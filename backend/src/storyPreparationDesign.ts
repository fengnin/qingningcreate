import { randomUUID } from 'node:crypto'
import { AppError, requestQwenJson, withModelDiagnostic } from './qwen.js'
import { activePreparationMaterial, preparationExplanationContext, preparationMaterialAuthorityGuidance } from './storyPreparationContext.js'
import { storyCreativeIntentGuidance, preparationCreativeFocus } from './storyCreativeIntent.js'
import { storyDevelopmentGuidance, storyDevelopmentRepairGuidance, storySemanticReviewGuidance } from './storySemanticReview.js'
import { preparationOutputSchemas, qualityOutputSchema } from './storyOutputSchemas.js'
import { mapInitialReasoningProposal } from './storyInitialReasoning.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'
import { storyDirectionSelectionGuidance } from './storyPreparationDirections.js'
import type { StoryPreparation, StoryPreparationItem } from '../../shared/story-preparation.js'
import type { ProvisionalCurve, StoryDesignRecord } from '../../shared/story-contract.js'
import type { StoryReasoningProposal } from '../../shared/story-reasoning-contract.js'

const kinds = ['current-state', 'trigger', 'escalation', 'midpoint-turn', 'climax-choice', 'resolution'] as const
const titles = { 'current-state': '故事起点', trigger: '开始尝试', escalation: '尝试带来的变化', 'midpoint-turn': '新的转折', 'climax-choice': '关键选择', resolution: '暂定结局' }
const criteria = ['boundaries', 'continuity', 'causality', 'closure']
const invalid = (message: string): never => { throw new AppError(message, 502, 'STORY_PREPARATION_INVALID_OUTPUT') }
type Step = { kind: typeof kinds[number]; text: string; materialIds: string[] }

export const preparationStoryDesignPrompt = `根据作者确认的方向，提出一版从起点到暂定结局的故事骨架，供作者审阅和修改。不是复述或排列方向卡，也不是完整正文。
严格输出 JSON {steps:[{kind,text,materialIds}]}。3至6个互不重复、按故事顺序发展的节点，kind依序为current-state、trigger、可选escalation、可选midpoint-turn、可选climax-choice、resolution。起点、开始尝试、结局必须有；简单故事不必强造中段、高潮、成长或反转。每段用1至3句简洁梗概，优先60至120字，最多220字；直接概括人物做什么、处境怎样变化，不写逐镜头动作、长对白、抒情比喻、分析、问题清单或内部字段。trigger必须包含一次实际尝试，不能只写发现麻烦、找到或拿出工具。
先读完整作者材料和最新已确认卡片：action包含遇到的困难及眼前的选择；futureChoice是故事将推向的取舍；possibleResult是可能走向。保留它们的核心情境、选择意义及作者编辑。已提供selectedStoryDirection时，必须承接作者明确选定的分支；仅旧版未记录选择时可提出暂定方案。不能把作者明确保留的未知擅自定死。原卡已经指定的行动或结果不可换成无关故事。
具体设计人物采取什么办法，尝试带来什么变化，人物如何回应；需要关键选择时，写出这一版他暂定选择做什么、放弃或承担什么，接着给出这版实际走向的结局。不要让起点、行动和结局重复同一句，也不要在结局仍只并列“如果选甲就怎样、选乙就怎样”。开放结局可以保留远期未知，但当前这次行动应有可理解的落点。目标可有来由地转变，原愿望及风险仍须影响选择的意义。
允许补充服务关键行动、转折和结果的新人物、道具、必要铺垫与回应；均属于可拒绝的未来提案。优先让已有要素发挥作用，不把每个普通省略补成新任务，不为了完整强行加秘密、故障、手续或危机。普通动作、对白、环境和无关紧要的细节留给后续正文；已采用解释中的重要待展开事项，只在确实支撑当前骨架时兑现。
brief.allowSystemNamedCharacters=false时，不给新增人物起具体名字，保留作者已经提供的名字。人物称呼不需要另加身份往事来证明合理。
${preparationMaterialAuthorityGuidance}
materialIds只能引用referenceContract.knownMaterialIds中确实承接的作者片段；引用只说明从哪里出发，不证明新增情节是事实。可用空数组表示纯新增发展，尤其不能用原目标冒充结局已经成立的证明。已知背景和保留的替代路径可以在起点引用而不逐条复述；不能假装承接无关材料。保留的未知不作为已知引用或关键解决手段。
${storyDevelopmentGuidance}`

