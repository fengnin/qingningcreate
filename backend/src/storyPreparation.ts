import { randomUUID } from 'node:crypto'
import { generateDirectionCards, directionCardGenerationPrompt } from './storyDirectionCards.js'
import { directionLogicReviewGuidance } from './storyDirectionLogicReview.js'
import { parsePreparationExplanation } from './storyPreparationExplanation.js'
import { activePreparationMaterial } from './storyPreparationContext.js'
export { activePreparationMaterial } from './storyPreparationContext.js'
import { hasProposalProtocolLeak } from './storyProposalProse.js'
import { storyCreativeIntentGuidance, storyCreativeFocusGuidance, preparationCreativeFocus } from './storyCreativeIntent.js'
import { storyDevelopmentGuidance, storyDevelopmentRepairGuidance, storySemanticReviewGuidance, storyTechnicalReviewGuidance, storyMainlineGoalGuidance, storyCausalMechanismGuidance, storyResourceConsistencyGuidance } from './storySemanticReview.js'
import { developmentStateGuidance, developmentStateIssues, type DevelopmentState } from './storyDevelopmentState.js'
import { bridgeRepairDiagnostic, parseBridgeReviewCheck, bridgeEvidenceCatalog, storyDirectionDetailGuidance, type BridgeEvidence } from './storyBridgeReview.js'
import { generateSceneDraft, sceneAuthorRequirements } from './storySceneDraft.js'
import { AppError, requestQwenJson, withModelDiagnostic } from './qwen.js'
import { preparationOutputSchemas as schemas, preparationDirectionQualitySchema, projectionOutputSchema, causalReviewOutputSchema, factReviewOutputSchema } from './storyOutputSchemas.js'
import { parseFactReviewChecks } from './storyFactReview.js'
import { developPreparationStory } from './storyPreparationDesign.js'
import type { StoryCausalBridge, StoryMainlineAnchor, StoryMainlineGoal, StoryPreparation, StoryPreparationCandidate, StoryPreparationItem, StoryPreparationReview, StoryExpansionNeed, StoryCreativeFocus } from '../../shared/story-preparation.js'
import type { CreativeBrief, ProvisionalCurve } from '../../shared/story-contract.js'

const invalid = (message: string): never => { throw new AppError(message, 502, 'STORY_PREPARATION_INVALID_OUTPUT') }
class PreparationQuoteError extends AppError {
  constructor(readonly materialIndex: number) {
    super(`material[${materialIndex}].quote：原文引用不是连续逐字内容；不能补写依据。`, 502, 'STORY_PREPARATION_INVALID_OUTPUT')
  }
}
class PreparationCoverageError extends AppError {
  constructor(readonly sourceId: string, readonly offset: number) {
    super(`sources 的覆盖校验失败（字符位置 ${offset}）：材料整理遗漏原文，请重新提取；不是作者资料不足。`, 502, 'STORY_PREPARATION_INVALID_OUTPUT')
  }
}
class PreparationMaterialIdError extends AppError {
  constructor() {
    super('材料 ID 必须唯一，且不能与 sources.id 相同。', 502, 'STORY_PREPARATION_INVALID_OUTPUT')
  }
}
const causalBridgeMaxAttempts = 3
class PreparationQualityError extends AppError {
  constructor(readonly issues: string[], readonly origin: 'directions' | 'causal-bridge' = 'directions', attempt = 1, issueTypes: string[] = []) {
    super('这个方向的内容审阅未通过，请换一个提案或调整想法；尚未生成故事曲线。', 502, 'STORY_PREPARATION_QUALITY_FAILED',
      undefined, undefined, undefined, {
        stage: origin === 'causal-bridge' ? 'preparation-future-choice:content-review' : 'preparation-directions:content-review',
        attempt, maxAttempts: origin === 'causal-bridge' ? causalBridgeMaxAttempts : 2,
        // Categories only: author text and model criticism stay out of API diagnostics.
        reason: [...new Set(issueTypes)].join(',') || 'content-review-rejected',
      })
  }
}
const preparationQualityCriteria = ['facts', 'causality', 'requirements', 'author-control', 'questions'] as const
const openIdeaDirectionsGuidance = `原文未明确人物目标时，直接围绕已有主题、场景、关系或感觉构思三种可拒绝的故事方向，不要求作者先补充想法。未提供的人物或愿望可作为暂定提案，不能宣称是作者原本指定的目标；人物称呼遵守命名开关。作者明确说暂不确定的要素继续保持开放，不能擅自定案或依赖它解决问题。materialIds引用实际承接的原始材料，不为生成方向把主题、风格或未知改标成goal。审阅按原文检查相容性与提案内部因果，不能仅因没有预先确定人物目标而拒绝或追问。`
export function preparationDirectionQualityPrompt(brief: CreativeBrief): string {
  return `${directionLogicReviewGuidance}\n${openIdeaDirectionsGuidance}
完成上述独立因果判断后，审查故事提案质量。你负责核对当前方向卡，不负责替它扩写、象征化或解释成更好的故事。提供 structuredProposal 时，逐卡按 options 原顺序返回恰好两个 branches，直接核对 difficulty、options.action 和对应 options.consequence；proposal 是同一内容的展示形式。每个 outcome 必须保留对应 consequence 的实际声称，不得把“可能、等待、风险、尝试”改成已完成，也不得替它补出成功条件。返回JSON {actionChecks:[上述聚焦判断，仅structuredProposal时返回],candidateChecks:[{id,pursuedGoal,branches:[{action,outcome,goalEffect,mechanism}],relation,reason}],checks:[{criterion,passed,evidence}],issues:[具体问题]}。
先提取每个分支再作结论。branches覆盖卡片全部选择，通常两个，不能只挑较合理的分支。action与outcome各不超过60字，分别概括卡片实际写出的行动和结果，必须保留各自人物主体；不能把行动目的填成已经发生的结果，也不能把“他”改为主角。goalEffect仅按实际结果对原目标的影响选择：advances=原目标有实际进展；attempted=结果尚未给定、仍是有作用途径的合理尝试；postponed=明确延后；abandoned=有动机地放弃；failed=明确失败；substituted=把另一体验、凭据或别人的经历冒充完成；unaddressed=结果转去无关信息且没交代原目标进展、受阻、失败或取舍。结果已写成别人获得机会并转入无关对话时，不能以主角原先想求助为由填attempted。mechanism判断已写出的行动能否支撑已声称的结果：supported或unsupported；普通未展开细节不算unsupported，不强求尝试成功。等待回复、他人合理回应、普通求助或配合，不因结果不受主角控制就判unsupported；只拒绝真正需要推翻已有限制、凭空新增决定性能力或省略关键作用途径的结果。每个分支独立生效，任何substituted、unaddressed或unsupported均需修复。
若输入提供 consequenceCatalog，先返回 consequenceChecks:[{id,resultStatus,prerequisite,prerequisiteStatus,verdict,reason}]，每个片段ID恰好一次。resultStatus按原文措辞取asserted（直接断言变化成立）、conditional（明确以某事发生为条件）、uncertain（可能或风险）、planned（打算安排）；不能因整张卡是未来提案就把所有断言一律改成conditional。prerequisite用不超过40字指出该结果成立需要的关键事件，没有则为空；prerequisiteStatus取satisfied-by-action（假设执行当前action，该事件即完成）、explicit-condition（原文明确写了该事件完成后的条件）、only-planned（当前action只是约定、准备或承诺以后做该事件）、missing（关键事件及途径缺失）、not-needed（无关键前提）。普通工具使用、沟通回应等可自然展开，不列成缺失前提。verdict仅supported或unsupported，reason不超过60字，不能用“起点、预期、将来有望履行”证明一个已经无条件宣称成立的结果。当前action本身若是实际执行所需事件，允许描写其后果；若只是安排未来执行，不能省略实际履行就声称责任、占有或风险已消失。
片段必须连同完整consequence、对应action和difficulty判断，保留前文的如果、可能、失败与时间条件，不割裂条件句。逐项核对片段内所有关键断言，前半句合理不能抵消后半句跳跃。只评原文所称结果，不提供修复办法。任何关键断言unsupported均须修复，不能被分支或总评通过抵消。无catalog时不返回consequenceChecks，保留原有编辑场景的审阅格式。
先逐卡核对原始愿望。原目标只从 sources、material、mainlineGoals 中读取；proposal 是待核对的提案，不能反过来定义作者原本想要什么。pursuedGoal 概括卡片人物实际在做的事，不能自动复制原目标。对眼前的每一种应对分别追踪到 possibleResult，再给整张卡一个 relation：
- pursues-goal：各分支的办法仍争取原活动、行动或明确任务，允许失败或未完成。
- goal-tradeoff：人物明确接受改期、放弃或转变，原目标因此失去的机会、代价或承诺仍直接驱动取舍。不能把做别的事冒充另一种完成。
- substituted：任一分支用另一任务、象征替身、表面凭据或他人代为经历冒充原目标的实现。只有作者原文就要求该替代任务时才不算偷换。
- unrelated：后续已转去另一任务，原目标只剩开头提及、同一场所或末尾感悟。
任一分支偷换目标时整张卡按 substituted 处理；合理失败、改期或放弃可为 goal-tradeoff，不强求完成原计划。理由仅解释提案实际内容。
原文没有要求完整程度时，不擅自补成必须全程、全部或一次完成。分支明确交代未完成的部分及其代价，仍争取同一活动或任务的部分进展，可判goal-tradeoff；只有把部分、替代任务或凭据冒充全部完成才判substituted，不要求另加承认改目标的台词。
candidateChecks 每个候选 id 恰好一次，无候选时为空数组；reason 与 pursuedGoal 各不超过120字。任一 substituted 或 unrelated 都是实质问题，不会被其他卡片或五项总评抵消。
随后完成五项 checks，每项恰好一次，passed 为布尔值，evidence 不超过140字：
facts：保留人物主体、原目标、已定事实、否定、期限、关系和条件。不把初始状态的未来变化误判为已有事实冲突。
causality：人物应对须与所称结果有作用关系；不能用新巧合替人物完成选择。三张卡是互斥备选，不互相比较为时间线；阻碍和取舍须实质不同。有sceneDraft时不得更换已定尝试、变化及回应。
按下述共享因果、资源尺度检查行动能否启动及支撑所称结果；实质断裂令 mechanism 为 unsupported、causality 失败，并指明候选 id。拒绝理由须同时指出卡片的具体限制和与之冲突的行动或结果，不能只写不自然、缺细节或缺作者授权。原目标没有限定版本、场所时，改变版本或场所不构成偷换；提案自己的新设定不能提升为作者限制。明确写成失败的错误尝试可以成立，不得擅自把它改判为声称成功。剧情写得太满或生硬只作为改进空间，不为审美偏好另设硬拦截。
重点区分安排与完成、意愿与能力、风险降低与风险消失：等待、约定、提供凭据本身不能完成仍未发生的交付或状态转移；普通道具、保险、手续不能凭空获得决定性功能。关键后果必须能由对应行动和已给条件支撑；把关键缺口藏在“可能”后仍是 unsupported。此处不要求补齐普通操作细节，也不拒绝明确可能失败的合理尝试。新增规则只按故事世界的合理性和必要性核对，不因作者没事先提供就一概拒绝。
requirements：遵守作者要求、命名权限和世界设定。新人物、道具、情境可以创作，不因作者没写过就拒绝；但不能靠明显不可能、越权或违背已有限制的办法完成关键结果。
author-control：新增内容都是可拒绝的未来设计，不是已发生事实；保留authorAction和作者明确保留的未知。缺少普通细节不等于越界。
questions：仅问必要的人物目标或作者明确保留且无法绕过的未知；无问题时通过，不追问自造设定的证明。
只拒绝实质缺陷，同义改写、未采用最优办法、普通省略不算失败。感觉和戏剧力量默认约束整篇，卡片只需相容并保留空间。issues最多三项，每项不超过200字；指明候选id和具体问题，不补写新情节。总评通过时 issues 应为空；逐卡判定无论总评怎样都独立生效。
${storyMainlineGoalGuidance}
${storyCausalMechanismGuidance}
${storyResourceConsistencyGuidance}
${storySemanticReviewGuidance}
${storyCreativeFocusGuidance}
${storyCreativeIntentGuidance(brief, 'directions')}`
}
const futureChoiceIssueTypes = ['none', 'author-conflict', 'world-implausible', 'causal-gap', 'mainline-drift'] as const
const generatedProposalTextMax = 240
function logPreparationReview(stage: string, attempt: number, candidateIds: string[], decision: object): void {
  if (process.env.STORY_PREPARATION_DIAGNOSTICS !== 'true') return
  // Model judgments may quote the author's text; keep them in opt-in local server logs only.
  console.warn('[preparation] review', JSON.stringify({ stage, attempt, candidateIds, decision }))
}
function object(value: unknown, keys: string[], optionalKeys: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('输出必须是对象。')
  const r = value as Record<string, unknown>
  if (Object.keys(r).some(key => !keys.includes(key) && !optionalKeys.includes(key)) || keys.some(k => !(k in r))) {
    if (process.env.STORY_PREPARATION_DIAGNOSTICS === 'true') console.warn('[preparation] unexpected output keys', { expected: keys, actual: Object.keys(r) })
    invalid('输出字段不符合当前阶段，禁止夹带事实更新或确认状态。')
  }
  return r
}
function list(value: unknown, max = 24): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid('列表缺失或过长。')
  return value as unknown[]
}
function text(value: unknown, max = 240, field = '文本'): string {
  if (typeof value !== 'string' || !value.trim()) return invalid(`${field}缺失。`)
  if (value.length > max) return invalid(`${field}长度为 ${value.length}，超过 ${max} 字上限。`)
  return value as string
}
function ids(value: unknown, allowed: Set<string>, path = '引用'): string[] {
  const result = list(value).map(v => text(v, 80))
  if (new Set(result).size !== result.length) invalid(`${path}：引用重复。`)
  const missing = result.filter(id => !allowed.has(id))
  if (missing.length) invalid(`${path}：引用不在合法集合中：${missing.join(', ')}。合法 ID：${[...allowed].join(', ') || '无'}。不得将未知或设计引用转换为已知依据。`)
  return result
}
function unique(items: { id: string }[]) {
  if (new Set(items.map(i => i.id)).size !== items.length) invalid('ID 重复。')
}

