import {
  requestFullStory,
  requestHeadTailOptions,
  requestConflictCores,
  requestStoryPredicament,
  requestStoryTurn,
  requestStoryTurnOptionRefinement,
} from './storyApi'
import {
  type PendingTurnRequest,
  type StorySessionState,
} from './useStorySessionState'
import { normalizeConflictCoreContext } from './conflictCoreContext'
import { getNextStoryIdeaExample } from './storyIdeaExamples'
import type {
  StoryConflictCoreContext,
  StorySessionVersion,
  StoryTurnMode,
  StoryTurnOptionRefinement,
  StoryTurnResponse,
  StoryView,
} from './types'
import type { StoryStageRequest } from './useStoryStageRequest'

const defaultStoryExpansionScope = 'keep-scale' as const

interface ConflictCoreGenerationOptions {
  context?: StoryConflictCoreContext
  generateSystemDraft?: boolean
  preference?: string
  excludedTitles?: string[]
  fresh?: boolean
}

export interface StorySessionActions {
  updateIdea: (idea: string) => void
  useExample: () => void
  openConflictCorePicker: () => Promise<void>
  showDifferentConflictCores: () => Promise<void>
  applyConflictCoreFeedback: (feedback: string) => Promise<void>
  applyConflictCoreContext: (context: StoryConflictCoreContext) => Promise<void>
  generateSystemDraft: () => Promise<void>
  selectConflictCore: (id: string) => void
  continueToPredicament: () => Promise<void>
  regeneratePredicament: () => Promise<void>
  selectPredicamentApproach: (id: string) => void
  continueToHeadTail: () => void
  regenerateHeadTail: () => Promise<void>
  selectHeadTail: (id: string) => void
  continueToStorySpine: () => Promise<void>
  selectTurnOption: (optionId: string) => void
  refineTurnOption: (refinement: StoryTurnOptionRefinement) => Promise<void>
  continueStory: () => Promise<void>
  concludeStory: () => Promise<void>
  generateFullStory: () => Promise<void>
  viewGeneratedStory: () => void
  retryCurrentStage: () => Promise<void>
  goBack: () => void
  goBackToOpening: () => void
  restartStory: () => void
}

const previousViewByView: Partial<Record<StoryView, StoryView>> = {
  'conflict-core-picker': 'opening',
  predicament: 'conflict-core-picker',
  'head-tail': 'predicament',
  'story-spine': 'head-tail',
  complete: 'story-spine',
}

export function createStorySessionActions(
  state: StorySessionState,
  stage: StoryStageRequest,
): StorySessionActions {
  const loaders = createStorySessionLoaders(state, stage)
  const context = { state, stage, loaders }
  const storyProgressActions = createStoryProgressActions(context)

  return {
    ...createStoryFoundationActions(context),
    ...createStoryPlanningActions(context),
    ...storyProgressActions,
    ...createNavigationActions(context, storyProgressActions.generateFullStory),
  }
}

interface StorySessionActionContext {
  state: StorySessionState
  stage: StoryStageRequest
  loaders: StorySessionLoaders
}

function createStoryFoundationActions(
  { state, stage, loaders }: StorySessionActionContext,
): Pick<
  StorySessionActions,
  | 'updateIdea'
  | 'useExample'
  | 'openConflictCorePicker'
  | 'showDifferentConflictCores'
  | 'applyConflictCoreFeedback'
  | 'applyConflictCoreContext'
  | 'generateSystemDraft'
  | 'selectConflictCore'
  | 'continueToPredicament'
  | 'regeneratePredicament'
  | 'selectPredicamentApproach'
