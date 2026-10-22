import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { serializeWritingInput } from './storyWritingInput.js'
import { reviseWritingDraft } from './storyWriting.js'
import { reviewCompleteWritingConsistency, reviewWritingMainline, writingContext } from './storyWritingProtection.js'
import type { ConfirmedCurve, StoryWritingDraft } from '../../shared/story-contract.js'

function expandInput(source: any): any {
  function expand(value: any): any {
    if (value && typeof value === 'object' && '$textRef' in value) {
      const original = value.$textRef.split('/').slice(1).reduce((node: any, part: string) =>
        node[part.replaceAll('~1', '/').replaceAll('~0', '~')], source)
      assert.equal(typeof original, 'string', 'reference must resolve directly to original text')
      return original
    }
    if (Array.isArray(value)) return value.map(expand)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]))
    return value
  }
  return expand(source)
}

function fixture() {
  const curve: ConfirmedCurve = { id: randomUUID(), provisionalCurveId: randomUUID(), title: '核对书单', confirmedAt: 1,
    brief: { tones: [], dramaticForces: [], allowSystemNamedCharacters: false },
    beats: [{ id: 'b1', kind: 'current-state', title: '起点', detail: '书单模糊。', source: 'system-proposal', status: 'confirmed', dependsOn: [] },
      { id: 'b2', kind: 'resolution', title: '结局', detail: '取得清晰书单后核对。', source: 'user-edit', status: 'edited', dependsOn: ['b1'] }],
    designContract: { protocol: 1, authority: 'future-design', sourceHash: 'source', goal: { text: '核对书单', sourceIds: [] },
      mainlineGoals: [], mainlineAnchors: [], causalBridge: { method: '核实来源', change: '书单清晰可读' }, nodes: [] } }
  const draft: StoryWritingDraft = { complete: false, segments: [
    { id: 's1', beatId: 'b1', label: '起点', text: '方屿看不清书单。', status: 'accepted' },
    { id: 's2', beatId: 'b2', label: '结局', text: '他收到清晰书单后与妹妹核对。', status: 'pending' },
  ] }
  const context = () => writingContext('帮妹妹核对书单', curve, draft, 1)
  return { curve, draft, context }
}

const supported = () => ({ verdict: 'supported', reason: '符合设计和作者要求。', evidenceIds: [] })
const consistent = () => ({ verdict: 'supported', issues: [] })
async function stubModel(run: (requests: any[], replies: unknown[]) => Promise<void>) {
  const saved = { ...process.env }, fetch = globalThis.fetch
  const names = ['DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL', 'STORY_DISABLE_MODEL', 'QWEN_MODEL'] as const
  process.env.DASHSCOPE_API_KEY = 'economy-test'; process.env.DASHSCOPE_BASE_URL = 'https://stub.invalid'
  process.env.STORY_DISABLE_MODEL = 'false'; process.env.QWEN_MODEL = 'qwen-plus'
  const requests: any[] = [], replies: unknown[] = []
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request)
    assert.ok(replies.length, `Unexpected request ${request.response_format.json_schema.name}`)
    const reply = replies.shift()
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }))
  }
  try { await run(requests, replies); assert.equal(replies.length, 0) }
  finally { globalThis.fetch = fetch; for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name] } }
}

test('request compaction preserves full text, all evidence roles, order and pointer escaping', () => {
  const text = '作者要求先获得老师发来的清晰电子书单，再与妹妹逐项核对；不能根据模糊照片猜测确定书名。'.repeat(3)
  const input = { 'source/~text': text, authorRequirements: [{ id: 'a', quote: text }],
    acceptedProse: [{ id: 's', text }], evidenceCatalog: [{ id: 'e1', scope: 'author', text }, { id: 'e2', scope: 'prose', text }],
    futureDesign: { executed: false, beats: [{ id: 'b', detail: text }] } }
  const before = structuredClone(input)
  const serialized = serializeWritingInput(input)
  assert.ok(serialized.length < JSON.stringify(input).length)
  assert.equal(serialized.split(text).length - 1, 1)
  assert.deepEqual(expandInput(JSON.parse(serialized)), input)
  assert.deepEqual(input, before)
  assert.equal(serializeWritingInput({ text: '很短。', copy: '很短。' }), JSON.stringify({ text: '很短。', copy: '很短。' }))
})

