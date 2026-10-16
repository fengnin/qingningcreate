import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError } from './qwen.js'
import { bridgeEvidenceCatalog } from './storyBridgeReview.js'
import { parseFactReviewChecks, factReviewCheckSchema } from './storyFactReview.js'
import { projectFutureChoices } from './storyPreparation.js'

const source = { id: 'author-input', text: '妹妹想亲手挂画。画只能由妹妹亲手挂上去。' }
const material = [{ id: 'm0', quote: '妹妹想亲手挂画。' }, { id: 'm1', quote: '画只能由妹妹亲手挂上去。' }]
const candidate = { id: 'd0', action: '妹妹让哥哥扶着梯子，自己挂画。', possibleResult: '画可能挂稳。',
  materialIds: ['m0'], preconditionIds: [], resultBasisIds: [], unknownIds: [], futureChoice: '挂稳后，请哥哥一起看画还是调整位置？',
  causalBridge: { method: '哥哥扶梯子，妹妹亲手挂画。', change: '画挂稳后，两人一起看画。', methodBasisIds: ['m0'], changeBasisIds: [] } }
const catalog = bridgeEvidenceCatalog([{ ...candidate, ...candidate.causalBridge }], [])
const compatible = { id: 'd0', verdict: 'compatible', conflictMaterialIds: [], proposalEvidenceIds: [], reason: '无冲突' }
const invalid = (error: unknown) => error instanceof AppError && error.code === 'STORY_PREPARATION_INVALID_OUTPUT'

test('fact verdict is explicit, with both sides of a rejection anchored to canonical text', () => {
  assert.equal(factReviewCheckSchema().anyOf, undefined)
  assert.deepEqual(factReviewCheckSchema().properties!.verdict!.enum, ['compatible', 'contradictory'])
  assert.equal(parseFactReviewChecks({ checks: [compatible] }, ['d0'], material, catalog)[0]!.valid, true)
  const rejected = { ...compatible, verdict: 'contradictory', conflictMaterialIds: ['m1'], proposalEvidenceIds: ['p0-method'], reason: '测试冲突依据合同。' }
  assert.deepEqual(parseFactReviewChecks({ checks: [rejected] }, ['d0'], material, catalog)[0]!.evidence,
    [{ field: 'author', quote: material[1]!.quote }, { field: 'method', quote: candidate.causalBridge.method }])
  for (const check of [
    { id: 'd0', materialIds: ['m0'], reason: '无冲突' },
    { ...compatible, conflictMaterialIds: ['m0'] },
    { ...rejected, proposalEvidenceIds: [] }, { ...rejected, conflictMaterialIds: [] },
    { ...rejected, conflictMaterialIds: ['absent'] }, { ...rejected, proposalEvidenceIds: ['p1-method'] },
    { ...rejected, proposalEvidenceIds: ['p0-method', 'p0-method'] },
  ]) assert.throws(() => parseFactReviewChecks({ checks: [check] }, ['d0'], material, catalog), invalid)
  assert.throws(() => parseFactReviewChecks({ checks: [compatible, compatible] }, ['d0', 'd1'], material, catalog), invalid)
})

for (const persistent of [false, true]) test(`contradictory review output retries only the reviewer (persistent=${persistent})`, async () => {
  const original = globalThis.fetch, saved = { key: process.env.DASHSCOPE_API_KEY, disabled: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'contract-stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const stages: string[] = [], inputs: any[] = []
  let reviews = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), stage = request.response_format.json_schema.name
    const input = JSON.parse(request.messages[1].content)
    stages.push(stage); inputs.push(input)
    const output = stage.endsWith('fact-review') ? { checks: [{ ...compatible,
      conflictMaterialIds: persistent || ++reviews === 1 ? ['m0'] : [] }] }
      : { checks: [{ id: 'd0', verdict: 'supported', issueType: 'none', needs: [], evidenceIds: [], reason: '成立。' }] }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))
  }
  const before = structuredClone(candidate)
  try {
    const run = () => projectFutureChoices([candidate], [source], { tones: [], dramaticForces: [], allowSystemNamedCharacters: false })
    if (persistent) await assert.rejects(run, e => invalid(e) && (e as AppError).modelDiagnostic?.stage === 'preparation-future-choice-fact-review:response-schema')
    else assert.deepEqual(await run(), [candidate])
    assert.deepEqual(stages, ['preparation-future-choice-fact-review', 'preparation-future-choice-fact-review',
      ...(!persistent ? ['preparation-future-choice-world-review'] : [])])
    assert.deepEqual(inputs[1].candidates, inputs[0].candidates)
    assert.match(inputs[1].validationFailure, /只重审原提案/)
    assert.deepEqual(candidate, before)
  } finally {
    globalThis.fetch = original
    if (saved.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = saved.key
    if (saved.disabled === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = saved.disabled
  }
})
