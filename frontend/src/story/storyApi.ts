import type { StoryReasoningProposal } from '../../../shared/story-reasoning-contract.js'
import type {
  ApiErrorResponse,
  GeneratedStory,
  StoryConflict,
  StoryConflictCore,
  StoryConflictCoreContextPrefill,
  StoryConflictCoreMechanismType,
  StoryConflictCoreSystemDraft,
  StoryBeat,
  StoryDirectionsRequest,
  StoryDirectionsResponse,
  StoryPredicamentResponse,
  StoryPredicamentSessionRequest,
  StoryGenerationSessionRequest,
  StoryGenerationResponse,
  StoryHeadTailOption,
  StoryHeadTailSessionRequest,
  StoryHeadTailResponse,
  StoryNode,
  StoryPredicament,
  StorySeed,
  StoryReviewItem,
  StoryTurn,
  StoryTurnOption,
  StoryTurnOptionRefinementRequest,
  StoryTurnSessionRequest,
  StoryTurnResponse,
  StoryFact,
  StoryAction,
  StoryTransition,
  StorySessionVersion,
  ConfirmedCurve,
  AuthorInstruction,
  CreativeBrief,
  CurveBeat,
  ProvisionalCurve,
  StoryCoCreationResponse,
  StoryCoCreationStartRequest,
  StoryCurveBeatRegenerationRequest,
  StoryCurveBeatRejectRequest,
  StoryCurveDependenciesRegenerationRequest,
  StorySourceFactDispositionRequest,
  StoryCurveBeatUpdateRequest,
  StoryCurveConfirmationResponse,
  StoryCurveConfirmRequest,
  StoryCurveMutationResponse,
  StoryCurveSpineResponse,
  StoryCurveStartSpineRequest,
  StoryCurveVersion,
  StoryCurveFoundation,
  StoryCurveRegenerationPreview,
  StoryCurveRegenerationResolutionRequest,
  StoryCurveVersionSelectionRequest,
  StorySessionSnapshot,
  StoryAuthorInstructionRequest,
  StoryAuthorClarification,
  StoryAuthorClarificationRequest,
  StoryActionProposalRequest,
  StoryActionProposalConfirmRequest,
  StoryActionProposalResponse,
  StoryActionProposal,
} from '../../../shared/story-contract.js'

const INVALID_RESPONSE_MESSAGE = '故事服务返回的数据不完整，请重试。'
const GENERATED_OPTION_COUNT = 3

export class StoryApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly conflictCoreContextPrefill?: StoryConflictCoreContextPrefill,
    public readonly systemDraftPrefill?: StoryConflictCoreSystemDraft,
  ) {
    super(message)
    this.name = 'StoryApiError'
  }
}

export function requestConflictCores(request: StoryDirectionsRequest): Promise<StoryDirectionsResponse> {
  return postJson('/api/story-directions', request, parseConflictCoresResponse)
}

export function requestStoryCoCreationStart(request: StoryCoCreationStartRequest): Promise<StoryCoCreationResponse> {
  return postJson('/api/story/co-create/start', request, parseStoryCoCreationResponse)
}

export function requestPreparationAcceptance(request: import('../../../shared/story-preparation-request.js').StoryPreparationAcceptanceRequest): Promise<StoryCurveMutationResponse> {
  return postJson('/api/story/preparation/accept', request, parseStoryCurveMutationResponse)
}
export function requestPreparationSupplement(request: import('../../../shared/story-preparation-request.js').StoryPreparationSupplementRequest): Promise<StoryCurveMutationResponse> {
  return postJson('/api/story/preparation/supplement', request, parseStoryCurveMutationResponse)
}
export function requestPreparationRevision(request: import('../../../shared/story-preparation-request.js').StoryPreparationRevisionRequest): Promise<StoryCurveMutationResponse> {
  return postJson('/api/story/preparation/revise', request, parseStoryCurveMutationResponse)
}
export function requestPreparationGoalSuggestion(request: { storyId: string; revision: number; curveId: string }): Promise<string> {
  return postJson('/api/story/preparation/suggest-goal', request, payload => readText(expectRecord(payload), 'suggestion'))
}

export function requestCurveBeatUpdate(request: StoryCurveBeatUpdateRequest): Promise<StoryCurveMutationResponse> {
  return postJson('/api/story/curve/beat', request, parseStoryCurveMutationResponse)
}

export function requestCurveBeatRegeneration(
  request: StoryCurveBeatRegenerationRequest,
): Promise<StoryCurveMutationResponse> {
  return postJson('/api/story/curve/beat/regenerate', request, parseStoryCurveMutationResponse)
}

export function requestCurveBeatRejection(request: StoryCurveBeatRejectRequest): Promise<StoryCurveMutationResponse> {
  return postJson('/api/story/curve/beat/reject', request, parseStoryCurveMutationResponse)
}

export function requestAffectedCurveRegeneration(
  request: StoryCurveDependenciesRegenerationRequest,
): Promise<StoryCurveMutationResponse> {
  return postJson('/api/story/curve/regenerate-affected', request, parseStoryCurveMutationResponse)
}

export function requestCurveRegenerationResolution(
  request: StoryCurveRegenerationResolutionRequest,
): Promise<StoryCurveMutationResponse> {
  return postJson('/api/story/curve/regenerate-affected/resolve', request, parseStoryCurveMutationResponse)
}

export function requestSourceFactDisposition(
  request: StorySourceFactDispositionRequest,
): Promise<StoryCurveMutationResponse> {
  return postJson('/api/story/curve/source-fact', request, parseStoryCurveMutationResponse)
}

export function requestCurveClarification(
  request: StoryAuthorClarificationRequest,
): Promise<StoryCurveMutationResponse> {
  return postJson('/api/story/curve/clarification', request, parseStoryCurveMutationResponse)
}

export function requestCurveConfirmation(request: StoryCurveConfirmRequest): Promise<StoryCurveConfirmationResponse> {
  return postJson('/api/story/curve/confirm', request, parseStoryCurveConfirmationResponse)
}

export function requestCurveStorySpine(request: StoryCurveStartSpineRequest): Promise<StoryCurveSpineResponse> {
  return postJson('/api/story/curve/start-spine', request, parseStoryCurveSpineResponse)
}

export function requestStorySession(storyId: string): Promise<StorySessionSnapshot> {
  return getJson(`/api/story/session/${encodeURIComponent(storyId)}`, parseStorySessionSnapshot)
}

export function requestCurveVersionSelection(
  request: StoryCurveVersionSelectionRequest,
): Promise<StorySessionSnapshot> {
  return postJson('/api/story/curve/version/select', request, parseStorySessionSnapshot)
}

export function requestAuthorInstruction(
  request: StoryAuthorInstructionRequest,
): Promise<StoryCurveMutationResponse> {
  return postJson('/api/story/author-instruction', request, parseStoryCurveMutationResponse)
}

export function requestStoryActionProposal(
  request: StoryActionProposalRequest,
): Promise<StoryActionProposalResponse> {
  return postJson('/api/story/action-proposal', request, parseStoryActionProposalResponse)
}

export function requestStoryActionProposalConfirmation(
  request: StoryActionProposalConfirmRequest,
): Promise<StoryTurnResponse> {
  return postJson('/api/story/action-proposal/confirm', request, parseStoryTurnResponse)
}

export function requestStoryPredicament(request: StoryPredicamentSessionRequest): Promise<StoryPredicamentResponse> {
  return postJson('/api/story-predicament', request, parsePredicamentResponse)
}

export function requestHeadTailOptions(request: StoryHeadTailSessionRequest): Promise<StoryHeadTailResponse> {
  return postJson('/api/story-head-tail', request, parseHeadTailResponse)
}

export function requestStoryTurn(request: StoryTurnSessionRequest): Promise<StoryTurnResponse> {
  return postJson('/api/story-spine/turn', request, parseStoryTurnResponse)
}

export function requestStoryTurnOptionRefinement(
  request: StoryTurnOptionRefinementRequest,
): Promise<StoryTurnResponse> {
  return postJson('/api/story-spine/turn-option/refine', request, parseStoryTurnResponse)
}

export function requestFullStory(request: StoryGenerationSessionRequest): Promise<StoryGenerationResponse> {
  return postJson('/api/stories/generate', request, parseStoryResponse)
}

