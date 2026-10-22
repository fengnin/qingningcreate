import assert from 'node:assert/strict'
import test from 'node:test'
import { generateAuthorRevisedBeat } from './storyAuthorRevision.js'
import { createProvisionalCurveFallback } from './storyCoCreation.js'

test('author requirements produce scene text without mutating the curve; echo and failed requests cannot replace it', async () => {
  const beforeFetch = globalThis.fetch
  const beforeEnv = { ...process.env }
  const keys = ['STORY_DISABLE_MODEL', 'DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL'] as const
  process.env.STORY_DISABLE_MODEL = 'false'
  process.env.DASHSCOPE_API_KEY = 'test-key'
  process.env.DASHSCOPE_BASE_URL = 'https://stub.invalid'
  try {
    const idea = '余禾想和姐姐整理书架。'
    const curve = createProvisionalCurveFallback(idea, { subject: '余禾', activeSituation: idea, lockedGoal: idea,
      lockedFacts: [], worldMode: 'realistic-default', expansionScope: 'keep-scale', unknowns: [] },
      { tones: [], dramaticForces: [], allowSystemNamedCharacters: false })
    const target = curve.beats.find(b => b.kind === 'trigger')!
    const before = structuredClone(curve)
    const instruction = '让两人先讨论分工，再开始整理。'
    let detail = '余禾和姐姐把书摊开，商量好一人核对编号、一人归架，随后从第一层开始整理。'
    let generationCount = 0
    let rejectCount = 0
    let invalidReview = false
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const prompt = JSON.parse(body.messages[1].content)
      assert.equal(prompt.instruction, instruction)
      const stage = body.response_format.json_schema.name
      const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 })
      if (stage === 'author-design-requirements') return response({ requirements: ['先明确分工，再开始整理'] })
      if (stage === 'author-design-requirement-review') {
        assert.equal(prompt.requirements[0], instruction, 'complete instruction must survive requirement extraction')
        const verdict = rejectCount-- > 0 ? 'unmet' : 'met'
        return response({ checks: prompt.requirements.map((_: string, index: number) => ({ requirementIndex: invalidReview ? 40 : index, verdict, reason: verdict === 'met' ? '先分工再整理，顺序明确' : '开始整理后才讨论分工，顺序反转' })) })
      }
      generationCount++
      assert.equal(prompt.target.detail, target.detail)
      assert.ok(prompt.currentDesign.some((b: { id: string }) => b.id === target.id))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ detail }) } }] }), { status: 200 })
    }
    assert.equal(await generateAuthorRevisedBeat(idea, curve, target, instruction), detail)
    assert.deepEqual(curve, before)
    rejectCount = 1
    generationCount = 0
    assert.equal(await generateAuthorRevisedBeat(idea, curve, target, instruction), detail)
    assert.equal(generationCount, 2, 'unfulfilled requirements trigger one local regeneration')
    rejectCount = 2
    generationCount = 0
    await assert.rejects(generateAuthorRevisedBeat(idea, curve, target, instruction), { code: 'STORY_AUTHOR_REVISION_REQUIREMENTS_UNMET' })
    assert.equal(generationCount, 2, 'persistent mismatch cannot loop or publish')
    assert.deepEqual(curve, before)
    invalidReview = true
    await assert.rejects(generateAuthorRevisedBeat(idea, curve, target, instruction), { code: 'STORY_AUTHOR_REVISION_REVIEW_UNAVAILABLE' })
    invalidReview = false
    detail = `提案：${curve.beats.find(b => b.kind === 'current-state')!.detail}`
    generationCount = 0
    await assert.rejects(generateAuthorRevisedBeat(idea, curve, target, instruction), { code: 'STORY_AUTHOR_REVISION_REQUIREMENTS_UNMET' })
    assert.equal(generationCount, 2, 'copying another beat must fail even when requirement review passes')
    assert.deepEqual(curve, before)
    detail = instruction
    await assert.rejects(generateAuthorRevisedBeat(idea, curve, target, instruction), { code: 'STORY_AUTHOR_REVISION_INVALID_OUTPUT' })
    assert.deepEqual(curve, before)
    globalThis.fetch = async () => { throw new Error('network unavailable') }
    await assert.rejects(generateAuthorRevisedBeat(idea, curve, target, instruction))
    assert.deepEqual(curve, before)
  } finally {
    globalThis.fetch = beforeFetch
    for (const key of keys) {
      if (beforeEnv[key] === undefined) delete process.env[key]
      else process.env[key] = beforeEnv[key]
    }
  }
})
