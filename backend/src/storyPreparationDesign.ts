import { randomUUID } from 'node:crypto'
import { repeatsStoryBeatText } from './storyBeatText.js'
import { AppError, requestQwenJson, withModelDiagnostic, withQwenRequestBudget } from './qwen.js'
import { activePreparationMaterial, preparationExplanationContext, preparationMaterialAuthorityGuidance, authorRequirementsGuidance } from './storyPreparationContext.js'
import { storyCreativeIntentGuidance, preparationCreativeFocus } from './storyCreativeIntent.js'
import { storyDevelopmentGuidance, storyDevelopmentRepairGuidance, storySemanticReviewGuidance } from './storySemanticReview.js'
import { preparationOutputSchemas, qualityOutputSchema } from './storyOutputSchemas.js'
import { mapInitialReasoningProposal } from './storyInitialReasoning.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'
import { storyDirectionSelectionGuidance } from './storyPreparationDirections.js'
import { storySettingScopeGuidance } from './storySettingScope.js'
import { observeStoryDesignMainline, reviewStoryDesignMainline } from './storyDesignMainlineShadow.js'
import { outputShapeErrors, shape as s } from './modelOutputSchema.js'
import { compileStoryDesignContract, currentStoryDesignContract, storyDesignContractInput, storyDesignContractGuidance } from './storyDesignContract.js'
import type { StoryPreparation, StoryPreparationItem } from '../../shared/story-preparation.js'
import type { ProvisionalCurve, StoryDesignRecord } from '../../shared/story-contract.js'
import type { StoryReasoningProposal } from '../../shared/story-reasoning-contract.js'

const kinds = ['current-state', 'trigger', 'escalation', 'midpoint-turn', 'climax-choice', 'resolution'] as const
const titles = { 'current-state': '故事起点', trigger: '开始尝试', escalation: '尝试带来的变化', 'midpoint-turn': '新的转折', 'climax-choice': '关键选择', resolution: '暂定结局' }
const criteria = ['boundaries', 'continuity', 'causality', 'closure']
const invalid = (message: string): never => { throw new AppError(message, 502, 'STORY_PREPARATION_INVALID_OUTPUT') }
type Step = { kind: typeof kinds[number]; text: string; materialIds: string[]; action?: string | null; expectedChange?: string | null }

export const preparationStoryDesignPrompt = `根据作者确认的方向，提出一版从起点到暂定结局的故事骨架，供作者审阅和修改。不是复述或排列方向卡，也不是完整正文。
严格输出 JSON {steps:[{kind,text,materialIds,action,expectedChange}]}。每个节点必须返回action和expectedChange；current-state没有明确行动或变化时相应字段填null，其余节点两个字段均为非空简洁概括，不添加节点没有的新事实。变化可以是回应、决定或结果，不为填字段强造新事件。3至6个互不重复、按故事顺序发展的节点，kind依序为current-state、trigger、可选escalation、可选midpoint-turn、可选climax-choice、resolution。起点、开始尝试、结局必须有；简单故事不必强造中段、高潮、成长或反转。每段用1至3句简洁梗概，优先60至120字，最多220字；直接概括人物做什么、处境怎样变化，不写逐镜头动作、长对白、抒情比喻、分析、问题清单或内部字段。trigger必须包含一次实际尝试，不能只写发现麻烦、找到或拿出工具。
先读完整作者材料和最新已确认卡片：action包含遇到的困难及眼前的选择；futureChoice是故事将推向的取舍；possibleResult是可能走向。保留它们的核心情境、选择意义及作者编辑。已提供selectedStoryDirection时，必须承接作者明确选定的分支；仅旧版未记录选择时可提出暂定方案。不能把作者明确保留的未知擅自定死。原卡已经指定的行动或结果不可换成无关故事。
具体设计人物采取什么办法，尝试带来什么变化，人物如何回应；需要关键选择时，写出这一版他暂定选择做什么、放弃或承担什么，接着给出这版实际走向的结局。不要让起点、行动和结局重复同一句，也不要在结局仍只并列“如果选甲就怎样、选乙就怎样”。开放结局可以保留远期未知，但当前这次行动应有可理解的落点。目标可有来由地转变，原愿望及风险仍须影响选择的意义。
允许补充服务关键行动、转折和结果的新人物、道具、必要铺垫与回应；均属于可拒绝的未来提案。优先让已有要素发挥作用，不把每个普通省略补成新任务，不为了完整强行加秘密、故障、手续或危机。普通动作、对白、环境和无关紧要的细节留给后续正文；已采用解释中的重要待展开事项，只在确实支撑当前骨架时兑现。
brief.allowSystemNamedCharacters=false时，不给新增人物起具体名字，保留作者已经提供的名字。人物称呼不需要另加身份往事来证明合理。
${storySettingScopeGuidance}
${preparationMaterialAuthorityGuidance}
${authorRequirementsGuidance}
materialIds只能引用referenceContract.knownMaterialIds中确实承接的作者片段；引用只说明从哪里出发，不证明新增情节是事实。可用空数组表示纯新增发展，尤其不能用原目标冒充结局已经成立的证明。已知背景和保留的替代路径可以在起点引用而不逐条复述；不能假装承接无关材料。referenceContract.unknownMaterialIds列出的未知材料不能出现在materialIds，也不能被写成原因、资源、障碍、解决手段或结局依据；除非当前候选的unknownIds明确包含对应问题，否则只能保留为未决，不得替作者定案。
${storyDevelopmentGuidance}`

