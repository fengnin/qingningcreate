import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConfirmedCurve, StorySeed, StoryTurnHistoryItem } from '../../shared/story-contract.js'
import { createStoryProposalContext, validateProposalFactReferences, validateContinuationBasis } from './storyProposalContext.js'

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
})
