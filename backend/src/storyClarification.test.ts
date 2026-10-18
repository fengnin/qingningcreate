import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { CreativeBrief, ProvisionalCurve, StoryCurveMutationResponse } from '../../shared/story-contract.js'
import { AppError } from './qwen.js'
import { createProvisionalCurveFallback, updateCurveBeat } from './storyCoCreation.js'
import {
  changeCurveClarification, confirmCurveClarification, getClarificationGroundingFacts,
  getClarificationsAffectingBeat, getUnresolvedClarifications, reviewClarificationReplacement,
} from './storyClarification.js'

// These are contract fixtures, not author answers for the retained Shen Qiao sample.
const idea = '青柠去游乐园'
const brief: CreativeBrief = { tones: ['growth'], dramaticForces: ['contrast'], allowSystemNamedCharacters: false }
const seed = { subject: '青柠', activeSituation: idea, lockedGoal: '去游乐园', lockedFacts: [idea],
  worldMode: 'realistic-default' as const, expansionScope: 'keep-scale' as const, unknowns: [] }
const previousFetch = globalThis.fetch
const environment = { STORY_SESSION_STORE_PATH: process.env.STORY_SESSION_STORE_PATH,
  STORY_DISABLE_MODEL: process.env.STORY_DISABLE_MODEL, DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
  DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL }
const storePath = join(mkdtempSync(join(tmpdir(), 'story-clarification-')), 'sessions.json')
process.env.STORY_SESSION_STORE_PATH = storePath
process.env.STORY_DISABLE_MODEL = 'true'
process.env.DASHSCOPE_API_KEY = 'contract-test-key'
process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
// The store must be isolated before the module captures its path.
const service = await import('./storyService.js')
test.after(() => {
  globalThis.fetch = previousFetch
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function curveFixture() { return createProvisionalCurveFallback(idea, seed, brief) }
function addQuestion(curve: ProvisionalCurve, beatId = 'beat-trigger') {
  const target = curve.beats.find((beat) => beat.id === beatId)!
  return changeCurveClarification(curve, { storyId: 'fixture', revision: 0, curveId: curve.id,
    action: 'create', targetBeatId: beatId, causalGap: target.detail, prompt: '这个节点的因果条件已确定吗？' }).curve
}
function transition(curve: ProvisionalCurve, action: Parameters<typeof changeCurveClarification>[1]['action'], answerText?: string) {
  return changeCurveClarification(curve, { storyId: 'fixture', revision: 0, curveId: curve.id,
    clarificationId: curve.clarifications![0]!.id, action, ...(answerText === undefined ? {} : { answerText }) }).curve
}
function hasCode(code: string, status?: number) {
  return (error: unknown) => error instanceof AppError && error.code === code && (status === undefined || error.statusCode === status)
}
function response(payload: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })
}
type ModelCall = { system: string; prompt: string }
const replacements: Record<string, string> = {
  'beat-trigger': '暂定：青柠去游乐园前重新判断是否出发，去游乐园的原安排暂时停住。',
  'beat-escalation': '暂定：青柠去游乐园的安排停住后，重新考虑是否继续去游乐园。',
  'beat-midpoint-turn': '暂定：青柠重新考虑去游乐园时，发现去游乐园的原办法不能继续。',
  'beat-climax-choice': '暂定：青柠重新考虑去游乐园之后，主动决定是否继续去游乐园。',
  'beat-resolution': '暂定：青柠重新考虑去游乐园之后，重新理解去游乐园的决定。',
}
async function mockModel<T>(operation: (calls: ModelCall[]) => Promise<T>, review: unknown = { grounded: true, dependsOnUnconfirmedPremise: false }) {
  const calls: ModelCall[] = []
  process.env.STORY_DISABLE_MODEL = 'false'
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
    const system = body.messages.find((message) => message.role === 'system')!.content
    const prompt = body.messages.find((message) => message.role === 'user')!.content
    calls.push({ system, prompt })
    if (system.includes('开场事实选择器')) {
      return response({ openingPlan: { anchorIds: ['opening-anchor-1', 'opening-anchor-2', 'opening-anchor-3'] } })
    }
    if (prompt.startsWith('{')) return response(review)
    const target = JSON.parse(prompt.match(/只重写目标节点：(\{[^\n]+\})/)![1]!) as { id: string }
    return response({ detail: replacements[target.id] ?? replacements['beat-trigger'] })
  }
  try { return await operation(calls) }
  finally { globalThis.fetch = previousFetch; process.env.STORY_DISABLE_MODEL = 'true' }
}
async function startQuestion() {
  process.env.STORY_DISABLE_MODEL = 'true'
  const started = await service.startStoryCoCreation({ idea, brief })
  const target = started.curve.beats.find((beat) => beat.id === 'beat-trigger')!
  const result = await service.updateSessionCurveClarification({ storyId: started.storyId, revision: started.revision,
    curveId: started.curve.id, action: 'create', targetBeatId: target.id, causalGap: target.detail, prompt: '这个前提是否已确定？' })
  return { result, questionId: result.curve.clarifications![0]!.id }
}
function reference(result: StoryCurveMutationResponse) {
  return { storyId: result.storyId, revision: result.revision, curveId: result.curve.id }
}
function snapshot(storyId: string) { return structuredClone(service.getStorySessionSnapshot(storyId)) }
function stored(storyId: string) {
  const data = JSON.parse(readFileSync(storePath, 'utf8')) as { sessions: { id: string }[] }
  return data.sessions.find((session) => session.id === storyId)
}

