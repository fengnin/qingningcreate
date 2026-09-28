import { AppError, requestQwenJson } from './qwen.js'
import { createNarrativeStateMachine, type StoryValidationContext } from './storyState.js'
import { formatStoryRealityContractContext, storyRealityContractInstruction } from './storyRealityContract.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  GeneratedStory,
  StoryConflict,
  StoryConflictCore,
  StoryConflictCores,
  StoryConflictCoreContext,
  StoryConflictCoreContextPrefill,
  StoryConflictCoreMechanismType,
  StoryConflictCoreSystemDraft,
  StoryFact,
  StoryFactMutability,
  StoryNarrativeState,
  StoryBeat,
  StoryExpansionScope,
  StoryGoalState,
  StoryPredicament,
  StoryPredicamentApproach,
  StoryDirectionsRequest,
  StoryDirectionsResponse,
  StoryPredicamentResponse,
  StoryPredicamentSessionRequest,
  StoryGenerationResponse,
  StoryGenerationSessionRequest,
  StoryHeadTailOption,
  StoryHeadTailOptions,
  StoryHeadTailResponse,
  StoryHeadTailSessionRequest,
  StoryNode,
  StoryPlan,
  StorySeed,
  StoryTurn,
  StoryTurnOption,
  StoryTurnOptionRefinementFocus,
  StoryTurnOptionRefinementRequest,
  StoryTurnHistoryItem,
  StoryTurnMode,
  StoryTurnPhase,
  StoryTurnResponse,
  StoryTurnSessionRequest,
  StoryTransition,
  StoryAction,
  StoryVariationAxis,
  StoryReviewItem,
  StorySessionVersion,
} from '../../shared/story-contract.js'

type ValidationErrorContext = StoryValidationContext

type StoryTurnOutputFormat = 'detailed' | 'compact'

const invalidRequestContext: ValidationErrorContext = {
  statusCode: 400,
  code: 'INVALID_REQUEST',
}

const invalidModelOutputContext: ValidationErrorContext = {
  statusCode: 502,
  code: 'INVALID_MODEL_OUTPUT',
}

const maxConflictCoreGenerationAttempts = 3
const maxConflictCoreReplacementAttempts = 2
const maxConflictCoreContractReviewAttempts = 2
const maxConflictCoreGroundingReviewAttempts = 2
const conflictCoreContractReviewMaxTokens = 2_000
const conflictCoreGroundingReviewMaxTokens = 1_500
const maximumStoryIdeaLength = 120
const maxStorySeedExtractionAttempts = 3
const maxSystemDraftGenerationAttempts = 3
const systemConflictCoreDraftMaxTokens = 1_200
const maximumStorySeedLockedFacts = 5
const maximumStorySeedLockedFactLength = 120
const maximumConflictCoreContextLength = 120
const maximumSystemDraftFieldLength = 64
const maximumSystemDraftDirectionLabelLength = 16
const maxPredicamentGenerationAttempts = 3
const maxHeadTailGenerationAttempts = 2
const maxStoryTurnGenerationAttempts = 3
const maxStoryTurnOptionRefinementAttempts = 2
const maxStoryGenerationAttempts = 3
const storyTurnMaxTokens = 2_800
const storyTurnOptionRefinementMaxTokens = 900
const storyTurnOptionRefinementFocusLabels: Record<StoryTurnOptionRefinementFocus, string> = {
  action: '行动方式',
  consequence: '当下结果',
  tradeoff: '代价取舍',
  tone: '情绪走向',
}
const generatedOptionCount = 3
const minimumConfirmedTurnsBeforeConclusion = 3
const maximumConfirmedStoryTurns = 24
const maximumStoryFacts = 12
// Reserve one action beyond user-confirmed turns for the generated resolution.
const maximumStoryActions = maximumConfirmedStoryTurns + generatedOptionCount + 1
const maximumTransitionFactReferences = 8
const shouldReviewStoryTurnGrounding = process.env.STORY_TURN_GROUNDING_REVIEW?.trim().toLowerCase() === 'true'
const shouldReviewGeneratedStoryConsistency = process.env.STORY_BODY_CONSISTENCY_REVIEW?.trim().toLowerCase() !== 'false'
const shouldLogConflictCoreDiagnostics = process.env.STORY_CONFLICT_CORE_DEBUG?.trim().toLowerCase() === 'true'

const narrativeState = createNarrativeStateMachine({
  maximumActions: maximumStoryActions,
  maximumFacts: maximumStoryFacts,
})

type ConflictCoreContractPart =
  | 'lockedFacts'
  | 'lockedGoal'
  | 'goalThreat'
  | 'singleMechanism'
  | 'tradeoff'
  | 'protagonistDecision'
  | 'sustainedDevelopment'
  | 'escalation'
  | 'balancedApproaches'
  | 'distinctMechanism'
  | 'sharedGoal'
  | 'actionableGoal'
  | 'goalAnchor'
  | 'groundedFacts'
  | 'mechanismEvidence'
  | 'axisFit'
  | 'specificity'
  | 'scope'

type ConflictCoreGoalForm = 'explicit-goal' | 'action' | 'decision' | 'event-or-state'

type ConflictCoreMechanismType = StoryConflictCoreMechanismType

interface UnsupportedDetailRule {
  label: string
  pattern: RegExp
}

interface UnsupportedDetailIssue {
  label: string
  value: string
}

const conflictCoreMechanismTypes: readonly ConflictCoreMechanismType[] = [
  'information-gap',
  'boundary-conflict',
  'meaning-commitment',
  'initiation-block',
  'window-pressure',
  'resource-constraint',
  'commitment-conflict',
]

const conflictCoreMechanismVariationAxis: Record<ConflictCoreMechanismType, StoryVariationAxis> = {
  'information-gap': 'resource',
  'boundary-conflict': 'relationship',
  'meaning-commitment': 'commitment',
  'initiation-block': 'resource',
  'window-pressure': 'time',
  'resource-constraint': 'resource',
  'commitment-conflict': 'commitment',
}

const unestablishedPrecisionPattern = /(?:\d+(?:\.\d+)?\s*(?:%|秒|分钟|小时|天|周|月|年|步|米|公里|点(?:钟)?|时|分)|(?<!下)[零〇一二两三四五六七八九十百千万亿半]+\s*(?:%|秒|分钟|小时|天|周|月|年|步|米|公里|点钟|时|分)|倒数|第(?:\d+|[零〇一二两三四五六七八九十百千万亿半]+)(?:步|次))/gu
const systemDraftMultipleAssumptionsPattern = /(?:、|同时|另外|此外|并且?|以及|还需|还要|先[\s\S]{0,24}?再|不仅[\s\S]{0,24}?还|，(?=[^，。！？；\n]{1,16}(?:必须|只能|不得|会|将|并|且)))/u
// These are semantic claims that can look harmless in a provisional branch,
// but become false facts once later candidates use that branch as evidence.
const semanticUnsupportedDetailRules: readonly UnsupportedDetailRule[] = [
  { label: '权限或交付结论', pattern: /(?:未经许可|未经同意|未被邀请|未获(?:许可|同意|允许|邀请)|没有被允许|自主选择权|选择权|交付方式|交付渠道|授权|权限|越界|越过边界)/gu },
  { label: '现场或过去经历', pattern: /(?:当面|面对面|亲口|口头|现场)/gu },
  { label: '心理或归属判断', pattern: /(?:未放下|放不下|错认主人|认错主人|(?:物品|东西|物件|礼物)?主人(?!公)|所有者|归属(?:未知|不明|尚无|未确认)|(?:主人|所有者)[^，。！？；\n]{0,12}(?:未知|不明|尚未确认|未确认|不清楚|不确定)|(?:主人|所有者|对方|朋友|他人)[^，。！？；\n]{0,12}(?:需要|想要|愿意|意愿|期待|希望|是否仍|不需要|不想))/gu },
  { label: '必要处理条件', pattern: /(?:必须|只能|不得)[^，。！？；\n]{1,24}(?:处理|归还|送回|交付|联系|接触|决定)/gu },
  { label: '资源或暂存状态', pattern: /(?:无法久留|无处存放|无法保管|即将被(?:带走|转交|处理))/gu },
]
const unsupportedGeneratedDetailRules: readonly UnsupportedDetailRule[] = [
  ...semanticUnsupportedDetailRules,
  { label: '技术实施细节', pattern: /(?:USB|Wi-?Fi|账号|密码|验证码|登录|接口|电量|序列号|存储卡|硬盘|芯片|邮箱|垃圾邮件|故障|损坏|失灵|断网)/giu },
  { label: '未经建立的工具或服务', pattern: /(?:第三方[^，。！？；\n]{0,12}(?:工具|服务|软件)|应用商店|下载[^，。！？；\n]{0,18}(?:工具|软件|应用)|安装[^，。！？；\n]{0,18}(?:工具|软件|应用))/gu },
  { label: '资源或操作状态', pattern: /(?:尚未导出|无法导出|正在传输|已上传|已下载|已备份|未备份|格式损坏|无法预览|无法播放|自动删除|自动存档|隐私保护|尚未离开|仍在[^，。！？；\n]{0,10}(?:设备|相机|手机|电脑)|设备状态)/gu },
  { label: '文书或程序细节', pattern: /(?:借条|条款|承诺书|手写|签字|复印件|合同|申请表|审批|登记|手续|校规)/gu },
  { label: '外部身份或机构', pattern: /(?:校方|部门|机构|平台|客服|管理员|工作人员)/gu },
  { label: '他人的既定状态', pattern: /(?:已经断联|拒绝(?:回复|见面|配合)?|不愿(?:回复|见面|配合)?|不再接收|未设置公开联系方式|已经离开|已经到达|已经删除|已经封锁|已读|未读)/gu },
  { label: '他人边界或历史', pattern: /(?:对方(?:明确)?(?:拒绝|禁止|要求不再)|不再接收|不再联系|对方已(?:删除|封锁|拉黑)|断联边界|(?:已|曾|明确)?设(?:定|置)的边界|边界)/gu },
  { label: '未经建立的承诺或关系结论', pattern: /(?:承诺|答应|约定|保证|发誓|义务|责任|不再主动联系|不再打扰|不再联系)/gu },
  { label: '未经建立的绝对结果', pattern: /(?:永久|永远|封存|彻底失去|无法挽回|一定|必然)/gu },
  { label: '未经建立的状态或关联判断', pattern: /(?:当前生活状态|生活状态|生活节奏|关联性|联系间隔|可发送状态|发送状态|不合时宜|合时宜|可察觉变动|近期[^，。！？；\n]{0,12}(?:状态|变化)|已有沉默状态|沉默状态|缓冲期|不可逆的?(?:关系|联系|状态|变化|转变|后果|结果|损失)|默认接受|单方面改变|长期未被触碰|压缩[^，。！？；\n]{0,12}(?:时间|窗口))/gu },
  { label: '未经建立的他人态度或反应', pattern: /(?:对方|朋友|他|她)(?:已经|已|曾|明确|默认|可能|或许)?[^，。！？；\n]{0,20}(?:不适|压力|受伤|生气|介意|期待|希望|愿意|意愿|不想|拒绝|不愿|接受|同意|设置|设定|要求|会|将|可能)/gu },
  { label: '未经建立的关系结果', pattern: /(?:关系|这段关系|两人关系)[^，。！？；\n]{0,20}(?:已经|已|曾|默认|恶化|破裂|恢复|结束|疏远|二次伤害)/gu },
  { label: '未经建立的接触或处理动作', pattern: /(?:主动联系|联系对方|见面|打电话|回复|沟通|解释|挽留)/gu },
  // Causal connectives such as "导致" are not facts by themselves. Keep
  // concrete outcomes here so an abstract mechanism can survive grounding,
  // while an asserted consequence (for example, "导致关系破裂") is still
  // rejected by the more specific rules above.
  { label: '未经建立的外部结果', pattern: /(?:错过|无法按时|重划|跨越|违背|误解|伤害|风险|被[^，。！？；\n]{0,8}(?:转交|带走|处理|公开|泄露)|(?:转交|交由|交给)[^，。！？；\n]{0,12}(?:他人|别人|某人|其他(?:团队|部门|人))|随[^，。！？；\n]{0,12}(?:一同|一起)[^，。！？；\n]{0,8}(?:转交|带走|处理))/gu },
  { label: '未经建立的外部结果', pattern: /(?:引发|导致|造成|意味着)[^，。！？；\n]{1,18}(?:被|将|会|无法|失去|错过|破裂|恶化|拒绝|受伤|泄露|暴露|转交|带走)/gu },
  { label: '心理或关系结论', pattern: /(?:尚未厘清|犹豫|害怕|期待|希望|后悔|在意|无法面对|纠结|担心|觉得|认为|感到|不适|难受|受伤|尴尬|生气|介意|解释或告别|告别还是挽留|自我定义|沉默式容忍|真实意愿|期待看到|关系二次伤害|默认隔离状态|有限清醒时间)/gu },
  { label: '完整行动流程', pattern: /(?:先[\s\S]{0,24}?再|随后|接着)/gu },
]

// The second layer may establish a small current scene, but anything that
// becomes a durable fact, route prerequisite, or stated consequence needs a
// source. These patterns cover common ways a model turns an ordinary scene
// into an invented capability, history, or psychological conclusion.
const predicamentUnsupportedDetailRules: readonly UnsupportedDetailRule[] = [
  ...unsupportedGeneratedDetailRules,
  {
    label: '未经建立的通讯设备或渠道',
    pattern: /(?:一次性|虚拟|匿名)[^，。！？；\n]{0,10}(?:号码|账号|信箱|短信|渠道)|(?:打开|查看|翻找|使用|发送)[^，。！？；\n]{0,12}(?:手机|电话|通讯录|号码|短信|邮箱|社交账号)|(?:手边|身边|带着|拥有)[^，。！？；\n]{0,20}(?:手机|电话|电脑|网络|账号|号码)|(?:已开机|有信号|可用|已登录|可发送)[^，。！？；\n]{0,20}(?:手机|电话|电脑|网络|账号|号码)|(?:手机|电话|电脑|网络|账号|号码)[^，。！？；\n]{0,12}(?:已开机|有信号|可用|已登录|可发送)/gu,
  },
  {
    label: '未经建立的随身物品或容器',
    pattern: /(?:随身|手边|包里|口袋里)[^，。！？；\n]{0,12}(?:小盒|首饰盒|收纳盒|备用袋)/gu,
  },
  {
    label: '未经建立的过往关系细节',
    pattern: /(?:毕业|入学|离校|从前|以前|那年|当年|小时候|童年)[^，。！？；\n]{0,24}(?:送|给|赠|答应|约定|说|见|离开)/gu,
  },
  {
    label: '未经建立的内在结论',
    pattern: /(?:厘清|确认|看清|证明)[^，。！？；\n]{0,10}(?:心意|真心|感情|内心)|(?:牵扯|消耗|耗尽|扰乱)[^，。！？；\n]{0,12}(?:心神|情绪|心绪|精力)|(?:松动|动摇)[^，。！？；\n]{0,12}(?:承诺|边界)/gu,
  },
]

// A route may propose ordinary contact or handling; those are choices rather
// than claims that the channel, permission, or outcome already exists.
const predicamentProposalUnsupportedDetailRules = predicamentUnsupportedDetailRules
  .filter((rule) => ![
    '未经建立的接触或处理动作',
    '必要处理条件',
    '完整行动流程',
  ].includes(rule.label))

// The model review still verifies every first-layer claim against the source.
// This smaller local guard only blocks concrete invented facts. Abstract
// causal language is reviewed semantically instead of by a single word match.
const conflictCoreUnsupportedDetailRules = unsupportedGeneratedDetailRules.filter((rule) => ![
  '权限或交付结论',
  '他人边界或历史',
  '未经建立的状态或关联判断',
  '未经建立的接触或处理动作',
  '未经建立的外部结果',
  '心理或关系结论',
].includes(rule.label))

const conflictCoreContractPartLabel: Record<ConflictCoreContractPart, string> = {
  lockedFacts: '保留原始事实',
  lockedGoal: '保留原始目标',
  goalThreat: '阻碍真正威胁目标',
  singleMechanism: '单一阻碍机制',
  tradeoff: '真正的两难',
  protagonistDecision: '迫使主角主动决定',
  sustainedDevelopment: '可持续推进',
  escalation: '可继续升级',
  balancedApproaches: '两条起点同样成立',
  distinctMechanism: '与其他核心的机制差异',
  sharedGoal: '三条核心共享同一个目标',
  actionableGoal: '目标具体且可行动',
  goalAnchor: '目标锚定原始对象或事件',
  groundedFacts: '没有引入未建立的事实',
  mechanismEvidence: '阻碍机制有原始证据',
  axisFit: '标注的冲突轴符合实际机制',
  specificity: '没有提前写死具体过程',
  scope: '保持原始尺度',
}

const conflictCoreContextLimitedParts = new Set<ConflictCoreContractPart>([
  'groundedFacts',
  'mechanismEvidence',
  'distinctMechanism',
])

// This stays server-side. It guides the second-layer approaches without becoming
// another visible field the user must evaluate in the first-layer picker.
interface StoredStoryConflictCore extends StoryConflictCore {
  decisionFocus?: string
  // These fields stay internal. They make the model name the actual causal
  // mechanism and show which seed text supports it before a card is exposed.
  mechanism?: string
  mechanismType?: ConflictCoreMechanismType
  evidence?: string[]
}

type StoredStoryConflictCores = [
  StoredStoryConflictCore,
  StoredStoryConflictCore,
  StoredStoryConflictCore,
]

interface ConflictCoreContractReview {
  conflictCoreId: string
  preservesLockedFacts: boolean
  preservesLockedGoal: boolean
  obstacleThreatensGoal: boolean
  hasSingleMechanism: boolean
  requiresTradeoff: boolean
  forcesProtagonistDecision: boolean
  supportsSustainedDevelopment: boolean
  hasEscalationPath: boolean
  canSupportBalancedApproaches: boolean
  usesDistinctMechanism: boolean
  sharesCommonGoal: boolean
  hasActionableGoal: boolean
  goalForm: ConflictCoreGoalForm
  goalAnchoredToSeed: boolean
  introducesNoUnestablishedFacts: boolean
  mechanismEvidenceGrounded: boolean
  unestablishedClaims: string[]
  variationAxisFitsMechanism: boolean
  staysWithinScope: boolean
}

interface ConflictCoreGroundingReview {
  conflictCoreId: string
  unestablishedClaims: string[]
}

interface ConflictCoreContractViolation {
  conflictCoreId: string
  title: string
  missingParts: ConflictCoreContractPart[]
  unestablishedClaims?: string[]
}

interface ConflictCoreRepairContext {
  violations: ConflictCoreContractViolation[]
}

type SystemDraftDirection = NonNullable<StoryConflictCoreSystemDraft['directions']>[number]

interface GeneratedTextField {
  label: string
  value: string
}

interface GeneratedFieldGroundingCheck {
  field: GeneratedTextField
  rules: readonly UnsupportedDetailRule[]
}

interface GeneratedFieldGroundingIssue {
  field: GeneratedTextField
  detail: UnsupportedDetailIssue
}

interface ConflictCoreCandidateEvaluation {
  contractReviews: ConflictCoreContractReview[]
  groundingReviews: ConflictCoreGroundingReview[]
  violations: ConflictCoreContractViolation[]
}

interface ConflictCoreReplacementResult {
  cores: StoredStoryConflictCores
  failedViolations: ConflictCoreContractViolation[]
}

interface ConflictCoreRetryState {
  excludedTitles: string[]
  bestViolations?: ConflictCoreContractViolation[]
  lastViolations?: ConflictCoreContractViolation[]
  lastGenerationError?: string
  lastReviewError?: string
}

/** Mutable state for one batch conflict-core generation request. */
interface ConflictCoreGenerationState {
  currentCores?: StoredStoryConflictCores
  repairContext?: ConflictCoreRepairContext
  pendingReplacements?: ConflictCoreContractViolation[]
  readonly unreviewedReplacementIndexes: Set<number>
  readonly groundingReviewCache: Map<StoredStoryConflictCore, ConflictCoreGroundingReview>
  readonly retryState: ConflictCoreRetryState
}

interface ConflictCoreReviewPlan<TReview> {
  label: string
  candidates: readonly StoredStoryConflictCore[]
  maximumAttempts: number
  retryInstruction: string
  requestReview: (repairInstruction?: string) => Promise<TReview[]>
  requestIndividually: () => Promise<TReview[]>
  createProtocolError: () => AppError
}

interface HeadTailGoalReview {
  optionId: string
  keepsConfirmedGoal: boolean
  followsSelectedApproach: boolean
  climaxIsProtagonistAction: boolean
  resolutionFulfillsPlan: boolean
  transitionIsGrounded: boolean
}

interface HeadTailRepairContext {
  violations: string[]
}

interface StoryTurnGroundingReview {
  situationIsGrounded: boolean
  conclusionFulfillsHeadTail: boolean | null
  optionReviews: StoryTurnOptionGroundingReview[]
}

interface StoryTurnOptionGroundingReview {
  optionId: string
  isGrounded: boolean
  detail: string
}

type StoryConclusionWithGeneratedAction = StoryTurn & {
  isConclusion: true
  narrativeAction: StoryAction
  transition: StoryTransition
}

interface ConfirmedStoryPathItem {
  id: string
  label: string
  situation: string
  obstacle: string | null
  selectedAction: string | null
  immediateResult: string | null
}

type StoryBodyConsistencyIssueKind = 'missing-path-item' | 'contradiction' | 'unsupported-critical-detail'

interface StoryBodyConsistencyIssue {
  kind: StoryBodyConsistencyIssueKind
  pathId: string
  detail: string
}

interface StoryBodyConsistencyReview {
  isConsistent: boolean
  issues: StoryBodyConsistencyIssue[]
}

interface StorySessionRecord {
  id: string
  idea: string
  seed: StorySeed
  conflictCores: StoredStoryConflictCores
  selectedConflictCore?: StoredStoryConflictCore
  selectedPredicament?: StoryPredicament
  selectedApproach?: StoryPredicamentApproach
  headTailOptions?: StoryHeadTailOptions
  selectedHeadTail?: StoryHeadTailOption
  state?: StoryNarrativeState
  history: StoryTurnHistoryItem[]
  currentTurn?: StoryTurn
  revision: number
  updatedAt: number
}

interface PersistedStorySessionStore {
  version: 1
  sessions: unknown[]
}

interface StoryFoundation {
  idea: string
  seed: StorySeed
  predicament: StoryPredicament
  approach: StoryPredicamentApproach
}

interface StoryHeadTailRequest extends StoryFoundation {}

interface StoryTurnRequest extends StoryFoundation {
  headTail: StoryHeadTailOption
  mode: StoryTurnMode
  history: StoryTurnHistoryItem[]
}

interface StoryTurnOptionRefinementGenerationRequest extends StoryFoundation {
  headTail: StoryHeadTailOption
  history: StoryTurnHistoryItem[]
  currentTurn: StoryTurn
  originalOption: StoryTurnOption
  focus: StoryTurnOptionRefinementFocus
  feedback: string
}

interface StoryGenerationRequest {
  idea: string
  plan: StoryPlan
}

const configuredStorySessionStorePath = process.env.STORY_SESSION_STORE_PATH?.trim()
const storySessionStorePath = configuredStorySessionStorePath
  ? resolve(configuredStorySessionStorePath)
  : fileURLToPath(new URL('../data/story-sessions.json', import.meta.url))
const storySessions = loadPersistedStorySessions()

const retryableModelOutputErrorCodes = new Set([
  'INVALID_MODEL_OUTPUT',
  'QWEN_EMPTY_RESPONSE',
  'QWEN_INVALID_JSON',
  'QWEN_INVALID_RESPONSE',
])

const transientQwenErrorCodes = new Set([
  'QWEN_NETWORK_ERROR',
  'QWEN_TIMEOUT',
  'QWEN_RATE_LIMITED',
  'QWEN_UPSTREAM_ERROR',
])

const retryableConflictCoreGenerationErrorCodes = new Set([
  ...retryableModelOutputErrorCodes,
  ...transientQwenErrorCodes,
  'INVALID_CONFLICT_CORE_OUTPUT',
  'CONFLICT_CORE_GENERATION_RETRY_EXHAUSTED',
  'CONFLICT_CORE_REPLACEMENT_FAILED',
  'INVALID_CONFLICT_CORE_REPAIR',
])

const retryableConflictCoreReviewErrorCodes = new Set([
  ...retryableModelOutputErrorCodes,
  ...transientQwenErrorCodes,
  'INVALID_CONFLICT_CORE_REVIEW',
  'INVALID_CONFLICT_CORE_GROUNDING_REVIEW',
])

const retryableStoryTurnErrorCodes = new Set([
  'INVALID_MODEL_OUTPUT',
  'QWEN_EMPTY_RESPONSE',
  'QWEN_INVALID_JSON',
  'QWEN_INVALID_RESPONSE',
  'QWEN_TIMEOUT',
  'QWEN_NETWORK_ERROR',
])

interface StorySeedDraft {
  subject: string
  activeSituation: string
  lockedGoal: string | null
  lockedFacts: string[]
  worldMode: 'realistic-default' | 'user-specified'
  unknowns: string[]
}

interface StorySeedExtraction {
  seed: StorySeedDraft
  contextPrefill: StoryConflictCoreContextPrefill
}

interface ResolvedStorySeed {
  seed: StorySeed
  contextPrefill: StoryConflictCoreContextPrefill
  usesOriginalIdeaFallback: boolean
}

export function parseDirectionRequest(body: unknown): StoryDirectionsRequest {
  const record = parseRequestRecord(body, ['idea', 'expansionScope', 'context', 'generateSystemDraft', 'preference', 'excludedTitles', 'storyId', 'revision'])
  const idea = readText(record, 'idea', '请先写下一个故事想法。', maximumStoryIdeaLength, invalidRequestContext)
  const expansionScope = readStoryExpansionScope(record.expansionScope)
  const context = parseConflictCoreContext(record.context)
  const generateSystemDraft = readOptionalBoolean(record, 'generateSystemDraft', '系统生成选项不正确，请重试。', invalidRequestContext) ?? false
  if (context && generateSystemDraft) {
    throw new AppError('请选择让系统先给一版，或提交你确认的设定。', 400, 'INVALID_REQUEST')
  }
  const preference = readOptionalText(record, 'preference', 120)
  const excludedTitles = readTextList(record, 'excludedTitles', 3, 80)
  const storyId = readOptionalIdentifier(record, 'storyId')
  const revision = readOptionalNonNegativeInteger(record, 'revision')

  return { idea, expansionScope, context, generateSystemDraft, preference, excludedTitles, storyId, revision }
}

function parseConflictCoreContext(value: unknown): StoryConflictCoreContext | undefined {
  if (value === undefined || value === null) return undefined

  const message = '补充设定格式不正确，请检查后重试。'
  const context = expectRecord(value, message, invalidRequestContext)
  if (Object.keys(context).some((field) => !['goal', 'stake', 'constraint'].includes(field))) {
    throw new AppError(message, 400, 'INVALID_REQUEST')
  }

  const goal = readOptionalText(context, 'goal', maximumConflictCoreContextLength, message, message)
  const stake = readOptionalText(context, 'stake', maximumConflictCoreContextLength, message, message)
  const constraint = readOptionalText(context, 'constraint', maximumConflictCoreContextLength, message, message)
  if (!goal && !stake && !constraint) {
    throw new AppError('请至少补充一项故事设定。', 400, 'INVALID_REQUEST')
  }

  return {
    ...(goal ? { goal } : {}),
    ...(stake ? { stake } : {}),
    ...(constraint ? { constraint } : {}),
  }
}

export function parsePredicamentSessionRequest(body: unknown): StoryPredicamentSessionRequest {
  const record = parseRequestRecord(body, ['storyId', 'revision', 'conflictCoreId'])
  return {
    ...parseStorySessionReference(record),
    conflictCoreId: readIdentifier(record, 'conflictCoreId', '请选择一个冲突核心。', invalidRequestContext),
  }
}

export function parseHeadTailSessionRequest(body: unknown): StoryHeadTailSessionRequest {
  const record = parseRequestRecord(body, ['storyId', 'revision', 'predicamentId', 'approachId'])
  return {
    ...parseStorySessionReference(record),
    predicamentId: readIdentifier(record, 'predicamentId', '请选择一个故事困境。', invalidRequestContext),
    approachId: readIdentifier(record, 'approachId', '请选择一条应对方向。', invalidRequestContext),
  }
}

export function parseStoryTurnSessionRequest(body: unknown): StoryTurnSessionRequest {
  const record = parseRequestRecord(body, ['storyId', 'revision', 'mode', 'headTailId', 'turnId', 'optionId'])
  const mode = readStoryTurnMode(record.mode, '故事推进请求格式不正确，请重试。', invalidRequestContext)
  const headTailId = readOptionalIdentifier(record, 'headTailId')
  const turnId = readOptionalIdentifier(record, 'turnId')
  const optionId = readOptionalIdentifier(record, 'optionId')

  if (mode === 'start' && (!headTailId || turnId || optionId)) {
    throw new AppError('开始故事时需要确认故事两端。', 400, 'INVALID_REQUEST')
  }

  if (mode !== 'start' && (!turnId || !optionId || headTailId)) {
    throw new AppError('请确认当前情境中的一个行动。', 400, 'INVALID_REQUEST')
  }

  return {
    ...parseStorySessionReference(record),
    mode,
    headTailId,
    turnId,
    optionId,
  }
}

export function parseStoryTurnOptionRefinementRequest(body: unknown): StoryTurnOptionRefinementRequest {
  const record = parseRequestRecord(body, ['storyId', 'revision', 'turnId', 'optionId', 'focus', 'feedback'])
  return {
    ...parseStorySessionReference(record),
    turnId: readIdentifier(record, 'turnId', '当前情境不完整，请刷新后重试。', invalidRequestContext),
    optionId: readIdentifier(record, 'optionId', '请选择要调整的行动。', invalidRequestContext),
    focus: readStoryTurnOptionRefinementFocus(record.focus),
    feedback: readText(record, 'feedback', '调整说明不能为空，请简短说明想改什么。', 160, invalidRequestContext),
  }
}

export function parseStoryGenerationSessionRequest(body: unknown): StoryGenerationSessionRequest {
  const record = parseRequestRecord(body, ['storyId', 'revision'])
  return parseStorySessionReference(record)
}

function parseStorySessionReference(record: Record<string, unknown>): StorySessionVersion {
  return {
    storyId: readIdentifier(record, 'storyId', '当前故事标识不完整，请刷新页面后继续。', invalidRequestContext),
    revision: readNonNegativeInteger(record, 'revision', '故事会话版本不正确，请刷新后重试。', invalidRequestContext),
  }
}

function parseRequestRecord(body: unknown, allowedFields: readonly string[]): Record<string, unknown> {
  const record = expectRecord(body, '请求内容不正确。', invalidRequestContext)
  if (Object.keys(record).some((field) => !allowedFields.includes(field))) {
    throw new AppError('请求不能携带完整故事状态，请只提交当前步骤需要的标识。', 400, 'INVALID_REQUEST')
  }
  return record
}

async function generateConflictCoreSet(
  request: StoryDirectionsRequest,
  existingSeed?: StorySeed,
): Promise<{ seed: StorySeed; conflictCores: StoredStoryConflictCores }> {
  const { seed, contextPrefill } = await prepareConflictCoreGenerationSeed(request, existingSeed)
  const state = createConflictCoreGenerationState(request.excludedTitles)

  for (let attempt = 0; attempt < maxConflictCoreGenerationAttempts; attempt += 1) {
    const conflictCores = await getConflictCoreCandidatesForAttempt(request, seed, state, attempt)
    if (!conflictCores) continue

    const evaluation = await evaluateConflictCoreCandidatesForAttempt(request, seed, conflictCores, state, attempt)
    if (!evaluation) continue

    state.retryState.lastReviewError = undefined
    state.retryState.lastViolations = evaluation.violations
    if (shouldLogConflictCoreDiagnostics) {
      console.warn(`Story conflict core reviews: contract=${JSON.stringify(evaluation.contractReviews)}; grounding=${JSON.stringify(evaluation.groundingReviews)}`)
    }

    if (!evaluation.violations.length) {
      state.unreviewedReplacementIndexes.clear()
      return { seed, conflictCores }
    }

    if (shouldLogConflictCoreDiagnostics) {
      console.warn(`Story conflict core contract violations (attempt ${attempt + 1}): ${JSON.stringify(evaluation.violations)}; candidates=${JSON.stringify(conflictCores)}`)
    }

    scheduleConflictCoreReplacements(state, conflictCores, evaluation.violations)
  }

  // A generic three-card scaffold makes the UI look successful while losing
  // the actual story choices. Surface the retryable generation error instead.
  throw createConflictCoreRetryExhaustedError(state.retryState, contextPrefill, seed)
}

async function prepareConflictCoreGenerationSeed(
  request: StoryDirectionsRequest,
  existingSeed?: StorySeed,
): Promise<{ seed: StorySeed; contextPrefill: StoryConflictCoreContextPrefill }> {
  const resolvedSeed = existingSeed
    ? {
      seed: existingSeed,
      contextPrefill: getConflictCoreContextPrefill(existingSeed),
      usesOriginalIdeaFallback: false,
    }
    : await resolveStorySeed(request)
  let seed = releaseActiveSystemDraftDirection(resolvedSeed.seed, existingSeed, request)
  const { contextPrefill } = resolvedSeed

  const existingSystemDraft = seed.systemDraft
  if (!request.generateSystemDraft && existingSystemDraft && existingSystemDraft.origin !== 'deterministic-fallback') {
    try {
      validateSystemConflictCoreDraft(request.idea, seed, existingSystemDraft)
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      console.warn(`Discarding rejected system draft and generating concrete story hooks directly: ${getErrorIdentifier(error)}`)
      seed = withoutSystemConflictCoreDraft(seed)
    }
  }

  if (resolvedSeed.usesOriginalIdeaFallback && !request.context && !request.generateSystemDraft) {
    throw createConflictCoreContextRequiredError(contextPrefill)
  }

  if (request.generateSystemDraft) {
    try {
      seed = applySystemConflictCoreDraft(seed, await generateSystemConflictCoreDraft(request.idea, seed))
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      // A rejected setup used to be replaced by abstract labels. Generate the
      // concrete three-hook comparison directly from the original seed.
      console.warn(`System draft unavailable; generating concrete story hooks directly: ${getErrorIdentifier(error)}`)
      seed = withoutSystemConflictCoreDraft(seed)
    }
  }

  return { seed, contextPrefill }
}

