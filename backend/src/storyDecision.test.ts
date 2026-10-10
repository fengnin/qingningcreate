import assert from 'node:assert/strict'
import test from 'node:test'
import type { CreativeBrief } from '../../shared/story-contract.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from './qwen.js'
// Preserve historical rendering contract assertions; protocol 1 does not use it.
import { generateLegacyProvisionalCurve as generateProvisionalCurve } from './storyCoCreation.js'

const previousStorePath = process.env.STORY_SESSION_STORE_PATH
// Isolate the service module's store even though these tests only use its seed extractor.
process.env.STORY_SESSION_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'story-decision-')), 'sessions.json')
const { createDirectCoCreationSeed } = await import('./storyService.js')

const idea = '青柠要在周五毕业展前把祖母留下的投影仪送到学校；好友阿岚答应帮忙但要求不要署名；归还期限是周六；途中发现设备缺少电源线；青柠必须决定是否拆掉自己的展板供电；可能失去署名机会。'
const shen = '毕业展布置前，沈乔在借来的投影仪里看到和前队友剪的短片。投影仪今晚要归还，她答应不再改动作品，却想在展出前决定要不要删掉自己的名字。'
const brief: CreativeBrief = { tones: ['growth'], dramaticForces: ['cost'], allowSystemNamedCharacters: false }
const previousFetch = globalThis.fetch
const environment = { STORY_DISABLE_MODEL: process.env.STORY_DISABLE_MODEL,
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY, DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL }
test.after(() => {
  globalThis.fetch = previousFetch
  if (previousStorePath === undefined) delete process.env.STORY_SESSION_STORE_PATH
  else process.env.STORY_SESSION_STORE_PATH = previousStorePath
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
function model(plan: unknown) {
  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'contract-test-key'
  process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ curvePlan: plan }) } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })
}
test('a deadline remains a constraint; the real input decision and risk reach the live causal curve and foundation', async () => {
  model({ triggerFactId: 'source-fact-4', escalationFactId: 'source-fact-3', choiceFactId: 'source-fact-1', resolutionMode: 'adjust-goal-under-constraint' })
  const curve = await generateProvisionalCurve(idea, createDirectCoCreationSeed(idea)!, brief)
  const trigger = curve.beats.find((beat) => beat.kind === 'trigger')!
  const choice = curve.beats.find((beat) => beat.kind === 'climax-choice')!
  assert.match(trigger.detail, /缺少电源线/u)
  assert.match(choice.detail, /选择拆掉自己的展板供电还是不拆自己的展板/u)
  assert.match(choice.detail, /既有约束：归还期限是周六/u)
  assert.match(choice.detail, /可能失去署名机会.*因果关系待作者确认/u)
  assert.ok(choice.sourceFactIds!.includes('source-fact-5'))
  assert.ok(choice.sourceFactIds!.includes('source-fact-6'))
  assert.doesNotMatch(JSON.stringify(curve.foundation), /无法同时保留.*归还期限/u)
  assert.match(curve.foundation!.predicament.choice, /拆掉自己的展板供电还是不拆自己的展板/u)
  assert.match(curve.foundation!.predicament.plausibleCost, /因果关系待作者确认/u)
})
test('a plan cannot ignore the explicit missing-resource obstacle in favor of a date', async () => {
  model({ triggerFactId: 'source-fact-3', escalationFactId: 'source-fact-2', choiceFactId: 'source-fact-1', resolutionMode: 'adjust-goal-under-constraint' })
  await assert.rejects(() => generateProvisionalCurve(idea, createDirectCoCreationSeed(idea)!, brief),
    (error: unknown) => error instanceof AppError && error.code === 'STORY_CURVE_MODEL_GENERATION_FAILED')
})
test('Shen Qiao stays a review proposal; no promise violation, location or cost is invented', async () => {
  model({ triggerFactId: 'source-fact-3', escalationFactId: 'source-fact-4', choiceFactId: 'source-fact-5', resolutionMode: 'adjust-goal-under-constraint' })
  const curve = await generateProvisionalCurve(shen, createDirectCoCreationSeed(shen)!, brief)
  const choice = curve.beats.find((beat) => beat.kind === 'climax-choice')!
  assert.equal(curve.status, 'draft')
  assert.match(choice.detail, /选择删掉自己的名字还是保留自己的名字/u)
  assert.match(choice.detail, /具体代价待作者确认/u)
  assert.doesNotMatch(JSON.stringify(curve.foundation), /必然|违反|无法同时保留|名字写在/u)
})
