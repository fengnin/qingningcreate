import { AppError } from './qwen.js'
import type {
  StoryReasoningBasis, StoryReasoningProposal, StoryReasoningStatement,
  StoryReasoningValidationContext, StoryReasoningDesignAcceptance, StoryReasoningAuthorResult,
} from '../../shared/story-reasoning-contract.js'

const invalid = (message: string): never => { throw new AppError(message, 502, 'STORY_REASONING_INVALID_OUTPUT') }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('推理提案字段必须为对象。')
  const r = value as Record<string, unknown>
  if (Object.keys(r).some(k => !keys.includes(k)) || keys.some(k => !(k in r))) invalid('推理提案缺少字段或夹带了状态、执行结果及其他字段。')
  return r
}
function text(value: unknown, max = 240): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid('推理提案文本缺失或过长。')
  return value as string
}
function array(value: unknown, max = 24): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid('推理提案列表格式不正确。')
  return value as unknown[]
}
function ids(value: unknown): string[] {
  const list = array(value).map(v => text(v, 80))
  if (new Set(list).size !== list.length) invalid('推理提案引用重复。')
  return list
}
function references(values: string[], allowed: Set<string>, label: string) {
  if (values.some(id => !allowed.has(id))) invalid(`${label}引用了不存在的 ID。`)
}

/** Validates identity, source authority, dependency and edit ownership. It
 * deliberately does not certify the semantic truth of a relation from IDs,
 * quotes, a model reviewer or a keyword. All output remains needs-review. */