function withoutSystemConflictCoreDraft(seed: StorySeed): StorySeed {
  const { systemDraft: _systemDraft, ...seedWithoutSystemDraft } = seed
  return seedWithoutSystemDraft
}

function releaseActiveSystemDraftDirection(
  seed: StorySeed,
  existingSeed: StorySeed | undefined,
  request: StoryDirectionsRequest,
): StorySeed {
  // Re-entering the picker asks for a new comparison set. Keep the planned
  // directions, but release the prior choice so each branch can be generated.
  if (!existingSeed?.systemDraft?.activeDirection || request.context || request.generateSystemDraft) {
    return seed
  }

  const systemDraft = seed.systemDraft
  if (!systemDraft) {
    throw new AppError('系统暂定设定不完整，请重新生成。', 502, 'INVALID_MODEL_OUTPUT')
  }

  return {
    ...seed,
    systemDraft: {
      ...systemDraft,
      activeDirection: undefined,
    },
  }
}

function createConflictCoreGenerationState(excludedTitles: string[] | undefined): ConflictCoreGenerationState {
  return {
    unreviewedReplacementIndexes: new Set(),
    groundingReviewCache: new Map(),
    retryState: { excludedTitles: excludedTitles ?? [] },
  }
}

async function getConflictCoreCandidatesForAttempt(
  request: StoryDirectionsRequest,
  seed: StorySeed,
  state: ConflictCoreGenerationState,
  attempt: number,
): Promise<StoredStoryConflictCores | undefined> {
  if (state.pendingReplacements?.length) {
    const replacementCores = await replaceBatchConflictCoreCandidates(request, seed, state, attempt)
    if (replacementCores) state.currentCores = replacementCores
    return replacementCores
  }

  if (state.currentCores) return state.currentCores

  const generatedCores = await generateBatchConflictCoreCandidates(request, seed, state, attempt)
  if (generatedCores) state.currentCores = generatedCores
  return generatedCores
}

async function generateBatchConflictCoreCandidates(
  request: StoryDirectionsRequest,
  seed: StorySeed,
  state: ConflictCoreGenerationState,
  attempt: number,
): Promise<StoredStoryConflictCores | undefined> {
  try {
    const cores = await generateConflictCoreBatch(
      withConflictCoreExcludedTitles(request, state.retryState),
      seed,
      state.repairContext,
      attempt,
    )
    state.retryState.lastGenerationError = undefined
    return cores
  } catch (error) {
    if (!isRetryableConflictCoreGenerationError(error)) throw error

    const failure = rememberConflictCoreGenerationFailure(state.retryState, error)
    console.warn(`Story conflict core generation rejected (attempt ${attempt + 1}): ${failure}`)
    return undefined
  }
}

async function replaceBatchConflictCoreCandidates(
  request: StoryDirectionsRequest,
  seed: StorySeed,
  state: ConflictCoreGenerationState,
  attempt: number,
): Promise<StoredStoryConflictCores | undefined> {
  if (!state.currentCores || !state.pendingReplacements?.length) {
    throw new AppError('冲突核心替换状态不完整，请重新生成。', 502, 'INVALID_CONFLICT_CORE_REPAIR')
  }

  try {
    const replacementResult = await replaceConflictCoreCandidates(
      withConflictCoreExcludedTitles(request, state.retryState),
      seed,
      state.currentCores,
      state.pendingReplacements,
      attempt,
      state.unreviewedReplacementIndexes,
    )
    state.currentCores = replacementResult.cores
    state.pendingReplacements = replacementResult.failedViolations.length
      ? replacementResult.failedViolations
      : undefined
    if (state.pendingReplacements) {
      state.retryState.lastGenerationError ||= '替换候选生成失败。'
      return undefined
    }

    state.retryState.lastGenerationError = undefined
    return replacementResult.cores
  } catch (error) {
    if (!isRetryableConflictCoreGenerationError(error)) throw error

    const failure = rememberConflictCoreGenerationFailure(state.retryState, error)
    console.warn(`Story conflict core replacement rejected (attempt ${attempt + 1}): ${failure}`)
    return undefined
  }
}

async function evaluateConflictCoreCandidatesForAttempt(
  request: StoryDirectionsRequest,
  seed: StorySeed,
  conflictCores: StoredStoryConflictCores,
  state: ConflictCoreGenerationState,
  attempt: number,
): Promise<ConflictCoreCandidateEvaluation | undefined> {
  try {
    return await evaluateConflictCoreCandidate(
      request.idea,
      seed,
      request.expansionScope ?? 'keep-scale',
      conflictCores,
      state.groundingReviewCache,
    )
  } catch (error) {
    if (isRetryableConflictCoreReviewError(error)) {
      state.retryState.lastReviewError = describeConflictCoreReviewFailure(error)
      console.warn(`Story conflict core review rejected; retaining current candidates (attempt ${attempt + 1}): ${state.retryState.lastReviewError}`)
      return undefined
    }

    console.warn(`Story conflict core review was unavailable: ${getErrorIdentifier(error)}`)
    throw createConflictCoreReviewUnavailableError(error)
  }
}

function scheduleConflictCoreReplacements(
  state: ConflictCoreGenerationState,
  conflictCores: StoredStoryConflictCores,
  violations: ConflictCoreContractViolation[],
) {
  if (!state.retryState.bestViolations || violations.length < state.retryState.bestViolations.length) {
    state.retryState.bestViolations = violations
  }

  state.repairContext = { violations }
  state.pendingReplacements = violations
  state.unreviewedReplacementIndexes.clear()
  violations.forEach((violation) => {
    const index = getConflictCoreIndex(violation.conflictCoreId)
    if (index !== undefined) state.unreviewedReplacementIndexes.add(index)
  })
  state.retryState.excludedTitles = [...new Set([
    ...state.retryState.excludedTitles,
    ...conflictCores.map((core) => core.title),
  ])]
}

function withConflictCoreExcludedTitles(
  request: StoryDirectionsRequest,
  retryState: ConflictCoreRetryState,
): StoryDirectionsRequest {
  return { ...request, excludedTitles: retryState.excludedTitles }
}

function rememberConflictCoreGenerationFailure(
  retryState: ConflictCoreRetryState,
  error: unknown,
  prefix = '',
): string {
  const failure = `${prefix}${describeConflictCoreGenerationFailure(error)}`
  retryState.lastGenerationError = failure
  return failure
}

async function generateConflictCoreBatch(
  request: StoryDirectionsRequest,
  seed: StorySeed,
  repairContext: ConflictCoreRepairContext | undefined,
  attempt: number,
): Promise<StoredStoryConflictCores> {
  const record = await requestModelRecord({
    systemPrompt: `${conflictCoreSystemPrompt}\n\n${conflictCoreGenerationSupplement}\n\n${conflictCoreFieldSeparationSupplement}\n\n${getConflictCoreAllowedSourceRule(seed)}${getSystemDraftPromptSupplement(seed)}`,
    userPrompt: buildConflictCorePrompt(request, seed, repairContext),
    temperature: attempt === 0 ? 0.52 : 0.36,
    maxTokens: 3_000,
  }, '模型没有返回可用的冲突核心，请重试。')
  if (shouldLogConflictCoreDiagnostics) {
    console.warn(`Story conflict core candidate: ${JSON.stringify(record.cores)}`)
  }
  const values = expectGeneratedOptionItems(
    record.cores,
    '模型没有生成完整的三个冲突核心，请重试。',
    'INVALID_CONFLICT_CORE_OUTPUT',
  )
  const cores = parseGeneratedOptionTuple(values, parseModelConflictCore)
  cores.forEach((core) => assertConflictCoreUsesSupportedDetails(request.idea, seed, core))
  assertConflictCoreBatchMatchesSystemDraft(seed, cores)
  return cores
}

function getSystemDraftDirection(
  seed: Pick<StorySeed, 'systemDraft'>,
  index: number,
): SystemDraftDirection | undefined {
  return seed.systemDraft?.activeDirection ?? seed.systemDraft?.directions?.[index]
}

// Picker operations resolve the original index before a branch becomes active;
// this keeps re-selection correct even when a previous branch is still active.
function getSystemDraftDirectionForIndex(
  seed: Pick<StorySeed, 'systemDraft'>,
  index: number,
): SystemDraftDirection | undefined {
  return seed.systemDraft?.directions?.[index] ?? seed.systemDraft?.activeDirection
}

function assertConflictCoreBatchMatchesSystemDraft(
  seed: Pick<StorySeed, 'systemDraft'>,
  cores: StoredStoryConflictCores,
) {
  const directions = seed.systemDraft?.directions
  if (!directions) return

  cores.forEach((core, index) => {
    const direction = getSystemDraftDirection(seed, index)
    if (!direction || core.mechanismType !== direction.mechanismType) {
      throw new AppError(
        `第 ${index + 1} 条冲突核心没有沿用对应的系统暂定分支，请重试。`,
        502,
        'INVALID_CONFLICT_CORE_OUTPUT',
      )
    }

    if (!core.evidence?.some((evidence) => hasOriginalTextPhrase(direction.premise, evidence)
      || hasOriginalTextPhrase(direction.tradeoff, evidence))) {
      throw new AppError(
        `第 ${index + 1} 条冲突核心没有引用对应分支的暂定依据，请重试。`,
        502,
        'INVALID_CONFLICT_CORE_OUTPUT',
      )
    }
  })
}

async function replaceConflictCoreCandidates(
  request: StoryDirectionsRequest,
  seed: StorySeed,
  cores: StoredStoryConflictCores,
  violations: ConflictCoreContractViolation[],
  generationRound: number,
  unreviewedReplacementIndexes: Set<number>,
): Promise<ConflictCoreReplacementResult> {
  const violationById = new Map(violations.map((violation) => [violation.conflictCoreId, violation]))
  const replacementIndexes = cores.flatMap((core, index) => (violationById.has(core.id) ? [index] : []))

  if (!replacementIndexes.length) {
    throw new AppError('冲突核心审核没有指出可替换的候选，请重新生成。', 502, 'INVALID_CONFLICT_CORE_REPAIR')
  }

  const replacementIndexSet = new Set(replacementIndexes)
  // Only candidates that passed the previous review are stable anchors. A
  // replacement has not been reviewed yet and must not constrain another
  // replacement's mechanism or evidence.
  const retainedCores = cores.filter((_, candidateIndex) => (
    !replacementIndexSet.has(candidateIndex) && !unreviewedReplacementIndexes.has(candidateIndex)
  ))
  const nextCores = [...cores]
  const failedViolations: ConflictCoreContractViolation[] = []

  for (const index of replacementIndexes) {
    const target = cores[index]
    const violation = violationById.get(target.id)
    if (!violation) continue

    try {
      const replacement = await generateConflictCoreReplacement(
        request,
        seed,
        target,
        index,
        retainedCores,
        violation,
        generationRound,
      )
      nextCores[index] = replacement
      unreviewedReplacementIndexes.add(index)
    } catch (error) {
      if (!isRetryableConflictCoreGenerationError(error)) throw error
      failedViolations.push(violation)
    }
  }

  return {
    cores: [nextCores[0], nextCores[1], nextCores[2]],
    failedViolations,
  }
}

async function generateConflictCoreReplacement(
  request: StoryDirectionsRequest,
  seed: StorySeed,
  target: StoredStoryConflictCore,
  targetIndex: number,
  retainedCores: StoredStoryConflictCore[],
  violation: ConflictCoreContractViolation,
  generationRound: number,
): Promise<StoredStoryConflictCore> {
  let lastGenerationError: string | undefined

  for (let attempt = 0; attempt < maxConflictCoreReplacementAttempts; attempt += 1) {
    try {
      const record = await requestModelRecord({
        systemPrompt: `${conflictCoreSystemPrompt}\n\n${conflictCoreGenerationSupplement}\n\n${conflictCoreFieldSeparationSupplement}\n\n${getConflictCoreAllowedSourceRule(seed)}${getSystemDraftPromptSupplement(seed)}`,
        userPrompt: buildConflictCoreReplacementPrompt(request, seed, target, retainedCores, violation),
        temperature: attempt === 0 ? 0.36 : 0.2,
        maxTokens: 1_400,
      }, '模型没有返回可用的替换冲突核心，请重试。')
      const replacementValue = isPlainRecord(record.core)
        ? record.core
        : Array.isArray(record.cores) && record.cores.length
          ? record.cores[0]
          : record
      const replacement = parseModelConflictCore(replacementValue, targetIndex)
      assertConflictCoreUsesSupportedDetails(request.idea, seed, replacement)
      const direction = getSystemDraftDirection(seed, targetIndex)
      if (direction && replacement.mechanismType !== direction.mechanismType) {
        throw new AppError(
          `第 ${targetIndex + 1} 条替换核心没有沿用对应的系统暂定分支，请重试。`,
          502,
          'INVALID_CONFLICT_CORE_OUTPUT',
        )
      }
      if (direction && !replacement.evidence?.some((evidence) => hasOriginalTextPhrase(direction.premise, evidence)
        || hasOriginalTextPhrase(direction.tradeoff, evidence))) {
        throw new AppError(
          `第 ${targetIndex + 1} 条替换核心没有引用对应分支的暂定依据，请重试。`,
          502,
          'INVALID_CONFLICT_CORE_OUTPUT',
        )
      }
      return replacement
    } catch (error) {
      if (!isRetryableConflictCoreGenerationError(error)) throw error

      lastGenerationError = describeConflictCoreGenerationFailure(error)
      console.warn(
        `Story conflict core replacement rejected (round ${generationRound + 1}, attempt ${attempt + 1}): ${lastGenerationError}`,
      )
    }
  }

  throw new AppError(
    `模型没有返回可替换的冲突核心（${lastGenerationError ?? '输出不完整'}），请重新生成。`,
    502,
    'CONFLICT_CORE_REPLACEMENT_FAILED',
  )
}

async function generatePredicamentForCore(
  session: StorySessionRecord,
  core: StoredStoryConflictCore,
): Promise<StoryPredicament> {
  let repairMessage: string | undefined
  const seed = getStorySeedForConflictCore(session.seed, core)

  for (let attempt = 0; attempt < maxPredicamentGenerationAttempts; attempt += 1) {
    try {
      const record = await requestModelRecord({
        systemPrompt: `${predicamentExpansionSystemPrompt}\n\n${storyRealityContractInstruction}`,
        userPrompt: buildPredicamentExpansionPrompt(session.idea, seed, core, repairMessage),
        temperature: attempt === 0 ? 0.68 : 0.5,
        maxTokens: 2_000,
      }, '模型没有返回可用的具体困境，请重试。')
      const generatedPredicament = parsePredicament(
        expectRecord(record.predicament, '模型返回的具体困境不完整，请重试。', invalidModelOutputContext),
        invalidModelOutputContext,
        '模型返回的具体困境不完整，请重试。',
        'predicament-1',
      )
      const predicament = generatedPredicament
      validatePredicamentForConflictCore(session.idea, seed, core, predicament)
      return predicament
    } catch (error) {
      if (!isRetryablePredicamentGenerationError(error)) throw error
      repairMessage = error.message
      if (shouldLogConflictCoreDiagnostics) {
        console.warn(`Predicament generation rejected (attempt ${attempt + 1}): ${repairMessage}`)
      }
    }
  }

  throw new AppError('具体困境连续生成失败，请返回上一步重新选择冲突核心。', 502, 'PREDICAMENT_EXPANSION_FAILED')
}

function isRetryablePredicamentGenerationError(error: unknown): error is AppError {
  return error instanceof AppError
    && (retryableModelOutputErrorCodes.has(error.code) || transientQwenErrorCodes.has(error.code))
}

type PredicamentConflictCore = Pick<StoryConflictCore, 'variationAxis' | 'preservedGoal' | 'obstacle' | 'tradeoff'>

export function validatePredicamentForConflictCore(
  idea: string,
  seed: Pick<StorySeed, 'activeSituation' | 'lockedFacts' | 'systemDraft'>,
  core: PredicamentConflictCore,
  predicament: StoryPredicament,
) {
  assertPredicamentCriticalDetails(idea, seed, core, predicament)
  assertPredicamentMatchesConflictCore(predicament, core)
}

function assertPredicamentCriticalDetails(
  idea: string,
  seed: Pick<StorySeed, 'activeSituation' | 'lockedFacts' | 'systemDraft'>,
  core: PredicamentConflictCore,
  predicament: StoryPredicament,
) {
  const sourceTexts = [
    idea,
    ...getConflictCoreEvidenceSourceTexts(seed),
    core.preservedGoal,
    core.obstacle,
    core.tradeoff,
  ]
  const issue = findFirstUnsupportedGeneratedField(
    sourceTexts,
    getPredicamentFieldGroundingChecks(predicament),
  )

  if (issue?.detail) {
    throw new AppError(
      `具体困境${issue.field.label}加入了未建立的${issue.detail.label}“${issue.detail.value}”，请重试。`,
      invalidModelOutputContext.statusCode,
      'INVALID_MODEL_OUTPUT',
    )
  }
}

function getPredicamentFieldGroundingChecks(
  predicament: StoryPredicament,
): GeneratedFieldGroundingCheck[] {
  return [
    ...createFieldGroundingChecks(
      getPredicamentFactualFields(predicament),
      predicamentUnsupportedDetailRules,
    ),
    ...createFieldGroundingChecks(
      getPredicamentProposalFields(predicament),
      predicamentProposalUnsupportedDetailRules,
    ),
  ]
}

function getPredicamentFactualFields(predicament: StoryPredicament): GeneratedTextField[] {
  return [
    { label: '当前场景', value: predicament.immediateSituation },
    { label: '当前压力', value: predicament.urgency },
    { label: '选择焦点', value: predicament.choice },
    { label: '共同风险', value: predicament.plausibleCost },
    ...predicament.facts.map((fact, index) => ({ label: `第 ${index + 1} 条暂定事实`, value: fact.statement })),
  ]
}

function getPredicamentProposalFields(predicament: StoryPredicament): GeneratedTextField[] {
  return [
    ...predicament.approaches.flatMap((approach, index) => [
      { label: `第 ${index + 1} 条应对方向`, value: approach.intent },
      { label: `第 ${index + 1} 条应对代价`, value: approach.cost },
    ]),
    ...predicament.actions.map((action, index) => ({ label: `第 ${index + 1} 个行动意图`, value: action.intent })),
  ]
}

function getStorySeedForConflictCore(
  seed: StorySeed,
  core: Pick<StoredStoryConflictCore, 'id'>,
): StorySeed {
  const directionIndex = getConflictCoreIndex(core.id)
  const direction = directionIndex === undefined ? undefined : getSystemDraftDirectionForIndex(seed, directionIndex)
  if (!seed.systemDraft || !direction) return seed

  return {
    ...seed,
    systemDraft: {
      ...seed.systemDraft,
      directions: [direction],
      activeDirection: direction,
    },
  }
}

function assertPredicamentMatchesConflictCore(
  predicament: StoryPredicament,
  core: PredicamentConflictCore,
) {
  if (
    predicament.variationAxis !== core.variationAxis
    || predicament.preservedGoal !== core.preservedGoal
    || predicament.obstacle !== core.obstacle
    || predicament.tradeoff !== core.tradeoff
  ) {
    throw new AppError('模型没有保持已确认的冲突核心，请重试。', 502, 'INVALID_MODEL_OUTPUT')
  }
}

async function reviewConflictCoreContract(
  idea: string,
  seed: StorySeed,
  expansionScope: StoryExpansionScope,
  cores: StoredStoryConflictCores,
): Promise<ConflictCoreContractReview[]> {
  return runConflictCoreReview({
    label: 'contract',
    candidates: cores,
    maximumAttempts: maxConflictCoreContractReviewAttempts,
    retryInstruction: '上一版没有满足审核 JSON 协议。必须只返回 reviews 数组，条数和 conflictCoreId 必须与输入候选完全一致；每项必须包含全部布尔字段与 unestablishedClaims 数组。',
    requestReview: (repairInstruction) => requestConflictCoreContractReview(
      idea,
      seed,
      expansionScope,
      cores,
      repairInstruction,
    ),
    requestIndividually: () => reviewConflictCoreContractIndividually(idea, seed, expansionScope, cores),
    createProtocolError: () => new AppError(
      '模型没有完成冲突核心的质量检查，请重试。',
      502,
      'INVALID_CONFLICT_CORE_REVIEW',
    ),
  })
}

async function requestConflictCoreContractReview(
  idea: string,
  seed: StorySeed,
  expansionScope: StoryExpansionScope,
  cores: readonly StoredStoryConflictCore[],
  repairMessage?: string,
  comparisonCores: readonly StoredStoryConflictCore[] = cores,
): Promise<ConflictCoreContractReview[]> {
  const record = await requestModelRecord({
    systemPrompt: `${conflictCoreContractReviewSystemPrompt}\n\n${conflictCoreReviewSupplement}\n\n${conflictCoreReviewEvidenceSupplement}\n\n${getConflictCoreAllowedSourceRule(seed)}${getSystemDraftPromptSupplement(seed)}`,
    userPrompt: buildConflictCoreReviewPrompt(idea, seed, expansionScope, cores, repairMessage, comparisonCores),
    temperature: 0.1,
    maxTokens: conflictCoreContractReviewMaxTokens,
  }, '模型没有完成冲突核心的质量检查，请重试。')
  return parseConflictCoreReviews(record.reviews, cores)
}

async function reviewConflictCoreContractIndividually(
  idea: string,
  seed: StorySeed,
  expansionScope: StoryExpansionScope,
  cores: StoredStoryConflictCores,
): Promise<ConflictCoreContractReview[]> {
  return reviewConflictCoreCandidatesIndividually(cores, (core) => (
    requestConflictCoreContractReview(
      idea,
      seed,
      expansionScope,
      [core],
      '这是批量审核的协议兜底。只返回当前这一条的 review；仍需把横向比较参考中的其他候选纳入 usesDistinctMechanism 和 sharesCommonGoal 判断。',
      cores,
    )
  ))
}

async function reviewConflictCoreGrounding(
  idea: string,
  seed: StorySeed,
  cores: readonly StoredStoryConflictCore[],
): Promise<ConflictCoreGroundingReview[]> {
  return runConflictCoreReview({
    label: 'grounding',
    candidates: cores,
    maximumAttempts: maxConflictCoreGroundingReviewAttempts,
    retryInstruction: '上一版没有满足审核 JSON 协议。必须只返回 reviews 数组，条数和 conflictCoreId 必须与输入候选完全一致；每项都必须包含 unestablishedClaims 数组。',
    requestReview: (repairInstruction) => requestConflictCoreGroundingReview(
      idea,
      seed,
      cores,
      repairInstruction,
    ),
    requestIndividually: () => reviewConflictCoreGroundingIndividually(idea, seed, cores),
    createProtocolError: () => new AppError(
      '模型没有完成冲突核心的事实核对，请重试。',
      502,
      'INVALID_CONFLICT_CORE_GROUNDING_REVIEW',
    ),
  })
}

async function runConflictCoreReview<TReview>({
  label,
  candidates,
  maximumAttempts,
  retryInstruction,
  requestReview,
  requestIndividually,
  createProtocolError,
}: ConflictCoreReviewPlan<TReview>): Promise<TReview[]> {
  let lastReviewError: unknown

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      return await requestReview(attempt === 0 ? undefined : retryInstruction)
    } catch (error) {
      if (!isRetryableConflictCoreReviewError(error)) throw error

      lastReviewError = error
      console.warn(`Story conflict core ${label} review rejected (attempt ${attempt + 1}): ${describeConflictCoreReviewFailure(error)}`)
    }
  }

  if (candidates.length > 1) {
    console.warn(`Story conflict core ${label} batch did not satisfy the protocol; retrying each candidate independently.`)
    return requestIndividually()
  }

  throw lastReviewError ?? createProtocolError()
}

async function requestConflictCoreGroundingReview(
  idea: string,
  seed: StorySeed,
  cores: readonly StoredStoryConflictCore[],
  repairMessage?: string,
): Promise<ConflictCoreGroundingReview[]> {
  const record = await requestModelRecord({
    systemPrompt: `${getConflictCoreGroundingReviewSystemPrompt(seed)}\n\n${getConflictCoreAllowedSourceRule(seed)}${getSystemDraftPromptSupplement(seed)}`,
    userPrompt: buildConflictCoreGroundingReviewPrompt(idea, seed, cores, repairMessage),
    temperature: 0.1,
    maxTokens: conflictCoreGroundingReviewMaxTokens,
  }, '模型没有完成冲突核心的事实核对，请重试。')
  if (shouldLogConflictCoreDiagnostics) {
    console.warn(`Story conflict core grounding review shape: ${describeConflictCoreGroundingReviewShape(record.reviews)}`)
  }
  return parseConflictCoreGroundingReviews(record.reviews, cores)
}

async function reviewConflictCoreGroundingIndividually(
  idea: string,
  seed: StorySeed,
  cores: readonly StoredStoryConflictCore[],
): Promise<ConflictCoreGroundingReview[]> {
  return reviewConflictCoreCandidatesIndividually(
    cores,
    (core) => reviewConflictCoreGrounding(idea, seed, [core]),
  )
}

async function reviewConflictCoreCandidatesIndividually<TReview>(
  cores: readonly StoredStoryConflictCore[],
  requestCandidateReview: (core: StoredStoryConflictCore) => Promise<TReview[]>,
): Promise<TReview[]> {
  const reviews: TReview[] = []

  for (const core of cores) {
    const [review] = await requestCandidateReview(core)
    reviews.push(review)
  }

  return reviews
}

function describeConflictCoreGroundingReviewShape(value: unknown): string {
  if (!Array.isArray(value)) return `reviews=${value === null ? 'null' : typeof value}`

  const entries = value.map((item) => {
    if (!isPlainRecord(item)) return typeof item

    const id = typeof item.conflictCoreId === 'string' ? item.conflictCoreId : typeof item.conflictCoreId
    const claims = item.unestablishedClaims
    return `${id}:${Array.isArray(claims) ? claims.length : typeof claims}`
  })

  return `reviews=${value.length}; entries=${entries.join(',')}`
}

async function evaluateConflictCoreCandidate(
  idea: string,
  seed: StorySeed,
  expansionScope: StoryExpansionScope,
  cores: StoredStoryConflictCores,
  groundingReviewCache: Map<StoredStoryConflictCore, ConflictCoreGroundingReview>,
): Promise<ConflictCoreCandidateEvaluation> {
  const contractReviews = await reviewConflictCoreContract(idea, seed, expansionScope, cores)
  const coresNeedingGroundingReview = cores.filter((core) => !groundingReviewCache.has(core))

  if (coresNeedingGroundingReview.length) {
    const newGroundingReviews = await reviewConflictCoreGrounding(idea, seed, coresNeedingGroundingReview)
    const newGroundingReviewById = new Map(newGroundingReviews.map((review) => [review.conflictCoreId, review]))

    for (const core of coresNeedingGroundingReview) {
      const review = requireReviewForCandidate(
        newGroundingReviewById,
        core.id,
        '模型事实核对结果没有覆盖全部冲突核心，请重试。',
        'INVALID_CONFLICT_CORE_GROUNDING_REVIEW',
      )
      groundingReviewCache.set(core, review)
    }
  }

  const groundingReviews = cores.map((core) => {
    const review = groundingReviewCache.get(core)
    if (!review) {
      throw new AppError(
        '模型事实核对结果没有覆盖全部冲突核心，请重试。',
        invalidModelOutputContext.statusCode,
        'INVALID_CONFLICT_CORE_GROUNDING_REVIEW',
      )
    }
    return review
  })
  const violations = collectConflictCoreViolations(seed, cores, contractReviews, groundingReviews)

  return { contractReviews, groundingReviews, violations }
}

function collectConflictCoreViolations(
  seed: StorySeed,
  cores: StoredStoryConflictCores,
  reviews: ConflictCoreContractReview[],
  groundingReviews: ConflictCoreGroundingReview[],
): ConflictCoreContractViolation[] {
  const reviewById = new Map(reviews.map((review) => [review.conflictCoreId, review]))
  const groundingReviewById = new Map(groundingReviews.map((review) => [review.conflictCoreId, review]))
  const sharedGoal = seed.lockedGoal ?? cores[0].preservedGoal
  const hasDistinctDeclaredMechanisms = hasDistinctConflictCoreMechanisms(cores)

  return cores.flatMap((core) => {
    const review = requireReviewForCandidate(
      reviewById,
      core.id,
      '模型审查结果没有覆盖全部冲突核心，请重试。',
      'INVALID_CONFLICT_CORE_REVIEW',
    )
    const groundingReview = requireReviewForCandidate(
      groundingReviewById,
      core.id,
      '模型事实核对结果没有覆盖全部冲突核心，请重试。',
      'INVALID_CONFLICT_CORE_GROUNDING_REVIEW',
    )
    const missingParts = findConflictCoreMissingParts(
      seed,
      core,
      review,
      groundingReview,
      sharedGoal,
      hasDistinctDeclaredMechanisms,
    )
    if (!missingParts.length) return []

    return [{
      conflictCoreId: core.id,
      title: core.title,
      missingParts,
      unestablishedClaims: collectUnestablishedClaims(review, groundingReview),
    }]
  })
}

function findConflictCoreMissingParts(
  seed: StorySeed,
  core: StoredStoryConflictCore,
  review: ConflictCoreContractReview,
  groundingReview: ConflictCoreGroundingReview,
  sharedGoal: string,
  hasDistinctDeclaredMechanisms: boolean,
): ConflictCoreContractPart[] {
  const hasUnestablishedClaims = review.unestablishedClaims.length > 0 || groundingReview.unestablishedClaims.length > 0
  const requirements: Array<[ConflictCoreContractPart, boolean]> = [
    ['lockedFacts', review.preservesLockedFacts],
    ['lockedGoal', !seed.lockedGoal || (core.preservedGoal === seed.lockedGoal && review.preservesLockedGoal)],
    ['goalThreat', review.obstacleThreatensGoal],
    ['singleMechanism', review.hasSingleMechanism],
    ['tradeoff', review.requiresTradeoff],
    ['protagonistDecision', review.forcesProtagonistDecision],
    ['distinctMechanism', review.usesDistinctMechanism && hasDistinctDeclaredMechanisms],
    ['sharedGoal', core.preservedGoal === sharedGoal && review.sharesCommonGoal],
    ['actionableGoal', review.hasActionableGoal && review.goalForm !== 'event-or-state' && !goalOnlyRestatesSeedEvent(seed, core.preservedGoal)],
    ['goalAnchor', review.goalAnchoredToSeed && goalReferencesSeed(seed, core.preservedGoal)],
    ['groundedFacts', review.introducesNoUnestablishedFacts && !hasUnestablishedClaims],
    ['mechanismEvidence', review.mechanismEvidenceGrounded && hasConflictCoreEvidenceFromPremises(seed, core)],
    ['axisFit', review.variationAxisFitsMechanism],
    ['specificity', !containsUnestablishedPrecision(seed, core)],
    ['scope', review.staysWithinScope],
  ]

  return requirements
    .filter(([, isSatisfied]) => !isSatisfied)
    .map(([part]) => part)
}

function collectUnestablishedClaims(
  review: ConflictCoreContractReview,
  groundingReview: ConflictCoreGroundingReview,
): string[] {
  return [...new Set([...review.unestablishedClaims, ...groundingReview.unestablishedClaims])]
}

function hasDistinctConflictCoreMechanisms(cores: StoredStoryConflictCores): boolean {
  const mechanismTypes = cores.map((core) => core.mechanismType)
  return mechanismTypes.every((type): type is ConflictCoreMechanismType => type !== undefined)
    && new Set(mechanismTypes).size === mechanismTypes.length
}

function shouldRequestMoreConflictCoreContext(violations: ConflictCoreContractViolation[]): boolean {
  if (!violations.length) return false

  // A candidate that repeatedly fails grounding or mechanism coverage needs
  // more confirmed premises. This remains true even when other candidates
  // passed, because the caller can preserve those candidates while the user
  // confirms only the missing context for the failed one.
  return violations.some(({ missingParts }) => missingParts.some((part) => conflictCoreContextLimitedParts.has(part)))
}

function createConflictCoreRetryExhaustedError({
  bestViolations,
  lastViolations,
  lastGenerationError,
  lastReviewError,
}: ConflictCoreRetryState, contextPrefill: StoryConflictCoreContextPrefill, seed: Pick<StorySeed, 'systemDraft'>): AppError {
  const hasContextLimitedViolations = [bestViolations, lastViolations]
    .some((violations) => violations !== undefined && shouldRequestMoreConflictCoreContext(violations))

  if (hasContextLimitedViolations) {
    if (seed.systemDraft) {
      return new AppError(
        '系统暂定设定已经生成，但其中的分支没有通过事实核对；当前候选没有被放行。请重新生成一版系统暂定设定。',
        502,
        'SYSTEM_DRAFT_CONFLICT_CORE_RETRY_EXHAUSTED',
        undefined,
        seed.systemDraft,
      )
    }

    return createConflictCoreContextRequiredError(contextPrefill)
  }

  if (lastGenerationError && !bestViolations) {
    return new AppError(
      `模型连续 ${maxConflictCoreGenerationAttempts} 次没有返回完整的冲突核心（${lastGenerationError}），请重新生成。`,
      502,
      'CONFLICT_CORE_GENERATION_RETRY_EXHAUSTED',
    )
  }

  if (lastGenerationError) {
    return new AppError(
      `已保留通过审核的冲突核心，但不合格候选替换失败（${lastGenerationError}），请重新生成。`,
      502,
      'CONFLICT_CORE_REPLACEMENT_FAILED',
    )
  }

  if (lastReviewError && !bestViolations) {
    return new AppError(
      `模型连续 ${maxConflictCoreGenerationAttempts} 次没有返回可用的冲突核心审核（${lastReviewError}），请重新生成。`,
      502,
      'CONFLICT_CORE_REVIEW_RETRY_EXHAUSTED',
    )
  }

  if (lastReviewError) {
    return new AppError(
      `已生成候选，但冲突核心审核连续失败（${lastReviewError}）；当前候选没有被放行，请重新生成。`,
      502,
      'CONFLICT_CORE_REVIEW_RETRY_EXHAUSTED',
    )
  }

  return new AppError(
    '当前念头还没有稳定生成三条同时满足原始事实、共同目标和机制差异的冲突核心，请补充设定或重新生成。',
    502,
    'CONFLICT_CORE_FIDELITY_FAILED',
  )
}

function createConflictCoreContextRequiredError(
  contextPrefill: StoryConflictCoreContextPrefill,
): AppError {
  return new AppError(
    '当前念头还缺少能稳定支撑三种不同冲突机制的事实。请选择让系统先给一版，或补充并确认故事设定。',
    422,
    'CONFLICT_CORE_NEEDS_CONTEXT',
    hasConflictCoreContextPrefill(contextPrefill) ? contextPrefill : undefined,
  )
}

