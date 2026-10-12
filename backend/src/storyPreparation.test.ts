import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError } from './qwen.js'
import { acceptPreparation, activePreparationMaterial, framePreparationSources, generateStoryPreparation, generateCurveFromPreparation, parsePreparationMaterial, parsePreparationCandidates, parsePreparationReview, preparationReferenceContract, reviseStoryPreparation } from './storyPreparation.js'
import { confirmProvisionalCurve, materializeConfirmedCurve, parseCreativeBrief } from './storyCoCreation.js'
import { requiredDesignProposalIds } from './storyDesignReview.js'
import { preserveRequirementRoles, preparationSources, reviewPreparationUncertainty } from './storyPreparation.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'

const source = { id: 'author-input', text: '方屿想核对书单；逐项计数能发现数量差异；计数不改动原书；没有期限；差异原因尚未确定。' }
const material = framePreparationSources([source]).map((m, i) => ({ ...m, role: (i === 0 ? 'goal' : i === 4 ? 'unknown' : 'condition') as 'goal' | 'unknown' | 'condition' }))
const classification = { material: material.map(({ id, role }) => ({ id, role })) }
const qualityPass = { checks: ['facts', 'causality', 'requirements', 'author-control', 'questions'].map(criterion => ({ criterion, passed: true, evidence: '测试用审阅证据；不作为实际内容验收。' })), issues: [] }
const candidate = { id: 'count', action: '方屿逐项计数并核对书单。', materialIds: ['m0'], preconditionIds: ['m1','m2'], possibleResult: '若完成逐项计数，可能发现书单与实物数量差异；原因仍未知。', resultBasisIds: ['m1'], unknownIds: [] }
const directions = [
  { ...candidate, id: 'c0' },
  { ...candidate, id: 'c1', action: '方屿先和同伴分组核对书单，发现两人对分类的理解不同，决定重新商定分类。', possibleResult: '重新分类后，两人可能找到数量差异的来源，并保留尚未确定的原因。' },
  { ...candidate, id: 'c2', action: '方屿从实物清点入手，遇到书单顺序不一致，决定按书架位置重新对应。', possibleResult: '对应完成后，可能缩小差异范围，仍需继续查明原因。' },
]
const brief = { tones: ['growth' as const], dramaticForces: [], allowSystemNamedCharacters: false }
const code = (name: string) => (e: unknown) => e instanceof AppError && e.code === name

test('source labels never turn a model unknown into a fact by keyword matching', () => {
  const settings = ['一幅画的名字贴错了。', '另一幅画还在同学手里。', '过河方式尚未确定。'].map((quote, i) => ({ id: `m${i}`, sourceId: 'author-setting', role: 'unknown' as const, quote }))
  assert.deepEqual(preserveRequirementRoles(settings).map(m => m.role), ['unknown', 'unknown', 'unknown'])
  assert.ok(settings.every(m => m.role === 'unknown'))
})

test('author note is preserved as a first-class creative requirement source', () => {
  const sources = preparationSources('青柠想去游乐园玩。', {
    tones: [], dramaticForces: [], allowSystemNamedCharacters: false,
    note: '最后让青柠主动承认自己记错了。',
  })
  assert.deepEqual(sources.at(-1), { id: 'author-note', text: '最后让青柠主动承认自己记错了。' })
  assert.deepEqual(preparationSources('青柠想去游乐园玩。', {
    tones: [], dramaticForces: [], allowSystemNamedCharacters: false,
  }), [{ id: 'author-input', text: '青柠想去游乐园玩。' }])
})

test('framing keeps distinct comma clauses available for separate roles', () => {
  const source = [{ id: 'author-setting', text: '一幅画的名字贴错了，另一幅画还在同学手里。寄信还是当面送，我暂时不选。' }]
  assert.deepEqual(framePreparationSources(source).map(m => m.quote), [
    '一幅画的名字贴错了，', '另一幅画还在同学手里。', '寄信还是当面送，', '我暂时不选。',
  ])
})

test('uncertainty review uses cross-clause evidence without inventing answers or accepting malformed corrections', async () => {
  const sources = [{ id: 'author-setting', text: '我还不知道父亲住在哪里。寄信还是当面送，我暂时不选。一个包裹在门边。同行者由系统设计。' }]
  const framed = framePreparationSources(sources).map(m => ({ ...m, role: 'unknown' as const }))
  const originalFetch = globalThis.fetch, key = process.env.DASHSCOPE_API_KEY, disabled = process.env.STORY_DISABLE_MODEL
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
    assert.deepEqual(input.sources, sources)
    const output = ++calls === 1 ? { decisions: [{ id: 'm0', role: 'fact', evidenceIds: [] }] } : {
      decisions: framed.map(m => ({ id: m.id, role: m.id === 'm3' ? 'fact' : m.id === 'm4' ? 'condition' : 'unknown', evidenceIds: [m.id] })) }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))
  }
  try {
    const result = await reviewPreparationUncertainty(sources, framed)
    assert.equal(calls, 2)
    assert.deepEqual(result.map(m => m.role), ['unknown','unknown','unknown','fact','condition'])
    assert.deepEqual(result.map(m => m.quote), framed.map(m => m.quote))
    assert.ok(framed.every(m => m.role === 'unknown'))
  } finally {
    globalThis.fetch = originalFetch
    if (key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = key
    if (disabled === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = disabled
  }
})

test('uncertainty review cannot turn neighbouring author expectations into facts', async () => {
  const sources = [{ id: 'author-input', text: '希望两人在雨夜逐渐信任。主角还没定。' }]
  const material = framePreparationSources(sources).map((m, i) => ({ ...m, role: i === 0 ? 'condition' as const : 'unknown' as const }))
  const originalFetch = globalThis.fetch, key = process.env.DASHSCOPE_API_KEY, disabled = process.env.STORY_DISABLE_MODEL
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decisions: [
    { id: 'm0', role: 'fact', evidenceIds: ['m0'] }, { id: 'm1', role: 'unknown', evidenceIds: ['m1'] },
  ] }) } }] }))
  try {
    const result = await reviewPreparationUncertainty(sources, material)
    assert.deepEqual(result.map(m => m.role), ['condition', 'unknown'])
    assert.deepEqual(result.map(m => m.quote), material.map(m => m.quote))
  } finally {
    globalThis.fetch = originalFetch
    if (key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = key
    if (disabled === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = disabled
  }
})

