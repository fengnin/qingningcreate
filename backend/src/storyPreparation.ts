import { randomUUID } from 'node:crypto'
import { AppError, requestQwenJson } from './qwen.js'
import { mapInitialReasoningProposal } from './storyInitialReasoning.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'
import type { StoryPreparation, StoryPreparationCandidate, StoryPreparationItem, StoryPreparationReview } from '../../shared/story-preparation.js'
import type { StoryReasoningProposal } from '../../shared/story-reasoning-contract.js'
import type { CreativeBrief, ProvisionalCurve, StoryDesignRecord } from '../../shared/story-contract.js'

const invalid = (message: string): never => { throw new AppError(message, 502, 'STORY_PREPARATION_INVALID_OUTPUT') }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('输出必须是对象。')
  const r = value as Record<string, unknown>
  if (Object.keys(r).length !== keys.length || keys.some(k => !(k in r))) invalid('输出字段不符合当前阶段，禁止夹带事实更新或确认状态。')
  return r
}
function list(value: unknown, max = 24): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid('列表缺失或过长。')
  return value as unknown[]
}
function text(value: unknown, max = 240): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid('文本缺失或过长。')
  return value as string
}
function ids(value: unknown, allowed: Set<string>, path = '引用'): string[] {
  const result = list(value).map(v => text(v, 80))
  if (new Set(result).size !== result.length) invalid(`${path}：引用重复。`)
  const missing = result.filter(id => !allowed.has(id))
  if (missing.length) invalid(`${path}：引用不在合法集合中：${missing.join(', ')}。合法 ID：${[...allowed].join(', ') || '无'}。不得将未知或设计引用转换为已知依据。`)
  return result
}
function unique(items: { id: string }[]) {
  if (new Set(items.map(i => i.id)).size !== items.length) invalid('ID 重复。')
}

export const preparationExtractionPrompt = `先整理作者材料，不设计曲线或行动，不补事实。
输出精确 JSON {material:[{id,role,sourceId,quote}]}。role 为 fact|condition|goal|unknown；它只是可审阅的原文分类。sourceId 来自 sources，quote 必须是连续逐字原文，保留否定、条件、范围，不改写、不拼接。覆盖全部原文（可按句拆分；空白和标点除外），不要遗漏约束或保留未知。没有期限不构成阻碍，兼容条件不构成冲突。作者没说的权限、回应或因果不要提取成事实。不要输出任何创意或结果。`

export const preparationCandidatesPrompt = `你只设计曲线之前的最小行动候选，不输出曲线，不预测既成事件。
输出精确 JSON {candidates:[{id,action,materialIds,preconditionIds,possibleResult,resultBasisIds,unknownIds}],questions:[{id,question,materialIds}]}。
引用合同：materialIds、preconditionIds、resultBasisIds 只能取 referenceContract.knownMaterialIds；即使描述行动对象，也不能引用 role=unknown 的材料。questions[].materialIds 可取 referenceContract.questionMaterialIds（含未知材料）。unknownIds 只取本次 questions[].id，不能填材料 ID。缺少已知对象时允许 candidates=[]，用具体问题恢复，不必凑行动。
合法编码示例（仅示意引用，不是故事设定）：若已知材料 k1、未知材料 u1，问题 {id:"q1",question:"请明确尚未确定的对象。",materialIds:["u1"]}；依赖该问题的候选使用 materialIds:["k1"],preconditionIds:[],resultBasisIds:[],unknownIds:["q1"]；没有独立行动就仅返回 questions。不能把 u1 放入候选的三个依据数组，也不能为了通过校验补造 k1 或结果依据。
最多3个具体候选，不要求凑满。action 说明谁对已有对象做什么；materialIds 指向支持行动对象及目标的已知原文。preconditionIds 逐项列出行动成立所需、作者已明确的条件。possibleResult 是行动的条件性可能结果，resultBasisIds 引用支持该结果的明确作者条件或目标；引用本身不能证明因果。不要保证态度变化、取得许可或关系改善。没有结果依据时，保留结果未知并提出具体问题，unknownIds 引用 questions 的 ID；这类候选不可接受为成立结构。
条件不存在时不发明条件：机构规则、物件能力、许可范围和人物反应没有原文依据就提问。未知材料不能当已知证据。可以设计使用已有材料的新做法，但新增规则或新因果必须先向作者询问，不能包装成已有依据。已有明确拒绝不改写成可能同意。条件可兼容时设计兼容行动，不硬写无法兼得；没有期限不制造倒计时。
若关键条件不足，给能具体回答的问题，或不依赖该条件的独立候选。questions 不能把生成失误归咎于作者，不能要求作者重复已有明确答案。候选和可能结果都是未来待审设计，接受不意味着执行。`

