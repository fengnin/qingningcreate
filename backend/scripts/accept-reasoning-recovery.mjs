import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
const backend=resolve(fileURLToPath(new URL('..',import.meta.url)))
const { storyReasoningWireExample }=await import('../dist/storyReasoningWire.js')
const artifacts=mkdtempSync(join(tmpdir(),'story-initial-reasoning-')), store=join(artifacts,'sessions.json')
const { build }=createRequire(new URL('../../frontend/package.json',import.meta.url))('esbuild')
const browserModule=join(artifacts,'browser-api.mjs')
await build({entryPoints:[resolve(backend,'../frontend/src/story/storyApi.ts')],bundle:true,format:'esm',platform:'node',outfile:browserModule})
const browser=await import(pathToFileURL(browserModule).href)
async function browserSnapshot(id){const f=globalThis.fetch;globalThis.fetch=(url,init)=>f(new URL(url,base),init);try{return await browser.requestStorySession(id)}finally{globalThis.fetch=f}}
const brief={tones:['growth'],dramaticForces:['cost'],allowSystemNamedCharacters:false}
let invalid=false, unknown=false, questions=false, calls=0, child, base, launch=0
const stub=createServer(async(req,res)=>{
  try {
    const chunks=[]; for await(const chunk of req) chunks.push(chunk)
    const request=JSON.parse(Buffer.concat(chunks).toString('utf8')); assert.equal(request.model,'qwen-plus')
    assert.match(request.messages[0].content,/服务端不会补写因果/u)
    assert.match(request.messages[0].content,/protocol=2/u)
    const { context,prefix,targets }=JSON.parse(request.messages[1].content); calls++
    const evidence=context.sources.filter(s=>s.authority!=='unknown').map(s=>({sourceId:s.id,quote:s.text}))
    const nid=id=>prefix?`${prefix}-${id}`:id
    const basis={kind:'design-proposal',evidence,unknownIds:unknown?['gap']:[]}
    const payload={protocol:1,stage:context.stage,status:'needs-review',outcome:questions?'questions':'proposal',
      goal:questions?null:{id:nid('goal'),text:context.lockedGoal??context.sources[0].text,basis:{kind:'design-proposal',evidence,unknownIds:[]}},constraints:[],
      actions:questions?[]:[{id:nid('action'),text:'提案：先记录作者材料，结果待审。',basis,constraintIds:[],relationIds:[],unknownIds:unknown?['gap']:[],respondsToEditIds:context.requiredEditIds}],relations:[],
      unknowns:unknown||questions?[{id:nid('gap'),question:'此项代价是否成立？',sourceIds:[],dependentIds:questions?[]:[nid('action')]}]:[]}
    if(questions) payload.questions=[{unknownId:nid('gap'),dependentIds:[]}]
    else payload.steps=(targets??['beat-current-state','beat-trigger','beat-escalation','beat-climax-choice','beat-resolution']).map((id,i,all)=>({id,kind:id.replace('beat-',''),title:'待审设计',text:`待审设计节点${i}：先记录原始材料。`,basis,
      actionIds:[nid('action')],relationIds:[],dependsOn:i?[all[i-1]]:context.requiredEditIds,respondsToEditIds:context.requiredEditIds}))
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(invalid?{curvePlan:{}}:storyReasoningWireExample(payload,context))}}]}))
  } catch(e){res.writeHead(500);res.end(String(e))}
})
await new Promise(r=>stub.listen(0,'127.0.0.1',r))
async function stop(){if(child?.exitCode===null){const own=child;await new Promise(r=>{own.once('exit',r);own.kill()})}}
async function start(disabled){
  await stop(); const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r))
  base=`http://127.0.0.1:${port}`
  child=spawn(process.execPath,['dist/server.js'],{cwd:backend,windowsHide:true,env:{...process.env,PORT:String(port),STORY_DISABLE_MODEL:String(disabled),STORY_SESSION_STORE_PATH:store,
    DASHSCOPE_API_KEY:'stub',DASHSCOPE_BASE_URL:`http://127.0.0.1:${stub.address().port}`,QWEN_MODEL:'qwen-plus'}})
  const log=createWriteStream(join(artifacts,`backend-${++launch}.log`));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});child.once('exit',()=>log.end())
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('own backend exited');try{if((await fetch(base+'/health')).ok)return}catch{}await delay(100)}throw Error('start timeout')
}
async function api(path,body,status=200,code){const res=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const p=await res.json();assert.equal(res.status,status,JSON.stringify(p));if(code)assert.equal(p.error.code,code);return p}
const ref=s=>({storyId:s.storyId,revision:s.revision,curveId:s.curve.id})
const snapshot=id=>api(`/api/story/session/${id}`)
try{
  await start(true)
  const legacy=await api('/api/story/co-create/start',{idea:'青柠要在周五送到投影仪；设备缺少电源线；答应好友不改展板。',brief})
  assert.equal(legacy.curve.reasoning,undefined);assert.equal(legacy.curve.generation.origin,'fact-preserving-fallback')
  await start(false)
  for(const idea of ['余禾想修补陶杯；没有完成期限；先测量不会改变杯子。','温晴想整理船模图纸；按编号分类与不丢弃图纸可以同时做到。','陆原想和姐姐共同守店；姐姐希望卖店，两人意见冲突。']){
    const s=await api('/api/story/co-create/start',{idea,brief})
    assert.equal(s.curve.reasoning.protocol,1);assert.equal(s.curve.foundation.predicament.urgency,'');assert.equal(s.curve.foundation.predicament.plausibleCost,'')
    const before=await snapshot(s.storyId)
    await api('/api/story/curve/start-spine',ref(s),409,'STORY_CURVE_NOT_CONFIRMED')
    assert.deepEqual(await snapshot(s.storyId),before)
    const confirmed=await api('/api/story/curve/confirm',ref(s));assert.equal(confirmed.confirmedCurve.reasoning.protocol,1)
    const frozen=await snapshot(s.storyId);await start(false);assert.deepEqual(await snapshot(s.storyId),frozen)
  }
  const s=await api('/api/story/co-create/start',{idea:'余禾想修补陶杯；没有完成期限；先测量不会改变杯子。',brief})
  let edited=await api('/api/story/curve/beat',{...ref(s),beatId:'beat-trigger',detail:'作者编辑：先测量，不修补。'})
  assert.equal(edited.curve.foundation,undefined);assert.equal(edited.curve.beats.find(b=>b.id==='beat-trigger').source,'user-edit')
  const before=await snapshot(s.storyId)
  invalid=true
  await api('/api/story/curve/beat/regenerate',{...ref(edited),beatId:'beat-escalation'},502,'STORY_REASONING_PREVIEW_FAILED')
  invalid=false
  await api('/api/story/curve/confirm',ref(edited),409,'STORY_CURVE_FOUNDATION_OUT_OF_DATE');assert.deepEqual(await snapshot(s.storyId),before)
  const single=await api('/api/story/curve/beat/regenerate',{...ref(edited),beatId:'beat-escalation'})
  assert.deepEqual(single.curve,edited.curve)
  let browserResult=await browserSnapshot(single.storyId)
  assert.equal(browserResult.pendingCurveRegeneration.reasoning.stage,'edit-preview');assert.equal(browserResult.curve.foundation,undefined)
  const resolveBody=x=>({...ref(x),previewId:x.pendingCurveRegeneration.id,decisions:Object.fromEntries(x.pendingCurveRegeneration.items.map(i=>[i.id,'accept']))})
  edited=await api('/api/story/curve/regenerate-affected/resolve',resolveBody(single))
  assert.equal(edited.curve.beats.find(b=>b.id==='beat-trigger').detail,'作者编辑：先测量，不修补。')
  const batch=await api('/api/story/curve/regenerate-affected',ref(edited))
  const accepted=await api('/api/story/curve/regenerate-affected/resolve',resolveBody(batch))
  assert.equal(accepted.curve.beats.some(b=>b.status==='stale'),false)
  assert.equal((await browserSnapshot(accepted.storyId)).curve.foundation.reasoning.protocol,1)
  const confirmed=await api('/api/story/curve/confirm',ref(accepted));await start(false)
  assert.equal((await browserSnapshot(accepted.storyId)).revision,confirmed.revision)
  await api('/api/story/curve/clarification',{...ref(confirmed),action:'create',targetBeatId:'beat-escalation',causalGap:confirmed.curve.beats.find(b=>b.id==='beat-escalation').detail,prompt:'是否确有代价？'},409,'STORY_VERSION_PRESERVATION_REQUIRED')
  let version=await api('/api/story/curve/clarification',{...ref(confirmed),versionMode:'new-version',action:'create',targetBeatId:'beat-escalation',causalGap:confirmed.curve.beats.find(b=>b.id==='beat-escalation').detail,prompt:'是否确有代价？'})
  assert.equal(version.curveVersions.some(v=>v.confirmedCurve?.id===confirmed.confirmedCurve.id),true)
  const id=version.curve.clarifications.at(-1).id, unknownRaw='  目前未确定。\n'
  version=await api('/api/story/curve/clarification',{...ref(version),action:'declare-unknown',clarificationId:id,answerText:unknownRaw})
  version=await api('/api/story/curve/clarification',{...ref(version),action:'keep-unknown',clarificationId:id})
  await api('/api/story/curve/beat/regenerate',{...ref(version),beatId:'beat-escalation'},409,'STORY_CLARIFICATION_REVIEW_REQUIRED')
  version=await api('/api/story/curve/clarification',{...ref(version),action:'request-independent-proposal',clarificationId:id})
  const independent=await api('/api/story/curve/beat/regenerate',{...ref(version),beatId:'beat-escalation'})
  await api('/api/story/curve/regenerate-affected/resolve',resolveBody(independent),409,'STORY_REASONING_REVIEW_CONFLICT')
  version=await api('/api/story/curve/regenerate-affected/resolve',{...resolveBody(independent),independentUnknownIds:[id]})
  browserResult=await browserSnapshot(version.storyId)
  assert.equal(browserResult.curve.clarifications.at(-1).answerText,unknownRaw);assert.equal(browserResult.curve.clarifications.at(-1).status,'author-unknown')
  assert.equal(browserResult.curve.clarifications.at(-1).resolution,'independent-proposal-accepted')
  questions=true
  let q=await api('/api/story/co-create/start',{idea:'余禾想修补陶杯；具体代价尚未确定。',brief});assert.equal(q.curve.reasoning.outcome,'questions');assert.equal(q.curve.foundation,undefined)
  assert.equal((await browserSnapshot(q.storyId)).curve.beats.length,0)
  const qid=q.curve.clarifications[0].id, answer='  陶杯缺口不会漏水。\n'
  q=await api('/api/story/curve/clarification',{...ref(q),action:'save-answer',clarificationId:qid,answerText:answer})
  assert.equal(q.curve.design.sourceFacts.some(f=>f.text===answer),false)
  q=await api('/api/story/curve/clarification',{...ref(q),action:'confirm-answer',clarificationId:qid})
  assert.equal((await browserSnapshot(q.storyId)).curve.design.sourceFacts.at(-1).text,answer)
  questions=false
  const qp=await api('/api/story/curve/regenerate-affected',ref(q))
  q=await api('/api/story/curve/regenerate-affected/resolve',resolveBody(qp))
  assert.equal(q.curve.beats.length,5);assert.equal(q.curve.clarifications[0].resolution,'answer-applied')
  questions=false;invalid=true
  await api('/api/story/co-create/start',{idea:'温晴想整理船模图纸；没有期限；条件可以兼容。',brief},502,'STORY_CURVE_MODEL_GENERATION_FAILED')
  invalid=false;await start(false);assert.equal((await snapshot(legacy.storyId)).curve.reasoning,undefined)
  console.log(`Reasoning recovery HTTP and browser parser contracts passed (${calls} local stub calls; disabled legacy + model wire2/stored protocol1; NOT real content acceptance). Artifacts: ${artifacts}`)
}finally{await stop();await new Promise(r=>stub.close(r))}