test('questions bind to a node gap; unrelated nodes remain editable; unknown is distinct from unanswered', () => {
  const original = curveFixture()
  assert.throws(() => changeCurveClarification(original, { storyId: 'fixture', revision: 0, curveId: original.id,
    action: 'create', targetBeatId: 'beat-trigger', causalGap: '不在节点中的原句', prompt: '问题' }), hasCode('STORY_CLARIFICATION_INVALID_GAP'))
  let curve = addQuestion(original)
  assert.equal(curve.clarifications![0]!.status, 'unanswered')
  assert.equal(getClarificationsAffectingBeat(curve, 'beat-character-tension').length, 0)
  assert.equal(getClarificationsAffectingBeat(curve, 'beat-escalation').length, 1)
  assert.equal(curve.beats.find((beat) => beat.id === 'beat-current-state')!.status, original.beats.find((beat) => beat.id === 'beat-current-state')!.status)
  curve = transition(curve, 'declare-unknown', '  我还未确定。\n')
  assert.equal(curve.clarifications![0]!.status, 'author-unknown')
  assert.equal(curve.clarifications![0]!.answerText, '  我还未确定。\n')
  assert.deepEqual(curve.design!.sourceFacts, original.design!.sourceFacts)
  assert.equal(transition(curve, 'request-independent-proposal').clarifications![0]!.unknownHandling, 'request-independent-proposal')
  const abandoned = transition(curve, 'abandon-dependent-proposal')
  assert.equal(abandoned.beats.find((beat) => beat.id === 'beat-trigger')!.status, 'rejected')
  assert.equal(abandoned.clarifications![0]!.resolution, 'proposal-abandoned')
})