> {
  const updateIdea = (idea: string) => {
    if (idea.trim() !== state.trimmedIdea && state.conflictCores.length) {
      state.resetStoryFoundation()
    }
    state.setIdea(idea)
  }

  const openConflictCorePicker = async () => {
    if (!state.trimmedIdea) return

    state.resetStoryFoundation()
    state.setView('conflict-core-picker')
    await loaders.loadConflictCores({ excludedTitles: [], fresh: true })
  }

  const applyConflictCoreFeedback = async (feedback: string) => {
    const preference = feedback.trim()
    if (preference) {
      await loaders.loadConflictCores({
        preference,
        generateSystemDraft: Boolean(state.seed?.systemDraft),
      })
    }
  }

  const applyConflictCoreContext = async (context: StoryConflictCoreContext) => {
    const confirmedContext = normalizeConflictCoreContext(context)
    if (!confirmedContext) return

    state.setConflictCoreContext(confirmedContext)
    await loaders.loadConflictCores({ context: confirmedContext, excludedTitles: [] })
  }

  const generateSystemDraft = async () => {
    await loaders.loadConflictCores({ generateSystemDraft: true })
  }

  const selectConflictCore = (id: string) => {
    if (id === state.selectedConflictCoreId) return
    state.setSelectedConflictCoreId(id)
    state.resetPlanAfter('conflict-core')
  }

  const loadSelectedConflictCorePredicament = async () => {
    if (!state.selectedConflictCore || !state.storyId) return
    await loaders.loadPredicament(state.selectedConflictCore)
  }

  const continueToPredicament = async () => {
    if (!state.selectedConflictCore || !state.storyId) return
    state.setView('predicament')
    if (!state.predicament) await loadSelectedConflictCorePredicament()
  }

  const regeneratePredicament = async () => {
    await loadSelectedConflictCorePredicament()
  }

  const selectPredicamentApproach = (id: string) => {
    if (stage.stageStatus === 'loading' || !state.predicament?.approaches.some((approach) => approach.id === id)) return
    if (id === state.selectedApproachId) return

    state.setSelectedApproachId(id)
    state.resetPlanAfter('predicament')
  }

  return {
    updateIdea,
    useExample: () => updateIdea(getNextStoryIdeaExample(state.idea)),
    openConflictCorePicker,
    showDifferentConflictCores: () => (
      state.seed?.systemDraft
        ? loaders.loadConflictCores({ generateSystemDraft: true })
        : loaders.loadConflictCores()
    ),
    applyConflictCoreFeedback,
    applyConflictCoreContext,
    generateSystemDraft,
    selectConflictCore,
    continueToPredicament,
    regeneratePredicament,
    selectPredicamentApproach,
  }
}

function createStoryPlanningActions(
  { state, loaders }: StorySessionActionContext,
): Pick<
  StorySessionActions,
  | 'continueToHeadTail'
  | 'regenerateHeadTail'
  | 'selectHeadTail'
  | 'continueToStorySpine'
> {
  const continueToHeadTail = () => {
    if (!state.seed || !state.predicament || !state.storyId) return
    state.setView('head-tail')
  }

  const selectHeadTail = (id: string) => {
    if (id === state.selectedHeadTailId) return
    state.setSelectedHeadTailId(id)
  }

  const continueToStorySpine = async () => {
    if (!state.seed || !state.predicament || !state.selectedHeadTail || !state.storyId) return

    const selectedHeadTailId = state.selectedHeadTail.id
    const isExistingStoryPath = Boolean(state.currentTurn || state.turnHistory.length)
    const shouldStartNewPath = !state.currentTurn || state.committedHeadTailId !== selectedHeadTailId

    state.setView('story-spine')
    if (!shouldStartNewPath) return

    if (isExistingStoryPath) state.resetPlanAfter('head-tail')
    await loaders.loadStoryTurn({ mode: 'start', headTailId: selectedHeadTailId })
  }

  return {
    continueToHeadTail,
    regenerateHeadTail: () => loaders.loadHeadTail(),
    selectHeadTail,
    continueToStorySpine,
  }
}

function createStoryProgressActions(
  { state, stage, loaders }: StorySessionActionContext,
): Pick<
  StorySessionActions,
  | 'selectTurnOption'
  | 'refineTurnOption'
  | 'continueStory'
  | 'concludeStory'
  | 'generateFullStory'
  | 'viewGeneratedStory'
