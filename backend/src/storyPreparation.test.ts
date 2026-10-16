import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError } from './qwen.js'
import { acceptPreparation, activePreparationMaterial, framePreparationSources, generateStoryPreparation, generateCurveFromPreparation, parseMainlineAnchors, parsePreparationMaterial, parsePreparationCandidates, parsePreparationReview, preparationReferenceContract, projectFutureChoices, reviseStoryPreparation } from './storyPreparation.js'
import { confirmProvisionalCurve, materializeConfirmedCurve, parseCreativeBrief } from './storyCoCreation.js'
import { requiredDesignProposalIds } from './storyDesignReview.js'
import { preserveRequirementRoles, preparationSources, reviewPreparationUncertainty, parsePreparationIntent } from './storyPreparation.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'

// Keep the existing narrative fixtures while emitting the new per-direction
// wire format. These neutral states are contract stubs, not quality evidence.
function projectionWire(value: any): any {
  if (!value?.bridges || !value?.futureChoices) return value
  return { developments: Array.from({ length: Math.max(value.bridges.length, value.futureChoices.length) }, (_, i) => {
    const bridge = value.bridges[i], choice = value.futureChoices[i]
    return { id: choice?.id ?? bridge?.id,
      attempt: { means: [{ id: 'ability-1', capability: '按本方向尝试行动', status: 'available' }],
        methodUses: [{ meansId: 'ability-1', mode: 'rely' }], text: bridge?.method, materialIds: bridge?.methodBasisIds },
      change: { text: bridge?.change, materialIds: bridge?.changeBasisIds, outcome: 'uncertain',
        states: [{ id: 'state-1', statement: '本条尝试得到待核对的结果', status: 'uncertain' }] },
      futureChoice: { text: choice?.text, requires: [] } }
  }) }
}
// The new model contract encodes one verdict, rather than both a verdict and
// a potentially conflicting boolean. Keep malformed non-booleans malformed.
const modelJson = (value: any, init?: RequestInit) => {
  // Historical workflow fixtures use neutral in-scope excerpts; dedicated
  // review tests exercise missing, fabricated and cross-direction evidence.
  const input = init ? JSON.parse(JSON.parse(String(init.body)).messages[1].content) : undefined
  if (value?.checks) value = { ...value, checks: value.checks.map((check: any) => {
    if (!check.issueType && !check.verdict && typeof check.valid === 'boolean' && 'sourceId' in check) {
      const author = input?.material?.find((m: any) => m.sourceId === check.sourceId && check.quote && m.quote.includes(check.quote))
      return { id: check.id, verdict: check.valid ? 'compatible' : 'contradictory',
        conflictMaterialIds: check.valid ? [] : [author?.id ?? 'absent'],
        proposalEvidenceIds: check.valid ? [] : [input?.evidenceCatalog?.find((e: any) => e.candidateId === check.id)?.id ?? 'absent'], reason: check.reason }
    }
    if (!check.issueType || check.verdict) return check
    const { issueType, valid, evidenceIds, ...rest } = check
    if (valid !== undefined && typeof valid !== 'boolean') return check
    return issueType === 'none' ? { ...rest, verdict: 'supported', issueType: 'none', evidenceIds: [], needs: [] }
      : { ...rest, verdict: 'contradictory', issueType, needs: [], evidenceIds: evidenceIds ??
        (input?.evidenceCatalog ?? []).filter((e: any) => e.candidateId === check.id && ['method', 'change'].includes(e.field)).map((e: any) => e.id) }
  }) }
  return JSON.stringify(value, (key, value) => key === 'valid' && typeof value === 'boolean' ? undefined : value)
}

const source = { id: 'author-input', text: '方屿想核对书单；逐项计数能发现数量差异；计数不改动原书；没有期限；差异原因尚未确定。' }
const material = framePreparationSources([source]).map((m, i) => ({ ...m, role: (i === 0 ? 'goal' : i === 4 ? 'unknown' : 'condition') as 'goal' | 'unknown' | 'condition' }))
const classification = { material: material.map(({ id, role }) => ({ id, role })) }
const qualityPass = { checks: ['facts', 'causality', 'requirements', 'author-control', 'questions'].map(criterion => ({ criterion, passed: true, evidence: '测试用审阅证据；不作为实际内容验收。' })), issues: [] }
const factPass = (ids: string[]) => ({ checks: ids.map(id => ({ id, valid: true, sourceId: null, quote: null, reason: '无冲突' })) })
const mockIntent = (input: { sources: { id: string; text: string }[] }, characterGoalIds: string[]) => ({
  characterGoalIds,
  appealMaterialIds: characterGoalIds.slice(0, 1),
  mainlineGoals: characterGoalIds.length ? [{ id: 'g0', sourceId: 'author-input', quote: input.sources[0]!.text }] : [],
  mainlineAnchors: characterGoalIds.length ? [{ id: 'a0', kind: 'action', sourceId: 'author-input', quote: input.sources[0]!.text.slice(0, 2) }] : [],
})
const candidate = { id: 'count', action: '方屿逐项计数并核对书单。', futureChoice: '若数量不一致，他要选择先公开差异，还是先追查原因。', materialIds: ['m0'], preconditionIds: ['m1','m2'], possibleResult: '若完成逐项计数，可能发现书单与实物数量差异；原因仍未知。', resultBasisIds: ['m1'], unknownIds: [] }
const directions = [
  { ...candidate, id: 'c0' },
  { ...candidate, id: 'c1', action: '方屿先和同伴分组核对书单，发现两人对分类的理解不同，决定重新商定分类。', possibleResult: '重新分类后，两人可能找到数量差异的来源，并保留尚未确定的原因。' },
  { ...candidate, id: 'c2', action: '方屿从实物清点入手，遇到书单顺序不一致，决定按书架位置重新对应。', possibleResult: '对应完成后，可能缩小差异范围，仍需继续查明原因。' },
].map(direction => ({ ...direction, causalBridge: { method: direction.action, change: direction.possibleResult, methodBasisIds: ['m0'], changeBasisIds: ['m1'] } }))
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

test('mainline anchors keep the named place and companion separate from the activity', () => {
  const sources = [{ id: 'author-input', text: '青柠和朋友去游乐园玩。' }]
  const anchors = parseMainlineAnchors([
    { id: 'a0', kind: 'character', sourceId: 'author-input', quote: '青柠' },
    { id: 'a1', kind: 'relationship', sourceId: 'author-input', quote: '和朋友' },
    { id: 'a2', kind: 'place', sourceId: 'author-input', quote: '游乐园' },
    { id: 'a3', kind: 'action', sourceId: 'author-input', quote: '玩' },
  ], sources, true)
  assert.deepEqual(anchors.map(anchor => anchor.quote), ['青柠', '和朋友', '游乐园', '玩'])
  assert.deepEqual(parseMainlineAnchors([{ id: 'a0', kind: 'place', sourceId: 'm0', quote: '游乐园' }], sources, false,
    framePreparationSources(sources))[0], { id: 'a0', kind: 'place', sourceId: 'author-input', quote: '游乐园' })
  assert.throws(() => parseMainlineAnchors([{ id: 'a0', kind: 'place', sourceId: 'author-input', quote: '商场' }], sources, true), code('STORY_PREPARATION_INVALID_OUTPUT'))
})

test('mainline source selection preserves completed actions, negation and quoted speech across frame boundaries', () => {
  const sources = [{ id: 'author-input', text: '她写完辞职信，但不打算今天提交。父亲接通视频就问“你妈呢？”' }]
  const frames = framePreparationSources(sources)
  const selected = parseMainlineAnchors([
    { id: 'action', kind: 'action', materialIds: [frames[0]!.id] },
    { id: 'limit', kind: 'condition', materialIds: [frames[1]!.id] },
    { id: 'speech', kind: 'action', sourceId: frames[2]!.id, quote: '接通视频就问“你妈呢？”' },
  ], sources, true, frames)
  assert.equal(selected[0]!.quote, '她写完辞职信，')
  assert.equal(selected[1]!.kind, 'constraint')
  assert.equal(selected[1]!.quote, '但不打算今天提交。')
  assert.equal(selected[2]!.quote, '接通视频就问“你妈呢？”')
  assert.equal(selected[2]!.sourceId, 'author-input')
  const spanning = parseMainlineAnchors([{ id: 'full', kind: 'action', materialIds: [frames[0]!.id, frames[2]!.id] }], sources, true, frames)
  assert.ok(spanning[0]!.quote.includes('但不打算今天提交。'))
  for (const item of [
    { id: 'missing', kind: 'action', materialIds: ['absent'] },
    { id: 'unrelated', kind: 'action', sourceId: frames[0]!.id, quote: '父亲' },
    { id: 'reverse', kind: 'action', sourceId: 'author-input', quote: '打算今天立刻提交' },
  ]) assert.throws(() => parseMainlineAnchors([item], sources, true, frames), code('STORY_PREPARATION_INVALID_OUTPUT'))
  const other = [...sources, { id: 'author-note', text: '保留误会。' }]
  const all = framePreparationSources(other)
  const split = parseMainlineAnchors([{ id: 'mixed', kind: 'action', materialIds: [all[0]!.id, all.at(-1)!.id] }], other, true, all)
  assert.equal(split.length, 2)
  assert.deepEqual(split.map(anchor => anchor.sourceId), ['author-input', 'author-note'])
  assert.ok(split.every(anchor => anchor.id.startsWith('mixed-source-')))
})

test('mainline elements split cross-field references without inventing a combined quote', () => {
  const sources = [
    { id: 'author-input', text: '两人要一起做最后一顿饭。' },
    { id: 'author-direction', text: '最后一起收拾残局。' },
  ]
  const frames = framePreparationSources(sources)
  const anchors = parseMainlineAnchors([{ id: 'action', kind: 'action', materialIds: [frames[0]!.id, frames[1]!.id] }], sources, true, frames)
  assert.deepEqual(anchors.map(anchor => anchor.quote), ['两人要一起做最后一顿饭。', '最后一起收拾残局。'])
  assert.deepEqual(anchors.map(anchor => anchor.sourceId), ['author-input', 'author-direction'])
  assert.deepEqual(anchors.map(anchor => anchor.kind), ['action', 'constraint'])
})

