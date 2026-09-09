import { createStorySessionActions, type StorySessionActions } from './storySessionActions'
import { useStorySessionState } from './useStorySessionState'
import { useStoryStageRequest } from './useStoryStageRequest'
import type {
  GeneratedStory,
  GenerationStatus,
  StoryHeadTailOption,
  StoryPlan,
  StoryPredicament,
  StoryPredicaments,
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
  predicamentOptions: StoryPredicaments | []
  predicamentFeedback: string
  selectedPredicament: StoryPredicament | undefined
  selectedPredicamentId: string | undefined
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
    predicamentOptions: state.predicamentOptions,
    predicamentFeedback: state.predicamentFeedback,
    selectedPredicament: state.selectedPredicament,
    selectedPredicamentId: state.selectedPredicamentId,
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
    generatedStory: state.generatedStory,
    ...actions,
  }
}
