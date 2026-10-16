import { AppError } from './qwen.js'
import { shape as s } from './modelOutputSchema.js'
import type { StoryExpansionNeed, StoryPreparation } from '../../shared/story-preparation.js'

export const bridgeEvidenceFields = ['author', 'action', 'possibleResult', 'method', 'change', 'futureChoice'] as const
export type BridgeEvidence = { field: typeof bridgeEvidenceFields[number]; quote: string }
export type BridgeReviewText = Record<Exclude<BridgeEvidence['field'], 'author'>, string>
export type BridgeEvidenceEntry = BridgeEvidence & { id: string; candidateId: string | null }

export const bridgeEvidenceSchema = s.array(s.text, 0, 4)
export const expansionKinds = ['setup', 'action-detail', 'response-detail'] as const
export const bridgeIssueTypes = ['causal-gap', 'mainline-drift', 'world-implausible'] as const

// Keep a single wire shape. Real Qwen requests with separate anyOf branches
// locked every verdict to the first branch, even when the reason rejected it.
// The verdict controls the branch. Non-applicable notes are discarded rather
// than turning a clear rejection into another format retry or a writing task.
export const bridgeReviewCheckSchema = (ids?: string[]) => {
  const refs = ids?.length ? s.enum(...ids) : s.text
  return s.object({ id: s.text, verdict: s.enum('supported', 'expandable', 'contradictory'), reason: s.text,
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
    || typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > 500) return invalid()
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
  causalBridge?: { method: string; change: string }; expansionNeeds?: StoryExpansionNeed[] }): StoryExpansionNeed[] {
  const prose = { action: candidate.action, possibleResult: candidate.possibleResult, futureChoice: candidate.futureChoice,
    method: candidate.causalBridge?.method, change: candidate.causalBridge?.change }
  return structuredClone((candidate.expansionNeeds ?? []).filter(need => need.anchors.length
    && need.anchors.every(anchor => prose[anchor.field] === anchor.quote)))
}

export function selectedExpansionNeeds(preparation?: StoryPreparation): StoryExpansionNeed[] {
  if (preparation?.status !== 'accepted-design') return []
  return preparation.candidates.filter(c => preparation.acceptedCandidateIds.includes(c.id)).flatMap(currentExpansionNeeds)
}

// These instructions are owned by the program. Reviewer reason strings never
// enter generation, and no note is promoted to fact evidence or an extra task.
export const storyExpansionGuidance = `待展开事项是已选方向里尚未具体表现的铺垫或过程，不是作者新增限制、已发生事实或角色必须另办的任务。仅当确认路径仍采用所引情节时自然展开：setup交代已有提案中的道具、信息或转折的必要铺垫；action-detail表现已有办法的关键动作或尝试；response-detail表现已有变化对应的反应与选择。普通对白、动作及合理背景可自然补充，不必额外取得作者确认。不得据此增加资格、认证、秘密能力或豁免来绕过限制，不改作者明确保留的未知。后续作者改换办法或确认不同结果时，舍弃不再相关的事项，不恢复旧预测。规划阶段无需现在写完细节；正文阶段应在相关结果之前或发生时自然兑现，已由路径交代的无需重复。`

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
  if (!Array.isArray(value) || value.length > 4) return invalid()
  if (new Set(value).size !== value.length) return invalid()
  const evidence = value.map(id => {
    const entry = catalog.find(entry => entry.id === id)
    if (!entry || entry.candidateId !== null && entry.candidateId !== candidateId) return invalid()
    return { field: entry.field, quote: entry.quote }
  })
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
