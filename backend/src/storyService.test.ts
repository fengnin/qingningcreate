import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  StoryAction,
  StoryConflictCoreSystemDraft,
  StoryNarrativeState,
  StoryPredicament,
  StoryTransition,
} from '../../shared/story-contract.js'
import { validatePredicamentForConflictCore, validateSystemConflictCoreDraft } from './storyService.js'
import { createNarrativeStateMachine } from './storyState.js'

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
        label: '信息未明',
        mechanismType: 'information-gap',
        premise: '暂定：完成目标所需的一项信息尚未确认',
        tradeoff: '在信息尚未确认时决定是否送回去，还是暂不继续',
      },
      {
        label: '启动受阻',
        mechanismType: 'initiation-block',
        premise: '暂定：目标行动的启动条件尚未确认',
        tradeoff: '在启动条件未确认时决定是否送回去，还是先暂缓',
      },
      {
        label: '取向取舍',
        mechanismType: 'meaning-commitment',
        premise: '暂定：作出这个决定会改变行动的取向',
        tradeoff: '决定是否送回去，还是暂缓以保留选择空间',
      },
    ],
  }
}

test('allows abstract system draft mechanisms without inventing facts', () => {
  assert.doesNotThrow(() => validateSystemConflictCoreDraft(idea, seed, createValidDraft()))
})

test('allows supported commitment summaries and abstract causal language', () => {
  const draft = createValidDraft()
  draft.stake = '继续行动将触碰自己“不再联系”的承诺'
  draft.directions![0].tradeoff = '不再主动联系的自我约束会被触碰'
  draft.directions![1].tradeoff = '继续行动会触碰已有约束，还是先暂缓'
  draft.directions![2].tradeoff = '这个取向一旦形成可能不可逆，还是暂缓以保留选择空间'

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
  draft.constraint = '交接前仍有一个决定窗口'
  draft.directions![0].tradeoff = '在信息尚未确认时决定是否提交，还是暂不继续'
  draft.directions![1].tradeoff = '在已有承诺下决定是否提交，还是先暂缓'
  draft.directions![2].tradeoff = '决定是否提交，还是暂缓以保留选择空间'
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
