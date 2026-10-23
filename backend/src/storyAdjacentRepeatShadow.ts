import { createHash, randomUUID } from 'node:crypto'
import { AppError, requestQwenJson, withQwenRequestBudget } from './qwen.js'
import { outputShapeErrors, shape as s } from './modelOutputSchema.js'

type Relation = 'repeat' | 'retry' | 'later-action' | 'recollection' | 'uncertain'
const priorExecutionGuidance = `先独立核对previous是否实际执行了待比较动作，不允许用关系相似或事件身份相同替代这一步。能够执行、距离合适、准备执行、希望执行、要求执行、假设执行及即将发生，均不等于已经执行；条件满足后的首次实际执行是正常推进。注意限定词的作用范围：一句中某人物已经推/递出，不代表另一人物已经接/收下；不要把句内别的已执行动作转移到待比较动作上。若前段后来明确执行，应引用后来实际执行的原句，不因更早写过计划而否定已执行。
前段动作发生状态previousExecution只能为performed（该动作或待比较的具体瞬时阶段已明确实际发生）、in-progress（该动作仍在进行，未证明待比较阶段已发生）、not-performed（仅能力、条件、意图、预期、假设或明确否定）、unclear（无直接执行依据）。每个状态只针对待比较的动作，不针对整个任务；暂停、抬手等局部阶段即使整个活动未完成，也可以已实际发生。
previousExecutionEvidenceId只选输入previousExecutionCatalog内直接表述该动作发生状态的原句编号，不重抄原句；保留原句中能力、意图、条件、否定等限定，不可只理解其内部动作动词而造成完成假象。performed必须有正文直接陈述的执行证据，不能凭场景气氛、声音出现/消失、没有后续声响、物品靠近、合理预期或缺少过渡反推完成。progressQuote只用于核对时间进展，不能替代前段执行证据。无法确认则unclear，不自行补写已接住、已交付或已离场等事实。
核对previousActionQuote、所选执行证据、candidateActionQuote必须对应同一个待比较动作；前段‘递出’与后段‘接过’不是同一动作重复。只补充动作发生判断，不要求至少两个动作，也不要求一次性结果。`
type Event = { relation: Relation; previousEvidenceIds: string[]; candidateEvidenceIds: string[]; action: string; reason: string }
type Proof = {
  previousExecution: 'performed' | 'in-progress' | 'not-performed' | 'unclear'
  previousExecutionEvidenceId: string
  execution: 'action' | 'state' | 'report' | 'unclear'
  identity: 'same-occurrence' | 'insufficient' | 'different-occurrence'
  alternative: 'none' | 'routine-omission' | 'new-attempt' | 'multiple-objects' | 'new-interaction' | 'unclear'
  previousActionQuote: string; candidateActionQuote: string; progressQuote: string; reason: string
}
type ShadowInput = { curveId: string; beatId: string; previousSegmentId: string; previous: string; candidate: string }
type Entry = { id: string; quote: string }
const catalog = (prefix: string, text: string): Entry[] => text.split(/\n\s*\n/u).filter(p => p.trim()).map((quote, i) => ({ id: `${prefix}:${i}`, quote }))
// Preserve full sentence qualifiers. The model selects an ID rather than
// retyping or cropping a modal/negative sentence into an assertion.
const executionCatalog = (entries: Entry[]): Entry[] => entries.flatMap(entry =>
  [...entry.quote.matchAll(/[^。！？\n]+[。！？]?[”’」』"']*|[^\n]+/gu)]
    .filter(match => match[0].trim()).map((match, i) => ({ id: `${entry.id}:sentence:${i}`, quote: match[0] })))
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const detectionSchema = s.object({ events: s.array(s.object({ relation: s.enum('repeat', 'retry', 'later-action', 'recollection', 'uncertain'),
  previousEvidenceIds: s.array(s.text, 1, 3), candidateEvidenceIds: s.array(s.text, 1, 3), action: s.text, reason: s.text }), 1, 5) })
const proofSchema = s.object({ previousExecution: s.enum('performed', 'in-progress', 'not-performed', 'unclear'), previousExecutionEvidenceId: s.text,
  execution: s.enum('action', 'state', 'report', 'unclear'),
  identity: s.enum('same-occurrence', 'insufficient', 'different-occurrence'),
  alternative: s.enum('none', 'routine-omission', 'new-attempt', 'multiple-objects', 'new-interaction', 'unclear'),
  previousActionQuote: s.text, candidateActionQuote: s.text, progressQuote: s.text, reason: s.text })

/** Shadow only. No return value feeds generation, acceptance, repair or UI.
 * Callers pass immutable text snapshots; logs identify that exact generation.
 * Enabled explicitly, bounded to six upstream calls including retries.
 */
export async function observeAdjacentRepeat(input: ShadowInput): Promise<void> {
  if (!/^(true|1|yes)$/iu.test(process.env.STORY_ADJACENT_REPEAT_SHADOW?.trim() ?? '')
    || /^(true|1|yes)$/iu.test(process.env.STORY_DISABLE_MODEL?.trim() ?? '')
    || !input.previous.trim() || !input.candidate.trim()) return
  const identity = { observationId: randomUUID(), curveId: input.curveId, beatId: input.beatId, previousSegmentId: input.previousSegmentId,
    previousHash: hash(input.previous), candidateHash: hash(input.candidate), mode: 'shadow', protocol: 'adjacent-repeat-v3-execution' }
  const events: Event[] = []
  const assessments: Array<{ event: Event; proof: Proof; previousExecutionEvidence?: Entry; validEvidence: boolean; confirmed: boolean }> = []
  try {
    await withQwenRequestBudget(6, async () => {
      const evidenceCatalog = { previous: catalog('previous', input.previous), candidate: catalog('candidate', input.candidate) }
      const detected = await requestQwenJson({ systemPrompt: adjacentRepeatDetectionPrompt,
        userPrompt: JSON.stringify({ previous: input.previous, candidate: input.candidate, evidenceCatalog }), outputSchema: detectionSchema,
        temperature: 0.1, maxTokens: 1600, diagnosticStage: 'story-writing-adjacent-repeat-shadow-detection' })
      if (outputShapeErrors(detected, detectionSchema).length) throw new Error('invalid-detection')
      events.push(...(detected as { events: Event[] }).events)
      const select = (ids: string[], entries: Entry[]) => ids.map(id => {
        const entry = entries.find(e => e.id === id)
        if (!entry) throw new Error('invalid-evidence-id')
        return entry
      })
      for (const event of events) {
        const references = select(event.previousEvidenceIds, evidenceCatalog.previous)
        const candidates = select(event.candidateEvidenceIds, evidenceCatalog.candidate)
        if (event.relation !== 'repeat') continue
        const previousExecutionCatalog = executionCatalog(references)
        const raw = await requestQwenJson({ systemPrompt: adjacentRepeatProofPrompt,
          userPrompt: JSON.stringify({ previous: input.previous, candidate: input.candidate,
            comparison: { action: event.action, previousEvidence: references, candidateEvidence: candidates }, previousExecutionCatalog }), outputSchema: proofSchema,
          temperature: 0.1, maxTokens: 1400, diagnosticStage: 'story-writing-adjacent-repeat-shadow-proof' })
        if (outputShapeErrors(raw, proofSchema).length) throw new Error('invalid-proof')
        const proof = raw as Proof
        const previousExecutionEvidence = previousExecutionCatalog.find(e => e.id === proof.previousExecutionEvidenceId)
        const validEvidence = Boolean(proof.previousActionQuote.trim() && proof.candidateActionQuote.trim() && proof.progressQuote.trim()
          && previousExecutionEvidence
          && input.previous.includes(proof.previousActionQuote) && input.previous.includes(proof.progressQuote)
          && input.candidate.includes(proof.candidateActionQuote)
          && references.some(e => e.quote.includes(proof.previousActionQuote))
          && candidates.some(e => e.quote.includes(proof.candidateActionQuote)))
        const confirmed = validEvidence && proof.previousExecution === 'performed'
          && proof.execution === 'action' && proof.identity === 'same-occurrence' && proof.alternative === 'none'
        assessments.push({ event, proof, previousExecutionEvidence, validEvidence, confirmed })
      }
    })
    console.info('[story-writing-adjacent-repeat-shadow]', JSON.stringify({ ...identity, status: 'completed',
      confirmed: assessments.some(a => a.confirmed), events, assessments, previous: input.previous, candidate: input.candidate }))
  } catch (error) {
    // Arbitrary upstream exception messages can contain prose or secrets.
    // Partial results remain diagnostic, never a completed passing judgment.
    console.info('[story-writing-adjacent-repeat-shadow]', JSON.stringify({ ...identity, status: 'unavailable',
      code: error instanceof AppError ? error.code : 'INVALID_SHADOW_OUTPUT', events, assessments }))
  }
}

// Retain the v3 event/identity checks; add an explicit occurrence check on the
// previous action. Do not restore the discarded v4 sequence/result restriction.
const baseDetectionPrompt = "你是相邻故事段落的逐事件关系分类员。把candidate拆成最多5个有意义的原子事件分别判断，不能用一个总体印象覆盖整段。严格输出JSON {events:[{relation,previousEvidenceIds,candidateEvidenceIds,action,reason}]}。\nrelation定义：repeat=明确证明同一主体、同一对象、同一事件身份已经在previous完成，candidate又在同一连续时间线上执行或重新呈现；retry=previous失败或candidate明确重新开始/补做，同一任务再次执行；later-action=previous之后的新动作、结果或不同事件，即使使用同一物品也不重复；recollection=回忆、转述、引用旧话或心理画面，不是现实再次执行；uncertain=主体、对象、事件身份或时间关系不足，不能排除其他解释。\n保守规则：repeat必须有previous中已完成的动作证据、candidate中对应动作证据，并能证明是同一事件身份；仅文字相同、同一动作类型、同一物品或同一句对白不足以判repeat。candidate同时有旧动作和新反应时，分别输出两个事件，不能用后一个新反应给前一个重复动作解释成正常承接。判定局部动作而非整段的人际目标。无法确认唯一对象、人物或事件身份时必须uncertain。普通取放、持握等中间动作允许省略；有聊天或时间间隔后再次放杯之类日常动作，仅缺少逐字描写端起不构成重演证明。明确‘重新、又、再次’或失败后新尝试优先判retry，不要因为动作相同改判repeat。明确回忆、转述、引用优先判recollection。信息不足默认uncertain。不要补写未给出的时间、对象身份或动作重置。证据编号只能来自输入目录，每侧选择1至3条原句编号；reason说明判定证据，不提出修复意见。"
const baseProofPrompt = "你核验相邻故事正文中的一个待比较动作。待比较动作不是已成立的错误；不要沿用提议者的判断。只看完整previous、candidate和所给证据目录，不参考故事设计。\n先区分候选写的是动作执行、结果状态、回忆/转述、还是无法确定。比如处于敞开状态不是又开窗；人看着碎片不是又砸碎。引用旧对白未必是现实中重新回答。\n再核验具体人物和具体对象是否同一：多个同类对象中两次“一把/一封/一个”不能默认同一。即使同人同物同动作，也不自动等于同一次事件。\n核验事件身份的正面依据：previous先写该动作，随后明确推进到其下游阶段或完成结果；candidate在已推进之后退回同一段动作过程。指出已推进的原文，不得仅用文字相同、没写“又”、没写重置动作作为证明。只有相同动作而无下游完成状态/推进依据，身份不足。\n日常可循环动作（端杯、放杯、查看、开关等）在聊天、时间间隔或新互动后再次发生，允许中间动作省略；缺少拿起描写不证明重演。失败后的补做、明确再次尝试、不同对象、新人物动作都不修改。相同回应也可能是重新确认或新的说话场合。\n但不能因候选后半段有新反应，就忽略前半段确实倒退重演的动作。逐项核验待比较动作本身。\n输出execution=action/state/report/unclear；identity=same-occurrence/insufficient/different-occurrence；alternative=none/routine-omission/new-attempt/multiple-objects/new-interaction/unclear。只有execution=action、identity=same-occurrence、alternative=none才可能修改。\npreviousActionQuote、candidateActionQuote、progressQuote只能逐字摘取各自正文中的非空连续片段；progressQuote从previous摘取动作之后的完成状态或下游进展；没有依据填空字符串。候选动作片段必须只含待比较的动作，不得吞掉它之后的新反应。reason说明正面依据及其他解释是否成立。严格按JSON结构输出，不写修改建议。"

export const adjacentRepeatDetectionPrompt = `${baseDetectionPrompt}\n${priorExecutionGuidance}`
export const adjacentRepeatProofPrompt = `${baseProofPrompt}\n${priorExecutionGuidance}\n输出JSON时必须额外包含previousExecution和previousExecutionEvidenceId，原有字段继续填写。只有previousExecution=performed且原有证据与关系条件也成立，才可确认重复。没有执行证据则previousExecutionEvidenceId填空字符串，不能编造。`