test('optional story requirements survive request parsing without rewriting quotes; malformed values are rejected', () => {
  assert.deepEqual(parseCreativeBrief(brief), brief)
  const storyRequirements = { setting: '青柠怕高。\n同行的是姐姐。', direction: '从争执到理解。', boundaries: '不坐过山车。' }
  assert.deepEqual(parseCreativeBrief({ ...brief, storyRequirements }).storyRequirements, storyRequirements)
  assert.equal(parseCreativeBrief({ ...brief, storyRequirements: { boundaries: '  ' } }).storyRequirements, undefined)
  for (const invalid of [{ boundaries: '长'.repeat(241) }, { boundaries: 42 }, { unknown: '不支持' }, []]) {
    assert.throws(() => parseCreativeBrief({ ...brief, storyRequirements: invalid }), code('INVALID_REQUEST'))
  }
})

test('author requirements reach composition and review as quoted sources; edits replace prior requirements', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  let expectedBoundary = '不改原题。'
  const observedStages = new Set<string>()
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), prompt = request.messages[0].content as string
    const input = JSON.parse(request.messages[1].content)
    assert.equal(input.sources.find((s: { id: string }) => s.id === 'author-boundaries').text, expectedBoundary)
    observedStages.add(prompt)
    if (prompt.includes('先整理作者材料')) {
      // Deliberately misclassify author wishes and boundaries as character goals.
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ material: input.material.map((m: { id: string; sourceId: string }) => ({ id: m.id, role: m.sourceId === 'author-setting' ? 'fact' : 'goal' })) }) } }] }))
    }
    if (prompt.includes('从作者的想法提出恰好三种') || prompt.includes('审查故事提案质量')) {
      for (const sourceId of ['author-direction', 'author-boundaries']) {
        assert.ok(input.material.some((m: { sourceId: string; role: string }) => m.sourceId === sourceId && m.role === 'condition'))
      }
    }
    const staged = stagedFixture(init)
    if (staged) return staged
    const output = prompt.includes('核对人物当下意图') ? { characterGoalIds: ['m0'] } : prompt.includes('从作者的想法提出恰好三种') ? { candidates: directions, questions: [] } : qualityPass
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))
  }
  try {
    const withRequirements = { ...brief, storyRequirements: { setting: '同学拿着画。', direction: '恢复信任。', boundaries: expectedBoundary } }
    const first = await generateStoryPreparation('方屿想布好画展。', withRequirements)
    assert.equal(first.preparation!.sources.length, 4)
    assert.equal(first.preparation!.executed, false)
    expectedBoundary = '不碰同学的画。'
    const edited = await generateStoryPreparation('方屿想布好画展。', { ...withRequirements, storyRequirements: { ...withRequirements.storyRequirements, boundaries: expectedBoundary } })
    assert.equal(edited.brief.storyRequirements!.boundaries, expectedBoundary)
    assert.ok(!edited.preparation!.material.some(m => m.quote === '不改原题。'))
    for (const stage of ['从作者的想法提出恰好三种', '审查故事提案质量']) assert.ok([...observedStages].some(p => p.includes(stage)))
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

// Legacy contract counters below count their original phases only. Dedicated
// storySceneDraft tests verify staged ordering, retries and invalidation.
function stagedFixture(init?: RequestInit): Response | undefined {
  const request = JSON.parse(String(init?.body)), prompt = request.messages[0].content as string
  const input = JSON.parse(request.messages[1].content)
  let output: unknown
  if (prompt.includes('核对作者未知范围')) output = { decisions: input.reviewIds.map((id: string) => ({ id, role: input.disputedIds.includes(id) ? 'unknown' : 'condition', evidenceIds: [id] })) }
  else if (prompt.includes('理解故事任务')) output = { goal: '核对书单并保留期限等条件。', tension: '数量有差异。', focusIds: ['m0'] }
  else if (prompt.includes('完整小场景构思')) output = { attempt: { ...(input.authorAction ? {} : { action: input.rejectedCandidates.length ? '方屿把书单分组后交叉核对。' : candidate.action }), materialIds: candidate.materialIds, preconditionIds: candidate.preconditionIds },
    development: { change: '可能发现数量差异。', response: '方屿再与同伴核对。', resultBasisIds: ['m1'] } }
  else if (prompt.includes('独立核对短场景骨架')) output = { checks: ['boundaries','causality','state','scope'].map(criterion => ({ criterion, passed: true, evidence: '分步合同桩，非内容验收。' })), issues: [] }
  else return undefined
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 })
}

test('new protocol references cannot leak into either story prose or author questions', () => {
  for (const action of ['依据 m0 她开始计数。', '提议：带上罗盘（m0/m1隐含物）。']) {
    assert.throws(() => parsePreparationCandidates({ candidates: [{ ...candidate, action }], questions: [] }, material), /内部引用/)
  }
  assert.throws(() => parsePreparationCandidates({ candidates: [], questions: [{ id: 'q', question: '请确认 sourceFacts 中 m4 的结果。', materialIds: ['m4'] }] }, material), /内部字段/)
})

