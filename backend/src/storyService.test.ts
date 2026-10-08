import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  StoryAction,
  CreativeBrief,
  StoryCurveRegenerationDecision,
  StoryConflictCoreSystemDraft,
  StoryNarrativeState,
  StoryPredicament,
  StoryTurn,
  StoryTransition,
} from '../../shared/story-contract.js'
import {
  createBoundedSystemConflictCoreDraftFallback,
  createCoreAnchoredPredicamentFallback,
  createOriginalIdeaFallbackSeed,
  createSystemDraftCandidatePreservingFallback,
  createSystemDraftHeadTailFallback,
  createSystemDraftConflictCoreFallback,
  createSystemDraftStoryTurnFallback,
  shouldAutoGenerateSystemConflictCoreDraft,
  validateConfirmedCurveStoryTurnContinuation,
  validatePredicamentForConflictCore,
  validateSystemConflictCoreDraft,
  validateSystemDraftStoryTurnContinuation,
  parseStoryAuthorInstructionRequest,
  parseStoryActionProposalRequest,
  looksLikeAuthorInstruction,
  createDirectCoCreationSeed,
  getStorySessionSnapshot,
  generateDirections,
  startStoryCoCreation,
  confirmSessionCurve,
  startSessionStorySpineFromCurve,
  updateSessionCurveBeat,
} from './storyService.js'
import { AppError } from './qwen.js'
import {
  confirmProvisionalCurve,
  createProvisionalCurveFallback,
  generateProvisionalCurve,
  isSystemCurveProposalSafe,
  materializeConfirmedCurve,
  previewAffectedCurveBeats,
  resolveAffectedCurveBeats,
  rejectCurveBeat,
  regenerateCurveBeat,
  regenerateAffectedCurveBeats,
  updateCurveSourceFactDisposition,
  updateCurveBeat,
} from './storyCoCreation.js'
import { createNarrativeStateMachine } from './storyState.js'
import { createStoryDesignRecord, getMissingStoryDesignSections, updateStoryDesignCoverage } from './storyDesign.js'

const examples = {
  personal: {
    idea: '婚礼彩排前，安澜在借来的礼服口袋里找到断联朋友的耳环。礼服明早要还，她答应不再联系，却想在仪式前决定要不要送回去。',
    seed: {
      activeSituation: '婚礼彩排前，安澜在借来的礼服口袋里找到断联朋友的耳环。礼服明早要还，她答应不再联系，却想在仪式前决定要不要送回去。',
      lockedGoal: '想在仪式前决定要不要送回去',
      lockedFacts: ['礼服明早要还', '她答应不再联系'],
    },
  },
  workplace: {
    idea: '项目交接前，周岚在共享文件夹里发现一份未发送的报告。她答应不再干预原团队，却想在交接前决定是否提交。',
    seed: {
      activeSituation: '项目交接前，周岚在共享文件夹里发现一份未发送的报告。她答应不再干预原团队，却想在交接前决定是否提交。',
      lockedGoal: '想在交接前决定是否提交',
      lockedFacts: ['项目交接前', '在共享文件夹里发现一份未发送的报告', '她答应不再干预原团队'],
    },
  },
}

const { idea } = examples.personal
const seed = examples.personal.seed

function createValidDraft(): StoryConflictCoreSystemDraft {
  return {
    goal: seed.lockedGoal,
    stake: '继续行动可能触碰自己“不再联系”的承诺',
    constraint: '礼服明早要还',
    origin: 'model',
    directions: [
      {
        label: '归还期限',
        mechanismType: 'information-gap',
        premise: '暂定：礼服明早要还，让耳环是否送回去的决定不能继续搁置',
        tradeoff: '在礼服明早要还前决定要不要送回耳环，还是暂不联系',
      },
      {
        label: '断联承诺',
        mechanismType: 'initiation-block',
        premise: '暂定：她答应不再联系，让送回耳环的决定难以启动',
        tradeoff: '守住不再联系的承诺，还是决定要不要送回耳环',
      },
      {
        label: '耳环归属',
        mechanismType: 'meaning-commitment',
        premise: '暂定：断联朋友的耳环让送回去的决定改变取向',
        tradeoff: '保留断联朋友的耳环，还是在仪式前决定要不要送回去',
      },
    ],
  }
}

const sparseIdea = '青柠去游乐园'
const sparseSeed = {
  subject: '青柠',
  activeSituation: sparseIdea,
  lockedGoal: '去游乐园',
  lockedFacts: ['青柠去游乐园'],
  worldMode: 'realistic-default' as const,
  expansionScope: 'keep-scale' as const,
  unknowns: [],
}

function createConfirmedOpeningTurn(event: string): StoryTurn {
  return {
    id: 'turn-1',
    phase: 'opening',
    node: {
      id: 'node-1',
      title: '首回合边界',
      event,
      purpose: '让主角先面对已确认的阻碍。',
      goalState: 'trying',
    },
    conflict: {
      nodeId: 'node-1',
      conflict: '原来的安排需要重新判断。',
      action: '选择一个此刻可以承担的方向。',
      consequence: '选择会留下需要继续面对的取舍。',
      intensity: 1,
      anchor: '起点',
    },
    question: '现在先怎么做？',
    options: [],
    narrativeAction: null,
    transition: null,
    canConclude: false,
    isConclusion: false,
  }
}

const richCurveIdea = '毕业展布置前，沈乔在借来的投影仪里看到和前队友剪的短片。投影仪今晚要归还，她答应不再改动作品，却想在展出前决定要不要删掉自己的名字。'
const richCurveSeed = {
  subject: '沈乔',
  activeSituation: richCurveIdea,
  lockedGoal: '在展出前决定要不要删掉自己的名字',
  lockedFacts: [richCurveIdea],
  worldMode: 'realistic-default' as const,
  expansionScope: 'keep-scale' as const,
  unknowns: [],
}

const relationshipCurveIdea = '周岚想和姐姐一起保住父亲留下的书店，却答应过不再替姐姐做决定；姐姐准备把店卖掉。'
const relationshipBoundaryCurveIdea = '周岚想和姐姐一起保住父亲留下的书店，却答应过不再替姐姐做决定；姐姐准备把店卖掉，卖店合同将在周五前签署。'

const reportSeed = {
  activeSituation: '周岚要提交报告',
  lockedGoal: '提交报告',
  lockedFacts: ['周岚要提交报告'],
}

// The regression suite exercises deterministic, explicitly-labelled local
// fallbacks. Individual tests temporarily opt into the real-model branch only
// to verify its error boundary; none of these results are model-quality proof.
const initialStoryDisableModel = process.env.STORY_DISABLE_MODEL
test.before(() => {
  process.env.STORY_DISABLE_MODEL = 'true'
})
test.after(() => {
  if (initialStoryDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
  else process.env.STORY_DISABLE_MODEL = initialStoryDisableModel
})

function createCompactOpeningModelResponse(
  event: string,
  firstAction = '先面对投影仪今晚要归还。',
): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          node: {
            title: '归还与署名',
            event,
            purpose: '投影仪今晚要归还、答应不再改动作品、在展出前决定要不要删掉自己的名字之间的当前取舍。',
          },
          conflict: {
            conflict: '投影仪今晚要归还，沈乔答应不再改动作品，却想在展出前决定要不要删掉自己的名字。',
            action: '先判断投影仪今晚要归还、答应不再改动作品，还是在展出前决定要不要删掉自己的名字。',
            consequence: '在展出前决定要不要删掉自己的名字仍待判断。',
          },
          question: '当前先判断投影仪今晚要归还，还是答应不再改动作品？',
          options: [
            {
              label: '先面对归还',
              action: firstAction,
              immediateConsequence: '投影仪今晚要归还形成当前卡点。',
              laterEffect: '答应不再改动作品仍待判断。',
            },
            {
              label: '先守住承诺',
              action: '先保留她答应不再改动作品。',
              immediateConsequence: '答应不再改动作品作为当前优先。',
              laterEffect: '在展出前决定要不要删掉自己的名字仍待判断。',
            },
            {
              label: '先看署名取舍',
              action: '先明确在展出前决定要不要删掉自己的名字。',
              immediateConsequence: '在展出前决定要不要删掉自己的名字成为当前判断。',
              laterEffect: '投影仪今晚要归还仍待判断。',
            },
          ],
        }),
      },
    }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createOpeningPlanModelResponse(
  anchorIds = ['opening-anchor-1', 'opening-anchor-2', 'opening-anchor-3'],
): Response {
  return createCurveModelResponse({
    openingPlan: { anchorIds },
  })
}

function createRelationshipOpeningModelResponse(
  inventedResponse = false,
  hasCurrentBoundary = false,
): Response {
  const deadlineFact = hasCurrentBoundary ? '卖店合同将在周五前签署。' : ''
  const boundaryPurpose = hasCurrentBoundary
    ? '姐姐准备把店卖掉、卖店合同将在周五前签署、答应过不再替姐姐做决定之间的当前取舍。'
    : '姐姐准备把店卖掉、答应过不再替姐姐做决定之间的当前取舍。'
  const secondOption = hasCurrentBoundary
    ? {
      label: '面对周五前',
      action: '周岚先判断卖店合同将在周五前签署。',
      immediateConsequence: '卖店合同将在周五前签署作为当前优先。',
      laterEffect: '答应过不再替姐姐做决定仍待判断。',
    }
    : {
      label: '守住不替姐姐决定',
      action: '周岚先保留「却答应过不再替姐姐做决定」这项承诺。',
      immediateConsequence: '却答应过不再替姐姐做决定仍是当前事实。',
      laterEffect: '姐姐准备把店卖掉仍待周岚继续面对。',
    }
  return createCurveModelResponse({
    node: {
      title: '书店的取舍',
      event: `周岚想和姐姐一起保住父亲留下的书店；姐姐准备把店卖掉，她却答应过不再替姐姐做决定。${deadlineFact}`,
      purpose: boundaryPurpose,
    },
    conflict: {
      conflict: '姐姐准备把店卖掉，但周岚想和姐姐一起保住父亲留下的书店，也答应过不再替姐姐做决定。',
      action: hasCurrentBoundary
        ? '周岚先判断姐姐准备把店卖掉、卖店合同将在周五前签署，还是答应过不再替姐姐做决定。'
        : '周岚先判断姐姐准备把店卖掉，还是答应过不再替姐姐做决定。',
      consequence: hasCurrentBoundary
        ? '姐姐准备把店卖掉与卖店合同将在周五前签署仍待判断。'
        : '姐姐准备把店卖掉与答应过不再替姐姐做决定仍待判断。',
    },
    question: hasCurrentBoundary
      ? '周岚当前先判断姐姐准备把店卖掉，还是卖店合同将在周五前签署？'
      : '周岚现在先面对姐姐准备把店卖掉，还是先守住不替姐姐做决定的承诺？',
    options: [
      {
        label: '面对姐姐卖店',
        action: '周岚先面对姐姐准备把店卖掉。',
        immediateConsequence: inventedResponse
          ? '姐姐可能暂停出售动作，再说明自己的决定。'
          : '姐姐准备把店卖掉形成当前卡点。',
        laterEffect: hasCurrentBoundary
          ? '卖店合同将在周五前签署仍待判断。'
          : '是否和姐姐一起保住父亲留下的书店仍待周岚判断。',
      },
      secondOption,
      {
        label: '保住父亲书店',
        action: '周岚先守住和姐姐一起保住父亲留下的书店。',
        immediateConsequence: '和姐姐一起保住父亲留下的书店成为当前判断。',
        laterEffect: '却答应过不再替姐姐做决定仍待判断。',
      },
    ],
  })
}

function createDeadlineOpeningModelResponse(
  firstAction = '先面对在周五前把祖母的手稿交给出版社。',
): Response {
  return createCurveModelResponse({
    node: {
      title: '手稿与承诺',
      event: '林澈答应在周五前把祖母的手稿交给出版社，但他发现最后一页缺失，不知道是否该按承诺提交。',
      purpose: '在周五前把祖母的手稿交给出版社、最后一页缺失与按承诺提交之间的当前取舍。',
    },
    conflict: {
      conflict: '林澈答应在周五前把祖母的手稿交给出版社，但他发现最后一页缺失，不知道是否该按承诺提交。',
      action: '先判断最后一页缺失，还是按承诺提交。',
      consequence: '在周五前把祖母的手稿交给出版社仍待判断。',
    },
    question: '当前先判断最后一页缺失，还是按承诺提交？',
    options: [
      {
        label: '面对周五前',
        action: firstAction,
        immediateConsequence: '在周五前把祖母的手稿交给出版社作为当前优先。',
        laterEffect: '最后一页缺失仍待判断。',
      },
      {
        label: '面对最后一页',
        action: '先面对最后一页缺失。',
        immediateConsequence: '最后一页缺失形成当前卡点。',
        laterEffect: '按承诺提交仍待判断。',
      },
      {
        label: '判断承诺提交',
        action: '先判断按承诺提交。',
        immediateConsequence: '按承诺提交成为当前判断。',
        laterEffect: '在周五前把祖母的手稿交给出版社仍待判断。',
      },
    ],
  })
}

