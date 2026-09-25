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
  continueToHeadTail: () => Promise<void>
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

const storyIdeaExamples = [
  '李明第一天自己去上学。',
  '王小雨和同学一起做值日。',
  '陈晨在放学路上捡到一片漂亮的叶子。',
  '周末，小雅和家人去公园玩。',
  '赵阳第一次学骑自行车。',
  '刘佳帮妈妈一起去买菜。',
  '张宁给奶奶做一张生日卡。',
  '林可参加班级的朗读比赛。',
  '何宇和好朋友因为一件小事闹别扭了。',
  '孙悦照顾窗台上刚发芽的小植物。',
  '吴迪忘记带作业本，想在上课前找到办法。',
  '杨帆把雨伞借给了同学，放学时自己没有伞。',
  '许诺第一次去图书馆借书。',
  '高兴发现自己的水杯和同学的拿错了。',
  '杜若想学会做一道简单的早餐。',
  '马超放学后留下来整理教室里的图书角。',
  '唐果要把借来的漫画书按时还给同学。',
  '宋然在手工课上做坏了自己的纸风车。',
  '冯乐带着弟弟去楼下买牛奶。',
  '顾宁发现小区公告栏上的活动报名快结束了。',
  '程晓在运动会上报名参加了接力赛。',
  '罗言想把攒下的零花钱买一份礼物。',
  '韩梅第一次帮爸爸整理阳台。',
  '方圆在班级分享会上介绍自己最喜欢的一本书。',
  '潘安发现同桌今天没有来上课，想去看看他。',
  '谢雨和姐姐一起准备周末的野餐。',
  '郑晨把钥匙落在了教室里。',
  '朱琳答应帮朋友保守一个小秘密。',
  '梁川在放学后练习跳绳。',
  '董欣想邀请新搬来的邻居一起玩。',
]

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
    if (preference) await loaders.loadConflictCores({ preference })
  }

  const applyConflictCoreContext = async (context: StoryConflictCoreContext) => {
    const confirmedContext = normalizeConflictCoreContext(context)
    if (!confirmedContext) return

    state.setConflictCoreContext(confirmedContext)
    await loaders.loadConflictCores({ context: confirmedContext, excludedTitles: [] })
  }

  const generateSystemDraft = async () => {
    await loaders.loadConflictCores({ generateSystemDraft: true, excludedTitles: [] })
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
    useExample: () => updateIdea(createRandomIdea(state.idea)),
    openConflictCorePicker,
    showDifferentConflictCores: () => loaders.loadConflictCores(),
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
  const continueToHeadTail = async () => {
    if (!state.seed || !state.predicament || !state.selectedApproach || !state.storyId) return
    state.setView('head-tail')
    if (!state.headTailOptions.length) await loaders.loadHeadTail(state.predicament, state.seed, state.selectedApproach)
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

function createRandomIdea(currentIdea: string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const idea = pickRandom(storyIdeaExamples)
    if (idea !== currentIdea) return idea
  }

  const fallbackIdea = storyIdeaExamples[0]
  return fallbackIdea === currentIdea ? storyIdeaExamples[1] : fallbackIdea
}

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}
