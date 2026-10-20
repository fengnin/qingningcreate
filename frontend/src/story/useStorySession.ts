import { useEffect, useRef } from 'react'
import { createStorySessionActions, type StorySessionActions } from './storySessionActions'
import { persistStoryId, useStorySessionState } from './useStorySessionState'
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
  ConfirmedCurve,
  CreativeBrief,
  ProvisionalCurve,
  StoryPredicament,
  StoryPredicamentApproach,
  StorySeed,
  StoryTurn,
  StoryTurnHistoryItem,
  StoryTurnOption,
  StoryView,
  StoryCurveRegenerationPreview,
  StoryWritingDraft,
} from './types'

export interface StorySession extends StorySessionActions {
  view: StoryView
  idea: string
  trimmedIdea: string
  seed: StorySeed | undefined
  conflictCores: StoryConflictCores | []
  conflictCoreContext: StoryConflictCoreContext
  creativeBrief: CreativeBrief
  provisionalCurve: ProvisionalCurve | undefined
  confirmedCurve: ConfirmedCurve | undefined
  hasVisitedStoryWriting: boolean
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
  writingDraft: StoryWritingDraft | undefined
  storyId: string | undefined
  revision: number
  curveVersions: import('./types').StoryCurveVersion[]
  activeCurveVersionId: string | undefined
  pendingActionProposal: import('./types').StoryActionProposal | undefined
  pendingCurveRegeneration: StoryCurveRegenerationPreview | undefined
  restoreAttempted: boolean
  restoreLoading: boolean
  restoreError: string | undefined
  retryRestoreSession: () => Promise<void>
}

export function useStorySession(): StorySession {
  const state = useStorySessionState()
  const stage = useStoryStageRequest()
  const actions = createStorySessionActions(state, stage)
  const restoreStarted = useRef(false)
  const writingVisits = useRef(new Set<string>())
  const curveId = state.provisionalCurve?.id
  if (curveId && state.view === 'story-spine') writingVisits.current.add(curveId)

  useEffect(() => {
    if (restoreStarted.current) return
    restoreStarted.current = true
    // Each page load starts a new creation. Keep navigation within this page
    // in React state, but discard handles saved by earlier app versions.
    persistStoryId(undefined)
    state.markRestoreAttempted()
  }, [])

  return {
    view: state.view,
    idea: state.idea,
    trimmedIdea: state.trimmedIdea,
    seed: state.seed,
    conflictCores: state.conflictCores,
    conflictCoreContext: state.conflictCoreContext,
    creativeBrief: state.creativeBrief,
    provisionalCurve: state.provisionalCurve,
    confirmedCurve: state.confirmedCurve,
    hasVisitedStoryWriting: Boolean(state.confirmedCurve && (curveId && writingVisits.current.has(curveId) || state.writingDraft || state.currentTurn || state.generatedStory)),
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
    writingDraft: state.writingDraft,
    storyId: state.storyId,
    revision: state.revision,
    curveVersions: state.curveVersions,
    activeCurveVersionId: state.activeCurveVersionId,
    pendingActionProposal: state.pendingActionProposal,
    pendingCurveRegeneration: state.pendingCurveRegeneration,
    restoreAttempted: state.restoreAttempted,
    restoreLoading: state.restoreLoading,
    restoreError: state.restoreError,
    ...actions,
  }
}