test('an author theme with explicitly undecided characters cannot be promoted into a character action', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const idea = '想写轻松的告别故事。人物和告别对象没定。'
  let attempts = 0
  globalThis.fetch = async (_url, init) => {
    const staged = stagedFixture(init); if (staged) return staged
    const request = JSON.parse(String(init?.body)), input = JSON.parse(request.messages[1].content)
    let output: unknown
    if (request.messages[0].content.includes('先整理作者材料')) {
      output = { material: input.material.map((m: { id: string }, i: number) => ({ id: m.id, role: i ? 'unknown' : 'condition' })) }
    } else if (request.messages[0].content.includes('核对人物当下意图')) {
      output = { characterGoalIds: [] }
    } else if (request.messages[0].content.includes('最小行动候选')) {
      attempts++
      assert.match(input.requiredResponse, /candidates=\[\]/)
      output = attempts === 1 ? { candidates: [{ ...candidate, materialIds: ['m0'], preconditionIds: [], resultBasisIds: ['m0'] }], questions: [] }
        : { candidates: [], questions: [{ id: 'choose-goal', question: '你想写谁向什么告别？比如搬家的室友，或将退休的店主。', materialIds: ['m1'] }] }
    } else output = qualityPass
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 })
  }
  try {
    const curve = await generateStoryPreparation(idea, brief)
    assert.equal(attempts, 2)
    assert.deepEqual(curve.preparation!.candidates, [])
    assert.equal(curve.preparation!.questions.length, 1)
    assert.equal(curve.preparation!.executed, false)
    assert.deepEqual(curve.beats, [])
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of [['DASHSCOPE_API_KEY', env.key], ['STORY_DISABLE_MODEL', env.disable]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value }
  }
})

test('independent intent check recovers an explicit goal missed by the first classifier', async () => {
  const originalFetch = globalThis.fetch
  const key = process.env.DASHSCOPE_API_KEY, disabled = process.env.STORY_DISABLE_MODEL
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  let checked = false
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), input = JSON.parse(request.messages[1].content), prompt = request.messages[0].content
    let output: unknown
    if (prompt.includes('先整理作者材料')) output = { material: input.material.map((m: { id: string }) => ({ id: m.id, role: 'condition' })) }
    else if (prompt.includes('核对人物当下意图')) { checked = true; output = { characterGoalIds: ['m0'] } }
    else if (prompt.includes('从作者的想法提出恰好三种')) {
      assert.ok(checked)
      output = { candidates: directions.map((c, i) => ({ ...c, id: `d${i}`, materialIds: ['m0'], preconditionIds: [], resultBasisIds: ['m0'] })), questions: [] }
    } else output = qualityPass
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))
  }
  try {
    const curve = await generateStoryPreparation('青柠去游乐园玩', brief)
    assert.equal(curve.preparation!.material[0]?.role, 'goal')
    assert.equal(curve.preparation!.candidates.length, 3)
    assert.deepEqual(curve.preparation!.questions, [])
  } finally {
    globalThis.fetch = originalFetch
    if (key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = key
    if (disabled === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = disabled
  }
})

test('quote validation distinguishes absent source from verbatim drift without normalizing evidence', () => {
  const sources = [{ id: 's', text: '甲有两件物品，没有期限。' }]
  const item = { id: 'm', role: 'fact', sourceId: 's', quote: '甲有两件物品。' }
  for (const quote of [item.quote, '甲有三件物品', '甲有物品', '甲有两件物品没有期限', '甲有两件物品\u200b']) {
    assert.throws(() => parsePreparationMaterial({ material: [{ ...item, quote }] }, sources),
      (e: unknown) => e instanceof AppError && e.message.includes('material[0].quote'))
  }
  assert.throws(() => parsePreparationMaterial({ material: [{ ...item, sourceId: 'missing' }] }, sources),
    (e: unknown) => e instanceof AppError && e.message.includes('material[0].sourceId'))
})

test('independent intent check demotes an author ending misclassified as a character goal and preserves unknowns', async () => {
  const originalFetch = globalThis.fetch
  const savedKey = process.env.DASHSCOPE_API_KEY, savedDisable = process.env.STORY_DISABLE_MODEL
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const idea = '想让两个陌生人最后成为朋友。人物当前想做什么还没定。'
  let checked = false
  globalThis.fetch = async (_url, init) => {
    const staged = stagedFixture(init); if (staged) return staged
    const request = JSON.parse(String(init?.body)), input = JSON.parse(request.messages[1].content), prompt = request.messages[0].content
    let output: unknown
    if (prompt.includes('先整理作者材料')) output = { material: input.material.map((m: { id: string }, i: number) => ({ id: m.id, role: i ? 'unknown' : 'goal' })) }
    else if (prompt.includes('核对人物当下意图')) {
      checked = true
      assert.ok(input.material.every((m: object) => !('role' in m)))
      output = { characterGoalIds: [] }
    } else if (prompt.includes('最小行动候选')) {
      assert.ok(checked)
      assert.match(input.requiredResponse, /candidates=\[\]/)
      output = { candidates: [], questions: [{ id: 'choose', question: '其中一个人眼下想完成什么事？', materialIds: ['m1'] }] }
    } else output = qualityPass
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))
  }
  try {
    const curve = await generateStoryPreparation(idea, brief)
    assert.deepEqual(curve.preparation!.material.map(m => m.role), ['condition', 'unknown'])
    assert.equal(curve.preparation!.sources[0]!.text, idea)
    assert.deepEqual(curve.preparation!.candidates, [])
    assert.equal(curve.preparation!.executed, false)
  } finally {
    globalThis.fetch = originalFetch
    if (savedKey === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = savedKey
    if (savedDisable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = savedDisable
  }
})

