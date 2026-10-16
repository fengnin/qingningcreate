import { randomUUID } from 'node:crypto'
import { parsePreparationExplanation } from './storyPreparationExplanation.js'
import { activePreparationMaterial } from './storyPreparationContext.js'
export { activePreparationMaterial } from './storyPreparationContext.js'
import { hasProposalProtocolLeak } from './storyProposalProse.js'
import { storyCreativeIntentGuidance, storyCreativeFocusGuidance, preparationCreativeFocus } from './storyCreativeIntent.js'
import { storyDevelopmentGuidance, storyDevelopmentRepairGuidance, storySemanticReviewGuidance, storyTechnicalReviewGuidance } from './storySemanticReview.js'
import { developmentStateGuidance, developmentStateIssues, type DevelopmentState } from './storyDevelopmentState.js'
import { bridgeRepairDiagnostic, parseBridgeReviewCheck, bridgeEvidenceCatalog, storyDirectionDetailGuidance, type BridgeEvidence } from './storyBridgeReview.js'
import { generateSceneDraft, sceneAuthorRequirements } from './storySceneDraft.js'
import { AppError, requestQwenJson, withModelDiagnostic } from './qwen.js'
import { preparationOutputSchemas as schemas, preparationQualitySchema, projectionOutputSchema, causalReviewOutputSchema, factReviewOutputSchema } from './storyOutputSchemas.js'
import { parseFactReviewChecks } from './storyFactReview.js'
import { mapInitialReasoningProposal } from './storyInitialReasoning.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'
import type { StoryCausalBridge, StoryMainlineAnchor, StoryMainlineGoal, StoryPreparation, StoryPreparationCandidate, StoryPreparationItem, StoryPreparationReview, StoryExpansionNeed, StoryCreativeFocus } from '../../shared/story-preparation.js'
import type { StoryReasoningProposal } from '../../shared/story-reasoning-contract.js'
import type { CreativeBrief, ProvisionalCurve, StoryDesignRecord } from '../../shared/story-contract.js'

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
  const collect = (value: unknown, path: string, limits: Record<string, number>) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const record = value as Record<string, unknown>
    for (const [key, targetLength] of Object.entries(limits)) {
      const value = record[key]
      if (typeof value === 'string' && value.length > generatedProposalTextMax) fields.push({
        id: `t${fields.length}`, path: `${path}.${key}`, text: value, maxLength: generatedProposalTextMax, targetLength, record, key,
      })
    }
  }
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


const preparationQuestionsPrompt = `你是第一次写作的作者的故事搭档。当前在最小行动候选阶段的补充入口，人物目标尚未确定，或作者明确保留的关键未知阻碍了独立构思；依据requiredResponse区分这两种情况。
严格返回 JSON {candidates:[],questions:[{id,question,materialIds}]}。只问一个容易回答的创作选择：谁想做什么，或谁正面对什么具体情境。提供两三个简短例子帮助作者选择，也允许作者自定。不问抽象类型、主动被动、主体客体、戏剧机制或创作理论，不要求一次补齐人物、地点、期限、阻碍和结局。没有人物就先问人物，不将等候的对象误称为行动主体。
保留原文已定风格、场景及结尾期待；不能把结尾期待当人物当前愿望。不要设计角色行动或结果，不进行现实事实核查。materialIds 仅取 referenceContract.questionMaterialIds 中相关的原文ID，不能新增来源。`

