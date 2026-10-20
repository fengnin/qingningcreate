import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleWrittenStory, reviseWritingDraft } from './storyWriting.js'
import { reviewWritingText, reviewWritingMainline, writingContext } from './storyWritingProtection.js'
import type { ConfirmedCurve, StoryWritingDraft, StoryWritingRequest } from '../../shared/story-contract.js'

async function withModelReplies(replies: unknown[], run: (requests: any[]) => Promise<void>) {
  const originalFetch = globalThis.fetch
  const saved = { key: process.env.DASHSCOPE_API_KEY, disabled: process.env.STORY_DISABLE_MODEL, model: process.env.QWEN_MODEL }
  const requests: any[] = []
  process.env.DASHSCOPE_API_KEY = 'test-key'; process.env.STORY_DISABLE_MODEL = 'false'; process.env.QWEN_MODEL = 'qwen-plus'
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request)
    assert.ok(replies.length, `Unexpected model call: ${request.response_format?.json_schema?.name}`)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }))
  }
  try { await run(requests); assert.equal(replies.length, 0) }
  finally {
    globalThis.fetch = originalFetch
    for (const [name, value] of Object.entries({ DASHSCOPE_API_KEY: saved.key, STORY_DISABLE_MODEL: saved.disabled, QWEN_MODEL: saved.model })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  }
}

const curve: ConfirmedCurve = { id: 'c', provisionalCurveId: 'p', title: '故事', confirmedAt: 1,
  brief: { tones: [], dramaticForces: [], allowSystemNamedCharacters: false }, beats: [
    { id: 'b1', kind: 'current-state', title: '起点', detail: '人物面对问题。', source: 'system-proposal', status: 'proposed', dependsOn: [] },
    { id: 'b2', kind: 'resolution', title: '回应', detail: '人物做出回应。', source: 'system-proposal', status: 'proposed', dependsOn: ['b1'] },
  ] }
const req = (action: StoryWritingRequest['action'], extra = {}): StoryWritingRequest => ({ storyId: 's', revision: 1, action, ...extra })
const prefix = (): StoryWritingDraft => ({ complete: false, segments: [
  { id: 's1', beatId: 'b1', label: '起点', text: '她站在窗边。', status: 'accepted' },
] })

const contractedCurve: ConfirmedCurve = { ...curve, designContract: {
  protocol: 1, authority: 'future-design', sourceHash: 'test',
  goal: { text: '去看球赛', sourceIds: ['goal'] }, mainlineGoals: [], mainlineAnchors: [],
  selectedDirection: '在时间压力下赶到球场', causalBridge: { method: '赶路', change: '时间压力变得具体' },
  nodes: [
    { beatId: 'b1', kind: 'current-state', text: '人物面对问题。', objective: '建立目标和阻碍', dependsOn: [], action: null, expectedChange: null, sourceIds: [] },
    { beatId: 'b2', kind: 'resolution', text: '人物做出回应。', objective: '推进目标', dependsOn: ['b1'], action: '赶往球场', expectedChange: '抵达或承担代价', sourceIds: [] },
  ],
} }

test('prose generation and final review receive supplemental requirements without anchor dependence', async () => {
  const c = structuredClone(contractedCurve)
  c.designContract!.authorRequirements = [{ id: 'boundary', sourceId: 'author-boundaries',
    quote: '必须靠自己的行动抵达，不能使用魔法。', kind: 'boundary', status: 'required' }]
  const context = writingContext('去看球赛', c, prefix(), 1)
  assert.deepEqual(context.authorRequirements, c.designContract!.authorRequirements)
  await withModelReplies([{ verdict: 'drift', reason: '正文用魔法瞬移，违反作者边界。', evidenceIds: ['author-requirement:boundary'] }], async requests => {
    const result = await reviewWritingMainline(context, '她施法瞬移到球场。', 'complete')
    assert.equal(result.verdict, 'drift')
    const input = JSON.parse(requests[0].messages[1].content)
    assert.deepEqual(input.authorRequirements, context.authorRequirements)
    assert.ok(input.evidenceCatalog.some((e: any) => e.id === 'author-requirement:boundary'))
  })
})