function hasConflictCoreEvidenceFromPremises(seed: StorySeed, core: StoredStoryConflictCore): boolean {
  const evidence = core.evidence ?? []
  if (!evidence.length) return false

  return evidence.every((item) => getConflictCoreEvidenceSourceTextsForCore(seed, core)
    .some((source) => hasOriginalTextPhrase(source, item)))
}

function goalReferencesSeed(seed: StorySeed, goal: string): boolean {
  if (seed.lockedGoal) return goal === seed.lockedGoal

  if (seed.systemDraft) {
    return goal === seed.systemDraft.goal && goalReferencesUserSeed(seed, goal)
  }

  return goalReferencesUserSeed(seed, goal)
}

function goalReferencesUserSeed(seed: Pick<StorySeed, 'activeSituation' | 'lockedFacts'>, goal: string): boolean {
  const seedTerms = extractGoalAnchorTerms(getUserConfirmedSeedSourceTexts(seed))
  const normalizedGoal = goal.toLocaleLowerCase()
  return seedTerms.some((term) => normalizedGoal.includes(term.toLocaleLowerCase()))
}

function goalOnlyRestatesSeedEvent(seed: StorySeed, goal: string): boolean {
  if (seed.lockedGoal || seed.systemDraft) return false

  const normalizedGoal = normalizeGoalText(goal)
  return getUserConfirmedSeedSourceTexts(seed)
    .some((source) => normalizeGoalText(source) === normalizedGoal)
}

function getUserConfirmedSeedSourceTexts(seed: Pick<StorySeed, 'activeSituation' | 'lockedFacts'>): string[] {
  return [seed.activeSituation, ...seed.lockedFacts]
}

function getSystemDraftSourceTexts(seed: Pick<StorySeed, 'systemDraft'>): string[] {
  if (!seed.systemDraft) return []

  const directions = seed.systemDraft.activeDirection
    ? [seed.systemDraft.activeDirection]
    : seed.systemDraft.directions ?? []
  return [
    seed.systemDraft.goal,
    seed.systemDraft.stake,
    seed.systemDraft.constraint,
    ...directions.flatMap((direction) => [direction.premise, direction.tradeoff]),
  ]
}

function getConflictCoreEvidenceSourceTexts(
  seed: Pick<StorySeed, 'activeSituation' | 'lockedFacts' | 'systemDraft'>,
): string[] {
  return [...getUserConfirmedSeedSourceTexts(seed), ...getSystemDraftSourceTexts(seed)]
}

function getConflictCoreEvidenceSourceTextsForCore(
  seed: StorySeed,
  core: Pick<StoredStoryConflictCore, 'id'>,
): string[] {
  if (!seed.systemDraft?.directions && !seed.systemDraft?.activeDirection) return getConflictCoreEvidenceSourceTexts(seed)

  const index = getConflictCoreIndex(core.id)
  const direction = index === undefined
    ? seed.systemDraft.activeDirection
    : getSystemDraftDirection(seed, index)
  return [
    ...getUserConfirmedSeedSourceTexts(seed),
    seed.systemDraft.goal,
    seed.systemDraft.stake,
    seed.systemDraft.constraint,
    ...(direction ? [direction.premise, direction.tradeoff] : []),
  ]
}

function getConflictCoreIndex(id: string): number | undefined {
  const match = /^conflict-core-([1-3])$/.exec(id)
  return match ? Number(match[1]) - 1 : undefined
}

function normalizeGoalText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function hasOriginalTextPhrase(source: string, phrase: string): boolean {
  const normalizedSource = source.replace(/\s+/gu, '')
  const normalizedPhrase = phrase.replace(/\s+/gu, '')
  return Boolean(normalizedPhrase) && normalizedSource.includes(normalizedPhrase)
}

function containsUnestablishedPrecision(seed: StorySeed, core: StoredStoryConflictCore): boolean {
  const establishedText = getConflictCoreEvidenceSourceTextsForCore(seed, core).join('')
  const candidateText = [core.obstacle, core.tradeoff, core.storyHook ?? '', core.decisionFocus ?? '', core.mechanism ?? ''].join('')
  return (candidateText.match(unestablishedPrecisionPattern) ?? [])
    .some((match) => !establishedText.includes(match))
}

function extractGoalAnchorTerms(sourceTexts: string[]): string[] {
  const terms = new Set<string>()

  for (const sourceText of sourceTexts) {
    for (const term of sourceText.match(/[A-Za-z0-9]+|[\u4e00-\u9fff]+/g) ?? []) {
      if (/^[\u4e00-\u9fff]+$/.test(term)) {
        const maximumLength = Math.min(4, term.length)
        for (let length = maximumLength; length >= 2; length -= 1) {
          for (let start = 0; start + length <= term.length; start += 1) {
            terms.add(term.slice(start, start + length))
          }
        }
      } else if (term.length >= 1) {
        terms.add(term)
      }
    }
  }

  return [...terms]
}

export async function generateDirections(request: StoryDirectionsRequest): Promise<StoryDirectionsResponse> {
  if (request.storyId) {
    const session = getStorySession(request.storyId, request.revision)
    if (request.idea !== session.idea) {
      throw new AppError('故事想法已改变，请从第一步重新生成困境。', 409, 'STORY_SESSION_CONFLICT')
    }

    const result = await generateConflictCoreSet({
      ...request,
      idea: session.idea,
      expansionScope: session.seed.expansionScope,
    }, request.context ? undefined : session.seed)
    assertStorySessionRevision(session, request.revision)
    replaceSessionConflictCores(session, result)
    return createConflictCoreResponse(session, result.seed, result.conflictCores)
  }

  const { seed, conflictCores } = await generateConflictCoreSet(request)
  const session = createStorySession(request.idea, seed, conflictCores)
  storySessions.set(session.id, session)
  persistStorySessions()

  return createConflictCoreResponse(session, seed, conflictCores)
}

function createConflictCoreResponse(
  session: Pick<StorySessionRecord, 'id' | 'revision'>,
  seed: StorySeed,
  conflictCores: StoredStoryConflictCores,
): StoryDirectionsResponse {
  return {
    storyId: session.id,
    revision: session.revision,
    seed,
    conflictCores: toPublicConflictCores(conflictCores),
  }
}

export async function generateSessionPredicament(
  request: StoryPredicamentSessionRequest,
): Promise<StoryPredicamentResponse> {
  const session = getStorySession(request.storyId, request.revision)
  const core = session.conflictCores.find((candidate) => candidate.id === request.conflictCoreId)
  if (!core) {
    throw new AppError('所选冲突核心已不在当前会话中，请重新选择。', 409, 'STORY_SESSION_CONFLICT')
  }

  const predicament = await generatePredicamentForCore(session, core)
  assertStorySessionRevision(session, request.revision)
  replaceSessionPredicament(session, core, predicament)
  return { storyId: session.id, revision: session.revision, predicament }
}

async function resolveStorySeed(request: StoryDirectionsRequest): Promise<ResolvedStorySeed> {
  let repairMessage: string | undefined

  for (let attempt = 0; attempt < maxStorySeedExtractionAttempts; attempt += 1) {
    try {
      const extraction = await extractStorySeed(request.idea, repairMessage, attempt)
      assertStorySeedUsesOriginalText(request.idea, extraction.seed)
      const contextPrefill = retainOriginalContextPrefill(request.idea, extraction.contextPrefill)
      return {
        seed: {
          ...applyConflictCoreContext(extraction.seed, request.context),
          expansionScope: request.expansionScope ?? 'keep-scale',
        },
        contextPrefill,
        usesOriginalIdeaFallback: false,
      }
    } catch (error) {
      if (!isRetryableStorySeedExtractionError(error)) throw error

      repairMessage = getStorySeedExtractionRepairMessage(error)
      console.warn(`Story seed extraction rejected (attempt ${attempt + 1}): ${getErrorIdentifier(error)}`)
    }
  }

  console.warn(`Story seed extraction fell back to the original idea after ${maxStorySeedExtractionAttempts} rejected attempts.`)
  const fallbackSeed = createOriginalIdeaFallbackSeed(request.idea, request.context)
  return {
    seed: {
      ...fallbackSeed,
      expansionScope: request.expansionScope ?? 'keep-scale',
    },
    contextPrefill: getConflictCoreContextPrefill(fallbackSeed),
    usesOriginalIdeaFallback: true,
  }
}

function isRetryableStorySeedExtractionError(error: unknown): boolean {
  return error instanceof AppError
    && (retryableModelOutputErrorCodes.has(error.code) || transientQwenErrorCodes.has(error.code))
}

function getStorySeedExtractionRepairMessage(error: unknown): string {
  if (error instanceof AppError && error.code === 'INVALID_MODEL_OUTPUT') {
    return '上一版缺少必填字段，或没有逐字保留原始念头中的锁定信息。'
  }

  return '上一版不是可读取的完整 JSON。'
}

function createOriginalIdeaFallbackSeed(
  idea: string,
  context: StoryConflictCoreContext | undefined,
): StorySeedDraft {
  const lockedFacts = [...new Set([
    idea,
    ...[context?.stake, context?.constraint].filter((value): value is string => Boolean(value)),
  ])]
  const unknowns = [
    ...(!context?.goal ? ['主角此刻的具体目标'] : []),
    ...(!context?.stake ? ['主角最在意的事'] : []),
    ...(!context?.constraint ? ['当前限制或阻碍'] : []),
  ]

  return {
    // Preserve the raw idea verbatim instead of inferring actors or facts locally.
    subject: idea,
    activeSituation: idea,
    lockedGoal: context?.goal ?? null,
    lockedFacts,
    worldMode: 'realistic-default',
    unknowns,
  }
}

async function extractStorySeed(
  idea: string,
  repairMessage: string | undefined,
  attempt: number,
): Promise<StorySeedExtraction> {
  const record = await requestModelRecord({
    systemPrompt: storySeedSystemPrompt,
    userPrompt: buildStorySeedPrompt(idea, repairMessage),
    temperature: attempt === 0 ? 0.1 : 0.05,
    maxTokens: 680,
  }, '模型没有识别出原始念头中的锁定信息，请重试。')

  // json_object models occasionally omit the schema's seed wrapper.
  const seedRecord = isPlainRecord(record.seed) ? record.seed : record
  const seed = parseStorySeedDraft(seedRecord, invalidModelOutputContext)
  return {
    seed,
    contextPrefill: parseStorySeedContextPrefill(seedRecord.contextPrefill, seed),
  }
}

function assertStorySeedUsesOriginalText(idea: string, seed: StorySeedDraft) {
  const quotedValues = [...seed.lockedFacts, ...(seed.lockedGoal ? [seed.lockedGoal] : [])]
  const hasUnquotedValue = quotedValues.some((value) => !hasOriginalTextPhrase(idea, value))
  if (hasUnquotedValue) {
    throw new AppError('模型没有逐字保留原始念头中的锁定事实或目标，请重试。', 502, 'INVALID_MODEL_OUTPUT')
  }
}

function retainOriginalContextPrefill(
  idea: string,
  contextPrefill: StoryConflictCoreContextPrefill,
): StoryConflictCoreContextPrefill {
  const goal = contextPrefill.goal && hasOriginalTextPhrase(idea, contextPrefill.goal)
    ? contextPrefill.goal
    : undefined
  const stake = contextPrefill.stake && hasOriginalTextPhrase(idea, contextPrefill.stake)
    ? contextPrefill.stake
    : undefined
  const constraint = contextPrefill.constraint && hasOriginalTextPhrase(idea, contextPrefill.constraint)
    ? contextPrefill.constraint
    : undefined

  return {
    ...(goal ? { goal } : {}),
    ...(stake ? { stake } : {}),
    ...(constraint ? { constraint } : {}),
  }
}

function getConflictCoreContextPrefill(
  seed: Pick<StorySeed, 'lockedGoal'>,
): StoryConflictCoreContextPrefill {
  return seed.lockedGoal ? { goal: seed.lockedGoal } : {}
}

function hasConflictCoreContextPrefill(contextPrefill: StoryConflictCoreContextPrefill): boolean {
  return Boolean(contextPrefill.goal || contextPrefill.stake || contextPrefill.constraint)
}

function applyConflictCoreContext(
  extractedSeed: StorySeedDraft,
  context: StoryConflictCoreContext | undefined,
): StorySeedDraft {
  if (!context) return extractedSeed

  const confirmedFacts = [context.stake, context.constraint]
    .filter((value): value is string => Boolean(value))
  const lockedFacts = [...new Set([...extractedSeed.lockedFacts, ...confirmedFacts])]

  return {
    ...extractedSeed,
    lockedGoal: context.goal ?? extractedSeed.lockedGoal,
    lockedFacts: lockedFacts.slice(0, maximumStorySeedLockedFacts),
  }
}

async function generateSystemConflictCoreDraft(
  idea: string,
  seed: StorySeed,
): Promise<StoryConflictCoreSystemDraft> {
  let repairMessage: string | undefined
  let candidate: StoryConflictCoreSystemDraft | undefined

  for (let attempt = 0; attempt < maxSystemDraftGenerationAttempts; attempt += 1) {
    try {
      const record = await requestModelRecord({
        systemPrompt: systemConflictCoreDraftSystemPrompt,
        userPrompt: candidate
          ? buildSystemConflictCoreDraftRepairPrompt(idea, seed, candidate, repairMessage ?? '上一版没有通过最小事实检查。')
          : buildSystemConflictCoreDraftPrompt(idea, seed, repairMessage),
        temperature: attempt === 0 ? 0.22 : 0.1,
        maxTokens: systemConflictCoreDraftMaxTokens,
      }, '模型没有生成可用的暂定故事设定，请重试。')
      const draft = parseSystemConflictCoreDraft(record, seed.lockedGoal)
      candidate = draft
      if (shouldLogConflictCoreDiagnostics) {
        console.warn(`System conflict core draft candidate (attempt ${attempt + 1}): ${JSON.stringify(draft)}`)
      }
      validateSystemConflictCoreDraft(idea, seed, draft)
      return draft
    } catch (error) {
      if (!isRetryableSystemDraftGenerationError(error)) throw error

      repairMessage = describeSystemDraftGenerationFailure(error)
      if (shouldLogConflictCoreDiagnostics) {
        console.warn(`System conflict core draft rejected (attempt ${attempt + 1}): ${repairMessage}`)
      }
    }
  }

  throw new AppError(
    '系统暂定设定没有通过最小事实检查；当前候选没有被采用。请重新生成一版系统暂定分支。',
    502,
    'SYSTEM_DRAFT_GENERATION_FAILED',
  )
}

function isRetryableSystemDraftGenerationError(error: unknown): boolean {
  return error instanceof AppError
    && (retryableModelOutputErrorCodes.has(error.code) || transientQwenErrorCodes.has(error.code))
}

function describeSystemDraftGenerationFailure(error: unknown): string {
  return error instanceof AppError
    ? error.message
    : '上一版不是完整的 JSON 对象。'
}

function parseSystemConflictCoreDraft(
  value: unknown,
  lockedGoal: string | null,
): StoryConflictCoreSystemDraft {
  const message = '模型没有生成完整的暂定故事设定，请重试。'
  const rootRecord = expectRecord(value, message, invalidModelOutputContext)
  // json_object models occasionally omit the schema's systemDraft wrapper.
  const record = isPlainRecord(rootRecord.systemDraft) ? rootRecord.systemDraft : rootRecord

  const directions = parseSystemDraftDirections(record.directions, message)

  return {
    goal: lockedGoal ?? readText(record, 'goal', message, maximumSystemDraftFieldLength, invalidModelOutputContext),
    stake: readText(record, 'stake', message, maximumSystemDraftFieldLength, invalidModelOutputContext),
    constraint: readText(record, 'constraint', message, maximumSystemDraftFieldLength, invalidModelOutputContext),
    origin: 'model',
    ...(directions ? { directions } : {}),
  }
}

function parseSystemDraftDirections(
  value: unknown,
  message: string,
): StoryConflictCoreSystemDraft['directions'] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length !== generatedOptionCount) {
    throw new AppError('系统暂定设定必须包含三条彼此不同的冲突方向，请重试。', invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
  }

  const directions = value.map((item) => {
    const record = expectRecord(item, message, invalidModelOutputContext)
    return {
      label: readText(record, 'label', message, maximumSystemDraftDirectionLabelLength, invalidModelOutputContext),
      mechanismType: readConflictCoreMechanismType(record.mechanismType, message),
      premise: readText(record, 'premise', message, maximumSystemDraftFieldLength, invalidModelOutputContext),
      tradeoff: readText(record, 'tradeoff', message, maximumSystemDraftFieldLength, invalidModelOutputContext),
    } satisfies SystemDraftDirection
  })

  return directions
}

export function validateSystemConflictCoreDraft(
  idea: string,
  seed: Pick<StorySeed, 'activeSituation' | 'lockedGoal' | 'lockedFacts'>,
  draft: StoryConflictCoreSystemDraft,
) {
  const normalizedValues = [draft.goal, draft.stake, draft.constraint].map(normalizeGoalText)
  if (new Set(normalizedValues).size !== normalizedValues.length) {
    throw new AppError('系统暂定设定没有区分目标、代价和限制，请重试。', 502, 'INVALID_MODEL_OUTPUT')
  }

  if (!seed.lockedGoal && !goalReferencesUserSeed(seed, draft.goal)) {
    throw new AppError('系统暂定目标没有锚定原始念头，请重试。', 502, 'INVALID_MODEL_OUTPUT')
  }

  const directions = draft.directions
  if (!directions || directions.length !== generatedOptionCount) {
    throw new AppError('系统暂定设定没有规划三条独立冲突方向，请重试。', 502, 'INVALID_MODEL_OUTPUT')
  }

  const mechanismTypes = directions.map((direction) => direction.mechanismType)
  if (new Set(mechanismTypes).size !== mechanismTypes.length) {
    throw new AppError('系统暂定设定的三条冲突方向不能使用同一种机制，请重试。', 502, 'INVALID_MODEL_OUTPUT')
  }

  const directionTexts = directions.flatMap((direction) => [direction.label, direction.premise, direction.tradeoff])
    .map(normalizeGoalText)
  if (new Set(directionTexts).size !== directionTexts.length) {
    throw new AppError('系统暂定设定的三条冲突方向不能互相重复，请重试。', 502, 'INVALID_MODEL_OUTPUT')
  }

  assertSystemDraftUsesMinimalAssumptions(idea, seed, draft)
}

function assertSystemDraftUsesMinimalAssumptions(
  idea: string,
  seed: Pick<StorySeed, 'activeSituation' | 'lockedGoal' | 'lockedFacts'>,
  draft: StoryConflictCoreSystemDraft,
) {
  const issues = collectSystemDraftMinimalAssumptionIssues(idea, seed, draft)
  if (issues.length) {
    throw new AppError(
      `系统暂定设定需要收紧：${issues.slice(0, 6).join('；')}。请只保留抽象、单一、可编辑的前提。`,
      502,
      'INVALID_MODEL_OUTPUT',
    )
  }
}

function collectSystemDraftMinimalAssumptionIssues(
  idea: string,
  seed: Pick<StorySeed, 'activeSituation' | 'lockedGoal' | 'lockedFacts'>,
  draft: StoryConflictCoreSystemDraft,
): string[] {
  const issues: string[] = []
  for (const field of getSystemDraftGeneratedFields(seed, draft)) {
    const structuralIssue = getSystemDraftStructuralIssue(field.value)
    if (structuralIssue) {
      issues.push(`${field.label}${structuralIssue}`)
      continue
    }

    const unsupportedDetail = findUnsupportedSystemDraftDetail(idea, seed, field.value)
    if (unsupportedDetail) issues.push(`${field.label}加入了未建立的${unsupportedDetail.label}“${unsupportedDetail.value}”`)
  }
  return issues
}

function getSystemDraftGeneratedFields(
  seed: Pick<StorySeed, 'lockedGoal'>,
  draft: StoryConflictCoreSystemDraft,
): GeneratedTextField[] {
  return [
    ...(!seed.lockedGoal ? [{ label: '共同目标', value: draft.goal }] : []),
    { label: '共同代价', value: draft.stake },
    { label: '共同限制', value: draft.constraint },
    ...(draft.directions ?? []).flatMap((direction, index) => [
      { label: `第 ${index + 1} 条分支前提`, value: direction.premise },
      { label: `第 ${index + 1} 条分支取舍`, value: direction.tradeoff },
    ]),
  ]
}

function getSystemDraftStructuralIssue(value: string): string | undefined {
  const withoutTerminalPunctuation = value.trim().replace(/[。！？]+$/u, '')
  if (/[\r\n。！？；]/u.test(withoutTerminalPunctuation)) return '包含了多句或多段内容'
  if (systemDraftMultipleAssumptionsPattern.test(value)) return '叠加了多个设定'
  return undefined
}

function findUnsupportedSystemDraftDetail(
  idea: string,
  seed: Pick<StorySeed, 'activeSituation' | 'lockedFacts'>,
  value: string,
): UnsupportedDetailIssue | undefined {
  return findUnsupportedGeneratedDetailFromRules(
    [idea, ...getUserConfirmedSeedSourceTexts(seed)],
    value,
    unsupportedGeneratedDetailRules,
  )
}

function findUnsupportedGeneratedDetailFromRules(
  establishedSourceTexts: readonly string[],
  value: string,
  rules: readonly UnsupportedDetailRule[],
): UnsupportedDetailIssue | undefined {
  const establishedText = establishedSourceTexts.join('\n')
  const precision = Array.from(value.matchAll(unestablishedPrecisionPattern))
    .map((match) => match[0])
    .find((match) => !hasOriginalTextPhrase(establishedText, match))
  if (precision) return { label: '精确数值或时限', value: precision }

  for (const rule of rules) {
    const unsupportedMatch = Array.from(value.matchAll(rule.pattern))
      .map((match) => match[0])
      .find((match) => !isGeneratedDetailSupported(establishedText, value, match, rule.label))
    if (unsupportedMatch) return { label: rule.label, value: unsupportedMatch }
  }

  return undefined
}

function createFieldGroundingChecks(
  fields: readonly GeneratedTextField[],
  rules: readonly UnsupportedDetailRule[],
): GeneratedFieldGroundingCheck[] {
  return fields.map((field) => ({ field, rules }))
}

function findFirstUnsupportedGeneratedField(
  establishedSourceTexts: readonly string[],
  checks: readonly GeneratedFieldGroundingCheck[],
): GeneratedFieldGroundingIssue | undefined {
  for (const { field, rules } of checks) {
    if (!field.value.trim()) continue

    const detail = findUnsupportedGeneratedDetailFromRules(
      establishedSourceTexts,
      field.value,
      rules,
    )
    if (detail) return { field, detail }
  }

  return undefined
}

function isGeneratedDetailSupported(
  establishedText: string,
  candidateText: string,
  match: string,
  label: string,
): boolean {
  // A literal phrase is normally enough to prove that a detail was supplied
  // by the user. Relationship/commitment phrases still need a role check:
  // copying "不再联系" into "对方不再联系" would otherwise turn the
  // protagonist's own promise into somebody else's boundary.
  if (label === '未经建立的承诺或关系结论' || label === '他人边界或历史') {
    if (hasOtherPersonBoundaryContext(candidateText, match)) {
      return hasEstablishedOtherPersonBoundary(establishedText, candidateText)
    }
  }

  if (hasOriginalTextPhrase(establishedText, match)) return true

  // A direct commitment can be summarized with a close synonym, but the
  // committed action itself must still overlap the user's wording. This lets
  // "答应过不再打扰" become "不再打扰的承诺" while rejecting additions such
  // as "毕业前不再主动联系" or a newly asserted relationship boundary.
  if (label === '未经建立的承诺或关系结论') {
    if (hasOtherPersonCommitmentContext(candidateText, match)) return false
    return hasSupportedCommitmentAction(establishedText, candidateText)
      || (extractCommitmentActionPhrases(candidateText).length === 0 && hasEstablishedCommitment(establishedText))
  }

  if (label === '未经建立的接触或处理动作' && match === '主动联系') {
    return hasSupportedCommitmentAction(establishedText, candidateText)
  }

  // A user's own confirmed commitment can be described as a boundary or
  // self-restraint. Do not extend that permission to a newly asserted
  // boundary belonging to another person.
  if (label === '他人边界或历史' && match === '边界') {
    const matchIndex = candidateText.indexOf(match)
    const nearbyText = matchIndex >= 0 ? candidateText.slice(Math.max(0, matchIndex - 12), matchIndex + match.length) : ''
    return /(?:自己|自身|自我|主角|已有|既有)[^，。！？；\n]{0,8}边界/u.test(nearbyText)
      && hasEstablishedCommitment(establishedText)
  }

  // "违背自己的承诺" is the direct tradeoff implied by an established
  // commitment. Other outcome words remain unsupported unless quoted verbatim.
  if (label === '未经建立的外部结果' && match === '风险') {
    // "承担一项风险" is an abstract tradeoff. A risk tied to a concrete
    // invented event ("暴露行踪的风险", "误送的风险") remains unsupported.
    const matchIndex = candidateText.indexOf(match)
    const nearbyText = matchIndex >= 0
      ? candidateText.slice(Math.max(0, matchIndex - 16), matchIndex + match.length)
      : ''
    return !/(?:暴露|误送|伤害|误解|失去|错过|破坏|泄露|失败)/u.test(nearbyText)
  }

  return label === '未经建立的外部结果'
    && match === '违背'
    && hasSupportedCommitmentAction(establishedText, candidateText)
}

function hasSupportedCommitmentAction(establishedText: string, candidateText: string): boolean {
  const establishedActions = extractCommitmentActionPhrases(establishedText)
  const normalizedEstablishedActions = establishedActions.map(normalizeCommitmentAction)
  const candidateActions = extractCommitmentActionPhrases(candidateText)
  if (candidateActions.some((candidateAction) => normalizedEstablishedActions.includes(normalizeCommitmentAction(candidateAction)))) {
    return true
  }

  // Once the source contains an explicit promise, an abstract reference such
  // as “the existing promise/constraint” may carry that same commitment
  // forward. It must remain impersonal: concrete rules, permissions, terms,
  // or another person's boundary still fail their own source checks.
  return normalizedEstablishedActions.length > 0
    && /(?:自己的|自身|自我|已有|既有)?(?:承诺|约定|保证|自我约束|限制|约束)/u.test(candidateText)
}

function hasEstablishedCommitment(value: string): boolean {
  return Array.from(value.matchAll(/(?:答应|承诺|约定|保证|发誓)[^，。！？；\n]{0,30}/gu))
    .some((match) => /(?:不再|不得|不能|必须|要|不(?:打开|公开|透露|泄露|提及|发送|联系|打扰|说|告诉|使用|触碰|查看|分享))/.test(match[0]))
}

function extractCommitmentActionPhrases(value: string): string[] {
  return Array.from(value.matchAll(/(?:不再|不得|不能|必须|要|不(?:打开|公开|透露|泄露|提及|发送|联系|打扰|说|告诉|使用|触碰|查看|分享))[^，。！？；\n]{1,18}/gu))
    .map((match) => match[0]
      .replace(/(?:的)?(?:承诺|约定|保证|答应).*$/u, '')
      .replace(/[的之]$/u, '')
      .trim())
    .filter((phrase) => phrase.length >= 2)
}

