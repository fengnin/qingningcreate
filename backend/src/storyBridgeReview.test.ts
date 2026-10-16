import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError } from './qwen.js'
import { bridgeRepairDiagnostic, parseBridgeEvidence, bridgeEvidenceCatalog, parseBridgeReviewCheck, selectedExpansionNeeds, currentExpansionNeeds } from './storyBridgeReview.js'
import { projectFutureChoices, acceptPreparation } from './storyPreparation.js'
import type { StoryPreparation } from '../../shared/story-preparation.js'

const proposal = { action: '借披风救人。', possibleResult: '救援后可能延误赶路。', method: '学徒把使用方法喊给牧羊人。',
  change: '牧羊人可能渡过，学徒留下等披风。', futureChoice: '等披风回来，还是另寻路赶往高塔？' }
const authors = ['披风只能托起一人的重量。']
const evidence = [{ field: 'method', quote: proposal.method }, { field: 'change', quote: proposal.change }]
const catalog = bridgeEvidenceCatalog([{ id: 'd0', ...proposal }, { id: 'd1', ...proposal, method: '另一方向尝试飞走。' }], authors)

test('review selects canonical excerpts without retyping and cannot invent or borrow another directions evidence', () => {
  assert.deepEqual(parseBridgeEvidence(['p0-method', 'p0-change'], true, 'd0', catalog), evidence)
  for (const invalid of [[], ['p0-method'], ['p0-method', 'p0-method'], ['invented-qualification', 'p0-method'],
    ['p1-method', 'p0-change'], ['developmentState', 'p0-change'], [proposal.method, proposal.change],
  ]) assert.throws(() => parseBridgeEvidence(invalid, true, 'd0', catalog),
    (error: unknown) => error instanceof AppError && error.code === 'STORY_PREPARATION_INVALID_OUTPUT')
  assert.deepEqual(parseBridgeEvidence([], false, 'd0', catalog), [])
  assert.deepEqual(parseBridgeEvidence(['p1-method', 'p1-change'], false, 'd0', catalog), [])
})

const candidate = { id: 'd0', action: proposal.action, possibleResult: proposal.possibleResult, materialIds: ['m0'],
  resultBasisIds: [], preconditionIds: [], unknownIds: [], futureChoice: proposal.futureChoice,
  causalBridge: { method: proposal.method, change: proposal.change, methodBasisIds: ['m0'], changeBasisIds: [] } }

test('expansion notes contain only current proposal excerpts and a category, never a reviewer solution', () => {
  const decision = { id: 'd0', verdict: 'expandable', reason: '建议新增资格认证和秘密功能。',
    issueType: 'none', evidenceIds: [],
    needs: [{ kind: 'action-detail', evidenceIds: ['p0-method'] }] }
  const check = parseBridgeReviewCheck(decision, catalog)
  assert.equal(check.valid, true)
  assert.equal(check.issueType, 'none')
  assert.deepEqual(check.expansionNeeds, [{ kind: 'action-detail', anchors: [{ field: 'method', quote: proposal.method }] }])
  assert.doesNotMatch(JSON.stringify(check.expansionNeeds), /资格|秘密功能/)
  for (const wrong of [
    { ...decision, needs: [] },
    { ...decision, issueType: 'world-implausible' },
    { ...decision, needs: [{ kind: 'qualification', evidenceIds: ['p0-method'] }] },
    { ...decision, needs: [{ kind: 'setup', evidenceIds: ['a0'] }] },
    { ...decision, needs: [{ kind: 'setup', evidenceIds: ['p1-method'] }] },
    { ...decision, needs: [{ kind: 'setup', evidenceIds: ['p0-method'], instruction: '新增认证' }] },
  ]) assert.throws(() => parseBridgeReviewCheck(wrong, catalog), (e: unknown) => e instanceof AppError
    && e.code === 'STORY_PREPARATION_INVALID_OUTPUT')
  const rejected = parseBridgeReviewCheck({ id: 'd0', verdict: 'contradictory', issueType: 'world-implausible',
    needs: [], evidenceIds: ['a0', 'p0-change'], reason: '结果违反明确承载上限。' }, catalog)
  assert.equal(rejected.valid, false)
  assert.deepEqual(rejected.expansionNeeds, [])
})

