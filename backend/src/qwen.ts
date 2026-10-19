import { AsyncLocalStorage } from 'node:async_hooks'
import { outputShapeErrors, type OutputSchema } from './modelOutputSchema.js'
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
    const modelDiagnostic = ['QWEN_REQUEST_BUDGET_EXHAUSTED', 'QWEN_OUTPUT_SCHEMA_FAILED', 'QWEN_OUTPUT_SCHEMA_UNSUPPORTED'].includes(error.code)
      ? {
          ...diagnostic,
          ...error.modelDiagnostic,
          response: error.modelDiagnostic?.response ?? diagnostic.response,
        }
      : {
          ...error.modelDiagnostic,
          ...diagnostic,
          response: error.modelDiagnostic?.response ?? diagnostic.response,
        }
    return new AppError(
      error.message,
      error.statusCode,
      error.code,
      error.conflictCoreContextPrefill,
      error.systemDraftPrefill,
      error.retryAfterMs,
      modelDiagnostic,
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
const defaultRequestTimeoutMs = 90_000
const defaultQwenRequestAttempts = 2
const QWEN_RETRY_BASE_DELAY_MS = 700
const QWEN_RETRY_MAX_DELAY_MS = 5_000

interface QwenRequestBudget {
  remaining: number
  maximum: number
  parent?: QwenRequestBudget
}

// A model workflow can issue more than one request through retries, format
// fallback, or a later recovery step. Keep an optional budget in async-local
// state so an HTTP request can cap all of those paths together.
const qwenRequestBudgetStorage = new AsyncLocalStorage<QwenRequestBudget>()

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
  max_tokens?: number
  response_format?: { type: 'json_object' } | { type: 'json_schema'; json_schema: { name: string; strict: true; schema: OutputSchema } }
  enable_thinking?: boolean
}

interface QwenCompletionOptions {
  systemPrompt: string
  userPrompt: string
  temperature?: number
  maxTokens?: number | null
  diagnosticStage?: string
  outputSchema?: OutputSchema
}

export async function requestQwenJson({
  systemPrompt,
  userPrompt,
  temperature = 0.8,
  maxTokens = 2_500,
  diagnosticStage = 'qwen-json',
  outputSchema,
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
    ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
    response_format: outputSchema ? { type: 'json_schema', json_schema: {
      name: diagnosticStage.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64), strict: true, schema: outputSchema,
    } } : { type: 'json_object' },
  }
  // qwen-plus JSON Object mode is documented for non-thinking generation.
  // Do not silently change mode while the workflow expects parseable JSON.
  if (/^qwen-plus(?:$|-latest$|-\d{4}-)/u.test(request.model)) request.enable_thinking = false
  const requestAttempts = defaultQwenRequestAttempts

  try {
    let output = await sendRequestWithRetry(request, apiKey, diagnosticStage, requestAttempts)
    if (!outputSchema) return output
    // A compatible gateway may accept a schema without actually enforcing it.
    // Validate here as well; one format repair never becomes a story verdict.
    for (let pass = 0; pass < 2; pass++) {
      const errors = outputShapeErrors(output, outputSchema)
      if (!errors.length) return output
      if (pass) throw new AppError('千问输出仍不符合当前步骤的字段结构，请重试；这不是作者资料不足或因果不成立。',
        502, 'QWEN_OUTPUT_SCHEMA_FAILED', undefined, undefined, undefined,
        { stage: `${diagnosticStage}:response-schema`, attempt: 2, maxAttempts: 2, reason: errors.join('；') })
      let originalTask: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(userPrompt)
        originalTask = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown> : { originalTask: userPrompt }
      } catch { originalTask = { originalTask: userPrompt } }
      output = await sendRequestWithRetry({ ...request, temperature: 0.1,
        messages: [request.messages[0]!, { role: 'user', content: JSON.stringify({ ...originalTask,
          previousOutput: output, validationFailure: errors.join('；'),
          formatRepair: { instruction: '只纠正当前步骤的输出结构，返回完整JSON。字段须独立，数组不是字符串，保留结构正确部分，不补作者事实、引用或故事条件。',
            outputSchema } }) }],
      }, apiKey, `${diagnosticStage}:format-repair`, requestAttempts)
    }
    return output
  } catch (error) {
    if (outputSchema && error instanceof AppError && error.code === 'QWEN_REQUEST_ERROR'
      && /schema|response[_\s-]?format/i.test(error.message)) {
      throw new AppError('当前千问模型或网关不支持本步骤的结构化输出约束；未降级为无结构生成。',
        502, 'QWEN_OUTPUT_SCHEMA_UNSUPPORTED', undefined, undefined, undefined, error.modelDiagnostic)
    }
    if (
      !outputSchema &&
      !isQwenResponseFormatFallbackDisabled()
      &&
      error instanceof AppError
      && error.code === 'QWEN_REQUEST_ERROR'
      && /response[_\s-]?format/i.test(error.message)
    ) {
      const { response_format: _responseFormat, ...fallbackRequest } = request
      return sendRequestWithRetry(fallbackRequest, apiKey, `${diagnosticStage}:without-response-format`, requestAttempts)
    }

    throw error
  }
}

/**
 * Apply the optional diagnostic request budget to one API operation. The
 * budget is intentionally inactive unless the environment variable is set,
 * so normal production retries retain their existing behavior.
 */