export const preparationStoryDesignReviewPrompt = `审阅一版待作者决定的完整故事骨架，严格输出 JSON {checks:[{criterion,passed,evidence}],issues:[]}。criterion为boundaries、continuity、causality、closure，每项恰好一次；evidence不超过240字，issues只列具体实质问题，最多4项。
boundaries核对作者已定条件、发展要求和明确保留的未知；continuity核对是否承接最新已选卡片的困难、选择、后续取舍和可能走向，人物尝试与回应是否仍影响后续；causality核对重要行动、变化与结果是否接得上；closure核对是否提出这一版具体暂定结果，而非重复原卡的分支预测。合理的开放结局不等于没有结局。
核对命名开关：brief.allowSystemNamedCharacters=false时不得为新人物起具体名字；已有作者名字可保留。判断连续性时，已选行动不能一直推迟到最后才出现；trigger应写出实际尝试，后续变化由人物回应接起。只拿出工具或出现新麻烦还不算实际尝试。
${storySettingScopeGuidance}
新增设定导致额外独立任务或替换已选方向时归continuity；造成办法缺乏依据或数字冲突时归causality，不增加审阅维度或重复列同一问题。
${preparationMaterialAuthorityGuidance}
${authorRequirementsGuidance}
${storySemanticReviewGuidance}
新情境、必要铺垫、人物选择和结果都是可拒绝的未来设计，不能仅因原文没有它们而拒绝。接受方向允许进一步设计，但不得更换selectedStoryDirection所确定的关键分支。仅旧版未记录选择时允许提出暂定方案，不要求作者补答普通细节。作者明确保留的未知仍不得替作者决定。原方向的核心安排及明确边界须保留。
普通互动、省略的动作对白、其他可选办法、没有大反转或人物成长都不是缺陷；必要因果过程有交代即可，不追问无关细节，不新增待办或标记。拒绝须指出具体冲突双方或哪段关键因果断裂及影响；不能用“不够精彩”或审阅者偏好的结局拒绝。所有项通过时issues=[]。`

