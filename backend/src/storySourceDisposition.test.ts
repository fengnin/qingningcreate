import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError } from './qwen.js'
import { confirmProvisionalCurve, updateCurveSourceFactDisposition } from './storyCoCreation.js'
import { requiredDesignProposalIds } from './storyDesignReview.js'
import { createStoryProposalContext } from './storyProposalContext.js'
import { generateCurveFromPreparation } from './storyPreparation.js'
import type { ProvisionalCurve, StorySeed } from '../../shared/story-contract.js'

const code = (name: string) => (e: unknown) => e instanceof AppError && e.code === name
test('unused material decision preserves reviewed structure, but live dependencies and missing coverage remain gated', async () => {
  const material = [
    {id:'goal',role:'goal' as const,sourceId:'author-input',quote:'周汐想按编号整理图纸。'},
    {id:'permission',role:'condition' as const,sourceId:'author-input',quote:'按编号分类获准且不会改变图纸。'},
    {id:'optional',role:'fact' as const,sourceId:'author-input',quote:'也可以保持现状。'},
  ]
  const candidate = {id:'sort',action:'周汐按编号分类图纸。',materialIds:['goal'],preconditionIds:['permission'],possibleResult:'可能按编号归组。',resultBasisIds:['permission'],unknownIds:[]}
  const curve: ProvisionalCurve = {id:'curve',title:'待审',status:'draft',brief:{tones:['growth'],dramaticForces:[],allowSystemNamedCharacters:false},beats:[],instructions:[],createdAt:1,updatedAt:1,
    preparation:{protocol:1,status:'needs-review',sources:[{id:'author-input',text:material.map(m=>m.quote).join('')}],material,candidates:[candidate],questions:[],acceptedCandidateIds:[],executed:false}}
  const oldFetch = globalThis.fetch, oldKey = process.env.DASHSCOPE_API_KEY, oldDisable = process.env.STORY_DISABLE_MODEL
  process.env.DASHSCOPE_API_KEY='stub';process.env.STORY_DISABLE_MODEL='false'
  globalThis.fetch = async(_url,init)=> {
    const request=JSON.parse(String(init?.body))
    const output=request.response_format.json_schema.name.endsWith('-review')
      ? {checks:['boundaries','continuity','causality','closure'].map(criterion=>({criterion,passed:true,evidence:'合同测试桩。'})),issues:[]}
      : {steps:['current-state','trigger','resolution'].map((kind,i)=>({kind,text:i===0?material[0]!.quote:i===1?candidate.action:'图纸按编号归组，未改变图纸。',materialIds:i===2?['permission']:['goal']}))}
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}),{status:200})
  }
  try {
    const prepared = await generateCurveFromPreparation(curve,['sort'])
    const original = structuredClone(prepared), reviewIds = requiredDesignProposalIds(prepared.reasoning!)
    assert.throws(()=>confirmProvisionalCurve(prepared,reviewIds),code('STORY_SOURCE_FACTS_UNRESOLVED'))
    assert.throws(()=>updateCurveSourceFactDisposition(prepared,'optional','integrated'),code('STORY_SOURCE_FACT_NOT_COVERED'))
    const parked = updateCurveSourceFactDisposition(prepared,'optional','parked')
    assert.deepEqual(parked.affectedBeatIds,[])
    assert.deepEqual(parked.curve.foundation,prepared.foundation)
    const confirmed = confirmProvisionalCurve(parked.curve,reviewIds).confirmedCurve
    assert.equal(confirmed.design!.sourceFacts.find(f=>f.id==='optional')!.disposition,'parked')
    const seed: StorySeed = {subject:'周汐',activeSituation:'',lockedGoal:null,lockedFacts:[],worldMode:'realistic-default',expansionScope:'keep-scale',unknowns:[]}
    assert.ok(!createStoryProposalContext(seed,confirmed,[],[]).sourceFacts.some(f=>f.text===material[2]!.quote))
    const dependent = updateCurveSourceFactDisposition(prepared,'permission','parked')
    assert.ok(dependent.affectedBeatIds.length)
    assert.equal(dependent.curve.foundation,undefined)
    assert.throws(()=>confirmProvisionalCurve(dependent.curve,reviewIds),code('STORY_CURVE_FOUNDATION_OUT_OF_DATE'))
    assert.deepEqual(prepared,original)
    assert.throws(()=>updateCurveSourceFactDisposition({...parked.curve,status:'confirmed'},'optional','integrated'))
  } finally {
    globalThis.fetch=oldFetch
    for(const [key,value] of [['DASHSCOPE_API_KEY',oldKey],['STORY_DISABLE_MODEL',oldDisable]])if(value===undefined)delete process.env[key!];else process.env[key!]=value
  }
})