const preparationDirectionsPrompt = `你是一位中文短篇故事编辑。从作者的想法提出恰好三种可以继续展开的故事困境，供作者选择；此时不写场景、对白或人物已经做出的具体动作。
${storyDevelopmentGuidance}
严格输出JSON {candidates:[{id,action,materialIds,preconditionIds,possibleResult,resultBasisIds,unknownIds}],questions:[]}。每条 action 用50至110字，必须使用两段明确标记：“遇到的难处：……”和“眼前的选择：……”。前一段说明人物原本想完成什么、未来可能遇到的一个阻碍；后一段说明由该阻碍造成的眼前取舍。不要把阻碍写成已经发现、已被告知或已被要求的事实。possibleResult 用30至80字写不同选择可能让原目标怎样变化，不宣称结果已经发生。不写“提议：”“可能发展：”前缀。
 三条从同一原始愿望出发，在事件、人物应对及取舍上分化；删去专有名词后若仍是同一阻碍，就重新构思。mainlineGoals 是作者的完整主线，mainlineAnchors 是原文指定的要素。每条只围绕一个主要阻碍和一个眼前取舍，不在短卡里写完多轮过程。先利用人物性格、相处方式、行动对象和已有场景产生变化；确实需要新人物、道具或条件时再补，交代其怎样影响选择即可。
 人物可以在遇见新情况后改变打算，甚至主动承担原先回避的代价；写清为何改变，以及原愿望、风险或关系如何继续影响取舍。不能仅在开头重提原目标、随后转去无关任务。作者已定结局是选定方向应能走向的终点，不必让三条使用同一个转折。保留作者期限、承诺、否定、关系、结局期望和明确未知；只说双方有分歧时，不替他们确定立场。
 意外可以从已有情境中自然遇见，不必全由人物造成，也不必在卡片里解释完整来历；之后的可能发展须与人物不同应对有关，不靠再一次巧合自动解题。新内容都是尚未发生、可拒绝的提案。能力与限制按故事世界判断：日常互动不必补证明流程，奇幻能力不必补科学原理；关键结果仍须有相应行动或能力支撑，不把询问写成必然获准，不凭空越过作者限制。
 每条id唯一，用d0、d1、d2。引用字段只能使用 referenceContract 中对应字段允许的材料 ID；mainlineAnchors 和 mainlineGoals 只用于理解主线，不是引用来源。materialIds至少引用原始目标；preconditionIds只能从 referenceContract.preconditionMaterialIds 选取行动确实依赖的作者已定事实或条件，没有额外前提就返回空数组，不得把人物目标当作前提。resultBasisIds只在可能结果明确承接已知原文条件时引用，否则返回空数组；不能为系统新创作的结果硬填原始目标充当证明。短输入允许提出新结果，但仍须与原目标、明确条件和人物选择构成可信因果。unknownIds为空。rejectedCandidates只用于避开作者拒绝过的方向，不是故事事实。
输出结构：每条候选必须有七个独立字段，不能把 possibleResult、materialIds 等键名及其内容写进 action 字符串。单条编码示例（只示范字段，文字和ID必须按本次输入构思与选择）：{"id":"d0","action":"遇到的难处：人物面临的一个具体问题。眼前的选择：两种可能的应对。","materialIds":["本次允许的目标材料ID"],"preconditionIds":[],"possibleResult":"人物不同应对可能带来的变化。","resultBasisIds":[],"unknownIds":[]}。最终顶层为 {"candidates":[三条完整候选],"questions":[]}。即使重试也须返回完整JSON，不只给修订的句子或部分字段。不要附加解释。`

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
  mainlineAnchors: StoryMainlineAnchor[] = [], mainlineGoals: StoryMainlineGoal[] = [], creativeFocus?: StoryCreativeFocus): Promise<StoryPreparationCandidate[]> {
  if (!candidates.length) return candidates
  const hasCompleteProjection = candidates.every(candidate => candidate.futureChoice && candidate.causalBridge)
  const prompt = `你是故事大纲编辑。输入包含已审阅的方向卡。为每条方向补人物可能采取的办法、由此可能发生的处境变化和下一层故事取舍，不写完整剧情。返回精确 JSON {developments:[{attempt:{means,methodUses,text,materialIds},change:{outcome,states,text,materialIds},futureChoice:{requires,text},id}]}，每个输入 id 恰好一项。每条按attempt→change→futureChoice连续写完整后再写下一条，不把办法与后续选择分成两组独立构思。
${storyDevelopmentGuidance}
${storyCreativeFocusGuidance}
${developmentStateGuidance}
method 是人物在方向卡眼前取舍中可能采取的办法，change 是办法后可能出现的新局面，使原目标更近、更远，或改变已建立的人物关系；两项各用40至100字，简明写清机制，不要把它写成已经发生。methodBasisIds 只能引用该方向的 materialIds；changeBasisIds 只在变化确实承接作者原文条件时引用该方向的 resultBasisIds，否则为空。引用表示承接作者材料，不证明新结果已经发生或因果成立。来源 ID 不写入文字。
以上办法编码为attempt.text、methodBasisIds编码为attempt.materialIds；处境变化编码为change.text、changeBasisIds编码为change.materialIds；后续取舍编码为futureChoice.text。不要输出旧的bridges或futureChoices顶层数组。
本步写故事大纲，不写操作指南。办法用一个可理解的行动说清，不展开拆装、接线、材料用量或参数实验。题材确实关注技术时，保留直接决定取舍的关键条件即可。若阻力来自人与人的关系，让尝试与回应落在相处中，不凭空增加必须先解决的技术难题。
 每条 text 30至80字，写明办法奏效或失败后，人物面对哪两种后续走向。新取舍须影响原愿望的机会、代价或已有关系，也可以让人物在保住原打算与回应更在意的事情之间选择；等待、核对、调整做法或路线也可成立，但这次办法必须带来新信息、条件或后果，不能原地重复。先沿方向卡已有人物、目标和情境寻找办法；新事件可以偶然出现，不要求由上一步直接造成，但人物须有自然理由遇见它，且它须影响原目标和选择，不能连续空降无关麻烦代替人物行动改变处境。
 可以创作新人物、道具、往事、服务或规则，无须作者原文或方向卡预先写明；新内容应能从人物正在做的事或已有场所情境自然遇见。能力与代价按作者的世界设定和题材判断，新设定须自洽并保留已有的限制。普通询问、登记、协商及他人合理配合可以带出可能变化，无须另编整套手续、权限或背景；有必要条件时用条件式说明，不保证必然获准。关键结果须有办法能提供的信息、资源或能力支撑；线索可以引出调查，不能无依据地变成定论。
 method 只写人物选用的办法；change 写办法成败、他人回应或相关发现带来的信息、机会、限制、代价或关系变化，不用心理感悟代替处境变化。futureChoices.text 写变化后尚待决定的两种走向，不必写出结局。写故事规划，不写对白、微动作、身体感受、隐藏经历或完整场景。不为增强戏剧性再空降一轮麻烦；先让这次办法产生后果。所有内容仍是可拒绝、尚未发生的系统提案。`
  const input = { sources, brief, mainlineAnchors, mainlineGoals, creativeFocus, candidates: candidates.map(({ id, action, possibleResult, materialIds, resultBasisIds }) => ({ id, action, possibleResult, materialIds, resultBasisIds })) }
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
${storySemanticReviewGuidance}`,
        userPrompt: JSON.stringify({ sources, material: factMaterial, candidates: input.candidates.filter(candidate => reviewableCandidates.some(item => item.id === candidate.id)),
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
            creativeFocus,
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
  const anchors = splitReferenceEntries(value, frames, 'mainlineAnchors', 16, ['kind']).map((entry, index) => {
    const item = object(entry, ['id', 'kind', ...(entry && typeof entry === 'object' && 'materialIds' in entry ? ['materialIds'] : ['sourceId', 'quote'])])
    const suppliedKind = String(item.kind)
    const kind = suppliedKind === 'condition' || suppliedKind === 'time' ? 'constraint' : suppliedKind
    if (!['character', 'relationship', 'place', 'action', 'object', 'constraint'].includes(kind)) invalid(`mainlineAnchors[${index}].kind 不合法。`)
    const reference = resolvePreparationReference(item, sources, frames, `mainlineAnchors[${index}]`)
    return { id: text(item.id, 80), kind: isAuthorRequirementSource(reference.sourceId) ? 'constraint' as const : kind as StoryMainlineAnchor['kind'], ...reference }
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

export async function generateStoryPreparation(idea: string, brief: CreativeBrief): Promise<ProvisionalCurve> {
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
  const candidates = await generatePreparationCandidates(sources, material, brief, mainlineAnchors, [], undefined, mainlineGoals, appealMaterialIds)
  const now = Date.now()
  return { id: `curve-${randomUUID()}`, title: '一起选择故事方向', status: 'draft', brief, beats: [], instructions: [],
    preparation: { protocol: 1, status: 'needs-review', sources, material, mainlineAnchors, mainlineGoals, appealMaterialIds, ...candidates, acceptedCandidateIds: [], executed: false }, createdAt: now, updatedAt: now,
    generation: { origin: 'model', dramaticMechanism: '原文整理与三种故事困境分开生成；尚未生成曲线，也未确认事实' } }
}

async function generatePreparationCandidates(sources: StoryPreparation['sources'], material: StoryPreparationItem[], brief: CreativeBrief,
  mainlineAnchors: StoryMainlineAnchor[] = [], rejectedCandidates: StoryPreparationCandidate[] = [], authorAction?: string,
  mainlineGoals: StoryMainlineGoal[] = [], appealMaterialIds: string[] = []): Promise<Pick<StoryPreparation, 'candidates' | 'questions'>> {
  const creativeFocus = preparationCreativeFocus({ sources, material, appealMaterialIds })
  const input = { sources, material,
    creativeFocus,
    mainlineAnchors: mainlineAnchors.map(({ kind, quote }) => ({ kind, quote })),
    mainlineGoals: mainlineGoals.map(({ quote }) => quote),
    brief, referenceContract: preparationReferenceContract(material), rejectedCandidates, ...(authorAction ? { authorAction } : {}) }
  let needsGoalChoice = !authorAction && !material.some(m => m.role === 'goal')
  // Undecided author intent stays in the question path. Never manufacture a
  // character goal to make the staged scene pipeline run.
  const sceneStep = needsGoalChoice || !authorAction ? undefined : await generateSceneDraft({ sources, material, brief, rejectedCandidates, authorAction, creativeFocus })
  let sceneDraft = sceneStep && 'attempt' in sceneStep ? sceneStep : undefined
  const unknownQuestions = sceneStep && 'questions' in sceneStep ? sceneStep.questions : undefined
  if (unknownQuestions) needsGoalChoice = true
  let previousOutput: unknown
  let validationFailure: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    // Presentation and reference IDs are deterministic. Asking the model to
    // copy an approved scene creates another opportunity for story drift.
    previousOutput = sceneDraft ? { candidates: [{ id: 'c0',
      action: authorAction ?? `提议：${sceneDraft.attempt.action}`,
      materialIds: sceneDraft.attempt.materialIds, preconditionIds: sceneDraft.attempt.preconditionIds,
      possibleResult: `可能发展：${sceneDraft.development.change}${sceneDraft.development.response}`,
      resultBasisIds: sceneDraft.development.resultBasisIds, unknownIds: [] }], questions: [] }
       : await requestQwenJson({ systemPrompt: needsGoalChoice ? preparationQuestionsPrompt : `${validationFailure?.startsWith('内容审阅：') ? `${storyDevelopmentRepairGuidance}\n` : ''}${preparationDirectionsPrompt}\n${storyCreativeIntentGuidance(brief, 'directions')}\n${storyCreativeFocusGuidance}`,
      userPrompt: JSON.stringify({ ...input, ...(sceneDraft ? { sceneDraft } : {}), ...(needsGoalChoice ? { requiredResponse: unknownQuestions ? 'candidates=[]；围绕suggestedQuestions对应的明确未知，只问一个必要问题，不替作者决定未知。' : 'candidates=[]；原文尚无人物目标，请只问一个人物或目标的创作选择，不设计角色行动。', ...(unknownQuestions ? { suggestedQuestions: unknownQuestions } : {}) } : {}), ...(validationFailure ? { previousOutput, validationFailure } : {}) }),
      temperature: needsGoalChoice ? 0.2 : 0.45, maxTokens: needsGoalChoice ? 1200 : 3000, diagnosticStage: needsGoalChoice ? 'preparation-candidates' : 'preparation-directions',
      outputSchema: needsGoalChoice ? schemas.questions : schemas.directions })
    try {
      // In edit mode the model generates only a result, never another action.
      // A conflicting action remains a visible error; do not splice it away.
      const output = authorAction && previousOutput && typeof previousOutput === 'object' && !Array.isArray(previousOutput)
        ? structuredClone(previousOutput) as Record<string, unknown> : previousOutput
      if (authorAction && output && typeof output === 'object' && 'candidates' in output && Array.isArray(output.candidates) && output.candidates.length === 1) {
        const candidate = output.candidates[0]
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          if ('action' in candidate && candidate.action !== authorAction) invalid('只重推作者行动的后果；不得生成不同的行动。')
          candidate.action = authorAction
        }
      }
      const result = parsePreparationCandidates(!authorAction && !needsGoalChoice
        ? await repairGeneratedTextLengths(output, sources, 'preparation-directions-text-length') : output, material)
      if (sceneDraft && !authorAction && (result.candidates.length !== 1
          || ![sceneDraft.attempt.action, `提议：${sceneDraft.attempt.action}`].includes(result.candidates[0]!.action))) invalid('文字表达不能更换已审阅的尝试。')
      if (sceneDraft && result.candidates.length === 1) {
        const candidate = result.candidates[0]!
        for (const [actual, expected] of [[candidate.materialIds, sceneDraft.attempt.materialIds],
          [candidate.preconditionIds, sceneDraft.attempt.preconditionIds], [candidate.resultBasisIds, sceneDraft.development.resultBasisIds]]) {
          if (actual.length !== expected.length || actual.some(id => !expected.includes(id))) invalid('文字表达不能更换已审阅骨架的引用依据。')
        }
        if (candidate.unknownIds.length || result.questions.length) invalid('文字表达不能新增补充依赖。')
      }
      if (needsGoalChoice && result.candidates.length) invalid('原文尚无人物目标；请返回 candidates=[] 和一个具体创作问题，不把作者主题或未定人物转换为角色行动。')
      if (!needsGoalChoice && !authorAction && (result.candidates.length !== 3 || result.questions.length
          || result.candidates.some(c => c.unknownIds.length))) invalid('请给出三条不依赖补充问题的故事困境。')
      if (authorAction && (result.candidates.length !== 1 || result.candidates[0]!.action !== authorAction)) invalid('重推必须完整保留作者编辑的行动。')
      if (result.candidates.some(c => rejectedCandidates.some(old => old.action === c.action))) invalid('新提案重复了已拒绝的行动。')
      if (new Set(result.candidates.map(c => `${c.action.replace(/\s/gu, '')}|${c.possibleResult.replace(/\s/gu, '')}`)).size !== result.candidates.length) invalid('故事方向重复。')
      const issues = await requestPreparationResponse({
          systemPrompt: `审查故事提案质量，核对文字是否忠实于作者材料与创作边界。返回精确JSON {checks:[{criterion,passed,evidence}],issues:[具体问题]}。五项criterion为facts,causality,requirements,author-control,questions，每项一次；passed布尔值，evidence引用具体措辞、不超过140字。issues最多三项、每项不超过200字，只有实质缺陷才列；不得补写缺失解释替提案圆场。结合 mainlineGoals 的完整原目标和 mainlineAnchors，对每张方向卡的 action 与 possibleResult 整体判断是否仍服务原故事；若某张卡转向与原愿望、人物关系和取舍代价失去联系的任务，令 causality 失败并在 issues 写明候选 id 和偏航处。不逐要素输出判断，也不在此阶段审阅因果桥的下一步。允许人物因有来由的发现或回应改变目标、牺牲原打算；原活动、关系或风险须继续影响选择的意义与代价。
${storySemanticReviewGuidance}
facts：逐条保留原目标、行动主体、明确事实、期限、承诺、关系、否定以及命名权限。作者事实是初始状态，可在未来发展中变化；不能把求职者写成招聘人员，不能把假装或象征动作当成实际目标。
  causality：有sceneDraft时比较骨架与提案，不能新增或更换尝试、变化、回应。没有sceneDraft时，只检查每条新事件是否能在已有情境中被人物遇见、是否改变人物处境并深化或转变原愿望所带出的选择；可能走向是否与人物的不同应对有关，而非下一次巧合自动完成。意外不必由上一行动造成，卡片不必解释完整事件来历或写完故事曲线；不要以缺少后续细节判失败。各方向是互斥的备选设计，不是同一时间线；分别核对内部逻辑，不把不同方向的新设定互相当作已定事实来判矛盾。不同方向须有实质不同的主要阻碍或关键选择，换道具、场地或措辞不算不同。作者要求的共同结局不算机制差异：若三条都是同一种认知错误、同一种物件线索或同一种误会，只换了表面细节，必须指出重复。
 requirements：新人物、道具、往事、代价及日常流程均可作为未来设计创作，不要求作者预先提供。按作者世界、题材惯例及提案的自洽设定理解，只拦截影响关键转折的明显不可能、越权或矛盾：例如办法没有能力支撑所称结果、违背已有能力限制、明显荒谬的强制规则，或把询问与他人沉默直接当作已获授权。正常互动不要求权限链，奇幻能力不要求科学实现，短卡不要求补齐规则制定者、完整手续或事件全史。技术、规则或手续本身不构成错误；相继增加的无关要求若替代人物应对，须指出哪一步失去故事联系，而非要求再补一套设定。
 author-control：所有新增内容是尚未执行、可拒绝的未来设计，不能决定作者明确保留的未知。保留authorAction，拒绝后改变机制。骨架本身也是设计，不是事实证据。
questions：问题必要具体、易回答，只问人物目标或不可避开的作者未知，不追问自造设定的现实证明，不重复确认。不提供行动而只问创作选择时，causality只检查问题能否帮助确定人物或情境，不要求问题包含完整故事。
${storyCreativeIntentGuidance(brief, 'directions')}
${storyCreativeFocusGuidance}
若有候选，检查三条是否都与所选感觉、戏剧力量和作者额外偏好相容，并各自提供不同、可发展的主要机制；这里不要求每条卡片独立完成整篇故事。若某条完全偏离，或把作者偏好直接写成已发生结果，列出候选 id；不能只因出现标签词、俏皮对白就判通过。作者偏好应在选定方向后的曲线与正文中转化为可观察的行动、选择或收束；作者事实与因果优先，不要求新增未确认的关键事件。`,
         userPrompt: JSON.stringify({ sources, material, mainlineAnchors, mainlineGoals, creativeFocus, brief, authorAction, rejectedCandidates,
          authorRequirements: sceneAuthorRequirements({ sources, material, brief, rejectedCandidates, authorAction }),
          sceneDraft: sceneDraft ? { action: sceneDraft.attempt.action,
            change: sceneDraft.development.change, response: sceneDraft.development.response } : undefined, proposal: result,
          expressionBoundary: '若提供sceneDraft，核对表达是否新增或改变骨架的事件、物件、人物边界和后果。骨架是待作者审阅的未来设计，不是执行证据。',
          reviewMode: result.candidates.length ? authorAction ? '作者编辑的方向与可能发展核对' : '三条故事困境的共同目标、阻碍差异和选择因果核对' : '仅补充创作选择，不要求行动、结果或完整因果链' }),
         temperature: 0.1, maxTokens: 1800, diagnosticStage: 'preparation-quality-review', outputSchema: preparationQualitySchema,
       }, raw => {
      const audit = object(raw, ['checks', 'issues'])
      const issues = list(audit.issues, 8).map((v, i) => text(v, 500, `issues[${i}]`))
      const checks = list(audit.checks, 5).map(v => {
        const check = object(v, ['criterion', 'passed', 'evidence'])
        if (!preparationQualityCriteria.includes(check.criterion as typeof preparationQualityCriteria[number]) || typeof check.passed !== 'boolean') invalid('内容审阅维度或判断不合法。')
        return { criterion: String(check.criterion), passed: check.passed, evidence: text(check.evidence, 320, `checks[${String(check.criterion)}].evidence`) }
      })
       if (checks.length !== 5 || new Set(checks.map(c => c.criterion)).size !== 5) invalid('内容审阅没有完成全部维度。')
      if (checks.every(c => c.passed) && issues.length) invalid('审阅各项均通过却仍列出内容缺陷。请只重审原提案，使checks和issues一致；不改写故事，也不为保留问题列表编造失败项。')
      logPreparationReview('quality', attempt + 1, result.candidates.map(candidate => candidate.id), { checks, issues })
      // Preserve failed dimensions without flooding regeneration with the same
      // critique twice (issues and checks usually describe the same defects).
      if (!issues.length) for (const check of checks.filter(c => !c.passed)) issues.push(`${check.criterion}：${check.evidence}`)
      return issues
      })
      if (issues.length) throw new PreparationQualityError(issues, 'directions', attempt + 1)
      if (result.candidates.length) {
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
  if (Object.keys(r).some(k => !['originalText','candidates','supersededMaterialIds','confirmedQuotes'].includes(k)) || !validText(r.originalText) || !Array.isArray(r.candidates)) return fail()
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
  return { originalText: r.originalText, candidates,
    ...(supersededMaterialIds === undefined ? {} : { supersededMaterialIds: supersededMaterialIds as string[] }),
    ...(confirmedQuotes === undefined ? {} : { confirmedQuotes: confirmedQuotes as string[] }) }
}

/** Classification is model work, never a server keyword inference. A missing
 * role can be recovered by selecting existing text without rewriting history. */
async function resolvePreparationGoal(material: StoryPreparationItem[]): Promise<StoryPreparationItem> {
  const classified = material.find(m => m.role === 'goal')
  if (classified) return classified
  const known = material.filter(m => m.role !== 'unknown')
  const output = await requestQwenJson({
    systemPrompt: '核对作者目标分类。输出精确 JSON {goalMaterialId}。只从输入 knownMaterial 中选择明确表达作者人物目标的一项 ID；不改写目标，不以行动候选或可能结果代替目标，不推断人物动机。没有明确目标时返回 goalMaterialId:null。此输出只是原文角色审阅，不是设计接受或执行事实。',
    userPrompt: JSON.stringify({ knownMaterial: known }), temperature: 0.1, maxTokens: 200, diagnosticStage: 'preparation-goal-classification', outputSchema: schemas.goal,
  })
  const r = object(output, ['goalMaterialId'])
  const id = r.goalMaterialId === null ? null : text(r.goalMaterialId, 80)
  const goal = known.find(m => m.id === id)
  if (!goal) invalid('目标分类未给出有效的已知原文引用；模型需重新整理或返回问题审阅，不能用行动或未知材料补造目标。')
  return goal!
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

/** The model writes stage-specific review text within the accepted structure.
 * Reference validation is not semantic certification; no text becomes fact. */
export async function generateCurveFromPreparation(curve: ProvisionalCurve, acceptedIds: string[], review?: StoryPreparationReview): Promise<ProvisionalCurve> {
  return arrangePreparationCurve(curve, acceptedIds, review)
}

async function arrangePreparationCurve(curve: ProvisionalCurve, acceptedIds: string[], review?: StoryPreparationReview, omittedOnFirstAttempt?: string[]): Promise<ProvisionalCurve> {
  if (!curve.preparation || curve.status !== 'draft' || curve.beats.length) throw new AppError('当前不在行动结构审阅阶段。', 409, 'STORY_PREPARATION_NOT_PENDING')
  const p = acceptPreparation(curve.preparation, acceptedIds, review)
  const selected = p.candidates.filter(c => acceptedIds.includes(c.id))
  const activeMaterial = activePreparationMaterial(p)
  const known = new Set(activeMaterial.filter(m => m.role !== 'unknown').map(m => m.id))
  const goalMaterial = await resolvePreparationGoal(activeMaterial)
  const options = { systemPrompt: `排列已接受未来行动，不写执行记录。严格输出 JSON {steps:[{kind,candidateIds,materialIds,displayMaterialIds}],supplements:[{id,kind,text,question,materialIds}]}。每个step的四个字段均须给出。steps 不输出 title 或 text；程序按 ID 取回已审阅原文，不需要重新抄写。
materialIds 和 displayMaterialIds 只能选 referenceContract.knownMaterialIds；unknownMaterial 只用于理解作者保留的未知，绝不引用为已知。candidateIds 只能选 referenceContract.acceptedCandidateIds。referenceContract.stepReferences 明确给出每类节点的引用范围：current-state选currentStateMaterialIds；行动阶段选当前candidateId的actionMaterialIds；resolution选当前candidateId的resultMaterialIds，为空时必须输出materialIds=[]。材料与故事相关，不等于它属于该节点的依据；尤其不能把行动目标引用成新结果的依据。若有 validationFailure，只修复本次排列及不合法引用，保留已接受候选，不补新事实。
${storyCreativeIntentGuidance(curve.brief, 'curve')} 本阶段只排列和引用已接受的文字；若已选方向没有兑现创作倾向，也不得偷偷重写它。
这是引用排列阶段，不展开故事。只排列 material.quote、acceptedCandidates.action 和 acceptedCandidates.possibleResult，不扩写新办法、后续取舍或新的高潮。
核心 steps 只选择已有材料或已接受候选的 ID，不扩写新设计。3 至5段，依序 current-state,trigger,可选 escalation,可选 climax-choice,resolution；简单行动只需三段，不造高潮。current-state 的 candidateIds=[]，displayMaterialIds 必须非空，选择 materialIds 中能说明当前情境的已知片段（含分隔符合计不超过240字，不要只选时间短语）；程序将不相邻的片段分行展示，不补连接或因果。其余阶段 candidateIds 恰好一个，displayMaterialIds=[]。程序展示候选 action，resolution 展示 possibleResult，仍是未来假设。
current-state 的 materialIds 非空；所有行动阶段（trigger、escalation、climax-choice）的 materialIds 也须非空，选择对应候选 materialIds 中实际承接的材料。可选阶段不等于引用可省略；若没有不同的已接受行动可排列，省略 escalation、climax-choice，不重复同一行动凑高潮。resolution 仅在候选 resultBasisIds 非空时引用它们，否则 materialIds=[]；新创作的可能结果仍是已接受的未来设计，不以原目标充当结果证明。materialIds 不可引用已取代材料。
先逐项分配全部已知材料：current-state 的 materialIds 保留初始状态、背景、全局条件和作者保留的可选路径；displayMaterialIds 只决定展示的原文，其余引用仍记录背景承接。trigger 的引用说明行动依据，resolution 的引用说明假设结果依据。这三种用途不同，保留可选路径不等于冲突，尚未开始是行动前状态而非故障假设，均不应另加 supplements 要求作者再次确认。行动和结果的窄引用域不限制 current-state 引用其他已知背景。全部已知材料必须在 steps 的 materialIds 中由模型显式承接。没有期限是边界，不是阻碍；可兼容条件不是冲突。引用背景或替代路径不表示它是行动前提、结果依据或已执行事件，不得因此改写候选 preconditionIds/resultBasisIds。未知材料不在已知覆盖范围内，不得引用为事实。服务端不会自动补齐遗漏的引用。
新增故障假设、观察步骤、检查标准或条件只能写入独立 supplements，kind=hypothesis|observation|criterion|condition，question 为具体待作者审阅问题，materialIds 只引用现有材料。它们不可成为 steps 或既有行动的前提；即使提出也不阻止独立核心行动生成曲线。没有新增设计就给空数组。引用本身不证明因果，不能暗中增加人物、权限、结果。`, userPrompt: JSON.stringify({ material: activeMaterial.filter(m => known.has(m.id)),
  unknownMaterial: activeMaterial.filter(m => !known.has(m.id)), referenceContract: { knownMaterialIds: [...known], acceptedCandidateIds: acceptedIds,
    stepReferences: { currentStateMaterialIds: [...known], byCandidate: selected.map(c => ({ candidateId: c.id,
      actionMaterialIds: c.materialIds, resultMaterialIds: c.resultBasisIds })) } },
  // Derived projections remain in the session for review. This stage only
  // arranges exact accepted quotations, so do not offer projections as text.
  acceptedCandidates: selected.map(({ causalBridge, futureChoice, explanation, ...candidate }) => candidate),
  authorReview: p.authorReview ? { ...p.authorReview, candidates: p.authorReview.candidates.map(({ explanation, ...candidate }) => candidate) } : null,
  ...(omittedOnFirstAttempt ? { coverageReview: { omittedMaterialIds: omittedOnFirstAttempt, instruction: '上一预览遗漏这些作者材料。重新审阅各节点的背景、约束及保留替代路径；只显式引用实际承接的材料，不改写行动或补因果。无法承接的仍留给作者决定，不伪造覆盖。' } } : {}) }), temperature: 0.2, maxTokens: 2400, diagnosticStage: 'preparation-curve-generation', outputSchema: schemas.arrangement }
  const parseArrangement = (output: unknown) => {
  const r = object(output, ['steps', 'supplements']), kinds = ['current-state','trigger','escalation','climax-choice','resolution'] as const
  p.supplements = list(r.supplements, 8).map(v => {
    const s = object(v, ['id','kind','text','question','materialIds'])
    if (!['hypothesis','observation','criterion','condition'].includes(String(s.kind))) invalid('新增设计类型不合法。')
    return { id: text(s.id, 80), kind: s.kind as NonNullable<StoryPreparation['supplements']>[number]['kind'], text: text(s.text), question: text(s.question), materialIds: ids(s.materialIds, known), status: 'needs-review' as const }
  })
  unique([...activeMaterial, ...p.candidates, ...p.questions, ...p.supplements])
  const arrangements = list(r.steps, 5).map((v, i) => {
    const legacyText = !!v && typeof v === 'object' && ('text' in v || 'title' in v)
    const s = object(v, ['kind', 'candidateIds', 'materialIds', ...(legacyText ? ['title', 'text'] : [])], legacyText ? [] : ['displayMaterialIds'])
    if (!kinds.includes(s.kind as typeof kinds[number])) invalid('曲线阶段不正确。')
    const refs = ids(s.candidateIds, new Set(acceptedIds))
    if ((i === 0 && refs.length) || (i > 0 && !refs.length)) invalid('曲线只能排列已接受的行动结构。')
    const materialRefs = ids(s.materialIds, known)
    const referencedCandidates = selected.filter(c => refs.includes(c.id))
    if (s.kind === 'resolution') {
      const allowedResultIds = new Set(referencedCandidates.flatMap(c => c.resultBasisIds))
      const hasAuthorResultBasis = allowedResultIds.size > 0
      if (hasAuthorResultBasis && !materialRefs.length) invalid('曲线遗漏候选已有的作者结果条件。')
      if (materialRefs.some(id => !allowedResultIds.has(id))) invalid(`steps[${i}].materialIds只能选择当前候选的resultMaterialIds=${JSON.stringify([...allowedResultIds])}，不能引用目标、行动起点或其他候选的依据。${!hasAuthorResultBasis ? '系统新创作的结果不能补造作者原文依据；此节点必须输出materialIds=[]。' : ''}只修改当前排列的引用，不修改已接受故事。`)
    } else if (s.kind !== 'current-state') {
      const allowedActionIds = new Set(referencedCandidates.flatMap(c => c.materialIds))
      if (materialRefs.some(id => !allowedActionIds.has(id))) invalid(`steps[${i}].materialIds只能选择当前候选的actionMaterialIds=${JSON.stringify([...allowedActionIds])}；不能把背景或结果依据移入行动依据。只修改当前排列的引用，不修改已接受故事。`)
      if (!materialRefs.length) invalid(`steps[${i}]（${s.kind}）的 materialIds 不能为空；行动阶段引用对应候选 actionMaterialIds。可选行动阶段没有独立内容时应省略，服务端不补依据。`)
    } else if (!materialRefs.length) invalid(`steps[${i}]（${s.kind}）的 materialIds 不能为空；当前情境引用已知材料，行动阶段引用对应候选 materialIds。可选行动阶段没有独立内容时应省略，服务端不补依据。`)
    let content: string
    if (legacyText) content = text(s.text)
    else if (s.kind === 'current-state') {
      if (!Array.isArray(s.displayMaterialIds) || !s.displayMaterialIds.length) invalid(`steps[${i}].displayMaterialIds缺失或为空；必须从本节点materialIds选择用于展示的原文编号。只补本次排列引用，不改写故事。`)
      const displayRefs = ids(s.displayMaterialIds, new Set(materialRefs), `steps[${i}].displayMaterialIds`)
      if (!displayRefs.length) invalid('当前情境缺少展示材料。')
      // Display only model-selected known excerpts. Separate disjoint sources
      // or spans visibly rather than inventing a continuous quotation.
      const display = activeMaterial.filter(item => displayRefs.includes(item.id))
      const sourceId = display[0]!.sourceId
      const original = p.sources.find(source => source.id === sourceId)
      const joined = display.map(item => item.quote).join('')
      const contiguous = display.every(item => item.sourceId === sourceId) && original?.text.includes(joined)
      content = text(display.map(item => item.quote).join(contiguous ? '' : '\n'))
    } else {
      if (refs.length !== 1 || s.displayMaterialIds !== undefined
        && (!Array.isArray(s.displayMaterialIds) || s.displayMaterialIds.length)) invalid('行动或结果须选择一个已接受候选，displayMaterialIds为空数组。')
      const candidate = selected.find(candidate => candidate.id === refs[0])!
      content = text(s.kind === 'resolution' ? candidate.possibleResult : candidate.action)
    }
    const allowedTexts = s.kind === 'current-state' ? activeMaterial.filter(m => materialRefs.includes(m.id)).map(m => m.quote)
      : selected.filter(c => refs.includes(c.id)).map(c => s.kind === 'resolution' ? c.possibleResult : c.action)
    if (legacyText && (!allowedTexts.includes(content) || s.title !== content)) invalid('核心曲线夹带未审新增设计；只能逐字展示有效材料或已接受行动及可能结果。')
    return { kind: s.kind as typeof kinds[number], title: content, text: content, refs, materialRefs }
  })
  if (arrangements.length < 3 || arrangements[0]?.kind !== 'current-state' || arrangements[1]?.kind !== 'trigger' || arrangements.at(-1)?.kind !== 'resolution'
    || arrangements.some((s, i) => i > 0 && kinds.indexOf(s.kind) <= kinds.indexOf(arrangements[i-1]!.kind))
    || selected.some(c => !arrangements.some(s => s.refs.includes(c.id)))) invalid('曲线遗漏已接受结构或阶段顺序不正确。')
  // Optional phases must contribute distinct accepted wording. Merge only
  // already validated references; this changes neither text nor its authority.
  const normalized: typeof arrangements = []
  for (const step of arrangements) {
    const duplicate = step.kind === 'escalation' || step.kind === 'climax-choice'
      ? normalized.find(previous => previous.kind !== 'current-state' && previous.text.replace(/\s/gu, '') === step.text.replace(/\s/gu, '')) : undefined
    if (duplicate) {
      duplicate.refs = [...new Set([...duplicate.refs, ...step.refs])]
      duplicate.materialRefs = [...new Set([...duplicate.materialRefs, ...step.materialRefs])]
    } else normalized.push(step)
  }
  return normalized
  }
  const arrangements = await requestPreparationResponse(options, parseArrangement)
  const covered = new Set(arrangements.flatMap(s => s.materialRefs))
  const omitted = [...known].filter(id => !covered.has(id))
  // One explicit model recovery, never server-added citations. A partial
  // preview remains reviewable; its confirmation still requires the author's
  // disposition decision. Upstream failures remain failures, not fallback.
  if (omitted.length && !omittedOnFirstAttempt) return arrangePreparationCurve(curve, acceptedIds, review, omitted)
  const evidence = (ids: string[]) => ids.map(id => activeMaterial.find(m => m.id === id)!).map(m => ({ sourceId: m.id, quote: m.quote }))
  const basis = (ids: string[]) => ({ kind: 'design-proposal' as const, evidence: evidence(ids), unknownIds: [] })
  const actions = selected.map(c => ({ id: c.id, text: c.action, basis: basis(c.materialIds), constraintIds: c.preconditionIds.map(id => `material-${id}`), relationIds: [`result-${c.id}`], unknownIds: [], respondsToEditIds: [] }))
  const relations = selected.map(c => ({ id: `result-${c.id}`, text: c.possibleResult, basis: basis(c.resultBasisIds), relation: 'cause' as const,
    fromIds: [c.id, ...c.preconditionIds], toIds: c.resultBasisIds.length ? c.resultBasisIds : ['prepared-goal'] }))
  const conditions = activeMaterial.filter(m => m.role !== 'unknown').map(m => ({ id: `material-${m.id}`, text: m.quote, basis: { kind: 'author-text' as const, evidence: [{ sourceId: m.id, quote: m.quote }] } }))
  const proposal: StoryReasoningProposal = { protocol: 1, stage: 'initial-design', status: 'needs-review', outcome: 'proposal',
    goal: goalMaterial ? { id: 'prepared-goal', text: goalMaterial.quote, basis: { kind: 'author-text', evidence: evidence([goalMaterial.id]) } } : null,
    constraints: conditions, actions, relations, unknowns: [], steps: arrangements.map((s, i) => {
      // Model text remains a separate design proposal, never server-written cause.
      // Titles are display labels. Preserve the complete, strictly validated
      // source text and references in the statement, not in the 40-char slot.
      const titles = { 'current-state': '当前材料', trigger: '未来行动', escalation: '后续行动', 'climax-choice': '行动取舍', resolution: '可能结果' }
      return { id: `beat-${s.kind}`, kind: s.kind, title: titles[s.kind], text: s.text, basis: basis(s.materialRefs),
        actionIds: s.refs, relationIds: s.kind === 'resolution' ? s.refs.map(id => `result-${id}`) : [], dependsOn: i ? [`beat-${arrangements[i - 1]!.kind}`] : [], respondsToEditIds: [] }
    }), designReview: { required: true, acceptedProposalIds: [] } }
  const design: StoryDesignRecord = { id: `design-${randomUUID()}`, sourceFacts: activeMaterial.filter(m => m.role !== 'unknown').map(m => ({ id: m.id, text: m.quote, source: 'user-input', disposition: 'needs-author-decision', coveredByBeatIds: [] })), conflictCoreBeatIds: ['beat-current-state','beat-trigger'], predicamentBeatIds: ['beat-trigger','beat-escalation'], storyEndBeatIds: ['beat-current-state','beat-climax-choice','beat-resolution'], middleDevelopmentBeatIds: ['beat-escalation','beat-climax-choice'] }
  const beatIds = new Set(proposal.steps.map(s => s.id))
  for (const key of ['conflictCoreBeatIds','predicamentBeatIds','storyEndBeatIds','middleDevelopmentBeatIds'] as const) design[key] = design[key].filter(id => beatIds.has(id))
  validateStoryReasoningProposal(proposal, { stage: 'initial-design', sources: design.sourceFacts.map(f => ({ id: f.id, text: f.text, authority: 'author-material' })), protectedSteps: [], requiredEditIds: [] })
  const mapped = mapInitialReasoningProposal(proposal, design, curve.brief, { allowSimplePlan: true })
  return { ...mapped, id: curve.id, preparation: p, createdAt: curve.createdAt }
}
