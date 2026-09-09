import { AppError, requestQwenJson } from './qwen.js'
import { createNarrativeStateMachine, type StoryValidationContext } from './storyState.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  GeneratedStory,
  StoryConflict,
  StoryFact,
  StoryFactMutability,
  StoryNarrativeState,
  StoryBeat,
  StoryExpansionScope,
  StoryGoalState,
  StoryPredicament,
  StoryPredicaments,
  StoryDirectionsRequest,
  StoryDirectionsResponse,
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

const maxPredicamentGenerationAttempts = 3
const maxHeadTailGenerationAttempts = 2
const maxStoryTurnGenerationAttempts = 3
const maxStoryGenerationAttempts = 3
const storyTurnMaxTokens = 2_800
const generatedOptionCount = 3
const minimumConfirmedTurnsBeforeConclusion = 3
const maximumConfirmedStoryTurns = 24
const maximumStoryFacts = 12
// Reserve one action beyond user-confirmed turns for the generated resolution.
const maximumStoryActions = maximumConfirmedStoryTurns + generatedOptionCount + 1
const maximumTransitionFactReferences = 8
const shouldReviewStoryTurnGrounding = process.env.STORY_TURN_GROUNDING_REVIEW?.trim().toLowerCase() === 'true'
const shouldReviewGeneratedStoryConsistency = process.env.STORY_BODY_CONSISTENCY_REVIEW?.trim().toLowerCase() !== 'false'

const narrativeState = createNarrativeStateMachine({
  maximumActions: maximumStoryActions,
  maximumFacts: maximumStoryFacts,
})

type StorySeedPart = 'lockedFacts' | 'lockedGoal' | 'goalContinuity' | 'scope' | 'stateContract'

interface PredicamentContractReview {
  predicamentId: string
  preservesLockedFacts: boolean
  preservesLockedGoal: boolean
  isOriginalGoalStillMainPlot: boolean
  staysWithinScope: boolean
  stateContractIsGrounded: boolean
}

interface PredicamentContractViolation {
  title: string
  missingParts: StorySeedPart[]
}

interface PredicamentRepairContext {
  violations: PredicamentContractViolation[]
}

interface SoftPredicamentFallback {
  directions: StoryPredicaments
  violations: PredicamentContractViolation[]
}

interface HeadTailGoalReview {
  optionId: string
  keepsConfirmedGoal: boolean
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
  directions: StoryPredicaments
  selectedPredicament?: StoryPredicament
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
}

interface StoryHeadTailRequest extends StoryFoundation {}

