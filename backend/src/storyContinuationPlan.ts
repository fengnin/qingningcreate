import { AppError, requestQwenJson } from './qwen.js'
import { continuationOutputSchemas as schemas } from './storyOutputSchemas.js'
import type { OutputSchema } from './modelOutputSchema.js'
import { hasProposalProtocolLeak } from './storyProposalProse.js'
import { storyDevelopmentGuidance, storyDevelopmentRepairGuidance } from './storySemanticReview.js'
import { storyExpansionGuidance } from './storyBridgeReview.js'
import { storyCreativeFocusGuidance } from './storyCreativeIntent.js'
import { createStoryProposalContext, validateContinuationBasis, continuationQualityInstruction, validateContinuationQualityReview } from './storyProposalContext.js'

type Context = ReturnType<typeof createStoryProposalContext>
type Route = 'action' | 'question' | 'closure' | 'design'
type Basis = ReturnType<typeof validateContinuationBasis> & { latestResultFactId: string | null }
export type ContinuationPlan = {
  basis: Basis
  options: { label: string; action: string; proposedConsequence: string; sourceFactIds: string[];
    causalClaims: { statement: string; sourceFactIds: string[] }[]; questions: string[] }[]
  authorReview: { summary: string; questions: string[] } | null
}
export type ContinuationDecision = { route: Route; basis: Basis }
const invalid = (message: string): never => { throw new AppError(message, 502, 'INVALID_MODEL_OUTPUT') }
function record(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('续推步骤缺少对象。')
  const r = value as Record<string, unknown>
  if (Object.keys(r).length !== keys.length || keys.some(k => !(k in r))) invalid('续推步骤字段不符合当前职责。')
  return r
}
function prose(value: unknown, context: Context, max = 240): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return invalid(`续推说明应为1至${max}字。`)
  if (hasProposalProtocolLeak(value, context.sourceFacts.map(f => f.text))) invalid('续推说明不能输出内部字段或事实ID。')
  return value
}
// Short aliases are only reference selectors. The server owns actual fact IDs,
// the latest-result pointer, execution flags and candidate IDs.
function evidence(context: Context) {
  return context.sourceFacts.map((f, i) => ({ id: `e${i}`, text: f.text, authority: f.authority }))
}
function resolveRefs(value: unknown, context: Context): string[] {
  const facts = evidence(context)
  if (!Array.isArray(value) || value.some(id => !facts.some(f => f.id === id)) || new Set(value).size !== value.length) invalid('只允许选择当前作者依据，不能引用设计或未知回答。')
  return (value as string[]).map(id => context.sourceFacts[facts.findIndex(f => f.id === id)]!.id)
}
function readingContext(context: Context) {
  const latest = context.lastAuthorConfirmedResult
  return { goal: context.goal, authorMaterial: evidence(context).filter(f => f.authority === 'author-material'),
    confirmedResults: context.executedHistory.map(h => ({ action: h.actionText, result: h.resultText })),
    latestResult: latest ? { action: latest.actionText, result: latest.resultText } : null,
    authorDesign: context.authorEdits.map(e => e.text), unknowns: context.unresolvedQuestions.map(q => ({ question: q.prompt,
      handling: q.unknownHandling })), selectedFocus: context.selectedFocus, evidence: evidence(context) }
}
const routingPrompt = `续推出口判断：只依据作者原文、按时间排序的确认结果及作者未来设计，决定现在该继续行动、问一个创作问题，还是请作者收束。不构思动作或后果。
输出JSON {route,unresolved,reason,sourceIds,contradictions}。route只用action/question/closure/design。unresolved与reason各最多240字，用人物、事情、结果叙述；sourceIds选择e开头的已有依据；contradictions为[{text,sourceIds}]，仅列两项作者依据真正互相矛盾的情况。
action：作者仍有具体未解决事项，unresolved说清该事项，sourceIds非空；目标还没完成不等于需要质量核查。
question：作者明确保留的选择确实无法绕过，sourceIds引用相关作者依据；不追问自造设备、许可或未来结果。
closure：最新结果已明确完成当前任务，或没有已知未解决事项；sourceIds=[]。不要要求再拍一次、测量或他人证明。设计预测不能否定实际结果。
design：只能是作者自愿审阅的新方向，不能伪装成必须解决的问题；sourceIds=[]。
例：照片已拍到且作者说满意→closure；拇指已移开但手机朝向天花板→action，事项是朝向而非遮挡；作者说是否见面仍未知且要求围绕它写→question。只学判断方法，不复制示例事实。`
const actionPrompt = `共创提案编辑：本步只围绕已确定的未解决事项构思一至三项完整小场景，不重新判断出口或当前事实。
${storyDevelopmentGuidance}
${storyCreativeFocusGuidance}
${storyExpansionGuidance}
输出JSON {options:[{label,action,proposedConsequence}]}。label最多32字，action最多180字，proposedConsequence最多180字。一起考虑人物的具体尝试、直接变化及针对变化的回应；明确怎样改变原问题的处境与代价，目标转变须有事件与人物反应承接。无需凑三项，多项须做法与实际发展都有差异。
label用简短自然名称。action和proposedConsequence只写人物会怎样做、看见什么、说什么以及事情可能怎样变化；不要解释“确认权”“可追溯”“物证支撑”“机制”“事项闭环”等方案价值，不把一句普通回应扩写成评论。选择普通、可演出的发展，不为表现创意添加奇怪姿势或没有作用的小动作。
所有新内容只是可拒绝的未来设计。保留作者完整愿望、期限、关系边界、编辑和未解决部分；不凭空追加完成原任务必需的许可、设备、检查或标准来替代人物应对。已有情境中的手续、技术问题可以构成冲突，须由人物行动改变其实际后果。不把作者回答和设计核对写成角色行动。不用技术术语或象征细节代替因果。
例：手指挡镜头，可示范挪开手指或改变握法；语音快门只改变触发方式，不能解决遮挡。合作冲突应给对方实际选择空间，不能换台词后仍替对方决定。例只示范方法，不套用题材。`
const questionPrompt = `作者创作补充：出口已确定，本步只问一个必要、具体、容易回答的创作问题。输出JSON {questions:[一句问题]}，最多140字。不生成角色行动，不索取未知结果的证明；可以提示作者保留未知或选独立替代。新增方向是可拒绝设计，不是现实核查。`