test('multi-field intent preserves source quotes while keeping expected development out of character goals', () => {
  const sources = preparationSources('两人想一起做完最后一顿饭，越帮忙越添乱。', {
    ...brief, storyRequirements: { setting: '厨房设备正常，没有第三人在场。', direction: '最后一起收拾残局。', boundaries: '不要停电。' },
    note: '最后用一个小动作收尾。',
  })
  const material = framePreparationSources(sources).map(frame => ({ ...frame, role: 'fact' as const }))
  const bySource = (sourceId: string) => material.filter(m => m.sourceId === sourceId).map(m => m.id)
  const selected = [material[0]!.id, ...bySource('author-direction')]
  const parsed = parsePreparationIntent({
    characterGoalIds: selected, appealMaterialIds: [],
    mainlineGoals: [{ id: 'g0', materialIds: selected }],
    mainlineAnchors: [
      { id: 'a0', kind: 'action', materialIds: selected },
      { id: 'a1', kind: 'constraint', materialIds: material.slice(2).map(m => m.id) },
    ],
  }, sources, material)
  assert.deepEqual([...parsed.goalIds], [material[0]!.id])
  assert.deepEqual(parsed.goals.map(g => ({ sourceId: g.sourceId, quote: g.quote })), [{ sourceId: 'author-input', quote: material[0]!.quote }])
  assert.ok(parsed.anchors.every(a => sources.some(s => s.id === a.sourceId && s.text.includes(a.quote))))
  assert.ok(parsed.anchors.filter(a => ['author-direction', 'author-boundaries', 'author-note'].includes(a.sourceId)).every(a => a.kind === 'constraint'))
  for (const source of sources.slice(1)) assert.ok(parsed.anchors.some(a => a.sourceId === source.id))
  assert.equal(parsed.anchors.length, new Set(parsed.anchors.map(a => a.id)).size)
})

test('intent never invents a character goal from requirements or explicitly unknown material', () => {
  const sources = [{ id: 'author-input', text: '主角要做什么还没想好。' }, { id: 'author-note', text: '最后主动道歉。' }]
  const material = framePreparationSources(sources).map((m, i) => ({ ...m, role: i ? 'condition' as const : 'unknown' as const }))
  const parsed = parsePreparationIntent({ characterGoalIds: ['m0', 'm1'], appealMaterialIds: [],
    mainlineGoals: [{ id: 'g0', materialIds: ['m0', 'm1'] }],
    mainlineAnchors: [{ id: 'a0', kind: 'action', materialIds: ['m1'] }],
  }, sources, material)
  assert.equal(parsed.goalIds.size, 0)
  assert.deepEqual(parsed.goals, [])
  assert.equal(parsed.anchors[0]!.kind, 'constraint')
})

test('reference splitting preserves original whitespace, long clauses and generated ID uniqueness', () => {
  const long = '甲'.repeat(180) + '，\n\n' + '乙'.repeat(180) + '。'
  const sources = [{ id: 'author-input', text: long }, { id: 'author-setting', text: '只用厨房。' }]
  const frames = framePreparationSources(sources)
  const anchors = parseMainlineAnchors([
    { id: 'a0', kind: 'action', materialIds: frames.map(m => m.id) },
    { id: 'a0-source-1', kind: 'place', materialIds: [frames.at(-1)!.id] },
  ], sources, true, frames)
  assert.equal(anchors[0]!.quote, long)
  assert.equal(anchors.length, new Set(anchors.map(a => a.id)).size)
  assert.ok(anchors.every(a => a.id.length <= 80))
  const duplicated = [{ id: 'same', kind: 'action', materialIds: [frames[0]!.id] },
    { id: 'same', kind: 'action', materialIds: [frames.at(-1)!.id] }]
  assert.throws(() => parseMainlineAnchors(duplicated, sources, true, frames), code('STORY_PREPARATION_INVALID_OUTPUT'))
  assert.throws(() => parseMainlineAnchors([{ id: 'bad', kind: 'action', materialIds: ['absent', frames[0]!.id] }], sources, true, frames), code('STORY_PREPARATION_INVALID_OUTPUT'))
  assert.throws(() => parseMainlineAnchors([{ id: 'bad', kind: 'action', sourceId: 'author-input', quote: long + '没有写过' }], sources, true, frames), code('STORY_PREPARATION_INVALID_OUTPUT'))
})

