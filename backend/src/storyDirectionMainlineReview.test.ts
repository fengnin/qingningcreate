import assert from 'node:assert/strict'
import test from 'node:test'
import { generateStoryPreparation } from './storyPreparation.js'
import { AppError } from './qwen.js'
import { outputShapeErrors } from './modelOutputSchema.js'
import { preparationOutputSchemas, preparationDirectionQualitySchema } from './storyOutputSchemas.js'
import { compileDirectionPlans } from './storyDirectionPlan.js'
import { directionConsequenceCatalog, parseDirectionConsequenceChecks } from './storyDirectionConsequenceReview.js'
import { parseDirectionLogicReview } from './storyDirectionLogicReview.js'
import { directionPlanSubsetSchema, parseDirectionCardReview, directionCardReviewSchema } from './storyDirectionCards.js'

const brief = { tones: [], dramaticForces: [], allowSystemNamedCharacters: false }
const pass = { checks: ['facts', 'causality', 'requirements', 'author-control', 'questions']
  .map(criterion => ({ criterion, passed: true, evidence: '结构测试桩，不证明语义审阅准确。' })), issues: [] }
const directionPlans = () => ({ plans: [0, 1, 2].map(i => ({ id: `d${i}`, difficulty: `第${i}种阻碍需要人物作出选择。`,
  options: [{ action: '继续争取原目标', consequence: '仍有机会推进，但结果尚待确认。' },
    { action: '接受改期并调整安排', consequence: '原计划可能延后，需要承担相应代价。' }],
  materialIds: ['m0'], preconditionIds: [], resultBasisIds: [] })) })
const supportedBranches = () => [0, 1].map(() => ({ action: '主角尝试', outcome: '仍待结果', goalEffect: 'attempted', mechanism: 'supported' }))
const logicPass = (plans: ReturnType<typeof directionPlans>['plans']) => plans.map(p => ({ id: p.id,
  branches: p.options.map((o, optionIndex) => ({ optionIndex, analysis: '中性格式测试桩，不证明审阅质量。', evidence: [o.action], verdict: 'supported' })) }))

async function withModel(reply: (stage: string, input: any) => unknown, run: () => Promise<void>) {
  const original = globalThis.fetch
  const saved = [process.env.DASHSCOPE_API_KEY, process.env.STORY_DISABLE_MODEL, process.env.STORY_DIRECTION_CONSEQUENCE_REVIEW]
  process.env.DASHSCOPE_API_KEY = 'stub'
  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.STORY_DIRECTION_CONSEQUENCE_REVIEW = 'true'
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), wireInput = JSON.parse(request.messages[1].content)
    const compact = request.response_format.json_schema.name === 'preparation-direction-card-review'
    const input = compact ? { ...wireInput, structuredProposal: { plans: wireInput.reviewPlans },
      proposal: compileDirectionPlans({ plans: wireInput.reviewPlans }, wireInput.reviewPlans.length) } : wireInput
    if (request.response_format.json_schema.name === 'preparation-directions') {
      assert.deepEqual(request.response_format.json_schema.schema, directionPlanSubsetSchema(input.repairIds))
    }
    if (request.response_format.json_schema.name === 'preparation-quality-review') {
      assert.deepEqual(input.structuredProposal, directionPlans(), 'review must retain both original option/consequence pairs')
    }
    let output: any = reply(compact ? 'preparation-quality-review' : request.response_format.json_schema.name, input)
    if (input.repairIds && output?.plans) output = { plans: output.plans.filter((p: any) => input.repairIds.includes(p.id)) }
    if (input.structuredProposal && output?.candidateChecks && output.actionChecks === undefined) output = { ...output,
      actionChecks: logicPass(input.structuredProposal.plans) }
    if (input.consequenceCatalog && output?.candidateChecks && output.consequenceChecks === undefined) output = { ...output,
      consequenceChecks: input.consequenceCatalog.map((e: any) => ({ id: e.id, resultStatus: 'uncertain', prerequisite: '', prerequisiteStatus: 'not-needed', verdict: 'supported', reason: '格式桩，不证明语义正确。' })) }
    if (compact && output?.candidateChecks) output = { cards: output.candidateChecks.map((c: any) => ({ id: c.id,
      branches: output.actionChecks.find((a: any) => a.id === c.id)?.branches.map((b: any, i: number) => ({ optionIndex: i,
        analysis: b.analysis, evidenceFields: ['action', 'consequence'],
        verdict: c.branches?.[i]?.mechanism === 'unsupported' || ['substituted', 'unaddressed'].includes(c.branches?.[i]?.goalEffect) ? 'unsupported' : b.verdict })),
      mainline: { verdict: ['substituted', 'unrelated'].includes(c.relation) ? 'unsupported' : 'supported', reason: c.reason },
      boundaries: { verdict: 'supported', reason: '相容' }, scope: { verdict: 'supported', reason: '相容' },
    })), diversity: { passed: true, repairIds: [], reason: '不同阻碍' } }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))
  }
  try { await run() } finally {
    globalThis.fetch = original
    ;['DASHSCOPE_API_KEY', 'STORY_DISABLE_MODEL', 'STORY_DIRECTION_CONSEQUENCE_REVIEW'].forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]
    })
  }
}