export async function withConfiguredQwenRequestBudget<T>(operation: () => Promise<T>): Promise<T> {
  const maximumRequests = getConfiguredQwenRequestBudget()
  if (maximumRequests === undefined) return operation()
  return withQwenRequestBudget(maximumRequests, operation)
}

/** Exposed for service-level tests that need to verify a full workflow cap. */
export async function withQwenRequestBudget<T>(
  maximumRequests: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1) return operation()
  return qwenRequestBudgetStorage.run({ remaining: maximumRequests, maximum: maximumRequests, parent: qwenRequestBudgetStorage.getStore() }, operation)
}

/**
 * Local real-model diagnostics can deliberately lower this cap without
 * changing production retry behavior. The value is capped at the source
 * default so an environment variable can never make a request retry more.
 */
export function getConfiguredModelOutputAttemptLimit(defaultAttempts: number): number {
  // The explicit local-model mode has no upstream output to retry. Preserve
  // its deterministic repair path so contract E2E remains a test of the
  // offline fallback contract, not of real-model diagnostic limits.
  if (/^(?:1|true|yes)$/iu.test(process.env.STORY_DISABLE_MODEL?.trim() ?? '')) return defaultAttempts
  return getPositiveIntegerEnvironmentValue('STORY_MODEL_OUTPUT_ATTEMPTS', defaultAttempts, defaultAttempts)
}

function getConfiguredQwenRequestBudget(): number | undefined {
  return getOptionalPositiveIntegerEnvironmentValue('STORY_QWEN_REQUEST_ATTEMPTS')
}

function getRequestTimeoutMs(): number {
  return getPositiveIntegerEnvironmentValue('STORY_QWEN_REQUEST_TIMEOUT_MS', defaultRequestTimeoutMs, defaultRequestTimeoutMs)
}

function isQwenResponseFormatFallbackDisabled(): boolean {
  return /^(?:1|true|yes)$/iu.test(process.env.STORY_QWEN_DISABLE_RESPONSE_FORMAT_FALLBACK?.trim() ?? '')
}

function getPositiveIntegerEnvironmentValue(name: string, fallback: number, maximum: number): number {
  const parsed = getOptionalPositiveIntegerEnvironmentValue(name)
  return parsed === undefined ? fallback : Math.min(parsed, maximum)
}

function getOptionalPositiveIntegerEnvironmentValue(name: string): number | undefined {
  const value = process.env[name]?.trim()
  if (!value || !/^[1-9]\d*$/u.test(value)) return undefined

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

async function sendRequestWithRetry(
  request: QwenRequest,
  apiKey: string,
  diagnosticStage: string,
  maximumAttempts: number,
): Promise<unknown> {
  let lastError: unknown

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      consumeQwenRequestBudget(diagnosticStage)
      return await sendRequest(request, apiKey)
    } catch (error) {
      // The budget error already identifies the precise blocked call (for
      // example, the response_format fallback). Do not overwrite that stage
      // with the enclosing transport attempt diagnostic.
      const enrichedError = error instanceof AppError && error.code === 'QWEN_REQUEST_BUDGET_EXHAUSTED'
        ? error
        : attachModelDiagnostic(error, {
          stage: diagnosticStage,
          attempt: attempt + 1,
          maxAttempts: maximumAttempts,
          responseFormat: Boolean(request.response_format),
        })
      lastError = enrichedError
      logModelFailure(enrichedError)
      if (!isRetryableQwenRequestError(enrichedError) || attempt === maximumAttempts - 1) {
        throw enrichedError
      }

      const retryDelayMs = getQwenRetryDelayMs(enrichedError, attempt)
      if (retryDelayMs === undefined) throw enrichedError

      await waitForRetry(retryDelayMs)
    }
  }

  throw lastError ?? new AppError('Qwen 请求没有完成，请稍后重试。', 502, 'QWEN_UPSTREAM_ERROR')
}

function consumeQwenRequestBudget(diagnosticStage: string): void {
  const budgets: QwenRequestBudget[] = []
  for (let current = qwenRequestBudgetStorage.getStore(); current; current = current.parent) budgets.push(current)
  const budget = budgets.find(current => current.remaining <= 0)
  if (budget) {
    throw new AppError(
      '本次 API 请求已达到模型上游调用上限，请稍后重试。',
      429,
      'QWEN_REQUEST_BUDGET_EXHAUSTED',
      undefined,
      undefined,
      undefined,
      {
        stage: `${diagnosticStage}:request-budget`,
        attempt: budget.maximum,
        maxAttempts: budget.maximum,
        reason: '已在同一 API 请求中用尽模型上游调用预算。',
      },
    )
  }

  // A local single-call limit must not reset the enclosing API request cap.
  for (const current of budgets) current.remaining -= 1
}

async function sendRequest(request: QwenRequest, apiKey: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), getRequestTimeoutMs())

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
    if (responseSummary.finishReason === 'length') {
      throw new AppError('千问输出达到长度上限，结果被截断；请调整当前步骤的输出预算后重试。', 502, 'QWEN_OUTPUT_TRUNCATED',
        undefined, undefined, undefined, { stage: 'qwen-output', response: responseSummary })
    }
    const content = getMessageContent(responseBody)
    return parseModelJson(content, responseSummary)
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
