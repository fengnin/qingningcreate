import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapInitialReasoningProposal } from './storyInitialReasoning.js'
import { createStoryDesignRecord, isStoryCurveFoundationCurrent } from './storyDesign.js'
import { attachReasoningQuestions, createRecoveryContext, previewReasoningRecovery, acceptReasoningRecovery } from './storyReasoningRecovery.js'
import { updateCurveBeat, rejectCurveBeat, confirmProvisionalCurve, materializeConfirmedCurve } from './storyCoCreation.js'
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
test('simple prepared story locally regenerates after an author edit and carries its selected direction',async()=>{
 model();const design=createStoryDesignRecord(idea,seed)
 const p=payload({stage:'initial-design',sources:design.sourceFacts.map(s=>({...s,authority:'author-material'})),protectedSteps:[],requiredEditIds:[]},'simple',['beat-current-state','beat-trigger','beat-resolution'])
 const initial=mapInitialReasoningProposal(p,design,brief,{allowSimplePlan:true})
 initial.preparation={protocol:1,status:'accepted-design',executed:false,sources:[{id:'author-input',text:idea}],
   material:[{id:'m0',sourceId:'author-input',role:'goal',quote:idea},{id:'m1',sourceId:'author-input',role:'unknown',quote:'编号的来历尚未确定。'}],
   candidates:[{id:'selected',action:'按编号分类，保留全部图纸。',futureChoice:'是否先交出部分整理结果？',possibleResult:'图纸可以按编号归组。',materialIds:['m0'],preconditionIds:[],resultBasisIds:[],unknownIds:[]}],acceptedCandidateIds:['selected'],questions:[]}
 const edited=updateCurveBeat(initial,'beat-trigger','先记录编号，不丢弃图纸；重复编号也保留。').curve
 const before=structuredClone(edited)
 const {preview}=await previewReasoningRecovery(idea,seed,edited)
 assert.deepEqual(preview.items.map(i=>i.beatId),['beat-resolution'])
 const input=requests.at(-1)!
 assert.equal(input.preparationContext.futureDesign.candidate.futureChoice,'是否先交出部分整理结果？')
 assert.equal(input.preparationContext.authorReservedUnknowns.entries[0].quote,'编号的来历尚未确定。')
 const accepted=acceptReasoningRecovery(edited,preview,Object.fromEntries(preview.items.map(i=>[i.id,'accept'])),[],requiredDesignProposalIds(preview.reasoning!)).curve
 assert.equal(accepted.beats.length,3)
 assert.equal(accepted.beats[1]!.detail,edited.beats[1]!.detail)
 assert.equal(isStoryCurveFoundationCurrent(accepted.foundation,accepted.beats),true)
 assert.ok(confirmProvisionalCurve(accepted,requiredDesignProposalIds(accepted.reasoning!)).confirmedCurve)
 assert.deepEqual(edited,before)
})
test('accepting a regenerated early node restores dependency order in both beats and reasoning',async()=>{
 model();const initial=curve()
 const trigger=initial.beats.find(b=>b.kind==='trigger')!
 const edited={...initial,beats:initial.beats.map(b=>b.id===trigger.id?{...b,status:'stale' as const}:b)}
 const {preview}=await previewReasoningRecovery(idea,seed,edited,['beat-trigger'])
 const accepted=acceptReasoningRecovery(edited,preview,Object.fromEntries(preview.items.map(i=>[i.id,'accept'])),[],requiredDesignProposalIds(preview.reasoning!)).curve
 const order=accepted.beats.filter(b=>b.status!=='rejected').map(b=>b.kind)
 assert.ok(order.indexOf('current-state')<order.indexOf('trigger'))
 assert.ok(order.indexOf('trigger')<order.indexOf('escalation'))
 assert.ok(order.indexOf('escalation')<order.indexOf('climax-choice'))
 assert.ok(order.indexOf('climax-choice')<order.indexOf('resolution'))
 assert.deepEqual(accepted.reasoning && 'steps' in accepted.reasoning ? accepted.reasoning.steps.map(s=>s.kind) : [],order)
 assert.equal(isStoryCurveFoundationCurrent(accepted.foundation,accepted.beats),true)
})
test('explicit author-node rework previews first, requires adoption, preserves other edits and archives replaced text',async()=>{
 model()
 let c=updateCurveBeat(curve(),'beat-trigger','作者版本：先记录编号，保留图纸。').curve
 c=updateCurveBeat(c,'beat-resolution','作者结尾：保留全部图纸并交付。').curve
 const before=structuredClone(c)
 const {preview}=await previewReasoningRecovery(idea,seed,c,['beat-trigger'],'让这次尝试更主动。')
 assert.deepEqual(c,before)
 assert.deepEqual(preview.authorReplacementBeatIds,['beat-trigger'])
 const input=requests.at(-1)!
 assert.equal(input.authorReplacementDrafts[0].text,c.beats.find(b=>b.id==='beat-trigger')!.detail)
 assert.equal(input.feedback,'让这次尝试更主动。')
 assert.ok(!input.context.protectedSteps.some((s:any)=>s.id==='beat-trigger'))
 assert.ok(input.context.protectedSteps.some((s:any)=>s.id==='beat-resolution'))
 const decisions=Object.fromEntries(preview.items.map(i=>[i.id,'accept' as const]))
 assert.throws(()=>acceptReasoningRecovery(c,preview,decisions),code('STORY_DESIGN_REVIEW_REQUIRED'))
 assert.throws(()=>acceptReasoningRecovery(c,{...preview,authorReplacementBeatIds:[]},decisions,[],requiredDesignProposalIds(preview.reasoning!)))
 const declined=acceptReasoningRecovery(c,preview,Object.fromEntries(preview.items.map(i=>[i.id,'reject']))).curve
 assert.deepEqual(declined.beats,c.beats)
 const adopted=acceptReasoningRecovery(c,preview,decisions,[],requiredDesignProposalIds(preview.reasoning!)).curve
 assert.equal(adopted.beats.find(b=>b.id==='beat-trigger')!.source,'system-proposal')
 assert.equal(adopted.beats.find(b=>b.id==='beat-resolution')!.detail,c.beats.find(b=>b.id==='beat-resolution')!.detail)
 assert.equal(adopted.beats.find(b=>b.id==='beat-resolution')!.status,'stale')
 assert.ok(adopted.rejectedProposals!.some(b=>b.detail===c.beats.find(b=>b.id==='beat-trigger')!.detail))
 assert.deepEqual(c,before)
 await assert.rejects(()=>previewReasoningRecovery(idea,seed,c,['beat-current-state']),code('STORY_REASONING_REVIEW_CONFLICT'))
})
test('an author can reject and explicitly replace an edited node while keeping its original text',async()=>{
 model();const c=updateCurveBeat(curve(),'beat-resolution','作者版本：把全部图纸交还。').curve
 const rejected=rejectCurveBeat(c,'beat-resolution','想换一种结局。').curve
 assert.equal(rejected.beats.find(b=>b.id==='beat-resolution')!.status,'rejected')
 assert.equal(rejected.beats.find(b=>b.id==='beat-resolution')!.detail,c.beats.find(b=>b.id==='beat-resolution')!.detail)
 await assert.rejects(()=>previewReasoningRecovery(idea,seed,rejected,['beat-resolution']),code('STORY_REASONING_REVIEW_CONFLICT'))
 const {preview}=await previewReasoningRecovery(idea,seed,rejected,['beat-resolution'],undefined,true)
 const adopted=acceptReasoningRecovery(rejected,preview,Object.fromEntries(preview.items.map(i=>[i.id,'accept'])),[],requiredDesignProposalIds(preview.reasoning!)).curve
 assert.equal(adopted.beats.find(b=>b.id==='beat-resolution')!.status,'proposed')
 const start=updateCurveBeat(curve(),'beat-current-state','作者修改起点。').curve
 assert.throws(()=>rejectCurveBeat(start,'beat-current-state'),code('STORY_CURVE_USER_NODE_REJECT_FORBIDDEN'))
})
test('session API publishes an edited-node replacement only after explicit preview acceptance',async()=>{
 model();const started=await service.startStoryCoCreation({idea,brief,operationId:'explicit-edited-node'})
 const edited=await service.updateSessionCurveBeat({storyId:started.storyId,revision:started.revision,curveId:started.curve.id,beatId:'beat-resolution',detail:'作者版本：把完整图纸装好后归还。'})
 const generated=await service.regenerateSessionCurveBeat({storyId:started.storyId,revision:edited.revision,curveId:started.curve.id,beatId:'beat-resolution',feedback:'保留归还，改变交接方式。'})
 assert.equal(generated.curve.beats.find(b=>b.id==='beat-resolution')!.detail,edited.curve.beats.find(b=>b.id==='beat-resolution')!.detail)
 const preview=generated.pendingCurveRegeneration!
 assert.deepEqual(preview.authorReplacementBeatIds,['beat-resolution'])
 const accepted=await service.resolveSessionCurveDependencies({storyId:started.storyId,revision:generated.revision,curveId:started.curve.id,previewId:preview.id,decisions:Object.fromEntries(preview.items.map(i=>[i.id,'accept'])),acceptedDesignProposalIds:requiredDesignProposalIds(preview.reasoning!)})
 assert.equal(accepted.curve.beats.find(b=>b.id==='beat-resolution')!.detail,preview.items[0]!.newDetail)
 assert.ok(accepted.curve.rejectedProposals!.some(b=>b.detail==='作者版本：把完整图纸装好后归还。'))
})
test('mapping and confirming a previously misordered draft repairs order without changing node text',()=>{
 const c=curve()
 const expected=c.beats.map(b=>b.id)
 const trigger=c.beats.find(b=>b.kind==='trigger')!
 c.beats=[...c.beats.filter(b=>b.id!==trigger.id),trigger]
 assert.ok(c.reasoning && 'steps' in c.reasoning)
 const proposal=structuredClone(c.reasoning)
 assert.ok('steps' in proposal)
 const step=proposal.steps.find(s=>s.id===trigger.id)!
 proposal.steps=[...proposal.steps.filter(s=>s.id!==trigger.id),step]
 proposal.designReview={required:true,acceptedProposalIds:[]}
 c.reasoning=proposal
 c.foundation!.reasoning=structuredClone(proposal)
 const before=structuredClone(c)
 const mapped=mapInitialReasoningProposal(proposal,c.design!,brief)
 assert.deepEqual(mapped.beats.map(b=>b.id),expected)
 const confirmed=confirmProvisionalCurve(c,requiredDesignProposalIds(c.reasoning)).confirmedCurve
 assert.deepEqual(confirmed.beats.map(b=>b.id),expected)
 assert.deepEqual(confirmed.beats.map(b=>b.detail),expected.map(id=>c.beats.find(b=>b.id===id)!.detail))
 assert.deepEqual(c,before)
 assert.equal(isStoryCurveFoundationCurrent(confirmed.foundation,confirmed.beats),true)
 const cyclic=structuredClone(proposal)
 cyclic.steps.find(s=>s.kind==='current-state')!.dependsOn=['beat-resolution']
 assert.throws(()=>mapInitialReasoningProposal(cyclic,c.design!,brief),code('STORY_REASONING_INVALID_OUTPUT'))
})
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
