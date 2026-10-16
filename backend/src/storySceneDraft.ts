import { AppError, requestQwenJson } from './qwen.js'
import { sceneOutputSchemas as schemas } from './storyOutputSchemas.js'
import { hasProposalProtocolLeak } from './storyProposalProse.js'
import { storyDevelopmentGuidance, storyDevelopmentRepairGuidance, storySemanticReviewGuidance } from './storySemanticReview.js'
import { storyCreativeFocusGuidance } from './storyCreativeIntent.js'
import type { StoryPreparation, StoryPreparationCandidate, StoryPreparationItem, StoryCreativeFocus } from '../../shared/story-preparation.js'
import type { CreativeBrief } from '../../shared/story-contract.js'

type SceneInput = {
  sources: StoryPreparation['sources']; material: StoryPreparationItem[]; brief: CreativeBrief
  rejectedCandidates: StoryPreparationCandidate[]; authorAction?: string
  creativeFocus?: StoryCreativeFocus
}
export type SceneAttempt = { action: string; materialIds: string[]; preconditionIds: string[] }
export type SceneDevelopment = { change: string; response: string; resultBasisIds: string[] }
export type SceneIntent = { goal: string; tension: string; focusIds: string[] }
export type SceneDraft = { attempt: SceneAttempt; development: SceneDevelopment; intent: SceneIntent }
export type SceneQuestions = { questions: StoryPreparation['questions'] }
const fail = (message: string): never => { throw new AppError(message, 502, 'STORY_PREPARATION_INVALID_OUTPUT') }
async function requestStep<T>(options: Parameters<typeof requestQwenJson>[0], parse: (value: unknown) => T): Promise<T> {
  const output = await requestQwenJson(options)
  try { return parse(output) } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'STORY_PREPARATION_INVALID_OUTPUT') throw error
    // Repair only this step's shape, not the entire story; never a fallback.
    const input = JSON.parse(options.userPrompt)
    return parse(await requestQwenJson({ ...options, diagnosticStage: `${options.diagnosticStage}-repair`,
      userPrompt: JSON.stringify({ ...input, previousOutput: output, validationFailure: error.message }), temperature: 0.1 }))
  }
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('场景骨架缺失。')
  const r = value as Record<string, unknown>
  if (Object.keys(r).length !== keys.length || keys.some(k => !(k in r))) fail('场景骨架字段不符合当前步骤。')
  return r
}
function prose(value: unknown, input: SceneInput, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail(`场景骨架应为1至${max}字。`)
  if (hasProposalProtocolLeak(value, input.sources.map(s => s.text))) fail('场景骨架不能夹带内部字段或材料ID。')
  return value
}
function refs(value: unknown, input: SceneInput): string[] {
  // A promise may be classified as goal while also constraining the scene.
  // Classification alone must not exclude an author's explicit condition.
  const allowed = input.material.filter(m => m.role !== 'unknown').map(m => m.id)
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !allowed.includes(id))
      || new Set(value).size !== value.length) return fail('场景骨架只能引用相应的作者已知材料，不能把未知或新设计当依据。')
  return value as string[]
}
export function parseSceneAttempt(value: unknown, input: SceneInput): SceneAttempt {
  const r = record(value, input.authorAction ? ['materialIds', 'preconditionIds'] : ['action', 'materialIds', 'preconditionIds'])
  const action = input.authorAction ?? prose(r.action, input, 120)
  const materialIds = refs(r.materialIds, input), preconditionIds = refs(r.preconditionIds, input)
  if (!materialIds.length) fail('具体尝试缺少原文起点。')
  if (input.rejectedCandidates.some(c => c.action === action || c.action === `提议：${action}`)) fail('尝试不能重复被拒绝的行动。')
  return { action, materialIds, preconditionIds }
}
export function parseSceneDevelopment(value: unknown, input: SceneInput): SceneDevelopment {
  const r = record(value, ['change', 'response', 'resultBasisIds'])
  const resultBasisIds = refs(r.resultBasisIds, input)
  if (!resultBasisIds.length) fail('变化和回应缺少作者依据。')
  return { change: prose(r.change, input, 110), response: prose(r.response, input, 110), resultBasisIds }
}

function parseAttemptStep(output: unknown, input: SceneInput): SceneAttempt | SceneQuestions {
  if (!output || typeof output !== 'object' || !('questions' in output)) return parseSceneAttempt(output, input)
  const r = record(output, ['questions'])
  if (!Array.isArray(r.questions) || r.questions.length !== 1) fail('只问一个必要的创作问题。')
  const q = record((r.questions as unknown[])[0], ['id', 'question', 'materialIds'])
  const unknownIds = input.material.filter(m => m.role === 'unknown').map(m => m.id)
  if (!Array.isArray(q.materialIds) || !q.materialIds.length || q.materialIds.some(id => !unknownIds.includes(String(id)))
      || new Set(q.materialIds).size !== q.materialIds.length) fail('补充问题必须对应作者明确保留的未知，不追问新增设定。')
  return { questions: [{ id: prose(q.id, input, 80), question: prose(q.question, input, 240), materialIds: q.materialIds as string[] }] }
}