function normalizeCommitmentAction(value: string): string {
  const normalized = value
    .replace(/[“”"「」]/gu, '')
    .replace(/主动/gu, '')
    .replace(/(?:自己的|本人|主角)/gu, '')
    .replace(/[的之]$/u, '')
    .trim()

  // Compare the committed action rather than incidental objects that a
  // model may append (for example, "不再主动联系"). This intentionally does
  // not equate distinct actions such as "联系" and "打扰".
  const action = /(?:不再|不得|不能|必须|要)(?:打开|公开|透露|泄露|提及|发送|联系|打扰|说|告诉|使用|触碰|查看|分享)/u.exec(normalized)
  return action?.[0] ?? normalized
}

function hasOtherPersonBoundaryContext(candidateText: string, match: string): boolean {
  const matchIndex = candidateText.indexOf(match)
  if (matchIndex < 0) return false
  const prefix = candidateText.slice(Math.max(0, matchIndex - 12), matchIndex)
  const clauseStart = Math.max(
    candidateText.lastIndexOf('，', matchIndex - 1),
    candidateText.lastIndexOf('。', matchIndex - 1),
    candidateText.lastIndexOf('；', matchIndex - 1),
  ) + 1
  const clausePrefix = candidateText.slice(clauseStart, matchIndex)
  return /(?:对方|朋友|他人|主人|另一方)(?:明确|已经|已|曾|可能|默认|会)?的?$/u.test(prefix)
    || /(?:对方|朋友|他人|主人|另一方)[^，。！？；\n]{0,10}(?:承诺|答应|约定|保证|拒绝|禁止|要求)[^，。！？；\n]{0,4}$/u.test(clausePrefix)
    || /^(?:对方|朋友|他人|主人|另一方)[^，。！？；\n]{0,12}/u.test(match)
}

function hasOtherPersonCommitmentContext(candidateText: string, match: string): boolean {
  const matchIndex = candidateText.indexOf(match)
  if (matchIndex < 0) return false
  const prefix = candidateText.slice(Math.max(0, matchIndex - 12), matchIndex)
  return /(?:对方|朋友|他人|主人|另一方)(?:明确|已经|已|曾|可能|默认|会)?的?$/u.test(prefix)
    || /(?:对方|朋友|他人|主人|另一方)[^，。！？；\n]{0,10}(?:承诺|答应|约定|保证)[^，。！？；\n]{0,4}$/u.test(prefix)
}

function hasEstablishedOtherPersonBoundary(establishedText: string, candidateText: string): boolean {
  // Only permit a role-specific boundary when the same role and action are
  // explicitly present in user-confirmed text. A bare matching substring is
  // insufficient because the source may instead describe the protagonist's
  // own promise.
  const action = /(?:不再联系|不再打扰|拒绝(?:联系|见面|回复)?|禁止(?:联系|接触)?)/u.exec(candidateText)?.[0]
  if (!action) return false
  return new RegExp(`(?:对方|朋友|他人|主人|另一方)[^，。！？；\\n]{0,18}${action}`).test(establishedText)
}

function assertConflictCoreUsesSupportedDetails(
  idea: string,
  seed: StorySeed,
  core: StoredStoryConflictCore,
) {
  const sourceTexts = [idea, ...getConflictCoreEvidenceSourceTextsForCore(seed, core)]
  // A title is a display label, not a factual or causal assertion. Keep the
  // grounding contract on fields that can change what the story assumes.
  const issue = findFirstUnsupportedGeneratedField(
    sourceTexts,
    createFieldGroundingChecks(
      getConflictCoreGroundingFields(core),
      conflictCoreUnsupportedDetailRules,
    ),
  )

  if (issue?.detail) {
    throw new AppError(
      `冲突核心${issue.field.label}加入了未建立的${issue.detail.label}“${issue.detail.value}”，请重试。`,
      invalidModelOutputContext.statusCode,
      'INVALID_CONFLICT_CORE_OUTPUT',
    )
  }
}

function getConflictCoreGroundingFields(core: StoredStoryConflictCore): GeneratedTextField[] {
  return [
    { label: '共同目标', value: core.preservedGoal },
    { label: '核心阻碍', value: core.obstacle },
    { label: '真正的两难', value: core.tradeoff },
    { label: '故事钩子', value: core.storyHook ?? '' },
    { label: '选择焦点', value: core.decisionFocus ?? '' },
    { label: '阻碍机制', value: core.mechanism ?? '' },
  ]
}

function applySystemConflictCoreDraft(seed: StorySeed, draft: StoryConflictCoreSystemDraft): StorySeed {
  return {
    ...seed,
    systemDraft: draft,
  }
}

export async function generateStory(request: StoryGenerationRequest): Promise<GeneratedStory> {
  let lastFailure: string | undefined
  let repairMessage: string | undefined
  const state = createNarrativeStateForPlan(request.plan)
  const confirmedPath = buildConfirmedStoryPath(request.plan)

  for (let attempt = 0; attempt < maxStoryGenerationAttempts; attempt += 1) {
    try {
      const record = await requestModelRecord({
        systemPrompt: storySystemPrompt,
        userPrompt: buildStoryPrompt(request, state, confirmedPath, repairMessage),
        temperature: attempt === 0 ? 0.72 : 0.46,
        maxTokens: 3_600,
      }, '模型没有返回完整故事，请重试。')
      const story = parseGeneratedStory(record)
      const consistencyFailure = await getGeneratedStoryConsistencyFailure(request, state, confirmedPath, story)
      if (!consistencyFailure) return story

      repairMessage = consistencyFailure
      lastFailure = consistencyFailure
      console.warn(`Generated story consistency review rejected (attempt=${attempt + 1}): ${consistencyFailure}`)
    } catch (error) {
      if (!isRetryableStoryGenerationError(error)) throw error

      lastFailure = describeStoryGenerationFailure(error)
      console.warn(`Generated story failed (attempt=${attempt + 1}): ${lastFailure}`)
    }
  }

  throw new AppError(
    `完整故事连续 ${maxStoryGenerationAttempts} 次未能生成（${lastFailure ?? '模型没有返回可用内容'}），请直接重试。`,
    502,
    'STORY_GENERATION_RETRY_EXHAUSTED',
  )
}

export async function generateStoryTurn(request: StoryTurnRequest): Promise<StoryTurn> {
  let repairMessage: string | undefined
  const state = createNarrativeStateForRequest(request)

  for (let attempt = 0; attempt < maxStoryTurnGenerationAttempts; attempt += 1) {
    try {
      const outputFormat = getStoryTurnOutputFormat(attempt)
      const record = await requestModelRecord({
        systemPrompt: storyTurnSystemPrompt,
        userPrompt: buildStoryTurnPrompt(request, state, repairMessage, outputFormat),
        temperature: getStoryTurnTemperature(request.mode, attempt),
        maxTokens: storyTurnMaxTokens,
      }, '模型没有返回下一段可继续发展的故事情境，请重试。')
      const turn = parseModelStoryTurn(record, request, state, outputFormat)
      if (shouldReviewStoryTurnGrounding) {
        await reportStoryTurnGroundingWarning(request, state, turn)
      }
      return turn
    } catch (error) {
      if (!isRetryableStoryTurnError(error)) throw error

      repairMessage = describeStoryTurnValidationFailure(error)
      console.warn(
        `Story turn rejected (mode=${request.mode}, confirmedTurns=${request.history.length}, format=${getStoryTurnOutputFormat(attempt)}, attempt=${attempt + 1}): ${repairMessage}`,
      )
    }
  }

  throw new AppError(
    `模型连续 ${maxStoryTurnGenerationAttempts} 次没有返回可用的下一情境（${repairMessage ?? '回合结构不完整'}），请再试一次。`,
    502,
    'STORY_TURN_RETRY_EXHAUSTED',
  )
}

async function generateStoryTurnOptionRefinement(
  request: StoryTurnOptionRefinementGenerationRequest,
): Promise<StoryTurnOption> {
  const state = createNarrativeStateForRequest(request)
  let repairMessage: string | undefined

  for (let attempt = 0; attempt < maxStoryTurnOptionRefinementAttempts; attempt += 1) {
    try {
      const record = await requestModelRecord({
        systemPrompt: storyTurnOptionRefinementSystemPrompt,
        userPrompt: buildStoryTurnOptionRefinementPrompt(request, state, repairMessage),
        temperature: attempt === 0 ? 0.52 : 0.38,
        maxTokens: storyTurnOptionRefinementMaxTokens,
      }, '模型没有返回可用的修改后选择，请重试。')
      return parseRefinedStoryTurnOption(record, request, state)
    } catch (error) {
      if (!isRetryableStoryTurnError(error)) throw error

      repairMessage = describeStoryTurnValidationFailure(error)
      console.warn(`Story turn option refinement rejected (turn=${request.currentTurn.id}, option=${request.originalOption.id}, attempt=${attempt + 1}): ${repairMessage}`)
    }
  }

  throw new AppError(
    `模型连续 ${maxStoryTurnOptionRefinementAttempts} 次没有返回可用的修改后选择（${repairMessage ?? '选项结构不完整'}），请再试一次。`,
    502,
    'STORY_TURN_OPTION_REFINEMENT_RETRY_EXHAUSTED',
  )
}

function getStoryTurnOutputFormat(attempt: number): StoryTurnOutputFormat {
  // The detailed format gives the model explicit state references on the first
  // attempt. A compact retry keeps the reader-facing turn while letting the
  // server create the internal transition metadata.
  return attempt === 0 ? 'detailed' : 'compact'
}

function getStoryTurnTemperature(mode: StoryTurnMode, attempt: number): number {
  if (attempt === 0) return mode === 'conclude' ? 0.52 : 0.6
  return mode === 'conclude' ? 0.34 : 0.42
}

async function reportStoryTurnGroundingWarning(
  request: StoryTurnRequest,
  state: StoryNarrativeState,
  turn: StoryTurn,
): Promise<void> {
  try {
    const review = await reviewStoryTurnGrounding(request, state, turn)
    const warning = getStoryTurnGroundingFailure(turn, review)
    if (warning) {
      console.warn(`Story turn grounding review warning accepted: ${warning}`)
    }
  } catch (error) {
    if (!(error instanceof AppError)) throw error

    // The deterministic state transition has already passed. This optional
    // quality signal must never turn an otherwise valid user choice into a
    // failed story step.
    console.warn(`Story turn grounding review skipped: ${getErrorIdentifier(error)}`)
  }
}

async function getGeneratedStoryConsistencyFailure(
  request: StoryGenerationRequest,
  state: StoryNarrativeState,
  confirmedPath: ConfirmedStoryPathItem[],
  story: GeneratedStory,
): Promise<string | undefined> {
  if (!shouldReviewGeneratedStoryConsistency) return undefined

  try {
    const review = await reviewGeneratedStoryConsistency(request, state, confirmedPath, story)
    return getGeneratedStoryConsistencyReviewFailure(review)
  } catch (error) {
    // A quality review should improve an otherwise valid story, not create a
    // second source of user-visible generation failures.
    console.warn(`Generated story consistency review skipped: ${getErrorIdentifier(error)}`)
    return undefined
  }
}

async function reviewGeneratedStoryConsistency(
  request: StoryGenerationRequest,
  state: StoryNarrativeState,
  confirmedPath: ConfirmedStoryPathItem[],
  story: GeneratedStory,
): Promise<StoryBodyConsistencyReview> {
  const record = await requestModelRecord({
    systemPrompt: storyBodyConsistencyReviewSystemPrompt,
    userPrompt: buildStoryBodyConsistencyReviewPrompt(request, state, confirmedPath, story),
    temperature: 0.1,
    maxTokens: 900,
  }, '模型没有完成完整故事的一致性检查，请重试。')

  return parseStoryBodyConsistencyReview(record, confirmedPath)
}

function getGeneratedStoryConsistencyReviewFailure(review: StoryBodyConsistencyReview): string | undefined {
  if (review.isConsistent) return undefined

  return review.issues
    .map((issue) => `${issue.pathId}：${issue.detail}`)
    .join('；')
}

function createNarrativeStateForRequest(
  request: Pick<StoryTurnRequest, 'seed' | 'predicament' | 'history'>,
): StoryNarrativeState {
  return replayConfirmedStoryTurns(request.seed, request.predicament, request.history)
}

function createNarrativeStateForPlan(plan: StoryPlan): StoryNarrativeState {
  const state = replayConfirmedStoryTurns(
    plan.seed,
    plan.predicament,
    plan.turnHistory,
  )

  return applyConclusionTransition(
    state,
    plan.headTail,
    plan.conclusion,
    invalidRequestContext,
    '故事收束没有有效地承接已确认路径。',
  )
}

function replayConfirmedStoryTurns(
  seed: StorySeed,
  predicament: StoryPredicament,
  history: StoryTurnHistoryItem[],
): StoryNarrativeState {
  return narrativeState.replayConfirmedTurns(
    seed,
    predicament,
    history,
    invalidRequestContext,
    '已确认的行动没有有效的状态变更。',
  )
}

function applyConclusionTransition(
  state: StoryNarrativeState,
  headTail: StoryHeadTailOption,
  conclusion: StoryTurn,
  context: ValidationErrorContext,
  message: string,
): StoryNarrativeState {
  if (isConclusionWithGeneratedAction(conclusion)) {
    return applyGeneratedConclusionAction(state, conclusion, context, message)
  }

  return applyLegacyConclusionTransition(state, headTail, conclusion, context, message)
}

function isConclusionWithGeneratedAction(
  conclusion: StoryTurn,
): conclusion is StoryConclusionWithGeneratedAction {
  return conclusion.isConclusion && Boolean(conclusion.narrativeAction && conclusion.transition)
}

function applyGeneratedConclusionAction(
  state: StoryNarrativeState,
  conclusion: StoryConclusionWithGeneratedAction,
  context: ValidationErrorContext,
  message: string,
): StoryNarrativeState {
  narrativeState.validateActionTransition(
    state,
    conclusion.narrativeAction,
    conclusion.transition,
    context,
    message,
  )
  return narrativeState.applyTransition(state, conclusion.narrativeAction, conclusion.transition)
}

function applyLegacyConclusionTransition(
  state: StoryNarrativeState,
  headTail: StoryHeadTailOption,
  conclusion: StoryTurn,
  context: ValidationErrorContext,
  message: string,
): StoryNarrativeState {
  // Sessions saved before conclusion actions were added still contain the
  // original head-tail transition. Keep those paths writable after upgrades.
  return narrativeState.applyExpectedTransition(
    state,
    conclusion.transition,
    headTail.climaxActionId,
    context,
    message,
  )
}

export async function generateHeadTailOptions(request: StoryHeadTailRequest): Promise<StoryHeadTailOptions> {
  let repairContext: HeadTailRepairContext | undefined
  const state = narrativeState.createInitialState(request.seed, request.predicament)

  for (let attempt = 0; attempt < maxHeadTailGenerationAttempts; attempt += 1) {
    try {
      const options = await generateHeadTailSet(request, repairContext, attempt)
      for (const option of options) {
        narrativeState.validateExpectedTransition(state, option.transition, option.climaxActionId, invalidModelOutputContext, '头尾方案的状态变更不成立，请重新生成。')
      }

      const reviews = await reviewHeadTailGoal(request, options)
      const violations = collectHeadTailGoalViolations(options, reviews)
      if (!violations.length) return options

      repairContext = { violations }
    } catch (error) {
      if (!(error instanceof AppError) || error.statusCode !== invalidModelOutputContext.statusCode) throw error
      repairContext = { violations: [error.message] }
    }
  }

  throw new AppError(
    '生成的故事两端没有形成可兑现的开场、关键行动和结尾，请返回上一步调整困境后重试。',
    502,
    'HEAD_TAIL_FIDELITY_FAILED',
  )
}

export async function generateSessionHeadTailOptions(
  request: StoryHeadTailSessionRequest,
): Promise<StoryHeadTailResponse> {
  const session = getStorySession(request.storyId, request.revision)
  const predicament = session.selectedPredicament?.id === request.predicamentId
    ? session.selectedPredicament
    : undefined
  if (!predicament) {
    throw new AppError('所选故事困境已不在当前会话中，请重新选择。', 409, 'STORY_SESSION_CONFLICT')
  }
  const approach = findSelectedPredicamentApproach(predicament, request.approachId)

  const options = await generateHeadTailOptions({
    idea: session.idea,
    seed: session.seed,
    predicament,
    approach,
  })
  assertStorySessionRevision(session, request.revision)
  replaceSessionHeadTailOptions(session, predicament, approach, options)

  return { storyId: session.id, revision: session.revision, options }
}

export async function generateSessionStoryTurn(
  request: StoryTurnSessionRequest,
): Promise<StoryTurnResponse> {
  const session = getStorySession(request.storyId, request.revision)
  const { predicament, approach, headTailOptions } = requireStoryTurnContext(session)
  return request.mode === 'start'
    ? startSessionStoryTurn(session, request, predicament, approach, headTailOptions)
    : continueSessionStoryTurn(session, request, predicament, approach)
}

export async function generateSessionStoryTurnOptionRefinement(
  request: StoryTurnOptionRefinementRequest,
): Promise<StoryTurnResponse> {
  const session = getStorySession(request.storyId, request.revision)
  const { predicament, approach } = requireStoryTurnContext(session)
  const currentTurn = session.currentTurn
  const headTail = session.selectedHeadTail

  if (!currentTurn || currentTurn.isConclusion || !headTail || !session.state) {
    throw new AppError('当前情境无法调整，请返回故事路径后重新开始。', 409, 'STORY_SESSION_CONFLICT')
  }
  if (currentTurn.id !== request.turnId) {
    throw new AppError('当前情境已经变化，请刷新后重新调整。', 409, 'STORY_SESSION_CONFLICT')
  }

  const originalOption = findSelectedTurnOption(currentTurn, request.optionId)
  const refinedOption = await generateStoryTurnOptionRefinement({
    idea: session.idea,
    seed: session.seed,
    predicament,
    approach,
    headTail,
    history: session.history,
    currentTurn,
    originalOption,
    focus: request.focus,
    feedback: request.feedback,
  })

  assertStorySessionRevision(session, request.revision)
  const refinedTurn: StoryTurn = {
    ...currentTurn,
    options: currentTurn.options.map((option) => option.id === refinedOption.id ? refinedOption : option),
  }
  session.currentTurn = refinedTurn
  commitStorySessionChanges(session)
  return createStoryTurnResponse(session, refinedTurn)
}

function requireStoryTurnContext(session: StorySessionRecord): {
  predicament: StoryPredicament
  approach: StoryPredicamentApproach
  headTailOptions: StoryHeadTailOptions
} {
  if (!session.selectedPredicament || !session.selectedApproach || !session.headTailOptions) {
    throw new AppError('请先确认具体困境中的应对方向并生成故事两端。', 409, 'STORY_SESSION_CONFLICT')
  }

  return {
    predicament: session.selectedPredicament,
    approach: session.selectedApproach,
    headTailOptions: session.headTailOptions,
  }
}

async function startSessionStoryTurn(
  session: StorySessionRecord,
  request: StoryTurnSessionRequest,
  predicament: StoryPredicament,
  approach: StoryPredicamentApproach,
  headTailOptions: StoryHeadTailOptions,
): Promise<StoryTurnResponse> {
  const headTail = headTailOptions.find((option) => option.id === request.headTailId)
  if (!headTail) {
    throw new AppError('所选故事两端已不在当前会话中，请重新选择。', 409, 'STORY_SESSION_CONFLICT')
  }

  const turn = await generateStoryTurn({
    idea: session.idea,
    seed: session.seed,
    predicament,
    approach,
    headTail,
    mode: 'start',
    history: [],
  })
  assertStorySessionRevision(session, request.revision)
  session.selectedHeadTail = headTail
  session.history = []
  session.state = narrativeState.createInitialState(session.seed, predicament)
  session.currentTurn = turn
  commitStorySessionChanges(session)
  return createStoryTurnResponse(session, turn)
}

async function continueSessionStoryTurn(
  session: StorySessionRecord,
  request: StoryTurnSessionRequest,
  predicament: StoryPredicament,
  approach: StoryPredicamentApproach,
): Promise<StoryTurnResponse> {
  const headTail = session.selectedHeadTail
  const currentTurn = session.currentTurn
  const state = session.state
  if (!headTail || !currentTurn || !state || currentTurn.isConclusion) {
    throw new AppError('当前故事路径无法继续，请返回上一步重新生成。', 409, 'STORY_SESSION_CONFLICT')
  }

  validateSessionTurnRequest(session, request, currentTurn)
  const selectedOption = findSelectedTurnOption(currentTurn, request.optionId)
  narrativeState.validateTurnOption(state, selectedOption, invalidRequestContext, '所选行动不满足当前故事状态。')

  const nextHistory = appendStoryTurnHistory(session.history, currentTurn, selectedOption)
  const advancedState = narrativeState.applyTransition(state, selectedOption.narrativeAction, selectedOption.transition)
  const turn = await generateStoryTurn({
    idea: session.idea,
    seed: session.seed,
    predicament,
    approach,
    headTail,
    mode: request.mode,
    history: nextHistory,
  })

  assertStorySessionRevision(session, request.revision)
  session.history = nextHistory
  session.currentTurn = turn
  session.state = turn.isConclusion
    ? applyConclusionTransition(
      advancedState,
      headTail,
      turn,
      invalidModelOutputContext,
      '故事收束没有有效地承接已确认路径。',
    )
    : advancedState
  commitStorySessionChanges(session)
  return createStoryTurnResponse(session, turn)
}

function validateSessionTurnRequest(
  session: StorySessionRecord,
  request: StoryTurnSessionRequest,
  currentTurn: StoryTurn,
) {
  if (currentTurn.id !== request.turnId) {
    throw new AppError('当前情境已经变化，请刷新后重新选择。', 409, 'STORY_SESSION_CONFLICT')
  }

  if (request.mode === 'conclude' && !currentTurn.canConclude) {
    throw new AppError('故事还需要更多已确认的行动，暂时不能收束。', 400, 'STORY_NOT_READY_TO_CONCLUDE')
  }

  if (request.mode === 'continue' && session.history.length >= maximumConfirmedStoryTurns) {
    throw new AppError('故事路径已达到最大回合数，请选择收束或从新的困境重新开始。', 400, 'STORY_TURN_LIMIT_REACHED')
  }
}

function findSelectedTurnOption(turn: StoryTurn, optionId: string | undefined): StoryTurnOption {
  const option = turn.options.find((candidate) => candidate.id === optionId)
  if (!option) {
    throw new AppError('所选行动已不在当前情境中，请重新选择。', 409, 'STORY_SESSION_CONFLICT')
  }
  return option
}

function findSelectedPredicamentApproach(
  predicament: StoryPredicament,
  approachId: string,
): StoryPredicamentApproach {
  const approach = predicament.approaches.find((candidate) => candidate.id === approachId)
  if (!approach) {
    throw new AppError('所选应对方向已不在当前困境中，请重新选择。', 409, 'STORY_SESSION_CONFLICT')
  }
  return approach
}

function appendStoryTurnHistory(
  history: StoryTurnHistoryItem[],
  turn: StoryTurn,
  selectedOption: StoryTurnOption,
): StoryTurnHistoryItem[] {
  return [
    ...history,
    {
      turnId: turn.id,
      phase: turn.phase,
      node: turn.node,
      conflict: turn.conflict,
      selectedOption,
    },
  ]
}

function createStoryTurnResponse(session: StorySessionRecord, turn: StoryTurn): StoryTurnResponse {
  return { storyId: session.id, revision: session.revision, history: session.history, turn }
}

export async function generateSessionStory(
  request: StoryGenerationSessionRequest,
): Promise<StoryGenerationResponse> {
  const session = getStorySession(request.storyId, request.revision)
  const {
    selectedPredicament: predicament,
    selectedApproach: approach,
    selectedHeadTail: headTail,
    currentTurn: conclusion,
  } = session
  if (!predicament || !approach || !headTail || !conclusion?.isConclusion || !session.history.length) {
    throw new AppError('故事尚未形成完整的已确认路径，请继续推进。', 409, 'STORY_SESSION_CONFLICT')
  }

  const story = await generateStory({
    idea: session.idea,
    plan: {
      seed: session.seed,
      predicament,
      approach,
      headTail,
      turnHistory: session.history,
      conclusion,
    },
  })
  assertStorySessionRevision(session, request.revision)
  return { storyId: session.id, revision: session.revision, story }
}

function createStorySession(idea: string, seed: StorySeed, conflictCores: StoredStoryConflictCores): StorySessionRecord {
  return {
    id: `story-${randomUUID()}`,
    idea,
    seed,
    conflictCores,
    history: [],
    revision: 0,
    updatedAt: Date.now(),
  }
}

function replaceSessionConflictCores(
  session: StorySessionRecord,
  result: { seed: StorySeed; conflictCores: StoredStoryConflictCores },
) {
  session.seed = result.seed
  session.conflictCores = result.conflictCores
  session.selectedConflictCore = undefined
  session.selectedPredicament = undefined
  clearSessionApproachAndStoryPath(session)
  commitStorySessionChanges(session)
}

function replaceSessionPredicament(
  session: StorySessionRecord,
  core: StoredStoryConflictCore,
  predicament: StoryPredicament,
) {
  session.seed = activateSystemDraftDirection(session.seed, core)
  session.selectedConflictCore = core
  session.selectedPredicament = predicament
  clearSessionApproachAndStoryPath(session)
  commitStorySessionChanges(session)
}

function activateSystemDraftDirection(
  seed: StorySeed,
  core: Pick<StoredStoryConflictCore, 'id'>,
): StorySeed {
  const directionIndex = getConflictCoreIndex(core.id)
  const direction = directionIndex === undefined ? undefined : getSystemDraftDirectionForIndex(seed, directionIndex)
  if (!seed.systemDraft || !direction) return seed

  return {
    ...seed,
    systemDraft: {
      ...seed.systemDraft,
      activeDirection: direction,
    },
  }
}

function clearSessionApproachAndStoryPath(session: StorySessionRecord) {
  session.selectedApproach = undefined
  session.headTailOptions = undefined
  session.selectedHeadTail = undefined
  session.state = undefined
  session.history = []
  session.currentTurn = undefined
}

function replaceSessionHeadTailOptions(
  session: StorySessionRecord,
  predicament: StoryPredicament,
  approach: StoryPredicamentApproach,
  options: StoryHeadTailOptions,
) {
  session.selectedPredicament = predicament
  session.selectedApproach = approach
  session.headTailOptions = options
  session.selectedHeadTail = undefined
  session.state = narrativeState.createInitialState(session.seed, predicament)
  session.history = []
  session.currentTurn = undefined
  commitStorySessionChanges(session)
}

function getStorySession(storyId: string, revision: number | undefined): StorySessionRecord {
  const session = storySessions.get(storyId)
  if (!session) {
    throw new AppError('没有找到当前故事会话。请刷新页面后继续。', 409, 'STORY_SESSION_NOT_FOUND')
  }
  assertStorySessionRevision(session, revision)
  return session
}

function assertStorySessionRevision(session: StorySessionRecord, revision: number | undefined) {
  if (storySessions.get(session.id) !== session || revision === undefined || revision !== session.revision) {
    throw new AppError('故事已经在其他操作中更新，请刷新当前步骤后重试。', 409, 'STORY_SESSION_CONFLICT')
  }
}

function commitStorySessionChanges(session: StorySessionRecord) {
  session.revision += 1
  session.updatedAt = Date.now()
  persistStorySessions()
}

function loadPersistedStorySessions(): Map<string, StorySessionRecord> {
  if (!existsSync(storySessionStorePath)) return new Map()

  try {
    const parsed = JSON.parse(readFileSync(storySessionStorePath, 'utf8')) as unknown
    if (!isPersistedStorySessionStore(parsed)) {
      console.warn('Story session store has an unsupported format; starting with an empty in-memory cache.')
      return new Map()
    }

    const sessions = parsed.sessions.filter(isPersistedStorySession)
    if (sessions.length !== parsed.sessions.length) {
      console.warn('Story session store contains malformed records; ignoring only those records.')
    }
    return new Map(sessions.map((session) => [session.id, session]))
  } catch (error) {
    console.warn(`Story session store could not be read; starting with an empty in-memory cache: ${getErrorIdentifier(error)}`)
    return new Map()
  }
}

function persistStorySessions() {
  const store: PersistedStorySessionStore = {
    version: 1,
    sessions: [...storySessions.values()],
  }
  const temporaryPath = `${storySessionStorePath}.tmp`

  try {
    mkdirSync(dirname(storySessionStorePath), { recursive: true })
    writeFileSync(temporaryPath, JSON.stringify(store), 'utf8')
    renameSync(temporaryPath, storySessionStorePath)
  } catch (error) {
    console.error(`Story session store could not be saved: ${getErrorIdentifier(error)}`)
  }
}

function isPersistedStorySessionStore(value: unknown): value is PersistedStorySessionStore {
  if (!isPlainRecord(value)) return false
  return value.version === 1 && Array.isArray(value.sessions)
}

function isPersistedStorySession(value: unknown): value is StorySessionRecord {
  if (!isPlainRecord(value)) return false

  return typeof value.id === 'string'
    && typeof value.idea === 'string'
    && isPlainRecord(value.seed)
    && Array.isArray(value.conflictCores)
    && Array.isArray(value.history)
    && typeof value.revision === 'number'
    && Number.isInteger(value.revision)
    && value.revision >= 0
    && typeof value.updatedAt === 'number'
    && Number.isFinite(value.updatedAt)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function generateHeadTailSet(
  request: StoryHeadTailRequest,
  repairContext: HeadTailRepairContext | undefined,
  attempt: number,
): Promise<StoryHeadTailOptions> {
  const record = await requestModelRecord({
    systemPrompt: headTailSystemPrompt,
    userPrompt: buildHeadTailPrompt(request, repairContext),
    temperature: attempt === 0 ? 0.72 : 0.62,
    maxTokens: 2_000,
  }, '模型没有返回可用的头尾方案，请重试。')
  const options = expectGeneratedOptionItems(
    record.options,
    '模型没有生成完整的三个头尾方案，请重试。',
    'INVALID_HEAD_TAIL_OUTPUT',
  )

  return parseGeneratedOptionTuple(
    options,
    (option, index) => parseHeadTailOption(option, invalidModelOutputContext, `head-tail-${index + 1}`),
  )
}

async function reviewHeadTailGoal(
  request: StoryHeadTailRequest,
  options: StoryHeadTailOptions,
): Promise<HeadTailGoalReview[]> {
  const record = await requestModelRecord({
    systemPrompt: headTailGoalReviewSystemPrompt,
    userPrompt: buildHeadTailGoalReviewPrompt(request, options),
    temperature: 0.1,
    maxTokens: 620,
  }, '模型没有完成故事两端的目标连续性检查，请重试。')

  return parseHeadTailGoalReviews(record.reviews, options)
}

async function reviewStoryTurnGrounding(
  request: StoryTurnRequest,
  state: StoryNarrativeState,
  turn: StoryTurn,
): Promise<StoryTurnGroundingReview> {
  const record = await requestModelRecord({
    systemPrompt: storyTurnGroundingReviewSystemPrompt,
    userPrompt: buildStoryTurnGroundingReviewPrompt(request, state, turn),
    temperature: 0.1,
    maxTokens: 900,
  }, '模型没有完成当前回合的状态连续性检查，请重试。')

  return parseStoryTurnGroundingReview(record, turn)
}

function getStoryTurnGroundingFailure(
  turn: StoryTurn,
  review: StoryTurnGroundingReview,
): string | undefined {
  const failures: string[] = []
  if (!review.situationIsGrounded) failures.push('当前情境没有由既有事实和已确认行动直接推出。')
  if (turn.isConclusion && !review.conclusionFulfillsHeadTail) {
    failures.push('收束没有兑现故事两端约定的关键行动、结局结果或开场线索。')
  }

  for (const option of review.optionReviews) {
    if (!option.isGrounded) failures.push(`选项 ${option.optionId}：${option.detail}`)
  }

  return failures.length ? failures.join('；') : undefined
}

function collectHeadTailGoalViolations(
  options: StoryHeadTailOptions,
  reviews: HeadTailGoalReview[],
): string[] {
  const reviewByOptionId = new Map(reviews.map((review) => [review.optionId, review]))

  return options.flatMap((option) => {
    const review = requireReviewForCandidate(
      reviewByOptionId,
      option.id,
      '模型审查结果没有覆盖全部故事两端，请重试。',
      'INVALID_HEAD_TAIL_REVIEW',
    )

    const problems: string[] = []
    if (!review.keepsConfirmedGoal) problems.push('确认的主线目标没有贯穿开场、关键行动和结尾')
    if (!review.followsSelectedApproach) problems.push('没有从用户选定的应对方向开始发展')
    if (!review.climaxIsProtagonistAction) problems.push('关键行动没有由主角亲自完成')
    if (!review.resolutionFulfillsPlan) problems.push('结尾没有兑现关键行动、目标结果或开场线索')
    if (!review.transitionIsGrounded) problems.push('状态变更没有由已声明的行动和事实支撑')

    return problems.length ? [`方案“${option.promise}”：${problems.join('；')}`] : []
  })
}

interface ModelRequestOptions {
  systemPrompt: string
  userPrompt: string
  temperature: number
  maxTokens: number
}

async function requestModelRecord(
  options: ModelRequestOptions,
  missingOutputMessage: string,
): Promise<Record<string, unknown>> {
  const modelOutput = await requestQwenJson(options)
  return expectRecord(modelOutput, missingOutputMessage, invalidModelOutputContext)
}

function getErrorIdentifier(error: unknown): string {
  if (error instanceof AppError) return error.code
  return error instanceof Error ? error.name : 'unknown error'
}

function describeStoryTurnValidationFailure(error: unknown): string {
  return error instanceof AppError
    ? error.message
    : '上一轮输出不符合当前回合的结构要求。'
}

function isRetryableStoryTurnError(error: unknown): boolean {
  return error instanceof AppError && retryableStoryTurnErrorCodes.has(error.code)
}

function describeStoryGenerationFailure(error: unknown): string {
  return error instanceof AppError
    ? error.message
    : '模型没有返回可用的完整故事。'
}

function isRetryableStoryGenerationError(error: unknown): boolean {
  return error instanceof AppError && retryableModelOutputErrorCodes.has(error.code)
}

function describeConflictCoreGenerationFailure(error: unknown): string {
  return error instanceof AppError
    ? error.message
    : '模型没有返回完整的冲突核心结构。'
}

function isRetryableConflictCoreGenerationError(error: unknown): boolean {
  return error instanceof AppError && retryableConflictCoreGenerationErrorCodes.has(error.code)
}

function describeConflictCoreReviewFailure(error: unknown): string {
  return error instanceof AppError
    ? error.message
    : '模型没有返回可用的冲突核心审核。'
}

function isRetryableConflictCoreReviewError(error: unknown): boolean {
  return error instanceof AppError && retryableConflictCoreReviewErrorCodes.has(error.code)
}

function createConflictCoreReviewUnavailableError(error: unknown): AppError {
  if (error instanceof AppError) {
    if (error.code === 'QWEN_NOT_CONFIGURED' || error.code === 'QWEN_AUTH_ERROR') {
      return error
    }

    if (error.code === 'QWEN_RATE_LIMITED') {
      return new AppError(
        '冲突核心质量检查请求受限；当前候选没有被放行，请稍后重试。',
        429,
        'CONFLICT_CORE_REVIEW_RATE_LIMITED',
      )
    }

    if (error.code === 'QWEN_TIMEOUT') {
      return new AppError(
        '冲突核心质量检查响应超时；当前候选没有被放行，请稍后重试。',
        504,
        'CONFLICT_CORE_REVIEW_TIMEOUT',
      )
    }

    if (error.code === 'QWEN_NETWORK_ERROR' || error.code === 'QWEN_UPSTREAM_ERROR') {
      return new AppError(
        '冲突核心质量检查服务暂时不可用；当前候选没有被放行，请稍后重试。',
        502,
        'CONFLICT_CORE_REVIEW_UNAVAILABLE',
      )
    }

    if (error.code === 'QWEN_REQUEST_ERROR') {
      return new AppError(
        '冲突核心质量检查请求被模型服务拒绝，请检查 QWEN_MODEL、接口地址和服务配置。',
        502,
        'CONFLICT_CORE_REVIEW_REQUEST_REJECTED',
      )
    }
  }

  return new AppError(
    '冲突核心质量检查暂时不可用；当前候选没有被放行，请稍后重试。',
    502,
    'CONFLICT_CORE_REVIEW_FAILED',
  )
}

function expectListOfLength(
  value: unknown,
  length: number,
  message: string,
  context: ValidationErrorContext,
  code = context.code,
): unknown[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new AppError(message, context.statusCode, code)
  }

  return value
}

function expectGeneratedOptionItems(value: unknown, message: string, code: string): unknown[] {
  return expectListOfLength(value, generatedOptionCount, message, invalidModelOutputContext, code)
}

function parseGeneratedOptionTuple<T>(
  values: unknown[],
  parseOption: (value: unknown, index: number) => T,
): [T, T, T] {
  return [parseOption(values[0], 0), parseOption(values[1], 1), parseOption(values[2], 2)]
}

function toPublicConflictCores(cores: StoredStoryConflictCores): StoryConflictCores {
  return [
    toPublicConflictCore(cores[0]),
    toPublicConflictCore(cores[1]),
    toPublicConflictCore(cores[2]),
  ]
}

function toPublicConflictCore(core: StoredStoryConflictCore): StoryConflictCore {
  // Keep the API boundary explicit: future server-only guidance fields must
  // not become visible just because they were added to the stored core.
  return {
    id: core.id,
    title: core.title,
    variationAxis: core.variationAxis,
    preservedGoal: core.preservedGoal,
    obstacle: core.obstacle,
    tradeoff: core.tradeoff,
    ...(core.storyHook ? { storyHook: core.storyHook } : {}),
  }
}

function getConflictCoreDecisionFocus(core: StoredStoryConflictCore): string {
  return core.decisionFocus?.trim() || core.tradeoff
}

const conflictCoreDirectInferenceRules = `第一层可以把原文已经明示的限制组织成抽象的选择，但不能把选择写成新事实。以下都是允许的最小推导：原文给出明确截止点时，可说目标有明确时限，也可在 tradeoff 或 decisionFocus 中写“在期限内继续还是暂不继续”，但不能断言等待会来不及、窗口不足、存在某种流程或必然错过；原文明确某个必要信息未知时，可说“在信息未知下继续还是暂不继续”，但不能补出如何取得信息、谁会回应、对方会拒绝或任何行动结果；原文写明“必须、不得、只能”时，可概括为目标受该条件限制，也可写明遵守目标与进行被禁止的动作不能兼得，但不能补出替代路径、协调方式、监督、动机或违规后果；原文写明已作出的承诺时，可说目标与该承诺相连，但不能断言承诺不能协商、不能改变或一定造成后果。\n\n推荐的安全表达是：tradeoff 写“在【原文条件】下继续【原始目标】，还是暂不继续”；decisionFocus 写“决定是否在【原文条件】下继续【原始目标】”；mechanism 写“明示的时间/信息/边界/承诺条件限制目标”。不要写“前往、联系、尝试见面、第三方中介、启动并完成、错过、被拒、对方会怎样”等原文没有出现的具体路径或结果。\n\n“继续、暂不继续、在条件未知下决定是否继续、在期限内决定是否继续”只是主角尚未作出的抽象选择，不是对现场、能力、路径或结果的事实断言。不得把它们误判为新增事实。只有候选补出了具体接触方式、行动顺序、位置、他人态度/反应、资源、规则、因果结果或未明示的不可行性时，才属于未建立事实。`

const conflictCoreSystemPrompt = `你是一位严谨的中文故事编辑。你的任务是从用户的一个念头中提出三个“冲突核心”，供用户先选择这篇故事要卡在哪一种难处。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输出内容使用简体中文。第一层对用户只展示原始目标、核心阻碍、真正的两难，以及一句很短的 storyHook。三条必须共享同一个 preservedGoal。若用户已经明确行动目标，逐字保留它；若用户没有明确行动目标，目标只能写成主角当下可主动完成的最小动作或决定，并且必须让读者能指出它对应 activeSituation 或 lockedFacts 中的哪个对象、事件或动作；可以补出由该事实直接推出的最小决定，但不能把原始事件抹平成抽象的“处理/应对”。不能用“眼前事件”“下一步”“这件事”“自然应对”“维持体面”“处理好这件事”等占位语替代真实目标。核心阻碍只写目标受阻的因果卡点，不得借新增画面、动作或临时条件让难处变得具体；不要写具体路线、金额、人物帮助、精确时限、精确距离、倒数数字、步数、先后动作、解决方案、完整行动过程或结局。tradeoff 要保持为抽象而清楚的取舍，不要展开成小剧情。storyHook 只是一句不超过 56 字的阅读钩子，用已建立的对象、目标或限制让读者感到这条冲突的张力；它不能展开成完整当前场景、为什么必须现在处理、主角此刻行动或直接代价。所有这些具体困境信息只在第二层生成。每条还必须给出内部审核字段 mechanism 和 evidence：mechanism 用一句短语概括“目标为什么无法继续”，evidence 逐字摘取支持它的种子原文；不能给出证据的机制不成立。

核心字段和 storyHook 只能使用原始念头和故事种子中的明确事实。storyHook 可以把已建立信息压缩成一句带一点画面的提示，但不能新增临时事件、永久背景、身份、关系定论、固定规则、资源权限、过去经历、严重伤害或确定结果，也不能伪装成用户已经说过的事实。不得把 unknowns 填成核心字段事实：不能新增或断言任何未在原文建立的背景、关系、身份、责任、规则、资源、权限、过去经历或结果。若一个核心必须依赖这些信息才成立，就不要生成它。

每条还要输出仅供后续生成使用的 decisionFocus。它不展示给用户，必须用一句简短的话指出主角被迫在什么取向之间主动决定；它只能从 obstacle 和 tradeoff 推出，不能新增人物、路线、资源、精确时间或结果，也不能写成已经选定的方案。

每条必须满足：若主角不处理 obstacle，preservedGoal 就会被延后、失败或被迫改变；为了继续，后续必须存在清楚的损失、风险或取舍，并且主角必须能通过自己的决定改变故事走向。障碍必须直接作用于目标本身，不能只是情绪不适、旁支请求或可无视的附带干扰。一个合格核心应能在不增加第二个核心阻碍的前提下继续升级，并在下一层形成两条同样成立、各有代价的起点。每条只保留一个主要阻碍机制，三条机制必须彼此不同；判断差异时先去掉人物、物品、地点、画面和情绪，只问“目标为什么无法继续”，若答案仍相同，就算换了表面载体也仍是重复。variationAxis 只用来概括该机制：time 是原文已建立的窗口或时机，resource 是原文中已有且目标必需的条件受限，relationship 是输入已建立的人际边界，commitment 是输入已建立的承诺或责任；未建立的心理状态不能伪装成任何轴。三条可以使用相同 variationAxis；绝不能为了凑齐不同 axis 另造关系、责任或资源。`

const conflictCoreGenerationSupplement = `生成前先做四个内部检查：第一，preservedGoal 必须是主角尚未完成、可观察的动作或决定；若输入只有一个事件，就把该事件中的对象或动作保留下来，再补一个由它直接推出的最小“是否/如何”决定，不能原样复述事件。通用表达是“决定是否/如何对[输入中的对象或事件]作出回应”，但只有在输入语义支持时使用，方括号必须换成输入里的具体对象或事件。第二，分别写出三条“目标为什么无法继续”的因果句，三句的关键因果动词必须不同；如果删掉人物、物品、地点、画面和情绪后仍能互相替换，就不要把它们当作三条。第三，为每条机制列出 evidence，必须逐字出现在 activeSituation 或 lockedFacts 中；没有逐字证据的机制直接放弃，不得用任何新的背景、场景细节、行为或临时规则填空。第四，storyHook 必须只有一句，且只从目标、阻碍、取舍或已建立的对象中挑一个可感知的切面；它不是场景契约，不能写新的触发事件、现在压力、行动选择、直接代价或任何会进入后续因果的细节。机制类型只能从以下集合选择，且三条不得重复：information-gap（完成行动所需信息或意图未明）、boundary-conflict（输入已建立的关系/限制边界被触发）、meaning-commitment（行动本身会传达或放弃不可兼得的立场）、initiation-block（目标行动因输入已给出的条件无法启动）、window-pressure（输入明确给出的时机或窗口正在收窄）、resource-constraint（输入中已有且目标必需的资源受限）、commitment-conflict（输入中已建立的承诺或责任与目标冲突）。只有类型确实由原文支持且会改变后续选择时才可使用；不要把未建立的心理状态或一般性不适换名成三条机制。第一层不使用临时人物、物品、场景动作或过去对白补足机制；若需要这些细节，应留到第二层具体困境再生成。没有已建立的资源、责任或承诺时，不要为了填写 variationAxis 引入它们。若原文无法支持三种机制，宁可让审核拒绝并请求补充信息，也不能编造条件。\n\n${conflictCoreDirectInferenceRules}`

const conflictCoreFieldSeparationSupplement = `variationAxis 与 mechanismType 是两个不同字段。variationAxis 只能填 time、resource、relationship 或 commitment，用于界面概括；mechanismType 才能填写 information-gap、boundary-conflict、meaning-commitment、initiation-block、window-pressure、resource-constraint 或 commitment-conflict。若某个 mechanismType 没有唯一的界面分类，可以复用最接近的 variationAxis，绝不能把 mechanismType 原样填进 variationAxis。`

const conflictCoreReviewSupplement = `审稿时不要把模型的布尔值当作自证：先重述每条核心的目标动作、直接卡点和主要代价，再据此填写 goalForm。任何只复述 seed 事件、没有主角动作/决定的 preservedGoal 都必须判 event-or-state。storyHook 只是一句短展示文本，不能新增事实、场景动作或第二个阻碍；若它把原文没有的现场人物、物品、动作、过去对白或外部事件写成已成立事实，也必须在 unestablishedClaims 中列出。检查 mechanism 和 evidence：mechanism 必须回答“目标为什么无法继续”，evidence 必须逐字存在于 activeSituation 或 lockedFacts；evidence 不能为新的断言背书。任何只增加一个可忽略的附带条件、而没有改变目标可达性的核心，都必须判 obstacleThreatensGoal 为 false。若两个核心删去人物、物品、地点、画面和情绪后都可概括为同一种回避、等待或无法启动，即使表面不同，也必须判 usesDistinctMechanism 为 false。对于只提供一个当前事件的输入，只有当卡点分别来自信息未明、原文已建立的边界/限制、行动本身不可兼得的意义或代价等不可互换原因时，才可以判为机制不同；它们若都只是难开始行动仍然不通过。\n\n${conflictCoreDirectInferenceRules}`

const conflictCoreReviewEvidenceSupplement = `mechanismEvidenceGrounded 只在以下条件同时成立时为 true：mechanismType 准确分类 mechanism；mechanism 准确概括 obstacle 的因果来源；evidence 的每项逐字出现在 activeSituation 或 lockedFacts；核心没有借这些原文补出新的关键事实。若任一条件不成立，填 false。`

const conflictCoreContractReviewSystemPrompt = `你是一位严格的中文故事编辑审稿人。请判断每个候选冲突核心是否真的能驱动故事，而不是只制造一个看似有戏的插曲。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。storyHook 只是帮助读者比较的短句，不能把它当作已确认的当前场景或额外事实。核心障碍只有在不处理它会让原始目标延后、失败、被迫改变，或使一个决定无法继续保持原有意义时才算成立；对于“决定是否/如何行动”这类目标，直接相关的信息未明或已建立边界带来的真实取舍可以构成阻碍，但单纯尴尬、麻烦、额外请求，或者主角仍能无代价地照常完成原目标，都必须判 obstacleThreatensGoal 为 false。requiresTradeoff 只有在继续目标必然会面对真实的损失、风险或取舍时才为 true，即使代价不会在第一层展示。hasSingleMechanism 只有在没有叠加第二个独立阻碍、完整场景、解法或结果时才为 true。sharesCommonGoal 只有在三条 preservedGoal 语义相同，且都保留用户明确目标或同一个最小可行动目标时才为 true。hasActionableGoal 只有在 preservedGoal 描述主角可完成或作出的动作/决定，并且明确引用原始 activeSituation 的对象、事件或动作，而不是“眼前事件”“下一步”“自然应对”“维持体面”“处理好关系”等抽象状态时才为 true。goalForm 必须分类为 explicit-goal、action、decision 或 event-or-state；只是在复述已经发生、正在发生或客观存在的事件，而没有主角要完成的动作/决定时，必须填 event-or-state 且 hasActionableGoal 为 false。goalAnchoredToSeed 只有在目标能让读者指出它对应 activeSituation 或 lockedFacts 中的具体对象、事件或动作时才为 true；仅有“完成应对、解决问题、维持体面”这类抽象意图，即使语法上像一个动作，也必须为 false。

introducesNoUnestablishedFacts 只有在核心没有把 unknowns 或未提及信息断言为事实时才为 true。要检查所有新增背景、身份、关系、责任、规则、资源、权限、心理状态和外部结果。第一层不允许用普通临时场景条件放行新人物、物品、动作、过去对白或外部事件；它们应在第二层具体困境中才出现。unestablishedClaims 必须列出候选中每一项不受种子支持的断言；若没有则返回空数组，不能为了让 introducesNoUnestablishedFacts 为 true 而省略。variationAxisFitsMechanism 只有在轴确实概括障碍机制时才为 true；时间轴必须有真实的时机或窗口压力，关系轴必须基于输入已建立的人际边界，资源轴必须基于输入已存在且对目标必要的条件，承诺轴必须基于输入已建立的承诺或责任。未建立的心理状态不能伪装成任意冲突轴。三条可以使用同一轴，不能因为轴重复而判错。forcesProtagonistDecision 只有在 decisionFocus 确实让主角必须主动选择，而不是等别人解决、单纯躲避或执行唯一正确答案时才为 true。supportsSustainedDevelopment 只有在任选一个合理起点后，仍可自然推进至少三步有后果的行动而不立刻解决时才为 true。hasEscalationPath 只有在不新增另一主冲突的前提下，当前阻碍可因选择、拖延或代价继续加压时才为 true。canSupportBalancedApproaches 只有在 decisionFocus 可生成两条并列、各有真实代价且没有明显更优的应对起点时才为 true。usesDistinctMechanism 只有在先去掉人物、物品、地点、画面和情绪后，这条核心的“目标为什么无法继续”仍与另外两条不同才为 true；若只是用不同表面载体重述同一种回避、等待或外部打断，必须为 false。候选核心不得写死精确秒数、步数、距离、路线、倒数、必须先后经过的完整行动、已经发生的回应或确定结局。`

const systemDraftConflictCoreGroundingReviewSystemPrompt = `你是一位只做事实归因核对的中文编辑。用户主动选择了系统暂定路线；你的唯一任务是找出第一层候选冲突核心中超出该候选“允许事实源”的断言。不评价故事好坏，不提出改写建议，也不因为候选写了 evidence 就默认它成立。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。用户提示会按 conflictCoreId 给出唯一允许事实源：userConfirmed 来自用户原文或用户确认，systemDraftCommon 是本次路线共享的系统暂定前提，systemDraftBranch 是当前候选独有的系统暂定分支。后两者不是用户原话，但在本次候选中是允许的事实前提；不能仅因它们不在原始念头中就列为 unestablishedClaims，也不能把它们归因给用户。每条候选只能使用自己对应的 systemDraftBranch，不能借用其他编号的分支。

逐条检查 preservedGoal、obstacle、tradeoff、decisionFocus 和 mechanism。把每个不在该候选允许事实源中、或把允许前提扩写成额外背景、人物、关系、规则、资源、行动、位置、距离、时间、外部结果或他人态度的断言列入 unestablishedClaims，使用简短、可定位的原句或断言。evidence 只能证明它逐字引用了什么，不能让候选从一小段允许前提推导出新的动作、态度、环境或因果链。

抽象地描述“信息未明”“边界已被触发”等机制，只有在其完整因果链由当前候选允许事实源或允许的直接语义蕴含支持时才可放行；不能把未建立的具体情绪、动作、程序、关系或结果当作支撑。${conflictCoreDirectInferenceRules}\n\n若一条核心完全没有新增断言，unestablishedClaims 返回空数组。conflictCoreId 必须照抄输入，恰好覆盖本次输入中的全部候选。`

function getConflictCoreGroundingReviewSystemPrompt(seed: Pick<StorySeed, 'systemDraft'>): string {
  return seed.systemDraft
    ? systemDraftConflictCoreGroundingReviewSystemPrompt
    : conflictCoreGroundingReviewSystemPrompt
}

const conflictCoreGroundingReviewSystemPrompt = `你是一位只做事实归因核对的中文编辑。你的唯一任务是找出第一层候选冲突核心中没有被用户原始念头明确建立的断言；不评价故事好坏，不提出改写建议，也不因为候选写了 evidence 就默认它成立。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。原始念头是唯一的事实来源；故事种子只帮助定位原文，不能为原始念头中不存在的内容补充事实。逐条检查 preservedGoal、obstacle、tradeoff、decisionFocus 和 mechanism。把每个不受原文明确支持、却被候选当作已成立的事实或因果前提列入 unestablishedClaims，使用简短、可定位的原句或断言。

重点审查候选是否新增了人物、关系状态、地点、物品、现场动作、位置、顺序、距离、时间、外部事件、过去对白、他人的态度/意图/反应、主角的内在状态、既有责任、规则、资源、权限或已经发生的结果。即使这些内容看似符合常识，只要原文没有建立，也必须列出。evidence 只能证明它逐字引用了什么，不能让候选从一小段原文推导出额外的动作、态度、环境或因果链。

抽象地描述“信息未明”“边界已被触发”等机制，也只有在其完整因果链由原文或允许的直接语义蕴含支持时才可放行；不能把未建立的具体情绪、动作、程序、关系或结果当作支撑。\n\n${conflictCoreDirectInferenceRules}\n\n若一条核心完全没有新增断言，unestablishedClaims 返回空数组。conflictCoreId 必须照抄输入，恰好覆盖本次输入中的全部候选。`

const predicamentExpansionSystemPrompt = `你是一位擅长互动短篇故事的中文编辑。用户已经选定一条冲突核心；现在把它展开成一份可执行的具体困境。\n\n必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输出内容使用简体中文。必须逐字照抄输入的 variationAxis、preservedGoal、obstacle 和 tradeoff，不能换成另一条主线或另加第二个核心阻碍。输入中的 storyHook 只用于第一层比较，不是已经成立的当前场景或事实，不能照抄为 immediateSituation、facts、urgency、choice 或 plausibleCost；第二层必须自己建立当前场景、为什么必须现在处理、主角必须面对的取舍、共同风险，以及 2 到 4 条暂定事实。输入中的 decisionFocus 是内部约束，不要原样写回 JSON，但两条 approaches 必须围绕它展开。两条 approaches 必须彼此并列、都能开始且各有直接代价或不确定性；它们此时只用于证明困境有张力。进入“故事两端”后，用户才会从中选择一条作为故事实际开始的路线。两条都必须是主角主动选择的不同起点，不能是连续步骤、唯一正确答案或等待他人替他解决，但此时不得预先写定具体开场、发展、他人回应、转折或结局。\n\nimmediateSituation 可以首次补足普通、当下可见的画面，但它不能补写人物姓名、过去经历、固定关系、资源、权限、技术条件或他人的既定反应。facts 会进入后续状态：只保留已确认限制、与核心直接相连的暂定当前状态，或“尚未作出选择”这类可改变状态；不要把手机、号码、网络、临时工具、容器、渠道、场所规则或他人安排写成现成资源。urgency、choice 和 plausibleCost 只能从已确认阻碍、时限或取舍推出，不能假定别人会发现、转交、回应、拒绝，不能把主角的心意、创伤或关系结论当作已成立事实。approaches 可以提出尝试联系、暂缓或处理等普通选择，但不能预设具体通讯渠道、设备、权限、工具或成功结果。\n\n事实和行动构成可执行状态契约：fixed 不能被主角直接改写，unknown 不能作为行动前置条件或确定结果，actions 只能用既有事实支持，effects 只能指向 changeable 事实，并且必须指向行动后会真正改变的状态；不要把检查一个临时资源、重复原状态或无变化的观察当成状态变更。可以建立一个与已确认核心一致的普通当前场景，并补充不改变选择可行性的普通细节；这些细节不能变成新增限制、资源、权限、精确时限或他人的必然决定，也不要把解法写成已经成功。`

const storySeedSystemPrompt = `你是一位严谨的中文故事编辑。请把用户已写出的念头整理成一份可跨步骤保留的故事种子。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输出内容使用简体中文。只能提取用户已经说出的信息，不能补写姓名以外的身份、年龄、职业、家庭关系、病史、过去经历或题材。lockedGoal 只在用户给出了明确想做、必须做、想去、想找、想说等具体行动时填写；否则返回 null。lockedGoal 和每条 lockedFacts 都必须是从用户原文连续逐字摘取的短语，不能改写、补全或倒装；lockedFacts 只能保留 1 至 3 条不可替换的核心锚点，优先人物或关系、关键事件、明确目标或时间限制；不要把同一个事件拆成重复碎片。unknowns 应列出仍未建立、后续不能作为关键因果依据的设定类别；它们不是禁止普通场景细节的清单。`

const systemConflictCoreDraftSystemPrompt = `你是一位擅长把模糊念头发展成故事起点的中文编辑。用户已经明确选择“让系统先给一版”；你的任务是提出一个共同故事起点，以及三条彼此独立、清楚标为系统暂定设定的冲突分支，让后续稳定生成三条有分量的冲突核心。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输出内容使用简体中文。输入中的锁定目标和锁定事实来自用户，绝不能改写或反过来声称为系统发明；你补出的 goal、stake、constraint 以及 directions 中的 premise、tradeoff 不是用户原文，必须只作为本次故事的可修改暂定设定。若输入已有锁定目标，服务端会直接把它保留为 goal；此时只生成 stake、constraint 和 directions，不要输出或改写 goal。若没有锁定目标，goal 才是主角此刻可主动完成的一件具体行动，且必须保留原始念头中的主体、对象或关键事件。stake 是继续或放弃这件事会失去、守住或承受的直接代价。constraint 是三条分支共享的最小当前起点。directions 必须恰好有三条，每条使用不同的 mechanismType，并各自提出一项独立的最小前提和对应取舍；三条前提是互斥的创作分支，不是同一个故事中同时成立的事实。

每个 stake、constraint、premise 和 tradeoff 都只能是一句话、一个条件或一个取舍，不能同时塞入背景、原因、操作和结果。优先从原始目标、事件、时限或承诺中找出不同机制；共同 stake 和 constraint 不得以原始信息为由新增资源状态。除非用户原文已明确写出，否则禁止补入精确数字、钟点或倒计时，账号密码、设备接口、网络电量等技术细节，文书条款、机构流程，或者他人的既定状态和过去事件。不得把主角自己的“答应过不再打扰”改写成“对方设定边界、明确拒绝或承诺不可违背”；不得把“已经断联”改写成对方新的态度、要求或历史；不得把内容未知改写成他人的偏好、意愿或期待；不得补写主角的心理动机或关系结论。可接受的抽象粒度是“信息尚无法确认”“已有边界会被触碰”“可用窗口正在收窄”“继续行动要承担一项代价”；只说明机制，不补出造成它的设备、规则、人员或流程。不要补写人物履历、具体地点、完整行动步骤、外部结果或结局。`

const headTailSystemPrompt = `你是一位擅长短篇故事结构的中文编辑。根据已经确认的故事基础，提出能驱动后续创作的开场、关键行动与结尾组合。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输出内容使用简体中文。输入会包含用户已选的应对方向，三个方案都必须从这条方向实际开始，而不是改用另一条未选方向。开场是迫使故事开始的激励事件；高潮是主角必须亲自完成的关键行动；结尾是该行动带来的可验证结果，必须明确已确认主线目标如何完成、延后、主动放弃或重新确认，并回应开场线索。结尾不能只重复高潮行动，也不能只写“事情解决了”之类空泛判断。三个方案要在事件切入、关键行动、结局结果或代价上明显不同，但不得改变故事种子中的锁定事实和目标。

事实、行动和状态变更是故事契约：只能引用输入中存在的事实或行动 ID。fixed 事实不能被行动直接改写、绕过或抹掉，unknown 事实不能用作行动许可；任何状态改变都必须由对应 actionId 的已知前置事实和全部 effects 支撑。不要把限制、拒绝、损失、时间、资源归属、他人决定或既有关系凭空写成已经消失。`

const headTailGoalReviewSystemPrompt = `你是一位严格的中文故事编辑审稿人。请检查故事两端的开场、关键行动和结尾是否仍然围绕锁定目标与用户已选方向展开。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输出内容使用简体中文。请按语义判断，合理的同义改写仍算保留。请以锁定目标为准；若用户没有明确锁定目标，则以确认困境中的 preservedGoal 为主线目标。开场可以制造阻碍，但高潮必须是主角亲自完成的关键行动；结尾必须是该行动的直接结果，明确改变主线目标的结果并回应开场线索。若去掉主线目标后，开场、高潮和结尾仍然是同一个故事，keepsConfirmedGoal 必须为 false。followsSelectedApproach 只有在方案确实从用户已选方向开始，且未让另一条未选方向替代为主线时才能为 true。transitionIsGrounded 只有在 transition 引用的行动、已知前置事实和状态变化都能在文本中成立，完整兑现 action.effects，且没有通过假定授权、未知信息或主角无权改变的方式撤销 fixed 限制时才能为 true。`

const storyTurnSystemPrompt = `你是一位擅长互动短篇故事的中文编辑。每次只推进一段当前情境，绝不能一次性给出完整大纲、未来节点或结局预告。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输出内容使用简体中文。故事的锁定目标、已确认困境、开场线索、预定高潮的语义和预定结尾结果是不可替换的结构约束。用户已经确认的每一次行动都必须继续生效，新的事件必须由最近一次行动的即时后果或尚待处理的后续牵引直接触发，不能重置局面、跳到无关支线，或假装该行动没有发生。后续牵引不是已经发生的事件，必须在新的当前情境中自然兑现，不能当成已完成的结果。

输入会给出当前叙事状态。本次任务会明确指定输出“详细状态结构”或“紧凑叙事结构”。只有详细状态结构才输出 narrativeAction 和 transition；紧凑叙事结构只输出读者可见的情境、冲突和选项，内部行动记录由服务端生成。详细状态结构中：
- narrativeAction.preconditions 只能引用当前已知、非 unknown 的 facts
- narrativeAction.effects 只能引用 changeable facts
- transition.consumedFacts 要覆盖行动前置事实
- transition.changedFacts 必须逐一更新该行动 effects
- transition.introducedFacts 只能是这次行动实际带来的、可继续变化的新事实

不得凭空改变、删除或忽略既有事实；fixed 事实不能被绕开、解除、推翻或改写。

叙事状态记录的是会影响选择与后果的关键事实，不是场景里所有物品的穷举清单。请区分两类信息：
1. 关键因果信息：会改变限制、目标是否可达、时间或交通状态、场所是否可用、他人决定、权限、资源、能力，或会在后续反复作为证据和条件使用的信息。这类信息必须有输入依据；不能借一次行动直接声称固定限制已经消失，也不能把没有来源的精确数值或外部结果写成既定事实。
2. 临时场景细节：不改变选项可行性、代价或后续状态的普通动作、无关紧要的道具、画面和感官细节可以自然补写。例如，已知有垫子时可以写铺开垫子、用书压住边角；这类细节不得在后续被当成新资源、权限、证据或行动前提。

原始想法、已确认困境和已确认行动中已经建立的目标、人物、地点可以自然延续到文本里，不必因为没有再次单列为 fact 就假装它们不存在。面对既有阻碍时，保留原计划、等待、询问、尝试或承担风险都可以成为选项；但不能把“选择尝试”写成“阻碍已经解除”或“目标必然实现”。

仍然禁止把下列无依据内容作为关键因果：
1. 没有来源的具体时长、距离、速度或精确交通到达状态；可以写查询、询问或等待的行动，但不能预先写死查询结果；
2. 未确认的他人内部状态、决定或必然行为；
3. 未确认的场所设施、规则、权限、资源或主角能力，并以此使行动可行或使结果成立；
4. 用普通场景细节暗中解除预警、安全条件、时间限制或其他 fixed 事实。

选项中的关键后果必须基于已知事实推导；无关紧要的临时细节不需要写入内部状态，也不能成为关键依据。laterEffect 只用于说明下一段仍待处理的风险、线索或代价，不是已经发生的结果；不得预告某个角色之后一定会做的具体动作，也不得把未来结局写死。

当任务是 start 或 continue 时，返回一个尚未结束的情境和恰好三个真正不同的行动选项。三个选项必须分别在方法、风险、代价或接近目标的方式上有实质区别，每个选项都要说明即时后果与后续牵引。不要把选择写成同义句，也不要在第一、二次推进时仓促收束。

当任务是 conclude 时，用户刚确认的选择只表示“从这条已发生的路径开始收束”，它不必等于预定高潮行动。你要生成一个不再需要用户选择的收束情境，并在其中写出主角实际完成的结尾行动，使其自然兑现预定高潮的语义、预定结尾结果与开场线索。结尾可以补足不承担关键因果的自然过渡，例如饭已端上桌时写主角坐下、拿起筷子再吃饭；这种桥接不是新的分支、资源、许可或重大事件。不得用桥接动作凭空消除既有限制，或补写新的关键关系、能力、权限、信息、资源、外部决定。收束情境不应再提供选项；详细状态结构才需要返回实际结尾行动的 narrativeAction 和 transition。phase、isConclusion、canConclude 和 node.goalState 均由服务端计算，不要在输出中添加这些字段。

生成顺序提示：先写 node 和 conflict，再写 question；非收束时逐个完成每个 option。若本次要求详细状态结构，再补齐每个 option 中的 narrativeAction 和 transition，收束时补齐顶层 narrativeAction 和 transition；若本次要求紧凑叙事结构，则绝不输出这些内部字段。详细状态结构中 transition.introducedFacts 即使为空也必须保留为空数组 []。`

const storyTurnOptionRefinementSystemPrompt = `你是一位擅长互动短篇故事的中文编辑。你只修改当前情境中的一个备选行动，绝不改写已经确认的故事路径、当前情境、另外两条选择或预定的故事两端。`

const storyTurnGroundingReviewSystemPrompt = `你是一位严谨但不过度保守的故事因果与权限审查员。你只判断一段候选回合是否能从已有叙事状态正当地发生，不负责润色或补写。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输入中 fixed 表示主角不能自行撤销、绕过或直接改写的既有事实；changeable 表示已有行动可以直接改变的状态；unknown 表示尚未证实、不能拿来作为关键行动许可或确定结果依据的信息。任何候选行动若要改变限制、规则、安全条件、他人的决定、时间、资源归属或权限，必须有输入状态中明确的授权、能力和因果路径，不能仅靠行动文字声称成功。

当前叙事状态是关键因果的契约，不是场景物品和日常动作的完整清单。不得因为候选写了不承担关键因果的临时细节就判为 false。以下内容可以成立，只要它们不在后续充当资源、前提、证据或确定结果：
1. 已知目标、人物、地点和已确认计划在文本中的自然延续；
2. 已知物品的普通操作，以及不影响选择的临时道具、数量、画面或感官细节。例如已知有垫子时，铺开它、用书压住边角可以是场景细节；
3. 在既有预警、限制或阻碍下保留计划、等待、询问或选择承担风险。该选择不等于限制已经消失，也不等于目标一定能够完成；
4. 记录、观察、询问或查询本身作为行动，但不能在没有来源时把它们的具体答案预先写死。

只有无依据的信息承担了关键因果时才判 false。包括但不限于：
1. 没有来源的精确时长、距离、速度、交通到达状态或查询结果，并以此影响选择或后果；
2. 未确认的他人内部状态、决定或必然行为，并以此使行动或结果成立；
3. 未确认的场所设施、规则、权限、资源或主角能力，并以此使行动可行或使结果成立；
4. 直接或间接把 fixed 限制、预警、安全条件、时间限制写成已经解除、无效或必然被绕过；
5. 把先前只是临时场景细节的内容变成后续关键资源、证据或行动前提。

当候选回合有 options 时，必须逐项审查。situationIsGrounded 只审查 node、conflict 和收束结果是否承接当前状态及已确认行动，绝不能因某一个 option 不成立而设为 false。每个 option 的 isGrounded 独立判断。收束回合没有 options，optionReviews 必须为空数组。收束时还要检查“最后一次已确认选择 -> 实际结尾行动 -> 预定高潮语义 -> 预定结尾结果与开场线索”的链条；实际结尾行动不需要与故事两端中保存的 actionId 相同，普通自然桥接也不应被误判为新增关键事件。`

const storySystemPrompt = `你是一位擅长中文短篇小说的作者和编辑。根据用户逐步确认的故事计划，写一篇有场景、行动、对白和后果的完整短篇故事。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输出内容使用简体中文。正文不要写成大纲；用自然段完成叙事。必须遵循故事种子、用户选择的困境、头尾与已确认路径账本。账本中的每项行动和当下结果都是既成事实，必须按顺序写进正文；账本刻意不含“后续牵引”，不能自行把尚未发生的风险、线索或代价写成已注定的具体行动或结果。锁定目标必须始终是这篇故事的主线；结尾必须由收束回合的实际行动自然兑现预定高潮的语义、已确认的结局结果并回应开头线索。允许在结尾补足不改变关键因果的自然过渡动作，不能借此补写关键资源、权限、关系或外部结果。

写作前先在内部核对：人物、地点、时间、交通工具、座位和道具的状态是否连续；每个关键结果是否由前一行动直接造成；结尾是否有足够铺垫。篇幅按故事路径自然展开，不以固定字数或段落数作为完成条件。不要为制造高潮临时增加关键关系、承诺、交通安排、道具功能或人物身份。`

const storyBodyConsistencyReviewSystemPrompt = `你是一位严谨但不过度保守的中文故事编辑。你的任务是审核候选正文是否保留了已确认的故事路径，不负责润色或续写。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输入中的“已确认路径账本”是关键事件的权威来源：每项的 situation、obstacle、selectedAction、immediateResult 必须在正文中以语义等价的方式发生，顺序不能颠倒，且不能被正文改写。故事种子、已确认困境、预定结尾约束和最终叙事状态也是可用的已知背景；不要要求逐字复述，普通道具、动作、感官、画面和不承担关键因果的场景细节可以自由补写。

只报告三类问题：
1. missing-path-item：账本中的关键行动、即时结果、开场阻碍或实际收束在正文中缺失；
2. contradiction：正文把账本中已确认的人物、物品、时间、地点、行动或结果写成了不兼容的另一种状态；
3. unsupported-critical-detail：正文新加的精确时间、资源、权限、他人决定、进入方式、查询结果等内容承担了关键因果，却没有来自账本或最终状态的依据。

实际收束必须以语义方式兑现预定结尾约束中的 climax、resolution 和 openingClue；若未兑现或相互矛盾，使用 contradiction 或 missing-path-item，并将 pathId 写为 conclusion。

不得因为未写出某个普通场景细节、使用同义改写、补写日常动作，或没有采纳尚未发生的“后续牵引”而报告问题。若正文一致，issues 必须为空数组；若不一致，issues 必须逐条说明具体问题。`

const storyTurnOngoingResponseSchema = `{
  "turn": {
    "node": {
      "title": "不超过 12 个字的节点名",
      "event": "当前具体发生什么，不超过 160 字",
      "purpose": "它怎样承接前因并推进后果，不超过 100 字"
    },
    "conflict": {
      "conflict": "当前阻力或危机，不超过 120 字",
      "action": "主角此刻必须权衡的行动方向，不超过 100 字",
      "consequence": "若不处理会怎样，不超过 120 字",
      "intensity": 1,
      "anchor": "推进、意外、虚假胜利、低点、高潮前夜、高潮或结局之一"
    },
    "question": "主角此刻必须回答的问题",
    "options": [
      {
        "label": "不超过 12 个字的选择名",
        "action": "主角具体怎么做，不超过 90 字",
        "immediateConsequence": "立即后果，不超过 90 字",
        "laterEffect": "尚未发生的风险、线索或代价；不能预告具体行动或既定结果，不超过 90 字",
        "narrativeAction": {
          "intent": "与 action 一致的行动意图",
          "preconditions": ["当前 fact id"],
          "effects": ["当前可 change 的 fact id"]
        },
        "transition": {
          "consumedFacts": ["覆盖 narrativeAction preconditions 的 fact id"],
          "changedFacts": [
            { "factId": "narrativeAction effects 中的 fact id", "statement": "行动后该事实的新状态" }
          ],
          "introducedFacts": []
        }
      }
    ]
  }
}`

const storyTurnConclusionResponseSchema = `{
  "turn": {
    "node": {
      "title": "不超过 12 个字的节点名",
      "event": "收束时当前具体发生什么，不超过 160 字",
      "purpose": "它怎样承接前因并兑现结尾，不超过 100 字"
    },
    "conflict": {
      "conflict": "收束前最后需要面对的阻力，不超过 120 字",
      "action": "主角实际完成的结尾行动方向，不超过 100 字",
      "consequence": "这个行动如何带来结局，不超过 120 字",
      "intensity": 1,
      "anchor": "结局"
    },
    "question": null,
    "options": [],
    "narrativeAction": {
      "intent": "主角实际完成的结尾行动",
      "preconditions": ["当前 fact id"],
      "effects": ["当前可 change 的 fact id"]
    },
    "transition": {
      "consumedFacts": ["覆盖 narrativeAction preconditions 的 fact id"],
      "changedFacts": [
        { "factId": "narrativeAction effects 中的 fact id", "statement": "行动后该事实的新状态" }
      ],
      "introducedFacts": []
    }
  }
}`

const storyTurnOngoingCompactResponseSchema = `{
  "turn": {
    "node": {
      "title": "不超过 12 个字的节点名",
      "event": "当前具体发生什么，不超过 160 字",
      "purpose": "它怎样承接前因并推进后果，不超过 100 字"
    },
    "conflict": {
      "conflict": "当前阻力或危机，不超过 120 字",
      "action": "主角此刻必须权衡的行动方向，不超过 100 字",
      "consequence": "若不处理会怎样，不超过 120 字"
    },
    "question": "主角此刻必须回答的问题",
    "options": [
      {
        "label": "不超过 12 个字的选择名",
        "action": "主角具体怎么做，不超过 90 字",
        "immediateConsequence": "立即后果，不超过 90 字",
        "laterEffect": "尚未发生的风险、线索或代价；不能预告具体行动或既定结果，不超过 90 字"
      }
    ]
  }
}`

const storyTurnConclusionCompactResponseSchema = `{
  "turn": {
    "node": {
      "title": "不超过 12 个字的节点名",
      "event": "收束时当前具体发生什么，不超过 160 字",
      "purpose": "它怎样承接前因并兑现结尾，不超过 100 字"
    },
    "conflict": {
      "conflict": "收束前最后需要面对的阻力，不超过 120 字",
      "action": "主角已经实际完成的结尾行动，不超过 100 字",
      "consequence": "这个行动如何带来结局，不超过 120 字"
    },
    "question": null,
    "options": []
  }
}`

const storySeedResponseSchema = `{
  "seed": {
    "subject": "用户已经明确写出的角色、关系或对象；不补写履历",
    "activeSituation": "用户已明确写出的当前愿望、行动、事件或处境",
    "lockedGoal": "用户明确想完成的具体行动；若没有则为 null",
    "lockedFacts": ["从原始念头原样摘取的 1 至 3 条不可替换核心锚点"],
    "worldMode": "realistic-default 或 user-specified",
    "unknowns": ["仍未给出的设定类别，例如年龄、职业、家庭背景"],
    "contextPrefill": {
      "goal": "原文中明确写出的主角此刻目标；没有则为 null",
      "stake": "原文中明确写出的主角最在意、不愿失去或想守住的事；没有则为 null",
      "constraint": "原文中明确写出的限制、时限、阻碍或未知条件；没有则为 null"
    }
  }
}`

const systemConflictCoreDraftResponseSchema = `{
  "systemDraft": {
    "goal": "系统暂定的主角当前具体行动，只写一个行动，不超过 64 字",
    "stake": "系统暂定的直接代价或想守住的事，只写一个条件或取舍，不超过 64 字",
    "constraint": "系统暂定的共同起点限制，只写一个条件，不超过 64 字",
    "directions": [
      {
        "label": "不超过 16 字的分支名称",
        "mechanismType": "information-gap、boundary-conflict、meaning-commitment、initiation-block、window-pressure、resource-constraint 或 commitment-conflict",
        "premise": "仅属于这一分支的系统暂定前提，只写一个条件，不超过 64 字",
        "tradeoff": "这一分支继续目标时必须接受的暂定取舍，只写一个取舍，不超过 64 字"
      },
      {
        "label": "不超过 16 字的分支名称",
        "mechanismType": "与上一条不同的机制类型",
        "premise": "第二条独立的系统暂定前提，只写一个条件，不超过 64 字",
        "tradeoff": "第二条对应的暂定取舍，只写一个取舍，不超过 64 字"
      },
      {
        "label": "不超过 16 字的分支名称",
        "mechanismType": "与前两条不同的机制类型",
        "premise": "第三条独立的系统暂定前提，只写一个条件，不超过 64 字",
        "tradeoff": "第三条对应的暂定取舍，只写一个取舍，不超过 64 字"
      }
    ]
  }
}`

const conflictCoreResponseSchema = `{
  "cores": [
    {
      "title": "不超过 12 个字的冲突标题",
      "variationAxis": "只能填 time、resource、relationship 或 commitment；这是界面分类，不能填 mechanismType",
      "preservedGoal": "沿用原始目标的具体行动；若原始念头没有明确目标，必须点出 activeSituation 或 lockedFacts 中的对象、事件或动作，不能写抽象的应对状态",
      "obstacle": "一句只描述核心阻碍的短句；必须直接照抄或紧贴 evidence 中的原文，不补出因果解释、画面、现场动作、解法、精确时限、步数、路线、金额、人物帮助、代价、完整行动过程或结果",
      "tradeoff": "为了继续原始目标，明确要接受或暂时无法兼得的原始条件；只使用 preservedGoal 与 evidence 中的原文概念，不新增人物行为、流程、态度、规则后果或结局",
      "decisionFocus": "仅供后续生成使用的一句主动选择焦点；只在 preservedGoal 与 evidence 已明确的条件之间决定，不写具体方案、过程或结果",
      "mechanism": "仅供审核使用的因果机制标签；用不新增事实的短语概括目标为什么无法继续，例如明示条件受限、明示关系边界或明示意愿冲突；不得写成画面、道具、人物状态或具体过程",
      "mechanismType": "information-gap、boundary-conflict、meaning-commitment、initiation-block、window-pressure、resource-constraint 或 commitment-conflict",
      "evidence": ["逐字摘取 activeSituation、lockedFacts，或明确标出的系统暂定设定中支持该机制的短语；没有证据就不要生成该机制"],
      "storyHook": "一句不超过 56 字的故事钩子；只重组已建立的目标、阻碍、取舍或对象，不写完整场景、紧迫性、行动、直接代价或新的事实"
    }
  ]
}

重要：恰好生成 3 条；三条要靠“阻碍如何卡住同一目标”的实质机制不同来区分，variationAxis 可以重复，不能把不同 axis 当作配额。先去掉人物、物品、地点、画面和情绪后，三条的“目标为什么无法继续”必须仍然不同；只替换表面载体不算不同。每条都必须有清楚的 tradeoff、decisionFocus、mechanism、mechanismType、evidence 和 storyHook。mechanismType 必须准确描述因果来源，且三条不能重复；如果同一个稀薄事实不能支持三种不同类型，就不要虚构条件来凑数。mechanism 必须是可复述的因果差异，evidence 必须逐字来自故事种子。decisionFocus、mechanism、mechanismType 和 evidence 是服务端内部字段。storyHook 会展示给用户，但只能是已建立信息的短钩子；不得把它写成当前场景、触发事件、行动选择、直接代价、永久背景、固定规则或结局。obstacle 仍不得新增画面、现场动作、人物状态、具体规则、精确时间、步数、路线、完整行动或结局。`

const conflictCoreReplacementResponseSchema = `{
  "core": {
    "title": "不超过 12 个字的冲突标题",
    "variationAxis": "只能填 time、resource、relationship 或 commitment",
    "preservedGoal": "逐字使用指定的共同目标",
    "obstacle": "只描述已建立事实构成的单一核心阻碍",
    "tradeoff": "继续该目标必须接受或暂时无法兼得的原始条件",
    "decisionFocus": "只在目标和已建立证据之间的主动选择焦点",
    "mechanism": "不新增事实的目标受阻因果短语",
    "mechanismType": "information-gap、boundary-conflict、meaning-commitment、initiation-block、window-pressure、resource-constraint 或 commitment-conflict",
    "evidence": ["逐字摘取支持 mechanism 的原文或明确系统暂定设定"],
    "storyHook": "一句只重组已建立信息的短钩子，不写新的场景、行动或代价"
  }
}`

function getConflictCoreReviewResponseSchema(
  cores: readonly Pick<StoredStoryConflictCore, 'id'>[],
): string {
  const reviews = cores
    .map((core) => `    {
      "conflictCoreId": "${core.id}",
      "preservesLockedFacts": true,
      "preservesLockedGoal": true,
      "obstacleThreatensGoal": true,
      "hasSingleMechanism": true,
      "requiresTradeoff": true,
      "forcesProtagonistDecision": true,
      "supportsSustainedDevelopment": true,
      "hasEscalationPath": true,
      "canSupportBalancedApproaches": true,
      "usesDistinctMechanism": true,
      "sharesCommonGoal": true,
      "hasActionableGoal": true,
      "goalForm": "explicit-goal、action、decision 或 event-or-state",
      "goalAnchoredToSeed": true,
      "introducesNoUnestablishedFacts": true,
      "mechanismEvidenceGrounded": true,
      "unestablishedClaims": [],
      "variationAxisFitsMechanism": true,
      "staysWithinScope": true
    }`)
    .join(',\n')

  return `{
  "reviews": [
${reviews}
  ]
}`
}

const predicamentExpansionResponseSchema = `{
  "predicament": {
    "title": "不超过 12 个字、描述困境的标题",
    "variationAxis": "逐字照抄已确认冲突核心的 variationAxis",
    "preservedGoal": "逐字照抄已确认冲突核心的 preservedGoal",
    "immediateSituation": "此刻开始发生的具体小情境；由第二层首次建立，不照抄 storyHook",
    "obstacle": "逐字照抄已确认冲突核心的 obstacle",
    "tradeoff": "逐字照抄已确认冲突核心的 tradeoff",
    "urgency": "说明为什么现在需要处理",
    "choice": "写主角此刻必须面对的核心取舍，不预设具体行动过程",
    "plausibleCost": "写不处理或仓促处理该阻碍时的共同风险",
    "approaches": [
      { "intent": "第一条可行的应对方向", "cost": "它的直接代价或不确定性" },
      { "intent": "第二条可行的应对方向", "cost": "它的直接代价或不确定性" }
    ],
    "facts": [
      {
        "id": "fact-1",
        "statement": "当前已经成立、后续必须承接的一项具体事实",
        "mutability": "fixed、changeable 或 unknown"
      },
      {
        "id": "fact-2",
        "statement": "另一项事实",
        "mutability": "changeable"
      }
    ],
    "actions": [
      {
        "id": "action-1",
        "intent": "主角此刻可亲自完成的一项行动意图",
        "preconditions": ["fact-1"],
        "effects": ["fact-2"]
      }
    ]
  }
}

重要：
1. approaches 必须恰好有 2 条，全部处理同一 obstacle，彼此是并列起点而非连续步骤；两条都能开始、没有明显更优，并且各有真实直接代价或不确定性；用户稍后会从中选择一条作为后续故事路线起点，但这里不得预告具体回应、转折或结局
2. facts 必须有 2 到 4 个，每个 fact 的 id 格式为 "fact-1", "fact-2" 等
3. actions 必须有 1 到 3 个，每个 action 的 id 格式为 "action-1", "action-2" 等
4. action.preconditions 必须引用上面 facts 数组中存在的、非 unknown 的 fact id
5. action.effects 必须引用上面 facts 数组中存在的、mutability 为 changeable 的 fact id
6. storyHook 只用于第一层比较，不能当作已确认事实或要求逐字承接；当前场景、压力、取舍和共同风险都必须在这一层首次完整建立`

function buildStorySeedPrompt(idea: string, repairMessage?: string): string {
  const repair = repairMessage
    ? `\n上一版未通过结构检查：${repairMessage} 请只修正该问题，不要补写任何原文没有的信息。`
    : ''

  return `用户的原始念头：
---
${idea}
---

请提取 1 到 3 条彼此独立的核心 lockedFacts。每条 lockedFacts 与非空 lockedGoal 都必须是用户原文中连续出现的逐字短语，不能改写、补全、合并或颠倒语序；它们应覆盖最不可替换的信息，不要把同一个事件拆成多个近义短语。activeSituation 要沿用用户关键措辞；worldMode 只有用户明确写出了非现实类型或规则时才是 user-specified。不要把 unknowns 填成虚构事实。contextPrefill 只用于补充设定表单：goal、stake、constraint 各自只能逐字摘取用户原文中已经明确出现的连续短语；无法诚实归类时必须填 null，绝不能根据人物关系、常识或情绪推断补写。只要 lockedGoal 非空，contextPrefill.goal 也必须非空，并优先照抄该目标的完整动作短语。${repair}\n\n严格使用以下 JSON 结构：
${storySeedResponseSchema}`
}

function buildSystemConflictCoreDraftPrompt(
  idea: string,
  seed: StorySeed,
  repairMessage?: string,
): string {
  const goalInstruction = seed.lockedGoal
    ? `用户已确认目标“${seed.lockedGoal}”。服务端会直接保留它；请只生成 stake 和 constraint，不要返回 goal。`
    : '用户尚未确认具体行动目标。请生成 goal，并逐字保留原始念头中的主体、对象或关键事件。'
  const repair = repairMessage
    ? `\n上一版未通过结构检查：${repairMessage}。请只修正这一问题，仍然不要补写新的背景或结果。`
    : ''

  return `用户的原始念头：
---
${idea}
---

已从原文提取的故事种子：
${formatStorySeed(seed)}

用户选择让系统先给一版。请提出一个共同故事起点，并在其中规划恰好三条彼此独立的创作分支。不要把系统暂定内容写成用户已经说过的事实；保留所有原始信息，不要用具体人物、地点、时间、结果或复杂小剧情硬凑戏剧性。${goalInstruction} stake 和 constraint 共同构成三条分支共享的起点；directions 中每一条 premise 和 tradeoff 只属于自己的分支，是用户可选择的系统暂定前提。三条 mechanismType 必须不同，且每条都要能单独支撑一条冲突核心。${repair}\n\n粒度必须保持最小：stake、constraint、每条 premise、每条 tradeoff 各只写一句，且只表达一个条件或一个取舍。优先从原始目标、事件、时限或承诺中得到不同机制；共同 stake 和 constraint 不得凭原始信息新增资源或操作状态。系统暂定不是给具体虚构事实加标签：任何未由原文支持的内容只能是无人物、无物品归属、无过去经历、无他人态度或许可、无明确处理方式或结果的抽象机制，例如“暂定：完成目标所需的一项信息尚未确认”。不能借“暂定”写出某人当面承诺、物品主人未知、未经许可、具体交付方式、心理状态或既定后果。除非原始念头明确给出，否则不要写精确数字或钟点、账号密码、设备故障或接口、网络电量、文书条款、机构流程、他人的既定状态或过去事件；也不要把主角自己的承诺改写成他人已经拒绝或禁止联系的边界，不要把内容未知改写成他人的偏好、意愿或期待，不要补写主角心理动机或关系结论，也不要写“先做什么再做什么”的操作流程。可用“信息尚未确认”“已有承诺会被触碰”“可用窗口收窄”“继续会承担一项代价”这类抽象机制表达。\n\n每条 directions 都必须保留共同目标，只提出一项最小、可编辑的分支前提，明确目标为什么会因此受阻以及继续时要接受什么取舍；不要把另外两条分支的前提混进来，也不要把三条分支写成同一故事中同时成立的事实。严格使用以下 JSON：
${getSystemConflictCoreDraftResponseSchema(seed)}`
}

function buildSystemConflictCoreDraftRepairPrompt(
  idea: string,
  seed: StorySeed,
  candidate: StoryConflictCoreSystemDraft,
  repairMessage: string,
): string {
  const goalInstruction = seed.lockedGoal
    ? `共同目标必须继续使用已锁定目标“${seed.lockedGoal}”，不要改写 goal。`
    : 'goal 必须保留原始念头中的主体、对象或关键事件。'
  return `用户的原始念头：
---
${idea}
---

已确认的故事种子：
${formatStorySeed(seed)}

上一版系统暂定设定（只修正不合格的地方，仍需返回完整 JSON）：
${JSON.stringify(candidate)}

上一版检查结果：${repairMessage}

请重写整份 systemDraft。${goalInstruction} 每个 stake、constraint、premise、tradeoff 只能是一句、一个条件或一个取舍；删除所有精确数字、钟点、技术/设备状态、资源操作状态、文书流程、机构信息、他人既定态度、未建立的心理结论和完整行动链。系统暂定不能新增具体的人物经历、物品归属、他人许可、交付方式或结果；即使加了“暂定”也不能把这些未建立内容写成成立事实。不要把“她答应过不再打扰”改写成对方明确拒绝或禁止联系；不要把未知内容改写成对方的期待或意愿。优先使用抽象且可编辑的表达，例如“暂定：完成目标所需的一项信息尚未确认”“已有承诺会被触碰”“可用窗口正在收窄”。三条 directions 必须恰好存在、mechanismType 互不相同、彼此互斥，并且每条只保留一个最小前提和一个取舍。不要解释，只返回以下 JSON：
${getSystemConflictCoreDraftResponseSchema(seed)}`
}

function getSystemConflictCoreDraftResponseSchema(seed: Pick<StorySeed, 'lockedGoal'>): string {
  if (!seed.lockedGoal) return systemConflictCoreDraftResponseSchema

  return `{
  "systemDraft": {
    "stake": "系统暂定的直接代价或想守住的事，只写一个条件或取舍，不超过 64 字",
    "constraint": "系统暂定的共同起点限制，只写一个条件，不超过 64 字",
    "directions": [
      {
        "label": "不超过 16 字的分支名称",
        "mechanismType": "information-gap、boundary-conflict、meaning-commitment、initiation-block、window-pressure、resource-constraint 或 commitment-conflict",
        "premise": "仅属于这一分支的系统暂定前提，只写一个条件，不超过 64 字",
        "tradeoff": "这一分支继续目标时必须接受的暂定取舍，只写一个取舍，不超过 64 字"
      },
      {
        "label": "不超过 16 字的分支名称",
        "mechanismType": "与上一条不同的机制类型",
        "premise": "第二条独立的系统暂定前提，只写一个条件，不超过 64 字",
        "tradeoff": "第二条对应的暂定取舍，只写一个取舍，不超过 64 字"
      },
      {
        "label": "不超过 16 字的分支名称",
        "mechanismType": "与前两条不同的机制类型",
        "premise": "第三条独立的系统暂定前提，只写一个条件，不超过 64 字",
        "tradeoff": "第三条对应的暂定取舍，只写一个取舍，不超过 64 字"
      }
    ]
  }
}`
}

function buildConflictCorePrompt(
  request: StoryDirectionsRequest,
  seed: StorySeed,
  repairContext?: ConflictCoreRepairContext,
): string {
  const repair = repairContext
    ? `\n上一批核心未通过检查：${formatConflictCoreRepairContext(repairContext)}。请只修正这些结构问题，仍然只输出第一层信息。${getConflictCoreRepairGuidance(repairContext)}`
    : ''
  const directionInstructions = !seed.systemDraft?.activeDirection
    && seed.systemDraft?.directions?.length === generatedOptionCount
    ? `\n\n系统已规划三个互斥分支。cores[0] 必须只使用分支 1，cores[1] 必须只使用分支 2，cores[2] 必须只使用分支 3；每条 mechanismType 必须逐字等于对应分支的 mechanismType，且 evidence 必须逐字引用对应分支的 premise 或 tradeoff。不得交换、合并或借用分支前提。\n${seed.systemDraft.directions.map((direction, index) => (
      `分支 ${index + 1}：名称「${direction.label}」；机制「${direction.mechanismType}」；暂定前提「${direction.premise}」；暂定取舍「${direction.tradeoff}」`
    )).join('\n')}`
    : ''
  return `用户的模糊想法：\n---\n${request.idea}\n---\n\n${formatStorySeed(seed)}\n\n${getConflictCoreGoalInstruction(seed)}${getSparseSeedConflictCoreInstruction(seed)}${directionInstructions}\n\n扩展尺度：${getExpansionScopeInstruction(request.expansionScope ?? 'keep-scale')}\n${request.preference ? `用户偏好：${request.preference}` : ''}\n${request.excludedTitles?.length ? `请避免重复标题：${request.excludedTitles.join('、')}` : ''}${repair}\n\n第一层只让用户比较三条冲突核心：主角想完成什么、现在被什么卡住、为了继续暂时无法兼得什么。保留原始目标，目标必须锚定故事种子中的对象、事件或动作；核心阻碍要直接威胁它，且只写已建立事实构成的因果卡点；tradeoff 只能表达核心取舍。另输出一条仅供后续使用的 decisionFocus，用来约束主角随后必须作出的主动选择；它不进入用户界面。storyHook 只用一句很短的话为这条冲突提供阅读钩子，必须重组已建立的对象、目标、阻碍或取舍，不能写完整当前场景、紧迫性、行动选择、直接代价或新的创作事实。具体场景、暂定事实和两条应对方向全部留到第二层。严格使用以下 JSON：\n${conflictCoreResponseSchema}`
}

function buildConflictCoreReplacementPrompt(
  request: StoryDirectionsRequest,
  seed: StorySeed,
  target: StoredStoryConflictCore,
  retainedCores: readonly StoredStoryConflictCore[],
  violation: ConflictCoreContractViolation,
): string {
  const sharedGoal = seed.lockedGoal ?? retainedCores[0]?.preservedGoal ?? target.preservedGoal
  const retainedMechanismTypes = retainedCores
    .map((core) => core.mechanismType)
    .filter((type): type is ConflictCoreMechanismType => type !== undefined)
  const excludedTitles = request.excludedTitles?.length
    ? `不要复用这些已淘汰标题：${request.excludedTitles.join('、')}。`
    : ''
  const retainedGuidance = retainedCores.length
    ? `以下核心已经保留，绝不能改写：\n${JSON.stringify(retainedCores)}`
    : '本轮没有可保留的核心；仍必须生成一个能与后续核心形成不同机制的候选。'
  const repairContext = { violations: [violation] }
  const failedDetails = formatConflictCoreRepairContext(repairContext)
  const repairGuidance = getConflictCoreRepairGuidance(repairContext)
  const directionIndex = getConflictCoreIndex(target.id)
  const direction = directionIndex === undefined ? undefined : getSystemDraftDirectionForIndex(seed, directionIndex)
  const directionGuidance = direction
    ? `\n该位置绑定系统暂定分支：名称「${direction.label}」；mechanismType 必须逐字为「${direction.mechanismType}」；暂定前提「${direction.premise}」；暂定取舍「${direction.tradeoff}」。evidence 必须逐字引用这条分支的 premise 或 tradeoff；不能使用其他分支的前提。`
    : ''

  return `用户的原始念头：
---
${request.idea}
---

${formatStorySeed(seed)}

${getConflictCoreGoalInstruction(seed)}${getSparseSeedConflictCoreInstruction(seed)}

扩展尺度：${getExpansionScopeInstruction(request.expansionScope ?? 'keep-scale')}
${request.preference ? `用户偏好：${request.preference}` : ''}

现在只替换一个未通过审核的冲突核心。原候选：
${JSON.stringify(target)}

未通过原因：${failedDetails}。请只修正这些问题，仍然只输出第一层信息。${repairGuidance}

共同目标必须逐字为：“${sharedGoal}”。${retainedGuidance}${directionGuidance}
已保留机制类型：${retainedMechanismTypes.join('、') || '无'}。新候选的 mechanismType 必须不同于已保留类型，并且不能用未建立的事实、场景或结果凑出差异。${excludedTitles}

只生成替换候选，不返回 cores 数组，不修改任何保留候选。严格使用以下 JSON：
${conflictCoreReplacementResponseSchema}`
}

function formatConflictCoreRepairContext({ violations }: ConflictCoreRepairContext): string {
  return violations
    .map((violation) => {
      const claims = violation.unestablishedClaims?.slice(0, 3).join('、')
      const details = violation.missingParts.map((part) => conflictCoreContractPartLabel[part]).join('、')
      return `${violation.title}（${details}${claims ? `；未建立断言：${claims}` : ''}）`
    })
    .join('；')
}

function getConflictCoreRepairGuidance({ violations }: ConflictCoreRepairContext): string {
  const failedParts = new Set(violations.flatMap((violation) => violation.missingParts))
  const guidance: string[] = []

  if (failedParts.has('lockedFacts')) {
    guidance.push('删除所有未在原始念头或锁定事实中出现的关键条件，不能把未知背景当成已经成立。')
  }
  if (failedParts.has('actionableGoal') || failedParts.has('goalAnchor')) {
    guidance.push('不要重复 activeSituation 这件已发生的事实；请改成以原始对象或动作作为宾语的最小可观察动作或决定。')
  }
  if (failedParts.has('goalThreat')) {
    guidance.push('把障碍改成不处理就会直接改变、延后或阻断该目标的原因，不能只是尴尬、提醒或可忽略的插曲。')
  }
  if (failedParts.has('singleMechanism')) {
    guidance.push('每张卡只保留一个因果阻碍，删掉叠加的外部事件、画面压力和预设解法。')
  }
  if (failedParts.has('tradeoff') || failedParts.has('protagonistDecision')) {
    guidance.push('明确主角必须主动选择的两种取向，并让每一边都失去或冒险失去真实的东西。')
  }
  if (failedParts.has('sustainedDevelopment') || failedParts.has('escalation') || failedParts.has('balancedApproaches')) {
    guidance.push('保留能继续加压的单一问题，并使后续至少有两条不同、各有代价的主动起点。')
  }
  if (failedParts.has('groundedFacts')) {
    guidance.push('切换到逐字证据模式：obstacle 必须直接照抄或紧贴一条 evidence；tradeoff 与 decisionFocus 只能在 preservedGoal 和 evidence 已写出的条件之间表达。删除所有因果解释、流程、人物态度、身份含义、规则后果、替代办法和结果。')
  }
  if (failedParts.has('mechanismEvidence')) {
    guidance.push('mechanism 必须写成目标受阻的因果短语；evidence 只可逐字摘取 activeSituation、lockedFacts 或明确标出的系统暂定设定，不能概括、改写或补充。')
  }
  if (failedParts.has('distinctMechanism')) {
    guidance.push('三条 mechanism 必须不同，并对应三种不能互换的因果卡点；不要只更换表面载体。')
  }
  if (failedParts.has('axisFit')) {
    guidance.push('variationAxis 只描述实际阻碍机制，不能把情绪、普通道具或未建立的责任伪装成资源、关系或承诺。')
  }
  if (failedParts.has('specificity')) {
    guidance.push('去掉未建立的精确时限、步数、距离、人数、路线和预写行动过程。')
  }

  return guidance.join('')
}

function buildConflictCoreReviewPrompt(
  idea: string,
  seed: StorySeed,
  expansionScope: StoryExpansionScope,
  cores: readonly StoredStoryConflictCore[],
  repairMessage?: string,
  comparisonCores: readonly StoredStoryConflictCore[] = cores,
): string {
  const evidenceSourceDescription = getConflictCoreEvidenceSourceDescription(seed)
  const allowedSources = seed.systemDraft
    ? `\n\n每条候选唯一允许使用的事实源（按 conflictCoreId 严格对应）：\n${formatConflictCoreAllowedSourcesForReview(seed, cores)}`
    : ''
  const repair = repairMessage ? `\n${repairMessage}` : ''
  const comparison = comparisonCores.length !== cores.length
    ? `\n横向比较参考（只用于判断机制差异和共同目标，不要为这些参考候选返回 review）：\n${JSON.stringify(comparisonCores)}`
    : ''
  return `原始念头：\n---\n${idea}\n---\n\n${formatStorySeed(seed)}\n\n扩展尺度：${getExpansionScopeInstruction(expansionScope)}${allowedSources}\n\n待审核候选冲突核心：\n${JSON.stringify(cores)}${comparison}\n\n请逐条审查目标连续性、目标威胁、单一阻碍、真正两难、主角主动决定、可持续推进和升级空间；再横向比较待审核候选是否拥有不同的阻碍机制。审查 goalAnchoredToSeed 时，必须把 preservedGoal 对照 activeSituation 和 lockedFacts，确认目标保留了原始对象、事件或动作，而不是仅凭“应对/处理/解决”这样的动词通过。先检查每条 mechanism 是否准确概括 obstacle 的因果原因，再检查 evidence 是否逐字出现在 ${evidenceSourceDescription}；evidence 不能让候选凭空增加事实。系统暂定设定若存在，只可作为用户主动选择的本次路径前提，不得标成原文，并且每条只能使用上方对应编号的 systemDraftBranch。审查 usesDistinctMechanism 时，先抽象出每条“目标无法继续的原因”，忽略人物、道具、地点和画面，再比较原因是否真的不同。候选核心不得写死精确秒数、步数、距离、路线、倒数、固定先后动作、已经发生的回应和确定结局。审查 preservedGoal、obstacle、tradeoff、storyHook 和内部 decisionFocus、mechanism、evidence；storyHook 必须只是已建立信息的短钩子，不能用来推导当前场景或新事实。conflictCoreId 必须照抄待审核输入，恰好覆盖 ${cores.length} 条。${repair}\n严格使用：\n${getConflictCoreReviewResponseSchema(cores)}`
}

function buildConflictCoreGroundingReviewPrompt(
  idea: string,
  seed: StorySeed,
  cores: readonly StoredStoryConflictCore[],
  repairMessage?: string,
): string {
  const systemDraftContext = seed.systemDraft
    ? '系统暂定设定由系统给出，不是用户原文；但用户选择用它生成当前路径，因此每个候选可使用共同起点及其同编号分支的 premise、tradeoff，不能继续补全、扩大或归因给用户，也不能借用其他分支的前提。'
    : '没有系统暂定设定，候选只能以用户原文或用户确认的设定作为事实基础。'
  const allowedSources = formatConflictCoreAllowedSourcesForReview(seed, cores)
  const repair = repairMessage ? `\n${repairMessage}` : ''
  return `用户原始念头：
---
${idea}
---

故事种子中的锁定目标与锁定事实，均是用户原文摘录或用户后续补充并确认的事实；它们与原始念头同样可以作为事实基础，不能补全或扩大。${systemDraftContext} 当前处境只用于定位原始事件，仍未知项不得作为关键因果依据。

故事种子：
${formatStorySeed(seed)}

每条候选唯一允许使用的事实源（按 conflictCoreId 严格对应）：
${allowedSources}

待核对的第一层候选：
${JSON.stringify(cores)}

请逐条核对每个候选的 preservedGoal、obstacle、tradeoff、storyHook、decisionFocus 和 mechanism。storyHook 只可重组该候选已经允许的对象、目标、限制或取舍；不能把它当作已成立场景，也不能由它推出新的人物、动作、压力或后果。只列出没有被该候选允许事实源建立、却被候选核心字段写成已成立事实或因果前提的断言；不要评价结构，不要重述所有正确内容。systemDraftCommon 和 systemDraftBranch 是明确允许的系统暂定前提，不能仅因它们不在原始念头中就列为 unestablishedClaims；但候选仍不能把它们扩写成新的动作、位置、距离、视线、态度、过去经历、规则或结果。尤其不能因为 evidence 引用了一个宽泛片段，就认可该片段之外的断言。若只是把允许事实源中的对象、事件或动作组织成一个尚未发生的最小“决定是否/如何回应”目标，不要将这种必要组织本身列为新增事实。每条候选都必须返回 unestablishedClaims 数组；没有问题时返回空数组。conflictCoreId 必须照抄输入，并且只覆盖以上 ${cores.length} 条候选。${repair}

严格使用：
${getConflictCoreGroundingReviewResponseSchema(cores)}`
}

function getConflictCoreGroundingReviewResponseSchema(
  cores: readonly Pick<StoredStoryConflictCore, 'id'>[],
): string {
  const reviews = cores
    .map((core) => `    {
      "conflictCoreId": "${core.id}",
      "unestablishedClaims": []
    }`)
    .join(',\n')

  return `{
  "reviews": [
${reviews}
  ]
}`
}

function buildPredicamentExpansionPrompt(
  idea: string,
  seed: StorySeed,
  core: StoredStoryConflictCore,
  repairMessage?: string,
): string {
  const { storyHook, ...confirmedCore } = core
  const hookInstruction = storyHook
    ? `\n上一层的故事钩子仅供比较：「${storyHook}」。它不是已经成立的场景或事实，不得逐字承接，也不能拿它补出新的限制、人物或结果。`
    : ''
  const repair = repairMessage
    ? `\n上一版未通过结构检查：${repairMessage}。请重写全部具体困境。`
    : ''
  return `用户最初的想法：\n---\n${idea}\n---\n\n${formatStorySeed(seed)}\n\n${formatStoryRealityContractContext(seed)}\n\n已确认的冲突核心（必须逐字保留 variationAxis、preservedGoal、obstacle 和 tradeoff）：\n${JSON.stringify(confirmedCore)}${hookInstruction}\n\n内部选择焦点（不能原样写回 JSON）：${getConflictCoreDecisionFocus(core)}\n\n请展开为一个具体困境：补齐 immediateSituation、urgency、choice、plausibleCost、2 到 4 条 facts、恰好 2 条 approaches 和必要的 actions。choice 与两条 approaches 都必须回应内部选择焦点。两条 approach 此时只展示，不要求用户立刻选择；进入“故事两端”后，用户会选其中一条作为实际故事路线，后续头尾与逐步发展必须从该方向实际开始。因此两条都要是主角可主动选择、各有真实代价且没有明显更优的独立起点，不能是连续步骤、等待他人解决或同一办法的改写，也不能在这里预先写定具体回应、转折或结局。当前场景可以由与已确认核心一致的普通细节构成，但这些细节不能变成新增限制、资源、权限、精确时限、他人的必然决定或第二个核心阻碍。${repair}\n\n严格使用以下 JSON：\n${predicamentExpansionResponseSchema}`
}

function formatStorySeed(seed: StorySeed): string {
  const systemDraft = seed.systemDraft
    ? `\n- 系统暂定共同起点（用户选择系统先给一版；不是用户原文，可作为本次路径的可调整前提）：目标「${seed.systemDraft.goal}」；代价「${seed.systemDraft.stake}」；限制「${seed.systemDraft.constraint}」${seed.systemDraft.activeDirection
      ? formatSystemDraftDirections([seed.systemDraft.activeDirection])
      : formatSystemDraftDirections(seed.systemDraft.directions)}`
    : ''
  return `用户确认的故事种子（锁定目标与锁定事实均来自用户原文或用户补充确认，必须逐字保留）：
- 主体：${seed.subject}
- 当前处境：${seed.activeSituation}
- 锁定目标：${seed.lockedGoal ?? '未明确给出具体行动'}
- 锁定事实：${seed.lockedFacts.map((fact) => `「${fact}」`).join('、')}
${systemDraft}
- 世界语境：${seed.worldMode === 'realistic-default' ? '默认当代现实' : '用户已明确指定'}
- 仍未知且不得作为关键因果依据：${seed.unknowns.join('、') || '未给出的背景信息'}；不影响选择与后果的临时场景细节可以自然补写。`
}

function formatSystemDraftDirections(
  directions: StoryConflictCoreSystemDraft['directions'],
): string {
  if (!directions?.length) return ''

  const label = directions.length === 1 ? '；当前选定分支：' : '；三条互斥分支：'
  return `${label}${directions.map((direction, index) => (
    `${index + 1})「${direction.label}」/${direction.mechanismType}：前提「${direction.premise}」；取舍「${direction.tradeoff}」`
  )).join('；')}`
}

function getConflictCoreAllowedSourceRule(seed: Pick<StorySeed, 'systemDraft'>): string {
  if (!seed.systemDraft) {
    return '允许事实源规则：本次没有系统暂定设定。所有关键因果与 evidence 只能来自 activeSituation 或 lockedFacts；任何额外的背景、关系、规则、资源、行动或结果都必须拒绝。'
  }

  return '允许事实源规则（优先于前文所有“仅原文”表述）：用户主动选择了系统暂定路线。每个候选的事实源只能是用户原文摘录、系统暂定共同起点，以及与该候选同编号的系统暂定分支 premise、tradeoff。系统暂定内容是本次可编辑的路线前提，不是用户原话；不得把它归因给用户，也不得补写、扩大或借用其他分支的事实。'
}

function formatConflictCoreAllowedSourcesForReview(
  seed: StorySeed,
  cores: readonly Pick<StoredStoryConflictCore, 'id'>[],
): string {
  const userConfirmed = getUserConfirmedSeedSourceTexts(seed)
  const commonSystemDraft = seed.systemDraft
    ? [seed.systemDraft.goal, seed.systemDraft.stake, seed.systemDraft.constraint]
    : undefined

  return JSON.stringify(cores.map((core) => {
    const directionIndex = getConflictCoreIndex(core.id)
    const direction = directionIndex === undefined
      ? seed.systemDraft?.activeDirection
      : getSystemDraftDirection(seed, directionIndex)

    return {
      conflictCoreId: core.id,
      userConfirmed,
      ...(commonSystemDraft ? { systemDraftCommon: commonSystemDraft } : {}),
      ...(direction ? { systemDraftBranch: [direction.premise, direction.tradeoff] } : {}),
    }
  }))
}

function getSystemDraftPromptSupplement(seed: Pick<StorySeed, 'systemDraft'>): string {
  if (!seed.systemDraft) return ''

  const activeDirection = seed.systemDraft.activeDirection
  const branchRule = activeDirection
    ? '后续已选定一条分支；只允许使用该分支的 premise、tradeoff，不得再引用其他方向。'
    : '三条分支是互斥备选，不得把其他分支的 premise 当作当前候选的事实。'
  return `\n\n当前种子包含“系统暂定设定”。这是用户主动选择“让系统先给一版”后采用的本次路径前提，不是用户原文。对于这一明确标出的系统路线，本段优先于前文关于“只能使用原文”的一般表述：evidence 和因果依据可以逐字引用共同起点或当前候选所属分支的 premise、tradeoff，但绝不能把它们写成用户说过的事实，也不能在所属分支之外补写新的背景、人物、规则或结果。${branchRule}`
}

function getConflictCoreEvidenceSourceDescription(seed: Pick<StorySeed, 'systemDraft'>): string {
  return seed.systemDraft
    ? 'activeSituation、lockedFacts、系统暂定共同起点或当前候选所属的系统暂定分支中'
    : 'activeSituation 或 lockedFacts 中'
}

function getConflictCoreGoalInstruction(seed: StorySeed): string {
  if (seed.lockedGoal) {
    return `目标规则：三条 preservedGoal 都必须逐字使用已锁定目标“${seed.lockedGoal}”，不能改写成另一件事。`
  }

  if (seed.systemDraft) {
    return `目标规则：三条 preservedGoal 都必须逐字使用系统暂定目标“${seed.systemDraft.goal}”。它不是用户原文，但已由用户选择为本次路径的暂定前提；不得换成另一件事，也不得补写长期动机、关系状态或职业责任。`
  }

  return `目标规则：用户没有给出明确动作目标。请从当前处境“${seed.activeSituation}”和锁定事实“${seed.lockedFacts.join('；')}”中提炼一个最小、具体、可由主角主动完成的动作或决定；目标必须保留其中至少一个可辨认的对象、事件或动作，并让读者能看出目标与原始念头的直接关系。可以补出由该事实直接推出的最小决定，但不得把事件改写成“完成应对、解决问题、维持体面”等抽象状态。三条 preservedGoal 必须逐字使用同一个目标，不得用“眼前事件”“下一步”“这件事”等占位语，也不得补写长期动机、关系状态或职业责任。`
}

function getSparseSeedConflictCoreInstruction(seed: StorySeed): string {
  if (seed.systemDraft) {
    return '\n系统暂定设定使用规则：每条候选必须绑定 directions 中同索引的分支前提，只能使用共同起点和该分支的 premise、tradeoff 作为逐字证据；其他分支的前提不得混入。它们只解释当前分支为什么会卡住，不能被扩写为用户既有背景、他人态度、具体行动过程或结局。'
  }

  if (!isSingleSituationSeed(seed)) return ''

  return `\n事实证据容量规则：lockedFacts 虽可能列出多段文字，但都可能只是同一个当前事件的摘录；不能靠虚构场景细节来凑三条卡片。先检查原文实际支持多少种不同的 mechanismType；若不足三种，绝不能因为输出配额补写条件。每种类型都必须用原文 evidence 支撑其完整因果链：信息缺口不能假定隐藏信息存在，边界冲突必须有原文已建立的关系或限制，行动含义冲突必须确实由目标动作本身产生，时机、资源或承诺类型更必须有对应的明示事实。若去掉人物、物品、地点、画面和情绪后都只是主角难以开始行动，就不是三种卡点。没有原文建立的时机、资源、责任、规则或其他限制时，绝不能拿它们补足机制。`
}

function isSingleSituationSeed(seed: StorySeed): boolean {
  if (seed.lockedGoal) return false

  const normalizedSituation = normalizeGoalText(seed.activeSituation)
  return Boolean(normalizedSituation)
    && seed.lockedFacts.length > 0
    && seed.lockedFacts.every((fact) => {
      const normalizedFact = normalizeGoalText(fact)
      return Boolean(normalizedFact) && normalizedSituation.includes(normalizedFact)
    })
}

function buildStoryFoundationContext(
  idea: string,
  seed: StorySeed,
  predicament: StoryPredicament,
  approach: StoryPredicamentApproach,
  predicamentLabel = '确认的故事困境',
): string {
  return `用户最初的想法：
---
${idea}
---

${formatStorySeed(seed)}

${predicamentLabel}：
${JSON.stringify(predicament)}

用户已确认的应对方向（后续故事的起点）：
${JSON.stringify(approach)}

后续开场、发展、关键行动和结尾都必须承接这条方向实际开始后的处境与直接代价。可以产生新的选择，但不得把另一条未选方向写成主线、既成事实或替代路线。`
}

function getExpansionScopeInstruction(scope: StoryExpansionScope): string {
  if (scope === 'grounded-obstacle') {
    return '加入一点现实阻碍：可增加一项与当下行动直接相关的实际困难，但不要补写永久背景。'
  }
  if (scope === 'larger-story') {
    return '发展成更大的故事：可以扩大这件事带来的关系或后果，但原始目标仍必须是主线，新增设定不能冒充用户既有事实。'
  }
  if (scope === 'genre-led') {
    return '按题材展开：允许用不同类型的表达方式制造差异，但每条仍必须让锁定目标保持为主线，且不要替换人物或行动。'
  }
  return '就从这件小事开始：保持原始事件的大小和默认现实语境，只补充眼前可见的阻碍。'
}

function buildHeadTailPrompt(
  { idea, seed, predicament, approach }: StoryHeadTailRequest,
  repairContext?: HeadTailRepairContext,
): string {
  return `${buildStoryFoundationContext(idea, seed, predicament, approach, '用户确认的故事困境')}

三个开场都必须让主角从已选方向开始实际应对阻碍，且持续承担它的直接代价或不确定性；每个高潮都要由主角亲自完成，并围绕整个困境的目标、阻碍与取舍展开；每个结尾都要作为高潮行动的直接结果，明确已确认主线目标如何变化并回应开场线索。不要把另一条未选方向写成既成事实、替代路线或必然结果，也不要补写故事种子中没有的永久履历或重大背景。${repairContext ? `\n上一轮的问题：${repairContext.violations.join('、')}。三条都必须修正。` : ''}

请生成恰好 3 个可选择的头尾方案，并严格使用以下 JSON 结构：
{
  "options": [
    {
      "opening": "故事开始时具体发生的事，不超过 120 字",
      "openingClue": "开头埋下、结尾能回应的具体线索，不超过 80 字",
      "climax": "主角在高潮必须亲自完成的行动，不超过 120 字",
      "resolution": "高潮行动之后的结局状态，明确原始目标的结果和开场线索如何被回应，不超过 120 字",
      "cost": "完成这一行动需要承担的代价，不超过 100 字",
      "promise": "这个组合会带来怎样的阅读期待，不超过 60 字",
      "climaxActionId": "确认困境 actions 中的一个 action id",
      "transition": {
        "actionId": "与 climaxActionId 相同",
        "consumedFacts": ["该行动的前置 fact id"],
        "changedFacts": [
          { "factId": "该行动 effects 中的 changeable fact id", "statement": "行动之后该事实的具体新状态" }
        ],
        "introducedFacts": [
          { "id": "fact-new-1", "statement": "这次行动直接带来的新事实", "mutability": "changeable" }
        ]
      }
    }
  ]
}`
}

function buildHeadTailGoalReviewPrompt(
  { idea, seed, predicament, approach }: StoryHeadTailRequest,
  options: StoryHeadTailOptions,
): string {
  return `${buildStoryFoundationContext(idea, seed, predicament, approach, '用户确认的故事困境')}

待审查的头尾方案：
${JSON.stringify(options)}

逐条判断：keepsConfirmedGoal 只有在 opening、climax 和 resolution 都围绕主线目标时才能为 true；主线目标优先使用锁定目标，若其为空则使用确认困境的 preservedGoal。followsSelectedApproach 只有在 opening 和后续关键行动确实从用户已选方向开始，且没有改用另一条未选方向作为主线时才能为 true。climaxIsProtagonistAction 只有在 climax 是主角亲自完成的关键行动时才能为 true；resolutionFulfillsPlan 只有在 resolution 是 climax 的直接结果，明确改变目标结果并回应 openingClue 时才能为 true。允许合理的同义改写，不要以是否逐字复述作为判断标准。

optionId 必须照抄输入，恰好审查全部三条。严格使用以下 JSON 结构：
{
  "reviews": [
    {
      "optionId": "head-tail-1",
      "keepsConfirmedGoal": true,
      "followsSelectedApproach": true,
      "climaxIsProtagonistAction": true,
      "resolutionFulfillsPlan": true,
      "transitionIsGrounded": true
    }
  ]
}`
}

function buildStoryTurnPrompt(
  { idea, seed, predicament, approach, headTail, history, mode }: StoryTurnRequest,
  state: StoryNarrativeState,
  repairMessage?: string,
  outputFormat: StoryTurnOutputFormat = 'detailed',
): string {
  const modeInstruction = getStoryTurnModeInstruction(mode, history.length)
  const responseSchema = getStoryTurnResponseSchema(mode, outputFormat)
  const responseChecklist = getStoryTurnResponseChecklist(mode, outputFormat)

  return `${buildStoryFoundationContext(idea, seed, predicament, approach, '用户确认的故事困境')}

用户确认的故事两端：
${JSON.stringify(headTail)}

已确认的因果链（顺序不可改写；最后一项是此刻必须承接的行动）：
${formatStoryTurnHistory(history)}

当前叙事状态（只可引用其中的 fact/action ID；fixed 事实不可改写）：
${JSON.stringify(state)}

本次任务：${modeInstruction}
${getStoryTurnRepairInstruction(repairMessage, outputFormat)}

请只生成这一次推进的结果，不要补写未来大纲。node.event 必须是一个可视、可行动的当前局面；node.purpose 要准确说明它如何由前一步的选择而来，以及它将怎样把故事推向预定高潮语义和结尾。conflict.action 描述主角此刻面临的行动方向，但不要代替用户从 options 中作选择。故事两端中的 climaxActionId 只说明最初方案的状态依据，不是收束回合必须复用的动作 ID。

${getStoryTurnStateProtocolInstruction(outputFormat)}

输出前只核对以下结构：${responseChecklist}

严格使用以下 JSON 结构：
${responseSchema}`
}

function buildStoryTurnOptionRefinementPrompt(
  { idea, seed, predicament, approach, headTail, history, currentTurn, originalOption, focus, feedback }: StoryTurnOptionRefinementGenerationRequest,
  state: StoryNarrativeState,
  repairMessage?: string,
): string {
  const otherOptions = currentTurn.options
    .filter((option) => option.id !== originalOption.id)
    .map(toReaderFacingStoryTurnOption)

  return `${buildStoryFoundationContext(idea, seed, predicament, approach, '用户确认的故事困境')}

用户确认的故事两端：
${JSON.stringify(headTail)}

已确认的因果链（不能改写）：
${formatStoryTurnHistory(history)}

当前叙事状态（只能在其支持的范围内调整行动）：
${JSON.stringify(state)}

当前情境（不能改写）：
${JSON.stringify({ node: currentTurn.node, conflict: currentTurn.conflict, question: currentTurn.question })}

目标选项（只改这一条）：
${JSON.stringify(toReaderFacingStoryTurnOption(originalOption))}

其余两条选项（必须原样保留，也不要与它们重复）：
${JSON.stringify(otherOptions)}

用户希望调整的部分：${getStoryTurnOptionRefinementFocusLabel(focus)}
用户说明：${feedback}

请据此重写目标选项。行动必须仍然是主角此刻可做的事，立即结果必须是该行动会产生的当下后果，可能影响只能是尚未发生的后续牵引。不要凭空增加关键身份、长期关系、疾病、规则、资源或已经发生的结果；普通画面和临时动作可以自然补写。至少让 label、action、immediateConsequence、laterEffect 中的一项相对原选项有实质变化。不要输出 id、narrativeAction、transition 或任何解释。${repairMessage ? `\n上一版没有通过检查：${repairMessage}。请完整重写这个选项。` : ''}

严格使用以下 JSON 结构：
{
  "option": {
    "label": "不超过 32 字的选择名称",
    "action": "主角现在采取的行动",
    "immediateConsequence": "行动后的当下结果",
    "laterEffect": "尚未发生的后续牵引"
  }
}`
}

function toReaderFacingStoryTurnOption(option: StoryTurnOption): Pick<StoryTurnOption, 'id' | 'label' | 'action' | 'immediateConsequence' | 'laterEffect'> {
  return {
    id: option.id,
    label: option.label,
    action: option.action,
    immediateConsequence: option.immediateConsequence,
    laterEffect: option.laterEffect,
  }
}

function getStoryTurnStateProtocolInstruction(outputFormat: StoryTurnOutputFormat): string {
  if (outputFormat === 'compact') {
    return '本回合使用紧凑叙事结构：只写 node、conflict、question、options 中列出的读者可见字段。不要输出 narrativeAction、transition、id、actionId、goalState、phase、canConclude、isConclusion、intensity 或 anchor；服务端会从已确认路径中保存内部行动记录。收束时必须把主角已经实际完成的结尾行动写清 conflict.action。'
  }

  return '本回合使用详细状态结构：每个选项，以及收束时顶层的 narrativeAction，其 preconditions 只能引用当前 facts 中存在且非 unknown 的 ID；effects 只能引用 changeable facts 的 ID。transition.consumedFacts 必须覆盖 preconditions；changedFacts 必须更新 effects 中的每个 fact；introducedFacts 如果为空数组也必须保留。只引用完成该行动所需的最少 fact ID，通常 1 到 2 个；没有必要时 introducedFacts 一律使用 []。不要给 narrativeAction 或 transition 自行填写 id/actionId，服务端会分配。'
}

function getStoryTurnRepairInstruction(
  repairMessage: string | undefined,
  outputFormat: StoryTurnOutputFormat,
): string {
  if (!repairMessage) return ''
  if (outputFormat === 'compact') {
    return '\n上一轮的详细内部结构没有通过检查；本次已改为紧凑叙事结构。请完整重写读者可见的当前情境和选项，不要输出或修复 narrativeAction、transition 等内部字段。'
  }

  return `\n上一轮没有通过结构检查：${repairMessage}。请完整重做这一回合，不要沿用不合格字段。`
}

function getStoryTurnResponseSchema(mode: StoryTurnMode, outputFormat: StoryTurnOutputFormat): string {
  if (outputFormat === 'compact') {
    return mode === 'conclude'
      ? storyTurnConclusionCompactResponseSchema
      : storyTurnOngoingCompactResponseSchema
  }

  return mode === 'conclude'
    ? storyTurnConclusionResponseSchema
    : storyTurnOngoingResponseSchema
}

function getStoryTurnResponseChecklist(mode: StoryTurnMode, outputFormat: StoryTurnOutputFormat): string {
  if (outputFormat === 'compact') {
    return mode === 'conclude'
      ? '只输出一个 turn；question 必须为 null；options 必须为 []；不得输出 narrativeAction、transition 或内部状态字段。'
      : '只输出一个 turn；question 必须是非空字符串；options 必须恰好有 3 项；每项仅含 label、action、immediateConsequence、laterEffect；不得输出 narrativeAction、transition 或内部状态字段。'
  }

  if (mode === 'conclude') {
    return '只输出一个 turn；question 必须为 null；options 必须为 []；顶层 narrativeAction 和 transition 都必须是对象。'
  }

  return '只输出一个 turn；question 必须是非空字符串；options 必须恰好有 3 项；每项都含 label、action、immediateConsequence、laterEffect、narrativeAction、transition。不要输出顶层 narrativeAction 或 transition；服务端会补为 null。'
}

function buildStoryTurnGroundingReviewPrompt(
  { idea, seed, predicament, approach, headTail, history, mode }: StoryTurnRequest,
  state: StoryNarrativeState,
  turn: StoryTurn,
): string {
  return `${buildStoryFoundationContext(idea, seed, predicament, approach, '用户确认的故事困境')}

用户确认的故事两端：
${JSON.stringify(headTail)}

已确认的行动链：
${formatStoryTurnHistory(history)}

当前叙事状态：
${JSON.stringify(state)}

本次推进方式：${mode}

待审查的候选回合：
${JSON.stringify(turn)}

situationIsGrounded 只在 node、conflict 和收束结果都直接承接当前状态及已确认行动时为 true；它独立于任意 option 是否成立。每个 option 的 isGrounded 只有在 action 确实是主角凭已有事实能够正当完成的行动，preconditions/effects/transition 与文字后果一致，且没有把未知信息、假定授权或临时场景细节当成关键因果、没有绕过 fixed 限制或凭空制造关键结果时才为 true。

若候选为收束回合，conclusionFulfillsHeadTail 只有在最后一项已确认选择先发生，随后由候选 narrativeAction 及必要的普通桥接自然走到 headTail.climax、headTail.resolution 并回应 headTail.openingClue 时才为 true。不要要求候选 narrativeAction 的 ID 或字面措辞等于 headTail.climaxActionId；只判断实际因果与结局语义。若桥接暗中创造关键资源、权限、关系、信息或外部结果，必须为 false。非收束回合的 conclusionFulfillsHeadTail 必须为 null。

审查时只追究承担关键因果的无依据内容。普通道具、动作、画面、感官细节，以及目标、人物、地点和已确认计划的自然延续都可以成立，除非它们被用来改变选择可行性、代价、状态或后续结果。

detail 要具体说明审查依据；若不成立，指出哪个无依据内容承担了什么关键因果。即使成立也要写简短具体依据。严格使用以下 JSON 结构：
${buildStoryTurnGroundingReviewResponseSchema(turn.isConclusion)}`
}

function buildStoryTurnGroundingReviewResponseSchema(isConclusion: boolean): string {
  const optionReviews = isConclusion
    ? '[]'
    : `[
    {
      "optionId": "候选 option 的 id",
      "isGrounded": true,
      "detail": "不超过 120 字的具体依据"
    }
  ]`

  return `{
  "situationIsGrounded": true,
  "conclusionFulfillsHeadTail": ${isConclusion ? 'true' : 'null'},
  "optionReviews": ${optionReviews}
}`
}

function getStoryTurnModeInstruction(mode: StoryTurnMode, historyLength: number): string {
  if (mode === 'start') {
    return '开始故事：把用户确认的开场转化为第一个可选择的当前情境。它必须建立直接阻碍，question 必须非空，options 必须恰好有 3 项。'
  }

  if (mode === 'conclude') {
    return `在第 ${historyLength} 次已确认行动之后收束：所有这些行动都必须先发生，最新选择是结尾的起点，不必等于高潮行动。可以补足不承担关键因果的自然桥接，再让主角完成实际结尾行动，兑现预定高潮语义、预定结尾结果和开场线索。question 必须为 null，options 必须是空数组，顶层 narrativeAction 与 transition 必须非空。`
  }

  return `继续发展：承接第 ${historyLength} 次已确认行动的实际后果，只生成下一段尚未解决的情境。question 必须是非空字符串，options 必须恰好有 3 项。`
}

function formatStoryTurnHistory(history: StoryTurnHistoryItem[]): string {
  if (!history.length) return '尚无已确认行动。'

  return history.map((item, index) => `${index + 1}. [${item.phase}]
- 事件：${item.node.event}
- 当前阻力：${item.conflict.conflict}
- 主角选择：${item.selectedOption.action}
- 立即后果：${item.selectedOption.immediateConsequence}
- 后续牵引（尚未发生，不得当作既成事实）：${item.selectedOption.laterEffect}`).join('\n')
}

function buildConfirmedStoryPath(plan: StoryPlan): ConfirmedStoryPathItem[] {
  const conclusionAction = plan.conclusion.conflict.action || plan.conclusion.narrativeAction?.intent || null

  return [
    {
      id: 'opening',
      label: '开场与阻碍',
      situation: `${plan.headTail.opening} ${plan.predicament.immediateSituation}`.trim(),
      obstacle: plan.predicament.obstacle,
      selectedAction: null,
      immediateResult: null,
    },
    ...plan.turnHistory.map((item, index) => ({
      id: `turn-${index + 1}`,
      label: `第 ${index + 1} 次确认`,
      situation: item.node.event,
      obstacle: item.conflict.conflict,
      selectedAction: item.selectedOption.action,
      immediateResult: item.selectedOption.immediateConsequence,
    })),
    {
      id: 'conclusion',
      label: '实际收束',
      situation: plan.conclusion.node.event,
      obstacle: plan.conclusion.conflict.conflict,
      selectedAction: conclusionAction,
      immediateResult: plan.conclusion.conflict.consequence,
    },
  ]
}

function buildStoryPrompt(
  { idea, plan }: StoryGenerationRequest,
  state: StoryNarrativeState,
  confirmedPath: ConfirmedStoryPathItem[],
  repairMessage?: string,
): string {
  return `${buildStoryFoundationContext(idea, plan.seed, plan.predicament, plan.approach, '用户逐步确认的故事困境')}

用户确认的故事两端约束：
${JSON.stringify({
  openingClue: plan.headTail.openingClue,
  climax: plan.headTail.climax,
  resolution: plan.headTail.resolution,
  cost: plan.headTail.cost,
})}

只含既成事实的确认路径账本（situation 是当时局面，selectedAction 是实际选择，immediateResult 是该选择已经造成的当下结果；null 表示该类信息不适用）：
${JSON.stringify(confirmedPath)}

最终叙事状态与已应用变更：
${JSON.stringify(state)}

请写一篇完整短篇。确认路径账本与实际收束是用户已经确认的事实：不得删改、调换或把用户未选的选项写成实际行动。正文必须按“前一选择的当下结果 → 新局面 → 下一次选择”的因果顺序推进，明确写出每个关键行动为什么会发生；锁定目标持续驱动行动，结局必须由实际收束中的主角行动达成，并兑现预定结局、回应开场线索。账本没有列出后续牵引，不能把任何先前的预测、风险或线索写成必然发生的具体事件。不能用新的人设、历史或事件替换已经确认的故事路径。${getStoryGenerationRepairInstruction(repairMessage)}

写作完成后先逐段核对实体状态和因果链，再输出 JSON。用自然段组织正文，不要把标题、梗概、结构说明或审查意见混入 body。body 是唯一必填字段；title 和 logline 仅用于页面展示。若它们会挤占正文篇幅或影响 JSON 的完整性，宁可省略它们，也不得缩短正文或把正文改成大纲。不要输出 outline 或 review。严格使用 JSON 对象：
{
  "body": "完整正文，使用 \\n\\n 分隔自然段",
  "title": "可选：故事标题",
  "logline": "可选：一句话概述这条故事"
}`
}

function getStoryGenerationRepairInstruction(repairMessage: string | undefined): string {
  if (!repairMessage) return ''
  return `\n上一版正文没有通过路径一致性检查：${repairMessage}。请完整重写正文，保留所有已确认路径，并只修正这些冲突或缺失；不要因此删掉普通场景细节。`
}

function buildStoryBodyConsistencyReviewPrompt(
  { idea, plan }: StoryGenerationRequest,
  state: StoryNarrativeState,
  confirmedPath: ConfirmedStoryPathItem[],
  story: GeneratedStory,
): string {
  return `${buildStoryFoundationContext(idea, plan.seed, plan.predicament, plan.approach, '用户逐步确认的故事困境')}

预定结尾约束：
${JSON.stringify({
  openingClue: plan.headTail.openingClue,
  climax: plan.headTail.climax,
  resolution: plan.headTail.resolution,
})}

已确认路径账本：
${JSON.stringify(confirmedPath)}

最终叙事状态：
${JSON.stringify(state)}

候选正文：
---
${story.body}
---

按路径账本逐项检查：每项的 situation、obstacle、selectedAction、immediateResult 都要按语义保留；selectedAction 和 immediateResult 必须保持顺序。issues.pathId 只能是 ${[...confirmedPath.map((item) => item.id), 'body'].join('、')} 之一。严格使用以下 JSON 结构：
{
  "isConsistent": true,
  "issues": [
    {
      "kind": "missing-path-item、contradiction 或 unsupported-critical-detail",
      "pathId": "对应账本项 id 或 body",
      "detail": "不超过 220 字的具体问题"
    }
  ]
}`
}

function parseModelConflictCore(value: unknown, index: number): StoredStoryConflictCore {
  const message = '模型返回的冲突核心不完整，请重试。'
  const record = expectRecord(value, message, invalidModelOutputContext)
  const mechanismType = readConflictCoreMechanismType(record.mechanismType, message)
  return {
    id: `conflict-core-${index + 1}`,
    title: readText(record, 'title', message, 40, invalidModelOutputContext),
    variationAxis: readConflictCoreVariationAxis(record.variationAxis, mechanismType, message),
    preservedGoal: readText(record, 'preservedGoal', message, 180, invalidModelOutputContext),
    obstacle: readText(record, 'obstacle', message, 180, invalidModelOutputContext),
    tradeoff: readText(record, 'tradeoff', message, 220, invalidModelOutputContext),
    decisionFocus: readText(record, 'decisionFocus', message, 120, invalidModelOutputContext),
    mechanism: readText(record, 'mechanism', message, 80, invalidModelOutputContext),
    mechanismType,
    evidence: readRequiredTextList(record, 'evidence', 1, 2, 80, message, invalidModelOutputContext),
    storyHook: readText(record, 'storyHook', message, 96, invalidModelOutputContext),
  }
}

function parsePredicament(
  record: Record<string, unknown>,
  context: ValidationErrorContext,
  message: string,
  generatedId?: string,
): StoryPredicament {
  const predicament: StoryPredicament = {
    id: generatedId ?? readText(record, 'id', message, 64, context),
    title: readText(record, 'title', message, 40, context),
    variationAxis: readStoryVariationAxis(record.variationAxis, message, context),
    preservedGoal: readText(record, 'preservedGoal', message, 180, context),
    immediateSituation: readText(record, 'immediateSituation', message, 220, context),
    obstacle: readText(record, 'obstacle', message, 180, context),
    tradeoff: readText(record, 'tradeoff', message, 220, context),
    urgency: readText(record, 'urgency', message, 160, context),
    choice: readText(record, 'choice', message, 180, context),
    plausibleCost: readText(record, 'plausibleCost', message, 180, context),
    approaches: parsePredicamentApproaches(record.approaches, context, message),
    facts: parseStoryFacts(record.facts, context, message, 'predicament', 2, 4),
    actions: parseStoryActions(record.actions, context, message, 'user-choice', 1, 3),
  }

  validatePredicamentNarrative(predicament, context, message)
  return predicament
}

function parsePredicamentApproaches(
  value: unknown,
  context: ValidationErrorContext,
  message: string,
): StoryPredicament['approaches'] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new AppError(message, context.statusCode, context.code)
  }

  return value.map((item, index) => {
    const record = expectRecord(item, message, context)
    return {
      id: `approach-${index + 1}`,
      intent: readText(record, 'intent', message, 180, context),
      cost: readText(record, 'cost', message, 180, context),
    }
  })
}

