import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConfirmedCurve, StorySeed, StoryTurnHistoryItem, StoryPredicament } from '../../shared/story-contract.js'
import { createStoryProposalContext, validateProposalFactReferences, validateContinuationBasis, validateContinuationQualityReview } from './storyProposalContext.js'
import { generateStoryTurn } from './storyService.js'
import { AppError } from './qwen.js'
import type { StoryPreparation } from '../../shared/story-preparation.js'

const seed: StorySeed = { subject: '许沅', activeSituation: '修复陶碗', lockedGoal: '修复陶碗',
  lockedFacts: ['陶碗裂口缺一块', '邻居提供同色碎片'], worldMode: 'realistic-default', expansionScope: 'keep-scale', unknowns: [] }
const curve: ConfirmedCurve = { id: 'c', provisionalCurveId: 'p', title: '陶碗', confirmedAt: 1,
  brief: { tones: ['warm'], dramaticForces: ['cost'], allowSystemNamedCharacters: false },
  beats: [{ id: 'b', kind: 'trigger', title: '作者编辑', detail: '若碎片不能贴合，先测量裂口，不粘接。',
    dependsOn: [], source: 'user-edit', status: 'confirmed' }],
  clarifications: [{ id: 'q', prompt: '碎片是否贴合？', status: 'author-unknown', answerText: '作者尚未确定。',
    dependency: { beatIds: ['b'], causalGap: '尺寸匹配', requiredFor: ['review-beat'] },
    source: 'author-review', unknownHandling: 'keep-unknown', createdAt: 1, updatedAt: 1 }],
}
function history(mode: 'executed' | 'candidate', resultText = '测量后确认碎片比缺口窄。'): StoryTurnHistoryItem {
  return { turnId: 't', phase: 'development', node: { id: 'n', title: '测量', event: '测量', purpose: '核对', goalState: 'trying' },
    conflict: { nodeId: 'n', conflict: '尺寸待核对', action: '测量', consequence: '未知', intensity: 1, anchor: '尺寸' },
    selectedOption: { id: 'o', label: '测量', action: '测量裂口', immediateConsequence: resultText, laterEffect: '待审',
      narrativeAction: { id: 'a', intent: '测量裂口', mode, source: 'user-choice', preconditions: [], effects: [] },
      transition: { actionId: 'a', consumedFacts: [], changedFacts: [],
        introducedFacts: [{ id: 'result', statement: resultText, source: 'confirmed-action', mutability: 'changeable' }],
        authorConfirmation: { proposalId: 'p', turnId: 't', actionText: '测量裂口', resultText, confirmedAt: 1 } } } }
}
test('conditional author edits and unknown answers stay distinct from evidence, with no date required', () => {
  const input = createStoryProposalContext(seed, curve, [], ['邻居提供同色碎片'])
  assert.equal(input.authorEdits[0]!.text, curve.beats[0]!.detail)
  assert.equal(input.unresolvedQuestions[0]!.answerText, '作者尚未确定。')
  assert.ok(!input.sourceFacts.some((f) => f.text === curve.beats[0]!.detail || f.text === '作者尚未确定。'))
  assert.deepEqual(input.selectedFocus, ['邻居提供同色碎片'])
  assert.equal(input.lastAuthorConfirmedResult, null)
})
test('only exact author result receipts feed continuation; model history and tampered receipts do not', () => {
  const executed = history('executed'), candidate = history('candidate', '陶碗已经修好。')
  const tampered = history('executed', '碎片已经粘牢。')
  tampered.selectedOption.transition.authorConfirmation!.resultText = '未粘接。'
  const input = createStoryProposalContext(seed, curve, [executed, candidate, tampered], [])
  assert.deepEqual(input.executedHistory.map((entry) => entry.resultText), ['测量后确认碎片比缺口窄。'])
  assert.equal(input.lastAuthorConfirmedResult!.resultText, '测量后确认碎片比缺口窄。')
  assert.ok(!input.sourceFacts.some((f) => f.text === '陶碗已经修好。' || f.text === '碎片已经粘牢。'))
  const systemBeat = { ...curve.beats[0]!, id: 'prediction', source: 'system-proposal' as const, detail: '可能发现陶碗底部破洞。' }
  const withPrediction = { ...curve, beats: [...curve.beats, systemBeat] } as ConfirmedCurve
  assert.ok(!createStoryProposalContext(seed, withPrediction, [executed], []).designBeats.some(b => b.id === 'prediction'))
  assert.ok(createStoryProposalContext(seed, withPrediction, [], []).designBeats.some(b => b.id === 'prediction'))
})

test('continuation references cannot promote reviewed design or unknown questions to fact evidence', () => {
  const context = createStoryProposalContext(seed, curve, [history('executed')], [])
  assert.deepEqual(context.referenceContract.sourceFactIds, context.sourceFacts.map(f => f.id))
  assert.deepEqual(context.referenceContract.designOnlyIds, ['b'])
  const path = 'options[1].causalClaims[0].sourceFactIds'
  for (const refs of [['b'], ['q'], ['unknown-id'], ['result','result']]) {
    assert.throws(() => validateProposalFactReferences(refs, context.referenceContract.sourceFactIds, path),
      (e: unknown) => e instanceof Error && e.message.includes(path))
  }
  assert.deepEqual(validateProposalFactReferences(['result'], context.referenceContract.sourceFactIds, path), ['result'])
  assert.deepEqual(validateProposalFactReferences([], context.referenceContract.sourceFactIds, path), [])
})

