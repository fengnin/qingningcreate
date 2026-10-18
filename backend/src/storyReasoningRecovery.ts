import { createHash, randomUUID } from 'node:crypto'
import { AppError, requestQwenJson, withModelDiagnostic } from './qwen.js'
import { reasoningOutputSchema } from './storyOutputSchemas.js'
import { mapInitialReasoningProposal } from './storyInitialReasoning.js'
import { storyReasoningSystemPrompt } from './storyReasoningPrompt.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'
import { parseStoryReasoningWire } from './storyReasoningWire.js'
import { reviewSelectedReasoningDesign } from './storyDesignReview.js'
import { preparationExplanationContext, preparationMaterialAuthorityGuidance } from './storyPreparationContext.js'
import type { StoryReasoningProposal, StoryReasoningDesignStep, StoryReasoningStatement, StoryReasoningValidationContext } from '../../shared/story-reasoning-contract.js'
import type { ProvisionalCurve, StorySeed, StoryCurveRegenerationPreview, StoryCurveRegenerationDecision } from '../../shared/story-contract.js'

const invalid = (message: string): never => { throw new AppError(message,502,'STORY_REASONING_INVALID_OUTPUT') }
const conflict = (message: string): never => { throw new AppError(message,409,'STORY_REASONING_REVIEW_CONFLICT') }
const kinds = ['current-state','trigger','escalation','climax-choice','resolution'] as const
const statements = (p: StoryReasoningProposal): StoryReasoningStatement[] => [...(p.goal?[p.goal]:[]),...p.constraints,...p.actions,...p.relations,...('steps' in p?p.steps:[])]
function refs(n: StoryReasoningStatement): string[] {
  const s=n as StoryReasoningStatement & { actionIds?:string[];relationIds?:string[];constraintIds?:string[];fromIds?:string[];toIds?:string[] }
  return [...(s.actionIds??[]),...(s.relationIds??[]),...(s.constraintIds??[]),...(s.fromIds??[]),...(s.toIds??[])]
}
export function reasoningFingerprint(curve: ProvisionalCurve): string {
  return createHash('sha256').update(JSON.stringify([curve.id,curve.beats,curve.reasoning,curve.design,curve.clarifications,curve.instructions])).digest('hex')
}

/** Questions are review state. Compute their beat dependencies from the graph,
 * never from keywords, and keep a global question when no nodes exist yet. */
export function attachReasoningQuestions(curve: ProvisionalCurve, proposal = curve.reasoning!, targets: string[] = []): ProvisionalCurve {
  const nodes=statements(proposal)
  const existing=curve.clarifications??[]
  const questions=proposal.unknowns.filter(q=>!existing.some(c=>c.reasoningUnknownId===q.id)).map(q=>{
    const dependent=new Set(q.dependentIds)
    for(const s of nodes) if((s.basis.kind!=='author-text' && s.basis.unknownIds.includes(q.id))
      || ('unknownIds' in s && (s as {unknownIds:string[]}).unknownIds.includes(q.id))) dependent.add(s.id)
    let changed=true
    while(changed){changed=false;for(const s of nodes)if(!dependent.has(s.id)&&refs(s).some(id=>dependent.has(id))){dependent.add(s.id);changed=true}}
    const beatIds=curve.beats.filter(b=>dependent.has(b.id)).map(b=>b.id)
    return {id:`clarification-${randomUUID()}`,reasoningUnknownId:q.id,prompt:q.question,status:'unanswered' as const,
      dependency:{beatIds:beatIds.length?beatIds:targets,causalGap:q.question,requiredFor:['review-beat','confirm-curve'] as ('review-beat'|'confirm-curve')[]},
      source:'author-review' as const,createdAt:Date.now(),updatedAt:Date.now()}
  })
  return {...curve,clarifications:[...existing,...questions]}
}

