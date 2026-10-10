import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError } from './qwen.js'
import { reasoningEncodingExample, reasoningEditExample, reasoningQuestionExample } from './storyReasoningPrompt.js'
import { parseStoryReasoningWire, storyReasoningWireExample } from './storyReasoningWire.js'
import { acceptStoryReasoningDesign } from './storyReasoningContract.js'

const invalid = (e: unknown) => e instanceof AppError && e.code === 'STORY_REASONING_INVALID_OUTPUT'
test('wire2 quotes render exactly once; locked goals are references, stored history remains protocol1', () => {
  for (const { output, context } of [reasoningEncodingExample, reasoningEditExample, reasoningQuestionExample]) {
    const wire = storyReasoningWireExample(output, context), before = structuredClone(wire)
    const parsed = parseStoryReasoningWire(wire, context)
    assert.equal(parsed.protocol, 1); assert.deepEqual(wire, before)
    assert.equal(parsed.goal?.text ?? null, output.goal?.text ?? null)
    assert.deepEqual(parsed.constraints, output.constraints)
    assert.deepEqual(parsed.actions, output.actions)
    if (parsed.outcome === 'proposal') assert.equal(acceptStoryReasoningDesign(parsed).executed, false)
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
