import { useMemo, useRef, useState } from 'react'
import type {
  GeneratedStory,
  StoryHeadTailOption,
  StoryPlan,
  StoryConflictCore,
  StoryConflictCores,
  StoryConflictCoreContext,
  ConfirmedCurve,
  CreativeBrief,
  ProvisionalCurve,
  StoryPredicament,
  StoryPredicamentApproach,
  StorySeed,
  StorySessionVersion,
  StoryCurveVersion,
  StoryCurveRegenerationPreview,
  StoryActionProposal,
  StorySessionSnapshot,
  StoryTurn,
  StoryTurnHistoryItem,
  StoryWritingDraft,
  StoryTurnMode,
  StoryTurnOption,
  StoryView,
} from './types'

export type StoryPlanResetPoint = 'conflict-core' | 'predicament' | 'head-tail'

export interface PendingTurnRequest {
  mode: StoryTurnMode
  headTailId?: string
  turnId?: string
  optionId?: string
}
export interface PendingActionConfirmation {
  proposalId: string
  mode: 'continue' | 'conclude'
  authorConfirmation?: { actionText: string; resultText: string }
}

export interface StorySessionState {
  directionBuildProgress: number
  setDirectionBuildProgress: (completedNodes: number) => void
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
  creativeBrief: CreativeBrief
  setCreativeBrief: (brief: CreativeBrief) => void
  provisionalCurve: ProvisionalCurve | undefined
  setProvisionalCurve: (curve: ProvisionalCurve | undefined) => void
  confirmedCurve: ConfirmedCurve | undefined
  setConfirmedCurve: (curve: ConfirmedCurve | undefined) => void
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
  writingDraft: StoryWritingDraft | undefined
  setWritingDraft: (draft: StoryWritingDraft | undefined) => void
  storyId: string | undefined
  revision: number
  getRevision: () => number
  trimmedIdea: string
  selectedHeadTail: StoryHeadTailOption | undefined
  selectedTurnOption: StoryTurnOption | undefined
  storyPlan: StoryPlan | undefined
  resetPlanAfter: (resetPoint: StoryPlanResetPoint) => void
  resetStoryFoundation: () => void
  applySessionVersion: (result: StorySessionVersion) => void
  curveVersions: StoryCurveVersion[]
  setCurveVersions: (versions: StoryCurveVersion[]) => void
  activeCurveVersionId: string | undefined
  setActiveCurveVersionId: (versionId: string | undefined) => void
  pendingActionProposal: StoryActionProposal | undefined
  pendingActionConfirmation: PendingActionConfirmation | undefined
  setPendingActionConfirmation: (confirmation: PendingActionConfirmation | undefined) => void
  setPendingActionProposal: (proposal: StoryActionProposal | undefined) => void
  pendingCurveRegeneration: StoryCurveRegenerationPreview | undefined
  setPendingCurveRegeneration: (preview: StoryCurveRegenerationPreview | undefined) => void
  applySessionSnapshot: (snapshot: StorySessionSnapshot) => void
}

const activeStoryStorageKey = 'story-lens.active-story-id'

export function clearLegacyStoryPersistence(): void {
  try {
    window.localStorage.removeItem(activeStoryStorageKey)
  } catch {
    // Storage may be unavailable in embedded/private contexts.
  }
  try {
    const url = new URL(window.location.href)
    if (url.searchParams.has('story')) {
      url.searchParams.delete('story')
      window.history.replaceState({}, '', url)
    }
  } catch {
    // Clear the URL independently even when local storage is unavailable.
  }
}