function parseStoryFacts(
  value: unknown,
  context: ValidationErrorContext,
  message: string,
  source: StoryFact['source'],
  minimumItems: number,
  maximumItems: number,
): StoryFact[] {
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) {
    throw new AppError(message, context.statusCode, context.code)
  }

  const facts = value.map((item) => {
    const record = expectRecord(item, message, context)
    return {
      id: readIdentifier(record, 'id', message, context),
      statement: readText(record, 'statement', message, 180, context),
      source,
      mutability: readStoryFactMutability(record.mutability, message, context),
    }
  })

  ensureUniqueValues(facts.map((fact) => fact.id), message, context)
  return facts
}

function parseStoryActions(
  value: unknown,
  context: ValidationErrorContext,
  message: string,
  source: StoryAction['source'],
  minimumItems: number,
  maximumItems: number,
): StoryAction[] {
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) {
    throw new AppError(message, context.statusCode, context.code)
  }

  const actions = value.map((item) => parseStoryAction(item, context, message, source))

  ensureUniqueValues(actions.map((action) => action.id), message, context)
  return actions
}

function parseStoryAction(
  value: unknown,
  context: ValidationErrorContext,
  message: string,
  source: StoryAction['source'],
  generatedId?: string,
): StoryAction {
  const record = expectRecord(value, message, context)
  return {
    id: generatedId ?? readIdentifier(record, 'id', message, context),
    intent: readText(record, 'intent', message, 180, context),
    preconditions: readIdentifierList(record, 'preconditions', 1, maximumTransitionFactReferences, message, context),
    effects: readIdentifierList(record, 'effects', 1, maximumTransitionFactReferences, message, context),
    source,
  }
}