export function createRecoveryContext(curve: ProvisionalCurve, targets: string[]): StoryReasoningValidationContext {
  if(!curve.reasoning||!curve.design) conflict('新设计结构或作者材料不存在。')
  const sourceFacts=curve.design!.sourceFacts.filter(f=>f.disposition!=='parked')
  const edits=curve.beats.filter(b=>b.source==='user-edit')
  const unresolved=(curve.clarifications??[]).filter(c=>c.status!=='confirmed')
  return {stage:'edit-preview',sources:[...sourceFacts.map(f=>({id:f.id,text:f.text,authority:'author-material' as const})),
    ...edits.map(b=>({id:`edit-${b.id}`,text:b.detail,authority:'author-design' as const})),
    ...unresolved.map(c=>({id:`unknown-${c.id}`,text:c.dependency.causalGap,authority:'unknown' as const}))],
    protectedSteps:edits.map(b=>({id:b.id,text:b.detail})),requiredEditIds:edits.filter(b=>targets.some(id=>dependsOn(curve,id,b.id))).map(b=>b.id),
    externalNodeIds:curve.beats.map(b=>b.id),previewTargetIds:targets,
    ...(curve.reasoning!.goal?{lockedGoal:curve.reasoning!.goal.text}:{}),
    excludedUnknowns:unresolved.map(c=>({id:c.reasoningUnknownId??c.id,sourceIds:[`unknown-${c.id}`,
      ...(curve.reasoning!.unknowns.find(q=>q.id===c.reasoningUnknownId)?.sourceIds??[])]}))}
}
function dependsOn(curve: ProvisionalCurve,id:string,parent:string,seen=new Set<string>()): boolean {
  if(id===parent)return true
  if(seen.has(id))return false;seen.add(id)
  return curve.beats.find(b=>b.id===id)?.dependsOn.some(p=>dependsOn(curve,p,parent,seen))??false
}

