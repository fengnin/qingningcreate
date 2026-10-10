import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { CreativeBrief, StoryCurveMutationResponse, StorySeed } from '../../shared/story-contract.js'
import { AppError } from './qwen.js'
import { createProvisionalCurveFallback, previewAffectedCurveBeats, regenerateCurveBeat, updateCurveBeat } from './storyCoCreation.js'

const idea = '青柠要在周五毕业展前把祖母留下的投影仪送到学校；好友阿岚答应帮忙但要求不要署名；归还期限是周六；途中发现设备缺少电源线；青柠必须决定是否拆掉自己的展板供电；可能失去署名机会。'
const authorEdit = '暂定：青柠面对设备缺少电源线的阻碍，必须决定是否拆掉自己的展板供电。'
const brief: CreativeBrief = { tones: ['growth'], dramaticForces: ['cost'], allowSystemNamedCharacters: false }
const seed: StorySeed = { subject: '青柠', activeSituation: idea, lockedGoal: '把祖母留下的投影仪送到学校',
  lockedFacts: idea.split(/[；。]/u).filter(Boolean), worldMode: 'realistic-default', expansionScope: 'keep-scale', unknowns: [] }
const envNames = ['STORY_DISABLE_MODEL', 'DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL', 'STORY_SESSION_STORE_PATH'] as const
const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
const previousFetch = globalThis.fetch
const store = join(mkdtempSync(join(tmpdir(), 'story-regeneration-')), 'sessions.json')
process.env.STORY_SESSION_STORE_PATH = store
process.env.STORY_DISABLE_MODEL = 'true'
process.env.DASHSCOPE_API_KEY = 'contract-test-key'
process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
const service = await import('./storyService.js')
test.after(() => {
  globalThis.fetch = previousFetch
  for (const name of envNames) {
    if (previousEnv[name] === undefined) delete process.env[name]
    else process.env[name] = previousEnv[name]
  }
})
function fixture() { return updateCurveBeat(createProvisionalCurveFallback(idea, seed, brief), 'beat-trigger', authorEdit).curve }
function ref(result: Pick<StoryCurveMutationResponse, 'storyId' | 'revision' | 'curve'>) { return { storyId: result.storyId, revision: result.revision, curveId: result.curve.id } }
function hasCode(code: string) { return (error: unknown) => error instanceof AppError && error.code === code }
type PlanRequest = { targetKind: string; allowedAuthorAnchorIds: string[]; allowedConstraintFactIds: string[] }
async function model<T>(operation: () => Promise<T>, payload?: unknown) {
  process.env.STORY_DISABLE_MODEL = 'false'
  const calls: PlanRequest[] = []
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    assert.match(body.messages[0].content, /节点事实选择器/u)
    const request = JSON.parse(body.messages[1].content) as PlanRequest
    calls.push(request)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload ?? {
      beatPlan: { authorAnchorId: request.allowedAuthorAnchorIds[0], constraintFactId: request.allowedConstraintFactIds[0] },
    }) } }] }), { status: 200 })
  }
  try { return { result: await operation(), calls } }
  finally { globalThis.fetch = previousFetch; process.env.STORY_DISABLE_MODEL = 'true' }
}

test('edited real-mode regeneration uses exact IDs, keeps costs unknown and previews without replacing the draft', async () => {
  const curve = fixture(), before = structuredClone(curve)
  const { result, calls } = await model(() => previewAffectedCurveBeats(idea, seed, curve))
  assert.deepEqual(curve, before)
  assert.equal(calls.length, result.preview.items.length)
  assert.ok(calls.length >= 3)
  assert.match(result.preview.generation!.notice!, /模型选择.*ID.*服务端渲染/u)
  const choice = result.preview.items.find((item) => item.kind === 'climax-choice')!.newDetail
  assert.match(choice, /拆掉自己的展板供电还是不拆自己的展板/u)
  assert.match(choice, /可能失去署名机会，是否由行动导致待确认/u)
  assert.doesNotMatch(result.preview.items.map((item) => item.newDetail).join('\n'), /无法补回|必然|重导出|取消署名资格/u)
  assert.equal(new Set(result.preview.items.map((item) => item.newDetail)).size, result.preview.items.length)
})

