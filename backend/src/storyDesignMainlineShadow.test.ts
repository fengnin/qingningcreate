import assert from 'node:assert/strict'
import test from 'node:test'
import { observeStoryDesignMainline } from './storyDesignMainlineShadow.js'
import { developPreparationStory } from './storyPreparationDesign.js'
import type { StoryPreparation } from '../../shared/story-preparation.js'
import type { ProvisionalCurve } from '../../shared/story-contract.js'

const preparation: StoryPreparation = { protocol: 1, status: 'accepted-design', executed: false,
  sources: [{ id: 'input', text: '小林想去看球赛。' }],
  material: [{ id: 'goal', sourceId: 'input', role: 'goal', quote: '小林想去看球赛。' }],
  mainlineGoals: [{ id: 'g', sourceId: 'input', quote: '小林想去看球赛。' }],
  mainlineAnchors: [{ id: 'a', sourceId: 'input', kind: 'action', quote: '小林想去看球赛。' }],
  candidates: [{ id: 'bus', action: '赶不上公交，选择骑车。', possibleResult: '赶到球场。', materialIds: ['goal'], preconditionIds: [], resultBasisIds: [], unknownIds: [] }],
  acceptedCandidateIds: ['bus'], authorReview: { originalText: '', candidates: [], selectedStoryDirection: '骑车去球场。' }, questions: [] }
const steps = [
  { kind: 'current-state', text: '小林想去看球赛，却错过公交。', materialIds: ['goal'] },
  { kind: 'trigger', text: '他骑车出发，途中停下买水。', materialIds: [] },
  { kind: 'resolution', text: '他赶到球场，与朋友一起看比赛。', materialIds: [] },
]
const curve: ProvisionalCurve = { id: 'shadow-test', title: '看球赛', status: 'draft', brief: { tones: [], dramaticForces: [], allowSystemNamedCharacters: false },
  beats: [], instructions: [], createdAt: 1, updatedAt: 1, preparation }
const input = { curveId: curve.id, designId: 'design-test', preparation, steps }
const supported = { verdict: 'supported', reason: '测试桩，仅验证旁路合同，不证明真实模型判断可靠。', evidenceIds: [] }

async function mocked(run: (logs: any[], requests: any[]) => Promise<void>, reply: (stage: string, context: any) => unknown | Promise<unknown>) {
  const names = ['DASHSCOPE_API_KEY', 'STORY_DISABLE_MODEL', 'STORY_DESIGN_MAINLINE_SHADOW', 'STORY_DESIGN_MAINLINE_REPAIR'] as const
  const saved = names.map(name => process.env[name]), original = globalThis.fetch, info = console.info
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'; process.env.STORY_DESIGN_MAINLINE_SHADOW = 'true'
  process.env.STORY_DESIGN_MAINLINE_REPAIR = 'false'
  const logs: any[] = [], requests: any[] = []
  console.info = (label, value) => { if (label === '[story-design-mainline-shadow]') logs.push(JSON.parse(value)) }
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), stage = request.response_format.json_schema.name, context = JSON.parse(request.messages[1].content)
    requests.push({ stage, context })
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(await reply(stage, context)) } }] }))
  }
  try { await run(logs, requests) } finally {
    globalThis.fetch = original; console.info = info
    names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i] })
  }
}

test('shadow records drift with canonical evidence without mutating source or design', async () => mocked(async (logs, requests) => {
  const before = structuredClone(input)
  await observeStoryDesignMainline(input)
  assert.deepEqual(input, before)
  assert.equal(logs[0].status, 'completed')
  assert.equal(logs[0].audit.verdict, 'mainline-drift')
  assert.equal(logs[0].designId, input.designId)
  assert.deepEqual(requests[0].context.mainlineGoals, preparation.mainlineGoals)
  assert.equal(requests[0].context.futureDesign.selectedStoryDirection, '骑车去球场。')
}, () => ({ verdict: 'mainline-drift', reason: '测试桩：即使判断偏离也只记录。', evidenceIds: ['material:goal', 'beat:resolution'] })))

test('shadow unavailable is not a passing verdict; unknown IDs and missing conflict sides are rejected', async () => {
  for (const evidenceIds of [['missing'], ['beat:resolution']]) await mocked(async logs => {
    await assert.doesNotReject(() => observeStoryDesignMainline(input))
    assert.equal(logs[0].status, 'unavailable')
    assert.equal(logs[0].audit, undefined)
  }, () => ({ verdict: 'mainline-drift', reason: '测试桩。', evidenceIds }))
})

test('shadow preserves uncertain verdict and removes superseded goal/anchor references', async () => mocked(async (logs, requests) => {
  const p = structuredClone(preparation)
  p.authorReview!.supersededMaterialIds = ['goal']; p.authorReview!.confirmedQuotes = ['小林不再去看球赛。']
  await observeStoryDesignMainline({ ...input, preparation: p })
  const context = requests[0].context
  assert.deepEqual(context.mainlineGoals, []); assert.deepEqual(context.mainlineAnchors, [])
  assert.equal(context.sourceContext.sources[0].scope, 'active-excerpts')
  assert.ok(!context.evidenceCatalog.some((e: { id: string }) => e.id === 'material:goal'))
  assert.equal(logs[0].audit.verdict, 'uncertain')
}, () => ({ ...supported, verdict: 'uncertain' })))

test('generation returns unchanged while shadow is pending, even if shadow later fails', async () => {
  let release!: (value: unknown) => void
  const pending = new Promise(resolve => { release = resolve })
  await mocked(async (logs, requests) => {
    try {
      const result = await developPreparationStory(curve, preparation, preparation.material[0]!)
      assert.deepEqual(result.beats.map(b => b.detail), steps.map(s => s.text))
      assert.equal(requests.length, 3)
      assert.equal(logs.length, 0, 'shadow must still be pending when generation returns')
    } finally {
      release({ ...supported, reason: '' })
      for (let i = 0; i < 20 && !logs.length; i++) await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(logs[0].status, 'unavailable')
    assert.equal(requests.filter(r => r.stage === 'preparation-story-design').length, 1)
  }, stage => stage.endsWith('-shadow') ? pending : stage.endsWith('-review')
    ? { checks: ['boundaries', 'continuity', 'causality', 'closure'].map(criterion => ({ criterion, passed: true, evidence: '测试桩。' })), issues: [] }
    : { steps: steps.map(step => ({ ...step, action: step.kind === 'current-state' ? null : step.text.slice(0, 6), expectedChange: step.kind === 'current-state' ? null : step.text.slice(-6) })) })
})

test('disabled shadow makes no requests or records', async () => mocked(async (logs, requests) => {
  process.env.STORY_DESIGN_MAINLINE_SHADOW = 'false'
  await observeStoryDesignMainline(input)
  assert.equal(logs.length, 0); assert.equal(requests.length, 0)
}, () => supported))