test('future choice review gives one overall mainline judgment per direction', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const base = directions.slice(0, 1).map(({ futureChoice, causalBridge, ...rest }) => rest)
  const anchors = parseMainlineAnchors([{ id: 'place', kind: 'place', sourceId: 'author-input', quote: '游乐园' }],
    [{ id: 'author-input', text: '青柠和朋友去游乐园玩。' }], false)
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const prompt = request.messages[0].content as string
    const input = JSON.parse(request.messages[1].content)
    const output = prompt.includes('核对因果桥是否违背作者已定事实') ? factPass(base.map(item => item.id))
      : prompt.includes('审查每条方向的')
      ? { checks: [{ id: base[0]!.id, valid: true, issueType: 'none', reason: '园区游玩仍是主要问题。' }] }
      : { bridges: input.candidates.map((item: typeof base[number]) => ({ id: item.id, method: item.action,
          change: '青柠仍在园区选择项目。', methodBasisIds: ['m0'], changeBasisIds: [] })),
          futureChoices: input.candidates.map((item: typeof base[number]) => ({ id: item.id, text: '继续选项目还是等待朋友？' })) }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    const projected = await projectFutureChoices(base, [{ id: 'author-input', text: '青柠和朋友去游乐园玩。' }], brief, anchors)
    assert.equal(projected.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('a plausible new setting may first appear in a causal bridge without author result evidence', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const storySource = { id: 'author-input', text: '方屿答应和妹妹一起把画送到学校展览，让妹妹亲手挂上去。' }
  const direction = { ...candidate, id: 'school', action: '方屿发现妹妹还没决定挂画位置，打算先问展览负责人。',
    possibleResult: '如果负责人愿意协调，妹妹仍有机会亲手挂画。', resultBasisIds: [] }
  const bridge = { method: '方屿向展览负责人询问是否能预留挂画时段。',
    change: '负责人可能提供布展时段，妹妹需要选择现在赶去学校还是请人暂时保管画。',
    methodBasisIds: ['m0'], changeBasisIds: [] }
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const prompt = request.messages[0].content as string
    const input = JSON.parse(request.messages[1].content)
    calls++
    if (!prompt.includes('审查每条方向的')) {
      assert.deepEqual(input.sources, [storySource])
      if (!prompt.includes('核对因果桥是否违背作者已定事实'))
        assert.deepEqual(input.mainlineGoals, [{ id: 'g0', sourceId: 'author-input', quote: storySource.text }])
    }
    if (prompt.includes('核对因果桥是否违背作者已定事实')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(factPass([direction.id])) } }] }))
    }
    if (prompt.includes('审查每条方向的')) {
      assert.match(prompt, /允许按题材惯例创作新设定/)
      assert.match(prompt, /处境变化包括失败、恶化、暴露、失去机会、新信息及关系改变/)
      assert.deepEqual(input.proposals[0].change, bridge.change)
      assert.ok(!('sources' in input) && !('candidates' in input))
      return new Response(JSON.stringify({ choices: [{ message: { content: modelJson({ checks: [
        { id: direction.id, valid: true, issueType: 'none', reason: '负责人协调布展时段属于可能的学校流程，妹妹仍可亲手挂画。' },
      ] }) } }] }))
    }
    assert.match(prompt, /新事件可以偶然出现，不要求由上一步直接造成/)
    assert.match(prompt, /关键结果须有办法能提供的信息、资源或能力支撑/)
    assert.doesNotMatch(prompt, /不得只是再修一次、再等片刻/)
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire({
      bridges: [{ id: direction.id, ...bridge }],
      futureChoices: [{ id: direction.id, text: '现在去学校布展，还是先请负责人保管画？' }],
    })) } }] }))
  }
  try {
    const result = await projectFutureChoices([direction], [storySource], brief, [],
      [{ id: 'g0', sourceId: 'author-input', quote: storySource.text }])
    assert.equal(calls, 3)
    assert.deepEqual(result[0]?.causalBridge, bridge)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('author fact conflict requires a real quote and stops before plausibility review', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const storySource = { id: 'author-input', text: '方屿答应妹妹：画只能由妹妹亲手挂上去。' }
  const base = [{ ...directions[0]!, causalBridge: { method: '方屿请老师代挂画。', change: '老师替妹妹挂上了画。',
    methodBasisIds: ['m0'], changeBasisIds: [] }, futureChoice: '接受老师代挂，还是让妹妹重新挂画？' }]
  let factReviews = 0, worldReviews = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), prompt = request.messages[0].content as string
    const input = JSON.parse(request.messages[1].content)
    let output: unknown
    if (prompt.includes('核对因果桥是否违背作者已定事实')) {
      factReviews++
      output = { checks: [{ id: base[0]!.id, valid: false, sourceId: 'author-input', quote: '画只能由妹妹亲手挂上去',
        reason: '老师代挂与作者指定的亲手挂画冲突。' }] }
    } else if (prompt.includes('审查每条方向的')) { worldReviews++; output = { checks: [] } }
    else output = { bridges: input.candidates.map((item: typeof candidate) => ({ id: item.id, method: '方屿请老师代挂画。',
      change: '老师替妹妹挂上了画。', methodBasisIds: ['m0'], changeBasisIds: [] })),
      futureChoices: input.candidates.map((item: typeof candidate) => ({ id: item.id, text: '接受老师代挂，还是让妹妹重新挂画？' })) }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    await assert.rejects(() => projectFutureChoices(base, [storySource], brief), code('STORY_PREPARATION_QUALITY_FAILED'))
    assert.equal(factReviews, 2)
    assert.equal(worldReviews, 0)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('author conflict review rejects missing or fabricated evidence IDs before semantic review', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const base = [directions[0]!]
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    calls++
    const output = prompt.includes('你是故事大纲编辑')
      ? { bridges: [{ id: base[0]!.id, ...base[0]!.causalBridge }], futureChoices: [{ id: base[0]!.id, text: base[0]!.futureChoice }] }
      : { checks: [{ id: base[0]!.id, valid: false, sourceId: 'author-input',
        quote: calls === 1 ? '' : '作者没有写过的新规定', reason: '来源冲突。' }] }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    await assert.rejects(() => projectFutureChoices(base, [source], brief), code('QWEN_OUTPUT_SCHEMA_FAILED'))
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('world plausibility repair receives the rejected bridge and revises its mechanism', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const base = directions.slice(0, 1).map(({ futureChoice, causalBridge, ...rest }) => rest)
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const input = JSON.parse(request.messages[1].content)
    calls++
    let output: unknown
    if (calls === 1 || calls === 4) {
      if (calls === 4) {
        assert.equal(input.repairReasons[0].id, base[0]!.id)
        assert.equal(input.repairReasons[0].issueType, 'world-implausible')
        assert.match(input.repairReasons[0].reason, /关键作用途径/)
        assert.equal(input.repairReasons[0].evidence[1].quote, '临时系统凭一次手印自动核验身份并放行。')
        assert.equal(input.previousProjections[0].bridge.change, '临时系统凭一次手印自动核验身份并放行。')
        assert.match(request.messages[0].content, /world-implausible 时改掉不可信的规则、能力或权限/)
      }
      output = { bridges: [{ id: base[0]!.id, method: '向负责人询问现场登记方式。',
        change: calls === 1 ? '临时系统凭一次手印自动核验身份并放行。' : '负责人可能人工核对名单，人物还须等待确认。',
        methodBasisIds: ['m0'], changeBasisIds: [] }],
        futureChoices: [{ id: base[0]!.id, text: '等待核对还是调整原计划？' }] }
    } else if (request.messages[0].content.includes('核对因果桥是否违背作者已定事实')) output = factPass([base[0]!.id])
    else output = { checks: [{ id: base[0]!.id, valid: calls === 6,
      issueType: calls === 6 ? 'none' : 'world-implausible',
      reason: calls === 6 ? '人工核对有现实依据且仍影响原目标。' : '临时展览系统无法凭一次手印自动核验身份。' }] }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    const projected = await projectFutureChoices(base, [source], brief)
    assert.equal(calls, 6)
    assert.equal(projected[0]?.causalBridge?.change, '负责人可能人工核对名单，人物还须等待确认。')
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('causal bridge review rejects a change that replaces the authored place', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const anchors = parseMainlineAnchors([{ id: 'place', kind: 'place', sourceId: 'author-input', quote: '游乐园' }],
    [{ id: 'author-input', text: '青柠和朋友去游乐园玩。' }], false)
  const base = directions.slice(0, 1).map(({ futureChoice, causalBridge, ...rest }) => rest)
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const input = JSON.parse(request.messages[1].content)
    calls++
    const output = request.messages[0].content.includes('核对因果桥是否违背作者已定事实') ? factPass([base[0]!.id])
      : request.messages[0].content.includes('审查每条方向的')
      ? { checks: [{ id: base[0]!.id, valid: false, issueType: 'mainline-drift', reason: '地点由游乐园变成商场，后续不再围绕游乐园游玩。' }] }
      : { bridges: input.candidates.map((item: typeof base[number]) => ({ id: item.id, method: item.action,
          change: '青柠和朋友改去商场玩。', methodBasisIds: ['m0'], changeBasisIds: [] })),
          futureChoices: input.candidates.map((item: typeof base[number]) => ({ id: item.id, text: '继续在商场玩，还是回家？' })) }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    await assert.rejects(() => projectFutureChoices(base, [{ id: 'author-input', text: '青柠和朋友去游乐园玩。' }], brief, anchors), code('STORY_PREPARATION_QUALITY_FAILED'))
    assert.equal(calls, 6)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('future choice review does not request a separate quote repair', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const base = directions.slice(0, 1).map(({ futureChoice, causalBridge, ...rest }) => rest)
  const anchors = parseMainlineAnchors([{ id: 'place', kind: 'place', sourceId: 'author-input', quote: '游乐园' }],
    [{ id: 'author-input', text: '青柠和朋友去游乐园玩。' }], false)
  let repairs = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const prompt = request.messages[0].content as string
    const input = JSON.parse(request.messages[1].content)
    const output = prompt.includes('只修复主线审阅证据')
      ? (repairs++, { quotes: [] })
      : prompt.includes('核对因果桥是否违背作者已定事实') ? factPass([base[0]!.id])
      : prompt.includes('审查每条方向的')
        ? { checks: [{ id: base[0]!.id, valid: true, issueType: 'none', reason: '青柠仍在游乐园选择项目，原目标可推进。' }] }
        : { bridges: input.candidates.map((item: typeof base[number]) => ({ id: item.id, method: item.action,
            change: '青柠仍在游乐园选择项目。', methodBasisIds: ['m0'], changeBasisIds: [] })),
            futureChoices: input.candidates.map((item: typeof base[number]) => ({ id: item.id, text: '继续选项目还是等待朋友？' })) }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    const projected = await projectFutureChoices(base, [{ id: 'author-input', text: '青柠和朋友去游乐园玩。' }], brief, anchors)
    assert.equal(projected.length, 1)
    assert.equal(repairs, 0)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('prebuilt causal bridges still receive mainline review before directions are shown', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const idea = '青柠和朋友去游乐园玩。'
  let reviews = 0
  let continuationReviews = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const input = JSON.parse(request.messages[1].content)
    const prompt = request.messages[0].content as string
    let output: unknown
    if (prompt.includes('先整理作者材料')) output = { material: [{ id: 'm0', role: 'goal' }] }
    else if (prompt.includes('核对人物当下意图')) output = { characterGoalIds: ['m0'], appealMaterialIds: [], mainlineGoals: [{ id: 'g0', sourceId: 'author-input', quote: idea }], mainlineAnchors: [
      { id: 'a0', kind: 'character', sourceId: 'author-input', quote: '青柠' },
      { id: 'a1', kind: 'relationship', sourceId: 'author-input', quote: '和朋友' },
      { id: 'a2', kind: 'place', sourceId: 'author-input', quote: '游乐园' },
      { id: 'a3', kind: 'action', sourceId: 'author-input', quote: '玩' },
    ] }
    else if (prompt.includes('从作者的想法提出恰好三种')) output = { candidates: [0, 1, 2].map(index => ({
      id: `d${index}`, action: `青柠和朋友去游乐园玩，遇到第${index + 1}种入园问题，考虑向工作人员询问。`,
      materialIds: ['m0'], preconditionIds: [], possibleResult: `问询第${index + 1}种问题后可能需要改变计划。`, resultBasisIds: [], unknownIds: [],
      causalBridge: { method: '青柠询问门票问题。', change: index === 0 ? '青柠和朋友改去商场玩。' : '青柠和朋友仍争取在游乐园玩。', methodBasisIds: ['m0'], changeBasisIds: [] },
      futureChoice: index === 0 ? '在商场继续玩还是回家？' : '继续处理门票还是另选园内项目？',
    })), questions: [] }
    else if (prompt.includes('审查故事提案质量')) {
      reviews++
      output = qualityPass
    } else if (prompt.includes('核对因果桥是否违背作者已定事实')) output = factPass(input.candidates.map((item: { id: string }) => item.id))
    else if (prompt.includes('审查每条方向的')) {
      continuationReviews++
      output = { checks: input.proposals.map((item: { id: string }) => ({
        id: item.id, valid: item.id !== 'd0', issueType: item.id === 'd0' ? 'mainline-drift' : 'none',
        reason: item.id === 'd0' ? '下一步改去商场玩，偏离游乐园。' : '仍围绕游乐园游玩。',
      })) }
    } else if (prompt.includes('你是故事大纲编辑')) {
      output = { bridges: input.candidates.map((item: { id: string }) => ({
        id: item.id, method: '青柠询问门票问题。', change: '青柠和朋友改去商场玩。', methodBasisIds: ['m0'], changeBasisIds: [],
      })), futureChoices: input.candidates.map((item: { id: string }) => ({ id: item.id, text: '在商场继续玩还是回家？' })) }
    } else throw new Error(`Unexpected stage: ${prompt.slice(0, 30)}`)
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    await assert.rejects(() => generateStoryPreparation(idea, brief), code('STORY_PREPARATION_QUALITY_FAILED'))
    assert.equal(reviews, 1)
    assert.equal(continuationReviews, 2)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
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
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
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
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: modelJson({ decisions: [
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
    if (input.sources) assert.equal(input.sources.find((s: { id: string }) => s.id === 'author-boundaries').text, expectedBoundary)
    else if (input.storyContext) assert.ok(input.storyContext.includes(expectedBoundary))
    observedStages.add(prompt)
    if (prompt.includes('先整理作者材料')) {
      // Deliberately misclassify author wishes and boundaries as character goals.
      return new Response(JSON.stringify({ choices: [{ message: { content: modelJson({ material: input.material.map((m: { id: string; sourceId: string }) => ({ id: m.id, role: m.sourceId === 'author-setting' ? 'fact' : 'goal' })) }) } }] }))
    }
    if (prompt.includes('从作者的想法提出恰好三种') || prompt.includes('审查故事提案质量')) {
      for (const sourceId of ['author-direction', 'author-boundaries']) {
        assert.ok(input.material.some((m: { sourceId: string; role: string }) => m.sourceId === sourceId && m.role === 'condition'))
      }
    }
    const staged = stagedFixture(init)
    if (staged) return staged
    const output = prompt.includes('核对人物当下意图') ? mockIntent(input, ['m0']) : prompt.includes('从作者的想法提出恰好三种') ? { candidates: directions, questions: [] } : qualityPass
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
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
  else if (prompt.includes('你是故事大纲编辑')) output = {
    bridges: input.candidates.map((item: { id: string; action: string; materialIds: string[] }) => ({
      id: item.id, method: item.action, change: '原目标可能继续推进。', methodBasisIds: item.materialIds.slice(0, 1), changeBasisIds: [],
    })),
    futureChoices: input.candidates.map((item: { id: string }) => ({ id: item.id, text: '继续推进原目标，还是与同伴协商？' })),
  }
  else if (prompt.includes('核对因果桥是否违背作者已定事实')) output = factPass(input.candidates.map((item: { id: string }) => item.id))
  else if (prompt.includes('审查每条方向的')) output = { checks: input.proposals.map((item: { id: string }) => ({
    id: item.id, valid: true, issueType: 'none', reason: '测试桩确认因果桥仍围绕原目标。',
  })) }
  else return undefined
  return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }), { status: 200 })
}

test('ID-based intent and fact checks preserve canonical material and retry only malformed reviews', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  let facts = 0, writers = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), prompt = request.messages[0].content as string
    const input = JSON.parse(request.messages[1].content)
    let output: unknown
    if (prompt.includes('核对因果桥是否违背作者已定事实')) {
      facts++
      assert.deepEqual(input.material, framePreparationSources([source]))
      if (facts === 2) assert.match(input.validationFailure, /conflictMaterialIds/)
      output = { checks: directions.map(item => ({ id: item.id, verdict: facts === 1 ? 'contradictory' : 'compatible',
        conflictMaterialIds: facts === 1 ? ['absent'] : [], proposalEvidenceIds: [], reason: facts === 1 ? '无效引用桩。' : '没有事实冲突。' })) }
    } else {
      const staged = stagedFixture(init); if (staged) return staged
      if (prompt.includes('先整理作者材料')) output = classification
      else if (prompt.includes('核对人物当下意图')) output = { characterGoalIds: ['m0'], appealMaterialIds: ['m0'],
        mainlineGoals: [{ id: 'g0', materialIds: ['m0'] }],
        mainlineAnchors: [{ id: 'a0', kind: 'action', materialIds: ['m0'] }, { id: 'a1', kind: 'constraint', materialIds: ['m1', 'm3'] }] }
      else if (prompt.includes('从作者的想法提出恰好三种')) { writers++; output = { candidates: directions, questions: [] } }
      else output = qualityPass
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    const curve = await generateStoryPreparation(source.text, brief)
    assert.equal(writers, 1); assert.equal(facts, 2)
    assert.equal(curve.preparation!.mainlineGoals![0]!.quote, material[0]!.quote)
    assert.equal(curve.preparation!.mainlineAnchors![1]!.quote, material.slice(1, 4).map(item => item.quote).join(''))
    assert.equal(curve.preparation!.material[4]!.role, 'unknown')
    assert.equal(curve.preparation!.candidates.length, 3)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of [['DASHSCOPE_API_KEY', env.key], ['STORY_DISABLE_MODEL', env.disable]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value }
  }
})

for (const persistent of [false, true]) test(`inconsistent quality review never rewrites directions (persistent=${persistent})`, async () => {
  const original = globalThis.fetch, saved = { key: process.env.DASHSCOPE_API_KEY, disabled: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  let writers = 0, reviews = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), input = JSON.parse(request.messages[1].content), prompt = request.messages[0].content
    let output: unknown
    if (prompt.includes('审查故事提案质量')) {
      reviews++
      if (reviews === 2) { assert.match(input.validationFailure, /只重审原提案/); assert.deepEqual(input.proposal.candidates.map((c: any) => c.action), directions.map(c => c.action)) }
      output = { ...qualityPass, issues: persistent || reviews === 1 ? ['测试矛盾问题列表。'] : [] }
    } else {
      const staged = stagedFixture(init); if (staged) return staged
      if (prompt.includes('先整理作者材料')) output = classification
      else if (prompt.includes('核对人物当下意图')) output = mockIntent(input, ['m0'])
      else { writers++; output = { candidates: directions, questions: [] } }
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(output, init) } }] }))
  }
  try {
    const run = () => generateStoryPreparation(source.text, brief)
    if (persistent) await assert.rejects(run, e => e instanceof AppError && e.code === 'STORY_PREPARATION_INVALID_OUTPUT'
      && e.modelDiagnostic?.stage === 'preparation-quality-review:response-schema')
    else assert.equal((await run()).preparation!.candidates.length, 3)
    assert.equal(writers, 1); assert.equal(reviews, 2)
  } finally {
    globalThis.fetch = original
    if (saved.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = saved.key
    if (saved.disabled === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = saved.disabled
  }
})

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
      output = mockIntent(input, [])
    } else if (request.messages[0].content.includes('最小行动候选')) {
      attempts++
      assert.match(input.requiredResponse, /candidates=\[\]/)
      output = attempts === 1 ? { candidates: [{ ...candidate, materialIds: ['m0'], preconditionIds: [], resultBasisIds: ['m0'] }], questions: [] }
        : { candidates: [], questions: [{ id: 'choose-goal', question: '你想写谁向什么告别？比如搬家的室友，或将退休的店主。', materialIds: ['m1'] }] }
    } else output = qualityPass
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }), { status: 200 })
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
    else if (prompt.includes('核对人物当下意图')) { checked = true; output = mockIntent(input, ['m0']) }
    else if (prompt.includes('从作者的想法提出恰好三种')) {
      assert.ok(checked)
      output = { candidates: directions.map((c, i) => ({ ...c, id: `d${i}`, materialIds: ['m0'], preconditionIds: [], resultBasisIds: ['m0'],
        causalBridge: { ...c.causalBridge, changeBasisIds: ['m0'] } })), questions: [] }
    } else if (prompt.includes('核对因果桥是否违背作者已定事实')) output = factPass(input.candidates.map((item: { id: string }) => item.id))
    else if (prompt.includes('审查每条方向的')) output = { checks: input.proposals.map((item: { id: string }) => ({
      id: item.id, valid: true, issueType: 'none', reason: '仍围绕原目标。',
    })) }
    else output = qualityPass
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
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
      output = mockIntent(input, [])
    } else if (prompt.includes('最小行动候选')) {
      assert.ok(checked)
      assert.match(input.requiredResponse, /candidates=\[\]/)
      output = { candidates: [], questions: [{ id: 'choose', question: '其中一个人眼下想完成什么事？', materialIds: ['m1'] }] }
    } else output = qualityPass
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
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
      assert.deepEqual(user.previousOutput, calls === 2 ? first : second)
      assert.equal(typeof user.validationFailure, 'string')
      if (transportFailure) return new Response(JSON.stringify({ error: { message: 'invalid request' } }), { status: 400 })
    }
    const output = input.messages[0].content.includes('核对人物当下意图') ? mockIntent(user, ['m0']) : input.messages[0].content.includes('审查故事提案质量') ? qualityPass : input.messages[0].content.includes('从作者的想法提出恰好三种') ? { candidates: directions, questions: [] } : user.validationFailure ? second : first
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }), { status: 200 })
  }
  try {
    const before = structuredClone(wrong)
    const curve = await generateStoryPreparation(source.text, brief)
    assert.equal(calls, 5)
    assert.deepEqual(curve.preparation!.material, material)
    assert.deepEqual(wrong, before)
    for (const output of [wrong, { material: classification.material.slice(0, 2) }, { material: classification.material.map(m => ({ ...m, id: 'missing' })) }]) {
      calls = 0; second = output
      // Shape errors are now owned by the shared model entry point. Valid
      // shapes with missing/invalid source IDs still reach domain validation.
      await assert.rejects(() => generateStoryPreparation(source.text, brief),
        code(output === wrong ? 'QWEN_OUTPUT_SCHEMA_FAILED' : 'STORY_PREPARATION_INVALID_OUTPUT'))
      assert.equal(calls, output === wrong ? 2 : 3)
    }
    calls = 0; first = { material: material.map(m => ({ ...m, sourceId: 'missing' })) }; second = first
    await assert.rejects(() => generateStoryPreparation(source.text, brief), code('QWEN_OUTPUT_SCHEMA_FAILED'))
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
    } else output = prompt.includes('核对人物当下意图') ? mockIntent(user, ['m0']) : prompt.includes('审查故事提案质量') ? qualityPass : { candidates: directions, questions: [] }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
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
    let output: unknown = prompt.includes('核对人物当下意图') ? mockIntent(user, ['m0']) : classification
    if (prompt.includes('从作者的想法提出恰好三种')) {
      proposals++
      if (proposals === 2) assert.match(user.validationFailure, /内容审阅/)
      output = { candidates: directions, questions: [] }
    } else if (prompt.includes('审查故事提案质量')) {
      reviews++
      output = { ...qualityPass, checks: qualityPass.checks.map(c => c.criterion === 'causality' ? { ...c, passed: false, evidence: '发展只复述原目标，没有具体事件。' } : c), issues: [] }
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }), { status: 200 })
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
      envelope.choices[0].message.content = modelJson(output)
      return new Response(JSON.stringify(envelope))
    }
    const stagePrompt = body.messages[0].content as string
    const staged = stagePrompt.includes('你是故事大纲编辑') || stagePrompt.includes('审查每条方向的') || stagePrompt.includes('核对因果桥是否违背作者已定事实') ? undefined : stagedFixture(init)
    if (staged) return staged
    calls++
    const input = JSON.parse(String(init?.body))
    const user = JSON.parse(input.messages[1].content)
    let output: unknown
    if (input.messages[0].content.includes('核对人物当下意图')) output = mockIntent(user, ['m0'])
    else if (input.messages[0].content.includes('审查故事提案质量')) output = qualityPass
    else if (input.messages[0].content.includes('你是故事大纲编辑')) output = {
      bridges: user.candidates.map((c: typeof candidate) => ({ id: c.id, method: c.action, change: c.possibleResult, methodBasisIds: ['m0'], changeBasisIds: ['m1'] })),
      futureChoices: user.candidates.map((c: typeof candidate) => ({ id: c.id, text: '若核对后仍有差异，他要选择公开差异还是继续查明原因。' })),
    }
    else if (input.messages[0].content.includes('核对因果桥是否违背作者已定事实')) output = factPass(user.candidates.map((c: typeof candidate) => c.id))
    else if (input.messages[0].content.includes('审查每条方向的')) output = {
      checks: user.proposals.map((c: typeof candidate) => ({ id: c.id, valid: true, issueType: 'none', reason: '测试桩通过；不代表实际内容合格。' })),
    }
    else if (input.messages[0].content.includes('从作者的想法提出恰好三种')) {
      assert.deepEqual(user.material, material)
      if (user.rejectedCandidates.length) assert.ok(user.rejectedCandidates.some((c: { action: string }) => c.action === candidate.action))
      output = { candidates: directions.map(({ causalBridge, futureChoice, ...c }, i) => user.rejectedCandidates.length ? { ...c, action: `另一版方向${i}：${c.action}` } : c), questions: [] }
    } else if (user.validationFailure) {
      assert.match(user.validationFailure, /覆盖全部固定材料/)
      assert.deepEqual(user.sources, [source])
      output = classification
    } else output = { material: classification.material.slice(0, 2) }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }), { status: 200 })
  }
  try {
    const curve = await generateStoryPreparation(source.text, brief)
    assert.equal(calls, 8)
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
    await assert.rejects(() => reviseStoryPreparation(regenerated, 'revise', 'c0', authorAction), code('QWEN_OUTPUT_SCHEMA_FAILED'))
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
  assert.deepEqual(parsePreparationCandidates({ candidates: [{ ...candidate, resultBasisIds: [] }], questions: [] }, material).candidates[0]?.resultBasisIds, [])
  const p = { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material, candidates: [{ ...candidate, unknownIds: ['q'] }], questions, acceptedCandidateIds: [], executed: false as const }
  assert.throws(() => acceptPreparation(p, ['count']), code('STORY_PREPARATION_UNKNOWN_DEPENDENCY'))
  assert.deepEqual(p.acceptedCandidateIds, [])
})