/** Compress only generated prose before content review. References, author
 * text and every already valid field remain byte-for-byte unchanged. */
async function repairGeneratedTextLengths(output: unknown, sources: StoryPreparation['sources'], stage: string): Promise<unknown> {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output
  const repaired = structuredClone(output) as Record<string, unknown>
  const fields: { id: string; path: string; text: string; maxLength: number; targetLength: number; record: Record<string, unknown>; key: string }[] = []
  const collect = (value: unknown, path: string, limits: Record<string, number>, maxLength = generatedProposalTextMax) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const record = value as Record<string, unknown>
    for (const [key, targetLength] of Object.entries(limits)) {
      const value = record[key]
      if (typeof value === 'string' && value.length > maxLength) fields.push({
        id: `t${fields.length}`, path: `${path}.${key}`, text: value, maxLength, targetLength, record, key,
      })
    }
  }
  // Review and display must use the same repaired option/consequence pairs.
  // Component budgets keep the compiled card within its existing text limit.
  if (Array.isArray(repaired.plans) && repaired.plans.length >= 1 && repaired.plans.length <= 3) repaired.plans.forEach((value, i) => {
    collect(value, `plans[${i}]`, { difficulty: 55 }, 80)
    if (value && typeof value === 'object' && Array.isArray(value.options)) value.options.forEach((option: unknown, j: number) => {
      collect(option, `plans[${i}].options[${j}]`, { action: 28 }, 60)
      collect(option, `plans[${i}].options[${j}]`, { consequence: 35 }, 60)
    })
  })
  if (Array.isArray(repaired.candidates) && repaired.candidates.length <= 3) repaired.candidates.forEach((value, i) => {
    collect(value, `candidates[${i}]`, { action: 110, possibleResult: 80, futureChoice: 80 })
    if (value && typeof value === 'object') collect(value.causalBridge, `candidates[${i}].causalBridge`, { method: 100, change: 100 })
  })
  if (Array.isArray(repaired.bridges) && repaired.bridges.length <= 3) repaired.bridges.forEach((value, i) => collect(value, `bridges[${i}]`, { method: 100, change: 100 }))
  if (Array.isArray(repaired.futureChoices) && repaired.futureChoices.length <= 3) repaired.futureChoices.forEach((value, i) => collect(value, `futureChoices[${i}]`, { text: 80 }))
  if (Array.isArray(repaired.developments) && repaired.developments.length <= 3) repaired.developments.forEach((value, i) => {
    if (value && typeof value === 'object') {
      collect(value.attempt, `developments[${i}].attempt`, { text: 100 })
      collect(value.change, `developments[${i}].change`, { text: 100 })
      collect(value.futureChoice, `developments[${i}].futureChoice`, { text: 80 })
    }
  })
  if (!fields.length) return output
  try {
    const raw = await requestQwenJson({
      systemPrompt: `只压缩系统提案中超长的文字字段，不重新构思故事。返回精确 JSON {texts:[{id,text}]}，fields 中每个 id 恰好一项，不输出其他字段。sources 是不可改写的作者原文，proposal 是上下文。
每项按 targetLength 压缩，maxLength 是硬上限。长度按程序的字符串长度统计，标点、空格和英文也计入，部分表情占两位；actualLength 是程序已测长度。不要贴着上限写，也不要自报字数。
保留原有事件、人物应对、选择、代价、否定、条件和不确定性，删解释、修饰及重复内容；action 保留“遇到的难处”和“眼前的选择”。不新增事件、设备、规则或结果，不把可能改成已发生。只返回所列字段的压缩文本，其余内容由程序原样保留。`,
      userPrompt: JSON.stringify({ sources, proposal: output, fields: fields.map(({ record, key, ...field }) => ({ ...field, actualLength: field.text.length })) }),
      temperature: 0.1, maxTokens: Math.min(3600, 300 + fields.reduce((n, field) => n + field.targetLength * 2, 0)), diagnosticStage: stage,
      outputSchema: schemas.compression,
    })
    const result = object(raw, ['texts'])
    const replacements = list(result.texts, fields.length).map(value => {
      const item = object(value, ['id', 'text'])
      const field = fields.find(field => field.id === item.id)
      if (!field) return invalid('压缩结果引用了未请求的文字字段。')
      return { id: field.id, field, value: text(item.text, field.maxLength, field.path) }
    })
    unique(replacements)
    if (replacements.length !== fields.length) invalid('压缩结果遗漏超长字段。')
    for (const { field, value } of replacements) field.record[field.key] = value
    return repaired
  } catch (error) {
    throw withModelDiagnostic(error, { stage, attempt: 1, maxAttempts: 1 })
  }
}

export const preparationExtractionPrompt = `先整理作者材料，只分类固定原文片段，不设计曲线或行动，不补事实。
 sources中author-setting是作者已确定的设定；author-direction和author-note都是作者希望故事兑现的创作要求，不是已发生事件或人物当前目标；author-boundaries是必须保留或避免的创作要求，不能改成可选项。仍根据原文保留明确未知；主输入也可能包含同样要求，不需要作者重复填写。
未给具体名字、标题、地点名称，不等于作者保留未知。比如“一个包裹放在门边”是已定事实，即使没写包裹内容；不能因为细节没写就把整句标unknown。
输出精确 JSON {material:[{id,role}]}，每个输入 material.id 恰好出现一次，不能新增或遗漏 ID，不输出 quote 或 sourceId。原文由程序原样保存，你没有改写原文的权限。role 为 fact|condition|goal|unknown；goal 是故事人物要完成的事（包括明确承诺），作者想写什么主题或风格是 condition，不是人物目标。明确保留的未定内容是 unknown，不把明确的风格或题材归为未知。没有期限不构成阻碍，兼容条件不构成冲突。
分类前先分清说话层级：作者想让故事出现的结局、关系变化、人物成长或情绪效果都是创作约束 condition；即使提到了人物，也不等于人物当下想完成的事。只有原文已赋予故事中的人物一个愿望、任务或承诺才标 goal。原文没有这种目标时允许所有片段都不是 goal，不能为了生成行动把结尾期待改标 goal。依据整份 sources 判断代词和上下文，不按“想”字判断。`

/** Source framing, not semantic extraction: every character stays in an
 * immutable contiguous slice. Only the role is delegated to the model. */
export function framePreparationSources(sources: StoryPreparation['sources']): Omit<StoryPreparationItem, 'role'>[] {
  const frames: Omit<StoryPreparationItem, 'role'>[] = []
  for (const source of sources) {
    let quote = ''
    const flush = () => {
      if (quote.trim()) frames.push({ id: `m${frames.length}`, sourceId: source.id, quote })
      quote = ''
    }
    for (const char of source.text) {
      if (quote.length + char.length > 240) flush()
      quote += char
      if (/[，。！？；\n]/u.test(char)) flush()
    }
    flush()
  }
  // Long inputs can have many tiny clauses. Merge only adjacent slices from
  // the same source, without adding/removing a character or interpreting it.
  while (frames.length > 24) {
    const index = frames.findIndex((f, i) => frames[i + 1]?.sourceId === f.sourceId && f.quote.length + frames[i + 1]!.quote.length <= 240)
    if (index < 0) throw new AppError('想法过长，请分段补充。', 400, 'INVALID_REQUEST')
    frames[index]!.quote += frames[index + 1]!.quote
    frames.splice(index + 1, 1)
  }
  return frames.map((f, i) => ({ ...f, id: `m${i}` }))
}

function classifyPreparationMaterial(value: unknown, frames: ReturnType<typeof framePreparationSources>, sources: StoryPreparation['sources']): StoryPreparationItem[] {
  const r = object(value, ['material'])
  const roles = list(r.material).map(v => {
    const item = object(v, ['id', 'role'])
    if (!['fact', 'condition', 'goal', 'unknown'].includes(String(item.role))) invalid('原文分类不合法。')
    return { id: text(item.id, 80), role: item.role as StoryPreparationItem['role'] }
  })
  unique(roles)
  if (roles.length !== frames.length || roles.some(r => !frames.some(f => f.id === r.id))) invalid('原文分类必须覆盖全部固定材料 ID，不能新增或遗漏。')
  return parsePreparationMaterial({ material: frames.map(f => ({ ...f, role: roles.find(r => r.id === f.id)!.role })) }, sources)
}


export function parsePreparationMaterial(value: unknown, sources: StoryPreparation['sources']): StoryPreparationItem[] {
  const r = object(value, ['material'])
  const material = list(r.material).map((v, index) => {
    const m = object(v, ['id', 'role', 'sourceId', 'quote'])
    if (!['fact', 'condition', 'goal', 'unknown'].includes(String(m.role))) invalid('原文分类不合法。')
    const item = { id: text(m.id, 80), role: m.role as StoryPreparationItem['role'], sourceId: text(m.sourceId, 80), quote: text(m.quote) }
    const source = sources.find(s => s.id === item.sourceId)
    if (!source) return invalid(`material[${index}].sourceId：材料来源 ID 不存在；不能补写依据。`)
    if (!source.text.includes(item.quote)) throw new PreparationQuoteError(index)
    return item
  })
  if (new Set(material.map(m => m.id)).size !== material.length || material.some(m => sources.some(s => s.id === m.id))) throw new PreparationMaterialIdError()
  if (!material.length) invalid('缺少材料。')
  // Coverage is positional, not a keyword test or a semantic truth certificate.
  for (const source of sources) {
    const covered = new Set<number>()
    for (const m of material.filter(m => m.sourceId === source.id)) {
      for (let pos = source.text.indexOf(m.quote); pos >= 0; pos = source.text.indexOf(m.quote, pos + 1)) {
        for (let i = pos; i < pos + m.quote.length; i++) covered.add(i)
      }
    }
    let offset = 0
    for (const c of source.text) {
      if (!/[\p{P}\p{Z}\s]/u.test(c) && !covered.has(offset)) throw new PreparationCoverageError(source.id, offset)
      offset += c.length
    }
  }
  return material
}

export function preparationReferenceContract(material: StoryPreparationItem[]) {
  return { knownMaterialIds: material.filter(m => m.role !== 'unknown').map(m => m.id),
    preconditionMaterialIds: material.filter(m => m.role === 'fact' || m.role === 'condition').map(m => m.id),
    questionMaterialIds: material.map(m => m.id), unknownDependencyIds: 'questions[].id' }
}

