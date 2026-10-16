// Real production repair workflow across unrelated genres; no mocked replies.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { projectFutureChoices } from '../dist/storyPreparation.js'
import { causalBridgeCases } from './fixtures/causal-bridge-cases.mjs'

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(backend, '.env'), quiet: true })
process.env.STORY_DISABLE_MODEL = 'false'
const artifact = resolve(backend, '../logs', 'story-development-repair-' + new Date().toISOString().replaceAll(':', '-'))
mkdirSync(artifact, { recursive: true })
const brief = { tones: [], dramaticForces: [], allowSystemNamedCharacters: false }
const cases = ['goal-turn-fantasy', 'procedure-with-stakes'].map(name => {
  const group = causalBridgeCases.find(item => item.name === name)
  const selected = group.input.proposals.filter((_, index) => index < 2 || index === (name === 'goal-turn-fantasy' ? 2 : 3))
  return { name, sources: [{ id: 'author-input', text: group.input.storyContext.join('\n') }],
    goal: group.input.mainlineGoals[0], candidates: selected.map(p => ({ id: p.id, action: p.action,
      possibleResult: '这次尝试的结果尚待发展，须保留原有条件和人物取舍。', materialIds: ['m0'], preconditionIds: [],
      resultBasisIds: [], unknownIds: [], futureChoice: p.futureChoice,
      causalBridge: { method: p.method, change: p.change, methodBasisIds: ['m0'], changeBasisIds: [] } })),
    rejectedId: selected[2].id }
})
const sourceHashes = Object.fromEntries(['src/storySemanticReview.ts', 'src/storyPreparation.ts',
  'dist/storySemanticReview.js', 'dist/storyPreparation.js'].map(file => [file,
  createHash('sha256').update(readFileSync(resolve(backend, file))).digest('hex')]))
writeFileSync(resolve(artifact, 'declared.json'), JSON.stringify({ model: process.env.QWEN_MODEL || 'qwen-plus', sourceHashes, cases }, null, 2))
console.log('ARTIFACT', artifact)
const results = []
// Trace only request JSON and response body; never headers or credentials.
const originalFetch = globalThis.fetch
let activeCalls
globalThis.fetch = async (url, init) => {
  const call = { request: JSON.parse(String(init?.body)) }
  activeCalls.push(call)
  const response = await originalFetch(url, init)
  call.status = response.status
  call.response = await response.clone().json()
  return response
}
try {
  for (const sample of cases) {
    activeCalls = []
    const before = structuredClone(sample.candidates)
    try {
      const output = await projectFutureChoices(sample.candidates, sample.sources, brief, [],
        [{ id: 'g0', sourceId: 'author-input', quote: sample.goal }])
      const compositions = activeCalls.filter(call => call.request.messages[0].content.startsWith('你是故事大纲编辑'))
      assert.equal(compositions.length, 1)
      assert.deepEqual(JSON.parse(compositions[0].request.messages[1].content).candidates.map(c => c.id), [sample.rejectedId])
      assert.deepEqual(sample.candidates, before)
      for (const approved of before.slice(0, 2)) {
        const { expansionNeeds, ...unchanged } = output.find(c => c.id === approved.id)
        assert.deepEqual(unchanged, approved)
      }
      results.push({ name: sample.name, passed: true, output, calls: activeCalls })
    } catch (error) {
      results.push({ name: sample.name, passed: false, error: { code: error.code, message: error.message }, calls: activeCalls })
    }
    writeFileSync(resolve(artifact, 'results.json'), JSON.stringify(results, null, 2))
    console.log(JSON.stringify({ name: sample.name, passed: results.at(-1).passed }))
  }
} finally { globalThis.fetch = originalFetch }
const summary = { cases: results.length, passed: results.filter(r => r.passed).length,
  realRequests: results.reduce((n, r) => n + r.calls.length, 0),
  bounds: 'Real local repair and review; passed means accepted with fixed candidates preserved, not an independent literary quality score.' }
writeFileSync(resolve(artifact, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
if (summary.passed !== summary.cases) process.exitCode = 1