function parseSteps(raw: unknown, knownIds: Set<string>, strictContract = false): Step[] {
  const output = raw as { steps?: unknown[] }
  if (!output || !Array.isArray(output.steps) || output.steps.length < 3 || output.steps.length > 6) invalid('故事设计须包含3至6个节点。')
  const steps = output.steps!.map((value): Step => {
    const s = value as Step
    if (!s || !kinds.includes(s.kind) || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 220) invalid('故事节点类型或文本不合法；每段须为1至220字。')
    if (!Array.isArray(s.materialIds) || new Set(s.materialIds).size !== s.materialIds.length
      || s.materialIds.some(id => !knownIds.has(id))) invalid('故事节点只能引用有效的已知作者材料，不能引用未知或已取代材料。')
    if (strictContract && (!Object.hasOwn(s, 'action') || !Object.hasOwn(s, 'expectedChange'))) invalid('故事契约必须返回行动和预期变化字段。')
    for (const excerpt of [s.action, s.expectedChange]) {
      if (excerpt !== undefined && excerpt !== null && (typeof excerpt !== 'string' || !excerpt.trim())) invalid('故事契约中的行动和变化必须是非空文本。')
    }
    if (strictContract && s.kind !== 'current-state' && (typeof s.action !== 'string' || typeof s.expectedChange !== 'string')) invalid('推进节点必须提供非空的行动和预期变化概括。')
    return { kind: s.kind, text: s.text, materialIds: [...s.materialIds],
      ...(s.action === undefined ? {} : { action: s.action }), ...(s.expectedChange === undefined ? {} : { expectedChange: s.expectedChange }) }
  })
  if (steps[0]?.kind !== 'current-state' || steps[1]?.kind !== 'trigger' || steps.at(-1)?.kind !== 'resolution'
    || steps.some((s, i) => i > 0 && kinds.indexOf(s.kind) <= kinds.indexOf(steps[i - 1]!.kind))) invalid('故事节点缺少起点、尝试、结局，或顺序重复。')
  if (steps.some((step, index) => repeatsStoryBeatText(step.text, steps.slice(0, index).map(s => s.text)))) invalid('每个节点需要独立的发展，不能用重复卡片文字填充。')
  return steps
}

function reviewIssues(raw: unknown): string[] {
  const audit = raw as { checks?: { criterion: string; passed: boolean; evidence: string }[]; issues?: string[] }
  if (!audit || !Array.isArray(audit.checks) || audit.checks.length !== criteria.length || !Array.isArray(audit.issues)
    || new Set(audit.checks.map(c => c.criterion)).size !== criteria.length
    || audit.checks.some(c => !criteria.includes(c.criterion) || typeof c.passed !== 'boolean' || typeof c.evidence !== 'string' || !c.evidence.trim() || c.evidence.length > 240)
    || audit.issues.some(s => typeof s !== 'string' || !s.trim() || s.length > 400)) invalid('故事设计审阅维度不完整。')
  if (audit.checks!.every(c => c.passed) && audit.issues!.length) invalid('故事审阅均通过却列出缺陷，请核对本次审阅。')
  return [...audit.issues!, ...audit.checks!.filter(c => !c.passed).map(c => `${c.criterion}：${c.evidence}`)]
}

/** New events remain proposals. Accepted card wording and original material
 * are preserved separately; neither review nor confirmation executes them. */