export function parsePreparationCandidates(value: unknown, material: StoryPreparationItem[]): Pick<StoryPreparation, 'candidates' | 'questions'> {
  const r = object(value, ['candidates', 'questions'])
  const referenceContract = preparationReferenceContract(material)
  const materialIds = new Set(material.map(m => m.id)), known = new Set(referenceContract.knownMaterialIds)
  const allowedPreconditions = new Set(referenceContract.preconditionMaterialIds)
  const questions = list(r.questions, 8).map((v, i) => {
    const q = object(v, ['id', 'question', 'materialIds'])
    const question = text(q.question)
    if (hasProposalProtocolLeak(question, material.map(m => m.quote))) invalid('补充问题不能要求作者理解内部字段或材料 ID。')
    return { id: text(q.id, 80), question, materialIds: ids(q.materialIds, materialIds, `questions[${i}].materialIds`) }
  })
  const questionIds = new Set(questions.map(q => q.id))
  const candidates = list(r.candidates, 3).map((v, i) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) invalid('输出必须是对象。')
    const optionalKeys = ['futureChoice', 'causalBridge'].filter(key => key in (v as Record<string, unknown>))
    const candidateKeys = ['id', 'action', 'materialIds', 'preconditionIds', 'possibleResult', 'resultBasisIds', 'unknownIds', ...optionalKeys]
    const c = object(v, candidateKeys)
    const candidateMaterialIds = ids(c.materialIds, known, `candidates[${i}].materialIds`)
    const resultBasisIds = ids(c.resultBasisIds, known, `candidates[${i}].resultBasisIds`)
    let causalBridge: StoryCausalBridge | undefined
    if (c.causalBridge !== undefined) {
      const bridge = object(c.causalBridge, ['method', 'change', 'methodBasisIds', 'changeBasisIds'])
      const methodBasisIds = ids(bridge.methodBasisIds, known, `candidates[${i}].causalBridge.methodBasisIds`)
      const changeBasisIds = ids(bridge.changeBasisIds, known, `candidates[${i}].causalBridge.changeBasisIds`)
      const method = text(bridge.method, generatedProposalTextMax, `candidates[${i}].causalBridge.method`)
      const change = text(bridge.change, generatedProposalTextMax, `candidates[${i}].causalBridge.change`)
      if (!method || !change || method === change || !methodBasisIds.length) invalid('因果桥必须包含办法、处境变化和办法的目标来源。')
      causalBridge = { method, change, methodBasisIds, changeBasisIds }
    }
    const item: StoryPreparationCandidate = { id: text(c.id, 80), action: text(c.action, generatedProposalTextMax, `candidates[${i}].action`), materialIds: candidateMaterialIds,
      preconditionIds: ids(c.preconditionIds, allowedPreconditions, `candidates[${i}].preconditionIds`), possibleResult: text(c.possibleResult, generatedProposalTextMax, `candidates[${i}].possibleResult`), resultBasisIds, unknownIds: ids(c.unknownIds, questionIds, `candidates[${i}].unknownIds`),
      ...(c.futureChoice === undefined ? {} : { futureChoice: text(c.futureChoice, generatedProposalTextMax, `candidates[${i}].futureChoice`) }), ...(causalBridge ? { causalBridge } : {}) }
    for (const prose of [item.action, item.possibleResult, item.futureChoice].filter((value): value is string => !!value)) {
      if (hasProposalProtocolLeak(prose, material.map(m => m.quote))) invalid('故事提案不能包含内部引用字段或材料 ID；引用只放在引用数组。')
    }
    if (!item.materialIds.length) invalid('故事方向缺少作者目标来源。')
    if (item.unknownIds.some(id => !questions.find(q => q.id === id)!.materialIds.some(mid => material.find(m => m.id === mid)?.role === 'unknown'))) invalid('候选的补充问题必须对应作者保留的未知材料，不能把新增虚构设定转成事实核查。')
    return item
  })
  unique([...material, ...questions, ...candidates])
  if (candidates.length && questions.some(q => !candidates.some(c => c.unknownIds.includes(q.id)))) invalid('不要附加与候选无依赖关系的确认问题；可选虚构细节直接作为提案。')
  if (!candidates.length && !questions.length) invalid('未给行动或可恢复的具体问题。')
  return { candidates, questions }
}

function coversCandidates(items: { id: string }[], candidates: StoryPreparationCandidate[]): boolean {
  const expected = new Set(candidates.map(candidate => candidate.id))
  return items.length === expected.size && new Set(items.map(item => item.id)).size === expected.size
    && items.every(item => expected.has(item.id))
}

function parseFutureChoiceProjection(raw: unknown, candidates: StoryPreparationCandidate[]) {
  const output = object(raw, ['developments'])
  const developments = list(output.developments, candidates.length).map((value, index) => {
    const entry = object(value, ['id', 'attempt', 'change', 'futureChoice'])
    const attempt = object(entry.attempt, ['means', 'methodUses', 'text', 'materialIds'])
    const change = object(entry.change, ['outcome', 'states', 'text', 'materialIds'])
    const item = { id: entry.id, means: attempt.means, methodUses: attempt.methodUses, method: attempt.text, change: change.text, methodBasisIds: attempt.materialIds,
      changeBasisIds: change.materialIds, outcome: change.outcome, states: change.states, futureChoice: entry.futureChoice }
    if (!Array.isArray(item.methodBasisIds) || !Array.isArray(item.changeBasisIds)
      || item.methodBasisIds.some(id => typeof id !== 'string') || item.changeBasisIds.some(id => typeof id !== 'string')) invalid('因果桥来源 ID 格式不合法。')
    const means = list(item.means, 3).map(value => {
      const entry = object(value, ['id', 'capability', 'status'])
      if (!['available', 'unavailable', 'uncertain'].includes(String(entry.status))) invalid('能力状态不合法。')
      return { id: text(entry.id, 80), capability: text(entry.capability, 140), status: entry.status as DevelopmentState['means'][number]['status'] }
    })
    unique(means)
    if (!means.length) invalid('每条办法至少记录一项实际手段或条件。')
    const methodUses = list(item.methodUses, 3).map(value => {
      const use = object(value, ['meansId', 'mode'])
      if (!means.some(means => means.id === use.meansId) || !['rely', 'test'].includes(String(use.mode))) invalid('办法的能力依赖不存在或模式不合法。')
      return { meansId: text(use.meansId, 80), mode: use.mode as 'rely' | 'test' }
    })
    if (!methodUses.length) invalid('办法缺少实际依赖的手段。')
    if (new Set(methodUses.map(use => use.meansId)).size !== methodUses.length) invalid('办法的能力依赖重复。')
    const states = list(item.states, 5).map(value => {
      const entry = object(value, ['id', 'statement', 'status'])
      if (!['holds', 'absent', 'uncertain'].includes(String(entry.status))) invalid('结果状态不合法。')
      return { id: text(entry.id, 80), statement: text(entry.statement, 140), status: entry.status as DevelopmentState['states'][number]['status'] }
    })
    unique(states)
    if (!states.length || !['success', 'partial', 'failure', 'uncertain'].includes(String(item.outcome))) invalid('结果状态或成败缺失。')
    const choice = object(item.futureChoice, ['text', 'requires'])
    const choiceRequires = list(choice.requires, 5).map(value => {
      const requirement = object(value, ['stateId', 'status'])
      if (!states.some(state => state.id === requirement.stateId) || !['holds', 'absent', 'uncertain'].includes(String(requirement.status))) invalid('后续选择引用的结果状态不存在或状态不合法。')
      return { stateId: text(requirement.stateId, 80), status: requirement.status as DevelopmentState['choiceRequires'][number]['status'] }
    })
    if (new Set(choiceRequires.map(requirement => requirement.stateId)).size !== choiceRequires.length) invalid('后续选择的状态依赖重复。')
    return { id: text(item.id, 80), method: text(item.method, generatedProposalTextMax, `developments[${index}].attempt.text`), change: text(item.change, generatedProposalTextMax, `developments[${index}].change.text`),
      methodBasisIds: item.methodBasisIds as string[], changeBasisIds: item.changeBasisIds as string[],
      choice: text(choice.text, generatedProposalTextMax, `developments[${index}].futureChoice.text`),
      plan: { means, methodUses, states, choiceRequires, outcome: item.outcome as DevelopmentState['outcome'] } }
  })
  const bridges = developments.map(({ id, method, change, methodBasisIds, changeBasisIds }) => ({ id, method, change, methodBasisIds, changeBasisIds }))
  if (!coversCandidates(bridges, candidates)) invalid('因果桥没有覆盖全部方向。')
  return { bridges, choices: developments.map(({ id, choice }) => ({ id, value: choice })),
    plans: developments.map(({ id, plan }) => ({ id, plan })) }
}

// A malformed response is not a failed story judgment. Repair only this
// response; keep the semantic repair budget and previous approvals intact.
async function requestPreparationResponse<T>(options: Parameters<typeof requestQwenJson>[0], parse: (raw: unknown) => T | Promise<T>): Promise<T> {
  let previousOutput: unknown
  let validationFailure: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = await requestQwenJson({ ...options, ...(attempt ? {
      userPrompt: JSON.stringify({ ...JSON.parse(options.userPrompt), previousOutput, validationFailure }),
    } : {}) })
    try { return await parse(output) } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'STORY_PREPARATION_INVALID_OUTPUT' || error.modelDiagnostic) throw error
      if (attempt) throw withModelDiagnostic(error, { stage: `${options.diagnosticStage}:response-schema`, attempt: 2, maxAttempts: 2 })
      previousOutput = output
      validationFailure = error.message
    }
  }
  return invalid('模型审阅未完成。')
}

export const causalBridgeReviewPrompt = `审查每条方向的“办法→处境变化→故事将推向”因果桥。你审阅的是供作者选择的故事方向大纲，不是已写完的小说。职责只限当前因果桥是否成立；作者已定事实另有核对。按整条 action、possibleResult、method、change、futureChoice 的实际含义判断，不按是否逐字复述判断。所有新内容都是尚未发生、可拒绝的创意。
按以下顺序判断，不增设检查任务：
1. 读出这次尝试实际造成或引出的变化，再看变化怎样影响后续选择。处境变化包括失败、恶化、暴露、失去机会、新信息及关系改变；它不等于改善处境或完成原目标。人物的错误办法带来负面后果，再迫使人物取舍，本身就是推进。暂时稳住一次谈话与问题随后加剧可以同时成立，不能把局部效果读成彻底解决。
2. 按完整提案连接事件，不把字段当成隔离的事实快照。method写尝试，change可以首次写接下来的动作、发现、道具遗失或他人回应，不要求在method预先重复。change已经写出的外显动作、他人观察或回应就是提案内容，不能又以method没写同一动作判缺失。分清设备效果与人物反应：设备未产生声音或信号，不妨碍他人看见使用者的动作、迟疑并开口回应。人物到达场所、接触他人或尝试办法，可以引出相关偶遇和新事件。不要求每件事都由上一步直接造成；只在不断空降无关麻烦、人物办法及其后果不再影响选择时判断裂。
3. 对可能的缺口先判断能否在正文自然展开。${storyDirectionDetailGuidance}不要求在大纲中证明一句话必定引起某种心理反应。允许按题材惯例创作新设定，不从未写出的地方推断“必定没有”；尤其不得假定某种魔法、资格或心理反应是唯一途径，再据此拒绝。
4. 最后只拦截实质问题：办法与声称的关键结果没有可用的作用途径；明确否定的状态被当成已成立；核心机制明显不可能或违反该故事明确规则；后续转向与原愿望、关系及代价全无连接。已明确失效的渠道不能悄悄产生输出，存储内容不能在没有读取或传递途径时被解码播放，证据不能直接证明其不包含的信息。关键结果不能仅靠“共振、感应、同步”等名称成立；普通可用工具不要求内部实现，奇幻按其自洽规则判断，不以现实不存在为由拒绝。人物可以猜测、误会或尝试，但未证实不能叙述成已证实，可能发生不能变成成功保证。
后续选择可以包含尚未执行的新行动或条件分支，也可以由已发生的事触发目标转变、主动牺牲原打算；核对原愿望、风险、关系或承诺是否仍影响取舍的意义和代价，不要求每一步更接近原任务。developmentState只是待核对的生成计划，不能取代正文、证明能力，也不能据它凭空推断正文没写的限制。不同人物、时间、物品与信息状态须按上下文区分。
${storyTechnicalReviewGuidance}
只返回以下三种结论：
- supported：方向已成立。普通省略不产生待办，不因还有其他发展可能或人物未用最优办法拒绝。
- expandable：方向可成立，同时有值得正文兑现的重要因果支撑、人物变化、情绪效果、反差或前后呼应；不改目标、关键办法、结果或选择。needs最多两项，优先保留影响故事的一两处，只选当前提案原文编号与上述故事作用类别。普通细节交给正文，不为填满配额打标。不得写具体修改方案、增加认证、秘密能力或设备功能来绕过限制。
- contradictory：存在上述实质问题。issueType为causal-gap（作用途径或状态承接断裂、无关麻烦替代行动）、mainline-drift（与原问题及其选择代价失去联系）、world-implausible（关键机制明显不可能或自相矛盾）。复杂、技术或手续多不是独立判错标准。
返回紧凑JSON {checks:[{id,verdict,reason,issueType,evidenceIds,needs}]}，每个输入id恰好一次，六个字段全给，不输出valid。supported用issueType:"none",evidenceIds:[],needs:[]。expandable用issueType:"none",evidenceIds:[],needs:[{kind,evidenceIds}]；kind只用setup、action-detail、response-detail、character-detail、emotional-beat、payoff，每项选择当前提案1至3个原文编号。contradictory用needs:[]、上述issueType及2至4个不同evidenceIds，至少一个来自当前提案，其余来自当前提案或作者材料。
evidenceCatalog的id由程序保留原文，不重抄quote、不引用其他方向或内部developmentState。拒绝依据须真正支持所称断裂：状态矛盾选冲突双方，机制断裂选办法与声称结果，偏航选原愿望或已有后果与脱离它的后续。reason不超过180字，只解释实际判断，不建议新情节；不能仅凭未写细节、失败后处境变差、审阅者自定的必要条件拒绝。先作实际判断，再保证verdict、reason及引用一致；重审仍覆盖全部输入id。`