interface StoryTurnRequest extends StoryFoundation {
  headTail: StoryHeadTailOption
  mode: StoryTurnMode
  history: StoryTurnHistoryItem[]
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

const retryableStoryGenerationErrorCodes = new Set([
  'INVALID_MODEL_OUTPUT',
  'QWEN_EMPTY_RESPONSE',
  'QWEN_INVALID_JSON',
  'QWEN_INVALID_RESPONSE',
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

export function parseDirectionRequest(body: unknown): StoryDirectionsRequest {
  const record = parseRequestRecord(body, ['idea', 'expansionScope', 'preference', 'excludedTitles', 'storyId', 'revision'])
  const idea = readText(record, 'idea', '请先写下一个故事想法。', 60, invalidRequestContext)
  const expansionScope = readStoryExpansionScope(record.expansionScope)
  const preference = readOptionalText(record, 'preference', 120)
  const excludedTitles = readTextList(record, 'excludedTitles', 3, 80)
  const storyId = readOptionalIdentifier(record, 'storyId')
  const revision = readOptionalNonNegativeInteger(record, 'revision')

  return { idea, expansionScope, preference, excludedTitles, storyId, revision }
}

export function parseHeadTailSessionRequest(body: unknown): StoryHeadTailSessionRequest {
  const record = parseRequestRecord(body, ['storyId', 'revision', 'predicamentId'])
  return {
    ...parseStorySessionReference(record),
    predicamentId: readIdentifier(record, 'predicamentId', '请选择一个故事困境。', invalidRequestContext),
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

async function generateDirectionSet(
  request: StoryDirectionsRequest,
  existingSeed?: StorySeed,
): Promise<{ seed: StorySeed; directions: StoryPredicaments }> {
  const seed = existingSeed ?? await resolveStorySeed(request)
  let repairContext: PredicamentRepairContext | undefined
  let excludedTitles = request.excludedTitles ?? []
  let bestDirections: StoryPredicaments | undefined
  let bestViolations: PredicamentContractViolation[] | undefined

  for (let attempt = 0; attempt < maxPredicamentGenerationAttempts; attempt += 1) {
    const directions = await generatePredicamentSet({
      ...request,
      excludedTitles,
    }, seed, repairContext, attempt)
    let reviews: PredicamentContractReview[]
    try {
      reviews = await reviewPredicamentContract(request.idea, seed, request.expansionScope ?? 'keep-scale', directions)
    } catch (error) {
      console.warn(`Story direction review was unavailable; returning structurally valid directions: ${getErrorIdentifier(error)}`)
      return { seed, directions }
    }
    const violations = collectPredicamentContractViolations(seed, directions, reviews)

    if (!violations.length) return { seed, directions }

    // Preserve the closest batch only for a soft facts-review fallback. Goal
    // continuity and scope violations remain hard failures below.
    if (!bestViolations || violations.length < bestViolations.length) {
      bestDirections = directions
      bestViolations = violations
    }

    repairContext = { violations }
    excludedTitles = [...excludedTitles, ...directions.map((direction) => direction.title)]
  }

  const softFallback = getSoftPredicamentFallback(bestDirections, bestViolations)
  if (softFallback) {
    console.warn(
      `Story direction review remained conservative after ${maxPredicamentGenerationAttempts} attempts; returning the best batch with fact-only warnings (${softFallback.violations.length} flagged).`,
    )
    return { seed, directions: softFallback.directions }
  }

  throw new AppError('生成的故事困境偏离了你的核心目标，请稍后重试。', 502, 'DIRECTION_FIDELITY_FAILED')
}

export async function generateDirections(request: StoryDirectionsRequest): Promise<StoryDirectionsResponse> {
  if (request.storyId) {
    const session = getStorySession(request.storyId, request.revision)
    if (request.idea !== session.idea) {
      throw new AppError('故事想法已改变，请从第一步重新生成困境。', 409, 'STORY_SESSION_CONFLICT')
    }

    const result = await generateDirectionSet({
      ...request,
      idea: session.idea,
      expansionScope: session.seed.expansionScope,
    }, session.seed)
    assertStorySessionRevision(session, request.revision)
    replaceSessionDirections(session, result)
    return { storyId: session.id, revision: session.revision, ...result }
  }

  const { seed, directions } = await generateDirectionSet(request)
  const session = createStorySession(request.idea, seed, directions)
  storySessions.set(session.id, session)
  persistStorySessions()
  return { storyId: session.id, revision: session.revision, seed, directions }
}

async function resolveStorySeed(request: StoryDirectionsRequest): Promise<StorySeed> {
  const extractedSeed = await extractStorySeed(request.idea)
  return {
    ...extractedSeed,
    expansionScope: request.expansionScope ?? 'keep-scale',
  }
}

function getSoftPredicamentFallback(
  directions: StoryPredicaments | undefined,
  violations: PredicamentContractViolation[] | undefined,
): SoftPredicamentFallback | undefined {
  if (!directions || !violations?.every(hasOnlySoftPredicamentViolations)) return undefined
  return { directions, violations }
}

async function extractStorySeed(idea: string): Promise<StorySeedDraft> {
  const record = await requestModelRecord({
    systemPrompt: storySeedSystemPrompt,
    userPrompt: buildStorySeedPrompt(idea),
    temperature: 0.1,
    maxTokens: 560,
  }, '模型没有识别出原始念头中的锁定信息，请重试。')

  return parseStorySeedDraft(record.seed, invalidModelOutputContext)
}

async function generatePredicamentSet(
  request: StoryDirectionsRequest,
  seed: StorySeed,
  repairContext: PredicamentRepairContext | undefined,
  attempt: number,
): Promise<StoryPredicaments> {
  const record = await requestModelRecord({
    systemPrompt: predicamentSystemPrompt,
    userPrompt: buildPredicamentPrompt(request, seed, repairContext),
    temperature: attempt === 0 ? 0.72 : 0.64,
    maxTokens: 2_400,
  }, '模型没有返回可用的故事困境，请重试。')
  const values = expectGeneratedOptionItems(
    record.directions,
    '模型没有生成完整的三个故事困境，请重试。',
    'INVALID_DIRECTION_OUTPUT',
  )

  return parseGeneratedOptionTuple(values, parseModelPredicament)
}

async function reviewPredicamentContract(
  idea: string,
  seed: StorySeed,
  expansionScope: StoryExpansionScope,
  directions: StoryPredicaments,
): Promise<PredicamentContractReview[]> {
  const record = await requestModelRecord({
    systemPrompt: predicamentContractReviewSystemPrompt,
    userPrompt: buildPredicamentContractReviewPrompt(idea, seed, expansionScope, directions),
    temperature: 0.1,
    maxTokens: 850,
  }, '模型没有完成故事困境的忠实度检查，请重试。')

  return parsePredicamentContractReviews(record.reviews, directions)
}

function collectPredicamentContractViolations(
  seed: StorySeed,
  directions: StoryPredicaments,
  reviews: PredicamentContractReview[],
): PredicamentContractViolation[] {
  const reviewByDirectionId = new Map(reviews.map((review) => [review.predicamentId, review]))

  return directions.flatMap((direction) => {
    const review = requireReviewForCandidate(
      reviewByDirectionId,
      direction.id,
      '模型审查结果没有覆盖全部故事困境，请重试。',
      'INVALID_DIRECTION_REVIEW',
    )

    const missingParts = findMissingPredicamentContractParts(seed, review)
    return missingParts.length ? [{ title: direction.title, missingParts }] : []
  })
}

function findMissingPredicamentContractParts(
  seed: StorySeed,
  review: PredicamentContractReview,
): StorySeedPart[] {
  const missing: StorySeedPart[] = []
  if (!hasLockedFactsEvidence(review)) {
    missing.push('lockedFacts')
  }
  if (seed.lockedGoal && !hasGoalContinuityEvidence(review)) {
    missing.push('lockedGoal', 'goalContinuity')
  }
  if (!review.staysWithinScope) {
    missing.push('scope')
  }
  if (!review.stateContractIsGrounded) {
    missing.push('stateContract')
  }
  return missing
}

function hasGoalContinuityEvidence(review: PredicamentContractReview): boolean {
  return review.preservesLockedGoal
    && review.isOriginalGoalStillMainPlot
}

function hasLockedFactsEvidence(review: PredicamentContractReview): boolean {
  return review.preservesLockedFacts
}

function hasOnlySoftPredicamentViolations({ missingParts }: PredicamentContractViolation): boolean {
  return missingParts.length > 0 && missingParts.every((part) => part === 'lockedFacts')
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

function createNarrativeStateForRequest(request: StoryTurnRequest): StoryNarrativeState {
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
  const predicament = session.directions.find((direction) => direction.id === request.predicamentId)
  if (!predicament) {
    throw new AppError('所选故事困境已不在当前会话中，请重新选择。', 409, 'STORY_SESSION_CONFLICT')
  }

  const options = await generateHeadTailOptions({
    idea: session.idea,
    seed: session.seed,
    predicament,
  })
  assertStorySessionRevision(session, request.revision)
  replaceSessionHeadTailOptions(session, predicament, options)

  return { storyId: session.id, revision: session.revision, options }
}

export async function generateSessionStoryTurn(
  request: StoryTurnSessionRequest,
): Promise<StoryTurnResponse> {
  const session = getStorySession(request.storyId, request.revision)
  const { predicament, headTailOptions } = requireStoryTurnContext(session)
  return request.mode === 'start'
    ? startSessionStoryTurn(session, request, predicament, headTailOptions)
    : continueSessionStoryTurn(session, request, predicament)
}

function requireStoryTurnContext(session: StorySessionRecord): {
  predicament: StoryPredicament
  headTailOptions: StoryHeadTailOptions
} {
  if (!session.selectedPredicament || !session.headTailOptions) {
    throw new AppError('请先确认故事困境并生成故事两端。', 409, 'STORY_SESSION_CONFLICT')
  }

  return {
    predicament: session.selectedPredicament,
    headTailOptions: session.headTailOptions,
  }
}

async function startSessionStoryTurn(
  session: StorySessionRecord,
  request: StoryTurnSessionRequest,
  predicament: StoryPredicament,
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
  const { selectedPredicament: predicament, selectedHeadTail: headTail, currentTurn: conclusion } = session
  if (!predicament || !headTail || !conclusion?.isConclusion || !session.history.length) {
    throw new AppError('故事尚未形成完整的已确认路径，请继续推进。', 409, 'STORY_SESSION_CONFLICT')
  }

  const story = await generateStory({
    idea: session.idea,
    plan: {
      seed: session.seed,
      predicament,
      headTail,
      turnHistory: session.history,
      conclusion,
    },
  })
  assertStorySessionRevision(session, request.revision)
  return { storyId: session.id, revision: session.revision, story }
}

function createStorySession(idea: string, seed: StorySeed, directions: StoryPredicaments): StorySessionRecord {
  return {
    id: `story-${randomUUID()}`,
    idea,
    seed,
    directions,
    history: [],
    revision: 0,
    updatedAt: Date.now(),
  }
}

function replaceSessionDirections(
  session: StorySessionRecord,
  result: { seed: StorySeed; directions: StoryPredicaments },
) {
  session.seed = result.seed
  session.directions = result.directions
  session.selectedPredicament = undefined
  session.headTailOptions = undefined
  session.selectedHeadTail = undefined
  session.state = undefined
  session.history = []
  session.currentTurn = undefined
  commitStorySessionChanges(session)
}

function replaceSessionHeadTailOptions(
  session: StorySessionRecord,
  predicament: StoryPredicament,
  options: StoryHeadTailOptions,
) {
  session.selectedPredicament = predicament
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
    && Array.isArray(value.directions)
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
  return error instanceof AppError && retryableStoryGenerationErrorCodes.has(error.code)
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

const predicamentSystemPrompt = `你是一位擅长中文短篇故事的编辑。你的任务不是替用户补写完整人物小传，而是从一个念头中提出三种可以继续展开的故事困境。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输出内容使用简体中文。用户明确写出的事实和行动是不可替换的来源事实。未知信息只是空白，不是可以随意补写为永久人设、家族创伤、职业、病史或世界观的许可。

三条选项只能在”原始目标会遇到什么阻碍”上分化。每条都要让原始目标仍然是主线要完成、延后、主动放弃或重新确认的事情；不能只在开头提到它，随后改成另一件事。除非扩展尺度或用户偏好明确允许，不要擅自添加疾病、残障、死亡、遗弃、犯罪、升学命运、终身承诺、超自然规则、反乌托邦系统或重大人生创伤。

事实和行动构成可执行的状态契约：
1. facts 必须写入当前阻碍、限制、资源和已知结果，每条困境需要 2 到 6 个 facts
2. fixed 表示主角不能自行改写的事实（他人决定、既成事实、正式限制）
3. changeable 表示主角已有行动能直接改变的状态
4. unknown 表示尚未证实的信息，不能作为 action 的前置条件或效果
5. actions 需要 1 到 3 个，每个 action.preconditions 必须引用存在的、非 unknown 的 fact id
6. 每个 action.effects 只能引用存在的、mutability 为 changeable 的 fact id
7. 不得把绕过限制、破坏安全条件、取得未经建立的授权包装成可用行动

检查清单：生成每条困境后，务必确认 actions 中的所有 fact id 都在 facts 数组中存在，且 preconditions 引用的不是 unknown，effects 引用的是 changeable。`

const storySeedSystemPrompt = `你是一位严谨的中文故事编辑。请把用户已写出的念头整理成一份可跨步骤保留的故事种子。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输出内容使用简体中文。只能提取用户已经说出的信息，不能补写姓名以外的身份、年龄、职业、家庭关系、病史、过去经历或题材。lockedGoal 只在用户给出了明确想做、必须做、想去、想找、想说等具体行动时填写；否则返回 null。lockedFacts 只能保留 1 至 3 条不可替换的核心锚点，优先人物或关系、关键事件、明确目标或时间限制；不要把同一件事拆成重复碎片。unknowns 应列出仍未建立、后续不能作为关键因果依据的设定类别；它们不是禁止普通场景细节的清单。`

const predicamentContractReviewSystemPrompt = `你是一位严格的中文故事编辑审稿人。请核查每条故事困境是否真正围绕用户的原始念头，而不是仅保留几个名词后改写成另一条人生故事。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输出内容使用简体中文。请按语义判断，合理的同义改写仍算保留，不能把是否逐字复述当作标准。若删掉用户原始的具体行动或愿望后，这条困境仍然可以基本不变地成立，则 isOriginalGoalStillMainPlot 必须为 false。只要新增了未获允许的永久身份、重大创伤、病史、世界观或不可逆命运，staysWithinScope 必须为 false。stateContractIsGrounded 只有在 facts 完整保留当前限制、fixed/changeable 分类与实际控制权一致，且每个 action 都能由既有事实正当完成、不会无授权地撤销限制或制造结果时才能为 true。`

const headTailSystemPrompt = `你是一位擅长短篇故事结构的中文编辑。根据已经确认的故事基础，提出能驱动后续创作的开场、关键行动与结尾组合。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输出内容使用简体中文。开场是迫使故事开始的激励事件；高潮是主角必须亲自完成的关键行动；结尾是该行动带来的可验证结果，必须明确已确认主线目标如何完成、延后、主动放弃或重新确认，并回应开场线索。结尾不能只重复高潮行动，也不能只写“事情解决了”之类空泛判断。三个方案要在事件切入、关键行动、结局结果或代价上明显不同，但不得改变故事种子中的锁定事实和目标。

事实、行动和状态变更是故事契约：只能引用输入中存在的事实或行动 ID。fixed 事实不能被行动直接改写、绕过或抹掉，unknown 事实不能用作行动许可；任何状态改变都必须由对应 actionId 的已知前置事实和全部 effects 支撑。不要把限制、拒绝、损失、时间、资源归属、他人决定或既有关系凭空写成已经消失。`

const headTailGoalReviewSystemPrompt = `你是一位严格的中文故事编辑审稿人。请检查故事两端的开场、关键行动和结尾是否仍然围绕锁定目标展开。

必须严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。输出内容使用简体中文。请按语义判断，合理的同义改写仍算保留。请以锁定目标为准；若用户没有明确锁定目标，则以确认困境中的 preservedGoal 为主线目标。开场可以制造阻碍，但高潮必须是主角亲自完成的关键行动；结尾必须是该行动的直接结果，明确改变主线目标的结果并回应开场线索。若去掉主线目标后，开场、高潮和结尾仍然是同一个故事，keepsConfirmedGoal 必须为 false。transitionIsGrounded 只有在 transition 引用的行动、已知前置事实和状态变化都能在文本中成立，完整兑现 action.effects，且没有通过假定授权、未知信息或主角无权改变的方式撤销 fixed 限制时才能为 true。`

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
    "unknowns": ["仍未给出的设定类别，例如年龄、职业、家庭背景"]
  }
}`

const predicamentResponseSchema = `{
  "directions": [
    {
      "title": "不超过 12 个字、描述困境的标题",
      "variationAxis": "time、resource、relationship 或 commitment",
      "preservedGoal": "沿用原始目标的具体行动，不能替换成另一目标",
      "immediateSituation": "此刻开始发生的具体小情境；最多引入一项可撤销的临时假设",
      "obstacle": "这个目标当前遇到的直接阻碍",
      "urgency": "为什么现在需要处理",
      "choice": "主角为继续原始目标必须亲自做出的选择或行动",
      "plausibleCost": "该选择的有限、与当前阻碍直接相关的代价",
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
  ]
}

重要：
1. facts 必须有 2 到 6 个，每个 fact 的 id 格式为 "fact-1", "fact-2" 等
2. actions 必须有 1 到 3 个，每个 action 的 id 格式为 "action-1", "action-2" 等
3. action.preconditions 必须引用上面 facts 数组中存在的、非 unknown 的 fact id
4. action.effects 必须引用上面 facts 数组中存在的、mutability 为 changeable 的 fact id
5. 三条困境的 variationAxis 必须彼此不同`

const predicamentContractReviewRules = `逐条判断：
- preservesLockedFacts 只有在每一条核心 lockedFacts 在语义上仍然成立时才可为 true；允许使用不同措辞表达同一人物、事件、关系或限制。
- 当 lockedGoal 不为 null 时，preservesLockedGoal 只有在 preservedGoal 仍表示同一个行动时才可为 true；允许合理的同义改写。
- isOriginalGoalStillMainPlot 只有在 choice 明确服务于完成、延后、主动放弃或重新确认 lockedGoal 时才可为 true；不能只在开头提到原始目标，随后转为另一件事。
- staysWithinScope 必须严格遵守扩展尺度和未知信息预算；不允许用临时困难偷偷补写永久履历。
- stateContractIsGrounded 只有在 facts 明确包含眼前阻碍及其限制，并正确区分主角不能直接改变的 fixed 条件与可由已声明行动改变的 changeable 状态时才为 true；任何把未经建立的权限、外部决定、规则解除或安全状态当成主角可直接获得的行动或效果，都必须为 false。`

const predicamentContractReviewResponseSchema = `{
  "reviews": [
    {
      "predicamentId": "direction-1",
      "preservesLockedFacts": true,
      "preservesLockedGoal": true,
      "isOriginalGoalStillMainPlot": true,
      "staysWithinScope": true,
      "stateContractIsGrounded": true
    }
  ]
}`

function buildStorySeedPrompt(idea: string): string {
  return `用户的原始念头：
---
${idea}
---

请提取 1 到 3 条彼此独立的核心 lockedFacts。它们应覆盖最不可替换的信息，不要把同一个事件拆成多个近义短语。activeSituation 和 lockedGoal 要沿用用户关键措辞；worldMode 只有用户明确写出了非现实类型或规则时才是 user-specified。不要把 unknowns 填成虚构事实。严格使用以下 JSON 结构：
${storySeedResponseSchema}`
}

function buildPredicamentPrompt(
  request: StoryDirectionsRequest,
  seed: StorySeed,
  repairContext?: PredicamentRepairContext,
): string {
  return `用户的模糊想法：
---
${request.idea}
---

${formatStorySeed(seed)}

扩展尺度：${getExpansionScopeInstruction(request.expansionScope ?? 'keep-scale')}

原始念头是事实，不是可被重写的素材。未知信息保持为空；每条最多引入一项仅为当前阻碍服务、可以移除的临时情境假设。三条 variationAxis 必须彼此不同，并从 time、resource、relationship、commitment 中选择。除非用户选择“按题材展开”或原始念头已指定题材，三条不得通过改变时代、类型、人物身份或人生历史来制造差异。

facts 必须完整列出眼前阻碍、约束和可用资源。把主角无法自行撤销的外部决定、规则、时间、损失或安全条件标为 fixed；只有主角已具备合理能力直接改变的状态才能标为 changeable；unknown 不能被 action 当作前置条件或效果。actions 只能是当前事实已经支持的正当行动；effects 只能指向 changeable facts，不能用行动直接让 fixed 条件消失。

${buildPredicamentGenerationContext(request, repairContext)}

请生成恰好 3 条故事困境，并严格使用以下 JSON 结构：
${predicamentResponseSchema}`
}

function buildPredicamentGenerationContext(
  { preference, excludedTitles = [] }: StoryDirectionsRequest,
  repairContext: PredicamentRepairContext | undefined,
): string {
  const instructions = [
    preference ? `用户额外想要的感觉：${preference}` : '用户没有额外偏好，请给出彼此差异明显的三种可能。',
    excludedTitles.length ? `上一批已经出现过的标题：${excludedTitles.join('、')}。请避免重复这些困境。` : '',
    repairContext ? `上一批困境没有通过忠实度检查：\n${formatPredicamentRepairContext(repairContext)}\n重新生成时，三条都必须保留锁定目标和事实；不要只修补被点名的一条。` : '',
  ]

  return instructions.filter(Boolean).join('\n')
}

function buildPredicamentContractReviewPrompt(
  idea: string,
  seed: StorySeed,
  expansionScope: StoryExpansionScope,
  directions: StoryPredicaments,
): string {
  return `原始念头：
---
${idea}
---

${formatStorySeed(seed)}

扩展尺度：${getExpansionScopeInstruction(expansionScope)}

待审查的故事困境：
${JSON.stringify(directions)}

${predicamentContractReviewRules}

predicamentId 必须照抄输入，恰好审查全部三条。严格使用以下 JSON 结构：
${predicamentContractReviewResponseSchema}`
}

function formatStorySeed(seed: StorySeed): string {
  return `不可替换的故事种子：
- 主体：${seed.subject}
- 当前处境：${seed.activeSituation}
- 锁定目标：${seed.lockedGoal ?? '未明确给出具体行动'}
- 锁定事实：${seed.lockedFacts.map((fact) => `「${fact}」`).join('、')}
- 世界语境：${seed.worldMode === 'realistic-default' ? '默认当代现实' : '用户已明确指定'}
- 仍未知且不得作为关键因果依据：${seed.unknowns.join('、') || '未给出的背景信息'}；不影响选择与后果的临时场景细节可以自然补写。`
}

function buildStoryFoundationContext(
  idea: string,
  seed: StorySeed,
  predicament: StoryPredicament,
  predicamentLabel = '确认的故事困境',
): string {
  return `用户最初的想法：
---
${idea}
---

${formatStorySeed(seed)}

${predicamentLabel}：
${JSON.stringify(predicament)}`
}

function formatPredicamentRepairContext({ violations }: PredicamentRepairContext): string {
  return violations
    .map(({ title, missingParts }) => `《${title}》问题：${missingParts.map(getStorySeedPartLabel).join('、')}`)
    .join('\n')
}

function getStorySeedPartLabel(part: StorySeedPart): string {
  if (part === 'lockedFacts') return '锁定事实'
  if (part === 'lockedGoal') return '原始目标'
  if (part === 'scope') return '扩展尺度'
  if (part === 'stateContract') return '事实、行动与限制的状态契约'
  return '原始目标没有继续作为主线'
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
  { idea, seed, predicament }: StoryHeadTailRequest,
  repairContext?: HeadTailRepairContext,
): string {
  return `${buildStoryFoundationContext(idea, seed, predicament, '用户确认的故事困境')}

每个开场都要把主角推入这个具体困境；每个高潮都要由主角亲自完成；每个结尾都要作为高潮行动的直接结果，明确已确认主线目标如何变化并回应开场线索。不要补写故事种子中没有的永久履历或重大背景。${repairContext ? `\n上一轮的问题：${repairContext.violations.join('、')}。三条都必须修正。` : ''}

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
  { idea, seed, predicament }: StoryHeadTailRequest,
  options: StoryHeadTailOptions,
): string {
  return `${buildStoryFoundationContext(idea, seed, predicament, '用户确认的故事困境')}

待审查的头尾方案：
${JSON.stringify(options)}

逐条判断：keepsConfirmedGoal 只有在 opening、climax 和 resolution 都围绕主线目标时才能为 true；主线目标优先使用锁定目标，若其为空则使用确认困境的 preservedGoal。climaxIsProtagonistAction 只有在 climax 是主角亲自完成的关键行动时才能为 true；resolutionFulfillsPlan 只有在 resolution 是 climax 的直接结果，明确改变目标结果并回应 openingClue 时才能为 true。允许合理的同义改写，不要以是否逐字复述作为判断标准。

optionId 必须照抄输入，恰好审查全部三条。严格使用以下 JSON 结构：
{
  "reviews": [
    {
      "optionId": "head-tail-1",
      "keepsConfirmedGoal": true,
      "climaxIsProtagonistAction": true,
      "resolutionFulfillsPlan": true,
      "transitionIsGrounded": true
    }
  ]
}`
}

function buildStoryTurnPrompt(
  { idea, seed, predicament, headTail, history, mode }: StoryTurnRequest,
  state: StoryNarrativeState,
  repairMessage?: string,
  outputFormat: StoryTurnOutputFormat = 'detailed',
): string {
  const modeInstruction = getStoryTurnModeInstruction(mode, history.length)
  const responseSchema = getStoryTurnResponseSchema(mode, outputFormat)
  const responseChecklist = getStoryTurnResponseChecklist(mode, outputFormat)

  return `${buildStoryFoundationContext(idea, seed, predicament, '用户确认的故事困境')}

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
  { idea, seed, predicament, headTail, history, mode }: StoryTurnRequest,
  state: StoryNarrativeState,
  turn: StoryTurn,
): string {
  return `${buildStoryFoundationContext(idea, seed, predicament, '用户确认的故事困境')}

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
  return `${buildStoryFoundationContext(idea, plan.seed, plan.predicament, '用户逐步确认的故事困境')}

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
  return `${buildStoryFoundationContext(idea, plan.seed, plan.predicament, '用户逐步确认的故事困境')}

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

function parseModelPredicament(value: unknown, index: number): StoryPredicament {
  const message = '模型返回的故事困境不完整，请重试。'
  const record = expectRecord(value, message, invalidModelOutputContext)
  return parsePredicament(record, invalidModelOutputContext, message, `direction-${index + 1}`)
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
    urgency: readText(record, 'urgency', message, 160, context),
    choice: readText(record, 'choice', message, 180, context),
    plausibleCost: readText(record, 'plausibleCost', message, 180, context),
    facts: parseStoryFacts(record.facts, context, message, 'predicament', 2, 6),
    actions: parseStoryActions(record.actions, context, message, 'user-choice', 1, 3),
  }

  validatePredicamentNarrative(predicament, context, message)
  return predicament
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
    if (
      action.preconditions.some((factId) => factsById.get(factId)?.mutability === undefined || factsById.get(factId)?.mutability === 'unknown')
      || action.effects.some((factId) => factsById.get(factId)?.mutability !== 'changeable')
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
  maximumLockedFacts = 5,
): StorySeedDraft {
  return {
    subject: readText(record, 'subject', message, 160, context),
    activeSituation: readText(record, 'activeSituation', message, 200, context),
    lockedGoal: readNullableText(record, 'lockedGoal', message, 180, context),
    lockedFacts: readRequiredTextList(record, 'lockedFacts', 1, maximumLockedFacts, 80, message, context),
    worldMode: readStoryWorldMode(record.worldMode, message, context),
    unknowns: readRequiredTextList(record, 'unknowns', 1, 6, 48, message, context),
  }
}

function parsePredicamentContractReviews(
  value: unknown,
  directions: StoryPredicaments,
): PredicamentContractReview[] {
  const message = '模型没有完成完整的故事困境忠实度检查，请重试。'
  return parseCompleteReviewSet(
    value,
    directions,
    parsePredicamentContractReview,
    (review) => review.predicamentId,
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

function parsePredicamentContractReview(value: unknown, message: string): PredicamentContractReview {
  const record = expectRecord(value, message, invalidModelOutputContext)
  return {
    predicamentId: readText(record, 'predicamentId', message, 64, invalidModelOutputContext),
    preservesLockedFacts: readBoolean(record, 'preservesLockedFacts', message, invalidModelOutputContext),
    preservesLockedGoal: readBoolean(record, 'preservesLockedGoal', message, invalidModelOutputContext),
    isOriginalGoalStillMainPlot: readBoolean(record, 'isOriginalGoalStillMainPlot', message, invalidModelOutputContext),
    staysWithinScope: readBoolean(record, 'staysWithinScope', message, invalidModelOutputContext),
    stateContractIsGrounded: readBoolean(record, 'stateContractIsGrounded', message, invalidModelOutputContext),
  }
}

function parseHeadTailGoalReview(value: unknown, message: string): HeadTailGoalReview {
  const record = expectRecord(value, message, invalidModelOutputContext)
  return {
    optionId: readText(record, 'optionId', message, 64, invalidModelOutputContext),
    keepsConfirmedGoal: readBoolean(record, 'keepsConfirmedGoal', message, invalidModelOutputContext),
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

function readOptionalText(record: Record<string, unknown>, field: string, maximumLength: number): string | undefined {
  const value = record[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new AppError('偏好内容不正确。', 400, 'INVALID_REQUEST')

  const text = value.trim()
  if (!text) return undefined
  if (text.length > maximumLength) throw new AppError('偏好内容过长，请缩短后重试。', 400, 'INVALID_REQUEST')

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