export async function developPreparationStory(curve: ProvisionalCurve, p: StoryPreparation, goal?: StoryPreparationItem): Promise<ProvisionalCurve> {
  const active = activePreparationMaterial(p)
  const known = active.filter(m => m.role !== 'unknown')
  const selected = p.candidates.find(c => p.acceptedCandidateIds.includes(c.id))!
  const goalText = goal?.quote ?? p.authorReview?.selectedStoryDirection ?? selected.action
  const context = { ...preparationExplanationContext(p, selected), brief: curve.brief,
    creativeFocus: preparationCreativeFocus(p), designContract: storyDesignContractInput(p, goalText),
    referenceContract: { knownMaterialIds: known.map(m => m.id), unknownMaterialIds: active.filter(m => m.role === 'unknown').map(m => m.id) } }
  let previousOutput: unknown, repair: string | undefined, failure: AppError | undefined
  let steps: Step[] | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = await requestQwenJson({ systemPrompt: `${preparationStoryDesignPrompt}\n${storyDesignContractGuidance}\n新生成输出必须包含action和expectedChange键；起点无明确行动或变化时填null，其余节点填非空简洁概括，不添加节点没有的新事实。${storyCreativeIntentGuidance(curve.brief, 'curve')}\n${storyDevelopmentRepairGuidance}\n${storyDirectionSelectionGuidance}`,
        userPrompt: JSON.stringify({ ...context, ...(repair ? { previousOutput, repair } : {}) }), temperature: attempt ? 0.2 : 0.4,
        maxTokens: 3000, diagnosticStage: 'preparation-story-design', outputSchema: preparationOutputSchemas.storyDesign })
      previousOutput = output
      const draft = parseSteps(output, new Set(known.map(m => m.id)), true)
      const audit = await requestQwenJson({ systemPrompt: `${preparationStoryDesignReviewPrompt}\n${storyDesignContractGuidance}\n${storyDirectionSelectionGuidance}\ncontinuity 必须核对作者选定的走向，不能把擅自改选另一分支视作允许的进一步设计。`,
        userPrompt: JSON.stringify({ ...context, designContract: { ...context.designContract, ...compileStoryDesignContract(p, draft, goalText) }, steps: draft }), temperature: 0.1, maxTokens: 1800,
        diagnosticStage: 'preparation-story-design-review', outputSchema: qualityOutputSchema(criteria) })
      const issues = reviewIssues(audit)
      if (process.env.STORY_PREPARATION_DIAGNOSTICS === 'true') console.warn('[preparation] story-design-review', JSON.stringify({ attempt: attempt + 1, audit }))
      if (issues.length) {
        repair = issues.join('；')
        throw new AppError('本次故事设计未通过内容审阅，请重试；选定方向仍保留。', 502, 'STORY_PREPARATION_QUALITY_FAILED')
      }
      const covered = new Set(draft.flatMap(s => s.materialIds))
      const omitted = known.filter(m => !covered.has(m.id)).map(m => m.id)
      // Ask once for genuine coverage; if still unused, retain the explicit
      // author disposition gate instead of inventing citations server-side.
      if (omitted.length && !repair && attempt < 2) {
        repair = `核对未承接的作者材料${JSON.stringify(omitted)}。在适合的节点显式引用实际承接的背景或条件；不伪造引用，不改变已成立故事，无法承接的留给作者决定。`
        continue
      }
      steps = draft
      break
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      failure = withModelDiagnostic(error, { stage: 'preparation-story-design', attempt: attempt + 1, maxAttempts: 3 })
      if (!['STORY_PREPARATION_INVALID_OUTPUT', 'STORY_PREPARATION_QUALITY_FAILED', 'QWEN_OUTPUT_SCHEMA_FAILED'].includes(error.code)) throw failure
      if (error.code !== 'STORY_PREPARATION_QUALITY_FAILED') repair = error.message
    }
  }
  if (!steps) throw failure ?? new AppError('故事设计暂未完成，请重试。', 502, 'STORY_PREPARATION_QUALITY_FAILED')
  if (process.env.STORY_DESIGN_MAINLINE_REPAIR !== 'false') {
    const result = await repairPreparationMainline(curve, p, steps)
    return { ...mapPreparationDesign(curve, p, goal, result.steps), mainlineReview: result.review }
  }
  const mapped = mapPreparationDesign(curve, p, goal, steps)
  void observeStoryDesignMainline({ curveId: curve.id, designId: mapped.design!.id, preparation: structuredClone(p), steps: structuredClone(steps) })
  return mapped
}

