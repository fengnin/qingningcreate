import assert from 'node:assert/strict'
import test from 'node:test'
import { developmentStateIssues, type DevelopmentState } from './storyDevelopmentState.js'
import { outputShapeErrors } from './modelOutputSchema.js'
import { preparationOutputSchemas, projectionOutputSchema } from './storyOutputSchemas.js'
import { projectFutureChoices } from './storyPreparation.js'
import { AppError } from './qwen.js'

const plan = (): DevelopmentState => ({ means: [{ id: 'ability-1', capability: '借助披风单人渡过峡谷', status: 'available' }],
  methodUses: [{ meansId: 'ability-1', mode: 'rely' }], outcome: 'partial',
  states: [{ id: 'state-1', statement: '牧羊人受伤', status: 'absent' }, { id: 'state-2', statement: '学徒已赶上毕业仪式', status: 'uncertain' }],
  choiceRequires: [{ stateId: 'state-1', status: 'absent' }] })

test('declared unavailable and uncertain capabilities cannot be relied on; testing and failure remain valid', () => {
  for (const status of ['unavailable', 'uncertain'] as const) {
    const p = plan(); p.means[0]!.status = status
    assert.equal(developmentStateIssues(p)[0]?.issueType, 'world-implausible')
    p.methodUses[0]!.mode = 'test'; p.outcome = 'failure'
    assert.deepEqual(developmentStateIssues(p), [])
  }
})

test('a choice cannot require the opposite state or turn uncertainty into confirmation', () => {
  const p = plan()
  assert.deepEqual(developmentStateIssues(p), [])
  p.choiceRequires = [{ stateId: 'state-1', status: 'holds' }]
  assert.match(developmentStateIssues(p)[0]!.reason, /牧羊人受伤/)
  p.choiceRequires = [{ stateId: 'state-2', status: 'holds' }]
  assert.equal(developmentStateIssues(p)[0]?.issueType, 'causal-gap')
  p.choiceRequires = [{ stateId: 'state-2', status: 'absent' }]
  assert.equal(developmentStateIssues(p)[0]?.issueType, 'causal-gap')
  p.choiceRequires = [{ stateId: 'state-2', status: 'uncertain' }]
  assert.deepEqual(developmentStateIssues(p), [])
  p.choiceRequires = [] // Checking or acting on a condition does not assert it already holds.
  assert.deepEqual(developmentStateIssues(p), [])
})

function development(id: string) {
  const p = plan()
  return { id, attempt: { means: p.means, methodUses: p.methodUses, text: '学徒把披风借给牧羊人，自己留在桥头。', materialIds: ['m0'] },
    change: { text: '牧羊人可能安全渡过，两人未受伤，学徒却失去立即赶路的机会。', materialIds: [], outcome: p.outcome, states: p.states },
    futureChoice: { text: '把披风留给牧羊人，自己绕路赶往高塔，还是等披风送回再出发？', requires: p.choiceRequires } }
}

test('the production projection schema requires one complete development with state before its choice', () => {
  const item = development('d0')
  assert.deepEqual(outputShapeErrors({ developments: [item] }, preparationOutputSchemas.projection), [])
  const { states, ...withoutState } = item.change
  assert.ok(outputShapeErrors({ developments: [{ ...item, attempt: { ...item.attempt, means: [], methodUses: [] } }] }, preparationOutputSchemas.projection).length)
  assert.ok(outputShapeErrors({ developments: [{ ...item, change: withoutState }] }, preparationOutputSchemas.projection).length)
  assert.deepEqual(Object.keys(preparationOutputSchemas.projection.properties!.developments!.items!.properties!).filter(key => key !== 'id').sort(), ['attempt', 'change', 'futureChoice'])
  assert.ok(outputShapeErrors({ bridges: [], futureChoices: [] }, preparationOutputSchemas.projection).length)
})

test('generation constrains author references and leaves invented consequences unreferenced', () => {
  const item = development('d0')
  const schema = projectionOutputSchema([{ materialIds: ['m0'], resultBasisIds: [] }])
  assert.deepEqual(outputShapeErrors({ developments: [item] }, schema), [])
  assert.ok(outputShapeErrors({ developments: [{ ...item, change: { ...item.change, materialIds: ['m0'] } }] }, schema).length)
  assert.ok(outputShapeErrors({ developments: [{ ...item, attempt: { ...item.attempt, materialIds: ['not-allowed'] } }] }, schema).length)
  assert.deepEqual(outputShapeErrors({ developments: [item] }, preparationOutputSchemas.projection), []) // No mutation of the shared schema.
})

test('review contracts use a single verdict and reject a second conflicting boolean', () => {
  for (const [schema, fields] of [
    [preparationOutputSchemas.factReview, { id: 'd0', verdict: 'contradictory', conflictMaterialIds: ['m0'], proposalEvidenceIds: ['p0-method'], reason: '提案越过作者原有能力限制。' }],
    [preparationOutputSchemas.causalReview, { id: 'd0', verdict: 'contradictory', needs: [], issueType: 'causal-gap', evidenceIds: ['p0-method', 'p0-change'], reason: '结果否定后续选择所需状态。' }],
  ] as const) {
    assert.deepEqual(outputShapeErrors({ checks: [fields] }, schema), [])
    assert.ok(outputShapeErrors({ checks: [{ ...fields, valid: true }] }, schema).length)
  }
})

