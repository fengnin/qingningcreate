import { AppError, requestQwenJson } from './qwen.js'
import { shape as s, outputShapeErrors, type OutputSchema } from './modelOutputSchema.js'
import { compileDirectionPlans } from './storyDirectionPlan.js'
import { storySettingScopeGuidance } from './storySettingScope.js'
import type { DirectionLogicPlan } from './storyDirectionLogicReview.js'
import type { StoryPreparation, StoryPreparationCandidate } from '../../shared/story-preparation.js'
import type { CreativeBrief } from '../../shared/story-contract.js'

type Plan = DirectionLogicPlan & { materialIds: string[]; preconditionIds: string[]; resultBasisIds: string[] }
type Issue = { id: string; reason: string }

export function directionCardNamingGuidance(brief?: Pick<CreativeBrief, 'allowSystemNamedCharacters'>): string {
  if (brief?.allowSystemNamedCharacters === true) return '人物命名权限：允许为新增人物提出具体名字，仍须保留作者已提供的人名，不把新增名字说成作者已定设定。'
  return '人物命名权限：当前未允许系统提出具名人物。必须保留作者原文已提供的名字；新增人物只用朋友、同学、工作人员等关系或身份称呼，不得自行起姓名、昵称、英文名或代号。此规则适用于difficulty及每个options.action、options.consequence，不只检查主角；不得给已有但未命名的朋友补名。作者原文已有的姓名、作品名和场所名不因本开关删除。'
}
const verdict = s.enum('supported', 'unsupported', 'uncertain')
const judgment = s.object({ verdict, reason: s.text })
const invalid = (): never => { throw new AppError('方向审阅的编号、分支或判断不完整，请重试审阅。', 502, 'STORY_PREPARATION_INVALID_OUTPUT') }

export const directionCardScopeGuidance = `卡片是人物面临的处境，不是给作者的写作建议。每张只写一个主要阻碍、两个人物确实可以选择的行动，每个后果止于该行动的一项直接机会、损失或代价；允许必要的成功/失败条件，但不继续安排第二轮意外、未来多轮任务或完整结局。不要为了凑字数添加消费优惠、手续、隐藏往事或额外灾难。原文没有人物目标时，围绕原主题暂拟人物处境供作者选择，不把“缺少人物设定”“需要制造反差”等创作难题当成故事阻碍；未提及的内容可暂拟，作者明确保留的未知仍保持开放。
${storySettingScopeGuidance}`

export const directionCardGenerationPrompt = `你是一位中文短篇故事编辑。从作者的想法提出恰好三种简短设计，由作者选择后再展开。程序负责排版，只返回JSON {plans:[{id,difficulty,options:[{action,consequence},{action,consequence}],materialIds,preconditionIds,resultBasisIds}]}。
每卡一个主要阻碍，两种不同应对；difficulty约25至45字，action约10至22字，consequence约15至30字。后果只写这一办法对愿望的直接影响，最多一项直接代价；不能前半句已说清变化，后半句再添加另一项限制、任务或意外。不要写场景、对白、修辞、创作效果解说或完整结局。
先利用已有的人物、关系、场景和愿望构思取舍。未给出的普通情境可以暂拟，少量必要新内容即可；不为简单愿望同时添加精确时刻、制度、资格或后续任务。题材及作者本就指定的时间、技术、规则、数量限制仍须保留并核对，不能为方便取消限制。
原目标以sources/material/mainlineGoals为准：宽泛愿望不擅自锁定唯一版本或地点；各应对可以争取、失败、改期或有动机地放弃，原目标的机会与代价仍在。实际体验不能用凭据、旁观或他人体验冒充完成；允许有作用的合理委托。新设定不得反过来定义作者原本的愿望。
每个办法先核对当前条件是否允许启动，后果只写它实际能改变的事。先请求、等待或约定时保留是否获准及尚未完成；实际回应或执行可以写进办法。明示时间、金额、工具、位置和责任须自洽，不靠新能力、规则豁免或巧合补缺口。合理失败与有风险的尝试仍可成立，不强求成功。
作者已定的事实、否定、期限、关系、结局和要求都保留；明确未知不能当已知或关键解法，未提及不等于禁止创作。brief控制感觉、戏剧力量和命名，新人物未经允许不命名。creativeFocus只是参考，不是额外强制剧情。主题和风格不改标人物目标。
id用d0/d1/d2；引用只选referenceContract对应允许的材料ID，materialIds引用实际承接的原始材料；preconditionIds不拿目标冒充前提，resultBasisIds不拿目标证明结果，新增设计无原文结果依据时为空。rejectedCandidates只用于避开拒绝过的方向。三张卡须有不同主要阻碍，而非换道具改写同一种冲突。本轮若有repairIds，只返回这些id的卡，保留其他卡。`