export async function previewReasoningRecovery(idea:string,seed:StorySeed,curve:ProvisionalCurve,requested?:string[],feedback?:string,replaceRejected=false) {
  if(curve.status!=='draft')conflict('已确认设计不能原地重推，请创建新版本。')
  const targets=requested??(curve.beats.length?curve.beats.filter(b=>b.status==='stale'&&b.source==='system-proposal').map(b=>b.id):kinds.map(k=>`beat-${k}`))
  if(!targets.length)conflict('没有需要重推的系统节点。')
  for(const id of targets){const b=curve.beats.find(b=>b.id===id)
    if(b&&(b.source!=='system-proposal'||(b.status==='rejected'&&!replaceRejected)))conflict('系统不能覆盖作者节点或静默恢复已拒绝节点。')}
  const blockers=(curve.clarifications??[]).filter(c=>!c.resolution&&(c.dependency.beatIds.length===0||c.dependency.beatIds.some(id=>targets.some(t=>dependsOn(curve,t,id)))))
  if(blockers.some(c=>c.status!=='confirmed'&&c.unknownHandling!=='request-independent-proposal')){
    throw new AppError('请先确认回答，或明确保留未知并请求独立替代提案。',409,'STORY_CLARIFICATION_REVIEW_REQUIRED')
  }
  const context=createRecoveryContext(curve,targets), prefix=`preview-${randomUUID()}`
  let failure:AppError|undefined
  for(let attempt=0;attempt<3;attempt++){
    try{
      const selectedDirection=curve.preparation?.candidates.find(c=>curve.preparation!.acceptedCandidateIds.includes(c.id))
      const preparationContext=selectedDirection ? preparationExplanationContext(curve.preparation!,selectedDirection) : undefined
      const output=await requestQwenJson({systemPrompt:`${storyReasoningSystemPrompt('edit-preview')}${preparationContext ? `\n${preparationMaterialAuthorityGuidance}\npreparationContext保留原来已选方向及作者保留的未知，供承接故事；它不是执行事实。后续作者编辑优先，不恢复被作者改掉的旧情节。只重做指定段落，维持简洁故事骨架，不把普通细节变成作者待答问题。` : ''}`,
        userPrompt:JSON.stringify({idea,brief:curve.brief,context,prefix,targets,authorEdits:context.protectedSteps,
          currentSteps:curve.beats.filter(b=>!targets.includes(b.id)&&b.status!=='rejected'),preparationContext,questions:curve.clarifications,feedback,validationFailure:failure?.message}),
        temperature:attempt?0.1:0.35,maxTokens:6500,diagnosticStage:'reasoning-edit-preview',outputSchema:reasoningOutputSchema('edit-preview')})
      const p=parseStoryReasoningWire(output,context)
      if(p.outcome==='proposal'&&'steps'in p){
        if(p.steps.length!==targets.length||targets.some(id=>!p.steps.some(s=>s.id===id)))invalid('重推必须覆盖指定节点，不得修改范围外节点。')
        if(p.steps.some(s=>s.id!==`beat-${s.kind}`))invalid('节点类型和 ID 不一致。')
        if([...statements(p).filter(s=>!targets.includes(s.id)),...p.unknowns].some(s=>!s.id.startsWith(prefix)))invalid('新结构必须使用独立 ID，不能改写未审阅的原设计。')
        // An ID acknowledgement alone is insufficient even for provenance.
        for(const id of context.requiredEditIds) if(!statements(p).some(s=>s.basis.kind!=='unknown'&&s.basis.evidence.some(e=>e.sourceId===`edit-${id}`&&e.quote===context.protectedSteps.find(s=>s.id===id)!.text)))invalid('重推没有逐字承接作者编辑来源。')
      }
      const preview:StoryCurveRegenerationPreview={id:prefix,curveId:curve.id,baseFingerprint:reasoningFingerprint(curve),reasoning:p,
        excludedUnknownIds:blockers.filter(c=>c.status!=='confirmed').map(c=>c.id),
        items:p.outcome==='proposal'&&'steps'in p?p.steps.map(s=>({id:`${prefix}-${s.id}`,beatId:s.id,kind:s.kind,title:s.title,
          oldDetail:curve.beats.find(b=>b.id===s.id)?.detail??'',newDetail:s.text,newSourceFactIds:[]})):[],createdAt:Date.now(),
        generation:{origin:'model',dramaticMechanism:'模型直接生成编辑后的待审结构'}}
      return {preview,affectedBeatIds:targets,questionCurve:p.outcome==='questions'?attachReasoningQuestions(curve,p,targets):undefined}
    }catch(e){if(!(e instanceof AppError))throw e;failure=withModelDiagnostic(e,{stage:'reasoning-edit-preview',attempt:attempt+1,maxAttempts:3,reason:e.message});
      if(!['STORY_REASONING_INVALID_OUTPUT','QWEN_INVALID_JSON','QWEN_INVALID_RESPONSE','QWEN_EMPTY_RESPONSE','INVALID_MODEL_OUTPUT'].includes(e.code))throw failure}
  }
  throw new AppError('模型重推没有通过新合同，草案和作者编辑保持不变；这不表示作者缺少资料。',502,'STORY_REASONING_PREVIEW_FAILED',undefined,undefined,undefined,failure?.modelDiagnostic)
}

/** Merge only accepted reachable structure, preserving author nodes. A rejected
 * dependency cannot silently contribute its proposed meaning to another step. */