interface JsonRequestOptions<T> {
  path: string
  method: 'GET' | 'POST'
  body?: unknown
  parseResponse: (payload: unknown) => T
  networkErrorMessage: string
  responseErrorMessage: string
}

async function requestJson<T>({
  path,
  method,
  body,
  parseResponse,
  networkErrorMessage,
  responseErrorMessage,
}: JsonRequestOptions<T>): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      ...(method === 'POST'
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    })
  } catch {
    throw new StoryApiError(networkErrorMessage, 'NETWORK_ERROR')
  }

  const payload = await readJson(response)
  if (!response.ok) {
    const error = parseApiErrorResponse(payload)
    throw new StoryApiError(
      error?.error.message ?? responseErrorMessage,
      error?.error.code,
      error?.error.conflictCoreContextPrefill,
      error?.error.systemDraftPrefill,
    )
  }
  return parseResponse(payload)
}

async function postJson<T>(
  path: string,
  body: unknown,
  parseResponse: (payload: unknown) => T,
): Promise<T> {
  return requestJson({
    path,
    method: 'POST',
    body,
    parseResponse,
    networkErrorMessage: '暂时连不上故事服务，请确认后端已启动。',
    responseErrorMessage: '生成没有完成，请稍后重试。',
  })
}

async function getJson<T>(
  path: string,
  parseResponse: (payload: unknown) => T,
): Promise<T> {
  return requestJson({
    path,
    method: 'GET',
    parseResponse,
    networkErrorMessage: '暂时连不上故事服务，请确认后端已启动。',
    responseErrorMessage: '读取故事会话没有完成，请稍后重试。',
  })
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    if (!response.ok) {
      if ([500, 502, 503, 504].includes(response.status)) {
        throw new StoryApiError('故事服务暂时不可用，请确认后端已启动后重试。', 'SERVICE_UNAVAILABLE')
      }
      throw new StoryApiError(`故事请求失败（HTTP ${response.status}），请稍后重试。`, 'HTTP_ERROR')
    }
    throw new StoryApiError('故事服务返回了无法读取的内容，请重试。', 'INVALID_RESPONSE')
  }
}

function parseConflictCoresResponse(payload: unknown): StoryDirectionsResponse {
  const record = expectRecord(payload)

  return {
    ...parseStorySessionVersion(record),
    seed: parseStorySeed(record.seed),
    conflictCores: parseGeneratedOptionTuple(record.conflictCores, parseStoryConflictCore),
  }
}

function parseStoryCoCreationResponse(payload: unknown): StoryCoCreationResponse {
  const record = expectRecord(payload)
  return {
    ...parseStorySessionVersion(record),
    seed: parseStorySeed(record.seed),
    brief: parseCreativeBrief(record.brief),
    curve: parseProvisionalCurve(record.curve),
    ...(record.curveVersions === undefined ? {} : { curveVersions: parseCurveVersions(record.curveVersions) }),
    ...(record.activeCurveVersionId === undefined ? {} : { activeCurveVersionId: readIdentifier(record, 'activeCurveVersionId') }),
  }
}

function parseStoryCurveMutationResponse(payload: unknown): StoryCurveMutationResponse {
  const record = expectRecord(payload)
  return {
    ...parseStorySessionVersion(record),
    curve: parseProvisionalCurve(record.curve),
    affectedBeatIds: readIdentifierList(record, 'affectedBeatIds'),
    ...(record.pendingCurveRegeneration === undefined
      ? {}
      : { pendingCurveRegeneration: parseCurveRegenerationPreview(record.pendingCurveRegeneration) }),
    ...(record.curveVersions === undefined ? {} : { curveVersions: parseCurveVersions(record.curveVersions) }),
    ...(record.activeCurveVersionId === undefined ? {} : { activeCurveVersionId: readIdentifier(record, 'activeCurveVersionId') }),
  }
}

function parseCurveRegenerationPreview(value: unknown): StoryCurveRegenerationPreview {
  const record = expectRecord(value)
  const items = record.items
  if (!Array.isArray(items)) throwInvalidResponse()
  return {
    ...(record.reasoning === undefined ? {} : { reasoning: parseReasoning(record.reasoning) }),
    ...(record.excludedUnknownIds === undefined ? {} : { excludedUnknownIds: readIdentifierList(record, 'excludedUnknownIds') }),
    id: readIdentifier(record, 'id'),
    curveId: readIdentifier(record, 'curveId'),
    items: items.map((item) => {
      const itemRecord = expectRecord(item)
      const kind = itemRecord.kind
      if (
        kind !== 'current-state' && kind !== 'character-tension' && kind !== 'trigger'
        && kind !== 'escalation' && kind !== 'midpoint-turn' && kind !== 'climax-choice' && kind !== 'resolution'
      ) throwInvalidResponse()
      return {
        id: readIdentifier(itemRecord, 'id'),
        beatId: readIdentifier(itemRecord, 'beatId'),
        title: readText(itemRecord, 'title'),
        kind,
        oldDetail: record.reasoning === undefined ? readText(itemRecord, 'oldDetail') : readDesignSlot(itemRecord, 'oldDetail'),
        newDetail: readText(itemRecord, 'newDetail'),
        newSourceFactIds: readIdentifierList(itemRecord, 'newSourceFactIds'),
        ...(itemRecord.newCausalAnchor === undefined ? {} : { newCausalAnchor: readText(itemRecord, 'newCausalAnchor') }),
      }
    }),
    ...(record.generation === undefined ? {} : { generation: parseCurveGenerationMetadata(record.generation) }),
    createdAt: readTimestamp(record, 'createdAt'),
  }
}

function parseStoryCurveConfirmationResponse(payload: unknown): StoryCurveConfirmationResponse {
  const record = expectRecord(payload)
  return {
    ...parseStorySessionVersion(record),
    curve: parseProvisionalCurve(record.curve),
    confirmedCurve: parseConfirmedCurve(record.confirmedCurve),
    ...(record.curveVersions === undefined ? {} : { curveVersions: parseCurveVersions(record.curveVersions) }),
    ...(record.activeCurveVersionId === undefined ? {} : { activeCurveVersionId: readIdentifier(record, 'activeCurveVersionId') }),
  }
}

function parseStorySessionSnapshot(payload: unknown): StorySessionSnapshot {
  const record = expectRecord(payload)
  const resumeStage = record.resumeStage
  if (resumeStage !== 'creative-brief' && resumeStage !== 'provisional-curve' && resumeStage !== 'story-spine' && resumeStage !== 'complete') {
    throwInvalidResponse()
  }
  const curve = record.curve === undefined ? undefined : parseProvisionalCurve(record.curve)
  const confirmedCurve = record.confirmedCurve === undefined ? undefined : parseConfirmedCurve(record.confirmedCurve)
  const predicament = record.predicament === undefined ? undefined : parseStoryPredicament(record.predicament)
  const approach = record.approach === undefined ? undefined : parsePredicamentApproach(record.approach)
  const headTail = record.headTail === undefined ? undefined : parseHeadTailOption(record.headTail)
  const currentTurn = record.currentTurn === undefined ? undefined : parseStoryTurn(record.currentTurn)
  const generatedStory = record.generatedStory === undefined ? undefined : parseGeneratedStory(record.generatedStory)
  return {
    ...parseStorySessionVersion(record),
    idea: readText(record, 'idea'),
    seed: parseStorySeed(record.seed, predicament?.designProtocol === 'prepared-action' ? 12 : 5),
    brief: parseCreativeBrief(record.brief),
    ...(curve ? { curve } : {}),
    ...(confirmedCurve ? { confirmedCurve } : {}),
    curveVersions: parseCurveVersions(record.curveVersions),
    ...(record.activeCurveVersionId === undefined ? {} : { activeCurveVersionId: readIdentifier(record, 'activeCurveVersionId') }),
    ...(predicament ? { predicament } : {}),
    ...(approach ? { approach } : {}),
    ...(headTail ? { headTail } : {}),
    history: parseTurnHistory(record.history),
    ...(currentTurn ? { currentTurn } : {}),
    ...(record.pendingActionProposal === undefined ? {} : { pendingActionProposal: parseStoryActionProposal(record.pendingActionProposal) }),
    ...(record.pendingCurveRegeneration === undefined
      ? {}
      : { pendingCurveRegeneration: parseCurveRegenerationPreview(record.pendingCurveRegeneration) }),
    ...(generatedStory ? { generatedStory } : {}),
    resumeStage,
  }
}

