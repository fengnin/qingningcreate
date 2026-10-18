import 'dotenv/config'
import express, { type NextFunction, type Request, type Response } from 'express'
import { AppError, withConfiguredQwenRequestBudget } from './qwen.js'
import {
  generateDirections,
  parseDirectionRequest,
  parsePredicamentSessionRequest,
  parseHeadTailSessionRequest,
  parseStoryGenerationSessionRequest,
  parseStoryTurnSessionRequest,
  parseStoryTurnOptionRefinementRequest,
  generateSessionHeadTailOptions,
  generateSessionPredicament,
  generateSessionStory,
  parseStoryWritingRequest,
  updateSessionWriting,
  generateSessionStoryTurn,
  generateSessionStoryTurnOptionRefinement,
  startStoryCoCreation,
  acceptSessionPreparation,
  suggestSessionStoryDirections,
  reviseSessionPreparation,
  parseStoryPreparationSuggestionRequest,
  suggestSessionPreparationGoal,
  parseStoryPreparationExplanationRequest,
  suggestSessionPreparationExplanation,
  parseStoryPreparationRevisionRequest,
  parseStoryPreparationAcceptanceRequest,
  parseStoryPreparationSupplementRequest,
  reviewSessionPreparationSupplement,
  updateSessionCurveBeat,
  regenerateSessionCurveBeat,
  rejectSessionCurveBeat,
  regenerateSessionCurveDependencies,
  resolveSessionCurveDependencies,
  updateSessionSourceFactDisposition,
  updateSessionCurveClarification,
  confirmSessionCurve,
  startSessionStorySpineFromCurve,
  getStorySessionSnapshot,
  selectSessionCurveVersion,
  applySessionAuthorInstruction,
  createSessionStoryActionProposal,
  confirmSessionStoryActionProposal,
  parseStoryCoCreationStartRequest,
  parseStoryCurveBeatUpdateRequest,
  parseStoryCurveBeatRegenerationRequest,
  parseStoryCurveBeatRejectRequest,
  parseStoryCurveDependenciesRegenerationRequest,
  parseStoryCurveRegenerationResolutionRequest,
  parseStorySourceFactDispositionRequest,
  parseStoryAuthorClarificationRequest,
  parseStoryCurveConfirmRequest,
  parseStoryCurveStartSpineRequest,
  parseStoryCurveVersionSelectionRequest,
  parseStoryAuthorInstructionRequest,
  parseStoryActionProposalRequest,
  parseStoryActionProposalConfirmRequest,
} from './storyService.js'
import type {
  ApiErrorResponse,
  HealthResponse,
  StoryConflictCoreContextPrefill,
  StoryConflictCoreSystemDraft,
  StoryDirectionsResponse,
  StoryPredicamentResponse,
  StoryGenerationResponse,
  StoryHeadTailResponse,
  StoryTurnResponse,
  StoryCoCreationResponse,
  StoryCurveMutationResponse,
  StoryCurveConfirmationResponse,
  StoryCurveSpineResponse,
  StorySessionSnapshot,
  StoryActionProposalResponse,
  StoryModelFailureDiagnostic,
} from '../../shared/story-contract.js'

const app = express()
const port = Number.parseInt(process.env.PORT ?? '8787', 10)

app.disable('x-powered-by')
app.use(express.json({ limit: '64kb' }))

app.get('/health', (_request, response: Response<HealthResponse>) => {
  const health: HealthResponse = {
    ok: true,
    model: process.env.QWEN_MODEL?.trim() || 'qwen-plus',
    configured: Boolean(process.env.DASHSCOPE_API_KEY?.trim()),
  }

  response.json(health)
})

app.get('/api/story/session/:storyId', (request, response: Response<StorySessionSnapshot>, next) => {
  try {
    response.setHeader('Cache-Control', 'no-store')
    response.json(getStorySessionSnapshot(request.params.storyId))
  } catch (error) {
    next(error)
  }
})

registerStoryStage(
  '/api/story-directions',
  parseDirectionRequest,
  generateDirections,
  (result) => result satisfies StoryDirectionsResponse,
)

registerStoryStage(
  '/api/story/co-create/start',
  parseStoryCoCreationStartRequest,
  startStoryCoCreation,
  (result) => result satisfies StoryCoCreationResponse,
)

registerStoryStage(
  '/api/story/curve/beat',
  parseStoryCurveBeatUpdateRequest,
  updateSessionCurveBeat,
  (result) => result satisfies StoryCurveMutationResponse,
)

registerStoryStage(
  '/api/story/preparation/accept',
  parseStoryPreparationAcceptanceRequest,
  acceptSessionPreparation,
  (result) => result satisfies StoryCurveMutationResponse,
)

registerStoryStage('/api/story/preparation/revise', parseStoryPreparationRevisionRequest, reviseSessionPreparation,
  (result) => result satisfies StoryCurveMutationResponse)
