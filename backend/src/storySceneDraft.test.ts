import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError } from './qwen.js'
import { generateSceneDraft, parseSceneReview } from './storySceneDraft.js'

const audit = { checks: ['boundaries', 'causality', 'state', 'scope'].map(criterion => ({ criterion, passed: true, evidence: '测试合同，非语义验收。' })), issues: [] }
test('scene review requires consistent verdicts and repair locations', () => {
  assert.deepEqual(parseSceneReview(audit), [])
  for (const review of [{ ...audit, issues: [{ part: 'development', evidence: '仍有问题。' }] },
    { ...audit, checks: audit.checks.map(c => ({ ...c, passed: false })) }]) {
    assert.throws(() => parseSceneReview(review), (e: unknown) => e instanceof AppError && e.code === 'STORY_PREPARATION_INVALID_OUTPUT')
  }
})

for (const persistent of [false, true]) test(`inconsistent scene review never rewrites the scene (persistent=${persistent})`, async () => {
  const original = globalThis.fetch, saved = { key: process.env.DASHSCOPE_API_KEY, disabled: process.env.STORY_DISABLE_MODEL }
  process.env.DASHSCOPE_API_KEY = 'stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const stages: string[] = [], drafts: unknown[] = []
  let reviews = 0
  const scene = { attempt: { action: '妹妹请哥哥扶梯子，自己挂画。', materialIds: ['m0'], preconditionIds: [] },
    development: { change: '哥哥扶住了梯子。', response: '妹妹爬上去把画挂好。', resultBasisIds: ['m0'] } }
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), stage = request.response_format.json_schema.name, input = JSON.parse(request.messages[1].content)
    stages.push(stage)
    let output: unknown
    if (stage.includes('review')) {
      drafts.push(input.draft); reviews++
      if (reviews === 2) assert.match(input.validationFailure, /只重审原骨架/)
      output = { ...audit, issues: persistent || reviews === 1 ? [{ part: 'development', evidence: '测试矛盾问题列表。' }] : [] }
    } else output = stage.endsWith('intent') ? { goal: '妹妹想挂画。', tension: '梯子需要有人扶住。', focusIds: ['m0'] } : scene
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))
  }
  try {
    const run = () => generateSceneDraft({ sources: [{ id: 'author-input', text: '妹妹想亲手挂画。' }],
      material: [{ id: 'm0', sourceId: 'author-input', role: 'goal', quote: '妹妹想亲手挂画。' }],
      brief: { tones: [], dramaticForces: [], allowSystemNamedCharacters: false }, rejectedCandidates: [] })
    if (persistent) await assert.rejects(run, (e: unknown) => e instanceof AppError && e.code === 'STORY_PREPARATION_INVALID_OUTPUT')
    else assert.equal('attempt' in await run(), true)
    assert.equal(stages.filter(s => s === 'preparation-scene-composition').length, 1)
    assert.equal(reviews, 2); assert.deepEqual(drafts[0], drafts[1])
  } finally {
    globalThis.fetch = original
    if (saved.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = saved.key
    if (saved.disabled === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = saved.disabled
  }
})
