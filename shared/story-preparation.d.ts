/** Pre-curve review. Quotations are author material, interpretation is not a
 * new fact. Author acceptance records future design, never execution. */
export interface StoryPreparationQuote { sourceId: string; quote: string }
export interface StoryPreparationItem extends StoryPreparationQuote {
  id: string
  role: 'fact' | 'condition' | 'goal' | 'unknown'
}
export interface StoryPreparationQuestion {
  id: string
  question: string
  materialIds: string[]
}
export interface StoryPreparationCandidate {
  id: string
  action: string
  materialIds: string[]
  preconditionIds: string[]
  /** A possible result, never a prediction certified by the server. */
  possibleResult: string
  resultBasisIds: string[]
  unknownIds: string[]
}
/** Author-reviewed wording; accepting a future design is never execution. */
export interface StoryPreparationReview {
  originalText: string
  candidates: { id: string; action: string; possibleResult: string; resultBasisIds?: string[] }[]
  /** Explicit author revision; originals remain in material for audit. */
  supersededMaterialIds?: string[]
  confirmedQuotes?: string[]
}
export interface StoryPreparationSupplement {
  id: string
  kind: 'hypothesis' | 'observation' | 'criterion' | 'condition'
  text: string
  question: string
  materialIds: string[]
  status: 'needs-review' | 'accepted-design' | 'rejected' | 'keep-unknown'
  authorText?: string
}
export interface StoryPreparation {
  protocol: 1
  status: 'needs-review' | 'accepted-design'
  sources: { id: string; text: string }[]
  material: StoryPreparationItem[]
  candidates: StoryPreparationCandidate[]
  questions: StoryPreparationQuestion[]
  acceptedCandidateIds: string[]
  authorReview?: StoryPreparationReview
  /** Historical proposals are never overwritten by reviewed wording. */
  originalCandidates?: StoryPreparationCandidate[]
  /** Rejected directions are exclusions, never material or execution facts. */
  rejectedCandidates?: StoryPreparationCandidate[]
  supplements?: StoryPreparationSupplement[]
  executed: false
}
