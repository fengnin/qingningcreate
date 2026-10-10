import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { StorySessionSnapshot, StoryTurnOption } from '../../shared/story-contract.js'
import { AppError } from './qwen.js'
import { createNarrativeStateMachine } from './storyState.js'

const idea = '青柠要在周五毕业展前把祖母留下的投影仪送到学校；好友阿岚答应帮忙但要求不要署名；归还期限是周六；途中发现设备缺少电源线；青柠必须决定是否拆掉自己的展板供电；可能失去署名机会。'
const brief = { tones: ['growth' as const], dramaticForces: ['cost' as const], allowSystemNamedCharacters: false }
const names = ['STORY_DISABLE_MODEL', 'STORY_SESSION_STORE_PATH', 'DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL'] as const
const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
const originalFetch = globalThis.fetch
const store = join(mkdtempSync(join(tmpdir(), 'story-interaction-contract-')), 'sessions.json')
process.env.STORY_SESSION_STORE_PATH = store
process.env.STORY_DISABLE_MODEL = 'true'
process.env.DASHSCOPE_API_KEY = 'contract-key'
process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'
const service = await import('./storyService.js')
test.after(() => {
  globalThis.fetch = originalFetch
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]
    else process.env[name] = previous[name]
  }
})
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code
const calls: { system: string; input: Record<string, any> }[] = []
function stub(payload: unknown) {
  process.env.STORY_DISABLE_MODEL = 'false'
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const system = body.messages[0].content
    const input = system.includes('共创提案编辑') ? JSON.parse(body.messages[1].content) : {}
    calls.push({ system, input })
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 })
  }
}
function plan() {
  return { candidatePlan: { options: [
    { label: '拆展板的候选', action: '青柠考虑拆掉自己的展板供电。' },
    { label: '保留展板的候选', action: '青柠考虑保留自己的展板。' },
    { label: '保留未知', action: '青柠暂不决定是否拆掉展板，先审阅行动条件。' },
  ].map((option) => ({ ...option, proposedConsequence: '拆展板可能解决供电，也可能影响署名；因果均待作者核对。',
    sourceFactIds: ['author-1'], causalClaims: [{ statement: '拆展板供电是否可行及代价尚未确认。', sourceFactIds: ['author-1'] }],
    questions: ['展板供电能否用于投影仪？'] })) } }
}
async function opening() {
  process.env.STORY_DISABLE_MODEL = 'true'; globalThis.fetch = originalFetch
  const start = await service.startStoryCoCreation({ idea, brief })
  const confirmed = await service.confirmSessionCurve({ storyId: start.storyId, revision: start.revision, curveId: start.curve.id })
  stub({ openingPlan: { anchorIds: ['opening-anchor-1', 'opening-anchor-2', 'opening-anchor-3'] } })
  await service.startSessionStorySpineFromCurve({ storyId: confirmed.storyId, revision: confirmed.revision, curveId: confirmed.curve.id })
  return structuredClone(service.getStorySessionSnapshot(start.storyId))
}
const click = (s: StorySessionSnapshot) => ({ storyId: s.storyId, revision: s.revision, mode: 'continue' as const,
  turnId: s.currentTurn!.id, optionId: s.currentTurn!.options[0]!.id })
const diskSession = (id: string) => JSON.parse(readFileSync(store, 'utf8')).sessions.find((s: { id: string }) => s.id === id)

