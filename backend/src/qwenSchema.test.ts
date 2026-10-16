import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError, requestQwenJson, withQwenRequestBudget, withModelDiagnostic } from './qwen.js'
import { outputShapeErrors, shape as s } from './modelOutputSchema.js'
import { preparationOutputSchemas, continuationOutputSchemas, sceneOutputSchemas, reasoningOutputSchema } from './storyOutputSchemas.js'
import { reasoningEncodingExample, reasoningQuestionExample, reasoningEditExample } from './storyReasoningPrompt.js'
import { storyReasoningWireExample } from './storyReasoningWire.js'

const candidate = { id: 'c0', action: '她邀请同伴一起试一次。', materialIds: ['m0'], preconditionIds: [],
  possibleResult: '同伴可能提出另一种玩法。', resultBasisIds: [], unknownIds: [] }
const good = { candidates: [candidate], questions: [] }

async function mock(run: (requests: any[]) => Promise<void>, reply: (request: any, index: number) => Response) {
  const original = globalThis.fetch
  const names = ['DASHSCOPE_API_KEY', 'STORY_DISABLE_MODEL', 'QWEN_MODEL'] as const
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.DASHSCOPE_API_KEY = 'contract-stub'; process.env.STORY_DISABLE_MODEL = 'false'; process.env.QWEN_MODEL = 'qwen-plus'
  const requests: any[] = []
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request)
    return reply(request, requests.length)
  }
  try { await run(requests) } finally {
    globalThis.fetch = original
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name] }
  }
}
const response = (output: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))
const options = { systemPrompt: '只返回JSON，不补事实。', userPrompt: JSON.stringify({ sources: [{ id: 'm0', text: '她想和同伴玩。' }] }),
  diagnosticStage: 'schema-contract', outputSchema: preparationOutputSchemas.directions }

test('shared schema repairs fields embedded in prose before returning a proposal', async () => {
  const bad = { candidates: [{ id: 'c0', action: '她邀请同伴。 possibleResult: 同伴换玩法，materialIds: [m0]，preconditionIds: []，resultBasisIds: []，unknownIds: []' }], questions: [] }
  await mock(async requests => {
    assert.deepEqual(await requestQwenJson(options), good)
    assert.equal(requests.length, 2)
    for (const request of requests) {
      assert.equal(request.response_format.type, 'json_schema')
      assert.equal(request.response_format.json_schema.strict, true)
      assert.deepEqual(request.response_format.json_schema.schema, options.outputSchema)
      assert.equal(request.enable_thinking, false)
    }
    const repair = JSON.parse(requests[1].messages[1].content)
    assert.deepEqual(repair.sources, JSON.parse(options.userPrompt).sources)
    assert.deepEqual(repair.previousOutput, bad)
    assert.match(repair.validationFailure, /\$\.candidates\[0\].*possibleResult/u)
    assert.match(repair.formatRepair.instruction, /不补作者事实/u)
  }, (_request, index) => response(index === 1 ? bad : good))
})

test('nested types, wrong wrappers, serialized JSON, missing fields and misplaced fields all share bounded repair', async () => {
  const malformed: unknown[] = [
    { ...good, candidates: JSON.stringify(good.candidates) },
    { ...good, candidates: [{ ...candidate, materialIds: '["m0"]' }] },
    { ...good, candidates: [{ ...candidate, possibleResult: { text: candidate.possibleResult } }] },
    { result: good }, JSON.stringify(good),
    { ...good, candidates: [{ ...candidate, causalBridge: { method: '邀请', change: '回应', methodBasisIds: ['m0'] } }] },
    { ...good, candidates: [{ ...candidate, resultBasisIds: [false] }] },
    { ...good, confirmed: true },
  ]
  for (const bad of malformed) await mock(async requests => {
    await assert.rejects(() => requestQwenJson(options), (error: unknown) => error instanceof AppError
      && error.code === 'QWEN_OUTPUT_SCHEMA_FAILED' && error.modelDiagnostic?.stage === 'schema-contract:response-schema')
    assert.equal(requests.length, 2)
  }, () => response(bad))
})

test('valid output adds no repair call; format repair cannot bypass request budget', async () => {
  await mock(async requests => {
    assert.deepEqual(await requestQwenJson(options), good)
    assert.equal(requests.length, 1)
  }, () => response(good))
  await mock(async requests => {
    await assert.rejects(() => withQwenRequestBudget(1, () => requestQwenJson(options)),
      (error: unknown) => error instanceof AppError && error.code === 'QWEN_REQUEST_BUDGET_EXHAUSTED'
        && error.modelDiagnostic?.stage === 'schema-contract:format-repair:request-budget')
    assert.equal(requests.length, 1)
  }, () => response({}))
})

test('unsupported schema fails explicitly without an unconstrained request or a false causal verdict', async () => {
  await mock(async requests => {
    await assert.rejects(() => requestQwenJson(options), (error: unknown) => error instanceof AppError
      && error.code === 'QWEN_OUTPUT_SCHEMA_UNSUPPORTED')
    assert.equal(requests.length, 1)
  }, () => new Response(JSON.stringify({ error: { message: 'response_format json_schema unsupported' } }), { status: 400 }))
})