export function parseStoryCurveSpineResponse(payload: unknown): StoryCurveSpineResponse {
  const record = expectRecord(payload)
  const predicament = parseStoryPredicament(record.predicament)
  return {
    ...parseStoryTurnResponse(record),
    seed: parseStorySeed(record.seed, predicament.designProtocol === 'prepared-action' ? 12 : 5),
    predicament,
    approach: parsePredicamentApproach(record.approach),
    headTail: parseHeadTailOption(record.headTail),
  }
}

function parsePredicamentResponse(payload: unknown): StoryPredicamentResponse {
  const record = expectRecord(payload)
  return {
    ...parseStorySessionVersion(record),
    predicament: parseStoryPredicament(record.predicament),
  }
}

function parseHeadTailResponse(payload: unknown): StoryHeadTailResponse {
  const record = expectRecord(payload)

  return {
    ...parseStorySessionVersion(record),
    options: parseGeneratedOptionTuple(record.options, parseHeadTailOption),
  }
}

function parseStoryTurnResponse(payload: unknown): StoryTurnResponse {
  const record = expectRecord(payload)
  return {
    ...parseStorySessionVersion(record),
    history: parseTurnHistory(record.history),
    turn: parseStoryTurn(record.turn),
    ...(record.pendingActionProposal === undefined ? {} : { pendingActionProposal: parseStoryActionProposal(record.pendingActionProposal) }),
  }
}

function parseStoryActionProposalResponse(payload: unknown): StoryActionProposalResponse {
  const record = expectRecord(payload)
  const proposalRecord = expectRecord(record.proposal)
  return {
    ...parseStorySessionVersion(record),
    proposal: parseStoryActionProposal(proposalRecord),
  }
}

function parseStoryActionProposal(value: unknown): StoryActionProposal {
  const record = expectRecord(value)
  return {
    id: readIdentifier(record, 'id'),
    turnId: readIdentifier(record, 'turnId'),
    action: readText(record, 'action'),
    grounding: readText(record, 'grounding'),
    preconditions: readTextList(record, 'preconditions', 0, 8),
    immediateConsequence: readText(record, 'immediateConsequence'),
    laterEffect: readText(record, 'laterEffect'),
    option: parseStoryTurnOption(record.option),
    createdAt: readTimestamp(record, 'createdAt'),
    ...(record.requiresExecutedResultConfirmation === undefined ? {} : {
      requiresExecutedResultConfirmation: readRequiredBoolean(record.requiresExecutedResultConfirmation),
    }),
  }
}


function parseStoryResponse(payload: unknown): StoryGenerationResponse {
  const record = expectRecord(payload)
  return {
    ...parseStorySessionVersion(record),
    story: parseGeneratedStory(record.story),
  }
}

function parseStorySessionVersion(record: Record<string, unknown>): StorySessionVersion {
  return {
    storyId: readIdentifier(record, 'storyId'),
    revision: readNonNegativeInteger(record, 'revision'),
  }
}

function parseStorySeed(value: unknown, maximumLockedFacts = 5): StorySeed {
  const record = expectRecord(value)
  const lockedGoal = record.lockedGoal
  if (lockedGoal !== null && (typeof lockedGoal !== 'string' || !lockedGoal.trim())) throwInvalidResponse()

  const worldMode = record.worldMode
  if (worldMode !== 'realistic-default' && worldMode !== 'user-specified') throwInvalidResponse()

  const expansionScope = record.expansionScope
  if (expansionScope !== 'keep-scale' && expansionScope !== 'grounded-obstacle' && expansionScope !== 'larger-story' && expansionScope !== 'genre-led') {
    throwInvalidResponse()
  }
  const systemDraft = parseSystemConflictCoreDraft(record.systemDraft)
  const creativeBrief = record.creativeBrief === undefined || record.creativeBrief === null
    ? undefined
    : parseCreativeBrief(record.creativeBrief)

  return {
    subject: readText(record, 'subject'),
    activeSituation: readText(record, 'activeSituation'),
    lockedGoal: typeof lockedGoal === 'string' ? lockedGoal.trim() : null,
    lockedFacts: readTextList(record, 'lockedFacts', 0, maximumLockedFacts),
    ...(systemDraft ? { systemDraft } : {}),
    ...(creativeBrief ? { creativeBrief } : {}),
    worldMode,
    expansionScope,
    unknowns: readTextList(record, 'unknowns', 0, 6),
  }
}

function parseSystemConflictCoreDraft(value: unknown): StorySeed['systemDraft'] {
  if (value === undefined || value === null) return undefined

  const record = expectRecord(value)
  const directions = parseSystemDraftDirections(record.directions)
  const activeDirection = parseSystemDraftDirection(record.activeDirection)
  const origin = parseSystemDraftOrigin(record.origin) ?? 'model'
  const fallbackReason = readErrorPrefillText(record.fallbackReason)
  return {
    goal: readText(record, 'goal'),
    stake: readText(record, 'stake'),
    constraint: readText(record, 'constraint'),
    origin,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(directions ? { directions } : {}),
    ...(activeDirection ? { activeDirection } : {}),
  }
}

function parseSystemDraftOrigin(value: unknown): StoryConflictCoreSystemDraft['origin'] {
  if (value === 'model' || value === 'deterministic-fallback') return value
  return undefined
}

function parseSystemDraftDirections(
  value: unknown,
): StoryConflictCoreSystemDraft['directions'] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || (value.length !== 1 && value.length !== GENERATED_OPTION_COUNT)) throwInvalidResponse()

  return value.map((item) => parseSystemDraftDirection(item)!)
}

function parseSystemDraftDirection(
  value: unknown,
): StoryConflictCoreSystemDraft['activeDirection'] {
  if (value === undefined || value === null) return undefined
  const record = expectRecord(value)
  return {
    label: readText(record, 'label'),
    mechanismType: readSystemDraftMechanismType(record.mechanismType),
    premise: readText(record, 'premise'),
    tradeoff: readText(record, 'tradeoff'),
  }
}

function readSystemDraftMechanismType(value: unknown): StoryConflictCoreMechanismType {
  if (
    value === 'information-gap'
    || value === 'boundary-conflict'
    || value === 'meaning-commitment'
    || value === 'initiation-block'
    || value === 'window-pressure'
    || value === 'resource-constraint'
    || value === 'commitment-conflict'
  ) {
    return value
  }
  throwInvalidResponse()
}

function parseCreativeBrief(value: unknown): CreativeBrief {
  const record = expectRecord(value)
  const tones = parseCreativeEnumList(record.tones, ['comedy', 'warm', 'friendship', 'romance', 'growth', 'mystery', 'fantasy'] as const)
  const dramaticForces = parseCreativeEnumList(record.dramaticForces, ['misunderstanding', 'cost', 'surprise', 'contrast', 'relationship-tension'] as const)
  if (typeof record.allowSystemNamedCharacters !== 'boolean') throwInvalidResponse()
  const note = readOptionalGeneratedText(record.note, 180)
  let storyRequirements: CreativeBrief['storyRequirements']
  if (record.storyRequirements !== undefined) {
    const fields = expectRecord(record.storyRequirements)
    storyRequirements = {}
    for (const key of ['setting', 'direction', 'boundaries'] as const) {
      const content = readOptionalGeneratedText(fields[key], 240)
      if (content) storyRequirements[key] = content
    }
  }
  return {
    tones,
    dramaticForces,
    allowSystemNamedCharacters: record.allowSystemNamedCharacters,
    ...(note ? { note } : {}),
    ...(storyRequirements && Object.keys(storyRequirements).length ? { storyRequirements } : {}),
  }
}

function parseCreativeEnumList<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value) || value.length > 2 || value.some((item) => typeof item !== 'string' || !allowed.includes(item as T))) {
    throwInvalidResponse()
  }
  return [...new Set(value as T[])]
}