export function parsePreparationMaterial(value: unknown, sources: StoryPreparation['sources']): StoryPreparationItem[] {
  const r = object(value, ['material'])
  const material = list(r.material).map(v => {
    const m = object(v, ['id', 'role', 'sourceId', 'quote'])
    if (!['fact', 'condition', 'goal', 'unknown'].includes(String(m.role))) invalid('原文分类不合法。')
    const item = { id: text(m.id, 80), role: m.role as StoryPreparationItem['role'], sourceId: text(m.sourceId, 80), quote: text(m.quote) }
    const source = sources.find(s => s.id === item.sourceId)
    if (!source?.text.includes(item.quote)) invalid('原文引用不存在；不能补写依据。')
    return item
  })
  unique(material)
  if (!material.length || material.some(m => sources.some(s => s.id === m.id))) invalid('缺少材料或覆盖来源 ID。')
  // Coverage is positional, not a keyword test or a semantic truth certificate.
  for (const source of sources) {
    const covered = new Set<number>()
    for (const m of material.filter(m => m.sourceId === source.id)) {
      for (let pos = source.text.indexOf(m.quote); pos >= 0; pos = source.text.indexOf(m.quote, pos + 1)) {
        for (let i = pos; i < pos + m.quote.length; i++) covered.add(i)
      }
    }
    let offset = 0
    for (const c of source.text) {
      if (!/[\p{P}\p{Z}\s]/u.test(c) && !covered.has(offset)) invalid('材料整理遗漏原文，请重新提取；不是作者资料不足。')
      offset += c.length
    }
  }
  return material
}

export function preparationReferenceContract(material: StoryPreparationItem[]) {
  return { knownMaterialIds: material.filter(m => m.role !== 'unknown').map(m => m.id),
    questionMaterialIds: material.map(m => m.id), unknownDependencyIds: 'questions[].id' }
}

export function parsePreparationCandidates(value: unknown, material: StoryPreparationItem[]): Pick<StoryPreparation, 'candidates' | 'questions'> {
  const r = object(value, ['candidates', 'questions'])
  const materialIds = new Set(material.map(m => m.id)), known = new Set(material.filter(m => m.role !== 'unknown').map(m => m.id))
  const questions = list(r.questions, 8).map((v, i) => {
    const q = object(v, ['id', 'question', 'materialIds'])
    return { id: text(q.id, 80), question: text(q.question), materialIds: ids(q.materialIds, materialIds, `questions[${i}].materialIds`) }
  })
  const questionIds = new Set(questions.map(q => q.id))
  const candidates = list(r.candidates, 3).map((v, i) => {
    const c = object(v, ['id', 'action', 'materialIds', 'preconditionIds', 'possibleResult', 'resultBasisIds', 'unknownIds'])
    const item: StoryPreparationCandidate = { id: text(c.id, 80), action: text(c.action), materialIds: ids(c.materialIds, known, `candidates[${i}].materialIds`),
      preconditionIds: ids(c.preconditionIds, known, `candidates[${i}].preconditionIds`), possibleResult: text(c.possibleResult), resultBasisIds: ids(c.resultBasisIds, known, `candidates[${i}].resultBasisIds`), unknownIds: ids(c.unknownIds, questionIds, `candidates[${i}].unknownIds`) }
    if (!item.materialIds.length || (!item.resultBasisIds.length && !item.unknownIds.length)) invalid('行动或可能结果缺少作者依据，应提出具体问题。')
    return item
  })
  unique([...material, ...questions, ...candidates])
  if (!candidates.length && !questions.length) invalid('未给行动或可恢复的具体问题。')
  return { candidates, questions }
}

