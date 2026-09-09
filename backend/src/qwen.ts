export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
const REQUEST_TIMEOUT_MS = 90_000

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
}

export async function requestQwenJson({
  systemPrompt,
  userPrompt,
  temperature = 0.8,
  maxTokens = 2_500,
}: QwenCompletionOptions): Promise<unknown> {
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
    return await sendRequest(request, apiKey)
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 400 && error.message.includes('response_format')) {
      const { response_format: _responseFormat, ...fallbackRequest } = request
      return sendRequest(fallbackRequest, apiKey)
    }

    throw error
  }
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
      throw createQwenError(response.status, responseBody)
    }

    return parseModelJson(getMessageContent(responseBody))
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

function createQwenError(statusCode: number, responseBody: unknown): AppError {
  if (statusCode === 401 || statusCode === 403) {
    return new AppError('Qwen API Key 无效或没有调用权限。', 502, 'QWEN_AUTH_ERROR')
  }

  if (statusCode === 429) {
    return new AppError('Qwen 当前请求较多，请稍后重试。', 429, 'QWEN_RATE_LIMITED')
  }

  const upstreamMessage = getErrorMessage(responseBody)
  return new AppError(upstreamMessage || 'Qwen 暂时无法生成内容，请稍后重试。', 502, 'QWEN_UPSTREAM_ERROR')
}

function getMessageContent(responseBody: unknown): string {
  if (!isRecord(responseBody)) {
    throw new AppError('Qwen 返回了无法读取的内容，请重试。', 502, 'QWEN_INVALID_RESPONSE')
  }

  const choices = responseBody.choices
  if (!Array.isArray(choices) || !isRecord(choices[0]) || !isRecord(choices[0].message)) {
    throw new AppError('Qwen 没有返回可用内容，请重试。', 502, 'QWEN_EMPTY_RESPONSE')
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

  throw new AppError('Qwen 没有返回可用内容，请重试。', 502, 'QWEN_EMPTY_RESPONSE')
}

function parseModelJson(content: string): unknown {
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

    throw new AppError('Qwen 返回的格式不完整，请重试生成。', 502, 'QWEN_INVALID_JSON')
  }
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
