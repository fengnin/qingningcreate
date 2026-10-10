import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// HTTP/browser contract fixture only: disabled draft + controlled qwen stub.
const backend = resolve(fileURLToPath(new URL('..', import.meta.url)))
const artifacts = mkdtempSync(join(tmpdir(), 'story-interaction-e2e-')), store = join(artifacts, 'sessions.json')
const { build } = createRequire(new URL('../../frontend/package.json', import.meta.url))('esbuild')
const bundle = join(artifacts, 'browser-api.mjs')
await build({ entryPoints: [resolve(backend, '../frontend/src/story/storyApi.ts')], bundle: true, format: 'esm', platform: 'node', outfile: bundle })
const browser = await import(pathToFileURL(bundle).href)
const idea = '青柠要在周五毕业展前把祖母留下的投影仪送到学校；好友阿岚答应帮忙但要求不要署名；归还期限是周六；途中发现设备缺少电源线；青柠必须决定是否拆掉自己的展板供电；可能失去署名机会。'
const brief = { tones: ['growth'], dramaticForces: ['cost'], allowSystemNamedCharacters: false }
let mode = 'valid', child, base, launch = 0
const calls = []
const plan = () => ({ candidatePlan: { basis: { latestResultFactId: null, unresolved: { kind: 'existing', text: '投影仪供电仍未解决。', sourceFactIds: ['author-1'] }, reason: '承接最新结果，继续审阅供电条件。', contradictions: [] }, options: ['青柠考虑拆掉自己的展板供电。', '青柠考虑保留自己的展板。', '青柠保留未知，先审阅行动条件。'].map((action, i) => ({
  label: ['拆展板候选', '保留展板候选', '保留未知'][i], action, proposedConsequence: '设备是否可用、署名风险与行动的关联仍待作者确认。',
  sourceFactIds: ['author-1'], causalClaims: [{ statement: '拆展板能否为投影仪供电尚未确定。', sourceFactIds: ['author-1'] }],
  questions: ['这项行动是否可行？'],
})) } })
const stub = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(body.model, 'qwen-plus')
    const system = body.messages[0].content; calls.push(system)
    let payload
    if (system.includes('开场事实选择器')) payload = { openingPlan: { anchorIds: ['opening-anchor-1', 'opening-anchor-2', 'opening-anchor-3'] } }
    else {
      assert.match(system, /共创提案编辑/u)
      payload = plan()
      payload.candidatePlan.basis.latestResultFactId = JSON.parse(body.messages[1].content).lastAuthorConfirmedResult?.factId ?? null
      if (mode === 'stale-result-basis') payload.candidatePlan.basis.latestResultFactId = 'author-1'
      if (mode === 'optional-as-fact') payload.candidatePlan.basis.unresolved.kind = 'optional-design'
      if (mode === 'unsafe-state') payload.candidatePlan.options[0].transition = { introducedFacts: [{ statement: '投影仪已经通电。' }] }
      if (mode === 'fake-review') payload.review = { supported: true }
      if (mode === 'unknown-id') payload.candidatePlan.options[0].sourceFactIds = ['unknown-id']
      if (mode === 'design-id') payload.candidatePlan.options[0].sourceFactIds = ['beat-trigger']
      if (mode === 'design-claim-id') payload.candidatePlan.options[0].causalClaims[0].sourceFactIds = ['beat-resolution']
      if (mode === 'single') payload.candidatePlan.options = payload.candidatePlan.options.slice(0, 1)
      if (mode.startsWith('author-review')) {
        payload.candidatePlan.options = mode === 'author-review-mixed' ? payload.candidatePlan.options : []
        payload.candidatePlan.authorReview = { summary: '供电条件尚未确定；请作者选择补充或保留未知。', questions: ['是否提供供电条件，或保持未知并改选独立行动？'] }
        if (mode === 'author-review-facts') payload.candidatePlan.authorReview.introducedFacts = ['设备已经通电。']
        if (mode === 'author-review-empty') payload.candidatePlan.authorReview.questions = []
      }
      if (mode === 'empty') payload.candidatePlan.options = []
      if (mode === 'closure' || mode === 'closure-with-action') {
        payload.candidatePlan.basis.unresolved = { kind: 'next-goal', text: '已无未解决事项，请作者选择收束或下一目标。', sourceFactIds: [] }
        if (mode === 'closure') payload.candidatePlan.options = []
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }))
  } catch (error) { response.writeHead(500); response.end(String(error)) }
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))
async function stop() {
  const ownedChild = child
  child = undefined
  if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) {
    await new Promise((r) => { ownedChild.once('exit', r); ownedChild.kill() })
  }
}
async function start(disabled) {
  await stop()
  const probe = createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port; await new Promise((r) => probe.close(r)); base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['dist/server.js'], { cwd: backend, windowsHide: true,
    env: { ...process.env, PORT: String(port), STORY_DISABLE_MODEL: String(disabled), STORY_SESSION_STORE_PATH: store,
      DASHSCOPE_API_KEY: 'contract-stub', DASHSCOPE_BASE_URL: `http://127.0.0.1:${stub.address().port}`, QWEN_MODEL: 'qwen-plus' } })
  const log = createWriteStream(join(artifacts, `backend-${++launch}.log`))
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }); child.once('exit', () => log.end())
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`own backend exited ${child.exitCode}`)
    try { if ((await fetch(base + '/health')).ok) return } catch { /* own child */ }
    await delay(100)
  }
  throw new Error('own backend unavailable')
}
async function api(path, body, status = 200, code) {
  const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const payload = await response.json(); assert.equal(response.status, status, JSON.stringify(payload))
  if (code) assert.equal(payload.error.code, code)
  return payload
}
async function throughBrowser(operation) {
  const original = globalThis.fetch
  globalThis.fetch = (input, init) => original(typeof input === 'string' && input.startsWith('/') ? base + input : input, init)
  try { return await operation() } finally { globalThis.fetch = original }
}
const snapshot = (id) => throughBrowser(() => browser.requestStorySession(id))
const ref = (s) => ({ storyId: s.storyId, revision: s.revision, curveId: s.curve.id })
const click = (s) => ({ storyId: s.storyId, revision: s.revision, mode: 'continue', turnId: s.currentTurn.id, optionId: s.currentTurn.options[0].id })
const disk = (id) => JSON.parse(readFileSync(store, 'utf8')).sessions.find((s) => s.id === id)
try {
  await start(true)
  const draft = await api('/api/story/co-create/start', { idea, brief })
  assert.equal(draft.curve.generation.origin, 'fact-preserving-fallback')
  const unconfirmed = await snapshot(draft.storyId)
  await start(false)
  await api('/api/story-spine/turn', { storyId: draft.storyId, revision: draft.revision, mode: 'continue', turnId: 'turn-1', optionId: 'turn-1-option-1' }, 409, 'STORY_CURVE_NOT_CONFIRMED')
  assert.equal(calls.length, 0); assert.deepEqual(await snapshot(draft.storyId), unconfirmed)
  await start(true)
  const confirmed = await api('/api/story/curve/confirm', ref(draft))
  await start(false)
  await api('/api/story/curve/start-spine', ref(confirmed))
  const before = await snapshot(draft.storyId), stateBefore = disk(draft.storyId).state, fileBefore = readFileSync(store, 'utf8')
  assert.equal(before.currentTurn.presentation, 'focus-selection')
  for (mode of ['unsafe-state', 'fake-review', 'unknown-id', 'design-id', 'design-claim-id', 'empty', 'stale-result-basis', 'optional-as-fact', 'author-review-mixed', 'author-review-facts', 'author-review-empty']) {
    await api('/api/story-spine/turn', click(before), 502, 'STORY_TURN_RETRY_EXHAUSTED')
    assert.deepEqual(await snapshot(before.storyId), before); assert.equal(readFileSync(store, 'utf8'), fileBefore)
  }
  mode = 'valid'
  const after = await throughBrowser(() => browser.requestStoryTurn(click(before)))
  assert.equal(after.turn.presentation, 'candidate-actions')
  assert.ok(after.turn.options.every((o) => o.narrativeAction.mode === 'candidate' && !o.transition.introducedFacts.length && o.proposal.status === 'needs-review'))
  assert.deepEqual(disk(before.storyId).state.facts, stateBefore.facts)
  assert.deepEqual(disk(before.storyId).state.actions, stateBefore.actions)
  const refreshed = await snapshot(before.storyId)
  await start(false); assert.deepEqual(await snapshot(before.storyId), refreshed)
  const count = calls.length
  await api('/api/story-spine/turn', click(before), 409, 'STORY_SESSION_CONFLICT'); assert.equal(calls.length, count)
  const review = await throughBrowser(() => browser.requestStoryTurn(click(refreshed)))
  assert.equal(review.history.length, after.history.length); assert.equal(review.turn.id, after.turn.id)
  assert.ok(review.pendingActionProposal.requiresExecutedResultConfirmation)
  const proposal = review.pendingActionProposal, receipt = { storyId: before.storyId, revision: review.revision, proposalId: proposal.id, mode: 'continue' }
  await api('/api/story/action-proposal/confirm', receipt, 409, 'STORY_EXECUTED_RESULT_CONFIRMATION_REQUIRED')
  const pending = await snapshot(before.storyId)
  await start(false); assert.deepEqual(await snapshot(before.storyId), pending)
  mode = 'single'
  const confirmedResult = await throughBrowser(() => browser.requestStoryActionProposalConfirmation({ ...receipt,
    authorConfirmation: { actionText: proposal.action, resultText: '合同作者确认：只审阅了条件，设备仍未通电。' } }))
  assert.equal(confirmedResult.history.at(-1).selectedOption.narrativeAction.mode, 'executed')
  assert.equal(confirmedResult.history.at(-1).selectedOption.transition.authorConfirmation.resultText, '合同作者确认：只审阅了条件，设备仍未通电。')
  assert.equal(confirmedResult.turn.options.length, 1)
  assert.equal(confirmedResult.turn.node.event, '作者最近明确提交的结果：合同作者确认：只审阅了条件，设备仍未通电。')
  const newFacts = disk(before.storyId).state.facts.filter((f) => !stateBefore.facts.some((old) => old.id === f.id))
  assert.deepEqual(newFacts.map((f) => f.statement), ['合同作者确认：只审阅了条件，设备仍未通电。'])
  const final = await snapshot(before.storyId); await start(false); assert.deepEqual(await snapshot(before.storyId), final)
  const closureReview = await api('/api/story-spine/turn', click(final))
  const closureReceipt = { storyId: final.storyId, revision: closureReview.revision,
    proposalId: closureReview.pendingActionProposal.id, mode: 'continue',
    authorConfirmation: { actionText: closureReview.pendingActionProposal.action, resultText: '合同作者确认：供电事项已经完成，没有其余待办。' } }
  mode = 'closure-with-action'
  const beforeInvalidClosure = await snapshot(final.storyId), diskBeforeInvalidClosure = readFileSync(store, 'utf8')
  await api('/api/story/action-proposal/confirm', closureReceipt, 502, 'STORY_TURN_RETRY_EXHAUSTED')
  assert.deepEqual(await snapshot(final.storyId), beforeInvalidClosure)
  assert.equal(readFileSync(store, 'utf8'), diskBeforeInvalidClosure)
  mode = 'closure'
  const closure = await throughBrowser(() => browser.requestStoryActionProposalConfirmation(closureReceipt))
  assert.equal(closure.turn.presentation, 'closure-review')
  assert.deepEqual(closure.turn.options, [])
  assert.equal(closure.turn.transition, null)
  assert.equal(closure.turn.canConclude, true)
  const closureSnapshot = await snapshot(final.storyId), closureState = disk(final.storyId).state
  await start(false); assert.deepEqual(await snapshot(final.storyId), closureSnapshot)
  const callsBeforeClose = calls.length
  const concluded = await throughBrowser(() => browser.requestStoryTurn({ storyId: final.storyId,
    revision: closure.revision, turnId: closure.turn.id, mode: 'conclude' }))
  assert.equal(concluded.turn.isConclusion, true)
  assert.deepEqual(concluded.history, closure.history)
  assert.deepEqual(disk(final.storyId).state, closureState)
  assert.equal(calls.length, callsBeforeClose)
  const concludedSnapshot = await snapshot(final.storyId)
  await start(false); assert.deepEqual(await snapshot(final.storyId), concludedSnapshot)
  // Separate historical shape fixture. Preserve the saved historical version;
  // remove only new contract fields in the isolated fixture, never production.
  await stop()
  const savedStore = JSON.parse(readFileSync(store, 'utf8')), legacy = structuredClone(savedStore.sessions.find((s) => s.id === before.storyId))
  legacy.id = 'historical-opening-fixture'; legacy.revision = 2; legacy.history = []
  legacy.currentTurn = structuredClone(before.currentTurn); delete legacy.currentTurn.presentation
  for (const o of legacy.currentTurn.options) { delete o.narrativeAction.mode; delete o.narrativeAction.focusSourceTexts }
  legacy.state = structuredClone(stateBefore); delete legacy.pendingActionProposal
  savedStore.sessions.push(legacy); writeFileSync(store, JSON.stringify(savedStore))
  await start(false)
  const historical = await snapshot(legacy.id), historicalBefore = disk(legacy.id).state
  mode = 'valid'
  const compatible = await throughBrowser(() => browser.requestStoryTurn(click(historical)))
  assert.equal(compatible.turn.presentation, 'candidate-actions')
  assert.equal(compatible.history[0].selectedOption.narrativeAction.mode, 'focus')
  assert.deepEqual(disk(legacy.id).state.facts, historicalBefore.facts)
  assert.deepEqual(disk(legacy.id).state.actions, historicalBefore.actions)
  // Dedicated author-review branch from the same frozen opening: asking the
  // author cannot create an execution proposal, fact, or executed history.
  await stop()
  const reviewStore = JSON.parse(readFileSync(store, 'utf8')), authorFixture = structuredClone(legacy)
  authorFixture.id = 'author-review-fixture'
  reviewStore.sessions.push(authorFixture); writeFileSync(store, JSON.stringify(reviewStore))
  await start(false)
  mode = 'author-review'
  const authorStart = await snapshot(authorFixture.id)
  const authorTurn = await throughBrowser(() => browser.requestStoryTurn(click(authorStart)))
  assert.equal(authorTurn.turn.presentation, 'author-review')
  assert.deepEqual(authorTurn.turn.options, [])
  assert.equal(authorTurn.turn.narrativeAction, null)
  assert.equal(authorTurn.turn.transition, null)
  assert.equal(authorTurn.pendingActionProposal, undefined)
  assert.deepEqual(disk(authorFixture.id).state, { ...historicalBefore, focus: {
    actionId: authorTurn.history[0].selectedOption.narrativeAction.id,
    sourceTexts: authorTurn.history[0].selectedOption.narrativeAction.focusSourceTexts,
  } })
  assert.ok(authorTurn.history.every(h => h.selectedOption.narrativeAction.mode === 'focus'))
  const authorSnapshot = await snapshot(authorFixture.id), authorDisk = readFileSync(store, 'utf8'), authorCalls = calls.length
  for (const [path, body] of [
    ['/api/story-spine/turn', { storyId: authorFixture.id, revision: authorSnapshot.revision, turnId: authorTurn.turn.id, mode: 'continue', optionId: 'fake' }],
    ['/api/story/action-proposal', { storyId: authorFixture.id, revision: authorSnapshot.revision, turnId: authorTurn.turn.id, action: '青柠检查已有展板。' }],
    ['/api/story/action-proposal/confirm', { storyId: authorFixture.id, revision: authorSnapshot.revision, proposalId: 'fake', mode: 'continue', authorConfirmation: { actionText: '作者回答问题。', resultText: '回答已提交。' } }],
  ]) await api(path, body, 409, 'STORY_AUTHOR_REVIEW_REQUIRED')
  assert.deepEqual(await snapshot(authorFixture.id), authorSnapshot)
  assert.equal(readFileSync(store, 'utf8'), authorDisk)
  assert.equal(calls.length, authorCalls)
  await start(false); assert.deepEqual(await snapshot(authorFixture.id), authorSnapshot)
  // Explicit synthetic author choice: keep the missing condition unknown and
  // revise the design through the author channel. Preserve the old path.
  const adjusted = await api('/api/story/author-instruction', { storyId: authorFixture.id, revision: authorSnapshot.revision,
    targetBeatId: authorSnapshot.curve.beats[1].id, text: '供电条件保留未知；改为先审阅是否保留展板，不确认设备可用。' })
  const adjustedSnapshot = await snapshot(authorFixture.id)
  assert.equal(adjustedSnapshot.confirmedCurve, undefined)
  assert.equal(adjustedSnapshot.currentTurn, undefined)
  assert.ok(adjusted.curveVersions.some(v => v.path?.currentTurn?.presentation === 'author-review'))
  console.log(`Interaction HTTP/browser contract passed (disabled draft + model stub; historical shape replay, restart, stale-page revision). Artifacts: ${artifacts}`)
} finally { await stop(); stub.closeAllConnections(); await new Promise((r) => stub.close(r)) }