function parseStoryTransition(
  value: unknown,
  context: ValidationErrorContext,
  message: string,
  generatedActionId?: string,
): StoryTransition {
  const record = expectRecord(value, message, context)
  const introducedFactsValue = record.introducedFacts
  if (!Array.isArray(introducedFactsValue) || introducedFactsValue.length > 3) {
    throw new AppError(message, context.statusCode, context.code)
  }

  return {
    actionId: generatedActionId ?? readIdentifier(record, 'actionId', message, context),
    consumedFacts: readIdentifierList(record, 'consumedFacts', 1, maximumTransitionFactReferences, message, context),
    changedFacts: parseStoryFactChanges(record.changedFacts, context, message),
    introducedFacts: parseStoryFacts(introducedFactsValue, context, message, 'confirmed-action', 0, 3),
  }
}

function parseStoryFactChanges(
  value: unknown,
  context: ValidationErrorContext,
  message: string,
): StoryTransition['changedFacts'] {
  if (!Array.isArray(value) || value.length > maximumTransitionFactReferences) {
    throw new AppError(message, context.statusCode, context.code)
  }

  const changes = value.map((item) => {
    const record = expectRecord(item, message, context)
    return {
      factId: readIdentifier(record, 'factId', message, context),
      statement: readText(record, 'statement', message, 180, context),
    }
  })

  ensureUniqueValues(changes.map((change) => change.factId), message, context)
  return changes
}

