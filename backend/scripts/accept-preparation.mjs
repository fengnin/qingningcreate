import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, mkdirSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
const backend=resolve(fileURLToPath(new URL('..',import.meta.url)))
const artifact=mkdtempSync(join(tmpdir(),'story-preparation-'))
let store=join(artifact,'sessions.json')
const {build}=createRequire(new URL('../../frontend/package.json',import.meta.url))('esbuild')
const browserFile=join(artifact,'api.mjs')
await build({entryPoints:[resolve(backend,'../frontend/src/story/storyApi.ts')],outfile:browserFile,bundle:true,platform:'node',format:'esm'})
const idea='齐朔想整理底片；按编号分类不会改动底片；没有期限；拍摄日期尚未确定。'
const material=idea.split('；').map((quote,i)=>({id:'m'+i,sourceId:'author-input',quote,role:i===0?'goal':i===3?'unknown':'condition'}))
const candidate={id:'sort',action:'齐朔按编号分类底片。',materialIds:['m0','m1'],preconditionIds:['m1'],possibleResult:'按编号分类后，底片可能按编号归组而不被改动；日期仍未知。',resultBasisIds:['m1'],unknownIds:[]}
let child,base,calls=0,bad=false,hold,release,expectedReview
const stub=createServer(async(req,res)=>{
 const chunks=[];for await(const c of req)chunks.push(c)
 const request=JSON.parse(Buffer.concat(chunks));calls++;assert.equal(request.model,'qwen-plus')
 const prompt=request.messages[0].content
 if(expectedReview && !prompt.includes('先整理作者材料') && !prompt.includes('最小行动候选')) {
   const input=JSON.parse(request.messages[1].content)
   assert.deepEqual(input.authorReview,expectedReview)
   assert.equal(input.acceptedCandidates[0].possibleResult,expectedReview.candidates[0].possibleResult)
   assert.equal(input.brief,undefined)
 }
 if(hold){hold();await new Promise(r=>release=r)}
 const out=prompt.includes('先整理作者材料')?{material}:prompt.includes('最小行动候选')?{candidates:[candidate,{...candidate,id:'date',action:'按拍摄日期归档',unknownIds:['q']}],questions:[{id:'q',question:'这些底片的拍摄日期是什么？',materialIds:['m3']}]}
 :{steps:['current-state','trigger','resolution'].map((kind,i)=>{const content=i===0?material[0].quote:i===1?candidate.action:(expectedReview?.candidates[0].possibleResult??candidate.possibleResult);return {kind,title:content,text:content,candidateIds:i?[bad?'not-reviewed':'sort']:[],materialIds:['m0','m1','m2']}}),supplements:[
   {id:'check',kind:'criterion',text:'建议增加分组检查标准。',question:'作者是否希望增加这个标准？',materialIds:['m1']},
   {id:'observe',kind:'observation',text:'建议观察底片编号。',question:'作者是否增加观察步骤？',materialIds:['m1']},
   {id:'hypothesis',kind:'hypothesis',text:'建议审阅编号可能难以辨认的假设。',question:'作者是否确认这个设计？',materialIds:['m1']},
 ]}
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(out)}}]}))
})
await new Promise(r=>stub.listen(0,'127.0.0.1',r))
async function start(disabled=false){
 if(child?.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill()})
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));base=`http://127.0.0.1:${port}`
 child=spawn(process.execPath,['dist/server.js'],{cwd:backend,windowsHide:true,env:{...process.env,PORT:String(port),STORY_DISABLE_MODEL:String(disabled),DASHSCOPE_API_KEY:'contract-stub',QWEN_MODEL:'qwen-plus',DASHSCOPE_BASE_URL:`http://127.0.0.1:${stub.address().port}`,STORY_SESSION_STORE_PATH:store}})
 const log=createWriteStream(join(artifact,'backend-'+port+'.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});child.once('exit',()=>log.end())
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('backend exited');try{if((await fetch(base+'/health')).ok)return}catch{}await delay(100)}throw Error('health timeout')
}
async function api(path,body,status=200,code){const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const p=await r.json();assert.equal(r.status,status,JSON.stringify(p));if(code)assert.equal(p.error.code,code);return p}
const ref=s=>({storyId:s.storyId,revision:s.revision,curveId:s.curve.id})
const snapshot=id=>api('/api/story/session/'+id)
const startBody={idea,generationMode:'review-actions',brief:{tones:['growth'],dramaticForces:[],allowSystemNamedCharacters:false}}
try{
 await start();const s=await api('/api/story/co-create/start',startBody)
 assert.equal(calls,2);assert.equal(s.curve.beats.length,0);assert.equal(s.curve.preparation.executed,false)
 globalThis.fetch=((original)=> (url,init)=>original(typeof url==='string'&&url.startsWith('/api/')?base+url:url,init))(globalThis.fetch)
 const browser=await import('file:///'+browserFile.replaceAll('\\','/'))
 assert.equal((await browser.requestStorySession(s.storyId)).curve.preparation.status,'needs-review')
 const before=await snapshot(s.storyId),stored=readFileSync(store,'utf8')
 await api('/api/story/curve/confirm',ref(s),409,'STORY_PREPARATION_NOT_ACCEPTED')
 await api('/api/story/curve/start-spine',ref(s),409,'STORY_CURVE_NOT_CONFIRMED')
 await api('/api/story/preparation/accept',{...ref(s),acceptedCandidateIds:['date']},409,'STORY_PREPARATION_UNKNOWN_DEPENDENCY')
 assert.equal(calls,2);assert.deepEqual(await snapshot(s.storyId),before)
 bad=true;await api('/api/story/preparation/accept',{...ref(s),acceptedCandidateIds:['sort']},502,'STORY_PREPARATION_INVALID_OUTPUT');bad=false
 assert.deepEqual(await snapshot(s.storyId),before);assert.equal(readFileSync(store,'utf8'),stored)
 const entered=new Promise(r=>hold=r)
 const pending=api('/api/story/preparation/accept',{...ref(s),acceptedCandidateIds:['sort']},409,'STORY_SESSION_CONFLICT')
 await entered;hold=undefined
 const changed=await api('/api/story/co-create/start',{...startBody,storyId:s.storyId,revision:s.revision,versionMode:'replace-draft'})
 release();await pending;assert.equal((await snapshot(s.storyId)).revision,changed.revision)
 const body={...ref(changed),acceptedCandidateIds:['sort']}
 mkdirSync(store+'.tmp')
 const disk=readFileSync(store,'utf8');await api('/api/story/preparation/accept',body,503,'STORY_SESSION_PERSIST_FAILED')
 assert.equal(readFileSync(store,'utf8'),disk);assert.equal((await snapshot(s.storyId)).curve.preparation.status,'needs-review')
 // Retain injected-failure artifact. A separate store/session validates success.
 await start();assert.equal((await browser.requestStorySession(s.storyId)).curve.preparation.status,'needs-review')
 assert.equal((await snapshot(s.storyId)).revision,changed.revision)
 store=join(artifact,'success-sessions.json');await start()
 const fresh=await api('/api/story/co-create/start',startBody)
 expectedReview={originalText:'只接受未来按编号分类；可能归组，也可能仍有无法辨认的编号；尚未动手。',candidates:[{id:'sort',action:candidate.action,possibleResult:'分类后可能按编号归组，无法辨认的编号仍待核对。'}]}
 const freshSnapshot=await snapshot(fresh.storyId)
 await api('/api/story/preparation/accept',{...ref(fresh),acceptedCandidateIds:['sort'],authorReview:{...expectedReview,candidates:[]}},400,'INVALID_REQUEST')
 assert.deepEqual(await snapshot(fresh.storyId),freshSnapshot)
 let accepted=await api('/api/story/preparation/accept',{...ref(fresh),acceptedCandidateIds:['sort'],authorReview:expectedReview})
 assert.equal(accepted.revision,fresh.revision+1);assert.equal(accepted.curve.preparation.status,'accepted-design');assert.equal(accepted.curve.preparation.executed,false)
 assert.equal((await browser.requestStorySession(fresh.storyId)).curve.beats.length,3)
 assert.equal((await browser.requestStorySession(fresh.storyId)).curve.preparation.supplements[0].status,'needs-review')
 assert.deepEqual((await browser.requestStorySession(fresh.storyId)).curve.preparation.authorReview,expectedReview)
 assert.equal(accepted.curve.preparation.candidates[0].possibleResult,expectedReview.candidates[0].possibleResult)
 const beforeSupplement=await snapshot(fresh.storyId)
 const reviewText='  只接受这个未来检查设计，没有检查，也不确认检查结果。  '
 await api('/api/story/preparation/supplement',{...ref(accepted),supplementId:'check',decision:'executed',authorText:reviewText},400,'INVALID_REQUEST')
 accepted=await api('/api/story/preparation/supplement',{...ref(accepted),supplementId:'check',decision:'accepted-design',authorText:reviewText})
 assert.deepEqual(accepted.curve.reasoning,beforeSupplement.curve.reasoning)
 assert.deepEqual(accepted.curve.foundation,beforeSupplement.curve.foundation)
 assert.deepEqual(accepted.curve.beats,beforeSupplement.curve.beats)
 assert.equal(accepted.curve.preparation.supplements[0].authorText,reviewText)
 for(const [supplementId,decision] of [['observe','rejected'],['hypothesis','keep-unknown']]) {
   accepted=await api('/api/story/preparation/supplement',{...ref(accepted),supplementId,decision,authorText:reviewText})
   assert.equal(accepted.curve.preparation.supplements.find(s=>s.id===supplementId).status,decision)
   assert.deepEqual(accepted.curve.reasoning,beforeSupplement.curve.reasoning)
   assert.deepEqual(accepted.curve.foundation,beforeSupplement.curve.foundation)
   assert.deepEqual(accepted.curve.beats,beforeSupplement.curve.beats)
 }
 const reviewedSnapshot=await snapshot(fresh.storyId),reviewedDisk=readFileSync(store,'utf8')
 await api('/api/story/preparation/supplement',{...ref(accepted),supplementId:'check',decision:'rejected',authorText:reviewText},409,'STORY_PREPARATION_ALREADY_ACCEPTED')
 assert.deepEqual(await snapshot(fresh.storyId),reviewedSnapshot)
 assert.equal(readFileSync(store,'utf8'),reviewedDisk)
 await api('/api/story/preparation/supplement',{...ref(beforeSupplement),supplementId:'check',decision:'rejected',authorText:reviewText},409,'STORY_SESSION_CONFLICT')
 assert.equal((await browser.requestStorySession(fresh.storyId)).curve.preparation.supplements[0].authorText,reviewText)
 const frozen=await snapshot(fresh.storyId);await start();assert.deepEqual(await snapshot(fresh.storyId),frozen)
 const {requiredDesignProposalIds}=await import('../dist/storyDesignReview.js')
 await api('/api/story/curve/confirm',ref(accepted),409,'STORY_DESIGN_REVIEW_REQUIRED')
 const confirmed=await api('/api/story/curve/confirm',{...ref(accepted),acceptedDesignProposalIds:requiredDesignProposalIds(accepted.curve.reasoning)})
 await api('/api/story/preparation/supplement',{...ref(confirmed),supplementId:'check',decision:'rejected',authorText:reviewText},409,'STORY_CURVE_ALREADY_CONFIRMED')
 assert.ok(!confirmed.confirmedCurve.design.sourceFacts.some(f=>f.text.includes('日期尚未确定')))
 const callsBeforeOpening=calls
 const opening=await api('/api/story/curve/start-spine',ref(confirmed))
 assert.equal(calls,callsBeforeOpening);assert.equal(opening.turn.options.length,1)
 assert.equal(opening.turn.options[0].action,candidate.action)
 assert.equal(opening.turn.options[0].narrativeAction.mode,'candidate')
 assert.equal(opening.turn.transition,null)
 const openingSnapshot=await snapshot(fresh.storyId)
 const opened=await api('/api/story-spine/turn',{storyId:fresh.storyId,revision:opening.revision,mode:'continue',turnId:opening.turn.id,optionId:opening.turn.options[0].id})
 assert.equal(opened.revision,opening.revision+1)
 const afterClick=await snapshot(fresh.storyId)
 assert.deepEqual(afterClick.history,[]);assert.deepEqual(afterClick.state,openingSnapshot.state)
 assert.equal(afterClick.pendingActionProposal.action,candidate.action)
 assert.equal(afterClick.currentTurn.id,opening.turn.id)
 await start();assert.deepEqual(await snapshot(fresh.storyId),afterClick)
 assert.equal((await browser.requestStorySession(fresh.storyId)).currentTurn.options.length,1)
 assert.equal(calls,callsBeforeOpening)
 // A separate store preserves the successful path while retaining the failure injection.
 store=join(artifact,'supplement-failure-sessions.json');await start()
 const failureStart=await api('/api/story/co-create/start',startBody)
 const failureDraft=await api('/api/story/preparation/accept',{...ref(failureStart),acceptedCandidateIds:['sort'],authorReview:expectedReview})
 const failureBefore=await snapshot(failureStart.storyId),failureDisk=readFileSync(store,'utf8')
 mkdirSync(store+'.tmp')
 await api('/api/story/preparation/supplement',{...ref(failureDraft),supplementId:'check',decision:'accepted-design',authorText:reviewText},503,'STORY_SESSION_PERSIST_FAILED')
 assert.deepEqual(await snapshot(failureStart.storyId),failureBefore)
 assert.equal(readFileSync(store,'utf8'),failureDisk)
 await start();assert.deepEqual(await snapshot(failureStart.storyId),failureBefore)
 console.log(JSON.stringify({ok:true,artifact,calls,model:'local stub; not real content acceptance'}))
}finally{if(child?.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill()});await new Promise(r=>stub.close(r))}
