import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError } from './qwen.js'
import { reasoningEncodingExample } from './storyReasoningPrompt.js'
import { parseStoryReasoningWire, storyReasoningWireExample } from './storyReasoningWire.js'
import { reviewReasoningDesign, requiredDesignProposalIds, selectReasoningDesign, reviewSelectedReasoningDesign } from './storyDesignReview.js'
import { acceptStoryReasoningDesign } from './storyReasoningContract.js'
import { mapInitialReasoningProposal } from './storyInitialReasoning.js'
import { createStoryDesignRecord } from './storyDesign.js'
import { confirmProvisionalCurve, materializeConfirmedCurve } from './storyCoCreation.js'

const code = (name: string) => (e: unknown) => e instanceof AppError && e.code === name
test('new creative rule is an explicit rejectable design, not quotation, authority or an executed fact', () => {
  const p = parseStoryReasoningWire(storyReasoningWireExample(reasoningEncodingExample.output, reasoningEncodingExample.context), reasoningEncodingExample.context)
  p.constraints.push({ id: 'new-rule', text: '建议新增：提交前填写确认项；仅在作者接受设定后形成选择压力。', basis: { kind: 'design-proposal', evidence: [], unknownIds: [] } })
  p.actions[0]!.constraintIds.push('new-rule')
  assert.throws(() => acceptStoryReasoningDesign(p), code('STORY_DESIGN_REVIEW_REQUIRED'))
  assert.throws(() => reviewReasoningDesign(p, requiredDesignProposalIds(p).filter(id => id !== 'new-rule')), code('STORY_DESIGN_REVIEW_REQUIRED'))
  const reviewed = reviewReasoningDesign(p, requiredDesignProposalIds(p))
  const accepted = acceptStoryReasoningDesign(reviewed)
  assert.equal(accepted.executed, false); assert.equal(accepted.proposal.constraints.at(-1)!.basis.kind, 'design-proposal')
  assert.ok(!('facts' in accepted)); assert.deepEqual(p.designReview!.acceptedProposalIds, [])
})
test('a model cannot forge design review and acceptance cannot resolve unknown prerequisites', () => {
  const wire = storyReasoningWireExample(reasoningEncodingExample.output, reasoningEncodingExample.context)
  assert.throws(() => parseStoryReasoningWire({ ...wire, designReview: { required: true, acceptedProposalIds: ['sort'] } }, reasoningEncodingExample.context), code('STORY_REASONING_INVALID_OUTPUT'))
  const p = parseStoryReasoningWire(wire, reasoningEncodingExample.context)
  p.unknowns.push({ id: 'gap', question: '许可是否成立？', sourceIds: [], dependentIds: ['sort'] })
  p.actions[0]!.unknownIds = ['gap']
  const reviewed = reviewReasoningDesign(p, requiredDesignProposalIds(p))
  assert.throws(() => acceptStoryReasoningDesign(reviewed), code('STORY_REASONING_UNKNOWN_DEPENDENCY'))
})
test('rejecting a node rejects its design closure; accepted nodes cannot depend on rejected nodes', () => {
  const p = parseStoryReasoningWire(storyReasoningWireExample(reasoningEncodingExample.output, reasoningEncodingExample.context), reasoningEncodingExample.context)
  assert.throws(() => selectReasoningDesign(p, ['beat-resolution']), code('STORY_DESIGN_REJECTED_DEPENDENCY'))
  const selected = selectReasoningDesign(p, ['beat-current-state'])
  assert.equal(selected.actions.length, 0); assert.equal(selected.constraints.length, 0)
  assert.ok(!requiredDesignProposalIds(selected).includes('sort'))
  const reviewed = reviewSelectedReasoningDesign(p, ['beat-current-state'], requiredDesignProposalIds(p))
  assert.ok(!reviewed.designReview!.acceptedProposalIds.includes('sort'), 'unused/rejected designs cannot be recorded as accepted')
})

test('confirming reviewed creative design does not put the new rule or its future consequence in the fact ledger', () => {
  const context = reasoningEncodingExample.context
  const seed = { subject: '许禾', activeSituation: context.sources[0]!.text, lockedGoal: '整理旧照片', lockedFacts: [], worldMode: 'realistic-default' as const, expansionScope: 'keep-scale' as const, unknowns: [] }
  const design = createStoryDesignRecord(seed.activeSituation, seed)
  design.sourceFacts = context.sources.map(s => ({ ...design.sourceFacts[0]!, id: s.id, text: s.text }))
  const p = parseStoryReasoningWire(storyReasoningWireExample(reasoningEncodingExample.output, context), context)
  p.constraints.push({ id: 'new-rule', text: '建议新增先核对数量的整理规则；作者接受后用于设计，不代表已经核对。', basis: { kind: 'design-proposal', evidence: [], unknownIds: [] } })
  p.actions[0]!.constraintIds.push('new-rule')
  const curve = mapInitialReasoningProposal(p, design, { tones: ['growth'], dramaticForces: ['relationship-tension'], allowSystemNamedCharacters: false })
  const before = structuredClone(curve)
  assert.throws(() => confirmProvisionalCurve(curve), code('STORY_DESIGN_REVIEW_REQUIRED'))
  assert.deepEqual(curve, before)
  const confirmed = confirmProvisionalCurve(curve, requiredDesignProposalIds(p)).confirmedCurve
  assert.ok(confirmed.reasoning!.designReview!.acceptedProposalIds.includes('new-rule'))
  const facts = materializeConfirmedCurve(seed, confirmed).predicament.facts
  assert.ok(facts.every(f => context.sources.some(s => s.text === f.statement)))
  assert.ok(!facts.some(f => f.statement.includes('新增')))
  assert.deepEqual(curve, before)
  assert.throws(() => confirmProvisionalCurve({ ...curve, foundation: undefined, design: { ...design, foundation: undefined } }, requiredDesignProposalIds(p)), code('STORY_CURVE_FOUNDATION_OUT_OF_DATE'))
})