type DraftIssue = { part: 'attempt' | 'development'; evidence: string }
export function parseSceneReview(value: unknown): DraftIssue[] {
  const r = record(value, ['checks', 'issues'])
  const criteria = ['boundaries', 'causality', 'state', 'scope']
  if (!Array.isArray(r.checks) || r.checks.length !== criteria.length || !Array.isArray(r.issues) || r.issues.length > 4) fail('骨架审阅不完整。')
  const checks = (r.checks as unknown[]).map(v => {
    const c = record(v, ['criterion', 'passed', 'evidence'])
    if (!criteria.includes(String(c.criterion)) || typeof c.passed !== 'boolean'
        || typeof c.evidence !== 'string' || !c.evidence.trim() || c.evidence.length > 240) fail('骨架审阅维度不合法。')
    return c
  })
  if (new Set(checks.map(c => c.criterion)).size !== criteria.length) fail('骨架审阅维度遗漏或重复。')
  const issues = (r.issues as unknown[]).map(v => {
    const issue = record(v, ['part', 'evidence'])
    if (!['attempt', 'development'].includes(String(issue.part)) || typeof issue.evidence !== 'string'
        || !issue.evidence.trim() || issue.evidence.length > 240) fail('骨架修复必须定位尝试或发展及具体问题。')
    return issue as DraftIssue
  })
  if (checks.some(c => !c.passed) && !issues.length) fail('未通过的骨架审阅必须指出局部修复位置，不能当成通过。')
  if (checks.every(c => c.passed) && issues.length) fail('审阅各项均通过却仍列出内容缺陷。请只重审原骨架，使checks和issues一致；不改写故事，也不为保留问题列表编造失败项。')
  return issues
}