export function validateStoryReasoningProposal(value: unknown, context: StoryReasoningValidationContext): StoryReasoningProposal {
  const preliminary = value as Record<string, unknown> | null
  const tail = preliminary?.outcome === 'questions' ? 'questions' : context.stage === 'action-candidates' ? 'options' : 'steps'
  const r = record(value, ['protocol', 'stage', 'status', 'outcome', 'goal', 'constraints', 'actions', 'relations', 'unknowns', tail])
  if (r.protocol !== 1 || r.stage !== context.stage || r.status !== 'needs-review'
    || !['proposal', 'questions'].includes(String(r.outcome))) invalid('输出阶段或审阅状态不正确；模型不能确认设计或执行结果。')
  const sources = new Map(context.sources.map(s => [s.id, s]))
  if (sources.size !== context.sources.length) invalid('服务端来源 ID 重复。')
  const sourceIds = new Set(sources.keys())
  const excluded = context.excludedUnknowns ?? []
  const excludedSourceIds = new Set(excluded.flatMap(q => q.sourceIds))
  const unknowns = array(r.unknowns).map(value => {
    const q = record(value, ['id', 'question', 'sourceIds', 'dependentIds'])
    const item = { id: text(q.id, 80), question: text(q.question), sourceIds: ids(q.sourceIds), dependentIds: ids(q.dependentIds) }
    references(item.sourceIds, sourceIds, '问题来源')
    return item
  })
  const unknownIds = new Set([...unknowns.map(q => q.id), ...excluded.map(q => q.id)])
  const basis = (value: unknown): StoryReasoningBasis => {
    const raw = value as Record<string, unknown> | null
    const kind = raw?.kind
    const b = record(value, kind === 'author-text' ? ['kind', 'evidence'] : kind === 'design-proposal' ? ['kind', 'evidence', 'unknownIds'] : ['kind', 'unknownIds'])
    if (!['author-text', 'design-proposal', 'unknown'].includes(String(kind))) invalid('依据类型不正确。')
    if (kind === 'unknown') {
      const refs = ids(b.unknownIds); references(refs, unknownIds, '未知依据')
      if (!refs.length) invalid('未知依据必须指出具体问题。')
      return { kind: 'unknown', unknownIds: refs }
    }
    const evidence = array(b.evidence).map(value => {
      const e = record(value, ['sourceId', 'quote'])
      const sourceId = text(e.sourceId, 80), quote = text(e.quote)
      const source = sources.get(sourceId)
      if (!source || !source.text.includes(quote)) invalid('依据引用不存在或引文不在来源原文中。')
      if (source!.authority === 'unknown' || excludedSourceIds.has(sourceId)) invalid('未确定内容不能充当成立的依据。')
      if (kind === 'author-text' && source!.authority === 'author-design') invalid('作者设计不是已发生事实，不能提升为事实依据。')
      return { sourceId, quote }
    })
    if (kind === 'author-text') {
      if (!evidence.length) invalid('作者原文依据必须提供可核对引文。')
      return { kind: 'author-text', evidence }
    }
    const refs = ids(b.unknownIds); references(refs, unknownIds, '提案依赖')
    return { kind: 'design-proposal', evidence, unknownIds: refs }
  }
  const statement = (value: unknown, extra: string[] = []): StoryReasoningStatement & Record<string, unknown> => {
    const s = record(value, ['id', 'text', 'basis', ...extra])
    const result = { ...s, id: text(s.id, 80), text: text(s.text), basis: basis(s.basis) }
    // "author-text" is a quotation, not a license to append a new outcome.
    if (result.basis.kind === 'author-text' && !result.basis.evidence.some(e => e.quote === result.text)) invalid('原文依据不能夹带原文没有的解释或结果；请作为设计提案审阅。')
    return result
  }
  const goal = r.goal === null ? null : statement(r.goal)
  if (goal && context.lockedGoal !== undefined && goal.text !== context.lockedGoal) invalid('模型不能更改锁定目标。')
  const constraints = array(r.constraints).map(v => statement(v))
  const edits = new Set(context.requiredEditIds)
  const editRefs = (value: unknown) => {
    const refs = ids(value); references(refs, new Set(context.protectedSteps.map(s => s.id)), '作者编辑')
    return refs
  }
  const actions = array(r.actions, 12).map(value => {
    const a = statement(value, ['constraintIds', 'relationIds', 'unknownIds', 'respondsToEditIds'])
    const item = { id: a.id, text: a.text, basis: a.basis, constraintIds: ids(a.constraintIds), relationIds: ids(a.relationIds),
      unknownIds: ids(a.unknownIds), respondsToEditIds: editRefs(a.respondsToEditIds) }
    references(item.unknownIds, unknownIds, '行动未知前提')
    if (item.basis.kind !== 'author-text' && item.basis.unknownIds.some(id => !item.unknownIds.includes(id))) invalid('行动遗漏了依据中的未知依赖。')
    return item
  })
  const relations = array(r.relations).map(value => {
    const a = statement(value, ['relation', 'fromIds', 'toIds'])
    if (!['cause', 'conflict', 'compatible', 'sequence'].includes(String(a.relation))) invalid('关系类型不正确。')
    const fromIds = ids(a.fromIds), toIds = ids(a.toIds)
    if (!fromIds.length || !toIds.length) invalid('关系必须标明两端。')
    return { id: a.id, text: a.text, basis: a.basis, relation: a.relation as 'cause' | 'conflict' | 'compatible' | 'sequence', fromIds, toIds }
  })
  const steps = tail === 'steps' ? array(r.steps, 7).map(value => {
    const s = statement(value, ['kind', 'title', 'actionIds', 'relationIds', 'dependsOn', 'respondsToEditIds'])
    if (!['current-state', 'character-tension', 'trigger', 'escalation', 'midpoint-turn', 'climax-choice', 'resolution'].includes(String(s.kind))) invalid('设计节点类型不正确。')
    const protectedStep = context.protectedSteps.find(p => p.id === s.id)
    if (protectedStep) invalid('模型输出不能替换作者编辑节点；只能提出下游预览。')
    if (context.previewTargetIds && !context.previewTargetIds.includes(s.id)) invalid('重推输出修改了请求范围外的节点。')
    return { id: s.id, text: s.text, basis: s.basis, kind: s.kind as 'trigger', title: text(s.title, 40), actionIds: ids(s.actionIds),
      relationIds: ids(s.relationIds), dependsOn: ids(s.dependsOn), respondsToEditIds: editRefs(s.respondsToEditIds) }
  }) : []
  const all = [...(goal ? [goal] : []), ...constraints, ...actions, ...relations, ...unknowns, ...steps]
  const allIds = new Set(all.map(a => a.id))
  if (allIds.size !== all.length || all.some(a => sourceIds.has(a.id))) invalid('推理提案 ID 重复或覆盖来源 ID。')
  const nodeIds = new Set([...allIds, ...(context.externalNodeIds ?? []), ...context.protectedSteps.map(s => s.id)])
  const endpoints = new Set([...nodeIds, ...sourceIds])
  const actionIds = new Set(actions.map(a => a.id)), relationIds = new Set(relations.map(a => a.id)), constraintIds = new Set(constraints.map(a => a.id))
  for (const a of actions) {
    references(a.constraintIds, constraintIds, '行动约束'); references(a.relationIds, relationIds, '行动关系')
    for (const id of a.relationIds) {
      const rel = relations.find(r => r.id === id)!
      if (rel.basis.kind !== 'author-text' && rel.basis.unknownIds.some(id => !a.unknownIds.includes(id))) invalid('行动隐去了关系中的未知依赖。')
    }
  }
  for (const rel of relations) { references(rel.fromIds, endpoints, '关系起点'); references(rel.toIds, endpoints, '关系终点') }
  for (const q of unknowns) references(q.dependentIds, nodeIds, '问题依赖节点')
  for (const s of steps) {
    references(s.actionIds, actionIds, '节点行动'); references(s.relationIds, relationIds, '节点关系'); references(s.dependsOn, nodeIds, '节点上游')
    if (s.dependsOn.includes(s.id)) invalid('节点不能依赖自身。')
  }
  // Reject cycles rather than trusting a model's claimed causal order.
  const visit = (id: string, chain: Set<string>) => {
    if (chain.has(id)) invalid('设计节点依赖成环。')
    const step = steps.find(s => s.id === id)
    if (step) for (const parent of step.dependsOn) visit(parent, new Set([...chain, id]))
  }
  for (const s of steps) visit(s.id, new Set())
  if (r.outcome === 'proposal') {
    if (!goal || !actions.length) invalid('成立的行动提案必须给出目标与行动；否则请返回问题审阅。')
    const addressed = new Set([...actions, ...steps].flatMap(s => s.respondsToEditIds))
    if ([...edits].some(id => !addressed.has(id))) invalid('输出没有承接要求保留的作者编辑。')
  }
  const common = { protocol: 1 as const, status: 'needs-review' as const, goal, constraints, actions, relations, unknowns }
  if (tail === 'questions') {
    const questions = array(r.questions, 8).map(value => {
      const q = record(value, ['unknownId', 'dependentIds']), unknownId = text(q.unknownId, 80), dependentIds = ids(q.dependentIds)
      references([unknownId], unknownIds, '审阅问题'); references(dependentIds, nodeIds, '审阅问题依赖')
      return { unknownId, dependentIds }
    })
    if (!questions.length || actions.length || relations.length) invalid('问题审阅不能夹带可接受的行动或关系提案。')
    return { ...common, stage: context.stage, outcome: 'questions', questions }
  }
  if (tail === 'steps') {
    if (!steps.length) invalid('设计提案缺少待审节点。')
    return { ...common, stage: context.stage as 'initial-design' | 'edit-preview', outcome: 'proposal', steps }
  }
  const options = array(r.options, 3).map(value => {
    const o = record(value, ['id', 'label', 'actionId']), id = text(o.id, 80), actionId = text(o.actionId, 80)
    references([actionId], actionIds, '候选行动')
    return { id, label: text(o.label, 40), actionId }
  })
  if (!options.length || new Set(options.map(o => o.id)).size !== options.length || new Set(options.map(o => o.actionId)).size !== options.length) invalid('候选缺失或重复；不能用重复行动凑选项。')
  return { ...common, stage: 'action-candidates', outcome: 'proposal', options }
}