export const preparationStoryDesignReviewPrompt = `审阅一版待作者决定的完整故事骨架，严格输出 JSON {checks:[{criterion,passed,evidence}],issues:[]}。criterion为boundaries、continuity、causality、closure，每项恰好一次；evidence不超过240字，issues只列具体实质问题，最多4项。
boundaries核对作者已定条件、发展要求和明确保留的未知；continuity核对是否承接最新已选卡片的困难、选择、后续取舍和可能走向，人物尝试与回应是否仍影响后续；causality核对重要行动、变化与结果是否接得上；closure核对是否提出这一版具体暂定结果，而非重复原卡的分支预测。合理的开放结局不等于没有结局。
核对命名开关：brief.allowSystemNamedCharacters=false时不得为新人物起具体名字；已有作者名字可保留。判断连续性时，已选行动不能一直推迟到最后才出现；trigger应写出实际尝试，后续变化由人物回应接起。只拿出工具或出现新麻烦还不算实际尝试。
${preparationMaterialAuthorityGuidance}
${storySemanticReviewGuidance}
新情境、必要铺垫、人物选择和结果都是可拒绝的未来设计，不能仅因原文没有它们而拒绝。接受方向允许进一步设计，但不得更换selectedStoryDirection所确定的关键分支。仅旧版未记录选择时允许提出暂定方案，不要求作者补答普通细节。作者明确保留的未知仍不得替作者决定。原方向的核心安排及明确边界须保留。
普通互动、省略的动作对白、其他可选办法、没有大反转或人物成长都不是缺陷；必要因果过程有交代即可，不追问无关细节，不新增待办或标记。拒绝须指出具体冲突双方或哪段关键因果断裂及影响；不能用“不够精彩”或审阅者偏好的结局拒绝。所有项通过时issues=[]。`