function validatePredicamentNarrative(
  predicament: StoryPredicament,
  context: ValidationErrorContext,
  message: string,
) {
  const factsById = new Map(predicament.facts.map((fact) => [fact.id, fact]))
  for (const action of predicament.actions) {
    const changesStaticResource = action.effects.some((factId) => {
      const statement = factsById.get(factId)?.statement ?? ''
      return /(?:手机|电话|通讯录|号码|网络|账号|设备|工具|容器|小盒|收纳)/u.test(statement)
    })
    if (
      action.preconditions.some((factId) => factsById.get(factId)?.mutability === undefined || factsById.get(factId)?.mutability === 'unknown')
      || action.effects.some((factId) => factsById.get(factId)?.mutability !== 'changeable')
      || changesStaticResource
    ) {
      throw new AppError(message, context.statusCode, context.code)
    }
  }
}

function requireNull(
  value: unknown,
  message: string,
  context: ValidationErrorContext,
): void {
  if (value !== null) throw new AppError(message, context.statusCode, context.code)
}

function requireNullOrMissing(value: unknown, message: string): void {
  if (value !== undefined && value !== null) {
    throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
  }
}

function parseStorySeedDraft(
  value: unknown,
  context: ValidationErrorContext,
): StorySeedDraft {
  const message = '模型没有识别出完整的原始念头锁定信息，请重试。'
  const record = expectRecord(value, message, context)
  return parseStorySeedFields(record, context, message, 3)
}

function parseStorySeedContextPrefill(
  value: unknown,
  seed: StorySeedDraft,
): StoryConflictCoreContextPrefill {
  const fallback = getConflictCoreContextPrefill(seed)
  if (!isPlainRecord(value)) return fallback

  const goal = readOptionalGeneratedText(value.goal, maximumConflictCoreContextLength)
  const stake = readOptionalGeneratedText(value.stake, maximumConflictCoreContextLength)
  const constraint = readOptionalGeneratedText(value.constraint, maximumConflictCoreContextLength)

  return {
    ...fallback,
    ...(!fallback.goal && goal ? { goal } : {}),
    ...(stake ? { stake } : {}),
    ...(constraint ? { constraint } : {}),
  }
}

function parseStorySeed(value: unknown, context: ValidationErrorContext): StorySeed {
  const message = '故事种子格式不正确，请返回上一步重新生成。'
  const record = expectRecord(value, message, context)
  const expansionScope = readStoryExpansionScope(record.expansionScope)
  if (!expansionScope) {
    throw new AppError(message, context.statusCode, context.code)
  }

  return {
    ...parseStorySeedFields(record, context, message),
    expansionScope,
  }
}

function parseStorySeedFields(
  record: Record<string, unknown>,
  context: ValidationErrorContext,
  message: string,
  maximumLockedFacts = maximumStorySeedLockedFacts,
): StorySeedDraft {
  return {
    subject: readText(record, 'subject', message, 160, context),
    activeSituation: readText(record, 'activeSituation', message, 200, context),
    lockedGoal: readNullableText(record, 'lockedGoal', message, 180, context),
    lockedFacts: readRequiredTextList(record, 'lockedFacts', 1, maximumLockedFacts, maximumStorySeedLockedFactLength, message, context),
    worldMode: readStoryWorldMode(record.worldMode, message, context),
    unknowns: readRequiredTextList(record, 'unknowns', 1, 6, 48, message, context),
  }
}

function parseConflictCoreReviews(
  value: unknown,
  cores: readonly StoredStoryConflictCore[],
): ConflictCoreContractReview[] {
  const message = '模型没有完成冲突核心的质量检查，请重试。'
  return parseCompleteReviewSet(
    value,
    cores,
    (reviewValue, reviewMessage) => {
      const record = expectRecord(reviewValue, reviewMessage, invalidModelOutputContext)
      return {
        conflictCoreId: readText(record, 'conflictCoreId', reviewMessage, 64, invalidModelOutputContext),
        preservesLockedFacts: readBoolean(record, 'preservesLockedFacts', reviewMessage, invalidModelOutputContext),
        preservesLockedGoal: readBoolean(record, 'preservesLockedGoal', reviewMessage, invalidModelOutputContext),
        obstacleThreatensGoal: readBoolean(record, 'obstacleThreatensGoal', reviewMessage, invalidModelOutputContext),
        hasSingleMechanism: readBoolean(record, 'hasSingleMechanism', reviewMessage, invalidModelOutputContext),
        requiresTradeoff: readBoolean(record, 'requiresTradeoff', reviewMessage, invalidModelOutputContext),
        forcesProtagonistDecision: readBoolean(record, 'forcesProtagonistDecision', reviewMessage, invalidModelOutputContext),
        supportsSustainedDevelopment: readBoolean(record, 'supportsSustainedDevelopment', reviewMessage, invalidModelOutputContext),
        hasEscalationPath: readBoolean(record, 'hasEscalationPath', reviewMessage, invalidModelOutputContext),
        canSupportBalancedApproaches: readBoolean(record, 'canSupportBalancedApproaches', reviewMessage, invalidModelOutputContext),
        usesDistinctMechanism: readBoolean(record, 'usesDistinctMechanism', reviewMessage, invalidModelOutputContext),
        sharesCommonGoal: readBoolean(record, 'sharesCommonGoal', reviewMessage, invalidModelOutputContext),
        hasActionableGoal: readBoolean(record, 'hasActionableGoal', reviewMessage, invalidModelOutputContext),
        goalForm: readConflictCoreGoalForm(record.goalForm, reviewMessage),
        goalAnchoredToSeed: readBoolean(record, 'goalAnchoredToSeed', reviewMessage, invalidModelOutputContext),
        introducesNoUnestablishedFacts: readBoolean(record, 'introducesNoUnestablishedFacts', reviewMessage, invalidModelOutputContext),
        mechanismEvidenceGrounded: readBoolean(record, 'mechanismEvidenceGrounded', reviewMessage, invalidModelOutputContext),
        unestablishedClaims: readRequiredTextList(record, 'unestablishedClaims', 0, 6, 180, reviewMessage, invalidModelOutputContext),
        variationAxisFitsMechanism: readBoolean(record, 'variationAxisFitsMechanism', reviewMessage, invalidModelOutputContext),
        staysWithinScope: readBoolean(record, 'staysWithinScope', reviewMessage, invalidModelOutputContext),
      }
    },
    (review) => review.conflictCoreId,
    message,
  )
}

