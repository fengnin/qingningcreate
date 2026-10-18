import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError } from './qwen.js'
import { reasoningEncodingExample, reasoningEditExample, reasoningQuestionExample } from './storyReasoningPrompt.js'
import { parseStoryReasoningWire, storyReasoningWireExample } from './storyReasoningWire.js'
import { acceptStoryReasoningDesign } from './storyReasoningContract.js'
import { reviewReasoningDesign, requiredDesignProposalIds } from './storyDesignReview.js'

const invalid = (e: unknown) => e instanceof AppError && e.code === 'STORY_REASONING_INVALID_OUTPUT'
test('wire2 quotes render exactly once; locked goals are references, stored history remains protocol1', () => {
  for (const { output, context } of [reasoningEncodingExample, reasoningEditExample, reasoningQuestionExample]) {
    const wire = storyReasoningWireExample(output, context), before = structuredClone(wire)
    const parsed = parseStoryReasoningWire(wire, context)
    assert.equal(parsed.protocol, 1); assert.deepEqual(wire, before)
    assert.equal(parsed.goal?.text ?? null, output.goal?.text ?? null)
    assert.deepEqual(parsed.constraints, output.constraints)
    assert.deepEqual(parsed.actions, output.actions)
    if (parsed.outcome === 'proposal') {
      assert.throws(() => acceptStoryReasoningDesign(parsed), (e: unknown) => e instanceof AppError && e.code === 'STORY_DESIGN_REVIEW_REQUIRED')
      assert.equal(acceptStoryReasoningDesign(reviewReasoningDesign(parsed, requiredDesignProposalIds(parsed))).executed, false)
    }
    assert.throws(() => parseStoryReasoningWire(output, context), invalid, 'no online legacy protocol fallback')
  }
})
test('wire2 does not repair source IDs, evidence, author authority, edited nodes or unknown dependencies', () => {
  const { output, context } = reasoningEncodingExample
  for (const change of ['source', 'quote', 'duplicate-text', 'authority', 'unknown', 'executed', 'edit']) {
    const p = storyReasoningWireExample(output, context) as any
    const c = structuredClone(context)
    if (change === 'source') p.constraints[0].content.sourceId = 'not-present'
    if (change === 'quote') p.constraints[0].content.quote += '因此失去权限'
    if (change === 'duplicate-text') p.constraints[0].text = '添加新结果'
    if (change === 'authority') c.sources[0]!.authority = 'author-design' as any
    if (change === 'unknown') p.actions[0].content.unknownIds = ['missing']
    if (change === 'executed') p.transition = { introducedFacts: [] }
    if (change === 'edit') c.protectedSteps.push({ id: 'beat-trigger', text: '作者节点' } as never)
    assert.throws(() => parseStoryReasoningWire(p, c), invalid, change)
  }
})

test('relations need explicit reviewable content; a graph edge is not causal evidence', () => {
  const { output, context } = reasoningEncodingExample
  const p = storyReasoningWireExample(output, context) as any
  p.relations = [{ id: 'rel', relation: 'sequence', fromIds: ['sort'], toIds: ['keep'] }]
  assert.throws(() => parseStoryReasoningWire(p, context), (e: unknown) => invalid(e) && (e as Error).message.includes('content'))
  p.relations[0].content = { kind: 'proposal', text: '提案：分类时保持照片完整。', evidence: [], unknownIds: [] }
  assert.equal(parseStoryReasoningWire(p, context).relations[0]!.basis.kind, 'design-proposal')
})

test('source references recover exact author and edit text without transcription or authority changes', () => {
  const { output, context } = reasoningEncodingExample
  const wire = storyReasoningWireExample(output, context) as any
  wire.constraints[0].content = { kind: 'source', sourceId: 'example-material' }
  wire.actions[0].content.evidence = [{ sourceId: 'example-material' }]
  const before = structuredClone(wire)
  const parsed = parseStoryReasoningWire(wire, context)
  assert.equal(parsed.constraints[0]!.text, context.sources[0]!.text)
  assert.equal(parsed.actions[0]!.basis.kind, 'design-proposal')
  assert.deepEqual(parsed.actions[0]!.basis.kind === 'design-proposal' && parsed.actions[0]!.basis.evidence,
    [{ sourceId: 'example-material', quote: context.sources[0]!.text }])
  assert.deepEqual(wire, before)
  for (const change of ['missing', 'unknown', 'design', 'long', 'injected']) {
    const input = structuredClone(wire), sources = structuredClone(context.sources)
    if (change === 'missing') input.constraints[0].content.sourceId = 'absent'
    if (change === 'unknown') sources[0]!.authority = 'unknown' as any
    if (change === 'design') sources[0]!.authority = 'author-design' as any
    if (change === 'long') sources[0]!.text = '原'.repeat(241)
    if (change === 'injected') input.constraints[0].content.text = '没有授权也已获准。'
    assert.throws(() => parseStoryReasoningWire(input, { ...context, sources }), invalid, change)
  }
})
