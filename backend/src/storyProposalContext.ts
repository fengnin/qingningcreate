import type { ConfirmedCurve, StorySeed, StoryTurnHistoryItem } from '../../shared/story-contract.js'
import { activePreparationMaterial } from './storyPreparation.js'
import { AppError } from './qwen.js'

export function validateProposalFactReferences(value: unknown, sourceIds: readonly string[], path: string): string[] {
  if (!Array.isArray(value) || value.length > sourceIds.length || value.some(id => typeof id !== 'string') || new Set(value).size !== value.length) {
    throw new AppError(`${path}：事实引用必须是无重复的 ID 数组。`, 502, 'INVALID_MODEL_OUTPUT')
  }
  const missing = value.filter(id => !sourceIds.includes(id))
  if (missing.length) throw new AppError(`${path}：非法事实 ID ${missing.join(', ')}；只允许 ${sourceIds.join(', ') || '空数组'}。designBeats 和 authorEdits 的 ID 不属于事实证据；不能替换为相似事实或补造依据。`, 502, 'INVALID_MODEL_OUTPUT')
  return value as string[]
}

/** Auditable generation basis, not a model certificate of semantic truth. */
export function validateContinuationBasis(value: unknown, context: ReturnType<typeof createStoryProposalContext>) {
  const invalid = (message: string): never => { throw new AppError(`candidatePlan.basis：${message}`, 502, 'INVALID_MODEL_OUTPUT') }
  const record = (v: unknown, keys: string[]) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid('缺少推进依据。')
    const r = v as Record<string, unknown>
    if (Object.keys(r).some(k => !keys.includes(k))) return invalid('推进依据含未允许字段。')
    return r
  }
  const text = (v: unknown) => typeof v === 'string' && v.trim() && v.length <= 240 ? v : invalid('说明必须是1至240字。')
  const refs = (v: unknown, path: string) => validateProposalFactReferences(v, context.referenceContract.sourceFactIds, `candidatePlan.basis.${path}`)
  const b = record(value, ['latestResultFactId', 'unresolved', 'reason', 'contradictions'])
  if (b.latestResultFactId !== (context.lastAuthorConfirmedResult?.factId ?? null)) invalid('必须承接最近作者确认的结果 ID；没有结果时为 null。')
  const u = record(b.unresolved, ['kind', 'text', 'sourceFactIds'])
  if (!['existing', 'optional-design', 'next-goal'].includes(String(u.kind))) invalid('未解决事项类型不合法。')
  const sourceFactIds = refs(u.sourceFactIds, 'unresolved.sourceFactIds')
  if (u.kind === 'existing' && !sourceFactIds.length) invalid('现有未解决事项必须提供作者依据；新建议不能伪装成现有要求。')
  if (u.kind !== 'existing' && sourceFactIds.length) invalid('新增建议或下一目标不是已有事实要求，引用应为空。')
  if (!Array.isArray(b.contradictions) || b.contradictions.length > 3) invalid('矛盾说明必须是至多三项的数组。')
  const contradictions = (b.contradictions as unknown[]).map((v, i) => {
    const c = record(v, ['text', 'sourceFactIds']), ids = refs(c.sourceFactIds, `contradictions[${i}].sourceFactIds`)
    if (ids.length < 2) invalid('矛盾必须指出至少两项具体作者依据。')
    return { text: text(c.text), sourceFactIds: ids }
  })
  return { unresolved: { kind: u.kind as 'existing' | 'optional-design' | 'next-goal', text: text(u.text), sourceFactIds },
    reason: text(b.reason), contradictions }
}

/** Generation context separates narrative evidence from reviewed story design.
 * None of these roles is inferred from a date, an object name or a keyword. */
