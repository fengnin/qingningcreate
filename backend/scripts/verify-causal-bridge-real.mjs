// Calls the configured real Qwen model using the production review prompt.
// Run from backend after building: node scripts/verify-causal-bridge-real.mjs
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { requestQwenJson } from '../dist/qwen.js'
import { causalBridgeReviewPrompt } from '../dist/storyPreparation.js'
import { causalBridgeCases } from './fixtures/causal-bridge-cases.mjs'
import { causalReviewOutputSchema } from '../dist/storyOutputSchemas.js'
import { parseBridgeReviewCheck, bridgeEvidenceCatalog } from '../dist/storyBridgeReview.js'

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(backend, '.env'), quiet: true })
process.env.STORY_DISABLE_MODEL = 'false'
const rounds = Number(process.argv.find(value => value.startsWith('--rounds='))?.slice(9) ?? 2)
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw Error('--rounds must be an integer from 1 to 5')
const selected = process.argv.find(value => value.startsWith('--groups='))?.slice(9).split(',')
if (selected?.some(name => !causalBridgeCases.some(group => group.name === name))) throw Error('Unknown group')
const groups = causalBridgeCases.filter(group => !selected || selected.includes(group.name))
const artifact = resolve(backend, '../logs', 'causal-bridge-general-' + new Date().toISOString().replaceAll(':', '-'))
mkdirSync(artifact, { recursive: true })
const sourceHash = file => createHash('sha256').update(readFileSync(resolve(backend, file))).digest('hex')
const declared = {
  model: process.env.QWEN_MODEL?.trim() || 'qwen-plus', rounds,
  sourceSha256: sourceHash('src/storyPreparation.ts'), compiledSha256: sourceHash('dist/storyPreparation.js'),
  prompt: causalBridgeReviewPrompt, groups,
}
writeFileSync(resolve(artifact, 'declared.json'), JSON.stringify(declared, null, 2))
console.log('ARTIFACT', artifact)
const results = []
for (let round = 1; round <= rounds; round++) {
  for (let offset = 0; offset < groups.length; offset += 3) {
    // Bound concurrency; one unsuccessful request does not hide the other results.
    const batch = await Promise.allSettled(groups.slice(offset, offset + 3).map(async group => {
      const started = Date.now()
      const calls = [], checks = []
      // Production reviews at most three directions. Pair a supported and an
      // unsupported development instead of sending four into a three-item schema.
      try {
        for (const proposals of [group.input.proposals.filter((_, i) => i % 2 === 0), group.input.proposals.filter((_, i) => i % 2 === 1)]) {
          const evidenceCatalog = bridgeEvidenceCatalog(proposals, group.input.storyContext)
          const input = { ...group.input, proposals, evidenceCatalog }
          let previousOutput, validationFailure
          for (let attempt = 0; attempt < 2; attempt++) {
            const output = await requestQwenJson({ systemPrompt: causalBridgeReviewPrompt,
              userPrompt: JSON.stringify({ ...input, ...(attempt ? { previousOutput, validationFailure } : {}) }),
              temperature: 0.1, maxTokens: 1800, diagnosticStage: 'causal-bridge-general-regression', outputSchema: causalReviewOutputSchema(proposals.length, evidenceCatalog.map(e => e.id)) })
            calls.push({ input, output })
            try {
              if (output.checks.length !== proposals.length || new Set(output.checks.map(c => c.id)).size !== proposals.length) throw Error('Review omitted or duplicated directions')
              const parsed = []
              for (const check of output.checks) {
                const proposal = proposals.find(p => p.id === check.id)
                if (!proposal) throw Error('Review referenced an unknown direction')
                parsed.push(parseBridgeReviewCheck(check, evidenceCatalog))
              }
              checks.push(...parsed)
              break
            } catch (error) {
              if (attempt) throw error
              previousOutput = output; validationFailure = error.message
            }
          }
        }
      } catch (error) {
        return { round, name: group.name, elapsedMs: Date.now() - started, passed: false, calls,
          error: { code: error.code, message: error.message } }
      }
      const output = { checks }
      const passed = Array.isArray(checks) && checks.length === Object.keys(group.expected).length
        && new Set(checks.map(check => check.id)).size === checks.length
        && checks.every(check => Object.hasOwn(group.expected, check.id) && check.valid === group.expected[check.id]
          && (check.valid ? check.issueType === 'none' : ['causal-gap', 'mainline-drift', 'world-implausible'].includes(check.issueType))
          && typeof check.reason === 'string' && check.reason.trim().length > 0 && check.reason.length <= 500)
      return { round, name: group.name, elapsedMs: Date.now() - started, passed, output, calls }
    }))
    batch.forEach((result, index) => {
      const item = result.status === 'fulfilled' ? result.value : {
        round, name: groups[offset + index].name, passed: false,
        error: { code: result.reason?.code ?? 'ERROR', message: result.reason?.message ?? 'Request failed' },
      }
      results.push(item)
      console.log(JSON.stringify({ round: item.round, name: item.name, passed: item.passed, error: item.error }))
    })
    writeFileSync(resolve(artifact, 'results.json'), JSON.stringify(results, null, 2))
  }
}
const summary = { rounds, groups: groups.length, judgments: groups.reduce((n, group) => n + group.input.proposals.length, 0) * rounds,
  requests: results.reduce((n, result) => n + (result.calls?.length ?? 0), 0), passedGroups: results.filter(result => result.passed).length,
  failedGroups: results.filter(result => !result.passed).map(({ round, name, error }) => ({ round, name, error })) }
writeFileSync(resolve(artifact, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
if (summary.failedGroups.length) process.exitCode = 1
