import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError } from './qwen.js'
import { acceptPreparation, activePreparationMaterial, generateStoryPreparation, generateCurveFromPreparation, parsePreparationMaterial, parsePreparationCandidates, parsePreparationReview, preparationReferenceContract } from './storyPreparation.js'
import { confirmProvisionalCurve, materializeConfirmedCurve } from './storyCoCreation.js'
import { requiredDesignProposalIds } from './storyDesignReview.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'

const source = { id: 'author-input', text: '方屿想核对书单；逐项计数能发现数量差异；计数不改动原书；没有期限；差异原因尚未确定。' }
const material = source.text.split('；').map((quote, i) => ({ id: `m${i}`, sourceId: source.id, quote, role: (i === 0 ? 'goal' : i === 4 ? 'unknown' : 'condition') as 'goal' | 'unknown' | 'condition' }))
const candidate = { id: 'count', action: '方屿逐项计数并核对书单。', materialIds: ['m0'], preconditionIds: ['m1','m2'], possibleResult: '若完成逐项计数，可能发现书单与实物数量差异；原因仍未知。', resultBasisIds: ['m1'], unknownIds: [] }
const brief = { tones: ['growth' as const], dramaticForces: [], allowSystemNamedCharacters: false }
const code = (name: string) => (e: unknown) => e instanceof AppError && e.code === name

test('extraction preserves conditions, negative wording and unknowns; rejects invented or omitted source material', () => {
  assert.deepEqual(parsePreparationMaterial({ material }, [source]), material)
  assert.throws(() => parsePreparationMaterial({ material: material.slice(0, 3) }, [source]), code('STORY_PREPARATION_INVALID_OUTPUT'))
  assert.throws(() => parsePreparationMaterial({ material: [{ ...material[0], quote: '已经核对书单' }] }, [source]), code('STORY_PREPARATION_INVALID_OUTPUT'))
  const unicode = [{ id: 's', text: '🛶没有期限。' }]
  assert.equal(parsePreparationMaterial({ material: [{ id: 'm', role: 'fact', sourceId: 's', quote: unicode[0]!.text }] }, unicode).length, 1)
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
test('two model calls stop before curve; only explicit acceptance permits arrangement, no unknown enters fact ledger', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  let calls = 0, bad = false, simple = false
  const review = { originalText: '只接受未来逐项计数。可能发现差异；计数尚未发生，结果未知。', candidates: [{ id: 'count', action: candidate.action, possibleResult: '计数后可能发现差异，也可能一致；原因保持未知。' }] }
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body))
    const prompt = input.messages[0].content as string
    if (prompt.includes('最小行动候选')) {
      assert.deepEqual(JSON.parse(input.messages[1].content).referenceContract, preparationReferenceContract(material))
    }
    if (simple) {
      const user = JSON.parse(input.messages[1].content)
      assert.deepEqual(user.authorReview, review)
      assert.equal(user.acceptedCandidates[0].possibleResult, review.candidates[0]!.possibleResult)
      assert.equal(user.brief, undefined)
    }
    calls++
    const response = prompt.includes('先整理作者材料') ? { material } : prompt.includes('最小行动候选') ? { candidates: [candidate], questions: [] }
      : { steps: (simple ? ['current-state','trigger','resolution'] : ['current-state','trigger','escalation','climax-choice','resolution']).map((kind, i) => { const content = kind === 'resolution' ? (simple ? review.candidates[0]!.possibleResult : candidate.possibleResult) : i ? candidate.action : material[0]!.quote; return { kind, title: content, text: content, candidateIds: i ? [bad ? 'invented' : 'count'] : [], materialIds: i ? ['m0','m1','m2'] : ['m0','m1','m2','m3'] } }), supplements: [] }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }), { status: 200 })
  }
  try {
    const curve = await generateStoryPreparation(source.text, brief)
    assert.equal(calls, 2); assert.deepEqual(curve.beats, []); assert.equal(curve.foundation, undefined)
    assert.throws(() => confirmProvisionalCurve(curve), code('STORY_PREPARATION_NOT_ACCEPTED'))
    await assert.rejects(() => generateCurveFromPreparation(curve, []), code('INVALID_REQUEST')); assert.equal(calls, 2)
    const before = structuredClone(curve)
    bad = true; await assert.rejects(() => generateCurveFromPreparation(curve, ['count']), code('STORY_PREPARATION_INVALID_OUTPUT'))
    assert.deepEqual(curve, before)
    bad = false; simple = true
    const reviewedCurve = await generateCurveFromPreparation(curve, ['count'], review)
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
    simple = false; const mapped = await generateCurveFromPreparation(curve, ['count'])
    assert.equal(mapped.preparation!.executed, false); assert.equal(mapped.preparation!.status, 'accepted-design')
    assert.equal(mapped.beats[1]!.detail, candidate.action)
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
