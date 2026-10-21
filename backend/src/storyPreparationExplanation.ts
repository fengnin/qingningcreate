import { AppError, requestQwenJson } from './qwen.js'
import { shape as s } from './modelOutputSchema.js'
import { preparationExplanationContext, preparationMaterialAuthorityGuidance } from './storyPreparationContext.js'
import { activePreparationMaterial } from './storyPreparationContext.js'
import { bridgeEvidenceCatalog, bridgeReviewCheckSchema, parseBridgeReviewCheck, expansionKinds, storyExpansionSelectionGuidance } from './storyBridgeReview.js'
import type { StoryPreparation, StoryPreparationExplanation, StoryExpansionNeed } from '../../shared/story-preparation.js'
import type { StoryPreparationExplanationRequest } from '../../shared/story-preparation-request.js'

const fail = (): never => { throw new AppError('请提供当前方向及完整的推演解释。', 400, 'INVALID_REQUEST') }
const validText = (v: unknown, max = 240): v is string => typeof v === 'string' && !!v.trim() && v.length <= max
export function parseExplanationWording(value: unknown): StoryPreparationExplanation['wording'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const r = value as Record<string, unknown>
  if (Object.keys(r).some(k => !['action', 'possibleResult', 'futureChoice'].includes(k))
    || !validText(r.action, 4000) || !validText(r.possibleResult, 4000)
    || r.futureChoice !== undefined && r.futureChoice !== '' && !validText(r.futureChoice, 4000)) return fail()
  return { action: r.action, possibleResult: r.possibleResult, ...(r.futureChoice === undefined ? {} : { futureChoice: r.futureChoice as string }) }
}
export function parsePreparationExplanation(value: unknown): StoryPreparationExplanation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const r = value as Record<string, unknown>
  if (Object.keys(r).some(k => !['wording', 'method', 'change', 'issues', 'expansionNeeds', 'source'].includes(k))
    || !validText(r.method) || !validText(r.change) || !['author', 'system'].includes(String(r.source))
    || !Array.isArray(r.issues) || r.issues.length > 3 || r.issues.some(i => !validText(i))) return fail()
  const wording = parseExplanationWording(r.wording)
  const expansionNeeds: StoryExpansionNeed[] = []
  if (r.expansionNeeds !== undefined) {
    if (!Array.isArray(r.expansionNeeds) || r.expansionNeeds.length > 2) return fail()
    const prose = { ...wording, method: r.method, change: r.change }
    for (const need of r.expansionNeeds) {
      if (!need || typeof need !== 'object' || Object.keys(need).length !== 2 || !expansionKinds.includes(need.kind)
        || !Array.isArray(need.anchors) || !need.anchors.length || need.anchors.length > 3) return fail()
      for (const anchor of need.anchors) {
        if (!anchor || typeof anchor !== 'object' || Object.keys(anchor).length !== 2
          || typeof anchor.field !== 'string' || !Object.hasOwn(prose, anchor.field) || !validText(anchor.quote, 4000)
          || prose[anchor.field as keyof typeof prose] !== anchor.quote) return fail()
      }
      if (new Set(need.anchors.map((a: unknown) => JSON.stringify(a))).size !== need.anchors.length) return fail()
      expansionNeeds.push(structuredClone(need))
    }
    if (new Set(expansionNeeds.map(n => JSON.stringify(n))).size !== expansionNeeds.length) return fail()
  }
  return { wording, method: r.method, change: r.change, issues: r.issues as string[], source: r.source as 'author' | 'system',
    ...(r.expansionNeeds === undefined ? {} : { expansionNeeds }) }
}

