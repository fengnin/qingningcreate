import { AppError, requestQwenJson } from './qwen.js'
import { shape as s } from './modelOutputSchema.js'
import type { CurveBeat, ProvisionalCurve } from '../../shared/story-contract.js'

/** An instruction is input to a revision, never the replacement scene itself. */
export async function generateAuthorRevisedBeat(idea: string, curve: ProvisionalCurve, target: CurveBeat, instruction: string): Promise<string> {
  const extracted = await requestQwenJson({
    systemPrompt: `从instruction提取作者明确提出的修改条件。返回JSON {requirements:string[]}，1至8条，合并重复条件，一条完整保留一组关联动作的对象、否定、条件、完成结果或先后关系。只提取原句明确要求，不推导隐含背景、数量、时间延续性、写作语气、事实权限等额外要求，不把本提示中的说明提取为要求。只写作者要改什么，不写解释或新情节。允许同义实现，不要求复述原句。`,
    userPrompt: JSON.stringify({ instruction }), temperature: 0, maxTokens: 650,
    diagnosticStage: 'author-design-requirements', outputSchema: s.object({ requirements: s.array(s.text, 1, 8) }),
  })
  const extractedRequirements = (extracted as { requirements: string[] }).requirements
  if (extractedRequirements.some(r => !r.trim())) throw new AppError('未能识别调整要求，请重新提交；原设计仍保留。', 502, 'STORY_AUTHOR_REVISION_INVALID_OUTPUT')
  // Always retain the complete request: extraction can otherwise separate two
  // actions and silently lose the relation between them.
  const requirements = [instruction.trim(), ...extractedRequirements.filter(r => r.trim() !== instruction.trim()).slice(0, 7)]
  let unmetRequirements: string[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
  const output = await requestQwenJson({
    systemPrompt: `根据作者调整要求，改写一个故事设计节点。返回JSON {detail:string}。
detail必须是可供作者审阅的具体故事情节，写清人物采取的行动及产生的变化，不能复述“让主角……”“把情节改为……”等修改指令，也不输出分析或写作说明。保持简洁，不超过220字。
只改target节点，不改节点类型，不把其余节点的任务提前写完。作者新要求及requirements中的条件优先于旧节点安排；保留原始想法的目标及未被修改的明确条件。参考相邻节点理解情境，但不为维持旧剧情而忽略新要求。不要只写请求、准备或尝试来替代作者要求已经完成的确认或结果。若作者明确要求先做某事再行动，不能写成行动已经开始后才补做；当前节点的局部改写须真正体现该顺序。结尾节点须写清本次行动的具体落点。
未确定的条件继续保持未知，不靠擅自填补关键未知解决问题。新增情节只是待确认设计，不表示已经发生。遵守brief的故事感觉、戏剧力量和人物命名设置。`,
    userPrompt: JSON.stringify({ idea, brief: curve.brief, target, instruction, requirements, unmetRequirements,
      currentDesign: curve.beats.filter(b => b.status !== 'rejected'),
      authorRequirements: curve.preparation?.sources,
      unresolvedConditions: curve.clarifications?.filter(c => !c.resolution && c.status !== 'confirmed'),
    }),
    temperature: 0.3, maxTokens: 900, diagnosticStage: 'author-design-revision',
    outputSchema: s.object({ detail: s.text }),
  })
  const detail = output && typeof output === 'object' && 'detail' in output && typeof output.detail === 'string' ? output.detail.trim() : ''
  if (!detail || detail.length > 220 || detail === instruction.trim()) {
    if (attempt === 0) { unmetRequirements = ['请输出220字以内的具体情节，不直接复述修改要求。']; continue }
    throw new AppError('这次未能将调整要求整理成故事提案，请重新提交；原设计仍保留。', 502, 'STORY_AUTHOR_REVISION_INVALID_OUTPUT')
  }
  unmetRequirements = await reviewAuthorRevisionRequirements(instruction, requirements, detail)
  if (!unmetRequirements.length) return detail
  }
  throw new AppError('新提案仍未完整落实你的调整要求，请重试或调整要求；原设计仍保留。', 502, 'STORY_AUTHOR_REVISION_REQUIREMENTS_UNMET')
}

export async function reviewAuthorRevisionRequirements(instruction: string, requirements: string[], detail: string): Promise<string[]> {
  const reviewed = await requestQwenJson({
    systemPrompt: `只核对新节点是否兑现作者本次修改要求，不审阅前后段落一致性、主线、世界合理性或故事精彩程度。返回JSON {checks:[{requirementIndex:number,verdict:"met"|"unmet",reason:string}]}，requirements每条恰好一项，索引从0开始。
对照instruction、requirements与candidate的实际含义逐项判断。instruction是唯一要求来源；提取条目若添加了原句没有的条件，不据此拒绝，判met并说明原句未要求。允许同义表达和简洁骨架，不要求逐字引用或添加无关过渡。故事提案可以直接写人物动作和结果，叙述用“做了”不代表真的发生过，绝不能要求未来时、计划语气或“打算”措辞。
必须保留明确的动作对象、否定、完成条件、结果与时序。先查候选中是否有违反条件的已有动作或状态，再查是否完成要求；reason须指出候选中的具体依据，不能只凭结尾的反应判满足。提问不等于得到确认；准备或尝试不等于完成；先做A再做B不能写成B已开始才做A，也不能把改变B的方式当作尚未开始B。未再描述B不等于B尚未开始；人物沉默、观察或犹豫不自动等于作出了作者要求的决定。完整原始要求与拆分条目都必须满足，拆分条目不能覆盖或弱化原句关系。不要靠候选文本之外的想象、旧段落或将来正文替候选补齐作者要求。未落实时用reason指出遗漏或反转的具体条件，不给新情节方案。全部落实才逐项met。`,
    userPrompt: JSON.stringify({
      task: '核对修改是否兑现。先从candidate开头检查动作已经进行到哪一步，再逐项核对要求。若要求先A后B，而candidate在A之前已明确处于B进行中的状态，必须判unmet；后续改变方案不能使已开始的动作变为尚未开始。只提问不算获得确认，沉默观察不算明确决定。不得补写候选未交代的结果。',
      instruction, requirements, candidate: detail,
    }),
    temperature: 0, maxTokens: 1000, diagnosticStage: 'author-design-requirement-review',
    outputSchema: s.object({ checks: s.array(s.object({ requirementIndex: { type: 'integer' }, verdict: s.enum('met', 'unmet'), reason: s.text }), requirements.length, requirements.length) }),
  })
  const checks = (reviewed as { checks: { requirementIndex: number; verdict: 'met' | 'unmet'; reason: string }[] }).checks
  if (checks.length !== requirements.length || new Set(checks.map(c => c.requirementIndex)).size !== requirements.length
    || checks.some(c => c.requirementIndex < 0 || c.requirementIndex >= requirements.length)) {
    throw new AppError('调整要求核对未完成，请重试；原设计仍保留。', 502, 'STORY_AUTHOR_REVISION_REVIEW_UNAVAILABLE')
  }
  return checks.filter(c => c.verdict === 'unmet').map(c => `${requirements[c.requirementIndex]}：${c.reason}`)
}
