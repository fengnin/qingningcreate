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
  source: 'user' | 'system-draft' | 'predicament' | 'confirmed-curve' | 'confirmed-action'
  mutability: StoryFactMutability
  /** Curve nodes that established this fact after the author confirmed them. */
  originCurveBeatIds?: string[]
}

export interface StoryAction {
  id: string
  intent: string
  preconditions: string[]
  effects: string[]
  source: 'user-choice' | 'generated'
  /** Curve nodes that constrain this action after the author confirms a curve. */
  originCurveBeatIds?: string[]
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
   * A provisional premise proposed by the system for a sparse idea. It is
   * never extracted from or attributed to the input.
   */
  systemDraft?: StoryConflictCoreSystemDraft
  /** The author's lightweight direction for the current story. */
  creativeBrief?: CreativeBrief
  worldMode: 'realistic-default' | 'user-specified'
  expansionScope: StoryExpansionScope
  unknowns: string[]
}

export type CreativeTone = 'comedy' | 'warm' | 'friendship' | 'romance' | 'growth' | 'mystery' | 'fantasy'

export type DramaticForce = 'misunderstanding' | 'cost' | 'surprise' | 'contrast' | 'relationship-tension'

/**
 * Choices that guide proposals without becoming story facts by themselves.
 * All fields except the naming permission may stay empty.
 */
export interface CreativeBrief {
  tones: CreativeTone[]
  dramaticForces: DramaticForce[]
  allowSystemNamedCharacters: boolean
  note?: string
}

export type CurveBeatKind =
  | 'current-state'
  | 'character-tension'
  | 'trigger'
  | 'escalation'
  | 'midpoint-turn'
  | 'climax-choice'
  | 'resolution'

export type CurveBeatSource = 'user-input' | 'system-proposal' | 'user-edit' | 'undecided'

export type CurveBeatStatus = 'proposed' | 'edited' | 'confirmed' | 'stale' | 'rejected'

/** A verbatim or lightly segmented piece of material supplied by the author. */
export interface StorySourceFact {
  id: string
  text: string
  source: 'user-input' | 'author-supplement'
  /** The clarification whose verbatim answer created this fact, if any. */
  clarificationId?: string
  /**
   * A fact may only be parked after the author explicitly chooses not to use
   * it in this version. A pending fact blocks curve confirmation.
   */
  disposition: 'integrated' | 'needs-author-decision' | 'parked'
  coveredByBeatIds: string[]
}

export type StoryAuthorClarificationStatus =
  | 'unanswered'
  | 'author-unknown'
  | 'needs-review'
  | 'confirmed'

export type StoryAuthorUnknownHandling =
  | 'keep-unknown'
  | 'request-independent-proposal'
  | 'abandon-dependent-proposal'

export type StoryClarificationRequirement = 'review-beat' | 'confirm-curve'

export interface StoryClarificationDependency {
  beatIds: string[]
  causalGap: string
  requiredFor: StoryClarificationRequirement[]
}

/**
 * A review question is not a story fact. Its answer becomes a source fact
 * only after the author explicitly confirms it.
 */
export interface StoryAuthorClarification {
  id: string
  prompt: string
  status: StoryAuthorClarificationStatus
  answerText?: string
  unknownHandling?: StoryAuthorUnknownHandling
  dependency: StoryClarificationDependency
  source: 'author-review'
  sourceFactId?: string
  resolution?: 'answer-applied' | 'independent-proposal-accepted' | 'proposal-abandoned'
  createdAt: number
  updatedAt: number
  confirmedAt?: number
}

/**
 * The single pre-story design record. It ties source material to the curve's
 * conflict, concrete predicament, endpoints and middle development instead
 * of treating the curve as a parallel generator.
 */
export interface StoryDesignRecord {
  id: string
  sourceFacts: StorySourceFact[]
  conflictCoreBeatIds: string[]
  predicamentBeatIds: string[]
  storyEndBeatIds: string[]
  middleDevelopmentBeatIds: string[]
  /**
   * The concrete design map assembled while the curve is still a draft. It is
   * intentionally stored beside the beat references so confirmation freezes a
   * design that was already reviewed, rather than reconstructing one later.
   */
  foundation?: StoryCurveFoundation
}

