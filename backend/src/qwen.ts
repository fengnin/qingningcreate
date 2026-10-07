import type {
  StoryConflictCoreContextPrefill,
  StoryConflictCoreSystemDraft,
} from '../../shared/story-contract.js'

export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly conflictCoreContextPrefill?: StoryConflictCoreContextPrefill,
    public readonly systemDraftPrefill?: StoryConflictCoreSystemDraft,
    public readonly retryAfterMs?: number,
    public readonly modelDiagnostic?: ModelFailureDiagnostic,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/**
 * Safe, server-side-only information about a failed model request.  It is
 * deliberately limited to shape and transport metadata; prompts, API keys and
 * raw model text must never be copied into this object.
 */
export interface ModelResponseSummary {
  kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'undefined'
  topLevelKeys?: string[]
  fieldShapes?: Record<string, string>
  model?: string
  finishReason?: string
  usageKeys?: string[]
  choicesCount?: number
  firstChoiceKeys?: string[]
  contentType?: string
  contentLength?: number
  errorKeys?: string[]
}

export interface ModelFailureDiagnostic {
  stage: string
  attempt?: number
  maxAttempts?: number
  httpStatus?: number
  responseFormat?: boolean
  reason?: string
  response?: ModelResponseSummary
}

/**
 * Add a safe validation-stage diagnostic without copying model content into
 * logs or API errors. Callers use this when JSON is parseable but fails a
 * domain contract after the transport layer has already succeeded.
 */
export function withModelDiagnostic(
  error: unknown,
  diagnostic: ModelFailureDiagnostic,
): AppError {
  if (error instanceof AppError) {
    return new AppError(
      error.message,
      error.statusCode,
      error.code,
      error.conflictCoreContextPrefill,
      error.systemDraftPrefill,
      error.retryAfterMs,
      { ...error.modelDiagnostic, ...diagnostic, response: error.modelDiagnostic?.response ?? diagnostic.response },
    )
  }

  return new AppError(
    '模型返回内容未通过结构校验，请重试。',
    502,
    'INVALID_MODEL_OUTPUT',
    undefined,
    undefined,
    undefined,
    diagnostic,
  )
}

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
const REQUEST_TIMEOUT_MS = 90_000
const MAX_QWEN_REQUEST_ATTEMPTS = 2
const QWEN_RETRY_BASE_DELAY_MS = 700
const QWEN_RETRY_MAX_DELAY_MS = 5_000

const retryableQwenRequestErrorCodes = new Set([
  'QWEN_EMPTY_RESPONSE',
  'QWEN_INVALID_JSON',
  'QWEN_INVALID_RESPONSE',
  'QWEN_NETWORK_ERROR',
  'QWEN_RATE_LIMITED',
  'QWEN_TIMEOUT',
  'QWEN_UPSTREAM_ERROR',
])

interface QwenMessage {
  role: 'system' | 'user'
  content: string
}

interface QwenRequest {
  model: string
  messages: QwenMessage[]
  temperature: number
  max_tokens: number
  response_format?: { type: 'json_object' }
}

interface QwenCompletionOptions {
  systemPrompt: string
  userPrompt: string
  temperature?: number
  maxTokens?: number
  diagnosticStage?: string
}

export async function requestQwenJson({
  systemPrompt,
  userPrompt,
  temperature = 0.8,
  maxTokens = 2_500,
  diagnosticStage = 'qwen-json',
}: QwenCompletionOptions): Promise<unknown> {
  // Keep local contract and end-to-end checks deterministic without requiring
  // network access. Production behavior is unchanged unless this explicit
  // diagnostic switch is enabled.
  if (/^(?:1|true|yes)$/iu.test(process.env.STORY_DISABLE_MODEL?.trim() ?? '')) {
    throw new AppError('当前已关闭模型调用，系统将使用可追溯的本地结构草案。', 503, 'QWEN_NOT_CONFIGURED')
  }
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim()

  if (!apiKey) {
    throw new AppError('尚未配置 Qwen API Key。请在 backend/.env 中设置 DASHSCOPE_API_KEY。', 503, 'QWEN_NOT_CONFIGURED')
  }

  const request: QwenRequest = {
    model: process.env.QWEN_MODEL?.trim() || 'qwen-plus',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  }

  try {
    return await sendRequestWithRetry(request, apiKey, diagnosticStage)
  } catch (error) {
    if (
      error instanceof AppError
      && error.code === 'QWEN_REQUEST_ERROR'
      && /response[_\s-]?format/i.test(error.message)
    ) {
      const { response_format: _responseFormat, ...fallbackRequest } = request
      return sendRequestWithRetry(fallbackRequest, apiKey, `${diagnosticStage}:without-response-format`)
    }

    throw error
  }
}

