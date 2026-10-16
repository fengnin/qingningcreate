import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(frontend, '..')
const backend = join(root, 'backend')
const artifact = join(root, 'local-evidence', `preparation-browser-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(artifact, { recursive: true })
const report = { artifact, checks: [], browserErrors: [], modelRequests: [], screenshots: [] }
const children = []
let browser
const check = (name, fn) => { fn(); report.checks.push(name); console.log(`PASS ${name}`) }
async function unusedPort() {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}
async function start(name, args, cwd, env, url) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, windowsHide: true })
  children.push(child)
  const log = createWriteStream(join(artifact, `${name}.log`))
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  child.once('exit', () => log.end())
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`${name} exited; inspect ${name}.log`)
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return } catch {}
    await delay(200)
  }
  throw new Error(`${name} did not start`)
}
async function clickButton(scope, label) {
  for (const button of await scope.$$('button')) {
    if ((await button.evaluate(el => el.textContent.trim())) === label) { await button.click(); return }
  }
  throw new Error(`Button not found: ${label}`)
}
async function fill(scope, selector, value) {
  const el = await scope.$(selector)
  assert.ok(el, `Missing ${selector}`)
  await el.click(); await el.evaluate(input => input.select()); await el.type(value)
}
async function screenshot(page, name, element) {
  const path = join(artifact, `${name}.png`)
  if (element) await element.screenshot({ path })
  else await page.screenshot({ path, fullPage: true })
  report.screenshots.push(path)
}

try {
  const store = JSON.parse(readFileSync(join(backend, 'data/story-sessions.json'), 'utf8'))
  const original = [...store.sessions].reverse().find(s => s.idea === '青柠想和朋友去游乐园玩，但朋友第一次去，害怕最刺激的项目。'
    && s.provisionalCurve?.preparation?.status === 'needs-review' && s.provisionalCurve.preparation.candidates.length === 3)
    ?? [...store.sessions].reverse().find(s => s.provisionalCurve?.preparation?.status === 'needs-review'
      && s.provisionalCurve.preparation.candidates.length === 3 && !s.provisionalCurve.preparation.candidates[0].unknownIds.length)
  assert.ok(original, 'A saved preparation session is needed for this browser check')
  const session = structuredClone(original)
  session.id = `story-browser-${randomUUID()}`
  const storePath = join(artifact, 'test-sessions.json')
  writeFileSync(storePath, JSON.stringify({ version: 1, sessions: [session] }))
  const backendPort = await unusedPort(), frontendPort = await unusedPort()
  const backendUrl = `http://127.0.0.1:${backendPort}`, frontendUrl = `http://127.0.0.1:${frontendPort}`
  await start('backend', ['dist/server.js'], backend, { PORT: String(backendPort), STORY_SESSION_STORE_PATH: storePath, STORY_DISABLE_MODEL: 'false' }, `${backendUrl}/health`)
  const health = await (await fetch(`${backendUrl}/health`)).json()
  assert.equal(health.configured, true, 'Real model configuration is required')
  await start('frontend', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], frontend,
    { VITE_STORY_API_TARGET: backendUrl }, frontendUrl)
  const require = createRequire(import.meta.url)
  const puppeteer = require(process.env.STORY_BROWSER_MODULE || 'puppeteer-core')
  browser = await puppeteer.launch({ executablePath: process.env.STORY_BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, userDataDir: join(artifact, 'browser-profile'), timeout: 45000, protocolTimeout: 150000,
    args: ['--no-first-run', '--no-default-browser-check'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  page.on('pageerror', error => report.browserErrors.push(error.message))
  page.on('request', req => {
    if (req.url().endsWith('/api/story/preparation/explanation') && req.method() === 'POST') report.modelRequests.push(JSON.parse(req.postData()))
  })
  await page.goto(`${frontendUrl}/?story=${session.id}`, { waitUntil: 'networkidle0', timeout: 45000 })
  await page.waitForSelector('.preparation-proposal', { timeout: 30000 })
  let card = await page.$('.preparation-proposal')
  const siblingText = await page.$$eval('.preparation-proposal', cards => cards.slice(1).map(c => c.innerText))
  const baselineBridge = session.provisionalCurve.preparation.candidates[0].causalBridge
  report.baseline = { idea: session.idea, candidate: session.provisionalCurve.preparation.candidates[0] }
  await screenshot(page, '01-before-edit', card)
  await clickButton(card, '编辑')
  check('Editor exposes four separate fields', () => {})
  assert.deepEqual(await card.$$eval('.preparation-editor > label', labels => labels.map(l => l.firstChild.textContent)), ['遇到的难处', '眼前的选择', '故事将推向', '可能走向'])
  const values = [
    '朋友因青柠以前失约而不愿再相信他，也害怕刺激项目。',
    '青柠认真谈起失约，承认责任，约定由朋友决定是否挑战项目；这次谈话的关键内容留到正文展开。',
    '青柠接下来怎样用行动守住约定，避免又催促朋友？',
    '朋友愿意再给青柠一次机会，两人先玩温和项目，刺激项目仍可拒绝。',
  ]
  report.editedFields = values
  for (let i = 0; i < values.length; i++) {
    const before = await card.$$eval('.preparation-editor textarea', fields => fields.map(f => f.value))
    await fill(card, `.preparation-editor > label:nth-child(${i + 1}) textarea`, values[i])
    const after = await card.$$eval('.preparation-editor textarea', fields => fields.map(f => f.value))
    check(`Editing field ${i + 1} preserves the other three fields and flags the explanation`, () => {
      assert.equal(after[i], values[i])
      for (let j = 0; j < 4; j++) if (j !== i) assert.equal(after[j], before[j])
    })
    assert.ok((await card.$eval('.preparation-actions', el => el.innerText)).includes('解释待核对'))
  }
  await screenshot(page, '02a-four-field-editor', card)
  await clickButton(card, '完成编辑')
  await card.$eval('details.preparation-card-evidence > summary', el => el.click())
  check('Edited card displays all four current values', () => {})
  const cardText = await card.$eval('.preparation-choice', el => el.innerText)
  values.forEach(value => assert.ok(cardText.includes(value)))
  const oldExplanation = await card.$eval('.preparation-explanation .is-stale', el => el.innerText)
  assert.ok(oldExplanation.includes(baselineBridge.method))
  assert.ok(oldExplanation.includes(baselineBridge.change))
  await screenshot(page, '02-four-fields-edited-old-explanation', card)
  const responseWait = page.waitForResponse(res => res.url().endsWith('/api/story/preparation/explanation') && res.request().method() === 'POST', { timeout: 180000 })
  console.log('Calling the real configured model for this card explanation...')
  await clickButton(card, '重新推演这张卡')
  const response = await responseWait
  const preview = await response.json()
  report.preview = { status: response.status(), ...preview }
  assert.equal(response.status(), 200, JSON.stringify(preview))
  check('A conditional, ordinary social interaction is not rejected for invented prerequisites', () => {
    assert.deepEqual(preview.issues, [], 'This scenario preserves refusal and does not claim that fear must disappear')
  })
  report.modelMissedExpansion = !preview.expansionNeeds?.length
  await page.waitForSelector('.preparation-explanation-preview', { timeout: 10000 })
  if (!report.modelMissedExpansion) assert.ok((await card.$eval('.preparation-explanation-preview', el => el.innerText)).includes('留到正文展开'))
  assert.ok(!(await card.$eval('.preparation-explanation-preview', el => el.innerText)).includes('待作者判断'))
  check('Real model receives the latest four fields for this card only', () => {
    assert.equal(report.modelRequests.length, 1)
    assert.equal(report.modelRequests[0].candidate.id, session.provisionalCurve.preparation.candidates[0].id)
    assert.equal(report.modelRequests[0].candidate.action, `遇到的难处：${values[0]}${session.provisionalCurve.preparation.candidates[0].action.includes('\n眼前的选择：') ? '\n' : ''}眼前的选择：${values[1]}`)
    assert.equal(preview.wording.action, report.modelRequests[0].candidate.action)
    assert.equal(preview.wording.futureChoice, values[2])
    assert.equal(preview.wording.possibleResult, values[3])
  })
  assert.equal(await card.$eval('.preparation-explanation .is-stale', el => el.innerText), oldExplanation)
  assert.ok((await card.$eval('.preparation-explanation-preview', el => el.innerText)).includes('尚未采用'))
  await screenshot(page, '03-real-model-preview', card)
  await clickButton(card, '编辑')
  await fill(card, '.preparation-editor > label:nth-child(4) textarea', `${values[3]}他们也可能约好下次再来。`)
  check('Editing after a preview makes its adoption unavailable', () => {})
  const adoptDisabled = await card.$$eval('.preparation-explanation-preview button', buttons => buttons.find(b => b.textContent.trim() === '采用这版解释').disabled)
  assert.equal(adoptDisabled, true)
  await fill(card, '.preparation-editor > label:nth-child(4) textarea', values[3])
  await clickButton(card, '完成编辑')
  await clickButton(card, '采用这版解释')
  await page.waitForFunction(() => !document.querySelector('.preparation-explanation-preview'))
  check('Adoption updates the current explanation and retains earlier text', () => {})
  assert.ok((await card.$eval('.preparation-explanation', el => el.innerText)).includes(preview.method))
  assert.ok((await card.$eval('.preparation-explanation', el => el.innerText)).includes(preview.change))
  assert.ok(await card.$('.preparation-explanation > details'))
  await clickButton(card, '编辑解释')
  const manual = { method: '青柠承认以前失约的责任，陪朋友从温和项目开始，把是否挑战的决定交给朋友。', change: '朋友愿意再给一次机会，青柠接下来需要用行动守住约定。', issues: ['暂时保留这版谈话设计，后续由我决定如何表现。'] }
  report.manual = manual
  await fill(card, '.preparation-explanation-editor > label:nth-child(1) textarea', manual.method)
  await fill(card, '.preparation-explanation-editor > label:nth-child(2) textarea', manual.change)
  await fill(card, '.preparation-explanation-editor > label:nth-child(3) textarea', manual.issues.join('\n'))
  for (let i = 0; i < (preview.expansionNeeds?.length ?? 0); i++) await clickButton(card, '移除此标记')
  assert.deepEqual(await card.$$eval('select[aria-label="待展开类型"] option', options => options.map(o => o.textContent)),
    ['因果铺垫', '关键行动', '重要回应', '人物变化', '情绪效果', '反差与呼应'])
  const kindSelect = await card.$('select[aria-label="待展开类型"]')
  await kindSelect.select('character-detail')
  await clickButton(card, '添加标记')
  check('Author can select a story effect, remove model notes and add a character-change note', () => {})
  report.adoptedNeeds = [{ kind: 'character-detail', anchors: [{ field: 'action', quote: preview.wording.action }] }]
  await clickButton(card, '保存并采用解释')
  assert.deepEqual(await page.$$eval('.preparation-proposal', cards => cards.slice(1).map(c => c.innerText)), siblingText)
  check('Manual explanation edits are adopted with unresolved issues; other cards stay unchanged', () => {})
  await screenshot(page, '04-author-explanation-adopted', card)
  await card.$eval('.preparation-choice', el => el.click())
  const acceptWait = page.waitForResponse(res => res.url().endsWith('/api/story/preparation/accept') && res.request().method() === 'POST', { timeout: 180000 })
  console.log('Confirming the edited direction through the real backend...')
  await clickButton(page, '确认这个困境')
  const acceptedResponse = await acceptWait
  const accepted = await acceptedResponse.json()
  report.acceptance = { status: acceptedResponse.status(), error: accepted.error }
  assert.equal(acceptedResponse.status(), 200, JSON.stringify(accepted.error))
  const candidate = accepted.curve.preparation.candidates.find(c => c.id === report.modelRequests[0].candidate.id)
  writeFileSync(join(artifact, 'accepted-curve.json'), JSON.stringify(accepted.curve, null, 2))
  check('Next story plan uses the edited action and possible result verbatim', () => {
    assert.equal(candidate.action, preview.wording.action)
    assert.equal(candidate.futureChoice, values[2])
    assert.equal(candidate.possibleResult, values[3])
    assert.equal(accepted.curve.preparation.status, 'accepted-design')
    assert.deepEqual(accepted.curve.preparation.acceptedCandidateIds, [candidate.id])
    const actionBeats = accepted.curve.beats.filter(b => ['trigger', 'escalation', 'climax-choice'].includes(b.kind))
    assert.ok(actionBeats.length)
    for (const beat of actionBeats) assert.equal(beat.detail, preview.wording.action)
    assert.equal(accepted.curve.beats.find(b => b.kind === 'resolution')?.detail, values[3])
    assert.deepEqual(accepted.curve.preparation.candidates.slice(1), session.provisionalCurve.preparation.candidates.slice(1))
  })
  report.nextPlan = { action: candidate.action, futureChoice: candidate.futureChoice, possibleResult: candidate.possibleResult,
    beats: accepted.curve.beats.map(b => ({ kind: b.kind, detail: b.detail })) }
  assert.deepEqual(candidate.explanation.wording, preview.wording)
  assert.equal(candidate.explanation.method, manual.method)
  assert.deepEqual(candidate.explanation.issues, manual.issues)
  assert.deepEqual(candidate.explanation.expansionNeeds, report.adoptedNeeds)
  assert.deepEqual(candidate.expansionNeeds, report.adoptedNeeds)
  check('Adopted writing notes survive manual explanation edits and are saved on the selected direction', () => {})
  await page.waitForSelector('.curve-shell', { timeout: 10000 })
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('.curve-shell', { timeout: 15000 })
  const savedText = await page.$eval('.curve-main', el => el.textContent)
  values.slice(0, 2).forEach(value => assert.ok(savedText.includes(value)))
  assert.ok(savedText.includes(values[3]))
  const persisted = JSON.parse(readFileSync(storePath, 'utf8')).sessions.find(s => s.id === session.id)
  const persistedCandidate = persisted.provisionalCurve.preparation.candidates.find(c => c.id === candidate.id)
  assert.equal(persistedCandidate.action, candidate.action)
  assert.equal(persistedCandidate.futureChoice, values[2])
  assert.equal(persistedCandidate.possibleResult, values[3])
  assert.ok(savedText.includes(manual.method))
  assert.ok(savedText.includes(manual.change))
  assert.ok(savedText.includes(manual.issues[0]))
  assert.ok(savedText.includes('留到正文展开'))
  assert.ok(savedText.includes('人物变化'))
  check('Confirmed direction and adopted explanation persist through a browser refresh', () => {})
  await page.$$eval('details', elements => elements.filter(el => el.querySelector('summary')?.textContent.includes('推演解释')).forEach(el => { el.open = true }))
  await screenshot(page, '05-saved-explanation-after-refresh')
  assert.deepEqual(report.browserErrors, [])
  report.success = true
} catch (error) {
  report.success = false
  report.error = { message: error.message, stack: error.stack }
  console.error(error.stack)
  if (browser) {
    try { const page = (await browser.pages()).at(-1); await screenshot(page, 'failure') } catch {}
  }
  process.exitCode = 1
} finally {
  writeFileSync(join(artifact, 'report.json'), JSON.stringify(report, null, 2))
  if (browser) await browser.close().catch(() => {})
  for (const child of children) if (child.exitCode === null) child.kill()
  console.log(`Evidence: ${artifact}`)
}
