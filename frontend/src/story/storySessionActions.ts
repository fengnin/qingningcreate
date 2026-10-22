import {
  requestFullStory,
  requestHeadTailOptions,
  requestConflictCores,
  requestStoryPredicament,
  requestStoryTurn,
  requestStoryTurnOptionRefinement,
  requestStoryCoCreationStart,
  requestPreparationAcceptance,
  requestDesignMainlineRetry,
  requestPreparationRevision,
  requestPreparationSupplement,
  requestCurveBeatUpdate,
  requestCurveBeatRegeneration,
  requestCurveBeatRejection,
  requestAffectedCurveRegeneration,
  requestCurveBeatRetention,
  requestCurveRegenerationResolution,
  requestCurveClarification,
  requestCurveConfirmation,
  requestCurveStorySpine,
  requestCurveVersionSelection,
  requestAuthorInstruction,
  requestStoryActionProposal,
  requestStoryActionProposalConfirmation,
  requestStoryWriting,
} from './storyApi'
import {
  type PendingTurnRequest,
  type StorySessionState,
} from './useStorySessionState'
import { normalizeConflictCoreContext } from './conflictCoreContext'
import { getNextStoryIdeaExample } from './storyIdeaExamples'
import type {
  StoryConflictCoreContext,
  CreativeBrief,
  StorySessionVersion,
  StoryTurnMode,
  StoryTurnOptionRefinement,
  StoryTurnResponse,
  StoryView,
  StoryCurveVersion,
  StoryAuthorClarificationAction,
  StoryCurveMutationResponse,
  StoryCurveRegenerationDecision,
  StoryWritingRequest,
} from './types'
import type { StoryStageRequest } from './useStoryStageRequest'

const defaultStoryExpansionScope = 'keep-scale' as const