test('candidate reference contract separates unknown material from question dependencies without repairing evidence', () => {
  const before = structuredClone(material)
  assert.deepEqual(preparationReferenceContract(material).knownMaterialIds, ['m0','m1','m2','m3'])
  assert.deepEqual(preparationReferenceContract(material).preconditionMaterialIds, ['m1','m2','m3'])
  assert.deepEqual(preparationReferenceContract(material).questionMaterialIds, material.map(m => m.id))
  const questions = [{ id: 'q', question: '差异原因是什么？', materialIds: ['m4'] }]
  for (const field of ['materialIds','preconditionIds','resultBasisIds'] as const) {
    assert.throws(() => parsePreparationCandidates({ candidates: [{ ...candidate, [field]: ['m4'] }], questions }, material),
      (e: unknown) => e instanceof AppError && e.code === 'STORY_PREPARATION_INVALID_OUTPUT'
        && e.message.includes(`candidates[0].${field}`) && e.message.includes('m4'))
  }
  assert.throws(() => parsePreparationCandidates({ candidates: [{ ...candidate, preconditionIds: ['m0'] }], questions: [] }, material),
    (e: unknown) => e instanceof AppError && e.message.includes('candidates[0].preconditionIds'))
  assert.throws(() => parsePreparationCandidates({ candidates: [{ ...candidate, preconditionIds: ['a0'] }], questions: [] }, material),
    (e: unknown) => e instanceof AppError && e.message.includes('candidates[0].preconditionIds'))
  assert.throws(() => parsePreparationCandidates({ candidates: [{ ...candidate, unknownIds: ['m4'] }], questions }, material),
    (e: unknown) => e instanceof AppError && e.message.includes('candidates[0].unknownIds'))
  const pending = { ...candidate, resultBasisIds: [], unknownIds: ['q'] }
  assert.deepEqual(parsePreparationCandidates({ candidates: [pending], questions }, material), { candidates: [pending], questions })
  assert.deepEqual(material, before)
})

