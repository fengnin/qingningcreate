import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError } from './qwen.js'
import { acceptPreparation, activePreparationMaterial, parsePreparationReview } from './storyPreparation.js'
import { parsePreparationExplanation, suggestPreparationExplanation } from './storyPreparationExplanation.js'
import { parseStoryPreparationExplanationRequest } from './storyService.js'
import type { StoryPreparation, StoryPreparationExplanation } from '../../shared/story-preparation.js'
import { currentExpansionNeeds, selectedExpansionNeeds } from './storyBridgeReview.js'
import { createStoryProposalContext } from './storyProposalContext.js'

const candidate = { id: 'c0', action: '遇到的难处：书单数量不符。眼前的选择：逐项核对。', possibleResult: '可能找到数量差异，原因仍未知。', futureChoice: '先告诉同伴还是继续核对？',
  materialIds: ['m0'], preconditionIds: [], resultBasisIds: [], unknownIds: [],
  causalBridge: { method: '逐项核对书单。', change: '可能发现差异。', methodBasisIds: ['m0'], changeBasisIds: [] },
  expansionNeeds: [{ kind: 'action-detail' as const, anchors: [{ field: 'method' as const, quote: '逐项核对书单。' }] }] }
const p: StoryPreparation = { protocol: 1, status: 'needs-review', sources: [{ id: 'author-input', text: '方屿想核对书单；差异原因尚未确定。' }],
  material: [{ id: 'm0', sourceId: 'author-input', role: 'goal', quote: '方屿想核对书单；' }, { id: 'm1', sourceId: 'author-input', role: 'unknown', quote: '差异原因尚未确定。' }],
  candidates: [candidate, { ...candidate, id: 'c1' }, { ...candidate, id: 'c2' }], questions: [], acceptedCandidateIds: [], executed: false }
const wording = { action: candidate.action, possibleResult: candidate.possibleResult, futureChoice: candidate.futureChoice }
const explanation: StoryPreparationExplanation = { wording, method: '方屿与同伴对照书单。', change: '两份记录可能出现不一致。', issues: ['差异原因仍待设计。'], source: 'author' }
const code = (name: string) => (e: unknown) => e instanceof AppError && e.code === name

test('explicit explanation review permits retaining an outcome after changing the choice, without creating facts or changing other cards', () => {
  const original = structuredClone(p)
  const edited = { ...wording, action: `${candidate.action}请同伴协助。` }
  const review = { originalText: '我核对了新选择及保留的结果，原因仍未知。', candidates: [{ id: 'c0', ...edited, explanation: { ...explanation, wording: edited } }] }
  const accepted = acceptPreparation(p, ['c0'], review)
  assert.deepEqual(p, original)
  assert.deepEqual(accepted.candidates.slice(1), p.candidates.slice(1))
  assert.deepEqual(accepted.candidates[0]!.explanation, review.candidates[0]!.explanation)
  assert.equal(accepted.candidates[0]!.causalBridge, undefined)
  assert.equal(accepted.candidates[0]!.expansionNeeds, undefined)
  assert.deepEqual(accepted.originalCandidates, original.candidates)
  assert.deepEqual(activePreparationMaterial(accepted), original.material)
  assert.equal(accepted.executed, false)
})

test('each of the three card fields invalidates an adopted explanation, even when other wording is unchanged', () => {
  for (const field of ['action', 'possibleResult', 'futureChoice'] as const) {
    const edited = { ...wording, [field]: `${wording[field]}再修改。` }
    assert.throws(() => acceptPreparation(p, ['c0'], { originalText: '再次修改', candidates: [{ id: 'c0', ...edited, explanation }] }), code('STORY_PREPARATION_EXPLANATION_STALE'))
  }
})

test('a future-choice-only edit discards the old causal bridge and expansion notes', () => {
  const accepted = acceptPreparation(p, ['c0'], { originalText: '改变后续选择。', candidates: [{ id: 'c0', ...wording, futureChoice: '要独自核对还是请同伴帮忙？' }] })
  assert.equal(accepted.candidates[0]!.causalBridge, undefined)
  assert.equal(accepted.candidates[0]!.expansionNeeds, undefined)
  assert.deepEqual(accepted.originalCandidates![0]!.causalBridge, candidate.causalBridge)
})

test('explanation editing preserves author whitespace and unresolved issues but cannot inject material references or facts', () => {
  const reviewed = { ...explanation, method: '  我自己写的办法。\n', issues: ['暂时保留疑问。'] }
  const review = { originalText: '仅接受设计。', candidates: [{ id: 'c0', ...wording, explanation: reviewed }] }
  assert.deepEqual(parsePreparationReview(review, ['c0']), review)
  assert.deepEqual(parsePreparationExplanation(reviewed), reviewed)
  assert.throws(() => parsePreparationExplanation({ ...reviewed, confirmedQuotes: ['已成功。'] }), code('INVALID_REQUEST'))
  assert.throws(() => parsePreparationExplanation({ ...reviewed, methodBasisIds: ['m1'] }), code('INVALID_REQUEST'))
  assert.throws(() => parsePreparationExplanation({ ...reviewed, issues: ['a', 'b', 'c', 'd'] }), code('INVALID_REQUEST'))
})