for (const idea of ['小雨想亲自把画送到学校。', '阿禾想参加合唱排练。', '林舟想证明自己完成过登山。']) {
  test(`per-card drift cannot be cancelled by passing aggregate checks: ${idea}`, async () => {
    let generations = 0, reviews = 0
    const progress: number[] = []
    await withModel((stage, input) => {
      if (stage === 'preparation-extraction') return { material: input.material.map((m: any) => ({ id: m.id, role: 'goal' })) }
      if (stage === 'preparation-character-intent') return { characterGoalIds: ['m0'], appealMaterialIds: [],
        mainlineGoals: [{ id: 'g0', materialIds: ['m0'] }], mainlineAnchors: [{ id: 'a0', kind: 'action', materialIds: ['m0'] }] }
      if (stage === 'preparation-directions') {
        assert.deepEqual(progress, generations === 0 ? [1] : [1, 2], 'generation starts after understanding; repairs remain in comparison')
        generations++
        if (generations === 2) assert.match(input.validationFailure, /d1 主线/)
        return directionPlans()
      }
      assert.equal(stage, 'preparation-quality-review', 'initial cards must not invoke deep projection')
      assert.deepEqual(progress, [1, 2], 'comparison starts only after candidates have been generated')
      reviews++
      return { ...pass, issues: reviews === 1 && idea.startsWith('小雨') ? ['d1 把另一任务冒充原目标。'] : [],
        candidateChecks: input.proposal.candidates.map((c: any) => ({ id: c.id,
        branches: supportedBranches(),
        pursuedGoal: idea, relation: reviews === 1 && c.id === 'd1' ? 'substituted' : 'pursues-goal',
        reason: reviews === 1 && c.id === 'd1' ? '此候选用另一任务冒充原目标。' : '仍服务作者原本的目标。' })) }
    }, async () => {
      const result = await generateStoryPreparation(idea, brief, completedNodes => progress.push(completedNodes))
      assert.equal(generations, 2)
      assert.equal(reviews, 2)
      assert.deepEqual(progress, [1, 2, 3])
      assert.ok(result.preparation!.candidates.every(c => !c.causalBridge))
    })
  })
}

