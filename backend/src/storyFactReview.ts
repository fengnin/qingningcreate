import { AppError } from './qwen.js'
import { shape as s } from './modelOutputSchema.js'
import type { BridgeEvidence, BridgeEvidenceEntry } from './storyBridgeReview.js'

// One shape and one explicit verdict. A citation is evidence, never a verdict.
export const factReviewCheckSchema = (candidateIds?: string[], materialIds?: string[], proposalIds?: string[]) => {
  const refs = (ids?: string[]) => s.array(ids?.length ? s.enum(...ids) : s.text, 0, ids ? ids.length : 24)
  return s.object({ id: candidateIds?.length ? s.enum(...candidateIds) : s.text,
    verdict: s.enum('compatible', 'contradictory'), conflictMaterialIds: refs(materialIds),
    proposalEvidenceIds: refs(proposalIds), reason: s.text })
}

export function parseFactReviewChecks(raw: unknown, candidateIds: string[], material: { id: string; quote: string }[], catalog: BridgeEvidenceEntry[]) {
  const invalid = (): never => { throw new AppError('事实审阅输出无效：明确给出compatible或contradictory；compatible的两类冲突依据均须为空，contradictory须同时选择冲突作者材料及当前方向的提案原文。请只重审原提案，不修改故事或补写事实。', 502, 'STORY_PREPARATION_INVALID_OUTPUT') }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1 || !('checks' in raw)
    || !Array.isArray(raw.checks) || raw.checks.length !== candidateIds.length) return invalid()
  const checks = raw.checks.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
    const r = value as Record<string, unknown>
    const keys = ['id', 'verdict', 'conflictMaterialIds', 'proposalEvidenceIds', 'reason']
    if (Object.keys(r).length !== keys.length || keys.some(key => !(key in r))
      || typeof r.id !== 'string' || !candidateIds.includes(r.id)
      || !['compatible', 'contradictory'].includes(String(r.verdict))
      || typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > 500) return invalid()
    const id = r.id
    const readRefs = (value: unknown, allowed: string[]) => {
      if (!Array.isArray(value) || value.length > allowed.length || new Set(value).size !== value.length
        || value.some(ref => typeof ref !== 'string' || !allowed.includes(ref))) return invalid()
      return value as string[]
    }
    const authorRefs = readRefs(r.conflictMaterialIds, material.map(m => m.id))
    const proposalRefs = readRefs(r.proposalEvidenceIds, catalog.filter(e => e.candidateId === id).map(e => e.id))
    const valid = r.verdict === 'compatible'
    if (valid ? authorRefs.length || proposalRefs.length : !authorRefs.length || !proposalRefs.length) return invalid()
    const evidence: BridgeEvidence[] = [
      ...authorRefs.map(ref => ({ field: 'author' as const, quote: material.find(m => m.id === ref)!.quote })),
      ...proposalRefs.map(ref => { const e = catalog.find(e => e.id === ref)!; return { field: e.field, quote: e.quote } }),
    ]
    return { id, valid, evidence, issueType: valid ? 'none' as const : 'author-conflict' as const, reason: r.reason }
  })
  if (new Set(checks.map(check => check.id)).size !== candidateIds.length) return invalid()
  return checks
}