function mapPreparationDesign(curve: ProvisionalCurve, p: StoryPreparation, goal: StoryPreparationItem | undefined, steps: Step[]): ProvisionalCurve {
  const known = activePreparationMaterial(p).filter(m => m.role !== 'unknown')
  const evidence = (ids: string[]) => ids.map(id => ({ sourceId: id, quote: known.find(m => m.id === id)!.quote }))
  const basis = (ids: string[]) => ({ kind: 'design-proposal' as const, evidence: evidence(ids), unknownIds: [] })
  const selected = p.candidates.find(c => p.acceptedCandidateIds.includes(c.id))!
  const goalText = goal?.quote ?? p.authorReview?.selectedStoryDirection ?? selected.action
  const actionSteps = steps.filter(s => !['current-state', 'resolution'].includes(s.kind))
  const proposal: StoryReasoningProposal = { protocol: 1, stage: 'initial-design', status: 'needs-review', outcome: 'proposal',
    goal: { id: 'prepared-goal', text: goalText, basis: goal
      ? { kind: 'author-text', evidence: evidence([goal.id]) }
      : basis(selected.materialIds.filter(id => known.some(item => item.id === id))) },
    constraints: known.map(m => ({ id: `material-${m.id}`, text: m.quote, basis: { kind: 'author-text', evidence: evidence([m.id]) } })),
    actions: actionSteps.map(s => ({ id: `design-action-${s.kind}`, text: s.text, basis: basis(s.materialIds), constraintIds: [], relationIds: [], unknownIds: [], respondsToEditIds: [] })),
    relations: [], unknowns: [], steps: steps.map((s, i) => ({ id: `beat-${s.kind}`, kind: s.kind, title: titles[s.kind], text: s.text, basis: basis(s.materialIds),
      actionIds: actionSteps.includes(s) ? [`design-action-${s.kind}`] : [], relationIds: [], dependsOn: i ? [`beat-${steps![i - 1]!.kind}`] : [], respondsToEditIds: [] })),
    designReview: { required: true, acceptedProposalIds: [] } }
  const beatIds = new Set(proposal.steps.map(s => s.id))
  const present = (...ks: string[]) => ks.map(k => `beat-${k}`).filter(id => beatIds.has(id))
  // Development requests and boundaries are carried by authorRequirements;
  // they are not plot facts that must be "covered" by a beat. Only concrete
  // author-established material participates in source-fact disposition.
  const sourceFacts = known.filter(m => !['author-direction', 'author-boundaries', 'author-note'].includes(m.sourceId))
  const design: StoryDesignRecord = { id: `design-${randomUUID()}`, sourceFacts: sourceFacts.map(m => ({ id: m.id, text: m.quote, source: 'user-input', disposition: 'needs-author-decision', coveredByBeatIds: [] })),
    conflictCoreBeatIds: present('current-state', 'trigger'), predicamentBeatIds: present('trigger', 'escalation'),
    storyEndBeatIds: present('current-state', 'climax-choice', 'resolution'), middleDevelopmentBeatIds: present('escalation', 'midpoint-turn', 'climax-choice') }
  validateStoryReasoningProposal(proposal, { stage: 'initial-design', sources: known.map(m => ({ id: m.id, text: m.quote, authority: 'author-material' })), protectedSteps: [], requiredEditIds: [] })
  const mapped = mapInitialReasoningProposal(proposal, design, curve.brief, { allowSimplePlan: true })
  return { ...mapped, id: curve.id, preparation: p, createdAt: curve.createdAt, designContract: compileStoryDesignContract(p, steps, goalText),
    generation: { origin: 'model', dramaticMechanism: '承接已选方向生成可编辑的故事骨架', notice: '已根据你确认的方向构思发展与暂定结局。每一段都可以修改或局部重做，确认后再进入剧情。' } }
}

/** One bounded patch, only system proposals cited by TWO drift judgments.
 * No reviewer-authored solution is sent to generation, and no partial patch is
 * published until both the existing quality review and mainline recheck pass. */
