import { AppError } from './qwen.js'
import { shape as s } from './modelOutputSchema.js'
import { selectStoryEvidence } from './storyEvidence.js'
import type { StoryExpansionNeed, StoryPreparation, StoryPreparationExplanation } from '../../shared/story-preparation.js'

export const bridgeEvidenceFields = ['author', 'action', 'possibleResult', 'method', 'change', 'futureChoice'] as const
export type BridgeEvidence = { field: typeof bridgeEvidenceFields[number]; quote: string }
export type BridgeReviewText = Record<Exclude<BridgeEvidence['field'], 'author'>, string>
export type BridgeEvidenceEntry = BridgeEvidence & { id: string; candidateId: string | null }

export const bridgeEvidenceSchema = s.array(s.text, 0, 4)
export const expansionKinds = ['setup', 'action-detail', 'response-detail', 'character-detail', 'emotional-beat', 'payoff'] as const
export const bridgeIssueTypes = ['causal-gap', 'mainline-drift', 'world-implausible'] as const

// Keep a single wire shape. Real Qwen requests with separate anyOf branches
// locked every verdict to the first branch, even when the reason rejected it.
// The verdict controls the branch. Non-applicable notes are discarded rather
// than turning a clear rejection into another format retry or a writing task.
export const bridgeReviewCheckSchema = (ids?: string[], candidateIds?: string[]) => {
  const refs = ids?.length ? s.enum(...ids) : s.text
  return s.object({ id: candidateIds?.length ? s.enum(...candidateIds) : s.text, verdict: s.enum('supported', 'expandable', 'contradictory'), reason: s.text,
    issueType: s.enum('none', ...bridgeIssueTypes), evidenceIds: s.array(refs, 0, 4),
    needs: s.array(s.object({ kind: s.enum(...expansionKinds), evidenceIds: s.array(refs, 1, 3) }), 0, 2) })
}