test('preview requests accept exact current wording, including a cleared future choice, and reject oversized drafts', () => {
  const request = { storyId: 'story-test', revision: 1, curveId: 'curve-test', candidate: { id: 'c0', ...wording, futureChoice: '' } }
  assert.deepEqual(parseStoryPreparationExplanationRequest(request), request)
  assert.throws(() => parseStoryPreparationExplanationRequest({ ...request, candidate: { ...request.candidate, action: '字'.repeat(241) } }), code('INVALID_REQUEST'))
  assert.throws(() => parseStoryPreparationExplanationRequest({ ...request, candidate: { ...request.candidate, material: [] } }), code('INVALID_REQUEST'))
})

test('single-card model preview cannot mutate the preparation or overwrite card wording and surfaces gaps for the author', async t => {
  const original = structuredClone(p)
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  })
  process.env.DASHSCOPE_API_KEY = 'stub'
  process.env.STORY_DISABLE_MODEL = 'false'
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    const request = JSON.parse(String(init?.body))
    const input = JSON.parse(request.messages[1].content)
    if (input.task === 'select-story-effects') {
      const refs = request.response_format.json_schema.schema.properties.needs.items.properties.evidenceIds.items.enum
      assert.ok(refs.every((ref: string) => ref.startsWith('p0-')))
      assert.deepEqual(refs, ['p0-action', 'p0-possibleResult'])
      assert.ok(input.evidenceCatalog.every((e: { field: string }) => e.field !== 'futureChoice' && e.field !== 'author'))
    }
    assert.deepEqual(input.futureDesign, { authority: 'draft-future-design', executed: false, candidate: { id: 'c1', ...wording } })
    assert.equal('candidate' in input, false)
    assert.equal('material' in input, false)
    assert.equal('sources' in input, false)
    assert.deepEqual(input.authorMaterial.goals, [p.material[0]])
    assert.deepEqual(input.authorReservedUnknowns.entries, [p.material[1]])
    assert.deepEqual(input.sourceContext.sources, [{ ...p.sources[0], scope: 'full-source' }])
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(input.task === 'select-story-effects'
      ? { assessment: '核对过程支撑后续行动。', needs: [{ kind: 'action-detail', evidenceIds: ['p0-action'] }] }
      : calls === 1
      ? { id: 'c1', conflict: 'none', reason: '方向成立，关键过程不必现在补答。', evidenceIds: [] }
      : { method: explanation.method, change: explanation.change }) } }] }))
  }
  const preview = await suggestPreparationExplanation(p, { id: 'c1', ...wording })
  assert.equal(calls, 3)
  assert.deepEqual(preview, { ...explanation, issues: [], source: 'system', expansionNeeds: [{ kind: 'action-detail', anchors: [{ field: 'action', quote: candidate.action }] }] })
  assert.deepEqual(p, original)
  await assert.rejects(() => suggestPreparationExplanation(p, { id: 'missing', ...wording }), code('STORY_PREPARATION_NOT_PENDING'))
  await assert.rejects(() => suggestPreparationExplanation({ ...p, status: 'accepted-design' }, { id: 'c1', ...wording }), code('STORY_PREPARATION_NOT_PENDING'))
  assert.equal(calls, 3)
})

test('adopted explanation notes replace old notes and reach continuation without becoming facts', () => {
  const adopted: StoryPreparationExplanation = { ...explanation, issues: [], expansionNeeds: [
    { kind: 'action-detail', anchors: [{ field: 'method', quote: explanation.method }] },
    { kind: 'response-detail', anchors: [{ field: 'futureChoice', quote: wording.futureChoice }] },
  ] }
  const accepted = acceptPreparation(p, ['c0'], { originalText: '采用这张卡和正文待展开标记。', candidates: [{ id: 'c0', ...wording, explanation: adopted }] })
  assert.equal(accepted.candidates[0]!.causalBridge, undefined)
  assert.deepEqual(selectedExpansionNeeds(accepted), adopted.expansionNeeds)
  const context = createStoryProposalContext({ subject: '方屿', activeSituation: '核对书单', lockedGoal: '核对书单', lockedFacts: [], worldMode: 'realistic-default', expansionScope: 'keep-scale', unknowns: [] },
    { id: 'curve', provisionalCurveId: 'draft', title: '核对', confirmedAt: 1, brief: { tones: [], dramaticForces: [], allowSystemNamedCharacters: false }, beats: [], clarifications: [], preparation: accepted }, [], [])
  assert.deepEqual(context.expansionNeeds, adopted.expansionNeeds)
  assert.ok(!context.sourceFacts.some(f => f.text === adopted.method || f.text === adopted.change))
  const changed = structuredClone(accepted.candidates[0]!)
  changed.action += '再次修改。'
  assert.deepEqual(currentExpansionNeeds(changed), [])
  const cleared = acceptPreparation(p, ['c0'], { originalText: '不保留待展开。', candidates: [{ id: 'c0', ...wording, explanation: { ...explanation, expansionNeeds: [] } }] })
  assert.deepEqual(selectedExpansionNeeds(cleared), [])
})