export async function repairPreparationMainline(curve: ProvisionalCurve, p: StoryPreparation, steps: Step[], protectedKinds: string[] = []) {
  const snapshot = steps.map(({ kind, text }) => ({ kind, text }))
  const state = (status: NonNullable<ProvisionalCurve['mainlineReview']>['status'], message: string, repairedBeatKinds: string[] = []) =>
    ({ steps, review: { status, message, reviewedSteps: snapshot, repairedBeatKinds } })
  const input = { curveId: curve.id, designId: curve.design?.id ?? curve.id, preparation: p, steps }
  const first = await reviewStoryDesignMainline(input)
  if (first.status === 'unavailable') return state('unavailable', '主线审阅暂不可用，设计已保留。可点击“重试主线审阅”，也可先自行审阅当前设计。')
  if (first.audit.verdict === 'supported') return state('supported', '本次主线审阅未发现任务替换；这不代表全部事实与因果都已验证。')
  if (first.audit.verdict === 'uncertain') return state('uncertain', '主线审阅证据不足，未自动修改。请查看当前设计，或重试审阅。')
  const second = await reviewStoryDesignMainline(input)
  if (second.status === 'unavailable') return state('unavailable', '主线复核暂不可用，尚未修改设计。请重试主线审阅。')
  if (second.audit.verdict !== 'mainline-drift') return state('uncertain', '两次主线判断不一致，未自动修改。请自行审阅或重试。')
  const editable = steps.filter(step => step.kind !== 'current-state' && !protectedKinds.includes(step.kind)
    && first.audit.evidenceIds.includes(`beat:${step.kind}`) && second.audit.evidenceIds.includes(`beat:${step.kind}`))
  if (!editable.length) return state('mainline-drift', '主线复核发现可能偏离，但无法确定可安全修改的系统节点。请手动编辑相关节点。')
  const selected = p.candidates.find(c => p.acceptedCandidateIds.includes(c.id))!
  const known = activePreparationMaterial(p).filter(m => m.role !== 'unknown')
  const context = { ...preparationExplanationContext(p, selected), brief: curve.brief,
    creativeFocus: preparationCreativeFocus(p), designContract: storyDesignContractInput(p),
    referenceContract: { knownMaterialIds: known.map(m => m.id) } }
  try {
    const schema = s.object({ patches: s.array(s.object({ kind: s.enum(...editable.map(step => step.kind)), text: s.text, action: s.text, expectedChange: s.text }), 1, editable.length) })
    const raw = await withQwenRequestBudget(1, () => requestQwenJson({
      systemPrompt: `${preparationStoryDesignPrompt}\n${storyDesignContractGuidance}\n${storyCreativeIntentGuidance(curve.brief, 'curve')}\n仅做故事设计主线局部修复。严格输出JSON {patches:[{kind,text,action,expectedChange}]}；两个字段必须是对新text的简洁概括，不能添加新事实。只可修改editableKinds中的节点文本，不改变节点数量、顺序和材料引用。editableKinds只是允许修改的上限，并不要求全部修改；保留仍服务原目标的现有障碍、尝试和节点，只返回确需改变的patch。起点、作者编辑、其他节点及作者选定分支全部固定。只把脱离主线的新任务及其后果接回原愿望，不趁机换一套悬念和事件；不为修复新增遗失证据、破损记录、秘密能力、手续或认证。优先让人物处理已有障碍后继续原办法，或作有动机的取舍；不要求原愿望必定成功，不新增任务来强行圆场。不要输出分析。`,
      userPrompt: JSON.stringify({ ...context, steps, outputContract: '严格输出 {patches:[{kind,text,action,expectedChange}]}。两个字段必须是对应新text的非空简洁概括；不得为填字段添加新事实。', editableKinds: editable.map(step => step.kind),
        issue: '两次复核均认为存在mainline-drift；仅修复允许节点中脱离原问题及其选择代价的发展。' }),
      temperature: 0.2, maxTokens: 2200, diagnosticStage: 'preparation-story-design-mainline-repair', outputSchema: schema }))
    if (outputShapeErrors(raw, schema).length) throw new Error('invalid-patch')
    const patches = (raw as { patches: { kind: string; text: string; action: string; expectedChange: string }[] }).patches
    if (new Set(patches.map(patch => patch.kind)).size !== patches.length) throw new Error('duplicate-patch')
    // A text patch invalidates the old excerpts. Never retain stale actions/changes.
    const revised = parseSteps({ steps: steps.map(step => {
      const patch = patches.find(patch => patch.kind === step.kind)
      return patch ? { kind: step.kind, text: patch.text, materialIds: step.materialIds, action: patch.action, expectedChange: patch.expectedChange } : step
    }) }, new Set(known.map(m => m.id)))
    const quality = await withQwenRequestBudget(1, () => requestQwenJson({ systemPrompt: `${preparationStoryDesignReviewPrompt}\n${storyDesignContractGuidance}\n${storyDirectionSelectionGuidance}`,
      userPrompt: JSON.stringify({ ...context, designContract: { ...context.designContract, ...compileStoryDesignContract(p, revised) }, steps: revised }), temperature: 0.1, maxTokens: 1800,
      diagnosticStage: 'preparation-story-design-review', outputSchema: qualityOutputSchema(criteria) }))
    if (reviewIssues(quality).length) return state('repair-failed', '局部修复未通过原有内容审阅，已保留修复前设计。可重试主线审阅或手动编辑。')
    const checked = await reviewStoryDesignMainline({ ...input, steps: revised })
    if (checked.status === 'unavailable') return state('unavailable', '修复后的主线审阅暂不可用，尚未采用修复。原设计保留，可重试主线审阅。')
    if (checked.audit.verdict !== 'supported') return state('repair-failed', '局部修复未获主线复核通过，已保留原设计。请重试或手动编辑。')
    const changed = revised.filter((step, index) => step.text !== steps[index]!.text).map(step => step.kind)
    if (!changed.length) return state('repair-failed', '本次修复没有改变偏离内容，原设计保留。请重试或手动编辑。')
    return { steps: revised, review: { status: 'repaired' as const, message: '已局部调整系统提出的发展节点，请重新审阅这一版设计。',
      reviewedSteps: revised.map(({ kind, text }) => ({ kind, text })), repairedBeatKinds: changed } }
  } catch {
    return state('repair-failed', '局部修复暂未完成，原设计已保留。可重试主线审阅，或直接编辑相关节点。')
  }
}