test('classification cannot rewrite original slices, retries once and never falls back', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  let calls = 0
  const wrong = { material: material.map((m, i) => i === 0 ? { ...m, quote: m.quote + '。' } : m) }
  let first: unknown = wrong, second: unknown = classification
  let transportFailure = false
  globalThis.fetch = async (_url, init) => {
    const staged = stagedFixture(init); if (staged) return staged
    calls++
    const input = JSON.parse(String(init?.body))
    const user = JSON.parse(input.messages[1].content)
    if (user.validationFailure) {
      assert.deepEqual(user.sources, [source])
      assert.deepEqual(user.previousOutput, first)
      assert.equal(typeof user.validationFailure, 'string')
      if (transportFailure) return new Response(JSON.stringify({ error: { message: 'invalid request' } }), { status: 400 })
    }
    const output = input.messages[0].content.includes('核对人物当下意图') ? { characterGoalIds: ['m0'] } : input.messages[0].content.includes('审查故事提案质量') ? qualityPass : input.messages[0].content.includes('从作者的想法提出恰好三种') ? { candidates: directions, questions: [] } : user.validationFailure ? second : first
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 })
  }
  try {
    const before = structuredClone(wrong)
    const curve = await generateStoryPreparation(source.text, brief)
    assert.equal(calls, 5)
    assert.deepEqual(curve.preparation!.material, material)
    assert.deepEqual(wrong, before)
    for (const output of [wrong, { material: classification.material.slice(0, 2) }, { material: classification.material.map(m => ({ ...m, id: 'missing' })) }]) {
      calls = 0; second = output
      await assert.rejects(() => generateStoryPreparation(source.text, brief), code('STORY_PREPARATION_INVALID_OUTPUT'))
      assert.equal(calls, 2)
    }
    calls = 0; first = { material: material.map(m => ({ ...m, sourceId: 'missing' })) }
    await assert.rejects(() => generateStoryPreparation(source.text, brief), code('STORY_PREPARATION_INVALID_OUTPUT'))
    assert.equal(calls, 2)
    calls = 0; first = wrong; transportFailure = true
    await assert.rejects(() => generateStoryPreparation(source.text, brief), (e: unknown) => e instanceof AppError && e.code !== 'STORY_PREPARATION_INVALID_OUTPUT')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('extraction preserves conditions, negative wording and unknowns; rejects invented or omitted source material', () => {
  assert.deepEqual(parsePreparationMaterial({ material }, [source]), material)
  assert.throws(() => parsePreparationMaterial({ material: material.slice(0, 3) }, [source]), code('STORY_PREPARATION_INVALID_OUTPUT'))
  assert.throws(() => parsePreparationMaterial({ material: [{ ...material[0], quote: '已经核对书单' }] }, [source]), code('STORY_PREPARATION_INVALID_OUTPUT'))
  const unicode = [{ id: 's', text: '🛶没有期限。' }]
  assert.equal(parsePreparationMaterial({ material: [{ id: 'm', role: 'fact', sourceId: 's', quote: unicode[0]!.text }] }, unicode).length, 1)
})

test('framing keeps conjunctions, punctuation and surrogate pairs without inventing content', () => {
  for (const input of ['甲想出门，而乙不愿意；原因未知。', '🛶'.repeat(180), '短句，'.repeat(80)]) {
    const frames = framePreparationSources([{ id: 'source', text: input }])
    assert.equal(frames.map(f => f.quote).join(''), input)
    assert.ok(frames.length <= 24)
    assert.ok(frames.every(f => f.quote.length <= 240 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(f.quote)))
    assert.equal(new Set(frames.map(f => f.id)).size, frames.length)
  }
})

test('model cannot replace a material ID with a source ID', async () => {
  const originalFetch = globalThis.fetch
  const savedKey = process.env.DASHSCOPE_API_KEY, savedDisable = process.env.STORY_DISABLE_MODEL
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const collision = { material: classification.material.map((m, i) => i ? m : { ...m, id: source.id }) }
  let extractionCalls = 0
  globalThis.fetch = async (_url, init) => {
    const staged = stagedFixture(init); if (staged) return staged
    const request = JSON.parse(String(init?.body)), user = JSON.parse(request.messages[1].content)
    const prompt = request.messages[0].content
    let output: unknown
    if (prompt.includes('先整理作者材料')) {
      extractionCalls++
      if (extractionCalls === 2) {
        assert.match(user.validationFailure, /固定材料 ID/)
        assert.deepEqual(user.sources, [source])
        assert.deepEqual(user.previousOutput, collision)
      }
      output = extractionCalls === 1 ? collision : classification
    } else output = prompt.includes('核对人物当下意图') ? { characterGoalIds: ['m0'] } : prompt.includes('审查故事提案质量') ? qualityPass : { candidates: directions, questions: [] }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))
  }
  try {
    const result = await generateStoryPreparation(source.text, brief)
    assert.equal(extractionCalls, 2)
    assert.deepEqual(result.preparation!.material, material)
  } finally {
    globalThis.fetch = originalFetch
    if (savedKey === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = savedKey
    if (savedDisable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = savedDisable
  }
})

test('a proposed fictional detail cannot become a required author fact check', () => {
  const questions = [{ id: 'new-setting', question: '新设定的钥匙是谁留下的？', materialIds: ['m0'] }]
  assert.throws(() => parsePreparationCandidates({ candidates: [{ ...candidate, unknownIds: ['new-setting'] }], questions }, material),
    (e: unknown) => e instanceof AppError && e.message.includes('作者保留的未知'))
  const actualUnknown = [{ ...questions[0]!, materialIds: ['m4'] }]
  assert.equal(parsePreparationCandidates({ candidates: [{ ...candidate, unknownIds: ['new-setting'] }], questions: actualUnknown }, material).candidates.length, 1)
})

test('content rejection gets one model revision and stays distinct from structural or transport failure', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  let proposals = 0, reviews = 0
  globalThis.fetch = async (_url, init) => {
    const staged = stagedFixture(init); if (staged) return staged
    const input = JSON.parse(String(init?.body)), user = JSON.parse(input.messages[1].content)
    const prompt = input.messages[0].content
    let output: unknown = prompt.includes('核对人物当下意图') ? { characterGoalIds: ['m0'] } : classification
    if (prompt.includes('从作者的想法提出恰好三种')) {
      proposals++
      if (proposals === 2) assert.match(user.validationFailure, /内容审阅/)
      output = { candidates: directions, questions: [] }
    } else if (prompt.includes('审查故事提案质量')) {
      reviews++
      output = { ...qualityPass, checks: qualityPass.checks.map(c => c.criterion === 'causality' ? { ...c, passed: false, evidence: '发展只复述原目标，没有具体事件。' } : c), issues: [] }
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 })
  }
  try {
    await assert.rejects(() => generateStoryPreparation(source.text, brief), code('STORY_PREPARATION_QUALITY_FAILED'))
    assert.equal(proposals, 2)
    assert.equal(reviews, 2)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('coverage recovery preserves omitted promises; rejection and revised action remain future design', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  let calls = 0
  const authorAction = '方屿先把书单交给同伴核对。'
  let tamperAuthorAction = false, tamperCalls = 0
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (tamperAuthorAction && body.messages[0].content.includes('完整小场景构思')) {
      tamperCalls++
      const staged = stagedFixture(init)!
      const envelope = await staged.json()
      const output = JSON.parse(envelope.choices[0].message.content)
      output.attempt.action = '模型试图改写作者行动'
      envelope.choices[0].message.content = JSON.stringify(output)
      return new Response(JSON.stringify(envelope))
    }
    const staged = stagedFixture(init); if (staged) return staged
    calls++
    const input = JSON.parse(String(init?.body))
    const user = JSON.parse(input.messages[1].content)
    let output: unknown
    if (input.messages[0].content.includes('核对人物当下意图')) output = { characterGoalIds: ['m0'] }
    else if (input.messages[0].content.includes('审查故事提案质量')) output = qualityPass
    else if (input.messages[0].content.includes('从作者的想法提出恰好三种')) {
      assert.deepEqual(user.material, material)
      if (user.rejectedCandidates.length) assert.ok(user.rejectedCandidates.some((c: { action: string }) => c.action === candidate.action))
      output = { candidates: user.rejectedCandidates.length ? directions.map((c, i) => ({ ...c, action: `另一版方向${i}：${c.action}` })) : directions, questions: [] }
    } else if (user.validationFailure) {
      assert.match(user.validationFailure, /覆盖全部固定材料/)
      assert.deepEqual(user.sources, [source])
      output = classification
    } else output = { material: classification.material.slice(0, 2) }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 })
  }
  try {
    const curve = await generateStoryPreparation(source.text, brief)
    assert.equal(calls, 5)
    const rejected = await reviseStoryPreparation(curve, 'reject', curve.preparation!.candidates[0]!.id)
    assert.equal(curve.preparation!.candidates.length, 3)
    assert.equal(rejected.preparation!.candidates.length, 2)
    assert.throws(() => acceptPreparation(rejected.preparation!, [candidate.id]), code('INVALID_REQUEST'))
    const restored = JSON.parse(JSON.stringify(rejected))
    const regenerated = await reviseStoryPreparation(restored, 'regenerate')
    assert.notEqual(regenerated.preparation!.candidates[0]!.action, candidate.action)
    const revised = await reviseStoryPreparation(regenerated, 'revise', 'c0', authorAction)
    assert.equal(revised.preparation!.candidates[0]!.action, authorAction)
    assert.equal(revised.preparation!.candidates.length, 3)
    assert.equal(revised.preparation!.executed, false)
    assert.equal(revised.preparation!.status, 'needs-review')
    assert.deepEqual(revised.preparation!.material, material)
    assert.notEqual(revised.preparation!.candidates[0]!.possibleResult, candidate.possibleResult)
    tamperAuthorAction = true
    const before = structuredClone(regenerated), callsBefore = calls
    await assert.rejects(() => reviseStoryPreparation(regenerated, 'revise', 'c0', authorAction), code('STORY_PREPARATION_INVALID_OUTPUT'))
    assert.equal(tamperCalls, 2, 'composition cannot replace author action, even during structural recovery')
    assert.equal(calls - callsBefore, 0, 'invalid composition never reaches presentation or final review')
    assert.deepEqual(regenerated, before)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})