export function createStoryProposalContext(
  seed: StorySeed,
  curve: ConfirmedCurve,
  history: StoryTurnHistoryItem[],
  selectedFocus: string[],
) {
  const authorTexts = curve.preparation
    ? activePreparationMaterial(curve.preparation).filter(item => item.role !== 'unknown'
        && curve.design?.sourceFacts.find(f => f.id === item.id)?.disposition !== 'parked').map(item => item.quote)
    : [...new Set([
    seed.lockedGoal ?? '', ...seed.lockedFacts,
    ...(curve.design?.sourceFacts.filter((f) => f.disposition === 'integrated').map((f) => f.text) ?? []),
  ].filter((text) => text.trim()))]
  const executedHistory = history.flatMap((item) => {
    const { narrativeAction, transition } = item.selectedOption
    const receipt = transition.authorConfirmation
    if (narrativeAction.mode !== 'executed' || !receipt) return []
    // A receipt must match the exact result. Historical model prose, even in a
    // saved history entry, is never promoted to evidence by this adapter.
    const resultFacts = transition.introducedFacts.filter((f) => f.statement === receipt.resultText)
    if (narrativeAction.intent !== receipt.actionText || resultFacts.length !== 1) return []
    return [{ turnId: item.turnId, actionText: receipt.actionText, resultText: receipt.resultText,
      factId: resultFacts[0]!.id }]
  })
  const sourceFacts = [
    ...authorTexts.map((text, index) => ({ id: `author-${index + 1}`, text, authority: 'author-material' as const })),
    ...executedHistory.map((item) => ({ id: item.factId, text: item.resultText, authority: 'author-confirmed-result' as const })),
  ]
  const designBeats = curve.beats.filter((beat) => beat.status !== 'rejected').map((beat) => ({
    id: beat.id, kind: beat.kind, text: beat.detail, dependsOn: beat.dependsOn,
    authority: beat.source === 'user-edit' ? 'author-design' as const : 'reviewed-system-design' as const,
  }))
  const authorEdits = designBeats.filter((beat) => beat.authority === 'author-design')
  const unresolvedQuestions = (curve.clarifications ?? [])
    .filter((q) => q.status !== 'confirmed' && !q.resolution).map((q) => ({
      id: q.id, prompt: q.prompt, status: q.status,
      // Raw unconfirmed answers remain review material, never sourceFacts.
      ...(q.answerText === undefined ? {} : { answerText: q.answerText }),
      beatIds: q.dependency.beatIds, causalGap: q.dependency.causalGap,
      unknownHandling: q.unknownHandling,
    }))
  return {
    subject: seed.subject, goal: seed.lockedGoal, sourceFacts,
    authorEdits, designBeats, unresolvedQuestions, selectedFocus,
    executedHistory,
    lastAuthorConfirmedResult: executedHistory.at(-1) ?? null,
    chronology: { initialMaterial: '行动前作者材料，保留原文；其中的尚未执行描述不能覆盖之后的明确执行结果。',
      confirmedResults: '按执行历史顺序排列；同一事项的最新明确结果优先，未写出的后果仍未知。',
      reviewedDesign: '未来安排及假设结果，不能覆盖实际结果或增设验收条件。' },
    referenceContract: { sourceFactIds: sourceFacts.map(f => f.id),
      designOnlyIds: designBeats.map(b => b.id), unconfirmedQuestionIds: unresolvedQuestions.map(q => q.id) },
    priorities: [
      '承接最近已确认的实际结果，不把已执行行动重新当作待执行行动。',
      '保留作者编辑的行动对象、约束及尚待决定的部分，系统节点不覆盖作者编辑。',
      '关注点只是审阅角度；结合完整目标和相关编辑，不把被点选的单一材料替换成整个故事任务。',
      '设计节点与条件句不是已发生事件；未确认回答及未知因果不得用作成立的前提。',
    ],
  }
}