test('saved answers stay out of the ledger until explicit confirmation; confirmed raw text invalidates only the dependent draft', () => {
  const raw = '  青柠只能在下午去游乐园。\n'
  const original = curveFixture()
  const edited = updateCurveBeat(original, 'beat-escalation', '作者编辑：青柠重新考虑去游乐园。').curve
  const question = addQuestion(edited)
  assert.throws(() => confirmCurveClarification(question, question.clarifications![0]!.id), hasCode('STORY_CLARIFICATION_NOT_REVIEWED'))
  const saved = transition(question, 'save-answer', raw)
  assert.equal(saved.clarifications![0]!.status, 'needs-review')
  assert.deepEqual(saved.design!.sourceFacts, question.design!.sourceFacts)
  const confirmed = confirmCurveClarification(saved, saved.clarifications![0]!.id).curve
  const fact = confirmed.design!.sourceFacts.at(-1)!
  assert.equal(fact.text, raw)
  assert.equal(fact.source, 'author-supplement')
  assert.equal(fact.clarificationId, confirmed.clarifications![0]!.id)
  assert.equal(confirmed.foundation, undefined)
  assert.equal(confirmed.design!.foundation, undefined)
  assert.deepEqual(confirmed.beats.find((beat) => beat.id === 'beat-character-tension'), original.beats.find((beat) => beat.id === 'beat-character-tension'))
  assert.equal(confirmed.beats.find((beat) => beat.id === 'beat-escalation')!.detail, edited.beats.find((beat) => beat.id === 'beat-escalation')!.detail)
  assert.equal(confirmed.beats.find((beat) => beat.id === 'beat-escalation')!.status, 'stale')
  assert.equal(getUnresolvedClarifications(confirmed).length, 1, 'confirming an answer does not accept an old proposal')
})

test('discarding one proposal resolves its own questions without inventing answers or resolving other node gaps', () => {
  let curve = addQuestion(curveFixture())
  curve = addQuestion(curve)
  curve = addQuestion(curve, 'beat-escalation')
  const abandoned = transition(transition(curve, 'declare-unknown'), 'abandon-dependent-proposal')
  assert.equal(abandoned.clarifications![0]!.resolution, 'proposal-abandoned')
  assert.equal(abandoned.clarifications![1]!.resolution, 'proposal-abandoned')
  assert.equal(abandoned.clarifications![1]!.status, 'unanswered')
  assert.equal(abandoned.clarifications![1]!.answerText, undefined)
  assert.equal(abandoned.clarifications![2]!.resolution, undefined)
  assert.equal(getUnresolvedClarifications(abandoned).length, 1)
  assert.deepEqual(abandoned.design!.sourceFacts, curve.design!.sourceFacts)
})

test('review rejects literal gaps, causal-anchor leakage, semantic paraphrases and malformed reviewer output', async () => {
  const curve = addQuestion(curveFixture())
  const question = curve.clarifications![0]!
  const target = curve.beats.find((beat) => beat.id === 'beat-trigger')!
  await assert.rejects(() => reviewClarificationReplacement(curve, question, target), hasCode('STORY_CLARIFICATION_REPLACEMENT_UNGROUNDED', 502))
  await assert.rejects(() => reviewClarificationReplacement(curve, question, { ...target, detail: idea, causalAnchor: question.dependency.causalGap }), hasCode('STORY_CLARIFICATION_REPLACEMENT_UNGROUNDED'))
  const candidate = { ...target, detail: '暂定：青柠重新选择去游乐园的办法。', causalAnchor: '去游乐园的决定' }
  await mockModel(async (calls) => {
    await assert.rejects(() => reviewClarificationReplacement(curve, question, candidate), hasCode('STORY_CLARIFICATION_REPLACEMENT_UNGROUNDED'))
    assert.equal(calls.length, 1, 'nonliteral dependence requires a semantic review')
  }, { grounded: true, dependsOnUnconfirmedPremise: true })
  await mockModel(async (calls) => {
    await assert.rejects(() => reviewClarificationReplacement(curve, question, candidate), hasCode('QWEN_OUTPUT_SCHEMA_FAILED'))
    assert.equal(calls.length, 2, 'malformed reviews get one format repair and no causal verdict')
  }, { grounded: true })
  await assert.rejects(() => reviewClarificationReplacement(curve, question, candidate), hasCode('STORY_CLARIFICATION_REVIEW_UNAVAILABLE', 503))
  const knownText = curve.design!.sourceFacts[0]!.text
  await reviewClarificationReplacement(curve, question, { ...target, detail: knownText, causalAnchor: knownText })
  const suspect = structuredClone(curve)
  suspect.design!.sourceFacts.push({ id: 'suspect', text: question.dependency.causalGap, source: 'user-input', disposition: 'integrated', coveredByBeatIds: [] })
  assert.equal(getClarificationGroundingFacts(suspect).some((fact) => fact.id === 'suspect'), false)
  await assert.rejects(() => reviewClarificationReplacement(suspect, question, { ...target, detail: idea, sourceFactIds: ['suspect'] }), hasCode('STORY_CLARIFICATION_REPLACEMENT_UNGROUNDED'))
})