test('explanation notes must anchor exact current prose and cannot add a solution or source authority', () => {
  const need = { kind: 'setup', anchors: [{ field: 'method', quote: explanation.method }] }
  assert.equal(parsePreparationExplanation({ ...explanation, expansionNeeds: [need] }).expansionNeeds?.length, 1)
  for (const invalid of [
    { ...need, text: '必须新增认证。' },
    { ...need, anchors: [{ field: 'author', quote: p.sources[0]!.text }] },
    { ...need, anchors: [{ field: 'method', quote: '旧解释' }] },
    { ...need, anchors: [{ field: 'method', quote: explanation.method.slice(0, -1) }] },
  ]) assert.throws(() => parsePreparationExplanation({ ...explanation, expansionNeeds: [invalid] }), code('INVALID_REQUEST'))
  assert.throws(() => parsePreparationExplanation({ ...explanation, expansionNeeds: [need, need] }), code('INVALID_REQUEST'))
})

test('character, emotional and payoff notes survive adoption and continuation as design, and stale notes are discarded', () => {
  for (const kind of ['character-detail', 'emotional-beat', 'payoff'] as const) {
    const adopted = { ...explanation, issues: [], expansionNeeds: [{ kind, anchors: [{ field: 'action' as const, quote: wording.action }] }] }
    assert.deepEqual(parsePreparationExplanation(adopted), adopted)
    const before = structuredClone(p)
    const accepted = acceptPreparation(p, ['c0'], { originalText: '保留已选设计的重要故事作用。', candidates: [{ id: 'c0', ...wording, explanation: adopted }] })
    assert.deepEqual(selectedExpansionNeeds(accepted), adopted.expansionNeeds)
    assert.deepEqual(activePreparationMaterial(accepted), activePreparationMaterial(p))
    assert.equal(accepted.executed, false)
    const context = createStoryProposalContext({ subject: '方屿', activeSituation: '核对书单', lockedGoal: '核对书单', lockedFacts: [], worldMode: 'realistic-default', expansionScope: 'keep-scale', unknowns: [] },
      { id: 'curve', provisionalCurveId: 'draft', title: '核对', confirmedAt: 1, brief: { tones: [], dramaticForces: [], allowSystemNamedCharacters: false }, beats: [], clarifications: [], preparation: accepted }, [], [])
    assert.deepEqual(context.expansionNeeds, adopted.expansionNeeds)
    assert.deepEqual(currentExpansionNeeds({ ...accepted.candidates[0]!, action: '作者改了行动。' }), [])
    assert.deepEqual(p, before)
  }
})

test('model verdict controls issues and notes; structural and genuine contradictions are not silently reclassified', async t => {
  const saved = { key: process.env.DASHSCOPE_API_KEY, disabled: process.env.STORY_DISABLE_MODEL, fetch: globalThis.fetch }
  t.after(() => {
    globalThis.fetch = saved.fetch
    if (saved.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = saved.key
    if (saved.disabled === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = saved.disabled
  })
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  // An unused supporting reason may be empty; that must not force a retry or create an author question.
  let review: Record<string, unknown> = { id: 'c0', verdict: 'supported', reason: '', issueType: 'none', evidenceIds: [], needs: [] }
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(input.task === 'select-story-effects'
      ? { assessment: '保留已有故事作用。', needs: review.needs }
      : input.detailReview ? { method: explanation.method, change: explanation.change }
      : { id: review.id, conflict: review.issueType === 'none' ? 'none' : 'impossible-mechanism', reason: review.reason, evidenceIds: review.evidenceIds }) } }] }))
  }
  assert.deepEqual((await suggestPreparationExplanation(p, { id: 'c0', ...wording })).issues, [])
  for (const kind of ['setup', 'character-detail', 'emotional-beat', 'payoff']) {
    review = { id: 'c0', issueType: 'none', reason: '', evidenceIds: [], needs: [{ kind, evidenceIds: ['p0-action'] }] }
    const preview = await suggestPreparationExplanation(p, { id: 'c0', ...wording })
    assert.deepEqual(preview.expansionNeeds, [{ kind, anchors: [{ field: 'action', quote: wording.action }] }])
    assert.deepEqual(preview.issues, [])
    assert.equal('assessment' in preview, false)
  }
  review = { id: 'c0', verdict: 'contradictory', reason: '提案结果直接违反作者明确的限制。', issueType: 'causal-gap', evidenceIds: ['a0', 'p0-possibleResult'], needs: [] }
  const result = await suggestPreparationExplanation(p, { id: 'c0', ...wording })
  assert.deepEqual(result.issues, [review.reason])
  assert.deepEqual(result.expansionNeeds, [])
  review = { ...review, verdict: 'expandable', issueType: 'none', evidenceIds: [], needs: [{ kind: 'setup', evidenceIds: ['a0'] }] }
  await assert.rejects(() => suggestPreparationExplanation(p, { id: 'c0', ...wording }), code('QWEN_OUTPUT_SCHEMA_FAILED'))
})