export function acceptReasoningRecovery(curve:ProvisionalCurve,preview:StoryCurveRegenerationPreview,decisions:Record<string,StoryCurveRegenerationDecision>,independentUnknownIds:string[]=[],acceptedDesignProposalIds:string[]=[]) {
  if(curve.status!=='draft'||preview.curveId!==curve.id||preview.baseFingerprint!==reasoningFingerprint(curve))conflict('草案已变化，重推预览失效。')
  const p=preview.reasoning
  if(!curve.reasoning||!curve.design||!p||p.outcome!=='proposal'||!('steps'in p))conflict('当前只有问题审阅，不能接受为设计。')
  if(Object.keys(decisions).some(id=>!preview.items.some(i=>i.id===id))||preview.items.some(i=>!['accept','reject'].includes(decisions[i.id]??'')))conflict('请逐项审阅全部提案。')
  const accepted=new Set(preview.items.filter(i=>decisions[i.id]==='accept').map(i=>i.beatId))
  if(accepted.size&&(preview.excludedUnknownIds??[]).some(id=>!independentUnknownIds.includes(id)))conflict('接受独立替代前，请作者明确核对它未依赖保留的未知前提。')
  const targets=preview.items.map(i=>i.beatId),context=createRecoveryContext(curve,targets)
  validateStoryReasoningProposal(p,context)
  const previewNodes=new Map(statements(p!).map(s=>[s.id,s]))
  const checked=new Set<string>()
  const checkUnknown=(id:string)=>{if(targets.includes(id)&&!accepted.has(id))conflict('接受的结构依赖被拒绝的预览。')
    if(checked.has(id))return;checked.add(id);const s=previewNodes.get(id);if(!s)return
    if((s.basis.kind!=='author-text'&&s.basis.unknownIds.length)||('unknownIds'in s&&(s as {unknownIds:string[]}).unknownIds.length)) {
      conflict('接受的提案仍依赖未确认前提；请保留待审或重新生成独立替代。')
    }
    for(const id of refs(s))checkUnknown(id)
  }
  for(const id of accepted)checkUnknown(id)
  for(const s of p!.outcome==='proposal'&&'steps'in p!?p!.steps:[]){if(!accepted.has(s.id))continue
    if(curve.beats.find(b=>b.id===s.id)?.source==='user-edit')conflict('作者节点不能被系统覆盖。')
    if(s.dependsOn.some(id=>targets.includes(id)&&!accepted.has(id)))conflict('接受的节点依赖被拒绝的预览，请一起审阅或重新生成。')}
  const reviewed = accepted.size && p!.designReview ? reviewSelectedReasoningDesign(p!, [...accepted], acceptedDesignProposalIds) : p!
  if(!accepted.size)return {curve:{...curve,rejectedProposals:[...(curve.rejectedProposals??[]),...preview.items.map(i=>({id:`rejected-${randomUUID()}`,kind:i.kind,title:i.title,detail:i.newDetail,source:'system-proposal' as const,status:'rejected' as const,dependsOn:[],sourceFactIds:[]}))]},affectedBeatIds:targets}
  const original=curve.reasoning!, oldSteps='steps'in original?original.steps:[]
  const newSteps=p!.outcome==='proposal'&&'steps'in p!?p!.steps:[]
  const steps:StoryReasoningDesignStep[]=structuredClone([...oldSteps.filter(s=>!accepted.has(s.id)),...newSteps.filter(s=>accepted.has(s.id))]
    .filter(s=>curve.beats.find(b=>b.id===s.id)?.status!=='rejected'||accepted.has(s.id)))
  for(const b of curve.beats.filter(b=>b.source==='user-edit')){
    const s=steps.find(s=>s.id===b.id);if(!s)conflict('作者节点缺少结构记录。')
    Object.assign(s!,{text:b.detail,basis:{kind:'design-proposal',evidence:[{sourceId:`edit-${b.id}`,quote:b.detail}],unknownIds:[]},actionIds:[],relationIds:[]})
  }
  // Never mutate the retained old proposal while merging.
  const cloned=structuredClone(steps), pool=new Map([...statements(original),...statements(p!)].map(s=>[s.id,s]))
  const reachable=new Set<string>(),visit=(id:string)=>{if(reachable.has(id))return;reachable.add(id);const n=pool.get(id);if(n)for(const r of refs(n))visit(r)}
  for(const s of cloned)for(const id of refs(s))visit(id)
  const allUnknowns=[...original.unknowns,...p!.unknowns], unknownIds=new Set<string>()
  for(const s of [...cloned,...(original.goal?[original.goal]:[]),...[...pool.values()].filter(s=>reachable.has(s.id))]){
    if(s.basis.kind!=='author-text')for(const id of s.basis.unknownIds)unknownIds.add(id)
    if('unknownIds'in s)for(const id of (s as {unknownIds:string[]}).unknownIds)unknownIds.add(id)
  }
  const merged:StoryReasoningProposal={protocol:1,stage:'initial-design',status:'needs-review',outcome:'proposal',goal:original.goal??p!.goal,
    constraints:[...original.constraints,...p!.constraints].filter(s=>reachable.has(s.id)),actions:[...original.actions,...p!.actions].filter(s=>reachable.has(s.id)),
    relations:[...original.relations,...p!.relations].filter(s=>reachable.has(s.id)),unknowns:allUnknowns.filter((q,i,a)=>unknownIds.has(q.id)&&a.findIndex(v=>v.id===q.id)===i),steps:cloned}
  if (original.designReview || p!.designReview) {
    const ids = new Set([...original.designReview?.acceptedProposalIds ?? [], ...reviewed.designReview?.acceptedProposalIds ?? []])
    merged.designReview = { required: true, acceptedProposalIds: statements(merged).filter(s => s.basis.kind === 'design-proposal' && ids.has(s.id)).map(s => s.id) }
  }
  const mergedContext={...createRecoveryContext(curve,[]),stage:'initial-design' as const,requiredEditIds:[],previewTargetIds:undefined,excludedUnknowns:undefined}
  // Author nodes were copied by the server, not emitted by the model. Validate
  // all generated structure against those protected external nodes.
  const modelSteps = merged.steps.filter(s=>!mergedContext.protectedSteps.some(p=>p.id===s.id))
  const modelStepIds = new Set(modelSteps.map(s=>s.id))
  const protectedIds = new Set(mergedContext.protectedSteps.map(s=>s.id))
  validateStoryReasoningProposal({...merged,steps:modelSteps,
    ...(merged.designReview ? { designReview: { required: true, acceptedProposalIds: merged.designReview.acceptedProposalIds.filter(id=>!protectedIds.has(id)||modelStepIds.has(id)) } } : {})},mergedContext)
  const mapped=mapInitialReasoningProposal(merged,curve.design!,curve.brief,{allowSimplePlan:!!curve.preparation})
  const beats=mapped.beats.map(b=>{const old=curve.beats.find(o=>o.id===b.id)
    return old&&!accepted.has(b.id)?{...old}:b})
  const foundation=mapped.foundation!
  foundation.beatSignatures=Object.fromEntries(beats.filter(b=>b.status!=='rejected').map(b=>[b.id,[b.kind,b.detail.trim(),b.causalAnchor?.trim()??'', [...(b.sourceFactIds??[])].sort().join(',')].join('|')]))
  const clarifications=curve.clarifications?.map(c=>!c.resolution&&(c.dependency.beatIds.length===0||c.dependency.beatIds.every(id=>accepted.has(id)))
    ?{...c,resolution:c.status==='confirmed'?'answer-applied' as const:'independent-proposal-accepted' as const,updatedAt:Date.now()}:c)
  const next={...curve,reasoning:merged,beats,foundation,design:{...mapped.design!,foundation},clarifications,
    rejectedProposals:[...(curve.rejectedProposals??[]),...preview.items.filter(i=>decisions[i.id]==='reject').map(i=>({id:`rejected-${randomUUID()}`,kind:i.kind,title:i.title,detail:i.newDetail,source:'system-proposal' as const,status:'rejected' as const,dependsOn:[],sourceFactIds:[]}))],
    instructions:[...curve.instructions,{id:`instruction-${randomUUID()}`,kind:'regenerate' as const,text:`作者审阅并接受新协议重推；设计尚未执行。独立性审阅问题：${(preview.excludedUnknownIds??[]).join('、')}`,createdAt:Date.now()}],updatedAt:Date.now()}
  return {curve:attachReasoningQuestions(next),affectedBeatIds:targets}
}