test('candidates cannot cite unknown material as result evidence; question-only response is recoverable', () => {
  const questions = [{ id: 'q', question: '差异原因是什么？', materialIds: ['m4'] }]
  assert.equal(parsePreparationCandidates({ candidates: [], questions }, material).questions.length, 1)
  assert.throws(() => parsePreparationCandidates({ candidates: [{ ...candidate, resultBasisIds: ['m4'] }], questions }, material), code('STORY_PREPARATION_INVALID_OUTPUT'))
  assert.throws(() => parsePreparationCandidates({ candidates: [{ ...candidate, resultBasisIds: [] }], questions }, material), code('STORY_PREPARATION_INVALID_OUTPUT'))
  const p = { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material, candidates: [{ ...candidate, unknownIds: ['q'] }], questions, acceptedCandidateIds: [], executed: false as const }
  assert.throws(() => acceptPreparation(p, ['count']), code('STORY_PREPARATION_UNKNOWN_DEPENDENCY'))
  assert.deepEqual(p.acceptedCandidateIds, [])
})

test('candidate reference contract separates unknown material from question dependencies without repairing evidence', () => {
  const before = structuredClone(material)
  assert.deepEqual(preparationReferenceContract(material).knownMaterialIds, ['m0','m1','m2','m3'])
  assert.deepEqual(preparationReferenceContract(material).questionMaterialIds, material.map(m => m.id))
  const questions = [{ id: 'q', question: '差异原因是什么？', materialIds: ['m4'] }]
  for (const field of ['materialIds','preconditionIds','resultBasisIds'] as const) {
    assert.throws(() => parsePreparationCandidates({ candidates: [{ ...candidate, [field]: ['m4'] }], questions }, material),
      (e: unknown) => e instanceof AppError && e.code === 'STORY_PREPARATION_INVALID_OUTPUT'
        && e.message.includes(`candidates[0].${field}`) && e.message.includes('m4'))
  }
  assert.throws(() => parsePreparationCandidates({ candidates: [{ ...candidate, unknownIds: ['m4'] }], questions }, material),
    (e: unknown) => e instanceof AppError && e.message.includes('candidates[0].unknownIds'))
  const pending = { ...candidate, resultBasisIds: [], unknownIds: ['q'] }
  assert.deepEqual(parsePreparationCandidates({ candidates: [pending], questions }, material), { candidates: [pending], questions })
  assert.deepEqual(material, before)
})
test('extraction, proposal and quality review stop before curve; only acceptance permits arrangement', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  let calls = 0, bad = false, simple = false
  const review = { originalText: '只接受未来逐项计数。可能发现差异；计数尚未发生，结果未知。', candidates: [{ id: 'c0', action: candidate.action, possibleResult: '计数后可能发现差异，也可能一致；原因保持未知。' }] }
  globalThis.fetch = async (_url, init) => {
    const staged = stagedFixture(init); if (staged) return staged
    const input = JSON.parse(String(init?.body))
    const prompt = input.messages[0].content as string
    if (prompt.includes('从作者的想法提出恰好三种')) {
      assert.deepEqual(JSON.parse(input.messages[1].content).referenceContract, preparationReferenceContract(material))
    }
    if (simple) {
      const user = JSON.parse(input.messages[1].content)
      assert.deepEqual(user.authorReview, review)
      assert.equal(user.acceptedCandidates[0].possibleResult, review.candidates[0]!.possibleResult)
      assert.equal(user.brief, undefined)
    }
    calls++
    const response = prompt.includes('核对人物当下意图') ? { characterGoalIds: ['m0'] } : prompt.includes('审查故事提案质量') ? qualityPass : prompt.includes('先整理作者材料') ? classification : prompt.includes('从作者的想法提出恰好三种') ? { candidates: directions, questions: [] }
      : { steps: (simple ? ['current-state','trigger','resolution'] : ['current-state','trigger','escalation','climax-choice','resolution']).map((kind, i) => { const accepted = JSON.parse(input.messages[1].content).acceptedCandidates[0]; const content = kind === 'resolution' ? accepted.possibleResult : i ? accepted.action : material[0]!.quote; return { kind, title: content, text: content, candidateIds: i ? [bad ? 'invented' : 'c0'] : [], materialIds: i ? ['m0','m1','m2'] : ['m0','m1','m2','m3'] } }), supplements: [] }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }), { status: 200 })
  }
  try {
    const curve = await generateStoryPreparation(source.text, brief)
    assert.equal(calls, 4); assert.deepEqual(curve.beats, []); assert.equal(curve.foundation, undefined)
    assert.throws(() => confirmProvisionalCurve(curve), code('STORY_PREPARATION_NOT_ACCEPTED'))
    await assert.rejects(() => generateCurveFromPreparation(curve, []), code('INVALID_REQUEST')); assert.equal(calls, 4)
    const before = structuredClone(curve)
    bad = true; await assert.rejects(() => generateCurveFromPreparation(curve, ['c0']), code('STORY_PREPARATION_INVALID_OUTPUT'))
    assert.deepEqual(curve, before)
    bad = false; simple = true
    const reviewedCurve = await generateCurveFromPreparation(curve, ['c0'], review)
    assert.deepEqual(reviewedCurve.preparation!.authorReview, review)
    assert.equal(reviewedCurve.preparation!.executed, false)
    assert.equal(reviewedCurve.beats.length, 3)
    assert.equal(reviewedCurve.foundation!.predicament.choice, '')
    assert.equal(reviewedCurve.foundation!.storyEnds.climax, '')
    assert.ok(reviewedCurve.beats.at(-1)!.detail.includes('也可能一致'))
    assert.throws(() => confirmProvisionalCurve(reviewedCurve), code('STORY_DESIGN_REVIEW_REQUIRED'))
    const simpleConfirmed = confirmProvisionalCurve(reviewedCurve, requiredDesignProposalIds(reviewedCurve.reasoning!)).confirmedCurve
    const simpleSeed = { subject: '方屿', activeSituation: source.text, lockedGoal: material[0]!.quote, lockedFacts: [], worldMode: 'realistic-default' as const, expansionScope: 'keep-scale' as const, unknowns: [] }
    const simpleFoundation = materializeConfirmedCurve(simpleSeed, simpleConfirmed)
    assert.equal(simpleFoundation.predicament.choice, '')
    assert.equal(simpleFoundation.headTail.promise, '')
    assert.ok(!simpleFoundation.predicament.facts.some(f => f.statement === review.candidates[0]!.possibleResult))
    assert.deepEqual(curve, before)
    simple = false; const mapped = await generateCurveFromPreparation(curve, ['c0'])
    assert.equal(mapped.preparation!.executed, false); assert.equal(mapped.preparation!.status, 'accepted-design')
    assert.equal(mapped.beats[1]!.detail, curve.preparation!.candidates[0]!.action)
    // Exact projection tests authority only; repeating accepted wording is not
    // a certificate of distinct choices or real content quality.
    assert.ok(mapped.preparation!.material.some(m => m.role === 'unknown'))
    validateStoryReasoningProposal(mapped.reasoning, { stage: 'initial-design', sources: mapped.design!.sourceFacts.map(s => ({ id: s.id, text: s.text, authority: 'author-material' })), protectedSteps: [], requiredEditIds: [] })
    const confirmed = confirmProvisionalCurve(mapped, requiredDesignProposalIds(mapped.reasoning!)).confirmedCurve
    const seed = { subject: '方屿', activeSituation: source.text, lockedGoal: material[0]!.quote, lockedFacts: [], worldMode: 'realistic-default' as const, expansionScope: 'keep-scale' as const, unknowns: [] }
    const facts = materializeConfirmedCurve(seed, confirmed).predicament.facts
    assert.ok(!facts.some(f => f.statement.includes('原因尚未确定') || f.statement === candidate.possibleResult || f.statement === candidate.action))
    assert.deepEqual(curve, before)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of [['DASHSCOPE_API_KEY', env.key], ['STORY_DISABLE_MODEL', env.disable]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value }
  }
})

