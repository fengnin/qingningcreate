import assert from 'node:assert/strict'
import test from 'node:test'
import { createStoryDesignRecord, isStoryCurveFoundationCurrent } from './storyDesign.js'
import { createInitialReasoningContext, mapInitialReasoningProposal } from './storyInitialReasoning.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'
import { storyReasoningWireExample } from './storyReasoningWire.js'
import { confirmProvisionalCurve, generateProvisionalCurve, materializeConfirmedCurve, regenerateCurveBeat, updateCurveBeat } from './storyCoCreation.js'
import { AppError } from './qwen.js'
import type { CreativeBrief, StorySeed } from '../../shared/story-contract.js'
import type { StoryReasoningProposal } from '../../shared/story-reasoning-contract.js'

const brief: CreativeBrief = { tones: ['growth'], dramaticForces: ['cost'], allowSystemNamedCharacters: false }
const seedFor = (text: string): StorySeed => ({ subject: '作者人物', activeSituation: text, lockedGoal: null, lockedFacts: [],
  worldMode: 'realistic-default', expansionScope: 'keep-scale', unknowns: [] })
const cases = [
  { text: '余禾想修补陶杯；没有完成期限；先测量不会改变杯子。', relation: 'compatible', claim: '先测量不会改变杯子', action: '提案：先记录缺口尺寸，暂不修补。' },
  { text: '温晴想整理船模图纸；按编号分类与不丢弃图纸可以同时做到。', relation: 'compatible', claim: '按编号分类与不丢弃图纸可以同时做到', action: '提案：分类并保留所有图纸。' },
  { text: '陆原想和姐姐共同守店；姐姐希望卖店而陆原希望保留店铺，两人意见冲突。', relation: 'conflict', claim: '姐姐希望卖店而陆原希望保留店铺', action: '提案：先请姐姐说明卖店的理由，再讨论是否保留。' },
] as const

function fixture(text: string, action: string, claim?: string, relation: 'compatible' | 'conflict' = 'compatible'): StoryReasoningProposal {
  const design = createStoryDesignRecord(text, seedFor(text))
  const evidence = design.sourceFacts.map(f => ({ sourceId: f.id, quote: f.text }))
  const proposal = { kind: 'design-proposal' as const, evidence, unknownIds: [] }
  const facts = design.sourceFacts.map((f,i) => ({ id: `c${i}`, text: f.text, basis: { kind: 'author-text' as const, evidence: [{ sourceId: f.id, quote: f.text }] } }))
  return { protocol: 1, stage: 'initial-design', status: 'needs-review', outcome: 'proposal',
    goal: { id: 'goal', text: facts[0]!.text, basis: facts[0]!.basis }, constraints: facts,
    actions: [{ id: 'action', text: action, basis: proposal, constraintIds: facts.map(f => f.id), relationIds: claim ? ['rel'] : [], unknownIds: [], respondsToEditIds: [] }],
    relations: claim ? [{ id: 'rel', text: claim, basis: proposal, relation, fromIds: ['c0'], toIds: ['action'] }] : [], unknowns: [],
    steps: ['current-state','trigger','escalation','climax-choice','resolution'].map((kind,i,all) => ({ id: `beat-${kind}`, kind: kind as 'trigger', title: kind,
      text: i === 0 ? facts[0]!.text : `${action}（设计节点${i}，结果未发生）`, basis: i === 0 ? facts[0]!.basis : proposal,
      actionIds: ['action'], relationIds: claim ? ['rel'] : [], dependsOn: i ? [`beat-${all[i-1]}`] : [], respondsToEditIds: [] })) }
}

test('counterexamples map explicit relations without converting absent deadlines or compatible conditions into losses', () => {
  for (const c of cases) {
    const seed = seedFor(c.text), design = createStoryDesignRecord(c.text, seed)
    const parsed = validateStoryReasoningProposal(fixture(c.text,c.action,c.claim,c.relation), createInitialReasoningContext(design,seed))
    const curve = mapInitialReasoningProposal(parsed,design,brief)
    assert.deepEqual(curve.foundation!.reasoning,parsed)
    assert.equal(curve.foundation!.predicament.urgency,'')
    assert.equal(curve.foundation!.predicament.plausibleCost,'')
    assert.equal(curve.foundation!.conflictCore.obstacle,c.relation === 'conflict' ? c.claim : '')
    assert.equal(isStoryCurveFoundationCurrent(curve.foundation,curve.beats),true)
    const confirmed = confirmProvisionalCurve(curve)
    assert.equal(confirmed.confirmedCurve.reasoning!.status,'needs-review') // design acceptance never becomes an execution
    const materialized = materializeConfirmedCurve(seed,confirmed.confirmedCurve)
    assert.ok(materialized.predicament.facts.every(f => design.sourceFacts.some(s => s.text === f.statement)), 'no proposal in fact ledger')
    const edited = updateCurveBeat(curve,'beat-trigger','作者编辑：先记录缺口，保留全部材料。').curve
    assert.equal(edited.beats.find(b => b.id === 'beat-trigger')!.source,'user-edit')
    assert.equal(edited.foundation,undefined)
    assert.equal(edited.design!.foundation,undefined)
    assert.throws(() => confirmProvisionalCurve(edited), (e: unknown) => e instanceof AppError && e.code === 'STORY_CURVE_FOUNDATION_OUT_OF_DATE')
  }
})