test('dependent old proposal is blocked; independent preview is detached; only reviewed acceptance resolves the question', async () => {
  let { result, questionId } = await startQuestion()
  const initial = snapshot(result.storyId)
  await assert.rejects(() => service.regenerateSessionCurveBeat({ ...reference(result), beatId: 'beat-trigger' }), hasCode('STORY_CLARIFICATION_REVIEW_REQUIRED', 409))
  await assert.rejects(() => service.confirmSessionCurve(reference(result)), hasCode('STORY_CURVE_CLARIFICATIONS_UNRESOLVED'))
  assert.deepEqual(snapshot(result.storyId), initial)
  result = await service.updateSessionCurveBeat({ ...reference(result), beatId: 'beat-character-tension', detail: '作者编辑：青柠去游乐园的决定由自己承担。' })
  result = await service.updateSessionCurveClarification({ ...reference(result), action: 'declare-unknown', clarificationId: questionId })
  result = await service.updateSessionCurveClarification({ ...reference(result), action: 'request-independent-proposal', clarificationId: questionId })
  const before = snapshot(result.storyId)
  // Use a different fresh session without author edits as a model-generation fixture.
  const fresh = await startQuestion()
  let independent = await service.updateSessionCurveClarification({ ...reference(fresh.result), action: 'declare-unknown', clarificationId: fresh.questionId })
  independent = await service.updateSessionCurveClarification({ ...reference(independent), action: 'request-independent-proposal', clarificationId: fresh.questionId })
  const beforePreview = snapshot(independent.storyId)
  await mockModel(async () => {
    const preview = await service.regenerateSessionCurveBeat({ ...reference(independent), beatId: 'beat-trigger' })
    assert.deepEqual(preview.curve, beforePreview.curve)
    assert.equal(preview.curve.clarifications![0]!.resolution, undefined)
    assert.equal(snapshot(preview.storyId).pendingCurveRegeneration!.id, preview.pendingCurveRegeneration!.id)
    const item = preview.pendingCurveRegeneration!.items[0]!
    const accepted = await service.resolveSessionCurveDependencies({ ...reference(preview), previewId: preview.pendingCurveRegeneration!.id, decisions: { [item.id]: 'accept' } })
    assert.equal(accepted.curve.beats.find((beat) => beat.id === item.beatId)!.detail, item.newDetail)
    assert.equal(accepted.curve.clarifications![0]!.resolution, 'independent-proposal-accepted')
    assert.equal(accepted.curve.clarifications![0]!.status, 'author-unknown')
    assert.equal(accepted.curve.generation!.origin, 'fact-preserving-fallback', 'a fixture curve cannot become model success through acceptance')
    assert.equal(snapshot(accepted.storyId).revision, accepted.revision)
  })
  assert.deepEqual(snapshot(result.storyId), before, 'independent sessions do not change unrelated author edits')
})

