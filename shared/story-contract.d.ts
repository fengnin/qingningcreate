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
  source: 'user' | 'system-draft' | 'predicament' | 'confirmed-action'
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
  /**
   * A provisional premise proposed after the user explicitly chooses the
   * system-led route. It is never extracted from or attributed to the input.
   */
  systemDraft?: StoryConflictCoreSystemDraft
  worldMode: 'realistic-default' | 'user-specified'
  expansionScope: StoryExpansionScope
  unknowns: string[]
}

/**
 * Facts the user explicitly confirms when an initial idea is too sparse to
 * support several grounded conflict cores.
 */
export interface StoryConflictCoreContext {
  goal?: string
  stake?: string
  constraint?: string
}

/**
 * Original-text suggestions that the user may review before confirming a
 * conflict-core context. These values never introduce facts on their own.
 */
export interface StoryConflictCoreContextPrefill {
  goal?: string
  stake?: string
  constraint?: string
}

/**
 * A mechanism premise proposed for one independent system-led branch.
 * These premises are alternatives, not facts that all become true together.
 */
export type StoryConflictCoreMechanismType =
  | 'information-gap'
  | 'boundary-conflict'
  | 'meaning-commitment'
  | 'initiation-block'
  | 'window-pressure'
  | 'resource-constraint'
  | 'commitment-conflict'

export interface StoryConflictCoreSystemDraftDirection {
  label: string
  mechanismType: StoryConflictCoreMechanismType
  premise: string
  tradeoff: string
}

/**
 * The system's clearly labelled, editable premise for a sparse idea. It is
 * only present when the user asks the system to draft a first direction.
 */
export interface StoryConflictCoreSystemDraft {
  goal: string
  stake: string
  constraint: string
  /**
   * Three mutually exclusive branch premises. Optional for persisted sessions
   * created before branch planning was introduced.
   */
  directions?: StoryConflictCoreSystemDraftDirection[]
  /** The one branch carried forward after the user makes a selection. */
  activeDirection?: StoryConflictCoreSystemDraftDirection
}

/**
 * The first-layer choice. It names the preserved goal, the single obstacle,
 * and the thing the protagonist cannot keep while continuing.
 */
export interface StoryConflictCore {
  id: string
  title: string
  variationAxis: StoryVariationAxis
  preservedGoal: string
  obstacle: string
  tradeoff: string
}

export type StoryConflictCores = [StoryConflictCore, StoryConflictCore, StoryConflictCore]

export interface StoryPredicament {
  id: string
  title: string
  variationAxis: StoryVariationAxis
  preservedGoal: string
  immediateSituation: string
  obstacle: string
  tradeoff: string
  urgency: string
  choice: string
  plausibleCost: string
  approaches: StoryPredicamentApproach[]
  facts: StoryFact[]
  actions: StoryAction[]
}

export interface StoryPredicamentApproach {
  id: string
  intent: string
  cost: string
}

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

export interface StoryRefinement<TFocus extends string> {
  focus: TFocus
  feedback: string
}

export type StoryOptionRefinement<TFocus extends string> = StoryRefinement<TFocus> & {
  optionId: string
}

export type StoryPredicamentRefinementFocus = 'scene' | 'urgency' | 'facts' | 'approaches' | 'costs'

export type StoryPredicamentRefinement = StoryRefinement<StoryPredicamentRefinementFocus>

export type StoryHeadTailRefinementFocus = 'opening' | 'development' | 'resolution' | 'cost' | 'tone'

export type StoryHeadTailRefinement = StoryOptionRefinement<StoryHeadTailRefinementFocus>

export type StoryTurnOptionRefinementFocus = 'action' | 'consequence' | 'tradeoff' | 'tone'

export type StoryTurnOptionRefinement = StoryOptionRefinement<StoryTurnOptionRefinementFocus>

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
  approach: StoryPredicamentApproach
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
  context?: StoryConflictCoreContext
  generateSystemDraft?: boolean
  preference?: string
  excludedTitles?: string[]
  storyId?: string
  revision?: number
}

export interface StoryPredicamentSessionRequest extends StorySessionVersion {
  conflictCoreId: string
}

export interface StoryHeadTailSessionRequest extends StorySessionVersion {
  predicamentId: string
  approachId: string
}

export interface StoryTurnSessionRequest {
  storyId: string
  revision: number
  mode: StoryTurnMode
  headTailId?: string
  turnId?: string
  optionId?: string
}

export interface StoryTurnOptionRefinementRequest extends StorySessionVersion, StoryTurnOptionRefinement {
  turnId: string
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
  conflictCores: StoryConflictCores
}

export type StoryConflictCoresResponse = StoryDirectionsResponse

export interface StoryPredicamentResponse extends StorySessionVersion {
  predicament: StoryPredicament
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
    conflictCoreContextPrefill?: StoryConflictCoreContextPrefill
    systemDraftPrefill?: StoryConflictCoreSystemDraft
  }
}

export interface HealthResponse {
  ok: true
  model: string
  configured: boolean
}
