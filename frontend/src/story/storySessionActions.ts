import {
  requestFullStory,
  requestHeadTailOptions,
  requestStoryDirections,
  requestStoryTurn,
} from './storyApi'
import {
  type PendingTurnRequest,
  type StorySessionState,
} from './useStorySessionState'
import type { StoryTurnMode, StoryView } from './types'
import type { StoryStageRequest } from './useStoryStageRequest'

const defaultStoryExpansionScope = 'keep-scale' as const

interface PredicamentGenerationOptions {
  preference?: string
  excludedTitles?: string[]
  fresh?: boolean
}

export interface StorySessionActions {
  updateIdea: (idea: string) => void
  useExample: () => void
  openDirectionPicker: () => Promise<void>
  showDifferentPredicaments: () => Promise<void>
  applyPredicamentFeedback: (feedback: string) => Promise<void>
  selectPredicament: (id: string) => void
  continueToHeadTail: () => Promise<void>
  regenerateHeadTail: () => Promise<void>
  selectHeadTail: (id: string) => void
  continueToStorySpine: () => Promise<void>
  selectTurnOption: (optionId: string) => void
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
  'direction-picker': 'opening',
  'head-tail': 'direction-picker',
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
    ...createIdeaAndPredicamentActions(context),
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

function createIdeaAndPredicamentActions(
  { state, loaders }: StorySessionActionContext,
): Pick<
  StorySessionActions,
  | 'updateIdea'
  | 'useExample'
  | 'openDirectionPicker'
  | 'showDifferentPredicaments'
  | 'applyPredicamentFeedback'
  | 'selectPredicament'
> {
  const updateIdea = (idea: string) => {
    if (idea.trim() !== state.trimmedIdea && state.predicamentOptions.length) {
      state.resetStoryFoundation()
    }
    state.setIdea(idea)
  }

  const openDirectionPicker = async () => {
    if (!state.trimmedIdea) return

    state.resetStoryFoundation()
    state.setView('direction-picker')
    await loaders.loadPredicaments({ excludedTitles: [], fresh: true })
  }

  const applyPredicamentFeedback = async (feedback: string) => {
    const preference = feedback.trim()
    if (preference) await loaders.loadPredicaments({ preference })
  }

  const selectPredicament = (id: string) => {
    if (id === state.selectedPredicamentId) return
    state.setSelectedPredicamentId(id)
    state.resetPlanAfter('predicament')
  }

  return {
    updateIdea,
    useExample: () => updateIdea(createRandomIdea(state.idea)),
    openDirectionPicker,
    showDifferentPredicaments: () => loaders.loadPredicaments(),
    applyPredicamentFeedback,
    selectPredicament,
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
    if (!state.seed || !state.selectedPredicament || !state.storyId) return
    state.setView('head-tail')
    if (!state.headTailOptions.length) await loaders.loadHeadTail(state.selectedPredicament, state.seed)
  }

  const selectHeadTail = (id: string) => {
    if (id === state.selectedHeadTailId) return
    state.setSelectedHeadTailId(id)
  }

  const continueToStorySpine = async () => {
    if (!state.seed || !state.selectedPredicament || !state.selectedHeadTail || !state.storyId) return

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
  | 'continueStory'
  | 'concludeStory'
  | 'generateFullStory'
  | 'viewGeneratedStory'
> {
  const selectTurnOption = (optionId: string) => {
    if (!state.currentTurn || state.currentTurn.isConclusion || stage.stageStatus === 'loading') return
    state.setSelectedTurnOptionId(optionId)
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

    await stage.runStageRequest(
      () => requestFullStory({ storyId: state.storyId!, revision: state.revision }),
      (result) => {
        state.applySessionVersion(result)
        state.setGeneratedStory(result.story)
        state.setView('complete')
      },
    )
  }

  return {
    selectTurnOption,
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
    if (state.view === 'direction-picker') {
      await loaders.loadPredicaments({ preference: state.predicamentFeedback || undefined })
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
  loadPredicaments: (options?: PredicamentGenerationOptions) => Promise<void>
  loadHeadTail: (
    predicament?: StorySessionState['selectedPredicament'],
    seed?: StorySessionState['seed'],
  ) => Promise<void>
  loadStoryTurn: (request: PendingTurnRequest) => Promise<void>
}

function createStorySessionLoaders(
  state: StorySessionState,
  stage: StoryStageRequest,
): StorySessionLoaders {
  return {
    loadPredicaments: (options) => loadPredicamentsFromApi(state, stage, options),
    loadHeadTail: (predicament = state.selectedPredicament, seed = state.seed) => (
      loadHeadTailFromApi(state, stage, predicament, seed)
    ),
    loadStoryTurn: (request) => loadStoryTurnFromApi(state, stage, request),
  }
}

async function loadPredicamentsFromApi(
  state: StorySessionState,
  stage: StoryStageRequest,
  {
    preference,
    excludedTitles = state.predicamentOptions.map((predicament) => predicament.title),
    fresh = false,
  }: PredicamentGenerationOptions = {},
) {
  if (!state.trimmedIdea) return

  const normalizedPreference = preference?.trim()
  const storyId = fresh ? undefined : state.storyId
  await stage.runStageRequest(
    () => requestStoryDirections({
      idea: state.trimmedIdea,
      expansionScope: defaultStoryExpansionScope,
      storyId,
      revision: storyId ? state.revision : undefined,
      preference: normalizedPreference,
      excludedTitles: excludedTitles.length ? excludedTitles : undefined,
    }),
    (result) => {
      state.applySessionVersion(result)
      state.setSeed(result.seed)
      state.setPredicamentOptions(result.directions)
      state.setSelectedPredicamentId(result.directions[0]?.id)
      state.setPredicamentFeedback(normalizedPreference ?? '')
      state.resetPlanAfter('predicament')
    },
  )
}

async function loadHeadTailFromApi(
  state: StorySessionState,
  stage: StoryStageRequest,
  predicament = state.selectedPredicament,
  seed = state.seed,
) {
  if (!state.trimmedIdea || !seed || !predicament || !state.storyId) return

  await stage.runStageRequest(
    () => requestHeadTailOptions({
      storyId: state.storyId!,
      revision: state.revision,
      predicamentId: predicament.id,
    }),
    (result) => {
      state.applySessionVersion(result)
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
  await stage.runStageRequest(
    () => requestStoryTurn({ storyId: state.storyId!, revision: state.revision, ...request }),
    (result) => {
      state.applySessionVersion(result)
      if (request.headTailId) state.setCommittedHeadTailId(request.headTailId)
      state.setTurnHistory(result.history)
      state.setCurrentTurn(result.turn)
      state.setSelectedTurnOptionId(undefined)
      state.setPendingTurnRequest(undefined)
      state.setGeneratedStory(undefined)
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
