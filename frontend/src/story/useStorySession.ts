import { createStorySessionActions, type StorySessionActions } from './storySessionActions'
import { useStorySessionState } from './useStorySessionState'
import { useStoryStageRequest } from './useStoryStageRequest'
import type {
  GeneratedStory,
  GenerationStatus,
  StoryHeadTailOption,
  StoryPlan,
  StoryConflictCore,
  StoryConflictCores,
  StoryConflictCoreContext,
  StoryConflictCoreContextPrefill,
  StoryConflictCoreSystemDraft,
  StoryPredicament,
  StoryPredicamentApproach,
  StorySeed,
  StoryTurn,
  StoryTurnHistoryItem,
  StoryTurnOption,
  StoryView,
} from './types'

export interface StorySession extends StorySessionActions {
  view: StoryView
  idea: string
  trimmedIdea: string
  seed: StorySeed | undefined
  conflictCores: StoryConflictCores | []
  conflictCoreContext: StoryConflictCoreContext
  conflictCoreFeedback: string
  selectedConflictCore: StoryConflictCore | undefined
  selectedConflictCoreId: string | undefined
  predicament: StoryPredicament | undefined
  selectedApproach: StoryPredicamentApproach | undefined
  selectedApproachId: string | undefined
  headTailOptions: StoryHeadTailOption[]
  selectedHeadTail: StoryHeadTailOption | undefined
  selectedHeadTailId: string | undefined
  committedHeadTailId: string | undefined
  turnHistory: StoryTurnHistoryItem[]
  currentTurn: StoryTurn | undefined
  selectedTurnOption: StoryTurnOption | undefined
  selectedTurnOptionId: string | undefined
  storyPlan: StoryPlan | undefined
  stageStatus: GenerationStatus
  stageError: string | undefined
  stageErrorCode: string | undefined
  stageErrorContextPrefill: StoryConflictCoreContextPrefill | undefined
  stageErrorSystemDraftPrefill: StoryConflictCoreSystemDraft | undefined
  generatedStory: GeneratedStory | undefined
}

export function useStorySession(): StorySession {
  const state = useStorySessionState()
  const stage = useStoryStageRequest()
  const actions = createStorySessionActions(state, stage)

  return {
    view: state.view,
    idea: state.idea,
    trimmedIdea: state.trimmedIdea,
    seed: state.seed,
    conflictCores: state.conflictCores,
    conflictCoreContext: state.conflictCoreContext,
    conflictCoreFeedback: state.conflictCoreFeedback,
    selectedConflictCore: state.selectedConflictCore,
    selectedConflictCoreId: state.selectedConflictCoreId,
    predicament: state.predicament,
    selectedApproach: state.selectedApproach,
    selectedApproachId: state.selectedApproachId,
    headTailOptions: state.headTailOptions,
    selectedHeadTail: state.selectedHeadTail,
    selectedHeadTailId: state.selectedHeadTailId,
    committedHeadTailId: state.committedHeadTailId,
    turnHistory: state.turnHistory,
    currentTurn: state.currentTurn,
    selectedTurnOption: state.selectedTurnOption,
    selectedTurnOptionId: state.selectedTurnOptionId,
    storyPlan: state.storyPlan,
    stageStatus: stage.stageStatus,
    stageError: stage.stageError,
    stageErrorCode: stage.stageErrorCode,
    stageErrorContextPrefill: stage.stageErrorContextPrefill,
    stageErrorSystemDraftPrefill: stage.stageErrorSystemDraftPrefill,
    generatedStory: state.generatedStory,
    ...actions,
  }
}
