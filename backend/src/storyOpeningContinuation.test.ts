import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError } from './qwen.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'
import type { StoryReasoningValidationContext } from '../../shared/story-reasoning-contract.js'

// Migrated from the uncommitted turn + same-model truth-review experiment.
// Original source preserved under tmp-reasoning-baseline-*/ before migration.
// Session revision, focus history and no-ledger-mutation remain covered by
// storyInteractionContract.test.ts and accept-interaction-contract.mjs.
const context: StoryReasoningValidationContext = { stage: 'action-candidates',
  sources: [{ id: 'deadline', text: '归还期限是周六。', authority: 'author-material' }],
  protectedSteps: [], requiredEditIds: [] }
const invalid = (e: unknown) => e instanceof AppError && e.code === 'STORY_REASONING_INVALID_OUTPUT'
test('first-click contract: candidates are unexecuted proposals; old detailed transitions and model approval cannot authorize facts', () => {
  const p = { protocol: 1, stage: 'action-candidates', outcome: 'proposal', status: 'needs-review',
    goal: { id: 'g', text: '审阅下一步', basis: { kind: 'design-proposal', evidence: [], unknownIds: [] } }, constraints: [], relations: [], unknowns: [],
    actions: [{ id: 'a', text: '核对行动条件', basis: { kind: 'design-proposal', evidence: [], unknownIds: [] },
      constraintIds: [], relationIds: [], unknownIds: [], respondsToEditIds: [] }], options: [{ id: 'o', label: '核对', actionId: 'a' }] }
  const before = structuredClone(p), result = validateStoryReasoningProposal(p, context)
  assert.deepEqual(p, before); assert.equal(result.status, 'needs-review')
  assert.ok(!('transition' in result) && !('authorConfirmation' in result))
  assert.throws(() => validateStoryReasoningProposal({ turn: { options: [{ transition: { introducedFacts: [{ statement: '供电已恢复。' }] } }] }, review: { supported: true } }, context), invalid)
  assert.throws(() => validateStoryReasoningProposal({ ...p, review: { supported: true } }, context), invalid)
})
test('information gaps are explicit recoverable review requests, not facts or a model verdict blaming the author', () => {
  const p = { protocol: 1, stage: 'action-candidates', outcome: 'questions', status: 'needs-review', goal: null,
    constraints: [], actions: [], relations: [], unknowns: [{ id: 'gap', question: '行动需要什么条件？', sourceIds: ['deadline'], dependentIds: [] }],
    questions: [{ unknownId: 'gap', dependentIds: [] }] }
  const before = structuredClone(p), result = validateStoryReasoningProposal(p, context)
  assert.equal(result.outcome, 'questions'); assert.deepEqual(p, before)
  assert.ok(!('facts' in result) && !('transition' in result))
  assert.throws(() => validateStoryReasoningProposal({ needsAuthorDetail: ['模型认为作者没提供够资料。'] }, context), invalid)
  assert.throws(() => validateStoryReasoningProposal({ ...p, questions: [{ unknownId: 'missing', dependentIds: [] }] }, context), invalid)
})