export async function generateStoryPreparation(idea: string, brief: CreativeBrief): Promise<ProvisionalCurve> {
  const sources = [{ id: 'author-input', text: idea }]
  const extracted = await requestQwenJson({ systemPrompt: preparationExtractionPrompt, userPrompt: JSON.stringify({ sources }), temperature: 0.1, maxTokens: 2400, diagnosticStage: 'preparation-extraction' })
  const material = parsePreparationMaterial(extracted, sources)
  const output = await requestQwenJson({ systemPrompt: preparationCandidatesPrompt, userPrompt: JSON.stringify({ sources, material, brief, referenceContract: preparationReferenceContract(material) }), temperature: 0.25, maxTokens: 3000, diagnosticStage: 'preparation-candidates' })
  const candidates = parsePreparationCandidates(output, material)
  const now = Date.now()
  return { id: `curve-${randomUUID()}`, title: '先审阅行动与条件', status: 'draft', brief, beats: [], instructions: [],
    preparation: { protocol: 1, status: 'needs-review', sources, material, ...candidates, acceptedCandidateIds: [], executed: false }, createdAt: now, updatedAt: now,
    generation: { origin: 'model', dramaticMechanism: '原文整理与行动候选分开生成；尚未生成曲线，也未确认事实' } }
}

export function parsePreparationReview(value: unknown, acceptedIds: string[]): StoryPreparationReview {
  const fail = (): never => { throw new AppError('请提供所选行动的作者确认原文、行动和可能结果。', 400, 'INVALID_REQUEST') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const r = value as Record<string, unknown>
  const validText = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 4000
  if (Object.keys(r).some(k => !['originalText','candidates','supersededMaterialIds','confirmedQuotes'].includes(k)) || !validText(r.originalText) || !Array.isArray(r.candidates)) return fail()
  const candidates = r.candidates.map(v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail()
    const c = v as Record<string, unknown>
    if (Object.keys(c).some(k => !['id','action','possibleResult','resultBasisIds'].includes(k)) || typeof c.id !== 'string' || !acceptedIds.includes(c.id) || !validText(c.action) || !validText(c.possibleResult)) return fail()
    if (c.resultBasisIds !== undefined && (!Array.isArray(c.resultBasisIds) || c.resultBasisIds.some(id => typeof id !== 'string') || new Set(c.resultBasisIds).size !== c.resultBasisIds.length)) return fail()
    return { id: c.id, action: c.action, possibleResult: c.possibleResult, ...(c.resultBasisIds === undefined ? {} : { resultBasisIds: c.resultBasisIds as string[] }) }
  })
  if (candidates.length !== acceptedIds.length || new Set(candidates.map(c => c.id)).size !== candidates.length) return fail()
  const supersededMaterialIds = r.supersededMaterialIds === undefined ? undefined : r.supersededMaterialIds
  const confirmedQuotes = r.confirmedQuotes === undefined ? undefined : r.confirmedQuotes
  if (supersededMaterialIds !== undefined && (!Array.isArray(supersededMaterialIds) || supersededMaterialIds.some(id => typeof id !== 'string') || new Set(supersededMaterialIds).size !== supersededMaterialIds.length)) return fail()
  if (confirmedQuotes !== undefined && (!Array.isArray(confirmedQuotes) || confirmedQuotes.some(q => !validText(q) || !(r.originalText as string).includes(q)) || new Set(confirmedQuotes).size !== confirmedQuotes.length)) return fail()
  if (Array.isArray(supersededMaterialIds) && supersededMaterialIds.length && (!Array.isArray(confirmedQuotes) || !confirmedQuotes.length)) return fail()
  return { originalText: r.originalText, candidates,
    ...(supersededMaterialIds === undefined ? {} : { supersededMaterialIds: supersededMaterialIds as string[] }),
    ...(confirmedQuotes === undefined ? {} : { confirmedQuotes: confirmedQuotes as string[] }) }
}

/** Only explicitly selected quotations are confirmed material. Raw review
 * includes future actions and must never be imported wholesale as facts. */
export function activePreparationMaterial(p: StoryPreparation): StoryPreparationItem[] {
  const superseded = new Set(p.authorReview?.supersededMaterialIds ?? [])
  return [...p.material.filter(m => !superseded.has(m.id)), ...(p.authorReview?.confirmedQuotes ?? []).map((quote, i) => ({
    id: `author-review-${i + 1}`, role: 'condition' as const, sourceId: 'author-review', quote,
  }))]
}

/** Classification is model work, never a server keyword inference. A missing
 * role can be recovered by selecting existing text without rewriting history. */
