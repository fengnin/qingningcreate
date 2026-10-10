import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
const backend=resolve(fileURLToPath(new URL('..',import.meta.url)))
const artifacts=mkdtempSync(join(tmpdir(),'story-initial-reasoning-')), store=join(artifacts,'sessions.json')
const brief={tones:['growth'],dramaticForces:['cost'],allowSystemNamedCharacters:false}
let invalid=false, unknown=false, questions=false, calls=0, child, base, launch=0
const stub=createServer(async(req,res)=>{
  try {
    const chunks=[]; for await(const chunk of req) chunks.push(chunk)
    const request=JSON.parse(Buffer.concat(chunks).toString('utf8')); assert.equal(request.model,'qwen-plus')
    assert.match(request.messages[0].content,/服务端不会补写因果/u)
    const { context }=JSON.parse(request.messages[1].content); calls++
    const evidence=context.sources.map(s=>({sourceId:s.id,quote:s.text}))
    const basis={kind:'design-proposal',evidence,unknownIds:unknown?['gap']:[]}
    const payload={protocol:1,stage:'initial-design',status:'needs-review',outcome:questions?'questions':'proposal',
      goal:questions?null:{id:'goal',text:context.lockedGoal??context.sources[0].text,basis:{kind:'design-proposal',evidence,unknownIds:[]}},constraints:[],
      actions:questions?[]:[{id:'action',text:'提案：先记录作者材料，结果待审。',basis,constraintIds:[],relationIds:[],unknownIds:unknown?['gap']:[],respondsToEditIds:[]}],relations:[],
      unknowns:unknown||questions?[{id:'gap',question:'此项代价是否成立？',sourceIds:[],dependentIds:questions?[]:['action']}]:[]}
    if(questions) payload.questions=[{unknownId:'gap',dependentIds:[]}]
    else payload.steps=['current-state','trigger','escalation','climax-choice','resolution'].map((kind,i,all)=>({id:`beat-${kind}`,kind,title:kind,text:`待审设计节点${i}：先记录原始材料。`,basis,
      actionIds:['action'],relationIds:[],dependsOn:i?[`beat-${all[i-1]}`]:[],respondsToEditIds:[]}))
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(invalid?{curvePlan:{}}:payload)}}]}))
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
  const edited=await api('/api/story/curve/beat',{...ref(s),beatId:'beat-trigger',detail:'作者编辑：先测量，不修补。'})
  assert.equal(edited.curve.foundation,undefined);assert.equal(edited.curve.beats.find(b=>b.id==='beat-trigger').source,'user-edit')
  const before=await snapshot(s.storyId)
  invalid=true
  await api('/api/story/curve/beat/regenerate',{...ref(edited),beatId:'beat-escalation'},502,'STORY_REASONING_PREVIEW_FAILED')
  invalid=false
  await api('/api/story/curve/confirm',ref(edited),409,'STORY_CURVE_FOUNDATION_OUT_OF_DATE');assert.deepEqual(await snapshot(s.storyId),before)
  unknown=true
  const pending=await api('/api/story/co-create/start',{idea:'余禾想修补陶杯；没有完成期限；代价是否成立未确定。',brief})
  // Unknowns now have actionable clarification records; the earlier review
  // gate rejects before the reasoning dependency gate. This remains rejection.
  const blockedBefore=await snapshot(pending.storyId)
  await api('/api/story/curve/confirm',ref(pending),400,'STORY_CURVE_CLARIFICATIONS_UNRESOLVED')
  assert.deepEqual(await snapshot(pending.storyId),blockedBefore)
  unknown=false;questions=true
  const q=await api('/api/story/co-create/start',{idea:'余禾想修补陶杯；具体代价尚未确定。',brief});assert.equal(q.curve.reasoning.outcome,'questions');assert.equal(q.curve.foundation,undefined)
  questions=false;invalid=true
  await api('/api/story/co-create/start',{idea:'温晴想整理船模图纸；没有期限；条件可以兼容。',brief},502,'STORY_CURVE_MODEL_GENERATION_FAILED')
  invalid=false;await start(false);assert.equal((await snapshot(legacy.storyId)).curve.reasoning,undefined)
  console.log(`Initial reasoning HTTP contracts passed (${calls} local stub calls; disabled legacy + protocol 1; NOT real content acceptance). Artifacts: ${artifacts}`)
}finally{await stop();await new Promise(r=>stub.close(r))}