function createCurveModelResponse(payload: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('accepts concrete relationship-language synonyms without accepting model-language leakage', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  const idea = '周岚想和姐姐一起保住父亲留下的书店，却答应过不再替姐姐做决定；姐姐准备把店卖掉。'
  const seed = createDirectCoCreationSeed(idea)
  assert.ok(seed)
  const brief: CreativeBrief = {
    tones: ['friendship'],
    dramaticForces: ['relationship-tension'],
    allowSystemNamedCharacters: false,
  }
  const beats = [
    { kind: 'current-state', detail: idea, sourceFactIds: ['source-fact-1', 'source-fact-2', 'source-fact-3'], dependsOn: [] },
    { kind: 'trigger', detail: '暂定：承诺让周岚无法替姐姐作决定，关系中的目标因此停住', sourceFactIds: ['source-fact-2'], dependsOn: ['beat-current-state'] },
    { kind: 'escalation', detail: '暂定：姐姐准备把店卖掉，让共同守店的目标面对姐妹关系分歧', sourceFactIds: ['source-fact-3'], dependsOn: ['beat-trigger'] },
    { kind: 'climax-choice', detail: '暂定：周岚必须在继续替姐姐做决定与面对姐姐准备卖店之间选择', sourceFactIds: ['source-fact-2', 'source-fact-3'], dependsOn: ['beat-escalation'] },
    { kind: 'resolution', detail: '暂定：这次选择改变周岚不再替姐姐做决定、也面对姐姐准备卖店的方式', sourceFactIds: ['source-fact-2', 'source-fact-3'], dependsOn: ['beat-climax-choice'] },
  ]
  const prompts: string[] = []

  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'test-only-key'
  process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
  try {
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> }
      prompts.push(request.messages?.[1]?.content ?? '')
      return createCurveModelResponse({ title: '关系主线', beats })
    }
    const curve = await generateProvisionalCurve(idea, seed, brief)
    assert.equal(curve.generation?.origin, 'model')
    assert.equal(curve.beats.filter((beat) => beat.kind !== 'current-state').length, 4)
    assert.match(prompts[0] ?? '', /按以下事实锚点写/u)
    assert.match(prompts[0] ?? '', /答应过不再替姐姐做决定/u)
    assert.match(prompts[0] ?? '', /单个提案节点只列/u)

    globalThis.fetch = async () => createCurveModelResponse({
      title: '关系主线',
      beats: beats.map((beat) => beat.kind === 'resolution'
        ? { ...beat, detail: '暂定：shared history 改变姐妹共同面对分歧的方式' }
        : beat),
    })
    await assert.rejects(
      () => generateProvisionalCurve(idea, seed, brief),
      (error: unknown) => error instanceof AppError
        && error.code === 'STORY_CURVE_MODEL_GENERATION_FAILED'
        && /英文或模板短语/u.test(error.message),
    )
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('repairs a deadline curve that invents a relative\'s wish without mislabeling the result', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  const idea = '林澈答应在周五前把祖母的手稿交给出版社，但他发现最后一页缺失，不知道是否该按承诺提交。'
  const seed = createDirectCoCreationSeed(idea)
  assert.ok(seed)
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['cost'],
    allowSystemNamedCharacters: false,
  }
  const invalidBeats = [
    { kind: 'current-state', detail: idea, sourceFactIds: ['source-fact-1', 'source-fact-2', 'source-fact-3'] },
    { kind: 'trigger', detail: '暂定：周五前交稿的期限使按承诺提交的目标停住', sourceFactIds: ['source-fact-1'] },
    { kind: 'escalation', detail: '暂定：继续按承诺提交会违背祖母的遗愿', sourceFactIds: ['source-fact-2'] },
    { kind: 'climax-choice', detail: '暂定：林澈必须在按承诺提交与保留手稿完整性之间选择', sourceFactIds: ['source-fact-1', 'source-fact-2'] },
    { kind: 'resolution', detail: '暂定：这次选择改变他对承诺与完整性的理解', sourceFactIds: ['source-fact-2', 'source-fact-3'] },
  ]
  const repairedBeats = [
    { kind: 'current-state', detail: idea, sourceFactIds: ['source-fact-1', 'source-fact-2', 'source-fact-3'] },
    { kind: 'trigger', detail: '暂定：周五前交稿的期限使按承诺提交的目标停住', sourceFactIds: ['source-fact-1'] },
    { kind: 'escalation', detail: '暂定：继续按承诺提交会承担最后一页缺失带来的代价', sourceFactIds: ['source-fact-2'] },
    { kind: 'climax-choice', detail: '暂定：林澈必须在按承诺提交祖母的手稿并承担最后一页缺失的代价，与暂缓之间选择', sourceFactIds: ['source-fact-1', 'source-fact-2', 'source-fact-3'] },
    { kind: 'resolution', detail: '暂定：这次选择改变他对按承诺提交、承担最后一页缺失代价的理解', sourceFactIds: ['source-fact-2', 'source-fact-3'] },
  ]
  const prompts: string[] = []
  let calls = 0

  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'test-only-key'
  process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
  try {
    globalThis.fetch = async (_input, init) => {
      calls += 1
      const request = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> }
      prompts.push(request.messages?.[1]?.content ?? '')
      return createCurveModelResponse({
        title: '手稿承诺',
        beats: calls === 1 ? invalidBeats : repairedBeats,
      })
    }

    const curve = await generateProvisionalCurve(idea, seed, brief)

    assert.equal(calls, 2, 'the rejected first response should receive one bounded repair attempt')
    assert.match(prompts[1] ?? '', /遗愿|祖母/u)
    assert.doesNotMatch(prompts[1] ?? '', /上一轮失败原因：.*遗愿/u)
    assert.match(prompts[1] ?? '', /逐字|原文锚点/u)
    assert.equal(curve.generation?.origin, 'model')
    assert.doesNotMatch(curve.beats.map((beat) => beat.detail).join('\n'), /遗愿|遗嘱|生前/u)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('repairs a rich contrast-and-growth curve with directional evidence across causal layers', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  const seed = createDirectCoCreationSeed(richCurveIdea)
  assert.ok(seed)
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const missingContrastBeats = [
    { kind: 'current-state', detail: richCurveIdea, sourceFactIds: ['source-fact-1', 'source-fact-2', 'source-fact-3', 'source-fact-4', 'source-fact-5'] },
    { kind: 'trigger', detail: '暂定：投影仪今晚要归还使删掉自己的名字的决定停住', sourceFactIds: ['source-fact-3', 'source-fact-5'] },
    { kind: 'escalation', detail: '暂定：继续删掉自己的名字会触碰不再改动作品的承诺', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
    { kind: 'climax-choice', detail: '暂定：沈乔必须在删掉自己的名字与不再改动作品之间选择', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
    { kind: 'resolution', detail: '暂定：这次选择改变她对前队友剪的短片和自己的名字的理解', sourceFactIds: ['source-fact-2', 'source-fact-5'] },
  ]
  const repairedBeats = [
    { kind: 'current-state', detail: richCurveIdea, sourceFactIds: ['source-fact-1', 'source-fact-2', 'source-fact-3', 'source-fact-4', 'source-fact-5'] },
    { kind: 'trigger', detail: '暂定：投影仪今晚要归还让沈乔无法照原计划决定要不要删掉自己的名字', sourceFactIds: ['source-fact-3', 'source-fact-5'] },
    { kind: 'escalation', detail: '暂定：继续删掉自己的名字反而会触碰不再改动作品的承诺', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
    { kind: 'climax-choice', detail: '暂定：沈乔必须在展出前决定要不要删掉自己的名字与她答应不再改动作品之间选择，不能再按她答应不再改动作品的条件继续', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
    { kind: 'resolution', detail: '暂定：这次选择调整在展出前决定要不要删掉自己的名字在她答应不再改动作品下的处理方式', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
  ]
  const prompts: string[] = []
  let calls = 0

  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'test-only-key'
  process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
  try {
    globalThis.fetch = async (_input, init) => {
      calls += 1
      const request = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> }
      prompts.push(request.messages?.[1]?.content ?? '')
      return createCurveModelResponse({
        title: '署名决定',
        beats: calls === 1 ? missingContrastBeats : repairedBeats,
      })
    }

    const curve = await generateProvisionalCurve(richCurveIdea, seed, brief)

    assert.equal(calls, 2, 'directional evidence failures should use one bounded repair attempt')
    assert.match(prompts[0] ?? '', /方向层级硬约束/u)
    assert.match(prompts[1] ?? '', /反差|因果层级/u)
    assert.equal(curve.generation?.origin, 'model')
    assert.match(curve.beats.find((beat) => beat.kind === 'trigger')?.detail ?? '', /投影仪今晚要归还.*沈乔.*决定要不要删掉自己的名字/u)
    assert.match(curve.beats.find((beat) => beat.kind === 'climax-choice')?.detail ?? '', /不能再按她答应不再改动作品的条件继续/u)
    assert.match(curve.beats.find((beat) => beat.kind === 'resolution')?.detail ?? '', /调整.*处理方式/u)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('model curves keep three creative directions causally distinct on the same author facts', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  const seed = createDirectCoCreationSeed(richCurveIdea)
  assert.ok(seed)

  const currentState = {
    kind: 'current-state',
    detail: richCurveIdea,
    sourceFactIds: ['source-fact-1', 'source-fact-2', 'source-fact-3', 'source-fact-4', 'source-fact-5'],
  }
  const contrastBeats = [
    currentState,
    { kind: 'trigger', detail: '暂定：投影仪今晚要归还让沈乔无法照原有安排决定要不要删掉自己的名字', sourceFactIds: ['source-fact-3', 'source-fact-5'] },
    { kind: 'escalation', detail: '暂定：继续在展出前决定要不要删掉自己的名字反而会触碰她答应不再改动作品的承诺', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
    { kind: 'climax-choice', detail: '暂定：沈乔必须在展出前决定要不要删掉自己的名字与她答应不再改动作品之间选择，不能再沿用旧办法', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
    { kind: 'resolution', detail: '暂定：这次选择调整在展出前决定要不要删掉自己的名字在她答应不再改动作品下的处理方式', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
  ]
  const costBeats = [
    currentState,
    { kind: 'trigger', detail: '暂定：投影仪今晚要归还让沈乔决定要不要删掉自己的名字时必须承担时间取舍', sourceFactIds: ['source-fact-3', 'source-fact-5'] },
    { kind: 'escalation', detail: '暂定：继续在展出前决定要不要删掉自己的名字会承担她答应不再改动作品的代价', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
    { kind: 'climax-choice', detail: '暂定：沈乔必须在展出前决定要不要删掉自己的名字与她答应不再改动作品之间选择，并承担代价', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
    { kind: 'resolution', detail: '暂定：这次选择调整沈乔在展出前决定要不要删掉自己的名字的方式，并承担她答应不再改动作品的代价', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
  ]
  const relationshipBeats = [
    currentState,
    { kind: 'trigger', detail: '暂定：沈乔在借来的投影仪里看到和前队友剪的短片，使她在展出前决定要不要删掉自己的名字不能只按个人安排推进', sourceFactIds: ['source-fact-2', 'source-fact-5'] },
    { kind: 'escalation', detail: '暂定：继续在展出前决定要不要删掉自己的名字会触碰她答应不再改动作品的承诺，前队友关系的分歧因此更明显', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
    { kind: 'climax-choice', detail: '暂定：沈乔必须在展出前决定要不要删掉自己的名字与她答应不再改动作品之间选择，并回应与前队友的关系', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
    { kind: 'resolution', detail: '暂定：这次选择调整沈乔在展出前决定要不要删掉自己的名字的方式，并回应和前队友剪的短片', sourceFactIds: ['source-fact-2', 'source-fact-5'] },
  ]
  const responses = [contrastBeats, costBeats, relationshipBeats]

  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'test-only-key'
  process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
  try {
    globalThis.fetch = async () => createCurveModelResponse({
      title: '同一事实的不同因果方向',
      beats: responses.shift(),
    })

    const curves = [
      await generateProvisionalCurve(richCurveIdea, seed, { tones: ['growth'], dramaticForces: ['contrast'], allowSystemNamedCharacters: false }),
      await generateProvisionalCurve(richCurveIdea, seed, { tones: ['growth'], dramaticForces: ['cost'], allowSystemNamedCharacters: false }),
      await generateProvisionalCurve(richCurveIdea, seed, { tones: ['friendship'], dramaticForces: ['relationship-tension'], allowSystemNamedCharacters: false }),
    ]

    assert.equal(curves.every((curve) => curve.generation?.origin === 'model'), true)
    const proposalDetails = curves.map((curve) => curve.beats
      .filter((beat) => beat.kind !== 'current-state')
      .map((beat) => beat.detail))
    for (let index = 0; index < proposalDetails.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < proposalDetails.length; otherIndex += 1) {
        const distinctCount = proposalDetails[index]!
          .filter((detail, beatIndex) => detail !== proposalDetails[otherIndex]![beatIndex]).length
        assert.ok(distinctCount >= 3, 'each selected direction must change at least three causal proposals')
      }
    }
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('closed curve plans preserve model provenance and reject malformed plans without fallback', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  const idea = richCurveIdea
  const seed = createDirectCoCreationSeed(idea)
  assert.ok(seed)
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  let calls = 0
  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'test-only-key'
  process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
  try {
    globalThis.fetch = async () => {
      calls += 1
      return createCurveModelResponse({
        curvePlan: {
          triggerFactId: 'source-fact-3',
          escalationFactId: 'source-fact-4',
          choiceFactId: 'source-fact-5',
          resolutionMode: 'adjust-goal-under-constraint',
        },
      })
    }
    const curve = await generateProvisionalCurve(idea, seed, brief)
    assert.equal(curve.generation?.origin, 'model')
    assert.equal(calls, 1)
    const proposalDetails = curve.beats.filter((beat) => beat.kind !== 'current-state').map((beat) => beat.detail)
    assert.equal(proposalDetails.some((detail) => /在在|让想|让在|使想|使在|因为沈乔因为|手机|门票|陌生人物/u.test(detail)), false)
    assert.equal(proposalDetails.some((detail) => /投影仪今晚要归还/u.test(detail)), true)
    assert.equal(proposalDetails.some((detail) => /答应不再改动作品/u.test(detail)), true)
    assert.equal(proposalDetails.some((detail) => /判断投影仪|判断答应|处理方式/u.test(detail)), false)
    assert.equal(proposalDetails.filter((detail) => (detail.match(/删掉自己的名字/gu) ?? []).length > 1).length, 0)
    assert.equal(new Set(curve.beats.filter((beat) => beat.kind !== 'current-state').map((beat) => beat.detail)).size, 4)

    calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return createCurveModelResponse({
        curvePlan: {
          triggerFactId: 'source-fact-3',
          escalationFactId: 'source-fact-3',
          choiceFactId: 'source-fact-5',
          resolutionMode: 'adjust-goal-under-constraint',
        },
      })
    }
    await assert.rejects(
      () => generateProvisionalCurve(idea, seed, brief),
      (error: unknown) => error instanceof AppError
        && error.code === 'STORY_CURVE_MODEL_GENERATION_FAILED'
        && error.modelDiagnostic?.stage === 'curve-plan-validation'
        && error.modelDiagnostic?.attempt === 3
        && /同一条作者事实|不同压力/u.test(error.modelDiagnostic?.reason ?? ''),
    )
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('renders closed curve plans as distinct short causal phrases across rich fact shapes', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  const cases = [
    {
      idea: '林澈答应在周五前把祖母的手稿交给出版社，但他发现最后一页缺失，不知道是否该按承诺提交。',
      brief: { tones: ['growth'], dramaticForces: ['cost'], allowSystemNamedCharacters: false } as CreativeBrief,
      plan: { triggerFactId: 'source-fact-2', escalationFactId: 'source-fact-3', choiceFactId: 'source-fact-1', resolutionMode: 'adjust-goal-under-constraint' },
      required: [/最后一页缺失/u, /按承诺提交/u],
    },
    {
      idea: relationshipCurveIdea,
      brief: { tones: ['friendship'], dramaticForces: ['relationship-tension'], allowSystemNamedCharacters: false } as CreativeBrief,
      plan: { triggerFactId: 'source-fact-2', escalationFactId: 'source-fact-3', choiceFactId: 'source-fact-1', resolutionMode: 'address-pressure-before-goal' },
      required: [/答应过不再替姐姐做决定/u, /姐姐准备把店卖掉/u],
    },
  ]

  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'test-only-key'
  process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
  try {
    for (const testCase of cases) {
      globalThis.fetch = async () => createCurveModelResponse({ curvePlan: testCase.plan })
      const seed = createDirectCoCreationSeed(testCase.idea)
      assert.ok(seed)
      const curve = await generateProvisionalCurve(testCase.idea, seed, testCase.brief)
      assert.equal(curve.generation?.origin, 'model')
      const details = curve.beats.filter((beat) => beat.kind !== 'current-state').map((beat) => beat.detail)
      for (const phrase of testCase.required) assert.equal(details.some((detail) => phrase.test(detail)), true, phrase.source)
      assert.equal(details.some((detail) => /在在|让想|让在|使想|使在|因为(?:林澈|周岚)因为|判断(?:最后一页|答应|姐姐)|目标在.*目标/u.test(detail)), false)
      assert.equal(new Set(details).size, details.length)
      assert.equal(details.every((detail) => (detail.match(/(?:删掉自己的名字|按承诺提交|保住父亲留下的书店)/gu) ?? []).length <= 1), true)
    }
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('rejects a model source-fact claim when the proposal has no visible author anchor', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  const seed = createDirectCoCreationSeed(richCurveIdea)
  assert.ok(seed)
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const beats = [
    { kind: 'current-state', detail: richCurveIdea, sourceFactIds: ['source-fact-1', 'source-fact-2', 'source-fact-3', 'source-fact-4', 'source-fact-5'] },
    // source-fact-5 is the decision about the author's name. It is not
    // present in this generic trigger, so the traceability claim must fail.
    { kind: 'trigger', detail: '暂定：投影仪今晚要归还让原有安排无法推进', sourceFactIds: ['source-fact-3', 'source-fact-5'] },
    { kind: 'escalation', detail: '暂定：继续删掉自己的名字反而会触碰不再改动作品的承诺', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
    { kind: 'climax-choice', detail: '暂定：沈乔必须在保留旧办法的自己的名字与不再改动作品之间选择', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
    { kind: 'resolution', detail: '暂定：这次选择改变她对前队友剪的短片、自己的名字与旧办法的理解', sourceFactIds: ['source-fact-2', 'source-fact-5'] },
  ]
  let calls = 0

  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'test-only-key'
  process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
  try {
    globalThis.fetch = async () => {
      calls += 1
      return createCurveModelResponse({ title: '署名决定', beats })
    }

    await assert.rejects(
      () => generateProvisionalCurve(richCurveIdea, seed, brief),
      (error: unknown) => error instanceof AppError
        && error.code === 'STORY_CURVE_MODEL_GENERATION_FAILED'
        && /sourceFactIds.*原文锚点/u.test(error.message),
    )
    assert.equal(calls, 3, 'a bad traceability claim receives only the bounded repair attempts')
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('rejects curve semantics that add value, authority or relationship conclusions to valid fact anchors', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  const cases = [
    {
      idea: '林澈答应在周五前把祖母的手稿交给出版社，但他发现最后一页缺失，不知道是否该按承诺提交。',
      brief: { tones: ['growth'], dramaticForces: ['cost'], allowSystemNamedCharacters: false } as CreativeBrief,
      beats: [
        { kind: 'current-state', detail: '林澈答应在周五前把祖母的手稿交给出版社，但他发现最后一页缺失，不知道是否该按承诺提交。', sourceFactIds: ['source-fact-1', 'source-fact-2', 'source-fact-3'] },
        { kind: 'trigger', detail: '暂定：周五前把祖母的手稿交给出版社让提交目标停住', sourceFactIds: ['source-fact-1'] },
        { kind: 'escalation', detail: '暂定：继续按承诺提交会承担最后一页缺失带来的完整性代价', sourceFactIds: ['source-fact-2'] },
        { kind: 'climax-choice', detail: '暂定：林澈必须在按承诺提交与暂缓之间选择', sourceFactIds: ['source-fact-3'] },
        { kind: 'resolution', detail: '暂定：这次选择改变他是否按承诺提交的判断', sourceFactIds: ['source-fact-3'] },
      ],
      expected: /价值、意义或归属/u,
    },
    {
      idea: relationshipCurveIdea,
      brief: { tones: ['friendship'], dramaticForces: ['relationship-tension'], allowSystemNamedCharacters: false } as CreativeBrief,
      beats: [
        { kind: 'current-state', detail: relationshipCurveIdea, sourceFactIds: ['source-fact-1', 'source-fact-2', 'source-fact-3'] },
        { kind: 'trigger', detail: '暂定：答应过不再替姐姐做决定使周岚无法照原计划和姐姐一起保住父亲留下的书店', sourceFactIds: ['source-fact-2'] },
        { kind: 'escalation', detail: '暂定：姐姐准备把店卖掉让共同责任成为取舍', sourceFactIds: ['source-fact-3'] },
        { kind: 'climax-choice', detail: '暂定：周岚必须在和姐姐一起保住父亲留下的书店与不再替姐姐做决定之间选择', sourceFactIds: ['source-fact-1', 'source-fact-2'] },
        { kind: 'resolution', detail: '暂定：这次选择改变她对信任边界的理解', sourceFactIds: ['source-fact-2'] },
      ],
      expected: /关系、承诺或责任/u,
    },
    {
      idea: richCurveIdea,
      brief: { tones: ['growth'], dramaticForces: ['cost'], allowSystemNamedCharacters: false } as CreativeBrief,
      beats: [
        { kind: 'current-state', detail: richCurveIdea, sourceFactIds: ['source-fact-1', 'source-fact-2', 'source-fact-3', 'source-fact-4', 'source-fact-5'] },
        { kind: 'trigger', detail: '暂定：投影仪今晚要归还让沈乔无法按原计划决定是否删掉自己的名字', sourceFactIds: ['source-fact-3', 'source-fact-5'] },
        { kind: 'escalation', detail: '暂定：继续在展出前决定要不要删掉自己的名字会承担她答应不再改动作品的取舍', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
        { kind: 'climax-choice', detail: '暂定：沈乔必须在展出前决定要不要删掉自己的名字与她答应不再改动作品之间选择', sourceFactIds: ['source-fact-4', 'source-fact-5'] },
        { kind: 'resolution', detail: '暂定：这次选择改变她对署名权的理解', sourceFactIds: ['source-fact-5'] },
      ],
      expected: /权限或自主/u,
    },
  ]

  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'test-only-key'
  process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
  try {
    for (const testCase of cases) {
      let calls = 0
      globalThis.fetch = async () => {
        calls += 1
        return createCurveModelResponse({ title: '越界语义', beats: testCase.beats })
      }

      await assert.rejects(
        () => generateProvisionalCurve(testCase.idea, createDirectCoCreationSeed(testCase.idea)!, testCase.brief),
        (error: unknown) => error instanceof AppError
          && error.code === 'STORY_CURVE_MODEL_GENERATION_FAILED'
          && testCase.expected.test(error.message)
          && error.modelDiagnostic?.stage === 'curve-validation'
          && error.modelDiagnostic?.attempt === 3
          && typeof error.modelDiagnostic?.response === 'object'
          && !JSON.stringify(error.modelDiagnostic?.response).includes('完整性'),
      )
      assert.equal(calls, 3, 'semantic boundary failures receive only bounded repair attempts')
    }
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('allows a semantic phrase when the author explicitly wrote that phrase', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  const idea = '林澈答应在周五前把祖母的手稿交给出版社，但他发现最后一页缺失，并写明手稿完整性必须保留，不知道是否该按承诺提交。'
  const seed = createDirectCoCreationSeed(idea)
  assert.ok(seed)
  const design = createStoryDesignRecord(idea, seed)
  const factId = (phrase: string): string => design.sourceFacts.find((fact) => fact.text.includes(phrase))?.id ?? design.sourceFacts[0]!.id
  const beats = [
    { kind: 'current-state', detail: idea, sourceFactIds: design.sourceFacts.map((fact) => fact.id) },
    { kind: 'trigger', detail: '暂定：周五前把祖母的手稿交给出版社让提交目标停住', sourceFactIds: [factId('周五前把祖母的手稿交给出版社')] },
    { kind: 'escalation', detail: '暂定：继续按承诺提交会承担手稿完整性必须保留的取舍', sourceFactIds: [factId('手稿完整性必须保留')] },
    { kind: 'climax-choice', detail: '暂定：林澈必须在按承诺提交与保留手稿完整性之间选择', sourceFactIds: [factId('手稿完整性必须保留')] },
    { kind: 'resolution', detail: '暂定：这次选择改变他对手稿完整性的理解', sourceFactIds: [factId('手稿完整性必须保留')] },
  ]

  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'test-only-key'
  process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
  try {
    globalThis.fetch = async () => createCurveModelResponse({ title: '作者明确的完整性', beats })
    const curve = await generateProvisionalCurve(idea, seed, { tones: ['growth'], dramaticForces: ['cost'], allowSystemNamedCharacters: false })
    assert.equal(curve.generation?.origin, 'model')
    assert.match(curve.beats.map((beat) => beat.detail).join('\n'), /完整性/u)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('allows an author-established authorship right in a model curve', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  const idea = `${richCurveIdea} 沈乔明确说署名权必须由她自己决定。`
  const seed = createDirectCoCreationSeed(idea)
  assert.ok(seed)
  const design = createStoryDesignRecord(idea, seed)
  const factId = (phrase: string): string => design.sourceFacts.find((fact) => fact.text.includes(phrase))?.id ?? design.sourceFacts[0]!.id
  const beats = [
    { kind: 'current-state', detail: idea, sourceFactIds: design.sourceFacts.map((fact) => fact.id) },
    { kind: 'trigger', detail: '暂定：投影仪今晚要归还让沈乔无法按原计划决定是否删掉自己的名字', sourceFactIds: [factId('投影仪今晚要归还'), factId('在展出前决定要不要删掉自己的名字')] },
    { kind: 'escalation', detail: '暂定：继续在展出前决定要不要删掉自己的名字会承担她答应不再改动作品的取舍', sourceFactIds: [factId('她答应不再改动作品'), factId('在展出前决定要不要删掉自己的名字')] },
    { kind: 'climax-choice', detail: '暂定：沈乔必须在展出前决定要不要删掉自己的名字与她答应不再改动作品之间选择', sourceFactIds: [factId('她答应不再改动作品'), factId('在展出前决定要不要删掉自己的名字')] },
    { kind: 'resolution', detail: '暂定：这次选择调整在展出前决定要不要删掉自己的名字在署名权必须由她自己决定下的处理方式', sourceFactIds: [factId('在展出前决定要不要删掉自己的名字'), factId('署名权必须由她自己决定')] },
  ]

  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'test-only-key'
  process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
  try {
    globalThis.fetch = async () => createCurveModelResponse({ title: '作者明确署名权', beats })
    const curve = await generateProvisionalCurve(idea, seed, { tones: ['growth'], dramaticForces: ['cost'], allowSystemNamedCharacters: false })
    assert.equal(curve.generation?.origin, 'model')
    assert.match(curve.beats.find((beat) => beat.kind === 'resolution')?.detail ?? '', /署名权必须由她自己决定/u)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('co-creation start and node save are idempotent under duplicate requests', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  process.env.STORY_DISABLE_MODEL = 'true'
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const request = {
    idea: `重复点击验收-${Date.now()}：青柠去游乐园`,
    brief,
    operationId: `start-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  }

  try {
    const [first, second] = await Promise.all([
      startStoryCoCreation(request),
      startStoryCoCreation(request),
    ])
    assert.equal(first.storyId, second.storyId)
    assert.equal(first.revision, second.revision)
    const sequential = await startStoryCoCreation(request)
    assert.equal(sequential.storyId, first.storyId, 'a retry with the same operation id replays the result')
    await assert.rejects(
      () => startStoryCoCreation({ ...request, idea: `${request.idea}-changed` }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'STORY_OPERATION_CONFLICT',
    )
    const deliberate = await startStoryCoCreation({
      ...request,
      operationId: `${request.operationId}-deliberate`,
    })
    assert.notEqual(deliberate.storyId, first.storyId, 'a later deliberate start remains a new operation')

    const semanticStartRequest = {
      ...request,
      idea: `${request.idea}-semantic-concurrency`,
    }
    const [semanticFirst, semanticSecond] = await Promise.all([
      startStoryCoCreation({ ...semanticStartRequest, operationId: `${request.operationId}-semantic-a` }),
      startStoryCoCreation({ ...semanticStartRequest, operationId: `${request.operationId}-semantic-b` }),
    ])
    assert.equal(
      semanticFirst.storyId,
      semanticSecond.storyId,
      'same start mutation must deduplicate even when accidental clicks use different operation ids',
    )
    assert.equal(semanticFirst.revision, semanticSecond.revision)

    const beat = first.curve.beats.find((candidate) => candidate.kind === 'trigger')!
    const saveRequest = {
      storyId: first.storyId,
      revision: first.revision,
      curveId: first.curve.id,
      beatId: beat.id,
      detail: '暂定：青柠必须先说明自己为何要去游乐园。',
      operationId: `save-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }
    const [savedFirst, savedSecond] = await Promise.all([
      updateSessionCurveBeat(saveRequest),
      updateSessionCurveBeat(saveRequest),
    ])
    assert.equal(savedFirst.revision, savedSecond.revision)
    assert.equal(savedFirst.curve.id, savedSecond.curve.id)
    const savedRetry = await updateSessionCurveBeat(saveRequest)
    assert.equal(savedRetry.revision, savedFirst.revision, 'a save retry replays the same mutation')

    const semanticSaveRequest = {
      storyId: semanticFirst.storyId,
      revision: semanticFirst.revision,
      curveId: semanticFirst.curve.id,
      beatId: semanticFirst.curve.beats.find((candidate) => candidate.kind === 'trigger')!.id,
      operationId: `${saveRequest.operationId}-semantic-a`,
      detail: '暂定：青柠必须先说明自己为何要去游乐园，再决定是否继续。',
    }
    const [semanticSavedFirst, semanticSavedSecond] = await Promise.all([
      updateSessionCurveBeat(semanticSaveRequest),
      updateSessionCurveBeat({
        ...semanticSaveRequest,
        operationId: `${saveRequest.operationId}-semantic-b`,
      }),
    ])
    assert.equal(semanticSavedFirst.revision, semanticSavedSecond.revision)
    assert.equal(semanticSavedFirst.curve.id, semanticSavedSecond.curve.id)
    await assert.rejects(
      () => updateSessionCurveBeat({ ...saveRequest, detail: `${saveRequest.detail} changed` }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'STORY_OPERATION_CONFLICT',
    )
    const snapshot = getStorySessionSnapshot(first.storyId)
    assert.equal(snapshot.revision, semanticSavedFirst.revision)
  } finally {
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
  }
})

function createSparseSystemDraft(): StoryConflictCoreSystemDraft {
  return createBoundedSystemConflictCoreDraftFallback(sparseSeed)
}

function createCreativeSparseSystemDraft(): StoryConflictCoreSystemDraft {
  return {
    goal: reportSeed.lockedGoal,
    stake: '继续提交报告需要承担一项取舍',
    constraint: '当前会有一个主要阻碍',
    origin: 'model',
    directions: [
      {
        label: '末页便签',
        mechanismType: 'information-gap',
        premise: '暂定：报告末页夹着一张写着陌生名字的便签',
        tradeoff: '按原计划提交，还是先保住便签里的名字',
      },
      {
        label: '划掉的句子',
        mechanismType: 'meaning-commitment',
        premise: '暂定：报告里有一处被反复划掉的陌生句子',
        tradeoff: '保留原句提交，还是让这处空白留在报告里',
      },
      {
        label: '未署名附页',
        mechanismType: 'initiation-block',
        premise: '暂定：报告后面多出一页未署名的附页',
        tradeoff: '把附页留在报告里，还是先拿掉这页',
      },
    ],
  }
}

function formatDirectionForExpectation(direction: string): string {
  return direction.includes('「') ? direction : `「${direction}」`
}

test('uses a system draft for a goal-only idea but not for a detailed seed', () => {
  assert.equal(shouldAutoGenerateSystemConflictCoreDraft(sparseSeed), true)
  assert.equal(shouldAutoGenerateSystemConflictCoreDraft(seed), false)
})

test('author revisions and role actions use separate request contracts', () => {
  const authorRequest = parseStoryAuthorInstructionRequest({
    storyId: 'story-test',
    revision: 3,
    targetBeatId: 'beat-trigger',
    text: '先让这个转折回应前面的承诺。',
  })
  const actionRequest = parseStoryActionProposalRequest({
    storyId: 'story-test',
    revision: 3,
    turnId: 'turn-test',
    action: '角色先把手里的信息说清楚。',
  })

  assert.equal(authorRequest.targetBeatId, 'beat-trigger')
  assert.equal(authorRequest.text.includes('转折'), true)
  assert.equal(actionRequest.turnId, 'turn-test')
  assert.equal(actionRequest.action.includes('角色'), true)
  assert.equal('turnId' in authorRequest, false)
  assert.equal('targetBeatId' in actionRequest, false)
})

test('recognizes author-control language across Chinese and English action input', () => {
  assert.equal(looksLikeAuthorInstruction('把故事改成悬疑，并删掉当前的关系冲突。'), true)
  assert.equal(looksLikeAuthorInstruction('Change the story genre and remove the current relationship conflict.'), true)
  assert.equal(looksLikeAuthorInstruction('The character states the known facts before choosing a next step.'), false)
})

test('creates a provisional curve before any path facts exist', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  assert.equal(curve.status, 'draft')
  assert.equal(curve.beats.length, 7)
  assert.ok(curve.beats.every((beat) => beat.source === 'user-input' || beat.source === 'system-proposal'))
  assert.equal(curve.beats.some((beat) => beat.status === 'confirmed' && beat.source === 'system-proposal'), false)
})

test('rejects scene-level model content from a provisional curve', () => {
  assert.equal(
    isSystemCurveProposalSafe(
      'trigger',
      '暂定：一阵风掀飞门票，它飘向旋转木马围栏内，主角必须立刻钻进去捡回它。',
    ),
    false,
  )
  assert.equal(
    isSystemCurveProposalSafe(
      'trigger',
      '暂定：青柠想去游乐园玩时，一个意外让原计划停住。',
    ),
    true,
  )
  assert.equal(
    isSystemCurveProposalSafe(
      'trigger',
      '暂定：原有安排——投影仪今晚要归还——使目标停住。',
      ['投影仪今晚要归还'],
    ),
    true,
    'an inline dash around an author-confirmed condition is not a scene or dialogue',
  )
  assert.equal(
    isSystemCurveProposalSafe(
      'trigger',
      '暂定：投影仪今晚要归还使目标停住。',
      ['投影仪今晚要归还'],
    ),
    true,
    'an author-confirmed object may remain an abstract causal condition',
  )
  assert.equal(
    isSystemCurveProposalSafe(
      'trigger',
      '暂定：手机今晚要归还使目标停住。',
      ['投影仪今晚要归还'],
    ),
    false,
    'an unconfirmed object must remain blocked',
  )
  assert.equal(
    isSystemCurveProposalSafe(
      'trigger',
      '暂定：打开投影仪看到短片，随后目标停住。',
      ['投影仪今晚要归还', '在借来的投影仪里看到和前队友剪的短片'],
    ),
    false,
    'an author-confirmed object cannot authorize a newly invented action chain',
  )
  assert.equal(
    isSystemCurveProposalSafe(
      'trigger',
      '暂定：按承诺提交手稿的目标因最后一页缺失而停住。',
      ['答应在周五前把祖母的手稿交给出版社', '最后一页缺失'],
    ),
    true,
    'confirmed commitment wording may remain an abstract causal condition',
  )
  assert.equal(
    isSystemCurveProposalSafe(
      'climax-choice',
      '暂定：回应姐姐准备把店卖掉的决定，迫使周岚在保店与尊重姐姐之间选择。',
      ['姐姐准备把店卖掉', '周岚想和姐姐一起保住父亲留下的书店'],
    ),
    true,
    'confirmed relationship wording may remain an abstract choice condition',
  )
})

test('editing an early curve beat marks dependent proposals stale', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['cost'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const result = updateCurveBeat(curve, 'beat-trigger', '暂定：游乐园里出现一件让主角改变计划的反常小事。')
  assert.deepEqual(result.affectedBeatIds, ['beat-escalation', 'beat-midpoint-turn', 'beat-climax-choice', 'beat-resolution'])
  assert.equal(result.curve.beats.find((beat) => beat.id === 'beat-trigger')?.source, 'user-edit')
  assert.equal(result.curve.beats.find((beat) => beat.id === 'beat-resolution')?.status, 'stale')
})

test('editing a curve beat recalculates which source facts it still covers', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const sourceFactId = curve.design?.sourceFacts.find((fact) => fact.text === sparseSeed.lockedGoal)?.id
  assert.ok(sourceFactId)

  const edited = updateCurveBeat(curve, 'beat-trigger', '暂定：主角必须重新判断自己真正愿意承担的选择。').curve
  const trigger = edited.beats.find((beat) => beat.id === 'beat-trigger')
  assert.ok(trigger)
  assert.equal(trigger.sourceFactIds?.includes(sourceFactId), false)
  assert.equal(edited.design?.sourceFacts.find((fact) => fact.id === sourceFactId)?.coveredByBeatIds.includes('beat-trigger'), false)
})

test('similar fact prefixes do not silently count as coverage', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const idea = '她答应不再联系旧友。她答应不再改动作品。'
  const customSeed = {
    ...sparseSeed,
    subject: '她',
    activeSituation: idea,
    lockedGoal: '完成作品',
    lockedFacts: ['她答应不再联系旧友', '她答应不再改动作品'],
  }
  const curve = createProvisionalCurveFallback(idea, customSeed, brief)
  const edited = updateCurveBeat(curve, 'beat-trigger', '暂定：她需要重新决定下一步。').curve
  const secondFact = edited.design?.sourceFacts.find((fact) => fact.text === '她答应不再改动作品')
  assert.ok(secondFact)
  assert.equal(secondFact.coveredByBeatIds.includes('beat-trigger'), false)
})

test('explicit source fact links prevent a verbatim node from claiming every fact', () => {
  const seed = {
    ...sparseSeed,
    activeSituation: '她答应不再联系旧友。她答应不再改动作品。',
    lockedFacts: ['她答应不再联系旧友', '她答应不再改动作品'],
  }
  const design = createStoryDesignRecord(seed.activeSituation, seed)
  const currentState = {
    id: 'beat-current-state',
    kind: 'current-state' as const,
    title: '此刻想要什么',
    detail: seed.activeSituation,
    source: 'user-input' as const,
    status: 'confirmed' as const,
    dependsOn: [],
    sourceFactIds: [design.sourceFacts[0]!.id],
  }
  const covered = updateStoryDesignCoverage(design, [currentState])
  assert.deepEqual(
    covered.sourceFacts.filter((fact) => fact.coveredByBeatIds.length).map((fact) => fact.id),
    [design.sourceFacts[0]!.id],
  )
})

test('does not let regeneration replace the user-provided current state', async () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)

  await assert.rejects(
    regenerateCurveBeat(sparseIdea, sparseSeed, curve, 'beat-current-state'),
    /当前状态来自你的原始想法/u,
  )
})

test('a curve cannot be confirmed while dependent beats are stale', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['cost'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const edited = updateCurveBeat(curve, 'beat-trigger', '暂定：游乐园里出现一件让主角改变计划的反常小事。').curve
  assert.throws(() => confirmProvisionalCurve(edited), /处理被修改影响/u)
  const confirmed = confirmProvisionalCurve(curve).confirmedCurve
  const foundation = materializeConfirmedCurve(sparseSeed, confirmed)
  assert.equal(foundation.seed.systemDraft, undefined)
  assert.equal(foundation.predicament.facts.every((fact) => fact.source === 'confirmed-curve'), true)
})

test('design record coverage blocks confirmation when a whole section loses its live beats', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const design = curve.design!
  const rejected = curve.beats.map((beat) => (
    ['beat-current-state', 'beat-character-tension'].includes(beat.id)
      ? { ...beat, status: 'rejected' as const }
      : beat
  ))
  const missing = getMissingStoryDesignSections(design, rejected)
  assert.deepEqual(missing, ['冲突核心', '故事两端'])
})

test('materializes only current curve constraints as initial facts', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const confirmed = confirmProvisionalCurve(createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)).confirmedCurve
  const foundation = materializeConfirmedCurve(sparseSeed, confirmed)

  assert.ok(foundation.predicament.facts.length >= 2)
  assert.ok(foundation.predicament.facts.length <= 4)
  assert.equal(
    foundation.predicament.facts.some((fact) => (
      fact.originCurveBeatIds?.includes('beat-climax-choice')
      || fact.originCurveBeatIds?.includes('beat-resolution')
    )),
    false,
  )
  assert.equal(foundation.headTail.climax, confirmed.beats.find((beat) => beat.id === 'beat-climax-choice')?.detail)
  assert.equal(foundation.headTail.resolution, confirmed.beats.find((beat) => beat.id === 'beat-resolution')?.detail)
})

test('confirmed spine materialization keeps the frozen foundation as its source of truth', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const confirmed = confirmProvisionalCurve(createProvisionalCurveFallback(richCurveIdea, richCurveSeed, brief)).confirmedCurve
  const originalFoundation = confirmed.foundation!
  const tamperedBeats = confirmed.beats.map((beat) => (
    beat.kind === 'climax-choice'
      ? { ...beat, detail: '暂定：这是未经审阅的另一条高潮句子。' }
      : beat
  ))
  const beatSignatures = Object.fromEntries(tamperedBeats.map((beat) => [
    beat.id,
    [
      beat.kind,
      beat.detail.trim(),
      beat.causalAnchor?.trim() ?? '',
      [...(beat.sourceFactIds ?? [])].sort().join(','),
    ].join('|'),
  ]))
  const tampered = {
    ...confirmed,
    beats: tamperedBeats,
    foundation: { ...originalFoundation, beatSignatures },
  }

  const materialized = materializeConfirmedCurve(richCurveSeed, tampered)
  assert.equal(materialized.headTail.climax, originalFoundation.storyEnds.climax)
  assert.equal(materialized.predicament.obstacle, originalFoundation.predicament.obstacle)
  assert.equal(materialized.approach.intent, originalFoundation.approach.intent)
  assert.equal(materialized.predicament.facts.some((fact) => fact.statement.includes('未经审阅')), false)
})

test('rejects a confirmed-curve opening that invents access machinery', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const confirmed = confirmProvisionalCurve(createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)).confirmedCurve
  const foundation = materializeConfirmedCurve(sparseSeed, confirmed)
  const turn: StoryTurn = {
    id: 'turn-1',
    phase: 'opening',
    node: {
      id: 'node-1',
      title: '开始受阻',
      event: '青柠站在游乐园入口，手机弹出消息：VIP 通道卡因过去多次代排而失效。',
      purpose: '让最擅长的办法变成新的阻碍。',
      goalState: 'trying',
    },
    conflict: {
      nodeId: 'node-1',
      conflict: '她必须决定是否使用那张 VIP 通道卡。',
      action: '选择一个此刻的应对方式。',
      consequence: '这个选择会影响她如何面对代价。',
      intensity: 1,
      anchor: '起点',
    },
    question: '青柠现在怎么办？',
    options: [],
    narrativeAction: null,
    transition: null,
    canConclude: false,
    isConclusion: false,
  }

  assert.throws(
    () => validateConfirmedCurveStoryTurnContinuation({
      idea: sparseIdea,
      seed: foundation.seed,
      predicament: foundation.predicament,
      approach: foundation.approach,
      headTail: foundation.headTail,
      history: [],
      confirmedCurve: confirmed,
    }, turn),
    /手机/u,
  )
})

test('rejects an unconfirmed first-turn timestamp even when the curve is confirmed', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const confirmed = confirmProvisionalCurve(createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)).confirmedCurve
  const foundation = materializeConfirmedCurve(sparseSeed, confirmed)
  const turn: StoryTurn = {
    id: 'turn-1',
    phase: 'opening',
    node: {
      id: 'node-1',
      title: '停住的安排',
      event: '青柠明天会按原计划继续去游乐园，但当前阻碍还没有被确认。',
      purpose: '让主角先看清已确认的阻碍。',
      goalState: 'trying',
    },
    conflict: {
      nodeId: 'node-1',
      conflict: '原来的安排需要重新判断。',
      action: '选择一个此刻可以承担的方向。',
      consequence: '选择会留下需要继续面对的取舍。',
      intensity: 1,
      anchor: '起点',
    },
    question: '现在先怎么做？',
    options: [],
    narrativeAction: null,
    transition: null,
    canConclude: false,
    isConclusion: false,
  }

  assert.throws(
    () => validateConfirmedCurveStoryTurnContinuation({
      idea: sparseIdea,
      seed: foundation.seed,
      predicament: foundation.predicament,
      approach: foundation.approach,
      headTail: foundation.headTail,
      history: [],
      confirmedCurve: confirmed,
    }, turn),
    /明天/u,
  )
})

test('allows a confirmed deadline to be summarized as cutoff pressure without adding time', () => {
  const idea = '林澈答应在周五前把祖母的手稿交给出版社，但他发现最后一页缺失，不知道是否该按承诺提交。'
  const seed = createDirectCoCreationSeed(idea)
  assert.ok(seed)
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['cost'],
    allowSystemNamedCharacters: false,
  }
  const confirmed = confirmProvisionalCurve(createProvisionalCurveFallback(idea, seed, brief)).confirmedCurve
  const foundation = materializeConfirmedCurve(seed, confirmed)
  const turn = createConfirmedOpeningTurn('林澈答应在周五前把祖母的手稿交给出版社，但他发现最后一页缺失，不知道是否该按承诺提交。')
  turn.node.purpose = '在周五前把祖母的手稿交给出版社、最后一页缺失与按承诺提交之间的当前取舍。'
  turn.conflict = {
    ...turn.conflict,
    conflict: '最后一页缺失；是否按承诺提交。',
    action: '先判断最后一页缺失，还是按承诺提交。',
    consequence: '在周五前把祖母的手稿交给出版社仍待判断。',
  }
  turn.question = '当前先判断最后一页缺失，还是按承诺提交？'
  const createOption = (
    id: string,
    label: string,
    action: string,
    immediateConsequence: string,
    laterEffect: string,
  ): StoryTurn['options'][number] => {
    const narrativeAction: StoryAction = {
      id: `${id}-action`,
      intent: action,
      preconditions: [],
      effects: [],
      source: 'generated',
    }
    return {
      id,
      label,
      action,
      immediateConsequence,
      laterEffect,
      narrativeAction,
      transition: {
        actionId: narrativeAction.id,
        consumedFacts: [],
        changedFacts: [],
        introducedFacts: [],
      },
    }
  }
  turn.options = [
    createOption(
      'turn-1-option-1',
      '面对周五前',
      '先面对在周五前把祖母的手稿交给出版社。',
      '在周五前把祖母的手稿交给出版社作为当前优先。',
      '按承诺提交仍待判断。',
    ),
    createOption(
      'turn-1-option-2',
      '面对最后一页',
      '先面对但他发现最后一页缺失。',
      '最后一页缺失形成当前卡点。',
      '在周五前把祖母的手稿交给出版社仍待判断。',
    ),
    createOption(
      'turn-1-option-3',
      '判断承诺提交',
      '先判断林澈答应在周五前把祖母的手稿交给出版社，还是按承诺提交。',
      '按承诺提交成为当前判断。',
      '最后一页缺失仍待判断。',
    ),
  ]

  assert.doesNotThrow(() => validateConfirmedCurveStoryTurnContinuation({
    idea,
    seed: foundation.seed,
    predicament: foundation.predicament,
    approach: foundation.approach,
    headTail: foundation.headTail,
    history: [],
    confirmedCurve: confirmed,
  }, turn))
})

test('rejects introduced facts from a confirmed first-turn option', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const confirmed = confirmProvisionalCurve(createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)).confirmedCurve
  const foundation = materializeConfirmedCurve(sparseSeed, confirmed)
  const action: StoryAction = {
    id: 'turn-1-option-1-action',
    intent: '先面对青柠去游乐园。',
    preconditions: [],
    effects: [],
    source: 'generated',
  }
  const transition: StoryTransition = {
    actionId: action.id,
    consumedFacts: [],
    changedFacts: [],
    introducedFacts: [{
      id: 'fact-unconfirmed-opening',
      statement: '主角已经作出新的决定',
      source: 'confirmed-action',
      mutability: 'changeable',
    }],
  }
  const turn: StoryTurn = {
    id: 'turn-1',
    phase: 'opening',
    node: {
      id: 'node-1',
      title: '停住的安排',
      event: '青柠去游乐园。',
      purpose: '青柠去游乐园当前判断。',
      goalState: 'trying',
    },
    conflict: {
      nodeId: 'node-1',
      conflict: '青柠去游乐园仍待判断。',
      action: '先判断青柠去游乐园。',
      consequence: '青柠去游乐园仍待判断。',
      intensity: 1,
      anchor: '起点',
    },
    question: '青柠去游乐园是否当前判断？',
    options: [{
      id: 'turn-1-option-1',
      label: '面对游乐园',
      action: action.intent,
      immediateConsequence: '青柠去游乐园作为当前优先。',
      laterEffect: '青柠去游乐园仍待判断。',
      narrativeAction: action,
      transition,
    }],
    narrativeAction: null,
    transition: null,
    canConclude: false,
    isConclusion: false,
  }

  assert.throws(
    () => validateConfirmedCurveStoryTurnContinuation({
      idea: sparseIdea,
      seed: foundation.seed,
      predicament: foundation.predicament,
      approach: foundation.approach,
      headTail: foundation.headTail,
      history: [],
      confirmedCurve: confirmed,
    }, turn),
    /首回合不能把/u,
  )
})

test('asks for author detail for a bare premise in real model mode', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  process.env.STORY_DISABLE_MODEL = 'false'
  try {
    await assert.rejects(
      () => startStoryCoCreation({
        idea: '青柠去游乐园',
        brief: {
          tones: ['growth'],
          dramaticForces: ['contrast'],
          allowSystemNamedCharacters: false,
        },
        operationId: `clarification-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'STORY_IDEA_NEEDS_AUTHOR_DETAIL',
    )
  } finally {
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
  }
})

test('legacy directions also ask for author detail instead of inventing a sparse hook', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  process.env.STORY_DISABLE_MODEL = 'false'
  try {
    await assert.rejects(
      () => generateDirections({
        idea: '青柠去游乐园',
        expansionScope: 'keep-scale',
        generateSystemDraft: true,
      }),
      (error: unknown) => error instanceof AppError
        && error.code === 'STORY_IDEA_NEEDS_AUTHOR_DETAIL',
    )
  } finally {
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
  }
})

test('uses the compact confirmed-curve opening contract without inventing state facts', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  process.env.STORY_DISABLE_MODEL = 'true'
  try {
    const draft = await startStoryCoCreation({
      idea: richCurveIdea,
      brief: { tones: ['growth'], dramaticForces: ['contrast'], allowSystemNamedCharacters: false },
      operationId: `opening-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    const confirmed = await confirmSessionCurve({
      storyId: draft.storyId,
      revision: draft.revision,
      curveId: draft.curve.id,
    })

    let calls = 0
    const systemPrompts: string[] = []
    process.env.STORY_DISABLE_MODEL = 'false'
    process.env.DASHSCOPE_API_KEY = 'test-only-key'
    process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
    globalThis.fetch = async (_input, init) => {
      calls += 1
      const request = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> }
      systemPrompts.push(request.messages?.[0]?.content ?? '')
      return createOpeningPlanModelResponse()
    }

    const spine = await startSessionStorySpineFromCurve({
      storyId: confirmed.storyId,
      revision: confirmed.revision,
      curveId: confirmed.curve.id,
    })

    assert.equal(calls, 1, 'the confirmed opening should use the compact contract on its first model request')
    assert.match(systemPrompts[0] ?? '', /开场事实选择器/u)
    assert.match(systemPrompts[0] ?? '', /只能从数组中复制 anchorId/u)
    assert.doesNotMatch(systemPrompts[0] ?? '', /临时场景细节.+可以自然补写/u)
    assert.equal(spine.turn.options.length, 3)
    assert.equal(spine.turn.narrativeAction, null)
    assert.equal(spine.turn.transition, null)
    assert.equal(spine.turn.options.every((option) => option.narrativeAction.effects.length === 0), true)
    assert.equal(spine.turn.options.every((option) => option.transition.introducedFacts.length === 0), true)
    assert.equal(spine.history.length, 0)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('repairs a relationship opening after rejecting an unconfirmed other-person response when the author gives a present boundary', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  process.env.STORY_DISABLE_MODEL = 'true'
  try {
    const draft = await startStoryCoCreation({
      idea: relationshipBoundaryCurveIdea,
      brief: { tones: ['friendship'], dramaticForces: ['relationship-tension'], allowSystemNamedCharacters: false },
      operationId: `opening-relationship-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    const confirmed = await confirmSessionCurve({
      storyId: draft.storyId,
      revision: draft.revision,
      curveId: draft.curve.id,
    })

    let calls = 0
    const userPrompts: string[] = []
    process.env.STORY_DISABLE_MODEL = 'false'
    process.env.DASHSCOPE_API_KEY = 'test-only-key'
    process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
    globalThis.fetch = async (_input, init) => {
      calls += 1
      const request = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> }
      userPrompts.push(request.messages?.[1]?.content ?? '')
      return calls === 1
        ? createRelationshipOpeningModelResponse(true, true)
        : createOpeningPlanModelResponse()
    }

    const spine = await startSessionStorySpineFromCurve({
      storyId: confirmed.storyId,
      revision: confirmed.revision,
      curveId: confirmed.curve.id,
    })

    assert.equal(calls, 2, 'the first response predicts the sister response and must be repaired')
    assert.match(userPrompts[0] ?? '', /作者事实锚点（唯一允许的具体来源）/u)
    assert.match(userPrompts[0] ?? '', /不要生成任何故事句子/u)
    assert.match(userPrompts[1] ?? '', /只重新选择三个不同的 anchorId/u)
    assert.doesNotMatch(userPrompts[1] ?? '', /姐姐可能暂停|出售动作/u)
    assert.equal(spine.turn.options.length, 3)
    assert.equal(spine.turn.options.every((option) => option.transition.introducedFacts.length === 0), true)
    assert.equal(spine.turn.options.some((option) => /可能暂停|出售动作/u.test(option.immediateConsequence)), false)
    assert.equal(spine.turn.options.every((option) => /姐姐准备把店卖掉|卖店合同将在周五前签署|答应过不再替姐姐做决定|和姐姐一起保住父亲留下的书店/u.test(
      `${option.action}${option.immediateConsequence}${option.laterEffect}`,
    )), true)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('asks the author for a present boundary when a relationship-only opening exhausts repairs', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  process.env.STORY_DISABLE_MODEL = 'true'
  try {
    const draft = await startStoryCoCreation({
      idea: relationshipCurveIdea,
      brief: { tones: ['friendship'], dramaticForces: ['relationship-tension'], allowSystemNamedCharacters: false },
      operationId: `opening-relationship-detail-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    const confirmed = await confirmSessionCurve({
      storyId: draft.storyId,
      revision: draft.revision,
      curveId: draft.curve.id,
    })
    const before = getStorySessionSnapshot(confirmed.storyId)

    let calls = 0
    process.env.STORY_DISABLE_MODEL = 'false'
    process.env.DASHSCOPE_API_KEY = 'test-only-key'
    process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
    globalThis.fetch = async () => {
      calls += 1
      return createRelationshipOpeningModelResponse(true)
    }

    await assert.rejects(
      () => startSessionStorySpineFromCurve({
        storyId: confirmed.storyId,
        revision: confirmed.revision,
        curveId: confirmed.curve.id,
      }),
      (error: unknown) => error instanceof AppError
        && error.code === 'STORY_TURN_NEEDS_AUTHOR_DETAIL'
        && error.statusCode === 422
        && error.modelDiagnostic?.attempt === 3
        && /不替周岚假定他人如何回应/u.test(error.message),
    )

    assert.equal(calls, 3, 'the model gets bounded repair attempts before author detail is requested')
    const after = getStorySessionSnapshot(confirmed.storyId)
    assert.equal(after.revision, before.revision)
    assert.equal(after.currentTurn, undefined)
    assert.equal(after.history.length, 0)
    assert.equal(after.predicament, undefined)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('does not persist a confirmed-curve opening after bounded model failure', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  process.env.STORY_DISABLE_MODEL = 'true'
  try {
    const draft = await startStoryCoCreation({
      idea: `${richCurveIdea}（失败边界）`,
      brief: { tones: ['growth'], dramaticForces: ['contrast'], allowSystemNamedCharacters: false },
      operationId: `opening-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    const confirmed = await confirmSessionCurve({
      storyId: draft.storyId,
      revision: draft.revision,
      curveId: draft.curve.id,
    })
    const before = getStorySessionSnapshot(confirmed.storyId)

    let calls = 0
    process.env.STORY_DISABLE_MODEL = 'false'
    process.env.DASHSCOPE_API_KEY = 'test-only-key'
    process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
    globalThis.fetch = async () => {
      calls += 1
      return createCompactOpeningModelResponse('沈乔拿出一部尚未确认的手机，等待一个未发生的回复。')
    }

    await assert.rejects(
      () => startSessionStorySpineFromCurve({
        storyId: confirmed.storyId,
        revision: confirmed.revision,
        curveId: confirmed.curve.id,
      }),
      (error: unknown) => error instanceof AppError
        && error.code === 'STORY_TURN_RETRY_EXHAUSTED'
        && error.modelDiagnostic?.attempt === 3
        && error.modelDiagnostic?.stage === 'story-turn-validation'
        && /主线和已确认事实没有改变/u.test(error.message),
    )

    assert.equal(calls, 3, 'a model validation failure must use bounded retries')
    const after = getStorySessionSnapshot(confirmed.storyId)
    assert.equal(after.revision, before.revision)
    assert.equal(after.currentTurn, undefined)
    assert.equal(after.history.length, 0)
    assert.equal(after.predicament, undefined)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('rejects a confirmed opening that turns a known object into an executed outcome', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  process.env.STORY_DISABLE_MODEL = 'true'
  try {
    const draft = await startStoryCoCreation({
      idea: `${richCurveIdea}（执行结果边界）`,
      brief: { tones: ['growth'], dramaticForces: ['contrast'], allowSystemNamedCharacters: false },
      operationId: `opening-executed-outcome-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    const confirmed = await confirmSessionCurve({
      storyId: draft.storyId,
      revision: draft.revision,
      curveId: draft.curve.id,
    })
    const before = getStorySessionSnapshot(confirmed.storyId)

    let calls = 0
    process.env.STORY_DISABLE_MODEL = 'false'
    process.env.DASHSCOPE_API_KEY = 'test-only-key'
    process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
    globalThis.fetch = async () => {
      calls += 1
      return createCompactOpeningModelResponse(
        '投影仪今晚要归还，沈乔答应不再改动作品，却想在展出前决定要不要删掉自己的名字。',
        '先面对投影仪今晚要归还，再把投影仪打包归还。',
      )
    }

    await assert.rejects(
      () => startSessionStorySpineFromCurve({
        storyId: confirmed.storyId,
        revision: confirmed.revision,
        curveId: confirmed.curve.id,
      }),
      (error: unknown) => error instanceof AppError
        && error.code === 'STORY_TURN_RETRY_EXHAUSTED'
        && error.modelDiagnostic?.attempt === 3
        && /打包归还|执行动作/u.test(error.modelDiagnostic?.reason ?? ''),
    )

    assert.equal(calls, 3)
    const after = getStorySessionSnapshot(confirmed.storyId)
    assert.equal(after.revision, before.revision)
    assert.equal(after.currentTurn, undefined)
    assert.equal(after.history.length, 0)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('rejects unconfirmed process wording in a deadline opening instead of turning it into a fact', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  const idea = '林澈答应在周五前把祖母的手稿交给出版社，但他发现最后一页缺失，不知道是否该按承诺提交。'
  process.env.STORY_DISABLE_MODEL = 'true'
  try {
    const draft = await startStoryCoCreation({
      idea,
      brief: { tones: ['growth'], dramaticForces: ['cost'], allowSystemNamedCharacters: false },
      operationId: `opening-deadline-process-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    const confirmed = await confirmSessionCurve({
      storyId: draft.storyId,
      revision: draft.revision,
      curveId: draft.curve.id,
    })
    const before = getStorySessionSnapshot(confirmed.storyId)

    let calls = 0
    process.env.STORY_DISABLE_MODEL = 'false'
    process.env.DASHSCOPE_API_KEY = 'test-only-key'
    process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
    globalThis.fetch = async () => {
      calls += 1
      return createDeadlineOpeningModelResponse('先判断原计划、流程还是替代方案。')
    }

    await assert.rejects(
      () => startSessionStorySpineFromCurve({
        storyId: confirmed.storyId,
        revision: confirmed.revision,
        curveId: confirmed.curve.id,
      }),
      (error: unknown) => error instanceof AppError
        && error.code === 'STORY_TURN_RETRY_EXHAUSTED'
        && error.modelDiagnostic?.attempt === 3
        && /原计划|流程|替代方案/u.test(error.modelDiagnostic?.reason ?? ''),
    )

    assert.equal(calls, 3)
    const after = getStorySessionSnapshot(confirmed.storyId)
    assert.equal(after.revision, before.revision)
    assert.equal(after.currentTurn, undefined)
    assert.equal(after.history.length, 0)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('rejects a confirmed-curve opening that repeats proposal text or opaque option labels', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  process.env.STORY_DISABLE_MODEL = 'true'
  try {
    const draft = await startStoryCoCreation({
      idea: `${richCurveIdea}（递归提案边界）`,
      brief: { tones: ['growth'], dramaticForces: ['contrast'], allowSystemNamedCharacters: false },
      operationId: `opening-recursion-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    const confirmed = await confirmSessionCurve({
      storyId: draft.storyId,
      revision: draft.revision,
      curveId: draft.curve.id,
    })
    const before = getStorySessionSnapshot(confirmed.storyId)

    let calls = 0
    process.env.STORY_DISABLE_MODEL = 'false'
    process.env.DASHSCOPE_API_KEY = 'test-only-key'
    process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
    globalThis.fetch = async () => {
      calls += 1
      return createCurveModelResponse({
        node: {
          title: '确认后的卡点',
          event: '沈乔面对“暂定：投影仪今晚要归还使目标停住”，需要先回应前项。',
          purpose: '把已确认节点直接展示给作者。',
        },
        conflict: {
          conflict: '暂定：继续目标会承担取舍。',
          action: '先回应前项，还是先看另一端。',
          consequence: '当前边界仍未改变。',
        },
        question: '现在先回应哪一端？',
        options: [
          {
            label: '先回应前项',
            action: '先回应前项。',
            immediateConsequence: '前项成为当前判断。',
            laterEffect: '下一步再看另一端。',
          },
          {
            label: '先保留目标',
            action: '先保留目标。',
            immediateConsequence: '目标暂不改变。',
            laterEffect: '之后处理前项。',
          },
          {
            label: '先看另一端',
            action: '先看另一端。',
            immediateConsequence: '另一端被保留。',
            laterEffect: '之后处理前项。',
          },
        ],
      })
    }

    await assert.rejects(
      () => startSessionStorySpineFromCurve({
        storyId: confirmed.storyId,
        revision: confirmed.revision,
        curveId: confirmed.curve.id,
      }),
      (error: unknown) => error instanceof AppError
        && error.code === 'STORY_TURN_RETRY_EXHAUSTED'
        && error.modelDiagnostic?.attempt === 3
        && error.modelDiagnostic?.stage === 'story-turn-validation'
        && /暂定|占位|前项|另一端/u.test(error.modelDiagnostic?.reason ?? ''),
    )

    assert.equal(calls, 3)
    const after = getStorySessionSnapshot(confirmed.storyId)
    assert.equal(after.revision, before.revision)
    assert.equal(after.currentTurn, undefined)
    assert.equal(after.history.length, 0)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('uses an author-edited current state as the confirmed story goal', () => {
  const brief: CreativeBrief = {
    tones: ['friendship'],
    dramaticForces: ['relationship-tension'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const authorGoal = '青柠想先陪朋友看完演出，再决定要不要去游乐园。'
  const edited = updateCurveBeat(curve, 'beat-current-state', authorGoal).curve
  const reconciled = {
    ...edited,
    beats: edited.beats.map((beat) => (
      beat.status === 'stale' ? { ...beat, status: 'proposed' as const } : beat
    )),
  }
  const confirmed = confirmProvisionalCurve(reconciled).confirmedCurve
  const foundation = materializeConfirmedCurve(sparseSeed, confirmed)

  assert.equal(foundation.seed.activeSituation, authorGoal)
  assert.equal(foundation.seed.lockedGoal, authorGoal)
  assert.equal(foundation.predicament.preservedGoal, authorGoal)
  assert.ok(foundation.predicament.facts.some((fact) => fact.originCurveBeatIds?.includes('beat-current-state')))
})

test('keeps every rich source fact visible in the fact-preserving curve fallback', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['relationship-tension'],
    allowSystemNamedCharacters: false,
  }
  const richIdea = '毕业展布置前，沈乔在借来的投影仪里看到和前队友剪的短片。投影仪今晚要归还，她答应不再改动作品，却想在展出前决定要不要删掉自己的名字。'
  const richSeed = {
    ...sparseSeed,
    subject: '沈乔',
    activeSituation: richIdea,
    lockedGoal: '在展出前决定要不要删掉自己的名字',
    lockedFacts: ['毕业展布置前', '借来的投影仪', '投影仪今晚要归还', '答应不再改动作品'],
  }
  const curve = createProvisionalCurveFallback(richIdea, richSeed, brief)

  assert.equal(curve.generation?.origin, 'fact-preserving-fallback')
  assert.ok(curve.design)
  assert.equal(curve.design?.sourceFacts.every((fact) => fact.coveredByBeatIds.length > 0), true)
  const ledgerText = curve.design?.sourceFacts.map((fact) => fact.text).join('|') ?? ''
  assert.match(ledgerText, /毕业展布置前/u)
  assert.match(ledgerText, /投影仪今晚要归还/u)
  assert.match(ledgerText, /她答应不再改动作品/u)
  assert.match(JSON.stringify(curve.beats), /投影仪今晚要归还/u)
  assert.match(JSON.stringify(curve.beats), /不再改动作品/u)
  assert.equal(curve.beats.filter((beat) => beat.detail.includes(richIdea)).length, 0)
  const beatDetails = curve.beats.map((beat) => beat.detail).join('\n')
  assert.match(beatDetails, /投影仪今晚要归还/u)
  assert.match(beatDetails, /不再改动作品/u)
  assert.match(beatDetails, /删掉自己的名字/u)
  assert.equal(new Set(curve.design?.sourceFacts.map((fact) => fact.text)).size, curve.design?.sourceFacts.length)
  assert.equal(curve.beats.filter((beat) => beat.detail.includes('毕业展布置前，沈乔在借来的投影仪')).length, 0)
})

test('deduplicates equivalent decision wording without dropping the original clause', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const richIdea = '毕业展布置前，沈乔在借来的投影仪里看到和前队友剪的短片。投影仪今晚要归还，她答应不再改动作品，却想在展出前决定要不要删掉自己的名字。'
  const richSeed = {
    ...sparseSeed,
    subject: '沈乔',
    activeSituation: richIdea,
    lockedGoal: '是否删掉自己的名字',
    lockedFacts: ['毕业展布置前', '投影仪今晚要归还', '她答应不再改动作品', '展出前决定要不要删掉自己的名字'],
  }
  const curve = createProvisionalCurveFallback(richIdea, richSeed, brief)
  const facts = curve.design?.sourceFacts.map((fact) => fact.text) ?? []
  assert.equal(facts.filter((fact) => /删掉自己的名字/u.test(fact)).length, 1)
  assert.equal(curve.beats.filter((beat) => /删掉自己的名字/u.test(beat.detail)).length >= 1, true)
  assert.equal(curve.beats.some((beat) => /删掉自己的名字的安排|会决定删掉自己的名字是否/u.test(beat.detail)), false)
  const foundation = curve.foundation!
  assert.notEqual(foundation.predicament.plausibleCost, foundation.predicament.tradeoff)
  assert.match(foundation.predicament.plausibleCost, /(?:改变|改用|局限|代价|保留|放弃|留下|无法)/u)
  assert.notEqual(foundation.storyEnds.resolution, foundation.storyEnds.climax)
})

test('freezes one concrete design foundation before confirmation', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['relationship-tension'],
    allowSystemNamedCharacters: false,
  }
  const richIdea = '毕业展布置前，沈乔在借来的投影仪里看到和前队友剪的短片。投影仪今晚要归还，她答应不再改动作品，却想在展出前决定要不要删掉自己的名字。'
  const richSeed = {
    ...sparseSeed,
    subject: '沈乔',
    activeSituation: richIdea,
    lockedGoal: '在展出前决定要不要删掉自己的名字',
    lockedFacts: ['毕业展布置前', '投影仪今晚要归还', '她答应不再改动作品'],
  }
  const curve = createProvisionalCurveFallback(richIdea, richSeed, brief)
  assert.ok(curve.foundation)
  assert.notEqual(curve.foundation?.predicament.urgency, '沈乔发现')
  assert.notEqual(curve.foundation?.middleDevelopment.midpoint, '沈乔发现')
  assert.ok(curve.foundation?.sourceFactIds?.middleDevelopment.length)
  const confirmed = confirmProvisionalCurve(curve).confirmedCurve
  const tampered = {
    ...confirmed,
    beats: confirmed.beats.map((beat) => beat.id === 'beat-trigger' ? { ...beat, detail: `${beat.detail} 作者另改` } : beat),
  }
  assert.throws(() => materializeConfirmedCurve(richSeed, tampered), /基础与节点不一致/u)
})

test('the draft foundation keeps conflict, choice, cost, and progression distinct', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['cost'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(richCurveIdea, richCurveSeed, brief)
  const foundation = curve.foundation!

  assert.notEqual(foundation.conflictCore.tradeoff, foundation.predicament.choice)
  assert.notEqual(foundation.predicament.tradeoff, foundation.predicament.choice)
  assert.notEqual(foundation.middleDevelopment.climaxPressure, foundation.predicament.tradeoff)
  assert.match(foundation.predicament.choice, /投影仪|删掉自己的名字|不再改动作品/u)
  assert.match(foundation.predicament.plausibleCost, /无法同时|保留|放弃/u)
  assert.match(foundation.conflictCore.obstacle, /打断|取舍|局限/u)
  assert.ok(foundation.sourceFactIds?.conflictCore.length)
  assert.ok(foundation.sourceFactIds?.predicament.length)
  assert.ok(foundation.sourceFactIds?.middleDevelopment.length)
  assert.ok(foundation.sourceFactIds?.storyEnds.length)
})

test('rejecting a system proposal excludes it and makes only its dependents stale', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const result = rejectCurveBeat(curve, 'beat-trigger', '不想要这个钩子。')

  assert.equal(result.curve.beats.find((beat) => beat.id === 'beat-trigger')?.status, 'rejected')
  assert.equal(result.curve.beats.find((beat) => beat.id === 'beat-escalation')?.status, 'stale')
  assert.equal(result.curve.instructions.at(-1)?.kind, 'remove')
  assert.throws(() => confirmProvisionalCurve(result.curve), /处理被修改影响/u)
})

test('parked source material is explicit and does not become a confirmed-curve fact', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const fact = curve.design?.sourceFacts.find((candidate) => candidate.text === sparseSeed.lockedGoal)
  assert.ok(fact)

  const parked = updateCurveSourceFactDisposition(curve, fact.id, 'parked').curve
  assert.equal(parked.design?.sourceFacts.find((candidate) => candidate.id === fact.id)?.disposition, 'parked')

  // The author still has to review affected nodes; once their explicit source
  // links no longer reference the parked fact, the version can be confirmed.
  const reviewed = {
    ...parked,
    beats: parked.beats.map((beat) => beat.status === 'stale' ? { ...beat, status: 'proposed' as const } : beat),
  }
  assert.doesNotThrow(
    () => confirmProvisionalCurve(reviewed),
    /暂不纳入的原始材料仍出现在/u,
  )
  // Use the same mutation path as the UI so the frozen design foundation is
  // rebuilt for the author's new current-state wording. Directly replacing a
  // beat would intentionally invalidate the old foundation.
  const fullyEdited = updateCurveBeat(
    parked,
    'beat-current-state',
    '作者编辑：当前状态不再依赖已暂存的目标。',
  ).curve
  const fullyReviewed = {
    ...fullyEdited,
    beats: fullyEdited.beats.map((beat) => beat.status === 'stale' ? { ...beat, status: 'proposed' as const } : beat),
  }
  const confirmed = confirmProvisionalCurve(fullyReviewed).confirmedCurve
  const foundation = materializeConfirmedCurve(sparseSeed, confirmed)
  assert.equal(foundation.predicament.facts.some((candidate) => candidate.statement === fact.text), false)
  assert.equal(foundation.seed.lockedFacts.includes(fact.text), false)
  assert.equal(foundation.seed.lockedFacts.includes(sparseSeed.lockedFacts[0]!), false)
  assert.equal(foundation.seed.lockedGoal, '作者编辑：当前状态不再依赖已暂存的目标。')
})

test('rejected curve proposals are not used as confirmed-curve grounding', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const rejectedCurve = {
    ...rejectCurveBeat(curve, 'beat-character-tension').curve,
    beats: curve.beats.map((beat) => (
      beat.id === 'beat-character-tension'
        ? { ...beat, status: 'rejected' as const, detail: '暂定：手机这个未确认工具会决定人物关系。' }
        : beat.status === 'stale' ? { ...beat, status: 'proposed' as const } : beat
    )),
  }
  const confirmed = confirmProvisionalCurve(rejectedCurve).confirmedCurve
  const foundation = materializeConfirmedCurve(sparseSeed, confirmed)
  const turn: StoryTurn = {
    id: 'turn-rejected-grounding',
    phase: 'opening',
    node: {
      id: 'node-rejected-grounding',
      title: '未确认细节',
      event: '主角看见手机上的提示，却还不能把这当成故事前提。',
      purpose: '验证被拒绝提案不再为后续具体细节提供依据。',
      goalState: 'blocked',
    },
    conflict: {
      nodeId: 'node-rejected-grounding',
      conflict: '当前安排仍然需要一个可确认的应对方向。',
      action: '先判断已知材料能支持什么。',
      consequence: '未经确认的工具不能改变当前事实。',
      intensity: 1,
      anchor: '起点',
    },
    question: '现在怎么办？',
    options: [],
    narrativeAction: null,
    transition: null,
    canConclude: false,
    isConclusion: false,
  }

  assert.throws(
    () => validateConfirmedCurveStoryTurnContinuation({
      idea: sparseIdea,
      seed: foundation.seed,
      predicament: foundation.predicament,
      approach: foundation.approach,
      headTail: foundation.headTail,
      history: [],
      confirmedCurve: confirmed,
    }, turn),
    /手机/u,
  )
})

test('a rejected system proposal cannot be edited or regenerated back into the curve', async () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const rejected = rejectCurveBeat(curve, 'beat-trigger').curve

  assert.throws(
    () => updateCurveBeat(rejected, 'beat-trigger', '作者不再采用这个提案。'),
    /已被你拒绝/u,
  )
  await assert.rejects(
    regenerateCurveBeat(sparseIdea, sparseSeed, rejected, 'beat-trigger'),
    /已被你拒绝/u,
  )
})

test('a rejected required proposal can be explicitly replaced without reusing it', async () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const originalDetail = curve.beats.find((beat) => beat.id === 'beat-trigger')!.detail
  const rejected = rejectCurveBeat(curve, 'beat-trigger').curve
  const replacement = await regenerateCurveBeat(sparseIdea, sparseSeed, rejected, 'beat-trigger', undefined, true)
  const replacementBeat = replacement.curve.beats.find((beat) => beat.id === 'beat-trigger')

  assert.equal(replacementBeat?.status, 'proposed')
  assert.equal(replacementBeat?.source, 'system-proposal')
  assert.notEqual(replacementBeat?.detail, originalDetail)
  assert.equal(replacement.curve.rejectedProposals?.some((beat) => beat.detail === originalDetail), true)
})

test('creative directions change the causal mechanism of a fallback curve', () => {
  const costCurve = createProvisionalCurveFallback(sparseIdea, sparseSeed, {
    tones: ['growth'],
    dramaticForces: ['cost'],
    allowSystemNamedCharacters: false,
  })
  const relationshipCurve = createProvisionalCurveFallback(sparseIdea, sparseSeed, {
    tones: ['friendship'],
    dramaticForces: ['relationship-tension'],
    allowSystemNamedCharacters: false,
  })

  assert.notEqual(
    costCurve.beats.find((beat) => beat.kind === 'trigger')?.detail,
    relationshipCurve.beats.find((beat) => beat.kind === 'trigger')?.detail,
  )
  const costFoundation = materializeConfirmedCurve(sparseSeed, confirmProvisionalCurve(costCurve).confirmedCurve)
  const relationshipFoundation = materializeConfirmedCurve(sparseSeed, confirmProvisionalCurve(relationshipCurve).confirmedCurve)
  assert.notEqual(costFoundation.predicament.variationAxis, relationshipFoundation.predicament.variationAxis)
  assert.notEqual(costFoundation.predicament.obstacle, relationshipFoundation.predicament.obstacle)
})

test('same dramatic force still changes at least three causal beats across tones', () => {
  const growthCurve = createProvisionalCurveFallback(sparseIdea, sparseSeed, {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  })
  const mysteryCurve = createProvisionalCurveFallback(sparseIdea, sparseSeed, {
    tones: ['mystery'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  })
  const comparableKinds = ['character-tension', 'trigger', 'escalation', 'midpoint-turn', 'climax-choice', 'resolution']
  const differences = comparableKinds.filter((kind) => (
    growthCurve.beats.find((beat) => beat.kind === kind)?.detail
      !== mysteryCurve.beats.find((beat) => beat.kind === kind)?.detail
  ))
  assert.ok(differences.length >= 3, `expected at least three causal differences, got ${differences.join(', ')}`)
})

test('rich input keeps tone changes causal when the dramatic force is unchanged', () => {
  const growthCurve = createProvisionalCurveFallback(richCurveIdea, richCurveSeed, {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  })
  const mysteryCurve = createProvisionalCurveFallback(richCurveIdea, richCurveSeed, {
    tones: ['mystery'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  })
  const comparableKinds = ['character-tension', 'trigger', 'escalation', 'midpoint-turn', 'climax-choice', 'resolution']
  const differences = comparableKinds.filter((kind) => (
    growthCurve.beats.find((beat) => beat.kind === kind)?.detail
      !== mysteryCurve.beats.find((beat) => beat.kind === kind)?.detail
  ))
  assert.ok(differences.length >= 3, `expected rich-input tone differences, got ${differences.join(', ')}`)
  assert.match(growthCurve.beats.map((beat) => beat.detail).join('\n'), /旧习惯|承担/u)
  assert.match(mysteryCurve.beats.map((beat) => beat.detail).join('\n'), /信息缺口|解释/u)
})

test('a new curve version does not silently reuse a rejected proposal', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const original = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const rejectedDetail = original.beats.find((beat) => beat.kind === 'trigger')!.detail
  const regenerated = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief, undefined, [rejectedDetail])
  const regeneratedTrigger = regenerated.beats.find((beat) => beat.kind === 'trigger')!.detail

  assert.notEqual(regeneratedTrigger, rejectedDetail)
  assert.equal(regeneratedTrigger.includes(rejectedDetail.replace(/^暂定[：:]/u, '')), false)
})

test('replacing a rejected proposal keeps the author-selected dramatic direction', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const original = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const rejectedDetail = original.beats.find((beat) => beat.kind === 'trigger')!.detail
  const replacement = createProvisionalCurveFallback(
    sparseIdea,
    sparseSeed,
    brief,
    undefined,
    [rejectedDetail],
  )

  assert.deepEqual(replacement.brief.dramaticForces, brief.dramaticForces)
  assert.equal(replacement.generation?.dramaticMechanism, original.generation?.dramaticMechanism)
  assert.notEqual(replacement.beats.find((beat) => beat.kind === 'trigger')?.detail, rejectedDetail)
})

test('dependent fallback regeneration carries the author edit into later beats', async () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const edited = updateCurveBeat(
    curve,
    'beat-trigger',
    '暂定：青柠坚持去游乐园，是想证明自己已经能独自作决定。',
  ).curve
  const result = await regenerateAffectedCurveBeats(sparseIdea, sparseSeed, edited)
  const laterDetails = result.curve.beats
    .filter((beat) => ['escalation', 'midpoint-turn', 'climax-choice', 'resolution'].includes(beat.kind))
    .map((beat) => beat.detail)
    .join(' ')

  assert.doesNotMatch(laterDetails, /更重要的事|承担代价，选择比眼前目标/u)
  assert.match(laterDetails, /独自作决定|青柠坚持去游乐园/u)
})

test('dependent fallback regeneration propagates consequences without recursive author-edit text', async () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const authorEdit = '暂定：青柠坚持去游乐园，是想证明自己已经能独自作决定。'
  const edited = updateCurveBeat(curve, 'beat-trigger', authorEdit).curve
  const result = await regenerateAffectedCurveBeats(sparseIdea, sparseSeed, edited)
  const downstream = result.curve.beats
    .filter((beat) => ['escalation', 'midpoint-turn', 'climax-choice', 'resolution'].includes(beat.kind))
    .map((beat) => beat.detail)

  assert.match(downstream[0], /独自作决定/u)
  assert.match(downstream[0], /青柠坚持去游乐园/u)
  assert.doesNotMatch(downstream[0], /青柠坚持去游乐园；是想/u)
  assert.equal(downstream.some((detail) => detail.includes(authorEdit.replace(/^暂定：/u, ''))), false)
  assert.equal(downstream.some((detail) => /“[^”]*“[^”]*”[^”]*”/u.test(detail)), false)
  assert.doesNotMatch(downstream.join('\n'), /共同作品/u)
  assert.equal(new Set(downstream).size, downstream.length)
})

test('author instruction wrappers are removed before causal propagation', async () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const wrappers = [
    '作者希望高潮先回应已确认的归还承诺，再决定是否继续。',
    '把高潮改成先回应归还承诺，再决定是否继续。',
  ]
  for (const instruction of wrappers) {
    const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
    const edited = updateCurveBeat(curve, 'beat-trigger', instruction).curve
    const result = await regenerateAffectedCurveBeats(sparseIdea, sparseSeed, edited)
    const downstream = result.curve.beats
      .filter((beat) => ['escalation', 'midpoint-turn', 'climax-choice', 'resolution'].includes(beat.kind))
      .map((beat) => beat.detail)
      .join('\n')

    assert.doesNotMatch(downstream, /作者希望|把高潮改成|高潮先回应/u)
    assert.match(downstream, /归还承诺|是否继续/u)
  }
})

test('batch regeneration requires every decision and keeps rejected replacements out of the curve', async () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const edited = updateCurveBeat(
    curve,
    'beat-trigger',
    '暂定：青柠坚持去游乐园，是想证明自己已经能独自作决定。',
  ).curve
  const preview = await previewAffectedCurveBeats(sparseIdea, sparseSeed, edited)
  assert.ok(preview.preview.items.length >= 2)

  assert.throws(
    () => resolveAffectedCurveBeats(edited, preview.preview, {}),
    /逐项接受或拒绝/u,
  )

  const decisions = Object.fromEntries(preview.preview.items.map((item, index) => [
    item.id,
    (index === 0 ? 'reject' : 'accept') as StoryCurveRegenerationDecision,
  ])) as Record<string, StoryCurveRegenerationDecision>
  const resolved = resolveAffectedCurveBeats(edited, preview.preview, decisions)
  const rejectedItem = preview.preview.items[0]!
  assert.equal(
    resolved.curve.rejectedProposals?.some((proposal) => proposal.detail === rejectedItem.newDetail),
    true,
  )
  assert.equal(
    resolved.curve.beats.find((beat) => beat.id === rejectedItem.beatId)?.detail,
    edited.beats.find((beat) => beat.id === rejectedItem.beatId)?.detail,
  )
  assert.equal(
    resolved.curve.beats.find((beat) => beat.id === rejectedItem.beatId)?.status,
    'stale',
  )
})

test('batch regeneration preview is non-mutating and keeps confirmation gated after a rejection', async () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const edited = updateCurveBeat(
    curve,
    'beat-trigger',
    '暂定：让高潮先回应已确认的归还承诺，再决定是否继续。',
  ).curve
  const beforePreview = structuredClone(edited)
  const preview = await previewAffectedCurveBeats(sparseIdea, sparseSeed, edited)

  assert.deepEqual(edited, beforePreview)
  assert.ok(preview.preview.items.length >= 2)

  const decisions = Object.fromEntries(preview.preview.items.map((item, index) => [
    item.id,
    (index === 0 ? 'reject' : 'accept') as StoryCurveRegenerationDecision,
  ])) as Record<string, StoryCurveRegenerationDecision>
  const resolved = resolveAffectedCurveBeats(edited, preview.preview, decisions)
  assert.throws(
    () => confirmProvisionalCurve(resolved.curve),
    /先处理被修改影响/u,
  )
  assert.equal(
    resolved.curve.rejectedProposals?.some((proposal) => proposal.detail === preview.preview.items[0]!.newDetail),
    true,
  )
})

test('batch regeneration gives each downstream proposal a new causal detail', async () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const edited = updateCurveBeat(
    curve,
    'beat-trigger',
    '暂定：让高潮先回应已确认的归还承诺，再决定是否继续。',
  ).curve
  const preview = await previewAffectedCurveBeats(sparseIdea, sparseSeed, edited)
  assert.ok(preview.preview.items.length >= 2)
  assert.equal(
    preview.preview.items.every((item) => item.newDetail !== item.oldDetail),
    true,
    'every affected system proposal needs an actual old/new difference',
  )
})

test('rich-input batch regeneration keeps every downstream proposal causally distinct', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  process.env.STORY_DISABLE_MODEL = 'true'
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }

  try {
    const curve = createProvisionalCurveFallback(richCurveIdea, richCurveSeed, brief)
    const authorEdit = '让高潮先回应已确认的归还承诺，再决定是否继续。'
    const edited = updateCurveBeat(curve, 'beat-trigger', authorEdit).curve
    const preview = await previewAffectedCurveBeats(richCurveIdea, richCurveSeed, edited)
    const items = preview.preview.items

    assert.ok(items.length >= 2)
    assert.equal(items.every((item) => item.newDetail !== item.oldDetail), true)
    assert.equal(new Set(items.map((item) => item.newDetail)).size, items.length)
    assert.match(items[0]!.newDetail, /归还承诺|决定是否继续/u)
    assert.match(items[0]!.newDetail, /回应已确认的归还承诺/u)
    assert.doesNotMatch(items[0]!.newDetail, /投影仪今晚要归还，后续取舍/u)
    assert.doesNotMatch(items[0]!.newDetail, /所以让高潮/u)
    assert.equal(items.some((item) => item.newDetail.includes(authorEdit)), false)
    assert.equal(items.some((item) => item.newDetail.includes(authorEdit.replace(/^让高潮先/u, ''))), false)
    assert.equal(items.slice(1).some((item) => /继续带来的前置条件|前置条件带来的/u.test(item.newDetail)), false)
    assert.match(items.find((item) => item.kind === 'midpoint-turn')!.newDetail, /是否继续[”"]改变了/u)
    assert.match(items.find((item) => item.kind === 'climax-choice')!.newDetail, /归还承诺与是否继续之间的取舍/u)
    assert.match(items.find((item) => item.kind === 'resolution')!.newDetail, /承担“是否继续”带来的责任/u)
  } finally {
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
  }
})

test('batch regeneration preserves source-fact links needed for confirmation', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  process.env.STORY_DISABLE_MODEL = 'true'
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }

  try {
    const curve = createProvisionalCurveFallback(richCurveIdea, richCurveSeed, brief)
    const edited = updateCurveBeat(
      curve,
      'beat-trigger',
      '暂定：投影仪今晚要归还，所以让高潮先回应已确认的归还承诺，再决定是否继续。',
    ).curve
    const preview = await previewAffectedCurveBeats(richCurveIdea, richCurveSeed, edited)
    const decisions = Object.fromEntries(preview.preview.items.map((item) => [item.id, 'accept' as const]))
    const resolved = resolveAffectedCurveBeats(edited, preview.preview, decisions)

    assert.equal(
      resolved.curve.design?.sourceFacts.every((fact) => fact.disposition === 'integrated'),
      true,
      'regeneration must retain the original rich-input fact links',
    )
    assert.doesNotThrow(() => confirmProvisionalCurve(resolved.curve))
  } finally {
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
  }
})

test('an author may explicitly park source material before confirmation', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const fact = curve.design?.sourceFacts[0]
  assert.ok(fact)
  const result = updateCurveSourceFactDisposition(curve, fact.id, 'parked')
  assert.equal(result.curve.design?.sourceFacts.find((item) => item.id === fact.id)?.disposition, 'parked')
})

test('parked source material can be explicitly brought back after an author edit', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const fact = curve.design?.sourceFacts.find((candidate) => candidate.text === sparseSeed.lockedGoal)
  assert.ok(fact)

  const parked = updateCurveSourceFactDisposition(curve, fact.id, 'parked').curve
  const edited = updateCurveBeat(
    parked,
    'beat-trigger',
    `暂定：继续${sparseSeed.lockedGoal}时，主角必须重新面对这项目标。`,
  ).curve
  const coveredParkedFact = edited.design?.sourceFacts.find((candidate) => candidate.id === fact.id)
  assert.equal(coveredParkedFact?.disposition, 'parked')
  assert.ok(coveredParkedFact?.coveredByBeatIds.includes('beat-trigger'))

  const reintegrated = updateCurveSourceFactDisposition(edited, fact.id, 'integrated').curve
  const restoredFact = reintegrated.design?.sourceFacts.find((candidate) => candidate.id === fact.id)
  assert.equal(restoredFact?.disposition, 'integrated')
  assert.ok(restoredFact?.coveredByBeatIds.includes('beat-trigger'))
})

test('parked source material can be restored without losing its prior coverage', () => {
  const brief: CreativeBrief = {
    tones: ['growth'],
    dramaticForces: ['contrast'],
    allowSystemNamedCharacters: false,
  }
  const curve = createProvisionalCurveFallback(sparseIdea, sparseSeed, brief)
  const fact = curve.design?.sourceFacts.find((candidate) => candidate.text === sparseSeed.lockedGoal)
  assert.ok(fact)

  const parked = updateCurveSourceFactDisposition(curve, fact.id, 'parked').curve
  const parkedFact = parked.design?.sourceFacts.find((candidate) => candidate.id === fact.id)
  assert.equal(parkedFact?.disposition, 'parked')
  assert.ok(parkedFact?.coveredByBeatIds.length)

  const restored = updateCurveSourceFactDisposition(parked, fact.id, 'integrated').curve
  const restoredFact = restored.design?.sourceFacts.find((candidate) => candidate.id === fact.id)
  assert.equal(restoredFact?.disposition, 'integrated')
  assert.ok(restoredFact?.coveredByBeatIds.length)
})

test('keeps a bare idea actionable when the model seed extraction is unavailable', () => {
  const amusement = createOriginalIdeaFallbackSeed('青柠去游乐园', undefined)
  const apology = createOriginalIdeaFallbackSeed('阿南想向朋友道歉', undefined)
  const report = createOriginalIdeaFallbackSeed('周岚要提交报告', undefined)

  assert.deepEqual(
    [amusement.subject, amusement.lockedGoal],
    ['青柠', '去游乐园'],
  )
  assert.deepEqual(
    [apology.subject, apology.lockedGoal],
    ['阿南', '向朋友道歉'],
  )
  assert.deepEqual(
    [report.subject, report.lockedGoal],
    ['周岚', '提交报告'],
  )
})

test('extracts a conservative subject and goal from rich fallback prose', () => {
  const idea = '毕业展布置前，沈乔在借来的投影仪里看到和前队友剪的短片。投影仪今晚要归还，她答应不再改动作品，却想在展出前决定要不要删掉自己的名字。'
  const seed = createOriginalIdeaFallbackSeed(idea, undefined)

  assert.equal(seed.subject, '沈乔')
  assert.equal(seed.lockedGoal, '在展出前决定要不要删掉自己的名字')
  assert.equal(seed.activeSituation, idea)
  assert.ok(seed.lockedFacts.includes('毕业展布置前'))
  assert.ok(seed.lockedFacts.includes('投影仪今晚要归还'))
  assert.ok(seed.lockedFacts.includes('她答应不再改动作品'))
  assert.ok(seed.lockedFacts.includes('却想在展出前决定要不要删掉自己的名字'))
  assert.equal(seed.lockedFacts.includes(idea), false)
})

test('uses the direct co-creation seed for a rich Chinese idea with a clear subject and goal', () => {
  const idea = '毕业展布置前，沈乔在借来的投影仪里看到和前队友剪的短片。投影仪今晚要归还，她答应不再改动作品，却想在展出前决定要不要删掉自己的名字。'
  const seed = createDirectCoCreationSeed(idea)

  assert.ok(seed)
  assert.equal(seed.subject, '沈乔')
  assert.equal(seed.lockedGoal, '在展出前决定要不要删掉自己的名字')
  assert.ok(seed.lockedFacts.includes('投影仪今晚要归还'))
  assert.ok(seed.lockedFacts.includes('她答应不再改动作品'))
})

test('treats a leading promise as a constraint instead of the protagonist goal', () => {
  const seed = createDirectCoCreationSeed('林澈答应在周五前把祖母的手稿交给出版社，但他发现最后一页缺失，不知道是否该按承诺提交。')

  assert.ok(seed)
  assert.equal(seed.subject, '林澈')
  assert.equal(seed.lockedGoal, '在周五前把祖母的手稿交给出版社')
  assert.equal(seed.lockedFacts.includes('林澈答应在周五前把祖母的手稿交给出版社'), true)
})

test('rich model directions keep visible author facts and reject new scene hooks', () => {
  const seed = createDirectCoCreationSeed(richCurveIdea)
  assert.ok(seed)
  const draft: StoryConflictCoreSystemDraft = {
    goal: seed.lockedGoal ?? '在展出前决定要不要删掉自己的名字',
    stake: '投影仪今晚要归还，让展出前的署名决定不能继续搁置',
    constraint: '她答应不再改动作品',
    origin: 'model',
    directions: [
      {
        label: '归还期限',
        mechanismType: 'information-gap',
        premise: '暂定：投影仪今晚要归还，让沈乔无法按原计划决定是否删掉自己的名字',
        tradeoff: '先面对投影仪今晚要归还，还是暂缓决定要不要删掉自己的名字',
      },
      {
        label: '不改动承诺',
        mechanismType: 'commitment-conflict',
        premise: '暂定：她答应不再改动作品，让删掉自己的名字成为取舍',
        tradeoff: '守住不再改动作品，还是决定要不要删掉自己的名字',
      },
      {
        label: '前队友短片',
        mechanismType: 'meaning-commitment',
        premise: '暂定：和前队友剪的短片，让是否删掉自己的名字改变意义',
        tradeoff: '保留和前队友剪的短片，还是删掉自己的名字',
      },
    ],
  }

  assert.doesNotThrow(() => validateSystemConflictCoreDraft(richCurveIdea, seed, draft))

  const inventedHook = structuredClone(draft)
  inventedHook.directions![0] = {
    ...inventedHook.directions![0]!,
    premise: '暂定：投影仪里的短片结尾浮现陌生字句',
  }
  assert.throws(
    () => validateSystemConflictCoreDraft(richCurveIdea, seed, inventedHook),
    /具体场景钩子/u,
  )

  const observationAsChoice = structuredClone(draft)
  observationAsChoice.directions![2] = {
    ...observationAsChoice.directions![2]!,
    tradeoff: '和前队友剪的短片，还是暂缓决定',
  }
  assert.throws(
    () => validateSystemConflictCoreDraft(richCurveIdea, seed, observationAsChoice),
    /取舍加入了未由作者原文支持的判断/u,
  )

  const malformedCausalTemplate = structuredClone(draft)
  malformedCausalTemplate.directions![0] = {
    ...malformedCausalTemplate.directions![0]!,
    premise: '暂定：投影仪今晚要归还让想在展出前决定要不要删掉自己的名字停住',
  }
  assert.throws(
    () => validateSystemConflictCoreDraft(richCurveIdea, seed, malformedCausalTemplate),
    /模板化因果连接/u,
  )
})

test('rejects rich model directions that hide new value or authority conclusions behind source facts', () => {
  const deadlineIdea = '林澈答应在周五前把祖母的手稿交给出版社，但他发现最后一页缺失，不知道是否该按承诺提交。'
  const deadlineSeed = createDirectCoCreationSeed(deadlineIdea)
  assert.ok(deadlineSeed)
  const deadlineDraft: StoryConflictCoreSystemDraft = {
    goal: deadlineSeed.lockedGoal ?? '在周五前把祖母的手稿交给出版社',
    stake: '按承诺提交与最后一页缺失之间存在取舍',
    constraint: '林澈答应在周五前把祖母的手稿交给出版社',
    origin: 'model',
    directions: [
      {
        label: '周五交稿',
        mechanismType: 'window-pressure',
        premise: '暂定：林澈答应在周五前把祖母的手稿交给出版社',
        tradeoff: '在周五前把祖母的手稿交给出版社，还是暂缓处理最后一页缺失',
      },
      {
        label: '最后一页缺失',
        mechanismType: 'information-gap',
        premise: '暂定：但他发现最后一页缺失',
        tradeoff: '保留最后一页缺失，还是按承诺提交',
      },
      {
        label: '按承诺提交',
        mechanismType: 'commitment-conflict',
        premise: '暂定：不知道是否该按承诺提交',
        tradeoff: '按承诺提交，还是暂缓交给出版社',
      },
    ],
  }
  assert.doesNotThrow(() => validateSystemConflictCoreDraft(deadlineIdea, deadlineSeed, deadlineDraft))

  const inventedMeaning = structuredClone(deadlineDraft)
  inventedMeaning.directions![2] = {
    ...inventedMeaning.directions![2]!,
    tradeoff: '将祖母的手稿视为祖母未竟意志，还是保留完整权',
  }
  assert.throws(
    () => validateSystemConflictCoreDraft(deadlineIdea, deadlineSeed, inventedMeaning),
    /未由作者原文支持的价值、权限或关系结论/u,
  )

  const inventedAuthorshipRight = structuredClone(deadlineDraft)
  inventedAuthorshipRight.directions![2] = {
    ...inventedAuthorshipRight.directions![2]!,
    tradeoff: '按承诺提交，还是保留署名权',
  }
  assert.throws(
    () => validateSystemConflictCoreDraft(deadlineIdea, deadlineSeed, inventedAuthorshipRight),
    /未由作者原文支持的价值、权限或关系结论/u,
  )

  const explicitAuthorshipIdea = `${deadlineIdea} 林澈明确保留署名权。`
  const explicitAuthorshipSeed = createDirectCoCreationSeed(explicitAuthorshipIdea)
  assert.ok(explicitAuthorshipSeed)
  const explicitAuthorshipDraft = structuredClone(deadlineDraft)
  explicitAuthorshipDraft.directions![2] = {
    label: '署名权',
    mechanismType: 'meaning-commitment',
    premise: '暂定：林澈明确保留署名权',
    tradeoff: '保留署名权，还是按承诺提交',
  }
  assert.doesNotThrow(() => validateSystemConflictCoreDraft(
    explicitAuthorshipIdea,
    explicitAuthorshipSeed,
    explicitAuthorshipDraft,
  ))

  const relationshipSeed = createDirectCoCreationSeed(relationshipCurveIdea)
  assert.ok(relationshipSeed)
  const relationshipDraft: StoryConflictCoreSystemDraft = {
    goal: relationshipSeed.lockedGoal ?? '和姐姐一起保住父亲留下的书店',
    stake: '和姐姐一起保住父亲留下的书店与不再替姐姐做决定之间存在取舍',
    constraint: '姐姐准备把店卖掉',
    origin: 'model',
    directions: [
      {
        label: '保住书店',
        mechanismType: 'window-pressure',
        premise: '暂定：姐姐准备把店卖掉',
        tradeoff: '和姐姐一起保住父亲留下的书店，还是不再替姐姐做决定',
      },
      {
        label: '不替姐姐决定',
        mechanismType: 'commitment-conflict',
        premise: '暂定：却答应过不再替姐姐做决定',
        tradeoff: '不再替姐姐做决定，还是和姐姐一起保住父亲留下的书店',
      },
      {
        label: '卖掉书店',
        mechanismType: 'meaning-commitment',
        premise: '暂定：周岚想和姐姐一起保住父亲留下的书店',
        tradeoff: '姐姐准备把店卖掉，还是和姐姐一起保住父亲留下的书店',
      },
    ],
  }
  assert.doesNotThrow(() => validateSystemConflictCoreDraft(relationshipCurveIdea, relationshipSeed, relationshipDraft))

  const inventedAuthority = structuredClone(relationshipDraft)
  inventedAuthority.directions![2] = {
    ...inventedAuthority.directions![2]!,
    tradeoff: '和姐姐一起保住父亲留下的书店，还是由姐姐单方延续',
  }
  assert.throws(
    () => validateSystemConflictCoreDraft(relationshipCurveIdea, relationshipSeed, inventedAuthority),
    /未由作者原文支持的价值、权限或关系结论/u,
  )

  const abstractTradeoffSides = structuredClone(relationshipDraft)
  abstractTradeoffSides.directions = abstractTradeoffSides.directions!.map((direction, index) => ({
    ...direction,
    tradeoff: [
      '和姐姐一起保住父亲留下的书店，还是姐姐准备把店卖掉',
      '保留承诺，还是和姐姐一起保住父亲留下的书店',
      '重新判断，还是姐姐准备把店卖掉',
    ][index]!,
  }))
  assert.doesNotThrow(() => validateSystemConflictCoreDraft(
    relationshipCurveIdea,
    relationshipSeed,
    abstractTradeoffSides,
  ))

  const inventedTemporalLabel = structuredClone(relationshipDraft)
  inventedTemporalLabel.directions![0] = {
    ...inventedTemporalLabel.directions![0]!,
    label: '期限卡住目标',
  }
  assert.throws(
    () => validateSystemConflictCoreDraft(relationshipCurveIdea, relationshipSeed, inventedTemporalLabel),
    /作者没有提供的期限或时机语义/u,
  )
})

test('rich system-draft requests never invite sparse-scene hooks', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  const idea = '沈乔要在周五前把祖母的手稿交给出版社，却发现最后一页缺失，也答应过不擅自补写。'
  const systemPrompts: string[] = []
  const userPrompts: string[] = []

  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'test-only-key'
  process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
  try {
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> }
      systemPrompts.push(request.messages?.[0]?.content ?? '')
      userPrompts.push(request.messages?.[1]?.content ?? '')
      return createCurveModelResponse({
        systemDraft: {
          stake: '按时提交与最后一页缺失之间存在取舍',
          constraint: '周五前交稿与最后一页缺失同时存在',
          directions: [
            {
              label: '周五期限',
              mechanismType: 'window-pressure',
              premise: '暂定：周五前把祖母的手稿交给出版社，让提交决定不能继续搁置',
              tradeoff: '在周五前提交祖母的手稿，还是暂缓处理最后一页缺失',
            },
            {
              label: '补写承诺',
              mechanismType: 'commitment-conflict',
              premise: '暂定：答应过不擅自补写，让最后一页缺失成为提交取舍',
              tradeoff: '守住不擅自补写，还是在周五前提交祖母的手稿',
            },
            {
              label: '缺页取舍',
              mechanismType: 'meaning-commitment',
              premise: '暂定：祖母的手稿最后一页缺失，让提交决定需要重新判断',
              tradeoff: '保留最后一页缺失，还是在周五前提交祖母的手稿',
            },
          ],
        },
      })

      if (systemPrompts.length === 1) {
        // The direct seed avoids extraction, so the first request is the
        // system-draft call. Keep the mock response valid and let the normal
        // direction picker proceed through its own fallback contract.
      }
    }

    const response = await generateDirections({
      idea,
      expansionScope: 'keep-scale',
      generateSystemDraft: true,
    })
    assert.equal(response.conflictCores.length, 3)

    const systemDraftPrompt = systemPrompts.find((prompt) => prompt.includes('信息丰富输入'))
    assert.ok(systemDraftPrompt, 'expected the rich system-draft system prompt')
    assert.match(systemDraftPrompt ?? '', /不得新增任何普通物件、设备、通讯/u)
    assert.doesNotMatch(systemDraftPrompt ?? '', /门票、手机、工作人员等普通词可以/u)
    assert.doesNotMatch(systemDraftPrompt ?? '', /允许一个当前物件/u)
    assert.equal(userPrompts.some((prompt) => /门票、手机、工作人员等普通词可以/u.test(prompt)), false)
    assert.equal(userPrompts.some((prompt) => /反常痕迹、角色错位、有限意外/u.test(prompt)), false)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('recovers a grounded rich direction without applying sparse-hook validation', async () => {
  const previousDisableModel = process.env.STORY_DISABLE_MODEL
  const previousApiKey = process.env.DASHSCOPE_API_KEY
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL
  const previousFetch = globalThis.fetch
  const idea = '林澈答应在周五前把祖母的手稿交给出版社，但他发现最后一页缺失，不知道是否该按承诺提交。'

  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'test-only-key'
  process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
  try {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      if (calls <= 3) {
        return createCurveModelResponse({
          systemDraft: {
            stake: '按时提交与最后一页缺失之间存在取舍',
            constraint: '周五前交稿与最后一页缺失同时存在',
            directions: [
              {
                label: '周五期限',
                mechanismType: 'window-pressure',
                premise: '暂定：林澈答应在周五前把祖母的手稿交给出版社',
                tradeoff: '按承诺提交还是暂缓提交',
              },
              {
                label: '缺页判断',
                mechanismType: 'information-gap',
                premise: '暂定：但他发现最后一页缺失',
                tradeoff: '继续提交还是保留缺失',
              },
              {
                label: '陌生便签',
                mechanismType: 'commitment-conflict',
                premise: '暂定：手稿旁多出便签',
                tradeoff: '按承诺提交还是保留便签',
              },
            ],
          },
        })
      }

      return createCurveModelResponse({
        directions: [{
          label: '承诺与缺页',
          mechanismType: 'boundary-conflict',
          premise: '暂定：他发现最后一页缺失',
          tradeoff: '继续按承诺提交还是暂缓提交',
        }],
      })
    }

    const response = await generateDirections({
      idea,
      expansionScope: 'keep-scale',
      generateSystemDraft: true,
    })

    assert.equal(response.seed.systemDraft?.origin, 'model')
    assert.equal(response.seed.systemDraft?.directions?.length, 3)
    assert.ok(response.seed.systemDraft?.directions?.some((direction) => direction.label === '承诺与缺页'))
  } finally {
    globalThis.fetch = previousFetch
    if (previousDisableModel === undefined) delete process.env.STORY_DISABLE_MODEL
    else process.env.STORY_DISABLE_MODEL = previousDisableModel
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl
  }
})

test('keeps a leading goal clause separate from later rich source facts', () => {
  const idea = '青柠要在周五毕业展前把祖母留下的投影仪送到学校；好友阿岚答应帮忙但要求不要署名；归还期限是周六；途中发现设备缺少电源线；青柠必须决定是否拆掉自己的展板供电；可能失去署名机会。'
  const seed = createOriginalIdeaFallbackSeed(idea, undefined)

  assert.equal(seed.subject, '青柠')
  assert.equal(seed.lockedGoal, '在周五毕业展前把祖母留下的投影仪送到学校')
  assert.equal(seed.activeSituation, idea)
})

test('adapts deterministic creative drafts to the target and avoids prior motifs', () => {
  const amusementDraft = createBoundedSystemConflictCoreDraftFallback(sparseSeed)
  const reportDraft = createBoundedSystemConflictCoreDraftFallback(reportSeed)
  const apologySeed = {
    subject: '阿南',
    activeSituation: '阿南想向朋友道歉',
    lockedGoal: '向朋友道歉',
    lockedFacts: ['阿南想向朋友道歉'],
  }
  const apologyDraft = createBoundedSystemConflictCoreDraftFallback(apologySeed)
  const refreshedAmusementDraft = createBoundedSystemConflictCoreDraftFallback(
    sparseSeed,
    amusementDraft.directions?.map((direction) => direction.label),
  )

  assert.equal(amusementDraft.goal, sparseSeed.lockedGoal)
  assert.equal(reportDraft.goal, reportSeed.lockedGoal)
  assert.equal(apologyDraft.goal, apologySeed.lockedGoal)
  assert.notDeepEqual(amusementDraft.directions, reportDraft.directions)
  assert.deepEqual(
    amusementDraft.directions?.map((direction) => direction.mechanismType),
    reportDraft.directions?.map((direction) => direction.mechanismType),
  )
  assert.match(JSON.stringify(amusementDraft.directions), /去游乐园/u)
  assert.match(JSON.stringify(reportDraft.directions), /提交报告/u)
  assert.match(JSON.stringify(amusementDraft.directions), /游园图/u)
  assert.match(JSON.stringify(reportDraft.directions), /文稿页/u)
  assert.match(JSON.stringify(apologyDraft.directions), /便签/u)
  assert.match(JSON.stringify(apologyDraft.directions), /阿南/u)
  assert.notDeepEqual(
    amusementDraft.directions?.map((direction) => direction.label),
    refreshedAmusementDraft.directions?.map((direction) => direction.label),
  )
  assert.doesNotMatch(JSON.stringify(amusementDraft.directions), /(?:条件缺口|当前限制|时间受限|旧物上的陌生话|陌生人的请求|继续的直接代价)/u)
  assert.doesNotMatch(JSON.stringify(amusementDraft.directions), /一件眼下不能替代的东西/u)
  for (const [idea, draft, draftSeed] of [
    [sparseIdea, amusementDraft, sparseSeed],
    [reportSeed.activeSituation, reportDraft, reportSeed],
    [apologySeed.activeSituation, apologyDraft, apologySeed],
    [sparseIdea, refreshedAmusementDraft, sparseSeed],
  ] as const) {
    assert.doesNotThrow(() => validateSystemConflictCoreDraft(idea, draftSeed, draft))
  }
})

test('keeps a usable creative branch when a later model branch becomes a workflow', () => {
  const draft: StoryConflictCoreSystemDraft = {
    goal: sparseSeed.lockedGoal,
    stake: '继续去游乐园需要承担一项取舍',
    constraint: '当前会有一个主要阻碍',
    origin: 'model',
    directions: [
      {
        label: '旧照片上的陌生日期',
        mechanismType: 'information-gap',
        premise: '暂定：与去游乐园有关的旧照片上多出一个陌生日期',
        tradeoff: '先查清日期，还是照原计划去游乐园',
      },
      {
        label: '入园核验',
        mechanismType: 'boundary-conflict',
        premise: '暂定：工作人员要求完成现场核验',
        tradeoff: '配合核验，还是暂不继续',
      },
      {
        label: '继续的代价',
        mechanismType: 'commitment-conflict',
        premise: '暂定：继续去游乐园会失去一件眼下不能替代的东西',
        tradeoff: '承担代价继续，还是保住它暂缓行动',
      },
    ],
  }

  assert.throws(
    () => validateSystemConflictCoreDraft(sparseIdea, sparseSeed, draft),
    /流程、资格或系统规定/,
  )
})

test('keeps a partial creative draft and fills its missing directions with visible hooks', () => {
  const candidate: StoryConflictCoreSystemDraft = {
    goal: sparseSeed.lockedGoal,
    stake: '继续去游乐园需要承担一项取舍',
    constraint: '当前会有一个主要阻碍',
    origin: 'model',
    directions: [
      {
        label: '旧照片上的陌生日期',
        mechanismType: 'information-gap',
        premise: '暂定：与去游乐园有关的旧照片上多出一个陌生日期',
        tradeoff: '先查清日期，还是照原计划去游乐园',
      },
      {
        label: '入园核验',
        mechanismType: 'boundary-conflict',
        premise: '暂定：工作人员要求完成现场核验',
        tradeoff: '配合核验，还是暂不继续',
      },
      {
        label: '继续的代价',
        mechanismType: 'commitment-conflict',
        premise: '暂定：继续去游乐园会失去一件眼下不能替代的东西',
        tradeoff: '承担代价继续，还是保住它暂缓行动',
      },
    ],
  }

  const fallback = createSystemDraftCandidatePreservingFallback(sparseIdea, sparseSeed, candidate)

  assert.equal(fallback.origin, 'deterministic-fallback')
  assert.match(fallback.fallbackReason ?? '', /未整体通过校验|本地结构草案/u)
  assert.equal(fallback.directions?.[0]?.label, '旧照片上的陌生日期')
  assert.deepEqual(fallback.directions?.slice(1).map((direction) => direction.mechanismType), [
    'boundary-conflict',
    'commitment-conflict',
  ])
  assert.doesNotMatch(JSON.stringify(fallback.directions), /一件眼下不能替代的东西/u)
  assert.doesNotThrow(() => validateSystemConflictCoreDraft(sparseIdea, sparseSeed, fallback))
})

test('does not discard retained directions when they use a different valid mechanism type', () => {
  const candidate: StoryConflictCoreSystemDraft = {
    goal: sparseSeed.lockedGoal,
    stake: '继续去游乐园需要承担一项取舍',
    constraint: '当前会有一个主要阻碍',
    origin: 'model',
    directions: [
      {
        label: '旧照片上的陌生日期',
        mechanismType: 'information-gap',
        premise: '暂定：与去游乐园有关的旧照片上多出一个陌生日期',
        tradeoff: '先查清日期，还是照原计划去游乐园',
      },
      {
        label: '划掉的署名',
        mechanismType: 'meaning-commitment',
        premise: '暂定：一张写着主角名字的纸上，有一道未干的划痕',
        tradeoff: '保留这个名字继续，还是亲手划掉它暂缓行动',
      },
    ],
  }

  const fallback = createSystemDraftCandidatePreservingFallback(sparseIdea, sparseSeed, candidate)

  assert.equal(fallback.origin, 'deterministic-fallback')
  assert.match(fallback.fallbackReason ?? '', /未整体通过校验|本地结构草案/u)
  assert.deepEqual(fallback.directions?.map((direction) => direction.mechanismType), [
    'information-gap',
    'meaning-commitment',
    'boundary-conflict',
  ])
  assert.doesNotThrow(() => validateSystemConflictCoreDraft(sparseIdea, sparseSeed, fallback))
})

test('allows one bounded provisional premise for each sparse-idea direction', () => {
  assert.doesNotThrow(() => validateSystemConflictCoreDraft(
    sparseIdea,
    sparseSeed,
    createSparseSystemDraft(),
  ))
})

test('allows a concrete one-hook system draft without treating it as user fact', () => {
  const draft = createCreativeSparseSystemDraft()

  assert.doesNotThrow(() => validateSystemConflictCoreDraft(
    reportSeed.activeSituation,
    reportSeed,
    draft,
  ))

  const cores = createSystemDraftConflictCoreFallback({
    lockedGoal: reportSeed.lockedGoal,
    systemDraft: draft,
  })
  assert.deepEqual(cores?.map((core) => core.title), draft.directions?.map((direction) => direction.label))
  assert.deepEqual(cores?.map((core) => core.obstacle), draft.directions?.map((direction) => direction.premise))
})

test('allows a dramatic single-hook draft with one direct choice on each side', () => {
  const draft: StoryConflictCoreSystemDraft = {
    goal: '看演唱会',
    stake: '继续这件事会失去一项眼下重要的东西',
    constraint: '目标旁出现了一个需要回应的反常信号',
    origin: 'model',
    directions: [
      {
        label: '门票背面有陌生字迹',
        mechanismType: 'information-gap',
        premise: '暂定：青柠手中的纸质门票背面，用蓝墨水写着“别进去”三个字',
        tradeoff: '撕掉字迹直接入场，还是保留字迹原地停步',
      },
      {
        label: '安检员递来未署名纸条',
        mechanismType: 'boundary-conflict',
        premise: '暂定：安检员递还青柠背包时，多塞进一张没写字的白纸条',
        tradeoff: '当场展开纸条，还是收起纸条',
      },
      {
        label: '口袋里多出旧号码',
        mechanismType: 'meaning-commitment',
        premise: '暂定：青柠口袋里多出一张写着旧号码的纸条',
        tradeoff: '把纸条留在手里进场，还是当场撕掉纸条',
      },
    ],
  }

  assert.doesNotThrow(() => validateSystemConflictCoreDraft('青柠看演唱会', {
    activeSituation: '青柠看演唱会',
    lockedGoal: '看演唱会',
    lockedFacts: ['青柠', '看演唱会'],
  }, draft))
})

test('accepts a mistaken-name hook as a bounded identity conflict', () => {
  const draft = createCreativeSparseSystemDraft()
  draft.directions![1] = {
    label: '叫错的名字',
    mechanismType: 'boundary-conflict',
    premise: '暂定：一个陌生人把主角叫成另一个名字',
    tradeoff: '顺着这个错认听下去，还是当场否认继续当前目标',
  }

  assert.doesNotThrow(() => validateSystemConflictCoreDraft(
    reportSeed.activeSituation,
    reportSeed,
    draft,
  ))
})

test('rejects a creative hook that expands into a staged scene or prescribed route', () => {
  const draft = createCreativeSparseSystemDraft()
  draft.directions![1] = {
    label: '检票口的黑口罩',
    mechanismType: 'boundary-conflict',
    premise: '暂定：检票员身后突然伸来一只手，递出黑口罩，没说话只盯着主角的眼睛',
    tradeoff: '戴上口罩被带往未知侧门，还是坚持原计划走正门入场',
  }

  assert.throws(
    () => validateSystemConflictCoreDraft(reportSeed.activeSituation, reportSeed, draft),
    /(?:连续现场动作|既定路线或被他人带领)/u,
  )
})

test('carries only the selected creative hook into the second-layer contract', () => {
  const systemDraft = createCreativeSparseSystemDraft()
  systemDraft.activeDirection = systemDraft.directions?.[0]
  const activeSeed = { ...reportSeed, systemDraft }
  const core = createSystemDraftConflictCoreFallback(activeSeed)?.[0]
  assert.ok(core)

  const predicament = createCoreAnchoredPredicamentFallback(activeSeed, core)
  assert.match(predicament.immediateSituation, /末页夹着一张写着陌生名字的便签/u)
  assert.match(predicament.facts[0]?.statement ?? '', /系统暂定阻碍/u)
  assert.doesNotMatch(
    JSON.stringify(predicament),
    /(?:门票|票务|手机|支付|工作人员|身份证|二维码|审批|手续)/u,
  )
  assert.doesNotThrow(() => validatePredicamentForConflictCore(
    reportSeed.activeSituation,
    activeSeed,
    core,
    predicament,
  ))
})

test('rejects a system hook that writes a process, result, or settled person state', () => {
  const cases: Array<{ name: string; change: (draft: StoryConflictCoreSystemDraft) => void }> = [
    {
      name: 'action chain',
      change: (draft) => { draft.directions![0].premise = '暂定：先找出便签来源再决定是否提交' },
    },
    {
      name: 'finished result',
      change: (draft) => { draft.directions![1].premise = '暂定：报告已经被处理完成' },
    },
    {
      name: 'settled person state',
      change: (draft) => { draft.directions![2].premise = '暂定：一位匿名人物已经离开' },
    },
    {
      name: 'invented deadline',
      change: (draft) => { draft.directions![2].tradeoff = '在两小时内提交，还是放弃这次机会' },
    },
  ]

  for (const { name, change } of cases) {
    const draft = createCreativeSparseSystemDraft()
    change(draft)
    assert.throws(
      () => validateSystemConflictCoreDraft(reportSeed.activeSituation, reportSeed, draft),
      /系统暂定设定需要收紧/,
      name,
    )
  }
})

test('keeps sparse system draft branches above scene-level detail', () => {
  const cases: Array<{ name: string; change: (draft: StoryConflictCoreSystemDraft) => void }> = [
    {
      name: 'ticket repurchase and cash outcome',
      change: (draft) => { draft.directions![0].tradeoff = '补齐凭证耗尽现金，还是保住现金' },
    },
    {
      name: 'inspector and credential workflow',
      change: (draft) => { draft.directions![1].premise = '暂定：工作人员要求出示身份证件' },
    },
    {
      name: 'identity confirmation and verification workflow',
      change: (draft) => {
        draft.directions![1].premise = '暂定：需要本人现场确认身份'
        draft.directions![1].tradeoff = '配合现场核验流程，还是暂不继续当前目标'
      },
    },
    {
      name: 'borrowing a credential and leaving contact details',
      change: (draft) => { draft.directions![1].tradeoff = '借用他人证件，还是留下联系方式' },
    },
    {
      name: 'reserved attraction outcome',
      change: (draft) => { draft.directions![2].tradeoff = '预约具体项目，还是放弃当前目标' },
    },
  ]

  for (const { name, change } of cases) {
    const draft = createSparseSystemDraft()
    change(draft)
    assert.throws(
      () => validateSystemConflictCoreDraft(sparseIdea, sparseSeed, draft),
      /具体资源、身份、支付、预约或流程/,
      name,
    )
  }
})

test('creates three grounded conflict cores when model core generation is exhausted', () => {
  const draft = createSparseSystemDraft()
  const fallback = createSystemDraftConflictCoreFallback({
    lockedGoal: sparseSeed.lockedGoal,
    systemDraft: draft,
  })

  assert.equal(fallback?.length, 3)
  assert.deepEqual(fallback?.map((core) => core.obstacle), draft.directions!.map((direction) => direction.premise))
  assert.deepEqual(fallback?.map((core) => core.tradeoff), draft.directions!.map((direction) => direction.tradeoff))
})

test('maps an allowed system hook into a conflict core without reinterpreting its mystery as fact', () => {
  const draft: StoryConflictCoreSystemDraft = {
    goal: '看演唱会',
    stake: '继续看演唱会需要承担一项取舍',
    constraint: '当前会有一个主要阻碍',
    origin: 'model',
    directions: [
      {
        label: '陌生警告',
        mechanismType: 'information-gap',
        premise: '暂定：门票背面写着“别进去，他在找你”',
        tradeoff: '先追究这句话，还是照原计划看演唱会',
      },
      {
        label: '认错身份',
        mechanismType: 'boundary-conflict',
        premise: '暂定：一个陌生人把青柠认成了另一个人',
        tradeoff: '顺着误认继续，还是当场否认它',
      },
      {
        label: '继续的代价',
        mechanismType: 'commitment-conflict',
        premise: '暂定：继续看演唱会会失去一件眼下不能替代的东西',
        tradeoff: '承担代价继续，还是保住它暂缓行动',
      },
    ],
  }
  const cores = createSystemDraftConflictCoreFallback({ lockedGoal: '看演唱会', systemDraft: draft })

  assert.deepEqual(cores?.map((core) => core.obstacle), draft.directions?.map((direction) => direction.premise))
  assert.match(cores?.[0]?.decisionFocus ?? '', /他在找你/u)
})

test('rejects a sparse system draft that turns tradeoffs into action scenes', () => {
  const cases: Array<{ name: string; change: (draft: StoryConflictCoreSystemDraft) => void }> = [
    {
      name: 'searching and alternative entry method',
      change: (draft) => { draft.directions![0].tradeoff = '先观察旧物再作决定，还是立刻作决定' },
    },
    {
      name: 'current location and movement instruction',
      change: (draft) => { draft.directions![1].premise = '暂定：当前位置无法直接继续当前目标' },
    },
    {
      name: 'companion binding workflow',
      change: (draft) => { draft.directions![2].tradeoff = '先回应眼前请求再继续，还是立刻继续' },
    },
  ]

  for (const { name, change } of cases) {
    const draft = createSparseSystemDraft()
    change(draft)
    assert.throws(
      () => validateSystemConflictCoreDraft(sparseIdea, sparseSeed, draft),
      /(?:完整行动流程|具体行动步骤、地点或执行方式)/,
      name,
    )
  }
})

test('allows abstract system draft mechanisms without inventing facts', () => {
  assert.doesNotThrow(() => validateSystemConflictCoreDraft(idea, seed, createValidDraft()))
})

test('allows supported commitment summaries and abstract causal language', () => {
  const draft = createValidDraft()
  draft.stake = '继续行动将触碰自己“不再联系”的承诺'
  draft.directions![0].tradeoff = '触碰自己“不再联系”的承诺，还是暂不送回耳环'
  draft.directions![1].tradeoff = '守住已有的“不再联系”约束，还是决定要不要送回耳环'
  draft.directions![2].tradeoff = '在仪式前决定要不要送回耳环，还是暂缓以保留选择空间'

  assert.doesNotThrow(() => validateSystemConflictCoreDraft(idea, seed, draft))
})

test('does not allow an abstract commitment to smuggle in concrete rules', () => {
  const draft = createValidDraft()
  draft.directions![1].tradeoff = '继续行动会触碰已有条款，还是先暂缓'

  assert.throws(
    () => validateSystemConflictCoreDraft(idea, seed, draft),
    /系统暂定设定需要收紧/,
  )
})

test('does not let a confirmed promise become another person\'s boundary', () => {
  const draft = createValidDraft()
  draft.directions![1].tradeoff = '对方不再联系的边界会被触碰'

  assert.throws(
    () => validateSystemConflictCoreDraft(idea, seed, draft),
    /系统暂定设定需要收紧/,
  )
})

test('keeps nearby mention of the friend from changing the promise subject', () => {
  const draft = createValidDraft()
  draft.stake = '朋友的耳环关联着自己的“不再联系”承诺'
  assert.doesNotThrow(() => validateSystemConflictCoreDraft(idea, seed, draft))

  const shifted = createValidDraft()
  shifted.stake = '朋友答应不再联系的承诺'
  assert.throws(
    () => validateSystemConflictCoreDraft(idea, seed, shifted),
    /系统暂定设定需要收紧/,
  )
})

test('rejects unsupported facts before a system draft can become evidence', () => {
  const cases: Array<{ name: string; change: (draft: StoryConflictCoreSystemDraft) => void }> = [
    {
      name: 'a new mandatory handling deadline',
      change: (draft) => { draft.constraint = '礼服明早要还，耳环必须在仪式前处理' },
    },
    {
      name: 'an unestablished ownership gap',
      change: (draft) => { draft.directions![0].premise = '耳环归属尚无确认方式' },
    },
    {
      name: 'an invented in-person promise',
      change: (draft) => { draft.directions![1].premise = '安澜曾当面承诺不再联系' },
    },
    {
      name: 'an invented permission boundary',
      change: (draft) => { draft.directions![1].tradeoff = '送回动作本身即构成一次未经许可的接触' },
    },
    {
      name: 'an invented psychological conclusion',
      change: (draft) => { draft.directions![0].tradeoff = '送回可能错认主人并暴露未放下的状态' },
    },
    {
      name: 'an invented delivery outcome',
      change: (draft) => { draft.directions![2].tradeoff = '拖延将失去对交付方式的自主选择权' },
    },
  ]

  for (const { name, change } of cases) {
    const draft = createValidDraft()
    change(draft)
    assert.throws(
      () => validateSystemConflictCoreDraft(idea, seed, draft),
      /系统暂定设定需要收紧/,
      name,
    )
  }
})

test('applies the grounding boundary across unrelated domains', () => {
  const { idea: otherIdea, seed: otherSeed } = examples.workplace
  const draft = createValidDraft()
  draft.goal = otherSeed.lockedGoal
  draft.stake = '继续行动可能触碰自己的“不再干预”承诺'
  draft.constraint = '项目交接前仍要决定是否提交'
  draft.directions = [
    {
      label: '未发送报告',
      mechanismType: 'information-gap',
      premise: '暂定：共享文件夹里发现一份未发送的报告，让是否提交仍需判断',
      tradeoff: '保留未发送的报告，还是在项目交接前决定是否提交',
    },
    {
      label: '不再干预',
      mechanismType: 'initiation-block',
      premise: '暂定：她答应不再干预原团队，让提交报告成为取舍',
      tradeoff: '守住不再干预原团队，还是决定是否提交',
    },
    {
      label: '交接时限',
      mechanismType: 'meaning-commitment',
      premise: '暂定：项目交接前让是否提交的决定改变后续取向',
      tradeoff: '在项目交接前决定是否提交，还是暂不继续',
    },
  ]
  assert.doesNotThrow(() => validateSystemConflictCoreDraft(otherIdea, otherSeed, draft))

  const unsupported = [
    '报告所有者是否仍需要它尚无确认',
    '提交需要一次未被邀请的干预',
    '报告将被交给其他团队',
  ]
  for (const value of unsupported) {
    const candidate = { ...draft, directions: draft.directions!.map((direction, index) => (
      index === 0 ? { ...direction, tradeoff: value } : direction
    )) }
    assert.throws(
      () => validateSystemConflictCoreDraft(otherIdea, otherSeed, candidate),
      /系统暂定设定需要收紧/,
      value,
    )
  }
})

const predicamentCore = {
  variationAxis: 'time' as const,
  preservedGoal: '想在仪式前决定要不要送回去',
  obstacle: '礼服明早要还',
  tradeoff: '在礼服明早要还的时限内决定是否送回去，还是暂不决定',
}

function createValidPredicament(): StoryPredicament {
  return {
    id: 'predicament-1',
    title: '归还前的决定',
    variationAxis: predicamentCore.variationAxis,
    preservedGoal: predicamentCore.preservedGoal,
    immediateSituation: '礼服口袋里的耳环被取出，安澜还没有决定是否送回去。',
    obstacle: predicamentCore.obstacle,
    tradeoff: predicamentCore.tradeoff,
    urgency: '礼服明早要还，决定仍须在这之前作出。',
    choice: '是现在作出是否送回去的决定，还是暂不决定。',
    plausibleCost: '无论作出还是暂缓决定，都要承担这项取舍。',
    approaches: [
      {
        id: 'approach-1',
        intent: '把耳环与礼服分开，暂时保留到归还前。',
        cost: '决定会继续悬而未决。',
      },
      {
        id: 'approach-2',
        intent: '现在作出是否送回耳环的决定。',
        cost: '作出决定会结束当前的暂缓状态。',
      },
    ],
    facts: [
      {
        id: 'fact-1',
        statement: '礼服明早要还。',
        source: 'predicament',
        mutability: 'fixed',
      },
      {
        id: 'fact-2',
        statement: '安澜尚未决定是否送回耳环。',
        source: 'predicament',
        mutability: 'changeable',
      },
    ],
    actions: [
      {
        id: 'action-1',
        intent: '作出是否送回耳环的决定。',
        preconditions: ['fact-1'],
        effects: ['fact-2'],
        source: 'user-choice',
      },
    ],
  }
}

test('allows a second-layer scene while keeping the conflict core intact', () => {
  assert.doesNotThrow(() => validatePredicamentForConflictCore(
    idea,
    seed,
    predicamentCore,
    createValidPredicament(),
  ))
})

test('allows an ordinary current scene reference while rejecting invented interaction history', () => {
  const currentScene = createValidPredicament()
  currentScene.immediateSituation = '当前现场中，安澜还没有决定是否送回耳环。'
  assert.doesNotThrow(() => validatePredicamentForConflictCore(
    idea,
    seed,
    predicamentCore,
    currentScene,
  ))

  const inventedHistory = createValidPredicament()
  inventedHistory.immediateSituation = '安澜曾当面答应不再联系，现在还没有决定是否送回耳环。'
  assert.throws(
    () => validatePredicamentForConflictCore(idea, seed, predicamentCore, inventedHistory),
    /具体困境.+未建立/,
  )
})

test('builds a grounded fallback predicament from the selected conflict core', () => {
  const fallback = createCoreAnchoredPredicamentFallback(seed, {
    id: 'conflict-core-1',
    title: '归还前的决定',
    ...predicamentCore,
  })

  assert.match(fallback.immediateSituation, /婚礼彩排前/u)
  assert.equal(fallback.approaches[0]?.intent, '在礼服明早要还的时限内决定是否送回去。')
  assert.equal(fallback.approaches[1]?.intent, '暂不决定。')
  assert.equal(fallback.approaches.length, 2)
  assert.equal(fallback.actions[0]?.effects[0], 'fact-decision')
  assert.doesNotThrow(() => validatePredicamentForConflictCore(idea, seed, predicamentCore, fallback))
})

test('turns a selected sparse system direction into a bounded predicament contract', () => {
  const core = createSystemDraftConflictCoreFallback({
    lockedGoal: sparseSeed.lockedGoal,
    systemDraft: createSparseSystemDraft(),
  })?.[0]
  assert.ok(core)

  const fallback = createCoreAnchoredPredicamentFallback(sparseSeed, core)
  const [firstDirection, secondDirection] = core.tradeoff
    .split('还是')
    .map((value) => value.trim().replace(/[，、。！？\s]+$/u, ''))
  assert.ok(fallback.immediateSituation.includes(core.obstacle.replace(/^暂定：/u, '')))
  assert.match(fallback.urgency, /继续「去游乐园」前/u)
  assert.equal(
    fallback.choice,
    `在${formatDirectionForExpectation(firstDirection)}与${formatDirectionForExpectation(secondDirection)}之间作出决定。`,
  )
  assert.deepEqual(fallback.approaches.map((approach) => approach.intent), [
    `${firstDirection}。`,
    `${secondDirection}。`,
  ])
  assert.deepEqual(fallback.approaches.map((approach) => approach.cost), [
    `选择${formatDirectionForExpectation(firstDirection)}后，需要承担这条方向带来的直接变化。`,
    `选择${formatDirectionForExpectation(secondDirection)}后，需要承担这条方向带来的直接变化。`,
  ])
  assert.match(fallback.facts[0]?.statement ?? '', /系统暂定阻碍/u)
  assert.doesNotThrow(() => validatePredicamentForConflictCore(sparseIdea, sparseSeed, core, fallback))
})

test('recognizes a model-proposed system direction as the selected branch contract', () => {
  const modelDraft = createSparseSystemDraft()
  modelDraft.origin = 'model'
  modelDraft.activeDirection = modelDraft.directions?.[1]
  const core = createSystemDraftConflictCoreFallback({
    lockedGoal: sparseSeed.lockedGoal,
    systemDraft: modelDraft,
  })?.[1]
  assert.ok(core)

  const fallback = createCoreAnchoredPredicamentFallback(sparseSeed, core)
  const [firstDirection, secondDirection] = core.tradeoff
    .split('还是')
    .map((value) => value.trim().replace(/[，、。！？\s]+$/u, ''))
  assert.deepEqual(fallback.approaches.map((approach) => approach.intent), [
    `${firstDirection}。`,
    `${secondDirection}。`,
  ])
  assert.ok(fallback.immediateSituation.includes(core.obstacle.replace(/^暂定：/u, '')))
  assert.doesNotThrow(() => validatePredicamentForConflictCore(sparseIdea, {
    ...sparseSeed,
    systemDraft: modelDraft,
  }, core, fallback))
})

test('gives each selected sparse hook a minimal scene and direct costs from its own tradeoff', () => {
  const cores = createSystemDraftConflictCoreFallback({
    lockedGoal: sparseSeed.lockedGoal,
    systemDraft: createSparseSystemDraft(),
  })
  assert.ok(cores)

  for (const core of cores) {
    const fallback = createCoreAnchoredPredicamentFallback(sparseSeed, core)
    const [firstDirection, secondDirection] = core.tradeoff
      .split('还是')
      .map((value) => value.trim().replace(/[，、。！？\s]+$/u, ''))
    assert.ok(fallback.immediateSituation.includes(core.obstacle.replace(/^暂定：/u, '')))
    assert.match(fallback.urgency, /继续「去游乐园」前/u)
    assert.deepEqual(fallback.approaches.map((approach) => approach.cost), [
      `选择${formatDirectionForExpectation(firstDirection)}后，需要承担这条方向带来的直接变化。`,
      `选择${formatDirectionForExpectation(secondDirection)}后，需要承担这条方向带来的直接变化。`,
    ])
    assert.doesNotMatch(
      JSON.stringify(fallback),
      /(?:购买|支付|核验|通讯|预约|分钟|小时|现金)/u,
    )
  }
})

test('keeps a bounded system branch usable when story-two-end generation needs a fallback', () => {
  const systemDraft = createSparseSystemDraft()
  systemDraft.activeDirection = systemDraft.directions?.[1]
  const activeSeed = {
    ...sparseSeed,
    systemDraft,
    worldMode: 'realistic-default' as const,
    expansionScope: 'keep-scale' as const,
    unknowns: ['外部细节'],
  }
  const core = createSystemDraftConflictCoreFallback(activeSeed)?.[1]
  assert.ok(core)

  const predicament = createCoreAnchoredPredicamentFallback(activeSeed, core)
  const options = createSystemDraftHeadTailFallback({
    seed: activeSeed,
    predicament,
    approach: predicament.approaches[0],
  })
  const machine = createNarrativeStateMachine({ maximumActions: 8, maximumFacts: 20 })
  const state = machine.createInitialState(activeSeed, predicament)

  assert.equal(options.length, 3)
  const selectedDirection = predicament.approaches[0]?.intent.replace(/[。！？]+$/u, '')
  assert.ok(selectedDirection)
  for (const option of options) {
    assert.match(option.opening, new RegExp(selectedDirection, 'u'))
    assert.match(option.climax, new RegExp(selectedDirection, 'u'))
    assert.equal(option.climaxActionId, 'action-decide')
    assert.doesNotMatch(
      JSON.stringify(option),
      /(?:门票|电子票|订单|手机|支付|工作人员|身份证|二维码|分钟|小时|现金)/u,
    )
    assert.doesNotThrow(() => machine.validateExpectedTransition(
      state,
      option.transition,
      option.climaxActionId,
      { statusCode: 502, code: 'INVALID_MODEL_OUTPUT' },
      'fallback transition should be valid',
    ))
  }
})

test('rejects invented durable details in a second-layer predicament', () => {
  const cases: Array<{ name: string; change: (predicament: StoryPredicament) => void }> = [
    {
      name: 'invented name and past gift history',
      change: (predicament) => {
        predicament.immediateSituation = '耳环是林薇毕业时送的那对，安澜正把它放在镜前。'
      },
    },
    {
      name: 'invented technical route',
      change: (predicament) => {
        predicament.approaches[1].intent = '用一次性虚拟号码发送短信，询问耳环如何处理。'
      },
    },
    {
      name: 'invented device availability',
      change: (predicament) => {
        predicament.facts[1].statement = '安澜手边有一台已开机、有信号的手机。'
      },
    },
    {
      name: 'invented external result',
      change: (predicament) => {
        predicament.plausibleCost = '耳环可能被他人发现并转交。'
      },
    },
    {
      name: 'invented psychological conclusion',
      change: (predicament) => {
        predicament.choice = '是为厘清心意松动承诺，还是继续回避。'
      },
    },
  ]

  for (const { name, change } of cases) {
    const predicament = createValidPredicament()
    change(predicament)
    assert.throws(
      () => validatePredicamentForConflictCore(idea, seed, predicamentCore, predicament),
      /具体困境.+未建立/,
      name,
    )
  }
})

test('rejects a narrative transition that leaves its declared effect unchanged', () => {
  const state: StoryNarrativeState = {
    revision: 0,
    facts: [{
      id: 'fact-decision',
      statement: '安澜尚未决定是否送回耳环。',
      source: 'predicament',
      mutability: 'changeable',
    }],
    actions: [],
    appliedTransitions: [],
  }
  const action: StoryAction = {
    id: 'action-decide',
    intent: '作出是否送回耳环的决定。',
    preconditions: [],
    effects: ['fact-decision'],
    source: 'generated',
  }
  const transition: StoryTransition = {
    actionId: action.id,
    consumedFacts: [],
    changedFacts: [{
      factId: 'fact-decision',
      statement: '安澜尚未决定是否送回耳环。',
    }],
    introducedFacts: [],
  }
  const machine = createNarrativeStateMachine({ maximumActions: 8, maximumFacts: 20 })

  assert.throws(
    () => machine.validateActionTransition(
      state,
      action,
      transition,
      { statusCode: 502, code: 'INVALID_MODEL_OUTPUT' },
      '状态推进无效。',
    ),
    /transition\.changedFacts 必须只更新 narrativeAction\.effects/,
  )
})

function createSelectedSparseTurnContext() {
  const systemDraft = createSparseSystemDraft()
  systemDraft.activeDirection = systemDraft.directions?.[1]
  const activeSeed = {
    ...sparseSeed,
    systemDraft,
    worldMode: 'realistic-default' as const,
    expansionScope: 'keep-scale' as const,
    unknowns: ['外部细节'],
  }
  const core = createSystemDraftConflictCoreFallback(activeSeed)?.[1]
  assert.ok(core)

  const predicament = createCoreAnchoredPredicamentFallback(activeSeed, core)
  const approach = predicament.approaches[0]
  const headTail = createSystemDraftHeadTailFallback({
    seed: activeSeed,
    predicament,
    approach,
  })[0]
  const machine = createNarrativeStateMachine({ maximumActions: 8, maximumFacts: 20 })
  const state = machine.createInitialState(activeSeed, predicament)

  return {
    machine,
    state,
    request: {
      idea: sparseIdea,
      seed: activeSeed,
      predicament,
      approach,
      headTail,
      mode: 'start' as const,
      history: [],
    },
  }
}

test('keeps selected system-draft story-turn fallbacks inside the established contract', () => {
  const { machine, request, state } = createSelectedSparseTurnContext()
  const turn = createSystemDraftStoryTurnFallback(request, state)

  assert.doesNotThrow(() => validateSystemDraftStoryTurnContinuation(request, turn))
  assert.equal(turn.options.length, 3)
  assert.doesNotMatch(
    JSON.stringify(turn),
    /(?:门票|票务|手机|消息|支付|工作人员|身份证|二维码|检票|闸机|审批|手续)/u,
  )
  for (const option of turn.options) {
    assert.doesNotThrow(() => machine.validateTurnOption(
      state,
      option,
      { statusCode: 502, code: 'INVALID_MODEL_OUTPUT' },
      'fallback turn option should be valid',
    ))
  }

  const selectedOption = turn.options[0]
  const continuedRequest = {
    ...request,
    mode: 'continue' as const,
    history: [{
      turnId: turn.id,
      phase: turn.phase,
      node: turn.node,
      conflict: turn.conflict,
      selectedOption,
    }],
  }
  const continuedState = machine.applyTransition(
    state,
    selectedOption.narrativeAction,
    selectedOption.transition,
  )
  const continuedTurn = createSystemDraftStoryTurnFallback(continuedRequest, continuedState)

  assert.doesNotThrow(() => validateSystemDraftStoryTurnContinuation(continuedRequest, continuedTurn))
  assert.notDeepEqual(
    continuedTurn.options.map((option) => option.action),
    turn.options.map((option) => option.action),
  )
  assert.match(continuedTurn.node.event, /已经完成上一项选择/u)
})

test('rejects unestablished detail categories throughout a system-draft story turn', () => {
  const cases: Array<{ name: string; change: (turn: StoryTurn) => void }> = [
    {
      name: 'device and unread message in the current event',
      change: (turn) => { turn.node.event = '青柠看着手机屏幕里未回复的消息。' },
    },
    {
      name: 'ticket verification in the conflict consequence',
      change: (turn) => { turn.conflict.consequence = '一张电子票需要在入口核验。' },
    },
    {
      name: 'service workflow in the question',
      change: (turn) => { turn.question = '要不要向工作人员提交申请？' },
    },
    {
      name: 'unestablished person status in an option consequence',
      change: (turn) => { turn.options[0].immediateConsequence = '对方一直没有到场，原有安排被迫停下。' },
    },
    {
      name: 'institutional workflow in an introduced fact',
      change: (turn) => {
        turn.options[0].transition.introducedFacts = [{
          id: 'fact-new-1',
          statement: '平台要求完成审批手续。',
          source: 'confirmed-action',
          mutability: 'changeable',
        }]
      },
    },
  ]

  for (const { name, change } of cases) {
    const { request, state } = createSelectedSparseTurnContext()
    const turn = createSystemDraftStoryTurnFallback(request, state)
    change(turn)
    assert.throws(
      () => validateSystemDraftStoryTurnContinuation(request, turn),
      /系统暂定分支后的逐步发展当前回合.+未经建立/u,
      name,
    )
  }
})

test('rejects direct reuse of an unselected direction in a system-draft story turn', () => {
  const { request, state } = createSelectedSparseTurnContext()
  const alternativeDirection = request.predicament.approaches[1]?.intent.replace(/[。！？]+$/u, '')
  assert.ok(alternativeDirection)

  for (const route of [
    `${alternativeDirection}。`,
    alternativeDirection,
  ]) {
    const turn = createSystemDraftStoryTurnFallback(request, state)
    turn.options[1].action = route
    turn.options[1].narrativeAction.intent = route

    assert.throws(
      () => validateSystemDraftStoryTurnContinuation(request, turn),
      new RegExp(`未选方向“${alternativeDirection}”`, 'u'),
      route,
    )
  }
})