/**
 * The reviewed, pre-story foundation shared by the curve and the first turn.
 * These are design statements, not path facts: they become narrative state
 * only after the author confirms the curve and starts the spine.
 */
export interface StoryCurveFoundation {
  /** The concrete conflict core that the author is reviewing before confirmation. */
  conflictCore: {
    goal: string
    obstacle: string
    tradeoff: string
  }
  preservedGoal: string
  predicament: {
    title: string
    variationAxis: StoryVariationAxis
    immediateSituation: string
    obstacle: string
    tradeoff: string
    urgency: string
    choice: string
    plausibleCost: string
  }
  middleDevelopment: {
    escalation: string
    midpoint: string
    climaxPressure: string
  }
  storyEnds: {
    opening: string
    openingClue: string
    climax: string
    resolution: string
    cost: string
    promise: string
  }
  approach: {
    intent: string
    cost: string
  }
  /**
   * Explicit traceability for the design map. A fact may support more than one
   * design section, but every live fact must appear in at least one section.
   * Legacy persisted curves may omit this field and are treated as requiring
   * regeneration before confirmation.
   */
  sourceFactIds?: {
    conflictCore: string[]
    predicament: string[]
    middleDevelopment: string[]
    storyEnds: string[]
  }
  /**
   * Content fingerprints make the frozen foundation conditional on the exact
   * draft the author reviewed. They prevent a stale foundation from being
   * reused after an out-of-band beat edit.
   */
  beatSignatures?: Record<string, string>
}

export interface CurveGenerationMetadata {
  origin: 'model' | 'fact-preserving-fallback'
  notice?: string
  dramaticMechanism: string
}

export interface CurveBeat {
  id: string
  kind: CurveBeatKind
  title: string
  detail: string
  source: CurveBeatSource
  status: CurveBeatStatus
  dependsOn: string[]
  /** User-source facts this node must preserve or develop. */
  sourceFactIds?: string[]
  /**
   * A short causal handle carried to the next proposal. It is deliberately
   * separate from the display sentence so downstream regeneration cannot
   * quote an entire upstream node as if it were a new fact.
   */
  causalAnchor?: string
}

export type AuthorInstructionKind = 'replace' | 'remove' | 'regenerate' | 'author-revision' | 'park-fact'

/** A deliberate author-level edit. It is never a character action. */
export interface AuthorInstruction {
  id: string
  kind: AuthorInstructionKind
  text: string
  targetBeatId?: string
  createdAt: number
}

export type ProvisionalCurveStatus = 'draft' | 'confirmed' | 'superseded'

/**
 * The sole pre-story source of truth. Its beats contain proposal material,
 * never path facts, until the author confirms the whole curve.
 */
export interface ProvisionalCurve {
  id: string
  title: string
  status: ProvisionalCurveStatus
  brief: CreativeBrief
  beats: CurveBeat[]
  /**
   * Proposals the author explicitly rejected and that were replaced in the
   * current slot. Keeping this audit trail prevents a replacement or later
   * version from silently treating the rejected wording as acceptable.
   */
  rejectedProposals?: CurveBeat[]
  instructions: AuthorInstruction[]
  clarifications?: StoryAuthorClarification[]
  design?: StoryDesignRecord
  /** Concrete foundation assembled before confirmation; legacy sessions may omit it. */
  foundation?: StoryCurveFoundation
  generation?: CurveGenerationMetadata
  createdAt: number
  updatedAt: number
}

