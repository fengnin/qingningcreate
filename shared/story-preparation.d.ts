/** Pre-curve review. Quotations are author material, interpretation is not a
 * new fact. Author acceptance records future design, never execution. */
export interface StoryPreparationQuote { sourceId: string; quote: string }
/** Selected source excerpts for creative development, never inferred facts or
 * mandatory plot/ending requirements. */
export interface StoryCreativeFocus {
  authority: 'creative-reference'
  excerpts: string[]
}
export interface StoryPreparationItem extends StoryPreparationQuote {
  id: string
  role: 'fact' | 'condition' | 'goal' | 'unknown'
}
export interface StoryPreparationQuestion {
  id: string
  question: string
  materialIds: string[]
}
export interface StoryMainlineAnchor {
  id: string
  kind: 'character' | 'relationship' | 'place' | 'action' | 'object' | 'constraint'
  sourceId: string
  quote: string
}
export interface StoryMainlineGoal {
  id: string
  sourceId: string
  /** One continuous author-text clause that keeps the actor, activity and place/object together. */
  quote: string
}
export interface StoryCausalBridge {
  method: string
  change: string
  methodBasisIds: string[]
  changeBasisIds: string[]
}
/** A writing obligation anchored to the current proposal, never a new fact or
 * a reviewer-authored solution. Only relevant while that proposal is retained. */
export interface StoryExpansionNeed {
  kind: 'setup' | 'action-detail' | 'response-detail'
  anchors: { field: 'action' | 'possibleResult' | 'method' | 'change' | 'futureChoice'; quote: string }[]
}
export interface StoryPreparationCandidate {
  id: string
  action: string
  /** A provisional next-level story choice, not a character decision already made. */
  futureChoice?: string
  materialIds: string[]
  preconditionIds: string[]
  /** A possible result, never a prediction certified by the server. */
  possibleResult: string
  resultBasisIds: string[]
  unknownIds: string[]
  /** Internal causal bridge; all text remains future design, never execution. */
  causalBridge?: StoryCausalBridge
  expansionNeeds?: StoryExpansionNeed[]
}
/** Author-reviewed wording; accepting a future design is never execution. */
export interface StoryPreparationReview {
  originalText: string
  candidates: { id: string; action: string; possibleResult: string; futureChoice?: string; resultBasisIds?: string[] }[]
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
  /** Explicit elements of the author's premise, quoted from source text. */
  mainlineAnchors?: StoryMainlineAnchor[]
  mainlineGoals?: StoryMainlineGoal[]
  /** Soft focus selected during existing intent extraction; original IDs only. */
  appealMaterialIds?: string[]
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