test('online initial entry requests direct structure; legacy IDs, invalid authority and excluded proposals fail without fallback', async () => {
  const env = { STORY_DISABLE_MODEL: process.env.STORY_DISABLE_MODEL, DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY, DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL }
  const fetchBefore = globalThis.fetch
  process.env.STORY_DISABLE_MODEL='false'; process.env.DASHSCOPE_API_KEY='stub'; process.env.DASHSCOPE_BASE_URL='https://stub.invalid'
  const c = cases[0], seed = seedFor(c.text)
  let payload: unknown = fixture(c.text,c.action), calls = 0
  try {
    globalThis.fetch = async (_url,init) => {
      const request = JSON.parse(String(init?.body)); calls++
      assert.match(request.messages[0].content,/服务端不会补写因果/u)
      assert.equal(JSON.parse(request.messages[1].content).context.stage,'initial-design')
      const context = JSON.parse(request.messages[1].content).context
      let wire: unknown = payload
      try { wire = storyReasoningWireExample(payload, context) } catch { /* Deliberately malformed fixture remains rejected. */ }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(wire) } }] }), { status: 200 })
    }
    const curve = await generateProvisionalCurve(c.text,seed,brief)
    assert.equal(curve.generation!.origin,'model'); assert.deepEqual(curve.reasoning,payload)
    await assert.rejects(() => regenerateCurveBeat(c.text,seed,curve,'beat-escalation'), (e: unknown) => e instanceof AppError && e.code === 'STORY_REASONING_REGENERATION_NOT_CONNECTED')
    const failure = (e: unknown) => e instanceof AppError && e.code === 'STORY_CURVE_MODEL_GENERATION_FAILED'
    payload = { curvePlan: { triggerFactId: 'source-fact-1' } }
    await assert.rejects(() => generateProvisionalCurve(c.text,seed,brief),failure)
    payload = fixture(c.text,c.action); (payload as any).constraints[0].text += '因此失去权限。'
    await assert.rejects(() => generateProvisionalCurve(c.text,seed,brief),failure)
    payload = fixture(c.text,c.action)
    await assert.rejects(() => generateProvisionalCurve(c.text,seed,brief,[c.action+'（设计节点1，结果未发生）']),failure)
    assert.ok(calls >= 4)
  } finally {
    globalThis.fetch=fetchBefore
    for (const [key,value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key]=value
  }
})

test('unknowns and question outcomes remain review records; dependent confirmation is blocked', () => {
  const c=cases[0], seed=seedFor(c.text), design=createStoryDesignRecord(c.text,seed), p=fixture(c.text,c.action)
  p.unknowns=[{ id:'missing',question:'名字在哪里？',sourceIds:[],dependentIds:['action'] }]
  p.actions[0]!.basis={kind:'unknown',unknownIds:['missing']}; p.actions[0]!.unknownIds=['missing']
  const curve=mapInitialReasoningProposal(validateStoryReasoningProposal(p,createInitialReasoningContext(design,seed)),design,brief)
  assert.deepEqual(curve.foundation!.reasoning!.unknowns,p.unknowns)
  assert.throws(() => confirmProvisionalCurve(curve), (e: unknown) => e instanceof AppError && e.code === 'STORY_REASONING_UNKNOWN_DEPENDENCY')
  const questions: StoryReasoningProposal={ protocol:1,stage:'initial-design',status:'needs-review',outcome:'questions',goal:null,
    constraints:[],actions:[],relations:[],unknowns:[{id:'missing',question:'希望做什么？',sourceIds:[],dependentIds:[]}],questions:[{unknownId:'missing',dependentIds:[]}] }
  const pending=mapInitialReasoningProposal(validateStoryReasoningProposal(questions,createInitialReasoningContext(design,seed)),design,brief)
  assert.equal(pending.foundation,undefined); assert.deepEqual(pending.reasoning,questions)
  assert.throws(() => confirmProvisionalCurve(pending))
})