test('selected expansion obligations travel as design, never fact evidence or a new unresolved task', () => {
  const expansionNeeds = [{ kind: 'setup' as const, anchors: [{ field: 'method' as const, quote: '用随身的戏服伪装。' }] }]
  const preparation: StoryPreparation = { protocol: 1, status: 'accepted-design', executed: false,
    sources: [{ id: 'author-input', text: '主角想离开。' }], appealMaterialIds: ['m0'],
    material: [{ id: 'm0', sourceId: 'author-input', role: 'goal', quote: '主角想离开。' }], questions: [], acceptedCandidateIds: ['d0'],
    candidates: [{ id: 'd0', action: '主角尝试伪装后离开。', possibleResult: '可能接近出口。', futureChoice: '继续离开还是回去帮人？',
      materialIds: ['m0'], resultBasisIds: [], preconditionIds: [], unknownIds: [], expansionNeeds,
      causalBridge: { method: '用随身的戏服伪装。', change: '可能接近出口。', methodBasisIds: ['m0'], changeBasisIds: [] } }] }
  const input = createStoryProposalContext(seed, { ...curve, preparation }, [], [])
  assert.deepEqual(input.expansionNeeds, expansionNeeds)
  assert.deepEqual(input.creativeFocus, { authority: 'creative-reference', excerpts: ['主角想离开。'] })
  assert.deepEqual(input.sourceFacts.map(f => f.text), ['主角想离开。'])
  assert.doesNotMatch(JSON.stringify(input.sourceFacts), /戏服/)
  assert.deepEqual(input.referenceContract.sourceFactIds, ['author-1'])
})

test('continuation basis carries the latest receipt and separates optional design from existing obligations', () => {
  const context = createStoryProposalContext(seed, curve, [history('executed')], [])
  const basis = { latestResultFactId: 'result', unresolved: { kind: 'optional-design', text: '可以拒绝的展示建议。', sourceFactIds: [] as string[] }, reason: '承接测量结果；展示建议不阻止原任务。', contradictions: [] as unknown[] }
  assert.equal(validateContinuationBasis(basis, context).unresolved.kind, 'optional-design')
  assert.throws(() => validateContinuationBasis({ ...basis, latestResultFactId: null }, context), /最近作者确认/)
  assert.throws(() => validateContinuationBasis({ ...basis, unresolved: { ...basis.unresolved, kind: 'existing' } }, context), /必须提供作者依据/)
  assert.throws(() => validateContinuationBasis({ ...basis, unresolved: { ...basis.unresolved, sourceFactIds: ['result'] } }, context), /不是已有事实要求/)
  assert.throws(() => validateContinuationBasis({ ...basis, contradictions: [{ text: '矛盾', sourceFactIds: ['result'] }] }, context), /至少两项/)
  assert.throws(() => validateContinuationBasis({ ...basis, contradictions: [{ text: '矛盾', sourceFactIds: ['result','b'] }] }, context), /非法事实 ID/)
  assert.equal(validateContinuationBasis({ ...basis, unresolved: { kind: 'next-goal', text: '请作者决定下一目标或收束。', sourceFactIds: [] } }, context).unresolved.kind, 'next-goal')
  assert.throws(() => validateContinuationBasis({ ...basis, reason: '根据lastAuthorConfirmedResult，没有sourceFact缺口。' }, context), /内部字段/)
})

test('structurally valid fact references cannot bypass an independent failed content review', async () => {
  const originalFetch = globalThis.fetch
  const env = { key: process.env.DASHSCOPE_API_KEY, disable: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const predicament = { id: 'p', designProtocol: 'prepared-action', title: '陶碗', variationAxis: 'commitment',
    preservedGoal: seed.lockedGoal, immediateSituation: seed.activeSituation, obstacle: '', tradeoff: '', urgency: '', choice: '', plausibleCost: '',
    approaches: [], facts: [], actions: [] } as StoryPredicament
  const request = { mode: 'continue', seed, predicament, confirmedCurve: curve, history: [], headTail: null } as unknown as Parameters<typeof generateStoryTurn>[0]
  const before = structuredClone(request)
  let generationCalls = 0, reviewCalls = 0
  const audit = { checks: ['continuity','causality','requirements','author-control'].map(criterion => ({ criterion, passed: criterion !== 'requirements', evidence: criterion === 'requirements' ? '原文没有要求邻居签字；签字被伪装为修碗的必要条件。' : '测试合同证据，非真实内容验收。' })), issues: [] }
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)), user = JSON.parse(input.messages[1].content)
    let output: unknown
    if (input.messages[0].content.includes('独立审查中文故事续推提案')) {
      reviewCalls++
      assert.equal(user.proposal.options[0].action, '先请邻居签字，才能修碗。')
      output = audit
    } else if (input.messages[0].content.includes('续推出口判断')) {
      output = { route: 'action', unresolved: '修复陶碗', reason: '陶碗仍待修复。', sourceIds: ['e0'], contradictions: [] }
    } else {
      generationCalls++
      if (generationCalls > 1) assert.match(user.task.repair, /签字/)
      output = { options: [{ label: '签字', action: '先请邻居签字，才能修碗。', proposedConsequence: '可能获得修复许可。' }] }
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 })
  }
  try {
    await assert.rejects(() => generateStoryTurn(request), (e: unknown) => e instanceof AppError && e.code === 'STORY_TURN_QUALITY_FAILED')
    assert.ok(generationCalls > 1)
    assert.equal(generationCalls, reviewCalls)
    assert.deepEqual(request, before)
    assert.throws(() => validateContinuationQualityReview({ ...audit, checks: audit.checks.slice(1) }), (e: unknown) => e instanceof AppError && e.code === 'INVALID_MODEL_OUTPUT')
  } finally {
    globalThis.fetch = originalFetch
    if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key
    if (env.disable === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = env.disable
  }
})
