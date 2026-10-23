import assert from 'node:assert/strict'
import test from 'node:test'
import { observeAdjacentRepeat } from './storyAdjacentRepeatShadow.js'
import { reviseWritingDraft } from './storyWriting.js'
import type { ConfirmedCurve, StoryWritingDraft } from '../../shared/story-contract.js'

const input = { curveId: 'curve', beatId: 'b2', previousSegmentId: 's1',
  previous: '她撕开唯一的信封，取出信纸。她读完了信，把信纸放在桌上。', candidate: '她撕开那个信封，取出信纸。她终于明白母亲的用意。' }
const event = { relation: 'repeat', previousEvidenceIds: ['previous:0'], candidateEvidenceIds: ['candidate:0'], action: '拆信取信', reason: '候选动作待核验。' }
const proof = { previousExecution: 'performed', previousExecutionEvidenceId: 'previous:0:sentence:0',
  execution: 'action', identity: 'same-occurrence', alternative: 'none', previousActionQuote: '她撕开唯一的信封，取出信纸。',
  candidateActionQuote: '她撕开那个信封，取出信纸。', progressQuote: '她读完了信，把信纸放在桌上。', reason: '已读完后重新拆同一封信。' }
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }))

async function harness(run: (state: { requests: any[]; logs: any[]; replies: unknown[] }) => Promise<void>) {
  const savedFetch = globalThis.fetch, savedInfo = console.info
  const names = ['DASHSCOPE_API_KEY', 'STORY_DISABLE_MODEL', 'QWEN_MODEL', 'STORY_ADJACENT_REPEAT_SHADOW'] as const
  const saved = names.map(name => process.env[name])
  process.env.DASHSCOPE_API_KEY = 'test-key'; process.env.STORY_DISABLE_MODEL = 'false'
  process.env.QWEN_MODEL = 'qwen-plus'; process.env.STORY_ADJACENT_REPEAT_SHADOW = 'true'
  const state = { requests: [] as any[], logs: [] as any[], replies: [] as unknown[] }
  globalThis.fetch = async (_url, init) => {
    state.requests.push(JSON.parse(String(init?.body)))
    assert.ok(state.replies.length, 'unexpected upstream call')
    return response(state.replies.shift())
  }
  console.info = (label, data) => { if (label === '[story-writing-adjacent-repeat-shadow]') state.logs.push(JSON.parse(data)) }
  try { await run(state) }
  finally {
    globalThis.fetch = savedFetch; console.info = savedInfo
    names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i] })
  }
}

test('shadow is opt-in, skips offline mode and empty predecessor, and makes no model calls', async () => {
  await harness(async ({ requests }) => {
    delete process.env.STORY_ADJACENT_REPEAT_SHADOW
    await observeAdjacentRepeat(input)
    process.env.STORY_ADJACENT_REPEAT_SHADOW = 'true'; process.env.STORY_DISABLE_MODEL = 'true'
    await observeAdjacentRepeat(input)
    process.env.STORY_DISABLE_MODEL = 'false'
    await observeAdjacentRepeat({ ...input, previous: '' })
    assert.equal(requests.length, 0)
  })
})

test('execution-grounded proof logs exact texts and identity without changing the input', async () => {
  await harness(async ({ replies, requests, logs }) => {
    replies.push({ events: [event] }, proof)
    const before = structuredClone(input)
    assert.equal(await observeAdjacentRepeat(input), undefined)
    assert.deepEqual(input, before)
    assert.equal(requests.length, 2)
    const confirmation = JSON.parse(requests[1].messages[1].content)
    assert.equal(confirmation.previous, input.previous)
    assert.equal(confirmation.previousExecutionCatalog[0].quote, proof.previousActionQuote)
    assert.equal('reason' in confirmation.comparison, false)
    assert.equal(logs[0].status, 'completed'); assert.equal(logs[0].confirmed, true)
    assert.equal(logs[0].candidate, input.candidate)
    assert.equal(logs[0].previousSegmentId, 's1'); assert.equal(logs[0].candidateHash.length, 64)
  })
})

test('prior capability, intention, ongoing and unclear actions cannot confirm a repeat even with confident identity', async () => {
  await harness(async ({ replies, logs }) => {
    for (const previousExecution of ['not-performed', 'in-progress', 'unclear']) {
      replies.push({ events: [event] }, { ...proof, previousExecution })
      await observeAdjacentRepeat(input)
    }
    assert.ok(logs.every(log => log.status === 'completed' && log.confirmed === false))
    assert.equal(logs.length, 3)
  })
})

