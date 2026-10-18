import type { ConfirmedCurve, StorySeed, StoryTurnHistoryItem } from '../../shared/story-contract.js'
import { activePreparationMaterial } from './storyPreparation.js'
import { AppError } from './qwen.js'
import { hasProposalProtocolLeak } from './storyProposalProse.js'
import { storySemanticReviewGuidance } from './storySemanticReview.js'
import { selectedExpansionNeeds, storyExpansionGuidance } from './storyBridgeReview.js'
import { preparationCreativeFocus } from './storyCreativeIntent.js'

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
  const text = (v: unknown) => {
    if (typeof v !== 'string' || !v.trim() || v.length > 240) return invalid('说明必须是1至240字。')
    // These are model protocol identifiers, not narrative explanations. Do not
    // silently rewrite them into prose or expose them as an author obligation.
    if (hasProposalProtocolLeak(v, context.sourceFacts.map(f => f.text))) return invalid('请用故事中的人物、行动和结果解释承接，不输出内部字段或事实 ID。')
    return v
  }
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
  // Keep the reviewed story available as a plan throughout development.
  // Actual confirmed results take priority; this never turns plans into facts.
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
    selectedStoryDirection: curve.preparation?.authorReview?.selectedStoryDirection,
    expansionNeeds: selectedExpansionNeeds(curve.preparation),
    creativeFocus: preparationCreativeFocus(curve.preparation, curve.design?.sourceFacts.filter(f => f.disposition === 'parked').map(f => f.id)),
    executedHistory,
    lastAuthorConfirmedResult: executedHistory.at(-1) ?? null,
    chronology: { initialMaterial: '行动前作者材料，保留原文；其中的尚未执行描述不能覆盖之后的明确执行结果。',
      confirmedResults: '按执行历史顺序排列；同一事项的最新明确结果优先，未写出的后果仍未知。',
      reviewedDesign: '未来安排及假设结果，不能覆盖实际结果或增设验收条件。' },
    referenceContract: { sourceFactIds: sourceFacts.map(f => f.id),
      designOnlyIds: designBeats.map(b => b.id), unconfirmedQuestionIds: unresolvedQuestions.map(q => q.id) },
    priorities: [
      'selectedStoryDirection 是作者选定的未来设计倾向；承接关键分支，不当作已发生事实；后续作者编辑和实际结果优先。',
      '承接最近已确认的实际结果，不把已执行行动重新当作待执行行动。',
      '保留作者编辑的行动对象、约束及尚待决定的部分，系统节点不覆盖作者编辑。',
      '关注点只是审阅角度；结合完整目标和相关编辑，不把被点选的单一材料替换成整个故事任务。',
      '设计节点与条件句不是已发生事件；未确认回答及未知因果不得用作成立的前提。',
    ],
  }
}

export const continuationQualityCriteria = ['continuity', 'causality', 'requirements', 'author-control'] as const

/** A separate review must cover every dimension; missing review is not a pass. */
export function validateContinuationQualityReview(value: unknown): void {
  const invalid = (message: string): never => { throw new AppError(message, 502, 'INVALID_MODEL_OUTPUT') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('续推内容审阅缺失。')
  const audit = value as Record<string, unknown>
  if (Object.keys(audit).length !== 2 || !Array.isArray(audit.checks) || !Array.isArray(audit.issues)
      || audit.checks.length !== continuationQualityCriteria.length || audit.issues.length > 4) invalid('续推内容审阅结构不完整。')
  const checks = (audit.checks as unknown[]).map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('续推内容审阅维度缺失。')
    const check = value as Record<string, unknown>
    if (Object.keys(check).length !== 3 || !continuationQualityCriteria.includes(check.criterion as typeof continuationQualityCriteria[number])
        || typeof check.passed !== 'boolean' || typeof check.evidence !== 'string' || !check.evidence.trim() || check.evidence.length > 400) invalid('续推内容审阅维度不合法。')
    return check
  })
  if (new Set(checks.map(c => c.criterion)).size !== continuationQualityCriteria.length) invalid('续推内容审阅遗漏维度。')
  const issues = (audit.issues as unknown[]).map(issue => {
    if (typeof issue !== 'string' || !issue.trim() || issue.length > 400) invalid('续推内容审阅问题不合法。')
    return issue as string
  })
  if (checks.every(c => c.passed) && issues.length) invalid('审阅各项均通过却仍列出内容缺陷。请只重审原提案，使checks和issues一致；不改写故事，也不为保留问题列表编造失败项。')
  for (const check of checks.filter(c => !c.passed)) issues.push(`${check.criterion}：${check.evidence}`)
  if (issues.length) throw new AppError(`续推内容审阅未通过：${issues.join('；')}`, 502, 'STORY_TURN_QUALITY_FAILED')
}

export const continuationQualityInstruction = `独立审查中文故事续推提案。严格返回 JSON {checks:[{criterion,passed,evidence}],issues:[具体问题]}，四项 criterion 为 continuity,causality,requirements,author-control，每项恰好一次，passed 是布尔值，evidence 引用具体待审措辞说明原因（不超过180字）。issues 只列实质缺陷，最多四项。
${storySemanticReviewGuidance}
${storyExpansionGuidance}
先按reviewMode检查出口：closure只核对作者完成结果和是否遗漏明确未解决事项，不要求新动作或因果链，causality记为通过且说明“收束无新增行动”；question/design只核对问题是否必要且不执行角色动作。不能用行动出口的要求否决合理收束或补充。action才检查具体行动与可能后果，不为了四项维度制造缺陷。
continuity：先逐字引用最新确认结果里与 unresolved 有关的状态，再引用 proposal.basis 的对应断言，逐一比较；不能仅说‘承接了’就判通过。提案是否承接最近作者确认结果，保留原目标、编辑和条件；过去的初始状态不得覆盖后来的结果，不得重复已完成事项。basis.reason 和 unresolved.text 描述的是当前状态，其中原文没有的观察、故障、身体状态或时间安排不能借提议标签豁免。叶片仍绿不代表必须证明直立，目标未完成不等于缺少测量结果。依据引用ID本身不证明语义正确。此前的预测结果不能成为当前状态，即使它在主线设计中获接受。
causality：行动是否处理当前具体未解决事项，可能后果是否由行动引发且符合日常常识。多个方向须有不同的实际后果，不以装饰性细节、巧合或无关线索替代进展。仅未确认目标完成不等于存在需要证明完成的技术缺口。提案应继续故事中的问题，不能继续审核故事。说明用叙事语言，不应泄露内部字段、ID或合同术语。
requirements：不得把新增许可、设备、核查、流程、时长或他人认可设为完成目标的必要条件。人物可以主动尝试已有任务；原文没有要求的检查与评估不能成为核心续推。新增虚构人物回应和直接发展允许作为可拒绝提案，不需要作者证明现实存在。
author-control：设计和可能结果未执行；未知保持未知，不能被预先确定。authorReview 仅限确实无法避开的作者创作选择，不是重复确认或现实调查；回答不得混入角色行动。已完成且无未解决事项时可走 next-goal 收束，不制造新障碍。不要把所有未来反应都当成越权事实，也不要因文本标了提议就放过缺陷。全部维度通过且无实质问题才返回空 issues。`