for (const problem of ['unaddressed', 'substituted', 'unsupported']) {
  test(`branch problem ${problem} cannot be cancelled by an overall pass`, async () => {
    let generations = 0, reviews = 0
    await withModel((stage, input) => {
      if (stage === 'preparation-extraction') return { material: input.material.map((m: any) => ({ id: m.id, role: 'goal' })) }
      if (stage === 'preparation-character-intent') return { characterGoalIds: ['m0'], appealMaterialIds: [],
        mainlineGoals: [{ id: 'g0', materialIds: ['m0'] }], mainlineAnchors: [{ id: 'a0', kind: 'action', materialIds: ['m0'] }] }
      if (stage === 'preparation-directions') {
        generations++
        if (generations === 2) assert.match(input.validationFailure, /d1 分支2/)
        return directionPlans()
      }
      assert.equal(stage, 'preparation-quality-review')
      reviews++
      return { ...pass, candidateChecks: input.proposal.candidates.map((c: any) => ({ id: c.id, pursuedGoal: '把画交给学校', relation: 'pursues-goal', reason: '总评通过的测试桩。',
        branches: [
          { action: '人物尝试', outcome: '结果尚待确认', goalEffect: 'attempted', mechanism: 'supported' },
          { action: '人物求助', outcome: '另一人物得到不相关结果',
            goalEffect: reviews === 1 && c.id === 'd1' && problem !== 'unsupported' ? problem : 'attempted',
            mechanism: reviews === 1 && c.id === 'd1' && problem === 'unsupported' ? 'unsupported' : 'supported' },
        ] })) }
    }, async () => {
      await generateStoryPreparation('小雨想把画交给学校。', brief)
      assert.equal(generations, 2)
      assert.equal(reviews, 2)
    })
  })
}

test('duplicate per-card coverage retries the reviewer without rewriting direction cards', async () => {
  let generations = 0, reviews = 0
  await withModel((stage, input) => {
    if (stage === 'preparation-extraction') return { material: input.material.map((m: any) => ({ id: m.id, role: 'goal' })) }
    if (stage === 'preparation-character-intent') return { characterGoalIds: ['m0'], appealMaterialIds: [],
      mainlineGoals: [{ id: 'g0', materialIds: ['m0'] }], mainlineAnchors: [{ id: 'a0', kind: 'action', materialIds: ['m0'] }] }
    if (stage === 'preparation-directions') {
      generations++
      return directionPlans()
    }
    reviews++
    return { ...pass, candidateChecks: input.proposal.candidates.map((c: any) => ({ id: 'd0', pursuedGoal: '原目标', branches: supportedBranches(), relation: 'pursues-goal', reason: '合同测试桩。' })) }
  }, async () => {
    await assert.rejects(() => generateStoryPreparation('阿禾想参加合唱排练。', brief), (error: unknown) => error instanceof AppError
      && error.code === 'STORY_PREPARATION_INVALID_OUTPUT' && error.modelDiagnostic?.stage === 'preparation-direction-card-review:response-schema')
    assert.equal(generations, 1)
    assert.equal(reviews, 2)
  })
})

test('fresh generation rejects legacy payloads while old candidate decoding stays compatible', () => {
  const legacy = compileDirectionPlans(directionPlans())
  assert.ok(outputShapeErrors(legacy, preparationOutputSchemas.directionPlans).length)
  assert.equal(compileDirectionPlans(legacy), legacy)
})

test('structured review requires exactly two branch decisions; edited single scenes keep their existing contract', () => {
  const audit = { ...pass, actionChecks: logicPass([directionPlans().plans[0]!]), candidateChecks: [{ id: 'd0', pursuedGoal: '原目标', branches: supportedBranches(),
    relation: 'pursues-goal', reason: '格式测试桩。' }] }
  assert.deepEqual(outputShapeErrors(audit, preparationDirectionQualitySchema(['d0'], true)), [])
  audit.candidateChecks[0]!.branches.pop()
  assert.ok(outputShapeErrors(audit, preparationDirectionQualitySchema(['d0'], true)).length)
  const { actionChecks: _logic, ...editedAudit } = audit
  assert.deepEqual(outputShapeErrors(editedAudit, preparationDirectionQualitySchema(['d0'])), [])
})