export async function projectFutureChoices(candidates: StoryPreparationCandidate[], sources: StoryPreparation['sources'], brief: CreativeBrief,
  mainlineAnchors: StoryMainlineAnchor[] = [], mainlineGoals: StoryMainlineGoal[] = [], creativeFocus?: StoryCreativeFocus,
  selectedStoryDirection?: string): Promise<StoryPreparationCandidate[]> {
  if (!candidates.length) return candidates
  const hasCompleteProjection = candidates.every(candidate => candidate.futureChoice && candidate.causalBridge)
  const prompt = `你是故事大纲编辑。输入包含已审阅的方向卡。为每条方向补人物可能采取的办法、由此可能发生的处境变化和下一层故事取舍，不写完整剧情。返回精确 JSON {developments:[{attempt:{means,methodUses,text,materialIds},change:{outcome,states,text,materialIds},futureChoice:{requires,text},id}]}，每个输入 id 恰好一项。每条按attempt→change→futureChoice连续写完整后再写下一条，不把办法与后续选择分成两组独立构思。
${storyDevelopmentGuidance}
${storyCreativeFocusGuidance}
${developmentStateGuidance}
${storyMainlineGoalGuidance}
${storyCausalMechanismGuidance}
${storyResourceConsistencyGuidance}
selectedStoryDirection 若存在，是作者已经选定的走向；本次办法、变化和后续取舍必须承接它，不重新打开相反分支。候选已有 futureChoice 时保留该取舍的含义，不自行替换；作者已确认的具体设计条件仍须保留。
method 是人物在方向卡眼前取舍中可能采取的办法，change 是办法后可能出现的新局面，使原目标更近、更远，或改变已建立的人物关系；两项各用40至100字，简明写清机制，不要把它写成已经发生。methodBasisIds 只能引用该方向的 materialIds；changeBasisIds 只在变化确实承接作者原文条件时引用该方向的 resultBasisIds，否则为空。引用表示承接作者材料，不证明新结果已经发生或因果成立。来源 ID 不写入文字。
以上办法编码为attempt.text、methodBasisIds编码为attempt.materialIds；处境变化编码为change.text、changeBasisIds编码为change.materialIds；后续取舍编码为futureChoice.text。不要输出旧的bridges或futureChoices顶层数组。
本步写故事大纲，不写操作指南。办法用一个可理解的行动说清，不展开拆装、接线、材料用量或参数实验。题材确实关注技术时，保留直接决定取舍的关键条件即可。若阻力来自人与人的关系，让尝试与回应落在相处中，不凭空增加必须先解决的技术难题。
 每条 text 30至80字，写明办法奏效或失败后，人物面对哪两种后续走向。新取舍须影响原愿望的机会、代价或已有关系，也可以让人物在保住原打算与回应更在意的事情之间选择；等待、核对、调整做法或路线也可成立，但这次办法必须带来新信息、条件或后果，不能原地重复。先沿方向卡已有人物、目标和情境寻找办法；新事件可以偶然出现，不要求由上一步直接造成，但人物须有自然理由遇见它，且它须影响原目标和选择，不能连续空降无关麻烦代替人物行动改变处境。
 可以创作新人物、道具、往事、服务或规则，无须作者原文或方向卡预先写明；新内容应能从人物正在做的事或已有场所情境自然遇见。能力与代价按作者的世界设定和题材判断，新设定须自洽并保留已有的限制。普通询问、登记、协商及他人合理配合可以带出可能变化，无须另编整套手续、权限或背景；有必要条件时用条件式说明，不保证必然获准。关键结果须有办法能提供的信息、资源或能力支撑；线索可以引出调查，不能无依据地变成定论。
 method 只写人物选用的办法；change 写办法成败、他人回应或相关发现带来的信息、机会、限制、代价或关系变化，不用心理感悟代替处境变化。futureChoices.text 写变化后尚待决定的两种走向，不必写出结局。写故事规划，不写对白、微动作、身体感受、隐藏经历或完整场景。不为增强戏剧性再空降一轮麻烦；先让这次办法产生后果。所有内容仍是可拒绝、尚未发生的系统提案。`
  const input = { sources, brief, mainlineAnchors, mainlineGoals, creativeFocus,
    ...(selectedStoryDirection ? { selectedStoryDirection } : {}),
    candidates: candidates.map(({ id, action, possibleResult, materialIds, resultBasisIds, futureChoice }) => ({ id, action, possibleResult, materialIds, resultBasisIds,
      ...(futureChoice ? { futureChoice } : {}) })) }
  const projectedBridges = new Map<string, ReturnType<typeof parseFutureChoiceProjection>['bridges'][number]>()
  const projectedChoices = new Map<string, string>()
  const projectedStates = new Map<string, DevelopmentState>()
  const projectedNeeds = new Map<string, StoryExpansionNeed[]>()
  const approved = new Set<string>()
  const factMaterial = framePreparationSources(sources)
  let repairReasons: { id: string; issueType: string; reason: string; evidence?: BridgeEvidence[] }[] = []
  let projectionValidationFailure: string | undefined
  let previousProjectionOutput: unknown
  for (let attempt = 0; attempt < causalBridgeMaxAttempts; attempt++) {
    try {
      const pending = attempt && repairReasons.length ? candidates.filter(candidate => repairReasons.some(issue => issue.id === candidate.id)) : candidates
      const pendingInput = { ...input, candidates: input.candidates.filter(candidate => pending.some(item => item.id === candidate.id)),
        referenceContract: pending.map(candidate => ({ id: candidate.id, attemptMaterialIds: candidate.materialIds, changeMaterialIds: candidate.resultBasisIds })),
        ...(repairReasons.length ? { repairReasons, previousProjections: repairReasons.map(({ id }) => ({
          id, bridge: projectedBridges.get(id), futureChoice: projectedChoices.get(id), developmentState: projectedStates.get(id),
        })) } : {}), ...(projectionValidationFailure ? { validationFailure: projectionValidationFailure, previousOutput: previousProjectionOutput } : {}) }
      const { bridges: generatedBridges, choices: generatedChoices, plans: generatedPlans } = hasCompleteProjection && !attempt
        ? { bridges: candidates.map(candidate => ({ ...candidate.causalBridge!, id: candidate.id })),
          choices: candidates.map(candidate => ({ id: candidate.id, value: candidate.futureChoice! })), plans: [] }
        : await requestPreparationResponse({ systemPrompt: `${prompt}
每个attempt.text、change.text和futureChoice.text均不得超过240字。若输入含validationFailure，只改正超限或不合法字段，保留其他方向的内容及引用。若输入含repairReasons，只修复列出的方向，不改方向卡。对照previousProjections找出失败机制：world-implausible 时改掉不可信的规则、能力或权限；causal-gap 时让人物办法实际改变处境；mainline-drift 时恢复原愿望、风险或关系与新选择代价的联系，不把合理的目标转变改回原任务；author-conflict 时保留作者已定事实。失败桥中尚未接受的办法、变化与后续取舍可以一起简化或替换，不必靠补设定保住旧写法；仍须承接固定方向卡的眼前选择。修复后仍须同时满足故事连接和世界可信度。
${repairReasons.length ? storyDevelopmentRepairGuidance : ''}
developments 必须恰好 ${pending.length} 项，id 只能为 ${pending.map(candidate => candidate.id).join('、')}，每个id各出现一次。futureChoice.text 内写该人物面临的两种走向，不能把两个选项拆成两条记录或另编 c1/c2 等ID。修复时同步更新本条状态和依赖，不能只把状态标签改成通过而保留矛盾正文。`, userPrompt: JSON.stringify(pendingInput), temperature: attempt ? 0.15 : 0.35,
          maxTokens: Math.max(1300, pending.length * 1100), diagnosticStage: 'preparation-future-choice', outputSchema: projectionOutputSchema(pending) }, async rawOutput => {
          previousProjectionOutput = rawOutput
          return parseFutureChoiceProjection(await repairGeneratedTextLengths(rawOutput, sources, 'preparation-future-choice-text-length'), pending)
        })
      if (process.env.STORY_PREPARATION_DIAGNOSTICS === 'true') {
        console.warn('[preparation] projection', JSON.stringify({ attempt: attempt + 1,
          bridges: generatedBridges, futureChoices: generatedChoices }))
      }
      for (const bridge of generatedBridges) projectedBridges.set(bridge.id, bridge)
      for (const choice of generatedChoices) projectedChoices.set(choice.id, choice.value)
      for (const { id, plan } of generatedPlans) projectedStates.set(id, plan)
      const bridges = candidates.map(candidate => projectedBridges.get(candidate.id)!)
      const choices = candidates.map(candidate => ({ id: candidate.id, value: projectedChoices.get(candidate.id)! }))
      for (const candidate of candidates) {
        const bridge = projectedBridges.get(candidate.id)!
        if (bridge.method === bridge.change || !bridge.methodBasisIds.length
          || bridge.methodBasisIds.some(id => !candidate.materialIds.includes(id))
          || bridge.changeBasisIds.some(id => !candidate.resultBasisIds.includes(id))) invalid(`${candidate.id} 因果桥引用或内容不合法。`)
      }
      const reviewCandidates = candidates.filter(candidate => !approved.has(candidate.id))
      const stateChecks = new Map(reviewCandidates.flatMap(candidate => {
        const plan = projectedStates.get(candidate.id)
        const issue = plan && developmentStateIssues(plan)[0]
        return issue ? [[candidate.id, { id: candidate.id, valid: false, ...issue }] as const] : []
      }))
      const reviewableCandidates = reviewCandidates.filter(candidate => !stateChecks.has(candidate.id))
      const factProposals = reviewableCandidates.map(candidate => ({ id: candidate.id, action: candidate.action,
        possibleResult: candidate.possibleResult, method: projectedBridges.get(candidate.id)!.method,
        change: projectedBridges.get(candidate.id)!.change, futureChoice: projectedChoices.get(candidate.id)! }))
      const factEvidence = bridgeEvidenceCatalog(factProposals, [])
      const factChecks = reviewableCandidates.length ? await requestPreparationResponse({
        systemPrompt: `核对因果桥是否违背作者已定事实。只做来源与事实冲突核对，不评价新设定是否可信、人物办法是否有效或故事是否精彩。返回紧凑JSON {checks:[{id,verdict,conflictMaterialIds,proposalEvidenceIds,reason}]}，每个id恰好一项。verdict只能为compatible或contradictory，是唯一判定；引用只是冲突证据，不能代替判定。不输出valid、materialIds、sourceId或quote。
没有直接冲突时verdict="compatible"，conflictMaterialIds=[]、proposalEvidenceIds=[]，reason简写为“无冲突”。不要引用相容或支持提案的材料。只有提案明确否定、替换或越过作者已经写明的事实、限制或保留的未知时，才给contradictory；此时conflictMaterialIds从material选择至少一条被违背的作者原条件，proposalEvidenceIds从evidenceCatalog选择至少一条当前方向中与其冲突的提案原文，reason具体说明双方哪里矛盾。理由、判定与冲突依据须一致。不重新抄写引文。新规则、服务、设备或人物首次出现在提案中，本身绝不是事实冲突；不得因作者没写过而拒绝，也不把数量上限扩大成使用者资格或操控方式限制。若输入有validationFailure，只改正当前审阅，不重写故事，不为保留旧结论编造冲突。
人物愿望不等于作者要求必须成功：想、打算、希望完成某事，不能自动解释为禁止改期、失败、接受代价或有动机地放弃。selectedStoryDirection若存在，是作者选定的本版取舍；与生成展开使用同一走向核对。原愿望因困难而调整、损失或放弃，且仍影响人物选择和代价，不构成对愿望本身的事实否定。不要为让人物继续原计划而拒绝作者已选分支，也不要把放弃原计划说成原目标已完成。
选定方向只授权该分支内的未来设计，不覆盖作者明确的必须、禁止、既定结局、已定事实或保留未知；有这些硬性冲突仍须引用双方原文并拒绝。不同分支是互斥备选，不把未选分支的行动、结果当成当前分支必须实现的事实。
${storySemanticReviewGuidance}`,
        userPrompt: JSON.stringify({ sources, material: factMaterial,
          ...(selectedStoryDirection ? { selectedStoryDirection } : {}),
          candidates: input.candidates.filter(candidate => reviewableCandidates.some(item => item.id === candidate.id)),
          bridges: bridges.filter(bridge => reviewableCandidates.some(item => item.id === bridge.id)),
          futureChoices: choices.filter(choice => reviewableCandidates.some(item => item.id === choice.id)).map(choice => ({ id: choice.id, text: choice.value })),
          evidenceCatalog: factEvidence }),
        temperature: 0.1, maxTokens: 1100, diagnosticStage: 'preparation-future-choice-fact-review',
        outputSchema: factReviewOutputSchema(reviewableCandidates.map(c => c.id), factMaterial.map(m => m.id), factEvidence.map(e => e.id)),
      }, raw => parseFactReviewChecks(raw, reviewableCandidates.map(c => c.id), factMaterial, factEvidence)) : []
      const worldCandidates = reviewableCandidates.filter(candidate => factChecks.find(check => check.id === candidate.id)?.valid)
      let worldChecks: { id: string; valid: boolean; verdict: 'supported' | 'expandable' | 'contradictory'; issueType: typeof futureChoiceIssueTypes[number]; reason: string; evidence: BridgeEvidence[]; expansionNeeds: StoryExpansionNeed[] }[] = []
      if (worldCandidates.length) {
        const proposals = worldCandidates.map(candidate => ({ id: candidate.id, action: candidate.action,
          possibleResult: candidate.possibleResult, method: projectedBridges.get(candidate.id)!.method,
          change: projectedBridges.get(candidate.id)!.change, futureChoice: projectedChoices.get(candidate.id)!,
          ...(projectedStates.has(candidate.id) ? { developmentState: projectedStates.get(candidate.id) } : {}) }))
        const evidenceCatalog = bridgeEvidenceCatalog(proposals, sources.map(source => source.text))
        worldChecks = await requestPreparationResponse({
          systemPrompt: `${causalBridgeReviewPrompt}\n${storyCreativeFocusGuidance}`,
          userPrompt: JSON.stringify({ storyContext: sources.map(source => source.text),
            mainlineGoals: mainlineGoals.map(goal => goal.quote),
            mainlineAnchors: mainlineAnchors.map(anchor => ({ kind: anchor.kind, quote: anchor.quote })),
            creativeFocus, ...(selectedStoryDirection ? { selectedStoryDirection } : {}),
            proposals, evidenceCatalog }),
          temperature: 0.1, maxTokens: 1800, diagnosticStage: 'preparation-future-choice-world-review', outputSchema: causalReviewOutputSchema(worldCandidates.length, evidenceCatalog.map(e => e.id)),
        }, raw => {
          const worldReview = object(raw, ['checks'])
          const checks = list(worldReview.checks, worldCandidates.length).map(value => {
            const id = typeof value === 'object' && value && 'id' in value ? String((value as Record<string, unknown>).id) : ''
            const candidate = worldCandidates.find(candidate => candidate.id === id)
            if (!candidate) return invalid('审阅引用了本次未审查的方向。')
            const check = parseBridgeReviewCheck(value, evidenceCatalog)
            if (check.id !== id) return invalid('审阅方向编号不一致。')
            return check
          })
          if (!coversCandidates(checks, worldCandidates)) invalid('世界与因果审阅没有覆盖全部方向。')
          return checks
        })
        for (const check of worldChecks) projectedNeeds.set(check.id, check.expansionNeeds)
      }
      const checks = reviewCandidates.map(candidate => {
        const stateCheck = stateChecks.get(candidate.id)
        if (stateCheck) return stateCheck
        const fact = factChecks.find(check => check.id === candidate.id)!
        return fact.valid ? worldChecks.find(check => check.id === candidate.id)! : fact
      })
      for (const check of checks) if (check.valid) approved.add(check.id)
      logPreparationReview('future-choice', attempt + 1, reviewCandidates.map(candidate => candidate.id), { checks })
      const rejected = checks.filter(check => !check.valid)
      if (rejected.length) {
        if (attempt + 1 < causalBridgeMaxAttempts) {
          repairReasons = rejected.map(check => stateChecks.has(check.id)
            ? { id: check.id, issueType: check.issueType, reason: check.reason } : bridgeRepairDiagnostic(check))
          continue
        }
        throw new PreparationQualityError(rejected.map(check => `${check.id} 因果桥：${check.reason}`), 'causal-bridge', attempt + 1, rejected.map(check => check.issueType))
      }
      const bridgeById = new Map(bridges.map(bridge => [bridge.id, bridge]))
      const choiceById = new Map(choices.map(choice => [choice.id, choice.value]))
      return candidates.map(candidate => {
        const usableBridge = bridgeById.get(candidate.id)!
        const futureChoice = choiceById.get(candidate.id)!
        const { expansionNeeds: _staleNeeds, ...current } = candidate
        const expansionNeeds = projectedNeeds.get(candidate.id)
        return { ...current, futureChoice,
          ...(expansionNeeds?.length ? { expansionNeeds } : {}),
          causalBridge: { method: usableBridge.method, change: usableBridge.change, methodBasisIds: usableBridge.methodBasisIds, changeBasisIds: usableBridge.changeBasisIds } }
      })
    } catch (error) {
      if (attempt || !(error instanceof AppError) || error.code !== 'STORY_PREPARATION_INVALID_OUTPUT' || error.modelDiagnostic) throw error
      projectionValidationFailure = error.message
    }
  }
  return invalid('因果桥生成未完成。')
}

