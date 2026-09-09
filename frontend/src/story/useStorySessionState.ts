import { useMemo, useState } from 'react'
import type {
  GeneratedStory,
  StoryHeadTailOption,
  StoryPlan,
  StoryPredicament,
  StoryPredicaments,
  StorySeed,
  StorySessionVersion,
  StoryTurn,
  StoryTurnHistoryItem,
  StoryTurnMode,
  StoryTurnOption,
  StoryView,
} from './types'

export type StoryPlanResetPoint = 'predicament' | 'head-tail'

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
  predicamentOptions: StoryPredicaments | []
  setPredicamentOptions: (options: StoryPredicaments | []) => void
  predicamentFeedback: string
  setPredicamentFeedback: (feedback: string) => void
  selectedPredicamentId: string | undefined
  setSelectedPredicamentId: (id: string | undefined) => void
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
  selectedPredicament: StoryPredicament | undefined
  selectedHeadTail: StoryHeadTailOption | undefined
  selectedTurnOption: StoryTurnOption | undefined
  storyPlan: StoryPlan | undefined
  resetPlanAfter: (resetPoint: StoryPlanResetPoint) => void
  resetStoryFoundation: () => void
  applySessionVersion: (result: StorySessionVersion) => void
}

export function useStorySessionState(): StorySessionState {
  const [view, setView] = useState<StoryView>('opening')
  const [idea, setIdea] = useState('')
  const [seed, setSeed] = useState<StorySeed>()
  const [predicamentOptions, setPredicamentOptions] = useState<StoryPredicaments | []>([])
  const [predicamentFeedback, setPredicamentFeedback] = useState('')
  const [selectedPredicamentId, setSelectedPredicamentId] = useState<string>()
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
  const selectedPredicament = useMemo(
    () => predicamentOptions.find((predicament) => predicament.id === selectedPredicamentId),
    [predicamentOptions, selectedPredicamentId],
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
    () => getCompletedStoryPlan(seed, selectedPredicament, selectedHeadTail, turnHistory, currentTurn),
    [currentTurn, seed, selectedHeadTail, selectedPredicament, turnHistory],
  )

  const resetStorySpine = () => {
    setCommittedHeadTailId(undefined)
    setTurnHistory([])
    setCurrentTurn(undefined)
    setSelectedTurnOptionId(undefined)
    setPendingTurnRequest(undefined)
    setGeneratedStory(undefined)
  }

  const resetPlanAfter = (resetPoint: StoryPlanResetPoint) => {
    if (resetPoint === 'predicament') {
      setHeadTailOptions([])
      setSelectedHeadTailId(undefined)
    }

    resetStorySpine()
  }

  const resetStoryFoundation = () => {
    setStoryId(undefined)
    setRevision(0)
    setSeed(undefined)
    setPredicamentOptions([])
    setPredicamentFeedback('')
    setSelectedPredicamentId(undefined)
    resetPlanAfter('predicament')
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
    predicamentOptions,
    setPredicamentOptions,
    predicamentFeedback,
    setPredicamentFeedback,
    selectedPredicamentId,
    setSelectedPredicamentId,
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
    selectedPredicament,
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
  headTail: StoryHeadTailOption | undefined,
  turnHistory: StoryTurnHistoryItem[],
  currentTurn: StoryTurn | undefined,
): StoryPlan | undefined {
  if (!seed || !predicament || !headTail || !turnHistory.length || !currentTurn?.isConclusion) {
    return undefined
  }

  return { seed, predicament, headTail, turnHistory, conclusion: currentTurn }
}
