import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const { build } = createRequire(new URL('../../frontend/package.json', import.meta.url))('esbuild')
const output = join(mkdtempSync(join(tmpdir(), 'story-api-errors-')), 'api.mjs')
await build({ entryPoints: [fileURLToPath(new URL('../../frontend/src/story/storyApi.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'node', outfile: output })
const { requestStoryCoCreationStart, StoryApiError } = await import(pathToFileURL(output).href)
const request = { idea: '青柠想去游乐园玩', brief: { tones: [], dramaticForces: [], allowSystemNamedCharacters: false } }

test('transport errors remain distinct from invalid JSON and model errors', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const [status, body, type, code, message] of [
      [500, '', 'text/plain', 'SERVICE_UNAVAILABLE', '后端已启动'],
      [502, '<html>Bad Gateway</html>', 'text/html', 'SERVICE_UNAVAILABLE', '后端已启动'],
      [503, '', 'text/plain', 'SERVICE_UNAVAILABLE', '后端已启动'],
      [504, '', 'text/plain', 'SERVICE_UNAVAILABLE', '后端已启动'],
      [404, '<html>Not Found</html>', 'text/html', 'HTTP_ERROR', 'HTTP 404'],
      [200, '<html>Frontend</html>', 'text/html', 'INVALID_RESPONSE', '无法读取'],
      [200, '', 'application/json', 'INVALID_RESPONSE', '无法读取'],
      [200, '{}', 'application/json', 'INVALID_RESPONSE', '数据不完整'],
      [502, JSON.stringify({ error: { code: 'STORY_PREPARATION_INVALID_OUTPUT', message: '模型内容未通过校验' } }), 'application/json', 'STORY_PREPARATION_INVALID_OUTPUT', '模型内容未通过校验'],
      [409, JSON.stringify({ error: { code: 'STORY_CO_CREATION_WORKFLOW', message: '当前会话不是共创主线工作区' } }), 'application/json', 'STORY_CO_CREATION_WORKFLOW', '当前会话'],
    ]) {
      globalThis.fetch = async () => new Response(body, { status, headers: { 'Content-Type': type } })
      await assert.rejects(requestStoryCoCreationStart(request), error => error instanceof StoryApiError && error.code === code && error.message.includes(message), `${status} ${type}`)
    }
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    await assert.rejects(requestStoryCoCreationStart(request), error => error.code === 'NETWORK_ERROR')
  } finally {
    globalThis.fetch = originalFetch
  }
})