async function sendRequestWithRetry(request: QwenRequest, apiKey: string, diagnosticStage: string): Promise<unknown> {
  let lastError: unknown

  for (let attempt = 0; attempt < MAX_QWEN_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await sendRequest(request, apiKey)
    } catch (error) {
      const enrichedError = attachModelDiagnostic(error, {
        stage: diagnosticStage,
        attempt: attempt + 1,
        maxAttempts: MAX_QWEN_REQUEST_ATTEMPTS,
        responseFormat: Boolean(request.response_format),
      })
      lastError = enrichedError
      logModelFailure(enrichedError)
      if (!isRetryableQwenRequestError(enrichedError) || attempt === MAX_QWEN_REQUEST_ATTEMPTS - 1) {
        throw enrichedError
      }

      const retryDelayMs = getQwenRetryDelayMs(enrichedError, attempt)
      if (retryDelayMs === undefined) throw enrichedError

      await waitForRetry(retryDelayMs)
    }
  }

  throw lastError ?? new AppError('Qwen 请求没有完成，请稍后重试。', 502, 'QWEN_UPSTREAM_ERROR')
}

async function sendRequest(request: QwenRequest, apiKey: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(process.env.DASHSCOPE_BASE_URL?.trim() || DEFAULT_BASE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
    const responseBody = await readResponseBody(response)

    if (!response.ok) {
      throw createQwenError(
        response.status,
        responseBody,
        getRetryAfterMs(response.headers.get('retry-after')),
        summarizeModelResponse(responseBody),
      )
    }

    const responseSummary = summarizeModelResponse(responseBody)
    return parseModelJson(getMessageContent(responseBody), responseSummary)
  } catch (error) {
    if (error instanceof AppError) throw error

    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AppError('Qwen 响应超时，请稍后重试。', 504, 'QWEN_TIMEOUT')
    }

    throw new AppError('无法连接 Qwen 服务，请检查网络后重试。', 502, 'QWEN_NETWORK_ERROR')
  } finally {
    clearTimeout(timeout)
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function createQwenError(
  statusCode: number,
  responseBody: unknown,
  retryAfterMs?: number,
  response?: ModelResponseSummary,
): AppError {
  if (statusCode === 401 || statusCode === 403) {
    return new AppError('Qwen API Key 无效或没有调用权限。', 502, 'QWEN_AUTH_ERROR', undefined, undefined, undefined, {
      stage: 'qwen-upstream',
      httpStatus: statusCode,
      response,
    })
  }

  if (statusCode === 429) {
    return new AppError(
      'Qwen 当前请求较多，请稍后重试。',
      429,
      'QWEN_RATE_LIMITED',
      undefined,
      undefined,
      retryAfterMs,
      { stage: 'qwen-upstream', httpStatus: statusCode, response },
    )
  }

  const upstreamMessage = getErrorMessage(responseBody)
  if (statusCode === 408 || statusCode === 409 || statusCode >= 500) {
    return new AppError(
      upstreamMessage || 'Qwen 暂时无法生成内容，请稍后重试。',
      502,
      'QWEN_UPSTREAM_ERROR',
      undefined,
      undefined,
      retryAfterMs,
      { stage: 'qwen-upstream', httpStatus: statusCode, response },
    )
  }

  return new AppError(
    upstreamMessage || 'Qwen 拒绝了本次请求，请检查模型和服务配置。',
    502,
    'QWEN_REQUEST_ERROR',
    undefined,
    undefined,
    undefined,
    { stage: 'qwen-upstream', httpStatus: statusCode, response },
  )
}

function isRetryableQwenRequestError(error: unknown): error is AppError {
  return error instanceof AppError && retryableQwenRequestErrorCodes.has(error.code)
}

function getQwenRetryDelayMs(error: AppError, attempt: number): number | undefined {
  if (typeof error.retryAfterMs === 'number') {
    return error.retryAfterMs <= QWEN_RETRY_MAX_DELAY_MS ? Math.max(error.retryAfterMs, 0) : undefined
  }

  return Math.min(QWEN_RETRY_BASE_DELAY_MS * 2 ** attempt, QWEN_RETRY_MAX_DELAY_MS)
}

function getRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000

  const retryAt = Date.parse(value)
  if (Number.isNaN(retryAt)) return undefined

  return Math.max(retryAt - Date.now(), 0)
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function getMessageContent(responseBody: unknown): string {
  if (!isRecord(responseBody)) {
    throw new AppError('Qwen 返回了无法读取的内容，请重试。', 502, 'QWEN_INVALID_RESPONSE', undefined, undefined, undefined, {
      stage: 'qwen-response-shape',
      response: summarizeModelResponse(responseBody),
    })
  }

  const choices = responseBody.choices
  if (!Array.isArray(choices) || !isRecord(choices[0]) || !isRecord(choices[0].message)) {
    throw new AppError('Qwen 没有返回可用内容，请重试。', 502, 'QWEN_EMPTY_RESPONSE', undefined, undefined, undefined, {
      stage: 'qwen-response-shape',
      response: summarizeModelResponse(responseBody),
    })
  }

  const content = choices[0].message.content
  if (typeof content === 'string' && content.trim()) return content

  if (Array.isArray(content)) {
    const joinedContent = content
      .filter(isRecord)
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim()

    if (joinedContent) return joinedContent
  }

  throw new AppError('Qwen 没有返回可用内容，请重试。', 502, 'QWEN_EMPTY_RESPONSE', undefined, undefined, undefined, {
    stage: 'qwen-response-content',
    response: summarizeModelResponse(responseBody),
  })
}

function parseModelJson(content: string, response?: ModelResponseSummary): unknown {
  const cleanedContent = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')

  try {
    return JSON.parse(cleanedContent) as unknown
  } catch {
    const firstBrace = cleanedContent.indexOf('{')
    const lastBrace = cleanedContent.lastIndexOf('}')

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleanedContent.slice(firstBrace, lastBrace + 1)) as unknown
      } catch {
        // The request prompt requires JSON. Return a controlled error instead of leaking raw model output.
      }
    }

    throw new AppError('Qwen 返回的格式不完整，请重试生成。', 502, 'QWEN_INVALID_JSON', undefined, undefined, undefined, {
      stage: 'qwen-json-parse',
      response: {
        ...response,
        kind: 'string',
        contentType: 'string',
        contentLength: content.length,
      },
    })
  }
}

