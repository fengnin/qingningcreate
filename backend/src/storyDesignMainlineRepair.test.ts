import assert from 'node:assert/strict'
import test from 'node:test'
import { developPreparationStory, repairPreparationMainline, retryPreparationMainline } from './storyPreparationDesign.js'
import { withQwenRequestBudget } from './qwen.js'
import { confirmProvisionalCurve } from './storyCoCreation.js'
import { requiredDesignProposalIds } from './storyDesignReview.js'
import { reviseWritingDraft } from './storyWriting.js'
import type { ProvisionalCurve } from '../../shared/story-contract.js'
import type { StoryPreparation } from '../../shared/story-preparation.js'

const p: StoryPreparation = { protocol: 1, status: 'accepted-design', executed: false,
  sources: [{ id: 'input', text: '小林想去看球赛。' }],
  material: [{ id: 'goal', sourceId: 'input', role: 'goal', quote: '小林想去看球赛。' }],
  candidates: [{ id: 'd', action: '乘车去球场。', possibleResult: '赶到球场。', materialIds: ['goal'], preconditionIds: [], resultBasisIds: [], unknownIds: [] }],
  acceptedCandidateIds: ['d'], authorReview: { originalText: '', candidates: [], selectedStoryDirection: '乘车去球场。' }, questions: [] }
const steps = [
  { kind: 'current-state' as const, text: '小林拿着球票出门。', materialIds: ['goal'] },
  { kind: 'trigger' as const, text: '他乘车前往球场，途中发现司机正在招人。', materialIds: [] },
  { kind: 'resolution' as const, text: '他留下经营车队，再也没有去看球。', materialIds: [] },
].map(step => ({ ...step, action: step.kind === 'current-state' ? null : step.text.slice(0, 6),
  expectedChange: step.kind === 'current-state' ? null : step.text.slice(-6) }))
const curve: ProvisionalCurve = { id: 'mainline-test', title: '球赛', status: 'draft', brief: { tones: [], dramaticForces: [], allowSystemNamedCharacters: false }, beats: [], instructions: [], createdAt: 1, updatedAt: 1 }
const drift = { verdict: 'mainline-drift', reason: '测试桩：新事业取代原愿望。', evidenceIds: ['material:goal', 'beat:resolution'] }
const supported = { verdict: 'supported', reason: '测试桩，仅验证控制流程。', evidenceIds: [] }
const quality = { checks: ['boundaries', 'continuity', 'causality', 'closure'].map(criterion => ({ criterion, passed: true, evidence: '测试桩。' })), issues: [] }
const repaired = '小林付费乘车，赶到球场看完比赛。'

async function model(run: (calls: any[]) => Promise<void>, reply: (stage: string, input: any, calls: any[]) => unknown) {
  const names = ['DASHSCOPE_API_KEY', 'STORY_DISABLE_MODEL', 'STORY_DESIGN_MAINLINE_REPAIR'] as const
  const saved = names.map(name => process.env[name]), originalFetch = globalThis.fetch, info = console.info, warn = console.warn
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'; process.env.STORY_DESIGN_MAINLINE_REPAIR = 'true'
  console.info = () => {}; console.warn = () => {}
  const calls: any[] = []
  globalThis.fetch = async (_url, init) => {
    const req = JSON.parse(String(init?.body)), stage = req.response_format.json_schema.name, input = JSON.parse(req.messages[1].content)
    calls.push({ stage, input })
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply(stage, input, calls)) } }] }))
  }
  try { await run(calls) } finally {
    globalThis.fetch = originalFetch; console.info = info; console.warn = warn
    names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i] })
  }
}
const normalReply = (stage: string, input: any) => stage.endsWith('-repair') ? { patches: [{ kind: 'resolution', text: repaired, action: '小林付费乘车', expectedChange: '赶到球场看完比赛' }] }
  : stage === 'preparation-story-design-review' ? quality
    : input.evidenceCatalog.some((e: any) => e.text === repaired) ? supported : drift

test('two drift checks allow one local patch, retaining uncited nodes and all evidence IDs', async () => model(async calls => {
  const before = structuredClone(steps)
  const result = await repairPreparationMainline(curve, p, steps)
  assert.equal(result.review.status, 'repaired'); assert.equal(calls.length, 5)
  assert.deepEqual(result.steps.slice(0, 2), steps.slice(0, 2))
  assert.equal(result.steps[2]!.text, repaired)
  assert.equal(result.steps[2]!.action, '小林付费乘车')
  assert.equal(result.steps[2]!.expectedChange, '赶到球场看完比赛')
  assert.deepEqual(result.steps.map(s => s.materialIds), steps.map(s => s.materialIds))
  assert.deepEqual(steps, before)
  const patchRequest = calls.find(call => call.stage.endsWith('-repair')).input
  assert.deepEqual(patchRequest.editableKinds, ['resolution'])
  assert.ok(!JSON.stringify(patchRequest).includes(drift.reason), 'do not forward reviewer-authored prose as instructions')
}, normalReply))

test('normal design returns unchanged with only one review', async () => model(async calls => {
  const result = await repairPreparationMainline(curve, p, steps)
  assert.equal(result.review.status, 'supported'); assert.deepEqual(result.steps, steps); assert.equal(calls.length, 1)
}, () => supported))

test('single-call repair reviews still respect the enclosing API request budget', async () => model(async calls => {
  const result = await withQwenRequestBudget(1, () => repairPreparationMainline(curve, p, steps))
  assert.equal(result.review.status, 'unavailable')
  assert.deepEqual(result.steps, steps)
  assert.equal(calls.length, 1)
}, () => drift))

