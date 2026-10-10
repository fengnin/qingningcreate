import { randomUUID } from 'node:crypto'
import { getClarificationGroundingFacts, getClarificationsForBeat, getUnresolvedClarifications, markClarificationsResolved, reviewClarificationReplacement } from './storyClarification.js'
import { AppError, requestQwenJson, summarizeModelResponse, withModelDiagnostic } from './qwen.js'
import {
  createStoryDesignRecord,
  buildStoryCurveFoundation,
  deriveCoveredSourceFactIds,
  ensureStoryDesignRecord,
  getDramaticMechanism,
  getMissingStoryDesignSections,
  getParkedStorySourceFactsUsedByCurve,
  getUnresolvedStorySourceFacts,
  isStoryCurveFoundationCurrent,
  setStorySourceFactDisposition,
  updateStoryDesignCoverage,
} from './storyDesign.js'
import type {
  AuthorInstruction,
  ConfirmedCurve,
  CreativeBrief,
  CreativeTone,
  CurveBeat,
  CurveBeatKind,
  CurveGenerationMetadata,
  DramaticForce,
  ProvisionalCurve,
  StoryAction,
  StoryCurveFoundation,
  StoryCurveRegenerationDecision,
  StoryCurveRegenerationPreview,
  StoryCurveRegenerationPreviewItem,
  StoryDesignRecord,
  StoryFact,
  StoryHeadTailOption,
  StoryPredicament,
  StoryPredicamentApproach,
  StorySeed,
  StorySourceFact,
  StoryTransition,
  StoryVariationAxis,
} from '../../shared/story-contract.js'

const maximumCurveBeatLength = 220
const maximumModelCurveBeatLength = 120
const maximumCurveInstructionLength = 180
const maxCurveGenerationAttempts = 3
const curveBeatKinds: readonly CurveBeatKind[] = [
  'current-state',
  'character-tension',
  'trigger',
  'escalation',
  'midpoint-turn',
  'climax-choice',
  'resolution',
]
const requiredConfirmationBeatKinds: readonly CurveBeatKind[] = [
  'current-state',
  'trigger',
  'escalation',
  'climax-choice',
  'resolution',
]
const initialNarrativeBeatKinds: readonly CurveBeatKind[] = [
  'current-state',
  'character-tension',
  'trigger',
  'escalation',
  'midpoint-turn',
]
const creativeTones: readonly CreativeTone[] = [
  'comedy',
  'warm',
  'friendship',
  'romance',
  'growth',
  'mystery',
  'fantasy',
]
const dramaticForces: readonly DramaticForce[] = [
  'misunderstanding',
  'cost',
  'surprise',
  'contrast',
  'relationship-tension',
]

