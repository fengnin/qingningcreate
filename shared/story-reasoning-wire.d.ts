import type { StoryReasoningEvidence, StoryReasoningDesignStep, StoryReasoningProposal } from './story-reasoning-contract.js'

/** Model-only protocol. Persisted sessions and frontend use reviewed protocol1.
 * Quote display is exactly quote; there is no second text to reconcile. */
export type StoryReasoningWireContent =
  | { kind: 'quote'; sourceId: string; quote: string }
  | { kind: 'proposal'; text: string; evidence: StoryReasoningEvidence[]; unknownIds: string[] }
  | { kind: 'unknown'; text: string; unknownIds: string[] }

export interface StoryReasoningWireStatement { id: string; content: StoryReasoningWireContent }
export type StoryReasoningWireGoal = StoryReasoningWireStatement | { id: string; content: { kind: 'locked-goal' } } | null
export interface StoryReasoningWireCommon {
  protocol: 2
  status: 'needs-review'
  goal: StoryReasoningWireGoal
  constraints: StoryReasoningWireStatement[]
  actions: (StoryReasoningWireStatement & { constraintIds: string[]; relationIds: string[]; unknownIds: string[]; respondsToEditIds: string[] })[]
  relations: (StoryReasoningWireStatement & { relation: 'cause' | 'conflict' | 'compatible' | 'sequence'; fromIds: string[]; toIds: string[] })[]
  unknowns: StoryReasoningProposal['unknowns']
}
export type StoryReasoningWireOutput = StoryReasoningWireCommon & (
  | { stage: 'initial-design' | 'edit-preview'; outcome: 'proposal'; steps: (StoryReasoningWireStatement & Omit<StoryReasoningDesignStep, 'text' | 'basis' | 'id'>)[] }
  | { stage: 'initial-design' | 'edit-preview'; outcome: 'questions'; questions: { unknownId: string; dependentIds: string[] }[] }
)