test('unavailable design mainline review does not block author confirmation or segment generation', async () => model(async calls => {
  const generated = await developPreparationStory(curve, p, p.material[0]!)
  assert.equal(generated.mainlineReview!.status, 'unavailable')
  const confirmed = confirmProvisionalCurve(generated, requiredDesignProposalIds(generated.reasoning!)).confirmedCurve
  const before = calls.length
  const draft = await reviseWritingDraft('小林想去看球赛。', confirmed, undefined, { storyId: 'test', revision: 1, action: 'start' })
  assert.equal(draft.segments[0]!.text, '小林拿着球票走出家门。')
  assert.equal(calls.length - before, 1, 'prose generation must not invoke the design reviewer')
}, stage => {
  if (stage === 'preparation-story-design') return { steps }
  if (stage === 'preparation-story-design-review') return quality
  if (stage.endsWith('-shadow')) throw new DOMException('timeout', 'AbortError')
  return { text: '小林拿着球票走出家门。' }
}))

test('disagreeing or uncertain reviews never start repair', async () => {
  for (const second of [supported, { ...supported, verdict: 'uncertain' }]) await model(async calls => {
    const result = await repairPreparationMainline(curve, p, steps)
    assert.equal(result.review.status, 'uncertain'); assert.deepEqual(result.steps, steps); assert.equal(calls.length, 2)
  }, (_stage, _input, calls) => calls.length === 1 ? drift : second)
})

test('review timeout returns original generated design with explicit retry status, without regeneration', async () => model(async calls => {
  const result = await developPreparationStory(curve, p, p.material[0]!)
  assert.equal(result.mainlineReview!.status, 'unavailable')
  assert.match(result.mainlineReview!.message, /重试主线审阅/)
  assert.deepEqual(result.beats.map(b => b.detail), steps.map(s => s.text))
  assert.equal(calls.filter(call => call.stage === 'preparation-story-design').length, 1)
  assert.equal(calls.length, 3, 'no hidden transport retry after the failed audit')
}, stage => {
  if (stage.endsWith('-shadow')) throw new DOMException('timeout', 'AbortError')
  return stage.endsWith('-review') ? quality : { steps }
}))

for (const failure of ['unauthorized-patch', 'quality', 'recheck', 'repair-timeout'] as const) test(`${failure} never publishes a partial patch or loops`, async () => model(async calls => {
  const result = await repairPreparationMainline(curve, p, steps)
  assert.equal(result.review.status, 'repair-failed'); assert.deepEqual(result.steps, steps)
  assert.equal(calls.filter(call => call.stage.endsWith('-repair')).length, 1)
}, (stage, input) => {
  if (stage.endsWith('-repair') && failure === 'unauthorized-patch') return { patches: [{ kind: 'trigger', text: '越权修改。' }] }
  if (stage.endsWith('-repair') && failure === 'repair-timeout') throw new DOMException('timeout', 'AbortError')
  if (stage === 'preparation-story-design-review' && failure === 'quality') return { ...quality, checks: quality.checks.map(c => ({ ...c, passed: false })) }
  if (input.evidenceCatalog?.some((e: any) => e.text === repaired) && failure === 'recheck') return drift
  return normalReply(stage, input)
}))

test('author protected nodes are never sent to patch generation', async () => model(async calls => {
  const result = await repairPreparationMainline(curve, p, steps, ['resolution'])
  assert.equal(result.review.status, 'mainline-drift'); assert.equal(calls.length, 2); assert.deepEqual(result.steps, steps)
}, () => drift))

test('saved unavailable design can retry without regenerating or losing author edits', async () => model(async calls => {
  const generated = await developPreparationStory(curve, p, p.material[0]!)
  assert.equal(generated.mainlineReview!.status, 'unavailable')
  const original = structuredClone(generated)
  const result = await retryPreparationMainline(generated)
  assert.equal(result.mainlineReview!.status, 'repaired')
  assert.deepEqual(generated, original)
  assert.deepEqual(result.beats.slice(0, 2), generated.beats.slice(0, 2))
  assert.deepEqual(result.designContract!.nodes.slice(0, 2), generated.designContract!.nodes.slice(0, 2))
  assert.equal(result.designContract!.nodes[2]!.expectedChange, '赶到球场看完比赛')
  assert.deepEqual(result.reasoning!.designReview!.acceptedProposalIds, [])
  assert.equal(calls.filter(c => c.stage === 'preparation-story-design').length, 1)
}, (stage, input, calls) => {
  if (stage === 'preparation-story-design') return { steps }
  if (stage === 'preparation-story-design-review') return quality
  if (calls.length === 3) throw new DOMException('timeout', 'AbortError')
  return normalReply(stage, input)
}))

test('retry on a design containing author edits only reviews and preserves the entire authored version', async () => model(async calls => {
  const generated = await developPreparationStory(curve, p, p.material[0]!)
  generated.beats[1] = { ...generated.beats[1]!, source: 'user-edit', detail: '我决定保留这段自己的构思。'.repeat(30) }
  const before = structuredClone(generated)
  const count = calls.length
  const result = await retryPreparationMainline(generated)
  assert.equal(result.mainlineReview!.status, 'mainline-drift')
  assert.deepEqual(result.beats, generated.beats)
  assert.deepEqual(result.reasoning, generated.reasoning)
  assert.deepEqual(generated, before)
  assert.equal(calls.length - count, 2)
}, (stage, _input, calls) => {
  if (stage === 'preparation-story-design') return { steps }
  if (stage === 'preparation-story-design-review') return quality
  if (calls.length === 3) throw new DOMException('timeout', 'AbortError')
  return drift
}))