test('author review preserves exact original text and covers exactly the selected candidates', () => {
  const review = { originalText: '  接受未来行动，尚未执行。  ', candidates: [{ id: 'count', action: candidate.action, possibleResult: '可能发现差异；尚未确认。' }] }
  assert.deepEqual(parsePreparationReview(review, ['count']), review)
  assert.throws(() => parsePreparationReview(review, ['other']), code('INVALID_REQUEST'))
  assert.throws(() => parsePreparationReview({ ...review, candidates: [review.candidates[0], review.candidates[0]] }, ['count']), code('INVALID_REQUEST'))
  assert.throws(() => parsePreparationReview({ ...review, originalText: '' }, ['count']), code('INVALID_REQUEST'))
})

test('long reviewed text keeps exact evidence and history while stage titles satisfy the reasoning contract', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const curve = { id: 'long-review', title: '待审', status: 'draft' as const, brief, beats: [], instructions: [], createdAt: 1, updatedAt: 1,
    preparation: { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material, candidates: [candidate], questions: [], acceptedCandidateIds: [], executed: false as const } }
  let longText = '合成作者审阅的未来可能结果：画被完整装入封套，未折叠，符合朋友要求且获准状态持续有效'
  let invalidReference = false, calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    const user = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
    const revised = user.acceptedCandidates[0]
    const steps = ['current-state','trigger','resolution'].map((kind, i) => {
      const content = i === 0 ? material[0]!.quote : i === 1 ? revised.action : revised.possibleResult
      return { kind, title: content, text: content, candidateIds: i ? [candidate.id] : [], materialIds: invalidReference ? ['absent'] : ['m0','m1','m2','m3'] }
    })
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ steps, supplements: [] }) } }] }), { status: 200 })
  }
  try {
    const before = structuredClone(curve)
    for (const size of [42, 40, 240]) {
      longText = size === 42 ? longText : '审'.repeat(size)
      const review = { originalText: '明确重审未来结果；并非执行。', candidates: [{ id: candidate.id, action: candidate.action, possibleResult: longText }] }
      const mapped = await generateCurveFromPreparation(curve, [candidate.id], review)
      assert.equal(mapped.beats.at(-1)!.detail, longText)
      assert.equal(mapped.reasoning!.outcome, 'proposal')
      assert.equal(mapped.foundation!.storyEnds.resolution, longText)
      assert.deepEqual(mapped.preparation!.originalCandidates, [candidate])
      assert.deepEqual(mapped.preparation!.candidates[0]!.resultBasisIds, candidate.resultBasisIds)
      assert.ok(mapped.beats.every(b => b.title.length <= 40))
      assert.deepEqual(curve, before)
    }
    assert.equal(calls, 3)
    invalidReference = true
    await assert.rejects(() => generateCurveFromPreparation(curve, [candidate.id]), code('STORY_PREPARATION_INVALID_OUTPUT'))
    invalidReference = false
    await assert.rejects(() => generateCurveFromPreparation(curve, [candidate.id], { originalText: '超长正文', candidates: [{ id: candidate.id, action: candidate.action, possibleResult: '审'.repeat(241) }] }), code('STORY_PREPARATION_INVALID_OUTPUT'))
    assert.deepEqual(curve, before)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of [['DASHSCOPE_API_KEY', env.key], ['STORY_DISABLE_MODEL', env.disable]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value }
  }
})