function parseProvisionalCurve(value: unknown): ProvisionalCurve {
  const record = expectRecord(value)
  const status = record.status
  if (status !== 'draft' && status !== 'confirmed' && status !== 'superseded') throwInvalidResponse()
  const fields = parseCurveFields(record)
  const instructions = parseAuthorInstructions(record.instructions)
  return {
    ...fields,
    status,
    instructions,
    createdAt: readTimestamp(record, 'createdAt'),
    updatedAt: readTimestamp(record, 'updatedAt'),
  }
}

function parseConfirmedCurve(value: unknown): ConfirmedCurve {
  const record = expectRecord(value)
  const fields = parseCurveFields(record)
  return {
    ...fields,
    provisionalCurveId: readIdentifier(record, 'provisionalCurveId'),
    confirmedAt: readTimestamp(record, 'confirmedAt'),
  }
}

type ParsedCurveFields = Pick<
  ProvisionalCurve,
  'id' | 'title' | 'brief' | 'beats' | 'rejectedProposals' | 'design' | 'foundation' | 'generation' | 'clarifications' | 'reasoning' | 'preparation'
>

function parseCurveFields(record: Record<string, unknown>): ParsedCurveFields {
  const preparation = record.preparation === undefined ? undefined : parsePreparation(record.preparation)
  const reasoning = record.reasoning === undefined ? undefined : parseReasoning(record.reasoning)
  const rejectedProposals = record.rejectedProposals === undefined
    ? undefined
    : parseCurveBeatList(record.rejectedProposals, 0, 100)
  return {
    id: readIdentifier(record, 'id'),
    title: readText(record, 'title'),
    brief: parseCreativeBrief(record.brief),
    beats: preparation ? parseCurveBeatList(record.beats, preparation.status === 'needs-review' ? 0 : 3, 7) : reasoning?.outcome === 'questions' ? parseCurveBeatList(record.beats, 0, 7) : parseCurveBeats(record.beats),
    ...(preparation ? { preparation } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(rejectedProposals ? { rejectedProposals } : {}),
    ...(record.design === undefined ? {} : { design: parseStoryDesignRecord(record.design) }),
    ...(record.foundation === undefined ? {} : { foundation: parseStoryCurveFoundation(record.foundation) }),
    ...(record.generation === undefined ? {} : { generation: parseCurveGenerationMetadata(record.generation) }),
    ...(record.clarifications === undefined ? {} : { clarifications: parseClarifications(record.clarifications) }),
  }
}

function parseClarifications(value: unknown): StoryAuthorClarification[] {
  if (!Array.isArray(value)) throwInvalidResponse()
  return value.map((item) => {
    const record = expectRecord(item)
    const status = record.status
    if (status !== 'unanswered' && status !== 'author-unknown' && status !== 'needs-review' && status !== 'confirmed') throwInvalidResponse()
    const unknownHandling = record.unknownHandling
    if (unknownHandling !== undefined && unknownHandling !== 'keep-unknown' && unknownHandling !== 'request-independent-proposal' && unknownHandling !== 'abandon-dependent-proposal') throwInvalidResponse()
    const resolution = record.resolution
    if (resolution !== undefined && resolution !== 'answer-applied' && resolution !== 'independent-proposal-accepted' && resolution !== 'proposal-abandoned') throwInvalidResponse()
    const dependency = expectRecord(record.dependency)
    const requiredFor = dependency.requiredFor
    if (!Array.isArray(requiredFor) || requiredFor.some((value) => value !== 'review-beat' && value !== 'confirm-curve')) throwInvalidResponse()
    if (record.source !== 'author-review') throwInvalidResponse()
    return {
      id: readIdentifier(record, 'id'),
      prompt: readText(record, 'prompt'),
      ...(record.reasoningUnknownId === undefined ? {} : { reasoningUnknownId: readIdentifier(record, 'reasoningUnknownId') }),
      status,
      ...(record.answerText === undefined ? {} : { answerText: readVerbatimAnswer(record.answerText) }),
      ...(unknownHandling === undefined ? {} : { unknownHandling }),
      dependency: {
        beatIds: readIdentifierList(dependency, 'beatIds'),
        causalGap: readText(dependency, 'causalGap'),
        requiredFor,
      },
      source: 'author-review',
      ...(record.sourceFactId === undefined ? {} : { sourceFactId: readIdentifier(record, 'sourceFactId') }),
      ...(resolution === undefined ? {} : { resolution }),
      createdAt: readTimestamp(record, 'createdAt'),
      updatedAt: readTimestamp(record, 'updatedAt'),
      ...(record.confirmedAt === undefined ? {} : { confirmedAt: readTimestamp(record, 'confirmedAt') }),
    }
  })
}

function parseStoryCurveFoundation(value: unknown): StoryCurveFoundation {
  const record = expectRecord(value)
  const reasoning = record.reasoning === undefined ? undefined : parseReasoning(record.reasoning)
  // New protocol intentionally leaves undeclared urgency/cost/conflict empty.
  const slot = reasoning ? readDesignSlot : readText
  const conflictCore = expectRecord(record.conflictCore)
  const predicament = expectRecord(record.predicament)
  const middleDevelopment = expectRecord(record.middleDevelopment)
  const storyEnds = expectRecord(record.storyEnds)
  const approach = expectRecord(record.approach)
  const sourceFactIdsRecord = record.sourceFactIds === undefined ? undefined : expectRecord(record.sourceFactIds)
  const beatSignaturesRecord = record.beatSignatures === undefined ? undefined : expectRecord(record.beatSignatures)
  const beatSignatures = beatSignaturesRecord
    ? Object.fromEntries(Object.entries(beatSignaturesRecord).map(([id, signature]) => {
        if (typeof signature !== 'string' || !signature.trim()) throwInvalidResponse()
        return [id, signature]
      }))
    : undefined
  return {
    conflictCore: {
      goal: readText(conflictCore, 'goal'),
      obstacle: slot(conflictCore, 'obstacle'),
      tradeoff: slot(conflictCore, 'tradeoff'),
    },
    preservedGoal: readText(record, 'preservedGoal'),
    predicament: {
      title: readText(predicament, 'title'),
      variationAxis: readStoryVariationAxis(predicament.variationAxis),
      immediateSituation: readText(predicament, 'immediateSituation'),
      obstacle: slot(predicament, 'obstacle'),
      tradeoff: slot(predicament, 'tradeoff'),
      urgency: slot(predicament, 'urgency'),
      choice: slot(predicament, 'choice'),
      plausibleCost: slot(predicament, 'plausibleCost'),
    },
    middleDevelopment: {
      escalation: slot(middleDevelopment, 'escalation'),
      midpoint: slot(middleDevelopment, 'midpoint'),
      climaxPressure: slot(middleDevelopment, 'climaxPressure'),
    },
    storyEnds: {
      opening: readText(storyEnds, 'opening'),
      openingClue: readText(storyEnds, 'openingClue'),
      climax: slot(storyEnds, 'climax'),
      resolution: readText(storyEnds, 'resolution'),
      cost: slot(storyEnds, 'cost'),
      promise: slot(storyEnds, 'promise'),
    },
    approach: {
      intent: readText(approach, 'intent'),
      cost: slot(approach, 'cost'),
    },
    ...(sourceFactIdsRecord ? {
      sourceFactIds: {
        conflictCore: readIdentifierList(sourceFactIdsRecord, 'conflictCore'),
        predicament: readIdentifierList(sourceFactIdsRecord, 'predicament'),
        middleDevelopment: readIdentifierList(sourceFactIdsRecord, 'middleDevelopment'),
        storyEnds: readIdentifierList(sourceFactIdsRecord, 'storyEnds'),
      },
    } : {}),
    ...(beatSignatures ? { beatSignatures } : {}),
    ...(reasoning ? { reasoning } : {}),
  }
}

function parseCurveVersions(value: unknown): StoryCurveVersion[] {
  if (!Array.isArray(value)) throwInvalidResponse()
  return value.map((item) => {
    const record = expectRecord(item)
    const curve = parseProvisionalCurve(record.curve)
    const confirmedCurve = record.confirmedCurve === undefined ? undefined : parseConfirmedCurve(record.confirmedCurve)
    return {
      id: readIdentifier(record, 'id'),
      label: readText(record, 'label'),
      curve,
      ...(confirmedCurve ? { confirmedCurve } : {}),
      createdAt: readTimestamp(record, 'createdAt'),
      updatedAt: readTimestamp(record, 'updatedAt'),
    }
  })
}

function parseStoryDesignRecord(value: unknown): NonNullable<ProvisionalCurve['design']> {
  const record = expectRecord(value)
  const sourceFacts = record.sourceFacts
  if (!Array.isArray(sourceFacts)) throwInvalidResponse()
  return {
    id: readIdentifier(record, 'id'),
    sourceFacts: sourceFacts.map((item) => {
      const fact = expectRecord(item)
      const disposition = fact.disposition
      if (disposition !== 'integrated' && disposition !== 'needs-author-decision' && disposition !== 'parked') throwInvalidResponse()
      const source = fact.source
      if (source !== 'user-input' && source !== 'author-supplement') throwInvalidResponse()
      return {
        id: readIdentifier(fact, 'id'),
        text: source === 'author-supplement' ? readVerbatimAnswer(fact.text) : readText(fact, 'text'),
        source,
        ...(fact.clarificationId === undefined ? {} : { clarificationId: readIdentifier(fact, 'clarificationId') }),
        disposition,
        coveredByBeatIds: readIdentifierList(fact, 'coveredByBeatIds'),
      }
    }),
    conflictCoreBeatIds: readIdentifierList(record, 'conflictCoreBeatIds'),
    predicamentBeatIds: readIdentifierList(record, 'predicamentBeatIds'),
    storyEndBeatIds: readIdentifierList(record, 'storyEndBeatIds'),
    middleDevelopmentBeatIds: readIdentifierList(record, 'middleDevelopmentBeatIds'),
    ...(record.foundation === undefined ? {} : { foundation: parseStoryCurveFoundation(record.foundation) }),
  }
}

function parseCurveGenerationMetadata(value: unknown): NonNullable<ProvisionalCurve['generation']> {
  const record = expectRecord(value)
  const origin = record.origin
  if (origin !== 'model' && origin !== 'fact-preserving-fallback') throwInvalidResponse()
  const notice = readOptionalGeneratedText(record.notice, 220)
  return {
    origin,
    dramaticMechanism: readText(record, 'dramaticMechanism'),
    ...(notice ? { notice } : {}),
  }
}

function parseCurveBeats(value: unknown): CurveBeat[] {
  return parseCurveBeatList(value, 5, 7)
}

function parseCurveBeatList(value: unknown, minimumLength: number, maximumLength: number): CurveBeat[] {
  if (!Array.isArray(value) || value.length < minimumLength || value.length > maximumLength) throwInvalidResponse()
  return value.map((item) => {
    const record = expectRecord(item)
    const kind = record.kind
    if (
      kind !== 'current-state'
      && kind !== 'character-tension'
      && kind !== 'trigger'
      && kind !== 'escalation'
      && kind !== 'midpoint-turn'
      && kind !== 'climax-choice'
      && kind !== 'resolution'
    ) throwInvalidResponse()
    const source = record.source
    if (source !== 'user-input' && source !== 'system-proposal' && source !== 'user-edit' && source !== 'undecided') throwInvalidResponse()
    const status = record.status
    if (status !== 'proposed' && status !== 'edited' && status !== 'confirmed' && status !== 'stale' && status !== 'rejected') throwInvalidResponse()
    return {
      id: readIdentifier(record, 'id'),
      kind,
      title: readText(record, 'title'),
      detail: readText(record, 'detail'),
      source,
      status,
      dependsOn: readIdentifierList(record, 'dependsOn'),
      ...(record.sourceFactIds === undefined ? {} : { sourceFactIds: readIdentifierList(record, 'sourceFactIds') }),
      ...(record.causalAnchor === undefined ? {} : { causalAnchor: readText(record, 'causalAnchor') }),
    }
  })
}

function parseAuthorInstructions(value: unknown): AuthorInstruction[] {
  if (!Array.isArray(value)) throwInvalidResponse()
  return value.map((item) => {
    const record = expectRecord(item)
    const kind = record.kind
    if (kind !== 'replace' && kind !== 'remove' && kind !== 'regenerate' && kind !== 'author-revision' && kind !== 'park-fact') throwInvalidResponse()
    return {
      id: readIdentifier(record, 'id'),
      kind,
      text: readText(record, 'text'),
      ...(record.targetBeatId === undefined ? {} : { targetBeatId: readIdentifier(record, 'targetBeatId') }),
      createdAt: readTimestamp(record, 'createdAt'),
    }
  })
}

function readTimestamp(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throwInvalidResponse()
  return value
}

function parseStoryPredicament(value: unknown): StoryPredicament {
  const record = expectRecord(value)
  const slot = record.designProtocol === 'prepared-action' ? readDesignSlot : readText

  return {
    id: readText(record, 'id'),
    title: readText(record, 'title'),
    variationAxis: readStoryVariationAxis(record.variationAxis),
    preservedGoal: readText(record, 'preservedGoal'),
    immediateSituation: readText(record, 'immediateSituation'),
    ...(record.designProtocol === 'prepared-action' ? { designProtocol: 'prepared-action' as const } : {}),
    obstacle: slot(record, 'obstacle'),
    tradeoff: slot(record, 'tradeoff'),
    urgency: slot(record, 'urgency'),
    choice: slot(record, 'choice'),
    plausibleCost: slot(record, 'plausibleCost'),
    approaches: parsePredicamentApproaches(record.approaches),
    facts: parseStoryFacts(record.facts),
    actions: parseStoryActions(record.actions),
  }
}

function parseStoryConflictCore(value: unknown): StoryConflictCore {
  const record = expectRecord(value)
  const storyHook = readOptionalGeneratedText(record.storyHook, 96)
  return {
    id: readIdentifier(record, 'id'),
    title: readText(record, 'title'),
    variationAxis: readStoryVariationAxis(record.variationAxis),
    preservedGoal: readText(record, 'preservedGoal'),
    obstacle: readText(record, 'obstacle'),
    tradeoff: readText(record, 'tradeoff'),
    ...(storyHook ? { storyHook } : {}),
  }
}

function parsePredicamentApproaches(value: unknown): StoryPredicament['approaches'] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) throwInvalidResponse()
  return value.map(parsePredicamentApproach)
}