test('execution evidence cannot be invented or borrowed from a different prior paragraph', async () => {
  await harness(async ({ replies, logs }) => {
    const changed = { ...input, previous: `${input.previous}\n\n她把信纸收好。` }
    for (const previousExecutionEvidenceId of ['invented', 'previous:1:sentence:0', 'candidate:0:sentence:0', '']) {
      replies.push({ events: [event] }, { ...proof, previousExecutionEvidenceId })
      await observeAdjacentRepeat(changed)
    }
    assert.ok(logs.every(log => log.status === 'completed' && log.confirmed === false
      && log.assessments[0].validEvidence === false))
  })
})

test('execution catalog preserves modal and negative scope instead of exposing cropped action words', async () => {
  await harness(async ({ replies, requests, logs }) => {
    const changed = { ...input, previous: '只要门开着，她就能够进去。她准备把信交给父亲，但还没有动。' }
    replies.push({ events: [event] }, { ...proof, previousExecution: 'not-performed', previousExecutionEvidenceId: 'previous:0:sentence:0' })
    await observeAdjacentRepeat(changed)
    const confirmation = JSON.parse(requests[1].messages[1].content)
    assert.deepEqual(confirmation.previousExecutionCatalog.map((e: any) => e.quote), ['只要门开着，她就能够进去。', '她准备把信交给父亲，但还没有动。'])
    assert.equal(logs[0].confirmed, false)
  })
})

test('uncertain events and ungrounded or insufficient proofs are observed without confirmation', async () => {
  await harness(async ({ replies, requests, logs }) => {
    replies.push({ events: [{ ...event, relation: 'uncertain' }] })
    await observeAdjacentRepeat(input)
    assert.equal(requests.length, 1)
    for (const changed of [{ ...proof, identity: 'insufficient' }, { ...proof, candidateActionQuote: '原文不存在的动作' },
      { ...proof, execution: 'state' }, { ...proof, alternative: 'routine-omission' }]) {
      replies.push({ events: [event] }, changed)
      await observeAdjacentRepeat(input)
    }
    assert.equal(logs.length, 5)
    assert.ok(logs.every(log => log.status === 'completed' && log.confirmed === false))
  })
})

test('invalid evidence is unavailable and never logged as a completed passing review', async () => {
  await harness(async ({ replies, logs }) => {
    replies.push({ events: [{ ...event, previousEvidenceIds: ['fabricated'] }] })
    await observeAdjacentRepeat(input)
    assert.equal(logs[0].status, 'unavailable')
    assert.equal('confirmed' in logs[0], false)
  })
})

test('generation returns unchanged text while shadow request is still pending; failure never rejects it', async () => {
  await harness(async ({ logs }) => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { release = resolve })
    let calls = 0
    globalThis.fetch = async () => ++calls === 1 ? response({ text: input.candidate }) : pending
    const curve: ConfirmedCurve = { id: 'curve', provisionalCurveId: 'p', title: '故事', confirmedAt: 1,
      brief: { tones: [], dramaticForces: [], allowSystemNamedCharacters: false }, beats: [
        { id: 'b1', kind: 'current-state', title: '起点', detail: '人物面对问题。', source: 'system-proposal', status: 'proposed', dependsOn: [] },
        { id: 'b2', kind: 'resolution', title: '回应', detail: '人物做出回应。', source: 'system-proposal', status: 'proposed', dependsOn: ['b1'] },
      ] }
    const draft: StoryWritingDraft = { complete: false, segments: [{ id: 's1', beatId: 'b1', label: '起点', text: input.previous, status: 'accepted' }] }
    const before = structuredClone(draft)
    try {
      const result = await reviseWritingDraft('想法', curve, draft, { storyId: 'story', revision: 1, action: 'next' })
      assert.equal(result.segments[1]!.text, input.candidate)
      assert.deepEqual(draft, before)
      assert.equal(calls, 2); assert.equal(logs.length, 0)
    } finally {
      release(response({ events: [{ ...event, candidateEvidenceIds: ['invalid'] }] }))
      // Drain the detached observer before restoring global mocks.
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(logs[0].status, 'unavailable')
  })
})