test('rejecting a replacement keeps the old proposal blocked; batch preview does not overwrite author edits', async () => {
  const fresh = await startQuestion()
  let result = await service.updateSessionCurveClarification({ ...reference(fresh.result), action: 'declare-unknown', clarificationId: fresh.questionId })
  result = await service.updateSessionCurveClarification({ ...reference(result), action: 'request-independent-proposal', clarificationId: fresh.questionId })
  await mockModel(async () => {
    const preview = await service.regenerateSessionCurveBeat({ ...reference(result), beatId: 'beat-trigger' })
    const rejected = await service.resolveSessionCurveDependencies({ ...reference(preview), previewId: preview.pendingCurveRegeneration!.id,
      decisions: { [preview.pendingCurveRegeneration!.items[0]!.id]: 'reject' } })
    assert.equal(rejected.curve.clarifications![0]!.resolution, undefined)
    await assert.rejects(() => service.confirmSessionCurve(reference(rejected)), hasCode('STORY_CURVE_CLARIFICATIONS_UNRESOLVED'))
  })
  const edited = updateCurveBeat(curveFixture(), 'beat-escalation', '作者编辑：青柠重新考虑去游乐园。').curve
  const question = transition(transition(addQuestion(edited), 'declare-unknown'), 'request-independent-proposal')
  const { previewAffectedCurveBeats } = await import('./storyCoCreation.js')
  // Reviewer rejection must leave the original draft unchanged, including author-owned text.
  const before = structuredClone(question)
  await mockModel(async () => {
    await assert.rejects(() => previewAffectedCurveBeats(idea, seed, question), (error: unknown) => error instanceof AppError)
    assert.deepEqual(question, before)
  }, { grounded: false, dependsOnUnconfirmedPremise: true })
  await mockModel(async () => {
    const preview = await previewAffectedCurveBeats(idea, seed, question)
    assert.ok(preview.preview.items.some((item) => item.beatId === 'beat-trigger'))
    assert.ok(preview.preview.items.some((item) => item.beatId === 'beat-midpoint-turn'))
    assert.equal(preview.preview.items.some((item) => item.beatId === 'beat-escalation'), false)
    assert.deepEqual(question, before)
  })
})

test('confirmed supplements are rebuilt into generation input; unreviewed answer text is excluded', async () => {
  const raw = '  青柠只能在下午去游乐园。\n'
  let { result, questionId } = await startQuestion()
  const parsed = service.parseStoryAuthorClarificationRequest({ ...reference(result), action: 'save-answer', clarificationId: questionId, answerText: raw })
  assert.equal(parsed.answerText, raw)
  result = await service.updateSessionCurveClarification(parsed)
  assert.equal(result.curve.design!.sourceFacts.some((fact) => fact.text === raw), false)
  result = await service.updateSessionCurveClarification({ ...reference(result), action: 'confirm-answer', clarificationId: questionId })
  assert.equal(result.curve.design!.sourceFacts.at(-1)!.text, raw)
  await mockModel(async (calls) => {
    const preview = await service.regenerateSessionCurveBeat({ ...reference(result), beatId: 'beat-trigger' })
    const generation = calls.find((call) => !call.prompt.startsWith('{'))!
    assert.ok(generation.prompt.includes(JSON.stringify(raw)))
    assert.ok(generation.prompt.includes('"status":"confirmed"'))
    assert.equal(preview.curve.clarifications![0]!.resolution, undefined)
  })
})