registerStoryStage('/api/story/preparation/story-directions', parseStoryPreparationAcceptanceRequest, suggestSessionStoryDirections,
  (result) => result)
registerStoryStage('/api/story/preparation/suggest-goal', parseStoryPreparationSuggestionRequest, suggestSessionPreparationGoal,
  (result) => result satisfies { suggestion: string })
registerStoryStage('/api/story/preparation/explanation', parseStoryPreparationExplanationRequest, suggestSessionPreparationExplanation,
  (result) => result)
registerStoryStage('/api/story/preparation/supplement', parseStoryPreparationSupplementRequest, reviewSessionPreparationSupplement,
  (result) => result satisfies StoryCurveMutationResponse)

registerStoryStage(
  '/api/story/curve/beat/regenerate',
  parseStoryCurveBeatRegenerationRequest,
  regenerateSessionCurveBeat,
  (result) => result satisfies StoryCurveMutationResponse,
)

registerStoryStage(
  '/api/story/curve/beat/reject',
  parseStoryCurveBeatRejectRequest,
  rejectSessionCurveBeat,
  (result) => result satisfies StoryCurveMutationResponse,
)

registerStoryStage(
  '/api/story/curve/regenerate-affected',
  parseStoryCurveDependenciesRegenerationRequest,
  regenerateSessionCurveDependencies,
  (result) => result satisfies StoryCurveMutationResponse,
)

registerStoryStage(
  '/api/story/curve/regenerate-affected/resolve',
  parseStoryCurveRegenerationResolutionRequest,
  resolveSessionCurveDependencies,
  (result) => result satisfies StoryCurveMutationResponse,
)

registerStoryStage(
  '/api/story/curve/source-fact',
  parseStorySourceFactDispositionRequest,
  updateSessionSourceFactDisposition,
  (result) => result satisfies StoryCurveMutationResponse,
)

registerStoryStage(
  '/api/story/curve/clarification',
  parseStoryAuthorClarificationRequest,
  updateSessionCurveClarification,
  (result) => result satisfies StoryCurveMutationResponse,
)

registerStoryStage(
  '/api/story/curve/confirm',
  parseStoryCurveConfirmRequest,
  confirmSessionCurve,
  (result) => result satisfies StoryCurveConfirmationResponse,
)

registerStoryStage(
  '/api/story/curve/start-spine',
  parseStoryCurveStartSpineRequest,
  startSessionStorySpineFromCurve,
  (result) => result satisfies StoryCurveSpineResponse,
)

registerStoryStage(
  '/api/story/curve/version/select',
  parseStoryCurveVersionSelectionRequest,
  selectSessionCurveVersion,
  (result) => result satisfies StorySessionSnapshot,
)

registerStoryStage(
  '/api/story/author-instruction',
  parseStoryAuthorInstructionRequest,
  applySessionAuthorInstruction,
  (result) => result satisfies StoryCurveMutationResponse,
)

registerStoryStage(
  '/api/story/action-proposal',
  parseStoryActionProposalRequest,
  createSessionStoryActionProposal,
  (result) => result satisfies StoryActionProposalResponse,
)

registerStoryStage(
  '/api/story/action-proposal/confirm',
  parseStoryActionProposalConfirmRequest,
  confirmSessionStoryActionProposal,
  (result) => result satisfies StoryTurnResponse,
)

registerStoryStage(
  '/api/story-predicament',
  parsePredicamentSessionRequest,
  generateSessionPredicament,
  (result) => result satisfies StoryPredicamentResponse,
)

registerStoryStage(
  '/api/story-head-tail',
  parseHeadTailSessionRequest,
  generateSessionHeadTailOptions,
  (result) => result satisfies StoryHeadTailResponse,
)

registerStoryStage(
  '/api/story-spine/turn',
  parseStoryTurnSessionRequest,
  generateSessionStoryTurn,
  (result) => result satisfies StoryTurnResponse,
)

registerStoryStage(
  '/api/story-spine/turn-option/refine',
  parseStoryTurnOptionRefinementRequest,
  generateSessionStoryTurnOptionRefinement,
  (result) => result satisfies StoryTurnResponse,
)

registerStoryStage(
  '/api/stories/generate',
  parseStoryGenerationSessionRequest,
  generateSessionStory,
  (result) => result satisfies StoryGenerationResponse,
)

registerStoryStage('/api/story/writing', parseStoryWritingRequest, updateSessionWriting, result => result)

app.use((_request, response: Response<ApiErrorResponse>) => {
  sendApiError(response, 404, 'NOT_FOUND', '没有找到这个接口。')
})