> {
  const selectTurnOption = (optionId: string) => {
    if (!state.currentTurn || state.currentTurn.isConclusion || stage.stageStatus === 'loading') return
    state.setSelectedTurnOptionId(optionId)
  }

  const refineTurnOption = async ({ optionId, focus, feedback }: StoryTurnOptionRefinement) => {
    const storyId = state.storyId
    const currentTurn = state.currentTurn
    const optionToRefine = currentTurn?.options.find((option) => option.id === optionId)
    if (!storyId || !currentTurn || currentTurn.isConclusion || !optionToRefine) return

    await runStorySessionStageRequest(
      state,
      stage,
      () => requestStoryTurnOptionRefinement({
        storyId,
        revision: state.revision,
        turnId: currentTurn.id,
        optionId: optionToRefine.id,
        focus,
        feedback,
      }),
      (result) => {
        applyStoryTurnState(state, result)
      },
    )
  }

  const advanceStory = (mode: Extract<StoryTurnMode, 'continue' | 'conclude'>) => {
    if (!state.currentTurn || state.currentTurn.isConclusion || !state.selectedTurnOption) return Promise.resolve()
    return loaders.loadStoryTurn({
      mode,
      turnId: state.currentTurn.id,
      optionId: state.selectedTurnOption.id,
    })
  }

  const generateFullStory = async () => {
    if (!state.trimmedIdea || !state.storyPlan || !state.storyId || state.generatedStory) return

    await runStorySessionStageRequest(
      state,
      stage,
      () => requestFullStory({ storyId: state.storyId!, revision: state.revision }),
      (result) => {
        state.setGeneratedStory(result.story)
        state.setView('complete')
      },
    )
  }

  return {
    selectTurnOption,
    refineTurnOption,
    continueStory: () => advanceStory('continue'),
    concludeStory: async () => {
      if (state.currentTurn?.canConclude) await advanceStory('conclude')
    },
    generateFullStory,
    viewGeneratedStory: () => {
      if (state.generatedStory) state.setView('complete')
    },
  }
}

function createNavigationActions(
  { state, stage, loaders }: StorySessionActionContext,
  generateFullStory: StorySessionActions['generateFullStory'],
): Pick<StorySessionActions, 'retryCurrentStage' | 'goBack' | 'goBackToOpening' | 'restartStory'> {
  const retryCurrentStage = async () => {
    if (state.view === 'conflict-core-picker') {
      await loaders.loadConflictCores({
        context: normalizeConflictCoreContext(state.conflictCoreContext),
        preference: state.conflictCoreFeedback || undefined,
      })
      return
    }

    if (state.view === 'predicament') {
      if (state.selectedConflictCore) await loaders.loadPredicament(state.selectedConflictCore)
      return
    }

    if (state.view === 'head-tail') {
      await loaders.loadHeadTail()
      return
    }

    if (state.view === 'story-spine' && state.pendingTurnRequest) {
      await loaders.loadStoryTurn(state.pendingTurnRequest)
      return
    }

    if (state.view === 'story-spine' && state.currentTurn?.isConclusion) await generateFullStory()
  }

  const goBack = () => {
    if (state.view === 'story-spine' && stage.stageStatus === 'error') {
      state.setPendingTurnRequest(undefined)
      stage.clearStageFeedback()
      return
    }

    stage.clearStageFeedback()
    const previousView = previousViewByView[state.view]
    if (previousView) state.setView(previousView)
  }

  const restartStory = () => {
    state.setView('opening')
    state.setIdea(getNextStoryIdeaExample(state.idea))
    state.resetStoryFoundation()
    stage.clearStageFeedback()
  }

  return {
    retryCurrentStage,
    goBack,
    goBackToOpening: () => state.setView('opening'),
    restartStory,
  }
}

interface StorySessionLoaders {
  loadConflictCores: (options?: ConflictCoreGenerationOptions) => Promise<void>
  loadPredicament: (core?: StorySessionState['selectedConflictCore']) => Promise<void>
  loadHeadTail: (
    predicament?: StorySessionState['predicament'],
    seed?: StorySessionState['seed'],
    approach?: StorySessionState['selectedApproach'],
  ) => Promise<void>
  loadStoryTurn: (request: PendingTurnRequest) => Promise<void>
}