export const storyProposalGenerationInstruction = `你是中文故事共创提案编辑。生成具体、成立、可审阅的下一步行动，不生成既成事件或事实状态。
先读完整上下文：sourceFacts 是作者材料或逐字确认的实际结果；authorEdits 是作者设计意图而非已发生事实；designBeats 只给结构方向，不能替代因果证据。executedHistory 是已确认行动结果。selectedFocus 是关注角度，不是执行授权，也不能使作者编辑的核心问题消失。
引用编码：options[].sourceFactIds 与 causalClaims[].sourceFactIds 只能照抄 referenceContract.sourceFactIds。禁止填 designOnlyIds、未确认问题 ID、材料原来的 ID 或示例占位词。引用一个设计节点不是事实依据；没有作者依据的待审假设用空数组并明确提出问题，不能把设计节点转换为事实引用。
行动、约束和代价分开：行动须说明谁针对什么对象做什么；目标与期限、承诺、资源条件都不是行动选项。比较解决同一当前问题的不同做法，不把可同时满足的条件硬写成二选一。没有期限就不制造倒计时；已有条件可兼容就不声称必然冲突。
因果依据：事实并列不等于因果，引用 ID 不等于证明。仅作者明确写出的因果关系可以作为成立的理由；从物件用途、关系身份、期限或承诺推断出的能力、动机、权限、回应和代价都不是已知。不要通过新增人员、机构、设备、流程或便利权限绕开核心问题。
给一至三项有实质差异的角色行动，不为凑数制造新问题。优先使用已有对象和条件。角色向另一角色询问可以是行动，向作者索取资料、检查设计或确认结果必须走 authorReview，不能放进 options[].action。若没有不依赖未知前提的行动，options=[]，提出具体作者问题；作者明确保留未知时，不替作者回答。
先依据 lastAuthorConfirmedResult 及 executedHistory 确定仍未解决的具体事项，再生成候选。原始材料是较早状态，不得以其中的尚未开始、未来安排否定明确执行结果。作者明确确认完成的目标或满足的条件不需要再次举证、测量或追问成立机制。不得新增稳定时长、物理检查、他人评价等标准作为目标完成或续推的必要条件。若没有作者已提供的未解决事项，可以只提供一项请作者审阅收束或给出下一目标的候选；不要凭空续造障碍。独立新增设计只能自愿审阅，不得伪装成必须解决的现有缺口。
编辑承接：优先推进 authorEdits 指向的行动与问题；期限仍作约束，不把编辑后的任务变成归还安排等旁支。最近确认结果已解决的事项不能再重复，不推断其未写出的其他后果；后续行动要处理作者仍未解决的部分。
action 是候选行动，不是执行结果；proposedConsequence 须区分作者已有因果与待核对的条件性承接，不能保证未获证实的效果。整个候选留在待审区不意味着内容合格。不要引用系统模板作为理由。
先输出 candidatePlan.basis，再给 options。basis.latestResultFactId 逐字使用 lastAuthorConfirmedResult.factId，无执行结果时为 null。basis.unresolved={kind,text,sourceFactIds}：existing 仅用于作者事实仍未解决的事项，引用具体依据；optional-design 是可拒绝且不阻碍原目标完成的新增建议，引用为空；next-goal 表示现有事项已完成或无已知未解决事项，请作者收束或提出新目标，引用为空。basis.reason 解释为何从刚才结果推进到该事项；basis.contradictions=[{text,sourceFactIds}] 只列真正矛盾的作者依据，没有则为空。较早的未开始和较晚的完成只是时序变化，不是矛盾。
options 只能处理 basis.unresolved；新编号、签收、装帧、检查或他人认可等要求若没有作者依据，只能属于 optional-design，不得称为完成原目标的必需条件。既有目标已明确完成时优先收束，不再让作者证明完成；结果未知时只核对真实未解决事项，不发明验收标准。引用 ID 不能证明语义正确；不能通过 basis 标签包装新增因果。
三个出口互斥：收束 kind=next-goal 时 options=[]、authorReview=null。作者资料补充或设计审阅时 options=[]、authorReview={summary,questions}，questions 一至四个具体作者问题，不是角色动作。kind=optional-design 必须走作者设计审阅。只有 existing 且有可审阅角色行动才输出一至三项 options，authorReview=null。行动出口不能把作者回答、设计核对或完成证明当成行动；作者审阅不产生执行或事实，作者可补充、保留未知或选择独立替代，经现有作者入口重审主线。
严格输出 JSON 对象 candidatePlan，不输出 turn、transition、introducedFacts、review 或任何确认凭证。`