test('editing an action invalidates its old derived possible result while preserving the original candidate', () => {
  const p = { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material, candidates: [candidate], questions: [], acceptedCandidateIds: [], executed: false as const }
  const unchangedResult = { originalText: '改动行动。', candidates: [{ id: candidate.id, action: '方屿改为先清点借阅记录。', possibleResult: candidate.possibleResult }] }
  assert.throws(() => acceptPreparation(p, [candidate.id], unchangedResult), code('STORY_PREPARATION_DERIVED_RESULT_STALE'))
  const revised = { ...unchangedResult, candidates: [{ ...unchangedResult.candidates[0]!, possibleResult: '新的行动结果仍待作者确认。', resultBasisIds: [] }] }
  assert.throws(() => acceptPreparation(p, [candidate.id], revised), code('STORY_PREPARATION_REVISION_BASIS_REQUIRED'))
  assert.deepEqual(p.candidates, [candidate])
})

test('missing goal role is recovered only by model selection of active original material, without overwriting classification or author action', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const allFacts = material.map(m => m.role === 'goal' ? { ...m, role: 'fact' as const } : m)
  const curve = { id: 'goal-recovery', title: '待审', status: 'draft' as const, brief, beats: [], instructions: [], createdAt: 1, updatedAt: 1,
    preparation: { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material: allFacts, candidates: [candidate], questions: [], acceptedCandidateIds: [], executed: false as const } }
  const review = { originalText: '仅接受未来计数；尚未执行。', candidates: [{ id: candidate.id, action: '只计数，不改书。', possibleResult: '只计数后的结果仍待作者确认。' }] }
  let goalId: string | null = 'm0', arrangements = 0
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)), user = JSON.parse(input.messages[1].content)
    let response
    if (input.messages[0].content.includes('核对作者目标分类')) {
      assert.ok(!user.knownMaterial.some((m: { id: string }) => m.id === 'm4'))
      response = { goalMaterialId: goalId }
    } else {
      arrangements++
      assert.equal(user.acceptedCandidates[0].action, review.candidates[0]!.action)
      response = { steps: ['current-state','trigger','resolution'].map((kind, i) => {
        const content = i === 0 ? material[0]!.quote : i === 1 ? review.candidates[0]!.action : review.candidates[0]!.possibleResult
        return { kind, title: content, text: content, candidateIds: i ? [candidate.id] : [], materialIds: ['m0','m1','m2','m3'] }
      }), supplements: [] }
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }), { status: 200 })
  }
  try {
    const before = structuredClone(curve)
    const mapped = await generateCurveFromPreparation(curve, [candidate.id], review)
    assert.equal(mapped.reasoning!.goal!.text, material[0]!.quote)
    assert.deepEqual(mapped.preparation!.material, allFacts)
    assert.equal(mapped.beats[1]!.detail, review.candidates[0]!.action)
    for (const id of ['m4','invented',null]) {
      goalId = id
      await assert.rejects(() => generateCurveFromPreparation(curve, [candidate.id], review), code('STORY_PREPARATION_INVALID_OUTPUT'))
    }
    assert.equal(arrangements, 1)
    assert.deepEqual(curve, before)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of [['DASHSCOPE_API_KEY', env.key], ['STORY_DISABLE_MODEL', env.disable]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value }
  }
})