/** Read-only preview: model output cannot replace the author's card or material. */
export async function suggestPreparationExplanation(p: StoryPreparation, candidate: StoryPreparationExplanationRequest['candidate'], selectedStoryDirection?: string): Promise<StoryPreparationExplanation> {
  if (p.status !== 'needs-review' || !p.candidates.some(c => c.id === candidate.id)) {
    throw new AppError('请选择尚未采用的当前故事方向。', 409, 'STORY_PREPARATION_NOT_PENDING')
  }
  const { id, ...wording } = candidate
  const context = { ...preparationExplanationContext(p, candidate),
    ...(selectedStoryDirection ? { selectedStoryDirection,
      directionBoundary: '这是作者选定的故事走向。办法与变化只展开这一分支，不重新打开相反分支；仍是尚未发生的设计。' } : {}) }
  const evidenceCatalog = bridgeEvidenceCatalog([{ id, ...wording, futureChoice: wording.futureChoice ?? '', method: '', change: '' }],
    activePreparationMaterial(p).map(m => m.quote))
  const reviewSchema = bridgeReviewCheckSchema(evidenceCatalog.map(e => e.id), [id])
  const noteEvidence = evidenceCatalog.filter(e => e.candidateId === id && e.field !== 'futureChoice')
  const noteSchema = bridgeReviewCheckSchema(noteEvidence.map(e => e.id), [id])
  const reviewOutput = await requestQwenJson({
    systemPrompt: `只判断当前卡片是否存在具体矛盾，不生成解释，不补写情节。返回JSON {id,conflict,reason,evidenceIds}。
${preparationMaterialAuthorityGuidance}
id取当前卡片id。卡片是创作者正在编辑的未来设计，允许新增难处和背景关系；原材料未提到该背景不构成矛盾，不得要求它先成为authorMaterial事实。
conflict只有三种值：none=没有具体矛盾；explicit-opposition=卡片直接否定明确条件（例如只能载一人的伞却成功载两人）；impossible-mechanism=卡片已明确排除了所有作用途径却仍保证结果（例如无定位或通信信息的票，仅凭看票却准确知道实时位置）。后两种evidenceIds选2至4个冲突原句且至少一个来自当前卡，其余evidenceIds=[]。‘作者原文未提’‘人物是否愿意’‘尚未写出具体过程’都属于none，不是impossible-mechanism。本步骤不处理正文备忘。
扶朋友休息、日常道歉、询问意愿、走错路后求助、拿出普通道具、新增以前失约的背景，以及未来待选分支，均不能仅因细节尚未写出而被拒绝。人物可以失败、犯错、临时改变目标和选择有代价的办法；可能风险不用证明必然发生；询问求助不必保证他人接受；不存在更优方案要求。reason最多240字，只解释判断，不写修改建议。`,
    userPrompt: JSON.stringify({ ...context, evidenceCatalog }),
    temperature: 0.1, maxTokens: 1000, diagnosticStage: 'preparation-explanation-detail-review',
    outputSchema: s.object({ id: s.enum(id), conflict: s.enum('none', 'explicit-opposition', 'impossible-mechanism'),
      reason: s.text, evidenceIds: reviewSchema.properties!.evidenceIds! }),
  })
  let review: ReturnType<typeof parseBridgeReviewCheck>
  try {
    const { conflict, ...decision } = reviewOutput as Record<string, unknown>
    review = parseBridgeReviewCheck({ ...decision, verdict: conflict === 'none' ? 'supported' : 'contradictory',
      issueType: conflict === 'none' ? 'none' : conflict === 'explicit-opposition' ? 'world-implausible' : 'causal-gap', needs: [] }, evidenceCatalog)
    if (review.id !== id) throw new Error('wrong candidate')
  } catch {
    throw new AppError('推演解释的正文展开分类未完成，请重试。', 502, 'STORY_PREPARATION_INVALID_OUTPUT')
  }
  const output = await requestQwenJson({
    systemPrompt: `你帮助创作者解释未来故事方向。只返回JSON {method,change}。method、change各最多240字。
${preparationMaterialAuthorityGuidance}
method用人物可见的具体行动说明卡片已有办法，change说明它怎样影响处境与后续取舍；用日常语言，不写作者的创作手法或心理学分析。保留卡片实际含义，不补造特殊能力、决定性证据或规则替既定结果圆场；有矛盾时仍说明已有办法及可合理带来的变化，不替作者改写卡片或结局。detailReview只判断具体矛盾；没有矛盾不等于已经表现人物、情绪或呼应作用，不在解释中假称已完成。
完整理解卡片的拟设情节，再判断是否违背作者明确条件或内部因果。普通互动、道具和行动细节可留给正文；可能、尝试、询问、条件分支无需保证成功。日常害怕不自动成为疾病。人物可以失败、犯错和选择有代价的办法。
解释不承担新增审查，不增加新任务，不要求作者补答普通细节或证明选择最优；卡片内容、解释及采用设计都不是已发生事实。`,
    userPrompt: JSON.stringify({ ...context, detailReview: reviewOutput, evidenceCatalog }),
    temperature: 0.2, maxTokens: 900, diagnosticStage: 'preparation-explanation-preview',
    outputSchema: s.object({ method: s.text, change: s.text }),
  })
  if (!output || typeof output !== 'object' || Array.isArray(output)
    || Object.keys(output).some(k => !['method', 'change'].includes(k))) {
    throw new AppError('推演解释生成不完整，请重试。', 502, 'STORY_PREPARATION_INVALID_OUTPUT')
  }
  // Choosing important story effects is separate from explaining the method:
  // otherwise the model mistakes a summary in the explanation for finished prose.
  const noteOutput = review.verdict === 'contradictory' ? { assessment: '', needs: [] } : await requestQwenJson({
    systemPrompt: `你是故事编辑，只选择未来正文值得兑现的重要故事作用，不审查矛盾、不补写情节、不生成办法解释。返回JSON {assessment,needs}。assessment先简要判断本故事哪些作用值得保留，最多240字；这段说明不会进入故事生成。
${storyExpansionSelectionGuidance}
needs最多两项{kind,evidenceIds}，每项选当前卡片1至3个原句编号。保留已概括但尚未在正文表现的重要作用：换装办法的来源铺垫选setup；放弃自保救人体现人物变化选character-detail；从拒绝关心到接受夹子选character-detail；重逢的情绪释放选emotional-beat；换装救人的反差、旧话重现的首尾呼应选payoff。同一处只选最主要作用。不因卡片已经说出意义就清空标记，也不因每个事件都没写细节就标记。普通递夹子、坐下、询问、扶人休息和未选未来分支通常needs=[]。futureChoice只供理解发展空间，自动标记只引用已经提出的行动与可能结果，不引用尚待作者选择的未来分支。`,
    userPrompt: JSON.stringify({ ...context, evidenceCatalog: noteEvidence, task: 'select-story-effects' }),
    temperature: 0.1, maxTokens: 1000, diagnosticStage: 'preparation-explanation-story-effects',
    // Automatic notes cannot select author-source text or unselected branches.
    outputSchema: s.object({ assessment: s.text, needs: noteSchema.properties!.needs! }),
  })
  try {
    const r = output as Record<string, unknown>
    const { needs } = noteOutput as Record<string, unknown>
    if (!Array.isArray(needs)) throw new Error('missing needs')
    const notes = review.verdict === 'contradictory' ? [] : parseBridgeReviewCheck({ id,
      verdict: needs.length ? 'expandable' : 'supported',
      reason: '已选方向的重要故事作用。', issueType: 'none', evidenceIds: [], needs }, evidenceCatalog).expansionNeeds
    return parsePreparationExplanation({ method: r.method, change: r.change, wording, source: 'system',
      issues: review.verdict === 'contradictory' ? [review.reason] : [], expansionNeeds: notes })
  } catch {
    throw new AppError('推演解释生成不完整，请重试。', 502, 'STORY_PREPARATION_INVALID_OUTPUT')
  }
}