test('the single causal verdict rejects a branch despite passing mainline checks', async () => {
  let generations = 0, reviews = 0
  await withModel((stage, input) => {
    if (stage === 'preparation-extraction') return { material: input.material.map((m: any) => ({ id: m.id, role: 'goal' })) }
    if (stage === 'preparation-character-intent') return { characterGoalIds: ['m0'], appealMaterialIds: [],
      mainlineGoals: [{ id: 'g0', materialIds: ['m0'] }], mainlineAnchors: [{ id: 'a0', kind: 'action', materialIds: ['m0'] }] }
    if (stage === 'preparation-directions') {
      generations++
      if (generations === 2) assert.match(input.validationFailure, /d1 分支1 因果/)
      return directionPlans()
    }
    reviews++
    const actionChecks = logicPass(input.structuredProposal.plans)
    if (reviews === 1) actionChecks[1]!.branches[0]!.verdict = 'unsupported'
    return { ...pass, candidateChecks: input.proposal.candidates.map((c: any) => ({ id: c.id, pursuedGoal: '原目标',
      branches: supportedBranches(), relation: 'pursues-goal', reason: '测试桩。' })),
      actionChecks }
  }, async () => {
    await generateStoryPreparation('小雨想把画交给学校。', brief)
    assert.equal(generations, 2)
    assert.equal(reviews, 2)
  })
})

test('consequence coverage preserves conditions and all text, rejecting omitted, invented and duplicate IDs', () => {
  const consequence = '如果对方同意，再委托交接；若实际归还完成，保管责任才结束。'
  const catalog = directionConsequenceCatalog([{ id: 'd0', options: [{ consequence }] }])
  assert.equal(catalog.map(e => e.text).join(''), consequence)
  assert.ok(catalog.length <= 3)
  assert.ok(catalog.every(e => e.consequence === consequence))
  const checks = catalog.map(e => ({ id: e.id, resultStatus: 'conditional', prerequisite: '对方同意并实际接收', prerequisiteStatus: 'explicit-condition', verdict: 'supported', reason: '条件完整保留。' }))
  assert.equal(parseDirectionConsequenceChecks(checks, catalog).length, catalog.length)
  for (const invalid of [checks.slice(1), [...checks.slice(1), checks[1]], checks.map((c, i) => i ? c : { ...c, id: 'invented' })]) {
    assert.throws(() => parseDirectionConsequenceChecks(invalid, catalog), (error: unknown) => error instanceof AppError && error.code === 'STORY_PREPARATION_INVALID_OUTPUT')
  }
})

test('an unconditional result cannot rely only on a planned event even when the model passes it', () => {
  const catalog = directionConsequenceCatalog([{ id: 'd0', options: [{ consequence: '保管责任终止。' }] }])
  const check = { id: catalog[0]!.id, resultStatus: 'asserted', prerequisite: '实际交付物品', prerequisiteStatus: 'only-planned', verdict: 'supported', reason: '模型总体放行的测试桩。' }
  assert.equal(parseDirectionConsequenceChecks([check], catalog)[0]!.verdict, 'unsupported')
  for (const prerequisiteStatus of ['satisfied-by-action', 'explicit-condition']) {
    assert.equal(parseDirectionConsequenceChecks([{ ...check, prerequisiteStatus }], catalog)[0]!.verdict, 'supported')
  }
  assert.equal(parseDirectionConsequenceChecks([{ ...check, resultStatus: 'planned' }], catalog)[0]!.verdict, 'supported')
})

test('unvalidated consequence audit is disabled by default and adds no production call', async () => {
  let calls = 0
  await withModel((stage, input) => {
    calls++
    if (stage === 'preparation-extraction') return { material: input.material.map((m: any) => ({ id: m.id, role: 'goal' })) }
    if (stage === 'preparation-character-intent') return { characterGoalIds: ['m0'], appealMaterialIds: [],
      mainlineGoals: [{ id: 'g0', materialIds: ['m0'] }], mainlineAnchors: [{ id: 'a0', kind: 'action', materialIds: ['m0'] }] }
    if (stage === 'preparation-directions') return directionPlans()
    assert.equal(stage, 'preparation-quality-review')
    assert.equal(input.consequenceCatalog, undefined)
    return { ...pass, candidateChecks: input.proposal.candidates.map((c: any) => ({ id: c.id, pursuedGoal: '原目标',
      branches: supportedBranches(), relation: 'pursues-goal', reason: '格式桩。' })) }
  }, async () => {
    delete process.env.STORY_DIRECTION_CONSEQUENCE_REVIEW
    const result = await generateStoryPreparation('阿禾想参加合唱排练。', brief)
    assert.equal(result.preparation!.candidates.length, 3)
    assert.equal(calls, 4)
  })
})

