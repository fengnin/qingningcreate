export interface StoryPreparationAcceptanceRequest {
  storyId: string
  revision: number
  curveId: string
  acceptedCandidateIds: string[]
  /** Optional only for compatibility with existing ID-only clients. */
  authorReview?: import('./story-preparation.js').StoryPreparationReview
}
export interface StoryPreparationSupplementRequest {
  storyId: string
  revision: number
  curveId: string
  supplementId: string
  decision: 'accepted-design' | 'rejected' | 'keep-unknown'
  authorText: string
}
export interface StoryPreparationRevisionRequest {
  storyId: string
  revision: number
  curveId: string
  decision: 'reject' | 'regenerate' | 'revise'
  candidateId?: string
  authorAction?: string
}
export interface StoryPreparationExplanationRequest {
  storyId: string
  revision: number
  curveId: string
  candidate: { id: string; action: string; possibleResult: string; futureChoice?: string }
}
