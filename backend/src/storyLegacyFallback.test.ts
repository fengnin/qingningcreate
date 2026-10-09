import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AppError } from './qwen.js'

const previousEnvironment = {
  store: process.env.STORY_SESSION_STORE_PATH,
  disabled: process.env.STORY_DISABLE_MODEL,
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseUrl: process.env.DASHSCOPE_BASE_URL,
}
const previousFetch = globalThis.fetch
const storePath = join(mkdtempSync(join(tmpdir(), 'story-legacy-fallback-')), 'sessions.json')
process.env.STORY_SESSION_STORE_PATH = storePath
process.env.STORY_DISABLE_MODEL = 'true'
process.env.DASHSCOPE_API_KEY = 'test-only-key'
process.env.DASHSCOPE_BASE_URL = 'https://model.test.invalid'

// The store path is captured when storyService is imported, before any session is created.
const { generateDirections, generateSessionPredicament, generateSessionHeadTailOptions } = await import('./storyService.js')

test.after(() => {
  globalThis.fetch = previousFetch
  for (const [name, value] of Object.entries({
    STORY_SESSION_STORE_PATH: previousEnvironment.store,
    STORY_DISABLE_MODEL: previousEnvironment.disabled,
    DASHSCOPE_API_KEY: previousEnvironment.apiKey,
    DASHSCOPE_BASE_URL: previousEnvironment.baseUrl,
  })) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function storedSession(storyId: string): Record<string, unknown> {
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as { sessions: Array<Record<string, unknown>> }
  const session = store.sessions.find((candidate) => candidate.id === storyId)
  assert.ok(session, 'the isolated store must contain the test session')
  return session
}

function modelResponse(payload: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function rejectedRequest(): Response {
  return new Response(JSON.stringify({ message: 'invalid test key' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function startLegacySession() {
  process.env.STORY_DISABLE_MODEL = 'true'
  const directions = await generateDirections({
    idea: '青柠去游乐园',
    expansionScope: 'keep-scale',
    generateSystemDraft: true,
  })
  assert.equal(directions.seed.systemDraft?.origin, 'deterministic-fallback')
  assert.ok(directions.conflictCores[0])
  return {
    storyId: directions.storyId,
    revision: directions.revision,
    conflictCoreId: directions.conflictCores[0].id,
  }
}

for (const { name, modelFailure, selectedDirection, expectedCode } of [
  {
    name: 'invalid model output without an active direction',
    modelFailure: () => modelResponse({ predicament: {} }),
    selectedDirection: false,
    expectedCode: 'PREDICAMENT_EXPANSION_FAILED',
  },
  {
    name: 'invalid model output with an active direction',
    modelFailure: () => modelResponse({ predicament: {} }),
    selectedDirection: true,
    expectedCode: 'PREDICAMENT_EXPANSION_FAILED',
  },
  {
    name: 'upstream request failure with an active direction',
    modelFailure: rejectedRequest,
    selectedDirection: true,
    expectedCode: 'QWEN_AUTH_ERROR',
  },
]) {
  test(`legacy predicament: ${name} fails closed; explicit local mode remains usable`, async () => {
    const session = await startLegacySession()
    const before = selectedDirection
      ? await generateSessionPredicament(session)
      : undefined
    const request = { ...session, revision: before?.revision ?? session.revision }
    const persistedBefore = structuredClone(storedSession(session.storyId))
    let calls = 0

    try {
      process.env.STORY_DISABLE_MODEL = 'false'
      globalThis.fetch = async () => {
        calls += 1
        return modelFailure()
      }
      await assert.rejects(
        () => generateSessionPredicament(request),
        (error: unknown) => error instanceof AppError
          && error.code === expectedCode
          && error.statusCode === 502,
      )
      assert.ok(calls > 0, 'real model mode must make an upstream request')
      assert.deepEqual(storedSession(session.storyId), persistedBefore, 'failure must not write success state')

      process.env.STORY_DISABLE_MODEL = 'true'
      globalThis.fetch = async () => { throw new Error('explicit local mode must not call the model') }
      const local = await generateSessionPredicament(request)
      assert.equal(local.revision, request.revision + 1)
      assert.equal(local.predicament.id, 'predicament-1')
      assert.equal(storedSession(session.storyId).revision, local.revision)
      assert.equal((storedSession(session.storyId).seed as { systemDraft?: { origin?: string } }).systemDraft?.origin, 'deterministic-fallback')
    } finally {
      process.env.STORY_DISABLE_MODEL = 'true'
      globalThis.fetch = previousFetch
    }
  })
}

for (const { name, modelFailure, expectedCode } of [
  {
    name: 'invalid model output',
    modelFailure: () => modelResponse({ options: [] }),
    expectedCode: 'HEAD_TAIL_FIDELITY_FAILED',
  },
  {
    name: 'upstream request failure',
    modelFailure: rejectedRequest,
    expectedCode: 'QWEN_AUTH_ERROR',
  },
]) {
  test(`legacy head-tail: ${name} fails closed; explicit local mode remains usable`, async () => {
    const session = await startLegacySession()
    const predicament = await generateSessionPredicament(session)
    const approachId = predicament.predicament.approaches[0]?.id
    assert.ok(approachId)
    const request = {
      storyId: session.storyId,
      revision: predicament.revision,
      predicamentId: predicament.predicament.id,
      approachId,
    }
    const persistedBefore = structuredClone(storedSession(session.storyId))
    let calls = 0

    try {
      process.env.STORY_DISABLE_MODEL = 'false'
      globalThis.fetch = async () => {
        calls += 1
        return modelFailure()
      }
      await assert.rejects(
        () => generateSessionHeadTailOptions(request),
        (error: unknown) => error instanceof AppError
          && error.code === expectedCode
          && error.statusCode === 502,
      )
      assert.ok(calls > 0, 'real model mode must make an upstream request')
      assert.deepEqual(storedSession(session.storyId), persistedBefore, 'failure must not write success state')

      process.env.STORY_DISABLE_MODEL = 'true'
      globalThis.fetch = async () => { throw new Error('explicit local mode must not call the model') }
      const local = await generateSessionHeadTailOptions(request)
      assert.equal(local.revision, request.revision + 1)
      assert.equal(local.options.length, 3)
      assert.equal(storedSession(session.storyId).revision, local.revision)
      assert.equal((storedSession(session.storyId).seed as { systemDraft?: { origin?: string } }).systemDraft?.origin, 'deterministic-fallback')
    } finally {
      process.env.STORY_DISABLE_MODEL = 'true'
      globalThis.fetch = previousFetch
    }
  })
}