test('expansion is non-blocking, preserved across unrelated repairs and never forwarded as a new repair', async () => {
  let generations = 0, reviews = 0
  await withModel((stage, input) => {
    if (stage.endsWith('fact-review')) return { checks: input.candidates.map((c: any) => ({ id: c.id, verdict: 'compatible', conflictMaterialIds: [], proposalEvidenceIds: [], reason: '无冲突' })) }
    if (stage === 'preparation-future-choice') {
      generations++
      assert.deepEqual(input.candidates.map((c: any) => c.id), ['d1'])
      assert.doesNotMatch(JSON.stringify(input), /资格认证|隐藏电路/)
      return { developments: [{ id: 'd1', attempt: { means: [{ id: 'a', capability: '口头说明', status: 'available' }],
        methodUses: [{ meansId: 'a', mode: 'rely' }], text: proposal.method, materialIds: ['m0'] },
        change: { outcome: 'uncertain', states: [{ id: 's', statement: '牧羊人安全渡过', status: 'uncertain' }], text: proposal.change, materialIds: [] },
        futureChoice: { requires: [], text: proposal.futureChoice } }] }
    }
    reviews++
    return { checks: input.proposals.map((c: any) => c.id === 'd0'
      ? { id: c.id, verdict: 'expandable', reason: '需在正文表现过程，资格认证和隐藏电路并不是已有规则。', needs: [{ kind: 'action-detail', evidenceIds: ['p0-method'] }] }
      : reviews === 1 ? { id: c.id, verdict: 'contradictory', issueType: 'causal-gap', evidenceIds: ['p1-method', 'p1-change'], reason: '测试中的待修复连接。' }
      : { id: c.id, verdict: 'supported', reason: '修复后可继续展开。' }) }
  }, async () => {
    const before = structuredClone(candidate)
    const result = await projectFutureChoices([candidate, { ...candidate, id: 'd1' }], [{ id: 'author-input', text: authors[0]! }],
      { tones: [], dramaticForces: [], allowSystemNamedCharacters: false })
    assert.deepEqual(result[0]!.expansionNeeds, [{ kind: 'action-detail', anchors: [{ field: 'method', quote: proposal.method }] }])
    assert.deepEqual(result[1], { ...candidate, id: 'd1' })
    assert.deepEqual(candidate, before)
    assert.equal(generations, 1)
    assert.equal(reviews, 2)
  })
})

test('a rejection never carries non-applicable expansion notes to writing or changes its verdict', () => {
  const raw = { id: 'd0', verdict: 'contradictory', issueType: 'causal-gap',
    evidenceIds: ['p0-method', 'p0-change'], reason: '所称结果与明确限制矛盾。',
    needs: [{ kind: 'action-detail', evidenceIds: ['p0-method'] }] }
  const result = parseBridgeReviewCheck(raw, catalog)
  assert.equal(result.valid, false)
  assert.equal(result.verdict, 'contradictory')
  assert.deepEqual(result.evidence, evidence)
  assert.deepEqual(result.expansionNeeds, [])
  assert.equal(raw.needs.length, 1)
})

test('only selected, unchanged accepted designs carry expansion notes; author edits invalidate the old needs', () => {
  const needs = [{ kind: 'setup' as const, anchors: [{ field: 'action' as const, quote: candidate.action }] }]
  const prepared: StoryPreparation = { protocol: 1, status: 'needs-review', executed: false,
    sources: [{ id: 'author-input', text: authors[0]! }], material: [{ id: 'm0', sourceId: 'author-input', quote: authors[0]!, role: 'condition' }],
    candidates: [{ ...candidate, expansionNeeds: needs }, { ...candidate, id: 'd1' }], questions: [], acceptedCandidateIds: [] }
  assert.deepEqual(selectedExpansionNeeds(prepared), [])
  const accepted = acceptPreparation(prepared, ['d0'])
  assert.deepEqual(selectedExpansionNeeds(accepted), needs)
  assert.deepEqual(selectedExpansionNeeds(acceptPreparation(prepared, ['d1'])), [])
  const edited = acceptPreparation(prepared, ['d0'], { originalText: '作者改写后续取舍。', candidates: [{ id: 'd0',
    action: candidate.action, possibleResult: candidate.possibleResult, futureChoice: '先确认救援进展，还是请人接应？' }] })
  assert.deepEqual(selectedExpansionNeeds(edited), [])
  assert.deepEqual(edited.originalCandidates?.[0]?.expansionNeeds, needs)
  assert.deepEqual(currentExpansionNeeds({ ...candidate, action: '作者改成另一种尝试。', expansionNeeds: needs }), [])
  assert.deepEqual(prepared.candidates[0]!.expansionNeeds, needs)
})

async function withModel(reply: (stage: string, input: any) => unknown, run: () => Promise<void>) {
  const original = globalThis.fetch, saved = [process.env.DASHSCOPE_API_KEY, process.env.STORY_DISABLE_MODEL]
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), input = JSON.parse(request.messages[1].content)
    const output: any = reply(request.response_format.json_schema.name, input)
    if (request.response_format.json_schema.name.endsWith('world-review')) output.checks = output.checks.map((c: any) => ({ issueType: 'none', evidenceIds: [], needs: [], ...c }))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))
  }
  try { await run() } finally {
    globalThis.fetch = original
    ;['DASHSCOPE_API_KEY', 'STORY_DISABLE_MODEL'].forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]
    })
  }
}