test('schema diagnostics expose paths, preserve the failing stage and never include narrative or arbitrary extra keys', () => {
  const secretProse = '任意模型正文不进入诊断'
  const errors = outputShapeErrors({ ...good, [secretProse]: true }, options.outputSchema)
  assert.ok(errors.length)
  assert.doesNotMatch(errors.join(' '), new RegExp(secretProse))
  assert.ok(outputShapeErrors(JSON.parse('{"toString":true}'), s.object({})).length)
  const error = new AppError('format', 502, 'QWEN_OUTPUT_SCHEMA_FAILED', undefined, undefined, undefined,
    { stage: 'specific:response-schema', reason: 'shape' })
  assert.equal(withModelDiagnostic(error, { stage: 'outer-workflow' }).modelDiagnostic?.stage, 'specific:response-schema')
})

test('schemas cover reviews, continuation and scene composition with the same field checks', () => {
  for (const [schema, value] of [
    [preparationOutputSchemas.causalReview, { checks: [{ id: 'c0', valid: 'true', issueType: 'none' }] }],
    [preparationOutputSchemas.factReview, { checks: [{ id: 'c0', valid: true, sourceId: 'm0' }] }],
    [continuationOutputSchemas.composition, { options: [{ label: '先邀请', action: '邀请，proposedConsequence: 回应' }] }],
    [sceneOutputSchemas.composition(false), { attempt: { action: '先邀请', materialIds: [], preconditionIds: [] }, development: 'change: 回应, response: 换玩法, resultBasisIds: []' }],
  ] as const) assert.ok(outputShapeErrors(value, schema).length)
})

test('fact and causal reviews keep verdicts while repairing missing reasons', async () => {
  for (const [schema, fields] of [
    [preparationOutputSchemas.factReview, { id: 'c0', verdict: 'compatible', conflictMaterialIds: [], proposalEvidenceIds: [] }],
    [preparationOutputSchemas.factReview, { id: 'c0', verdict: 'contradictory', conflictMaterialIds: ['m0'], proposalEvidenceIds: ['p0-method'] }],
    [preparationOutputSchemas.causalReview, { id: 'c0', verdict: 'contradictory', needs: [], issueType: 'causal-gap', evidenceIds: ['p0-method', 'p0-change'] }],
  ] as const) {
    const missingReason = { checks: [{ ...fields }] }
    const repaired = { checks: [{ ...fields, reason: '原办法未产生后续取舍所依赖的变化。' }] }
    assert.ok(outputShapeErrors(missingReason, schema).length)
    assert.deepEqual(outputShapeErrors(repaired, schema), [])
    await mock(async requests => {
      assert.deepEqual(await requestQwenJson({ ...options, outputSchema: schema }), repaired)
      assert.equal(requests.length, 2)
      assert.match(JSON.parse(requests[1].messages[1].content).validationFailure, /reason/u)
    }, (_request, index) => response(index === 1 ? missingReason : repaired))
  }
  assert.ok(outputShapeErrors({ checks: [{ id: 'c0', materialIds: [], reason: '无冲突' }] }, preparationOutputSchemas.factReview).length)
  assert.deepEqual(outputShapeErrors({ checks: [{ id: 'c0', verdict: 'supported', issueType: 'none', needs: [], evidenceIds: [], reason: '无问题' }] }, preparationOutputSchemas.causalReview), [])
})

test('curve arrangement requests only canonical IDs and rejects fresh legacy prose', () => {
  const schema = preparationOutputSchemas.arrangement
  assert.equal(schema.properties!.steps!.items!.anyOf, undefined)
  const steps = [
    { kind: 'current-state', candidateIds: [], materialIds: ['m0'], displayMaterialIds: ['m0'] },
    { kind: 'trigger', displayMaterialIds: [], candidateIds: ['c0'], materialIds: ['m0'] },
    { kind: 'resolution', displayMaterialIds: [], candidateIds: ['c0'], materialIds: [] },
  ]
  assert.deepEqual(outputShapeErrors({ steps, supplements: [] }, schema), [])
  const { displayMaterialIds, ...missingDisplay } = steps[0]!
  assert.ok(outputShapeErrors({ steps: [missingDisplay, ...steps.slice(1)], supplements: [] }, schema).length)
  assert.ok(outputShapeErrors({ steps: [{ ...steps[0], title: '改写标题', text: '新写正文' }, ...steps.slice(1)], supplements: [] }, schema).length)
})

test('all three causal verdicts share one schema branch so constrained decoding can choose a rejection', () => {
  const schema = preparationOutputSchemas.causalReview
  const item = schema.properties!.checks!.items!
  assert.equal(item.anyOf, undefined)
  assert.deepEqual(item.properties!.verdict!.enum, ['supported', 'expandable', 'contradictory'])
  const checks = [
    { id: 'c0', verdict: 'supported', issueType: 'none', evidenceIds: [], needs: [], reason: '因果成立。' },
    { id: 'c1', verdict: 'expandable', issueType: 'none', evidenceIds: [],
      needs: [{ kind: 'setup', evidenceIds: ['p1-method'] }], reason: '已有道具的来历留给正文铺垫。' },
    { id: 'c2', verdict: 'contradictory', issueType: 'world-implausible',
      evidenceIds: ['p2-method', 'p2-change'], needs: [], reason: '明确不可用的手段却被当作成功。' },
  ]
  assert.deepEqual(outputShapeErrors({ checks }, schema), [])
})

test('reasoning schema accepts executable examples for both stages and outcomes without relaxing domain contracts', () => {
  for (const example of [reasoningEncodingExample, reasoningQuestionExample, reasoningEditExample]) {
    const wire = storyReasoningWireExample(example.output, example.context)
    assert.deepEqual(outputShapeErrors(wire, reasoningOutputSchema(example.context.stage)), [])
    const malformed = { ...wire, constraints: '[]' }
    assert.ok(outputShapeErrors(malformed, reasoningOutputSchema(example.context.stage)).length)
  }
})