async function step<T>(prompt: string, input: unknown, stage: string, parse: (value: unknown) => T, temperature: number, outputSchema: OutputSchema): Promise<T> {
  let previousOutput: unknown, validationFailure: string | undefined
  for (let pass = 0; pass < 2; pass++) {
    previousOutput = await requestQwenJson({ systemPrompt: prompt,
      userPrompt: JSON.stringify({ task: input, ...(validationFailure ? { previousOutput, validationFailure } : {}) }),
      temperature, maxTokens: 2400, diagnosticStage: stage, outputSchema })
    try { return parse(previousOutput) } catch (error) {
      if (pass || !(error instanceof AppError) || error.code !== 'INVALID_MODEL_OUTPUT') throw error
      validationFailure = error.message
    }
  }
  return invalid('续推步骤未完成。')
}
export async function decideContinuation(context: Context): Promise<ContinuationDecision> {
  return step(routingPrompt, readingContext(context), 'continuation-routing', value => {
    const r = record(value, ['route', 'unresolved', 'reason', 'sourceIds', 'contradictions'])
    if (!['action', 'question', 'closure', 'design'].includes(String(r.route))) invalid('续推出口不合法。')
    if (!Array.isArray(r.contradictions) || r.contradictions.length > 3) invalid('矛盾应为至多三项。')
    const route = r.route as Route
    const contradictionsInput = r.contradictions as unknown[]
    const rawBasis = { latestResultFactId: context.lastAuthorConfirmedResult?.factId ?? null,
      unresolved: { kind: route === 'closure' ? 'next-goal' : route === 'design' ? 'optional-design' : 'existing',
        text: prose(r.unresolved, context), sourceFactIds: resolveRefs(r.sourceIds, context) }, reason: prose(r.reason, context),
      contradictions: contradictionsInput.map((v: unknown) => { const c = record(v, ['text', 'sourceIds']); return { text: prose(c.text, context), sourceFactIds: resolveRefs(c.sourceIds, context) } }) }
    const basis = { ...validateContinuationBasis(rawBasis, context), latestResultFactId: rawBasis.latestResultFactId }
    if (basis.contradictions.length && route !== 'question') invalid('真正矛盾的作者依据应交给作者补充，不自动执行或收束。')
    return { route, basis }
  }, 0.1, schemas.routing)
}
export async function composeContinuation(context: Context, decision: ContinuationDecision, repair?: { issues: string; previousPlan: ContinuationPlan }): Promise<ContinuationPlan> {
  const { route, basis } = decision
  if (route === 'closure') return { basis, options: [], authorReview: null }
  // Creative composition needs narrative material, not evidence selectors.
  // Keep those aliases exclusively in the routing step.
  const { evidence: _selectors, authorMaterial, ...narrative } = readingContext(context)
  const task = { ...narrative, authorMaterial: authorMaterial.map(f => f.text), unresolved: basis.unresolved.text,
    expansionNeeds: context.expansionNeeds,
    creativeFocus: context.creativeFocus,
    ...(repair ? { repair: repair.issues, previousOptions: repair.previousPlan.options.map(({ label, action, proposedConsequence }) => ({ label, action, proposedConsequence })) } : {}) }
  if (route !== 'action') {
    const questions = await step(questionPrompt, task, 'continuation-question', value => {
      const r = record(value, ['questions'])
      if (!Array.isArray(r.questions) || r.questions.length !== 1) invalid('只问一个必要的作者问题。')
      return (r.questions as unknown[]).map((q: unknown) => prose(q, context, 140))
    }, 0.2, schemas.question)
    return { basis, options: [], authorReview: { summary: basis.unresolved.text, questions } }
  }
  const options = await step(repair ? `${actionPrompt}\n${storyDevelopmentRepairGuidance}` : actionPrompt, task, 'continuation-composition', value => {
    const r = record(value, ['options'])
    if (!Array.isArray(r.options) || r.options.length < 1 || r.options.length > 3) invalid('提供一至三项实际不同的提案。')
    const options = (r.options as unknown[]).map((v: unknown) => {
      const o = record(v, ['label', 'action', 'proposedConsequence'])
      return { label: prose(o.label, context, 32), action: prose(o.action, context, 180), proposedConsequence: prose(o.proposedConsequence, context, 180),
        sourceFactIds: [...basis.unresolved.sourceFactIds], causalClaims: [], questions: [] }
    })
    if (new Set(options.map(o => o.action)).size !== options.length) invalid('候选行动不能逐字重复。')
    return options
  }, 0.65, schemas.composition)
  return { basis, options, authorReview: null }
}