test('focused logic failure enters existing repair despite all other verdicts passing', async () => {
  let generations = 0, reviews = 0
  await withModel((stage, input) => {
    if (stage === 'preparation-extraction') return { material: input.material.map((m: any) => ({ id: m.id, role: 'goal' })) }
    if (stage === 'preparation-character-intent') return { characterGoalIds: ['m0'], appealMaterialIds: [],
      mainlineGoals: [{ id: 'g0', materialIds: ['m0'] }], mainlineAnchors: [{ id: 'a0', kind: 'action', materialIds: ['m0'] }] }
    if (stage === 'preparation-directions') {
      generations++
      if (generations === 2) assert.match(input.validationFailure, /d1 分支2 因果不成立/)
      return directionPlans()
    }
    reviews++
    const actionChecks = logicPass(input.structuredProposal.plans)
    if (reviews === 1) actionChecks[1]!.branches[1]!.verdict = 'unsupported'
    return { ...pass, actionChecks, candidateChecks: input.proposal.candidates.map((c: any) => ({ id: c.id,
      pursuedGoal: '原目标', branches: supportedBranches(), relation: 'pursues-goal', reason: '中性测试桩。' })) }
  }, async () => {
    await generateStoryPreparation('阿禾想参加合唱排练。', brief)
    assert.equal(generations, 2)
    assert.equal(reviews, 2)
  })
})

test('focused review validates full coverage, branch order and source-local evidence', () => {
  const plans = directionPlans().plans, valid = logicPass(plans)
  assert.deepEqual(parseDirectionLogicReview(valid, plans), [])
  for (const mutate of [
    (v: typeof valid) => v.pop(),
    (v: typeof valid) => { v[1]!.id = 'd0' },
    (v: typeof valid) => v[0]!.branches.reverse(),
    (v: typeof valid) => { v[0]!.branches[0]!.evidence = ['不存在的原文'] },
    (v: typeof valid) => { v[0]!.branches[0]!.evidence = [plans[0]!.options[1]!.action] },
  ]) {
    const broken = structuredClone(valid)
    mutate(broken)
    assert.throws(() => parseDirectionLogicReview(broken, plans), (e: unknown) => e instanceof AppError && e.code === 'STORY_PREPARATION_INVALID_OUTPUT')
  }
})

test('unavailable focused verdict becomes a content issue and regenerates the proposal', async () => {
  let generations = 0, reviews = 0
  await withModel((stage, input) => {
    if (stage === 'preparation-extraction') return { material: input.material.map((m: any) => ({ id: m.id, role: 'goal' })) }
    if (stage === 'preparation-character-intent') return { characterGoalIds: ['m0'], appealMaterialIds: [],
      mainlineGoals: [{ id: 'g0', materialIds: ['m0'] }], mainlineAnchors: [{ id: 'a0', kind: 'action', materialIds: ['m0'] }] }
    if (stage === 'preparation-directions') { generations++; return directionPlans() }
    reviews++
    const actionChecks = logicPass(input.structuredProposal.plans)
    actionChecks[0]!.branches[0]!.verdict = 'uncertain'
    return { ...pass, actionChecks, candidateChecks: input.proposal.candidates.map((c: any) => ({ id: c.id,
      pursuedGoal: '原目标', branches: supportedBranches(), relation: 'pursues-goal', reason: '格式桩。' })) }
  }, async () => {
    await assert.rejects(() => generateStoryPreparation('阿禾想参加合唱排练。', brief), (e: unknown) => e instanceof AppError
      && e.code === 'STORY_PREPARATION_QUALITY_FAILED')
    assert.equal(generations, 2)
    assert.equal(reviews, 2)
  })
})