test('explicit supersession preserves originals, requires reviewed replacement basis and excludes old material', () => {
  const p = { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material, candidates: [candidate], questions: [], acceptedCandidateIds: [], executed: false as const }
  const review = { originalText: '计数可能发现差异，尚未计数。', supersededMaterialIds: ['m1'], confirmedQuotes: ['计数可能发现差异'], candidates: [{ id: 'count', action: candidate.action, possibleResult: '可能发现差异，尚未确认。' }] }
  assert.throws(() => acceptPreparation(p, ['count'], review), code('STORY_PREPARATION_REVISION_BASIS_REQUIRED'))
  const accepted = acceptPreparation(p, ['count'], { ...review, candidates: [{ ...review.candidates[0]!, resultBasisIds: ['author-review-1'] }] })
  assert.deepEqual(accepted.material, material)
  assert.deepEqual(accepted.originalCandidates, [candidate])
  assert.ok(!activePreparationMaterial(accepted).some(m => m.id === 'm1'))
  assert.equal(activePreparationMaterial(accepted).at(-1)!.quote, review.confirmedQuotes[0])
  assert.equal(accepted.executed, false)
  assert.throws(() => acceptPreparation(p, ['count'], { ...review, supersededMaterialIds: ['missing'] }), code('INVALID_REQUEST'))
  assert.throws(() => parsePreparationReview({ ...review, confirmedQuotes: ['已经计数'] }, ['count']), code('INVALID_REQUEST'))
  assert.deepEqual(p.candidates, [candidate])
})

test('new fault, observation and criterion remain independent; no title or prose can make them action prerequisites', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const curve = { id: 'curve-test', title: '待审', status: 'draft' as const, brief, beats: [], instructions: [], createdAt: 1, updatedAt: 1,
    preparation: { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material, candidates: [candidate], questions: [], acceptedCandidateIds: [], executed: false as const } }
  let smuggle: 'none' | 'text' | 'title' | 'omit-condition' | 'recover-condition' = 'none'
  let recoveryCalls = 0
  globalThis.fetch = async (_url, init) => {
    const user = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
    if (smuggle === 'recover-condition' && user.coverageReview) {
      recoveryCalls++
      assert.deepEqual(user.coverageReview.omittedMaterialIds, ['m3'])
    }
    const steps = ['current-state','trigger','resolution'].map((kind, i) => { const content = i === 0 ? material[0]!.quote : i === 1 ? candidate.action : candidate.possibleResult; return { kind, title: content, text: content, candidateIds: i ? ['count'] : [], materialIds: ['m0','m1','m2','m3'] } })
    if (smuggle === 'omit-condition' || (smuggle === 'recover-condition' && !user.coverageReview)) for (const step of steps) step.materialIds = step.materialIds.filter(id => id !== 'm3')
    else if (smuggle === 'text' || smuggle === 'title') steps[1]![smuggle] += '必须先检查纸张有无破损。'
    const supplements = [{ id: 'inspection', kind: 'observation', text: '建议检查纸张有无破损。', question: '作者是否希望增加这个检查步骤？', materialIds: ['m0'] }]
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ steps, supplements }) } }] }), { status: 200 })
  }
  try {
    const mapped = await generateCurveFromPreparation(curve, ['count'])
    assert.equal(mapped.preparation!.supplements![0]!.status, 'needs-review')
    assert.equal(mapped.preparation!.candidates[0]!.preconditionIds.includes('inspection'), false)
    assert.equal(JSON.stringify(mapped.reasoning).includes('破损'), false)
    assert.equal(JSON.stringify(mapped.foundation).includes('破损'), false)
    assert.equal(mapped.preparation!.executed, false)
    assert.ok(mapped.design!.sourceFacts.find(f => f.id === 'm3')!.coveredByBeatIds.length)
    assert.deepEqual(mapped.preparation!.candidates[0]!.preconditionIds, candidate.preconditionIds)
    assert.deepEqual(mapped.preparation!.candidates[0]!.resultBasisIds, candidate.resultBasisIds)
    smuggle = 'omit-condition'
    const partial = await generateCurveFromPreparation(curve, ['count'])
    assert.equal(partial.design!.sourceFacts.find(f => f.id === 'm3')!.disposition, 'needs-author-decision')
    assert.throws(() => confirmProvisionalCurve(partial, requiredDesignProposalIds(partial.reasoning!)), code('STORY_SOURCE_FACTS_UNRESOLVED'))
    smuggle = 'recover-condition'
    const recovered = await generateCurveFromPreparation(curve, ['count'])
    assert.equal(recoveryCalls, 1)
    assert.equal(recovered.design!.sourceFacts.find(f => f.id === 'm3')!.disposition, 'integrated')
    assert.deepEqual(recovered.preparation!.candidates[0]!.preconditionIds, candidate.preconditionIds)
    for (const mode of ['text','title'] as const) { smuggle = mode; await assert.rejects(() => generateCurveFromPreparation(curve, ['count']), code('STORY_PREPARATION_INVALID_OUTPUT')) }
    assert.equal(curve.beats.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of [['DASHSCOPE_API_KEY', env.key], ['STORY_DISABLE_MODEL', env.disable]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value }
  }
})