function createClientOperationId(): string {
  const randomUuid = globalThis.crypto?.randomUUID
  // Story identifiers intentionally start with a letter. Keep the opaque
  // client operation id within that same wire-format contract even when the
  // UUID happens to begin with a digit.
  if (randomUuid) return `op-${randomUuid.call(globalThis.crypto)}`
  return `op-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

interface ConflictCoreGenerationOptions {
  context?: StoryConflictCoreContext
  generateSystemDraft?: boolean
  preference?: string
  excludedTitles?: string[]
  fresh?: boolean
}

export interface StorySessionActions {
  retryDesignMainline: () => Promise<void>
  reviewPreparationSupplement: (supplementId: string, decision: 'accepted-design' | 'rejected' | 'keep-unknown', authorText: string) => Promise<void>
  acceptPreparation: (candidateIds: string[], authorReview?: import('../../../shared/story-preparation.js').StoryPreparationReview) => Promise<void>
  revisePreparation: (decision: 'reject' | 'regenerate' | 'revise', candidateId?: string, authorAction?: string) => Promise<void>
  updateIdea: (idea: string) => void
  useExample: () => void
  openConflictCorePicker: () => Promise<void>
  openCreativeBrief: () => void
  updateCreativeBrief: (brief: CreativeBrief) => void
  generateProvisionalCurve: (brief?: CreativeBrief, versionMode?: 'replace-draft' | 'new-version') => Promise<void>
  updateCurveBeat: (beatId: string, detail: string) => Promise<void>
  regenerateCurveBeat: (beatId: string, feedback?: string, replaceRejected?: boolean) => Promise<void>
  rejectCurveBeat: (beatId: string, reason?: string) => Promise<void>
  regenerateAffectedCurveBeats: (feedback?: string) => Promise<void>
  retainAffectedCurveBeats: (beatIds: string[]) => Promise<void>
  resolveAffectedCurveBeats: (decisions: Record<string, StoryCurveRegenerationDecision>, independentUnknownIds?: string[], acceptedDesignProposalIds?: string[]) => Promise<void>
  changeCurveClarification: (action: StoryAuthorClarificationAction, fields?: {
    clarificationId?: string; targetBeatId?: string; prompt?: string; causalGap?: string; answerText?: string
  }) => Promise<boolean>
  confirmProvisionalCurve: (acceptedDesignProposalIds?: string[]) => Promise<boolean>
  openStoryWriting: () => void
  resumeStoryDesign: () => void
  reviewStoryPredicament: () => void
  openCompletedStory: () => void
  startStorySpineFromCurve: () => Promise<void>
  writeStory: (request: Omit<StoryWritingRequest, 'storyId' | 'revision'>) => Promise<void>
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
  selectCurveVersion: (versionId: string) => Promise<void>
  applyAuthorInstruction: (targetBeatId: string, text: string) => Promise<boolean>
  proposeStoryAction: (action: string) => Promise<void>
  confirmStoryActionProposal: (mode: Extract<StoryTurnMode, 'continue' | 'conclude'>, authorConfirmation?: { actionText: string; resultText: string }) => Promise<void>
}

const previousViewByView: Partial<Record<StoryView, StoryView>> = {
  'creative-brief': 'opening',
  'preparation-review': 'creative-brief',
  'provisional-curve': 'creative-brief',
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
  const coCreationActions = createCoCreationActions(context)

  return {
    ...createStoryFoundationActions(context),
    ...coCreationActions,
    openStoryWriting: () => state.setView('story-spine'),
    resumeStoryDesign: () => {
      if (!state.provisionalCurve || stage.stageStatus === 'loading') return
      if (state.provisionalCurve.preparation?.status === 'needs-review') return
      stage.clearStageFeedback()
      state.setView('provisional-curve')
    },
    reviewStoryPredicament: () => {
      if (!state.provisionalCurve?.preparation || stage.stageStatus === 'loading') return
      stage.clearStageFeedback()
      state.setView('preparation-review')
    },
    openCompletedStory: () => {
      if (!state.generatedStory || stage.stageStatus === 'loading') return
      stage.clearStageFeedback()
      state.setView('complete')
    },
    ...createStoryWritingActions(context),
    ...createStoryPlanningActions(context),
    ...storyProgressActions,
    ...createNavigationActions(context, storyProgressActions.generateFullStory, coCreationActions.generateProvisionalCurve),
    ...createCurveVersionActions(context),
    ...createAuthorControlActions(context),
  }
}

interface StorySessionActionContext {
  state: StorySessionState
  stage: StoryStageRequest
  loaders: StorySessionLoaders
}

function createStoryWritingActions({ state, stage }: StorySessionActionContext): Pick<StorySessionActions, 'writeStory'> {
  return { writeStory: async request => {
    if (!state.storyId) return
    await runStorySessionStageRequest(state, stage,
      () => requestStoryWriting({ ...request, storyId: state.storyId!, revision: state.getRevision() }),
      result => {
        state.setWritingDraft(result.draft)
        state.setGeneratedStory(result.story)
        if (result.story) state.setView('complete')
      })
  } }
}

function createCoCreationActions(
  { state, stage }: StorySessionActionContext,
): Pick<
  StorySessionActions,
  | 'openCreativeBrief'
  | 'updateCreativeBrief'
  | 'generateProvisionalCurve'
  | 'acceptPreparation'
  | 'retryDesignMainline'
  | 'revisePreparation'
  | 'reviewPreparationSupplement'
  | 'updateCurveBeat'
  | 'regenerateCurveBeat'
  | 'rejectCurveBeat'
  | 'regenerateAffectedCurveBeats'
  | 'retainAffectedCurveBeats'
  | 'resolveAffectedCurveBeats'
  | 'changeCurveClarification'
  | 'confirmProvisionalCurve'
  | 'startStorySpineFromCurve'
> {
  const openCreativeBrief = () => {
    if (!state.trimmedIdea) return
    // Returning from the opening screen is still part of the current author
    // session. Only a genuinely new session should clear the saved curve and
    // its version history.
    if (!state.storyId && !state.provisionalCurve) {
      state.resetStoryFoundation()
    }
    state.setView('creative-brief')
  }

  const generateProvisionalCurve = async (
    briefOverride?: CreativeBrief,
    versionMode: 'replace-draft' | 'new-version' = 'new-version',
  ) => {
    if (!state.trimmedIdea) return
    const brief = briefOverride ?? state.creativeBrief
    const existingSession = state.storyId ? { storyId: state.storyId, revision: state.getRevision() } : undefined
    if (!existingSession) state.resetStoryFoundation()
    else state.resetPlanAfter('conflict-core')
    state.setCreativeBrief(brief)
    state.setDirectionBuildProgress(0)
    state.setView('provisional-curve')
    await runStorySessionStageRequest(
      state,
      stage,
      () => requestStoryCoCreationStart({
        generationMode: 'review-actions',
        idea: state.trimmedIdea,
        brief,
        operationId: createClientOperationId(),
        ...(existingSession ? { ...existingSession, versionMode } : {}),
      }, state.setDirectionBuildProgress),
      (result) => {
        state.setSeed(result.seed)
        state.setCreativeBrief(result.brief)
        state.setProvisionalCurve(result.curve)
        state.setConfirmedCurve(undefined)
        state.setCurveVersions(result.curveVersions ?? [])
        state.setActiveCurveVersionId(result.activeCurveVersionId)
      },
    )
  }

  const updateCurveBeat = async (beatId: string, detail: string) => {
    const operationId = createClientOperationId()
    await runCurveMutationRequest(state, stage, ({ storyId, revision, curveId }) => (
      requestCurveBeatUpdate({ storyId, revision, curveId, beatId, detail, operationId })
    ))
  }

  const acceptPreparation = async (candidateIds: string[], authorReview?: import('../../../shared/story-preparation.js').StoryPreparationReview) => {
    const createNewVersion = needsNewPreparationVersion(state)
    await runCurveMutationRequest(state, stage, ({ storyId, revision, curveId }) => requestPreparationAcceptance({ storyId, revision, curveId, acceptedCandidateIds: candidateIds, ...(createNewVersion ? { versionMode: 'new-version' as const } : {}), ...(authorReview ? { authorReview } : {}) }))
  }
  const retryDesignMainline = async () => {
    await runCurveMutationRequest(state, stage, requestDesignMainlineRetry)
  }
  const reviewPreparationSupplement = async (supplementId: string, decision: 'accepted-design' | 'rejected' | 'keep-unknown', authorText: string) => {
    await runCurveMutationRequest(state, stage, ({ storyId, revision, curveId }) => requestPreparationSupplement({ storyId, revision, curveId, supplementId, decision, authorText }))
  }
  const revisePreparation = async (decision: 'reject' | 'regenerate' | 'revise', candidateId?: string, authorAction?: string) => {
    const createNewVersion = needsNewPreparationVersion(state)
    await runCurveMutationRequest(state, stage, ({ storyId, revision, curveId }) => requestPreparationRevision({ storyId, revision, curveId, decision, candidateId, authorAction, ...(createNewVersion ? { versionMode: 'new-version' as const } : {}) }))
  }

  const regenerateCurveBeat = async (beatId: string, feedback?: string, replaceRejected = false) => {
    await runCurveMutationRequest(state, stage, ({ storyId, revision, curveId }) => (
      requestCurveBeatRegeneration({
        storyId,
        revision,
        curveId,
        beatId,
        feedback: feedback?.trim() || undefined,
        replaceRejected: replaceRejected || undefined,
      })
    ))
  }

  const rejectCurveBeat = async (beatId: string, reason?: string) => {
    await runCurveMutationRequest(state, stage, ({ storyId, revision, curveId }) => (
      requestCurveBeatRejection({ storyId, revision, curveId, beatId, reason })
    ))
  }

  const regenerateAffectedCurveBeats = async (feedback?: string) => {
    const curve = state.provisionalCurve
    if (!curve || !state.storyId) return
    await runStorySessionStageRequest(
      state,
      stage,
      () => requestAffectedCurveRegeneration({ storyId: state.storyId!, revision: state.getRevision(), curveId: curve.id, feedback }),
      (result) => {
        applyCurveMutationState(state, result)
        state.setPendingCurveRegeneration(result.pendingCurveRegeneration)
      },
    )
  }

  const resolveAffectedCurveBeats = async (decisions: Record<string, StoryCurveRegenerationDecision>, independentUnknownIds?: string[], acceptedDesignProposalIds?: string[]) => {
    const curve = state.provisionalCurve
    const preview = state.pendingCurveRegeneration
    if (!curve || !preview || !state.storyId) return
    await runStorySessionStageRequest(
      state,
      stage,
      () => requestCurveRegenerationResolution({
        storyId: state.storyId!,
        revision: state.getRevision(),
        curveId: curve.id,
        previewId: preview.id,
        decisions,
        ...(independentUnknownIds ? { independentUnknownIds } : {}),
        ...(acceptedDesignProposalIds ? { acceptedDesignProposalIds } : {}),
      }),
      (result) => {
        applyCurveMutationState(state, result)
        state.setPendingCurveRegeneration(undefined)
      },
    )
  }

  const retainAffectedCurveBeats = async (beatIds: string[]) => {
    await runCurveMutationRequest(state, stage, reference => requestCurveBeatRetention({ ...reference, beatIds }))
  }

  const changeCurveClarification: StorySessionActions['changeCurveClarification'] = async (action, fields = {}) => {
    const confirmed = Boolean(state.confirmedCurve)
    const curve = state.provisionalCurve
    if (!curve || !state.storyId) return false
    let saved = false
    await runStorySessionStageRequest(state, stage,
      () => requestCurveClarification({
        storyId: state.storyId!, revision: state.getRevision(), curveId: curve.id, action, ...fields,
        ...(confirmed ? { versionMode: 'new-version' as const } : {}),
      }),
      (result) => {
        applyCurveMutationState(state, result)
        saved = true
        if (confirmed) {
          state.setConfirmedCurve(undefined)
          state.resetPlanAfter('conflict-core')
          state.setView('provisional-curve')
        }
      },
    )
    return saved
  }

  const confirmProvisionalCurve = async (acceptedDesignProposalIds?: string[]) => {
    const curve = state.provisionalCurve
    if (!curve || !state.storyId || state.confirmedCurve) return false
    let confirmed = false
    await runStorySessionStageRequest(
      state,
      stage,
      () => requestCurveConfirmation({
        storyId: state.storyId!,
        revision: state.getRevision(),
        curveId: curve.id,
        ...(acceptedDesignProposalIds ? { acceptedDesignProposalIds } : {}),
      }),
      (result) => {
        state.setProvisionalCurve(result.curve)
        state.setConfirmedCurve(result.confirmedCurve)
        state.setCurveVersions(result.curveVersions ?? [])
        state.setActiveCurveVersionId(result.activeCurveVersionId)
        confirmed = true
      },
    )
    return confirmed
  }

  const startStorySpineFromCurve = async () => {
    const curve = state.provisionalCurve
    if (!curve || !state.confirmedCurve || !state.storyId) return
    await runStorySessionStageRequest(
      state,
      stage,
      () => requestCurveStorySpine({
        storyId: state.storyId!,
        revision: state.getRevision(),
        curveId: curve.id,
      }),
      (result) => {
        state.setSeed(result.seed)
        state.setPredicament(result.predicament)
        state.setSelectedApproachId(result.approach.id)
        state.setHeadTailOptions([result.headTail])
        state.setSelectedHeadTailId(result.headTail.id)
        state.setCommittedHeadTailId(result.headTail.id)
        applyStoryTurnState(state, result)
        state.setSelectedTurnOptionId(undefined)
        state.setView('story-spine')
      },
    )
  }

  return {
    openCreativeBrief,
    updateCreativeBrief: state.setCreativeBrief,
    generateProvisionalCurve,
    acceptPreparation,
    retryDesignMainline,
    revisePreparation,
    reviewPreparationSupplement,
    updateCurveBeat,
    regenerateCurveBeat,
    rejectCurveBeat,
    regenerateAffectedCurveBeats,
    retainAffectedCurveBeats,
    resolveAffectedCurveBeats,
    changeCurveClarification,
    confirmProvisionalCurve,
    startStorySpineFromCurve,
  }
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
    if (idea.trim() !== state.trimmedIdea && (state.conflictCores.length || state.provisionalCurve || state.storyId)) {
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
        revision: state.getRevision(),
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
    if (mode === 'conclude' && state.currentTurn?.presentation === 'closure-review' && state.currentTurn.canConclude) {
      return loaders.loadStoryTurn({ mode, turnId: state.currentTurn.id })
    }
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
      () => requestFullStory({ storyId: state.storyId!, revision: state.getRevision() }),
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
  generateProvisionalCurve: StorySessionActions['generateProvisionalCurve'],
): Pick<StorySessionActions, 'retryCurrentStage' | 'goBack' | 'goBackToOpening' | 'restartStory'> {
  const retryCurrentStage = async () => {
    const confirmation = state.pendingActionConfirmation
    if (state.view === 'story-spine' && confirmation && confirmation.proposalId === state.pendingActionProposal?.id && state.storyId) {
      await runStorySessionStageRequest(state, stage,
        () => requestStoryActionProposalConfirmation({ storyId: state.storyId!, revision: state.getRevision(), ...confirmation }),
        result => { applyStoryTurnState(state, result); state.setPendingActionConfirmation(undefined) })
      return
    }
    if (state.view === 'provisional-curve') {
      // A failed regeneration leaves the previous draft visible so the author
      // does not lose work. Retrying must still issue the request; create a
      // preserved new version when an existing session is involved so a retry
      // cannot silently overwrite the visible draft.
      if (stage.stageStatus === 'error' || !state.provisionalCurve) {
        await generateProvisionalCurve(undefined, state.storyId ? 'new-version' : undefined)
      }
      return
    }

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
    if (state.view === 'story-spine' && !state.confirmedCurve && stage.stageStatus === 'error') {
      state.setPendingTurnRequest(undefined)
      stage.clearStageFeedback()
      return
    }

    stage.clearStageFeedback()
    const previousView = state.view === 'provisional-curve' && state.provisionalCurve?.preparation && state.provisionalCurve.preparation.status !== 'needs-review'
      ? 'preparation-review'
      : state.view === 'story-spine' && state.confirmedCurve
      ? 'provisional-curve'
      : previousViewByView[state.view]
    if (previousView) state.setView(previousView)
  }

  const restartStory = () => {
    state.setView('opening')
    state.setIdea('')
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

function needsNewPreparationVersion(state: StorySessionState): boolean {
  return Boolean(state.confirmedCurve || state.provisionalCurve?.status !== 'draft')
}

function applyStoryTurnState(state: StorySessionState, result: StoryTurnResponse) {
  state.setTurnHistory(result.history)
  state.setCurrentTurn(result.turn)
  state.setGeneratedStory(undefined)
  state.setPendingActionProposal(result.pendingActionProposal)
}

function applyCurveMutationState(
  state: StorySessionState,
  result: {
    curve: import('./types').ProvisionalCurve
    pendingCurveRegeneration?: import('./types').StoryCurveRegenerationPreview
    curveVersions?: StoryCurveVersion[]
    activeCurveVersionId?: string
  },
) {
  const startsNewVersion = Boolean(state.provisionalCurve && state.provisionalCurve.id !== result.curve.id)
  state.setProvisionalCurve(result.curve)
  if ('pendingCurveRegeneration' in result) state.setPendingCurveRegeneration(result.pendingCurveRegeneration)
  else state.setPendingCurveRegeneration(undefined)
  if (result.curveVersions) state.setCurveVersions(result.curveVersions)
  state.setActiveCurveVersionId(result.activeCurveVersionId)
  if (startsNewVersion) {
    state.setConfirmedCurve(undefined)
    state.resetPlanAfter('conflict-core')
  }
  // Accepting a direction from its dedicated page opens the newly built design.
  if (state.view === 'preparation-review' && result.curve.preparation?.status === 'accepted-design') {
    state.setView('provisional-curve')
  }
}

function createCurveVersionActions(
  { state, stage }: StorySessionActionContext,
  ): Pick<StorySessionActions, 'selectCurveVersion'> {
  const selectCurveVersion = async (versionId: string) => {
    if (!state.storyId || versionId === state.activeCurveVersionId) return
    await runStorySessionStageRequest(
      state,
      stage,
      () => requestCurveVersionSelection({ storyId: state.storyId!, revision: state.getRevision(), versionId }),
      (snapshot) => {
        state.applySessionSnapshot(snapshot)
        // Selecting a design version should display that design.
        if (snapshot.curve) state.setView('provisional-curve')
      },
    )
  }

  return { selectCurveVersion }
}

function createAuthorControlActions(
  { state, stage }: StorySessionActionContext,
): Pick<StorySessionActions, 'applyAuthorInstruction' | 'proposeStoryAction' | 'confirmStoryActionProposal'> {
  const applyAuthorInstruction = async (targetBeatId: string, text: string) => {
    if (!state.storyId || !state.provisionalCurve || !text.trim()) return false
    let applied = false
    await runStorySessionStageRequest(
      state,
      stage,
      () => requestAuthorInstruction({
        storyId: state.storyId!,
        revision: state.getRevision(),
        targetBeatId,
        text: text.trim(),
      }),
      (result) => {
        applyCurveMutationState(state, result)
        state.setConfirmedCurve(undefined)
        // The server intentionally clears the old narrative path when an
        // author changes the confirmed mainline. Clear the client projection
        // at the same boundary so it cannot offer a stale "current turn".
        state.resetPlanAfter('conflict-core')
        state.setView('provisional-curve')
        applied = true
      },
    )
    return applied
  }

  const proposeStoryAction = async (action: string) => {
    if (!state.storyId || !state.currentTurn || state.currentTurn.isConclusion || !action.trim()) return
    await runStorySessionStageRequest(
      state,
      stage,
      () => requestStoryActionProposal({
        storyId: state.storyId!,
        revision: state.getRevision(),
        turnId: state.currentTurn!.id,
        action: action.trim(),
      }),
      (result) => state.setPendingActionProposal(result.proposal),
    )
  }

  const confirmStoryActionProposal = async (mode: Extract<StoryTurnMode, 'continue' | 'conclude'>, authorConfirmation?: { actionText: string; resultText: string }) => {
    const proposal = state.pendingActionProposal
    if (!state.storyId || !proposal) return
    state.setPendingActionConfirmation({ proposalId: proposal.id, mode, ...(authorConfirmation ? { authorConfirmation } : {}) })
    await runStorySessionStageRequest(
      state,
      stage,
      () => requestStoryActionProposalConfirmation({
        storyId: state.storyId!,
        revision: state.getRevision(),
        proposalId: proposal.id,
        mode,
        ...(authorConfirmation ? { authorConfirmation } : {}),
      }),
      (result) => { applyStoryTurnState(state, result); state.setPendingActionConfirmation(undefined) },
    )
  }

  return { applyAuthorInstruction, proposeStoryAction, confirmStoryActionProposal }
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

interface CurveMutationRequestContext {
  storyId: string
  revision: number
  curveId: string
}

async function runCurveMutationRequest(
  state: StorySessionState,
  stage: StoryStageRequest,
  request: (context: CurveMutationRequestContext) => Promise<StoryCurveMutationResponse>,
): Promise<void> {
  const curve = state.provisionalCurve
  const storyId = state.storyId
  if (!curve || !storyId) return

  await runStorySessionStageRequest(
    state,
    stage,
    () => request({ storyId, revision: state.getRevision(), curveId: curve.id }),
    (result) => applyCurveMutationState(state, result),
  )
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
      revision: storyId ? state.getRevision() : undefined,
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
      revision: state.getRevision(),
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
      revision: state.getRevision(),
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
    () => requestStoryTurn({ storyId: state.storyId!, revision: state.getRevision(), ...request }),
    (result) => {
      applyStoryTurnState(state, result)
      if (request.headTailId) state.setCommittedHeadTailId(request.headTailId)
      state.setSelectedTurnOptionId(undefined)
      state.setPendingTurnRequest(undefined)
    },
  )
}