test('focus -> candidate review -> explicit author result: no model causal claim enters facts', async () => {
  const before = await opening(), stateBefore = diskSession(before.storyId).state
  assert.equal(before.currentTurn!.presentation, 'focus-selection')
  assert.ok(before.currentTurn!.options.every((o) => o.narrativeAction.mode === 'focus'))
  assert.doesNotMatch(before.currentTurn!.conflict.conflict, /形成取舍/u)
  stub(plan()); const callCount = calls.length
  const result = await service.generateSessionStoryTurn(click(before))
  assert.equal(calls.length - callCount, 1, 'no same-model truth reviewer')
  assert.equal(result.turn.presentation, 'candidate-actions')
  assert.equal(result.revision, before.revision + 1)
  let persisted = diskSession(before.storyId)
  assert.deepEqual(persisted.state.facts, stateBefore.facts)
  assert.deepEqual(persisted.state.actions, stateBefore.actions)
  assert.deepEqual(persisted.state.appliedTransitions, stateBefore.appliedTransitions)
  assert.equal(persisted.state.revision, stateBefore.revision)
  assert.ok(persisted.state.focus)
  assert.ok(result.turn.options.every((o) => o.narrativeAction.mode === 'candidate' && !o.transition.introducedFacts.length))
  const s = structuredClone(service.getStorySessionSnapshot(before.storyId))
  const reviewed = await service.generateSessionStoryTurn(click(s))
  assert.equal(reviewed.turn.id, s.currentTurn!.id)
  assert.equal(reviewed.history.length, s.history.length)
  assert.ok(reviewed.pendingActionProposal?.requiresExecutedResultConfirmation)
  assert.deepEqual(diskSession(s.storyId).state.facts, stateBefore.facts)
  const proposal = reviewed.pendingActionProposal!
  const request = { storyId: s.storyId, revision: reviewed.revision, proposalId: proposal.id, mode: 'continue' as const }
  const disk = readFileSync(store, 'utf8'), snapshot = structuredClone(service.getStorySessionSnapshot(s.storyId))
  await assert.rejects(service.confirmSessionStoryActionProposal(request), hasCode('STORY_EXECUTED_RESULT_CONFIRMATION_REQUIRED'))
  assert.equal(readFileSync(store, 'utf8'), disk)
  assert.deepEqual(service.getStorySessionSnapshot(s.storyId), snapshot)
  await assert.rejects(service.confirmSessionStoryActionProposal({ ...request, authorConfirmation: {
    actionText: '另一行动', resultText: '不应写入' } }), hasCode('STORY_ACTION_CONFIRMATION_CONFLICT'))
  // Synthetic author result: a contract fixture only, never a Shen Qiao answer.
  const authorConfirmation = { actionText: proposal.action, resultText: '合同作者确认：只完成了条件审阅，投影仪仍未通电。' }
  const after = await service.confirmSessionStoryActionProposal({ ...request, authorConfirmation })
  persisted = diskSession(s.storyId)
  const added = persisted.state.facts.filter((f: { id: string }) => !stateBefore.facts.some((old: { id: string }) => old.id === f.id))
  assert.deepEqual(added.map((f: { statement: string }) => f.statement), [authorConfirmation.resultText])
  assert.deepEqual(after.history.at(-1)!.selectedOption.transition.authorConfirmation?.resultText, authorConfirmation.resultText)
  assert.equal(after.turn.presentation, 'candidate-actions')
  assert.equal(calls.at(-1)!.input.lastAuthorConfirmedResult.resultText, authorConfirmation.resultText)
  assert.ok(calls.at(-1)!.input.sourceFacts.some((f: { text: string }) => f.text === authorConfirmation.resultText))
  await assert.rejects(service.generateSessionStoryTurn(click(before)), hasCode('STORY_SESSION_CONFLICT'))
})

test('unconfirmed mainline still rejects before any call; malformed model proposals do not mutate', async () => {
  process.env.STORY_DISABLE_MODEL = 'true'; globalThis.fetch = originalFetch
  const start = await service.startStoryCoCreation({ idea, brief })
  const count = calls.length; stub(plan())
  await assert.rejects(service.generateSessionStoryTurn({ storyId: start.storyId, revision: start.revision,
    mode: 'continue', turnId: 'turn-1', optionId: 'turn-1-option-1' }), hasCode('STORY_CURVE_NOT_CONFIRMED'))
  assert.equal(calls.length, count)
  const before = await opening(), disk = readFileSync(store, 'utf8')
  for (const bad of [
    { ...plan(), review: { supported: true } },
    { candidatePlan: { options: plan().candidatePlan.options.map((o) => ({ ...o, transition: { introducedFacts: [] } })) } },
    { candidatePlan: { options: plan().candidatePlan.options.map((o) => ({ ...o, sourceFactIds: ['unknown-id'] })) } },
    { needsAuthorDetail: ['模型猜测作者缺资料'] },
  ]) {
    stub(bad)
    await assert.rejects(service.generateSessionStoryTurn(click(before)), hasCode('STORY_TURN_RETRY_EXHAUSTED'))
    assert.deepEqual(service.getStorySessionSnapshot(before.storyId), before)
    assert.equal(readFileSync(store, 'utf8'), disk)
  }
})