// Exactly one causal judgment per branch. No repeated mechanism/general
// causality verdict, copied action/outcome, or free-form aggregate issue list.
export const directionCardReviewPrompt = `审查故事提案质量，只审当前三张方向卡，不扩写故事。reviewPlans是本轮需要判断的卡；unchangedPlans是此前通过且文字未变的卡，只用于比较差异，不重新审阅或修改。
先逐分支判断因果，再判断每卡主线、边界和范围，最后比较全组三卡差异。输出简洁JSON，cards每个输入id恰好一次，branches按optionIndex=0、1覆盖两种选择。
branches只负责因果：假设实际执行action，按本卡difficulty与完整consequence核对全部关键断言。analysis先核算明示的时间、金额、数量，再简述行动实际改变和未改变什么，最多100字；不把其他卡条件混入本卡，尤其不能把另一卡时刻、距离、资源或场次当成本卡已给条件。evidenceFields从difficulty/action/consequence选择依据所在字段，程序保留原文，不重抄引用。
判断对象是consequence实际声称的变化，不是人物是否最终成功。主动暂缓→目标延后、放弃→失去机会、失败→仍有困难，都可以是因果成立的设计；不得以“没有完成目标、未解决阻碍、尚未推进”拒绝如实写出这些后果的分支。仅当后果冒称完成、进展或其他无依据变化时才拒绝。
consequence是待核对的声称，不是证明它成立的证据。严格保留原句断言强度：原句直接写“获得许可、完成归还、责任结束”等结果时，不得在analysis自行加“若对方同意、如果成功、可能”来判通过。未来设计本身不等于所有断言都有隐含条件；需要他人决定才能获得的状态，须在action中实际写出回应或在consequence中明确保留条件。仅提出请求、预约或约定，不证明后续必要事件已经完成。
verdict用supported、unsupported或uncertain。unsupported须指出原文具体矛盾或关键作用缺失，不能只说缺细节。请求不等于已获许可，约定未来归还不等于保管责任已经终止；无条件成功不能靠审阅者补出批准、资源或能力来成立。反过来，已经写出实际执行或合理回应、条件、可能失败的尝试可以成立，不强求保证成功。普通购票、使用工具、沟通或委托允许省略常规细节，不要求证明影院明天营业、所有交通无事故或每个操作成功。明确数字不足不能被“可能”掩盖。条件统领其后的同组结果，不割裂条件句。无法作出有依据判断时uncertain，不猜测新规则。
mainline只负责主线：原目标与明确限制仅来自sources/material/mainlineGoals，提案不得反过来锁定作者没有指定的影片、地点或办理方式。合理同类实现、改期、失败或有动机放弃可成立，不把凭据、旁观或他人体验冒充原目标完成。没有预设人物目标时检查与原主题相容，不因目标未定追问作者。
boundaries只负责作者已定事实、要求、否定和明确保留的未知；新情境不是已发生事实，新人物或规则作为提案不因作者未提供就判错；命名服从brief开关。参考authorRequirements，不额外发明作者要求。
scope只负责是否仍是一个主要阻碍、两种人物行动和直接后果，不写作者创作任务或连串后续剧情。合理回应、必要条件、同一变化的直接代价不算第二轮剧情；不要为文风、精彩程度、没有成长反转而拒绝。
mainline/boundaries/scope各给verdict和reason，通过时reason简写为“相容”，失败时只指出具体问题，不给新剧情。scope还核对新增设定是否造成额外独立任务或不必要限制，按下述新增设定原则判断，不按人物、道具或数字的数量机械拒绝。branches因果判断不在其他维度重复判定。
diversity比较reviewPlans与unchangedPlans的整体：互斥备选，不比较成前后时间线；只有实质重复才拒绝。repairIds只从本轮reviewPlans选最少需修改的卡，保留其他卡。通过时repairIds=[]、reason="不同阻碍"；失败须有非空repairIds和具体重复理由。ignoreDiversity=true是固定对照样本，跳过差异要求。不要输出独立issues或再次给总评因果。
${storySettingScopeGuidance}`