function parsePredicamentApproach(value: unknown): StoryPredicament['approaches'][number] {
  const record = expectRecord(value)
  return {
    id: readIdentifier(record, 'id'),
    intent: readText(record, 'intent'),
    cost: readText(record, 'cost'),
  }
}

function parseHeadTailOption(value: unknown): StoryHeadTailOption {
  const record = expectRecord(value)
  const slot = record.designProtocol === 'prepared-action' ? readDesignSlot : readText
  return {
    id: readText(record, 'id'),
    opening: readText(record, 'opening'),
    openingClue: readText(record, 'openingClue'),
    ...(record.designProtocol === 'prepared-action' ? { designProtocol: 'prepared-action' as const } : {}),
    climax: slot(record, 'climax'),
    resolution: readText(record, 'resolution'),
    cost: slot(record, 'cost'),
    promise: slot(record, 'promise'),
    climaxActionId: readIdentifier(record, 'climaxActionId'),
    transition: parseStoryTransition(record.transition),
  }
}

function parseStoryTurn(value: unknown): StoryTurn {
  const record = expectRecord(value)
  const node = parseStoryNode(record.node)
  const conflict = parseStoryConflict(record.conflict)
  const phase = readStoryTurnPhase(record.phase)
  const isConclusion = record.isConclusion
  const canConclude = record.canConclude
  const question = record.question

  if (typeof isConclusion !== 'boolean' || typeof canConclude !== 'boolean') throwInvalidResponse()
  if (question !== null && (typeof question !== 'string' || !question.trim())) throwInvalidResponse()
  if (!Array.isArray(record.options)) throwInvalidResponse()

  const options = record.options.map(parseStoryTurnOption)
  const turn: StoryTurn = {
    id: readText(record, 'id'),
    phase,
    node,
    conflict,
    question: typeof question === 'string' ? question.trim() : null,
    options,
    ...parseStoryTurnConclusionPayload(record, isConclusion),
    canConclude,
    isConclusion,
    ...(record.presentation === undefined ? {} : { presentation: parseTurnPresentation(record.presentation) }),
    ...(record.authorReview === undefined ? {} : { authorReview: parseTurnAuthorReview(record.authorReview) }),
  }

  validateStoryTurnShape(turn)
  return turn
}

