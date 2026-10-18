import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError } from './qwen.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'
import { reasoningEncodingExample, reasoningQuestionExample, reasoningEditExample, storyReasoningSystemPrompt } from './storyReasoningPrompt.js'

test('model-facing full encoding and question examples obey the production contract', () => {
  for (const { output, context } of [reasoningEncodingExample, reasoningQuestionExample, reasoningEditExample]) {
    assert.deepEqual(validateStoryReasoningProposal(output, context), output)
  }
})

test('encoding errors remain errors with field diagnostics; no evidence repair or authority promotion', () => {
  const { output, context } = reasoningEncodingExample
  const before = JSON.stringify(output)
  const invalid = (path: RegExp) => (e: unknown) => e instanceof AppError && e.code === 'STORY_REASONING_INVALID_OUTPUT' && path.test(e.message)
  const short = structuredClone(output)
  short.goal.basis.evidence[0]!.quote = context.sources[0]!.text
  assert.throws(() => validateStoryReasoningProposal(short, context), invalid(/goal\.text/u))
  assert.throws(() => validateStoryReasoningProposal(short, context), invalid(/quote 写为 "整理旧照片"/u))
  for (const added of ['因此获得使用权限', '因此失去署名机会', '与新搭档一起完成']) {
    const p = structuredClone(output); p.goal.text += added
    assert.throws(() => validateStoryReasoningProposal(p, context), invalid(/goal\.text/u))
  }
  const missing = structuredClone(reasoningQuestionExample.output)
  missing.unknowns[0]!.sourceIds = ['constraint-1']
  assert.throws(() => validateStoryReasoningProposal(missing, reasoningQuestionExample.context), invalid(/unknowns\[0\]\.sourceIds/u))
  const unknown = structuredClone(output)
  assert.throws(() => validateStoryReasoningProposal(unknown, { ...context, sources: context.sources.map(s => ({ ...s, authority: 'unknown' as const })) }), invalid(/goal\.basis\.evidence\[0\]/u))
  assert.equal(JSON.stringify(output), before, 'validation never mutates model output')
})

test('stage-specific edit instructions do not require an initial five-node design', () => {
  const initial = storyReasoningSystemPrompt('initial-design'), edit = storyReasoningSystemPrompt('edit-preview')
  assert.match(initial, /stage=initial-design/u)
  assert.match(initial, /初次 proposal 输出5至7个节点/u)
  assert.match(edit, /stage=edit-preview/u)
  assert.match(edit, /仅输出 context.previewTargetIds/u)
  assert.doesNotMatch(edit, /初次 proposal 输出5至7个节点/u)
  assert.match(edit, /author-design 原文逐字/u)
})
