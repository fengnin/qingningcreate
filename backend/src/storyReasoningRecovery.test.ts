import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapInitialReasoningProposal } from './storyInitialReasoning.js'
import { createStoryDesignRecord, isStoryCurveFoundationCurrent } from './storyDesign.js'
import { attachReasoningQuestions, createRecoveryContext, previewReasoningRecovery, acceptReasoningRecovery } from './storyReasoningRecovery.js'
import { updateCurveBeat, confirmProvisionalCurve, materializeConfirmedCurve } from './storyCoCreation.js'
import { changeCurveClarification, confirmCurveClarification } from './storyClarification.js'
import { AppError } from './qwen.js'
import { storyReasoningWireExample } from './storyReasoningWire.js'
import { requiredDesignProposalIds } from './storyDesignReview.js'
import type { StoryReasoningProposal, StoryReasoningValidationContext } from '../../shared/story-reasoning-contract.js'
import type { ProvisionalCurve } from '../../shared/story-contract.js'
const env={...process.env}, fetchBefore=globalThis.fetch
const store=join(mkdtempSync(join(tmpdir(),'reasoning-recovery-tests-')),'sessions.json')
process.env.STORY_SESSION_STORE_PATH=store
const service=await import('./storyService.js')
test.after(()=>{globalThis.fetch=fetchBefore;for(const key of ['STORY_SESSION_STORE_PATH','STORY_DISABLE_MODEL','DASHSCOPE_API_KEY','DASHSCOPE_BASE_URL'])if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key]})
const idea='温晴想整理船模图纸；没有期限；按编号分类与不丢弃图纸可以同时做到。'
const seed={subject:'温晴',activeSituation:idea,lockedGoal:null,lockedFacts:[],worldMode:'realistic-default' as const,expansionScope:'keep-scale' as const,unknowns:[]}
const brief={tones:['growth' as const],dramaticForces:['cost' as const],allowSystemNamedCharacters:false}
let malformed=false, ask=false, hold:((r:Response)=>void)|undefined, entered:(()=>void)|undefined, requests:Record<string,any>[]=[]
function payload(context:StoryReasoningValidationContext,prefix='initial',targets=['beat-current-state','beat-trigger','beat-escalation','beat-climax-choice','beat-resolution']):StoryReasoningProposal{
 const evidence=context.sources.filter(s=>s.authority!=='unknown').map(s=>({sourceId:s.id,quote:s.text}))
 const basis={kind:'design-proposal' as const,evidence,unknownIds:[]}
 const goal={id:`${prefix}-goal`,text:context.lockedGoal??context.sources[0]!.text,basis}
 if(ask)return {protocol:1,stage:context.stage,status:'needs-review',outcome:'questions',goal,actions:[],constraints:[],relations:[],unknowns:[{id:`${prefix}-unknown`,question:'编号重复时是否保留？',sourceIds:[],dependentIds:[]}],questions:[{unknownId:`${prefix}-unknown`,dependentIds:[]}]}
 return {protocol:1,stage:context.stage as 'initial-design'|'edit-preview',status:'needs-review',outcome:'proposal',goal,constraints:[],relations:[],unknowns:[],
 actions:[{id:`${prefix}-action`,text:'提案：记录编号，保留全部图纸。',basis,constraintIds:[],relationIds:[],unknownIds:[],respondsToEditIds:context.requiredEditIds}],
 steps:targets.map((id,i)=>({id,kind:id.replace('beat-','') as 'trigger',title:'待审设计',text:`提案${i}：记录编号并保留全部图纸。`,basis,actionIds:[`${prefix}-action`],relationIds:[],respondsToEditIds:context.requiredEditIds,
 dependsOn:i?[targets[i-1]!]:context.protectedSteps.filter(s=>context.requiredEditIds.includes(s.id)).map(s=>s.id)}))}
}
function model(){process.env.STORY_DISABLE_MODEL='false';process.env.DASHSCOPE_API_KEY='contract-stub';process.env.DASHSCOPE_BASE_URL='https://stub.invalid'
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));const prompt=JSON.parse(body.messages[1].content);requests.push(prompt)
   if(entered){entered();entered=undefined;return new Promise<Response>(r=>{hold=r})}
   return response(malformed?{curvePlan:{}}:storyReasoningWireExample(payload(prompt.context,prompt.prefix,prompt.targets),prompt.context))}
}
const response=(p:unknown)=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(p)}}]}),{status:200})
const code=(name:string)=>(e:unknown)=>e instanceof AppError&&e.code===name
function curve():ProvisionalCurve{const design=createStoryDesignRecord(idea,seed);return mapInitialReasoningProposal(payload({stage:'initial-design',sources:design.sourceFacts.map(s=>({...s,authority:'author-material'})),protectedSteps:[],requiredEditIds:[]}),design,brief)}
test('edited preview preserves author nodes, reconstructs structure/foundation, and never makes a design fact',async()=>{
 model();const c=updateCurveBeat(curve(),'beat-trigger','作者编辑：先记录编号，不丢弃任何图纸。').curve,before=structuredClone(c)
 const {preview}=await previewReasoningRecovery(idea,seed,c)
 assert.deepEqual(c,before);assert.ok(preview.items.length)
 assert.ok(requests.at(-1)!.context.sources.some((s:any)=>s.authority==='author-design'&&s.text===c.beats[1]!.detail))
 const hidden=structuredClone(preview)
 if (hidden.reasoning!.outcome==='proposal' && 'steps' in hidden.reasoning!) {
   const p=hidden.reasoning!
   const qid=hidden.id+'-gap',cid=hidden.id+'-constraint'
   p.unknowns.push({id:qid,question:'未经确认的权限？',sourceIds:[],dependentIds:[cid]})
   p.constraints.push({id:cid,text:'权限待确认。',basis:{kind:'unknown',unknownIds:[qid]}})
   p.actions[0]!.constraintIds.push(cid)
 }
 assert.throws(()=>acceptReasoningRecovery(c,hidden,Object.fromEntries(hidden.items.map(i=>[i.id,'accept']))),code('STORY_REASONING_REVIEW_CONFLICT'))
 assert.throws(()=>acceptReasoningRecovery(c,preview,Object.fromEntries(preview.items.map(i=>[i.id,'accept']))),code('STORY_DESIGN_REVIEW_REQUIRED'))
 const accepted=acceptReasoningRecovery(c,preview,Object.fromEntries(preview.items.map(i=>[i.id,'accept'])),[],requiredDesignProposalIds(preview.reasoning!)).curve
 assert.deepEqual(c,before);assert.equal(accepted.beats.find(b=>b.id==='beat-trigger')!.detail,c.beats.find(b=>b.id==='beat-trigger')!.detail)
 assert.equal(isStoryCurveFoundationCurrent(accepted.foundation,accepted.beats),true)
 const confirmed=confirmProvisionalCurve(accepted,requiredDesignProposalIds(accepted.reasoning!)).confirmedCurve
 const facts=materializeConfirmedCurve(seed,confirmed).predicament.facts
 assert.ok(facts.every(f=>c.design!.sourceFacts.some(s=>s.text===f.statement)))
 assert.ok(!facts.some(f=>f.statement.startsWith('作者编辑')))
 assert.throws(()=>acceptReasoningRecovery({...c,updatedAt:1,instructions:[...c.instructions,{id:'changed',kind:'replace',text:'改变',createdAt:1}]},preview,Object.fromEntries(preview.items.map(i=>[i.id,'accept']))),code('STORY_REASONING_REVIEW_CONFLICT'))
})
test('unknown declaration, independent author review, rejected previews and confirmed raw answer have separate authority',async()=>{
 model();let c=curve();c=changeCurveClarification(c,{storyId:'s',revision:0,curveId:c.id,action:'create',targetBeatId:'beat-trigger',causalGap:c.beats[1]!.detail,prompt:'为何必须丢弃？'}).curve
 const id=c.clarifications![0]!.id
 await assert.rejects(()=>previewReasoningRecovery(idea,seed,c,['beat-trigger']),code('STORY_CLARIFICATION_REVIEW_REQUIRED'))
 c=changeCurveClarification(c,{storyId:'s',revision:0,curveId:c.id,action:'declare-unknown',clarificationId:id,answerText:'  目前不确定。\n'}).curve
 c=changeCurveClarification(c,{storyId:'s',revision:0,curveId:c.id,action:'request-independent-proposal',clarificationId:id}).curve
 const {preview}=await previewReasoningRecovery(idea,seed,c,['beat-trigger'])
 const decisions=Object.fromEntries(preview.items.map(i=>[i.id,'accept' as const]))
 assert.throws(()=>acceptReasoningRecovery(c,preview,decisions),code('STORY_REASONING_REVIEW_CONFLICT'))
 const rejected=acceptReasoningRecovery(c,preview,Object.fromEntries(preview.items.map(i=>[i.id,'reject']))).curve
 assert.equal(rejected.clarifications![0]!.resolution,undefined)
 const independent=acceptReasoningRecovery(c,preview,decisions,[id],requiredDesignProposalIds(preview.reasoning!)).curve
 assert.equal(independent.clarifications![0]!.status,'author-unknown');assert.equal(independent.clarifications![0]!.answerText,'  目前不确定。\n')
 assert.equal(independent.clarifications![0]!.resolution,'independent-proposal-accepted')
 assert.ok(!independent.design!.sourceFacts.some(f=>f.text.includes('不确定')))
 c=changeCurveClarification(c,{storyId:'s',revision:0,curveId:c.id,action:'save-answer',clarificationId:id,answerText:'  重复编号也保留全部图纸。\n'}).curve
 assert.ok(!c.design!.sourceFacts.some(f=>f.text.includes('重复编号')))
 c=confirmCurveClarification(c,id).curve
 const context=createRecoveryContext(c,['beat-trigger']);assert.ok(context.sources.some(s=>s.text==='  重复编号也保留全部图纸。\n'&&s.authority==='author-material'))
 const rebuilt=await previewReasoningRecovery(idea,seed,c,['beat-trigger'])
 const applied=acceptReasoningRecovery(c,rebuilt.preview,Object.fromEntries(rebuilt.preview.items.map(i=>[i.id,'accept'])),[],requiredDesignProposalIds(rebuilt.preview.reasoning!)).curve
 assert.equal(applied.clarifications![0]!.resolution,'answer-applied')
})
test('question-only recovery is visible, author unknown remains unknown and independent recovery has no executed facts',async()=>{
 model();ask=true;const initial=await service.startStoryCoCreation({idea,brief,operationId:'questions'})
 const c=initial.curve;assert.equal(c.beats.length,0);assert.equal(c.clarifications!.length,1)
 let changed=await service.updateSessionCurveClarification({storyId:initial.storyId,revision:initial.revision,curveId:c.id,action:'declare-unknown',clarificationId:c.clarifications![0]!.id})
 changed=await service.updateSessionCurveClarification({storyId:initial.storyId,revision:changed.revision,curveId:c.id,action:'request-independent-proposal',clarificationId:c.clarifications![0]!.id})
 ask=false;const preview=await service.regenerateSessionCurveDependencies({storyId:initial.storyId,revision:changed.revision,curveId:c.id})
 const accepted=await service.resolveSessionCurveDependencies({storyId:initial.storyId,revision:preview.revision,curveId:c.id,previewId:preview.pendingCurveRegeneration!.id,
 independentUnknownIds:[c.clarifications![0]!.id],acceptedDesignProposalIds:requiredDesignProposalIds(preview.pendingCurveRegeneration!.reasoning!),decisions:Object.fromEntries(preview.pendingCurveRegeneration!.items.map(i=>[i.id,'accept']))})
 assert.equal(accepted.curve.beats.length,5);assert.equal(accepted.curve.clarifications![0]!.status,'author-unknown')
 assert.equal(service.getStorySessionSnapshot(initial.storyId).currentTurn,undefined)
})
test('malformed output and in-flight revision changes leave session intact; persistence failure cannot publish accepted design',async()=>{
 model();const s=await service.startStoryCoCreation({idea,brief,operationId:'failure'})
 let edited=await service.updateSessionCurveBeat({storyId:s.storyId,revision:s.revision,curveId:s.curve.id,beatId:'beat-trigger',detail:'作者编辑：保留图纸。'})
 let before=service.getStorySessionSnapshot(s.storyId);malformed=true
 await assert.rejects(()=>service.regenerateSessionCurveDependencies({storyId:s.storyId,revision:edited.revision,curveId:s.curve.id}),code('QWEN_OUTPUT_SCHEMA_FAILED'))
 assert.deepEqual(service.getStorySessionSnapshot(s.storyId),before);malformed=false
 let signal!:()=>void;const seen=new Promise<void>(r=>{signal=r});entered=signal
 const pending=service.regenerateSessionCurveDependencies({storyId:s.storyId,revision:edited.revision,curveId:s.curve.id});const rejected=assert.rejects(pending,code('STORY_SESSION_CONFLICT'))
 await seen;edited=await service.updateSessionCurveBeat({storyId:s.storyId,revision:edited.revision,curveId:s.curve.id,beatId:'beat-trigger',detail:'作者编辑：保留并编号图纸。'})
 const req=requests.at(-1)!;hold!(response(storyReasoningWireExample(payload(req.context,req.prefix,req.targets),req.context)));await rejected
 assert.equal(service.getStorySessionSnapshot(s.storyId).pendingCurveRegeneration,undefined)
 const preview=await service.regenerateSessionCurveDependencies({storyId:s.storyId,revision:edited.revision,curveId:s.curve.id})
 before=service.getStorySessionSnapshot(s.storyId);const persisted=readFileSync(store,'utf8');mkdirSync(store+'.tmp')
 await assert.rejects(()=>service.resolveSessionCurveDependencies({storyId:s.storyId,revision:preview.revision,curveId:s.curve.id,previewId:preview.pendingCurveRegeneration!.id,acceptedDesignProposalIds:requiredDesignProposalIds(preview.pendingCurveRegeneration!.reasoning!),decisions:Object.fromEntries(preview.pendingCurveRegeneration!.items.map(i=>[i.id,'accept']))}),code('STORY_SESSION_PERSIST_FAILED'))
 assert.deepEqual(service.getStorySessionSnapshot(s.storyId),before);assert.equal(readFileSync(store,'utf8'),persisted)
})