async function resolvePreparationGoal(material: StoryPreparationItem[]): Promise<StoryPreparationItem> {
  const classified = material.find(m => m.role === 'goal')
  if (classified) return classified
  const known = material.filter(m => m.role !== 'unknown')
  const output = await requestQwenJson({
    systemPrompt: '核对作者目标分类。输出精确 JSON {goalMaterialId}。只从输入 knownMaterial 中选择明确表达作者人物目标的一项 ID；不改写目标，不以行动候选或可能结果代替目标，不推断人物动机。没有明确目标时返回 goalMaterialId:null。此输出只是原文角色审阅，不是设计接受或执行事实。',
    userPrompt: JSON.stringify({ knownMaterial: known }), temperature: 0.1, maxTokens: 200, diagnosticStage: 'preparation-goal-classification',
  })
  const r = object(output, ['goalMaterialId'])
  const id = r.goalMaterialId === null ? null : text(r.goalMaterialId, 80)
  const goal = known.find(m => m.id === id)
  if (!goal) invalid('目标分类未给出有效的已知原文引用；模型需重新整理或返回问题审阅，不能用行动或未知材料补造目标。')
  return goal!
}

export function acceptPreparation(p: StoryPreparation, acceptedCandidateIds: string[], review?: StoryPreparationReview): StoryPreparation {
  if (p.status !== 'needs-review') throw new AppError('结构已接受，请审阅当前曲线。', 409, 'STORY_PREPARATION_ALREADY_ACCEPTED')
  if (!acceptedCandidateIds.length || new Set(acceptedCandidateIds).size !== acceptedCandidateIds.length
    || acceptedCandidateIds.some(id => !p.candidates.some(c => c.id === id))) throw new AppError('请选择存在的结构候选。', 400, 'INVALID_REQUEST')
  if (p.candidates.some(c => acceptedCandidateIds.includes(c.id) && c.unknownIds.length)) throw new AppError('该行动仍依赖未知条件，请补充或选择独立方案。', 409, 'STORY_PREPARATION_UNKNOWN_DEPENDENCY')
  const authorReview = review === undefined ? undefined : parsePreparationReview(review, acceptedCandidateIds)
  if (authorReview?.supersededMaterialIds?.some(id => !p.material.some(m => m.id === id))) throw new AppError('修订引用的旧材料不存在。', 400, 'INVALID_REQUEST')
  const revised = { ...structuredClone(p), status: 'accepted-design' as const, acceptedCandidateIds, executed: false as const,
    ...(authorReview ? { authorReview, originalCandidates: structuredClone(p.candidates), candidates: p.candidates.map(c => ({ ...c, ...authorReview.candidates.find(r => r.id === c.id) })) } : {}) }
  // A revised quote does not automatically prove the old causal claim.
  // Remove superseded references; require the author to review the new result.
  const replaced = new Set(authorReview?.supersededMaterialIds ?? [])
  revised.candidates = revised.candidates.map(c => acceptedCandidateIds.includes(c.id) ? { ...c,
    materialIds: c.materialIds.filter(id => !replaced.has(id)),
    preconditionIds: c.preconditionIds.filter(id => !replaced.has(id)),
    resultBasisIds: c.resultBasisIds.filter(id => !replaced.has(id)),
  } : c)
  const activeKnown = new Set(activePreparationMaterial(revised).filter(m => m.role !== 'unknown').map(m => m.id))
  if (revised.candidates.some(c => acceptedCandidateIds.includes(c.id) && (!c.resultBasisIds.length || [...c.materialIds, ...c.preconditionIds, ...c.resultBasisIds].some(id => !activeKnown.has(id))))) throw new AppError('修订后请明确审阅行动和可能结果的有效依据，不能自动沿用被取代材料。', 409, 'STORY_PREPARATION_REVISION_BASIS_REQUIRED')
  return revised
}

/** The model writes stage-specific review text within the accepted structure.
 * Reference validation is not semantic certification; no text becomes fact. */
export async function generateCurveFromPreparation(curve: ProvisionalCurve, acceptedIds: string[], review?: StoryPreparationReview): Promise<ProvisionalCurve> {
  return arrangePreparationCurve(curve, acceptedIds, review)
}

