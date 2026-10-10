import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// HTTP contract acceptance only. No real-model or Shen Qiao content-quality claim.
const backendRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const artifactDirectory = mkdtempSync(join(tmpdir(), 'story-clarification-e2e-'))
const storePath = join(artifactDirectory, 'sessions.json')
// Bundle the actual browser API parser using the frontend's installed build dependency.
const { build } = createRequire(new URL('../../frontend/package.json', import.meta.url))('esbuild')
const frontendApiPath = join(artifactDirectory, 'frontend-story-api.mjs')
await build({ entryPoints: [resolve(backendRoot, '../frontend/src/story/storyApi.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: frontendApiPath })
const frontendApi = await import(pathToFileURL(frontendApiPath).href)
const brief = { tones: ['growth'], dramaticForces: ['contrast'], allowSystemNamedCharacters: false }
const rawAnswer = '  青柠只能在下午去游乐园。\n'
const rawUnknown = '  作者目前尚未确定。\n'
const replacements = {
  'beat-trigger': '暂定：青柠去游乐园前重新判断是否出发，去游乐园的原安排暂时停住。',
  'beat-escalation': '暂定：青柠去游乐园的安排停住后，重新考虑是否继续去游乐园。',
  'beat-midpoint-turn': '暂定：青柠去游乐园的决定需要重新理解，原办法无法照旧推进。',
  'beat-climax-choice': '暂定：青柠主动决定是否继续去游乐园，并承担去游乐园的选择。',
  'beat-resolution': '暂定：青柠对去游乐园的决定有了重新理解，开始承担自己的选择。',
}
let rejectReview = false
let modelCalls = []
const modelServer = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const prompt = body.messages.find((message) => message.role === 'user').content
    const system = body.messages.find((message) => message.role === 'system').content
    modelCalls.push({ model: body.model, prompt })
    const payload = system.includes('开场事实选择器')
      ? { openingPlan: { anchorIds: ['opening-anchor-1', 'opening-anchor-2', 'opening-anchor-3'] } }
      : prompt.startsWith('{')
      ? { grounded: !rejectReview, dependsOnUnconfirmedPremise: rejectReview }
      : { detail: replacements[JSON.parse(prompt.match(/只重写目标节点：(\{[^\n]+\})/)[1]).id] }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }))
  } catch {
    response.writeHead(500)
    response.end('contract fixture mismatch')
  }
})
await new Promise((resolveListen) => modelServer.listen(0, '127.0.0.1', resolveListen))
const modelPort = modelServer.address().port
let child
let baseUrl
let launchCount = 0