test('final review sees earlier confirmed nodes and author edits even with preparation present', async () => {
  const c = structuredClone(contractedCurve)
  c.preparation = { protocol: 1, status: 'accepted-design', executed: false, sources: [], material: [], candidates: [], acceptedCandidateIds: [], questions: [] }
  c.designContract!.authorRequirements = [{ id: 'edit-b1', sourceId: 'edit-b1', quote: '先向朋友确认再出发。', kind: 'development', status: 'required' }]
  const context = writingContext('去看球赛', c, prefix(), 1)
  assert.equal(context.authorRequirements[0]!.quote, '先向朋友确认再出发。')
  await withModelReplies([{ verdict: 'drift', reason: '忽略作者要求。', evidenceIds: ['design-contract:node:b1', 'author-requirement:edit-b1'] }], async requests => {
    const result = await reviewWritingMainline(context, '她直接出发去球场。', 'complete')
    assert.equal(result.verdict, 'drift')
    const input = JSON.parse(requests[0].messages[1].content)
    assert.deepEqual(input.designContract.confirmedNodes, c.designContract!.nodes)
    assert.ok(input.evidenceCatalog.some((e: any) => e.id === 'design-contract:node:b1'))
  })
})



test('segments generate with context and assemble after ordered acceptance without review calls', async () => {
  const titled = { ...curve, title: '待审阅的故事设计' }
  await withModelReplies([{ text: '第一段。' }, { text: '第二段。' }], async requests => {
    let draft = await reviseWritingDraft('想法', titled, undefined, req('start'))
    assert.equal(draft.segments[0]!.status, 'pending')
    draft = await reviseWritingDraft('想法', titled, draft, req('accept', { segmentId: draft.segments[0]!.id }))
    draft = await reviseWritingDraft('想法', titled, draft, req('next'))
    const context = JSON.parse(requests[1].messages[1].content)
    assert.equal(context.acceptedProse[0].text, '第一段。')
    assert.equal(context.followingBeats.length, 0)
    draft = await reviseWritingDraft('想法', titled, draft, req('accept', { segmentId: draft.segments[1]!.id }))
    assert.equal(draft.complete, true)
    assert.equal(draft.continuity, undefined)
    assert.equal(assembleWrittenStory(titled, draft)?.body, '第一段。\n\n第二段。')
    assert.equal(assembleWrittenStory(titled, { ...draft, continuity: undefined })?.title, '完整故事')
    assert.equal(requests.length, 2)
  })
})

test('structured design reviews a generated segment before it becomes pending', async () => {
  await withModelReplies([
    { text: '她去车站买票，盘算着怎样赶上球赛。' },
    { verdict: 'supported', reason: '买票直接服务赶到球场的目标。', evidenceIds: ['design-contract:goal', 'design-contract:node:b1'] },
  ], async requests => {
    const draft = await reviseWritingDraft('她想去看球赛。', contractedCurve, undefined, req('start'))
    assert.equal(draft.segments[0]!.status, 'pending')
    assert.equal(requests.length, 2)
    assert.equal(JSON.parse(requests[1].messages[1].content).proposal, draft.segments[0]!.text)
  })
})

test('mainline drift is rejected without mutating the existing draft', async () => {
  const before: StoryWritingDraft = { complete: false, segments: [] }
  await withModelReplies([
    { text: '她转而维修整栋楼的灯具，并制定巡检制度。' },
    { verdict: 'drift', reason: '新任务取代了去看球赛的目标。', evidenceIds: ['design-contract:goal'] },
  ], async () => {
    await assert.rejects(reviseWritingDraft('她想去看球赛。', contractedCurve, before, req('next')), { code: 'STORY_WRITING_MAINLINE_DRIFT' })
    assert.deepEqual(before, { complete: false, segments: [] })
  })
})

test('uncertain mainline review is retryable and does not publish a pending segment', async () => {
  const before: StoryWritingDraft = { complete: false, segments: [] }
  await withModelReplies([
    { text: '她在街角停下来。' },
    { verdict: 'uncertain', reason: '无法判断停下与目标的关系。', evidenceIds: [] },
  ], async () => {
    await assert.rejects(reviseWritingDraft('她想去看球赛。', contractedCurve, before, req('next')), { code: 'STORY_WRITING_MAINLINE_UNCERTAIN' })
    assert.deepEqual(before, { complete: false, segments: [] })
  })
})