export function useStorySessionState(): StorySessionState {
  const [directionBuildProgress, setDirectionBuildProgress] = useState(0)
  const [view, setView] = useState<StoryView>('opening')
  const [idea, setIdea] = useState('')
  const [seed, setSeed] = useState<StorySeed>()
  const [conflictCores, setConflictCores] = useState<StoryConflictCores | []>([])
  const [conflictCoreContext, setConflictCoreContext] = useState<StoryConflictCoreContext>({})
  const [creativeBrief, setCreativeBrief] = useState<CreativeBrief>(createEmptyCreativeBrief)
  const [provisionalCurve, setProvisionalCurve] = useState<ProvisionalCurve>()
  const [confirmedCurve, setConfirmedCurve] = useState<ConfirmedCurve>()
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
  const [writingDraft, setWritingDraft] = useState<StoryWritingDraft>()
  const [storyId, setStoryId] = useState<string>()
  const [revision, setRevision] = useState(0)
  const revisionRef = useRef(0)
  const updateRevision = (nextRevision: number) => {
    revisionRef.current = nextRevision
    setRevision(nextRevision)
  }
  const [curveVersions, setCurveVersions] = useState<StoryCurveVersion[]>([])
  const [activeCurveVersionId, setActiveCurveVersionId] = useState<string>()
  const [pendingActionProposal, setPendingActionProposal] = useState<StoryActionProposal>()
  const [pendingActionConfirmation, setPendingActionConfirmation] = useState<PendingActionConfirmation>()
  const [pendingCurveRegeneration, setPendingCurveRegeneration] = useState<StoryCurveRegenerationPreview>()

  const trimmedIdea = idea.trim()

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
    setPendingActionConfirmation(undefined)
    setCommittedHeadTailId(undefined)
    setTurnHistory([])
    setCurrentTurn(undefined)
    setSelectedTurnOptionId(undefined)
    setPendingTurnRequest(undefined)
    setGeneratedStory(undefined)
    setWritingDraft(undefined)
    setPendingCurveRegeneration(undefined)
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

  const clearCoCreation = () => {
    setCreativeBrief(createEmptyCreativeBrief())
    setProvisionalCurve(undefined)
    setConfirmedCurve(undefined)
    setPendingCurveRegeneration(undefined)
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
    setDirectionBuildProgress(0)
    clearLegacyStoryPersistence()
    setStoryId(undefined)
    updateRevision(0)
    setSeed(undefined)
    setConflictCoreContext({})
    setCurveVersions([])
    setActiveCurveVersionId(undefined)
    setPendingActionProposal(undefined)
    clearCoCreation()
    clearConflictCoreSelection()
    resetPlanAfter('conflict-core')
  }

  const applySessionVersion = (result: StorySessionVersion) => {
    setStoryId(result.storyId)
    updateRevision(result.revision)
  }

  const applySessionSnapshot = (snapshot: StorySessionSnapshot) => {
    setPendingActionConfirmation(undefined)
    setStoryId(snapshot.storyId)
    updateRevision(snapshot.revision)
    setIdea(snapshot.idea)
    setSeed(snapshot.seed)
    setCreativeBrief(snapshot.brief)
    setProvisionalCurve(snapshot.curve)
    setConfirmedCurve(snapshot.confirmedCurve)
    setCurveVersions(snapshot.curveVersions)
    setActiveCurveVersionId(snapshot.activeCurveVersionId)
    setPredicament(snapshot.predicament)
    setSelectedApproachId(snapshot.approach?.id)
    setHeadTailOptions(snapshot.headTail ? [snapshot.headTail] : [])
    setSelectedHeadTailId(snapshot.headTail?.id)
    setCommittedHeadTailId(snapshot.headTail?.id)
    setTurnHistory(snapshot.history)
    setCurrentTurn(snapshot.currentTurn)
    setPendingActionProposal(snapshot.pendingActionProposal)
    setPendingCurveRegeneration(snapshot.pendingCurveRegeneration)
    setGeneratedStory(snapshot.generatedStory)
    setWritingDraft(snapshot.writingDraft)
    setSelectedTurnOptionId(undefined)
    setPendingTurnRequest(undefined)
    setView(snapshot.resumeStage)
  }

  return {
    directionBuildProgress,
    setDirectionBuildProgress,
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
    creativeBrief,
    setCreativeBrief,
    provisionalCurve,
    setProvisionalCurve,
    confirmedCurve,
    setConfirmedCurve,
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
    writingDraft,
    setWritingDraft,
    storyId,
    revision,
    getRevision: () => revisionRef.current,
    trimmedIdea,
    selectedHeadTail,
    selectedTurnOption,
    storyPlan,
    resetPlanAfter,
    resetStoryFoundation,
    applySessionVersion,
    curveVersions,
    setCurveVersions,
    activeCurveVersionId,
    setActiveCurveVersionId,
    pendingActionProposal,
    pendingActionConfirmation,
    setPendingActionConfirmation,
    setPendingActionProposal,
    pendingCurveRegeneration,
    setPendingCurveRegeneration,
    applySessionSnapshot,
  }
}

function createEmptyCreativeBrief(): CreativeBrief {
  return {
    tones: [],
    dramaticForces: [],
    allowSystemNamedCharacters: false,
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