function parseStoryTurnConclusionPayload(
  record: Record<string, unknown>,
  isConclusion: boolean,
): Pick<StoryTurn, 'narrativeAction' | 'transition'> {
  if (!isConclusion || record.presentation === 'closure-review') {
    requireNull(record.narrativeAction)
    requireNull(record.transition)
    return { narrativeAction: null, transition: null }
  }

  return {
    narrativeAction: parseStoryAction(record.narrativeAction),
    transition: parseStoryTransition(record.transition),
  }
}

function parseTurnAuthorReview(value: unknown): NonNullable<StoryTurn['authorReview']> {
  const record = expectRecord(value)
  if (!Array.isArray(record.questions) || record.questions.length < 1 || record.questions.length > 4
    || record.questions.some(q => typeof q !== 'string' || !q.trim() || q.length > 140)) throwInvalidResponse()
  return { summary: readText(record, 'summary'), questions: record.questions as string[] }
}

function validateStoryTurnShape(turn: StoryTurn) {
  if (turn.conflict.nodeId !== turn.node.id) throwInvalidResponse()
  if (turn.presentation === 'author-review') {
    if (!turn.authorReview || turn.isConclusion || turn.canConclude || turn.options.length || turn.narrativeAction !== null || turn.transition !== null) throwInvalidResponse()
  } else if (turn.authorReview) throwInvalidResponse()

  if (turn.isConclusion) {
    validateConclusionTurnShape(turn)
    return
  }

  validateOngoingTurnShape(turn)
}

function validateConclusionTurnShape(turn: StoryTurn) {
  const hasInvalidShape = turn.phase !== 'resolution'
    || turn.node.goalState !== 'resolved'
    || turn.question !== null
    || turn.options.length !== 0
    || (turn.presentation === 'closure-review' ? turn.narrativeAction !== null || turn.transition !== null : !turn.narrativeAction || !turn.transition)
    || turn.canConclude

  if (hasInvalidShape) throwInvalidResponse()
}

function validateOngoingTurnShape(turn: StoryTurn) {
  const hasInvalidShape = turn.phase === 'resolution'
    || turn.node.goalState === 'resolved'
    || !turn.question
    || (turn.presentation === 'closure-review' || turn.presentation === 'author-review' ? turn.options.length !== 0 : turn.presentation === 'candidate-actions' ? turn.options.length < 1 || turn.options.length > GENERATED_OPTION_COUNT : turn.options.length !== GENERATED_OPTION_COUNT)
    || turn.narrativeAction !== null
    || turn.transition !== null

  if (hasInvalidShape) throwInvalidResponse()
}

function parseStoryNode(value: unknown): StoryNode {
  const record = expectRecord(value)
  return {
    id: readText(record, 'id'),
    title: readText(record, 'title'),
    event: readText(record, 'event'),
    purpose: readText(record, 'purpose'),
    goalState: readStoryGoalState(record.goalState),
  }
}

function parseStoryConflict(value: unknown): StoryConflict {
  const record = expectRecord(value)
  return {
    nodeId: readText(record, 'nodeId'),
    conflict: readText(record, 'conflict'),
    action: readText(record, 'action'),
    consequence: readText(record, 'consequence'),
    intensity: readInteger(record, 'intensity', 1, 5),
    anchor: readText(record, 'anchor'),
  }
}

function parseStoryTurnOption(value: unknown): StoryTurnOption {
  const record = expectRecord(value)
  return {
    id: readText(record, 'id'),
    label: readText(record, 'label'),
    action: readText(record, 'action'),
    immediateConsequence: readText(record, 'immediateConsequence'),
    laterEffect: readText(record, 'laterEffect'),
    narrativeAction: parseStoryAction(record.narrativeAction),
    transition: parseStoryTransition(record.transition),
    ...(record.proposal === undefined ? {} : { proposal: parseCandidateActionReview(record.proposal) }),
  }
}

function readRequiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throwInvalidResponse()
  return value
}

function parseTurnPresentation(value: unknown): NonNullable<StoryTurn['presentation']> {
  if (value !== 'focus-selection' && value !== 'candidate-actions' && value !== 'closure-review' && value !== 'author-review') throwInvalidResponse()
  return value
}

function parseCandidateActionReview(value: unknown): NonNullable<StoryTurnOption['proposal']> {
  const record = expectRecord(value)
  if (record.status !== 'needs-review' || !Array.isArray(record.causalClaims) || record.causalClaims.length > 8) throwInvalidResponse()
  return { status: 'needs-review', sourceFactIds: readIdentifierList(record, 'sourceFactIds'),
    questions: readTextList(record, 'questions', 0, 4),
    causalClaims: record.causalClaims.map((value) => {
      const claim = expectRecord(value)
      return { statement: readText(claim, 'statement'), sourceFactIds: readIdentifierList(claim, 'sourceFactIds') }
    }) }
}

function parseStoryAction(value: unknown): StoryAction {
  const record = expectRecord(value)
  const source = record.source
  if (source !== 'user-choice' && source !== 'generated') throwInvalidResponse()

  return parseActionFields(record, source)
}

function parseStoryFacts(value: unknown): StoryFact[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) throwInvalidResponse()
  return value.map((item) => parseFactRecord(item))
}

function parseStoryActions(value: unknown): StoryAction[] {
  if (!Array.isArray(value) || value.length < 1) throwInvalidResponse()
  return value.map((item) => {
    const record = expectRecord(item)
    const source = record.source
    if (source !== 'user-choice' && source !== 'generated') throwInvalidResponse()
    return parseActionFields(record, source)
  })
}

function parseActionFields(
  record: Record<string, unknown>,
  source: StoryAction['source'],
): StoryAction {
  if (record.mode !== undefined && !['focus', 'candidate', 'executed'].includes(String(record.mode))) throwInvalidResponse()
  return {
    id: readIdentifier(record, 'id'),
    intent: readText(record, 'intent'),
    preconditions: readIdentifierList(record, 'preconditions'),
    effects: readIdentifierList(record, 'effects'),
    source,
    ...(record.mode === undefined ? {} : { mode: record.mode as StoryAction['mode'] }),
    ...(record.focusSourceTexts === undefined ? {} : { focusSourceTexts: readTextList(record, 'focusSourceTexts', 0, 3) }),
    ...(record.originCurveBeatIds === undefined ? {} : { originCurveBeatIds: readIdentifierList(record, 'originCurveBeatIds') }),
  }
}

function parseStoryTransition(value: unknown): StoryTransition {
  const record = expectRecord(value)
  return {
    actionId: readIdentifier(record, 'actionId'),
    consumedFacts: readIdentifierList(record, 'consumedFacts'),
    changedFacts: parseFactChanges(record.changedFacts),
    introducedFacts: parseIntroducedFacts(record.introducedFacts),
    ...(record.authorConfirmation === undefined ? {} : { authorConfirmation: parseExecutedResultReceipt(record.authorConfirmation) }),
  }
}

function parseExecutedResultReceipt(value: unknown): NonNullable<StoryTransition['authorConfirmation']> {
  const record = expectRecord(value)
  return { proposalId: readIdentifier(record, 'proposalId'), turnId: readIdentifier(record, 'turnId'),
    actionText: readText(record, 'actionText'), resultText: readText(record, 'resultText'), confirmedAt: readTimestamp(record, 'confirmedAt') }
}

function requireNull(value: unknown): null {
  if (value !== null) throwInvalidResponse()
  return null
}

function parseFactChanges(value: unknown): StoryTransition['changedFacts'] {
  if (!Array.isArray(value)) throwInvalidResponse()
  return value.map((item) => {
    const record = expectRecord(item)
    return { factId: readIdentifier(record, 'factId'), statement: readText(record, 'statement') }
  })
}

function parseIntroducedFacts(value: unknown): StoryFact[] {
  if (!Array.isArray(value)) throwInvalidResponse()
  return value.map((item) => {
    const record = expectRecord(item)
    if (record.source !== 'confirmed-action' || record.mutability !== 'changeable') throwInvalidResponse()
    return parseFactRecord(item)
  })
}