const curveProposalPrefixPattern = /^暂定[：:]/u
// A bare dash is ordinary prose punctuation (for example, a parenthetical
// deadline), not evidence of a scene. Keep action/observation signals separate
// from concrete nouns: an author-confirmed object may be an abstract condition
// ("投影仪今晚要归还"), but the model must not turn it into a scene.
const curveSceneActionSignalPattern = /(?:[“”‘’"']|(?:一阵|这时|随后|紧接着|与此同时)|(?:站在|走向|走进|钻进|翻过|爬上|蹲下|握紧|掀飞|飘向|落在|赶来|喊|广播|打开|播放|拿出|捡起|关机|重启|导出|下载|上传|悬停|手写|黑场|调试|循环))/iu
const curveSceneObservationPattern = /(?:发现|听见|看到)[^，。！？；\n]{0,12}(?:文件|消息|屏幕|设备|短片|录音|纸条|便签|声音|对白|画面)/iu
const curveConcreteObjectPattern = /(?:门票|票务|电子票|纸质票|订单|购票|售票|检票|二维码|身份证|证件|凭证|支付|付款|现金|金额|退款|退票|手环|围栏|检修|铁链|闸机|工作人员|客服|管理员|前台|柜台|服务台|负责人|手机|电话|短信|号码|账号|密码|验证码|网络|邮箱|通讯录|社交账号|U盘|电脑|硬盘|设备|投影仪|相机|录音机|短片|文件|备份|导出|下载|上传|消息|屏幕|便签|展签|纸条|声音|对白|画面|手稿|作品|展板|预约|VIP|快速通行|代排|通道卡)/giu
const curveActionChainPattern = /(?:先[^。！？；\n]{0,28}再|然后|接着|随后|(?:一边|并且)[^。！？；\n]{0,28}(?:走|拿|捡|钻|翻|爬|交|放))/u
const curveSettledOutcomePattern = /(?:最终|终于|真相大白|已经(?:成功|完成|解决|得到|失去|到达|离开))/u
const curveUnestablishedPrecisionPattern = /(?:\d+(?:\.\d+)?\s*(?:%|秒|分钟|小时|天|周|月|年|步|次|米|公里|点(?:钟)?|时|分)|[零〇一二两三四五六七八九十百千万亿半]+\s*(?:%|秒|分钟|小时|天|周|月|年|米|公里|点钟|时|分)|倒数|第(?:\d+|[零〇一二两三四五六七八九十百千万亿半]+)(?:步|次))/gu
const curveLatinPhrasePattern = /\b[A-Za-z]{3,}(?:\s+[A-Za-z]{2,})+\b/g
const curveUnsupportedDetailRules: readonly { label: string; pattern: RegExp }[] = [
  { label: '票务、凭证或支付细节', pattern: /(?:门票|票务|电子票|纸质票|订单|购票|售票|检票|闸机|二维码|身份证|证件|凭证|支付|付款|现金|金额|退款|退票)/gu },
  { label: '设备、通讯或文件操作', pattern: /(?:手机|电话|短信|号码|账号|密码|验证码|网络|邮箱|通讯录|社交账号|U盘|电脑|硬盘|设备|文件|备份|导出|下载|上传|消息|便签|展签)/giu },
  { label: '机构、工作人员或程序流程', pattern: /(?:工作人员|客服|管理员|前台|柜台|服务台|负责人|机构|平台|手续|申请|审批|登记|审核|规则|规定)/gu },
  { label: '未经确认的过去经历或人物意图', pattern: /(?:遗愿|遗嘱|生前|临终|童年|过去经历|历史背景|曾经|当年|旧日心愿|未说出口的愿望)/gu },
  { label: '未经确认的具体人数或永久后果', pattern: /(?:[零〇一二两三四五六七八九十百千万亿]+人|永久|永远|彻底|无法挽回|不可逆)/gu },
]
// A visible source-fact anchor does not authorize a model to attach a new
// value judgement, permission claim, relationship conclusion, or repair action
// to that fact. Keep these patterns deliberately narrow: ordinary causal words
// such as "改变"、"理解"、"关系" and "承担" remain available when they are
// attached to the author's own wording. A matched phrase is allowed only when
// that exact phrase already occurs in the author's material.
const curveUnsupportedSemanticRules: readonly {
  label: string
  pattern: RegExp
  allowEstablishedSubphrase?: boolean
}[] = [
  {
    label: '未经确认的价值、意义或归属结论',
    pattern: /(?:完整性|完整权|完整状态|完整手稿|自我表达|共作意义|共作的意义|作品归属|归属|署名意义|手稿意义)/u,
  },
  {
    label: '未经确认的权限或自主结论',
    pattern: /(?:自主权|决定权|决策权|选择权|控制权|话语权|署名权|提交条件|交稿条件)/u,
  },
  {
    label: '未经确认的关系、承诺或责任结论',
    pattern: /(?:信任与边界|信任边界|承诺边界|承诺的边界|关系边界|共同责任|共同记忆|共同承诺|伙伴关系|合作署名|共同署名|协作方|创作边界|关系裂痕|关系损耗|关系后果|失信于|单方延续|尊重[^，。！？；\n]{0,8}(?:关系|决定|边界))/u,
  },
  {
    label: '未经确认的条件、标准或流程结论',
    pattern: /(?:提交条件|交稿条件|判断标准|资格条件|出版社要求|具体要求|责任边界)/u,
  },
  {
    label: '未经确认的复合意义或关系判断',
    pattern: /(?:改变|重新理解|重新判断|重构|确认|定义|承认)[^，。！？；\n]{0,10}(?:意义|归属|完整性|边界|责任)/u,
    allowEstablishedSubphrase: true,
  },
  {
    label: '未经确认的递归理解或条件结论',
    // A direct author phrase may follow "重新理解". Reject the malformed
    // model pattern where it wraps a desire/question again ("重新理解……要不要…")
    // or turns a generic method/condition into a new fact.
    pattern: /(?:重新理解|重新定义|重新判断)[^，。！？；\n]{0,24}(?:想|是否|要不要|原有安排|旧办法|条件|取舍)/u,
  },
  {
    label: '未经确认的模板化安排结论',
    pattern: /(?:原有安排|旧办法|原计划)[^，。！？；\n]{0,8}(?:的失效|失效|不再足够|不再奏效)/u,
  },
  {
    label: '未经确认的补写、修复或完成操作',
    pattern: /(?:补全|补写|修复|恢复|重建|填补|完善)(?:[^，。！？；\n]{0,10})(?:页|手稿|作品|短片|名字|署名|提交|交稿)/u,
  },
]
const curveFallbackModelErrorCodes = new Set([
  'INVALID_MODEL_OUTPUT',
  'STORY_CURVE_MODEL_VALIDATION_FAILED',
  'QWEN_NOT_CONFIGURED',
  'QWEN_EMPTY_RESPONSE',
  'QWEN_INVALID_JSON',
  'QWEN_INVALID_RESPONSE',
])
const curveModelValidationErrorCodes = new Set([
  'STORY_CURVE_MODEL_VALIDATION_FAILED',
])
const curveModelRetryableErrorCodes = new Set([
  ...curveModelValidationErrorCodes,
  'INVALID_MODEL_OUTPUT',
  'QWEN_EMPTY_RESPONSE',
  'QWEN_INVALID_JSON',
  'QWEN_INVALID_RESPONSE',
])

const creativeToneLabels: Record<CreativeTone, string> = {
  comedy: '搞笑',
  warm: '温暖',
  friendship: '友情',
  romance: '恋爱',
  growth: '成长',
  mystery: '悬疑',
  fantasy: '奇幻',
}

const dramaticForceLabels: Record<DramaticForce, string> = {
  misunderstanding: '误会',
  cost: '代价',
  surprise: '意外',
  contrast: '反差',
  'relationship-tension': '关系拉扯',
}

const variationAxisLabels: Record<StoryVariationAxis, string> = {
  time: '时机',
  resource: '资源',
  relationship: '关系',
  commitment: '承诺',
}

interface FallbackStoryMaterial {
  subject: string
  goal: string
  current: string
  observed: string
  deadline: string
  commitment: string
  decision: string
  /** Facts that were not selected as a primary role. They still need a
   * deliberate home in the curve instead of becoming unresolved noise. */
  remainingFacts: StorySourceFact[]
  factIds: {
    current: string[]
    observed: string[]
    deadline: string[]
    commitment: string[]
    decision: string[]
  }
}

export interface CurveMutationResult {
  curve: ProvisionalCurve
  affectedBeatIds: string[]
}

export interface CurveRegenerationPreviewResult {
  preview: StoryCurveRegenerationPreview
  affectedBeatIds: string[]
}

export interface MaterializedCurveFoundation {
  seed: StorySeed
  predicament: StoryPredicament
  approach: StoryPredicamentApproach
  headTail: StoryHeadTailOption
}

type CurveMutationOverrides = {
  rejectedProposals?: CurveBeat[]
  generation?: CurveGenerationMetadata
}

function assertDraftCurve(curve: ProvisionalCurve): void {
  if (curve.status !== 'draft') {
    throw new AppError('主线已经确认，请从确认前的版本重新编辑。', 409, 'STORY_CURVE_ALREADY_CONFIRMED')
  }
}

function requireCurveBeat(curve: ProvisionalCurve, beatId: string, action: string): CurveBeat {
  const beat = curve.beats.find((candidate) => candidate.id === beatId)
  if (!beat) {
    throw new AppError(`要${action}的曲线节点不存在，请刷新后重试。`, 409, 'STORY_SESSION_CONFLICT')
  }
  return beat
}

function createAuthorInstruction(
  kind: AuthorInstruction['kind'],
  text: string,
  targetBeatId?: string,
): AuthorInstruction {
  return {
    id: `instruction-${randomUUID()}`,
    kind,
    text,
    ...(targetBeatId ? { targetBeatId } : {}),
    createdAt: Date.now(),
  }
}

function markDependentBeatsStale(
  beats: readonly CurveBeat[],
  affectedBeatIds: readonly string[],
  options: { preserveRejected?: boolean } = {},
): CurveBeat[] {
  const affected = new Set(affectedBeatIds)
  return beats.map((beat) => (
    affected.has(beat.id)
      && beat.source !== 'user-input'
      && (!options.preserveRejected || beat.status !== 'rejected')
      ? { ...beat, status: 'stale' as const }
      : beat
  ))
}

function finalizeCurveMutation(
  curve: ProvisionalCurve,
  beats: CurveBeat[],
  instruction: AuthorInstruction,
  overrides: CurveMutationOverrides = {},
): ProvisionalCurve {
  const design = curve.design ? updateStoryDesignCoverage(curve.design, beats) : undefined
  const currentState = beats.find((beat) => beat.kind === 'current-state')
  const foundation = design
    ? buildStoryCurveFoundation(beats, curve.brief, {
      activeSituation: currentState?.detail ?? '',
      lockedGoal: currentState?.source === 'user-edit'
        ? currentState.detail
        : curve.foundation?.preservedGoal
        ?? curve.design?.foundation?.preservedGoal
        ?? null,
    })
    : undefined
  const nextDesign = design && foundation ? { ...design, foundation } : design
  const rejectedProposals = overrides.rejectedProposals ?? curve.rejectedProposals
  const generation = overrides.generation ?? curve.generation
  return {
    ...curve,
    beats,
    ...(nextDesign ? { design: nextDesign } : {}),
    ...(foundation ? { foundation } : {}),
    ...(rejectedProposals ? { rejectedProposals } : {}),
    ...(generation ? { generation } : {}),
    instructions: [...curve.instructions, instruction],
    updatedAt: Date.now(),
  }
}

export function parseCreativeBrief(value: unknown): CreativeBrief {
  if (!isRecord(value)) {
    throw new AppError('创意方向格式不正确，请重新选择。', 400, 'INVALID_REQUEST')
  }
  if (Object.keys(value).some((field) => !['tones', 'dramaticForces', 'allowSystemNamedCharacters', 'note'].includes(field))) {
    throw new AppError('创意方向包含不支持的字段，请重新提交。', 400, 'INVALID_REQUEST')
  }

  const tones = parseEnumList(value.tones, creativeTones, '故事感觉', 2)
  const forces = parseEnumList(value.dramaticForces, dramaticForces, '戏剧力量', 2)
  if (typeof value.allowSystemNamedCharacters !== 'boolean') {
    throw new AppError('请确认是否允许系统新增具名人物。', 400, 'INVALID_REQUEST')
  }

  const note = readOptionalText(value.note, maximumCurveInstructionLength)
  return {
    tones,
    dramaticForces: forces,
    allowSystemNamedCharacters: value.allowSystemNamedCharacters,
    ...(note ? { note } : {}),
  }
}

export async function generateProvisionalCurve(
  idea: string,
  seed: StorySeed,
  brief: CreativeBrief,
  excludedProposalDetails: readonly string[] = [],
): Promise<ProvisionalCurve> {
  const design = createStoryDesignRecord(idea, seed)
  // A rich author premise needs a goal plus two genuinely different pressures
  // before an online model can make a meaningful structural choice. Do this
  // before spending retries so a sparse premise gets an actionable author
  // question instead of a synthetic seven-beat answer.
  if (!isModelDisabled()) {
    const contract = getModelFactRoleCurveContract(design, seed, brief)
    const readinessFailure = getModelFactRoleCurveReadinessFailure(contract)
    if (readinessFailure) {
      throw new AppError(
        `${readinessFailure}请补充一项会让目标停住的具体条件，以及另一项需要承担的期限、承诺、关系或选择。`,
        422,
        'STORY_CURVE_NEEDS_AUTHOR_DETAIL',
        undefined,
        undefined,
        undefined,
        { stage: 'curve-generation-contract', reason: readinessFailure },
      )
    }
  }
  let repairMessage: string | undefined
  let lastFailure: AppError | undefined
  let lastFailureDescription: string | undefined

  for (let attempt = 0; attempt < maxCurveGenerationAttempts; attempt += 1) {
    try {
      const modelOutput = await requestQwenJson({
        systemPrompt: attempt === 0 ? compactCurveGenerationSystemPrompt : compactCurveGenerationRepairSystemPrompt,
        userPrompt: buildCurveGenerationPrompt(idea, seed, brief, design, excludedProposalDetails, repairMessage),
        temperature: attempt === 0 ? 0.35 : attempt === 1 ? 0.18 : 0.08,
        // The model contract is intentionally compact: the server derives the
        // shared foundation only after every beat has passed grounding and
        // causal checks. A smaller response is less likely to drift into a
        // scene or invent a second schema.
        // The contract is five identifiers and one enum. Limiting the answer
        // prevents qwen-plus from ignoring the contract and expanding back
        // into a five-beat prose draft.
        maxTokens: 360,
        diagnosticStage: 'curve-generation',
      })
      return parseModelCurve(modelOutput, idea, seed, brief, design, excludedProposalDetails)
    } catch (error) {
      if (isModelDisabled() && error instanceof AppError && curveFallbackModelErrorCodes.has(error.code)) {
        return createProvisionalCurveFallback(idea, seed, brief, design, excludedProposalDetails)
      }

      if (!(error instanceof AppError)) throw error
      lastFailure = withModelDiagnostic(error, {
        stage: error.modelDiagnostic?.stage ?? 'curve-generation-validation',
        attempt: attempt + 1,
        maxAttempts: maxCurveGenerationAttempts,
        reason: error.modelDiagnostic?.reason ?? error.message,
        response: error.modelDiagnostic?.response,
      })
      // Transport/configuration/auth failures are not repaired by asking the
      // model again. Keep those errors visible; only malformed or rejected
      // model content gets a bounded structural repair attempt.
      if (!curveModelRetryableErrorCodes.has(error.code)) {
        throw error
      }

      lastFailureDescription = describeCurveModelFailure(lastFailure)
      // The author-facing reason may quote the rejected token so the problem
      // is explainable. Do not feed that token back into the model: negative
      // examples are frequently echoed by JSON-capable models. The retry gets
      // a fact-slot repair contract instead.
      repairMessage = buildCurveModelRepairInstruction(lastFailure)
      console.warn(`[curve] model response rejected ${JSON.stringify({
        code: lastFailure.code,
        stage: lastFailure.modelDiagnostic?.stage,
        attempt: attempt + 1,
        maxAttempts: maxCurveGenerationAttempts,
        reason: lastFailure.modelDiagnostic?.reason ?? lastFailure.message,
        response: lastFailure.modelDiagnostic?.response,
      })}`)
    }
  }

  throw new AppError(
    `模型暂定曲线连续 ${maxCurveGenerationAttempts} 次未通过事实与因果校验（${lastFailureDescription ?? '模型没有返回可用结构'}），请重试或先补充作者信息。`,
    502,
    'STORY_CURVE_MODEL_GENERATION_FAILED',
    undefined,
    undefined,
    undefined,
    lastFailure?.modelDiagnostic ?? {
      stage: 'curve-generation-validation',
      attempt: maxCurveGenerationAttempts,
      maxAttempts: maxCurveGenerationAttempts,
    },
  )
}

/**
 * Keep retry instructions actionable without repeating rejected model prose.
 * In particular, a token that triggered a boundary rule must not be supplied
 * as a negative example again, because smaller models often copy it verbatim.
 */
function buildCurveModelRepairInstruction(error: AppError): string {
  const reason = error.modelDiagnostic?.reason ?? error.message
  if (/sourceFactIds|原文锚点/u.test(reason)) {
    return '逐条核对事实 ID：每个节点只列 detail 中逐字出现的作者短语对应的 ID；没有照抄锚点的材料不要列入该节点。'
  }
  if (/重复嵌套锁定目标|模板化因果连接|重复拼接了时间前缀|递归包成理解结论/u.test(reason)) {
    return '每个节点内目标只出现一次；不要把“想、要、在”重新拼进目标，也不要输出“在在、让在、使在、让想、使想”。因果句必须写出主体并直接承接作者锚点。'
  }
  if (/戏剧力量「反差」.*trigger\/escalation/u.test(reason)) {
    return '反差早期节点必须把两个作者锚点组成事实因果句：例如“[条件]让[目标]无法按已确认条件推进”或“[条件]反而让[目标]停住”。不要只写孤立的“原有安排/失效”，不要新增场景。'
  }
  if (/戏剧力量「反差」.*climax-choice\/resolution/u.test(reason)) {
    return '反差后期节点必须把[作者目标]和[作者期限/承诺/关系]写进同一句：例如“[目标]不能再按[条件]继续”或“这次选择调整[目标]在[条件]下的处理方式”。不要写“原有安排失效/不再足够”或“重新理解要不要……”。'
  }
  if (/创意方向|戏剧力量|故事感觉|因果层级/u.test(reason)) {
    return '重写为四个不同因果层级：目标受阻、取舍升级、主动选择、选择后的变化；让所选方向词紧贴对应作者锚点。'
  }
  if (/英文|模板短语/u.test(reason)) {
    return '只使用简体中文，并且每一句都以作者原文中的目标、期限、承诺、关系或对象作为可核对的中心。'
  }
  if (/价值、意义或归属|权限或自主|关系、承诺或责任|条件、标准或流程|复合意义或关系|补写、修复或完成/u.test(reason)) {
    return '删除附着在事实锚点上的新价值、归属、权限、关系、责任或修复结论；只保留作者原文逐字出现的条件和抽象的受阻、取舍、选择、变化。'
  }
  if (/dependsOn|beats|kind|JSON|结构/u.test(reason)) {
    return '只输出规定的五个节点和所要求的 JSON 字段，按固定顺序组织，不增加额外字段。'
  }
  return '删除所有不在作者材料中的断言，只用给出的事实锚点写出抽象的受阻、取舍、选择和变化。'
}

function describeCurveModelFailure(error: AppError): string {
  if (error.code === 'STORY_CURVE_MODEL_VALIDATION_FAILED') {
    const message = error.message
    if (/场景|对白|具体物件/u.test(message)) {
      return `${message}请删除新增的场景动作、连续操作和对白；作者原文中已明确出现的对象、期限、承诺或关系可以作为抽象因果条件保留，但不能扩写出新的动作、回应或结果。`
    }
    if (/精确数值|时限|具体人数|永久|不可逆|倒数/u.test(message)) {
      return `${message}请删除未在原始材料中逐字出现的数字、时刻、人数、倒数和永久后果；只保留抽象的期限、承诺或取舍。`
    }
    if (/戏剧力量「代价」.*climax-choice\/resolution/u.test(message)) {
      return `${message}请让 climax-choice 或 resolution 明确写出一项可审阅的取舍结构，例如“在[作者原文两端]之间选择”“承担[作者原文条件]的代价”或“保留一端、放弃另一端”；至少保留对应作者锚点，不要只写“理解调整”。`
    }
    if (/戏剧力量「代价」.*trigger\/escalation/u.test(message)) {
      return `${message}请让 trigger 或 escalation 明确写出“承担、放弃、失去、保留、取舍”之一，并紧贴对应作者原文锚点；不要只写目标停住。`
    }
    if (/戏剧力量「反差」.*trigger\/escalation/u.test(message)) {
      return `${message}请把 trigger 或 escalation 改成事实因果句，例如“[作者条件]让[作者目标]无法按已确认条件推进”或“[作者条件]反而让[作者目标]停住”。不要只孤立写“原有安排/失效”，不要新增场景。`
    }
    if (/戏剧力量「反差」.*climax-choice\/resolution/u.test(message)) {
      return `${message}请把 climax-choice 或 resolution 改成“[作者目标]不能再按[作者条件]继续”或“这次选择调整[作者目标]在[作者条件]下的处理方式”这类因果句；不要写“原有安排失效/不再足够”或“重新理解要不要……”，不要新增价值、权限或关系结论。`
    }
    if (/创意方向|戏剧力量|故事感觉|因果层级/u.test(message)) {
      return `${message}请只在指定的节点层级使用提示中的抽象方向词，并让每个方向词紧贴原文目标、期限、承诺、关系或对象；方向词不能替代事实，也不能单独凑关键词。`
    }
    if (/过去经历|人物意图|遗愿|遗嘱|生前|童年/u.test(message)) {
      return `${message}请删除所有从亲属、身份或物品推断出的愿望、遗嘱、过去经历和人物意图；只能逐字使用作者提供的目标、期限、承诺、关系或对象，不得把“祖母/父亲/前队友”等身份扩写成未说出的心愿。`
    }
    if (/sourceFactIds/u.test(message)) {
      const factId = message.match(/(source-fact-\d+)/u)?.[1]
      if (factId) {
        return `${message}本次只修复这个节点：除非 detail 逐字包含 ${factId} 对应的作者锚点，否则从该节点的 sourceFactIds 删除 ${factId}；不要用“原有安排、完整性、当前问题”等近义概括冒充锚点。整条曲线仍由 current-state 覆盖全部材料。`
      }
      return `${message}请只使用输入材料给出的 source-fact ID，并让每条材料至少被一个节点引用。`
    }
    if (/dependsOn/u.test(message)) {
      return `${message}请只引用前面已出现的 beat ID，例如 beat-current-state 或 beat-trigger。`
    }
    if (/创意方向|戏剧机制/u.test(message)) {
      return `${message}请在至少两条不同节点中各使用一个明确的方向词（反差：旧办法、局限、反而、失效、原本；成长：改变、重新、承担、选择、理解），并分别推进目标受阻、代价升级、主动选择与变化；不要只换同义词。`
    }
    return message
  }
  if (error.code === 'QWEN_INVALID_JSON' || error.code === 'QWEN_INVALID_RESPONSE' || error.code === 'QWEN_EMPTY_RESPONSE') {
    return '模型没有返回可读取的完整 JSON。'
  }
  return '模型请求没有完成。'
}

export function updateCurveBeat(
  curve: ProvisionalCurve,
  beatId: string,
  detail: string,
): CurveMutationResult {
  const normalizedDetail = normalizeCurveText(detail, '曲线节点内容不能为空。')
  const target = requireCurveBeat(curve, beatId, '编辑')
  if (target?.status === 'rejected') {
    throw new AppError('这条提案已被你拒绝，不能直接恢复。请编辑其他节点，或创建一个新的主线版本。', 409, 'STORY_CURVE_REJECTED_IMMUTABLE')
  }
  assertDraftCurve(curve)

  const affectedBeatIds = getDependentBeatIds(curve.beats, beatId)
  const instruction = createAuthorInstruction('replace', normalizedDetail, beatId)
  const beats = markDependentBeatsStale(curve.beats.map((beat) => {
      if (beat.id === beatId) {
        return {
          ...beat,
          detail: normalizedDetail,
          causalAnchor: compactAuthorMaterial(normalizedDetail),
          source: 'user-edit' as const,
        status: 'edited' as const,
        sourceFactIds: curve.design
          ? deriveCoveredSourceFactIds(curve.design, normalizedDetail, true)
          : beat.sourceFactIds,
      }
    }
    return beat
  }), affectedBeatIds)

  return {
    curve: finalizeCurveMutation(curve, beats, instruction),
    affectedBeatIds,
  }
}

interface GeneratedCurveBeatDetail {
  detail: string
  causalAnchor: string
  usedFallback: boolean
}

async function generateCurveBeatDetail(
  idea: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  target: CurveBeat,
  feedback?: string,
): Promise<GeneratedCurveBeatDetail> {
  const seedWithAuthorEdits = applyCurrentCurveEditToSeed(seed, curve)
  const authorAnchor = getNearestAuthorEditAnchor(curve, target)
  const fallbackDetail = authorAnchor
    ? createAuthorDrivenReplacementDetail(
        target.kind,
        getStorySubject(seedWithAuthorEdits),
        getStoryGoal(seedWithAuthorEdits, seedWithAuthorEdits.activeSituation),
        curve.brief,
        authorAnchor,
      )
    : createReplacementDetail(
        idea,
        target.kind,
        seedWithAuthorEdits,
        curve.brief,
        curve,
        target,
      )
  const fallbackAnchor = authorAnchor
    ? getAuthorDrivenCausalAnchor(target.kind, authorAnchor)
    : getFallbackCausalAnchor(
        target.kind,
        getStorySubject(seedWithAuthorEdits),
        getStoryGoal(seedWithAuthorEdits, seedWithAuthorEdits.activeSituation),
        curve.brief,
        getCausalAnchor(curve, target, getStoryGoal(seedWithAuthorEdits, seedWithAuthorEdits.activeSituation)),
      )

  try {
    const modelOutput = await requestQwenJson({
      systemPrompt: curveBeatRegenerationSystemPrompt,
      userPrompt: buildCurveBeatRegenerationPrompt(idea, seedWithAuthorEdits, curve, target, feedback),
      temperature: 0.68,
      maxTokens: 480,
      diagnosticStage: 'curve-beat-regeneration',
    })
    const modelDetail = parseRegeneratedBeatDetail(
      modelOutput,
      target.kind,
      curve.brief,
      seedWithAuthorEdits,
      curve,
      target,
    )
    if (modelDetail
      && isMeaningfullyDifferentRegeneration(modelDetail, target)
      && (!authorAnchor || hasAuthorCausalReference(modelDetail, target.kind, authorAnchor))) {
      return {
        detail: modelDetail,
        causalAnchor: authorAnchor
          ? getAuthorDrivenCausalAnchor(target.kind, authorAnchor)
          : getFallbackCausalAnchor(
              target.kind,
              getStorySubject(seedWithAuthorEdits),
              getStoryGoal(seedWithAuthorEdits, seedWithAuthorEdits.activeSituation),
              curve.brief,
              getCausalAnchor(curve, target, modelDetail),
            ),
        usedFallback: false,
      }
    }
    throw new AppError(
      '模型重推的曲线节点没有通过事实、因果或差异校验。',
      502,
      'STORY_CURVE_MODEL_VALIDATION_FAILED',
      undefined,
      undefined,
      undefined,
      {
        stage: 'curve-beat-validation',
        reason: !modelDetail
          ? '节点结构、事实锚点或提案边界不合法'
          : '新节点没有形成相对旧节点的有效因果差异',
        response: summarizeModelResponse(modelOutput),
      },
    )
  } catch (error) {
    // Invalid/empty model payloads may use the visible deterministic draft,
    // but configuration, auth, network and timeout failures must reach the
    // author instead of being disguised as a successful regeneration.
    if (!(error instanceof AppError)
      || !isLocalFallbackAllowed()
      || (!curveFallbackModelErrorCodes.has(error.code) && !curveModelValidationErrorCodes.has(error.code))) {
      throw error
    }
  }

  return { detail: fallbackDetail, causalAnchor: fallbackAnchor, usedFallback: true }
}

function getNearestAuthorEditAnchor(curve: ProvisionalCurve, target: CurveBeat): string | undefined {
  const visited = new Set<string>()
  // Carry the nearest live author edit through the whole affected chain. The
  // downstream renderer turns this root handle into a stage-specific
  // consequence, so it never needs to quote an intermediate system sentence.
  const queue = [...target.dependsOn]
  while (queue.length) {
    const beatId = queue.shift()!
    if (visited.has(beatId)) continue
    visited.add(beatId)
    const beat = curve.beats.find((candidate) => candidate.id === beatId)
    if (!beat || beat.status === 'rejected') continue
    if (beat.source === 'user-edit') return compactAuthorMaterial(beat.detail)
    queue.push(...beat.dependsOn)
  }
  return undefined
}

function isMeaningfullyDifferentRegeneration(detail: string, target: CurveBeat): boolean {
  return normalizeCausalText(detail) !== normalizeCausalText(target.detail)
}

function hasAuthorCausalReference(detail: string, kind: CurveBeatKind, authorAnchor: string): boolean {
  const stageAnchor = getAuthorDrivenStageAnchor(kind, authorAnchor)
  const fragments = [
    stageAnchor,
    ...stageAnchor.split(/[，；]/u),
    ...authorAnchor.split(/[，；]/u),
  ]
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= 4)
  return fragments.some((fragment) => detail.includes(fragment))
}

function getAuthorDrivenCausalAnchor(kind: CurveBeatKind, authorAnchor: string): string {
  const stageAnchor = getAuthorDrivenStageAnchor(kind, authorAnchor)
  switch (kind) {
    case 'character-tension': return `${stageAnchor}暴露的矛盾`
    case 'trigger': return `${stageAnchor}带来的限制`
    case 'escalation': return `${stageAnchor}带来的前置条件`
    case 'midpoint-turn': return `${stageAnchor}改变了原办法`
    case 'climax-choice': return `${stageAnchor}`
    case 'resolution': return `${stageAnchor}`
    case 'current-state': return stageAnchor
  }
}

function createAuthorDrivenReplacementDetail(
  kind: CurveBeatKind,
  subject: string,
  goal: string,
  brief: CreativeBrief,
  authorAnchor: string,
): string {
  // The author handle may intentionally contain two short clauses (the
  // decision and its consequence). `shortenCurveContext` would split at the
  // semicolon and discard the consequence, so preserve the compact author
  // handle as-is here.
  const anchor = getAuthorDrivenStageAnchor(kind, authorAnchor)
  const authorParts = parseAuthorCausalParts(authorAnchor)
  const actionChoice = getAuthorActionChoicePhrase(authorParts.action)
  const consequenceChoice = authorParts.consequence || '后续取舍'
  const goalPhrase = getGoalPhrase(goal)
  const goalObject = getGoalObject(goal)
  const toneClause = getToneCausalClause(brief, kind === 'midpoint-turn' ? 'midpoint' : 'trigger')
    .replace(/主角/gu, subject)
  switch (kind) {
    case 'character-tension':
      return `暂定：${subject}原来依赖的办法与“${anchor}”发生冲突；继续${goalPhrase}前，必须重新界定自己愿意承担的部分。`
    case 'trigger':
      return `暂定：“${anchor}”让${subject}不能再把${goalObject}当成照旧执行的安排，原来的办法因此停住；${toneClause}。`
    case 'escalation':
      return `暂定：围绕${authorParts.action}，${subject}继续${goalPhrase}时必须先处理${consequenceChoice}这个取舍；回避会让代价变得具体。`
    case 'midpoint-turn':
      return `暂定：${subject}发现“${anchor}”改变了自己对${goalObject}的判断，旧办法无法同时保留这项决定和目标；${toneClause}。`
    case 'climax-choice':
      return `暂定：${subject}必须面对${actionChoice}与${consequenceChoice}之间的取舍；选择会明确放弃另一项条件，不能由别人代替。`
    case 'resolution':
      return `暂定：${subject}如何承担“${anchor}”带来的责任，会决定${goalPhrase}最终保留什么，并留下可辨认的人物变化。`
    case 'current-state':
      return `暂定：${subject}需要先明确“${anchor}”如何改变${goalPhrase}。`
  }
}

function getAuthorDrivenStageAnchor(kind: CurveBeatKind, authorAnchor: string): string {
  const parts = parseAuthorCausalParts(authorAnchor)
  const action = parts.action
  const consequence = parts.consequence
  switch (kind) {
    case 'escalation':
      // The first downstream beat carries the concrete action object. Later
      // beats derive their own consequence/choice anchors, so no beat has to
      // quote the author's complete instruction.
      return shortenAuthorAnchor(consequence && consequence !== action
        ? `${action}；${consequence}成为下一步取舍`
        : action)
    case 'midpoint-turn':
      return consequence || action
    case 'climax-choice':
      return shortenAuthorAnchor(consequence && consequence !== action
        ? `${getAuthorActionChoicePhrase(action)}与${consequence}之间的取舍`
        : `${getAuthorActionChoicePhrase(action)}带来的取舍`)
    case 'resolution':
      return shortenAuthorAnchor(consequence || action)
    case 'character-tension':
      return action
    case 'trigger':
      return action
    case 'current-state':
      return shortenAuthorAnchor(consequence && consequence !== action
        ? `${action}，${consequence}`
        : action)
  }
}

function getAuthorActionChoicePhrase(action: string): string {
  const normalized = action
    .replace(/已确认的|已经确认的/gu, '')
    .replace(/^(?:要|想|希望|打算|准备)s*/u, '')
    .trim()
  const match = normalized.match(/^(回应|处理|兑现|改变|保留|放弃|坚持|继续|完成|归还|提交|参加|寻找|离开|删掉|删除|修改|承担)(.+)$/u)
  if (!match?.[1] || !match[2]) return normalized
  if (match[1] === '回应') return match[2].trim()
  return `${match[1]}${match[2].trim()}`
}

interface AuthorCausalParts {
  action: string
  consequence: string
}

/**
 * Turn an author-level instruction into two small planner handles. The input
 * often contains a directive wrapper ("让高潮…") and a source-fact clause
 * before it ("投影仪今晚要归还，所以…"). Keeping those wrappers in the
 * handle is what caused downstream proposals to recursively repeat the whole
 * instruction. The exact author text remains in `instructions`; these parts
 * are only for causal propagation.
 */
function parseAuthorCausalParts(value: string): AuthorCausalParts {
  const cleaned = value
    .replace(/^暂定[：:]/u, '')
    .replace(/^(?:作者(?:第一次)?(?:明确)?编辑|作者指令|作者调整)[：:]?/u, '')
    .replace(/^(?:作者(?:希望|要求|想要)|我(?:希望|想要)|请)\s*/u, '')
    .replace(/[“”"']/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  const rawClauses = cleaned
    .split(/[，；。！？\n]/u)
    .map((clause) => clause
      .replace(/^(?:所以|因此|于是|并且|而且|但是|但|却|同时)\s*/u, '')
      .replace(/^(?:先|再|然后|随后)\s*/u, '')
      .trim())
    .filter((clause) => clause.length >= 3)
  const clauses = rawClauses.length ? rawClauses : [cleaned]
  // Prefer the clause that explicitly changes the story (respond, change,
  // keep, drop, etc.). A source-fact clause such as “投影仪今晚要归还”
  // also contains an action verb, but it is context rather than the author's
  // instruction and must not swallow the actual directive that follows it.
  const directedActionIndex = clauses.findIndex((clause) => (
    /(?:让(?:高潮|主角|人物|自己|她|他|其)|回应|处理|兑现|改变|改成|改为|保留|放弃|坚持|删掉|删除|修改)/u.test(clause)
    && !/^(?:决定|选择|是否|要不要|想|希望|为了|证明|准备|打算)/u.test(clause)
  ))
  const actionIndex = directedActionIndex >= 0
    ? directedActionIndex
    : clauses.findIndex((clause) => (
      /(?:继续|完成|归还|提交|参加|寻找|离开|承担)/u.test(clause)
      && !/^(?:决定|选择|是否|要不要|想|希望|为了|证明|准备|打算)/u.test(clause)
    ))
  const selectedActionIndex = actionIndex >= 0 ? actionIndex : 0
  const action = normalizeAuthorActionClause(clauses[selectedActionIndex] ?? cleaned)
  const consequenceClause = clauses
    .slice(selectedActionIndex + 1)
    .find((clause) => /(?:决定|选择|是否|要不要|想|希望|为了|证明|准备|打算|承担|继续)/u.test(clause))
    ?? (clauses.length > 1 ? clauses.at(-1) : undefined)
  const consequence = normalizeAuthorConsequenceClause(consequenceClause ?? '')
  return {
    action: shortenAuthorAnchor(action || cleaned),
    consequence: consequence && consequence !== action ? shortenAuthorAnchor(consequence) : '',
  }
}

function normalizeAuthorActionClause(value: string): string {
  return value
    .replace(/^(?:作者(?:希望|要求|想要)|我(?:希望|想要)|请)\s*/u, '')
    .replace(/^(?:把|将)(?:高潮|主线|这个节点|该节点)(?:改成|改为|调整为)\s*/u, '')
    .replace(/^让(?:高潮|主角|人物|自己|她|他|其|[\u4e00-\u9fff]{1,4})(?=(?:先|再|然后|随后|回应|处理|兑现|改变|保留|放弃|坚持|继续|完成|归还|提交|参加|寻找|离开|删掉|删除|修改|承担))/u, '')
    .replace(/^(?:高潮|主角|人物|自己|她|他|其)(?=(?:先|再|然后|随后|回应|处理|兑现|改变|保留|放弃|坚持|继续|完成|归还|提交|参加|寻找|离开|删掉|删除|修改|承担))/u, '')
    .replace(/^(?:先|再|然后|随后)\s*/u, '')
    .replace(/^(?:是)?(?:要|想|希望|打算|准备)\s*/u, '')
    .trim()
}

function normalizeAuthorConsequenceClause(value: string): string {
  return value
    .replace(/^(?:先|再|然后|随后)\s*/u, '')
    .replace(/^是(?=(?:想|希望|为了|打算|准备|决定|选择))/u, '')
    .replace(/^(?:想|希望|为了|打算|准备|选择)\s*/u, '')
    .replace(/^证明(?:自己)?(?:已经|能够|能)?\s*/u, '')
    .replace(/^决定(?=是否|要不要)/u, '')
    .replace(/^选择(?=是否|要不要)/u, '')
    .trim()
}

function replaceRejectedProposalIfNeeded(
  generated: GeneratedCurveBeatDetail,
  seed: StorySeed,
  curve: ProvisionalCurve,
  target: CurveBeat,
): GeneratedCurveBeatDetail {
  if (!repeatsRejectedProposal(generated.detail, curve)) return generated

  // A replacement is an explicit new proposal, never a resurrection of the
  // wording the author rejected. Keep the fallback deterministic when the
  // model returns the same premise again.
  const alternateBrief = getAlternativeFallbackBrief(curve.brief, [target.detail])
  const relatedFact = curve.design?.sourceFacts.find((fact) => target.sourceFactIds?.includes(fact.id))?.text
    ?? curve.design?.sourceFacts.find((fact) => fact.disposition !== 'parked')?.text
    ?? getStoryGoal(seed, seed.activeSituation)
  let detail = getFallbackDetailForKind(
    target.kind,
    getStorySubject(seed),
    getStoryGoal(seed, seed.activeSituation),
    alternateBrief,
    relatedFact,
  )
  if (repeatsRejectedProposal(detail, curve)) {
    detail = `暂定：${getStorySubject(seed)}需要围绕“${shortenCurveContext(relatedFact)}”重新判断如何继续，具体代价留待作者决定。`
  }
  return {
    detail,
    causalAnchor: getFallbackCausalAnchor(
      target.kind,
      getStorySubject(seed),
      getStoryGoal(seed, seed.activeSituation),
      alternateBrief,
      relatedFact,
    ),
    usedFallback: true,
  }
}

export async function regenerateCurveBeat(
  idea: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  beatId: string,
  feedback?: string,
  replaceRejected = false,
): Promise<CurveMutationResult> {
  const target = requireCurveBeat(curve, beatId, '重推')
  const targetWasRejected = target?.status === 'rejected'
  if (targetWasRejected && !replaceRejected) {
    throw new AppError('这条提案已被你拒绝，不能重新生成。请编辑其他节点，或创建一个新的主线版本。', 409, 'STORY_CURVE_REJECTED_IMMUTABLE')
  }
  assertDraftCurve(curve)
  if (target.source === 'user-input' || target.kind === 'current-state') {
    throw new AppError('当前状态来自你的原始想法，请直接编辑它，不要让系统重写。', 400, 'STORY_CURVE_USER_NODE_REGENERATE_FORBIDDEN')
  }
  if (target.source === 'user-edit') {
    throw new AppError('这条内容是你的作者编辑。请继续编辑它，或先修改上游节点后再决定如何调整，系统不会覆盖它。', 400, 'STORY_CURVE_AUTHOR_NODE_REGENERATE_FORBIDDEN')
  }

  const normalizedFeedback = feedback ? normalizeCurveText(feedback, '重推说明不能为空。') : undefined
  const regenerated = await generateCurveBeatDetail(idea, seed, curve, target, normalizedFeedback)
  const replacement = targetWasRejected
    ? replaceRejectedProposalIfNeeded(regenerated, seed, curve, target)
    : regenerated

  const affectedBeatIds = getDependentBeatIds(curve.beats, beatId)
  const instruction = createAuthorInstruction(
    'regenerate',
    normalizedFeedback ?? '请按当前创意方向重推这个节点。',
    beatId,
  )
  const beats = markDependentBeatsStale(curve.beats.map((beat) => {
      if (beat.id === beatId) {
        return {
          ...beat,
          detail: replacement.detail,
          causalAnchor: replacement.causalAnchor,
        source: 'system-proposal' as const,
        status: 'proposed' as const,
        sourceFactIds: curve.design
          ? deriveReplacementSourceFactIds(curve.design, beat, replacement.detail)
          : beat.sourceFactIds,
      }
    }
    return beat
  }), affectedBeatIds)
  const rejectedProposals = targetWasRejected
    ? [
        ...(curve.rejectedProposals ?? []),
        {
          ...target,
          status: 'rejected' as const,
        },
      ]
    : curve.rejectedProposals

  return {
    curve: finalizeCurveMutation(curve, beats, instruction, {
      rejectedProposals,
      ...(replacement.usedFallback
        ? {
            generation: {
              origin: 'fact-preserving-fallback' as const,
              dramaticMechanism: getDramaticMechanism(curve.brief),
              notice: '系统未能可靠重推这一节点，已保留原始材料并生成可编辑的结构草案。',
            },
          }
        : {}),
    }),
    affectedBeatIds,
  }
}

/**
 * Regeneration changes the wording of a proposal, not the author's source
 * material. Keep the previous trace links and add any new links the revised
 * wording makes explicit; otherwise an author edit can make an unchanged
 * commitment or decision look like an unresolved fact and block confirmation.
 */
function deriveReplacementSourceFactIds(
  design: StoryDesignRecord,
  previous: CurveBeat,
  detail: string,
): string[] {
  return [...new Set([
    ...(previous.sourceFactIds ?? []),
    ...deriveCoveredSourceFactIds(design, detail),
  ])]
}

export function rejectCurveBeat(
  curve: ProvisionalCurve,
  beatId: string,
  reason?: string,
): CurveMutationResult {
  const target = requireCurveBeat(curve, beatId, '不采用')
  assertDraftCurve(curve)
  if (target.source === 'user-input') {
    throw new AppError('这条内容来自你的原始想法，请编辑它或标记为暂不纳入，而不是删除。', 400, 'STORY_CURVE_USER_NODE_REJECT_FORBIDDEN')
  }
  if (target.source !== 'system-proposal') {
    throw new AppError('只有系统提出的内容可以标记为不采用。你的编辑请直接修改或恢复。', 400, 'STORY_CURVE_AUTHOR_NODE_REJECT_FORBIDDEN')
  }

  const affectedBeatIds = getDependentBeatIds(curve.beats, beatId)
  const beats = markDependentBeatsStale(curve.beats.map((beat) => (
    beat.id === beatId ? { ...beat, status: 'rejected' as const } : beat
  )), affectedBeatIds, { preserveRejected: true })
  const instruction = createAuthorInstruction(
    'remove',
    reason?.trim() || `不采用“${target.title}”这条系统提案。`,
    beatId,
  )
  return {
    curve: finalizeCurveMutation(curve, beats, instruction),
    affectedBeatIds,
  }
}

export async function regenerateAffectedCurveBeats(
  idea: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  feedback?: string,
): Promise<CurveMutationResult> {
  assertDraftCurve(curve)
  let nextCurve = curve
  const affectedBeatIds = nextCurve.beats
    .filter((beat) => beat.status === 'stale')
    .map((beat) => beat.id)

  // Batch regeneration is only allowed to replace system proposals. An
  // author-edited downstream node stays visibly stale until the author edits
  // it, rather than being silently overwritten by a convenient re-generation.
  for (const beatId of affectedBeatIds) {
    const beat = nextCurve.beats.find((candidate) => candidate.id === beatId)
    if (!beat || beat.source !== 'system-proposal') continue
    const result = await regenerateCurveBeat(idea, seed, nextCurve, beatId, feedback)
    nextCurve = result.curve
  }

  return { curve: nextCurve, affectedBeatIds }
}

/**
 * Generate replacements into a private working copy. Nothing reaches the
 * author-visible curve until resolveAffectedCurveBeats receives an explicit
 * decision for every item.
 */
export async function previewAffectedCurveBeats(
  idea: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  feedback?: string,
): Promise<CurveRegenerationPreviewResult> {
  assertDraftCurve(curve)
  let working = structuredClone(curve)
  const affectedBeatIds = working.beats
    .filter((beat) => beat.status === 'stale')
    .map((beat) => beat.id)
  const items: StoryCurveRegenerationPreviewItem[] = []

  for (const beatId of affectedBeatIds) {
    const target = working.beats.find((beat) => beat.id === beatId)
    if (!target || target.source !== 'system-proposal') continue
    const blocking = getClarificationsForBeat(working, beatId)
    if (blocking.some((item) => !item.resolution && item.status !== 'confirmed' && item.unknownHandling !== 'request-independent-proposal')) continue
    const previous = structuredClone(target)
    const result = await regenerateCurveBeat(idea, seed, working, beatId, getClarificationFeedback(feedback, blocking))
    working = result.curve
    const proposed = working.beats.find((beat) => beat.id === beatId)
    if (!proposed) continue
    for (const clarification of blocking) await reviewClarificationReplacement(curve, clarification, proposed)
    items.push({
      id: `regen-preview-item-${randomUUID()}`,
      beatId,
      title: target.title,
      kind: target.kind,
      oldDetail: previous.detail,
      newDetail: proposed.detail,
      newSourceFactIds: [...(proposed.sourceFactIds ?? [])],
      ...(proposed.causalAnchor ? { newCausalAnchor: proposed.causalAnchor } : {}),
    })
  }

  return {
    affectedBeatIds,
    preview: {
      id: `regen-preview-${randomUUID()}`,
      curveId: curve.id,
      items,
      ...(working.generation ? { generation: working.generation } : {}),
      createdAt: Date.now(),
    },
  }
}

function getClarificationFeedback(
  feedback: string | undefined,
  clarifications: readonly import('../../shared/story-contract.js').StoryAuthorClarification[],
): string | undefined {
  if (!clarifications.length) return feedback
  return [feedback, '不得依赖未确定前提'].filter(Boolean).join('；').slice(0, maximumCurveInstructionLength)
}

export async function previewClarificationCurveBeat(
  idea: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  beatId: string,
  feedback?: string,
): Promise<CurveRegenerationPreviewResult> {
  const target = requireCurveBeat(curve, beatId, '重推')
  assertDraftCurve(curve)
  if (target.source !== 'system-proposal' || target.status === 'rejected') {
    throw new AppError('只有有效的系统提案可以生成替代预览。', 409, 'STORY_CLARIFICATION_AUTHOR_EDIT')
  }
  const blocking = getClarificationsForBeat(curve, beatId)
  if (!blocking.length || blocking.some((item) => !item.resolution && item.status !== 'confirmed' && item.unknownHandling !== 'request-independent-proposal')) {
    throw new AppError('请先标记未知并选择生成独立提案。', 409, 'STORY_CLARIFICATION_REVIEW_REQUIRED')
  }
  const result = await regenerateCurveBeat(idea, seed, curve, beatId, getClarificationFeedback(feedback, blocking))
  const replacement = result.curve.beats.find((beat) => beat.id === beatId)!
  for (const clarification of blocking) await reviewClarificationReplacement(curve, clarification, replacement)
  return {
    affectedBeatIds: [beatId, ...result.affectedBeatIds],
    preview: {
      id: `regen-preview-${randomUUID()}`,
      curveId: curve.id,
      ...(result.curve.generation ? { generation: result.curve.generation } : {}),
      items: [{
        id: `regen-preview-item-${randomUUID()}`,
        beatId,
        title: target.title,
        kind: target.kind,
        oldDetail: target.detail,
        newDetail: replacement.detail,
        newSourceFactIds: [...(replacement.sourceFactIds ?? [])],
        ...(replacement.causalAnchor ? { newCausalAnchor: replacement.causalAnchor } : {}),
      }],
      createdAt: Date.now(),
    },
  }
}

export function resolveAffectedCurveBeats(
  curve: ProvisionalCurve,
  preview: StoryCurveRegenerationPreview,
  decisions: Record<string, StoryCurveRegenerationDecision>,
): CurveMutationResult {
  assertDraftCurve(curve)
  if (preview.curveId !== curve.id) {
    throw new AppError('批量重推预览不属于当前主线，请刷新后重试。', 409, 'STORY_SESSION_CONFLICT')
  }
  if (!preview.items.length) {
    throw new AppError('没有可供审阅的重推提案。', 400, 'STORY_CURVE_REGENERATION_EMPTY')
  }
  const previewItemIds = new Set(preview.items.map((item) => item.id))
  const decisionIds = Object.keys(decisions)
  if (decisionIds.some((id) => !previewItemIds.has(id))
    || preview.items.some((item) => decisions[item.id] !== 'accept' && decisions[item.id] !== 'reject')) {
    throw new AppError('请逐项接受或拒绝所有重推提案。', 400, 'STORY_CURVE_REGENERATION_DECISIONS_INCOMPLETE')
  }

  const itemByBeatId = new Map(preview.items.map((item) => [item.beatId, item]))
  const acceptedBeatIds = new Set(
    preview.items
      .filter((item) => decisions[item.id] === 'accept')
      .map((item) => item.beatId),
  )
  const rejectedBeatIds = new Set(
    preview.items
      .filter((item) => decisions[item.id] === 'reject')
      .map((item) => item.beatId),
  )
  const rejectedPreviewProposals = preview.items
    .filter((item) => decisions[item.id] === 'reject')
    .map((item): CurveBeat => {
      const original = curve.beats.find((beat) => beat.id === item.beatId)
      return {
        id: `rejected-preview-${randomUUID()}`,
        kind: item.kind,
        title: item.title,
        detail: item.newDetail,
        source: 'system-proposal',
        status: 'rejected',
        dependsOn: [...(original?.dependsOn ?? [])],
        sourceFactIds: [...item.newSourceFactIds],
        ...(item.newCausalAnchor ? { causalAnchor: item.newCausalAnchor } : {}),
      }
    })
  const beats = curve.beats.map((beat) => {
    const item = itemByBeatId.get(beat.id)
    if (!item || decisions[item.id] !== 'accept') return beat
    const blockedByRejectedDependency = beat.dependsOn.some((dependencyId) => {
      if (rejectedBeatIds.has(dependencyId)) return true
      const dependency = curve.beats.find((candidate) => candidate.id === dependencyId)
      return dependency?.status === 'stale' && !acceptedBeatIds.has(dependencyId)
    })
    if (blockedByRejectedDependency) return beat
      return {
        ...beat,
        detail: item.newDetail,
        ...(item.newCausalAnchor ? { causalAnchor: item.newCausalAnchor } : { causalAnchor: compactCausalMaterial(item.newDetail, item.newDetail) }),
      source: 'system-proposal' as const,
      status: 'proposed' as const,
      sourceFactIds: item.newSourceFactIds,
    }
  })
  const instruction = createAuthorInstruction(
    'regenerate',
    '作者逐项审阅了受影响节点的重推提案。',
  )
  const acceptedClarificationBeatIds = [...acceptedBeatIds].filter((beatId) => {
    const original = curve.beats.find((beat) => beat.id === beatId)
    const replacement = beats.find((beat) => beat.id === beatId)
    return original?.detail !== replacement?.detail && replacement?.status === 'proposed'
  })
  return {
    curve: markClarificationsResolved(finalizeCurveMutation(curve, beats, instruction, {
      ...(acceptedClarificationBeatIds.length && preview.generation ? { generation: preview.generation } : {}),
      rejectedProposals: [
        ...(curve.rejectedProposals ?? []),
        ...rejectedPreviewProposals,
      ],
    }), acceptedClarificationBeatIds),
    affectedBeatIds: preview.items.map((item) => item.beatId),
  }
}

export function updateCurveSourceFactDisposition(
  curve: ProvisionalCurve,
  factId: string,
  disposition: 'parked' | 'integrated',
): CurveMutationResult {
  assertDraftCurve(curve)
  const design = ensureStoryDesignRecord(curve.design, curve.title, {
    subject: '',
    activeSituation: '',
    lockedGoal: null,
    lockedFacts: [],
    worldMode: 'realistic-default',
    expansionScope: 'keep-scale',
    unknowns: [],
  })
  const coverageBeforeDisposition = updateStoryDesignCoverage(design, curve.beats)
  const targetBeforeDisposition = coverageBeforeDisposition.sourceFacts.find((fact) => fact.id === factId)
  const updatedDesign = setStorySourceFactDisposition(
    coverageBeforeDisposition,
    factId,
    disposition,
  )
  const affectedBeatIds = getSourceFactAffectedBeatIds(curve, factId, disposition, targetBeforeDisposition)
  const beats = updateBeatsForSourceFactDisposition(curve.beats, factId, disposition, affectedBeatIds)
  const instruction = createAuthorInstruction(
    'park-fact',
    disposition === 'parked' ? '作者明确暂不把这条原始材料纳入当前主线。' : '作者要求把这条原始材料纳入当前主线。',
  )
  return {
    curve: finalizeCurveMutation({ ...curve, design: updatedDesign }, beats, instruction),
    affectedBeatIds,
  }
}

function getSourceFactAffectedBeatIds(
  curve: ProvisionalCurve,
  factId: string,
  disposition: 'parked' | 'integrated',
  previousFact: StoryDesignRecord['sourceFacts'][number] | undefined,
): string[] {
  if (disposition === 'parked') {
    return curve.beats
      .filter((beat) => beat.status !== 'rejected' && beat.sourceFactIds?.includes(factId))
      .map((beat) => beat.id)
  }
  if (previousFact?.disposition !== 'parked') return []
  return previousFact.coveredByBeatIds.filter((beatId) => (
    curve.beats.some((beat) => beat.id === beatId && beat.status !== 'rejected')
  ))
}

function updateBeatsForSourceFactDisposition(
  beats: readonly CurveBeat[],
  factId: string,
  disposition: 'parked' | 'integrated',
  affectedBeatIds: readonly string[],
): CurveBeat[] {
  const affected = new Set(affectedBeatIds)
  if (!affected.size) return [...beats]

  return beats.map((beat) => {
    if (!affected.has(beat.id)) return beat
    if (disposition === 'parked') {
      // Keep the text visible for review, but remove the live traceability
      // claim until the author explicitly integrates the fact again.
      return {
        ...beat,
        status: 'stale' as const,
        sourceFactIds: beat.sourceFactIds?.filter((sourceFactId) => sourceFactId !== factId),
      }
    }
    // Restoring a parked fact is explicit, but still requires another review
    // before the old material can be confirmed in this version.
    return {
      ...beat,
      status: 'stale' as const,
      sourceFactIds: [...new Set([...(beat.sourceFactIds ?? []), factId])],
    }
  })
}

export function confirmProvisionalCurve(curve: ProvisionalCurve): {
  curve: ProvisionalCurve
  confirmedCurve: ConfirmedCurve
} {
  const design = validateCurveForConfirmation(curve)
  const foundation = curve.foundation
    ?? design?.foundation
  if (!foundation) {
    throw new AppError('这条主线还没有形成完整的故事设计基础，请重新生成曲线。', 400, 'STORY_CURVE_FOUNDATION_INCOMPLETE')
  }
  const confirmedAt = Date.now()
  const beats = curve.beats.map((beat) => (
    beat.status === 'rejected' ? beat : { ...beat, status: 'confirmed' as const }
  ))
  const confirmed = {
    ...curve,
    beats,
    ...(design ? { design } : {}),
    foundation,
    status: 'confirmed' as const,
    updatedAt: confirmedAt,
  }
  return {
    curve: confirmed,
    confirmedCurve: {
      id: `confirmed-curve-${randomUUID()}`,
      provisionalCurveId: confirmed.id,
      title: confirmed.title,
      brief: confirmed.brief,
      beats: confirmed.beats,
      ...(confirmed.design ? { design: confirmed.design } : {}),
      ...(confirmed.clarifications ? { clarifications: structuredClone(confirmed.clarifications) } : {}),
      foundation,
      ...(confirmed.generation ? { generation: confirmed.generation } : {}),
      confirmedAt,
    },
  }
}

function validateCurveForConfirmation(curve: ProvisionalCurve): StoryDesignRecord | undefined {
  if (getUnresolvedClarifications(curve).length) {
    throw new AppError('还有节点依赖未确认的因果前提，请确认作者回答、审阅独立提案或放弃旧提案。', 400, 'STORY_CURVE_CLARIFICATIONS_UNRESOLVED')
  }
  if (curve.status !== 'draft') {
    throw new AppError('这条主线已经不是可确认的草案，请刷新后重试。', 409, 'STORY_CURVE_NOT_DRAFT')
  }
  if (curve.beats.length < 5 || curve.beats.length > 7) {
    throw new AppError('暂定故事曲线需要包含 5 至 7 个节点。', 400, 'STORY_CURVE_INCOMPLETE')
  }
  if (curve.beats.some((beat) => beat.status === 'stale' || beat.source === 'undecided')) {
    throw new AppError('请先处理被修改影响的曲线节点，再确认主线。', 400, 'STORY_CURVE_HAS_STALE_BEATS')
  }

  const hasAllRequiredKinds = requiredConfirmationBeatKinds.every((kind) => (
    curve.beats.some((beat) => beat.kind === kind && beat.status !== 'rejected')
  ))
  if (!hasAllRequiredKinds) {
    throw new AppError('暂定故事曲线还缺少关键节点，请重新生成。', 400, 'STORY_CURVE_INCOMPLETE')
  }

  const design = curve.design ? updateStoryDesignCoverage(curve.design, curve.beats) : undefined
  if (getUnresolvedStorySourceFacts(design).length) {
    throw new AppError('还有原始材料尚未纳入或明确暂不采用，请先由你决定。', 400, 'STORY_SOURCE_FACTS_UNRESOLVED')
  }
  const parkedFactsStillUsed = getParkedStorySourceFactsUsedByCurve(design, curve.beats)
  if (parkedFactsStillUsed.length) {
    throw new AppError(
      `你已选择暂不纳入的原始材料仍出现在${parkedFactsStillUsed.length}个曲线节点中，请先编辑或重推这些节点，或重新纳入材料。`,
      400,
      'STORY_PARKED_FACT_STILL_USED',
    )
  }
  const missingDesignSections = getMissingStoryDesignSections(design, curve.beats)
  if (missingDesignSections.length) {
    throw new AppError(
      `故事设计记录还缺少有效的${missingDesignSections.join('、')}节点，请补回或编辑后再确认。`,
      400,
      'STORY_DESIGN_INCOMPLETE',
    )
  }
  const foundation = curve.foundation ?? design?.foundation
  if (!foundation || !isStoryCurveFoundationCurrent(foundation, curve.beats)) {
    throw new AppError(
      '故事设计基础已经过期，请先重新生成或逐条重看受影响节点，再确认主线。',
      409,
      'STORY_CURVE_FOUNDATION_OUT_OF_DATE',
    )
  }
  const liveFactIds = new Set(design?.sourceFacts
    .filter((fact) => fact.disposition === 'integrated')
    .map((fact) => fact.id) ?? [])
  const foundationFactIds = new Set([
    ...(foundation.sourceFactIds?.conflictCore ?? []),
    ...(foundation.sourceFactIds?.predicament ?? []),
    ...(foundation.sourceFactIds?.middleDevelopment ?? []),
    ...(foundation.sourceFactIds?.storyEnds ?? []),
  ])
  if (liveFactIds.size && [...liveFactIds].some((factId) => !foundationFactIds.has(factId))) {
    throw new AppError(
      '还有原始材料没有进入冲突、困境、中段或故事两端的统一设计，请编辑或重推后再确认。',
      400,
      'STORY_CURVE_FOUNDATION_FACTS_INCOMPLETE',
    )
  }
  return design
}

export function materializeConfirmedCurve(
  seed: StorySeed,
  confirmedCurve: ConfirmedCurve,
): MaterializedCurveFoundation {
  const beats = getConfirmedCurveBeats(confirmedCurve)
  const foundation = confirmedCurve.foundation
    ?? confirmedCurve.design?.foundation
  if (!foundation) {
    throw new AppError('已确认主线缺少冻结的故事设计基础，请恢复旧版本后重新确认。', 409, 'STORY_CURVE_FOUNDATION_INCOMPLETE')
  }
  if (!isStoryCurveFoundationCurrent(foundation, confirmedCurve.beats)) {
    throw new AppError('已确认主线的故事设计基础与节点不一致，不能重新反向生成困境。请恢复匹配的主线版本。', 409, 'STORY_CURVE_FOUNDATION_OUT_OF_DATE')
  }
  const narrativeSeed = createNarrativeSeed(seed, confirmedCurve, foundation)
  const confirmedGoal = foundation.preservedGoal || getConfirmedCurveGoal(narrativeSeed, beats.currentState)
  const curveFacts = materializeConfirmedCurveFacts(seed, confirmedCurve)
  // The action that opens the spine is part of the reviewed foundation.  Do
  // not rebuild it from a display beat: doing so would let a later renderer or
  // a legacy copy of the beat become a second source of truth.
  const climaxAction = createConfirmedClimaxAction(foundation, beats.climax)
  const approach = createConfirmedApproach(foundation)
  const predicament = createConfirmedPredicament(
    confirmedCurve,
    beats,
    foundation,
    confirmedGoal,
    curveFacts,
    climaxAction,
    approach,
  )
  const headTail = createConfirmedHeadTail(foundation, confirmedGoal, climaxAction)
  const { systemDraft: _systemDraft, ...seedWithoutDraft } = narrativeSeed

  return {
    seed: { ...seedWithoutDraft, creativeBrief: confirmedCurve.brief },
    predicament,
    approach,
    headTail,
  }
}

interface ConfirmedCurveBeats {
  currentState: CurveBeat
  trigger: CurveBeat
  escalation: CurveBeat
  climax: CurveBeat
  resolution: CurveBeat
  characterTension?: CurveBeat
  midpoint?: CurveBeat
}

function getConfirmedCurveBeats(curve: ConfirmedCurve): ConfirmedCurveBeats {
  const requiredBeat = (kind: CurveBeatKind): CurveBeat => {
    const beat = curve.beats.find((candidate) => candidate.kind === kind && candidate.status !== 'rejected')
    if (!beat) throw new AppError('已确认主线缺少必要节点，请重新确认。', 409, 'STORY_CURVE_INCOMPLETE')
    return beat
  }
  return {
    currentState: requiredBeat('current-state'),
    trigger: requiredBeat('trigger'),
    escalation: requiredBeat('escalation'),
    climax: requiredBeat('climax-choice'),
    resolution: requiredBeat('resolution'),
    characterTension: curve.beats.find((beat) => beat.kind === 'character-tension' && beat.status !== 'rejected'),
    midpoint: curve.beats.find((beat) => beat.kind === 'midpoint-turn' && beat.status !== 'rejected'),
  }
}

function createNarrativeSeed(
  seed: StorySeed,
  confirmedCurve: ConfirmedCurve,
  foundation?: NonNullable<ConfirmedCurve['foundation']>,
): StorySeed {
  const materializedSeed = applyCurrentCurveEditToSeed(seed, confirmedCurve)
  const parkedFacts = (confirmedCurve.design?.sourceFacts ?? [])
    .filter((fact) => fact.disposition === 'parked')
    .map((fact) => fact.text.trim())
  const isParkedMaterial = (value: string) => parkedFacts.some((parked) => {
    const normalizedValue = value.trim()
    return normalizedValue === parked || (parked.length >= 4 && normalizedValue.includes(parked))
  })
  const foundationGoal = foundation?.preservedGoal?.trim()
  const currentStateWasEdited = confirmedCurve.beats.some((beat) => (
    beat.kind === 'current-state' && beat.source === 'user-edit'
  ))
  const lockedGoal = currentStateWasEdited
    ? materializedSeed.lockedGoal
    : foundationGoal || materializedSeed.lockedGoal
  return {
    ...materializedSeed,
    lockedFacts: materializedSeed.lockedFacts.filter((fact) => !isParkedMaterial(fact)),
    lockedGoal: lockedGoal && !isParkedMaterial(lockedGoal)
      ? lockedGoal
      : null,
  }
}

function materializeConfirmedCurveFacts(seed: StorySeed, curve: ConfirmedCurve): StoryFact[] {
  // Only the present obstacle and middle-development constraints belong in
  // the initial narrative state. Climax and resolution remain future
  // commitments in the confirmed curve.
  const seedFactStatements = new Set(seed.lockedFacts.map((statement) => statement.trim()))
  const sourceFacts = (curve.design?.sourceFacts ?? [])
    .filter((fact) => fact.disposition === 'integrated')
    .filter((fact) => !seedFactStatements.has(fact.text.trim()))
    .map((fact): StoryFact => ({
      id: `fact-source-${fact.id}`,
      statement: fact.text,
      source: 'confirmed-curve',
      mutability: 'fixed',
      ...(fact.coveredByBeatIds.length
        ? { originCurveBeatIds: getInitialCurveBeatIds(curve, fact.coveredByBeatIds) }
        : {}),
    }))
  const sourceFactStatements = new Set(sourceFacts.map((fact) => fact.statement.trim()))
  const foundation = curve.foundation ?? curve.design?.foundation
  if (!foundation) return sourceFacts

  // These are design constraints already reviewed before confirmation.  They
  // are intentionally copied from the frozen foundation, never from the
  // prose of a generated beat.  Keep the initial narrative bounded and leave
  // climax/resolution as future commitments.
  const foundationFacts: Array<{ id: string; statement: string; originCurveBeatIds: string[] }> = [
    {
      id: 'predicament-immediate-situation',
      statement: foundation.predicament.immediateSituation,
      originCurveBeatIds: ['beat-current-state'],
    },
    {
      id: 'predicament-obstacle',
      statement: foundation.predicament.obstacle,
      originCurveBeatIds: ['beat-trigger', 'beat-escalation'],
    },
    {
      id: 'predicament-urgency',
      statement: foundation.predicament.urgency,
      originCurveBeatIds: ['beat-trigger'],
    },
    {
      id: 'middle-escalation',
      statement: foundation.middleDevelopment.escalation,
      originCurveBeatIds: ['beat-escalation'],
    },
  ]
  const proposalLimit = Math.max(0, 4 - sourceFacts.length)
  const foundationProposals = foundationFacts
    .filter(({ statement }) => statement.trim() && !sourceFactStatements.has(statement.trim()))
    .slice(0, proposalLimit)
    .map(({ id, statement, originCurveBeatIds }): StoryFact => ({
      id: `fact-foundation-${id}`,
      statement: statement.trim(),
      source: 'confirmed-curve',
      mutability: 'fixed',
      originCurveBeatIds,
    }))
  return [...sourceFacts, ...foundationProposals]
}

function getInitialCurveBeatIds(curve: ConfirmedCurve, beatIds: readonly string[]): string[] {
  return beatIds.filter((beatId) => {
    const beat = curve.beats.find((candidate) => candidate.id === beatId)
    return Boolean(beat && initialNarrativeBeatKinds.includes(beat.kind))
  })
}

function isInitialCurveBeat(kind: CurveBeatKind): boolean {
  return initialNarrativeBeatKinds.includes(kind)
}

function createConfirmedClimaxAction(
  foundation: NonNullable<ConfirmedCurve['foundation']>,
  climax: CurveBeat,
): StoryAction {
  return {
    id: 'curve-climax-action',
    intent: foundation.storyEnds.climax,
    preconditions: [],
    effects: [],
    source: 'generated',
    originCurveBeatIds: [climax.id],
  }
}

function createConfirmedApproach(foundation: NonNullable<ConfirmedCurve['foundation']>): StoryPredicamentApproach {
  return {
    id: 'curve-approach',
    intent: foundation.approach.intent,
    cost: foundation.approach.cost,
  }
}

function createConfirmedPredicament(
  curve: ConfirmedCurve,
  beats: ConfirmedCurveBeats,
  foundation: NonNullable<ConfirmedCurve['foundation']>,
  confirmedGoal: string,
  facts: StoryFact[],
  climaxAction: StoryAction,
  approach: StoryPredicamentApproach,
): StoryPredicament {
  return {
    id: 'curve-predicament',
    title: foundation.predicament.title,
    variationAxis: foundation.predicament.variationAxis,
    preservedGoal: confirmedGoal,
    immediateSituation: foundation.predicament.immediateSituation,
    obstacle: foundation.predicament.obstacle,
    tradeoff: foundation.predicament.tradeoff,
    urgency: foundation.predicament.urgency,
    choice: foundation.predicament.choice,
    plausibleCost: foundation.predicament.plausibleCost,
    approaches: [approach],
    facts,
    actions: [climaxAction],
  }
}

function createConfirmedHeadTail(
  foundation: NonNullable<ConfirmedCurve['foundation']>,
  confirmedGoal: string,
  climaxAction: StoryAction,
): StoryHeadTailOption {
  const transition: StoryTransition = {
    actionId: climaxAction.id,
    consumedFacts: [],
    changedFacts: [],
    introducedFacts: [],
  }
  return {
    id: 'curve-head-tail',
    opening: foundation.storyEnds.opening,
    openingClue: foundation.storyEnds.openingClue,
    climax: foundation.storyEnds.climax,
    resolution: foundation.storyEnds.resolution,
    cost: foundation.storyEnds.cost,
    promise: foundation.storyEnds.promise || `围绕“${confirmedGoal}”完成一次会改变人物的选择。`,
    climaxActionId: climaxAction.id,
    transition,
  }
}

export function getDependentBeatIds(beats: readonly CurveBeat[], beatId: string): string[] {
  const dependentIds = new Set<string>()
  let didFindMore = true
  while (didFindMore) {
    didFindMore = false
    for (const beat of beats) {
      if (beat.id === beatId || dependentIds.has(beat.id)) continue
      if (beat.dependsOn.includes(beatId) || beat.dependsOn.some((dependency) => dependentIds.has(dependency))) {
        dependentIds.add(beat.id)
        didFindMore = true
      }
    }
  }
  return beats.filter((beat) => dependentIds.has(beat.id)).map((beat) => beat.id)
}

export function createProvisionalCurveFallback(
  idea: string,
  seed: StorySeed,
  brief: CreativeBrief,
  existingDesign?: StoryDesignRecord,
  excludedProposalDetails: readonly string[] = [],
): ProvisionalCurve {
  const design = ensureStoryDesignRecord(existingDesign, idea, seed)
  // A fact the author has parked belongs to this version's record, but is not
  // eligible as material for a new proposal. This keeps a rejected direction
  // from leaking back in through a deterministic fallback.
  const sourceFacts = design.sourceFacts.filter((fact) => fact.disposition !== 'parked')
  const material = deriveFallbackStoryMaterial(idea, seed, sourceFacts)
  const proposalBrief = getAlternativeFallbackBrief(brief, excludedProposalDetails)
  const turningMaterial = proposalBrief.dramaticForces.includes('relationship-tension')
    ? material.commitment
    : material.decision
  const hook = getFallbackTriggerDetail(material.subject, material.goal, proposalBrief, material.deadline, material)
  const tension = getFallbackTension(material.subject, material.goal, proposalBrief, material.observed, material)
  const currentStateDetail = material.current
  const now = Date.now()
  const proposalContext: FallbackProposalContext = {
    sourceFacts,
    subject: material.subject,
    goal: material.goal,
    proposalBrief,
    excludedProposalDetails,
    material,
  }
  const beats: CurveBeat[] = [
    createCurveBeat(
      'current-state',
      '此刻想要什么',
      currentStateDetail,
      'user-input',
      'confirmed',
      [],
      material.factIds.current,
      `当前状态是${compactCausalMaterial(currentStateDetail, material.goal)}`,
    ),
    createFallbackProposalBeat(proposalContext, {
      kind: 'character-tension',
      title: '人物的矛盾',
      detail: tension,
      material: material.observed,
      dependsOn: ['beat-current-state'],
      sourceFactIds: material.factIds.observed,
    }),
    createFallbackProposalBeat(proposalContext, {
      kind: 'trigger',
      title: '让目标停住的钩子',
      detail: hook,
      material: material.deadline,
      dependsOn: ['beat-current-state', 'beat-character-tension'],
      sourceFactIds: material.factIds.deadline,
    }),
    createFallbackProposalBeat(proposalContext, {
      kind: 'escalation',
      title: '阻碍开始升级',
      detail: getFallbackEscalation(material.subject, material.goal, proposalBrief, material.commitment, material),
      material: material.commitment,
      dependsOn: ['beat-trigger'],
      sourceFactIds: material.factIds.commitment,
    }),
    createFallbackProposalBeat(proposalContext, {
      kind: 'midpoint-turn',
      title: '中段转折',
      detail: getFallbackMidpointTurn(material.subject, material.goal, proposalBrief, turningMaterial, material),
      material: turningMaterial,
      dependsOn: ['beat-escalation'],
      sourceFactIds: material.factIds.decision,
    }),
    createFallbackProposalBeat(proposalContext, {
      kind: 'climax-choice',
      title: '高潮时的选择与代价',
      detail: getFallbackClimaxChoice(material.subject, material.goal, proposalBrief, turningMaterial, material),
      material: turningMaterial,
      dependsOn: ['beat-midpoint-turn'],
      sourceFactIds: [...new Set([...material.factIds.commitment, ...material.factIds.decision])],
    }),
    createFallbackProposalBeat(proposalContext, {
      kind: 'resolution',
      title: '结局中的变化',
      detail: getFallbackResolution(material.subject, material.goal, proposalBrief, turningMaterial, material),
      material: turningMaterial,
      dependsOn: ['beat-climax-choice'],
      sourceFactIds: [...new Set([...material.factIds.commitment, ...material.factIds.decision])],
    }),
  ]
  attachRemainingFallbackFacts(beats, material.remainingFacts, material.goal)
  const coveredDesign = updateStoryDesignCoverage(design, beats)
  const foundation = buildStoryCurveFoundation(beats, proposalBrief, {
    activeSituation: material.current,
    lockedGoal: material.goal,
  })
  return {
    id: `curve-${randomUUID()}`,
    title: `${getShortIdeaLabel(idea)}的暂定主线`,
    status: 'draft',
    brief,
    beats,
    instructions: [],
    design: foundation ? { ...coveredDesign, foundation } : coveredDesign,
    ...(foundation ? { foundation } : {}),
    generation: {
      origin: 'fact-preserving-fallback',
      dramaticMechanism: getDramaticMechanism(brief),
      notice: '系统未能完成可靠扩写，以下草案已逐条保留原始材料；请由你决定是否采用。',
    },
    createdAt: now,
    updatedAt: now,
  }
}

interface FallbackProposalContext {
  sourceFacts: StorySourceFact[]
  subject: string
  goal: string
  proposalBrief: CreativeBrief
  excludedProposalDetails: readonly string[]
  material: FallbackStoryMaterial
}

interface FallbackProposalSpec {
  kind: Exclude<CurveBeatKind, 'current-state'>
  title: string
  detail: string
  material: string
  dependsOn: string[]
  sourceFactIds: string[]
}

function deriveFallbackStoryMaterial(
  idea: string,
  seed: StorySeed,
  sourceFacts: readonly StorySourceFact[],
): FallbackStoryMaterial {
  const subject = getStorySubject(seed)
  const goal = getStoryGoal(seed, idea)
  const remaining = [...sourceFacts]
  const take = (predicate: (fact: StorySourceFact) => boolean, fallbackIndex = 0): StorySourceFact | undefined => {
    const index = remaining.findIndex(predicate)
    const selectedIndex = index >= 0 ? index : Math.min(fallbackIndex, Math.max(remaining.length - 1, 0))
    if (selectedIndex < 0 || !remaining[selectedIndex]) return undefined
    return remaining.splice(selectedIndex, 1)[0]
  }
  const currentFact = take((fact) => fact.text.includes(subject) || fact.text.includes('前') || fact.text.length > 18, 0)
  const observedFact = take((fact) => /(?:看到|发现|遇到|收到|拿到|作品|报告|耳环|短片)/u.test(fact.text), 0)
  const deadlineFact = take((fact) => /(?:今晚|明早|明天|截止|归还|交接|展出前|仪式前|布置前|之前|期限)/u.test(fact.text), 0)
  const commitmentFact = take((fact) => /(?:答应|承诺|不再|必须|约定|保证)/u.test(fact.text), 0)
  const decisionFact = take((fact) => fact.text.includes(goal) || /(?:想|决定|是否|要不要|打算|准备)/u.test(fact.text), 0)
  const fallbackFact = (candidate: StorySourceFact | undefined, fallback: string): StorySourceFact => (
    candidate ?? { id: `synthetic-${fallback}`, text: fallback, source: 'user-input', disposition: 'integrated', coveredByBeatIds: [] }
  )
  const currentBase = getAtomicFactHandle(fallbackFact(currentFact, '当前处境').text, '当前处境')
  const observed = getAtomicFactHandle(fallbackFact(observedFact, '原定安排').text, '原定安排')
  const deadline = getAtomicFactHandle(fallbackFact(deadlineFact, '眼前的时机').text, '眼前的时机')
  const commitment = getAtomicFactHandle(fallbackFact(commitmentFact, '尚未明确的取舍').text, '尚未明确的取舍')
  const decision = getAtomicFactHandle(fallbackFact(decisionFact, goal).text, goal)
  const ids = (fact: StorySourceFact | undefined, fallback: StorySourceFact | undefined): string[] => {
    const selected = fact ?? fallback
    return selected?.id.startsWith('synthetic-') ? [] : selected ? [selected.id] : []
  }
  // The current-state card is a compact starting point, not a second copy of
  // the whole premise. Other facts are assigned to the beat that develops
  // them, so repeating `observed` here would make a rich input look inflated.
  const current = currentBase
  const goalPhrase = getGoalPhrase(goal)
  const goalDecision = getGoalDecisionPhrase(goal)
  const currentWithGoal = current.includes(goalPhrase) || current.includes(goalDecision)
    ? current
    : `${current}；${subject}当前要决定${goalDecision}`
  return {
    subject,
    goal,
    current: currentWithGoal,
    observed,
    deadline,
    commitment,
    decision,
    remainingFacts: [...remaining],
    factIds: {
      current: ids(currentFact, sourceFacts[0]),
      observed: ids(observedFact, undefined),
      deadline: ids(deadlineFact, undefined),
      commitment: ids(commitmentFact, undefined),
      decision: ids(decisionFact, undefined),
    },
  }
}

/**
 * Role assignment deliberately starts with one primary fact per causal beat.
 * Rich ideas often contain one more consequence than the five obvious roles
 * (for example, a possible loss after a decision). Keep that consequence
 * visible and traceable by attaching it to the beat that can actually develop
 * it, while adding only a short object phrase to the proposal text.
 */
function attachRemainingFallbackFacts(
  beats: CurveBeat[],
  remainingFacts: readonly StorySourceFact[],
  goal: string,
): void {
  for (const fact of remainingFacts) {
    const normalized = fact.text.trim()
    if (!normalized) continue
    const kind: CurveBeatKind = /(?:期限|今晚|明早|明天|截止|归还|交接|之前|展出前|仪式前)/u.test(normalized)
      ? 'trigger'
      : /(?:答应|承诺|不再|约定|保证|要求|禁止|必须)/u.test(normalized)
        ? 'escalation'
        : /(?:决定|是否|要不要|可能|失去|代价|名字|署名|选择)/u.test(normalized)
          ? 'climax-choice'
          : 'character-tension'
    const target = beats.find((beat) => beat.kind === kind)
      ?? beats.find((beat) => beat.kind === 'resolution')
    if (!target) continue
    target.sourceFactIds = [...new Set([...(target.sourceFactIds ?? []), fact.id])]
    const handle = getAtomicFactHandle(normalized, getGoalPhrase(goal))
    if (!handle || target.detail.includes(handle)) continue
    const suffix = kind === 'trigger'
      ? `；处理时还要顾及${handle}`
      : kind === 'escalation'
        ? `；这项条件会让取舍更具体`
        : kind === 'climax-choice'
          ? `；代价还包括${handle}`
          : `；它会改变${getGoalPhrase(goal)}的判断`
    const nextDetail = `${target.detail.replace(/[。！？]$/u, '')}${suffix}。`
    target.detail = nextDetail.length > maximumCurveBeatLength
      ? `${nextDetail.slice(0, maximumCurveBeatLength - 1)}…`
      : nextDetail
    target.causalAnchor = shortenAuthorAnchor(handle)
  }
}

/** Keep one source fact as a short causal handle. The full wording remains in
 * the ledger; curve cards should carry only the object that the next beat
 * actually develops. */
function getAtomicFactHandle(value: string, fallback: string): string {
  const cleaned = value
    .replace(/^暂定[：:]/u, '')
    .replace(/^(?:却|但|并且|同时|然后|随后)\s*/u, '')
    .replace(/[“”"']/gu, '')
    .trim()
  const sceneMatch = cleaned.match(/(?:在|于)(?:借来的)?(.+?)(?:里|中)看到(?:和)?(.+)$/u)
  if (sceneMatch?.[1] && sceneMatch[2]) return shortenAtomicFact(`${sceneMatch[1]}里的${sceneMatch[2]}`)
  const decisionMatch = cleaned.match(/(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (decisionMatch?.[1]) return shortenAtomicFact(`是否${decisionMatch[1].trim()}`)
  const intentionMatch = cleaned.match(/(?:想要|想|希望|打算|准备)(?:在[^，。！？；]{0,16})?(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (intentionMatch?.[1]) return shortenAtomicFact(`是否${intentionMatch[1].trim()}`)
  const commitmentMatch = cleaned.match(/(?:答应|承诺|约定|保证)(.+)$/u)
  if (commitmentMatch?.[1]) return shortenAtomicFact(commitmentMatch[1].trim())
  const clauses = cleaned.split(/[，。！？；\n]/u).map((part) => part.trim()).filter(Boolean)
  const candidate = clauses.find((part) => part.length >= 4) ?? cleaned
  const withoutSubject = candidate.replace(/^[\u4e00-\u9fff]{1,4}(?=(?:在|于|想|要|答应|承诺|却))/u, '').trim()
  return shortenAtomicFact(withoutSubject || candidate || fallback)
}

function shortenAtomicFact(value: string): string {
  const normalized = value.trim()
  return normalized.length > 36 ? `${normalized.slice(0, 36)}…` : normalized
}

function createFallbackProposalBeat(
  context: FallbackProposalContext,
  spec: FallbackProposalSpec,
): CurveBeat {
  return createCurveBeat(
    spec.kind,
    spec.title,
    avoidExcludedProposal(
      spec.detail,
      spec.kind,
      context.subject,
      context.goal,
      context.proposalBrief,
      spec.material,
      context.excludedProposalDetails,
    ),
    'system-proposal',
    'proposed',
    spec.dependsOn,
    spec.sourceFactIds,
    getFallbackCausalAnchor(spec.kind, context.subject, context.goal, context.proposalBrief, spec.material, context.material),
  )
}

function createCurveBeat(
  kind: CurveBeatKind,
  title: string,
  detail: string,
  source: CurveBeat['source'],
  status: CurveBeat['status'],
  dependsOn: string[],
  sourceFactIds: string[] = [],
  causalAnchor?: string,
): CurveBeat {
  return {
    id: `beat-${kind}`,
    kind,
    title,
    detail,
    source,
    status,
    dependsOn,
    sourceFactIds,
    ...(causalAnchor?.trim() ? { causalAnchor: causalAnchor.trim() } : {}),
  }
}

function getAlternativeFallbackBrief(
  brief: CreativeBrief,
  excludedProposalDetails: readonly string[],
): CreativeBrief {
  // A rejected proposal is a rejected wording, not a request to change the
  // author's selected dramatic mechanism.  Switching forces here made a
  // replacement silently turn (for example) a contrast curve into a cost
  // curve.  `avoidExcludedProposal` supplies a bounded alternate sentence
  // while this brief remains the contract for the whole version.
  void excludedProposalDetails
  return brief
}

function avoidExcludedProposal(
  detail: string,
  kind: CurveBeatKind,
  subject: string,
  goal: string,
  alternateBrief: CreativeBrief,
  material: string,
  excludedProposalDetails: readonly string[],
): string {
  if (!repeatsExcludedProposal(detail, excludedProposalDetails)) return detail

  const alternate = getFallbackDetailForKind(kind, subject, goal, alternateBrief, material)
  if (!repeatsExcludedProposal(alternate, excludedProposalDetails)) return alternate

  // This final guard keeps a rejected proposal from leaking through even if a
  // future dramatic-mechanism template happens to converge with the original.
  return `暂定：${subject}需要围绕“${material}”重新判断如何继续${goal}，具体代价留待作者决定。`
}

function getFallbackDetailForKind(
  kind: CurveBeatKind,
  subject: string,
  goal: string,
  brief: CreativeBrief,
  material: string,
): string {
  switch (kind) {
    case 'character-tension':
      return getFallbackTension(subject, goal, brief, material)
    case 'trigger':
      return getFallbackTriggerDetail(subject, goal, brief, material)
    case 'escalation':
      return getFallbackEscalation(subject, goal, brief, material)
    case 'midpoint-turn':
      return getFallbackMidpointTurn(subject, goal, brief, material)
    case 'climax-choice':
      return getFallbackClimaxChoice(subject, goal, brief, material)
    case 'resolution':
      return getFallbackResolution(subject, goal, brief, material)
    case 'current-state':
      return material
  }
}

function getFallbackCausalAnchor(
  kind: CurveBeatKind,
  subject: string,
  goal: string,
  brief: CreativeBrief,
  material: string,
  storyMaterial?: FallbackStoryMaterial,
): string {
  const anchor = getConcreteMaterialHandle(material, goal, brief)
  switch (kind) {
    case 'character-tension':
      return storyMaterial?.observed && !isPlaceholderMaterial(storyMaterial.observed, goal)
        ? `${subject}对${getConcreteMaterialHandle(storyMaterial.observed, goal, brief)}的旧判断开始动摇`
        : `${subject}原来依赖的办法暴露出局限`
    case 'trigger':
      return anchor
    case 'escalation':
      return anchor
    case 'midpoint-turn':
      return anchor
    case 'climax-choice':
      return anchor
    case 'resolution':
      return anchor
    case 'current-state':
      return compactCausalMaterial(material, goal)
  }
}

function parseModelCurve(
  value: unknown,
  idea: string,
  seed: StorySeed,
  brief: CreativeBrief,
  design: StoryDesignRecord,
  excludedProposalDetails: readonly string[] = [],
): ProvisionalCurve {
  // A free-text five-beat response lets qwen-plus keep re-splicing a deadline
  // or a decision wrapper into every sentence ("在在周五前", "让想...").
  // The normal production contract therefore asks the model to choose the
  // factual roles and an ending tendency from a closed ledger. The server then
  // renders those exact choices into reader-facing, still-provisional beats.
  // This is not a fallback: an invalid role plan is rejected exactly like an
  // invalid free-text curve, and only a valid model plan can retain origin=model.
  if (isRecord(value) && value.curvePlan !== undefined) {
    try {
      const payload = buildModelFactRoleCurvePayload(value, idea, seed, brief, design)
      return parseModelCurve(payload, idea, seed, brief, design, excludedProposalDetails)
    } catch (error) {
      if (error instanceof AppError) {
        throw withModelDiagnostic(error, {
          stage: 'curve-plan-validation',
          reason: error.modelDiagnostic?.reason ?? error.message,
          response: summarizeModelResponse(value),
        })
      }
      throw error
    }
  }
  if (!isRecord(value) || !Array.isArray(value.beats)) {
    throwCurveModelValidationFailure('缺少 beats 数组', value)
  }
  if (value.beats.length < 5 || value.beats.length > 7) {
    throwCurveModelValidationFailure(`beats 数量为 ${value.beats.length}，应为 5 至 7`, value)
  }
  const title = `${getShortIdeaLabel(idea)}的暂定主线`
  const parsedBeats: CurveBeat[] = []
  const seenKinds = new Set<CurveBeatKind>()

  if (process.env.STORY_CURVE_DEBUG?.trim().toLowerCase() === 'true' && isRecord(value)) {
    console.warn(`[curve-debug] candidate=${JSON.stringify({
      beats: Array.isArray(value.beats)
        ? value.beats.map((item) => isRecord(item) ? { kind: item.kind, detail: item.detail, sourceFactIds: item.sourceFactIds } : { shape: typeof item })
        : { shape: typeof value.beats },
    })}`)
  }

  for (const item of value.beats) {
    if (!isRecord(item) || typeof item.kind !== 'string' || !isCurveBeatKind(item.kind)) {
      throwCurveModelValidationFailure(`第 ${parsedBeats.length + 1} 个 beat 的 kind 不合法`, value)
    }
    if (seenKinds.has(item.kind)) {
      throwCurveModelValidationFailure(`重复的 beat kind：${item.kind}`, value)
    }
    const detail = readOptionalText(item.detail, maximumModelCurveBeatLength)
    if (!detail) throwCurveModelValidationFailure(`beat ${item.kind} 缺少 detail`, value)
    if (!brief.allowSystemNamedCharacters && hasNewNamedCharacter(detail, seed)) {
      throwCurveModelValidationFailure(`beat ${item.kind} 引入了未允许的具名人物`, value)
    }
    if (item.kind !== 'current-state') {
      const safetyFailure = getCurveProposalSafetyFailure(
        item.kind,
        detail,
        design.sourceFacts.map((fact) => fact.text),
      )
      if (safetyFailure) throwCurveModelValidationFailure(`beat ${item.kind}${safetyFailure}`, value)
      const unsupported = findUnsupportedCurveDetail(detail, seed, design)
      if (unsupported) {
        throwCurveModelValidationFailure(`beat ${item.kind} 引入了未建立的${unsupported.label}“${unsupported.value}”`, value)
      }
      const unsupportedSemantic = findUnsupportedCurveSemanticLanguage(detail, seed, design)
      if (unsupportedSemantic) {
        throwCurveModelValidationFailure(
          `beat ${item.kind} 写入了未由作者原文支持的${unsupportedSemantic.label}“${unsupportedSemantic.value}”`,
          value,
        )
      }
      const languageLeak = findUnestablishedCurveLatinPhrase(detail, seed, design)
      if (languageLeak) {
        throwCurveModelValidationFailure(`beat ${item.kind} 包含未由作者材料支持的英文或模板短语“${languageLeak}”`, value)
      }
      const repeatedUpstream = findRepeatedCurveBeatDetail(detail, parsedBeats)
      if (repeatedUpstream) {
        throwCurveModelValidationFailure(`beat ${item.kind} 整句复述了上游节点“${repeatedUpstream}”，没有形成新的因果推进`, value)
      }
      const textQualityIssue = getModelCurveTextQualityIssue(item.kind, detail, seed)
      if (textQualityIssue) {
        throwCurveModelValidationFailure(`beat ${item.kind}${textQualityIssue}`, value)
      }
    }
    if (item.kind !== 'current-state' && repeatsExcludedProposal(detail, excludedProposalDetails)) {
      throwCurveModelValidationFailure(`beat ${item.kind} 重复了作者已拒绝的提案`, value)
    }
    seenKinds.add(item.kind)
    const parsedSourceFactIds = parseSourceFactIds(item.sourceFactIds, design)
    if (item.sourceFactIds !== undefined && !parsedSourceFactIds) {
      throwCurveModelValidationFailure(`beat ${item.kind} 的 sourceFactIds 不是当前原始材料 ID`, value)
    }
    const sourceFactIds = parsedSourceFactIds ?? deriveCoveredSourceFactIds(design, detail)
    if (item.kind !== 'current-state' && !sourceFactIds.length) {
      throwCurveModelValidationFailure(`beat ${item.kind} 没有列出可追溯的 sourceFactIds`, value)
    }
    if (item.kind !== 'current-state' && parsedSourceFactIds) {
      // sourceFactIds are an auditable claim, not a loose list of context the
      // model happened to receive. A model may abstract an author fact, but it
      // still needs a distinctive textual handle in the beat for review.
      const ungroundedFact = parsedSourceFactIds
        .map((sourceFactId) => design.sourceFacts.find((fact) => fact.id === sourceFactId))
        .find((fact): fact is StorySourceFact => fact !== undefined && !hasModelSourceFactEvidence(detail, fact.text))
      if (ungroundedFact) {
        throwCurveModelValidationFailure(
          `beat ${item.kind} 的 sourceFactIds 声称承接 ${ungroundedFact.id}，但 detail 没有对应的原文锚点`,
          value,
        )
      }
    }
    const parsedDetail = item.kind === 'current-state' ? getCurrentState(seed, idea) : detail
    const dependencies = parseDependencies(item.dependsOn)
    if (dependencies === undefined) {
      throwCurveModelValidationFailure(`beat ${item.kind} 的 dependsOn 包含未知或重复节点`, value)
    }
    parsedBeats.push(createCurveBeat(
      item.kind,
      getCurveBeatTitle(item.kind),
      parsedDetail,
      item.kind === 'current-state' ? 'user-input' : 'system-proposal',
      item.kind === 'current-state' ? 'confirmed' : 'proposed',
      dependencies,
      sourceFactIds,
      // The compact model contract does not ask the model to write a second
      // causal map. Derive this planner handle from its already validated
      // detail and source-fact claims instead, so an unreviewed auxiliary
      // field cannot smuggle a new premise into the frozen foundation.
      deriveModelCurveCausalAnchor(item.kind, parsedDetail, sourceFactIds, design),
      ))
  }

  if (requiredConfirmationBeatKinds.some((kind) => !seenKinds.has(kind))) {
    throwCurveModelValidationFailure('缺少必需的 current-state/trigger/escalation/climax-choice/resolution 节点', value)
  }
  const orderedBeats = orderCurveBeatsByDependencies(parsedBeats)
  if (!isCurveGroundedToSeed(orderedBeats, seed)) {
    throwCurveModelValidationFailure('至少两个提案没有引用原始目标或事实锚点', value)
  }
  const coveredDesign = updateStoryDesignCoverage(design, orderedBeats)
  const unresolvedFacts = getUnresolvedStorySourceFacts(coveredDesign)
  if (unresolvedFacts.length) {
    throwCurveModelValidationFailure(`仍有 ${unresolvedFacts.length} 条原始材料没有被 sourceFactIds 承接`, value)
  }
  const directionFailure = getCreativeDirectionValidationFailure(orderedBeats, brief)
  if (directionFailure) {
    throwCurveModelValidationFailure(directionFailure, value)
  }
  // The model only owns the reviewed beat proposals.  Build the single
  // foundation from those exact beats after validation so confirmation and
  // the first spine share one source of truth.  If a model emits a legacy
  // foundation anyway, reject malformed data rather than silently accepting a
  // second, unvalidated design map.
  const suppliedFoundation = value.foundation === undefined
    ? undefined
    : parseModelCurveFoundation(value.foundation)
  if (value.foundation !== undefined && !suppliedFoundation) {
    throwCurveModelValidationFailure('foundation 结构不符合当前模型合同；请只输出 title 和 beats', value)
  }
  if (suppliedFoundation) {
    if (!isModelFoundationGoalCompatible(suppliedFoundation, seed)) {
      throwCurveModelValidationFailure('foundation 没有保留作者锁定目标', value)
    }
    const foundationIssue = flattenFoundationTexts(suppliedFoundation)
      .map((text) => findUnsupportedCurveDetail(text, seed, design))
      .find((issue): issue is { label: string; value: string } => Boolean(issue))
    if (foundationIssue) {
      throwCurveModelValidationFailure(`foundation 引入了未建立的${foundationIssue.label}“${foundationIssue.value}”`, value)
    }
    const foundationSemanticIssue = flattenFoundationTexts(suppliedFoundation)
      .map((text) => findUnsupportedCurveSemanticLanguage(text, seed, design))
      .find((issue): issue is { label: string; value: string } => Boolean(issue))
    if (foundationSemanticIssue) {
      throwCurveModelValidationFailure(
        `foundation 写入了未由作者原文支持的${foundationSemanticIssue.label}“${foundationSemanticIssue.value}”`,
        value,
      )
    }
  }
  const plannedFoundation = buildStoryCurveFoundation(orderedBeats, brief, seed)
  if (!plannedFoundation) throwCurveModelValidationFailure('无法从已校验 beats 构造共享 foundation', value)
  const foundation = suppliedFoundation
    ? mergeFoundationTrace(suppliedFoundation, plannedFoundation)
    : plannedFoundation

  const now = Date.now()
  return {
    id: `curve-${randomUUID()}`,
    title,
    status: 'draft',
    brief,
    beats: normalizeCurveDependencies(orderedBeats),
    instructions: [],
    design: { ...updateStoryDesignCoverage(coveredDesign, normalizeCurveDependencies(orderedBeats)), foundation },
    foundation,
    generation: {
      origin: 'model',
      dramaticMechanism: getDramaticMechanism(brief),
    },
    createdAt: now,
    updatedAt: now,
  }
}

function deriveModelCurveCausalAnchor(
  kind: CurveBeatKind,
  detail: string,
  sourceFactIds: readonly string[],
  design: StoryDesignRecord,
): string {
  if (kind === 'current-state') {
    return getModelCurveFactAnchor(design.sourceFacts[0]?.text ?? detail)
  }

  const referencedFact = sourceFactIds
    .map((id) => design.sourceFacts.find((fact) => fact.id === id))
    .find((fact): fact is StorySourceFact => fact !== undefined && hasModelSourceFactEvidence(detail, fact.text))
  if (referencedFact) return getModelCurveFactAnchor(referencedFact.text)

  return compactCausalMaterial(detail, detail)
}

function orderCurveBeatsByDependencies(beats: readonly CurveBeat[]): CurveBeat[] {
  const canonicalOrder = new Map(curveBeatKinds.map((kind, index) => [kind, index]))
  const remaining = new Map(beats.map((beat) => [beat.id, beat]))
  const ordered: CurveBeat[] = []

  while (remaining.size) {
    const available = [...remaining.values()]
      .filter((beat) => beat.dependsOn.every((dependency) => ordered.some((candidate) => candidate.id === dependency)))
      .sort((left, right) => (canonicalOrder.get(left.kind) ?? 99) - (canonicalOrder.get(right.kind) ?? 99))
    if (!available.length) {
      throw new AppError(
        '模型曲线的 dependsOn 形成了循环或引用了未先建立的节点。',
        502,
        'STORY_CURVE_MODEL_VALIDATION_FAILED',
        undefined,
        undefined,
        undefined,
        { stage: 'curve-validation', reason: 'dependsOn-cycle' },
      )
    }
    const next = available[0]!
    ordered.push(next)
    remaining.delete(next.id)
  }

  return ordered
}

function getCurveProposalSafetyFailure(
  kind: CurveBeatKind,
  detail: string,
  authorSourceFacts: readonly string[] = [],
): string | undefined {
  if (kind === 'current-state') return undefined
  const normalized = detail.trim()
  if (!curveProposalPrefixPattern.test(normalized)) return '没有以“暂定：”开头'
  const sceneSignal = getCurveSceneSignal(normalized, authorSourceFacts)
  if (sceneSignal) return `包含了场景、对白或连续操作（${sceneSignal}）`
  const observation = normalized.match(curveSceneObservationPattern)?.[0]
  if (observation && !isAuthorConfirmedPhrase(observation, authorSourceFacts)) {
    return '包含了未经确认的场景观察'
  }
  const unsupportedObject = Array.from(normalized.matchAll(curveConcreteObjectPattern))
    .map((match) => match[0])
    .find((candidate) => !isAuthorConfirmedConcreteObject(candidate, authorSourceFacts))
  if (unsupportedObject) return `包含了未经确认的具体物件“${unsupportedObject}”`
  if (curveActionChainPattern.test(normalized)) return '包含了连续行动步骤'
  if (curveSettledOutcomePattern.test(normalized)) return '把结果写成了既成事实'

  const requirement: Record<Exclude<CurveBeatKind, 'current-state'>, RegExp> = {
    'character-tension': /(?:想|却|但|不愿|害怕|恐惧|习惯|容易|总|表面|性格|关系|承诺|名字|目标|原来|开始|需要|无法|不能)/u,
    trigger: /(?:想|目标|计划|原来的办法|出现|让|迫使|阻碍|停住|无法|不能|不得|受限|期限|归还|截止|之前|缺少|没有|尚未|只能|必须|却|但|承诺|关系|冲突)/u,
    escalation: /(?:继续|若|必须|取舍|代价|原本|升级|两难|因此|意味着|承担|不再|承诺|关系|责任|删|保留|公开|分歧|边界)/u,
    'midpoint-turn': /(?:发现|办法|代价|重新|转折|问题|表面|真正|改变|改成|不只是|意识|承认|转向|开始|选择|理解|判断)/u,
    'climax-choice': /(?:必须|选择|承担|放下|决定|代价|保留|删|是否|还是|改写|拒绝|接受|继续|停止|目标|承诺|关系)/u,
    resolution: /(?:结果|变化|得到|失去|理解|成长|离开|落点|保留|改写|接受|承担|决定|转为|不再|仍然|改变|调整|关系|承诺)/u,
  }
  if (!requirement[kind].test(normalized)) return '没有表达该节点所需的结构语义'
  return undefined
}

function getCurveSceneSignal(
  detail: string,
  authorSourceFacts: readonly string[],
): string | undefined {
  if (/[“”‘’"']/u.test(detail)) {
    const quoted = detail.match(/[“”‘’"']/u)?.[0] ?? '引号'
    // Quotation marks around a verbatim author phrase are review notation, not
    // dialogue. Any other quote remains a scene/dialogue boundary violation.
    if (!isAuthorConfirmedPhrase(quoted, authorSourceFacts) && !hasOnlyConfirmedQuotedPhrases(detail, authorSourceFacts)) {
      return '未确认引号内容'
    }
  }
  if (curveSceneActionSignalPattern.test(detail)) return '新增场景动作或调度'
  const observation = detail.match(curveSceneObservationPattern)?.[0]
  if (observation && !isAuthorConfirmedPhrase(observation, authorSourceFacts)) return '未确认场景观察'
  return undefined
}

function hasOnlyConfirmedQuotedPhrases(
  detail: string,
  authorSourceFacts: readonly string[],
): boolean {
  const quotedPhrases = detail.match(/[“”‘’"]([^“”‘’"]+)[”’"]/gu) ?? []
  if (!quotedPhrases.length) return false
  return quotedPhrases.every((quoted) => isAuthorConfirmedPhrase(quoted, authorSourceFacts))
}

function isAuthorConfirmedConcreteObject(
  candidate: string,
  authorSourceFacts: readonly string[],
): boolean {
  const normalizedCandidate = normalizeCurveEvidence(candidate)
  if (normalizedCandidate.length < 2) return false
  return authorSourceFacts.some((fact) => {
    const normalizedFact = normalizeCurveEvidence(fact)
    // The object must occur in the author's wording itself. Merely mentioning
    // a different confirmed fact in the same sentence cannot authorize it.
    return normalizedFact.includes(normalizedCandidate)
  })
}

function isAuthorConfirmedPhrase(
  phrase: string,
  authorSourceFacts: readonly string[],
): boolean {
  const normalizedPhrase = normalizeCurveEvidence(phrase)
  if (normalizedPhrase.length < 3) return false
  return authorSourceFacts.some((fact) => normalizeCurveEvidence(fact).includes(normalizedPhrase))
}

function throwCurveModelValidationFailure(reason: string, value: unknown): never {
  throw new AppError(
    `模型曲线校验失败：${reason}。`,
    502,
    'STORY_CURVE_MODEL_VALIDATION_FAILED',
    undefined,
    undefined,
    undefined,
    {
      stage: 'curve-validation',
      reason,
      response: summarizeModelResponse(value),
    },
  )
}

function findUnsupportedCurveDetail(
  value: string,
  seed: StorySeed,
  design: StoryDesignRecord,
): { label: string; value: string } | undefined {
  const established = [
    seed.activeSituation,
    seed.lockedGoal ?? '',
    ...seed.lockedFacts,
    ...design.sourceFacts.map((fact) => fact.text),
  ].join('\n')
  const normalizedEstablished = normalizeCurveEvidence(established)
  const precision = Array.from(value.matchAll(curveUnestablishedPrecisionPattern))
    .map((match) => match[0])
    .find((match) => !normalizedEstablished.includes(normalizeCurveEvidence(match)))
  if (precision) return { label: '精确数值或时限', value: precision }

  for (const rule of curveUnsupportedDetailRules) {
    const match = Array.from(value.matchAll(rule.pattern))
      .map((candidate) => candidate[0])
      .find((candidate) => (
        !normalizedEstablished.includes(normalizeCurveEvidence(candidate))
        && !isSupportedCurveCategory(candidate, normalizedEstablished)
      ))
    if (match) return { label: rule.label, value: match }
  }
  return undefined
}

function findUnsupportedCurveSemanticLanguage(
  value: string,
  seed: StorySeed,
  design: StoryDesignRecord,
): { label: string; value: string } | undefined {
  const established = normalizeCurveEvidence([
    seed.activeSituation,
    seed.lockedGoal ?? '',
    ...seed.lockedFacts,
    ...design.sourceFacts.map((fact) => fact.text),
  ].join('\n'))

  for (const rule of curveUnsupportedSemanticRules) {
    const match = rule.pattern.exec(value)?.[0]
    if (!match) continue
    // The author may explicitly name a value or relationship concept. In that
    // case it is part of the reviewed material rather than a model conclusion.
    if (established.includes(normalizeCurveEvidence(match))) continue
    if (rule.allowEstablishedSubphrase && hasEstablishedCurveSemanticSubphrase(match, established)) continue
    return { label: rule.label, value: match }
  }
  return undefined
}

function hasEstablishedCurveSemanticSubphrase(value: string, normalizedEstablished: string): boolean {
  const anchors = Array.from(value.matchAll(/(?:意义|归属|完整性|边界|责任)/gu)).map((match) => match[0])
  return anchors.length > 0 && anchors.every((anchor) => normalizedEstablished.includes(normalizeCurveEvidence(anchor)))
}

function findUnestablishedCurveLatinPhrase(
  value: string,
  seed: StorySeed,
  design: StoryDesignRecord,
): string | undefined {
  const established = normalizeCurveEvidence([
    seed.activeSituation,
    seed.lockedGoal ?? '',
    ...seed.lockedFacts,
    ...design.sourceFacts.map((fact) => fact.text),
  ].join('\n'))
  return Array.from(value.matchAll(curveLatinPhrasePattern))
    .map((match) => match[0])
    .find((phrase) => !established.includes(normalizeCurveEvidence(phrase)))
}

function findRepeatedCurveBeatDetail(
  detail: string,
  previousBeats: readonly CurveBeat[],
): string | undefined {
  const normalized = normalizeCausalText(detail)
  if (normalized.length < 18) return undefined
  return previousBeats
    .filter((beat) => beat.kind !== 'current-state' && beat.status !== 'rejected')
    .map((beat) => normalizeCausalText(beat.detail))
    .filter((upstream) => upstream.length >= 18)
    .find((upstream) => normalized.includes(upstream) || upstream.includes(normalized))
}

function isSupportedCurveCategory(match: string, normalizedEstablished: string): boolean {
  const normalizedMatch = normalizeCurveEvidence(match)
  const categoryEvidence: Array<{ match: string[]; source: RegExp }> = [
    { match: ['设备'], source: /投影仪|手机|电话|电脑|相机|录音机|机器|装置|设备/iu },
    { match: ['文件'], source: /文件|短片|作品|报告|文档|资料/iu },
    { match: ['消息'], source: /消息|短信|通知|邮件/iu },
    { match: ['工作人员'], source: /工作人员|负责人|客服|管理员|前队友|队友/iu },
  ]
  return categoryEvidence.some(({ match: aliases, source }) => aliases.includes(normalizedMatch) && source.test(normalizedEstablished))
}

function normalizeCurveEvidence(value: string): string {
  return value.replace(/[\s，。！？；、：“”‘’"'（）()]/gu, '').toLocaleLowerCase()
}

const nonDistinctCurveEvidenceFragments = new Set([
  '作者', '主角', '目标', '选择', '决定', '继续', '已经', '确认', '原来', '原有',
  '当前', '情况', '条件', '问题', '关系', '承诺', '因此', '所以', '但是', '因为',
  '这个', '那个', '他们', '我们', '自己', '对方', '之间', '无法', '不能', '需要',
  '必须', '可以', '以及', '然后', '还是', '是否', '要不要', '暂定',
])

/**
 * A declared source fact needs a visible, non-generic anchor in the proposal.
 * Contiguous source text is intentional: semantic similarity allowed a generic
 * "原有安排" sentence to claim an unrelated deadline, relationship, or commitment.
 */
function hasModelSourceFactEvidence(detail: string, sourceFact: string): boolean {
  const normalizedDetail = normalizeCurveEvidence(detail)
  const normalizedFact = normalizeCurveEvidence(sourceFact)
  if (!normalizedDetail || normalizedFact.length < 3) return false
  if (getModelFactAnchors(sourceFact).some((anchor) => normalizedDetail.includes(anchor))) return true

  // A rich source fact can contain several clauses. Accept a meaningful
  // contiguous handle from one clause, but not a generic story-structure word.
  const maximumFragmentLength = Math.min(10, normalizedFact.length)
  for (let length = maximumFragmentLength; length >= 3; length -= 1) {
    for (let index = 0; index <= normalizedFact.length - length; index += 1) {
      const fragment = normalizedFact.slice(index, index + length)
      if (nonDistinctCurveEvidenceFragments.has(fragment)) continue
      if (normalizedDetail.includes(fragment)) return true
    }
  }
  return false
}

function getModelFactAnchors(sourceFact: string): string[] {
  const normalized = normalizeCurveEvidence(sourceFact)
  if (normalized.length < 3) return []
  const anchors = new Set<string>([normalized])
  const stripped = normalized
    .replace(/^(?:却|但|同时|并且)/u, '')
    .replace(/^[\u4e00-\u9fff]{1,4}(?:发现|答应|承诺|想要|想|准备|决定|不知道|认为)/u, '')
  if (stripped.length >= 3) anchors.add(stripped)
  for (const marker of ['发现', '答应', '承诺', '不知道', '想要', '想', '准备', '决定']) {
    const markerIndex = stripped.indexOf(marker)
    if (markerIndex >= 0 && stripped.length - markerIndex - marker.length >= 3) {
      anchors.add(stripped.slice(markerIndex + marker.length))
    }
  }
  return [...anchors]
    .filter((anchor) => anchor.length >= 3 && !nonDistinctCurveEvidenceFragments.has(anchor))
    .sort((left, right) => right.length - left.length)
}

function flattenFoundationTexts(foundation: StoryCurveFoundation): string[] {
  return [
    foundation.conflictCore.goal,
    foundation.conflictCore.obstacle,
    foundation.conflictCore.tradeoff,
    foundation.preservedGoal,
    foundation.predicament.title,
    foundation.predicament.immediateSituation,
    foundation.predicament.obstacle,
    foundation.predicament.tradeoff,
    foundation.predicament.urgency,
    foundation.predicament.choice,
    foundation.predicament.plausibleCost,
    foundation.middleDevelopment.escalation,
    foundation.middleDevelopment.midpoint,
    foundation.middleDevelopment.climaxPressure,
    foundation.storyEnds.opening,
    foundation.storyEnds.openingClue,
    foundation.storyEnds.climax,
    foundation.storyEnds.resolution,
    foundation.storyEnds.cost,
    foundation.storyEnds.promise,
    foundation.approach.intent,
    foundation.approach.cost,
  ]
}

function mergeFoundationTrace(
  foundation: StoryCurveFoundation,
  trace: StoryCurveFoundation | undefined,
): StoryCurveFoundation {
  if (!trace) return foundation
  return {
    ...foundation,
    sourceFactIds: trace.sourceFactIds,
    beatSignatures: trace.beatSignatures,
  }
}

function isModelFoundationGoalCompatible(
  foundation: StoryCurveFoundation,
  seed: Pick<StorySeed, 'lockedGoal' | 'activeSituation'>,
): boolean {
  const expected = seed.lockedGoal?.trim()
  if (!expected) return true
  const expectedPhrase = getGoalPhrase(expected).replace(/[“”"']/gu, '')
  const candidate = `${foundation.preservedGoal} ${foundation.conflictCore.goal}`.replace(/[“”"']/gu, '')
  return Boolean(expectedPhrase)
    && (candidate.includes(expectedPhrase) || expectedPhrase.includes(getGoalPhrase(foundation.preservedGoal)))
}

interface CreativeDirectionEvidenceRequirement {
  label: string
  earlyKinds: readonly CurveBeatKind[]
  earlyPattern: RegExp
  earlyInstruction: string
  lateKinds: readonly CurveBeatKind[]
  latePattern: RegExp
  lateInstruction: string
}

function getCreativeDirectionValidationFailure(
  beats: readonly CurveBeat[],
  brief: CreativeBrief,
): string | undefined {
  const proposals = beats.filter((beat) => beat.kind !== 'current-state' && beat.status !== 'rejected')
  const byKind = new Map(proposals.map((beat) => [beat.kind, beat.detail]))
  const requirements = getCreativeDirectionEvidenceRequirements(brief)
  const missingEvidence: string[] = []

  for (const requirement of requirements) {
    const earlyMatches = getDirectionEvidenceKinds(byKind, requirement.earlyKinds, requirement.earlyPattern)
    const lateMatches = getDirectionEvidenceKinds(byKind, requirement.lateKinds, requirement.latePattern)
    if (!earlyMatches.length) {
      missingEvidence.push(`${requirement.label}缺少${requirement.earlyKinds.join('/')}层级的因果证据`)
    }
    if (!lateMatches.length) {
      missingEvidence.push(`${requirement.label}缺少${requirement.lateKinds.join('/')}层级的因果证据`)
    }
  }

  const distinctDetailCount = new Set(proposals.map((beat) => normalizeCausalText(beat.detail))).size
  // A selected direction has to change both the pressure that stops the goal
  // and the later choice/change. This is stronger than counting keywords in
  // arbitrary sentences, while keeping the evidence inside the author's
  // reviewed, fact-grounded curve instead of adding a hidden explanation.
  if (missingEvidence.length || distinctDetailCount < Math.min(3, proposals.length)) {
    const diagnostics = [
      ...missingEvidence,
      ...(distinctDetailCount < Math.min(3, proposals.length)
        ? [`不同因果节点 ${distinctDetailCount}/${Math.min(3, proposals.length)}`]
        : []),
    ]
    return `提案没有在不同因果层级持续体现所选创意方向（${diagnostics.join('；')}）`
  }
  return undefined
}

function getDirectionEvidenceKinds(
  details: ReadonlyMap<CurveBeatKind, string>,
  kinds: readonly CurveBeatKind[],
  pattern: RegExp,
): CurveBeatKind[] {
  return kinds.filter((kind) => pattern.test(details.get(kind) ?? ''))
}

function getCreativeDirectionEvidenceRequirements(brief: CreativeBrief): CreativeDirectionEvidenceRequirement[] {
  const requirements: CreativeDirectionEvidenceRequirement[] = []
  const earlyPressureKinds: readonly CurveBeatKind[] = ['trigger', 'escalation']
  const lateChoiceKinds: readonly CurveBeatKind[] = ['climax-choice', 'resolution']

  for (const force of brief.dramaticForces) {
    switch (force) {
      case 'contrast':
        requirements.push({
          label: '戏剧力量「反差」',
          earlyKinds: earlyPressureKinds,
          // A bare marker such as "原有安排" is not evidence: it can be
          // pasted into an otherwise generic sentence. Require the marker to
          // participate in a visible obstruction/contrast relation instead.
          earlyPattern: /(?:反而|反倒|反过来)[^。！？；\n]{0,48}(?:停住|卡住|无法|不能|受限|取舍|推进)|(?:无法|不能|不再|暴露|卡住|停住)[^。！？；\n]{0,28}(?:已确认条件|原有安排|旧办法|旧路径|原本|原计划)|(?:已确认条件|原有安排|旧办法|旧路径|原本|原计划)[^。！？；\n]{0,28}(?:无法|不能|不再|暴露|局限|停住|卡住|推进)/u,
          earlyInstruction: '用“[作者条件]让[作者目标]无法按已确认条件推进”或“[作者条件]反而让[作者目标]停住”这类因果句，说明作者事实为何不能照旧推进',
          lateKinds: lateChoiceKinds,
          latePattern: /(?:不能再|不再|无法再)[^。！？；\n]{0,36}(?:按[^。！？；\n]{0,24}(?:继续|处理|推进)|沿用|照旧|依赖旧办法)|(?:已确认条件|原有安排|旧办法|旧路径|原本|原计划)[^。！？；\n]{0,28}(?:不再照旧|不能继续|暴露局限|选择|取舍|保留|放弃)|(?:反而|反倒|调整)[^。！？；\n]{0,48}(?:选择|判断|处理|推进|目标)/u,
          lateInstruction: '用“[作者目标]不能再按[作者条件]继续”或“调整[作者目标]在[作者条件]下的处理方式”这类因果句，说明选择怎样改变原路径',
        })
        break
      case 'cost':
        requirements.push({
          label: '戏剧力量「代价」',
          earlyKinds: earlyPressureKinds,
          earlyPattern: /代价|放弃|牺牲|承担|交换|两难|两全|失去|保留|取舍/u,
          earlyInstruction: '代价、承担、放弃、失去、保留或取舍之一，说明继续目标会失去什么',
          lateKinds: lateChoiceKinds,
          // A concrete two-sided choice is itself an auditable cost signal.
          // Models often write "在 A 与 B 之间选择" rather than repeat the
          // abstract word "代价"; both sides still have to be present.
          latePattern: /代价|放弃|牺牲|承担|交换|两难|两全|失去|保留|取舍|(?:在|必须在)[^。！？；\n]{1,48}(?:与|还是)[^。！？；\n]{1,48}(?:之间)?(?:选择|取舍)|(?:选择|取舍)[^。！？；\n]{0,48}(?:代价|承担|放弃|失去|保留)/u,
          lateInstruction: '代价、承担、放弃、失去、保留或取舍之一，说明选择由谁承担',
        })
        break
      case 'misunderstanding':
        requirements.push({
          label: '戏剧力量「误会」',
          earlyKinds: earlyPressureKinds,
          earlyPattern: /误会|误解|信息|疑问|猜测|不一致|弄清|缺口/u,
          earlyInstruction: '误会、信息、疑问、猜测、不一致或缺口之一，说明什么尚未被同样理解',
          lateKinds: lateChoiceKinds,
          latePattern: /澄清|解释|理解|误会|误解|信息|疑问/u,
          lateInstruction: '澄清、解释、理解、误会、信息或疑问之一，说明选择如何处理理解差异',
        })
        break
      case 'surprise':
        requirements.push({
          label: '戏剧力量「意外」',
          earlyKinds: earlyPressureKinds,
          earlyPattern: /意外|突然|新条件|变化|时机|失效|反常|打断|转变/u,
          earlyInstruction: '意外、新条件、变化、时机、反常、打断或失效之一，说明原安排如何被打断',
          lateKinds: lateChoiceKinds,
          latePattern: /转变|失效|重新|变化|改变|调整|新条件/u,
          lateInstruction: '转变、失效、重新、变化、改变、调整或新条件之一，说明选择如何回应变化',
        })
        break
      case 'relationship-tension':
        requirements.push({
          label: '戏剧力量「关系拉扯」',
          earlyKinds: earlyPressureKinds,
           // Treat the author's concrete commitment/relationship wording as
           // evidence too. Requiring only abstract labels such as "承诺" or
           // "关系" rejected valid model sentences like "她答应不再改动作品"
           // even though the source fact was copied verbatim.
           earlyPattern: /承诺|答应|约定|保证|不再|关系|信任|分歧|边界|前队友|姐姐|姐妹|哥哥|弟弟|妹妹|队友|伙伴/u,
          earlyInstruction: '承诺、关系、信任、分歧、边界或已确认关系对象之一，说明目标受到的牵制',
          lateKinds: lateChoiceKinds,
           latePattern: /承诺|答应|约定|保证|不再|关系|信任|回应|分歧|边界|前队友|共同|姐姐|姐妹|哥哥|弟弟|妹妹|队友|伙伴/u,
          lateInstruction: '回应、关系、信任、分歧、边界、共同或已确认关系对象之一，说明选择如何承担关系后果',
        })
        break
    }
  }

  for (const tone of brief.tones) {
    switch (tone) {
      case 'growth':
        requirements.push({
          label: '故事感觉「成长」',
          earlyKinds: ['climax-choice'],
          earlyPattern: /选择|承担|承认|放下|接受|重新/u,
          earlyInstruction: '选择、承担、承认、放下、接受或重新之一，说明主角主动怎么决定',
          lateKinds: ['resolution'],
          latePattern: /改变|成长|理解|学会|调整|重新/u,
          lateInstruction: '改变、成长、理解、学会、调整或重新之一，说明选择带来怎样的变化',
        })
        break
      case 'friendship':
        requirements.push({
          label: '故事感觉「友情」',
          earlyKinds: earlyPressureKinds,
          earlyPattern: /朋友|信任|友情|同行|伙伴|家人|姐姐|姐妹|哥哥|弟弟|妹妹|队友|协作|共同|一起|彼此|并肩|关系/u,
          earlyInstruction: '朋友、信任、伙伴、家人、队友、共同、彼此或已确认关系对象之一，说明共同目标如何受阻',
          lateKinds: lateChoiceKinds,
          latePattern: /朋友|信任|友情|同行|伙伴|家人|姐姐|姐妹|哥哥|弟弟|妹妹|队友|协作|共同|一起|彼此|并肩|关系|回应/u,
          lateInstruction: '朋友、信任、伙伴、家人、队友、共同、彼此、关系或回应之一，说明选择如何改变共同处境',
        })
        break
      case 'romance':
        requirements.push({
          label: '故事感觉「恋爱」',
          earlyKinds: earlyPressureKinds,
          earlyPattern: /心意|喜欢|恋爱|告白|关系|回应/u,
          earlyInstruction: '心意、喜欢、关系或回应之一，说明目标为何牵动关系',
          lateKinds: lateChoiceKinds,
          latePattern: /心意|喜欢|恋爱|告白|关系|回应|理解/u,
          lateInstruction: '心意、喜欢、关系、回应或理解之一，说明选择如何处理心意',
        })
        break
      case 'mystery':
        requirements.push({
          label: '故事感觉「悬疑」',
          earlyKinds: earlyPressureKinds,
          earlyPattern: /信息|疑问|真相|解释|缺口|不一致/u,
          earlyInstruction: '信息、疑问、真相、解释、缺口或不一致之一，说明什么尚未确定',
          lateKinds: lateChoiceKinds,
          latePattern: /信息|疑问|真相|解释|缺口|澄清|理解/u,
          lateInstruction: '信息、疑问、真相、解释、缺口、澄清或理解之一，说明选择怎样面对未知',
        })
        break
      case 'comedy':
        requirements.push({
          label: '故事感觉「搞笑」',
          earlyKinds: earlyPressureKinds,
          earlyPattern: /尴尬|体面|笑|反差/u,
          earlyInstruction: '尴尬、体面、笑或反差之一，说明目标为何卡住',
          lateKinds: lateChoiceKinds,
          latePattern: /尴尬|体面|笑|反差/u,
          lateInstruction: '尴尬、体面、笑或反差之一，说明选择怎样带来不同后果',
        })
        break
      case 'warm':
        requirements.push({
          label: '故事感觉「温暖」',
          earlyKinds: earlyPressureKinds,
          earlyPattern: /理解|照顾|温暖|彼此|回应|关系/u,
          earlyInstruction: '理解、照顾、彼此、回应或关系之一，说明目标为何牵动彼此',
          lateKinds: lateChoiceKinds,
          latePattern: /理解|照顾|温暖|彼此|回应|关系/u,
          lateInstruction: '理解、照顾、彼此、回应或关系之一，说明选择怎样留下关系变化',
        })
        break
      case 'fantasy':
        requirements.push({
          label: '故事感觉「奇幻」',
          earlyKinds: earlyPressureKinds,
          earlyPattern: /规则|边界|奇幻|魔法|未知/u,
          earlyInstruction: '规则、边界、奇幻、魔法或未知之一，说明哪项已确认条件发生偏移',
          lateKinds: lateChoiceKinds,
          latePattern: /规则|边界|奇幻|魔法|未知|改变/u,
          lateInstruction: '规则、边界、奇幻、魔法、未知或改变之一，说明选择如何回应偏移',
        })
        break
    }
  }

  return requirements
}

function hasStableCreativeDirection(beats: readonly CurveBeat[], brief: CreativeBrief): boolean {
  return !getCreativeDirectionValidationFailure(beats, brief)
}

function parseModelCurveFoundation(value: unknown): StoryCurveFoundation | undefined {
  if (!isRecord(value)) return undefined
  const conflictCore = isRecord(value.conflictCore) ? value.conflictCore : undefined
  const predicament = isRecord(value.predicament) ? value.predicament : undefined
  const middleDevelopment = isRecord(value.middleDevelopment) ? value.middleDevelopment : undefined
  const storyEnds = isRecord(value.storyEnds) ? value.storyEnds : undefined
  const approach = isRecord(value.approach) ? value.approach : undefined
  if (!conflictCore || !predicament || !middleDevelopment || !storyEnds || !approach) return undefined
  const read = (record: Record<string, unknown>, key: string): string | undefined => (
    typeof record[key] === 'string' && record[key].trim() ? record[key].trim() : undefined
  )
  const variationAxis = predicament.variationAxis
  if (variationAxis !== 'time' && variationAxis !== 'resource' && variationAxis !== 'relationship' && variationAxis !== 'commitment') return undefined
  const required = [
    read(conflictCore, 'goal'), read(conflictCore, 'obstacle'), read(conflictCore, 'tradeoff'),
    read(value, 'preservedGoal'), read(predicament, 'title'), read(predicament, 'immediateSituation'),
    read(predicament, 'obstacle'), read(predicament, 'tradeoff'), read(predicament, 'urgency'),
    read(predicament, 'choice'), read(predicament, 'plausibleCost'), read(middleDevelopment, 'escalation'),
    read(middleDevelopment, 'midpoint'), read(middleDevelopment, 'climaxPressure'), read(storyEnds, 'opening'),
    read(storyEnds, 'openingClue'), read(storyEnds, 'climax'), read(storyEnds, 'resolution'),
    read(storyEnds, 'cost'), read(storyEnds, 'promise'), read(approach, 'intent'), read(approach, 'cost'),
  ]
  if (required.some((text) => !text)) return undefined
  return {
    conflictCore: {
      goal: required[0]!,
      obstacle: required[1]!,
      tradeoff: required[2]!,
    },
    preservedGoal: required[3]!,
    predicament: {
      title: required[4]!,
      variationAxis,
      immediateSituation: required[5]!,
      obstacle: required[6]!,
      tradeoff: required[7]!,
      urgency: required[8]!,
      choice: required[9]!,
      plausibleCost: required[10]!,
    },
    middleDevelopment: {
      escalation: required[11]!,
      midpoint: required[12]!,
      climaxPressure: required[13]!,
    },
    storyEnds: {
      opening: required[14]!,
      openingClue: required[15]!,
      climax: required[16]!,
      resolution: required[17]!,
      cost: required[18]!,
      promise: required[19]!,
    },
    approach: {
      intent: required[20]!,
      cost: required[21]!,
    },
  }
}

function normalizeProposalForComparison(value: string): string {
  return value
    .replace(/^暂定[：:]/u, '')
    .replace(/[“”"']/gu, '')
    .replace(/\s+/gu, '')
    .trim()
}

function repeatsExcludedProposal(detail: string, excludedProposalDetails: readonly string[]): boolean {
  const normalizedDetail = normalizeProposalForComparison(detail)
  if (normalizedDetail.length < 12) return false
  return excludedProposalDetails
    .map(normalizeProposalForComparison)
    .filter((value) => value.length >= 12)
    .some((excluded) => normalizedDetail === excluded || normalizedDetail.includes(excluded) || excluded.includes(normalizedDetail))
}

function parseSourceFactIds(value: unknown, design: StoryDesignRecord): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return undefined
  const availableIds = new Set(design.sourceFacts.map((fact) => fact.id))
  const ids = value.filter((candidate): candidate is string => (
    typeof candidate === 'string' && availableIds.has(candidate)
  ))
  if (ids.length !== value.length || new Set(ids).size !== ids.length) return undefined
  return ids
}

function parseDependencies(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 3) return undefined
  const allowedIds = new Set(curveBeatKinds.map((kind) => `beat-${kind}`))
  const ids = value.filter((candidate): candidate is string => typeof candidate === 'string' && allowedIds.has(candidate))
  if (ids.length !== value.length || new Set(ids).size !== ids.length) return undefined
  return ids
}

function normalizeCurveDependencies(beats: CurveBeat[]): CurveBeat[] {
  const ids = new Set(beats.map((beat) => beat.id))
  return beats.map((beat, index) => {
    const priorIds = new Set(beats.slice(0, index).map((candidate) => candidate.id))
    const dependencies = beat.dependsOn.filter((dependency) => (
      dependency !== beat.id && ids.has(dependency) && priorIds.has(dependency)
    ))
    return {
      ...beat,
      dependsOn: dependencies.length
        ? dependencies
        : index === 0 ? [] : [beats[index - 1]!.id],
    }
  })
}

function parseRegeneratedBeatDetail(
  value: unknown,
  kind: CurveBeatKind,
  brief: CreativeBrief,
  seed: StorySeed,
  curve: ProvisionalCurve,
  target: CurveBeat,
): string | undefined {
  if (!isRecord(value)) return undefined
  const detail = readOptionalText(value.detail, maximumModelCurveBeatLength)
  if (
    !detail
    || (!brief.allowSystemNamedCharacters && hasNewNamedCharacter(detail, seed))
    || !isCurveDetailGroundedToContext(detail, seed, curve, target)
    || !isSystemCurveProposalSafe(
      kind,
      detail,
      curve.design?.sourceFacts
        .filter((fact) => fact.disposition !== 'parked')
        .map((fact) => fact.text) ?? [],
    )
    || repeatsFullUpstreamDetail(detail, curve, target)
    || hasNestedCurveQuotes(detail)
    || hasUnboundGenericCausalPhrase(detail)
    || repeatsRejectedProposal(detail, curve)
  ) return undefined
  return detail
}

function repeatsFullUpstreamDetail(
  detail: string,
  curve: ProvisionalCurve,
  target: CurveBeat,
): boolean {
  const normalizedDetail = normalizeCausalText(detail)
  if (normalizedDetail.length < 18) return false
  return curve.beats
    .filter((beat) => target.dependsOn.includes(beat.id) && beat.status !== 'rejected')
    .map((beat) => normalizeCausalText(beat.detail))
    .filter((upstream) => upstream.length >= 18)
    .some((upstream) => normalizedDetail.includes(upstream))
}

function hasNestedCurveQuotes(detail: string): boolean {
  return /“[^”]*“[^”]*”[^”]*”/u.test(detail)
    || /"[^"]*"[^"]*"/u.test(detail)
}

function hasUnboundGenericCausalPhrase(detail: string): boolean {
  // These phrases are acceptable only when they name the concrete object
  // immediately around them. A bare occurrence turns a regeneration into a
  // vague template and gives the next beat nothing causal to inherit.
  return /(?:更重要的事|承担代价)(?:[，。！？；]|$)/u.test(detail)
    || /(?:出现新的结果|发生可见变化)(?:[，。！？；]|$)/u.test(detail)
}

function normalizeCausalText(value: string): string {
  return value
    .replace(/^暂定[：:]/u, '')
    .replace(/[“”"']/gu, '')
    .replace(/\s+/gu, '')
    .trim()
}

/**
 * Fact grounding alone cannot catch a model that repeats the locked goal
 * inside one clause or drops the subject after a causal connector. Reject
 * those malformed templates before they become visible curve proposals.
 */
function getModelCurveTextQualityIssue(
  kind: CurveBeatKind,
  detail: string,
  seed: Pick<StorySeed, 'lockedGoal'>,
): string | undefined {
  const normalizedGoal = normalizeCausalText(seed.lockedGoal ?? '')
  const goalAnchor = getModelGoalAnchor(seed.lockedGoal ?? '')
  if (
    (normalizedGoal.length >= 6 && countCausalPhraseOccurrences(detail, normalizedGoal) > 1)
    || (goalAnchor.length >= 6 && countCausalPhraseOccurrences(detail, goalAnchor) > 1)
  ) {
    return '重复嵌套锁定目标，形成整句复述；请只保留一次目标锚点'
  }

  if (/(?:让|使)(?:想|要|希望|准备|不知道|和|与|在)/u.test(detail)) {
    return '使用了缺少明确主体的模板化因果连接；请写出主角后再承接目标'
  }

  // A leading deadline already supplies the preposition. “必须在在周五前”
  // is a mechanical template splice, not a meaningful causal distinction.
  if (/(?:必须在|选择在|继续在)在/u.test(detail)) {
    return '重复拼接了时间前缀；请不要生成“在在”式目标'
  }

  if (kind === 'resolution' && /(?:重新理解|重新判断)[^，。！？；\n]{0,24}(?:要不要|是否|想)/u.test(detail)) {
    return '把作者的选择问题递归包成理解结论；请直接写目标在事实条件下如何调整'
  }

  return undefined
}

function countCausalPhraseOccurrences(value: string, phrase: string): number {
  const normalizedValue = normalizeCausalText(value)
  const normalizedPhrase = normalizeCausalText(phrase)
  if (!normalizedValue || !normalizedPhrase) return 0

  let count = 0
  let offset = 0
  while (offset <= normalizedValue.length - normalizedPhrase.length) {
    const index = normalizedValue.indexOf(normalizedPhrase, offset)
    if (index < 0) break
    count += 1
    offset = index + normalizedPhrase.length
  }
  return count
}

/** Return a contiguous action fragment without the goal's deadline wrapper. */
function getModelGoalAnchor(value: string): string {
  let normalized = value
    .trim()
    .replace(/^(?:当前(?:目标|想法)[：:]\s*)/u, '')
    .replace(/^(?:想要|想|希望|打算|准备|计划)\s*/u, '')
  normalized = normalized
    .replace(/^在[^，。！？；\n]{1,24}前(?=(?:把|将|去|看|提交|参加|寻找|归还|离开|决定|选择|判断))/u, '')
    .replace(/^于[^，。！？；\n]{1,24}(?=(?:把|将|去|看|提交|参加|寻找|归还|离开|决定|选择|判断))/u, '')
  const decision = normalized.match(/(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  // The deadline/decision wrapper belongs to the source fact.  The compact
  // handle is only the action that can be embedded after a causal verb; keeping
  // “要不要” here made models produce awkward forms such as “推进要不要删…”.
  if (decision?.[1]?.trim()) return decision[1].trim()
  return normalized || value.trim()
}

function repeatsRejectedProposal(detail: string, curve: ProvisionalCurve): boolean {
  const normalizedDetail = detail.replace(/^暂定[：:]/u, '').replace(/[“”"']/gu, '').trim()
  if (normalizedDetail.length < 12) return false
  return [
    ...curve.beats.filter((beat) => beat.status === 'rejected' && beat.source === 'system-proposal'),
    ...(curve.rejectedProposals ?? []),
  ]
    .some((beat) => {
      const rejected = beat.detail.replace(/^暂定[：:]/u, '').replace(/[“”"']/gu, '').trim()
      return rejected.length >= 12 && normalizedDetail.includes(rejected)
    })
}

function isCurveDetailGroundedToContext(
  detail: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  target: CurveBeat,
): boolean {
  if (isCurveDetailGroundedToSeed(detail, seed)) return true
  const upstreamTexts = curve.beats
    .filter((beat) => target.dependsOn.includes(beat.id) && beat.status !== 'rejected')
    .map((beat) => beat.detail)
  const sourceFactTexts = curve.design?.sourceFacts
    .filter((fact) => fact.disposition !== 'parked')
    .map((fact) => fact.text) ?? []
  return [...upstreamTexts, ...sourceFactTexts]
    .flatMap(getGroundingFragments)
    .some((fragment) => detail.includes(fragment))
}

function getGroundingFragments(value: string): string[] {
  const compact = value.replace(/^暂定[：:]/u, '').replace(/[^\p{L}\p{N}]/gu, '')
  if (compact.length < 3) return []
  const fragments = new Set<string>()
  const size = Math.min(6, compact.length)
  for (let start = 0; start + size <= compact.length; start += Math.max(1, size - 2)) {
    fragments.add(compact.slice(start, start + size))
  }
  return [...fragments]
}

export function isSystemCurveProposalSafe(
  kind: CurveBeatKind,
  detail: string,
  authorSourceFacts: readonly string[] = [],
): boolean {
  return !getCurveProposalSafetyFailure(kind, detail, authorSourceFacts)
}

function getCurveBeatTitle(kind: CurveBeatKind): string {
  const titles: Record<CurveBeatKind, string> = {
    'current-state': '此刻想要什么',
    'character-tension': '人物的矛盾',
    trigger: '让目标停住的钩子',
    escalation: '阻碍开始升级',
    'midpoint-turn': '中段转折',
    'climax-choice': '高潮时的选择与代价',
    resolution: '结局中的变化',
  }
  return titles[kind]
}

function isCurveGroundedToSeed(beats: readonly CurveBeat[], seed: StorySeed): boolean {
  const proposalBeats = beats.filter((beat) => beat.kind !== 'current-state')
  const anchors = getCurveAnchorTerms(seed)
  const groundedBeatCount = proposalBeats.filter((beat) => (
    (beat.sourceFactIds?.length ?? 0) > 0
      || anchors.some((anchor) => beat.detail.includes(anchor))
  )).length
  return groundedBeatCount >= Math.min(2, proposalBeats.length)
}

function isCurveDetailGroundedToSeed(detail: string, seed: StorySeed): boolean {
  return getCurveAnchorTerms(seed).some((anchor) => detail.includes(anchor))
}

function getCurveAnchorTerms(seed: StorySeed): string[] {
  const genericTerms = new Set(['主角', '故事', '目标', '当前', '此刻', '事情', '东西', '一个', '这件'])
  const anchors = [...new Set([
    seed.subject,
    seed.lockedGoal ?? '',
    ...seed.lockedFacts,
  ])]
    .map((value) => value.trim())
    .filter((value) => value.length >= 2)
  const terms = new Set(anchors.filter((anchor) => !genericTerms.has(anchor)))

  for (const anchor of anchors) {
    for (const segment of anchor.match(/[A-Za-z0-9]+|[\u4e00-\u9fff]+/g) ?? []) {
      if (/^[\u4e00-\u9fff]+$/u.test(segment)) {
        const maximumLength = Math.min(4, segment.length)
        for (let length = maximumLength; length >= 2; length -= 1) {
          for (let start = 0; start + length <= segment.length; start += 1) {
            const candidate = segment.slice(start, start + length)
            if (!genericTerms.has(candidate)) terms.add(candidate)
          }
        }
      } else if (segment.length >= 2 && !genericTerms.has(segment)) {
        terms.add(segment)
      }
    }
  }

  return [...terms]
}

function createReplacementDetail(
  idea: string,
  kind: CurveBeatKind,
  seed: StorySeed,
  brief: CreativeBrief,
  curve: ProvisionalCurve,
  target: CurveBeat,
): string {
  const subject = getStorySubject(seed)
  const goal = getStoryGoal(seed, seed.activeSituation)
  const relatedFact = curve.design?.sourceFacts.find((fact) => target.sourceFactIds?.includes(fact.id))?.text
    ?? curve.design?.sourceFacts.find((fact) => fact.disposition !== 'parked')?.text
    ?? goal
  // Carry only the nearest causal consequence forward. This gives the first
  // dependent beat the author's edit, then lets each later beat advance the
  // consequence instead of repeatedly quoting the original edit.
  const premise = getCausalAnchor(curve, target, relatedFact)
  const storyMaterial = deriveFallbackStoryMaterial(
    idea,
    seed,
    curve.design?.sourceFacts.filter((fact) => fact.disposition !== 'parked') ?? [],
  )
  switch (kind) {
    case 'current-state':
      return getCurrentState(seed, seed.activeSituation)
    case 'character-tension':
      return getFallbackTension(subject, goal, brief, relatedFact, storyMaterial)
    case 'trigger':
      return getFallbackTriggerDetail(subject, goal, brief, relatedFact, storyMaterial)
    case 'escalation':
      return getFallbackEscalation(subject, goal, brief, premise, storyMaterial)
    case 'midpoint-turn':
      return getFallbackMidpointTurn(subject, goal, brief, premise, storyMaterial)
    case 'climax-choice':
      return getFallbackClimaxChoice(subject, goal, brief, premise, storyMaterial)
    case 'resolution':
      return getFallbackResolution(subject, goal, brief, premise, storyMaterial)
  }
}

function getFallbackTension(subject: string, goal: string, brief: CreativeBrief, material: string, storyMaterial?: FallbackStoryMaterial): string {
  const hasMaterial = !isPlaceholderMaterial(material, goal)
  const commitmentSource = storyMaterial?.commitment ?? material
  const hasCommitment = !isPlaceholderMaterial(commitmentSource, goal)
  const anchor = hasMaterial ? getConcreteMaterialHandle(material, goal, brief) : getDirectionAnchor(brief, goal)
  const goalPhrase = getGoalPhrase(goal)
  const goalDecision = getGoalDecisionPhrase(goal)
  const goalObject = getGoalObject(goal)
  const goalAction = getWantGoal(goal)
  const commitment = hasCommitment
    ? getConcreteMaterialHandle(commitmentSource, goal, brief)
    : getDirectionAnchor(brief, goal)
  const tone = getToneCausalClause(brief, 'tension')
  if (storyMaterial && hasConcreteFallbackMaterial(storyMaterial.observed, goal)) {
    const observed = getConcreteMaterialHandle(storyMaterial.observed, goal, brief)
    if (brief.dramaticForces.includes('relationship-tension') && hasConcreteFallbackMaterial(storyMaterial.commitment, goal)) {
      return `暂定：${observed}让${subject}原本的安排出现缺口，而${commitment}把这项帮忙变成必须回应的承诺；${tone}。`
    }
    switch (brief.dramaticForces[0]) {
      case 'misunderstanding':
        return `暂定：${observed}让${subject}无法确定这段材料究竟意味着什么；不同理解会把${goalDecision}带向不同方向；${tone}。`
      case 'cost':
        return `暂定：${observed}让${subject}发现，继续${goalPhrase}必须先拿一项眼前条件来交换；${tone}。`
      case 'surprise':
        return `暂定：${observed}打断了${subject}原本对${goalPhrase}的准备，原计划缺少一个关键条件；${tone}。`
      case 'contrast':
        return `暂定：${observed}暴露出${subject}最依赖的办法并不能直接支持${goalPhrase}；${tone}。`
      default:
        break
    }
    return `暂定：${observed}暴露出${subject}原本办法的缺口；${subject}仍要${goalPhrase}，却不能再假装条件齐全；${tone}。`
  }
  if (brief.dramaticForces.includes('relationship-tension')) {
    return `暂定：${subject}${goalAction}，但“${commitment}”使已经说出的承诺与现在的选择无法同时成立；${tone}`
  }
  if (brief.dramaticForces.includes('contrast')) {
    if (brief.tones.includes('mystery')) {
      return `暂定：${anchor}让${subject}无法只凭表面判断是否${getGoalObject(goal)}；信息缺口开始拖住${goalPhrase}。`
    }
    if (brief.tones.includes('growth')) {
      if (!hasMaterial && !hasCommitment) {
        return `暂定：${subject}想${goalPhrase}，却还没有决定是否由自己承担这次选择；${tone}`
      }
      return `暂定：${anchor}让${subject}原来依赖的做法露出局限；要${goalPhrase}就得重新承担${commitment}。`
    }
    if (brief.tones.includes('comedy')) {
      return `暂定：${anchor}让${subject}越想维持体面，越容易暴露原来办法的漏洞；${goalPhrase}因此不能照旧进行。`
    }
    return `暂定：${anchor}让${subject}原本最有把握的做法露出局限，继续照做反而会拖住${goalPhrase}；${tone}`
  }
  return `暂定：${subject}面对${anchor}仍${goalAction}，却必须先承认这件事会改变自己愿意承担的范围；${tone}`
}

function getFallbackTriggerDetail(subject: string, goal: string, brief: CreativeBrief, material: string, storyMaterial?: FallbackStoryMaterial): string {
  const hasMaterial = !isPlaceholderMaterial(material, goal)
  const commitmentSource = storyMaterial?.commitment ?? material
  const hasCommitment = !isPlaceholderMaterial(commitmentSource, goal)
  const anchor = hasMaterial ? getConcreteMaterialHandle(material, goal, brief) : getDirectionAnchor(brief, goal)
  const goalPhrase = getGoalPhrase(goal)
  const goalDecision = getGoalDecisionPhrase(goal)
  const goalAction = getWantGoal(goal)
  const commitment = hasCommitment
    ? getConcreteMaterialHandle(commitmentSource, goal, brief)
    : getDirectionAnchor(brief, goal)
  const tone = getToneCausalClause(brief, 'trigger')
  const force = brief.dramaticForces[0]
  if (storyMaterial && hasConcreteFallbackMaterial(storyMaterial.deadline, goal)) {
    const deadline = getConcreteMaterialHandle(storyMaterial.deadline, goal, brief)
    switch (force) {
      case 'misunderstanding':
        return `暂定：“${deadline}”让${subject}对${goalDecision}的理解出现分歧；在澄清前，原计划不能照常推进；${tone}。`
      case 'cost':
        return `暂定：“${deadline}”把${goalDecision}变成时间与${commitment}之间的取舍；继续${goalPhrase}会先消耗一项条件；${tone}。`
      case 'surprise':
        return `暂定：“${deadline}”提前压缩了${subject}处理${goalDecision}的时间；原来安排的缓冲被意外拿走；${tone}。`
      case 'relationship-tension':
        return `暂定：“${deadline}”让${subject}必须同时回应${commitment}和${goalDecision}，拖延会先伤到关系；${tone}。`
      case 'contrast':
      default:
        return `暂定：“${deadline}”暴露出${subject}原来以为足够的准备并不够；${goalDecision}不能照旧进行；${tone}。`
    }
  }
  switch (force) {
    case 'misunderstanding':
      return `暂定：${anchor}中的关键信息尚未被同样理解，让${subject}${goalAction}的原计划停住；${tone}`
    case 'cost':
      return `暂定：${anchor}让${subject}发现继续${goalPhrase}会直接牺牲${commitment}所代表的条件；${tone}`
    case 'surprise':
      return `暂定：${anchor}改变了${subject}原本依赖的条件，迫使其重新判断是否继续${goalPhrase}；${tone}`
    case 'relationship-tension':
      return `暂定：${anchor}让${subject}不能把${getGoalObject(goal)}与已经说出的承诺分开处理，拖延会留下关系上的代价；${tone}`
    case 'contrast':
    default:
      if (brief.tones.includes('mystery')) {
        return `暂定：${anchor}留下一个不能立即解释的信息缺口，${subject}若继续${goalPhrase}就得先决定相信哪部分；信息仍交给作者确认。`
      }
      if (brief.tones.includes('growth')) {
        if (!hasMaterial && !hasCommitment) {
          return `暂定：${subject}要${goalPhrase}，必须先说明这次选择由谁负责；${tone}`
        }
        return `暂定：${anchor}让${subject}不能把${getGoalObject(goal)}和${commitment}分开处理，拖延会缩小${subject}重新选择的空间。`
      }
      if (brief.tones.includes('comedy')) {
        return `暂定：${anchor}把${subject}想维持的体面变成公开风险，继续${goalPhrase}不再只是照原计划行动。`
      }
      return `暂定：${anchor}让${subject}最擅长的办法恰好变成继续${goalPhrase}的新阻碍；${tone}`
  }
}

function getFallbackEscalation(subject: string, goal: string, brief: CreativeBrief, material: string, storyMaterial?: FallbackStoryMaterial): string {
  const hasMaterial = !isPlaceholderMaterial(material, goal)
  const commitmentSource = storyMaterial?.commitment ?? material
  const hasCommitment = !isPlaceholderMaterial(commitmentSource, goal)
  const anchor = hasMaterial ? getConcreteMaterialHandle(material, goal, brief) : getDirectionAnchor(brief, goal)
  const goalPhrase = getGoalPhrase(goal)
  const goalObject = getGoalObject(goal)
  const commitment = hasCommitment
    ? getConcreteMaterialHandle(commitmentSource, goal, brief)
    : getDirectionAnchor(brief, goal)
  const commitmentEvidence = hasCommitment
    ? getCommitmentEvidence(commitment, goal, brief)
    : `由${subject}承担这次选择`
  const goalDecision = getGoalDecisionPhrase(goal)
  const progression = getProgressionAnchor(material, storyMaterial, goal, brief, commitment)
  const tone = getToneCausalClause(brief, 'escalation')
  if (storyMaterial && hasConcreteFallbackMaterial(storyMaterial.commitment, goal)) {
    const commitmentLabel = getConcreteMaterialHandle(storyMaterial.commitment, goal, brief)
    switch (brief.dramaticForces[0]) {
      case 'misunderstanding':
        return `暂定：“${commitmentLabel}”与${subject}对${goalDecision}的理解不一致；继续推进会把误会扩大到下一步；${tone}。`
      case 'cost':
        return `暂定：“${commitmentLabel}”要求${subject}在${goalDecision}和一项已承诺条件之间先放弃其一；代价开始具体；${tone}。`
      case 'surprise':
        return `暂定：“${commitmentLabel}”把${goalDecision}推向原计划没有预留的条件；越拖越难回到原办法；${tone}。`
      case 'relationship-tension':
        return `暂定：“${commitmentLabel}”让${subject}不能同时兑现承诺和${goalDecision}；回避本身会让关系失去退路；${tone}。`
      case 'contrast':
      default:
        return `暂定：“${commitmentLabel}”让${subject}最依赖的办法反而卡住${goalDecision}；继续拖延会迫使${subject}承认旧办法失效；${tone}。`
    }
  }
  switch (brief.dramaticForces[0]) {
    case 'misunderstanding':
      return `暂定：${anchor}的含义迟迟无法确认，${subject}若继续${goalPhrase}，就必须先决定是否公开自己的理解；${tone}`
    case 'cost':
      return `暂定：${commitmentEvidence}使${subject}不能同时保住${goalPhrase}和眼前条件，${anchor}把代价具体化；${tone}`
    case 'surprise':
      return `暂定：${anchor}改变了原本可用的条件，${subject}必须在变化扩大前重新安排${goalPhrase}的取舍；${tone}`
    case 'relationship-tension':
      return `暂定：${commitmentEvidence}让${subject}继续${goalPhrase}时必须先回应${progression}，回避本身会让关系失去退路；${tone}`
    case 'contrast':
    default:
      if (brief.tones.includes('mystery')) {
        return `暂定：${progression}的不同解释会把${subject}带向不同决定；她不能一边保留信息缺口，一边照旧${goalPhrase}。`
      }
      if (brief.tones.includes('growth')) {
        if (!hasMaterial && !hasCommitment) {
          return `暂定：${subject}继续${goalPhrase}时，必须在照原安排进行与自己承担这次选择之间取舍；回避会让两边都失去空间。`
        }
        return `暂定：${commitmentEvidence}使${subject}必须在兑现承诺与${getGoalObject(goal)}之间取舍；继续回避会让${progression}两边都失去空间。`
      }
      if (brief.tones.includes('comedy')) {
        return `暂定：${progression}证明旧办法只能延后尴尬，${subject}若继续${goalPhrase}就得先承认自己无法同时保住体面和目标。`
      }
      return `暂定：${progression}让${subject}最依赖的办法反而卡住${goalPhrase}，必须承认原来的强项解决不了这次问题；${tone}`
  }
}

function getFallbackMidpointTurn(subject: string, goal: string, brief: CreativeBrief, material: string, storyMaterial?: FallbackStoryMaterial): string {
  const hasMaterial = !isPlaceholderMaterial(material, goal)
  const anchor = hasMaterial ? getConcreteMaterialHandle(material, goal, brief) : getDirectionAnchor(brief, goal)
  const goalPhrase = getGoalPhrase(goal)
  const goalObject = getGoalObject(goal)
  const commitmentSource = storyMaterial?.commitment ?? material
  const hasCommitment = !isPlaceholderMaterial(commitmentSource, goal)
  const commitment = hasCommitment
    ? getConcreteMaterialHandle(commitmentSource, goal, brief)
    : getDirectionAnchor(brief, goal)
  const progression = getProgressionAnchor(material, storyMaterial, goal, brief, commitment)
  const tone = getToneCausalClause(brief, 'midpoint')
  if (storyMaterial && hasConcreteFallbackMaterial(storyMaterial.decision, goal)) {
    const decision = getConcreteMaterialHandle(storyMaterial.decision, goal, brief)
    // A regenerated downstream node must advance the nearest causal
    // consequence. If `material` is the newly regenerated upstream anchor,
    // carry that compact handle instead of rebuilding the original decision
    // sentence unchanged.
    const propagatedDecision = getProgressionAnchor(material, storyMaterial, goal, brief, decision)
    const decisionObject = getGoalObject(propagatedDecision)
    const decisionLabel = propagatedDecision === decision ? decision : propagatedDecision
    switch (brief.dramaticForces[0]) {
      case 'misunderstanding':
        return `暂定：${subject}发现，对“${decisionLabel}”的不同理解会改变这项决定的后果；必须先选定自己相信的解释；${tone}。`
      case 'cost':
        return `暂定：${subject}发现，“${decisionLabel}”要求拿一项眼前条件换取${goalPhrase}；旧办法无法两全；${tone}。`
      case 'surprise':
        return `暂定：${subject}发现，“${decisionLabel}”把${goalPhrase}推向新的时机或资源条件；必须重排优先级；${tone}。`
      case 'relationship-tension':
        return `暂定：${subject}发现，若绕开${commitment}，“${decisionLabel}”即使完成也会留下关系裂痕；${tone}。`
      case 'contrast':
      default:
        return `暂定：${subject}发现，“${decisionObject}”让自己最熟悉的办法反而失去作用；要继续${goalPhrase}必须回应“${decisionLabel}”带来的新限制；${tone}。`
    }
  }
  switch (brief.dramaticForces[0]) {
    case 'misunderstanding':
      return `暂定：${subject}发现，围绕${anchor}继续猜测只会放大误解，必须决定要不要先承担澄清带来的风险；${tone}`
    case 'cost':
      return `暂定：${subject}发现，${anchor}要求放弃的条件正是自己想保住的部分，${goalPhrase}因此变成真正的取舍；${tone}`
    case 'surprise':
      return `暂定：${subject}发现，${anchor}带来的变化让原计划失效，必须重新判断还能依靠什么；${tone}`
    case 'relationship-tension':
      return `暂定：${subject}发现，若绕开${anchor}这项承诺，${goalPhrase}即使完成也会留下无法回避的关系裂痕；${tone}`
    case 'contrast':
    default:
      if (brief.tones.includes('mystery')) {
        return `暂定：${subject}发现，${progression}的不同解释会让${goalObject}导向不同结果；${subject}必须决定先保留哪条可能，而不是继续照旧${goalPhrase}。`
      }
      if (brief.tones.includes('growth')) {
        return `暂定：${subject}发现，真正要改变的不是${goalObject}，而是自己如何面对${progression}；旧办法已无法替${subject}作答。`
      }
      if (brief.tones.includes('comedy')) {
        return `暂定：${subject}发现，越想用熟悉办法维持体面，${progression}造成的尴尬越大；${subject}必须承认笑点背后有真实代价。`
      }
      return `暂定：${subject}发现，继续用最熟悉的办法处理${anchor}只能遮住问题，必须承认旧办法会失去什么；${tone}`
  }
}

function getFallbackClimaxChoice(subject: string, goal: string, brief: CreativeBrief, material: string, storyMaterial?: FallbackStoryMaterial): string {
  const hasMaterial = !isPlaceholderMaterial(material, goal)
  const anchor = hasMaterial ? getConcreteMaterialHandle(material, goal, brief) : getDirectionAnchor(brief, goal)
  const goalPhrase = getGoalPhrase(goal)
  const goalObject = getGoalObject(goal)
  const commitmentSource = storyMaterial?.commitment ?? material
  const hasCommitment = !isPlaceholderMaterial(commitmentSource, goal)
  const commitment = hasCommitment
    ? getConcreteMaterialHandle(commitmentSource, goal, brief)
    : getDirectionAnchor(brief, goal)
  const progression = getProgressionAnchor(material, storyMaterial, goal, brief, commitment)
  const tone = getToneCausalClause(brief, 'climax')
  if (storyMaterial && hasConcreteFallbackMaterial(storyMaterial.decision, goal)) {
    const decision = getConcreteMaterialHandle(storyMaterial.decision, goal, brief)
    const propagatedDecision = getProgressionAnchor(material, storyMaterial, goal, brief, decision)
    const decisionObject = getGoalObject(decision)
    const decisionLabel = propagatedDecision === decision ? decision : propagatedDecision
    const otherSide = hasConcreteFallbackMaterial(storyMaterial.commitment, goal)
      ? getConcreteMaterialHandle(storyMaterial.commitment, goal, brief)
      : `继续${goalPhrase}`
    switch (brief.dramaticForces[0]) {
      case 'misunderstanding':
        return `暂定：${subject}必须在${decisionObject}与先澄清“${otherSide}”之间作出选择；选择会决定“${decisionLabel}”依据哪种理解继续；${tone}。`
      case 'cost':
        return `暂定：${subject}必须在${decisionObject}与${otherSide}之间放弃一项条件；“${decisionLabel}”的代价不能再由别人承担；${tone}。`
      case 'surprise':
        return `暂定：${subject}必须在${decisionObject}与${otherSide}之间重排先后；“${decisionLabel}”带来的新条件会让其中一边失去原来的保障；${tone}。`
      case 'relationship-tension':
        return `暂定：${subject}必须在${decisionObject}与回应${otherSide}之间作出选择；“${decisionLabel}”不能靠沉默同时保住；${tone}。`
      case 'contrast':
      default:
        return `暂定：${subject}必须在${decisionObject}与${otherSide}之间作出选择；要继续${goalPhrase}，就得回应“${decisionLabel}”而不能照旧；${tone}。`
    }
  }
  switch (brief.dramaticForces[0]) {
    case 'misunderstanding':
      return `暂定：面对${anchor}，${subject}必须选择公开自己的判断并承担被误解的风险，还是保留${goalPhrase}却让信息缺口继续存在；${tone}`
    case 'cost':
      return `暂定：面对${anchor}，${subject}必须明确放弃一项眼下条件，才可能继续${goalPhrase}；${tone}`
    case 'surprise':
      return `暂定：面对${anchor}造成的新条件，${subject}必须主动舍弃原计划的一部分，换取继续${goalPhrase}的可能；${tone}`
    case 'relationship-tension':
      return `暂定：面对${anchor}，${subject}必须选择先兑现${commitment}，还是明确改变它来继续${goalPhrase}；${tone}`
    case 'contrast':
    default:
      if (brief.tones.includes('mystery')) {
        return `暂定：面对${progression}，${subject}必须选择先按已知信息作出${goalObject}的决定，还是保留疑问并承担延误；两边都不能由别人代替。`
      }
      if (brief.tones.includes('growth')) {
        if (!hasMaterial && !hasCommitment) {
          return `暂定：面对这次${goalPhrase}，${subject}必须选择照原安排继续，还是先说清自己真正要承担的决定；两种选择都会留下可辨认的代价。`
        }
        return `暂定：面对${progression}，${subject}必须选择兑现承诺而暂缓${goalObject}，还是明确改变承诺后继续${goalPhrase}；两边都要承担责任。`
      }
      if (brief.tones.includes('comedy')) {
        return `暂定：面对${progression}，${subject}必须选择继续维护体面，还是主动承认尴尬并推进${goalPhrase}；选择会留下不同的关系代价。`
      }
      return `暂定：面对${anchor}，${subject}必须放下最擅长也最省事的办法，以另一种方式继续${goalPhrase}；${tone}`
  }
}

function getFallbackResolution(subject: string, goal: string, brief: CreativeBrief, material: string, storyMaterial?: FallbackStoryMaterial): string {
  const hasMaterial = !isPlaceholderMaterial(material, goal)
  const anchor = hasMaterial ? getConcreteMaterialHandle(material, goal, brief) : getDirectionAnchor(brief, goal)
  const goalPhrase = getGoalPhrase(goal)
  const goalObject = getGoalObject(goal)
  const commitmentSource = storyMaterial?.commitment ?? material
  const hasCommitment = !isPlaceholderMaterial(commitmentSource, goal)
  const commitment = hasCommitment
    ? getConcreteMaterialHandle(commitmentSource, goal, brief)
    : getDirectionAnchor(brief, goal)
  const progression = getProgressionAnchor(material, storyMaterial, goal, brief, commitment)
  const toneChange = getResolutionToneChange(brief)
  if (storyMaterial && (hasConcreteFallbackMaterial(storyMaterial.decision, goal) || hasConcreteFallbackMaterial(storyMaterial.commitment, goal))) {
    const decision = hasConcreteFallbackMaterial(storyMaterial.decision, goal)
      ? getConcreteMaterialHandle(storyMaterial.decision, goal, brief)
      : getConcreteMaterialHandle(storyMaterial.commitment, goal, brief)
    const commitmentLabel = hasConcreteFallbackMaterial(storyMaterial.commitment, goal)
      ? getConcreteMaterialHandle(storyMaterial.commitment, goal, brief)
      : '这项承诺'
    const decisionObject = getGoalObject(decision)
    const propagatedDecision = getProgressionAnchor(material, storyMaterial, goal, brief, decision)
    const decisionLabel = propagatedDecision === decision ? decision : propagatedDecision
    switch (brief.dramaticForces[0]) {
      case 'misunderstanding':
        return `暂定：${subject}如何解释“${decisionLabel}”并回应${commitmentLabel}，会决定这项选择最后留下的关系和信息缺口；${toneChange}。`
      case 'cost':
        return `暂定：${subject}如何处理${decisionObject}并回应${commitmentLabel}，会决定“${decisionLabel}”让${goalPhrase}放弃什么，并留下${toneChange}。`
      case 'surprise':
        return `暂定：${subject}如何处理${decisionObject}带来的新条件，会决定“${decisionLabel}”让${goalPhrase}能否成立，以及旧计划被怎样改写；${toneChange}。`
      case 'relationship-tension':
        return `暂定：${subject}如何处理${decisionObject}并回应${commitmentLabel}，会决定“${decisionLabel}”与这项承诺能否同时被诚实面对；${toneChange}。`
      case 'contrast':
      default:
        return `暂定：${subject}处理${decisionObject}并回应${commitmentLabel}后，必须用一个可验证的改变回应“${decisionLabel}”；${subject}承认原来的局限，并${toneChange}。`
    }
  }
  switch (brief.dramaticForces[0]) {
    case 'misunderstanding':
      return `暂定：${subject}如何处理${anchor}，会决定${goalPhrase}最终保留的意义，并${toneChange}。`
    case 'cost':
      return `暂定：${subject}是否放下${anchor}，会决定${goalPhrase}得到什么结果，并${toneChange}。`
    case 'surprise':
      return `暂定：${subject}如何回应${anchor}带来的新条件，会决定${goalPhrase}出现什么结果，并${toneChange}。`
    case 'relationship-tension':
      return `暂定：${subject}如何兑现或重新解释${commitment}，会同时改变${goalObject}和相关关系的结果，并${toneChange}。`
    case 'contrast':
    default:
      if (brief.tones.includes('mystery')) {
        return `暂定：${subject}如何安置${progression}留下的信息缺口，会决定${goalObject}是否按原意完成，并${toneChange}。`
      }
      if (brief.tones.includes('growth')) {
        if (!hasMaterial && !hasCommitment) {
          return `暂定：${subject}如何为${goalPhrase}承担自己的决定，会决定这次选择之后保留什么；${toneChange}。`
        }
        return `暂定：${subject}如何处理${progression}，会决定${goalObject}能否继续，以及${subject}愿意为这项选择承担什么；${toneChange}。`
      }
      if (brief.tones.includes('comedy')) {
        return `暂定：${subject}是否承认${progression}带来的尴尬，会决定${goalPhrase}留下怎样的结果，并${toneChange}。`
      }
      return `暂定：${subject}是否改用新的办法处理${anchor}，会决定${goalPhrase}最后留下的结果，并${toneChange}。`
  }
}

function getToneCausalClause(brief: CreativeBrief, stage: 'tension' | 'trigger' | 'escalation' | 'midpoint' | 'climax'): string {
  const tone = brief.tones[0]
  switch (tone) {
    case 'friendship': return stage === 'climax' ? '先把信任说清，再决定要保住什么' : '信任会随着这次选择一起被检验'
    case 'romance': return stage === 'climax' ? '让心意和行动承担同一份风险' : '心意与行动的落差会放大这道阻碍'
    case 'mystery': return stage === 'midpoint' ? '信息缺口仍由作者决定是否揭开' : '信息缺口保持开放，不能直接变成事实'
    case 'comedy': return stage === 'climax' ? '尴尬会逼出一个比体面更诚实的选择' : '尴尬的后果会暴露旧办法的局限'
    case 'fantasy': return stage === 'midpoint' ? '规则的边界需要在下一步由作者确认' : '这条规则只作为待确认的提案'
    case 'warm': return '人物仍有机会先理解彼此再行动'
    case 'growth':
      switch (stage) {
        case 'tension': return '旧习惯与当前选择开始冲突'
        case 'trigger': return '这会检验主角是否愿意改变旧习惯'
        case 'escalation': return '继续回避会让旧习惯的代价变得可见'
        case 'midpoint': return '主角必须重新判断要改变的是办法还是目标'
        case 'climax': return '成长由主角愿意承担的取舍体现'
      }
    default: return '具体走向仍交给作者确认'
  }
}

function getResolutionToneChange(brief: CreativeBrief): string {
  if (brief.tones.includes('romance')) return '让心意与行动不再彼此回避'
  if (brief.tones.includes('friendship')) return '让关系中的信任被重新看见'
  if (brief.tones.includes('mystery')) return '让仍未解开的信息获得新的位置'
  if (brief.tones.includes('comedy')) return '让尴尬的代价成为人物关系的新理解'
  if (brief.tones.includes('fantasy')) return '让人物重新理解这件事背后的规则'
  if (brief.tones.includes('growth')) return '让主角重新定义自己愿意承担的承诺'
  return `让${getPrimaryToneLabel(brief)}落在一个可辨认的选择结果上`
}

function getGoalPhrase(goal: string): string {
  const normalized = goal
    .trim()
    .replace(/^当前(?:目标|想法)[：:]\s*/u, '')
    .replace(/^(?:想要|想|希望|打算|准备|计划)\s*/u, '')
  const decisionMatch = normalized.match(/(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (decisionMatch?.[1]) return compactGoalPhrase(decisionMatch[1].trim() || '作出选择')
  if (normalized.startsWith('是否')) return compactGoalPhrase(normalized.slice(2).trim() || '作出选择')
  return compactGoalPhrase(normalized || '作出选择')
}

function getGoalDecisionPhrase(goal: string): string {
  const normalized = goal
    .trim()
    .replace(/^当前(?:目标|想法)[：:]\s*/u, '')
    .replace(/^(?:想要|想|希望|打算|准备|计划)\s*/u, '')
  const decisionMatch = normalized.match(/(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (decisionMatch?.[1]) return `是否${compactGoalPhrase(decisionMatch[1].trim())}`
  if (normalized.startsWith('是否')) return compactGoalPhrase(normalized)
  return `是否${getGoalPhrase(goal)}`
}

function getWantGoal(goal: string): string {
  const phrase = getGoalPhrase(goal)
  return `想${phrase}`
}

function getGoalObject(goal: string): string {
  const phrase = getGoalPhrase(goal)
  const deliveryMatch = phrase.match(/^把(.+?)(?:送到|带到|交给|归还|提交|放回)(?:[^，。！？；\n]+)?$/u)
  if (deliveryMatch?.[1]) return deliveryMatch[1].trim()
  const decisionMatch = phrase.match(/^(?:是否|要不要)(?:删掉|删除|保留|拆掉|改掉|放弃)(.+)$/u)
  if (decisionMatch?.[1]) return decisionMatch[1].trim()
  return phrase.replace(/^把/u, '').trim() || '这项目标'
}

function compactGoalPhrase(value: string): string {
  let normalized = value
    .replace(/^在[^，。！？；\n]{1,24}前(?=(?:把|将|去|看|提交|参加|寻找|归还|离开|决定|选择))/u, '')
    .replace(/^于[^，。！？；\n]{1,24}(?=(?:把|将|去|看|提交|参加|寻找|归还|离开|决定|选择))/u, '')
    .trim()

  // Long goals often carry a deadline and a complete sentence. Keep the
  // action/object that later beats need, while the ledger retains the exact
  // source wording and deadline as separate facts.
  if (normalized.length > 32) {
    const action = normalized.match(/(?:把|将)?[^，。！？；\n]{0,24}(?:送到|带到|交给|归还|提交|放回|拆掉|删掉|删除|保留)[^，。！？；\n]{0,16}/u)
      ?? normalized.match(/(?:去|看|参加|寻找|离开|决定|选择)[^，。！？；\n]{0,24}/u)
    if (action?.[0]?.trim()) normalized = action[0].trim()
  }
  return normalized.length > 34 ? `${normalized.slice(0, 34)}…` : normalized
}

function getConcreteMaterialHandle(value: string, fallback: string, brief?: CreativeBrief): string {
  if (brief && isPlaceholderMaterial(value, fallback)) return getDirectionAnchor(brief, fallback)
  let cleaned = compactCausalMaterial(value, fallback)
    .replace(/^(?:却|但|并且|同时|然后|随后|让|迫使|需要|使|发现|如果|若)\s*/u, '')
    .trim()
  // Keep the author's concrete object while removing reporting verbs that make
  // every later card sound like it is repeating the source sentence.
  cleaned = cleaned
    .replace(/^(?:途中|随后|然后|当时)?(?:发现|看到|遇到|收到|拿到)\s*/u, '')
    .replace(/^(?:主角|她|他|其)\s*(?:发现|看到|遇到|收到|拿到)\s*/u, '')
    .trim()
  const sceneMatch = cleaned.match(/(?:在|于)(?:借来的)?(.+?)(?:里|中)看到(?:和)?(.+)$/u)
  if (sceneMatch?.[1] && sceneMatch[2]) {
    const sceneObject = `${sceneMatch[1]}里的${sceneMatch[2]}`
    return sceneObject.length > 34 ? `${sceneObject.slice(0, 34)}…` : sceneObject
  }
  const commitmentMatch = cleaned.match(/(?:答应|承诺|约定|保证)(.+)$/u)
  if (commitmentMatch?.[1]) {
    const commitment = `${commitmentMatch[1].replace(/[了过]/gu, '').trim()}的承诺`
    return commitment.length > 34 ? `${commitment.slice(0, 34)}…` : commitment
  }
  const boundaryMatch = cleaned.match(/(?:要求|禁止|不许)(.+)$/u)
  if (boundaryMatch?.[1]) {
    const boundary = `不${boundaryMatch[1].replace(/^不/u, '').trim()}`
    return boundary.length > 34 ? `${boundary.slice(0, 34)}…` : boundary
  }
  const decisionMatch = cleaned.match(/(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (decisionMatch?.[1]) return `是否${decisionMatch[1].trim()}`
  const intentionDecisionMatch = cleaned.match(/(?:想|希望|打算|准备|计划)(?:在[^，。！？；]{0,24})?(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (intentionDecisionMatch?.[1]) return `是否${intentionDecisionMatch[1].trim()}`
  const clauses = cleaned.split(/[，。！？；\n]/u).map((part) => part.trim()).filter(Boolean)
  const candidate = clauses.find((part) => (
    part.length >= 4
    && !/(?:想|决定|必须|会|可能|结果|代价|问题|选择|承诺|办法|原计划)/u.test(part)
  )) ?? clauses.find((part) => part.length >= 4) ?? cleaned
  const withoutSubjectLead = candidate.replace(/^[\u4e00-\u9fff]{2,4}(?=在|正|正在|想|要)/u, '').trim()
  const normalized = withoutSubjectLead || candidate
  return normalized.length > 34 ? `${normalized.slice(0, 34)}…` : normalized
}

function hasConcreteFallbackMaterial(value: string | undefined, goal: string): value is string {
  const normalized = value?.trim() ?? ''
  return Boolean(normalized) && !isPlaceholderMaterial(normalized, goal)
}

function getCommitmentEvidence(value: string, goal?: string, brief?: CreativeBrief): string {
  const normalized = value.trim().replace(/^暂定[：:]/u, '')
  if (goal && brief && isPlaceholderMaterial(normalized, goal)) {
    return getDirectionAnchor(brief, goal)
  }
  if (/^(?:自己决定是否|是否)/u.test(normalized)) return `${normalized}这项决定`
  if (/(?:答应|承诺|约定|保证)/u.test(normalized)) return normalized
  if (/(?:要求|禁止|不许|不再|不要)/u.test(normalized)) return normalized
  return `${normalized}的承诺`
}

/**
 * Preserve a genuinely new author consequence while keeping ordinary fallback
 * beats tied to their assigned source material. This is what prevents a later
 * node from silently falling back to a generic "原本的安排方式" after an
 * author edits an upstream node.
 */
function getProgressionAnchor(
  material: string,
  storyMaterial: FallbackStoryMaterial | undefined,
  goal: string,
  brief: CreativeBrief,
  fallback: string,
): string {
  const candidate = isPlaceholderMaterial(material, goal)
    ? ''
    : getConcreteMaterialHandle(material, goal, brief)
  if (!storyMaterial) return candidate || fallback
  const known = [
    storyMaterial.current,
    storyMaterial.observed,
    storyMaterial.deadline,
    storyMaterial.commitment,
    storyMaterial.decision,
  ].map((value) => getConcreteMaterialHandle(value, goal, brief))
  if (candidate && !known.includes(candidate) && !isPlaceholderMaterial(material, goal)) return candidate
  if (!isPlaceholderMaterial(fallback, goal)) return getConcreteMaterialHandle(fallback, goal, brief)
  return getDirectionAnchor(brief, goal)
}

function isPlaceholderMaterial(value: string, goal: string): boolean {
  const normalized = value.trim()
  const normalizedGoal = goal.trim()
  const goalPhrase = getGoalPhrase(goal)
  return !normalized
    || normalized === '当前处境'
    || normalized === '当前可用的条件'
    || normalized === '眼前的时机'
    || normalized === '自己必须作决定的习惯'
    || normalized === '尚未明确的取舍'
    || normalized === `${goal}的原计划`
    // A bare goal is useful as the preserved objective, but it is not a
    // separate obstacle, promise or deadline. Treating it as material made a
    // sparse idea fabricate a promise around the same words.
    || normalized === normalizedGoal
    || normalized === goalPhrase
}

function getDirectionAnchor(brief: CreativeBrief, goal: string): string {
  const goalPhrase = getGoalPhrase(goal)
  if (goalPhrase && /^(?:继续|去|看|参加|寻找|归还|离开)/u.test(goalPhrase)) {
    if (brief.tones.includes('growth')) return `是否由主角自己决定${goalPhrase}`
    if (brief.tones.includes('comedy')) return `想维持体面却会暴露${goalPhrase}局限的办法`
    if (brief.tones.includes('mystery')) return `关于${goalPhrase}的关键信息`
  }
  if (brief.dramaticForces.includes('misunderstanding')) return `与${goalPhrase}有关的理解落差`
  if (brief.dramaticForces.includes('cost')) return `继续${goalPhrase}会占用的一项现实条件`
  if (brief.dramaticForces.includes('surprise')) return `改变${goalPhrase}时机的意外条件`
  if (brief.dramaticForces.includes('relationship-tension')) return `同行者对${goalPhrase}的期待落差`
  if (brief.tones.includes('mystery')) return `尚未确认、却影响${goalPhrase}的信息缺口`
  if (brief.tones.includes('comedy')) return `会暴露${goalPhrase}局限的一次临场尴尬`
  if (brief.tones.includes('friendship')) return `主角与同行者对${goalPhrase}的不同期待`
  if (brief.tones.includes('growth')) return `围绕${goalPhrase}的原本安排`
  return `主角原本最依赖的${goalPhrase}安排方式`
}

function stripLeadingLocationMarker(value: string): string {
  return value.replace(/^(?:在|于)/u, '')
}

function shortenCurveContext(value: string): string {
  return compactCausalMaterial(value, '此前的作者决定')
}

function extractCausalConsequence(value: string): string {
  // System proposals usually quote the material they build on. Removing that
  // quoted premise before selecting a clause keeps the next node focused on
  // the consequence, instead of recursively embedding the whole prior node.
  return compactCausalMaterial(value, '上一步暴露的后果')
}

function getCausalAnchor(curve: ProvisionalCurve, target: CurveBeat, fallback: string): string {
  const visited = new Set<string>()
  const queue = [...target.dependsOn]
  let nearest: CurveBeat | undefined
  while (queue.length && !nearest) {
    const dependencyId = queue.shift()!
    if (visited.has(dependencyId)) continue
    visited.add(dependencyId)
    const candidate = curve.beats.find((beat) => beat.id === dependencyId)
    if (!candidate || candidate.status === 'rejected') continue
    nearest = candidate
    if (candidate.source !== 'user-edit') queue.push(...candidate.dependsOn)
  }
  if (!nearest) return compactCausalMaterial(fallback, fallback)
  if (nearest.causalAnchor?.trim()) return nearest.source === 'user-edit'
    ? compactAuthorMaterial(nearest.causalAnchor)
    : compactCausalMaterial(nearest.causalAnchor, fallback)
  if (nearest.source === 'user-edit') return compactAuthorMaterial(nearest.detail)
  return compactGeneratedConsequence(nearest.detail, fallback)
}

/** Reduce a source fact or author instruction to one quote-free causal handle. */
function compactCausalMaterial(value: string, fallback: string): string {
  const cleaned = value
    .replace(/^暂定[：:]/u, '')
    .replace(/(?:作者(?:第一次)?(?:明确)?编辑|作者指令|作者调整)[：:]?/u, '')
    .replace(/“[^”]*”/gu, '')
    .replace(/"[^"]*"/gu, '')
    .replace(/[“”"']/gu, '')
    .replace(/\s+/gu, ' ')
    // Do not strip the leading "是" from the decision marker "是否".
    .replace(/^(?:是(?!否)|却想|却|但|并且|然后|随后|让|因为|由于)\s*/u, '')
    .trim()
  const clauses = cleaned
    .split(/[，。！？；\n]/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 4)
  const candidate = clauses.find((clause) => (
    !/^(?:面对|围绕|关于|由于|因此|继续|如果|若|让|并且)$/u.test(clause)
    && !/(?:发现|意识到|知道)$/u.test(clause)
  )) ?? clauses[0] ?? cleaned
  const normalized = candidate.trim()
  if (!normalized) return fallback.trim() || '此前的作者决定'
  return normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized
}

function compactAuthorMaterial(value: string): string {
  const parts = parseAuthorCausalParts(value)
  if (parts.action && parts.consequence) return shortenAuthorAnchor(`${parts.action}，${parts.consequence}`)
  return shortenAuthorAnchor(parts.action || parts.consequence || value.trim())
}

function shortenAuthorAnchor(value: string): string {
  const normalized = value
    .replace(/^(?:也是在|就是|而是|所以|因此|于是|让|需要|先|再)\s*/u, '')
    .trim()
  return normalized.length > 54 ? `${normalized.slice(0, 54)}…` : normalized
}

function compactGeneratedConsequence(value: string, fallback: string): string {
  const cleaned = value
    .replace(/^暂定[：:]/u, '')
    .replace(/“[^”]*”/gu, '')
    .replace(/"[^"]*"/gu, '')
    .replace(/[“”"']/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  const clauses = cleaned.split(/[，。！？；\n]/u).map((part) => part.trim()).filter((part) => part.length >= 4)
  const candidate = [...clauses].reverse().find((part) => /(?:必须|因此|结果|只能|会|改变|承担|决定|代价|阻碍|失去|无法)/u.test(part))
    ?? clauses.at(-1)
    ?? fallback
  return compactAuthorMaterial(candidate) || compactCausalMaterial(candidate, fallback)
}

function getCurveVariationAxis(brief: CreativeBrief): StoryVariationAxis {
  if (brief.dramaticForces.includes('relationship-tension')) return 'relationship'
  if (brief.dramaticForces.includes('cost')) return 'commitment'
  if (brief.dramaticForces.includes('surprise')) return 'time'
  return 'commitment'
}

function joinCurveDetails(beats: Array<CurveBeat | undefined>): string {
  return beats
    .filter((beat): beat is CurveBeat => Boolean(beat))
    .map((beat) => beat.detail)
    .join(' ')
}

function getStorySubject(seed: StorySeed): string {
  return seed.subject.trim() || '主角'
}

function getStoryGoal(seed: StorySeed, fallback: string): string {
  return seed.lockedGoal?.trim() || `围绕“${getShortIdeaLabel(fallback)}”作出决定`
}

function getConfirmedCurveGoal(seed: StorySeed, currentState: CurveBeat): string {
  return currentState.source === 'user-edit'
    ? currentState.detail.trim()
    : getStoryGoal(seed, currentState.detail)
}

function applyCurrentCurveEditToSeed<TCurve extends Pick<ProvisionalCurve | ConfirmedCurve, 'beats'>>(
  seed: StorySeed,
  curve: TCurve,
): StorySeed {
  const currentState = curve.beats.find((beat) => beat.kind === 'current-state')
  if (!currentState || currentState.source !== 'user-edit') return seed

  return {
    ...seed,
    activeSituation: currentState.detail,
    lockedGoal: currentState.detail,
  }
}

function getCurrentState(seed: StorySeed, fallback: string): string {
  return seed.activeSituation.trim() || fallback.trim()
}

function getFallbackCurrentStateDetail(
  seed: StorySeed,
  fallback: string,
  sourceFacts: readonly StorySourceFact[] = [],
): string {
  const currentState = getCurrentState(seed, fallback)
  const lockedGoal = seed.lockedGoal?.trim()
  if (!lockedGoal) return currentState
  const isRichSource = sourceFacts.length >= 3 || currentState.length > 48
  if (!isRichSource && currentState.length <= 72) return currentState
  const conciseMaterial = sourceFacts.length
    ? sourceFacts.slice(0, 2).map((fact) => fact.text.trim()).filter(Boolean).join('；')
    : currentState
  return conciseMaterial && conciseMaterial !== currentState
    ? `${conciseMaterial}；当前要决定：${lockedGoal}`
    : `${currentState}（当前目标：${lockedGoal}）`
}

function getShortIdeaLabel(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  return normalized.length > 16 ? `${normalized.slice(0, 16)}…` : normalized || '这个念头'
}

function getPrimaryToneLabel(brief: CreativeBrief): string {
  return brief.tones[0] ? creativeToneLabels[brief.tones[0]] : '人物理解'
}

function normalizeCurveText(value: string, emptyMessage: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (!normalized) throw new AppError(emptyMessage, 400, 'INVALID_REQUEST')
  if (normalized.length > maximumCurveBeatLength) {
    throw new AppError(`曲线节点最多 ${maximumCurveBeatLength} 个字符，请简短描述。`, 400, 'INVALID_REQUEST')
  }
  return normalized
}

function parseEnumList<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  label: string,
  maximumLength: number,
): T[] {
  if (!Array.isArray(value) || value.length > maximumLength || value.some((item) => typeof item !== 'string' || !allowedValues.includes(item as T))) {
    throw new AppError(`${label}格式不正确，请重新选择。`, 400, 'INVALID_REQUEST')
  }
  const items = value as T[]
  if (new Set(items).size !== items.length) {
    throw new AppError(`${label}不能重复选择。`, 400, 'INVALID_REQUEST')
  }
  return items
}

function readOptionalText(value: unknown, maximumLength: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replace(/\s+/gu, ' ')
  return normalized && normalized.length <= maximumLength ? normalized : undefined
}

function isCurveBeatKind(value: string): value is CurveBeatKind {
  return curveBeatKinds.includes(value as CurveBeatKind)
}

function hasNewNamedCharacter(text: string, seed?: StorySeed): boolean {
  const knownText = [seed?.subject ?? '', seed?.activeSituation ?? '', ...(seed?.lockedFacts ?? [])].join(' ')
  const explicitNamePattern = /(?:名叫|名字叫|名为|叫做|叫)[“「]?([\u4e00-\u9fff]{2,4})[”」]?/gu
  const delimitedSurnameNamePattern = /(?:^|[\s，。；：、！？“”‘’「」『』（）()])([赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦许何吕施张孔曹严华金魏陶姜戚谢邹喻范彭郎鲁韦昌马苗方俞任袁柳鲍史唐费廉薛雷贺倪汤滕殷罗毕郝邬安常乐于傅皮卞齐康伍余顾孟平黄穆萧尹姚邵汪祁毛狄米贝明成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季贾路江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万柯管卢莫房裘解应宗丁宣邓洪包左石崔吉龚程邢裴陆荣翁荀惠甄曲封段武符刘景詹龙叶黎白][\u4e00-\u9fff]{1,2})(?=$|[\s，。；：、！？“”‘’「」『』（）()])/gu
  for (const pattern of [explicitNamePattern, delimitedSurnameNamePattern]) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]
      if (candidate && !knownText.includes(candidate)) return true
    }
  }

  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isModelDisabled(): boolean {
  return /^(?:1|true|yes)$/iu.test(process.env.STORY_DISABLE_MODEL?.trim() ?? '')
}

function isLocalFallbackAllowed(): boolean {
  // Production callers need the explicit STORY_DISABLE_MODEL switch before a
  // deterministic fallback is returned. Regression commands set this switch
  // in their documented local environment.
  return isModelDisabled()
}

const curveGenerationSystemPrompt = `你是故事共创编辑。你的职责是把用户的模糊想法整理成一条可讨论、可编辑的暂定故事曲线，而不是写小说或代替用户决定主线。

只输出 JSON 对象，不要 Markdown。第一次请严格给出恰好 5 个 beats，kind 按 current-state、trigger、escalation、climax-choice、resolution 排列；不要添加 character-tension 或 midpoint-turn。每个 beat 只能是一个结构假设，不写连续场景、对白、角色回合、既定结果或固定路径事实。每个 detail 最多 110 个汉字。除 current-state 外，每个 detail 必须以“暂定：”开头，并且只写一个抽象因果句。

所有不是用户原文的内容都是系统提案：可以提出人物弱点、钩子、阻碍、代价与结局方向，但不要把它们写成已发生事实。除 current-state 外，提案只可引用目标、期限、承诺和关系的抽象因果，不要重复原文中的具体器物或文件名称。提案中绝对不要出现引号、对白、消息、文件、屏幕、便签、设备操作、具体场景动作、连续步骤、精确时间/数量、工作人员或机构流程；不要用这些细节替作者决定因果。foundation 的每个字段控制在 50 个汉字以内，predicament.immediateSituation 控制在 70 个汉字以内，只写设计关系，不写场景道具。若 allowSystemNamedCharacters 为 false，绝不新增任何具名人物，使用“陌生人”“同行者”等匿名指代。不要默认写成悬疑，除非 brief 明确选择 mystery。

安全写法示例：trigger 用“暂定：既有归还期限使原计划无法继续”这类抽象阻碍；escalation 用“暂定：继续目标会触碰已确认的承诺”这类取舍；climax-choice 用“暂定：主角必须在保留目标与承担承诺之间选择”。不要把“归还期限”扩写成便签、消息、倒计时或具体时刻。

输出：{"title":"简短标题","beats":[{"kind":"current-state","title":"节点标题","detail":"节点内容","dependsOn":[],"sourceFactIds":["source-fact-1"],"causalAnchor":"一句短因果承接"},{"kind":"trigger","title":"节点标题","detail":"暂定：抽象阻碍","dependsOn":["beat-current-state"],"sourceFactIds":["source-fact-1"],"causalAnchor":"一句短因果承接"},{"kind":"escalation","title":"节点标题","detail":"暂定：抽象升级","dependsOn":["beat-trigger"],"sourceFactIds":["source-fact-1"],"causalAnchor":"一句短因果承接"},{"kind":"climax-choice","title":"节点标题","detail":"暂定：主动选择","dependsOn":["beat-escalation"],"sourceFactIds":["source-fact-1"],"causalAnchor":"一句短因果承接"},{"kind":"resolution","title":"节点标题","detail":"暂定：抽象变化","dependsOn":["beat-climax-choice"],"sourceFactIds":["source-fact-1"],"causalAnchor":"一句短因果承接"}],"foundation":{"conflictCore":{"goal":"保留的目标","obstacle":"具体阻碍如何卡住目标","tradeoff":"主角必须承担的取舍"},"preservedGoal":"保留的目标","predicament":{"title":"具体困境标题","variationAxis":"time|resource|relationship|commitment","immediateSituation":"当前处境","obstacle":"当前阻碍","tradeoff":"取舍","urgency":"为什么现在要处理","choice":"主角要作的选择","plausibleCost":"选择的代价"},"middleDevelopment":{"escalation":"阻碍如何升级","midpoint":"中段如何改变原办法","climaxPressure":"高潮压力"},"storyEnds":{"opening":"故事开端","openingClue":"开端钩子","climax":"高潮选择","resolution":"结局变化","cost":"承担的代价","promise":"故事承诺"},"approach":{"intent":"第一步设计方向","cost":"第一步代价"}}}`

const curveBeatRegenerationSystemPrompt = `你是故事共创编辑。只重写一条暂定故事曲线节点，不写连续剧情。返回 JSON：{"detail":"暂定：一句可编辑的系统提案"}。detail 必须以“暂定：”开头，不得把提案写成既定事实、行动结果或长场景；未允许新增具名人物时不得新增名字。只提取上游节点的核心后果，用新的短语推进下一层；不要复制上游整句，不要出现嵌套引号。`

const curveGenerationRepairSystemPrompt = `你是故事结构校验修复器，不是小说作者。你必须把候选曲线改写成可审阅的抽象因果提案。

只输出 JSON。严格只保留 5 个 beat，kind 必须按 current-state、trigger、escalation、climax-choice、resolution 各出现一次；不要添加其他 kind。current-state 可以逐字保留用户材料；其余 beat 的 detail 必须以“暂定：”开头，只写一个因果关系或取舍，不得出现任何场景动作、对白、引号、消息、文件、屏幕、便签、设备、工作人员、机构流程、具体数字/时间/人数、精确结果或永久后果。不要把“投影仪”“手机”等具体物件换成“设备”来规避规则；直接写“既有期限”“已确认承诺”“作品归属”等抽象关系。foundation 每个字段不超过 50 个汉字，不能写场景物件；sourceFactIds 和 dependsOn 必须使用输入中给出的真实 ID；dependsOn 固定为 current-state→trigger→escalation→climax-choice→resolution 的链条。

合格例子：
- trigger：暂定：既有归还期限使原计划无法继续。
- escalation：暂定：继续目标会触碰主角已经确认的承诺。
- midpoint-turn：暂定：主角意识到旧办法无法同时保留目标和承诺。
- climax-choice：暂定：主角必须在保留目标与承担承诺之间作出选择。
- resolution：暂定：这次选择改变主角对目标和承诺关系的理解。

不合格例子：新增“打开/看到/收到/听见/倒计时/导出”等场景操作，或新增某人说、某设备、某文件、12小时、三个人、永久等内容。若“提交”或其他动作词已经逐字出现在作者材料中，可以作为抽象目标条件照抄，但不能扩写成现场操作链。

输出结构必须完整，不能省略 foundation：
{"title":"简短标题","beats":[{"kind":"current-state|character-tension|trigger|escalation|midpoint-turn|climax-choice|resolution","title":"节点标题","detail":"节点内容","dependsOn":[],"sourceFactIds":["输入中的 source-fact ID"],"causalAnchor":"一句短因果承接"}],"foundation":{"conflictCore":{"goal":"保留目标","obstacle":"阻碍","tradeoff":"取舍"},"preservedGoal":"保留目标","predicament":{"title":"困境标题","variationAxis":"time|resource|relationship|commitment","immediateSituation":"当前处境","obstacle":"阻碍","tradeoff":"取舍","urgency":"紧迫性","choice":"选择","plausibleCost":"代价"},"middleDevelopment":{"escalation":"升级","midpoint":"中段转折","climaxPressure":"高潮压力"},"storyEnds":{"opening":"开端","openingClue":"开场线索","climax":"高潮选择","resolution":"结局变化","cost":"代价","promise":"故事承诺"},"approach":{"intent":"第一步方向","cost":"第一步代价"}}}`

// Qwen follows a small, closed JSON contract much more reliably than a
// combined beat/foundation schema. The server derives the shared foundation
// from these validated beats below, so the model never gets a second design
// map that could drift from the reviewed curve.
const compactCurveGenerationSystemPrompt = `你是故事共创编辑，只负责从作者已经写出的事实中选择一条可审阅的因果结构，不写小说，也不写曲线文案。

只输出一个 JSON 对象，不能有 Markdown、解释或额外键。对象必须严格是：{"curvePlan":{"triggerFactId":"source-fact ID","escalationFactId":"source-fact ID","choiceFactId":"source-fact ID","resolutionMode":"allowed mode"}}。不要输出 title、beats、foundation、自然语言句子或任何作者未写出的故事内容。即使无法判断，也必须返回 curvePlan 这个对象，绝不能返回 beats。

你要做的是可审核的结构选择：triggerFactId 和 escalationFactId 必须是两个不同的、已存在的作者事实，前者是让目标停住的直接条件，后者是继续目标时必须面对的另一项条件；choiceFactId 必须是作者明确目标所在的事实。resolutionMode 只能从用户消息列出的 allowed modes 中选一个。不要用同一个事实填两个压力槽位，不要把目标本身误当作两项压力，也不要因为常识补写人物意图、价值、权限、关系结论、场景、结果或新物件。

服务端会把你选中的原文锚点呈现为“暂定”的系统提案，并独立校验事实追溯、因果差异和作者已选方向。任何不在允许列表中的 ID、模式或重复角色都会被拒绝；无法诚实选择时，仍只返回上述 JSON 形状。`

const compactCurveGenerationRepairSystemPrompt = `你是故事结构修复器。上一版的自然语言曲线未通过事实或因果校验；本轮不要改写句子，也不要解释失败原因。只重新选择作者事实角色。

只输出一个 JSON 对象，不能有 Markdown、解释或额外键。对象必须严格是：{"curvePlan":{"triggerFactId":"source-fact ID","escalationFactId":"source-fact ID","choiceFactId":"source-fact ID","resolutionMode":"allowed mode"}}。不得输出 title、beats、foundation 或任何自然语言故事内容。上一版若输出 beats，本轮必须改为 curvePlan。

triggerFactId 和 escalationFactId 必须是两个不同的允许压力事实；choiceFactId 必须来自允许目标事实；resolutionMode 必须来自 allowed modes。只根据用户消息中提供的逐字原文锚点选择，不得新增人物意图、价值、权限、关系结论、场景、结果、物件或时间。`


function buildCurveGenerationPrompt(
  idea: string,
  seed: StorySeed,
  brief: CreativeBrief,
  design: StoryDesignRecord,
  excludedProposalDetails: readonly string[] = [],
  repairMessage?: string,
): string {
  return buildCompactCurveGenerationPrompt(idea, seed, brief, design, excludedProposalDetails, repairMessage)
  /*
  return `用户原始想法：\n${idea}\n\n不可丢失的原始材料（只能从这里选择 sourceFactIds，不能改写成新事实）：\n${JSON.stringify(design.sourceFacts.map((fact) => ({ id: fact.id, text: fact.text })))}\n\n可保留的原始信息：\n${JSON.stringify({ subject: seed.subject, activeSituation: seed.activeSituation, lockedGoal: seed.lockedGoal, lockedFacts: seed.lockedFacts })}\n\n作者创意方向：\n${JSON.stringify({
    tones: brief.tones.map((tone) => creativeToneLabels[tone]),
    dramaticForces: brief.dramaticForces.map((force) => dramaticForceLabels[force]),
    allowSystemNamedCharacters: brief.allowSystemNamedCharacters,
    note: brief.note ?? '',
  })}\n\n戏剧机制必须是：${getDramaticMechanism(brief)}。${getCurveBriefQualityInstruction(brief)}每条原始材料都必须至少被一个 beat 的 sourceFactIds 引用；sourceFactIds 必须是上面给出的真实 ID，不能省略、伪造或重复。不要输出 foundation、title 以外的额外字段；服务端会从通过校验的 beats 构造共享 foundation。不要输出 dependsOn、causalAnchor 或节点 title。${excludedProposalDetails.length ? `以下提案已经被作者拒绝，不能在新版本中重现：${JSON.stringify(excludedProposalDetails)}` : ''}${repairMessage ? `\n上一版未通过校验：${repairMessage}。请只重写 title 和 5 个 beats，不要沿用不合格字段；仍然只写抽象结构句，不要写场景动作、对白、设备操作、精确时间、数量、永久后果或“倒数”等词。不要把上一版的具体句子带入新版本。` : ''}\n请给出一条主张明确、因果递进的暂定曲线。`
  */
}

function buildCompactCurveGenerationPrompt(
  idea: string,
  seed: StorySeed,
  brief: CreativeBrief,
  design: StoryDesignRecord,
  excludedProposalDetails: readonly string[],
  repairMessage?: string,
): string {
  if (repairMessage) {
    return buildCompactCurveRepairPrompt(idea, seed, brief, design, excludedProposalDetails, repairMessage)
  }

  const contract = getModelFactRoleCurveContract(design, seed, brief)
  return [
    '只输出 curvePlan JSON；不要输出任何自然语言曲线、title、beats、foundation 或其他键。',
    '事实审阅规则：按以下事实锚点写入角色选择（按以下事实锚点写）；单个提案节点只列它实际承接的作者事实。服务端会根据已选 ID 生成可审阅句子，不能由模型补写新事实。',
    '方向层级硬约束：触发和升级必须使用不同压力；高潮选择和结局必须同时承接目标与升级压力。所选方向必须改变至少三个因果节点，不能只替换形容词。',
    `用户原始想法（仅供核对，不要复述）：${idea}`,
    `作者材料（只能选择这里的 ID，anchor 是逐字原文）：${JSON.stringify(contract.sourceFacts)}`,
    `选择合同：${JSON.stringify({
      allowedTriggerFactIds: contract.pressureFactIds,
      allowedEscalationFactIds: contract.pressureFactIds,
      allowedChoiceFactIds: contract.choiceFactIds,
      allowedResolutionModes: contract.resolutionModes,
      required: 'triggerFactId 与 escalationFactId 必须不同；二者都不能等于 choiceFactId，除非只有一个作者事实且合同明确允许。',
    })}`,
    `作者选择的方向：${[...brief.dramaticForces.map((force) => dramaticForceLabels[force]), ...brief.tones.map((tone) => creativeToneLabels[tone])].join('、') || '开放方向'}。选择要优先让不同的作者压力进入不同层级，而不是重复同一目标。`,
    ...(excludedProposalDetails.length ? [`已拒绝提案，不能选择会重现它们的处理方式：${JSON.stringify(excludedProposalDetails)}`] : []),
    '严格输出形状：{"curvePlan":{"triggerFactId":"source-fact-2","escalationFactId":"source-fact-3","choiceFactId":"source-fact-1","resolutionMode":"adjust-goal-under-constraint"}}',
  ].join('\n')
}

interface CompactCurveRepairSlots {
  trigger: StorySourceFact
  escalation: StorySourceFact
  goal: StorySourceFact
}

function getCompactCurveRepairSlots(
  design: StoryDesignRecord,
  seed: StorySeed,
): CompactCurveRepairSlots | undefined {
  const sourceFacts = design.sourceFacts.filter((fact) => fact.disposition !== 'parked')
  const goal = sourceFacts.find((fact) => (
    Boolean(seed.lockedGoal) && hasModelSourceFactEvidence(seed.lockedGoal!, fact.text)
  )) ?? sourceFacts.at(-1)
  if (!goal) return undefined

  const trigger = sourceFacts.find((fact) => (
    fact.id !== goal?.id
      && /(?:今晚|明早|明天|周[一二三四五六日天]|归还|截止|期限|倒数|必须在[^，。！？；]{0,24}前|要在[^，。！？；]{0,24}前)/u.test(fact.text)
  )) ?? sourceFacts.find((fact) => (
    fact.id !== goal?.id
      && /(?:答应|承诺|约定|保证|不再|缺失|卖掉|无法|不能|冲突|分歧)/u.test(fact.text)
  )) ?? sourceFacts.find((fact) => fact.id !== goal?.id)
  const escalation = sourceFacts.find((fact) => (
    fact.id !== trigger?.id && /(?:缺失|卖掉|无法|不能|冲突|分歧|答应|承诺|约定|保证|不再|关系|姐姐|朋友|队友|家人|不知道|是否|按承诺)/u.test(fact.text)
  )) ?? sourceFacts.find((fact) => fact.id !== trigger?.id) ?? trigger
  if (!trigger || !escalation) return undefined
  return { trigger, escalation, goal }
}

function getCompactCurveRepairAnchor(fact: StorySourceFact): string {
  return getModelCurveFactAnchor(fact.text)
}

function buildCompactCurveRepairPrompt(
  idea: string,
  seed: StorySeed,
  brief: CreativeBrief,
  design: StoryDesignRecord,
  excludedProposalDetails: readonly string[],
  repairMessage: string,
): string {
  const contract = getModelFactRoleCurveContract(design, seed, brief)
  return [
    '只输出 curvePlan JSON：不得输出 beats、template、title、foundation、解释或任何自然语言故事内容。',
    '事实审阅规则：按以下事实锚点写入角色选择（按以下事实锚点写）；单个提案节点只列它实际承接的作者事实。不要补写句子。',
    '方向层级硬约束：触发和升级必须使用不同压力；高潮选择和结局必须同时承接目标与升级压力。',
    `本轮校验摘要（只用于避开同类错误，不得复述到结果）：${repairMessage}`,
    `用户原始想法（仅供核对）：${idea}`,
    `逐字原文锚点（只能从这里选择 ID）：${JSON.stringify(contract.sourceFacts)}`,
    `选择合同：${JSON.stringify({
      allowedTriggerFactIds: contract.pressureFactIds,
      allowedEscalationFactIds: contract.pressureFactIds,
      allowedChoiceFactIds: contract.choiceFactIds,
      allowedResolutionModes: contract.resolutionModes,
      required: 'triggerFactId 与 escalationFactId 必须不同，且不得把 choiceFactId 重复当作压力事实。',
    })}`,
    ...(excludedProposalDetails.length ? ['作者已经拒绝的提案不得通过选择同一事实角色或处理方式重新出现。'] : []),
    '严格输出形状：{"curvePlan":{"triggerFactId":"source-fact-2","escalationFactId":"source-fact-3","choiceFactId":"source-fact-1","resolutionMode":"adjust-goal-under-constraint"}}',
  ].join('\n')
}

function buildModelFactRepairMap(design: StoryDesignRecord): string {
  return `事实 ID 修复表（只可照抄对应短语）：${JSON.stringify(design.sourceFacts.map((fact) => ({
    id: fact.id,
    exactAnchor: getModelCurveFactAnchor(fact.text),
  })))}。若某个节点没有照抄某一行的 exactAnchor，就不要在该节点列出那个 ID；不要为了覆盖清单把 ID 挂到近义句上。`
}

function getModelCurveFactAnchor(value: string): string {
  const candidates = getModelFactAnchors(value)
  const normalized = normalizeCurveEvidence(value)
  const selected = candidates.find((candidate) => candidate !== normalized && candidate.length >= 4)
    ?? value.trim().replace(/^(?:却|但|同时|并且|她|他|我|我们)\s*/u, '')
  if (selected.length <= 42) return selected
  return selected.slice(0, 42)
}

const modelCurveResolutionModes = [
  'adjust-goal-under-constraint',
  'address-pressure-before-goal',
  'keep-goal-open-under-pressure',
] as const

type ModelCurveResolutionMode = typeof modelCurveResolutionModes[number]

interface ModelFactRoleCurveContract {
  sourceFacts: Array<{ id: string, text: string, anchor: string }>
  pressureFactIds: string[]
  choiceFactIds: string[]
  resolutionModes: ModelCurveResolutionMode[]
}

/**
 * The model chooses roles from a closed author ledger. It is deliberately not
 * a deterministic curve plan: it has to distinguish two different pressures,
 * identify the fact carrying the author's goal, and choose how the ending
 * holds that pressure open. The server only renders those validated choices
 * so a malformed free-text answer cannot become a fabricated story fact.
 */
function getModelFactRoleCurveContract(
  design: StoryDesignRecord,
  seed: StorySeed,
  brief: CreativeBrief,
): ModelFactRoleCurveContract {
  const facts = design.sourceFacts.filter((fact) => fact.disposition !== 'parked')
  const choiceFacts = facts.filter((fact) => (
    Boolean(seed.lockedGoal)
      && hasModelSourceFactEvidence(seed.lockedGoal!, fact.text)
  ))
  // createStoryDesignRecord adds the locked goal to its ledger when it is not
  // already represented by a richer author clause. Keep the fallback narrow
  // for legacy records only; a plan still has to show the selected goal fact.
  const resolvedChoiceFacts = choiceFacts.length
    ? choiceFacts
    : facts.filter((fact) => Boolean(seed.lockedGoal) && normalizeCurveEvidence(fact.text).includes(normalizeCurveEvidence(seed.lockedGoal!)))
  const choiceFactIds = resolvedChoiceFacts.map((fact) => fact.id)
  const nonGoalFacts = facts.filter((fact) => !choiceFactIds.includes(fact.id))
  // A date-only backdrop or a generic opening observation cannot honestly be
  // promoted into a conflict simply because it is in the ledger. Prefer facts
  // that actually establish a deadline, a promise, a relationship tension, an
  // information gap, or a stated obstruction. If fewer than two exist, the
  // caller asks the author for another concrete condition.
  const pressureFacts = nonGoalFacts.filter(isModelCurvePressureFact)

  const preferredModes: ModelCurveResolutionMode[] = brief.dramaticForces.includes('relationship-tension')
    ? ['address-pressure-before-goal', 'adjust-goal-under-constraint']
    : brief.dramaticForces.includes('cost')
      ? ['adjust-goal-under-constraint', 'address-pressure-before-goal']
      : brief.dramaticForces.includes('contrast')
        ? ['adjust-goal-under-constraint', 'keep-goal-open-under-pressure']
        : [...modelCurveResolutionModes]

  return {
    sourceFacts: facts.map((fact) => ({
      id: fact.id,
      text: fact.text,
      anchor: getModelCurveFactAnchor(fact.text),
    })),
    pressureFactIds: pressureFacts.map((fact) => fact.id),
    choiceFactIds,
    resolutionModes: preferredModes,
  }
}

function getModelFactRoleCurveReadinessFailure(contract: ModelFactRoleCurveContract): string | undefined {
  if (!contract.choiceFactIds.length) {
    return '当前想法还没有一条可逐字追溯的主角目标。'
  }
  if (contract.pressureFactIds.length < 2) {
    return '当前想法还缺少两项可区分的阻碍、期限、承诺、关系或待决定条件。'
  }
  return undefined
}

function isModelCurvePressureFact(fact: StorySourceFact): boolean {
  if (/(?:今晚|明早|明天|后天|今天|周[一二三四五六日天]|截止|期限|归还|必须在[^，。！？；]{0,24}前|要在[^，。！？；]{0,24}前|答应|承诺|约定|保证|不再|缺失|卖掉|无法|不能|不得|冲突|分歧|关系|姐姐|哥哥|弟弟|妹妹|队友|朋友|家人|不知道|不确定|犹豫|是否|要不要)/u.test(fact.text)) {
    return true
  }
  // “看到/发现” alone is an observation, not a pressure. Promote it only
  // when the same author clause also states a concrete absence, disagreement,
  // or unresolved decision that can actually constrain the goal.
  return /(?:发现|看到)/u.test(fact.text)
    && /(?:缺失|卖掉|无法|不能|冲突|分歧|不知道|不确定|犹豫|是否|要不要)/u.test(fact.text)
}

function buildModelFactRoleCurvePayload(
  value: Record<string, unknown>,
  idea: string,
  seed: StorySeed,
  brief: CreativeBrief,
  design: StoryDesignRecord,
): Record<string, unknown> {
  if (Object.keys(value).some((key) => key !== 'curvePlan')) {
    throwCurveModelValidationFailure('curvePlan 模型合同不允许顶层额外字段', value)
  }
  const rawPlan = value.curvePlan
  if (!isRecord(rawPlan)) {
    throwCurveModelValidationFailure('curvePlan 必须是对象', value)
  }
  const allowedKeys = new Set(['triggerFactId', 'escalationFactId', 'choiceFactId', 'resolutionMode'])
  if (Object.keys(rawPlan).some((key) => !allowedKeys.has(key))) {
    throwCurveModelValidationFailure('curvePlan 包含不支持的字段', value)
  }
  const triggerFactId = rawPlan.triggerFactId
  const escalationFactId = rawPlan.escalationFactId
  const choiceFactId = rawPlan.choiceFactId
  const resolutionMode = rawPlan.resolutionMode
  if (
    typeof triggerFactId !== 'string'
    || typeof escalationFactId !== 'string'
    || typeof choiceFactId !== 'string'
    || typeof resolutionMode !== 'string'
  ) {
    throwCurveModelValidationFailure('curvePlan 缺少字符串事实角色或处理方式', value)
  }

  const contract = getModelFactRoleCurveContract(design, seed, brief)
  const readinessFailure = getModelFactRoleCurveReadinessFailure(contract)
  if (readinessFailure) throwCurveModelValidationFailure(readinessFailure, value)
  if (!contract.pressureFactIds.includes(triggerFactId)) {
    throwCurveModelValidationFailure(`curvePlan 的 triggerFactId 不是允许的压力事实“${triggerFactId}”`, value)
  }
  if (!contract.pressureFactIds.includes(escalationFactId)) {
    throwCurveModelValidationFailure(`curvePlan 的 escalationFactId 不是允许的压力事实“${escalationFactId}”`, value)
  }
  if (!contract.choiceFactIds.includes(choiceFactId)) {
    throwCurveModelValidationFailure(`curvePlan 的 choiceFactId 不是作者锁定目标事实“${choiceFactId}”`, value)
  }
  if (triggerFactId === escalationFactId) {
    throwCurveModelValidationFailure('curvePlan 把同一条作者事实同时用作触发和升级，缺少因果差异', value)
  }
  if (!contract.resolutionModes.includes(resolutionMode as ModelCurveResolutionMode)) {
    throwCurveModelValidationFailure(`curvePlan 的 resolutionMode 不在当前方向允许范围“${resolutionMode}”`, value)
  }

  const triggerFact = design.sourceFacts.find((fact) => fact.id === triggerFactId)
  const escalationFact = design.sourceFacts.find((fact) => fact.id === escalationFactId)
  const choiceFact = design.sourceFacts.find((fact) => fact.id === choiceFactId)
  if (!triggerFact || !escalationFact || !choiceFact) {
    throwCurveModelValidationFailure('curvePlan 引用了不存在的作者事实', value)
  }

  const goal = getCurvePlanGoalPhrase(seed, choiceFact)
  const trigger = getCurvePlanPressurePhrase(triggerFact)
  const escalation = getCurvePlanPressurePhrase(escalationFact)
  if (!goal || !trigger || !escalation) {
    throwCurveModelValidationFailure('curvePlan 没有提供可逐字承接的目标或压力锚点', value)
  }

  const subject = getStorySubject(seed)
  const direction = getCurvePlanDirectionLanguage(brief)
  const decision = getCurvePlanDecisionPhrase(goal)
  const triggerDetail = `暂定：${trigger}让${subject}${direction.trigger}${decision}`
  const escalationDetail = `暂定：若${subject}继续考虑${decision}，${direction.escalation}${escalation}`
  const choiceDetail = getCurvePlanChoiceDetail(
    subject,
    goal,
    escalation,
    resolutionMode as ModelCurveResolutionMode,
    direction.choiceSuffix,
  )
  const resolutionDetail = getCurvePlanResolutionDetail(
    subject,
    goal,
    escalation,
    resolutionMode as ModelCurveResolutionMode,
    direction.resolutionSuffix,
  )
  const facts = design.sourceFacts.filter((fact) => fact.disposition !== 'parked')

  return {
    beats: [
      {
        kind: 'current-state',
        detail: getCurrentState(seed, idea),
        sourceFactIds: facts.map((fact) => fact.id),
      },
      { kind: 'trigger', detail: triggerDetail, sourceFactIds: [triggerFact.id, choiceFact.id] },
      // Keep the pressure fact first so the derived foundation anchor remains
      // the escalation condition instead of accidentally selecting the goal
      // fact merely because it is also cited by this beat.
      { kind: 'escalation', detail: escalationDetail, sourceFactIds: [escalationFact.id, choiceFact.id] },
      {
        kind: 'climax-choice',
        detail: choiceDetail,
        sourceFactIds: [escalationFact.id, choiceFact.id],
      },
      {
        kind: 'resolution',
        detail: resolutionDetail,
        sourceFactIds: [escalationFact.id, choiceFact.id],
      },
    ],
  }
}

function getCurvePlanGoalPhrase(seed: StorySeed, choiceFact: StorySourceFact): string {
  const lockedGoal = seed.lockedGoal?.trim()
  const source = lockedGoal && hasModelSourceFactEvidence(lockedGoal, choiceFact.text)
    ? lockedGoal
    : getModelCurveFactAnchor(choiceFact.text)
  let normalized = source
    .trim()
    .replace(/^(?:当前(?:目标|想法)[：:]\s*)/u, '')
    .replace(/^(?:想要|想|希望|打算|准备|计划)\s*/u, '')

  // Keep the action/object that the author can review, while leaving the
  // deadline and the decision wrapper to the surrounding sentence. This is
  // what prevents forms such as “在在周五前” and “继续要不要删名”.
  normalized = normalized
    .replace(/^在[^，。！？；\n]{1,24}前(?=(?:把|将|去|看|提交|参加|寻找|归还|离开|决定|选择|判断))/u, '')
    .replace(/^于[^，。！？；\n]{1,24}(?=(?:把|将|去|看|提交|参加|寻找|归还|离开|决定|选择|判断))/u, '')
    .trim()
  const decision = normalized.match(/(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (decision?.[1]?.trim()) return decision[1].trim()
  const intentionDecision = normalized.match(/(?:在[^，。！？；\n]{0,24})?(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (intentionDecision?.[1]?.trim()) return intentionDecision[1].trim()
  return normalized || source.trim()
}

function getCurvePlanPressurePhrase(fact: StorySourceFact): string {
  const text = fact.text
    .trim()
    .replace(/^(?:却|但|同时|并且|然后|随后)\s*/u, '')
  const explicitCommitmentDecision = text.match(/((?:按|依照|按照)(?:原有)?承诺[^，。！？；\n]{0,20})/u)
  if (explicitCommitmentDecision?.[1]?.trim()) return explicitCommitmentDecision[1].trim()
  const commitment = text.match(/(?:答应过|答应|承诺|约定|保证)(.+)$/u)
  if (commitment?.[1]?.trim()) {
    const marker = text.match(/(?:答应过|答应|承诺|约定|保证)/u)?.[0] ?? '承诺'
    return `${marker}${commitment[1].trim()}`
  }
  const decision = text.match(/(?:不知道|不确定|犹豫)?(?:是否|要不要)(.+)$/u)
  if (decision?.[1]?.trim()) return decision[1].trim().replace(/^该/u, '')
  // Keep the object before a deadline marker. Returning only “今晚要归还”
  // loses the actual pressure carrier and makes different facts look alike.
  if (/(?:今晚|明早|明天|后天|今天|周[一二三四五六日天]|本周|下周|月底|月末|截止|期限|归还|必须在[^，。！？；]{0,24}前|要在[^，。！？；]{0,24}前)/u.test(text)) {
    return text
      .replace(/^(?:他|她|我|我们|林澈|沈乔|周岚)\s*/u, '')
      .trim()
  }
  const discovery = text.match(/(?:发现|看到)(.+)$/u)
  if (discovery?.[1]?.trim()) return discovery[1].trim()
  const relation = text.match(/((?:姐姐|哥哥|弟弟|妹妹|朋友|队友|家人|同事|伴侣)[^，。！？；\n]{0,28})/u)
  if (relation?.[1]?.trim()) return relation[1].trim()
  return text
    .replace(/^(?:他|她|我|我们)\s*/u, '')
    .trim()
}

function getCurvePlanChoicePressure(
  pressure: string,
  mode: ModelCurveResolutionMode,
): string {
  if (mode === 'address-pressure-before-goal') return `先处理${pressure}`
  if (mode === 'keep-goal-open-under-pressure') return `暂缓处理${pressure}`
  return `面对${pressure}`
}

function getCurvePlanDecisionPhrase(goal: string): string {
  const normalized = goal.trim()
  if (/^(?:是否|要不要)/u.test(normalized)) return normalized
  return `是否${normalized}`
}

function getCurvePlanChoiceDetail(
  subject: string,
  goal: string,
  pressure: string,
  mode: ModelCurveResolutionMode,
  suffix: string,
): string {
  const pressureSide = getCurvePlanChoicePressure(pressure, mode)
  const decision = getCurvePlanDecisionPhrase(goal)
  // The goal is represented as one compact decision phrase. The pressure side
  // is an unfinished handling choice, so the beat never turns either side into
  // an already-executed result.
  return `暂定：${subject}必须在${goal}与${pressureSide}之间作出选择${suffix}`
}

function getCurvePlanDirectionLanguage(brief: CreativeBrief): {
  trigger: string
  escalation: string
  choiceSuffix: string
  resolutionSuffix: string
} {
  const hasContrast = brief.dramaticForces.includes('contrast')
  const hasCost = brief.dramaticForces.includes('cost')
  const hasSurprise = brief.dramaticForces.includes('surprise')
  const hasMisunderstanding = brief.dramaticForces.includes('misunderstanding')
  const hasGrowth = brief.tones.includes('growth')
  const hasMystery = brief.tones.includes('mystery')
  const hasRelationship = brief.dramaticForces.includes('relationship-tension')
  const choiceMarkers = [
    hasContrast ? '不能再按原有条件继续' : '',
    hasRelationship ? '需要在这段关系中作出选择' : '',
    hasCost ? '需要承担这项取舍' : '',
    hasGrowth ? '并承担这项选择' : '',
  ].filter(Boolean)
  const resolutionMarkers = [
    hasContrast ? '不再照原有条件推进' : '',
    hasRelationship ? '不替作者预设对方回应' : '',
    hasCost ? '取舍仍待作者确认' : '',
  ].filter(Boolean)

  return {
    trigger: hasContrast
      ? '无法按已确认条件继续考虑'
      : hasSurprise
        ? '原有安排被这个变化打断，仍需推进'
        : hasMisunderstanding || hasMystery
          ? '需要先面对其中的信息疑问，才能继续考虑'
          : '无法按原有条件继续考虑',
    escalation: hasRelationship
      ? '还要面对'
      : hasCost
        ? '还要承担'
        : '还要面对',
    choiceSuffix: choiceMarkers.length ? `，${choiceMarkers.join('，')}` : '',
    resolutionSuffix: hasMystery
      ? '，信息疑问仍待作者确认'
      : resolutionMarkers.length
        ? `，${resolutionMarkers.join('，')}`
        : '',
  }
}

function getCurvePlanResolutionDetail(
  subject: string,
  goal: string,
  pressure: string,
  mode: ModelCurveResolutionMode,
  suffix: string,
): string {
  const decision = getCurvePlanDecisionPhrase(goal)
  switch (mode) {
    case 'address-pressure-before-goal':
      return `暂定：这次选择让${subject}面对${pressure}并调整${decision}${suffix}`
    case 'keep-goal-open-under-pressure':
      return `暂定：这次选择让${subject}暂缓${decision}，同时面对${pressure}${suffix}`
    case 'adjust-goal-under-constraint':
      return `暂定：这次选择让${subject}调整${decision}，同时面对${pressure}${suffix}`
  }
}

function buildModelCurveFactAnchoringContract(
  design: StoryDesignRecord,
  seed: StorySeed,
): string {
  const sourceFacts = design.sourceFacts
  const goalFact = sourceFacts.find((fact) => (
    Boolean(seed.lockedGoal) && hasModelSourceFactEvidence(seed.lockedGoal!, fact.text)
  ))
  // A scene observation belongs in current-state. It can inform the author's
  // review, but should not become the structure card's causal premise just
  // because it appears first in the input. Prefer the facts that actually
  // constrain a decision: deadline, commitment, or an explicit blocking fact.
  const urgencyFacts = sourceFacts.filter((fact) => (
    /(?:今晚|明早|周[一二三四五六日天]|归还|截止|期限|倒数|必须在[^，。！？；]{0,24}前|要在[^，。！？；]{0,24}前)/u.test(fact.text)
  ))
  const commitmentFacts = sourceFacts.filter((fact) => (
    /(?:答应|承诺|约定|保证|不再|不要|不得|必须)/u.test(fact.text)
  ))
  const blockingFacts = sourceFacts.filter((fact) => (
    /(?:缺失|卖掉|无法|不能|冲突|分歧|阻碍|失去|取消|拒绝|失败)/u.test(fact.text)
  ))
  const relationshipFacts = sourceFacts.filter((fact) => (
    /(?:姐姐|哥哥|弟弟|妹妹|朋友|队友|家人|同事|伴侣|父亲|母亲)/u.test(fact.text)
  ))
  const sceneObservationFacts = new Set(sourceFacts.filter((fact) => (
    /(?:看到|发现|听见|收到|拿到|在[^，。！？；]{0,28}(?:里|中))/u.test(fact.text)
  )))
  const nonSceneFacts = sourceFacts.filter((fact) => !sceneObservationFacts.has(fact))
  const pickFirst = (...groups: Array<readonly StorySourceFact[]>): StorySourceFact | undefined => (
    groups.flat().find((fact) => Boolean(fact))
  )
  const nonGoalUrgencyFacts = urgencyFacts.filter((fact) => fact.id !== goalFact?.id)
  const nonGoalCommitmentFacts = commitmentFacts.filter((fact) => fact.id !== goalFact?.id)
  const nonGoalBlockingFacts = blockingFacts.filter((fact) => fact.id !== goalFact?.id)
  const nonGoalRelationshipFacts = relationshipFacts.filter((fact) => fact.id !== goalFact?.id)
  const triggerFact = pickFirst(
    nonGoalUrgencyFacts,
    nonGoalBlockingFacts,
    nonGoalCommitmentFacts,
    nonGoalRelationshipFacts,
    nonSceneFacts.filter((fact) => fact.id !== goalFact?.id),
    // A single source fact is valid for sparse material; rich material should
    // reach this branch only when the author supplied no second constraint.
    urgencyFacts,
    commitmentFacts,
    blockingFacts,
    relationshipFacts,
    nonSceneFacts,
  )
  const escalationFact = pickFirst(
    blockingFacts.filter((fact) => fact.id !== triggerFact?.id),
    commitmentFacts.filter((fact) => fact.id !== triggerFact?.id),
    relationshipFacts.filter((fact) => fact.id !== triggerFact?.id),
    urgencyFacts.filter((fact) => fact.id !== triggerFact?.id),
    nonSceneFacts.filter((fact) => fact.id !== triggerFact?.id && fact.id !== goalFact?.id),
    nonSceneFacts.filter((fact) => fact.id !== triggerFact?.id),
  )
    ?? triggerFact
    ?? sourceFacts[0]
  const goal = goalFact ?? sourceFacts.at(-1) ?? sourceFacts[0]

  if (!triggerFact || !escalationFact || !goal) {
    return '事实锚点规则：没有可逐字核对的作者材料时，不要编造 sourceFactIds 或补出新事件。'
  }

  return [
    '按以下事实锚点写（并按槽位分配），sourceFactIds 必须与槽位中的逐字锚点一一对应，不要只复述 ID：',
    `- trigger 槽位：只列 ${triggerFact.id}；detail 必须照抄“${getModelCurveFactAnchor(triggerFact.text)}”，再说明它怎样让目标停住。`,
    `- escalation 槽位：只列 ${escalationFact.id}；detail 必须照抄“${getModelCurveFactAnchor(escalationFact.text)}”，再说明继续目标的具体取舍。`,
    `- climax-choice 槽位：优先只列 ${goal.id}；detail 必须照抄“${getModelCurveFactAnchor(goal.text)}”，并写出主角在两端之间的主动选择。`,
    `- resolution 槽位：优先只列 ${goal.id}；detail 必须照抄“${getModelCurveFactAnchor(goal.text)}”，并写出选择后的抽象变化。`,
    'current-state 可以列出全部 sourceFactIds 以保留完整原始处境；其余节点不要为了覆盖清单而挂上没有写进 detail 的 ID。',
  ].join('\n')
}

function getModelDirectionRequirements(brief: CreativeBrief): string {
  return getCreativeDirectionEvidenceRequirements(brief)
    .map((requirement) => (
      `${requirement.label}：${requirement.earlyKinds.join('/')} 要写出${requirement.earlyInstruction}；${requirement.lateKinds.join('/')} 要写出${requirement.lateInstruction}`
    ))
    .join('；')
}

function getModelDirectionMarkerInstruction(brief: CreativeBrief): string {
  const markers: string[] = []
  for (const force of brief.dramaticForces) {
    if (force === 'contrast') {
      markers.push('反差：trigger 或 escalation 必须把作者条件写成“[作者条件]让[作者目标]无法按已确认条件推进/反而让目标停住”的因果句；climax-choice 或 resolution 必须写“[作者目标]不能再按[作者条件]继续/调整[作者目标]在[作者条件]下的处理方式”。不要孤立写“失效”或“重新理解……要不要……”')
    } else if (force === 'cost') {
      markers.push('代价：trigger 或 escalation 出现“承担/放弃/失去/保留/取舍”之一，climax-choice 或 resolution 出现“在……与……之间选择/取舍”或明确写出承担、放弃的一端')
    } else if (force === 'relationship-tension') {
      markers.push('关系：trigger 或 escalation 写出已确认的承诺/关系/分歧，climax-choice 或 resolution 写出主角如何回应该关系')
    } else if (force === 'misunderstanding') {
      markers.push('误会：trigger 或 escalation 写出信息缺口/疑问，climax-choice 或 resolution 写出澄清或理解的选择')
    } else if (force === 'surprise') {
      markers.push('意外：trigger 或 escalation 写出已确认条件造成的打断/变化，climax-choice 或 resolution 写出调整或重新选择')
    }
  }
  return markers.join('；') || '每个方向词都必须紧贴作者锚点并推进不同因果。'
}

function getCurveBriefQualityInstruction(brief: CreativeBrief): string {
  const forceHints = brief.dramaticForces.map((force) => {
    if (force === 'relationship-tension') return '关系、承诺、回应或分歧'
    if (force === 'misunderstanding') return '误会、信息差或澄清'
    if (force === 'cost') return '代价、放弃或承担'
    if (force === 'surprise') return '意外、变化或时机'
    return '反差、旧办法的局限或重新选择'
  })
  const toneHints = brief.tones.map((tone) => {
    if (tone === 'growth') return '改变、重新或承担'
    if (tone === 'friendship' || tone === 'romance') return '信任、心意或关系'
    if (tone === 'mystery') return '信息、疑问或解释'
    if (tone === 'comedy') return '尴尬、体面或反差'
    if (tone === 'warm') return '理解、照顾或彼此'
    return '规则、边界或未知'
  })
  return `至少三条非 current-state 节点要明确承接戏剧机制（可使用：${[...forceHints, ...toneHints].join('、')}），并让每一条的因果作用不同；不要只重复同一句。请按不同层次推进：character-tension 写关系/承诺如何形成牵制，trigger 写该牵制如何让目标停住，escalation 写继续目标要承担的代价或分歧，midpoint-turn 写旧办法为何失效并需要重新理解，climax-choice 写主角在两端之间的主动选择，resolution 写选择带来的关系或自我改变。至少两条节点各自明确出现戏剧力量词，至少两条各自明确出现故事感觉词；这些词必须服务于不同因果，不要机械重复。`
}

function buildCurveBeatRegenerationPrompt(
  idea: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  target: CurveBeat,
  feedback: string | undefined,
): string {
  const clarificationContext = getClarificationsForBeat(curve, target.id)
  const blockedBeatIds = new Set(curve.beats.filter((beat) => getClarificationsForBeat(curve, beat.id)
    .some((item) => !item.resolution)).map((beat) => beat.id))
  const activeBeats = curve.beats
    .filter((beat) => beat.status !== 'rejected' && !blockedBeatIds.has(beat.id))
    .map((beat) => ({ id: beat.id, kind: beat.kind, detail: beat.detail, status: beat.status, sourceFactIds: beat.sourceFactIds }))
  const upstream = curve.beats
    .filter((beat) => target.dependsOn.includes(beat.id) && beat.status !== 'rejected' && !blockedBeatIds.has(beat.id))
    .map((beat) => ({ id: beat.id, detail: beat.detail }))
  const rejectedProposals = curve.beats
    .filter((beat) => beat.status === 'rejected' && beat.source === 'system-proposal')
    .map((beat) => ({ id: beat.id, detail: beat.detail }))
  const rejectedHistory = (curve.rejectedProposals ?? []).map((beat) => ({ id: beat.id, detail: beat.detail }))
  return `用户原始想法：${idea}\n原始信息：${JSON.stringify({ subject: seed.subject, lockedGoal: seed.lockedGoal, lockedFacts: seed.lockedFacts })}\n不可丢失的原始材料：${JSON.stringify(getClarificationGroundingFacts(curve).map((fact) => ({ id: fact.id, text: fact.text })))}\n创意方向：${JSON.stringify(curve.brief)}\n戏剧机制：${getDramaticMechanism(curve.brief)}\n当前有效曲线：${JSON.stringify(activeBeats)}\n目标节点的上游依据：${JSON.stringify(upstream)}\n已拒绝、不可重用的系统提案：${JSON.stringify([...rejectedProposals, ...rejectedHistory])}\n${clarificationContext.length ? `因果问题与确认状态（缺口本身不是事实；只能使用已确认回答，其他前提必须排除）：${JSON.stringify(clarificationContext.map((item) => ({ question: item.prompt, gap: item.dependency.causalGap, status: item.status, answer: item.status === 'confirmed' ? item.answerText : null })))}\n` : ''}\n只重写目标节点：${JSON.stringify({ id: target.id, kind: target.kind, title: target.title, detail: clarificationContext.length ? '旧提案正在因果审阅，不得复用；按已确认事实重新提案' : target.detail })}${feedback ? `\n作者说明：${feedback}` : ''}\n重写必须具体承接上游依据或作者说明；只保留核心后果并推进新的因果，不得复制上游整句或使用嵌套引号；不得重新使用已拒绝内容，也不得用“更重要的事”“承担代价”等无对象的泛化句代替因果。`
}