async function withModel(run: (seen: { stage: string; input: any }[]) => Promise<void>,
  reply: (stage: string, input: any) => unknown) {
  const original = globalThis.fetch
  const names = ['DASHSCOPE_API_KEY', 'STORY_DISABLE_MODEL'] as const
  const saved = names.map(name => process.env[name])
  process.env.DASHSCOPE_API_KEY = 'contract-stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const seen: { stage: string; input: any }[] = []
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const stage = request.response_format.json_schema.name as string
    const input = JSON.parse(request.messages[1].content)
    seen.push({ stage, input })
    const output: any = reply(stage, input)
    if (stage.endsWith('world-review')) output.checks = output.checks.map((check: any) => ({ id: check.id, verdict: 'supported', issueType: 'none', needs: [], evidenceIds: [], reason: check.reason }))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output,
      (key, value) => key === 'valid' ? undefined : value) } }] }))
  }
  try { await run(seen) } finally {
    globalThis.fetch = original
    names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i] })
  }
}

const source = { id: 'author-input', text: '学徒要在日落前赶往高塔领毕业徽章，披风只能托一人，桥上有牧羊人。' }
const brief = { tones: [], dramaticForces: [], allowSystemNamedCharacters: false }
const candidates = () => ['d0', 'd1', 'd2'].map(id => ({ id, action: '学徒想借披风救人，同时赶往高塔。',
  possibleResult: '救援可能延误赶路。', materialIds: ['m0'], resultBasisIds: [], preconditionIds: [], unknownIds: [] }))

test('an unresolved outcome can motivate checking or a conditional choice without a local regeneration', async () => {
  let generations = 0
  await withModel(async seen => {
    const result = await projectFutureChoices(candidates().slice(0, 1), [source], brief)
    assert.equal(generations, 1)
    assert.match(result[0]!.futureChoice!, /赶得上/)
    const review = seen.find(call => call.stage.endsWith('world-review'))!
    assert.equal(review.input.proposals[0].developmentState.choiceRequires[0].status, 'uncertain')
    assert.ok(!('developmentState' in result[0]!))
  }, (stage, input) => {
    if (stage === 'preparation-future-choice') {
      generations++
      const d = development('d0')
      d.futureChoice = { text: '先问清绕路是否赶得上仪式再决定出发，还是留在桥头等披风送回？',
        requires: [{ stateId: 'state-2', status: 'uncertain' }] }
      assert.deepEqual(outputShapeErrors({ developments: [d] }, preparationOutputSchemas.projection), [])
      return { developments: [d] }
    }
    return { checks: (input.candidates ?? input.proposals).map((c: any) => stage.endsWith('fact-review')
      ? { id: c.id, verdict: 'compatible', conflictMaterialIds: [], proposalEvidenceIds: [], reason: '无冲突' }
      : { id: c.id, issueType: 'none', reason: '尚未确定的结果引出核实，没有当成已经成功。' }) }
  })
})

for (const defect of ['state', 'capability'] as const) test(`local ${defect} mismatch repairs only that direction even when the semantic model would pass`, async () => {
  let generations = 0
  const before = candidates()
  await withModel(async seen => {
    const result = await projectFutureChoices(before, [source], brief)
    assert.equal(generations, 2)
    const generationRequests = seen.filter(call => call.stage === 'preparation-future-choice')
    assert.deepEqual(generationRequests[1]!.input.candidates.map((c: any) => c.id), ['d1'])
    assert.equal(generationRequests[1]!.input.previousProjections[0].developmentState.states[0].status, 'absent')
    assert.equal(generationRequests[1]!.input.repairReasons[0].issueType, defect === 'state' ? 'causal-gap' : 'world-implausible')
    const reviews = seen.filter(call => call.stage.endsWith('world-review'))
    assert.deepEqual(reviews.map(call => call.input.proposals.map((p: any) => p.id)), [['d0', 'd2'], ['d1']])
    assert.ok(reviews.every(call => call.input.proposals.every((p: any) => p.developmentState)))
    assert.deepEqual(before, candidates())
    for (const candidate of result) {
      assert.deepEqual(candidate.causalBridge, { method: development(candidate.id).attempt.text, change: development(candidate.id).change.text,
        methodBasisIds: ['m0'], changeBasisIds: [] })
      assert.ok(!JSON.stringify(candidate).includes('state-1'))
      assert.ok(!('developmentState' in candidate))
    }
  }, (stage, input) => {
    if (stage === 'preparation-future-choice') {
      generations++
      return { developments: input.candidates.map((c: any) => {
        const d = development(c.id)
        if (generations === 1 && c.id === 'd1') {
          if (defect === 'state') { d.futureChoice.text = '先给牧羊人止血包扎，还是请人照顾伤者？'; d.futureChoice.requires[0]!.status = 'holds' }
          else d.attempt.means[0]!.status = 'unavailable'
        }
        return d
      }) }
    }
    return { checks: (input.candidates ?? input.proposals).map((c: any) => stage.endsWith('fact-review')
      ? { id: c.id, verdict: 'compatible', conflictMaterialIds: [], proposalEvidenceIds: [], reason: '无冲突' }
      : { id: c.id, valid: true, issueType: 'none', reason: '测试审阅桩；不证明语义成立。' }) }
  })
})

test('a repeated declared contradiction exhausts two local repairs without releasing the bad direction', async () => {
  let generations = 0, reviews = 0
  await withModel(async () => {
    await assert.rejects(() => projectFutureChoices(candidates().slice(0, 1), [source], brief),
      (error: unknown) => error instanceof AppError && error.code === 'STORY_PREPARATION_QUALITY_FAILED')
    assert.equal(generations, 3)
    assert.equal(reviews, 0)
  }, (stage, input) => {
    assert.equal(stage, 'preparation-future-choice'); generations++
    const d = development(input.candidates[0].id)
    d.futureChoice.requires[0]!.status = 'holds'
    return { developments: [d] }
  })
})