function parseFactRecord(value: unknown): StoryFact {
  const record = expectRecord(value)
  const source = record.source
  const mutability = record.mutability
  if (source !== 'user' && source !== 'system-draft' && source !== 'predicament' && source !== 'confirmed-curve' && source !== 'confirmed-action') throwInvalidResponse()
  if (mutability !== 'fixed' && mutability !== 'changeable' && mutability !== 'unknown') throwInvalidResponse()

  return {
    id: readIdentifier(record, 'id'),
    statement: readText(record, 'statement'),
    source,
    mutability,
    ...(record.originCurveBeatIds === undefined ? {} : { originCurveBeatIds: readIdentifierList(record, 'originCurveBeatIds') }),
  }
}

function parseTurnHistory(value: unknown): StoryTurnResponse['history'] {
  if (!Array.isArray(value)) throwInvalidResponse()
  return value.map((item) => {
    const record = expectRecord(item)
    return {
      turnId: readIdentifier(record, 'turnId'),
      phase: readStoryTurnPhase(record.phase),
      node: parseStoryNode(record.node),
      conflict: parseStoryConflict(record.conflict),
      selectedOption: parseStoryTurnOption(record.selectedOption),
    }
  })
}

function parseGeneratedStory(value: unknown): GeneratedStory {
  const record = expectRecord(value)
  const body = readText(record, 'body')

  return {
    title: readOptionalGeneratedText(record.title, 50) ?? '未命名故事',
    logline: readOptionalGeneratedText(record.logline, 220) ?? '根据你确认的故事路径写成。',
    body,
    outline: parseOptionalStoryBeats(record.outline),
    review: parseOptionalStoryReview(record.review),
  }
}

function parseGeneratedOptionTuple<T>(
  value: unknown,
  parseOption: (option: unknown) => T,
): [T, T, T] {
  if (!Array.isArray(value) || value.length !== GENERATED_OPTION_COUNT) throwInvalidResponse()
  return [parseOption(value[0]), parseOption(value[1]), parseOption(value[2])]
}

function parseOptionalStoryBeats(value: unknown): StoryBeat[] {
  if (!Array.isArray(value)) return createFallbackStoryBeats()

  const beats: StoryBeat[] = []
  for (const item of value.slice(0, 8)) {
    if (!isRecord(item)) continue

    const label = readOptionalGeneratedText(item.label, 32)
    const detail = readOptionalGeneratedText(item.detail, 240)
    if (label && detail) beats.push({ label, detail })
  }

  return beats.length ? beats : createFallbackStoryBeats()
}

function parseOptionalStoryReview(value: unknown): StoryReviewItem[] {
  if (!Array.isArray(value)) return createFallbackStoryReview()

  const review: StoryReviewItem[] = []
  for (const item of value.slice(0, 8)) {
    if (!isRecord(item) || (item.tone !== 'pass' && item.tone !== 'warn')) continue

    const label = readOptionalGeneratedText(item.label, 48)
    const summary = readOptionalGeneratedText(item.value, 80)
    const detail = readOptionalGeneratedText(item.detail, 260)
    if (label && summary && detail) review.push({ label, value: summary, detail, tone: item.tone })
  }

  return review.length ? review : createFallbackStoryReview()
}

function createFallbackStoryBeats(): StoryBeat[] {
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

function parseApiErrorResponse(value: unknown): ApiErrorResponse | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined

  const { code, message } = value.error
  if (typeof code !== 'string' || !code || typeof message !== 'string' || !message) return undefined

  const conflictCoreContextPrefill = parseConflictCoreContextPrefill(value.error.conflictCoreContextPrefill)
  const systemDraftPrefill = parseSystemDraftPrefill(value.error.systemDraftPrefill)
  return {
    error: {
      code,
      message,
      ...(conflictCoreContextPrefill ? { conflictCoreContextPrefill } : {}),
      ...(systemDraftPrefill ? { systemDraftPrefill } : {}),
    },
  }
}

function parseConflictCoreContextPrefill(value: unknown): StoryConflictCoreContextPrefill | undefined {
  if (!isRecord(value)) return undefined

  const goal = readErrorPrefillText(value.goal)
  const stake = readErrorPrefillText(value.stake)
  const constraint = readErrorPrefillText(value.constraint)
  if (!goal && !stake && !constraint) return undefined

  return {
    ...(goal ? { goal } : {}),
    ...(stake ? { stake } : {}),
    ...(constraint ? { constraint } : {}),
  }
}

function parseSystemDraftPrefill(value: unknown): StoryConflictCoreSystemDraft | undefined {
  if (!isRecord(value)) return undefined

  const goal = readErrorPrefillText(value.goal)
  const stake = readErrorPrefillText(value.stake)
  const constraint = readErrorPrefillText(value.constraint)
  if (!goal || !stake || !constraint) return undefined

  let directions: StoryConflictCoreSystemDraft['directions']
  let activeDirection: StoryConflictCoreSystemDraft['activeDirection']
  try {
    directions = parseSystemDraftDirections(value.directions)
    activeDirection = parseSystemDraftDirection(value.activeDirection)
  } catch {
    // Optional recovery data must never hide the server's actionable error.
    directions = undefined
    activeDirection = undefined
  }
  const origin = parseSystemDraftOrigin(value.origin)
  const fallbackReason = readErrorPrefillText(value.fallbackReason)
  return {
    goal,
    stake,
    constraint,
    ...(origin ? { origin } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(directions ? { directions } : {}),
    ...(activeDirection ? { activeDirection } : {}),
  }
}

function readErrorPrefillText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined

  const text = value.trim()
  return text && text.length <= 120 ? text : undefined
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throwInvalidResponse()
  return value
}

function readText(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || !value.trim()) throwInvalidResponse()
  return value.trim()
}

function readDesignSlot(record: Record<string, unknown>, field: string): string {
  if (typeof record[field] !== 'string') throwInvalidResponse()
  return record[field] as string
}