const intentPrompt = `理解故事任务：只整理作者目标与共同困境，不写角色行动或情节。输出JSON {goal,tension,focusIds}。
goal：人物想完成什么，最多160字；多个相关人物的愿望不可缩成只剩一人的任务。tension：已有事实、资源、期限、承诺或关系怎样让任务有意思，最多160字；原文没有阻力时可以写“尚未指定阻力”，不能编造故障。focusIds：本场景要推进的已知原文片段ID，至少一项。
authorGoals与authorConstraints由程序保留，整理不能改写它们。作者编辑属于未来设计，不是执行结果；有authorAction时围绕该行动理解目的，不能把人物退回准备它的状态。
样例：两位室友都要搬走，只有一辆手推车且不能遗失各自纪念物，目标是让两人完成搬离，困境是有限运力怎样兼顾两人；不能缩成“给箱子贴装饰”。样例只示范理解方法，不能复制人物与道具。
若作者明确保留的关键未知使独立提案无法构思，只输出JSON {questions:[{id,question,materialIds}]}；一个容易回答的创作问题，materialIds只引用unknown。不要询问新增虚构的现实许可。`
const scenePrompt = `完整小场景构思：围绕intent及作者完整原文，一起设计人物尝试、直接变化和具体回应，不先锁定一个动作再补后果。
${storyDevelopmentGuidance}
authorRequirements分别给出已定设定、明确边界、发展期望和作者未知；authorUnknownContexts给出未知片段所在的完整原句，用来识别“暂不选”指向的对象，不表示整句每个事实都未知。原文条件同样有效。先在这些边界内选择行动，再写正文。不要通过换名称、换物件部位或改为间接操作绕过禁止。人物可以请求协作，但不能替别人决定删改来规避自己的承诺；别人自主改变不等于作者授权修改原始要求。没有要求时不要自造禁止或强制条件。
输出JSON {attempt:{action,materialIds,preconditionIds},development:{change,response,resultBasisIds}}。不要输出进度、目标完成状态或证明方案有效的分析。
action最多120字，change与response各最多110字；写能演出来的一次尝试→直接变化或人物回应→针对变化的下一动作。正文里体现如何兼顾相关人物、期限、承诺和否定，不必当场解决全部问题；暂未解决的目标不能写成已达成。期望的发展不等于已发生的结果，也不能替代人物当前目标。
创意来自原有愿望、对象和关系的组合；短想法允许增加可拒绝的日常互动，不要固定成物件故障。authorRequirements.directionPreferences 是最终故事要兑现的作者要求，不是气氛建议，也不是已经发生的事实。本次尝试和回应应给出走向这些要求的具体因果台阶；不要求在一个场景内完成结局，也不能只复述要求或写一句保证。若当前作者行动与要求明显冲突，不要偷偷改写行动或假称已兑现。保留brief风格与命名权限。未知仍未知；人物可提出新办法、与他人自愿约定、承担有来由的时间压力，或询问可信的日常服务；不因作者没写流程就禁止创作。但新增规则、设备能力或机构配合若决定结果，须符合故事世界并交代关键条件，不能把询问写成已获批准，或靠不可信的特权直接完成目标。作者明确设定的架空规则照常承接。引用只用knownMaterialIds，不证明新增发展已发生。
先想人物能普通地做什么，以及别人可以怎样回应，再写场景。意外可以在人物行动之外发生，但人物应在当前情境中有机会发现它；意外带出选择后，要写人物的尝试怎样改变处境，不靠连续空降新麻烦或奇怪物理装置自动解决旧问题。资源不足时可以请求协助、改变分配或表现方式，保留下一步；不要靠增加新约束解释旧问题，不把普通动作包装为“系统”“协同机制”等抽象概念。原文明确物件在别人手里且对方不肯交时，其他人物不能直接拿、移动或放下它；必须先写出持有人自愿移交。每件物品的名称、位置和用途保持一致；宣传单不能无交代地变成入场票。
有authorAction时attempt不能输出action，程序保留作者原文；一起构思后果与回应，不改变作者已给的道具和位置。局部修复若只有development问题，attempt必须完整保持；若attempt有问题，可一起改动其后果。
跨题材示范：想找人一起玩，尝试邀请对方玩同一个游戏→对方提出不同玩法→人物把两种玩法组合，推动共同参与。赶期限送物，尝试改变携带或路线→遇到具体取舍→采取仍服务于送达的补救。合作边界冲突，尝试给对方实际选择权→对方选择→按选择调整自己的配合，而非再次替对方分配。示范是因果方法，不照搬情节。`
const reviewPrompt = `独立核对短场景骨架，不润色，不续写。输出精确JSON {checks:[{criterion,passed,evidence}],issues:[{part,evidence}]}。
${storySemanticReviewGuidance}
checks四项criterion恰好为boundaries,causality,state,scope。passed布尔值，evidence引用骨架具体措辞说明判断，不超过240字。issues最多4项，part只能是attempt或development，定位错误所在步骤并引用具体措辞。未通过必须有issue；没实质错误issues=[]。
boundaries：逐项对照authorRequirements与原文。directionPreferences 是最终故事的创作要求：检查骨架是否与之相容，并有具体可发展的因果台阶；不要求单场景提前完成结局，不能把愿望当成已发生事实，也不能以相同题材或一句承诺代替承接。authorUnknownContexts只是完整原句，用于判断未知指向的对象；原句中的独立已知事实仍有效。禁止动作不能通过改名称、只触碰组成部分或替别人决定来规避。依据实际动作判断，不因对白声称“没有改动”就通过。保留作者目标、期限、否定和人物边界，不确定明确未知，不复用拒绝机制，编辑动作完全保留，命名权限遵守。
causality：在evidence里写原目标是什么、回应具体怎样改变实现路径或引出有代价的目标转变。意外不必由上一步行动造成，也不必提前预告；但人物须有机会发现它，意外应带出选择，之后的变化要主要来自人物尝试或可理解的回应，而非再空降无关麻烦或巧合。尝试→变化→具体回应是否相连，让原愿望、风险或关系继续影响取舍？请求引来对方回应、临时合作、失败后调整或为更在意的事放弃原打算都可以成立，无需必然反应，也无需开场就完成目标或解决全部矛盾。只缺精细动作描写不能判失败；问题是无关线索、象征替代或把任务退回“要想办法”。
state：从作者已定设定开始，按attempt→change→response核对物件位置、持有人、时间和知识变化。没有交代转移，不能把手里的物件写成从别处取出。不用额外假设替骨架圆场，不要求现实证明虚构；未完成的目标可以继续发展，不能说已验证或达成。只能依据正文事件判断，不能用引用ID或构思意图证明条件满足。
scope：判断新增设定与关键结果是否可信，不按“作者是否逐项提供”一刀切。人物提议、自愿约定、有来由的期限，以及符合故事世界常识的日常服务都可创作；遗失门票后询问能否补票可以通过。若结果依赖机构批准、特殊设备能力或他人配合，核对正文是否给出足以理解的条件与回应；不能把“询问”直接写成“已获批准”。默认现实游乐园无合理设定却要求首次入园必须先玩旋转木马，或凭拼贴假票获得闭园后游玩资格，不能通过。保留作者明确设定的架空规则。未来发展尚未执行，不为了显得严格而新增限制。`

