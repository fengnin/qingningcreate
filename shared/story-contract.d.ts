export type ReviewTone = 'pass' | 'warn'

export interface StoryBeat {
  label: string
  detail: string
}

export type StoryExpansionScope = 'keep-scale' | 'grounded-obstacle' | 'larger-story' | 'genre-led'

export type StoryVariationAxis = 'time' | 'resource' | 'relationship' | 'commitment'

export type StoryGoalState = 'trying' | 'blocked' | 'changed-plan' | 'near-completion' | 'resolved'

export type StoryFactMutability = 'fixed' | 'changeable' | 'unknown'

export interface StoryFact {
  id: string
  statement: string
  source: 'user' | 'predicament' | 'confirmed-action'
  mutability: StoryFactMutability
}

export interface StoryAction {
  id: string
  intent: string
  preconditions: string[]
  effects: string[]
  source: 'user-choice' | 'generated'
}

export interface StoryFactChange {
  factId: string
  statement: string
}

export interface StoryTransition {
  actionId: string
  consumedFacts: string[]
  changedFacts: StoryFactChange[]
  introducedFacts: StoryFact[]
}

export interface StoryNarrativeState {
  revision: number
  facts: StoryFact[]
  actions: StoryAction[]
  appliedTransitions: StoryTransition[]
}

export interface StorySeed {
  subject: string
  activeSituation: string
  lockedGoal: string | null
  lockedFacts: string[]
  worldMode: 'realistic-default' | 'user-specified'
  expansionScope: StoryExpansionScope
  unknowns: string[]
}

export interface StoryPredicament {
  id: string
  title: string
  variationAxis: StoryVariationAxis
  preservedGoal: string
  immediateSituation: string
  obstacle: string
  urgency: string
  choice: string
  plausibleCost: string
  facts: StoryFact[]
  actions: StoryAction[]
}

export type StoryPredicaments = [StoryPredicament, StoryPredicament, StoryPredicament]

export interface StoryHeadTailOption {
  id: string
  opening: string
  openingClue: string
  climax: string
  resolution: string
  cost: string
  promise: string
  climaxActionId: string
  transition: StoryTransition
}

export type StoryHeadTailOptions = [StoryHeadTailOption, StoryHeadTailOption, StoryHeadTailOption]

export interface StoryNode {
  id: string
  title: string
  event: string
  purpose: string
  goalState: StoryGoalState
}

export interface StoryConflict {
  nodeId: string
  conflict: string
  action: string
  consequence: string
  intensity: number
  anchor: string
}

export interface StoryTurnOption {
  id: string
  label: string
  action: string
  immediateConsequence: string
  /**
   * A pending narrative thread for the next turn, not a confirmed event. It
   * must never be presented as an outcome that has already happened.
   */
  laterEffect: string
  narrativeAction: StoryAction
  transition: StoryTransition
}

export type StoryTurnPhase = 'opening' | 'development' | 'turn' | 'climax' | 'resolution'

export type StoryTurnMode = 'start' | 'continue' | 'conclude'

export interface StoryTurn {
  id: string
  phase: StoryTurnPhase
  node: StoryNode
  conflict: StoryConflict
  question: string | null
  options: StoryTurnOption[]
  /**
   * Ongoing turns only offer actions for the reader to choose. A resolution
   * turn records the distinct action that actually completes the story after
   * all confirmed choices have happened.
   */
  narrativeAction: StoryAction | null
  transition: StoryTransition | null
  canConclude: boolean
  isConclusion: boolean
}

export interface StoryTurnHistoryItem {
  turnId: string
  phase: StoryTurnPhase
  node: StoryNode
  conflict: StoryConflict
  selectedOption: StoryTurnOption
}

export interface StoryPlan {
  seed: StorySeed
  predicament: StoryPredicament
  headTail: StoryHeadTailOption
  turnHistory: StoryTurnHistoryItem[]
  conclusion: StoryTurn
}

export interface StoryReviewItem {
  label: string
  value: string
  detail: string
  tone: ReviewTone
}

export interface GeneratedStory {
  title: string
  logline: string
  body: string
  outline: StoryBeat[]
  review: StoryReviewItem[]
}

export interface StoryDirectionsRequest {
  idea: string
  expansionScope?: StoryExpansionScope
  preference?: string
  excludedTitles?: string[]
  storyId?: string
  revision?: number
}

export interface StoryHeadTailSessionRequest {
  storyId: string
  revision: number
  predicamentId: string
}

export interface StoryTurnSessionRequest {
  storyId: string
  revision: number
  mode: StoryTurnMode
  headTailId?: string
  turnId?: string
  optionId?: string
}

export interface StoryGenerationSessionRequest {
  storyId: string
  revision: number
}

export interface StorySessionVersion {
  storyId: string
  revision: number
}

export interface StoryDirectionsResponse extends StorySessionVersion {
  seed: StorySeed
  directions: StoryPredicaments
}

export interface StoryHeadTailResponse extends StorySessionVersion {
  options: StoryHeadTailOptions
}

export interface StoryTurnResponse extends StorySessionVersion {
  history: StoryTurnHistoryItem[]
  turn: StoryTurn
}

export interface StoryGenerationResponse extends StorySessionVersion {
  story: GeneratedStory
}

export interface ApiErrorResponse {
  error: {
    code: string
    message: string
  }
}

export interface HealthResponse {
  ok: true
  model: string
  configured: boolean
}