test('final retry reuses only the passed stage while the rejected draft stays unchanged', async () => {
  const { curve, draft } = fixture(), before = structuredClone(draft)
  await stubModel(async (requests, replies) => {
    const conflict = { verdict: 'conflict', issues: [{ kind: 'time-order', reason: '需重试核对。', evidenceIds: ['complete-text:0', 'complete-text:1'] }] }
    replies.push(supported(), conflict, conflict, consistent())
    const request = { storyId: 's', revision: 1, action: 'accept' as const, segmentId: 's2' }
    await assert.rejects(reviseWritingDraft('核对书单', curve, draft, request), { code: 'STORY_WRITING_COMPLETE_CONSISTENCY_CONFLICT' })
    assert.deepEqual(draft, before)
    const complete = await reviseWritingDraft('核对书单', curve, draft, request)
    assert.equal(complete.complete, true)
    assert.deepEqual(requests.map(r => r.response_format.json_schema.name), [
      'story-writing-mainline-review', 'story-writing-consistency-review', 'story-writing-consistency-confirmation', 'story-writing-consistency-review',
    ])
  })
})

test('cached passes invalidate on prose, author instruction, design, source and provider changes', async () => {
  const { curve, draft, context } = fixture()
  await stubModel(async (requests, replies) => {
    async function check(text = '正文。') { replies.push(supported()); await reviewWritingMainline(context(), text, 'complete') }
    await check()
    const cached = await reviewWritingMainline(context(), '正文。', 'complete'); cached.evidenceIds.push('poison')
    assert.deepEqual((await reviewWritingMainline(context(), '正文。', 'complete')).evidenceIds, [])
    assert.equal(requests.length, 1)
    await check('改变后的正文。')
    curve.designContract!.authorRequirements = [{ id: 'a', sourceId: 'author-note', quote: '先确认再行动。', kind: 'development', status: 'required' }]
    await check()
    curve.beats[1]!.detail = '先确认版本后核对。'; await check()
    const changedSource = writingContext('原想法修改为核对毕业班教材', curve, draft, 1)
    replies.push(supported()); await reviewWritingMainline(changedSource, '正文。', 'complete')
    process.env.QWEN_MODEL = 'qwen-plus-latest'; await check()
    process.env.DASHSCOPE_BASE_URL = 'https://other-stub.invalid'; await check()
    process.env.DASHSCOPE_API_KEY = 'other-test-credential'; await check()
    assert.equal(requests.length, 8)
    const other = fixture(); replies.push(supported()); await reviewWritingMainline(other.context(), '正文。', 'complete')
    assert.equal(requests.length, 9, 'another story cannot inherit a verdict')
  })
})

test('uncertain, rejected, invalid and unavailable reviews are never cached as passes', async () => {
  const { context } = fixture()
  await stubModel(async (requests, replies) => {
    replies.push({ verdict: 'uncertain', reason: '无法确认。', evidenceIds: [] }, supported())
    await reviewWritingMainline(context(), '待判断正文。', 'complete')
    await reviewWritingMainline(context(), '待判断正文。', 'complete')
    replies.push({ verdict: 'drift', reason: '偏离要求。', evidenceIds: [] }, supported())
    await reviewWritingMainline(context(), '另一个正文。', 'complete')
    await reviewWritingMainline(context(), '另一个正文。', 'complete')
    replies.push({ verdict: 'supported', reason: '伪造引用。', evidenceIds: ['not-in-catalog'] }, supported())
    await assert.rejects(reviewWritingMainline(context(), '无效证据正文。', 'complete'), { code: 'STORY_WRITING_MAINLINE_REVIEW_INVALID' })
    await reviewWritingMainline(context(), '无效证据正文。', 'complete')
    replies.push(new Error('offline'), new Error('offline'), supported())
    await reviewWritingMainline(context(), '断网时的正文。', 'complete')
    await reviewWritingMainline(context(), '断网时的正文。', 'complete')
    assert.equal(requests.length, 9)
  })
})

