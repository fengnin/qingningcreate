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
  getStorySessionSnapshot,
  startStoryCoCreation,
  updateSessionCurveBeat,
} from './storyService.js'
import {
  confirmProvisionalCurve,
  createProvisionalCurveFallback,
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

const reportSeed = {
  activeSituation: '周岚要提交报告',
  lockedGoal: '提交报告',
  lockedFacts: ['周岚要提交报告'],
}

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
  }

  try {
    const [first, second] = await Promise.all([
      startStoryCoCreation(request),
      startStoryCoCreation(request),
    ])
    assert.equal(first.storyId, second.storyId)
    assert.equal(first.revision, second.revision)
    const sequential = await startStoryCoCreation(request)
    assert.notEqual(sequential.storyId, first.storyId, 'a later deliberate start remains a new operation')

    const beat = first.curve.beats.find((candidate) => candidate.kind === 'trigger')!
    const saveRequest = {
      storyId: first.storyId,
      revision: first.revision,
      curveId: first.curve.id,
      beatId: beat.id,
      detail: '暂定：青柠必须先说明自己为何要去游乐园。',
    }
    const [savedFirst, savedSecond] = await Promise.all([
      updateSessionCurveBeat(saveRequest),
      updateSessionCurveBeat(saveRequest),
    ])
    assert.equal(savedFirst.revision, savedSecond.revision)
    assert.equal(savedFirst.curve.id, savedSecond.curve.id)
    const snapshot = getStorySessionSnapshot(first.storyId)
    assert.equal(snapshot.revision, savedFirst.revision)
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
      title: '游乐园门口',
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
  assert.equal(downstream.slice(1).some((detail) => detail.includes(authorEdit.replace(/^暂定：/u, ''))), false)
  assert.equal(downstream.some((detail) => /“[^”]*“[^”]*”[^”]*”/u.test(detail)), false)
  assert.doesNotMatch(downstream.join('\n'), /共同作品/u)
  assert.equal(new Set(downstream).size, downstream.length)
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
  assert.ok(seed.lockedFacts.includes(idea))
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

  assert.equal(fallback.origin, 'model')
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

  assert.equal(fallback.origin, 'model')
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