export function preparationSources(idea: string, brief: CreativeBrief): StoryPreparation['sources'] {
  return [{ id: 'author-input', text: idea }, ...(['setting', 'direction', 'boundaries'] as const)
    .flatMap(key => {
      const content = brief.storyRequirements?.[key]?.trim()
      return content ? [{ id: `author-${key}`, text: content }] : []
    }), ...(brief.note?.trim() ? [{ id: 'author-note', text: brief.note.trim() }] : [])]
}

export function parseMainlineAnchors(value: unknown, sources: StoryPreparation['sources'], hasGoal: boolean,
  frames: ReturnType<typeof framePreparationSources> = []): StoryMainlineAnchor[] {
  const anchors = splitReferenceEntries(value, frames, 'mainlineAnchors', 16, ['kind']).flatMap((entry, index) => {
    const item = object(entry, ['id', 'kind', ...(entry && typeof entry === 'object' && 'materialIds' in entry ? ['materialIds'] : ['sourceId', 'quote'])])
    const suppliedKind = String(item.kind)
    const kind = suppliedKind === 'condition' || suppliedKind === 'time' ? 'constraint' : suppliedKind
    if (!['character', 'relationship', 'place', 'action', 'object', 'constraint'].includes(kind)) invalid(`mainlineAnchors[${index}].kind 不合法。`)
    // An empty selection asserts nothing. Omit optional elements rather than
    // inventing a source; required action coverage is still checked below.
    if (Array.isArray(item.materialIds) && item.materialIds.length === 0) return []
    const reference = resolvePreparationReference(item, sources, frames, `mainlineAnchors[${index}]`)
    return [{ id: text(item.id, 80), kind: isAuthorRequirementSource(reference.sourceId) ? 'constraint' as const : kind as StoryMainlineAnchor['kind'], ...reference }]
  })
  unique(anchors)
  if (hasGoal && (!anchors.length || !anchors.some(anchor => anchor.kind === 'action'))) invalid('人物目标缺少可核对的主线行动。')
  return anchors
}

/**
 * A semantic mainline element may be supported by excerpts in several author
 * fields. Stored references are deliberately stricter: each quote must remain
 * a contiguous span from one source. Split cross-source ID groups into
 * source-local nodes before resolving them, instead of fabricating a sentence
 * that never appeared in any input field.
 */
function splitReferenceEntries(value: unknown, frames: ReturnType<typeof framePreparationSources>, path: string, maxItems: number, extraKeys: string[] = []): Record<string, unknown>[] {
  const entries = list(value, maxItems)
  const originalIds = entries.map(entry => ({ id: text(object(entry, ['id'], [...extraKeys, 'materialIds', 'sourceId', 'quote']).id, 80) }))
  unique(originalIds)
  const reservedIds = new Set(originalIds.map(item => item.id))
  const result: Record<string, unknown>[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const item = object(entry, ['id', ...extraKeys, ...(entry && typeof entry === 'object' && 'materialIds' in entry ? ['materialIds'] : ['sourceId', 'quote'])])
    if (!('materialIds' in item)) {
      result.push(item)
      continue
    }
    const refs = ids(item.materialIds, new Set(frames.map(frame => frame.id)), `${path}[${index}].materialIds`)
    const bySource = new Map<string, string[]>()
    for (const ref of refs) {
      const sourceId = frames.find(frame => frame.id === ref)?.sourceId ?? invalid(`${path}[${index}].materialIds：引用的材料来源不存在。`)
      const sourceRefs = bySource.get(sourceId) ?? []
      sourceRefs.push(ref)
      bySource.set(sourceId, sourceRefs)
    }
    const groups = [...bySource.values()]
    if (groups.length <= 1) {
      result.push(item)
      continue
    }
    const baseId = text(item.id, 80, `${path}[${index}].id`)
    groups.forEach((group, part) => {
      const prefix = `${baseId.slice(0, 55)}-source-${part + 1}`
      let id = prefix, suffix = 1
      while (reservedIds.has(id)) id = `${prefix}-${suffix++}`
      reservedIds.add(id)
      result.push({ ...item, id, materialIds: group })
    })
  }
  return result
}

/** Select immutable source spans instead of asking a model to transcribe them.
 * A span includes intervening clauses so a condition/negation cannot be dropped.
 * Legacy quotations remain exact, but a frame boundary is not a source boundary. */
function resolvePreparationReference(item: Record<string, unknown>, sources: StoryPreparation['sources'],
  frames: ReturnType<typeof framePreparationSources>, path: string): { sourceId: string; quote: string } {
  if ('materialIds' in item) {
    const refs = ids(item.materialIds, new Set(frames.map(frame => frame.id)), `${path}.materialIds`)
    if (!refs.length) invalid(`${path} 缺少原文片段。`)
    const selected = frames.filter(frame => refs.includes(frame.id))
    const sourceId = selected[0]!.sourceId
    if (selected.some(frame => frame.sourceId !== sourceId)) invalid(`${path} 不能把不同来源拼成一条原文。`)
    const source = sources.find(source => source.id === sourceId)
    if (!source) return invalid(`${path} 引用的原文来源不存在。`)
    // Resolve positions in source order so repeated clauses and whitespace
    // between frames stay exactly as authored, including intervening limits.
    let cursor = 0, start = -1, end = -1
    for (const frame of frames.filter(frame => frame.sourceId === sourceId)) {
      const offset = source.text.indexOf(frame.quote, cursor)
      if (offset < 0) invalid(`${path} 原文片段与来源不对应。`)
      cursor = offset + frame.quote.length
      if (frame.id === selected[0]!.id) start = offset
      if (frame.id === selected.at(-1)!.id) end = cursor
    }
    if (start < 0 || end <= start) invalid(`${path} 原文片段不连续。`)
    return { sourceId, quote: text(source.text.slice(start, end), source.text.length, path) }
  }
  const suppliedId = text(item.sourceId, 80)
  const frame = frames.find(frame => frame.id === suppliedId)
  const source = sources.find(source => source.id === (frame?.sourceId ?? suppliedId))
  if (!source) return invalid(`${path} 引用的原文来源不存在。`)
  const quote = text(item.quote, source.text.length, path)
  if (!source.text.includes(quote)) invalid(`${path} 必须逐字引用作者原文。`)
  if (frame) {
    const sourceFrames = frames.filter(item => item.sourceId === source.id)
    const start = sourceFrames.slice(0, sourceFrames.indexOf(frame)).reduce((offset, item) => offset + item.quote.length, 0)
    let overlaps = false
    for (let pos = source.text.indexOf(quote); pos >= 0; pos = source.text.indexOf(quote, pos + 1)) {
      if (pos < start + frame.quote.length && pos + quote.length > start) overlaps = true
    }
    if (!overlaps) invalid(`${path} 引文与所选片段不对应。`)
  }
  return { sourceId: source.id, quote }
}