test('new possible result may have no author result quote while keeping its goal source', () => {
  const original = { ...candidate, resultBasisIds: [], unknownIds: [] }
  const parsed = parsePreparationCandidates({ candidates: [original], questions: [] }, material)
  assert.deepEqual(parsed.candidates[0]?.resultBasisIds, [])
  const preparation = { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material,
    candidates: parsed.candidates, questions: [], acceptedCandidateIds: [], executed: false as const }
  const accepted = acceptPreparation(preparation, [candidate.id])
  assert.deepEqual(accepted.candidates[0]?.materialIds, ['m0'])
  assert.deepEqual(accepted.candidates[0]?.resultBasisIds, [])
  assert.equal(accepted.executed, false)
})

test('a model-created result without an author result quote reaches the reviewable curve', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const proposed = { ...candidate, resultBasisIds: [], unknownIds: [] }
  const curve = { id: 'creative-result', title: '待审', status: 'draft' as const, brief, beats: [], instructions: [], createdAt: 1, updatedAt: 1,
    preparation: { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material,
      candidates: [proposed], questions: [], acceptedCandidateIds: [], executed: false as const } }
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const prompt = request.messages[0].content as string
    const output = prompt.includes('核对作者目标分类') ? { goalMaterialId: 'm0' } : { steps: [
      { kind: 'current-state', displayMaterialIds: ['m0'], candidateIds: [], materialIds: ['m0','m1','m2','m3'] },
      { kind: 'trigger', displayMaterialIds: [], candidateIds: [proposed.id], materialIds: ['m0'] },
      { kind: 'resolution', displayMaterialIds: [], candidateIds: [proposed.id], materialIds: [] },
    ], supplements: [] }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    const mapped = await generateCurveFromPreparation(curve, [proposed.id])
    assert.equal(mapped.beats.at(-1)?.detail, proposed.possibleResult)
    assert.deepEqual(mapped.reasoning?.relations[0]?.basis, { kind: 'design-proposal', evidence: [], unknownIds: [] })
    assert.deepEqual(mapped.reasoning?.relations[0]?.toIds, ['prepared-goal'])
    assert.deepEqual(mapped.preparation?.candidates[0]?.resultBasisIds, [])
    assert.equal(mapped.preparation?.executed, false)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('causal bridge may describe a new change without pretending it came from author text', () => {
  const proposed = { ...candidate, resultBasisIds: [], causalBridge: {
    method: '方屿先逐项核对书单。', change: '核对后可能发现新的差异。', methodBasisIds: ['m0'], changeBasisIds: [],
  } }
  const parsed = parsePreparationCandidates({ candidates: [proposed], questions: [] }, material)
  assert.deepEqual(parsed.candidates[0]?.causalBridge?.changeBasisIds, [])
  assert.throws(() => parsePreparationCandidates({ candidates: [{ ...proposed, causalBridge: {
    ...proposed.causalBridge, changeBasisIds: ['m4'],
  } }], questions: [] }, material), code('STORY_PREPARATION_INVALID_OUTPUT'))
})
test('opt-in preparation diagnostics retain passing quality judgments without exposing requests', async () => {
  const originalFetch = globalThis.fetch, originalWarn = console.warn
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL, diagnostics: process.env.STORY_PREPARATION_DIAGNOSTICS }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'; process.env.STORY_PREPARATION_DIAGNOSTICS = 'true'
  const logs: string[] = []
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  globalThis.fetch = async (_url, init) => {
    const staged = stagedFixture(init); if (staged) return staged
    const request = JSON.parse(String(init?.body)), prompt = request.messages[0].content as string, input = JSON.parse(request.messages[1].content)
    if (prompt.includes('审查故事提案质量')) assert.equal(request.max_tokens, 1800)
    const output = prompt.includes('先整理作者材料') ? classification
      : prompt.includes('核对人物当下意图') ? mockIntent(input, ['m0'])
      : prompt.includes('从作者的想法提出恰好三种') ? { candidates: directions, questions: [] }
      : { ...qualityPass, checks: qualityPass.checks.map(check => ({ ...check, evidence: `${check.evidence}${'x'.repeat(250)}` })) }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    await generateStoryPreparation(source.text, brief)
    const reviewLog = logs.find(line => line.startsWith('[preparation] review '))
    assert.ok(reviewLog)
    const record = JSON.parse(reviewLog.slice('[preparation] review '.length))
    assert.equal(record.stage, 'quality')
    assert.equal(record.attempt, 1)
    assert.deepEqual(record.candidateIds, ['c0', 'c1', 'c2'])
    assert.equal(record.decision.checks.length, 5)
    assert.ok(record.decision.checks[0].evidence.length > 240)
    assert.deepEqual(record.decision.issues, [])
    assert.ok(!reviewLog.includes('DASHSCOPE_API_KEY'))
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
    for (const [key, value] of [['DASHSCOPE_API_KEY', env.key], ['STORY_DISABLE_MODEL', env.disable], ['STORY_PREPARATION_DIAGNOSTICS', env.diagnostics]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value
    }
  }
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
      const directionInput = JSON.parse(input.messages[1].content)
      assert.deepEqual(directionInput.referenceContract, preparationReferenceContract(material))
      assert.deepEqual(directionInput.mainlineAnchors, [{ kind: 'action', quote: source.text.slice(0, 2) }])
      assert.deepEqual(directionInput.mainlineGoals, [source.text])
      assert.deepEqual(directionInput.creativeFocus, { authority: 'creative-reference', excerpts: [material[0]!.quote] })
      assert.ok(!JSON.stringify(directionInput.mainlineAnchors).includes('a0'))
    }
    if (simple) {
      const user = JSON.parse(input.messages[1].content)
      assert.deepEqual(user.authorReview, review)
      assert.equal(user.acceptedCandidates[0].possibleResult, review.candidates[0]!.possibleResult)
      assert.equal(user.brief, undefined)
    }
    calls++
    const response = prompt.includes('核对人物当下意图') ? mockIntent(JSON.parse(input.messages[1].content), ['m0']) : prompt.includes('审查故事提案质量') ? qualityPass : prompt.includes('先整理作者材料') ? classification : prompt.includes('从作者的想法提出恰好三种') ? { candidates: directions, questions: [] }
      : prompt.includes('核对因果桥是否违背作者已定事实') ? factPass(JSON.parse(input.messages[1].content).candidates.map((c: typeof candidate) => c.id))
      : prompt.includes('审查每条方向的') ? { checks: JSON.parse(input.messages[1].content).proposals.map((c: typeof candidate) => ({ id: c.id, valid: true, issueType: 'none', reason: '故事连接成立。' })) }
      : { steps: (simple ? ['current-state','trigger','resolution'] : ['current-state','trigger','escalation','climax-choice','resolution']).map((kind, i) => ({ kind, displayMaterialIds: i ? [] : ['m0'], candidateIds: i ? [bad ? 'invented' : 'c0'] : [], materialIds: kind === 'resolution' ? ['m1'] : i ? ['m0'] : ['m0','m1','m2','m3'] })), supplements: [] }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(response), init) } }] }), { status: 200 })
  }
  try {
    const curve = await generateStoryPreparation(source.text, brief)
    assert.equal(calls, 4); assert.deepEqual(curve.beats, []); assert.equal(curve.foundation, undefined)
    assert.deepEqual(curve.preparation!.appealMaterialIds, ['m0'])
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

test('future story choice remains an editable proposal through acceptance', () => {
  const parsed = parsePreparationCandidates({ candidates: [{ ...candidate, futureChoice: '核对后要公开差异，还是先寻找原因？' }], questions: [] }, material)
  assert.equal(parsed.candidates[0]?.futureChoice, '核对后要公开差异，还是先寻找原因？')
  const preparation = { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material,
    candidates: parsed.candidates, questions: [], acceptedCandidateIds: [], executed: false as const }
  const review = { originalText: '我选择这条未来故事方向，尚未发生。', candidates: [{ id: candidate.id,
    action: candidate.action, possibleResult: candidate.possibleResult,
    futureChoice: '如果发现差异，他要决定先告诉同伴，还是先核对原始记录。' }] }
  const accepted = acceptPreparation(preparation, [candidate.id], review)
  assert.equal(accepted.candidates[0]?.futureChoice, review.candidates[0]?.futureChoice)
  assert.equal(accepted.executed, false)
  assert.equal(accepted.originalCandidates?.[0]?.futureChoice, parsed.candidates[0]?.futureChoice)
  const cleared = acceptPreparation(preparation, [candidate.id], { ...review,
    candidates: [{ ...review.candidates[0]!, futureChoice: '' }] })
  assert.equal(cleared.candidates[0]?.futureChoice, undefined)
  assert.equal(cleared.originalCandidates?.[0]?.futureChoice, parsed.candidates[0]?.futureChoice)
  assert.throws(() => acceptPreparation(preparation, [candidate.id], { ...review,
    candidates: [{ ...review.candidates[0]!, action: `${candidate.action} Changed`, possibleResult: `${candidate.possibleResult} Changed`, futureChoice: parsed.candidates[0]!.futureChoice }] }),
  code('STORY_PREPARATION_DERIVED_RESULT_STALE'))
  assert.throws(() => acceptPreparation(preparation, [candidate.id], { ...review,
    candidates: [{ ...review.candidates[0]!, possibleResult: `${candidate.possibleResult} Changed`, futureChoice: parsed.candidates[0]!.futureChoice }] }),
  code('STORY_PREPARATION_DERIVED_RESULT_STALE'))
})

test('causal bridge remains internal future design with explicit material references', () => {
  assert.throws(() => parsePreparationCandidates({ candidates: [null], questions: [] }, material), code('STORY_PREPARATION_INVALID_OUTPUT'))
  const withBridge = { candidates: [{ ...candidate, causalBridge: {
    method: '方屿先逐项核对书单与实物。', change: '核对后可能发现数量差异，原有安排需要重新判断。',
    methodBasisIds: ['m0'], changeBasisIds: ['m1'],
  } }], questions: [] }
  const parsed = parsePreparationCandidates(withBridge, material)
  assert.equal(parsed.candidates[0]?.causalBridge?.methodBasisIds[0], 'm0')
  assert.equal(parsed.candidates[0]?.causalBridge?.changeBasisIds[0], 'm1')
  assert.throws(() => parsePreparationCandidates({ candidates: [{ ...candidate, causalBridge: {
    method: '方屿先逐项核对书单与实物。', change: '方屿先逐项核对书单与实物。', methodBasisIds: ['m0'], changeBasisIds: ['m1'],
  } }], questions: [] }, material), code('STORY_PREPARATION_INVALID_OUTPUT'))
})

test('generated proposal fields enforce 240 characters and report the exact field', () => {
  const maxText = '青'.repeat(240)
  for (const field of ['action', 'possibleResult', 'futureChoice'] as const) {
    const proposal = { ...candidate, [field]: maxText }
    assert.equal(parsePreparationCandidates({ candidates: [proposal], questions: [] }, material).candidates[0]?.[field], maxText)
    assert.throws(() => parsePreparationCandidates({ candidates: [{ ...proposal, [field]: '青'.repeat(267) }], questions: [] }, material),
      (error: unknown) => error instanceof AppError && error.message.includes(`candidates[0].${field}`))
  }
  const bridge = { method: maxText, change: '可能出现新局面。', methodBasisIds: ['m0'], changeBasisIds: [] }
  assert.equal(parsePreparationCandidates({ candidates: [{ ...candidate, causalBridge: bridge }], questions: [] }, material).candidates[0]?.causalBridge?.method, maxText)
  assert.throws(() => parsePreparationCandidates({ candidates: [{ ...candidate, causalBridge: { ...bridge, method: '青'.repeat(267) } }], questions: [] }, material),
    (error: unknown) => error instanceof AppError && error.message.includes('candidates[0].causalBridge.method'))
})

test('length recovery repairs all overflowing generated fields together, preserves references and still runs content review', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const overlong = structuredClone(directions)
  overlong[0]!.action = candidate.action + '说明'.repeat(130)
  overlong[2]!.possibleResult = directions[2]!.possibleResult + '补充'.repeat(130)
  let mode: 'valid' | 'missing' | 'still-long' | 'extra' = 'valid'
  let generations = 0, repairs = 0, reviews = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), prompt = request.messages[0].content as string, input = JSON.parse(request.messages[1].content)
    let output: unknown
    if (prompt.startsWith('只压缩系统提案')) {
      repairs++
      assert.deepEqual(input.fields.map((field: { path: string }) => field.path), ['candidates[0].action', 'candidates[2].possibleResult'])
      assert.ok(input.fields.every((field: { actualLength: number; maxLength: number }) => field.actualLength > field.maxLength))
      output = { texts: input.fields.map((field: { id: string; path: string }) => ({ id: field.id,
        text: mode === 'still-long' ? '长'.repeat(241) : field.path.endsWith('.action') ? directions[0]!.action : directions[2]!.possibleResult })) }
      if (mode === 'missing') output = { texts: [] }
      if (mode === 'extra') output = { ...(output as object), materialIds: ['invented'] }
    } else {
      const staged = stagedFixture(init); if (staged) return staged
      if (prompt.includes('先整理作者材料')) output = classification
      else if (prompt.includes('核对人物当下意图')) output = mockIntent(input, ['m0'])
      else if (prompt.includes('从作者的想法提出恰好三种')) { generations++; output = { candidates: overlong, questions: [] } }
      else if (prompt.includes('审查故事提案质量')) {
        reviews++
        assert.deepEqual(input.proposal.candidates, directions)
        output = qualityPass
      } else throw Error('Unexpected test request')
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    const curve = await generateStoryPreparation(source.text, brief)
    assert.deepEqual(curve.preparation!.candidates.map(c => c.action), directions.map(c => c.action))
    assert.equal(generations, 1); assert.equal(repairs, 1); assert.equal(reviews, 1)
    for (const invalidMode of ['missing', 'still-long', 'extra'] as const) {
      mode = invalidMode
      const before: { generations: number; repairs: number; reviews: number } = { generations, repairs, reviews }
      await assert.rejects(() => generateStoryPreparation(source.text, brief),
        (error: unknown) => error instanceof AppError && error.code === (invalidMode === 'still-long'
          ? 'STORY_PREPARATION_INVALID_OUTPUT' : 'QWEN_OUTPUT_SCHEMA_FAILED')
          && error.modelDiagnostic?.stage === (invalidMode === 'still-long'
            ? 'preparation-directions-text-length' : 'preparation-directions-text-length:response-schema'))
      assert.equal(generations, before.generations + 1)
      assert.equal(repairs, before.repairs + (invalidMode === 'still-long' ? 1 : 2))
      assert.equal(reviews, before.reviews)
    }
    assert.ok(overlong[0]!.action.length > 240)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of [['DASHSCOPE_API_KEY', env.key], ['STORY_DISABLE_MODEL', env.disable]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value }
  }
})

