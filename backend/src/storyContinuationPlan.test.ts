import assert from 'node:assert/strict'
import test from 'node:test'
import { decideContinuation, composeContinuation, auditContinuation } from './storyContinuationPlan.js'
import { AppError, requestQwenJson } from './qwen.js'
import { createStoryProposalContext } from './storyProposalContext.js'

// Contract fixtures only; they do not demonstrate real model story quality.
const context = { subject: '小岚', goal: '教奶奶自拍',
  sourceFacts: [{ id: 'author-1', text: '小岚想教奶奶自拍', authority: 'author-material' as const },
    { id: 'actual-result', text: '奶奶移开了拇指，但手机朝向天花板。', authority: 'author-confirmed-result' as const }],
  authorEdits: [], designBeats: [{ id: 'design-only', text: '奶奶缩回手' }], unresolvedQuestions: [], selectedFocus: [],
  executedHistory: [{ turnId: 't1', actionText: '示范握姿', resultText: '奶奶移开了拇指，但手机朝向天花板。', factId: 'actual-result' }],
  lastAuthorConfirmedResult: { turnId: 't1', actionText: '示范握姿', resultText: '奶奶移开了拇指，但手机朝向天花板。', factId: 'actual-result' },
  referenceContract: { sourceFactIds: ['author-1','actual-result'], designOnlyIds: ['design-only'], unconfirmedQuestionIds: [] },
  priorities: [], chronology: { initialMaterial: '', confirmedResults: '', reviewedDesign: '' } } as unknown as ReturnType<typeof createStoryProposalContext>
const route = { route: 'action', unresolved: '奶奶还不知道怎样把手机朝向自己。', reason: '拇指已移开，当前问题是朝向。', sourceIds: ['e1'], contradictions: [] }
const option = { label: '看屏幕调整', action: '小岚请奶奶看着屏幕，把手机慢慢转向自己的脸。', proposedConsequence: '奶奶把自己的脸移回画面，试着保持手机朝向。' }
const audit = { checks: ['continuity','causality','requirements','author-control'].map(criterion => ({ criterion, passed: true, evidence: '合同桩，非真实内容验收。' })), issues: [] }
async function mock(run: (calls: any[]) => Promise<void>, respond: (prompt: string, body: any) => unknown) {
  const original = globalThis.fetch, names = ['DASHSCOPE_API_KEY','STORY_DISABLE_MODEL','QWEN_MODEL'] as const
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]])), calls: any[] = []
  process.env.DASHSCOPE_API_KEY = 'contract-stub'; process.env.STORY_DISABLE_MODEL = 'false'; process.env.QWEN_MODEL = 'qwen-plus'
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), prompt = request.messages[0].content, body = JSON.parse(request.messages[1].content)
    assert.equal(request.enable_thinking, false)
    calls.push({ prompt, body })
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(respond(prompt, body)) } }] }))
  }
  try { await run(calls) } finally {
    globalThis.fetch = original
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n] }
  }
}
test('routing owns state; writer gets no internal fact pointers, prior predictions or outlet schemas', async () => {
  await mock(async calls => {
    const decision = await decideContinuation(context)
    assert.equal(decision.basis.latestResultFactId, 'actual-result')
    const plan = await composeContinuation(context, decision)
    assert.deepEqual(plan.options[0]!.sourceFactIds, ['actual-result'])
    assert.deepEqual(plan.options[0]!.causalClaims, [])
    await auditContinuation(context, decision, plan)
    assert.equal(calls.length, 3)
    const serialized = JSON.stringify(calls.map(c => c.body))
    assert.doesNotMatch(serialized, /actual-result|design-only|奶奶缩回手|latestResultFactId|referenceContract/)
    assert.doesNotMatch(JSON.stringify(calls[1].body), /"e[0-9]+"|"evidence"|"authority"/)
  }, prompt => prompt.includes('续推出口判断') ? route : prompt.includes('共创提案编辑') ? { options: [option] } : audit)
})
test('closure never invokes action generation; reviewer is explicitly told not to demand more action', async () => {
  await mock(async calls => {
    const decision = await decideContinuation(context), plan = await composeContinuation(context, decision)
    assert.deepEqual(plan.options, []); assert.equal(plan.authorReview, null)
    await auditContinuation(context, decision, plan)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].body.reviewMode, 'closure')
    assert.match(calls[1].prompt, /不要求新动作/)
  }, prompt => prompt.includes('续推出口判断') ? { ...route, route: 'closure', sourceIds: [], unresolved: '作者已经确认完成，等待收束。' } : audit)
})
test('question remains separate from role options and has only one easy author question', async () => {
  await mock(async calls => {
    const plan = await composeContinuation(context, await decideContinuation(context))
    assert.deepEqual(plan.options, [])
    assert.deepEqual(plan.authorReview?.questions, ['你想让下一段发生在哪里，还是先保留未知？'])
    assert.equal(calls.length, 2)
  }, prompt => prompt.includes('续推出口判断') ? { ...route, route: 'question' } : { questions: ['你想让下一段发生在哪里，还是先保留未知？'] })
})
test('invalid reference only repairs routing; writer cannot manufacture transition or receipt fields', async () => {
  let routing = 0, writing = 0
  await mock(async calls => {
    const decision = await decideContinuation(context)
    const plan = await composeContinuation(context, decision)
    assert.equal(plan.basis.latestResultFactId, 'actual-result')
    assert.equal(routing, 2); assert.equal(writing, 2)
    assert.ok(calls[1].body.validationFailure)
    assert.ok(calls[3].body.validationFailure)
  }, prompt => {
    if (prompt.includes('续推出口判断')) return ++routing === 1 ? { ...route, sourceIds: ['design-only'] } : route
    return { options: [++writing === 1 ? { ...option, transition: { introducedFacts: [] } } : option] }
  })
})
test('length termination is classified as truncation, not JSON failure, and never repeated at the same cap', async () => {
  const original = globalThis.fetch, key = process.env.DASHSCOPE_API_KEY, disabled = process.env.STORY_DISABLE_MODEL
  process.env.DASHSCOPE_API_KEY = 'contract-stub'; process.env.STORY_DISABLE_MODEL = 'false'
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{' } }] })) }
  try {
    await assert.rejects(() => requestQwenJson({ systemPrompt: '输出JSON', userPrompt: '{}' }), (e: unknown) => e instanceof AppError && e.code === 'QWEN_OUTPUT_TRUNCATED')
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = original
    if (key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = key
    if (disabled === undefined) delete process.env.STORY_DISABLE_MODEL; else process.env.STORY_DISABLE_MODEL = disabled
  }
})
