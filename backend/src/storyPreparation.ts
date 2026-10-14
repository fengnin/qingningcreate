import { randomUUID } from 'node:crypto'
import { hasProposalProtocolLeak } from './storyProposalProse.js'
import { storyCreativeIntentGuidance } from './storyCreativeIntent.js'
import { generateSceneDraft, sceneAuthorRequirements } from './storySceneDraft.js'
import { AppError, requestQwenJson } from './qwen.js'
import { mapInitialReasoningProposal } from './storyInitialReasoning.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'
import type { StoryCausalBridge, StoryPreparation, StoryPreparationCandidate, StoryPreparationItem, StoryPreparationReview } from '../../shared/story-preparation.js'
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
class PreparationQualityError extends AppError {
  constructor(readonly issues: string[]) {
    super('这个方向的内容审阅未通过，请换一个提案或调整想法；尚未生成故事曲线。', 502, 'STORY_PREPARATION_QUALITY_FAILED')
  }
}
const preparationQualityCriteria = ['facts', 'causality', 'requirements', 'author-control', 'questions'] as const
function logPreparationReview(stage: string, attempt: number, candidateIds: string[], decision: object): void {
  if (process.env.STORY_PREPARATION_DIAGNOSTICS !== 'true') return
  // Model judgments may quote the author's text; keep them in opt-in local server logs only.
  console.warn('[preparation] review', JSON.stringify({ stage, attempt, candidateIds, decision }))
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('输出必须是对象。')
  const r = value as Record<string, unknown>
  if (Object.keys(r).length !== keys.length || keys.some(k => !(k in r))) invalid('输出字段不符合当前阶段，禁止夹带事实更新或确认状态。')
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
严格输出JSON {candidates:[{id,action,materialIds,preconditionIds,possibleResult,resultBasisIds,unknownIds}],questions:[]}。每条 action 用50至110字，必须使用两段明确标记：“遇到的难处：……”和“眼前的选择：……”。前一段说明人物原本想完成什么、未来可能遇到的一个阻碍；后一段说明由该阻碍造成的眼前取舍。不要把阻碍写成已经发现、已被告知或已被要求的事实。possibleResult 用30至80字写不同选择可能让原目标怎样变化，不宣称结果已经发生。不写“提议：”“可能发展：”前缀。
三条共享原始目标，只在阻碍及取舍的因果机制上分化；删去人物、物件和地点后，阻碍若仍相同就重新构思。作者希望看到的结局是共同终点，不是三条都要重复使用的阻碍或转折；分别设计不同的起因和关键选择，让选定的任一方向都能合理通向该终点。每条只保留一个主要阻碍和一个取舍，不要在同一条里列三个以上方案。短输入可以创作目标、代价、期限、人物、道具或往事，但每条卡围绕一个有意义的新事件发展，不用多个互不相干的新设定层层解释。新增内容是尚未发生、可拒绝的故事提案，不是作者已经提供的事实或必须补证的现实条件。意外不必由人物造成，也不必在卡片里解释完整来历；但人物应能在已有情境中遇见它，它须改变眼前目标并带出具体取舍。可能走向应由人物的不同应对打开，不靠下一次巧合自动兑现结果；具体发现过程和期限来由可在后续曲线中展开。允许创作符合故事世界常识的场所服务与日常流程，不因作者没写就否定：例如遗失门票后向游客中心询问能否补票可以提议；具体核验方式、费用和能否代办若决定结果，不能未经交代就保证成功。人物提议先陪朋友玩旋转木马是可拒绝的办法；“园区规定第一次来必须先玩旋转木马”若无合理世界设定，只是为了制造障碍，不应采用。关键新规则、资源或设备能力要符合当前故事世界，并有可理解的运作方式；不能靠拼贴假票突然获得扫码入园或闭园后游玩资格。作者明确给出的架空规则应保留，不套用现实规则限制。不要靠未经建立的设备特性、医学状态、技术故障或连续巧合自动兑现结果。保留原文期限、承诺、否定、关系、结局期望和明确未知；若只说双方有分歧，不要替他们确定各自立场；人物拒绝、沉默或尚未回应，不等于同意。人物亲自推进原目标：求职者找自己的工作，想游玩的人可以进入游玩。
每条id唯一，用d0、d1、d2。materialIds至少引用原始目标；preconditionIds只引用行动确实依赖的已知原文条件。resultBasisIds只在可能结果明确承接已知原文条件时引用，否则返回空数组；不能为系统新创作的结果硬填原始目标充当证明。短输入允许提出新结果，但仍须与原目标、明确条件和人物选择构成可信因果。unknownIds为空。rejectedCandidates只用于避开作者拒绝过的方向，不是故事事实。不要附加解释。`

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
    questionMaterialIds: material.map(m => m.id), unknownDependencyIds: 'questions[].id' }
}

export function parsePreparationCandidates(value: unknown, material: StoryPreparationItem[]): Pick<StoryPreparation, 'candidates' | 'questions'> {
  const r = object(value, ['candidates', 'questions'])
  const materialIds = new Set(material.map(m => m.id)), known = new Set(material.filter(m => m.role !== 'unknown').map(m => m.id))
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
      const method = text(bridge.method, 240), change = text(bridge.change, 240)
      if (!method || !change || method === change || !methodBasisIds.length) invalid('因果桥必须包含办法、处境变化和办法的目标来源。')
      causalBridge = { method, change, methodBasisIds, changeBasisIds }
    }
    const item: StoryPreparationCandidate = { id: text(c.id, 80), action: text(c.action), materialIds: candidateMaterialIds,
      preconditionIds: ids(c.preconditionIds, known, `candidates[${i}].preconditionIds`), possibleResult: text(c.possibleResult), resultBasisIds, unknownIds: ids(c.unknownIds, questionIds, `candidates[${i}].unknownIds`),
      ...(c.futureChoice === undefined ? {} : { futureChoice: text(c.futureChoice, 240, `candidates[${i}].futureChoice`) }), ...(causalBridge ? { causalBridge } : {}) }
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
  const output = object(raw, ['bridges', 'futureChoices'])
  const bridges = list(output.bridges, candidates.length).map(value => {
    const item = object(value, ['id', 'method', 'change', 'methodBasisIds', 'changeBasisIds'])
    if (!Array.isArray(item.methodBasisIds) || !Array.isArray(item.changeBasisIds)
      || item.methodBasisIds.some(id => typeof id !== 'string') || item.changeBasisIds.some(id => typeof id !== 'string')) invalid('因果桥来源 ID 格式不合法。')
    return { id: text(item.id, 80), method: text(item.method, 240), change: text(item.change, 240),
      methodBasisIds: item.methodBasisIds as string[], changeBasisIds: item.changeBasisIds as string[] }
  })
  if (!coversCandidates(bridges, candidates)) invalid('因果桥没有覆盖全部方向。')
  const choices = list(output.futureChoices, candidates.length).map(value => {
    const item = object(value, ['id', 'text'])
    return { id: text(item.id, 80), value: text(item.text, 240, 'futureChoices[].text') }
  })
  if (!coversCandidates(choices, candidates)) invalid('后续故事取舍没有覆盖全部方向。')
  return { bridges, choices }
}

export async function projectFutureChoices(candidates: StoryPreparationCandidate[], sources: StoryPreparation['sources'], brief: CreativeBrief): Promise<StoryPreparationCandidate[]> {
  if (!candidates.length) return candidates
  if (candidates.every(candidate => candidate.futureChoice && candidate.causalBridge)) return candidates
  const prompt = `你是故事大纲编辑。输入包含已审阅的方向卡。为每条方向补人物可能采取的办法、由此可能发生的处境变化和下一层故事取舍，不写完整剧情。返回精确 JSON {bridges:[{id,method,change,methodBasisIds,changeBasisIds}],futureChoices:[{id,text}]}，每个输入 id 在两组中恰好一项。
method 是人物在方向卡眼前取舍中可能采取的办法，change 是办法后可能出现的新局面，使原目标更近、更远，或改变已建立的人物关系；不要把它写成已经发生。methodBasisIds 只能引用该方向的 materialIds；changeBasisIds 只在变化确实承接作者原文条件时引用该方向的 resultBasisIds，否则为空。引用表示承接作者材料，不证明新结果已经发生或因果成立。来源 ID 不写入文字。
每条 text 30至80字，一句话写“如果眼前办法奏效或失败，处境会怎样改变；人物因此还要在什么两种故事走向间取舍”。新取舍必须改变原目标的推进方式、作品归属或人物间的协作关系，不得只是再修一次、再等片刻、再核对一次、换项目或换路线。可以补充人物、期限、道具、往事或可信的日常服务作为可拒绝的未来创意；若成为下一层选择的关键条件，须能从已选方向或人物行动中合理接出，不把“可以询问”直接写成“已获批准”。新增机构规则或特殊能力若决定结果，要符合故事世界并交代其运作；不能靠突然生效的设备功能、无来由的特权或他人默认同意直接解决问题。写故事规划，不写角色下一秒做什么；不要对白、微动作、物件位置、秘密、确定结局或“学会成长”式感悟。
粒度示范 A：若她解决入园问题，同行者可能已先走；她要独自游玩，还是追上对方说明自己希望一起玩？
粒度示范 B：若她修好妹妹被淋湿的画，画面可能已不是妹妹原作；她要替妹妹决定照常送展，还是坦白修改并让妹妹参与决定？
示范只说明“新局面改变选择对象”的结构，不能复制其中的人物、物件和情节。所有内容仍是可拒绝、尚未发生的系统提案。`
  const input = { sources, brief, candidates: candidates.map(({ id, action, possibleResult, materialIds, resultBasisIds }) => ({ id, action, possibleResult, materialIds, resultBasisIds })) }
  const projectedBridges = new Map<string, ReturnType<typeof parseFutureChoiceProjection>['bridges'][number]>()
  const projectedChoices = new Map<string, string>()
  let repairReasons: { id: string; reason: string }[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const pending = attempt && repairReasons.length ? candidates.filter(candidate => repairReasons.some(issue => issue.id === candidate.id)) : candidates
      const pendingInput = { ...input, candidates: input.candidates.filter(candidate => pending.some(item => item.id === candidate.id)),
        ...(repairReasons.length ? { repairReasons } : {}) }
      const rawOutput = await requestQwenJson({ systemPrompt: `${prompt}
关键设定若决定结果，写清它为何在此情境可信；不要用凭空新增的机构互通、专用设备或特权来代替人物办法。若输入含 repairReasons，仅重写所列方向的因果桥和取舍，不改方向卡。`, userPrompt: JSON.stringify(pendingInput), temperature: attempt ? 0.15 : 0.35,
         maxTokens: 1200, diagnosticStage: 'preparation-future-choice' })
      const { bridges: generatedBridges, choices: generatedChoices } = parseFutureChoiceProjection(rawOutput, pending)
      for (const bridge of generatedBridges) projectedBridges.set(bridge.id, bridge)
      for (const choice of generatedChoices) projectedChoices.set(choice.id, choice.value)
      const bridges = candidates.map(candidate => projectedBridges.get(candidate.id)!)
      const choices = candidates.map(candidate => ({ id: candidate.id, value: projectedChoices.get(candidate.id)! }))
      for (const candidate of candidates) {
        const bridge = projectedBridges.get(candidate.id)!
        if (bridge.method === bridge.change || !bridge.methodBasisIds.length
          || bridge.methodBasisIds.some(id => !candidate.materialIds.includes(id))
          || bridge.changeBasisIds.some(id => !candidate.resultBasisIds.includes(id))) invalid(`${candidate.id} 因果桥引用或内容不合法。`)
      }
      const review = object(await requestQwenJson({
        systemPrompt: `审查每条方向的“办法→处境变化→故事将推向”因果桥，不修改原困境。返回精确 JSON {checks:[{id,valid,reason}]}，每个 id 恰好一项，valid 为布尔值，reason 点明关键证据与修复方向，尽量控制在 250 字内。
 逐条核对两个断点：一，决定结果的关键设定（机构间数据互通、专用资源、审批或设备能力等）在原文、方向或通常世界中是否有可信来由；普通服务、合理偶然和可拒绝的创作细节不因作者未写就拒绝。二，办法后的变化如何让人物更接近或远离原目标，或改变已经建立的关系；取舍不能转向与之无关的新任务。若不通过，reason 必须指出具体设定或偏航处及可修复方向，不能只说“缺少作者依据”。
 来源层级必须分清：sources 是作者材料；candidates 是系统已审、但仍可拒绝的方向；bridges 和 futureChoices 是本轮新设计。新设计中的一句“该通道为研学备案机制预留”不能反过来证明这个通道可信；具体、可验证、带数字的细节也不等于现实可信。若方向只提出“去询问能否人工核验”，桥却保证出现教育专用通道、跨机构自动同步、特殊权限或语音识别设备，且没有作者设定或方向内可信铺垫，应拒绝桥，不要把它夸成合理升级。另核对方向内已写明的限制：若人物只记得证件号后四位，不能靠“准确说出完整号码”作为解决办法。不要用后续取舍仍提到游乐园，就掩盖实际主冲突已转成学校数据或设备审批。
 其他条件：办法是眼前选择的自然发展，不是下一秒微动作；故事将推向的取舍比眼前操作更重要，仍是可拒绝的未来设计；不是重复修补、再等片刻、抽象说教或确定结局。新事件可以偶然出现，不要求它由上一行动造成，也不要求短方向卡交代完整来历；但办法后的变化不能再靠无关巧合、突然生效的设备功能或他人默认同意来完成。遗失门票后询问游客中心能否补办是可信的提案，不因作者未写补票流程就拒绝；但不能未经交代就保证凭他人身份证号代办成功。作者明确给出的架空规则应保留。可以留待曲线展开具体细节，不能仅因卡片尚未解释完毕就判失败。不能让作者或角色替另一人物接受改动。判断具体文本，不要因为它没有完整结局就拒绝。`,
        userPrompt: JSON.stringify({ sources, candidates: input.candidates, bridges, futureChoices: choices.map(choice => ({ id: choice.id, text: choice.value })) }),
        temperature: 0.1, maxTokens: null, diagnosticStage: 'preparation-future-choice-review',
      }), ['checks'])
      const checks = list(review.checks, candidates.length).map(value => {
        const item = object(value, ['id', 'valid', 'reason'])
        if (typeof item.valid !== 'boolean') invalid('后续取舍审阅判断不合法。')
        const id = text(item.id, 80)
        return { id, valid: item.valid, reason: text(item.reason, 500, `checks[${id}].reason`) }
      })
      if (!coversCandidates(checks, candidates)) invalid('后续取舍审阅没有覆盖全部方向。')
      logPreparationReview('future-choice', attempt + 1, candidates.map(candidate => candidate.id), { checks })
      const rejected = checks.filter(check => !check.valid)
      if (rejected.length) {
        if (!attempt) { repairReasons = rejected.map(({ id, reason }) => ({ id, reason })); continue }
        throw new PreparationQualityError(rejected.map(check => `${check.id} 因果桥：${check.reason}`))
      }
      const bridgeById = new Map(bridges.map(bridge => [bridge.id, bridge]))
      const choiceById = new Map(choices.map(choice => [choice.id, choice.value]))
      return candidates.map(candidate => {
        const usableBridge = bridgeById.get(candidate.id)!
        const futureChoice = choiceById.get(candidate.id)!
        return { ...candidate, futureChoice,
          causalBridge: { method: usableBridge.method, change: usableBridge.change, methodBasisIds: usableBridge.methodBasisIds, changeBasisIds: usableBridge.changeBasisIds } }
      })
    } catch (error) {
      if (attempt || !(error instanceof AppError) || error.code !== 'STORY_PREPARATION_INVALID_OUTPUT') throw error
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

/** Labels never override an author's explicit uncertainty. */
export function preserveRequirementRoles(material: StoryPreparationItem[]): StoryPreparationItem[] {
  return material.map(m => {
    if (['author-direction', 'author-boundaries', 'author-note'].includes(m.sourceId) && m.role !== 'unknown') {
      return { ...m, role: 'condition' as const }
    }
    return m
  })
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
    diagnosticStage: 'preparation-uncertainty-review' }
  const output = await requestQwenJson(options)
  try { return parse(output) } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'STORY_PREPARATION_INVALID_OUTPUT') throw error
    return parse(await requestQwenJson({ ...options, userPrompt: JSON.stringify({ ...JSON.parse(options.userPrompt), previousOutput: output, validationFailure: error.message }) }))
  }
}

export async function generateStoryPreparation(idea: string, brief: CreativeBrief): Promise<ProvisionalCurve> {
  const sources = preparationSources(idea, brief)
  const frames = framePreparationSources(sources)
  let extracted = await requestQwenJson({ systemPrompt: preparationExtractionPrompt, userPrompt: JSON.stringify({ sources, material: frames }), temperature: 0.1, maxTokens: 2400, diagnosticStage: 'preparation-extraction' })
  let material: StoryPreparationItem[]
  try {
    material = classifyPreparationMaterial(extracted, frames, sources)
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'STORY_PREPARATION_INVALID_OUTPUT') throw error
    extracted = await requestQwenJson({
      systemPrompt: `${preparationExtractionPrompt}\n上一份分类未通过校验。请返回全部输入 ID 的分类，只输出 id、role。`,
      userPrompt: JSON.stringify({ sources, material: frames, previousOutput: extracted, validationFailure: error.message }),
      temperature: 0.1, maxTokens: 2400, diagnosticStage: 'preparation-extraction-retry',
    })
    material = classifyPreparationMaterial(extracted, frames, sources)
  }
  // Explicit author expectations cannot become character goals.
  material = preserveRequirementRoles(await reviewPreparationUncertainty(sources, material))
  // Independently identify who wants what. Do not show the first classifier's
  // labels: its interpretation must not become the evidence for this check.
  {
    const intent = object(await requestQwenJson({
      systemPrompt: `核对人物当下意图，而非作者的创作期待。返回精确 JSON {characterGoalIds:[原文片段ID]}。选择原文明确赋予所有故事人物的当前愿望、任务、承诺，包括配角、相互冲突的目标；不能只选主角或可兼容的目标。主题、希望的结尾、关系走向和人物成长是作者约束，不选择。若原文只说作者想让人物最后发生什么，而没有人物本人想做什么，返回空数组。不能把你的建议作为原文意图。不看先前分类，依据完整原文判断主体和语境。`,
      userPrompt: JSON.stringify({ sources, material: frames }), temperature: 0, maxTokens: 600, diagnosticStage: 'preparation-character-intent',
    }), ['characterGoalIds'])
    const goalIds = new Set(ids(intent.characterGoalIds, new Set(frames.map(f => f.id)), 'characterGoalIds'))
    material = material.map(m => m.role === 'unknown' ? m
      : goalIds.has(m.id) ? { ...m, role: 'goal' as const }
      : m.role === 'goal' ? { ...m, role: 'condition' as const } : m)
  }
  const candidates = await generatePreparationCandidates(sources, material, brief)
  const now = Date.now()
  return { id: `curve-${randomUUID()}`, title: '一起选择故事方向', status: 'draft', brief, beats: [], instructions: [],
    preparation: { protocol: 1, status: 'needs-review', sources, material, ...candidates, acceptedCandidateIds: [], executed: false }, createdAt: now, updatedAt: now,
    generation: { origin: 'model', dramaticMechanism: '原文整理与三种故事困境分开生成；尚未生成曲线，也未确认事实' } }
}

async function generatePreparationCandidates(sources: StoryPreparation['sources'], material: StoryPreparationItem[], brief: CreativeBrief,
  rejectedCandidates: StoryPreparationCandidate[] = [], authorAction?: string): Promise<Pick<StoryPreparation, 'candidates' | 'questions'>> {
  const input = { sources, material, brief, referenceContract: preparationReferenceContract(material), rejectedCandidates, ...(authorAction ? { authorAction } : {}) }
  let needsGoalChoice = !authorAction && !material.some(m => m.role === 'goal')
  // Undecided author intent stays in the question path. Never manufacture a
  // character goal to make the staged scene pipeline run.
  const sceneStep = needsGoalChoice || !authorAction ? undefined : await generateSceneDraft({ sources, material, brief, rejectedCandidates, authorAction })
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
       : await requestQwenJson({ systemPrompt: needsGoalChoice ? preparationQuestionsPrompt : `${preparationDirectionsPrompt}\n${storyCreativeIntentGuidance(brief, 'directions')}`,
      userPrompt: JSON.stringify({ ...input, ...(sceneDraft ? { sceneDraft } : {}), ...(needsGoalChoice ? { requiredResponse: unknownQuestions ? 'candidates=[]；围绕suggestedQuestions对应的明确未知，只问一个必要问题，不替作者决定未知。' : 'candidates=[]；原文尚无人物目标，请只问一个人物或目标的创作选择，不设计角色行动。', ...(unknownQuestions ? { suggestedQuestions: unknownQuestions } : {}) } : {}), ...(validationFailure ? { previousOutput, validationFailure } : {}) }),
      temperature: needsGoalChoice ? 0.2 : 0.45, maxTokens: needsGoalChoice ? 1200 : 3000, diagnosticStage: needsGoalChoice ? 'preparation-candidates' : 'preparation-directions' })
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
      const result = parsePreparationCandidates(output, material)
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
      const audit = object(await requestQwenJson({
          systemPrompt: `审查故事提案质量，核对文字是否忠实于作者材料与创作边界。返回精确JSON {checks:[{criterion,passed,evidence}],issues:[具体问题]}。五项criterion为facts,causality,requirements,author-control,questions，每项一次；passed布尔值，evidence引用具体措辞、不超过140字。issues最多三项、每项不超过200字，只有实质缺陷才列；不得补写缺失解释替提案圆场。
facts：逐条保留原目标、行动主体、明确事实、期限、承诺、关系、否定以及命名权限。作者事实是初始状态，可在未来发展中变化；不能把求职者写成招聘人员，不能把假装或象征动作当成实际目标。
  causality：有sceneDraft时比较骨架与提案，不能新增或更换尝试、变化、回应。没有sceneDraft时，只检查每条新事件是否能在已有情境中被人物遇见、是否改变原目标并带出值得继续发展的选择；可能走向是否与人物的不同应对有关，而非下一次巧合自动完成。意外不必由上一行动造成，卡片不必解释完整事件来历或写完故事曲线；不要以缺少后续细节判失败。不同方向须有实质不同的主要阻碍或关键选择，换道具、场地或措辞不算不同。作者要求的共同结局不算机制差异：若三条都是同一种认知错误、同一种物件线索或同一种误会，只换了表面细节，必须指出重复。
 requirements：允许系统创作新目标、人物、道具、往事、代价、时间压力，以及符合故事世界常识的场所服务或日常流程；作者原文没有提供，本身不构成失败。检查关键新设定是否可信、是否服务人物选择，不能把几项互不相关的设定叠成唯一解决路径。新增事件的完整来历可在曲线补足，但若结果已经依赖某项规则、设备能力、机构批准或他人配合，卡片必须给出足以理解的因果，不能只宣称成功。遗失门票后询问游客中心能否补办可以通过；未交代核验条件就断言凭朋友身份证号代办成功，不应通过。人物提议先陪朋友玩旋转木马可以通过；默认现实游乐园无合理设定却规定首次入园必须先玩旋转木马，或拼贴可扫码假票换取闭园后游玩资格，必须指出不可信的具体原因。作者明确设定的架空规则不在此列。他人沉默或拒绝不等于授权。
author-control：所有新增内容是尚未执行、可拒绝的未来设计，不能决定作者明确保留的未知。保留authorAction，拒绝后改变机制。骨架本身也是设计，不是事实证据。
questions：问题必要具体、易回答，只问人物目标或不可避开的作者未知，不追问自造设定的现实证明，不重复确认。不提供行动而只问创作选择时，causality只检查问题能否帮助确定人物或情境，不要求问题包含完整故事。
${storyCreativeIntentGuidance(brief, 'directions')}
若有候选，检查三条是否都与所选感觉、戏剧力量和作者额外偏好相容，并各自提供不同、可发展的主要机制；这里不要求每条卡片独立完成整篇故事。若某条完全偏离，或把作者偏好直接写成已发生结果，列出候选 id；不能只因出现标签词、俏皮对白就判通过。作者偏好应在选定方向后的曲线与正文中转化为可观察的行动、选择或收束；作者事实与因果优先，不要求新增未确认的关键事件。`,
        userPrompt: JSON.stringify({ sources, material, brief, authorAction, rejectedCandidates,
          authorRequirements: sceneAuthorRequirements({ sources, material, brief, rejectedCandidates, authorAction }),
          sceneDraft: sceneDraft ? { action: sceneDraft.attempt.action,
            change: sceneDraft.development.change, response: sceneDraft.development.response } : undefined, proposal: result,
          expressionBoundary: '若提供sceneDraft，核对表达是否新增或改变骨架的事件、物件、人物边界和后果。骨架是待作者审阅的未来设计，不是执行证据。',
          reviewMode: result.candidates.length ? authorAction ? '作者编辑的方向与可能发展核对' : '三条故事困境的共同目标、阻碍差异和选择因果核对' : '仅补充创作选择，不要求行动、结果或完整因果链' }),
        temperature: 0.1, maxTokens: 1800, diagnosticStage: 'preparation-quality-review',
      }), ['checks', 'issues'])
      const issues = list(audit.issues, 8).map((v, i) => text(v, 500, `issues[${i}]`))
      const checks = list(audit.checks, 5).map(v => {
        const check = object(v, ['criterion', 'passed', 'evidence'])
        if (!preparationQualityCriteria.includes(check.criterion as typeof preparationQualityCriteria[number]) || typeof check.passed !== 'boolean') invalid('内容审阅维度或判断不合法。')
        return { criterion: String(check.criterion), passed: check.passed, evidence: text(check.evidence, 320, `checks[${String(check.criterion)}].evidence`) }
      })
      if (checks.length !== 5 || new Set(checks.map(c => c.criterion)).size !== 5) invalid('内容审阅没有完成全部维度。')
      logPreparationReview('quality', attempt + 1, result.candidates.map(candidate => candidate.id), { checks, issues })
      // Preserve failed dimensions without flooding regeneration with the same
      // critique twice (issues and checks usually describe the same defects).
      if (!issues.length) for (const check of checks.filter(c => !c.passed)) issues.push(`${check.criterion}：${check.evidence}`)
      if (issues.length) throw new PreparationQualityError(issues)
      if (result.candidates.length) {
        const projected = await projectFutureChoices(result.candidates, sources, brief)
        return { ...result, candidates: projected }
      }
      return result
    } catch (error) {
      if (attempt || !(error instanceof AppError) || !['STORY_PREPARATION_INVALID_OUTPUT', 'STORY_PREPARATION_QUALITY_FAILED'].includes(error.code)) throw error
      validationFailure = error instanceof PreparationQualityError ? `内容审阅：${error.issues.join('；')}` : error.message
      if (error instanceof PreparationQualityError && sceneDraft) {
        const revised = await generateSceneDraft({ sources, material, brief, rejectedCandidates, authorAction }, { draft: sceneDraft, issues: error.issues })
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
    if (decision === 'revise' && (!authorAction?.trim() || authorAction.length > 240)) throw new AppError('请填写修改后的行动，最多240字。', 400, 'INVALID_REQUEST')
    if (decision === 'regenerate') p.rejectedCandidates = [...(p.rejectedCandidates ?? []), ...p.candidates]
    const generated = await generatePreparationCandidates(p.sources, p.material, next.brief, p.rejectedCandidates, decision === 'revise' ? authorAction : undefined)
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
    if (Object.keys(c).some(k => !['id','action','possibleResult','futureChoice','resultBasisIds'].includes(k)) || typeof c.id !== 'string' || !acceptedIds.includes(c.id) || !validText(c.action) || !validText(c.possibleResult) || (c.futureChoice !== undefined && c.futureChoice !== '' && !validText(c.futureChoice))) return fail()
    if (c.resultBasisIds !== undefined && (!Array.isArray(c.resultBasisIds) || c.resultBasisIds.some(id => typeof id !== 'string') || new Set(c.resultBasisIds).size !== c.resultBasisIds.length)) return fail()
    return { id: c.id, action: c.action, possibleResult: c.possibleResult, ...(c.futureChoice === undefined ? {} : { futureChoice: c.futureChoice as string }), ...(c.resultBasisIds === undefined ? {} : { resultBasisIds: c.resultBasisIds as string[] }) }
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

/** Only explicitly selected quotations are confirmed material. Raw review
 * includes future actions and must never be imported wholesale as facts. */
export function activePreparationMaterial(p: StoryPreparation): StoryPreparationItem[] {
  const superseded = new Set(p.authorReview?.supersededMaterialIds ?? [])
  return [...p.material.filter(m => !superseded.has(m.id)), ...(p.authorReview?.confirmedQuotes ?? []).map((quote, i) => ({
    id: `author-review-${i + 1}`, role: 'condition' as const, sourceId: 'author-review', quote,
  }))]
}

/** Classification is model work, never a server keyword inference. A missing
 * role can be recovered by selecting existing text without rewriting history. */
async function resolvePreparationGoal(material: StoryPreparationItem[]): Promise<StoryPreparationItem> {
  const classified = material.find(m => m.role === 'goal')
  if (classified) return classified
  const known = material.filter(m => m.role !== 'unknown')
  const output = await requestQwenJson({
    systemPrompt: '核对作者目标分类。输出精确 JSON {goalMaterialId}。只从输入 knownMaterial 中选择明确表达作者人物目标的一项 ID；不改写目标，不以行动候选或可能结果代替目标，不推断人物动机。没有明确目标时返回 goalMaterialId:null。此输出只是原文角色审阅，不是设计接受或执行事实。',
    userPrompt: JSON.stringify({ knownMaterial: known }), temperature: 0.1, maxTokens: 200, diagnosticStage: 'preparation-goal-classification',
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
      // An edited action invalidates its derived possible result. Do not let a
      // client carry the old prediction forward under the new action; the
      // original candidate remains in originalCandidates for audit/history.
      if (revised.action !== original.action && revised.possibleResult === original.possibleResult) {
        throw new AppError('作者改动了行动，但仍沿用旧的可能结果；请重新审阅并明确新的结果或保留未知。', 409, 'STORY_PREPARATION_DERIVED_RESULT_STALE')
      }
      if ((revised.action !== original.action || revised.possibleResult !== original.possibleResult)
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
      if (reviewed.action !== c.action || reviewed.possibleResult !== c.possibleResult) delete merged.causalBridge
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
  const goalMaterial = await resolvePreparationGoal(activeMaterial)
  const output = await requestQwenJson({ systemPrompt: `排列已接受未来行动，不写执行记录。严格输出 JSON {steps:[{kind,title,text,candidateIds,materialIds}],supplements:[{id,kind,text,question,materialIds}]}。
${storyCreativeIntentGuidance(curve.brief, 'curve')} 本阶段只排列和引用已接受的文字；若已选方向没有兑现创作倾向，也不得偷偷重写它。
所选方向的 futureChoice 是作者审阅过的未来故事取舍，只用于理解这条故事可能如何升级；它不是已发生行动，不得仅因出现于候选中就把其中的事件写成核心 steps 或 supplements，也不得要求作者逐回合作出角色选择。
核心 steps 只能引用输入中的逐字已知材料、已接受行动或可能结果；text 必须等于其中一条完整原文，不能改写、拼接或补因果。title 也必须逐字等于相应 text。3 至5段，依序 current-state,trigger,可选 escalation,可选 climax-choice,resolution；简单行动只需三段，不造高潮。current-state 无 candidateIds；其余引用已接受候选。resolution 只展示候选 possibleResult，仍是未来假设，不是已发生。
trigger 的 text 必须逐字等于被引用候选的 action，不能改用材料 quote。resolution 的 text 必须逐字等于该候选的 possibleResult。current-state 和 trigger 的 materialIds 非空；trigger 使用候选 materialIds。resolution 仅在候选 resultBasisIds 非空时引用它们，否则 materialIds=[]；新创作的可能结果仍是已接受的未来设计，不以原目标充当结果证明。materialIds 不可引用已取代材料。
先逐项分配全部已知材料：current-state 的 materialIds 保留初始状态、背景、全局条件和作者保留的可选路径，即使 text 只能展示其中一条原文，其余引用仍记录背景承接；trigger 的引用说明行动依据，resolution 的引用说明假设结果依据。这三种用途不同，保留可选路径不等于冲突，尚未开始是行动前状态而非故障假设，均不应另加 supplements 要求作者再次确认。行动和结果的窄引用域不限制 current-state 引用其他已知背景。全部已知材料必须在 steps 的 materialIds 中由模型显式承接。没有期限是边界，不是阻碍；可兼容条件不是冲突。引用背景或替代路径不表示它是行动前提、结果依据或已执行事件，不得因此改写候选 preconditionIds/resultBasisIds。未知材料不在已知覆盖范围内，不得引用为事实。服务端不会自动补齐遗漏的引用。
新增故障假设、观察步骤、检查标准或条件只能写入独立 supplements，kind=hypothesis|observation|criterion|condition，question 为具体待作者审阅问题，materialIds 只引用现有材料。它们不可成为 steps 或既有行动的前提；即使提出也不阻止独立核心行动生成曲线。没有新增设计就给空数组。引用本身不证明因果，不能暗中增加人物、权限、结果。`, userPrompt: JSON.stringify({ material: activeMaterial, acceptedCandidates: selected, authorReview: p.authorReview ?? null,
  ...(omittedOnFirstAttempt ? { coverageReview: { omittedMaterialIds: omittedOnFirstAttempt, instruction: '上一预览遗漏这些作者材料。重新审阅各节点的背景、约束及保留替代路径；只显式引用实际承接的材料，不改写行动或补因果。无法承接的仍留给作者决定，不伪造覆盖。' } } : {}) }), temperature: 0.2, maxTokens: 2400, diagnosticStage: 'preparation-curve-generation' })
  const r = object(output, ['steps', 'supplements']), kinds = ['current-state','trigger','escalation','climax-choice','resolution'] as const
  const known = new Set(activeMaterial.filter(m => m.role !== 'unknown').map(m => m.id))
  p.supplements = list(r.supplements, 8).map(v => {
    const s = object(v, ['id','kind','text','question','materialIds'])
    if (!['hypothesis','observation','criterion','condition'].includes(String(s.kind))) invalid('新增设计类型不合法。')
    return { id: text(s.id, 80), kind: s.kind as NonNullable<StoryPreparation['supplements']>[number]['kind'], text: text(s.text), question: text(s.question), materialIds: ids(s.materialIds, known), status: 'needs-review' as const }
  })
  unique([...activeMaterial, ...p.candidates, ...p.questions, ...p.supplements])
  const arrangements = list(r.steps, 5).map((v, i) => {
    const s = object(v, ['kind', 'title', 'text', 'candidateIds', 'materialIds'])
    if (!kinds.includes(s.kind as typeof kinds[number])) invalid('曲线阶段不正确。')
    const refs = ids(s.candidateIds, new Set(acceptedIds))
    if ((i === 0 && refs.length) || (i > 0 && !refs.length)) invalid('曲线只能排列已接受的行动结构。')
    const materialRefs = ids(s.materialIds, known)
    if (s.kind === 'resolution') {
      const hasAuthorResultBasis = selected.some(c => refs.includes(c.id) && c.resultBasisIds.length)
      if (hasAuthorResultBasis && !materialRefs.length) invalid('曲线遗漏候选已有的作者结果条件。')
      if (!hasAuthorResultBasis && materialRefs.length) invalid('系统新创作的结果不能补造作者原文依据。')
    } else if (!materialRefs.length) invalid('曲线文案缺少已知材料引用；服务端不补依据。')
    const content = text(s.text)
    const allowedTexts = s.kind === 'current-state' ? activeMaterial.filter(m => materialRefs.includes(m.id)).map(m => m.quote)
      : selected.filter(c => refs.includes(c.id)).map(c => s.kind === 'resolution' ? c.possibleResult : c.action)
    if (!allowedTexts.includes(content) || s.title !== content) invalid('核心曲线夹带未审新增设计；只能逐字展示有效材料或已接受行动及可能结果。')
    return { kind: s.kind as typeof kinds[number], title: content, text: content, refs, materialRefs }
  })
  if (arrangements.length < 3 || arrangements[0]?.kind !== 'current-state' || arrangements[1]?.kind !== 'trigger' || arrangements.at(-1)?.kind !== 'resolution'
    || arrangements.some((s, i) => i > 0 && kinds.indexOf(s.kind) <= kinds.indexOf(arrangements[i-1]!.kind))
    || selected.some(c => !arrangements.some(s => s.refs.includes(c.id)))) invalid('曲线遗漏已接受结构或阶段顺序不正确。')
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