export function summarizeModelResponse(value: unknown): ModelResponseSummary {
  if (value === null) return { kind: 'null' }
  if (value === undefined) return { kind: 'undefined' }
  if (typeof value === 'string') return { kind: 'string', contentLength: value.length }
  if (typeof value === 'number') return { kind: 'number' }
  if (typeof value === 'boolean') return { kind: 'boolean' }
  if (Array.isArray(value)) return { kind: 'array' }

  const record = value as Record<string, unknown>
  const summary: ModelResponseSummary = {
    kind: 'object',
    topLevelKeys: Object.keys(record).slice(0, 24),
    fieldShapes: Object.fromEntries(
      Object.entries(record)
        .slice(0, 24)
        .map(([key, field]) => [key, describeResponseFieldShape(field)]),
    ),
  }
  if (typeof record.model === 'string' && record.model.trim()) {
    summary.model = record.model.trim().slice(0, 80)
  }
  if (Array.isArray(record.choices)) {
    const firstChoice = record.choices[0]
    if (isRecord(firstChoice) && typeof firstChoice.finish_reason === 'string') {
      summary.finishReason = firstChoice.finish_reason.slice(0, 40)
    }
  }
  if (isRecord(record.usage)) {
    summary.usageKeys = Object.keys(record.usage).slice(0, 16)
  }
  if (Array.isArray(record.choices)) {
    summary.choicesCount = record.choices.length
    const firstChoice = record.choices[0]
    if (isRecord(firstChoice)) {
      summary.firstChoiceKeys = Object.keys(firstChoice).slice(0, 24)
      if (isRecord(firstChoice.message)) {
        const content = firstChoice.message.content
        summary.contentType = Array.isArray(content) ? 'array' : typeof content
        summary.contentLength = typeof content === 'string'
          ? content.length
          : Array.isArray(content)
            ? content.reduce((length, part) => length + (isRecord(part) && typeof part.text === 'string' ? part.text.length : 0), 0)
            : undefined
      }
    }
  }
  if (isRecord(record.error)) summary.errorKeys = Object.keys(record.error).slice(0, 12)
  return summary
}

function describeResponseFieldShape(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'string') return `string(${value.length})`
  if (typeof value === 'object') return 'object'
  return typeof value
}

function attachModelDiagnostic(error: unknown, diagnostic: ModelFailureDiagnostic): AppError {
  return withModelDiagnostic(
    error instanceof AppError
      ? error
      : new AppError('Qwen 请求失败，请稍后重试。', 502, 'QWEN_UPSTREAM_ERROR'),
    diagnostic,
  )
}

function logModelFailure(error: AppError): void {
  if (!error.modelDiagnostic) return
  const diagnostic = {
    ...error.modelDiagnostic,
    code: error.code,
  }
  console.warn(`[qwen] model request failed ${JSON.stringify(diagnostic)}`)
}

function getErrorMessage(responseBody: unknown): string | undefined {
  if (!isRecord(responseBody)) return undefined

  if (isRecord(responseBody.error) && typeof responseBody.error.message === 'string') {
    return responseBody.error.message
  }

  return typeof responseBody.message === 'string' ? responseBody.message : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