/** Response shape checking only. Authority and acceptance are server validated. */
function parsePreparation(value: unknown): import('../../../shared/story-preparation.js').StoryPreparation {
  const p = expectRecord(value)
  if (p.protocol !== 1 || !['needs-review', 'accepted-design'].includes(String(p.status)) || p.executed !== false) throwInvalidResponse()
  for (const key of ['sources', 'material', 'candidates', 'questions', 'acceptedCandidateIds']) if (!Array.isArray(p[key])) throwInvalidResponse()
  const sources = (p.sources as unknown[]).map(v => {
    const s = expectRecord(v)
    return { id: readIdentifier(s, 'id'), text: readText(s, 'text') }
  })
  const material = (p.material as unknown[]).map(v => {
    const m = expectRecord(v)
    if (!['fact', 'condition', 'goal', 'unknown'].includes(String(m.role))) throwInvalidResponse()
    return { id: readIdentifier(m, 'id'), role: m.role as 'fact' | 'condition' | 'goal' | 'unknown', sourceId: readIdentifier(m, 'sourceId'), quote: readText(m, 'quote') }
  })
  const questions = (p.questions as unknown[]).map(v => {
    const q = expectRecord(v)
    return { id: readIdentifier(q, 'id'), question: readText(q, 'question'), materialIds: readIdentifierList(q, 'materialIds') }
  })
  const parseCandidates = (items: unknown[]) => items.map(v => {
    const c = expectRecord(v)
    const bridge = c.causalBridge === undefined ? undefined : expectRecord(c.causalBridge)
    const expansionNeeds = c.expansionNeeds === undefined ? undefined
      : (Array.isArray(c.expansionNeeds) && c.expansionNeeds.length <= 2 ? c.expansionNeeds : throwInvalidResponse()).map(value => {
        const need = expectRecord(value)
        if (!['setup', 'action-detail', 'response-detail'].includes(String(need.kind))
          || !Array.isArray(need.anchors) || !need.anchors.length || need.anchors.length > 3) throwInvalidResponse()
        return { kind: need.kind as import('../../../shared/story-preparation.js').StoryExpansionNeed['kind'],
          anchors: (need.anchors as unknown[]).map(value => {
            const anchor = expectRecord(value)
            if (!['action', 'possibleResult', 'method', 'change', 'futureChoice'].includes(String(anchor.field))) throwInvalidResponse()
            return { field: anchor.field as import('../../../shared/story-preparation.js').StoryExpansionNeed['anchors'][number]['field'], quote: readText(anchor, 'quote') }
          }) }
      })
    return { id: readIdentifier(c, 'id'), action: readText(c, 'action'), possibleResult: readText(c, 'possibleResult'),
      ...(expansionNeeds ? { expansionNeeds } : {}),
      ...(c.futureChoice === undefined ? {} : { futureChoice: readText(c, 'futureChoice') }),
      ...(bridge === undefined ? {} : { causalBridge: { method: readText(bridge, 'method'), change: readText(bridge, 'change'), methodBasisIds: readIdentifierList(bridge, 'methodBasisIds'), changeBasisIds: readIdentifierList(bridge, 'changeBasisIds') } }),
      materialIds: readIdentifierList(c, 'materialIds'), preconditionIds: readIdentifierList(c, 'preconditionIds'),
      resultBasisIds: readIdentifierList(c, 'resultBasisIds'), unknownIds: readIdentifierList(c, 'unknownIds') }
  })
  const candidates = parseCandidates(p.candidates as unknown[])
  let authorReview: import('../../../shared/story-preparation.js').StoryPreparationReview | undefined
  if (p.authorReview !== undefined) {
    const review = expectRecord(p.authorReview)
    if (!Array.isArray(review.candidates)) throwInvalidResponse()
    authorReview = { originalText: readText(review, 'originalText'), candidates: review.candidates.map(v => {
      const c = expectRecord(v)
      return { id: readIdentifier(c, 'id'), action: readText(c, 'action'), possibleResult: readText(c, 'possibleResult'),
        ...(c.futureChoice === undefined ? {} : { futureChoice: readText(c, 'futureChoice') }), ...(c.resultBasisIds === undefined ? {} : { resultBasisIds: readIdentifierList(c, 'resultBasisIds') }) }
    }), ...(review.supersededMaterialIds === undefined ? {} : { supersededMaterialIds: readIdentifierList(review, 'supersededMaterialIds') }),
      ...(review.confirmedQuotes === undefined ? {} : { confirmedQuotes: readIdentifierList(review, 'confirmedQuotes') }) }
  }
  const supplements = p.supplements === undefined ? undefined : (Array.isArray(p.supplements) ? p.supplements : throwInvalidResponse()).map(v => {
    const s = expectRecord(v)
    if (!['hypothesis','observation','criterion','condition'].includes(String(s.kind)) || !['needs-review','accepted-design','rejected','keep-unknown'].includes(String(s.status))) throwInvalidResponse()
    return { id: readIdentifier(s, 'id'), kind: s.kind as 'hypothesis'|'observation'|'criterion'|'condition', text: readText(s, 'text'), question: readText(s, 'question'), materialIds: readIdentifierList(s, 'materialIds'), status: s.status as import('../../../shared/story-preparation.js').StoryPreparationSupplement['status'], ...(s.authorText === undefined ? {} : { authorText: readVerbatimAnswer(s.authorText) }) }
  })
  const originalCandidates = p.originalCandidates === undefined ? undefined : parseCandidates(Array.isArray(p.originalCandidates) ? p.originalCandidates : throwInvalidResponse())
  const rejectedCandidates = p.rejectedCandidates === undefined ? undefined : parseCandidates(Array.isArray(p.rejectedCandidates) ? p.rejectedCandidates : throwInvalidResponse())
  const parseMainlineQuote = (value: unknown) => {
    const item = expectRecord(value)
    const sourceId = readIdentifier(item, 'sourceId'), quote = readText(item, 'quote')
    if (!sources.some(source => source.id === sourceId && source.text.includes(quote))) throwInvalidResponse()
    return { id: readIdentifier(item, 'id'), sourceId, quote }
  }
  const mainlineGoals = p.mainlineGoals === undefined ? undefined
    : (Array.isArray(p.mainlineGoals) ? p.mainlineGoals : throwInvalidResponse()).map(parseMainlineQuote)
  const mainlineAnchors = p.mainlineAnchors === undefined ? undefined
    : (Array.isArray(p.mainlineAnchors) ? p.mainlineAnchors : throwInvalidResponse()).map(value => {
      const item = expectRecord(value)
      if (!['character', 'relationship', 'place', 'action', 'object', 'constraint'].includes(String(item.kind))) throwInvalidResponse()
      return { ...parseMainlineQuote(item), kind: item.kind as import('../../../shared/story-preparation.js').StoryMainlineAnchor['kind'] }
    })
  const appealMaterialIds = p.appealMaterialIds === undefined ? undefined : readIdentifierList(p, 'appealMaterialIds')
  return { protocol: 1, status: p.status as 'needs-review' | 'accepted-design', executed: false,
    ...(mainlineGoals === undefined ? {} : { mainlineGoals }), ...(mainlineAnchors === undefined ? {} : { mainlineAnchors }),
    ...(appealMaterialIds === undefined ? {} : { appealMaterialIds }),
    sources, material, questions, candidates, acceptedCandidateIds: readIdentifierList(p, 'acceptedCandidateIds'), ...(authorReview ? { authorReview } : {}), ...(supplements ? { supplements } : {}), ...(originalCandidates ? { originalCandidates } : {}), ...(rejectedCandidates ? { rejectedCandidates } : {}) }
}

function parseReasoning(value: unknown): StoryReasoningProposal {
  const r = expectRecord(value)
  if (r.protocol !== 1 || !['initial-design','edit-preview','action-candidates'].includes(String(r.stage))
    || r.status !== 'needs-review' || !['proposal','questions'].includes(String(r.outcome))) throwInvalidResponse()
  for (const key of ['constraints','actions','relations','unknowns']) if (!Array.isArray(r[key])) throwInvalidResponse()
  if (r.designReview !== undefined) {
    const review = expectRecord(r.designReview)
    if (review.required !== true || !Array.isArray(review.acceptedProposalIds) || review.acceptedProposalIds.some(id => typeof id !== 'string')) throwInvalidResponse()
  }
  if (r.goal !== null) expectRecord(r.goal)
  if (r.outcome === 'questions') { if (!Array.isArray(r.questions)) throwInvalidResponse() }
  else if (!Array.isArray(r.stage === 'action-candidates' ? r.options : r.steps)) throwInvalidResponse()
  return r as unknown as StoryReasoningProposal
}

function readVerbatimAnswer(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throwInvalidResponse()
  return value
}

function readOptionalGeneratedText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined

  const text = value.trim()
  return text && text.length <= maximumLength ? text : undefined
}

function readIdentifier(record: Record<string, unknown>, field: string): string {
  const value = readText(record, field)
  if (!/^[a-z][a-z0-9-]*$/i.test(value)) throwInvalidResponse()
  return value
}

function readNonNegativeInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throwInvalidResponse()
  return value
}

function readIdentifierList(record: Record<string, unknown>, field: string): string[] {
  const value = record[field]
  if (!Array.isArray(value)) throwInvalidResponse()
  return value.map((item) => {
    if (typeof item !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(item.trim())) throwInvalidResponse()
    return item.trim()
  })
}

function readStoryVariationAxis(value: unknown): StoryPredicament['variationAxis'] {
  if (value === 'time' || value === 'resource' || value === 'relationship' || value === 'commitment') return value
  throwInvalidResponse()
}

function readStoryTurnPhase(value: unknown): StoryTurn['phase'] {
  if (value === 'opening' || value === 'development' || value === 'turn' || value === 'climax' || value === 'resolution') return value
  throwInvalidResponse()
}

function readStoryGoalState(value: unknown): StoryNode['goalState'] {
  if (value === 'trying' || value === 'blocked' || value === 'changed-plan' || value === 'near-completion' || value === 'resolved') {
    return value
  }

  throwInvalidResponse()
}

function readInteger(record: Record<string, unknown>, field: string, minimum: number, maximum: number): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throwInvalidResponse()
  }

  return value
}

function readTextList(record: Record<string, unknown>, field: string, minimum: number, maximum: number): string[] {
  const value = record[field]
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throwInvalidResponse()

  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throwInvalidResponse()
    return item.trim()
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function throwInvalidResponse(): never {
  throw new StoryApiError(INVALID_RESPONSE_MESSAGE, 'INVALID_RESPONSE')
}