test('consistency passes are reusable, uncertain and unavailable results are not', async () => {
  const { context } = fixture()
  await stubModel(async (requests, replies) => {
    replies.push(consistent())
    await reviewCompleteWritingConsistency(context(), '第一句。第二句。')
    await reviewCompleteWritingConsistency(context(), '第一句。第二句。')
    assert.equal(requests.length, 1)
    replies.push({ verdict: 'uncertain', issues: [] }, consistent())
    await reviewCompleteWritingConsistency(context(), '第三句。第四句。')
    await reviewCompleteWritingConsistency(context(), '第三句。第四句。')
    replies.push(new Error('offline'), new Error('offline'), consistent())
    await reviewCompleteWritingConsistency(context(), '第五句。第六句。')
    await reviewCompleteWritingConsistency(context(), '第五句。第六句。')
    assert.equal(requests.length, 6)
  })
})

test('factual review receives prose only and independently checks candidate conflicts in full context', async () => {
  for (const text of [
    '她准备上台。她走上舞台，演唱到一半停了下来。',
    '他把钥匙装进口袋。到门口后，他把钥匙交给同伴。离开时，他的口袋空了。',
    '画稿被卷好。第二天，画稿平铺在工作台上。',
  ]) {
    const { curve, context } = fixture()
    curve.designContract!.nodes = [{ beatId: 'old-plan', detail: '旧设计不能成为正文时间线中的事件。' }] as any
    await stubModel(async (requests, replies) => {
      replies.push({ verdict: 'conflict', issues: [{ kind: 'state-reversal', evidenceIds: ['complete-text:0', 'complete-text:1'],
        reason: '最初审阅的未经核实结论，不得传给复核员。' }] }, consistent())
      const result = await reviewCompleteWritingConsistency(context(), text)
      assert.equal(result.verdict, 'supported')
      assert.equal(requests.length, 2)
      for (const request of requests) {
        const input = expandInput(JSON.parse(request.messages[1].content))
        assert.equal(input.completeText, text, 'all intervening and adjacent prose must remain available')
        assert.equal(input.designContract, undefined)
        assert.ok(input.evidenceCatalog.length >= 2)
      }
      const confirmation = expandInput(JSON.parse(requests[1].messages[1].content))
      assert.deepEqual(confirmation.candidateConflicts, [{ kind: 'state-reversal', evidenceIds: ['complete-text:0', 'complete-text:1'] }])
      assert.ok(!JSON.stringify(confirmation).includes('最初审阅的未经核实结论'))
      await reviewCompleteWritingConsistency(context(), text)
      assert.equal(requests.length, 2, 'a confirmed compatible verdict can reuse the existing final cache')
    })
  }
})