export function directionCardReviewSchema(ids: string[]): OutputSchema {
  return s.object({ cards: s.array(s.object({ id: s.enum(...ids),
    branches: s.array(s.object({ optionIndex: s.enum(0, 1), analysis: s.text,
      evidenceFields: s.array(s.enum('difficulty', 'action', 'consequence'), 1, 3), verdict }), 2, 2),
    mainline: judgment, boundaries: judgment, scope: judgment,
  }), ids.length, ids.length), diversity: s.object({ passed: s.bool, repairIds: s.array(s.enum(...ids), 0, ids.length), reason: s.text }) })
}

export function parseDirectionCardReview(raw: unknown, plans: DirectionLogicPlan[]): Issue[] {
  if (outputShapeErrors(raw, directionCardReviewSchema(plans.map(p => p.id))).length) return invalid()
  const audit = raw as { cards: { id: string; branches: { optionIndex: number; analysis: string; evidenceFields: string[]; verdict: string }[];
    mainline: { verdict: string; reason: string }; boundaries: { verdict: string; reason: string }; scope: { verdict: string; reason: string } }[];
    diversity: { passed: boolean; repairIds: string[]; reason: string } }
  if (new Set(audit.cards.map(c => c.id)).size !== plans.length) return invalid()
  const issues: Issue[] = []
  const bounded = (text: string) => !!text.trim() && text.length <= 300
  for (const card of audit.cards) {
    const plan = plans.find(p => p.id === card.id)!
    for (const [i, branch] of card.branches.entries()) {
      if (branch.optionIndex !== i || !bounded(branch.analysis) || new Set(branch.evidenceFields).size !== branch.evidenceFields.length) return invalid()
      if (branch.verdict !== 'supported') {
        const option = plan.options[i]!
        const evidence = branch.evidenceFields.map(field => field === 'difficulty' ? plan.difficulty : option[field as 'action' | 'consequence'])
        issues.push({ id: card.id, reason: `分支${i + 1} 因果${branch.verdict === 'uncertain' ? '依据不足' : '不成立'}：${branch.analysis}；原文：${evidence.join(' / ')}` })
      }
    }
    for (const [key, label] of [['mainline', '主线'], ['boundaries', '作者边界'], ['scope', '卡片范围']] as const) {
      if (!bounded(card[key].reason)) return invalid()
      if (card[key].verdict !== 'supported') issues.push({ id: card.id, reason: `${label}：${card[key].reason}` })
    }
  }
  const d = audit.diversity
  if (!bounded(d.reason) || new Set(d.repairIds).size !== d.repairIds.length || d.passed !== (d.repairIds.length === 0)) return invalid()
  for (const id of d.repairIds) issues.push({ id, reason: `方向重复：${d.reason}` })
  return issues
}

export function directionPlanSubsetSchema(ids?: string[]): OutputSchema {
  const refs = s.array(s.text)
  return s.object({ plans: s.array(s.object({ id: ids ? s.enum(...ids) : s.text, difficulty: s.text,
    options: s.array(s.object({ action: s.text, consequence: s.text }), 2, 2),
    materialIds: refs, preconditionIds: refs, resultBasisIds: refs,
  }), ids?.length ?? 3, ids?.length ?? 3) })
}

function discardUnsupportedPreconditionReferences(value: unknown, allowedIds: string[], knownIds: string[]): unknown {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { plans?: unknown }).plans)) return value
  const allowed = new Set(allowedIds)
  const known = new Set(knownIds)
  return { ...(value as Record<string, unknown>), plans: (value as { plans: unknown[] }).plans.map(plan => {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return plan
    const candidate = plan as Record<string, unknown>
    return { ...candidate, preconditionIds: Array.isArray(candidate.preconditionIds)
      ? candidate.preconditionIds.filter(id => typeof id !== 'string' || allowed.has(id) || !known.has(id)) : candidate.preconditionIds }
  }) }
}