export async function auditContinuation(context: Context, decision: ContinuationDecision, plan: ContinuationPlan): Promise<void> {
  const latest = context.lastAuthorConfirmedResult
  const input = { latestConfirmedResult: latest ? { actionText: latest.actionText, resultText: latest.resultText } : null,
    earlierConfirmedResults: context.executedHistory.slice(0, -1).map(h => ({ actionText: h.actionText, resultText: h.resultText })),
    originalAuthorMaterial: context.sourceFacts.filter(f => f.authority === 'author-material').map(f => f.text),
    authorDesignIntent: context.authorEdits.map(e => e.text), expansionNeeds: context.expansionNeeds, goal: context.goal, reviewMode: decision.route,
    creativeFocus: context.creativeFocus,
    proposal: { basis: { reason: plan.basis.reason, unresolved: { kind: plan.basis.unresolved.kind, text: plan.basis.unresolved.text } },
      options: plan.options.map(({ label, action, proposedConsequence }) => ({ label, action, proposedConsequence })), authorReview: plan.authorReview } }
  let previousOutput: unknown, validationFailure: string | undefined
  for (let pass = 0; pass < 2; pass++) {
    previousOutput = await requestQwenJson({ systemPrompt: `${continuationQualityInstruction}\n${storyCreativeFocusGuidance}`,
      userPrompt: JSON.stringify({ ...input, ...(validationFailure ? { previousOutput, validationFailure } : {}) }),
      temperature: 0.1, maxTokens: 2400, diagnosticStage: 'candidate-action-quality-review', outputSchema: schemas.review })
    try { validateContinuationQualityReview(previousOutput); return } catch (error) {
      // A content defect goes back to its owner, never to format regeneration.
      if (pass || !(error instanceof AppError) || error.code !== 'INVALID_MODEL_OUTPUT') throw error
      validationFailure = error.message
    }
  }
}