/** Author acceptance is a future design record, never a fact transition.
 * Callers must still persist it atomically and enforce session revision. */
export function acceptStoryReasoningDesign(proposal: StoryReasoningProposal): StoryReasoningDesignAcceptance {
  if (proposal.stage === 'action-candidates' || proposal.outcome !== 'proposal') throw new AppError('当前内容不能作为主线设计接受。', 409, 'STORY_REASONING_NOT_DESIGN')
  const dependencies = [...proposal.actions.flatMap(a => a.unknownIds),
    ...[...proposal.constraints, ...proposal.relations, ...proposal.steps, ...(proposal.goal ? [proposal.goal] : [])]
      .flatMap(s => s.basis.kind === 'author-text' ? [] : s.basis.unknownIds)]
  // Answer confirmation must rebuild the proposal from confirmed sources.
  // Accepting a model's list of supposedly resolved IDs would launder unknowns.
  if (dependencies.length) throw new AppError('依赖的未知前提尚未由作者解决，请重建提案或审阅独立替代提案。', 409, 'STORY_REASONING_UNKNOWN_DEPENDENCY')
  return { status: 'accepted-design', proposal: structuredClone(proposal), executed: false }
}

/** This parser is only for the separate author endpoint. Never call it on a
 * model response; design acceptance cannot manufacture its input. */
export function validateStoryReasoningAuthorResult(value: unknown, proposalId: string, actionText: string): StoryReasoningAuthorResult {
  const r = record(value, ['stage', 'proposalId', 'actionText', 'resultText'])
  if (r.stage !== 'author-result' || r.proposalId !== proposalId || r.actionText !== actionText) throw new AppError('作者执行确认与当前提案不一致。', 409, 'STORY_REASONING_RESULT_CONFLICT')
  return { stage: 'author-result', proposalId, actionText, resultText: text(r.resultText) }
}