test('failed persistence cannot publish a focus selection or author confirmation', async () => {
  const before = await opening(); stub(plan())
  const blocker = `${store}.tmp`, backup = `${blocker}.kept`
  // An existing directory as the temporary target induces a real write error.
  const { mkdirSync } = await import('node:fs')
  mkdirSync(blocker)
  try {
    await assert.rejects(service.generateSessionStoryTurn(click(before)), hasCode('STORY_SESSION_PERSIST_FAILED'))
    assert.deepEqual(service.getStorySessionSnapshot(before.storyId), before)
  } finally { renameSync(blocker, backup) }
  const result = await service.generateSessionStoryTurn(click(before))
  const s = structuredClone(service.getStorySessionSnapshot(before.storyId))
  const review = await service.generateSessionStoryTurn(click(s)), proposal = review.pendingActionProposal!
  const unchanged = structuredClone(service.getStorySessionSnapshot(s.storyId)), disk = readFileSync(store, 'utf8')
  mkdirSync(blocker)
  try {
    await assert.rejects(service.confirmSessionStoryActionProposal({ storyId: s.storyId, revision: review.revision,
      proposalId: proposal.id, mode: 'continue', authorConfirmation: { actionText: proposal.action, resultText: '合同作者确认的结果。' } }),
      hasCode('STORY_SESSION_PERSIST_FAILED'))
    assert.deepEqual(service.getStorySessionSnapshot(s.storyId), unchanged)
    assert.equal(readFileSync(store, 'utf8'), disk)
  } finally { renameSync(blocker, `${backup}-result`) }
  assert.equal(result.turn.presentation, 'candidate-actions')
})

test('state machine rejects pending causal facts, tampered result receipts; focus changes no facts or executed history', () => {
  const machine = createNarrativeStateMachine({ maximumFacts: 30, maximumActions: 30 })
  const state = { revision: 0, facts: [], actions: [], appliedTransitions: [] }
  const option: StoryTurnOption = { id: 'o', label: '关注', action: '审阅', immediateConsequence: '未执行', laterEffect: '待审',
    narrativeAction: { id: 'a', intent: '审阅', mode: 'focus', source: 'generated', preconditions: [], effects: [], focusSourceTexts: ['投影仪今晚要归还'] },
    transition: { actionId: 'a', consumedFacts: [], changedFacts: [], introducedFacts: [] } }
  const focused = machine.applyTransition(state, option.narrativeAction, option.transition)
  assert.deepEqual(focused.facts, []); assert.deepEqual(focused.actions, []); assert.deepEqual(focused.appliedTransitions, [])
  const pending = structuredClone(option); pending.narrativeAction.mode = 'candidate'
  pending.transition.introducedFacts = [{ id: 'bad', statement: '归还投影仪会关闭观看窗口。', source: 'confirmed-action', mutability: 'changeable' }]
  assert.throws(() => machine.validateTurnOption(state, pending, { statusCode: 502, code: 'INVALID_MODEL_OUTPUT' }, 'invalid'), hasCode('INVALID_MODEL_OUTPUT'))
  assert.throws(() => machine.applyTransition(state, pending.narrativeAction, pending.transition), hasCode('STORY_ACTION_REVIEW_REQUIRED'))
  pending.narrativeAction.mode = 'executed'; pending.narrativeAction.source = 'user-choice'
  pending.transition.authorConfirmation = { proposalId: 'p', turnId: 't', actionText: '审阅', resultText: '作者未确认窗口关闭。', confirmedAt: 1 }
  assert.throws(() => machine.applyTransition(state, pending.narrativeAction, pending.transition), hasCode('STORY_ACTION_REVIEW_REQUIRED'))
})