test('the final accepted story is checked against the whole design contract before completion', async () => {
  await withModelReplies([
    { text: '她整理好出门要带的东西。' },
    { verdict: 'supported', reason: '仍在准备看球赛。', evidenceIds: ['design-contract:goal'] },
    { text: '她赶往球场并做出最后决定。' },
    { verdict: 'supported', reason: '当前段继续推进看球赛。', evidenceIds: ['design-contract:goal'] },
    { verdict: 'supported', reason: '完整正文从准备到赶往球场都服务看球赛目标。', evidenceIds: ['design-contract:goal', 'design-contract:selected-direction'] },
    { verdict: 'supported', issues: [] },
  ], async requests => {
    let draft = await reviseWritingDraft('她想去看球赛。', contractedCurve, undefined, req('start'))
    draft = await reviseWritingDraft('她想去看球赛。', contractedCurve, draft, req('accept', { segmentId: draft.segments[0]!.id }))
    draft = await reviseWritingDraft('她想去看球赛。', contractedCurve, draft, req('next'))
    draft = await reviseWritingDraft('她想去看球赛。', contractedCurve, draft, req('accept', { segmentId: draft.segments[1]!.id }))
    assert.equal(draft.complete, true)
    assert.equal(requests.length, 6)
    assert.equal(requests[4].messages[0].content.includes('已经拼接完成的完整正文'), true)
    assert.equal(assembleWrittenStory(contractedCurve, draft)?.body, '她整理好出门要带的东西。\n\n她赶往球场并做出最后决定。')
  })
})


test('out-of-order acceptance is rejected, and stale audit metadata cannot block assembly', async () => {
  const draft = prefix()
  draft.segments[0]!.status = 'pending'
  draft.segments.push({ id: 's2', beatId: 'b2', label: '回应', text: '第二段。', status: 'pending' })
  await withModelReplies([], async () => {
    await assert.rejects(reviseWritingDraft('想法', curve, draft, req('accept', { segmentId: 's2' })), { code: 'STORY_SESSION_CONFLICT' })
    const first = await reviseWritingDraft('想法', curve, draft, req('accept', { segmentId: 's1' }))
    const complete = await reviseWritingDraft('想法', curve, first, req('accept', { segmentId: 's2' }))
    assert.equal(assembleWrittenStory(curve, { ...complete, continuity: { auditedHash: 'stale', snapshots: [] } })?.body, '她站在窗边。\n\n第二段。')
    assert.equal(assembleWrittenStory(curve, { ...complete, segments: complete.segments.slice().reverse() }), undefined)
  })
})

test('rewrite failure preserves accepted prose and original target; retry replaces only after success', async () => {
  const current = prefix()
  current.segments.push({ id: 's2', beatId: 'b2', label: '回应', text: '作者原段。', status: 'pending', authorship: 'author' })
  const before = structuredClone(current)
  await withModelReplies([{ text: ' ' }, { text: '成功重试的正文。' }], async requests => {
    await assert.rejects(reviseWritingDraft('想法', curve, current, req('regenerate', { segmentId: 's2', feedback: '放慢節奏' })), { code: 'INVALID_MODEL_OUTPUT' })
    assert.deepEqual(current, before)
    const draft = await reviseWritingDraft('想法', curve, current, req('regenerate', { segmentId: 's2', feedback: '放慢節奏' }))
    assert.equal(draft.segments[1]!.text, '成功重试的正文。')
    const context = JSON.parse(requests[1].messages[1].content)
    assert.equal(context.previousText, '作者原段。'); assert.equal(context.feedback, '放慢節奏')
    assert.equal(context.acceptedProse[0].text, '她站在窗边。')
    assert.deepEqual(current, before)
  })
})

test('editing an earlier segment invalidates later prose without mutating the original draft', async () => {
  const current = prefix()
  current.segments.push({ id: 's2', beatId: 'b2', label: '回应', text: '后段。', status: 'accepted' })
  current.complete = true
  current.continuity = { auditedHash: 'old', snapshots: [{ segmentId: 's1', sourceHash: 'old', facts: [] }] }
  const before = structuredClone(current)
  await withModelReplies([], async () => {
    const edited = await reviseWritingDraft('想法', curve, current, req('edit', { segmentId: 's1', text: '作者修改的正文。' }))
    assert.equal(edited.segments.length, 1)
    assert.equal(edited.segments[0]!.authorship, 'author')
    assert.equal(edited.segments[0]!.status, 'pending')
    assert.equal(edited.complete, false)
    assert.deepEqual(edited.continuity, { snapshots: [] })
    assert.deepEqual(current, before)
  })
})