function parseSteps(raw: unknown, knownIds: Set<string>): Step[] {
  const output = raw as { steps?: unknown[] }
  if (!output || !Array.isArray(output.steps) || output.steps.length < 3 || output.steps.length > 6) invalid('故事设计须包含3至6个节点。')
  const steps = output.steps!.map((value): Step => {
    const s = value as Step
    if (!s || !kinds.includes(s.kind) || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 220) invalid('故事节点类型或文本不合法；每段须为1至220字。')
    if (!Array.isArray(s.materialIds) || new Set(s.materialIds).size !== s.materialIds.length
      || s.materialIds.some(id => !knownIds.has(id))) invalid('故事节点只能引用有效的已知作者材料，不能引用未知或已取代材料。')
    return { kind: s.kind, text: s.text, materialIds: [...s.materialIds] }
  })
  if (steps[0]?.kind !== 'current-state' || steps[1]?.kind !== 'trigger' || steps.at(-1)?.kind !== 'resolution'
    || steps.some((s, i) => i > 0 && kinds.indexOf(s.kind) <= kinds.indexOf(steps[i - 1]!.kind))) invalid('故事节点缺少起点、尝试、结局，或顺序重复。')
  if (new Set(steps.map(s => s.text.replace(/\s/gu, ''))).size !== steps.length) invalid('每个节点需要独立的发展，不能用重复卡片文字填充。')
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
export async function developPreparationStory(curve: ProvisionalCurve, p: StoryPreparation, goal: StoryPreparationItem): Promise<ProvisionalCurve> {
  const active = activePreparationMaterial(p)
  const known = active.filter(m => m.role !== 'unknown')
  const selected = p.candidates.find(c => p.acceptedCandidateIds.includes(c.id))!
  const context = { ...preparationExplanationContext(p, selected), brief: curve.brief,
    creativeFocus: preparationCreativeFocus(p), referenceContract: { knownMaterialIds: known.map(m => m.id) } }
  let previousOutput: unknown, repair: string | undefined, failure: AppError | undefined
  let steps: Step[] | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = await requestQwenJson({ systemPrompt: `${preparationStoryDesignPrompt}\n${storyCreativeIntentGuidance(curve.brief, 'curve')}\n${storyDevelopmentRepairGuidance}\n${storyDirectionSelectionGuidance}`,
        userPrompt: JSON.stringify({ ...context, ...(repair ? { previousOutput, repair } : {}) }), temperature: attempt ? 0.2 : 0.4,
        maxTokens: 3000, diagnosticStage: 'preparation-story-design', outputSchema: preparationOutputSchemas.storyDesign })
      previousOutput = output
      const draft = parseSteps(output, new Set(known.map(m => m.id)))
      const audit = await requestQwenJson({ systemPrompt: `${preparationStoryDesignReviewPrompt}\n${storyDirectionSelectionGuidance}\ncontinuity 必须核对作者选定的走向，不能把擅自改选另一分支视作允许的进一步设计。`,
        userPrompt: JSON.stringify({ ...context, steps: draft }), temperature: 0.1, maxTokens: 1800,
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
  const evidence = (ids: string[]) => ids.map(id => ({ sourceId: id, quote: known.find(m => m.id === id)!.quote }))
  const basis = (ids: string[]) => ({ kind: 'design-proposal' as const, evidence: evidence(ids), unknownIds: [] })
  const actionSteps = steps.filter(s => !['current-state', 'resolution'].includes(s.kind))
  const proposal: StoryReasoningProposal = { protocol: 1, stage: 'initial-design', status: 'needs-review', outcome: 'proposal',
    goal: { id: 'prepared-goal', text: goal.quote, basis: { kind: 'author-text', evidence: evidence([goal.id]) } },
    constraints: known.map(m => ({ id: `material-${m.id}`, text: m.quote, basis: { kind: 'author-text', evidence: evidence([m.id]) } })),
    actions: actionSteps.map(s => ({ id: `design-action-${s.kind}`, text: s.text, basis: basis(s.materialIds), constraintIds: [], relationIds: [], unknownIds: [], respondsToEditIds: [] })),
    relations: [], unknowns: [], steps: steps.map((s, i) => ({ id: `beat-${s.kind}`, kind: s.kind, title: titles[s.kind], text: s.text, basis: basis(s.materialIds),
      actionIds: actionSteps.includes(s) ? [`design-action-${s.kind}`] : [], relationIds: [], dependsOn: i ? [`beat-${steps![i - 1]!.kind}`] : [], respondsToEditIds: [] })),
    designReview: { required: true, acceptedProposalIds: [] } }
  const beatIds = new Set(proposal.steps.map(s => s.id))
  const present = (...ks: string[]) => ks.map(k => `beat-${k}`).filter(id => beatIds.has(id))
  const design: StoryDesignRecord = { id: `design-${randomUUID()}`, sourceFacts: known.map(m => ({ id: m.id, text: m.quote, source: 'user-input', disposition: 'needs-author-decision', coveredByBeatIds: [] })),
    conflictCoreBeatIds: present('current-state', 'trigger'), predicamentBeatIds: present('trigger', 'escalation'),
    storyEndBeatIds: present('current-state', 'climax-choice', 'resolution'), middleDevelopmentBeatIds: present('escalation', 'midpoint-turn', 'climax-choice') }
  validateStoryReasoningProposal(proposal, { stage: 'initial-design', sources: known.map(m => ({ id: m.id, text: m.quote, authority: 'author-material' })), protectedSteps: [], requiredEditIds: [] })
  const mapped = mapInitialReasoningProposal(proposal, design, curve.brief, { allowSimplePlan: true })
  return { ...mapped, id: curve.id, preparation: p, createdAt: curve.createdAt,
    generation: { origin: 'model', dramaticMechanism: '承接已选方向生成可编辑的故事骨架', notice: '已根据你确认的方向构思发展与暂定结局。每一段都可以修改或局部重做，确认后再进入剧情。' } }
}
