/** Shared evidence, separate stage outputs. No model output may contain an
 * executed result or a fact-state transition. Citations establish provenance,
 * never causal truth. Design acceptance remains a future arrangement. */
export type StoryReasoningStage = 'initial-design' | 'edit-preview' | 'action-candidates'

export interface StoryReasoningSource {
  id: string
  text: string
  authority: 'author-material' | 'author-confirmed-result' | 'author-design' | 'unknown'
}

export interface StoryReasoningEvidence { sourceId: string; quote: string }

export type StoryReasoningBasis =
  | { kind: 'author-text'; evidence: StoryReasoningEvidence[] }
  | { kind: 'design-proposal'; evidence: StoryReasoningEvidence[]; unknownIds: string[] }
  | { kind: 'unknown'; unknownIds: string[] }

export interface StoryReasoningStatement {
  id: string
  text: string
  basis: StoryReasoningBasis
}

export interface StoryReasoningAction extends StoryReasoningStatement {
  constraintIds: string[]
  relationIds: string[]
  unknownIds: string[]
  respondsToEditIds: string[]
}

export interface StoryReasoningRelation extends StoryReasoningStatement {
  relation: 'cause' | 'conflict' | 'compatible' | 'sequence'
  fromIds: string[]
  toIds: string[]
}

export interface StoryReasoningUnknown {
  id: string
  question: string
  sourceIds: string[]
  dependentIds: string[]
}

export interface StoryReasoningDesignStep extends StoryReasoningStatement {
  kind: 'current-state' | 'character-tension' | 'trigger' | 'escalation' | 'midpoint-turn' | 'climax-choice' | 'resolution'
  title: string
  actionIds: string[]
  relationIds: string[]
  dependsOn: string[]
  respondsToEditIds: string[]
}

export interface StoryReasoningCommon {
  protocol: 1
  status: 'needs-review'
  goal: StoryReasoningStatement | null
  constraints: StoryReasoningStatement[]
  actions: StoryReasoningAction[]
  relations: StoryReasoningRelation[]
  unknowns: StoryReasoningUnknown[]
}

export type StoryReasoningProposal = StoryReasoningCommon & (
  | { stage: 'initial-design' | 'edit-preview'; outcome: 'proposal'; steps: StoryReasoningDesignStep[] }
  | { stage: 'action-candidates'; outcome: 'proposal'; options: { id: string; label: string; actionId: string }[] }
  /** Questions are review requests, not a diagnosis that the author failed to
   * supply enough information. No fake alternatives or completed plan. */
  | { stage: StoryReasoningStage; outcome: 'questions'; questions: { unknownId: string; dependentIds: string[] }[] }
)

/** Model-facing information is untrusted. Validation compares it with this
 * server-owned context; models cannot declare an edit or unknown resolved. */
export interface StoryReasoningValidationContext {
  stage: StoryReasoningStage
  sources: StoryReasoningSource[]
  protectedSteps: { id: string; text: string }[]
  requiredEditIds: string[]
  externalNodeIds?: string[]
  excludedUnknowns?: { id: string; sourceIds: string[] }[]
  lockedGoal?: string
  previewTargetIds?: string[]
}

export interface StoryReasoningDesignAcceptance {
  status: 'accepted-design'
  proposal: StoryReasoningProposal
  /** Acceptance records are outside the narrative fact ledger. */
  executed: false
}

/** An execution confirmation is a separate author request, never a model
 * stage or a consequence inferred from accepting a design. */
export interface StoryReasoningAuthorResult {
  stage: 'author-result'
  proposalId: string
  actionText: string
  resultText: string
}
