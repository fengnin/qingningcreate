import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createWriteStream, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// Disabled-model setup and local model stub. This checks HTTP/browser contracts,
// not real-model quality or author approval of the story.
const backend = resolve(fileURLToPath(new URL('..', import.meta.url)))
const artifacts = mkdtempSync(join(tmpdir(), 'story-opening-continuation-e2e-'))
const store = join(artifacts, 'sessions.json')
const { build } = createRequire(new URL('../../frontend/package.json', import.meta.url))('esbuild')
const browserBundle = join(artifacts, 'browser-story-api.mjs')
await build({ entryPoints: [resolve(backend, '../frontend/src/story/storyApi.ts')], bundle: true,
  format: 'esm', platform: 'node', outfile: browserBundle })
const browser = await import(pathToFileURL(browserBundle).href)
const idea = '青柠要在周五毕业展前把祖母留下的投影仪送到学校；好友阿岚答应帮忙但要求不要署名；归还期限是周六；途中发现设备缺少电源线；青柠必须决定是否拆掉自己的展板供电；可能失去署名机会。'
const brief = { tones: ['growth'], dramaticForces: ['cost'], allowSystemNamedCharacters: false }
let mode = 'valid', child, base, launch = 0
const calls = []
const stub = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(body.model, 'qwen-plus')
    const system = body.messages[0].content
    calls.push(system)
    let payload
    if (system.includes('开场事实选择器')) {
      payload = { openingPlan: { anchorIds: ['opening-anchor-1', 'opening-anchor-2', 'opening-anchor-3'] } }
    } else {
      assert.match(system, /共创提案编辑/u)
      const context = JSON.parse(body.messages[1].content)
      assert.ok(context.selectedFocus.length)
      const sourceFactIds = [context.sourceFacts[0].id]
      payload = { candidatePlan: { options: ['审阅拆展板供电的条件', '审阅保留展板的条件', '保留未知，核对缺少电源线的问题'].map((action, i) => ({
        label: ['拆展板待审', '保留展板待审', '核对条件'][i], action,
        proposedConsequence: '供电可行性及署名风险仍未确定，尚未执行。', sourceFactIds,
        causalClaims: [{ statement: '拆展板是否能供电仍未知。', sourceFactIds }], questions: ['拆展板是否能够供电？'],
      })) } }
      // Old executed-turn replies must be rejected, not silently adapted.
      if (mode === 'legacy-turn') payload = { turn: { options: [{ transition: { introducedFacts: [{ statement: '投影仪已通电。' }] } }] } }
      if (mode === 'fixed-effect') payload.candidatePlan.options[0].transition = { changedFacts: [{ factId: 'fact-user-3', statement: '归还期限已经取消。' }] }
      if (mode === 'missing-detail') payload = { needsAuthorDetail: ['生成器格式错误不能证明作者缺资料。'] }
    }
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
async function throughBrowser(operation) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => originalFetch(typeof input === 'string' && input.startsWith('/') ? base + input : input, init)
  try { return await operation() } finally { globalThis.fetch = originalFetch }
}
const ref = (s) => ({ storyId: s.storyId, revision: s.revision, curveId: s.curve.id })
const snapshot = (id) => throughBrowser(() => browser.requestStorySession(id))
const click = (s) => ({ storyId: s.storyId, revision: s.revision, mode: 'continue',
  turnId: s.currentTurn.id, optionId: s.currentTurn.options[0].id })
try {
  await start(true)
  const started = await api('/api/story/co-create/start', { idea, brief })
  assert.equal(started.curve.generation.origin, 'fact-preserving-fallback')
  const unconfirmed = await snapshot(started.storyId)
  await start(false)
  await api('/api/story-spine/turn', { storyId: started.storyId, revision: started.revision,
    mode: 'continue', turnId: 'turn-1', optionId: 'turn-1-option-1' }, 409, 'STORY_CURVE_NOT_CONFIRMED')
  assert.equal(calls.length, 0)
  assert.deepEqual(await snapshot(started.storyId), unconfirmed)
  await start(true)
  const confirmed = await api('/api/story/curve/confirm', ref(started))
  assert.equal(calls.length, 0, 'disabled draft setup must not contact the model stub')
  // Production openingPlan stub, independent of the disabled-opening renderer.
  await start(false)
  await api('/api/story/curve/start-spine', ref(confirmed))
  const before = await snapshot(started.storyId), disk = readFileSync(store, 'utf8')
  assert.equal(calls.length, 1)
  for (mode of ['fixed-effect', 'legacy-turn', 'missing-detail']) {
    await api('/api/story-spine/turn', click(before), 502, 'STORY_TURN_RETRY_EXHAUSTED')
    assert.deepEqual(await snapshot(before.storyId), before)
    assert.equal(readFileSync(store, 'utf8'), disk)
  }
  mode = 'valid'
  const after = await throughBrowser(() => browser.requestStoryTurn(click(before)))
  assert.equal(after.revision, before.revision + 1)
  assert.equal(after.turn.id, 'turn-2')
  assert.equal(after.history.length, 1)
  assert.equal(after.turn.presentation, 'candidate-actions')
  assert.ok(after.turn.options.every((option) => option.narrativeAction.mode === 'candidate' && !option.narrativeAction.effects.length && !option.transition.introducedFacts.length))
  assert.ok(!calls.some(prompt => prompt.includes('严格事实核对员')), 'model self-review does not certify proposal truth')
  const refreshed = await snapshot(before.storyId)
  assert.deepEqual(refreshed.currentTurn, after.turn)
  assert.equal(refreshed.revision, after.revision)
  const persisted = JSON.parse(readFileSync(store, 'utf8')).sessions.find((s) => s.id === before.storyId)
  assert.equal(persisted.state.facts.some((f) => f.id.startsWith('next-choice-')), false)
  await start(false)
  assert.deepEqual(await snapshot(before.storyId), refreshed, 'restart/reload must retain the same revision and turn')
  const callsBeforeOldClick = calls.length
  await api('/api/story-spine/turn', click(before), 409, 'STORY_SESSION_CONFLICT')
  assert.equal(calls.length, callsBeforeOldClick, 'returning to an old page must not execute a second model continuation')
  assert.deepEqual(await snapshot(before.storyId), refreshed)
  console.log(`Opening continuation contracts passed (disabled model + local stub; browser API parser, revision recovery and old-page rejection). Artifacts: ${artifacts}`)
} finally {
  await stop()
  await new Promise((r) => stub.close(r))
}