test('confirmed contradictions still block completion; incompatible evidence and inconclusive confirmation never become passes', async () => {
  const text = '封闭仪式期间，唯一的钥匙始终锁在无人能打开的柜子里。仪式尚未结束，他已用同一把钥匙打开外门。第三句用于检查复核范围。'
  const conflict = { verdict: 'conflict', issues: [{ kind: 'possession-reversal', evidenceIds: ['complete-text:0', 'complete-text:1'], reason: '同一时段的唯一钥匙处于互斥位置。' }] }
  await stubModel(async (requests, replies) => {
    const { context } = fixture()
    replies.push(conflict, conflict)
    assert.equal((await reviewCompleteWritingConsistency(context(), text)).verdict, 'conflict')
    replies.push(conflict, { verdict: 'uncertain', issues: [] })
    assert.equal((await reviewCompleteWritingConsistency(context(), text)).verdict, 'uncertain')
    replies.push(conflict, new Error('offline'), new Error('offline'))
    assert.equal((await reviewCompleteWritingConsistency(context(), text)).verdict, 'uncertain')
    replies.push(conflict, { verdict: 'conflict', issues: [{ ...conflict.issues[0], evidenceIds: ['complete-text:1', 'complete-text:2'] }] })
    await assert.rejects(reviewCompleteWritingConsistency(context(), text), { code: 'STORY_WRITING_CONSISTENCY_REVIEW_INVALID' })
    assert.equal(requests.length, 9)
  })
})

test('a contradiction requires distinct prose evidence on both sides and a coherent verdict', async () => {
  for (const invalid of [
    { verdict: 'conflict', issues: [] },
    { verdict: 'supported', issues: [{ kind: 'state-reversal', evidenceIds: ['complete-text:0', 'complete-text:1'], reason: '矛盾结论不一致。' }] },
    ...[[], ['complete-text:0'], ['complete-text:0', 'complete-text:0'], ['complete-text:0', 'beat-current-state']].map(evidenceIds =>
      ({ verdict: 'conflict', issues: [{ kind: 'state-reversal', evidenceIds, reason: '待核实。' }] })),
  ]) {
    await stubModel(async (_requests, replies) => {
      replies.push(invalid)
      await assert.rejects(reviewCompleteWritingConsistency(fixture().context(), '第一句。第二句。'), { code: 'STORY_WRITING_CONSISTENCY_REVIEW_INVALID' })
    })
  }
})

test('segment reviews stay fresh and final passes expire', async () => {
  const { context } = fixture()
  await stubModel(async (requests, replies) => {
    replies.push(supported(), supported(), supported(), supported())
    await reviewWritingMainline(context(), '当前段。')
    await reviewWritingMainline(context(), '当前段。')
    await reviewWritingMainline(context(), '全文。', 'complete')
    const now = Date.now
    try { Date.now = () => now() + 31 * 60 * 1000; await reviewWritingMainline(context(), '全文。', 'complete') }
    finally { Date.now = now }
    assert.equal(requests.length, 4)
  })
})

test('generation receives direct text and both reviewers retain lossless inputs', async () => {
  const { curve, draft, context } = fixture()
  const long = '方屿在收到老师正式电子书单后，与妹妹逐项核对书名、版本和必选标记，并把未确定的版本问题留下等待老师确认。'.repeat(4)
  curve.beats[1]!.detail = long
  curve.designContract!.authorRequirements = [{ id: 'a', sourceId: 'author-note', quote: long, kind: 'development', status: 'required' }]
  await stubModel(async (requests, replies) => {
    replies.push({ text: long }, supported(), supported(), consistent())
    const regenerated = await reviseWritingDraft('核对书单', curve, draft, { storyId: 's', revision: 1, action: 'regenerate', segmentId: 's2', feedback: '保留所有要求。' })
    await reviewWritingMainline(context(), long, 'complete')
    await reviewCompleteWritingConsistency(context(), long)
    assert.equal(regenerated.segments[1]!.text, long)
    for (const [index, request] of requests.entries()) {
      const encoded = request.messages[1].content
      const restored = expandInput(JSON.parse(encoded))
      assert.ok(JSON.stringify(restored).includes(long))
      if (index === 0) {
        assert.equal(typeof restored.currentBeat.detail, 'string')
        assert.ok(!encoded.includes('$textRef'))
        assert.equal(restored.designContract, undefined)
        assert.equal(restored.designMainlineReview, undefined)
      } else {
        assert.ok(request.messages[0].content.includes('$textRef'))
        assert.ok(encoded.length < JSON.stringify(restored).length)
      }
    }
  })
})