test('an overlong causal bridge is compressed without regenerating its other fields', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const base = [{ ...candidate, futureChoice: undefined, causalBridge: undefined }]
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const input = JSON.parse(request.messages[1].content)
    calls++
    let output: unknown
    if (calls === 1) {
      output = { bridges: [{ id: candidate.id, method: '青'.repeat(267),
        change: '可能发现差异。', methodBasisIds: ['m0'], changeBasisIds: [] }],
        futureChoices: [{ id: candidate.id, text: '先公开差异，还是继续核对？' }] }
    } else if (calls === 2) {
      assert.equal(input.fields.length, 1)
      assert.equal(input.fields[0].path, 'developments[0].attempt.text')
      assert.equal(input.fields[0].actualLength, 267)
      output = { texts: [{ id: input.fields[0].id, text: '方屿逐项核对书单。' }] }
    } else if (request.messages[0].content.includes('核对因果桥是否违背作者已定事实')) {
      output = factPass([candidate.id])
    } else {
      output = { checks: [{ id: candidate.id, valid: true, issueType: 'none', reason: '仍围绕核对书单。' }] }
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    const result = await projectFutureChoices(base, [source], brief)
    assert.equal(calls, 4)
    assert.equal(result[0]?.causalBridge?.method, '方屿逐项核对书单。')
    assert.equal(result[0]?.causalBridge?.change, '可能发现差异。')
    assert.equal(result[0]?.futureChoice, '先公开差异，还是继续核对？')
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('editing a direction invalidates its derived causal bridge', () => {
  const p = { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material, candidates: [{ ...candidate,
    causalBridge: { method: '先核对书单。', change: '核对后可能发现差异。', methodBasisIds: ['m0'], changeBasisIds: ['m1'] },
  }], questions: [], acceptedCandidateIds: [], executed: false as const }
  const accepted = acceptPreparation(p, [candidate.id], { originalText: '作者编辑方向', candidates: [{ id: candidate.id,
    action: `${candidate.action} 改写`, possibleResult: `${candidate.possibleResult} 改写`, futureChoice: '' }] })
  assert.equal(accepted.candidates[0]?.causalBridge, undefined)
  assert.equal(accepted.originalCandidates?.[0]?.causalBridge?.method, '先核对书单。')
})

test('future choice review requires all causal bridges before directions can be shown', async () => {
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL, diagnostics: process.env.STORY_PREPARATION_DIAGNOSTICS }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'; process.env.STORY_PREPARATION_DIAGNOSTICS = 'true'
  const base = directions.map(({ futureChoice, causalBridge, ...rest }) => rest)
  let calls = 0
  const logs: string[] = []
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const input = JSON.parse(request.messages[1].content)
    calls++
    if (input.candidates) assert.equal(input.candidates.length, calls >= 4 ? 2 : 3)
    const content = calls === 1 || calls === 4
      ? { bridges: input.candidates.map((item: typeof base[number]) => ({ id: item.id, method: item.action, change: item.possibleResult, methodBasisIds: ['m0'], changeBasisIds: ['m1'] })),
          futureChoices: input.candidates.map((item: typeof base[number], index: number) => ({ id: item.id, text: `Future story tradeoff ${index}` })) }
      : calls === 2 || calls === 5 ? factPass(input.candidates.map((item: typeof base[number]) => item.id))
       : { checks: input.proposals.map((item: typeof base[number]) => ({ id: item.id, valid: item.id === base[0]!.id,
           issueType: item.id === base[0]!.id ? 'none' : 'world-implausible',
           reason: item.id !== base[0]!.id ? 'Invented required resource' : 'Distinct future choice' })) }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(content), init) } }] }))
  }
  try {
    await assert.rejects(() => projectFutureChoices(base, [source], brief), code('STORY_PREPARATION_QUALITY_FAILED'))
    assert.equal(calls, 6)
    assert.ok(base.every(item => !('futureChoice' in item)))
    const proposals = logs.filter(line => line.startsWith('[preparation] projection '))
      .map(line => JSON.parse(line.slice('[preparation] projection '.length)))
    assert.deepEqual(proposals.map(proposal => [proposal.attempt, proposal.bridges.length]), [[1, 3], [2, 2]])
    const reviewLog = logs.find(line => line.startsWith('[preparation] review '))
    assert.ok(reviewLog)
    const decision = JSON.parse(reviewLog.slice('[preparation] review '.length))
    assert.equal(decision.stage, 'future-choice')
    assert.equal(decision.decision.checks[1].reason, 'Invented required resource')
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
    if (env.diagnostics === undefined) delete process.env.STORY_PREPARATION_DIAGNOSTICS; else process.env.STORY_PREPARATION_DIAGNOSTICS = env.diagnostics
  }
})