function parseMainlineGoals(value: unknown, sources: StoryPreparation['sources'], frames: ReturnType<typeof framePreparationSources>, hasGoal: boolean): StoryMainlineGoal[] {
  const goals = splitReferenceEntries(value, frames, 'mainlineGoals', 8).map((entry, index) => {
    const item = object(entry, ['id', ...(entry && typeof entry === 'object' && 'materialIds' in entry ? ['materialIds'] : ['sourceId', 'quote'])])
    return { id: text(item.id, 80), ...resolvePreparationReference(item, sources, frames, `mainlineGoals[${index}]`) }
  }).filter(goal => !isAuthorRequirementSource(goal.sourceId))
  unique(goals)
  if (hasGoal && !goals.length) invalid('人物目标缺少完整主线陈述。')
  return goals
}

/** Labels never override an author's explicit uncertainty. */
function isAuthorRequirementSource(sourceId: string): boolean {
  return ['author-direction', 'author-boundaries', 'author-note'].includes(sourceId)
}

export function preserveRequirementRoles(material: StoryPreparationItem[]): StoryPreparationItem[] {
  return material.map(m => {
    if (isAuthorRequirementSource(m.sourceId) && m.role !== 'unknown') {
      return { ...m, role: 'condition' as const }
    }
    return m
  })
}

/** Source authority is determined by the author's field, never by a second
 * model relabeling an expected ending as a character's present intention. */
export function parsePreparationIntent(output: unknown, sources: StoryPreparation['sources'], material: StoryPreparationItem[]) {
  const intent = object(output, ['characterGoalIds', 'mainlineGoals', 'mainlineAnchors', 'appealMaterialIds'])
  const allowedIds = new Set(material.map(frame => frame.id))
  const goalIds = new Set(ids(intent.characterGoalIds, allowedIds, 'characterGoalIds').filter(id => {
    const frame = material.find(frame => frame.id === id)!
    return frame.role !== 'unknown' && !isAuthorRequirementSource(frame.sourceId)
  }))
  const appealIds = ids(intent.appealMaterialIds, allowedIds, 'appealMaterialIds')
  if (appealIds.length > 3) invalid('appealMaterialIds 最多选择三个原文片段。')
  const anchors = parseMainlineAnchors(intent.mainlineAnchors, sources, goalIds.size > 0, material)
  const goals = parseMainlineGoals(intent.mainlineGoals, sources, material, false).filter(goal =>
    material.some(frame => goalIds.has(frame.id) && frame.sourceId === goal.sourceId && goal.quote.includes(frame.quote)))
  if ([...goalIds].some(id => {
    const frame = material.find(frame => frame.id === id)!
    return !goals.some(goal => goal.sourceId === frame.sourceId && goal.quote.includes(frame.quote))
  })) invalid('mainlineGoals 必须逐项保留 characterGoalIds 对应的完整人物目标；不能以作者发展期待或其他来源替代。')
  return { goalIds, appealIds, anchors, goals }
}

export const preparationUncertaintyPrompt = `核对作者未知范围，不创作故事，不补答案。输出精确JSON {decisions:[{id,role,evidenceIds}]}。
对每个reviewIds恰好输出一项；role只能为fact|condition|unknown，evidenceIds是支持判断的原文片段ID，至少一项。disputedIds是触发核对的未知；reviewIds也包含同一来源的相邻非目标片段，务必把未知范围扩展到作者暂不选择的对象，不只标“暂不选”几个字。
结合完整sources与相邻material判断，不因句子被逗号切开而丢掉后面的否定或保留声明。
unknown：作者明确不知道、尚未决定或要求暂时保留的设定与选择，包括跨片段的对象；不能因它写在“已确定设定”栏就改成已知。人物不知道的事实不等于作者未定；未来结果不保证也不自动要求作者先回答。
fact：原文明确断言的当前事实。未写名字、品牌、细节不能把整个事实变未知；但没有答案的选择不能仅因一句话存在就变fact。
condition：作者明确授权系统设计、允许自由选择，或要求保留的偏好/边界。授权创作不是已发生事件，也不需要追问作者；同一对象若作者又明确暂不选择，保留unknown，不擅自解决冲突。
先判断作者是否授权创作；明确授权系统设计的对象是condition，不因答案尚未生成就标unknown。尚未决定、暂不选择不等于授权系统代选；只有明确授权同一对象时才能按创作授权处理。允许暂不指定细节也不等于事件已经发生。不同对象的声明互不覆盖。
证据必须来自原文；需要跨句判断时同时引用对象与决定其性质的声明。没有充分证据纠正时保留unknown。不输出姓名、住址、选定方案或角色行动。`

export async function reviewPreparationUncertainty(sources: StoryPreparation['sources'], material: StoryPreparationItem[]): Promise<StoryPreparationItem[]> {
  const disputedIds = material.filter(m => m.role === 'unknown').map(m => m.id)
  if (!disputedIds.length) return material
  const disputedSources = new Set(material.filter(m => disputedIds.includes(m.id)).map(m => m.sourceId))
  const reviewIds = material.filter(m => m.role !== 'goal' && disputedSources.has(m.sourceId)).map(m => m.id)
  const disputedContexts = material.filter(m => disputedIds.includes(m.id)).map(m => {
    const source = sources.find(s => s.id === m.sourceId)?.text ?? m.quote
    const start = source.indexOf(m.quote)
    if (start < 0) return { id: m.id, sentence: m.quote }
    const before = source.slice(0, start), end = start + m.quote.length
    const lastStop = Math.max(...[...before.matchAll(/[。！？；\n]/gu)].map(match => match.index! + match[0].length), 0)
    const nextStop = /[。！？；\n]/u.exec(source.slice(end))
    return { id: m.id, sentence: source.slice(lastStop, nextStop ? end + nextStop.index + nextStop[0].length : source.length) }
  })
  const parse = (value: unknown) => {
    const r = object(value, ['decisions'])
    const decisions = list(r.decisions).map(value => {
      const d = object(value, ['id', 'role', 'evidenceIds'])
      const id = text(d.id, 80)
      if (!reviewIds.includes(id) || !['fact', 'condition', 'unknown'].includes(String(d.role))) invalid('未知核对只能处理争议来源片段，不能新增答案或目标。')
      const evidenceIds = ids(d.evidenceIds, new Set(material.map(m => m.id)), '未知核对证据')
      if (!evidenceIds.length) invalid('未知核对缺少原文证据。')
      return { id, role: d.role as StoryPreparationItem['role'], evidenceIds }
    })
    if (decisions.length !== reviewIds.length || new Set(decisions.map(d => d.id)).size !== reviewIds.length) invalid('未知核对必须覆盖全部争议来源片段且不能重复。')
    return material.map(m => {
      const reviewedRole = decisions.find(d => d.id === m.id)?.role
      // This review resolves uncertainty, not unrelated fact/condition labels.
      // Neighbouring clauses can join a reserved choice but cannot become
      // established events merely because this extra reviewer says so.
      const role = m.role === 'unknown' ? reviewedRole ?? m.role
        : reviewedRole === 'unknown' ? 'unknown' : m.role
      return { ...m, role }
    })
  }
  const options = { systemPrompt: preparationUncertaintyPrompt,
    userPrompt: JSON.stringify({ sources, material: material.map(({ role: _role, ...quote }) => quote), disputedIds, disputedContexts, reviewIds }), temperature: 0, maxTokens: 2400,
    diagnosticStage: 'preparation-uncertainty-review', outputSchema: schemas.uncertainty }
  const output = await requestQwenJson(options)
  try { return parse(output) } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'STORY_PREPARATION_INVALID_OUTPUT') throw error
    return parse(await requestQwenJson({ ...options, userPrompt: JSON.stringify({ ...JSON.parse(options.userPrompt), previousOutput: output, validationFailure: error.message }) }))
  }
}

export async function generateStoryPreparation(idea: string, brief: CreativeBrief, onProgress?: (completedNodes: number) => void): Promise<ProvisionalCurve> {
  const sources = preparationSources(idea, brief)
  const frames = framePreparationSources(sources)
  let extracted = await requestQwenJson({ systemPrompt: preparationExtractionPrompt, userPrompt: JSON.stringify({ sources, material: frames }), temperature: 0.1, maxTokens: 2400, diagnosticStage: 'preparation-extraction', outputSchema: schemas.classification })
  let material: StoryPreparationItem[]
  try {
    material = classifyPreparationMaterial(extracted, frames, sources)
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'STORY_PREPARATION_INVALID_OUTPUT') throw error
    extracted = await requestQwenJson({
      systemPrompt: `${preparationExtractionPrompt}\n上一份分类未通过校验。请返回全部输入 ID 的分类，只输出 id、role。`,
      userPrompt: JSON.stringify({ sources, material: frames, previousOutput: extracted, validationFailure: error.message }),
      temperature: 0.1, maxTokens: 2400, diagnosticStage: 'preparation-extraction-retry',
      outputSchema: schemas.classification,
    })
    material = classifyPreparationMaterial(extracted, frames, sources)
  }
  // Explicit author expectations cannot become character goals.
  material = preserveRequirementRoles(await reviewPreparationUncertainty(sources, material))
  let mainlineAnchors: StoryMainlineAnchor[] = []
  let mainlineGoals: StoryMainlineGoal[] = []
  let appealMaterialIds: string[] = []
  // Independently identify who wants what. Do not show the first classifier's
  // labels: its interpretation must not become the evidence for this check.
  {
    const systemPrompt = `核对人物当下意图，而非作者的创作期待。返回精确 JSON {characterGoalIds:[原文片段ID],mainlineGoals:[{id,materialIds}],mainlineAnchors:[{id,kind,materialIds}],appealMaterialIds:[原文片段ID]}。四个字段都必需，无内容用空数组。只选择输入 material 的 ID，不输出 quote、sourceId 或重写原文；程序按 ID 保存完整原文。每个 mainlineGoals 或 mainlineAnchors 项的 materialIds 必须全部来自同一个 sourceId；如果一个语义要素涉及多个输入框，拆成多个同 kind 项，不能把不同来源的 ID 放在同一项。mainlineGoals 每项选择能保留完整主线的一个或多个同来源片段，保留主体、目标活动、关系、地点、对象及限制，不能只选动词片段而漏掉相邻否定或条件。同一来源的跨片段语句可以一起选择，标点切片不代表语义边界。选择原文明确赋予所有故事人物的当前愿望、任务、承诺，包括配角、相互冲突的目标；不能只选主角或可兼容的目标。主题、希望的结尾、关系走向和人物成长是作者约束，不选择为人物目标。若原文只有作者创作期待，characterGoalIds 返回空数组，但仍可列出原文明确的主线陈述。mainlineAnchors 逐项选取包含已明确人物、人物关系、地点、目标行动、行动对象及不可更改条件的原文片段；kind 仅 character,relationship,place,action,object,constraint，时间和其他条件归 constraint。同一片段可用于不同 kind，不需从中再摘词。id 用 a0 等唯一标识。人物目标存在时必须有 action；目标未定时只列原文已确定的要素。结合完整 sources 理解，不凭措辞或单个关键词分类。`
    const parseIntent = (output: unknown) => parsePreparationIntent(output, sources, material)
    const referenceContract = {
      characterGoalMaterialIds: material.filter(m => m.role !== 'unknown' && !isAuthorRequirementSource(m.sourceId)).map(m => m.id),
      sourceGroups: sources.map(source => ({ sourceId: source.id, materialIds: frames.filter(frame => frame.sourceId === source.id).map(frame => frame.id) })),
    }
    const options = { systemPrompt: `${systemPrompt}\nauthor-direction、author-boundaries、author-note 都是作者创作要求，只能作为 constraint，不能写入 characterGoalIds 或 mainlineGoals。referenceContract.characterGoalMaterialIds 只是允许选择的范围，不表示这些片段已经是目标；仍须按语义判断。sourceGroups 列出同来源片段，目标及要素引用按组分项。\n输出另含 appealMaterialIds 数组：从原文选择零至三个最值得继续发展的人物互动、不同期待、习惯、反差或活动本身的片段 ID，保留原想法的看点。不编写解释、结局或人物成长要求；没有明确线索就给空数组。这只是创作参考，不是事实分类、人物目标或作者强制要求，不能影响前述分类。`, userPrompt: JSON.stringify({ sources, material: frames, referenceContract }), temperature: 0, maxTokens: 1600,
      diagnosticStage: 'preparation-character-intent', outputSchema: schemas.intent }
    options.systemPrompt += '\n未明确指定的要素直接省略该项，例如未指定地点就不输出place。每个输出项的materialIds至少一个有效ID；不要为了凑齐kind输出空引用。'
    let output = await requestQwenJson(options)
    let parsed: ReturnType<typeof parseIntent>
    try { parsed = parseIntent(output) } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'STORY_PREPARATION_INVALID_OUTPUT') throw error
      output = await requestQwenJson({ ...options,
        userPrompt: JSON.stringify({ sources, material: frames, referenceContract, previousOutput: output, validationFailure: error.message }),
        diagnosticStage: 'preparation-character-intent-retry' })
      parsed = parseIntent(output)
    }
    const { goalIds } = parsed
    material = preserveRequirementRoles(material.map(m => m.role === 'unknown' ? m
      : goalIds.has(m.id) ? { ...m, role: 'goal' as const }
      : m.role === 'goal' ? { ...m, role: 'condition' as const } : m))
    mainlineAnchors = parsed.anchors
    mainlineGoals = parsed.goals
    appealMaterialIds = parsed.appealIds
    if (process.env.STORY_PREPARATION_DIAGNOSTICS === 'true') {
      console.warn('[preparation] extracted mainline goals', JSON.stringify(mainlineGoals))
    }
  }
  onProgress?.(1)
  const candidates = await generatePreparationCandidates(sources, material, brief, mainlineAnchors, [], undefined, mainlineGoals, appealMaterialIds, () => onProgress?.(2))
  onProgress?.(3)
  const now = Date.now()
  return { id: `curve-${randomUUID()}`, title: '一起选择故事方向', status: 'draft', brief, beats: [], instructions: [],
    preparation: { protocol: 1, status: 'needs-review', sources, material, mainlineAnchors, mainlineGoals, appealMaterialIds, ...candidates, acceptedCandidateIds: [], executed: false }, createdAt: now, updatedAt: now,
    generation: { origin: 'model', dramaticMechanism: '原文整理与三种故事困境分开生成；尚未生成曲线，也未确认事实' } }
}

