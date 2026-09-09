import 'dotenv/config'
import express, { type NextFunction, type Request, type Response } from 'express'
import { AppError } from './qwen.js'
import {
  generateDirections,
  parseDirectionRequest,
  parseHeadTailSessionRequest,
  parseStoryGenerationSessionRequest,
  parseStoryTurnSessionRequest,
  generateSessionHeadTailOptions,
  generateSessionStory,
  generateSessionStoryTurn,
} from './storyService.js'
import type {
  ApiErrorResponse,
  HealthResponse,
  StoryDirectionsResponse,
  StoryGenerationResponse,
  StoryHeadTailResponse,
  StoryTurnResponse,
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

registerStoryStage(
  '/api/story-directions',
  parseDirectionRequest,
  generateDirections,
  (result) => result satisfies StoryDirectionsResponse,
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
  '/api/stories/generate',
  parseStoryGenerationSessionRequest,
  generateSessionStory,
  (result) => result satisfies StoryGenerationResponse,
)

app.use((_request, response: Response<ApiErrorResponse>) => {
  sendApiError(response, 404, 'NOT_FOUND', '没有找到这个接口。')
})

app.use((error: unknown, _request: Request, response: Response<ApiErrorResponse>, _next: NextFunction) => {
  if (error instanceof AppError) {
    sendApiError(response, error.statusCode, error.code, error.message)
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

function sendApiError(response: Response<ApiErrorResponse>, statusCode: number, code: string, message: string) {
  response.status(statusCode).json({ error: { code, message } } satisfies ApiErrorResponse)
}

function registerStoryStage<RequestBody, Result, ResponseBody>(
  path: string,
  parseRequest: (body: unknown) => RequestBody,
  generate: (request: RequestBody) => Promise<Result>,
  createResponse: (result: Result) => ResponseBody,
) {
  app.post(path, async (request, response: Response<ResponseBody>, next) => {
    try {
      const result = await generate(parseRequest(request.body))
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
