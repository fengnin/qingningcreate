import { useEffect, useMemo, useState } from 'react'
import type {
  GeneratedStory,
  StoryHeadTailOption,
  StoryPlan,
  StoryConflictCore,
  StoryConflictCores,
  StoryConflictCoreContext,
  StoryPredicament,
  StoryPredicamentApproach,
  StorySeed,
  StorySessionVersion,
  StoryTurn,
  StoryTurnHistoryItem,
  StoryTurnMode,
  StoryTurnOption,
  StoryView,
} from './types'
import { getInitialStoryIdeaExample, rememberStoryIdeaExample } from './storyIdeaExamples'

export type StoryPlanResetPoint = 'conflict-core' | 'predicament' | 'head-tail'

export interface PendingTurnRequest {
  mode: StoryTurnMode
  headTailId?: string
  turnId?: string
  optionId?: string
}

export interface StorySessionState {
  view: StoryView
  setView: (view: StoryView) => void
  idea: string
  setIdea: (idea: string) => void
  seed: StorySeed | undefined
  setSeed: (seed: StorySeed | undefined) => void
  conflictCores: StoryConflictCores | []
  setConflictCores: (options: StoryConflictCores | []) => void
  conflictCoreContext: StoryConflictCoreContext
  setConflictCoreContext: (context: StoryConflictCoreContext) => void
  conflictCoreFeedback: string
  setConflictCoreFeedback: (feedback: string) => void
  selectedConflictCoreId: string | undefined
  setSelectedConflictCoreId: (id: string | undefined) => void
  selectedConflictCore: StoryConflictCore | undefined
  predicament: StoryPredicament | undefined
  setPredicament: (predicament: StoryPredicament | undefined) => void
  selectedApproachId: string | undefined
  setSelectedApproachId: (id: string | undefined) => void
  selectedApproach: StoryPredicamentApproach | undefined
  headTailOptions: StoryHeadTailOption[]
  setHeadTailOptions: (options: StoryHeadTailOption[]) => void
  selectedHeadTailId: string | undefined
  setSelectedHeadTailId: (id: string | undefined) => void
  committedHeadTailId: string | undefined
  setCommittedHeadTailId: (id: string | undefined) => void
  turnHistory: StoryTurnHistoryItem[]
  setTurnHistory: (history: StoryTurnHistoryItem[]) => void
  currentTurn: StoryTurn | undefined
  setCurrentTurn: (turn: StoryTurn | undefined) => void
  selectedTurnOptionId: string | undefined
  setSelectedTurnOptionId: (id: string | undefined) => void
  pendingTurnRequest: PendingTurnRequest | undefined
  setPendingTurnRequest: (request: PendingTurnRequest | undefined) => void
  generatedStory: GeneratedStory | undefined
  setGeneratedStory: (story: GeneratedStory | undefined) => void
  storyId: string | undefined
  revision: number
  trimmedIdea: string
  selectedHeadTail: StoryHeadTailOption | undefined
  selectedTurnOption: StoryTurnOption | undefined
  storyPlan: StoryPlan | undefined
  resetPlanAfter: (resetPoint: StoryPlanResetPoint) => void
  resetStoryFoundation: () => void
  applySessionVersion: (result: StorySessionVersion) => void
}