test('explicit new-version preserves the confirmed curve, path and author edits; returning restores them', async () => {
  const positiveIdea = '项目交接前，周岚在共享文件夹里发现一份未发送的报告。她答应不再干预原团队，却想在交接前决定是否提交。'
  const started = await service.startStoryCoCreation({ idea: positiveIdea, brief })
  const authorDetail = `${started.curve.beats.find((beat) => beat.id === 'beat-resolution')!.detail} 作者保留此处决定。`
  const edited = await service.updateSessionCurveBeat({ storyId: started.storyId, revision: started.revision,
    curveId: started.curve.id, beatId: 'beat-resolution', detail: authorDetail })
  const confirmed = await service.confirmSessionCurve(reference(edited))
  // Use the existing closed opening contract to isolate history preservation
  // from the separately tracked disabled-model opening renderer defect.
  const spine = await mockModel(() => service.startSessionStorySpineFromCurve({
    storyId: started.storyId, revision: confirmed.revision, curveId: started.curve.id,
  }))
  const before = snapshot(started.storyId)
  const target = before.curve!.beats.find((beat) => beat.id === 'beat-trigger')!
  const request = { storyId: started.storyId, revision: spine.revision, curveId: started.curve.id,
    action: 'create' as const, targetBeatId: target.id, causalGap: target.detail, prompt: '这个因果前提是否成立？' }
  await assert.rejects(() => service.updateSessionCurveClarification(request), hasCode('STORY_VERSION_PRESERVATION_REQUIRED', 409))
  assert.deepEqual(snapshot(started.storyId), before)
  const next = await service.updateSessionCurveClarification({ ...request, versionMode: 'new-version' })
  assert.notEqual(next.curve.id, started.curve.id)
  assert.equal(snapshot(next.storyId).currentTurn, undefined)
  assert.equal(next.curve.beats.find((beat) => beat.id === 'beat-resolution')!.source, 'user-edit')
  assert.equal(next.curve.beats.find((beat) => beat.id === 'beat-resolution')!.detail, authorDetail)
  const old = next.curveVersions!.find((version) => version.id === before.activeCurveVersionId)!
  assert.deepEqual(old.confirmedCurve, before.confirmedCurve)
  assert.deepEqual(old.path!.currentTurn, before.currentTurn)
  assert.deepEqual(old.path!.history, before.history)
  const restored = await service.selectSessionCurveVersion({ storyId: next.storyId, revision: next.revision, versionId: old.id })
  assert.deepEqual(restored.confirmedCurve, before.confirmedCurve)
  assert.deepEqual(restored.currentTurn, before.currentTurn)
  assert.deepEqual(restored.history, before.history)
  assert.equal(restored.revision, next.revision + 1)
  assert.equal(snapshot(next.storyId).revision, restored.revision)
})

test('a concurrent clarification update makes an in-flight preview stale', async () => {
  let { result, questionId } = await startQuestion()
  result = await service.updateSessionCurveClarification({ ...reference(result), action: 'declare-unknown', clarificationId: questionId })
  result = await service.updateSessionCurveClarification({ ...reference(result), action: 'request-independent-proposal', clarificationId: questionId })
  let release!: (payload: Response) => void
  let entered!: () => void
  const reviewEntered = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<Response>((resolve) => { release = resolve })
  await mockModel(async () => {
    const ordinaryFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      if (String(init?.body).includes('dependsOnUnconfirmedPremise')) { entered(); return held }
      return ordinaryFetch(input, init)
    }
    const pending = service.regenerateSessionCurveBeat({ ...reference(result), beatId: 'beat-trigger' })
    const rejected = assert.rejects(pending, hasCode('STORY_SESSION_CONFLICT', 409))
    await reviewEntered
    const updated = await service.updateSessionCurveClarification({ ...reference(result), action: 'keep-unknown', clarificationId: questionId })
    release(response({ grounded: true, dependsOnUnconfirmedPremise: false }))
    await rejected
    assert.equal(snapshot(result.storyId).revision, updated.revision)
    assert.equal(snapshot(result.storyId).pendingCurveRegeneration, undefined)
  })
})

test('persistence failure does not confirm facts, change memory or increase revision', async () => {
  let { result, questionId } = await startQuestion()
  result = await service.updateSessionCurveClarification({ ...reference(result), action: 'save-answer', clarificationId: questionId,
    answerText: '  青柠只能在下午去游乐园。\n' })
  const before = snapshot(result.storyId)
  const persistedBefore = structuredClone(stored(result.storyId))
  // Keep this isolated failure fixture for inspection; never touch the user's session store.
  mkdirSync(`${storePath}.tmp`)
  await assert.rejects(() => service.updateSessionCurveClarification({ ...reference(result), action: 'confirm-answer', clarificationId: questionId }), hasCode('STORY_SESSION_PERSIST_FAILED', 503))
  assert.deepEqual(snapshot(result.storyId), before)
  assert.deepEqual(stored(result.storyId), persistedBefore)
  assert.equal(snapshot(result.storyId).curve!.clarifications![0]!.status, 'needs-review')
})
