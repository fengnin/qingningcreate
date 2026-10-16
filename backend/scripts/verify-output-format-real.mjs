// Replay an observed malformed response once, then let production format repair
// call the configured real Qwen model. This does not certify story quality.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { requestQwenJson } from '../dist/qwen.js'
import { outputShapeErrors } from '../dist/modelOutputSchema.js'
import { preparationOutputSchemas } from '../dist/storyOutputSchemas.js'

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const traceFile = argument('trace'), call = Number(argument('call')), contract = argument('contract') || 'directions'
if (!traceFile || !Number.isSafeInteger(call)) throw Error('Supply --trace=<qwen.jsonl> and --call=<number>')
const outputSchema = preparationOutputSchemas[contract]
if (!outputSchema) throw Error('Unknown preparation contract')
const trace = readFileSync(resolve(traceFile), 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line))
const request = trace.find(entry => entry.call === call && entry.event === 'request')?.request
const envelope = trace.find(entry => entry.call === call && entry.event === 'response')?.body
assert.ok(request && envelope?.choices?.[0]?.message?.content)
const malformed = JSON.parse(envelope.choices[0].message.content)
assert.ok(outputShapeErrors(malformed, outputSchema).length, 'Replay must actually violate the selected contract')
dotenv.config({ path: resolve(backend, '.env'), quiet: true })
process.env.STORY_DISABLE_MODEL = 'false'
const artifact = resolve(backend, '../logs', 'output-format-replay-' + new Date().toISOString().replaceAll(':', '-'))
mkdirSync(artifact, { recursive: true })
const hashes = () => Object.fromEntries(['src/qwen.ts', 'src/modelOutputSchema.ts', 'src/storyOutputSchemas.ts',
  'dist/qwen.js', 'dist/modelOutputSchema.js', 'dist/storyOutputSchemas.js'].map(file => [file,
  createHash('sha256').update(readFileSync(resolve(backend, file))).digest('hex')]))
const before = hashes(), calls = [], originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const payload = JSON.parse(String(init?.body))
  const replayed = calls.length === 0
  const record = { replayed, request: payload }; calls.push(record)
  const response = replayed
    ? new Response(JSON.stringify(envelope), { status: 200 })
    : await originalFetch(url, init)
  record.status = response.status
  record.response = await response.clone().json()
  return response
}
console.log('ARTIFACT', artifact)
let summary
try {
  const output = await requestQwenJson({ systemPrompt: request.messages[0].content,
    userPrompt: request.messages[1].content, temperature: request.temperature, maxTokens: request.max_tokens,
    diagnosticStage: `real-format-replay-${contract}`, outputSchema })
  assert.deepEqual(outputShapeErrors(output, outputSchema), [])
  assert.equal(calls.filter(item => item.replayed).length, 1)
  assert.equal(calls.filter(item => !item.replayed).length, 1)
  summary = { passed: true, output }
} catch (error) {
  summary = { passed: false, error: { code: error.code, message: error.message } }
  process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
  summary = { ...summary, traceFile, call, contract, model: process.env.QWEN_MODEL || 'qwen-plus',
    historicalResponsesReplayed: calls.filter(item => item.replayed).length,
    realRequests: calls.filter(item => !item.replayed).length,
    sourceUnchanged: JSON.stringify(before) === JSON.stringify(hashes()), sourceHashes: before,
    bounds: 'Historical malformed first response; real production Qwen format repair. Shape only, no semantic approval.' }
  writeFileSync(resolve(artifact, 'requests.json'), JSON.stringify(calls, null, 2))
  writeFileSync(resolve(artifact, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({ passed: summary.passed, realRequests: summary.realRequests, sourceUnchanged: summary.sourceUnchanged }))
}