test('review confirmation uses exact adjacent evidence IDs and preserves closing curly quotes', async () => {
  const text = '便签写着：‘今天归还。’她没有解锁手机。'
  const context = writingContext('青柠不想求助。', curve, { complete: false, segments: [] }, 0)
  await withModelReplies([
    { issues: [{ kind: 'future-event', textEvidenceId: 'current-text:0', referenceEvidenceId: 'b2:0', reason: '这里对照一个明确动作。' }] },
    { assessments: [{ index: 0, textEvidenceIds: ['current-text:0', 'current-text:1'], referenceEvidenceIds: ['b2:0'],
      analysis: '已按相邻原句核对动作与状态。', relation: 'boundary-crossed' }] },
  ], async requests => {
    const result = await reviewWritingText(context, text)
    assert.equal(result.length, 1)
    assert.deepEqual(result[0]!.evidence.map(item => item.id), ['current-text:0', 'current-text:1', 'b2:0'])
    assert.equal(requests[0].messages[1].content.includes('’她没有解锁手机。'), true)
    const confirmation = JSON.parse(requests[1].messages[1].content)
    assert.equal(confirmation.issues[0].textCandidates[0].quote, '便签写着：‘今天归还。’')
    for (const entry of confirmation.issues[0].textCandidates) {
      assert.equal(text.slice(entry.start, entry.end), entry.quote)
    }
    assert.deepEqual(confirmation.issues[0].textCandidates.map((item: any) => item.id), ['current-text:0', 'current-text:1'])
    assert.equal('textAnchor' in JSON.parse(requests[1].messages[1].content).issues[0], false)
  })
})

test('sparse evidence stays separate and confirmation receives the omitted transition', async () => {
  const text = '她没有钥匙。她在长椅下找到钥匙。她用钥匙开门。'
  const context = writingContext('她画画。', curve, { complete: false, segments: [] }, 0)
  await withModelReplies([
    { issues: [{ kind: 'future-event', textEvidenceId: 'current-text:0', referenceEvidenceId: 'b2:0', reason: '这里对照一个明确动作。' }] },
    { assessments: [{ index: 0, textEvidenceIds: ['current-text:0', 'current-text:2'], referenceEvidenceIds: ['b2:0'],
      analysis: '引用了两个不相邻的动作。', relation: 'boundary-crossed' }] },
  ], async requests => {
    const result = await reviewWritingText(context, text)
    assert.equal(result.length, 1)
    assert.deepEqual(result[0]!.evidence.map(item => item.id), ['current-text:0', 'current-text:2', 'b2:0'])
    const confirmation = JSON.parse(requests[1].messages[1].content)
    assert.equal(confirmation.issues[0].contextPassages[0].sentences[1].quote, '她在长椅下找到钥匙。')
    for (const entry of result[0]!.evidence.filter(entry => entry.scope === 'text')) {
      assert.equal(text.slice(entry.start, entry.end), entry.quote)
    }
    assert.equal(requests.length, 2)
  })
})

test('repeated invalid confirmation evidence remains an incomplete review, never an approval', async () => {
  const text = '她拿起牙刷。窗外下雨。她继续画画。'
  const context = writingContext('她画画。', curve, { complete: false, segments: [] }, 0)
  // Unknown ID, omitted anchor, and an ID from the other evidence category must all fail.
  for (const ids of [['fabricated'], ['current-text:1'], ['b2:0'], ['current-text:2', 'current-text:0'], ['current-text:0', 'current-text:0']]) {
    const reply = { assessments: [{ index: 0, textEvidenceIds: ids, referenceEvidenceIds: ['b2:0'],
      analysis: '无法形成符合目录约束的引用。', relation: 'compatible' }] }
    await withModelReplies([
      { issues: [{ kind: 'future-event', textEvidenceId: 'current-text:0', referenceEvidenceId: 'b2:0', reason: '对照动作。' }] },
      reply, reply,
    ], async () => {
      await assert.rejects(reviewWritingText(context, text), (error: any) =>
        ['STORY_WRITING_INVALID_EVIDENCE', 'QWEN_OUTPUT_SCHEMA_FAILED', 'INVALID_MODEL_OUTPUT'].includes(error.code))
    })
  }
})
