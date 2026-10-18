import assert from 'node:assert/strict'
import test from 'node:test'
import type { StoryPlan } from '../../shared/story-contract.js'
import { generateStory } from './storyService.js'

// Synthetic confirmed path: this test checks propagation and bounded repair,
// not model story judgment. Real Qwen verification is recorded separately.
const expansionNeeds = [
  { kind: 'setup' as const, anchors: [{ field: 'method' as const, quote: '用随身的戏服伪装，走向出口。' }] },
  { kind: 'payoff' as const, anchors: [{ field: 'change' as const, quote: '仍穿着戏服的阿禾向熟人坦白，躲藏的装扮反倒让这一刻显得坦诚又好笑。' }] },
]
const plan: StoryPlan = {
  seed: { subject: '阿禾', activeSituation: '阿禾想悄悄离开后台。', lockedGoal: '离开后台', lockedFacts: [],
    worldMode: 'realistic-default', expansionScope: 'keep-scale', unknowns: [] },
  predicament: { id: 'p', title: '后台', variationAxis: 'relationship', preservedGoal: '离开后台',
    immediateSituation: '阿禾被熟人堵在后台。', obstacle: '怕被熟人认出', tradeoff: '暴露或等待', urgency: '',
    choice: '是否伪装离开', plausibleCost: '被认出', approaches: [], facts: [], actions: [] },
  approach: { id: 'a', intent: '用随身的戏服伪装后离开', cost: '被认出' },
  headTail: { id: 'h', opening: '阿禾被熟人堵在后台。', openingClue: '随身的戏服', promise: '后台里的小误会',
    climax: '阿禾向熟人坦白', climaxActionId: 'finish', resolution: '熟人让出通道', cost: '被认出',
    transition: { actionId: 'finish', consumedFacts: [], changedFacts: [], introducedFacts: [] } },
  turnHistory: [],
  conclusion: { id: 'end', phase: 'climax', presentation: 'candidate-actions',
    node: { id: 'end-node', title: '坦白', event: '阿禾被认出。', purpose: '坦白后离开', goalState: 'resolved' },
    conflict: { nodeId: 'end-node', conflict: '继续躲藏还是坦白', action: '阿禾坦白', consequence: '熟人让出通道', intensity: 1, anchor: '坦白' },
    narrativeAction: { id: 'finish', intent: '阿禾坦白', source: 'generated', preconditions: [], effects: [] },
    transition: { actionId: 'finish', consumedFacts: [], changedFacts: [], introducedFacts: [] },
    question: null, options: [], canConclude: false, isConclusion: true },
  expansionNeeds,
  creativeFocus: { authority: 'creative-reference', excerpts: ['想写个后台里的小误会。'] },
}

test('final writing and its consistency review receive expansion needs, and a missing setup can be repaired without a new mechanism', async () => {
  const names = ['DASHSCOPE_API_KEY', 'STORY_DISABLE_MODEL'] as const
  const saved = names.map(n => process.env[n]), original = globalThis.fetch
  process.env.DASHSCOPE_API_KEY = 'contract-stub'; process.env.STORY_DISABLE_MODEL = 'false'
  const calls: { system: string; user: string }[] = []
  let writing = 0, reviewing = 0
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const system = request.messages[0].content as string, user = request.messages[1].content as string
    calls.push({ system, user })
    assert.ok(user.includes(JSON.stringify(expansionNeeds)))
    assert.ok(user.includes(JSON.stringify(plan.creativeFocus)))
    assert.match(user, /不得仅以不够有趣/)
    let reply: unknown
    if (system.includes('严谨但不过度保守')) {
      reviewing++
      assert.match(user, /实际路径仍采用/)
      reply = reviewing === 1 ? { isConsistent: false, issues: [{ kind: 'unsupported-critical-detail', pathId: 'body', detail: '使用戏服之前缺少自然铺垫。' }] }
        : { isConsistent: true, issues: [] }
    } else {
      writing++
      assert.match(user, /不是作者新增限制/)
      assert.match(user, /人物或关系变化/)
      assert.match(user, /反差或前后呼应/)
      assert.match(user, /未确定的主要办法、关键选择和结果仍由创作者/)
      if (writing > 1) assert.match(user, /使用戏服之前缺少自然铺垫/)
      reply = { body: writing === 1 ? '阿禾穿上戏服，被熟人认出后坦白，熟人让开了通道。'
        : '阿禾原本来后台送洗好的戏服，包里还剩一件。他披上它走向出口，仍被熟人认出。他扯了扯宽大的戏服，索性挺直身子坦白来意，熟人忍着笑让开了通道。' }
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }))
  }
  try {
    const result = await generateStory({ idea: '想写个后台里的小误会。', plan })
    assert.match(result.body, /送洗好的戏服/)
    assert.deepEqual([writing, reviewing], [2, 2])
    assert.doesNotMatch(result.body, /认证|隐藏功能|特殊权限/)
    assert.equal(calls.length, 4)
  } finally {
    globalThis.fetch = original
    names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i] })
  }
})