export interface ConfirmedCurve {
  id: string
  provisionalCurveId: string
  title: string
  brief: CreativeBrief
  beats: CurveBeat[]
  rejectedProposals?: CurveBeat[]
  clarifications?: StoryAuthorClarification[]
  design?: StoryDesignRecord
  /** Frozen design foundation reviewed with the provisional curve. */
  foundation?: StoryCurveFoundation
  generation?: CurveGenerationMetadata
  confirmedAt: number
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
 * Indicates whether the system-led premise came from a completed model pass
 * or from the legacy deterministic fallback retained for persisted sessions.
 * A fallback is editable and is never presented as a user-confirmed fact.
 */
export type StoryConflictCoreSystemDraftOrigin = 'model' | 'deterministic-fallback'

/**
 * The system's clearly labelled, editable premise for a sparse idea. It is
 * created automatically when the first layer lacks enough user facts, or on
 * an explicit user request for another system-led set.
 */
export interface StoryConflictCoreSystemDraft {
  goal: string
  stake: string
  constraint: string
  origin?: StoryConflictCoreSystemDraftOrigin
  fallbackReason?: string
  /**
   * Three mutually exclusive branch premises. Optional for persisted sessions
   * created before branch planning was introduced.
   */
  directions?: StoryConflictCoreSystemDraftDirection[]
  /** The one branch carried forward after the user makes a selection. */
  activeDirection?: StoryConflictCoreSystemDraftDirection
}

/**
 * The first-layer choice. It names the common goal, the single obstacle, and
 * the thing the protagonist cannot keep while continuing.
 */
export interface StoryConflictCore {
  id: string
  title: string
  variationAxis: StoryVariationAxis
  preservedGoal: string
  obstacle: string
  tradeoff: string
  /** Retained for persisted sessions created before the three-field picker. */
  storyHook?: string
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

/** Persisted progress for one curve version. */
export interface StoryPathSnapshot {
  seed: StorySeed
  predicament?: StoryPredicament
  approach?: StoryPredicamentApproach
  headTail?: StoryHeadTailOption
  state?: StoryNarrativeState
  history: StoryTurnHistoryItem[]
  currentTurn?: StoryTurn
  pendingActionProposal?: StoryActionProposal
  generatedStory?: GeneratedStory
}

export interface StoryCurveVersion {
  id: string
  label: string
  curve: ProvisionalCurve
  confirmedCurve?: ConfirmedCurve
  path?: StoryPathSnapshot
  createdAt: number
  updatedAt: number
}

export type StoryResumeStage = 'creative-brief' | 'provisional-curve' | 'story-spine' | 'complete'

/** A browser-safe projection of a persisted co-creation session. */
export interface StorySessionSnapshot extends StorySessionVersion {
  idea: string
  seed: StorySeed
  brief: CreativeBrief
  curve?: ProvisionalCurve
  confirmedCurve?: ConfirmedCurve
  curveVersions: StoryCurveVersion[]
  activeCurveVersionId?: string
  predicament?: StoryPredicament
  approach?: StoryPredicamentApproach
  headTail?: StoryHeadTailOption
  history: StoryTurnHistoryItem[]
  currentTurn?: StoryTurn
  /** A custom role-action proposal awaiting the author's confirmation. */
  pendingActionProposal?: StoryActionProposal
  /** Batch curve regeneration waiting for item-by-item author decisions. */
  pendingCurveRegeneration?: StoryCurveRegenerationPreview
  generatedStory?: GeneratedStory
  resumeStage: StoryResumeStage
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

export interface StoryCoCreationStartRequest {
  idea: string
  brief: CreativeBrief
  /** Stable identity for one browser submission; retries replay this operation. */
  operationId?: string
  /** Present only when the author deliberately creates another curve version. */
  storyId?: string
  revision?: number
  versionMode?: 'replace-draft' | 'new-version'
}

export interface StoryCurveBeatUpdateRequest extends StorySessionVersion {
  curveId: string
  beatId: string
  detail: string
  /** Optional client identity for retrying one save without a second mutation. */
  operationId?: string
}

export type StoryAuthorClarificationAction =
  | 'create'
  | 'save-answer'
  | 'declare-unknown'
  | 'keep-unknown'
  | 'request-independent-proposal'
  | 'abandon-dependent-proposal'
  | 'confirm-answer'

export interface StoryAuthorClarificationRequest extends StorySessionVersion {
  curveId: string
  versionMode?: 'new-version'
  clarificationId?: string
  action: StoryAuthorClarificationAction
  targetBeatId?: string
  prompt?: string
  causalGap?: string
  answerText?: string
}

export interface StoryCurveBeatRegenerationRequest extends StorySessionVersion {
  curveId: string
  beatId: string
  feedback?: string
  /** Explicitly request a replacement for a proposal already rejected. */
  replaceRejected?: boolean
}

export interface StoryCurveBeatRejectRequest extends StorySessionVersion {
  curveId: string
  beatId: string
  reason?: string
}

export interface StoryCurveDependenciesRegenerationRequest extends StorySessionVersion {
  curveId: string
  feedback?: string
}

export type StoryCurveRegenerationDecision = 'accept' | 'reject'

export interface StoryCurveRegenerationPreviewItem {
  id: string
  beatId: string
  title: string
  kind: CurveBeatKind
  oldDetail: string
  newDetail: string
  newSourceFactIds: string[]
  newCausalAnchor?: string
}

export interface StoryCurveRegenerationPreview {
  id: string
  curveId: string
  items: StoryCurveRegenerationPreviewItem[]
  generation?: CurveGenerationMetadata
  createdAt: number
}

export interface StoryCurveRegenerationResolutionRequest extends StorySessionVersion {
  curveId: string
  previewId: string
  decisions: Record<string, StoryCurveRegenerationDecision>
}

export interface StorySourceFactDispositionRequest extends StorySessionVersion {
  curveId: string
  factId: string
  disposition: 'parked' | 'integrated'
}

export interface StoryCurveConfirmRequest extends StorySessionVersion {
  curveId: string
}

export interface StoryCurveStartSpineRequest extends StorySessionVersion {
  curveId: string
}

export interface StoryCurveVersionSelectionRequest extends StorySessionVersion {
  versionId: string
}

/** A deliberate author-level revision requested after a curve was confirmed. */
export interface StoryAuthorInstructionRequest extends StorySessionVersion {
  targetBeatId: string
  text: string
}

export interface StoryActionProposalRequest extends StorySessionVersion {
  turnId: string
  action: string
}

export interface StoryActionProposalConfirmRequest extends StorySessionVersion {
  proposalId: string
  mode: Extract<StoryTurnMode, 'continue' | 'conclude'>
}

export interface StoryActionProposal {
  id: string
  turnId: string
  action: string
  grounding: string
  preconditions: string[]
  immediateConsequence: string
  laterEffect: string
  option: StoryTurnOption
  createdAt: number
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

export interface StoryCoCreationResponse extends StorySessionVersion {
  seed: StorySeed
  brief: CreativeBrief
  curve: ProvisionalCurve
  curveVersions?: StoryCurveVersion[]
  activeCurveVersionId?: string
}

export interface StoryCurveMutationResponse extends StorySessionVersion {
  curve: ProvisionalCurve
  affectedBeatIds: string[]
  pendingCurveRegeneration?: StoryCurveRegenerationPreview
  curveVersions?: StoryCurveVersion[]
  activeCurveVersionId?: string
}

export interface StoryCurveRegenerationResolutionResponse extends StoryCurveMutationResponse {}

export interface StoryCurveConfirmationResponse extends StorySessionVersion {
  curve: ProvisionalCurve
  confirmedCurve: ConfirmedCurve
  curveVersions?: StoryCurveVersion[]
  activeCurveVersionId?: string
}

export interface StoryActionProposalResponse extends StorySessionVersion {
  proposal: StoryActionProposal
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

/** The first turn created from a confirmed curve, with its materialized path foundation. */
export interface StoryCurveSpineResponse extends StoryTurnResponse {
  seed: StorySeed
  predicament: StoryPredicament
  approach: StoryPredicamentApproach
  headTail: StoryHeadTailOption
}

export interface StoryGenerationResponse extends StorySessionVersion {
  story: GeneratedStory
}

export interface ApiErrorResponse {
  error: {
    code: string
    message: string
    /** Safe model failure metadata; never contains prompts or raw response text. */
    diagnostic?: StoryModelFailureDiagnostic
    conflictCoreContextPrefill?: StoryConflictCoreContextPrefill
    systemDraftPrefill?: StoryConflictCoreSystemDraft
  }
}

export interface StoryModelResponseSummary {
  kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'undefined'
  topLevelKeys?: string[]
  fieldShapes?: Record<string, string>
  model?: string
  finishReason?: string
  usageKeys?: string[]
  choicesCount?: number
  firstChoiceKeys?: string[]
  contentType?: string
  contentLength?: number
  errorKeys?: string[]
}

export interface StoryModelFailureDiagnostic {
  stage: string
  attempt?: number
  maxAttempts?: number
  httpStatus?: number
  responseFormat?: boolean
  reason?: string
  response?: StoryModelResponseSummary
}

export interface HealthResponse {
  ok: true
  model: string
  configured: boolean
}
