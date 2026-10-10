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
