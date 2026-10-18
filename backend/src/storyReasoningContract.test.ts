import assert from 'node:assert/strict'
import test from 'node:test'
import type { StoryReasoningProposal, StoryReasoningValidationContext } from '../../shared/story-reasoning-contract.js'
import { AppError } from './qwen.js'
import { acceptStoryReasoningDesign, validateStoryReasoningAuthorResult, validateStoryReasoningProposal } from './storyReasoningContract.js'

const context: StoryReasoningValidationContext = {
  stage: 'edit-preview', sources: [
    { id: 'material', text: '分类与保留全部图纸可以同时做到。', authority: 'author-material' },
    { id: 'edit-source', text: '先分类，不丢弃。', authority: 'author-design' },
    { id: 'unknown-source', text: '编号是否重复尚未确定。', authority: 'unknown' },
  ], protectedSteps: [{ id: 'author-node', text: '先分类，不丢弃。' }], requiredEditIds: ['author-node'],
  excludedUnknowns: [{ id: 'unknown-existing', sourceIds: ['unknown-source'] }],
}
function proposal(): StoryReasoningProposal {
  const quotation = { kind: 'author-text' as const, evidence: [{ sourceId: 'material', quote: '分类与保留全部图纸可以同时做到。' }] }
  const design = { kind: 'design-proposal' as const, evidence: [{ sourceId: 'edit-source', quote: '先分类，不丢弃。' }], unknownIds: [] }
  return { protocol: 1, stage: 'edit-preview', outcome: 'proposal', status: 'needs-review',
    goal: { id: 'goal', text: '整理图纸', basis: design },
    constraints: [{ id: 'keep', text: '分类与保留全部图纸可以同时做到。', basis: quotation }],
    actions: [{ id: 'classify', text: '按编号分类，保留所有页面。', basis: design, constraintIds: ['keep'], relationIds: ['compatibility'], unknownIds: [], respondsToEditIds: ['author-node'] }],
    relations: [{ id: 'compatibility', text: '分类与保留全部图纸可以同时做到。', basis: quotation, relation: 'compatible', fromIds: ['classify'], toIds: ['keep'] }], unknowns: [],
    steps: [{ id: 'preview-node', kind: 'escalation', title: '分类后核对', text: '先分类，再核对。', basis: design,
      actionIds: ['classify'], relationIds: ['compatibility'], dependsOn: ['author-node'], respondsToEditIds: ['author-node'] }] }
}
const invalid = (e: unknown) => e instanceof AppError && e.code === 'STORY_REASONING_INVALID_OUTPUT'
test('accepted design remains future design; explicit author result is a separate stage', () => {
  const input = proposal(), parsed = validateStoryReasoningProposal(input, context), accepted = acceptStoryReasoningDesign(parsed)
  assert.equal(accepted.executed, false); assert.equal(accepted.status, 'accepted-design')
  assert.deepEqual(parsed, input); assert.ok(!('facts' in accepted) && !('transition' in accepted))
  assert.deepEqual(validateStoryReasoningAuthorResult({ stage: 'author-result', proposalId: 'p', actionText: '分类', resultText: '只分类了第一页。' }, 'p', '分类'),
    { stage: 'author-result', proposalId: 'p', actionText: '分类', resultText: '只分类了第一页。' })
  assert.throws(() => validateStoryReasoningProposal({ ...input, stage: 'author-result' }, context), invalid)
  assert.throws(() => validateStoryReasoningProposal({ ...input, transition: { introducedFacts: [] } }, context), invalid)
})
test('reject missing references, fabricated quotes, unknown facts and author design as factual authority', () => {
  for (const mutation of ['missing-ref', 'quote', 'unknown', 'design-fact', 'extra-conclusion', 'false-status']) {
    const p = proposal()
    if (mutation === 'missing-ref') p.actions[0]!.constraintIds = ['absent']
    if (mutation === 'false-status') (p as any).status = 'accepted-design'
    if (mutation === 'extra-conclusion') p.constraints[0]!.text += '因此必须丢弃。'
    if (mutation === 'quote') p.constraints[0]!.basis = { kind: 'author-text', evidence: [{ sourceId: 'material', quote: '必须丢弃。' }] }
    if (mutation === 'unknown') p.constraints[0]!.basis = { kind: 'author-text', evidence: [{ sourceId: 'unknown-source', quote: '编号是否重复尚未确定。' }] }
    if (mutation === 'design-fact') p.constraints[0]!.basis = { kind: 'author-text', evidence: [{ sourceId: 'edit-source', quote: '先分类，不丢弃。' }] }
    assert.throws(() => validateStoryReasoningProposal(p, context), invalid, mutation)
  }
})
test('reject overwriting protected edits, omitted edit obligations, dependency cycles and hidden unknowns', () => {
  for (const mutation of ['overwrite', 'omit', 'cycle', 'hidden']) {
    const p = proposal(); assert.ok(p.outcome === 'proposal' && 'steps' in p)
    if (mutation === 'overwrite') p.steps[0]!.id = 'author-node'
    if (mutation === 'omit') { p.actions[0]!.respondsToEditIds = []; p.steps[0]!.respondsToEditIds = [] }
    if (mutation === 'cycle') p.steps[0]!.dependsOn = ['preview-node']
    if (mutation === 'hidden') p.actions[0]!.basis = { kind: 'design-proposal', evidence: [], unknownIds: ['unknown-existing'] }
    assert.throws(() => validateStoryReasoningProposal(p, context), invalid, mutation)
  }
})
test('unknown dependencies are reviewable but block accepting a dependent design, not an independent replacement', () => {
  const p = proposal(); p.actions[0]!.basis = { kind: 'design-proposal', evidence: [], unknownIds: ['unknown-existing'] }; p.actions[0]!.unknownIds = ['unknown-existing']
  const parsed = validateStoryReasoningProposal(p, context)
  assert.throws(() => acceptStoryReasoningDesign(parsed), (e: unknown) => e instanceof AppError && e.code === 'STORY_REASONING_UNKNOWN_DEPENDENCY')
  assert.equal(acceptStoryReasoningDesign(validateStoryReasoningProposal(proposal(), context)).executed, false)
})
test('stage-specific candidates cannot contain design steps or fake repeated choices', () => {
  const p = proposal(); assert.ok(p.outcome === 'proposal' && 'steps' in p)
  const { steps: _steps, ...common } = p
  const candidate = { ...common, stage: 'action-candidates', options: [{ id: 'option', label: '分类', actionId: 'classify' }] }
  const c = { ...context, stage: 'action-candidates' as const }
  assert.equal(validateStoryReasoningProposal(candidate, c).stage, 'action-candidates')
  assert.throws(() => validateStoryReasoningProposal({ ...candidate, steps: [] }, c), invalid)
  assert.throws(() => validateStoryReasoningProposal({ ...candidate, options: [...candidate.options, { ...candidate.options[0], id: 'another' }] }, c), invalid)
})
test('server-owned locked goal and preview target scope cannot be changed by the model', () => {
  const p = proposal()
  assert.throws(() => validateStoryReasoningProposal(p, { ...context, lockedGoal: '保留原目标' }), invalid)
  assert.throws(() => validateStoryReasoningProposal(p, { ...context, previewTargetIds: ['another-node'] }), invalid)
  assert.equal(validateStoryReasoningProposal(p, { ...context, lockedGoal: '整理图纸', previewTargetIds: ['preview-node'] }).goal!.text, '整理图纸')
})