async function arrangePreparationCurve(curve: ProvisionalCurve, acceptedIds: string[], review?: StoryPreparationReview, omittedOnFirstAttempt?: string[]): Promise<ProvisionalCurve> {
  if (!curve.preparation || curve.status !== 'draft' || curve.beats.length) throw new AppError('当前不在行动结构审阅阶段。', 409, 'STORY_PREPARATION_NOT_PENDING')
  const p = acceptPreparation(curve.preparation, acceptedIds, review)
  const selected = p.candidates.filter(c => acceptedIds.includes(c.id))
  const activeMaterial = activePreparationMaterial(p)
  const goalMaterial = await resolvePreparationGoal(activeMaterial)
  const output = await requestQwenJson({ systemPrompt: `排列已接受未来行动，不写执行记录。严格输出 JSON {steps:[{kind,title,text,candidateIds,materialIds}],supplements:[{id,kind,text,question,materialIds}]}。
核心 steps 只能引用输入中的逐字已知材料、已接受行动或可能结果；text 必须等于其中一条完整原文，不能改写、拼接或补因果。title 也必须逐字等于相应 text。3 至5段，依序 current-state,trigger,可选 escalation,可选 climax-choice,resolution；简单行动只需三段，不造高潮。current-state 无 candidateIds；其余引用已接受候选。resolution 只展示候选 possibleResult，仍是未来假设，不是已发生。
trigger 的 text 必须逐字等于被引用候选的 action，不能改用材料 quote。resolution 的 text 必须逐字等于该候选的 possibleResult。每段 materialIds 非空；trigger 使用候选 materialIds，resolution 使用候选 resultBasisIds。materialIds 不可引用已取代材料。
先逐项分配全部已知材料：current-state 的 materialIds 保留初始状态、背景、全局条件和作者保留的可选路径，即使 text 只能展示其中一条原文，其余引用仍记录背景承接；trigger 的引用说明行动依据，resolution 的引用说明假设结果依据。这三种用途不同，保留可选路径不等于冲突，尚未开始是行动前状态而非故障假设，均不应另加 supplements 要求作者再次确认。行动和结果的窄引用域不限制 current-state 引用其他已知背景。全部已知材料必须在 steps 的 materialIds 中由模型显式承接。没有期限是边界，不是阻碍；可兼容条件不是冲突。引用背景或替代路径不表示它是行动前提、结果依据或已执行事件，不得因此改写候选 preconditionIds/resultBasisIds。未知材料不在已知覆盖范围内，不得引用为事实。服务端不会自动补齐遗漏的引用。
新增故障假设、观察步骤、检查标准或条件只能写入独立 supplements，kind=hypothesis|observation|criterion|condition，question 为具体待作者审阅问题，materialIds 只引用现有材料。它们不可成为 steps 或既有行动的前提；即使提出也不阻止独立核心行动生成曲线。没有新增设计就给空数组。引用本身不证明因果，不能暗中增加人物、权限、结果。`, userPrompt: JSON.stringify({ material: activeMaterial, acceptedCandidates: selected, authorReview: p.authorReview ?? null,
  ...(omittedOnFirstAttempt ? { coverageReview: { omittedMaterialIds: omittedOnFirstAttempt, instruction: '上一预览遗漏这些作者材料。重新审阅各节点的背景、约束及保留替代路径；只显式引用实际承接的材料，不改写行动或补因果。无法承接的仍留给作者决定，不伪造覆盖。' } } : {}) }), temperature: 0.2, maxTokens: 2400, diagnosticStage: 'preparation-curve-generation' })
  const r = object(output, ['steps', 'supplements']), kinds = ['current-state','trigger','escalation','climax-choice','resolution'] as const
  const known = new Set(activeMaterial.filter(m => m.role !== 'unknown').map(m => m.id))
  p.supplements = list(r.supplements, 8).map(v => {
    const s = object(v, ['id','kind','text','question','materialIds'])
    if (!['hypothesis','observation','criterion','condition'].includes(String(s.kind))) invalid('新增设计类型不合法。')
    return { id: text(s.id, 80), kind: s.kind as NonNullable<StoryPreparation['supplements']>[number]['kind'], text: text(s.text), question: text(s.question), materialIds: ids(s.materialIds, known), status: 'needs-review' as const }
  })
  unique([...activeMaterial, ...p.candidates, ...p.questions, ...p.supplements])
  const arrangements = list(r.steps, 5).map((v, i) => {
    const s = object(v, ['kind', 'title', 'text', 'candidateIds', 'materialIds'])
    if (!kinds.includes(s.kind as typeof kinds[number])) invalid('曲线阶段不正确。')
    const refs = ids(s.candidateIds, new Set(acceptedIds))
    if ((i === 0 && refs.length) || (i > 0 && !refs.length)) invalid('曲线只能排列已接受的行动结构。')
    const materialRefs = ids(s.materialIds, known)
    if (!materialRefs.length) invalid('曲线文案必须提供已知材料引用；服务端不补依据。')
    const content = text(s.text)
    const allowedTexts = s.kind === 'current-state' ? activeMaterial.filter(m => materialRefs.includes(m.id)).map(m => m.quote)
      : selected.filter(c => refs.includes(c.id)).map(c => s.kind === 'resolution' ? c.possibleResult : c.action)
    if (!allowedTexts.includes(content) || s.title !== content) invalid('核心曲线夹带未审新增设计；只能逐字展示有效材料或已接受行动及可能结果。')
    return { kind: s.kind as typeof kinds[number], title: content, text: content, refs, materialRefs }
  })
  if (arrangements.length < 3 || arrangements[0]?.kind !== 'current-state' || arrangements[1]?.kind !== 'trigger' || arrangements.at(-1)?.kind !== 'resolution'
    || arrangements.some((s, i) => i > 0 && kinds.indexOf(s.kind) <= kinds.indexOf(arrangements[i-1]!.kind))
    || selected.some(c => !arrangements.some(s => s.refs.includes(c.id)))) invalid('曲线遗漏已接受结构或阶段顺序不正确。')
  const covered = new Set(arrangements.flatMap(s => s.materialRefs))
  const omitted = [...known].filter(id => !covered.has(id))
  // One explicit model recovery, never server-added citations. A partial
  // preview remains reviewable; its confirmation still requires the author's
  // disposition decision. Upstream failures remain failures, not fallback.
  if (omitted.length && !omittedOnFirstAttempt) return arrangePreparationCurve(curve, acceptedIds, review, omitted)
  const evidence = (ids: string[]) => ids.map(id => activeMaterial.find(m => m.id === id)!).map(m => ({ sourceId: m.id, quote: m.quote }))
  const basis = (ids: string[]) => ({ kind: 'design-proposal' as const, evidence: evidence(ids), unknownIds: [] })
  const actions = selected.map(c => ({ id: c.id, text: c.action, basis: basis(c.materialIds), constraintIds: c.preconditionIds.map(id => `material-${id}`), relationIds: [`result-${c.id}`], unknownIds: [], respondsToEditIds: [] }))
  const relations = selected.map(c => ({ id: `result-${c.id}`, text: c.possibleResult, basis: basis(c.resultBasisIds), relation: 'cause' as const, fromIds: [c.id, ...c.preconditionIds], toIds: c.resultBasisIds }))
  const conditions = activeMaterial.filter(m => m.role !== 'unknown').map(m => ({ id: `material-${m.id}`, text: m.quote, basis: { kind: 'author-text' as const, evidence: [{ sourceId: m.id, quote: m.quote }] } }))
  const proposal: StoryReasoningProposal = { protocol: 1, stage: 'initial-design', status: 'needs-review', outcome: 'proposal',
    goal: goalMaterial ? { id: 'prepared-goal', text: goalMaterial.quote, basis: { kind: 'author-text', evidence: evidence([goalMaterial.id]) } } : null,
    constraints: conditions, actions, relations, unknowns: [], steps: arrangements.map((s, i) => {
      // Model text remains a separate design proposal, never server-written cause.
      return { id: `beat-${s.kind}`, kind: s.kind, title: s.title, text: s.text, basis: basis(s.materialRefs),
        actionIds: s.refs, relationIds: s.kind === 'resolution' ? s.refs.map(id => `result-${id}`) : [], dependsOn: i ? [`beat-${arrangements[i - 1]!.kind}`] : [], respondsToEditIds: [] }
    }), designReview: { required: true, acceptedProposalIds: [] } }
  const design: StoryDesignRecord = { id: `design-${randomUUID()}`, sourceFacts: activeMaterial.filter(m => m.role !== 'unknown').map(m => ({ id: m.id, text: m.quote, source: 'user-input', disposition: 'needs-author-decision', coveredByBeatIds: [] })), conflictCoreBeatIds: ['beat-current-state','beat-trigger'], predicamentBeatIds: ['beat-trigger','beat-escalation'], storyEndBeatIds: ['beat-current-state','beat-climax-choice','beat-resolution'], middleDevelopmentBeatIds: ['beat-escalation','beat-climax-choice'] }
  const beatIds = new Set(proposal.steps.map(s => s.id))
  for (const key of ['conflictCoreBeatIds','predicamentBeatIds','storyEndBeatIds','middleDevelopmentBeatIds'] as const) design[key] = design[key].filter(id => beatIds.has(id))
  validateStoryReasoningProposal(proposal, { stage: 'initial-design', sources: design.sourceFacts.map(f => ({ id: f.id, text: f.text, authority: 'author-material' })), protectedSteps: [], requiredEditIds: [] })
  const mapped = mapInitialReasoningProposal(proposal, design, curve.brief, { allowSimplePlan: true })
  return { ...mapped, id: curve.id, preparation: p, createdAt: curve.createdAt }
}