test('a conditional author edit remains a proposal and never establishes deletion as breaking a promise', async () => {
  const shenIdea = '沈乔想在展出前决定要不要删掉自己的名字；投影仪今晚要归还；她答应不再改动作品。'
  const shenSeed: StorySeed = { ...seed, subject: '沈乔', activeSituation: shenIdea,
    lockedGoal: '决定要不要删掉自己的名字', lockedFacts: shenIdea.split(/[；。]/u).filter(Boolean) }
  const edited = updateCurveBeat(createProvisionalCurveFallback(shenIdea, shenSeed, brief), 'beat-trigger',
    '暂定：沈乔若为了删掉自己的名字而改动作品，就会触碰她不再改动作品的承诺；她需要决定是否仍要改动。').curve
  const factsBefore = structuredClone(edited.design!.sourceFacts)
  const { result } = await model(() => previewAffectedCurveBeats(shenIdea, shenSeed, edited))
  assert.deepEqual(edited.design!.sourceFacts, factsBefore)
  assert.ok(result.preview.items.every((item) => item.newDetail.includes('沈乔若为了删掉自己的名字而改动作品')))
  assert.doesNotMatch(result.preview.items.map((item) => item.newDetail).join('\n'), /就会触碰|必然违反|违背不再改动/u)
  assert.match(result.preview.items.find((item) => item.kind === 'climax-choice')!.newDetail, /具体代价待作者确认/u)
})

test('invalid IDs or prose in the closed regeneration contract fail without modifying the session or store', async () => {
  const started = await service.startStoryCoCreation({ idea, brief })
  const edited = await service.updateSessionCurveBeat({ ...ref(started), beatId: 'beat-trigger', detail: authorEdit })
  const before = structuredClone(service.getStorySessionSnapshot(edited.storyId))
  const disk = readFileSync(store, 'utf8')
  for (const payload of [
    { detail: '暂定：青柠重新导出作品后无法补回署名资格。' },
    { beatPlan: { authorAnchorId: 'not-an-anchor', constraintFactId: 'not-a-fact' } },
    { beatPlan: { authorAnchorId: 'author-anchor-1', constraintFactId: 'source-fact-3', detail: '未经确认的文案' } },
  ]) {
    await model(() => assert.rejects(service.regenerateSessionCurveBeat({ ...ref(edited), beatId: 'beat-escalation' }),
      hasCode('STORY_CURVE_MODEL_VALIDATION_FAILED')), payload)
    assert.deepEqual(service.getStorySessionSnapshot(edited.storyId), before)
    assert.equal(readFileSync(store, 'utf8'), disk)
  }
})

test('single edited-node regeneration requires review, retains revision on conflict, and only accepts explicit decisions', async () => {
  const started = await service.startStoryCoCreation({ idea, brief })
  const edited = await service.updateSessionCurveBeat({ ...ref(started), beatId: 'beat-trigger', detail: authorEdit })
  const before = structuredClone(service.getStorySessionSnapshot(edited.storyId))
  const { result: preview } = await model(() => service.regenerateSessionCurveBeat({ ...ref(edited), beatId: 'beat-escalation' }))
  assert.equal(preview.revision, edited.revision + 1)
  assert.deepEqual(preview.curve, before.curve)
  assert.equal(service.getStorySessionSnapshot(preview.storyId).pendingCurveRegeneration!.id, preview.pendingCurveRegeneration!.id)
  await assert.rejects(service.confirmSessionCurve(ref(preview)), hasCode('STORY_CURVE_REGENERATION_PENDING'))
  await assert.rejects(service.resolveSessionCurveDependencies({ ...ref(edited), previewId: preview.pendingCurveRegeneration!.id,
    decisions: {} }), hasCode('STORY_SESSION_CONFLICT'))
  const accepted = await service.resolveSessionCurveDependencies({ ...ref(preview), previewId: preview.pendingCurveRegeneration!.id,
    decisions: Object.fromEntries(preview.pendingCurveRegeneration!.items.map((item) => [item.id, 'accept' as const])) })
  assert.equal(accepted.curve.beats.find((beat) => beat.id === 'beat-trigger')!.detail, authorEdit)
  assert.equal(accepted.curve.beats.find((beat) => beat.id === 'beat-escalation')!.status, 'proposed')
  assert.equal(service.getStorySessionSnapshot(accepted.storyId).pendingCurveRegeneration, undefined)
  assert.ok(accepted.curve.beats.some((beat) => beat.status === 'stale'))
})

test('explicit disabled-model regression still uses a visibly local fallback without model calls', async () => {
  process.env.STORY_DISABLE_MODEL = 'true'
  globalThis.fetch = async () => { throw new Error('disabled mode must not call a model') }
  try {
    const result = await regenerateCurveBeat(idea, seed, fixture(), 'beat-escalation')
    assert.equal(result.curve.generation!.origin, 'fact-preserving-fallback')
  } finally { globalThis.fetch = previousFetch }
})