export function sceneAuthorRequirements(input: SceneInput) {
  const quotes = (sourceId: string) => input.material.filter(m => m.sourceId === sourceId && m.role !== 'unknown').map(m => m.quote)
  const unknownContexts = input.material.filter(m => m.role === 'unknown').map(m => {
    const source = input.sources.find(s => s.id === m.sourceId)?.text ?? m.quote
    const start = source.indexOf(m.quote)
    if (start < 0) return m.quote
    const before = source.slice(0, start), end = start + m.quote.length
    const lastStop = Math.max(...[...before.matchAll(/[。！？；\n]/gu)].map(match => match.index! + match[0].length), 0)
    const nextStop = /[。！？；\n]/u.exec(source.slice(end))
    return source.slice(lastStop, nextStop ? end + nextStop.index + nextStop[0].length : source.length)
  })
  return {
    fixedSettings: input.material.filter(m => m.role === 'fact').map(m => m.quote), mandatoryBoundaries: quotes('author-boundaries'),
    directionPreferences: [...quotes('author-direction'), ...quotes('author-note')],
    otherAuthorConditions: input.material.filter(m => m.role === 'condition' && !['author-direction', 'author-boundaries'].includes(m.sourceId)).map(m => m.quote),
    authorUnknowns: input.material.filter(m => m.role === 'unknown').map(m => m.quote),
    authorUnknownContexts: [...new Set(unknownContexts)],
  }
}

/** Each step has its own contract. Repairs never silently replace author action
 * or previously accepted story facts; all output remains unpublished design. */
export async function generateSceneDraft(input: SceneInput, revision?: { draft: SceneDraft; issues: string[] }): Promise<SceneDraft | SceneQuestions> {
  const context = { ...input, knownMaterialIds: input.material.filter(m => m.role !== 'unknown').map(m => m.id),
    authorGoals: input.material.filter(m => m.role === 'goal'), authorConstraints: input.material.filter(m => m.role === 'condition' && m.sourceId !== 'author-direction'),
    authorRequirements: sceneAuthorRequirements(input) }
  const understood = revision?.draft.intent ?? await requestStep({ systemPrompt: intentPrompt,
    userPrompt: JSON.stringify(context), temperature: 0.1, maxTokens: 1000, diagnosticStage: 'preparation-scene-intent', outputSchema: schemas.intent }, value => {
    if (value && typeof value === 'object' && 'questions' in value) return parseAttemptStep(value, input) as SceneQuestions
    const r = record(value, ['goal', 'tension', 'focusIds']), focusIds = refs(r.focusIds, input)
    if (!focusIds.length) fail('故事理解必须定位原文任务。')
    return { goal: prose(r.goal, input, 160), tension: prose(r.tension, input, 160), focusIds }
  })
  if ('questions' in understood) return understood
  let draft = revision?.draft
  let repair: DraftIssue[] = revision ? [{ part: 'development', evidence: revision.issues.join('；') }] : []
  for (let pass = 0; pass < 2; pass++) {
    const previous = draft
    const preserveAttempt = previous && repair.length > 0 && repair.every(i => i.part === 'development')
    const compositionContext = { ...context, intent: understood, ...(previous ? { previousDraft: previous, repair,
      ...(preserveAttempt ? { fixedAttempt: previous.attempt } : {}) } : {}) }
    draft = await requestStep({ systemPrompt: `${scenePrompt}\n${storyCreativeFocusGuidance}${repair.length ? `\n${storyDevelopmentRepairGuidance}` : ''}`,
      userPrompt: JSON.stringify(compositionContext), temperature: 0.65, maxTokens: 2200,
      diagnosticStage: 'preparation-scene-composition', outputSchema: schemas.composition(!!input.authorAction) }, value => {
      const r = record(value, ['attempt', 'development'])
      const attempt = parseSceneAttempt(r.attempt, input), development = parseSceneDevelopment(r.development, input)
      if (preserveAttempt && JSON.stringify(attempt) !== JSON.stringify(previous!.attempt)) fail('只修复发展时不能更换已保留的尝试或依据。')
      return { attempt, development, intent: understood }
    })
    repair = await requestStep({ systemPrompt: `${reviewPrompt}\n${storyCreativeFocusGuidance}`,
      userPrompt: JSON.stringify({ ...context, draft: { action: draft.attempt.action,
        change: draft.development.change, response: draft.development.response } }),
      temperature: 0.1, maxTokens: 1500, diagnosticStage: 'preparation-scene-review', outputSchema: schemas.review }, parseSceneReview)
    if (!repair.length) return draft
  }
  throw new AppError(`场景骨架内容未通过：${repair.map(i => `${i.part}：${i.evidence}`).join('；')}`, 502, 'STORY_PREPARATION_QUALITY_FAILED')
}
