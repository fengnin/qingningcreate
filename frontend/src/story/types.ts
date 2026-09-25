export type {
  GeneratedStory,
  ReviewTone,
  StoryBeat,
  StoryAction,
  StoryConflict,
  StoryConflictCore,
  StoryConflictCores,
  StoryConflictCoreContext,
  StoryConflictCoreContextPrefill,
  StoryConflictCoreSystemDraft,
  StoryExpansionScope,
  StoryFact,
  StoryFactChange,
  StoryGoalState,
  StoryHeadTailOption,
  StoryHeadTailOptions,
  StoryHeadTailRefinement,
  StoryHeadTailRefinementFocus,
  StoryNode,
  StoryPlan,
  StoryPredicament,
  StoryPredicamentApproach,
  StoryPredicamentResponse,
  StoryPredicamentSessionRequest,
  StoryPredicamentRefinement,
  StoryPredicamentRefinementFocus,
  StoryReviewItem,
  StorySeed,
  StorySessionVersion,
  StoryTransition,
  StoryTurn,
  StoryTurnHistoryItem,
  StoryTurnMode,
  StoryTurnOption,
  StoryTurnOptionRefinement,
  StoryTurnOptionRefinementFocus,
  StoryTurnOptionRefinementRequest,
  StoryTurnResponse,
  StoryVariationAxis,
} from '../../../shared/story-contract.js'

export type StoryView =
  | 'opening'
  | 'conflict-core-picker'
  | 'predicament'
  | 'head-tail'
  | 'story-spine'
  | 'complete'

export type StoryStep = 1 | 2 | 3 | 4 | 5 | 6
export type GenerationStatus = 'idle' | 'loading' | 'error'