test('invalid future choice review cannot release directions without causal bridges', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const base = directions.map(({ futureChoice, causalBridge, ...rest }) => rest)
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    calls++
    const content = calls === 1
      ? { bridges: base.map(item => ({ id: item.id, method: item.action, change: item.possibleResult, methodBasisIds: ['m0'], changeBasisIds: ['m1'] })),
          futureChoices: base.map(item => ({ id: item.id, text: 'A future choice' })) }
       : { checks: [{ id: base[0]!.id, valid: true, sourceId: null, quote: null, reason: 'Incomplete review' }] }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(content), init) } }] }))
  }
  try {
    await assert.rejects(() => projectFutureChoices(base, [source], brief), code('QWEN_OUTPUT_SCHEMA_FAILED'))
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('future choice repair rewrites only rejected direction and preserves approved bridges', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const base = directions.map(({ futureChoice, causalBridge, ...rest }) => rest)
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const input = JSON.parse(request.messages[1].content)
    calls++
    let content
    if (calls === 1 || calls === 4) {
      const expected = calls === 4 ? [base[1]!.id] : base.map(item => item.id)
      assert.deepEqual(input.candidates.map((item: typeof base[number]) => item.id), expected)
      if (calls === 4) {
        assert.match(input.repairReasons[0].reason, /原愿望、关系或代价/)
        assert.equal(input.repairReasons[0].issueType, 'mainline-drift')
        assert.deepEqual(input.previousProjections.map(({ developmentState, ...rest }: any) => rest), [{ id: base[1]!.id,
          bridge: { id: base[1]!.id, method: `Method ${base[1]!.id}`, change: `Change ${base[1]!.id}`, methodBasisIds: ['m0'], changeBasisIds: [] },
          futureChoice: `Choice ${base[1]!.id}` }])
      }
      content = { bridges: input.candidates.map((item: typeof base[number]) => ({ id: item.id,
        method: calls === 4 ? 'Ask the park desk to verify the ticket' : `Method ${item.id}`,
        change: calls === 4 ? 'Ticket verification may let her enter the park' : `Change ${item.id}`,
        methodBasisIds: ['m0'], changeBasisIds: [] })),
        futureChoices: input.candidates.map((item: typeof base[number]) => ({ id: item.id, text: calls === 4 ? 'Enter the park or ask the friend to wait' : `Choice ${item.id}` })) }
    } else if (calls === 2 || calls === 5) {
      assert.deepEqual(input.candidates.map((item: typeof base[number]) => item.id), calls === 5 ? [base[1]!.id] : base.map(item => item.id))
      content = factPass(input.candidates.map((item: typeof base[number]) => item.id))
    } else {
      assert.deepEqual(input.proposals.map((item: typeof base[number]) => item.id), calls === 6 ? [base[1]!.id] : base.map(item => item.id))
      content = { checks: input.proposals.map((item: typeof base[number]) => ({ id: item.id, valid: calls === 6 || item.id !== base[1]!.id,
        issueType: calls === 6 || item.id !== base[1]!.id ? 'none' : 'mainline-drift',
        reason: item.id === base[1]!.id && calls === 3 ? 'Unexplained school system link diverts the park goal' : 'Coherent story direction' })) }
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(content), init) } }] }))
  }
  try {
    const projected = await projectFutureChoices(base, [source], brief)
    assert.equal(calls, 6)
    assert.equal(projected[0]?.causalBridge?.method, `Method ${base[0]!.id}`)
    assert.equal(projected[1]?.causalBridge?.method, 'Ask the park desk to verify the ticket')
    assert.equal(projected[1]?.causalBridge?.change, 'Ticket verification may let her enter the park')
    assert.equal(projected[2]?.causalBridge?.method, `Method ${base[2]!.id}`)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('malformed bridge repair keeps approved directions and has its own bounded format retry', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const base = structuredClone(directions), target = base[1]!.id
  let generations = 0, factReviews = 0, causalReviews = 0, compressions = 0, alwaysMalformed = false, oversized = false
  let malformed: unknown
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), prompt = request.messages[0].content as string
    const input = JSON.parse(request.messages[1].content)
    let output: unknown
    if (prompt.startsWith('只压缩系统提案中超长的文字字段')) {
      compressions++
      output = { texts: [] }
    } else if (prompt.startsWith('你是故事大纲编辑')) {
      generations++
      assert.deepEqual(input.candidates.map((c: { id: string }) => c.id), [target])
      if (generations === 2) {
        assert.deepEqual(input.previousOutput, malformed)
        assert.ok(input.validationFailure)
        assert.equal(input.repairReasons[0].id, target)
      }
      output = { bridges: [{ id: target, method: oversized ? '字'.repeat(267) : '方屿请同伴一起重新清点。', change: '同伴指出另一种分类，二人需要商定采用哪一种。',
        methodBasisIds: ['m0'], changeBasisIds: [] }], futureChoices: !oversized && (generations === 1 || alwaysMalformed)
        ? [{ id: 'wrong-a', text: '先商量。' }, { id: 'wrong-b', text: '先计数。' }]
        : [{ id: target, text: '先商定分类以共同核对，还是分开计数再比较差异？' }] }
      if (generations === 1) malformed = JSON.parse(JSON.stringify(projectionWire(output)))
    } else if (prompt.startsWith('核对因果桥是否违背作者已定事实')) {
      factReviews++
      output = factPass(input.candidates.map((c: { id: string }) => c.id))
    } else {
      causalReviews++
      assert.deepEqual(input.proposals.map((c: { id: string }) => c.id), causalReviews === 1 ? base.map(c => c.id) : [target])
      output = { checks: input.proposals.map((c: { id: string }) => ({ id: c.id,
        valid: causalReviews > 1 || c.id !== target, issueType: causalReviews > 1 || c.id !== target ? 'none' : 'causal-gap',
        reason: c.id === target && causalReviews === 1 ? '原办法未解释分类分歧怎样影响后续核对。' : '行动引出相关变化与取舍。' })) }
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    const output = await projectFutureChoices(base, [source], brief)
    assert.deepEqual([generations, factReviews, causalReviews], [2, 2, 2])
    assert.deepEqual(base, directions)
    for (const kept of [base[0]!, base[2]!]) assert.deepEqual(output.find(c => c.id === kept.id), kept)
    assert.equal(output[1]!.causalBridge!.method, '方屿请同伴一起重新清点。')
    generations = factReviews = causalReviews = 0; alwaysMalformed = true
    await assert.rejects(() => projectFutureChoices(base, [source], brief), (error: unknown) => error instanceof AppError
      && error.modelDiagnostic?.stage === 'preparation-future-choice:response-schema')
    assert.deepEqual([generations, factReviews, causalReviews], [2, 1, 1])
    assert.deepEqual(base, directions)
    generations = factReviews = causalReviews = 0; alwaysMalformed = false; oversized = true
    await assert.rejects(() => projectFutureChoices(base, [source], brief), (error: unknown) => error instanceof AppError
      && error.code === 'QWEN_OUTPUT_SCHEMA_FAILED'
      && error.modelDiagnostic?.stage === 'preparation-future-choice-text-length:response-schema')
    assert.deepEqual([generations, factReviews, causalReviews, compressions], [1, 1, 1, 2])
    assert.deepEqual(base, directions)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('approved causal bridges are attached to every direction', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const base = directions.map(({ futureChoice, causalBridge, ...rest }) => rest)
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    ++calls
    const content = calls === 1
      ? { bridges: base.map(item => ({ id: item.id, method: item.action, change: item.possibleResult, methodBasisIds: ['m0'], changeBasisIds: ['m1'] })),
          futureChoices: base.map(item => ({ id: item.id, text: `A future choice ${'x'.repeat(110)}` })) }
      : calls === 2 ? { checks: base.map(item => ({ id: item.id, valid: true, sourceId: null, quote: null, reason: '无冲突' })) }
       : { checks: base.map(item => ({ id: item.id, valid: true, issueType: 'none', reason: '无问题' })) }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(content), init) } }] }))
  }
  try {
    const projected = await projectFutureChoices(base, [source], brief)
    assert.equal(calls, 3)
    assert.ok(projected.every(item => item.causalBridge && item.futureChoice))
    assert.ok(projected.every(item => item.futureChoice!.length > 100))
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('a malformed causal review retries the unchanged proposal instead of regenerating its bridges', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const base = directions.map(({ futureChoice, causalBridge, ...rest }) => rest)
  let generations = 0, factReviews = 0, causalReviews = 0
  let reviewedProposals: unknown
  const incomplete = { checks: [{ id: base[0]!.id, valid: true, issueType: 'none', reason: '无问题' }] }
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const prompt = request.messages[0].content as string
    const input = JSON.parse(request.messages[1].content)
    let output: unknown
    if (prompt.includes('你是故事大纲编辑')) {
      generations++
      output = { bridges: base.map(item => ({ id: item.id, method: item.action, change: item.possibleResult,
        methodBasisIds: ['m0'], changeBasisIds: [] })),
        futureChoices: base.map(item => ({ id: item.id, text: `继续核对 ${item.id}，还是先与同伴协商？` })) }
    } else if (prompt.includes('核对因果桥是否违背作者已定事实')) {
      factReviews++
      output = factPass(base.map(item => item.id))
    } else {
      causalReviews++
      if (causalReviews === 1) {
        reviewedProposals = input.proposals
        output = incomplete
      } else {
        assert.deepEqual(input.proposals, reviewedProposals)
        assert.deepEqual(input.previousOutput, JSON.parse(modelJson(incomplete)))
        assert.match(input.validationFailure, /至少 3 项/)
        output = { checks: base.map(item => ({ id: item.id, valid: true, issueType: 'none', reason: '无问题' })) }
      }
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    const projected = await projectFutureChoices(base, [source], brief)
    assert.deepEqual([generations, factReviews, causalReviews], [1, 1, 2])
    assert.deepEqual(projected.map(item => item.causalBridge?.method), base.map(item => item.action))
    assert.ok(projected.every(item => item.causalBridge && item.futureChoice))
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('a rejected causal bridge still requires a concrete reason', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const base = [directions[0]!]
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    calls++
    const output = prompt.includes('你是故事大纲编辑')
      ? { bridges: [{ id: base[0]!.id, ...base[0]!.causalBridge }], futureChoices: [{ id: base[0]!.id, text: base[0]!.futureChoice }] }
      : prompt.includes('核对因果桥是否违背作者已定事实')
      ? { checks: [{ id: base[0]!.id, valid: true, sourceId: null, quote: null, reason: '无冲突' }] }
      : { checks: [{ id: base[0]!.id, valid: false, issueType: 'causal-gap' }] }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(output), init) } }] }))
  }
  try {
    await assert.rejects(() => projectFutureChoices(base, [source], brief),
      (error: unknown) => error instanceof AppError && error.code === 'QWEN_OUTPUT_SCHEMA_FAILED'
        && error.modelDiagnostic?.reason?.includes('reason') === true)
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('causal review reports the exact field when an explanation exceeds the safety limit', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const base = directions.map(({ futureChoice, causalBridge, ...rest }) => rest)
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const content = ++calls === 1
      ? { bridges: base.map(item => ({ id: item.id, method: item.action, change: item.possibleResult, methodBasisIds: ['m0'], changeBasisIds: ['m1'] })),
          futureChoices: base.map(item => ({ id: item.id, text: 'A future choice' })) }
      : calls === 2 ? factPass(base.map(item => item.id))
       : { checks: base.map((item, index) => ({ id: item.id, valid: true, issueType: 'none', reason: index ? 'Coherent' : 'x'.repeat(501) })) }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(content), init) } }] }))
  }
  try {
    await assert.rejects(() => projectFutureChoices(base, [source], brief), (error: unknown) =>
      error instanceof AppError && error.code === 'STORY_PREPARATION_INVALID_OUTPUT'
      && /checks\[c0\]\.reason长度为 501，超过 500 字上限/.test(error.message))
    assert.equal(calls, 4)
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})

test('curve arrangement excludes derived projections and keeps long reviewed evidence and history', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const projected = { ...candidate, causalBridge: { method: '只供方向审阅的派生办法，不是核心曲线可复制文字。', change: '只供方向审阅的派生变化。', methodBasisIds: ['m0'], changeBasisIds: [] } }
  const curve = { id: 'long-review', title: '待审', status: 'draft' as const, brief, beats: [], instructions: [], createdAt: 1, updatedAt: 1,
    preparation: { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material, candidates: [projected], questions: [], acceptedCandidateIds: [], executed: false as const } }
  let longText = '合成作者审阅的未来可能结果：画被完整装入封套，未折叠，符合朋友要求且获准状态持续有效'
  let invalidReference = false, calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    const user = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
    const revised = user.acceptedCandidates[0]
    assert.equal(Object.hasOwn(revised, 'causalBridge'), false)
    assert.equal(Object.hasOwn(revised, 'futureChoice'), false)
    const steps = ['current-state','trigger','resolution'].map((kind, i) => {
      const content = i === 0 ? material[0]!.quote : i === 1 ? revised.action : revised.possibleResult
      return { kind, displayMaterialIds: i ? [] : ['m0'], candidateIds: i ? [candidate.id] : [], materialIds: invalidReference ? ['absent'] : kind === 'resolution' ? ['m1'] : i ? ['m0'] : ['m0','m1','m2','m3'] }
    })
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson({ steps, supplements: [] }) } }] }), { status: 200 })
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
      assert.deepEqual(mapped.preparation!.originalCandidates, [projected])
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
  assert.deepEqual(acceptPreparation(p, [candidate.id], revised).candidates[0]?.resultBasisIds, [])
  assert.deepEqual(p.candidates, [candidate])
})