function parseConflictCoreGroundingReviews(
  value: unknown,
  cores: readonly StoredStoryConflictCore[],
): ConflictCoreGroundingReview[] {
  const message = '模型没有完成冲突核心的事实核对，请重试。'
  return parseCompleteReviewSet(
    value,
    cores,
    (reviewValue, reviewMessage) => {
      const record = expectRecord(reviewValue, reviewMessage, invalidModelOutputContext)
      return {
        conflictCoreId: readText(record, 'conflictCoreId', reviewMessage, 64, invalidModelOutputContext),
        unestablishedClaims: readRequiredTextList(
          record,
          'unestablishedClaims',
          0,
          8,
          180,
          reviewMessage,
          invalidModelOutputContext,
        ),
      }
    },
    (review) => review.conflictCoreId,
    message,
  )
}

function parseHeadTailGoalReviews(
  value: unknown,
  options: StoryHeadTailOptions,
): HeadTailGoalReview[] {
  const message = '模型没有完成完整的故事两端目标检查，请重试。'
  return parseCompleteReviewSet(
    value,
    options,
    parseHeadTailGoalReview,
    (review) => review.optionId,
    message,
  )
}

function parseHeadTailGoalReview(value: unknown, message: string): HeadTailGoalReview {
  const record = expectRecord(value, message, invalidModelOutputContext)
  return {
    optionId: readText(record, 'optionId', message, 64, invalidModelOutputContext),
    keepsConfirmedGoal: readBoolean(record, 'keepsConfirmedGoal', message, invalidModelOutputContext),
    followsSelectedApproach: readBoolean(record, 'followsSelectedApproach', message, invalidModelOutputContext),
    climaxIsProtagonistAction: readBoolean(record, 'climaxIsProtagonistAction', message, invalidModelOutputContext),
    resolutionFulfillsPlan: readBoolean(record, 'resolutionFulfillsPlan', message, invalidModelOutputContext),
    transitionIsGrounded: readBoolean(record, 'transitionIsGrounded', message, invalidModelOutputContext),
  }
}

function parseStoryTurnGroundingReview(
  record: Record<string, unknown>,
  turn: StoryTurn,
): StoryTurnGroundingReview {
  const message = '模型没有完成当前回合的状态连续性检查，请重试。'
  const situationIsGrounded = readBoolean(record, 'situationIsGrounded', message, invalidModelOutputContext)
  const conclusionFulfillsHeadTail = readNullableBoolean(
    record,
    'conclusionFulfillsHeadTail',
    message,
    invalidModelOutputContext,
  )
  const optionValues = record.optionReviews
  const expectedOptions = turn.isConclusion ? [] : turn.options
  const optionReviews = parseCompleteReviewSet(
    optionValues,
    expectedOptions,
    (value, reviewMessage) => parseStoryTurnOptionGroundingReview(value, reviewMessage),
    (review) => review.optionId,
    message,
  )

  assertGroundingReviewMatchesTurn(turn, conclusionFulfillsHeadTail, optionReviews, message)

  return { situationIsGrounded, conclusionFulfillsHeadTail, optionReviews }
}

function assertGroundingReviewMatchesTurn(
  turn: StoryTurn,
  conclusionFulfillsHeadTail: boolean | null,
  optionReviews: StoryTurnOptionGroundingReview[],
  message: string,
) {
  const hasExpectedConclusionReview = turn.isConclusion
    && optionReviews.length === 0
    && conclusionFulfillsHeadTail !== null
  const hasExpectedOngoingReview = !turn.isConclusion
    && conclusionFulfillsHeadTail === null

  if (!hasExpectedConclusionReview && !hasExpectedOngoingReview) {
    throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
  }
}

function parseStoryTurnOptionGroundingReview(
  value: unknown,
  message: string,
): StoryTurnOptionGroundingReview {
  const record = expectRecord(value, message, invalidModelOutputContext)
  return {
    optionId: readText(record, 'optionId', message, 64, invalidModelOutputContext),
    isGrounded: readBoolean(record, 'isGrounded', message, invalidModelOutputContext),
    detail: readText(record, 'detail', message, 120, invalidModelOutputContext),
  }
}

function parseCompleteReviewSet<TCandidate extends { id: string }, TReview>(
  value: unknown,
  candidates: readonly TCandidate[],
  parseReview: (value: unknown, message: string) => TReview,
  getReviewId: (review: TReview) => string,
  message: string,
): TReview[] {
  const reviewValues = expectListOfLength(value, candidates.length, message, invalidModelOutputContext)
  const reviews = reviewValues.map((reviewValue) => parseReview(reviewValue, message))

  ensureReviewSetMatchesCandidates(reviews, candidates, getReviewId, message)
  return reviews
}

function requireReviewForCandidate<T>(
  reviewsById: Map<string, T>,
  candidateId: string,
  message: string,
  code: string,
): T {
  const review = reviewsById.get(candidateId)
  if (!review) {
    throw new AppError(message, invalidModelOutputContext.statusCode, code)
  }

  return review
}

function ensureReviewSetMatchesCandidates<T extends { id: string }, TReview>(
  reviews: TReview[],
  candidates: readonly T[],
  getReviewId: (review: TReview) => string,
  message: string,
) {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id))
  const reviewIds = reviews.map(getReviewId)

  ensureUniqueValues(reviewIds, message, invalidModelOutputContext)
  if (reviewIds.some((reviewId) => !candidateIds.has(reviewId))) {
    throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
  }
}

function parseModelStoryTurn(
  value: unknown,
  request: StoryTurnRequest,
  state: StoryNarrativeState,
  outputFormat: StoryTurnOutputFormat = 'detailed',
): StoryTurn {
  const record = getStoryTurnRecord(value)
  const turnId = `turn-${request.history.length + 1}`
  const isConclusion = request.mode === 'conclude'
  const message = getStoryTurnValidationMessage(isConclusion)
  const node = parseModelStoryTurnNode(record.node, turnId, isConclusion, request.history.length)
  const conclusionPayload = parseConclusionPayload(record, isConclusion, turnId, outputFormat)
  const turn: StoryTurn = {
    id: turnId,
    phase: getStoryTurnPhaseForRequest(request),
    node,
    conflict: parseModelStoryTurnConflict(record.conflict, node.id, isConclusion),
    question: parseModelStoryTurnQuestion(record.question, isConclusion),
    options: parseStoryTurnOptions(
      record.options,
      isConclusion,
      (index) => `${turnId}-option-${index + 1}`,
      (index) => `${turnId}-option-${index + 1}-action`,
      outputFormat,
    ),
    ...conclusionPayload,
    canConclude: canConcludeAfterCurrentTurn(request),
    isConclusion,
  }

  validateStoryTurnShape(turn, invalidModelOutputContext, message)
  validateStoryTurnStateTransition(turn, state, message)
  return turn
}

function getStoryTurnRecord(value: unknown): Record<string, unknown> {
  const message = '回合 JSON 缺少 turn 对象。'
  const record = expectRecord(value, message, invalidModelOutputContext)

  // json_object models occasionally omit this otherwise redundant wrapper.
  // Accept the direct shape only when it unmistakably contains a turn body.
  if (isPlainRecord(record.turn)) return record.turn
  if (isPlainRecord(record.node) || isPlainRecord(record.conflict) || Array.isArray(record.options)) return record

  throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
}

function getStoryTurnValidationMessage(isConclusion: boolean): string {
  return isConclusion
    ? '收束回合缺少完整的当前情境。'
    : '继续回合缺少完整的当前情境。'
}

function parseModelStoryTurnNode(
  value: unknown,
  turnId: string,
  isConclusion: boolean,
  historyLength: number,
): StoryNode {
  const message = isConclusion
    ? '收束回合缺少 node，或 node 字段不完整。'
    : '继续回合缺少 node，或 node 字段不完整。'
  return parseStoryNode(
    value,
    invalidModelOutputContext,
    message,
    `node-${turnId.slice('turn-'.length)}`,
    getStoryTurnGoalState(isConclusion, historyLength),
  )
}

function getStoryTurnGoalState(
  isConclusion: boolean,
  historyLength: number,
): StoryGoalState {
  if (isConclusion) return 'resolved'
  return historyLength >= minimumConfirmedTurnsBeforeConclusion - 1 ? 'near-completion' : 'trying'
}

function parseModelStoryTurnQuestion(value: unknown, isConclusion: boolean): string | null {
  if (isConclusion) {
    if (value === null || value === undefined || value === '') return null
    throw new AppError('收束回合的 question 必须为 null。', invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
  }

  if (typeof value !== 'string' || !value.trim() || value.trim().length > 140) {
    throw new AppError('继续回合缺少非空 question。', invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
  }
  return value.trim()
}

function parseConclusionPayload(
  record: Record<string, unknown>,
  isConclusion: boolean,
  turnId: string,
  outputFormat: StoryTurnOutputFormat,
): Pick<StoryTurn, 'narrativeAction' | 'transition'> {
  if (!isConclusion) {
    if (outputFormat === 'detailed') {
      requireNullOrMissing(record.narrativeAction, '继续回合不能包含顶层 narrativeAction。')
      requireNullOrMissing(record.transition, '继续回合不能包含顶层 transition。')
    }
    return { narrativeAction: null, transition: null }
  }

  if (outputFormat === 'compact') {
    return createImplicitConclusionPayload(record, turnId)
  }

  if (!isPlainRecord(record.narrativeAction)) {
    throw new AppError('收束回合缺少顶层 narrativeAction。', invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
  }
  if (!isPlainRecord(record.transition)) {
    throw new AppError('收束回合缺少顶层 transition。', invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
  }

  const narrativeAction = parseStoryAction(
    record.narrativeAction,
    invalidModelOutputContext,
    '收束回合的 narrativeAction 字段不完整。',
    'generated',
    `${turnId}-resolution-action`,
  )
  return {
    narrativeAction,
    transition: parseStoryTransition(
      record.transition,
      invalidModelOutputContext,
      '收束回合的 transition 字段不完整。',
      narrativeAction.id,
    ),
  }
}

function createImplicitConclusionPayload(
  record: Record<string, unknown>,
  turnId: string,
): Pick<StoryTurn, 'narrativeAction' | 'transition'> {
  const conflict = expectRecord(record.conflict, '收束回合缺少 conflict，或 conflict 字段不完整。', invalidModelOutputContext)
  const intent = readText(
    conflict,
    'action',
    '收束回合的 conflict.action 必须说明主角实际完成的结尾行动。',
    140,
    invalidModelOutputContext,
  )
  const narrativeAction: StoryAction = {
    id: `${turnId}-resolution-action`,
    intent,
    preconditions: [],
    effects: [],
    source: 'generated',
  }
  return {
    narrativeAction,
    transition: {
      actionId: narrativeAction.id,
      consumedFacts: [],
      changedFacts: [],
      introducedFacts: [],
    },
  }
}

function validateStoryTurnStateTransition(
  turn: StoryTurn,
  state: StoryNarrativeState,
  message: string,
) {
  if (isConclusionWithGeneratedAction(turn)) {
    narrativeState.validateActionTransition(
      state,
      turn.narrativeAction,
      turn.transition,
      invalidModelOutputContext,
      message,
    )
    return
  }

  for (const option of turn.options) {
    narrativeState.validateTurnOption(state, option, invalidModelOutputContext, message)
  }
}

function getStoryTurnPhaseForRequest(request: StoryTurnRequest): StoryTurnPhase {
  if (request.mode === 'start') return getStoryTurnPhaseForHistoryIndex(0)
  if (request.mode === 'conclude') return 'resolution'
  return getStoryTurnPhaseForHistoryIndex(request.history.length)
}

function getStoryTurnPhaseForHistoryIndex(index: number): StoryTurnPhase {
  if (index === 0) return 'opening'
  if (index === 1) return 'development'
  if (index === 2) return 'turn'
  return 'climax'
}

function canConcludeAfterCurrentTurn(request: StoryTurnRequest): boolean {
  return request.mode === 'continue'
    && request.history.length >= minimumConfirmedTurnsBeforeConclusion - 1
}

function parseModelStoryTurnConflict(value: unknown, nodeId: string, isConclusion: boolean): StoryConflict {
  const message = getStoryTurnConflictMessage(isConclusion)
  const record = expectRecord(value, message, invalidModelOutputContext)
  return {
    nodeId,
    conflict: readText(record, 'conflict', message, 140, invalidModelOutputContext),
    action: readText(record, 'action', message, 140, invalidModelOutputContext),
    consequence: readText(record, 'consequence', message, 140, invalidModelOutputContext),
    intensity: readOptionalStoryTurnIntensity(record.intensity),
    anchor: readOptionalStoryTurnAnchor(record.anchor, isConclusion),
  }
}

function readOptionalStoryTurnIntensity(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5) return value
  return 1
}

function readOptionalStoryTurnAnchor(value: unknown, isConclusion: boolean): string {
  if (typeof value === 'string' && value.trim() && value.trim().length <= 32) return value.trim()
  return isConclusion ? '结局' : '推进'
}

function getStoryTurnConflictMessage(isConclusion: boolean): string {
  return isConclusion
    ? '收束回合缺少 conflict，或 conflict 字段不完整。'
    : '继续回合缺少 conflict，或 conflict 字段不完整。'
}

function parseStoryTurnOptions(
  value: unknown,
  isConclusion: boolean,
  getGeneratedId?: (index: number) => string,
  getGeneratedActionId?: (index: number) => string,
  outputFormat: StoryTurnOutputFormat = 'detailed',
): StoryTurnOption[] {
  const message = isConclusion
    ? '收束回合的 options 必须为空数组。'
    : '继续回合必须有恰好三个完整选项。'
  if (!Array.isArray(value)) {
    throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
  }

  if (isConclusion) {
    if (value.length !== 0) {
      throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
    }
    return []
  }
  if (value.length !== generatedOptionCount) {
    throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
  }

  return value.map((option, index) => parseStoryTurnOption(
    option,
    invalidModelOutputContext,
    message,
    getGeneratedId?.(index),
    getGeneratedActionId?.(index),
    outputFormat,
  ))
}

function parseStoryTurnOption(
  value: unknown,
  context: ValidationErrorContext,
  message: string,
  generatedId?: string,
  generatedActionId?: string,
  outputFormat: StoryTurnOutputFormat = 'detailed',
): StoryTurnOption {
  const record = expectRecord(value, message, context)
  const id = generatedId ?? readText(record, 'id', message, 56, context)
  if (outputFormat === 'compact') {
    return createImplicitStoryTurnOption(record, context, message, id, generatedActionId ?? `${id}-action`)
  }

  const narrativeAction = parseStoryAction(
    record.narrativeAction,
    context,
    message,
    'generated',
    generatedActionId ?? `${id}-action`,
  )
  return {
    id,
    label: readText(record, 'label', message, 32, context),
    action: readText(record, 'action', message, 120, context),
    immediateConsequence: readText(record, 'immediateConsequence', message, 120, context),
    laterEffect: readText(record, 'laterEffect', message, 120, context),
    narrativeAction,
    transition: parseStoryTransition(record.transition, context, message, narrativeAction.id),
  }
}

function parseRefinedStoryTurnOption(
  value: unknown,
  request: StoryTurnOptionRefinementGenerationRequest,
  state: StoryNarrativeState,
): StoryTurnOption {
  const record = expectRecord(value, '修改后的选择格式不完整。', invalidModelOutputContext)
  const optionRecord = isPlainRecord(record.option) ? record.option : record
  const option = parseStoryTurnOption(
    optionRecord,
    invalidModelOutputContext,
    '修改后的选择字段不完整。',
    request.originalOption.id,
    request.originalOption.narrativeAction.id,
    'compact',
  )

  if (hasSameReaderFacingStoryTurnOption(option, request.originalOption)) {
    throw new AppError('修改后的选择没有发生可见变化。', invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
  }

  narrativeState.validateTurnOption(
    state,
    option,
    invalidModelOutputContext,
    '修改后的选择不满足当前故事状态。',
  )
  return option
}

function hasSameReaderFacingStoryTurnOption(left: StoryTurnOption, right: StoryTurnOption): boolean {
  return left.label === right.label
    && left.action === right.action
    && left.immediateConsequence === right.immediateConsequence
    && left.laterEffect === right.laterEffect
}

function createImplicitStoryTurnOption(
  record: Record<string, unknown>,
  context: ValidationErrorContext,
  message: string,
  id: string,
  actionId: string,
): StoryTurnOption {
  const action = readText(record, 'action', message, 120, context)
  const narrativeAction: StoryAction = {
    id: actionId,
    intent: action,
    preconditions: [],
    effects: [],
    source: 'generated',
  }
  return {
    id,
    label: readText(record, 'label', message, 32, context),
    action,
    immediateConsequence: readText(record, 'immediateConsequence', message, 120, context),
    laterEffect: readText(record, 'laterEffect', message, 120, context),
    narrativeAction,
    transition: {
      actionId,
      consumedFacts: [],
      changedFacts: [],
      introducedFacts: [],
    },
  }
}

function validateStoryTurnShape(
  turn: StoryTurn,
  context: ValidationErrorContext,
  message: string,
) {
  if (turn.conflict.nodeId !== turn.node.id) {
    throwTurnValidationError(context, message, '当前情境中的 conflict 必须对应同一个 node。')
  }

  if (turn.isConclusion) {
    validateConclusionStoryTurnShape(turn, context, message)
    return
  }

  validateOngoingStoryTurnShape(turn, context, message)
}

function validateConclusionStoryTurnShape(
  turn: StoryTurn,
  context: ValidationErrorContext,
  message: string,
) {
  const hasInvalidShape = turn.phase !== 'resolution'
    || turn.node.goalState !== 'resolved'
    || turn.question !== null
    || turn.options.length !== 0
    || !turn.narrativeAction
    || !turn.transition
    || turn.canConclude

  if (hasInvalidShape) {
    throwTurnValidationError(context, message, '收束回合必须给出已解决的局面，question 为 null，且不再提供选项。')
  }
}

function validateOngoingStoryTurnShape(
  turn: StoryTurn,
  context: ValidationErrorContext,
  message: string,
) {
  if (turn.phase === 'resolution' || turn.node.goalState === 'resolved') {
    throwTurnValidationError(context, message, '继续回合不能提前给出已解决的结局。')
  }

  const hasInvalidShape = !turn.question
    || turn.options.length !== generatedOptionCount
    || turn.narrativeAction !== null
    || turn.transition !== null
  if (hasInvalidShape) {
    throwTurnValidationError(context, message, '继续回合必须包含一个问题和恰好三个行动选项。')
  }
}

function throwTurnValidationError(
  context: ValidationErrorContext,
  requestMessage: string,
  modelMessage: string,
): never {
  const message = context === invalidModelOutputContext ? modelMessage : requestMessage
  throw new AppError(message, context.statusCode, context.code)
}

function parseHeadTailOption(
  value: unknown,
  context: ValidationErrorContext,
  generatedId?: string,
): StoryHeadTailOption {
  const message = '头尾方案格式不正确，请重试。'
  const record = expectRecord(value, message, context)
  return {
    id: generatedId ?? readText(record, 'id', message, 40, context),
    opening: readText(record, 'opening', message, 180, context),
    openingClue: readText(record, 'openingClue', message, 120, context),
    climax: readText(record, 'climax', message, 180, context),
    resolution: readText(record, 'resolution', message, 180, context),
    cost: readText(record, 'cost', message, 140, context),
    promise: readText(record, 'promise', message, 100, context),
    climaxActionId: readIdentifier(record, 'climaxActionId', message, context),
    transition: parseStoryTransition(record.transition, context, message),
  }
}

function parseStoryNode(
  value: unknown,
  context: ValidationErrorContext,
  message: string,
  generatedId?: string,
  defaultGoalState?: StoryGoalState,
): StoryNode {
  const record = expectRecord(value, message, context)
  const goalState = defaultGoalState ?? readStoryGoalState(record.goalState, message, context)
  return {
    id: generatedId ?? readText(record, 'id', message, 40, context),
    title: readText(record, 'title', message, 32, context),
    event: readText(record, 'event', message, 180, context),
    purpose: readText(record, 'purpose', message, 120, context),
    goalState,
  }
}

function parseStoryConflict(
  value: unknown,
  context: ValidationErrorContext,
  message = '冲突格式不正确，请重试。',
): StoryConflict {
  const record = expectRecord(value, message, context)
  return {
    nodeId: readText(record, 'nodeId', message, 40, context),
    conflict: readText(record, 'conflict', message, 140, context),
    action: readText(record, 'action', message, 140, context),
    consequence: readText(record, 'consequence', message, 140, context),
    intensity: readInteger(record, 'intensity', message, 1, 5, context),
    anchor: readText(record, 'anchor', message, 32, context),
  }
}

function ensureUniqueValues(values: string[], message: string, context: ValidationErrorContext) {
  if (new Set(values).size !== values.length) {
    throw new AppError(message, context.statusCode, context.code)
  }
}

function parseGeneratedStory(record: Record<string, unknown>): GeneratedStory {
  const body = readText(record, 'body', '模型没有返回故事正文，请重试。', 12_000, invalidModelOutputContext)

  return {
    title: readOptionalGeneratedText(record.title, 50) ?? '未命名故事',
    logline: readOptionalGeneratedText(record.logline, 220) ?? '根据你确认的故事路径写成。',
    body,
    outline: parseOptionalStoryOutline(record.outline),
    review: parseOptionalStoryReview(record.review),
  }
}

function parseStoryBodyConsistencyReview(
  record: Record<string, unknown>,
  confirmedPath: ConfirmedStoryPathItem[],
): StoryBodyConsistencyReview {
  const message = '模型没有完成完整故事的一致性检查，请重试。'
  const isConsistent = readBoolean(record, 'isConsistent', message, invalidModelOutputContext)
  const issueValues = record.issues
  if (!Array.isArray(issueValues) || issueValues.length > 8) {
    throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
  }

  const allowedPathIds = new Set([...confirmedPath.map((item) => item.id), 'body'])
  const issues = issueValues.map((value) => {
    const issue = expectRecord(value, message, invalidModelOutputContext)
    const kind = readStoryBodyConsistencyIssueKind(issue.kind, message)
    const pathId = readText(issue, 'pathId', message, 32, invalidModelOutputContext)
    if (!allowedPathIds.has(pathId)) {
      throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
    }

    return {
      kind,
      pathId,
      detail: readText(issue, 'detail', message, 220, invalidModelOutputContext),
    }
  })

  if (isConsistent !== (issues.length === 0)) {
    throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
  }

  return { isConsistent, issues }
}

function readStoryBodyConsistencyIssueKind(
  value: unknown,
  message: string,
): StoryBodyConsistencyIssueKind {
  if (value === 'missing-path-item' || value === 'contradiction' || value === 'unsupported-critical-detail') {
    return value
  }

  throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
}

function parseOptionalStoryOutline(value: unknown): StoryBeat[] {
  if (!Array.isArray(value)) return createFallbackStoryOutline()

  const outline = value.slice(0, 8).flatMap((item) => {
    if (!isPlainRecord(item)) return []

    const label = readOptionalGeneratedText(item.label, 32)
    const detail = readOptionalGeneratedText(item.detail, 240)
    return label && detail ? [{ label, detail }] : []
  })

  return outline.length ? outline : createFallbackStoryOutline()
}

function parseOptionalStoryReview(value: unknown): StoryReviewItem[] {
  if (!Array.isArray(value)) return createFallbackStoryReview()

  const review = value.slice(0, 8).flatMap((item) => {
    if (!isPlainRecord(item) || (item.tone !== 'pass' && item.tone !== 'warn')) return []

    const label = readOptionalGeneratedText(item.label, 48)
    const summary = readOptionalGeneratedText(item.value, 80)
    const detail = readOptionalGeneratedText(item.detail, 260)
    return label && summary && detail
      ? [{ label, value: summary, detail, tone: item.tone as StoryReviewItem['tone'] }]
      : []
  })

  return review.length ? review : createFallbackStoryReview()
}

function createFallbackStoryOutline(): StoryBeat[] {
  return [{
    label: '已确认的路径',
    detail: '故事正文已按当前确认的情境、行动和结局写成。',
  }]
}

function createFallbackStoryReview(): StoryReviewItem[] {
  return [{
    label: '故事正文',
    value: '已生成',
    detail: '可以从当前路径继续阅读，并返回前面的选择进行修改。',
    tone: 'pass',
  }]
}

function readOptionalGeneratedText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined

  const text = value.trim()
  return text && text.length <= maximumLength ? text : undefined
}

function expectRecord(value: unknown, message: string, context: ValidationErrorContext): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError(message, context.statusCode, context.code)
  }

  return value as Record<string, unknown>
}

function readText(
  record: Record<string, unknown>,
  field: string,
  message: string,
  maximumLength: number,
  context: ValidationErrorContext,
): string {
  const value = record[field]
  if (typeof value !== 'string') throw new AppError(message, context.statusCode, context.code)

  const text = value.trim()
  if (!text || text.length > maximumLength) throw new AppError(message, context.statusCode, context.code)

  return text
}

function readNullableText(
  record: Record<string, unknown>,
  field: string,
  message: string,
  maximumLength: number,
  context: ValidationErrorContext,
): string | null {
  const value = record[field]
  if (value === null) return null
  if (typeof value !== 'string') throw new AppError(message, context.statusCode, context.code)

  const text = value.trim()
  if (!text || text.length > maximumLength) throw new AppError(message, context.statusCode, context.code)
  return text
}

function readStoryExpansionScope(value: unknown): StoryExpansionScope | undefined {
  if (value === undefined || value === null) return undefined
  if (value === 'keep-scale' || value === 'grounded-obstacle' || value === 'larger-story' || value === 'genre-led') {
    return value
  }

  throw new AppError('扩展方式不正确，请重新选择。', invalidRequestContext.statusCode, invalidRequestContext.code)
}

function readStoryWorldMode(
  value: unknown,
  message: string,
  context: ValidationErrorContext,
): StorySeed['worldMode'] {
  if (value === 'realistic-default' || value === 'user-specified') return value
  throw new AppError(message, context.statusCode, context.code)
}

function readStoryVariationAxis(
  value: unknown,
  message: string,
  context: ValidationErrorContext,
): StoryVariationAxis {
  if (value === 'time' || value === 'resource' || value === 'relationship' || value === 'commitment') return value
  throw new AppError(message, context.statusCode, context.code)
}

function readConflictCoreGoalForm(value: unknown, message: string): ConflictCoreGoalForm {
  if (value === 'explicit-goal' || value === 'action' || value === 'decision' || value === 'event-or-state') return value
  throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
}

function readConflictCoreMechanismType(value: unknown, message: string): ConflictCoreMechanismType {
  if (typeof value === 'string' && conflictCoreMechanismTypes.includes(value as ConflictCoreMechanismType)) {
    return value as ConflictCoreMechanismType
  }

  throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
}

function readConflictCoreVariationAxis(
  value: unknown,
  mechanismType: ConflictCoreMechanismType,
  message: string,
): StoryVariationAxis {
  if (value === 'time' || value === 'resource' || value === 'relationship' || value === 'commitment') {
    return value
  }

  // The model occasionally repeats mechanismType in this legacy display field.
  // The mapping preserves the generated mechanism while keeping the public schema stable.
  if (value === mechanismType) return conflictCoreMechanismVariationAxis[mechanismType]

  throw new AppError(message, invalidModelOutputContext.statusCode, invalidModelOutputContext.code)
}

function readStoryFactMutability(
  value: unknown,
  message: string,
  context: ValidationErrorContext,
): StoryFactMutability {
  if (value === 'fixed' || value === 'changeable' || value === 'unknown') return value
  throw new AppError(message, context.statusCode, context.code)
}

function readStoryTurnMode(
  value: unknown,
  message: string,
  context: ValidationErrorContext,
): StoryTurnMode {
  if (value === 'start' || value === 'continue' || value === 'conclude') return value
  throw new AppError(message, context.statusCode, context.code)
}

function readStoryTurnOptionRefinementFocus(value: unknown): StoryTurnOptionRefinementFocus {
  if (isStoryTurnOptionRefinementFocus(value)) return value
  throw new AppError('调整重点不正确，请重新选择。', invalidRequestContext.statusCode, invalidRequestContext.code)
}

function isStoryTurnOptionRefinementFocus(value: unknown): value is StoryTurnOptionRefinementFocus {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(storyTurnOptionRefinementFocusLabels, value)
}

function getStoryTurnOptionRefinementFocusLabel(focus: StoryTurnOptionRefinementFocus): string {
  return storyTurnOptionRefinementFocusLabels[focus]
}

function readStoryTurnPhase(
  value: unknown,
  message: string,
  context: ValidationErrorContext,
): StoryTurnPhase {
  if (value === 'opening' || value === 'development' || value === 'turn' || value === 'climax' || value === 'resolution') return value
  throw new AppError(message, context.statusCode, context.code)
}

function readStoryGoalState(
  value: unknown,
  message: string,
  context: ValidationErrorContext,
): StoryGoalState {
  if (value === 'trying' || value === 'blocked' || value === 'changed-plan' || value === 'near-completion' || value === 'resolved') {
    return value
  }

  throw new AppError(message, context.statusCode, context.code)
}

function readBoolean(
  record: Record<string, unknown>,
  field: string,
  message: string,
  context: ValidationErrorContext,
): boolean {
  const value = record[field]
  if (typeof value !== 'boolean') {
    throw new AppError(message, context.statusCode, context.code)
  }

  return value
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  field: string,
  message: string,
  context: ValidationErrorContext,
): boolean | undefined {
  const value = record[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw new AppError(message, context.statusCode, context.code)
  }

  return value
}

function readNullableBoolean(
  record: Record<string, unknown>,
  field: string,
  message: string,
  context: ValidationErrorContext,
): boolean | null {
  const value = record[field]
  if (value === null) return null
  if (typeof value !== 'boolean') {
    throw new AppError(message, context.statusCode, context.code)
  }

  return value
}

function readInteger(
  record: Record<string, unknown>,
  field: string,
  message: string,
  minimum: number,
  maximum: number,
  context: ValidationErrorContext,
): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new AppError(message, context.statusCode, context.code)
  }

  return value
}

function readIdentifier(
  record: Record<string, unknown>,
  field: string,
  message: string,
  context: ValidationErrorContext,
): string {
  const identifier = readText(record, field, message, 64, context)
  if (!/^[a-z][a-z0-9-]*$/i.test(identifier)) {
    throw new AppError(message, context.statusCode, context.code)
  }
  return identifier
}

function readOptionalIdentifier(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new AppError('请求内容不正确。', 400, 'INVALID_REQUEST')
  const identifier = value.trim()
  if (!identifier || identifier.length > 64 || !/^[a-z][a-z0-9-]*$/i.test(identifier)) {
    throw new AppError('请求内容不正确。', 400, 'INVALID_REQUEST')
  }
  return identifier
}

function readIdentifierList(
  record: Record<string, unknown>,
  field: string,
  minimumItems: number,
  maximumItems: number,
  message: string,
  context: ValidationErrorContext,
): string[] {
  const value = record[field]
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) {
    throw new AppError(message, context.statusCode, context.code)
  }

  const identifiers = value.map((item) => {
    if (typeof item !== 'string') throw new AppError(message, context.statusCode, context.code)
    const identifier = item.trim()
    if (!identifier || identifier.length > 64 || !/^[a-z][a-z0-9-]*$/i.test(identifier)) {
      throw new AppError(message, context.statusCode, context.code)
    }
    return identifier
  })

  ensureUniqueValues(identifiers, message, context)
  return identifiers
}

function readNonNegativeInteger(
  record: Record<string, unknown>,
  field: string,
  message: string,
  context: ValidationErrorContext,
): number {
  return readInteger(record, field, message, 0, Number.MAX_SAFE_INTEGER, context)
}

function readOptionalNonNegativeInteger(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new AppError('请求内容不正确。', 400, 'INVALID_REQUEST')
  }
  return value
}

function readRequiredTextList(
  record: Record<string, unknown>,
  field: string,
  minimumItems: number,
  maximumItems: number,
  maximumLength: number,
  message: string,
  context: ValidationErrorContext,
): string[] {
  const value = record[field]
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) {
    throw new AppError(message, context.statusCode, context.code)
  }

  const values = value.map((item) => {
    if (typeof item !== 'string') throw new AppError(message, context.statusCode, context.code)
    const text = item.trim()
    if (!text || text.length > maximumLength) throw new AppError(message, context.statusCode, context.code)
    return text
  })

  ensureUniqueValues(values, message, context)
  return values
}

function readOptionalText(
  record: Record<string, unknown>,
  field: string,
  maximumLength: number,
  invalidMessage = '偏好内容不正确。',
  maximumMessage = '偏好内容过长，请缩短后重试。',
): string | undefined {
  const value = record[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new AppError(invalidMessage, 400, 'INVALID_REQUEST')

  const text = value.trim()
  if (!text) return undefined
  if (text.length > maximumLength) throw new AppError(maximumMessage, 400, 'INVALID_REQUEST')

  return text
}

function readTextList(record: Record<string, unknown>, field: string, maximumItems: number, maximumLength: number): string[] | undefined {
  const value = record[field]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > maximumItems || value.some((item) => typeof item !== 'string')) {
    throw new AppError('请求内容不正确。', 400, 'INVALID_REQUEST')
  }

  return value
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (item.length > maximumLength) throw new AppError('请求内容不正确。', 400, 'INVALID_REQUEST')
      return item
    })
}