export async function retryPreparationMainline(curve: ProvisionalCurve): Promise<ProvisionalCurve> {
  if (!curve.preparation || !curve.reasoning || !('steps' in curve.reasoning) || curve.status !== 'draft' || !curve.beats.length) throw new AppError('当前没有可审阅的故事设计。', 409, 'STORY_PREPARATION_NOT_PENDING')
  if (process.env.STORY_DESIGN_MAINLINE_REPAIR === 'false') throw new AppError('故事设计主线局部修复已关闭。', 409, 'STORY_DESIGN_MAINLINE_DISABLED')
  const known = activePreparationMaterial(curve.preparation).filter(m => m.role !== 'unknown')
  const reasoningSteps = curve.reasoning.steps
  const contract = currentStoryDesignContract(curve)
  const steps: Step[] = curve.beats.map(beat => {
    const basis = reasoningSteps.find(step => step.id === beat.id)?.basis
    const node = contract?.nodes.find(node => node.beatId === beat.id)
    if (!kinds.includes(beat.kind as Step['kind'])) throw new AppError('当前设计包含其他类型的节点，请使用节点编辑功能处理。', 409, 'STORY_DESIGN_MAINLINE_UNSUPPORTED')
    return { kind: beat.kind as Step['kind'], text: beat.detail, materialIds: [...new Set(basis && basis.kind !== 'unknown'
      ? basis.evidence.map(e => e.sourceId).filter(id => known.some(m => m.id === id)) : [])],
      ...(node?.action === undefined ? {} : { action: node.action }),
      ...(node?.expectedChange === undefined ? {} : { expectedChange: node.expectedChange }) }
  })
  // Explicit user edits/clarifications have their own reasoning and must never
  // be rebuilt as fresh system proposals by this narrow repair path.
  const authored = curve.beats.some(beat => beat.source !== 'system-proposal') || curve.instructions.length > 0 || Boolean(curve.clarifications?.length)
  const result = await repairPreparationMainline(curve, curve.preparation, steps, authored ? steps.map(step => step.kind) : [])
  if (result.review.status !== 'repaired') return { ...curve, mainlineReview: result.review }
  const goal = known.find(m => m.quote === curve.reasoning!.goal?.text)
  if (!goal) return { ...curve, mainlineReview: { ...result.review, status: 'repair-failed', message: '当前目标引用已变化，未采用修复。请手动编辑相关节点。', reviewedSteps: steps.map(({ kind, text }) => ({ kind, text })), repairedBeatKinds: [] } }
  const mapped = mapPreparationDesign(curve, curve.preparation, goal, result.steps)
  return { ...mapped, title: curve.title, instructions: curve.instructions, rejectedProposals: curve.rejectedProposals,
    design: mapped.design && { ...mapped.design, sourceFacts: curve.design?.sourceFacts ?? mapped.design.sourceFacts },
    beats: mapped.beats.map(beat => {
      const previous = curve.beats.find(original => original.id === beat.id)
      return previous?.detail === beat.detail ? previous : beat
    }), mainlineReview: result.review }
}