test('a cross-direction reference retries the unchanged review and never becomes a story rewrite', async () => {
  let reviews = 0, generations = 0, seen: unknown
  await withModel((stage, input) => {
    if (stage.endsWith('fact-review')) return { checks: input.candidates.map((c: any) => ({ id: c.id, verdict: 'compatible', conflictMaterialIds: [], proposalEvidenceIds: [], reason: '无冲突' })) }
    if (stage === 'preparation-future-choice') { generations++; throw Error('must not regenerate') }
    reviews++
    if (reviews === 1) {
      seen = input.proposals
      return { checks: [{ id: 'd0', verdict: 'contradictory', issueType: 'world-implausible', reason: '补上牧羊人的飞行培训经历。',
        evidenceIds: ['p1-method', 'p0-change'] }, { id: 'd1', verdict: 'supported', reason: '无断裂。' }] }
    }
    assert.deepEqual(input.proposals, seen)
    assert.match(input.validationFailure, /审阅依据编号不合法/)
    return { checks: input.proposals.map((c: any) => ({ id: c.id, verdict: 'supported', reason: '已有口头教导与可能性表达，不要求原文未规定的资格。' })) }
  }, async () => {
    const candidates = [candidate, { ...candidate, id: 'd1' }]
    assert.deepEqual(await projectFutureChoices(candidates, [{ id: 'author-input', text: authors[0]! }],
      { tones: [], dramaticForces: [], allowSystemNamedCharacters: false }), candidates)
    assert.deepEqual([reviews, generations], [2, 0])
  })
})

test('persistent invalid evidence ends as a review error instead of a content rejection or silent approval', async () => {
  let reviews = 0
  await withModel(stage => stage.endsWith('fact-review') ? { checks: [{ id: 'd0', verdict: 'compatible', conflictMaterialIds: [], proposalEvidenceIds: [], reason: '无冲突' }] }
    : (reviews++, { checks: [{ id: 'd0', verdict: 'contradictory', issueType: 'causal-gap', evidenceIds: ['p0-method', 'p0-method'], reason: '请添加特殊功能。' }] }), async () => {
    await assert.rejects(() => projectFutureChoices([candidate], [{ id: 'author-input', text: authors[0]! }],
      { tones: [], dramaticForces: [], allowSystemNamedCharacters: false }), (error: unknown) => error instanceof AppError
        && error.code === 'STORY_PREPARATION_INVALID_OUTPUT'
        && error.modelDiagnostic?.stage === 'preparation-future-choice-world-review:response-schema')
    assert.equal(reviews, 2)
  })
})

test('a substantive rejection sends excerpts to repair without forwarding the reviewers invented solution', async () => {
  let reviews = 0, generations = 0
  await withModel((stage, input) => {
    if (stage.endsWith('fact-review')) return { checks: [{ id: 'd0', verdict: 'compatible', conflictMaterialIds: [], proposalEvidenceIds: [], reason: '无冲突' }] }
    if (stage === 'preparation-future-choice') {
      generations++
      assert.deepEqual(input.repairReasons, [bridgeRepairDiagnostic({ id: 'd0', issueType: 'causal-gap', evidence: evidence as any })])
      assert.doesNotMatch(JSON.stringify(input), /新增自动返程|秘密芯片/)
      return { developments: [{ id: 'd0', attempt: { means: [{ id: 'a', capability: '口头说明', status: 'available' }],
        methodUses: [{ meansId: 'a', mode: 'rely' }], text: proposal.method, materialIds: ['m0'] },
        change: { outcome: 'uncertain', states: [{ id: 's', statement: '牧羊人安全渡过', status: 'uncertain' }], text: proposal.change, materialIds: [] },
        futureChoice: { requires: [{ stateId: 's', status: 'uncertain' }], text: '先在桥头确认对方是否安全，还是请路人接应后另寻路赶往高塔？' } }] }
    }
    reviews++
    return { checks: [reviews === 1
      ? { id: 'd0', verdict: 'contradictory', issueType: 'causal-gap', evidenceIds: ['p0-method', 'p0-change'], reason: '建议新增自动返程功能或秘密芯片来解释披风返回。' }
      : { id: 'd0', verdict: 'supported', reason: '明确先确认救援结果，再作后续选择。' }] }
  }, async () => {
    const before = structuredClone(candidate)
    await projectFutureChoices([candidate], [{ id: 'author-input', text: authors[0]! }], { tones: [], dramaticForces: [], allowSystemNamedCharacters: false })
    assert.deepEqual(candidate, before)
    assert.deepEqual([reviews, generations], [2, 1])
  })
})