export function parseBridgeReviewCheck(value: unknown, catalog: BridgeEvidenceEntry[]) {
  const invalid = (): never => { throw new AppError('审阅结论不合法：区分supported、expandable和contradictory；待展开事项只能选择当前提案原文与固定类别，不能附加新规则或修改方案。', 502, 'STORY_PREPARATION_INVALID_OUTPUT') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const r = value as Record<string, unknown>
  if (typeof r.reason === 'string' && r.reason.length > 500) throw new AppError(
    `checks[${r.id}].reason长度为 ${r.reason.length}，超过 500 字上限。`, 502, 'STORY_PREPARATION_INVALID_OUTPUT')
  if (typeof r.id !== 'string' || !catalog.some(e => e.candidateId === r.id)
    || typeof r.reason !== 'string' || r.verdict !== 'supported' && !r.reason.trim() || r.reason.length > 500) return invalid()
  const keys = ['id', 'verdict', 'reason', 'needs', 'issueType', 'evidenceIds']
  if (!['supported', 'expandable', 'contradictory'].includes(String(r.verdict))
    || Object.keys(r).length !== keys.length || keys.some(k => !(k in r))
    || !Array.isArray(r.needs) || !Array.isArray(r.evidenceIds)) return invalid()
  if (r.verdict !== 'contradictory' && r.issueType !== 'none') return invalid()
  const expansionNeeds: StoryExpansionNeed[] = []
  if (r.verdict === 'expandable') {
    if (!Array.isArray(r.needs) || !r.needs.length || r.needs.length > 2) return invalid()
    for (const need of r.needs) {
      if (!need || typeof need !== 'object' || Object.keys(need).length !== 2
        || !expansionKinds.includes(need.kind) || !Array.isArray(need.evidenceIds)
        || !need.evidenceIds.length || need.evidenceIds.length > 3
        || new Set(need.evidenceIds).size !== need.evidenceIds.length) return invalid()
      const anchors = need.evidenceIds.map((id: unknown) => {
        const e = catalog.find(e => e.id === id && e.candidateId === r.id)
        if (!e || e.field === 'author') return invalid()
        return { field: e.field, quote: e.quote }
      })
      expansionNeeds.push({ kind: need.kind, anchors })
    }
    if (new Set(expansionNeeds.map(n => JSON.stringify(n))).size !== expansionNeeds.length) return invalid()
  }
  const rejected = r.verdict === 'contradictory'
  if (rejected && !bridgeIssueTypes.includes(r.issueType as typeof bridgeIssueTypes[number])) return invalid()
  return { id: r.id, verdict: r.verdict as 'supported' | 'expandable' | 'contradictory', valid: !rejected,
    issueType: rejected ? r.issueType as typeof bridgeIssueTypes[number] : 'none' as const,
    reason: r.reason, evidence: parseBridgeEvidence(r.evidenceIds, rejected, r.id, catalog), expansionNeeds }
}

/** Stale notes cannot survive author edits or regeneration. */
export function currentExpansionNeeds(candidate: { action: string; possibleResult: string; futureChoice?: string;
  causalBridge?: { method: string; change: string }; explanation?: StoryPreparationExplanation; expansionNeeds?: StoryExpansionNeed[] }): StoryExpansionNeed[] {
  const explanation = candidate.explanation
  const current = explanation && explanation.wording.action === candidate.action && explanation.wording.possibleResult === candidate.possibleResult
    && (explanation.wording.futureChoice ?? '') === (candidate.futureChoice ?? '') ? explanation : undefined
  if (explanation && !current) return []
  const prose = { action: candidate.action, possibleResult: candidate.possibleResult, futureChoice: candidate.futureChoice,
    method: current?.method ?? candidate.causalBridge?.method, change: current?.change ?? candidate.causalBridge?.change }
  return structuredClone((candidate.expansionNeeds ?? []).filter(need => need.anchors.length
    && need.anchors.every(anchor => prose[anchor.field] === anchor.quote)))
}

/** One selection standard for direction review and editable explanations. */
export const storyExpansionSelectionGuidance = `标记依据是值得后续兑现的故事作用，不是某处还没写详细。判断：若不单独提醒，后续写作是否容易漏掉已选设计的重要因果支撑、人物变化、情绪效果、反差或前后呼应？会削弱这些作用才记录needs；普通细节由正文自然补足，needs可以为空，不为填满配额而标记，最多两项，优先保留最影响故事的一两处。
补因果过程仍然有用：已选办法怎样产生关键结果、重要道具为何可用、人物为何作出转变，都可以在正文补足必要铺垫和过程；不要求把每个生活动作追溯到底。判断对象是未来完整故事，卡片或method/change已概括某个效果，不表示正文已经兑现；也不要因为尚未写正文就给每个事件打标。
先区分三层：决定主要办法、人物关键选择或结果的骨架，应在构思与选择阶段明确，尚未确定时保留作者判断，不能用“待展开”替作者选定或掩盖空缺；已确定设计的重要作用尚需具体表现，才留给正文；影响不大的动作、寒暄、环境及常见物品通常不标记。未来选择列出多个分支不表示它们都已采用，不提前兑现未选分支。
标记类型：setup=重要因果铺垫；action-detail=实现已有办法的关键行动；response-detail=重要后果的回应；character-detail=已设计的人物或关系变化；emotional-beat=已设计的情绪蓄积、反转或释放；payoff=已设计的反差或前后呼应。每项只选当前提案原句编号，不新增情节或写解决方案。同一处作用重叠时选最主要类型，不重复标记。
人物、情绪与呼应须有当前设计中的具体支撑：例如与此前习惯不同的主动选择、重要关系从拒绝到接纳、已积累情绪的释放、前文要素在此重现。不能把普通友好、询问、照顾或任何带代价的选择自动拔高成人物成长，不为打标臆造前史、情感或伏笔；只有未来待选分支时，不预设其会形成哪种人物变化。
例如：采用换装脱身，衣服来由关系到关键办法成立，可标setup；换装后仍穿这身衣服去救人所形成的反差，可标payoff，即使因果已经成立也有保留价值；已决定放弃脱身去救人，可标character-detail提醒表现这个决定，不能把“是否去救”仍未确定的选择当作已定结局。普通询问意愿、扶人休息、拿普通夹子固定画纸、走错路后求助，不因动作或对白省略而标记；若同一动作已明确承担重要人物转变、情绪或呼应作用，再按该作用判断。明确写“留到正文”也不是自动打标条件，仍检查故事作用。
对照：普通坐下、递夹子→needs=[]；同样递夹子却是一直拒绝帮助的人第一次接受朋友照顾，且关系转变是本段重点→character-detail；简单拥抱寒暄→needs=[]；全段围绕长久等待后的重逢，平静寒暄转为拥抱落泪承担情绪释放→emotional-beat；旧话在结尾重现并交换照顾者身份→payoff。重要的是其在本故事的作用，不能按动作名称一律标记或一律忽略。`

export const storyDirectionDetailGuidance = `先区分三类内容，再给结论：supported=方向成立且没有值得单独保留的正文事项；expandable=方向成立，同时有值得正文兑现的重要故事作用，只用needs记录，不列成作者必须补答的问题；contradictory=已有文字之间的明确矛盾，或普通展开也无法成立的关键因果断裂，才提出问题。不能因省略细节或人物没有选最优办法拒绝；标记也不能替真正矛盾圆场或隐藏尚未确定的关键设计。
${storyExpansionSelectionGuidance}`

export function selectedExpansionNeeds(preparation?: StoryPreparation): StoryExpansionNeed[] {
  if (preparation?.status !== 'accepted-design') return []
  return preparation.candidates.filter(c => preparation.acceptedCandidateIds.includes(c.id)).flatMap(currentExpansionNeeds)
}

// These instructions are owned by the program. Reviewer reason strings never
// enter generation, and no note is promoted to fact evidence or an extra task.
export const storyExpansionGuidance = `待展开事项提醒兑现已选设计的重要故事作用，不是作者新增限制、已发生事实或角色必须另办的任务。仅当确认路径仍采用所引情节时自然展开：setup交代关键办法或转折的必要铺垫；action-detail表现已有办法的关键行动；response-detail表现重要后果的回应；character-detail通过行动与选择表现已确定的人物或关系变化；emotional-beat让已设计的情绪蓄积、反转或释放有可感的表现；payoff兑现已有反差或前后呼应，而非另造反转。因果成立并不表示人物、情绪与呼应作用已经表现，具体写法应服务所选故事。
先搭骨架再补表现：未确定的主要办法、关键选择和结果仍由创作者在相应阶段判断，不能以标记替作者选择，不能把多个未选分支全部写成已发生。普通对白、动作及合理背景可自然补足，未标记也不表示正文不能补细节，不必逐项向作者追问。仅“没写得详细”不是遗漏重要故事作用；不为逐条完成标记加入拖沓的解释或重复段落。
不得据此增加资格、认证、秘密能力或豁免来绕过限制，不改作者明确保留的未知。后续作者改换办法或确认不同结果时，舍弃不再相关的事项，不恢复旧预测。规划阶段无需现在写完细节；正文阶段在合适位置自然兑现重要作用，已由路径交代的无需重复。`

/** Program-owned excerpts: reviewers select IDs instead of retyping prose.
 * The catalog is request-local and never changes author text or proposal text. */
export function bridgeEvidenceCatalog(proposals: (BridgeReviewText & { id: string })[], authors: string[]): BridgeEvidenceEntry[] {
  const catalog: BridgeEvidenceEntry[] = []
  authors.forEach((quote, index) => {
    if (quote.trim()) catalog.push({ id: `a${index}`, candidateId: null, field: 'author', quote })
  })
  proposals.forEach((proposal, index) => {
    for (const field of bridgeEvidenceFields) if (field !== 'author' && proposal[field]?.trim()) {
      catalog.push({ id: `p${index}-${field}`, candidateId: proposal.id, field, quote: proposal[field] })
    }
  })
  return catalog
}

export function parseBridgeEvidence(value: unknown, rejected: boolean, candidateId: string, catalog: BridgeEvidenceEntry[]): BridgeEvidence[] {
  // Only a rejection uses evidence to change the story. Optional supporting
  // IDs on an approval are discarded, so they cannot reject a valid proposal
  // or enter the repair input. Transport schema still checks their encoding.
  if (!rejected) return []
  const invalid = (): never => { throw new AppError('审阅依据编号不合法：只能选择当前方向或作者原文的evidenceCatalog编号；拒绝须提供至少两个不同编号，至少一个来自当前提案。请重审全部原提案，不改写故事或引用原文。', 502, 'STORY_PREPARATION_INVALID_OUTPUT') }
  const evidence = selectStoryEvidence(value, catalog, entry => entry.candidateId === null || entry.candidateId === candidateId,
    2, 4, invalid).map(entry => ({ field: entry.field, quote: entry.quote }))
  if (evidence.length < 2 || !evidence.some(e => e.field !== 'author')) return invalid()
  return evidence
}

const repairProblems = {
  'author-conflict': '对照所列作者原文与当前提案，保留作者已定事实、限制及未知，改写冲突的发展。',
  'world-implausible': '对照所列办法与结果，检查关键作用途径及明确能力限制；可换普通可用手段，或保留失败及其后果。',
  'causal-gap': '对照所列行动、变化与后续选择，修复具体连接或状态冲突；允许失败、核实和条件分支。',
  'mainline-drift': '对照所列发展与原愿望、关系或代价，让这次办法的后果继续影响后续取舍；允许有动机的目标转变。',
} as const

/** Reviewer prose is diagnostic data, never an instruction to the composer.
 * Only a program-owned problem and validated story excerpts cross this boundary. */
export function bridgeRepairDiagnostic(check: { id: string; issueType: string; evidence?: BridgeEvidence[] }) {
  const fields = new Set(check.evidence?.map(e => e.field))
  const reason = check.issueType === 'causal-gap' && fields.has('method') && fields.has('change') && !fields.has('futureChoice')
    ? '核对所列办法是否具备产生所述结果的作用途径。可换普通可用手段，或让结果保留未奏效及其后果；不要只调整措辞继续声称同一结果。'
    : repairProblems[check.issueType as keyof typeof repairProblems] ?? '核对当前发展与明确条件的连接。'
  return { id: check.id, issueType: check.issueType,
    reason,
    evidence: check.evidence ?? [] }
}