async function generatePreparationCandidates(sources: StoryPreparation['sources'], material: StoryPreparationItem[], brief: CreativeBrief,
  mainlineAnchors: StoryMainlineAnchor[] = [], rejectedCandidates: StoryPreparationCandidate[] = [], authorAction?: string,
  mainlineGoals: StoryMainlineGoal[] = [], appealMaterialIds: string[] = [], onCandidatesGenerated?: () => void): Promise<Pick<StoryPreparation, 'candidates' | 'questions'>> {
  const creativeFocus = preparationCreativeFocus({ sources, material, appealMaterialIds })
  const input = { sources, material,
    creativeFocus,
    mainlineAnchors: mainlineAnchors.map(({ kind, quote }) => ({ kind, quote })),
    mainlineGoals: mainlineGoals.map(({ quote }) => quote),
    brief, referenceContract: preparationReferenceContract(material), rejectedCandidates, ...(authorAction ? { authorAction } : {}) }
  if (!authorAction) return generateDirectionCards({ input: { ...input,
      authorRequirements: sceneAuthorRequirements({ sources, material, brief, rejectedCandidates }) },
    prompt: `${directionCardGenerationPrompt}\n${storyCreativeIntentGuidance(brief, 'directions')}\n${openIdeaDirectionsGuidance}`,
    request: requestPreparationResponse,
    onCandidatesGenerated,
    compress: raw => repairGeneratedTextLengths(raw, sources, 'preparation-directions-text-length'),
    parse: raw => {
      const result = parsePreparationCandidates(raw, material)
      if (result.candidates.some(c => rejectedCandidates.some(old => old.action === c.action))) invalid('新提案重复了已拒绝的行动。')
      return result
    },
  })
  // Author edits retain their existing scene/review contract. Fresh cards
  // above have a separate, compact review and targeted repair pipeline.
  const sceneStep = await generateSceneDraft({ sources, material, brief, rejectedCandidates, authorAction, creativeFocus })
  let sceneDraft = sceneStep && 'attempt' in sceneStep ? sceneStep : undefined
  const unknownQuestions = sceneStep && 'questions' in sceneStep ? sceneStep.questions : undefined
  if (unknownQuestions) throw new AppError('这次调整依赖尚未确定的条件，请调整方向后重试；原有卡片仍保留。', 409, 'STORY_PREPARATION_UNKNOWN_DEPENDENCY')
  if (!sceneDraft) return invalid('未生成可审阅的方向调整，请重试。')
  let previousOutput: unknown
  let validationFailure: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    // Presentation and reference IDs are deterministic. Asking the model to
    // copy an approved scene creates another opportunity for story drift.
    previousOutput = { candidates: [{ id: 'c0',
      action: authorAction,
      materialIds: sceneDraft.attempt.materialIds, preconditionIds: sceneDraft.attempt.preconditionIds,
      possibleResult: `可能发展：${sceneDraft.development.change}${sceneDraft.development.response}`,
      resultBasisIds: sceneDraft.development.resultBasisIds, unknownIds: [] }], questions: [] }
    try {
      // In edit mode the model generates only a result, never another action.
      // A conflicting action remains a visible error; do not splice it away.
      const output: unknown = previousOutput && typeof previousOutput === 'object' && !Array.isArray(previousOutput)
        ? structuredClone(previousOutput) : previousOutput
      if (authorAction && output && typeof output === 'object' && 'candidates' in output && Array.isArray(output.candidates) && output.candidates.length === 1) {
        const candidate = output.candidates[0]
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          if ('action' in candidate && candidate.action !== authorAction) invalid('只重推作者行动的后果；不得生成不同的行动。')
          candidate.action = authorAction
        }
      }
      const result = parsePreparationCandidates(output, material)
      if (sceneDraft && result.candidates.length === 1) {
        const candidate = result.candidates[0]!
        for (const [actual, expected] of [[candidate.materialIds, sceneDraft.attempt.materialIds],
          [candidate.preconditionIds, sceneDraft.attempt.preconditionIds], [candidate.resultBasisIds, sceneDraft.development.resultBasisIds]]) {
          if (actual.length !== expected.length || actual.some(id => !expected.includes(id))) invalid('文字表达不能更换已审阅骨架的引用依据。')
        }
        if (candidate.unknownIds.length || result.questions.length) invalid('文字表达不能新增补充依赖。')
      }
      if (authorAction && (result.candidates.length !== 1 || result.candidates[0]!.action !== authorAction)) invalid('重推必须完整保留作者编辑的行动。')
      if (result.candidates.some(c => rejectedCandidates.some(old => old.action === c.action))) invalid('新提案重复了已拒绝的行动。')
      if (new Set(result.candidates.map(c => `${c.action.replace(/\s/gu, '')}|${c.possibleResult.replace(/\s/gu, '')}`)).size !== result.candidates.length) invalid('故事方向重复。')
      const issues = await requestPreparationResponse({
          systemPrompt: preparationDirectionQualityPrompt(brief),
         userPrompt: JSON.stringify({ sources, material, mainlineAnchors, mainlineGoals, creativeFocus, brief, authorAction, rejectedCandidates,
          authorRequirements: sceneAuthorRequirements({ sources, material, brief, rejectedCandidates, authorAction }),
           sceneDraft: sceneDraft ? { action: sceneDraft.attempt.action,
             change: sceneDraft.development.change, response: sceneDraft.development.response } : undefined, proposal: result,
          expressionBoundary: '若提供sceneDraft，核对表达是否新增或改变骨架的事件、物件、人物边界和后果。骨架是待作者审阅的未来设计，不是执行证据。',
          reviewMode: result.candidates.length ? authorAction ? '作者编辑的方向与可能发展核对' : '三条故事困境的共同目标、阻碍差异和选择因果核对' : '仅补充创作选择，不要求行动、结果或完整因果链' }),
            temperature: 0.1, maxTokens: 2600, diagnosticStage: 'preparation-quality-review', outputSchema: preparationDirectionQualitySchema(result.candidates.map(candidate => candidate.id)),
        }, raw => {
      const audit = object(raw, ['checks', 'issues', 'candidateChecks'])
      const mainlineChecks = list(audit.candidateChecks, 3).map(value => {
        const check = object(value, ['id', 'pursuedGoal', 'branches', 'relation', 'reason'])
        const id = text(check.id, 80)
        if (!result.candidates.some(candidate => candidate.id === id)
          || !['pursues-goal', 'goal-tradeoff', 'substituted', 'unrelated'].includes(String(check.relation))) invalid('方向主线审阅的编号或关系不合法。')
        const branches = list(check.branches, 3).map(value => {
          const branch = object(value, ['action', 'outcome', 'goalEffect', 'mechanism'])
          if (!['advances', 'attempted', 'postponed', 'abandoned', 'failed', 'substituted', 'unaddressed'].includes(String(branch.goalEffect))
            || !['supported', 'unsupported'].includes(String(branch.mechanism))) invalid('方向分支审阅的目标变化或机制判断不合法。')
          const action = text(branch.action, 240), outcome = text(branch.outcome, 240)
           return { action, outcome,
            goalEffect: String(branch.goalEffect), mechanism: String(branch.mechanism) }
        })
        if (!branches.length) invalid('方向审阅缺少分支结果。')
        return { id, pursuedGoal: text(check.pursuedGoal, 240), branches, relation: String(check.relation), reason: text(check.reason, 320) }
      })
      if (!coversCandidates(mainlineChecks, result.candidates)) invalid('方向主线审阅必须恰好覆盖每张卡片。')
      const issues = list(audit.issues, 8).map((v, i) => text(v, 500, `issues[${i}]`))
      const checks = list(audit.checks, 5).map(v => {
        const check = object(v, ['criterion', 'passed', 'evidence'])
        if (!preparationQualityCriteria.includes(check.criterion as typeof preparationQualityCriteria[number]) || typeof check.passed !== 'boolean') invalid('内容审阅维度或判断不合法。')
        return { criterion: String(check.criterion), passed: check.passed, evidence: text(check.evidence, 320, `checks[${String(check.criterion)}].evidence`) }
      })
       if (checks.length !== 5 || new Set(checks.map(c => c.criterion)).size !== 5) invalid('内容审阅没有完成全部维度。')
       const branchIssues = mainlineChecks.flatMap(check => check.branches.flatMap((branch, i) =>
        ['substituted', 'unaddressed'].includes(branch.goalEffect) || branch.mechanism === 'unsupported'
           ? [`${check.id} 分支${i + 1}：${branch.action} → ${branch.outcome}；目标影响=${branch.goalEffect}，机制=${branch.mechanism}。`] : []))
      if (checks.every(c => c.passed) && issues.length && !branchIssues.length
        && mainlineChecks.every(check => !['substituted', 'unrelated'].includes(check.relation))) invalid('审阅各项均通过却仍列出内容缺陷。请只重审原提案，使checks和issues一致；不改写故事，也不为保留问题列表编造失败项。')
      issues.push(...branchIssues)
      for (const check of mainlineChecks) if (['substituted', 'unrelated'].includes(check.relation)) {
        issues.push(`${check.id} 主线偏航：实际追求“${check.pursuedGoal}”；${check.reason}`)
      }
       logPreparationReview('quality', attempt + 1, result.candidates.map(candidate => candidate.id), { checks, mainlineChecks, issues })
      // Preserve failed dimensions without flooding regeneration with the same
      // critique twice (issues and checks usually describe the same defects).
      if (!issues.length) for (const check of checks.filter(c => !c.passed)) issues.push(`${check.criterion}：${check.evidence}`)
      return issues
      })
      if (issues.length) throw new PreparationQualityError(issues, 'directions', attempt + 1)
      // Legacy callers may provide prebuilt bridges. Keep validating those
      // explicit bridges, but ordinary direction cards stay lightweight until
      // the author selects one.
      if (result.candidates.some(candidate => candidate.causalBridge)) {
        const projected = await projectFutureChoices(result.candidates, sources, brief, mainlineAnchors, mainlineGoals, creativeFocus)
        return { ...result, candidates: projected }
      }
      return result
    } catch (error) {
      // Projection already repaired the rejected bridges. Rewriting all
      // approved directions here discards unrelated work and repeats the loop.
      if ((error instanceof PreparationQualityError && error.origin === 'causal-bridge')
        || (error instanceof AppError && (error.modelDiagnostic?.stage.startsWith('preparation-future-choice')
          || error.modelDiagnostic?.stage === 'preparation-directions-text-length'
          || error.modelDiagnostic?.stage.startsWith('preparation-quality-review')))) throw error
      if (attempt || !(error instanceof AppError) || !['STORY_PREPARATION_INVALID_OUTPUT', 'STORY_PREPARATION_QUALITY_FAILED'].includes(error.code)) throw error
      validationFailure = error instanceof PreparationQualityError ? `内容审阅：${error.issues.join('；')}` : error.message
      if (error instanceof PreparationQualityError && sceneDraft) {
        const revised = await generateSceneDraft({ sources, material, brief, rejectedCandidates, authorAction, creativeFocus }, { draft: sceneDraft, issues: error.issues })
        if ('questions' in revised) invalid('表达后的内容修复不能转换为作者资料不足。')
        sceneDraft = revised as typeof sceneDraft
      }
    }
  }
  return invalid('提案重推未完成。')
}