test('curve ID arrangement renders accepted wording and contiguous context while rejecting unknown or absent references', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const curve = { id: 'id-arrangement', title: '待审', status: 'draft' as const, brief, beats: [], instructions: [], createdAt: 1, updatedAt: 1,
    preparation: { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material, candidates: [candidate], questions: [], acceptedCandidateIds: [], executed: false as const } }
  let display = ['m0', 'm1'], refs = [candidate.id]
  let transientUnknown = false, optionalChoice = false, arrangementCalls = 0
  globalThis.fetch = async (_url, init) => {
    arrangementCalls++
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
    assert.ok(!input.material.some((item: { id: string }) => item.id === 'm4'))
    assert.deepEqual(input.referenceContract.knownMaterialIds, ['m0', 'm1', 'm2', 'm3'])
    const firstMaterialIds = transientUnknown && !input.validationFailure ? ['m0', 'm4'] : ['m0', 'm1', 'm2', 'm3']
    if (optionalChoice && input.validationFailure) {
      assert.match(input.validationFailure, /steps\[2\].*climax-choice.*materialIds/)
      assert.deepEqual(input.acceptedCandidates[0].action, candidate.action)
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson({ steps: [
    { kind: 'current-state', candidateIds: [], materialIds: firstMaterialIds, displayMaterialIds: display },
    { kind: 'trigger', displayMaterialIds: [], candidateIds: refs, materialIds: ['m0'] },
    ...(optionalChoice ? [{ kind: 'climax-choice', displayMaterialIds: [], candidateIds: refs, materialIds: input.validationFailure ? ['m0'] : [] }] : []),
    { kind: 'resolution', displayMaterialIds: [], candidateIds: [candidate.id], materialIds: ['m1'] },
  ], supplements: [] }) } }] }))
  }
  try {
    const mapped = await generateCurveFromPreparation(curve, [candidate.id])
    assert.equal(mapped.beats[0]!.detail, material[0]!.quote + material[1]!.quote)
    assert.equal(mapped.beats[1]!.detail, candidate.action)
    assert.equal(mapped.beats.at(-1)!.detail, candidate.possibleResult)
    transientUnknown = true
    const beforeRetry = arrangementCalls
    const recovered = await generateCurveFromPreparation(curve, [candidate.id])
    assert.equal(arrangementCalls - beforeRetry, 2)
    assert.equal(recovered.beats[1]!.detail, candidate.action)
    transientUnknown = false
    optionalChoice = true
    const beforeChoiceRetry = arrangementCalls
    const withChoice = await generateCurveFromPreparation(curve, [candidate.id])
    assert.equal(arrangementCalls - beforeChoiceRetry, 2)
    assert.equal(withChoice.beats.length, 3)
    assert.equal(withChoice.beats[2]!.detail, candidate.possibleResult)
    assert.ok(withChoice.reasoning && 'steps' in withChoice.reasoning)
    const choiceBasis = withChoice.reasoning.steps[1]!.basis
    assert.ok('evidence' in choiceBasis)
    assert.deepEqual(choiceBasis.evidence.map(item => item.sourceId), ['m0'])
    assert.deepEqual(withChoice.reasoning.steps[2]!.dependsOn, ['beat-trigger'])
    optionalChoice = false
    display = ['m0', 'm2']
    assert.equal((await generateCurveFromPreparation(curve, [candidate.id])).beats[0]!.detail,
      material[0]!.quote + '\n' + material[2]!.quote)
    for (const invalidDisplay of [['m4'], ['absent']]) {
      display = invalidDisplay
      await assert.rejects(() => generateCurveFromPreparation(curve, [candidate.id]), code('STORY_PREPARATION_INVALID_OUTPUT'))
    }
    display = ['m0']; refs = ['absent']
    await assert.rejects(() => generateCurveFromPreparation(curve, [candidate.id]), code('STORY_PREPARATION_INVALID_OUTPUT'))
    assert.deepEqual(curve.beats, [])
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of [['DASHSCOPE_API_KEY', env.key], ['STORY_DISABLE_MODEL', env.disable]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value }
  }
})

for (const defect of ['action', 'result', 'invented-result'] as const) test(`curve references retry only arrangement for ${defect}`, async () => {
  const original = globalThis.fetch, saved = [process.env.DASHSCOPE_API_KEY, process.env.STORY_DISABLE_MODEL]
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const selected = { ...candidate, ...(defect === 'invented-result' ? { resultBasisIds: [] } : {}) }
  const curve = { id: 'reference-roles', title: '待审', status: 'draft' as const, brief, beats: [], instructions: [], createdAt: 1, updatedAt: 1,
    preparation: { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material, candidates: [selected], questions: [], acceptedCandidateIds: [], executed: false as const } }
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), input = JSON.parse(request.messages[1].content)
    assert.equal(request.response_format.json_schema.name, 'preparation-curve-generation')
    assert.deepEqual(input.referenceContract.stepReferences.byCandidate, [{ candidateId: selected.id, actionMaterialIds: ['m0'], resultMaterialIds: selected.resultBasisIds }])
    calls++
    if (calls === 2) {
      assert.match(input.validationFailure, defect === 'action' ? /actionMaterialIds/ : /resultMaterialIds/)
      assert.deepEqual(input.acceptedCandidates[0].action, selected.action)
    }
    const steps = [
      { kind: 'current-state', candidateIds: [], materialIds: ['m0','m1','m2','m3'], displayMaterialIds: ['m0'] },
      { kind: 'trigger', displayMaterialIds: [], candidateIds: [selected.id], materialIds: calls === 1 && defect === 'action' ? ['m2'] : ['m0'] },
      { kind: 'resolution', displayMaterialIds: [], candidateIds: [selected.id], materialIds: calls === 1 && defect !== 'action' ? ['m0'] : selected.resultBasisIds },
    ]
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ steps, supplements: [] }) } }] }))
  }
  try {
    const before = structuredClone(curve), result = await generateCurveFromPreparation(curve, [selected.id])
    assert.equal(calls, 2); assert.deepEqual(curve, before)
    assert.equal(result.beats.at(-1)!.detail, selected.possibleResult)
    assert.deepEqual(result.preparation!.candidates[0], selected)
  } finally {
    globalThis.fetch = original
    ;(['DASHSCOPE_API_KEY', 'STORY_DISABLE_MODEL'] as const).forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]
    })
  }
})

test('curve normalization merges repeated optional actions and their citations without another model request', async () => {
  const originalFetch = globalThis.fetch
  const saved = [process.env.DASHSCOPE_API_KEY, process.env.STORY_DISABLE_MODEL]
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const curve = { id: 'duplicate-actions', title: '待审', status: 'draft' as const, brief, beats: [], instructions: [], createdAt: 1, updatedAt: 1,
    preparation: { protocol: 1 as const, status: 'needs-review' as const, sources: [source], material, candidates: [{ ...candidate, materialIds: ['m0', 'm2'] }], questions: [], acceptedCandidateIds: [], executed: false as const } }
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ steps: [
      { kind: 'current-state', candidateIds: [], materialIds: ['m0', 'm1', 'm3'], displayMaterialIds: ['m0'] },
      { kind: 'trigger', displayMaterialIds: [], candidateIds: [candidate.id], materialIds: ['m0'] },
      { kind: 'escalation', displayMaterialIds: [], candidateIds: [candidate.id], materialIds: ['m2'] },
      { kind: 'climax-choice', displayMaterialIds: [], candidateIds: [candidate.id], materialIds: ['m0'] },
      { kind: 'resolution', displayMaterialIds: [], candidateIds: [candidate.id], materialIds: ['m1'] },
    ], supplements: [] }) } }] }))
  }
  try {
    const before = structuredClone(curve)
    const merged = await generateCurveFromPreparation(curve, [candidate.id])
    assert.equal(calls, 1)
    assert.deepEqual(merged.beats.map(b => b.kind), ['current-state', 'trigger', 'resolution'])
    assert.ok(merged.reasoning && 'steps' in merged.reasoning)
    assert.deepEqual(merged.reasoning.steps[1]!.actionIds, [candidate.id])
    const basis = merged.reasoning.steps[1]!.basis
    assert.ok('evidence' in basis)
    assert.deepEqual(basis.evidence.map(e => e.sourceId), ['m0', 'm2'])
    assert.deepEqual(merged.reasoning.steps[2]!.dependsOn, ['beat-trigger'])
    assert.deepEqual(curve, before)
  } finally {
    globalThis.fetch = originalFetch
    ;(['DASHSCOPE_API_KEY', 'STORY_DISABLE_MODEL'] as const).forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]
    })
  }
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
        return { kind, displayMaterialIds: i ? [] : ['m0'], candidateIds: i ? [candidate.id] : [], materialIds: kind === 'resolution' ? ['m1'] : i ? ['m0'] : ['m0','m1','m2','m3'] }
      }), supplements: [] }
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson(projectionWire(response), init) } }] }), { status: 200 })
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
  assert.deepEqual(acceptPreparation(p, ['count'], review).candidates[0]?.resultBasisIds, [])
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
    const steps: Record<string, any>[] = ['current-state','trigger','resolution'].map((kind, i) => ({ kind, displayMaterialIds: i ? [] : ['m0'], candidateIds: i ? ['count'] : [], materialIds: kind === 'resolution' ? ['m1'] : i ? ['m0'] : ['m0','m1','m2','m3'] }))
    if (smuggle === 'omit-condition' || (smuggle === 'recover-condition' && !user.coverageReview)) for (const step of steps) step.materialIds = step.materialIds.filter((id: string) => id !== 'm3')
    else if (smuggle === 'text' || smuggle === 'title') steps[1]![smuggle] = '必须先检查纸张有无破损。'
    const supplements = [{ id: 'inspection', kind: 'observation', text: '建议检查纸张有无破损。', question: '作者是否希望增加这个检查步骤？', materialIds: ['m0'] }]
    return new Response(JSON.stringify({ choices: [{ message: { content: modelJson({ steps, supplements }) } }] }), { status: 200 })
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
    for (const mode of ['text','title'] as const) { smuggle = mode; await assert.rejects(() => generateCurveFromPreparation(curve, ['count']), code('QWEN_OUTPUT_SCHEMA_FAILED')) }
    assert.equal(curve.beats.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of [['DASHSCOPE_API_KEY', env.key], ['STORY_DISABLE_MODEL', env.disable]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value }
  }
})
