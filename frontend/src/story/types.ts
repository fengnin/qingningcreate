export type {
  GeneratedStory,
  ReviewTone,
  StoryBeat,
  StoryAction,
  StoryConflict,
  StoryExpansionScope,
  StoryFact,
  StoryFactChange,
  StoryGoalState,
  StoryHeadTailOption,
  StoryHeadTailOptions,
  StoryNode,
  StoryPlan,
  StoryPredicament,
  StoryPredicaments,
  StoryReviewItem,
  StorySeed,
  StorySessionVersion,
  StoryTransition,
  StoryTurn,
  StoryTurnHistoryItem,
  StoryTurnMode,
  StoryTurnOption,
} from '../../../shared/story-contract.js'

export type StoryView =
  | 'opening'
  | 'direction-picker'
  | 'head-tail'
  | 'story-spine'
  | 'complete'

export type StoryStep = 1 | 2 | 3 | 4 | 5
export type GenerationStatus = 'idle' | 'loading' | 'error'