app.use((error: unknown, _request: Request, response: Response<ApiErrorResponse>, _next: NextFunction) => {
  if (error instanceof AppError) {
    sendApiError(
      response,
      error.statusCode,
      error.code,
      error.message,
      error.conflictCoreContextPrefill,
      error.systemDraftPrefill,
      toPublicModelDiagnostic(error.modelDiagnostic),
    )
    return
  }

  const bodyErrorStatus = getBodyErrorStatus(error)
  if (bodyErrorStatus === 400) {
    sendApiError(response, 400, 'INVALID_REQUEST', '请求内容必须是有效的 JSON。')
    return
  }

  if (bodyErrorStatus === 413) {
    sendApiError(response, 413, 'PAYLOAD_TOO_LARGE', '请求内容过大，请缩短后重试。')
    return
  }

  console.error('Unexpected API error', error)
  sendApiError(response, 500, 'INTERNAL_ERROR', '服务暂时无法处理请求，请稍后重试。')
})

app.listen(port, () => {
  console.log(`Story API listening on http://127.0.0.1:${port}`)
})

function sendApiError(
  response: Response<ApiErrorResponse>,
  statusCode: number,
  code: string,
  message: string,
  conflictCoreContextPrefill?: StoryConflictCoreContextPrefill,
  systemDraftPrefill?: StoryConflictCoreSystemDraft,
  diagnostic?: StoryModelFailureDiagnostic,
) {
  response.status(statusCode).json({
    error: {
      code,
      message,
      ...(diagnostic ? { diagnostic } : {}),
      ...(conflictCoreContextPrefill ? { conflictCoreContextPrefill } : {}),
      ...(systemDraftPrefill ? { systemDraftPrefill } : {}),
    },
  } satisfies ApiErrorResponse)
}

function toPublicModelDiagnostic(
  diagnostic: AppError['modelDiagnostic'],
): StoryModelFailureDiagnostic | undefined {
  if (!diagnostic) return undefined
  // ModelFailureDiagnostic is already safe internally, but copy only the
  // documented scalar/shape fields before returning it to a browser client.
  const response = diagnostic.response
    ? {
        kind: diagnostic.response.kind,
        ...(diagnostic.response.topLevelKeys ? { topLevelKeys: diagnostic.response.topLevelKeys.slice(0, 24) } : {}),
        ...(diagnostic.response.fieldShapes ? { fieldShapes: { ...diagnostic.response.fieldShapes } } : {}),
        ...(diagnostic.response.model ? { model: diagnostic.response.model } : {}),
        ...(diagnostic.response.finishReason ? { finishReason: diagnostic.response.finishReason } : {}),
        ...(diagnostic.response.usageKeys ? { usageKeys: diagnostic.response.usageKeys.slice(0, 16) } : {}),
        ...(diagnostic.response.choicesCount === undefined ? {} : { choicesCount: diagnostic.response.choicesCount }),
        ...(diagnostic.response.firstChoiceKeys ? { firstChoiceKeys: diagnostic.response.firstChoiceKeys.slice(0, 24) } : {}),
        ...(diagnostic.response.contentType ? { contentType: diagnostic.response.contentType } : {}),
        ...(diagnostic.response.contentLength === undefined ? {} : { contentLength: diagnostic.response.contentLength }),
        ...(diagnostic.response.errorKeys ? { errorKeys: diagnostic.response.errorKeys.slice(0, 12) } : {}),
      }
    : undefined
  return {
    stage: diagnostic.stage,
    ...(diagnostic.attempt === undefined ? {} : { attempt: diagnostic.attempt }),
    ...(diagnostic.maxAttempts === undefined ? {} : { maxAttempts: diagnostic.maxAttempts }),
    ...(diagnostic.httpStatus === undefined ? {} : { httpStatus: diagnostic.httpStatus }),
    ...(diagnostic.responseFormat === undefined ? {} : { responseFormat: diagnostic.responseFormat }),
    ...(diagnostic.reason ? { reason: diagnostic.reason.slice(0, 240) } : {}),
    ...(response ? { response } : {}),
  }
}

function registerStoryStage<RequestBody, Result, ResponseBody>(
  path: string,
  parseRequest: (body: unknown) => RequestBody,
  generate: (request: RequestBody) => Promise<Result>,
  createResponse: (result: Result) => ResponseBody,
) {
  app.post(path, async (request, response: Response<ResponseBody>, next) => {
    try {
      const parsedRequest = parseRequest(request.body)
      const result = await withConfiguredQwenRequestBudget(() => generate(parsedRequest))
      response.setHeader('Cache-Control', 'no-store')
      response.json(createResponse(result))
    } catch (error) {
      next(error)
    }
  })
}

function getBodyErrorStatus(error: unknown): 400 | 413 | undefined {
  if (typeof error !== 'object' || error === null) return undefined

  const status = 'status' in error ? error.status : undefined
  if (status === 400 || status === 413) return status

  const statusCode = 'statusCode' in error ? error.statusCode : undefined
  return statusCode === 400 || statusCode === 413 ? statusCode : undefined
}