function createStorySessionLoaders(
  state: StorySessionState,
  stage: StoryStageRequest,
): StorySessionLoaders {
  return {
    loadConflictCores: (options) => loadConflictCoresFromApi(state, stage, options),
    loadPredicament: (core = state.selectedConflictCore) => loadPredicamentFromApi(state, stage, core),
    loadHeadTail: (predicament = state.predicament, seed = state.seed, approach = state.selectedApproach) => (
      loadHeadTailFromApi(state, stage, predicament, seed, approach)
    ),
    loadStoryTurn: (request) => loadStoryTurnFromApi(state, stage, request),
  }
}

function applyStoryTurnState(state: StorySessionState, result: StoryTurnResponse) {
  state.setTurnHistory(result.history)
  state.setCurrentTurn(result.turn)
  state.setGeneratedStory(undefined)
}

async function runStorySessionStageRequest<Result extends StorySessionVersion>(
  state: StorySessionState,
  stage: StoryStageRequest,
  request: () => Promise<Result>,
  applyResult: (result: Result) => void,
) {
  await stage.runStageRequest(request, (result) => {
    state.applySessionVersion(result)
    applyResult(result)
  })
}

async function loadConflictCoresFromApi(
  state: StorySessionState,
  stage: StoryStageRequest,
  {
    context,
    generateSystemDraft = false,
    preference,
    excludedTitles = state.conflictCores.map((core) => core.title),
    fresh = false,
  }: ConflictCoreGenerationOptions = {},
) {
  if (!state.trimmedIdea) return

  const confirmedContext = normalizeConflictCoreContext(context)
  const normalizedPreference = preference?.trim()
  const storyId = fresh ? undefined : state.storyId
  await runStorySessionStageRequest(
    state,
    stage,
    () => requestConflictCores({
      idea: state.trimmedIdea,
      expansionScope: defaultStoryExpansionScope,
      context: confirmedContext,
      generateSystemDraft: generateSystemDraft || undefined,
      storyId,
      revision: storyId ? state.revision : undefined,
      preference: normalizedPreference,
      excludedTitles: excludedTitles.length ? excludedTitles : undefined,
    }),
    (result) => {
      state.setSeed(result.seed)
      state.setConflictCores(result.conflictCores)
      if (confirmedContext) state.setConflictCoreContext(confirmedContext)
      state.setSelectedConflictCoreId(result.conflictCores[0]?.id)
      state.setConflictCoreFeedback(normalizedPreference ?? '')
      state.resetPlanAfter('conflict-core')
    },
  )
}

async function loadPredicamentFromApi(
  state: StorySessionState,
  stage: StoryStageRequest,
  core = state.selectedConflictCore,
) {
  if (!core || !state.storyId) return

  await runStorySessionStageRequest(
    state,
    stage,
    () => requestStoryPredicament({
      storyId: state.storyId!,
      revision: state.revision,
      conflictCoreId: core.id,
    }),
    (result) => {
      state.setPredicament(result.predicament)
      state.setSelectedApproachId(undefined)
      state.resetPlanAfter('predicament')
    },
  )
}

async function loadHeadTailFromApi(
  state: StorySessionState,
  stage: StoryStageRequest,
  predicament = state.predicament,
  seed = state.seed,
  approach = state.selectedApproach,
) {
  if (!state.trimmedIdea || !seed || !predicament || !approach || !state.storyId) return

  await runStorySessionStageRequest(
    state,
    stage,
    () => requestHeadTailOptions({
      storyId: state.storyId!,
      revision: state.revision,
      predicamentId: predicament.id,
      approachId: approach.id,
    }),
    (result) => {
      state.setHeadTailOptions(result.options)
      state.setSelectedHeadTailId(result.options[0]?.id)
      state.resetPlanAfter('head-tail')
    },
  )
}

async function loadStoryTurnFromApi(
  state: StorySessionState,
  stage: StoryStageRequest,
  request: PendingTurnRequest,
) {
  if (!state.storyId) return

  state.setPendingTurnRequest(request)
  await runStorySessionStageRequest(
    state,
    stage,
    () => requestStoryTurn({ storyId: state.storyId!, revision: state.revision, ...request }),
    (result) => {
      applyStoryTurnState(state, result)
      if (request.headTailId) state.setCommittedHeadTailId(request.headTailId)
      state.setSelectedTurnOptionId(undefined)
      state.setPendingTurnRequest(undefined)
    },
  )
}
