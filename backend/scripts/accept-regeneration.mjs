import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createWriteStream, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// Isolated HTTP contracts with disabled model / local model stub, not real quality acceptance.
const backend = resolve(fileURLToPath(new URL('..', import.meta.url)))
const artifacts = mkdtempSync(join(tmpdir(), 'story-regeneration-e2e-'))
const store = join(artifacts, 'sessions.json')
const idea = '青柠要在周五毕业展前把祖母留下的投影仪送到学校；好友阿岚答应帮忙但要求不要署名；归还期限是周六；途中发现设备缺少电源线；青柠必须决定是否拆掉自己的展板供电；可能失去署名机会。'
const edit = '暂定：青柠面对设备缺少电源线的阻碍，必须决定是否拆掉自己的展板供电。'
const brief = { tones: ['growth'], dramaticForces: ['cost'], allowSystemNamedCharacters: false }
let invalid = false, requestCount = 0, child, base, launch = 0
const stub = createServer(async (request, response) => {
  try {
    const parts = []
    for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    assert.equal(body.model, 'qwen-plus')
    assert.match(body.messages[0].content, /节点事实选择器/u)
    const contract = JSON.parse(body.messages[1].content)
    requestCount++
    const payload = invalid ? { beatPlan: { authorAnchorId: 'invalid', constraintFactId: 'invalid' } }
      : { beatPlan: { authorAnchorId: contract.allowedAuthorAnchorIds[0], constraintFactId: contract.allowedConstraintFactIds[0] } }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }))
  } catch (error) { response.writeHead(500); response.end(String(error)) }
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))
async function stop() {
  if (child?.exitCode === null) {
    const running = child
    await new Promise((r) => { running.once('exit', r); running.kill() })
  }
}
async function start(disabled) {
  await stop()
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port
  await new Promise((r) => probe.close(r))
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['dist/server.js'], { cwd: backend, windowsHide: true,
    env: { ...process.env, PORT: String(port), STORY_DISABLE_MODEL: String(disabled), STORY_SESSION_STORE_PATH: store,
      DASHSCOPE_API_KEY: 'contract-stub-key', DASHSCOPE_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
      QWEN_MODEL: 'qwen-plus', STORY_QWEN_REQUEST_ATTEMPTS: '0' } })
  const log = createWriteStream(join(artifacts, `backend-${++launch}.log`))
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }); child.once('exit', () => log.end())
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`backend exited: ${child.exitCode}`)
    try { if ((await fetch(base + '/health')).ok) return } catch { /* own child only */ }
    await delay(100)
  }
  throw new Error('backend did not start')
}
async function api(path, body, status = 200, code) {
  const response = await fetch(base + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const payload = await response.json()
  assert.equal(response.status, status, JSON.stringify(payload))
  if (code) assert.equal(payload.error.code, code)
  return payload
}
const ref = (s) => ({ storyId: s.storyId, revision: s.revision, curveId: s.curve.id })
const snapshot = (id) => api(`/api/story/session/${id}`)
const decisions = (s) => ({ ...ref(s), previewId: s.pendingCurveRegeneration.id,
  decisions: Object.fromEntries(s.pendingCurveRegeneration.items.map((item) => [item.id, 'accept'])) })
try {
  await start(true)
  const started = await api('/api/story/co-create/start', { idea, brief })
  assert.equal(started.curve.generation.origin, 'fact-preserving-fallback')
  const edited = await api('/api/story/curve/beat', { ...ref(started), beatId: 'beat-trigger', detail: edit })
  assert.equal(requestCount, 0)
  const before = await snapshot(edited.storyId)
  await start(false)
  invalid = true
  await api('/api/story/curve/beat/regenerate', { ...ref(edited), beatId: 'beat-escalation' }, 502, 'STORY_CURVE_MODEL_VALIDATION_FAILED')
  assert.deepEqual(await snapshot(edited.storyId), before)
  invalid = false
  const single = await api('/api/story/curve/beat/regenerate', { ...ref(edited), beatId: 'beat-escalation' })
  assert.equal(single.revision, edited.revision + 1)
  assert.deepEqual(single.curve, edited.curve)
  assert.equal(single.pendingCurveRegeneration.items.length, 1)
  const pending = await snapshot(single.storyId)
  await api('/api/story/curve/start-spine', ref(single), 409, 'STORY_CURVE_NOT_CONFIRMED')
  await api('/api/story/curve/confirm', ref(single), 409, 'STORY_CURVE_REGENERATION_PENDING')
  assert.deepEqual(await snapshot(single.storyId), pending)
  await start(false)
  assert.deepEqual(await snapshot(single.storyId), pending)
  const accepted = await api('/api/story/curve/regenerate-affected/resolve', decisions(single))
  assert.equal(accepted.curve.beats.find((beat) => beat.id === 'beat-trigger').detail, edit)
  assert.equal(accepted.pendingCurveRegeneration, undefined)
  await api('/api/story/curve/beat/regenerate', { ...ref(accepted), beatId: 'beat-trigger' }, 400, 'STORY_CURVE_AUTHOR_NODE_REGENERATE_FORBIDDEN')
  const batch = await api('/api/story/curve/regenerate-affected', ref(accepted))
  assert.ok(batch.pendingCurveRegeneration.items.length >= 2)
  const choice = batch.pendingCurveRegeneration.items.find((item) => item.kind === 'climax-choice').newDetail
  assert.match(choice, /拆掉自己的展板供电还是不拆自己的展板/u)
  assert.match(choice, /是否由行动导致待确认/u)
  const reviewed = await api('/api/story/curve/regenerate-affected/resolve', decisions(batch))
  assert.equal(reviewed.curve.beats.some((beat) => beat.status === 'stale'), false)
  assert.equal(reviewed.curve.beats.find((beat) => beat.id === 'beat-trigger').detail, edit)
  const refreshed = await snapshot(reviewed.storyId)
  await start(false)
  assert.deepEqual(await snapshot(reviewed.storyId), refreshed)
  console.log(`Regeneration contracts passed (disabled model + local model stub; ${requestCount} stub calls). Artifacts: ${artifacts}`)
} finally {
  await stop()
  await new Promise((r) => stub.close(r))
}