export function useStorySessionState(): StorySessionState {
  const [view, setView] = useState<StoryView>('opening')
  const [idea, setIdea] = useState(getInitialStoryIdeaExample)
  const [seed, setSeed] = useState<StorySeed>()
  const [conflictCores, setConflictCores] = useState<StoryConflictCores | []>([])
  const [conflictCoreContext, setConflictCoreContext] = useState<StoryConflictCoreContext>({})
  const [conflictCoreFeedback, setConflictCoreFeedback] = useState('')
  const [selectedConflictCoreId, setSelectedConflictCoreId] = useState<string>()
  const [predicament, setPredicament] = useState<StoryPredicament>()
  const [selectedApproachId, setSelectedApproachId] = useState<string>()
  const [headTailOptions, setHeadTailOptions] = useState<StoryHeadTailOption[]>([])
  const [selectedHeadTailId, setSelectedHeadTailId] = useState<string>()
  const [committedHeadTailId, setCommittedHeadTailId] = useState<string>()
  const [turnHistory, setTurnHistory] = useState<StoryTurnHistoryItem[]>([])
  const [currentTurn, setCurrentTurn] = useState<StoryTurn>()
  const [selectedTurnOptionId, setSelectedTurnOptionId] = useState<string>()
  const [pendingTurnRequest, setPendingTurnRequest] = useState<PendingTurnRequest>()
  const [generatedStory, setGeneratedStory] = useState<GeneratedStory>()
  const [storyId, setStoryId] = useState<string>()
  const [revision, setRevision] = useState(0)

  const trimmedIdea = idea.trim()

  useEffect(() => {
    rememberStoryIdeaExample(idea)
  }, [])
  const selectedConflictCore = useMemo(
    () => conflictCores.find((core) => core.id === selectedConflictCoreId),
    [conflictCores, selectedConflictCoreId],
  )
  const selectedApproach = useMemo(
    () => predicament?.approaches.find((approach) => approach.id === selectedApproachId),
    [predicament, selectedApproachId],
  )
  const selectedHeadTail = useMemo(
    () => headTailOptions.find((option) => option.id === selectedHeadTailId),
    [headTailOptions, selectedHeadTailId],
  )
  const selectedTurnOption = useMemo(
    () => currentTurn?.options.find((option) => option.id === selectedTurnOptionId),
    [currentTurn, selectedTurnOptionId],
  )
  const storyPlan = useMemo(
    () => getCompletedStoryPlan(seed, predicament, selectedApproach, selectedHeadTail, turnHistory, currentTurn),
    [currentTurn, seed, selectedApproach, selectedHeadTail, predicament, turnHistory],
  )

  const resetStorySpine = () => {
    setCommittedHeadTailId(undefined)
    setTurnHistory([])
    setCurrentTurn(undefined)
    setSelectedTurnOptionId(undefined)
    setPendingTurnRequest(undefined)
    setGeneratedStory(undefined)
  }

  const clearPredicamentSelection = () => {
    setPredicament(undefined)
    setSelectedApproachId(undefined)
  }

  const clearHeadTailSelection = () => {
    setHeadTailOptions([])
    setSelectedHeadTailId(undefined)
  }

  const clearConflictCoreSelection = () => {
    setConflictCores([])
    setConflictCoreFeedback('')
    setSelectedConflictCoreId(undefined)
  }

  const resetPlanAfter = (resetPoint: StoryPlanResetPoint) => {
    if (resetPoint === 'conflict-core') {
      clearPredicamentSelection()
    }

    if (resetPoint === 'conflict-core' || resetPoint === 'predicament') {
      clearHeadTailSelection()
    }

    resetStorySpine()
  }

  const resetStoryFoundation = () => {
    setStoryId(undefined)
    setRevision(0)
    setSeed(undefined)
    setConflictCoreContext({})
    clearConflictCoreSelection()
    resetPlanAfter('conflict-core')
  }

  const applySessionVersion = (result: StorySessionVersion) => {
    setStoryId(result.storyId)
    setRevision(result.revision)
  }

  return {
    view,
    setView,
    idea,
    setIdea,
    seed,
    setSeed,
    conflictCores,
    setConflictCores,
    conflictCoreContext,
    setConflictCoreContext,
    conflictCoreFeedback,
    setConflictCoreFeedback,
    selectedConflictCoreId,
    setSelectedConflictCoreId,
    selectedConflictCore,
    predicament,
    setPredicament,
    selectedApproachId,
    setSelectedApproachId,
    selectedApproach,
    headTailOptions,
    setHeadTailOptions,
    selectedHeadTailId,
    setSelectedHeadTailId,
    committedHeadTailId,
    setCommittedHeadTailId,
    turnHistory,
    setTurnHistory,
    currentTurn,
    setCurrentTurn,
    selectedTurnOptionId,
    setSelectedTurnOptionId,
    pendingTurnRequest,
    setPendingTurnRequest,
    generatedStory,
    setGeneratedStory,
    storyId,
    revision,
    trimmedIdea,
    selectedHeadTail,
    selectedTurnOption,
    storyPlan,
    resetPlanAfter,
    resetStoryFoundation,
    applySessionVersion,
  }
}

function getCompletedStoryPlan(
  seed: StorySeed | undefined,
  predicament: StoryPredicament | undefined,
  approach: StoryPredicamentApproach | undefined,
  headTail: StoryHeadTailOption | undefined,
  turnHistory: StoryTurnHistoryItem[],
  currentTurn: StoryTurn | undefined,
): StoryPlan | undefined {
  if (!seed || !predicament || !approach || !headTail || !turnHistory.length || !currentTurn?.isConclusion) {
    return undefined
  }

  return { seed, predicament, approach, headTail, turnHistory, conclusion: currentTurn }
}