type Request = <T>(options: Parameters<typeof requestQwenJson>[0], parse: (raw: unknown) => T | Promise<T>) => Promise<T>
export async function generateDirectionCards(options: {
  input: Record<string, unknown> & { brief?: Pick<CreativeBrief, 'allowSystemNamedCharacters'> }; prompt: string;
  request: Request; compress: (raw: unknown) => Promise<unknown>;
  parse: (raw: unknown) => Pick<StoryPreparation, 'candidates' | 'questions'>;
  onCandidatesGenerated?: () => void;
}): Promise<Pick<StoryPreparation, 'candidates' | 'questions'>> {
  let plans: Plan[] = [], candidates: StoryPreparationCandidate[] = [], issues: Issue[] = []
  let pendingIds: string[] | undefined
  const namingGuidance = directionCardNamingGuidance(options.input.brief)
  for (let attempt = 0; attempt < 2; attempt++) {
    const replacements = await options.request({
      systemPrompt: `${options.prompt}\n${directionCardScopeGuidance}\n${namingGuidance}${pendingIds ? '\n本轮只修复repairIds中的卡，保持id不变；不得输出或改写其余卡。每卡必须仍有一个阻碍、两种行动及直接后果。' : ''}`,
      userPrompt: JSON.stringify({ ...options.input, ...(pendingIds ? { repairIds: pendingIds,
        repairPlans: plans.filter(p => pendingIds!.includes(p.id)),
        previousOutput: { plans: plans.filter(p => pendingIds!.includes(p.id)) },
        unchangedPlans: plans.filter(p => !pendingIds!.includes(p.id)),
        validationFailure: `内容审阅：${issues.map(i => `${i.id} ${i.reason}`).join('；')}` } : {}) }),
      temperature: attempt ? 0.25 : 0.45, maxTokens: pendingIds ? 300 + pendingIds.length * 800 : 2700,
      diagnosticStage: 'preparation-directions', outputSchema: directionPlanSubsetSchema(pendingIds),
    }, raw => {
      if (outputShapeErrors(raw, directionPlanSubsetSchema(pendingIds)).length) return invalid()
      const batch = (raw as { plans: Plan[] }).plans
      if (new Set(batch.map(p => p.id)).size !== batch.length) return invalid()
      return batch
    })
    const compressed = await options.compress({ plans: replacements }) as { plans: Plan[] }
    const referenceContract = options.input.referenceContract as { preconditionMaterialIds?: unknown; knownMaterialIds?: unknown } | undefined
    const allowedPreconditions = Array.isArray(referenceContract?.preconditionMaterialIds)
      ? referenceContract.preconditionMaterialIds.filter((id): id is string => typeof id === 'string') : []
    const knownIds = Array.isArray(referenceContract?.knownMaterialIds)
      ? referenceContract.knownMaterialIds.filter((id): id is string => typeof id === 'string') : []
    const grounded = discardUnsupportedPreconditionReferences(compressed, allowedPreconditions, knownIds) as { plans: Plan[] }
    const parsed = options.parse(compileDirectionPlans(grounded, replacements.length))
    if (parsed.questions.length || parsed.candidates.some(c => c.unknownIds.length)) return invalid()
    if (!pendingIds) { plans = grounded.plans; candidates = parsed.candidates }
    else {
      const byId = new Map(grounded.plans.map(p => [p.id, p]))
      const cards = new Map(parsed.candidates.map(c => [c.id, c]))
      plans = plans.map(p => byId.get(p.id) ?? p)
      candidates = candidates.map(c => cards.get(c.id) ?? c)
    }
    const changedIds = grounded.plans.map(p => p.id)
    if (attempt === 0) options.onCandidatesGenerated?.()
    const reviewPlans = plans.filter(p => changedIds.includes(p.id))
    issues = await options.request({ systemPrompt: `${directionCardReviewPrompt}\n${namingGuidance}\n命名审阅必须对照sources识别人名来源，卡片自己生成的名字不是作者授权；未经允许给新人物起名时，将该卡boundaries判为unsupported，reason指出新增名字及命名权限冲突。允许增加未具名的人物，不因人物未出现在原文就拒绝；作品名和场所名不当作人物姓名。`,
      userPrompt: JSON.stringify({ ...options.input, reviewPlans, unchangedPlans: plans.filter(p => !changedIds.includes(p.id)) }),
      temperature: 0.1, maxTokens: 400 + reviewPlans.length * 600,
      diagnosticStage: 'preparation-direction-card-review', outputSchema: directionCardReviewSchema(changedIds),
    }, raw => parseDirectionCardReview(raw, reviewPlans))
    if (process.env.STORY_PREPARATION_DIAGNOSTICS === 'true') console.warn('[preparation] direction-card-review', JSON.stringify({ attempt: attempt + 1, reviewedIds: changedIds, issues }))
    if (!issues.length) return { candidates, questions: [] }
    pendingIds = plans.filter(p => issues.some(issue => issue.id === p.id)).map(p => p.id)
  }
  throw new AppError('方向卡仍有内容问题，请重试生成；尚未进入故事设计。', 502, 'STORY_PREPARATION_QUALITY_FAILED', undefined, undefined, undefined,
    { stage: 'preparation-directions:content-review', attempt: 2, maxAttempts: 2, reason: 'content-review-rejected' })
}