async function stopBackend() {
  if (!child || child.exitCode !== null) return
  const running = child
  await new Promise((resolveExit) => { running.once('exit', resolveExit); running.kill() })
  child = undefined
}
async function startBackend(disabled) {
  const probe = createServer()
  await new Promise((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen))
  const port = probe.address().port
  await new Promise((resolveClose) => probe.close(resolveClose))
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['dist/server.js'], { cwd: backendRoot, windowsHide: true,
    env: { ...process.env, PORT: String(port), STORY_SESSION_STORE_PATH: storePath,
      STORY_DISABLE_MODEL: String(disabled), QWEN_MODEL: 'qwen-plus', DASHSCOPE_API_KEY: 'contract-fixture-key',
      DASHSCOPE_BASE_URL: `http://127.0.0.1:${modelPort}`, STORY_QWEN_REQUEST_ATTEMPTS: '0' } })
  const logs = createWriteStream(join(artifactDirectory, `backend-${++launchCount}.log`))
  child.stdout.pipe(logs, { end: false })
  child.stderr.pipe(logs, { end: false })
  child.once('exit', () => logs.end())
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Contract backend exited: ${child.exitCode}`)
    try { if ((await fetch(`${baseUrl}/health`)).ok) return } catch { /* wait for this child */ }
    await delay(100)
  }
  throw new Error('Contract backend did not start')
}
async function api(path, body, expectedCode, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const payload = await response.json()
  if (expectedCode) {
    assert.equal(payload.error?.code, expectedCode, JSON.stringify(payload))
    assert.equal(response.status, expectedStatus)
  } else assert.equal(response.status, 200, JSON.stringify(payload))
  return payload
}
function ref(result) { return { storyId: result.storyId, revision: result.revision, curveId: result.curve.id } }
async function snapshot(id) { return api(`/api/story/session/${id}`) }
async function throughFrontend(operation) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => originalFetch(typeof input === 'string' && input.startsWith('/') ? `${baseUrl}${input}` : input, init)
  try { return await operation() } finally { globalThis.fetch = originalFetch }
}
async function questionSession() {
  const started = await api('/api/story/co-create/start', { idea: '青柠去游乐园', brief })
  assert.equal(started.curve.generation.origin, 'fact-preserving-fallback')
  const beat = started.curve.beats.find((item) => item.id === 'beat-trigger')
  const result = await api('/api/story/curve/clarification', { ...ref(started), action: 'create',
    targetBeatId: beat.id, causalGap: beat.detail, prompt: '这个条件是否已经确定？' })
  return { result, id: result.curve.clarifications[0].id }
}

try {
  await startBackend(true)
  const localServerUrl = baseUrl
  let { result, id } = await questionSession()
  const unanswered = await snapshot(result.storyId)
  assert.equal(unanswered.curve.clarifications[0].status, 'unanswered')
  await api('/api/story/curve/beat/regenerate', { ...ref(result), beatId: 'beat-trigger' }, 'STORY_CLARIFICATION_REVIEW_REQUIRED', 409)
  await api('/api/story/curve/start-spine', ref(result), 'STORY_CURVE_NOT_CONFIRMED', 409)
  await api('/api/story/curve/confirm', ref(result), 'STORY_CURVE_CLARIFICATIONS_UNRESOLVED', 400)
  assert.deepEqual(await snapshot(result.storyId), unanswered)
  result = await api('/api/story/curve/clarification', { ...ref(result), action: 'declare-unknown', clarificationId: id, answerText: rawUnknown })
  assert.equal(result.curve.clarifications[0].answerText, rawUnknown)
  assert.equal(result.curve.clarifications[0].status, 'author-unknown')
  result = await api('/api/story/curve/clarification', { ...ref(result), action: 'request-independent-proposal', clarificationId: id })
  const independent = result
  const savedQuestion = await questionSession()
  let answer = await api('/api/story/curve/clarification', { ...ref(savedQuestion.result), action: 'save-answer', clarificationId: savedQuestion.id, answerText: rawAnswer })
  assert.equal(answer.curve.design.sourceFacts.some((fact) => fact.text === rawAnswer), false)
  const beforeConfirm = await snapshot(answer.storyId)
  answer = await api('/api/story/curve/clarification', { ...ref(answer), action: 'confirm-answer', clarificationId: savedQuestion.id })
  assert.equal(answer.curve.design.sourceFacts.at(-1).text, rawAnswer)
  assert.equal(answer.curve.design.sourceFacts.at(-1).source, 'author-supplement')
  assert.equal(answer.curve.foundation, undefined)
  assert.deepEqual(answer.curve.beats.find((beat) => beat.id === 'beat-character-tension'), beforeConfirm.curve.beats.find((beat) => beat.id === 'beat-character-tension'))
  await api('/api/story/curve/clarification', { ...ref(savedQuestion.result), action: 'save-answer', clarificationId: savedQuestion.id, answerText: rawAnswer }, 'STORY_SESSION_CONFLICT', 409)

  // Create this local fixture before switching to the controlled model stub.
  // It is independent of the retained Shen Qiao sample and its unknown facts.
  const historyDraft = await api('/api/story/co-create/start', {
    idea: '项目交接前，周岚在共享文件夹里发现一份未发送的报告。她答应不再干预原团队，却想在交接前决定是否提交。', brief,
  })
  const historyEdit = await api('/api/story/curve/beat', { ...ref(historyDraft), beatId: 'beat-resolution',
    detail: `${historyDraft.curve.beats.find((beat) => beat.id === 'beat-resolution').detail} 作者保留此处决定。` })
  const historyConfirmed = await api('/api/story/curve/confirm', ref(historyEdit))

  // Existing curve contract, with an explicitly local fixture and isolated storage.
  // The first-turn disabled renderer is a separate existing defect; below we
  // exercise started-history preservation with a controlled openingPlan stub.
  await new Promise((resolveExit, reject) => {
    const existing = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/accept-co-creation.ps1', '-BaseUrl', localServerUrl, '-KeepCreatedSession'], { cwd: backendRoot, windowsHide: true })
    existing.stdout.pipe(process.stdout)
    existing.stderr.pipe(process.stderr)
    existing.once('error', reject)
    existing.once('exit', (code) => code === 0 ? resolveExit() : reject(new Error(`Existing contract exit ${code}`)))
  })
  await stopBackend()
  await startBackend(false)
  const historySpine = await api('/api/story/curve/start-spine', ref(historyConfirmed))
  const historyBefore = await snapshot(historySpine.storyId)
  const historyQuestion = { ...ref(historyConfirmed), revision: historySpine.revision, action: 'create',
    targetBeatId: 'beat-trigger', causalGap: historyBefore.curve.beats.find((beat) => beat.id === 'beat-trigger').detail,
    prompt: '这个节点的因果前提是否成立？' }
  await api('/api/story/curve/clarification', historyQuestion, 'STORY_VERSION_PRESERVATION_REQUIRED', 409)
  assert.deepEqual(await snapshot(historySpine.storyId), historyBefore)
  const historyVersion = await api('/api/story/curve/clarification', { ...historyQuestion, versionMode: 'new-version' })
  const historyNew = await throughFrontend(() => frontendApi.requestStorySession(historyVersion.storyId))
  assert.equal(historyNew.currentTurn, undefined)
  assert.equal(historyNew.curve.beats.find((beat) => beat.id === 'beat-resolution').source, 'user-edit')
  assert.equal(historyNew.curve.beats.find((beat) => beat.id === 'beat-resolution').detail,
    historyEdit.curve.beats.find((beat) => beat.id === 'beat-resolution').detail)
  const previousVersion = historyVersion.curveVersions.find((version) => version.id === historyBefore.activeCurveVersionId)
  assert.deepEqual(previousVersion.confirmedCurve, historyBefore.confirmedCurve)
  assert.deepEqual(previousVersion.path.currentTurn, historyBefore.currentTurn)
  const restoredHistory = await api('/api/story/curve/version/select', {
    storyId: historyVersion.storyId, revision: historyVersion.revision, versionId: previousVersion.id,
  })
  const historyReturned = await throughFrontend(() => frontendApi.requestStorySession(historyVersion.storyId))
  assert.deepEqual(historyReturned.confirmedCurve, historyBefore.confirmedCurve)
  assert.deepEqual(historyReturned.currentTurn, historyBefore.currentTurn)
  assert.deepEqual(historyReturned.history, historyBefore.history)
  assert.equal(historyReturned.revision, restoredHistory.revision)
  assert.equal(historyReturned.revision, historyVersion.revision + 1)
  assert.equal((await snapshot(independent.storyId)).revision, independent.revision)
  assert.equal((await snapshot(answer.storyId)).curve.design.sourceFacts.at(-1).text, rawAnswer)
  const browserAnswer = await throughFrontend(() => frontendApi.requestStorySession(answer.storyId))
  assert.equal(browserAnswer.curve.clarifications[0].answerText, rawAnswer)
  assert.equal(browserAnswer.curve.design.sourceFacts.at(-1).text, rawAnswer)
  assert.equal(browserAnswer.curve.design.sourceFacts.at(-1).source, 'author-supplement')
  const beforePreview = await snapshot(independent.storyId)
  rejectReview = true
  await api('/api/story/curve/beat/regenerate', { ...ref(independent), beatId: 'beat-trigger' }, 'STORY_CLARIFICATION_REPLACEMENT_UNGROUNDED', 502)
  assert.deepEqual(await snapshot(independent.storyId), beforePreview)
  rejectReview = false
  const preview = await api('/api/story/curve/beat/regenerate', { ...ref(independent), beatId: 'beat-trigger' })
  assert.deepEqual(preview.curve, beforePreview.curve)
  assert.equal(preview.curve.clarifications[0].resolution, undefined)
  assert.equal((await snapshot(preview.storyId)).pendingCurveRegeneration.id, preview.pendingCurveRegeneration.id)
  const browserPreview = await throughFrontend(() => frontendApi.requestStorySession(preview.storyId))
  assert.equal(browserPreview.pendingCurveRegeneration.generation.origin, 'fact-preserving-fallback')
  await api('/api/story/curve/confirm', ref(preview), 'STORY_CURVE_CLARIFICATIONS_UNRESOLVED', 400)
  const accepted = await api('/api/story/curve/regenerate-affected/resolve', { ...ref(preview), previewId: preview.pendingCurveRegeneration.id,
    decisions: { [preview.pendingCurveRegeneration.items[0].id]: 'accept' } })
  assert.equal(accepted.curve.clarifications[0].resolution, 'independent-proposal-accepted')
  assert.equal(accepted.curve.generation.origin, 'fact-preserving-fallback')
  const batch = await api('/api/story/curve/regenerate-affected', ref(accepted))
  const reviewed = await api('/api/story/curve/regenerate-affected/resolve', { ...ref(batch), previewId: batch.pendingCurveRegeneration.id,
    decisions: Object.fromEntries(batch.pendingCurveRegeneration.items.map((item) => [item.id, 'accept'])) })
  rejectReview = true
  const beforeCurveConfirm = await snapshot(reviewed.storyId)
  await api('/api/story/curve/confirm', ref(reviewed), 'STORY_CLARIFICATION_REPLACEMENT_UNGROUNDED', 502)
  assert.deepEqual(await snapshot(reviewed.storyId), beforeCurveConfirm)
  rejectReview = false
  const confirmed = await api('/api/story/curve/confirm', ref(reviewed))
  assert.equal(confirmed.confirmedCurve.clarifications[0].status, 'author-unknown')
  assert.equal(confirmed.confirmedCurve.design.sourceFacts.some((fact) => fact.text === rawUnknown), false)
  assert.equal((await snapshot(confirmed.storyId)).revision, confirmed.revision)
  const browserConfirmed = await throughFrontend(() => frontendApi.requestStorySession(confirmed.storyId))
  assert.equal(browserConfirmed.confirmedCurve.clarifications[0].resolution, 'independent-proposal-accepted')
  assert.equal(browserConfirmed.confirmedCurve.clarifications[0].answerText, rawUnknown)

  // Applying a reviewed proposal after an answer is confirmed has its own contract status.
  const answerPreview = await api('/api/story/curve/beat/regenerate', { ...ref(answer), beatId: 'beat-trigger' })
  answer = await throughFrontend(() => frontendApi.requestCurveRegenerationResolution({ ...ref(answerPreview),
    previewId: answerPreview.pendingCurveRegeneration.id,
    decisions: { [answerPreview.pendingCurveRegeneration.items[0].id]: 'accept' } }))
  assert.equal(answer.curve.clarifications[0].resolution, 'answer-applied')

  const failureFixture = await api('/api/story/curve/clarification', { ...ref(answer), action: 'create', targetBeatId: 'beat-trigger',
    causalGap: answer.curve.beats.find((beat) => beat.id === 'beat-trigger').detail, prompt: '另一项待核对条件是什么？' })
  const failureQuestionId = failureFixture.curve.clarifications.at(-1).id
  const saved = await api('/api/story/curve/clarification', { ...ref(failureFixture), action: 'save-answer', clarificationId: failureQuestionId, answerText: '  青柠现在尚未出发。\n' })
  const memoryBeforeFailure = await snapshot(saved.storyId)
  const diskBeforeFailure = readFileSync(storePath, 'utf8')
  mkdirSync(`${storePath}.tmp`)
  await api('/api/story/curve/clarification', { ...ref(saved), action: 'confirm-answer', clarificationId: failureQuestionId }, 'STORY_SESSION_PERSIST_FAILED', 503)
  assert.deepEqual(await snapshot(saved.storyId), memoryBeforeFailure)
  assert.equal(readFileSync(storePath, 'utf8'), diskBeforeFailure)
  await stopBackend()
  await startBackend(false)
  assert.deepEqual(await snapshot(saved.storyId), memoryBeforeFailure)
  assert.ok(modelCalls.length > 0)
  console.log(`PASS: clarification HTTP contract; local model stub calls=${modelCalls.length}; isolated artifacts=${artifactDirectory}`)
} finally {
  await stopBackend()
  await new Promise((resolveClose) => modelServer.close(resolveClose))
}