export async function reviseStoryPreparation(curve: ProvisionalCurve, decision: 'reject' | 'regenerate' | 'revise', candidateId?: string, authorAction?: string): Promise<ProvisionalCurve> {
  if (curve.status !== 'draft' || curve.beats.length || curve.preparation?.status !== 'needs-review') throw new AppError('只能调整尚未采用的故事方向。', 409, 'STORY_PREPARATION_NOT_PENDING')
  const next = structuredClone(curve), p = next.preparation!
  if (decision === 'reject') {
    const candidate = p.candidates.find(c => c.id === candidateId)
    if (!candidate) throw new AppError('要拒绝的提案不存在。', 400, 'INVALID_REQUEST')
    p.rejectedCandidates = [...(p.rejectedCandidates ?? []), candidate]
    p.candidates = p.candidates.filter(c => c.id !== candidateId)
    p.questions = p.questions.filter(q => p.candidates.some(c => c.unknownIds.includes(q.id)))
  } else {
    if (decision === 'revise' && !p.candidates.some(c => c.id === candidateId)) throw new AppError('要编辑的提案不存在。', 400, 'INVALID_REQUEST')
    if (decision === 'revise' && (!authorAction?.trim() || authorAction.length > generatedProposalTextMax)) throw new AppError('请填写修改后的行动，最多240字。', 400, 'INVALID_REQUEST')
    if (decision === 'regenerate') p.rejectedCandidates = [...(p.rejectedCandidates ?? []), ...p.candidates]
    const generated = await generatePreparationCandidates(p.sources, p.material, next.brief, p.mainlineAnchors ?? [], p.rejectedCandidates, decision === 'revise' ? authorAction : undefined, p.mainlineGoals ?? [], p.appealMaterialIds ?? [])
    p.originalCandidates = [...(p.originalCandidates ?? []), ...p.candidates]
    if (decision === 'revise') {
      const revised = generated.candidates[0]!
      p.candidates = p.candidates.map(c => c.id === candidateId ? { ...revised, id: c.id } : c)
      p.questions = [...p.questions.filter(q => p.candidates.some(c => c.id !== candidateId && c.unknownIds.includes(q.id))), ...generated.questions]
    } else {
      p.candidates = generated.candidates
      p.questions = generated.questions
    }
  }
  next.updatedAt = Date.now()
  return next
}

export function parsePreparationReview(value: unknown, acceptedIds: string[]): StoryPreparationReview {
  const fail = (): never => { throw new AppError('请提供所选行动的作者确认原文、行动和可能结果。', 400, 'INVALID_REQUEST') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const r = value as Record<string, unknown>
  const validText = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 4000
  if (Object.keys(r).some(k => !['originalText','selectedStoryDirection','candidates','supersededMaterialIds','confirmedQuotes'].includes(k)) || !validText(r.originalText) || !Array.isArray(r.candidates)) return fail()
  if (r.selectedStoryDirection !== undefined && (!validText(r.selectedStoryDirection) || r.selectedStoryDirection.length > 400)) return fail()
  const candidates = r.candidates.map(v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail()
    const c = v as Record<string, unknown>
    if (Object.keys(c).some(k => !['id','action','possibleResult','futureChoice','resultBasisIds','explanation'].includes(k)) || typeof c.id !== 'string' || !acceptedIds.includes(c.id) || !validText(c.action) || !validText(c.possibleResult) || (c.futureChoice !== undefined && c.futureChoice !== '' && !validText(c.futureChoice))) return fail()
    if (c.resultBasisIds !== undefined && (!Array.isArray(c.resultBasisIds) || c.resultBasisIds.some(id => typeof id !== 'string') || new Set(c.resultBasisIds).size !== c.resultBasisIds.length)) return fail()
    return { id: c.id, action: c.action, possibleResult: c.possibleResult, ...(c.futureChoice === undefined ? {} : { futureChoice: c.futureChoice as string }), ...(c.resultBasisIds === undefined ? {} : { resultBasisIds: c.resultBasisIds as string[] }), ...(c.explanation === undefined ? {} : { explanation: parsePreparationExplanation(c.explanation) }) }
  })
  if (candidates.length !== acceptedIds.length || new Set(candidates.map(c => c.id)).size !== candidates.length) return fail()
  const supersededMaterialIds = r.supersededMaterialIds === undefined ? undefined : r.supersededMaterialIds
  const confirmedQuotes = r.confirmedQuotes === undefined ? undefined : r.confirmedQuotes
  if (supersededMaterialIds !== undefined && (!Array.isArray(supersededMaterialIds) || supersededMaterialIds.some(id => typeof id !== 'string') || new Set(supersededMaterialIds).size !== supersededMaterialIds.length)) return fail()
  if (confirmedQuotes !== undefined && (!Array.isArray(confirmedQuotes) || confirmedQuotes.some(q => !validText(q) || !(r.originalText as string).includes(q)) || new Set(confirmedQuotes).size !== confirmedQuotes.length)) return fail()
  if (Array.isArray(supersededMaterialIds) && supersededMaterialIds.length && (!Array.isArray(confirmedQuotes) || !confirmedQuotes.length)) return fail()
  return { originalText: r.originalText, ...(r.selectedStoryDirection === undefined ? {} : { selectedStoryDirection: r.selectedStoryDirection }), candidates,
    ...(supersededMaterialIds === undefined ? {} : { supersededMaterialIds: supersededMaterialIds as string[] }),
    ...(confirmedQuotes === undefined ? {} : { confirmedQuotes: confirmedQuotes as string[] }) }
}

export function acceptPreparation(p: StoryPreparation, acceptedCandidateIds: string[], review?: StoryPreparationReview): StoryPreparation {
  if (p.status !== 'needs-review') throw new AppError('结构已接受，请审阅当前曲线。', 409, 'STORY_PREPARATION_ALREADY_ACCEPTED')
  if (acceptedCandidateIds.length !== 1 || new Set(acceptedCandidateIds).size !== acceptedCandidateIds.length
    || acceptedCandidateIds.some(id => !p.candidates.some(c => c.id === id))) throw new AppError('请选择存在的结构候选。', 400, 'INVALID_REQUEST')
  if (p.candidates.some(c => acceptedCandidateIds.includes(c.id) && c.unknownIds.length)) throw new AppError('该行动仍依赖未知条件，请补充或选择独立方案。', 409, 'STORY_PREPARATION_UNKNOWN_DEPENDENCY')
  const authorReview = review === undefined ? undefined : parsePreparationReview(review, acceptedCandidateIds)
  if (authorReview) {
    for (const revised of authorReview.candidates) {
      const original = p.candidates.find(candidate => candidate.id === revised.id)
      if (!original) continue
      const reviewedExplanation = revised.explanation
        && revised.explanation.wording.action === revised.action
        && revised.explanation.wording.possibleResult === revised.possibleResult
        && (revised.explanation.wording.futureChoice ?? '') === (revised.futureChoice ?? original.futureChoice ?? '')
      if (revised.explanation && !reviewedExplanation) {
        throw new AppError('卡片已再次修改，请核对当前内容的解释，旧解释仍保留供查看。', 409, 'STORY_PREPARATION_EXPLANATION_STALE')
      }
      // An edited action invalidates its derived possible result. Do not let a
      // client carry the old prediction forward under the new action; the
      // original candidate remains in originalCandidates for audit/history.
      if (!reviewedExplanation && revised.action !== original.action && revised.possibleResult === original.possibleResult) {
        throw new AppError('作者改动了行动，但仍沿用旧的可能结果；请重新审阅并明确新的结果或保留未知。', 409, 'STORY_PREPARATION_DERIVED_RESULT_STALE')
      }
      if (!reviewedExplanation && (revised.action !== original.action || revised.possibleResult !== original.possibleResult)
        && revised.futureChoice === original.futureChoice && original.futureChoice) {
        throw new AppError('作者改动了方向或可能走向，请修改或清空旧的后续故事取舍。', 409, 'STORY_PREPARATION_DERIVED_RESULT_STALE')
      }
    }
  }
  if (authorReview?.supersededMaterialIds?.some(id => !p.material.some(m => m.id === id))) throw new AppError('修订引用的旧材料不存在。', 400, 'INVALID_REQUEST')
  const revised = { ...structuredClone(p), status: 'accepted-design' as const, acceptedCandidateIds, executed: false as const,
    ...(authorReview ? { authorReview, originalCandidates: structuredClone(p.candidates), candidates: p.candidates.map(c => {
      const reviewed = authorReview.candidates.find(r => r.id === c.id)
      if (!reviewed) return c
      const merged = { ...c, ...reviewed }
      if (reviewed.futureChoice === '') delete merged.futureChoice
      if (reviewed.action !== c.action || reviewed.possibleResult !== c.possibleResult
        || reviewed.futureChoice !== undefined && reviewed.futureChoice !== c.futureChoice || reviewed.explanation) delete merged.causalBridge
      if (reviewed.action !== c.action || reviewed.possibleResult !== c.possibleResult
        || reviewed.futureChoice !== undefined && reviewed.futureChoice !== c.futureChoice || reviewed.explanation) delete merged.expansionNeeds
      if (reviewed.explanation?.expansionNeeds?.length) merged.expansionNeeds = structuredClone(reviewed.explanation.expansionNeeds)
      return merged
    }) } : {}) }
  // A revised quote does not automatically prove the old causal claim.
  // Remove superseded references; require the author to review the new result.
  const replaced = new Set(authorReview?.supersededMaterialIds ?? [])
  revised.candidates = revised.candidates.map(c => acceptedCandidateIds.includes(c.id) ? { ...c,
    materialIds: c.materialIds.filter(id => !replaced.has(id)),
    preconditionIds: c.preconditionIds.filter(id => !replaced.has(id)),
    resultBasisIds: c.resultBasisIds.filter(id => !replaced.has(id)),
  } : c)
  const activeKnown = new Set(activePreparationMaterial(revised).filter(m => m.role !== 'unknown').map(m => m.id))
  if (revised.candidates.some(c => acceptedCandidateIds.includes(c.id) && (!c.materialIds.length
    || [...c.materialIds, ...c.preconditionIds, ...c.resultBasisIds].some(id => !activeKnown.has(id))
    || p.candidates.some(original => original.id === c.id && original.resultBasisIds.some(id => replaced.has(id))
      && original.possibleResult === c.possibleResult && !c.resultBasisIds.length)))) {
    throw new AppError('修订后请明确审阅行动的目标来源及被取代的结果依据，不能自动沿用旧材料。', 409, 'STORY_PREPARATION_REVISION_BASIS_REQUIRED')
  }
  return revised
}

/** The selected, possibly edited card is the basis for a new reviewable story. */
export async function generateCurveFromPreparation(curve: ProvisionalCurve, acceptedIds: string[], review?: StoryPreparationReview): Promise<ProvisionalCurve> {
  if (!curve.preparation || curve.status !== 'draft' || curve.beats.length) throw new AppError('当前不在方向确认阶段。', 409, 'STORY_PREPARATION_NOT_PENDING')
  const accepted = acceptPreparation(curve.preparation, acceptedIds, review)
  // The first screen only needs three comparable direction cards. Build the
  // deeper causal bridge after the author has selected one card, so unused
  // alternatives do not spend model calls or acquire misleading detail.
  const selected = accepted.candidates.filter(candidate => accepted.acceptedCandidateIds.includes(candidate.id))
  const hasMainlineContract = (accepted.mainlineAnchors?.length ?? 0) > 0 || (accepted.mainlineGoals?.length ?? 0) > 0
  const needsProjection = selected.some(candidate => !candidate.causalBridge && !candidate.explanation) && hasMainlineContract
  const projected = needsProjection
    ? await projectFutureChoices(selected, accepted.sources, curve.brief,
      accepted.mainlineAnchors ?? [], accepted.mainlineGoals ?? [], preparationCreativeFocus(accepted), accepted.authorReview?.selectedStoryDirection)
    : selected
  const projectedById = new Map(projected.map(candidate => [candidate.id, candidate]))
  const preparation = { ...accepted, candidates: accepted.candidates.map(candidate => projectedById.get(candidate.id) ?? candidate) }
  const activeMaterial = activePreparationMaterial(preparation)
  const goal = activeMaterial.find(item => item.role === 'goal')
  return developPreparationStory(curve, preparation, goal)
}
