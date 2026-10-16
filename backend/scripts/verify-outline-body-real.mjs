// Real final writing on a synthetic confirmed path, using expansion notes
// produced by the production Qwen outline review (not notes from a stub).
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { generateStory } from '../dist/storyService.js'

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(backend, '.env'), quiet: true })
process.env.STORY_DISABLE_MODEL = 'false'
const source = process.argv.find(a => a.startsWith('--source='))?.slice(9)
if (!source) throw Error('Provide a real outline review results.json with --source=')
const reviewed = JSON.parse(readFileSync(resolve(source), 'utf8')).find(r => r.index === 1 && r.expansionRecorded)
if (!reviewed) throw Error('The real outline review must record expansion before testing final writing')
const expansionNeeds = reviewed.output[0].expansionNeeds
const artifact = resolve(backend, '../logs/outline-body-' + new Date().toISOString().replaceAll(':', '-'))
mkdirSync(artifact, { recursive: true })
console.log('ARTIFACT', artifact)
const plan = {
  seed: { subject: '厨师', activeSituation: '厨师想在闭店前给父亲做好一碗汤，父亲不肯解释为何不喝。',
    lockedGoal: '在闭店前让父亲喝到自己做的汤', lockedFacts: [], worldMode: 'realistic-default', expansionScope: 'keep-scale', unknowns: [] },
  predicament: { id: 'p', title: '闭店前的汤', variationAxis: 'relationship', preservedGoal: '让父亲喝到汤',
    immediateSituation: '汤已经煮好，父亲却不肯喝。', obstacle: '父亲不肯解释为何不喝汤',
    tradeoff: '继续追问还是先忙闭店', urgency: '', choice: '是否先听父亲解释', plausibleCost: '闭店更晚', approaches: [], facts: [], actions: [] },
  approach: { id: 'a', intent: '换一种说法和父亲交谈，理解他的顾虑', cost: '闭店可能更晚' },
  headTail: { id: 'h', opening: '汤已经煮好，父亲却不肯喝。', openingClue: '桌上的热汤', promise: '父子之间的笨拙关心',
    climax: '儿子请父亲帮忙收拾，再一起喝汤', climaxActionId: 'finish', resolution: '父子收好厨房，一起喝了汤', cost: '儿子放慢自己收拾的节奏',
    transition: { actionId: 'finish', consumedFacts: [], changedFacts: [], introducedFacts: [] } },
  turnHistory: [{ turnId: 't', phase: 'development',
    node: { id: 'n', title: '开口', event: '父亲不肯解释为何不喝汤。', purpose: '听懂顾虑', goalState: 'trying' },
    conflict: { nodeId: 'n', conflict: '追问还是倾听', action: '儿子换一种说法与父亲交谈', consequence: '父亲愿意说出顾虑', intensity: 1, anchor: '交谈' },
    selectedOption: { id: 'o', label: '先交谈', action: '儿子换一种能让父亲愿意交谈的说法，具体问法及回应过程留给正文展开。',
      immediateConsequence: '父亲承认不喝是怕儿子为自己耽误闭店，两人开始讨论怎样一起收拾厨房。',
      narrativeAction: { id: 'talk', intent: '换一种说法交谈', source: 'user-choice', preconditions: [], effects: [] },
      transition: { actionId: 'talk', consumedFacts: [], changedFacts: [], introducedFacts: [
        { id: 'father-concern', statement: '父亲已承认不喝是怕儿子为自己耽误闭店，并愿意一起讨论收拾厨房。', source: 'confirmed-action', mutability: 'changeable' },
      ] } } }],
  conclusion: { id: 'end', phase: 'climax', presentation: 'candidate-actions',
    node: { id: 'e', title: '一起收拾', event: '父亲已说出怕耽误闭店的顾虑。', purpose: '一起喝汤', goalState: 'resolved' },
    conflict: { nodeId: 'e', conflict: '儿子独自赶工还是和父亲一起', action: '儿子请父亲帮忙收拾，父子收好厨房后一起喝汤。',
      consequence: '父子收好厨房，一起喝了汤。', intensity: 1, anchor: '热汤' },
    narrativeAction: { id: 'finish', intent: '一起收拾并喝汤', source: 'generated', preconditions: [], effects: [] },
    transition: { actionId: 'finish', consumedFacts: [], changedFacts: [], introducedFacts: [] },
    question: null, options: [], canConclude: false, isConclusion: true },
  expansionNeeds,
}
const request = { idea: '厨师想在闭店前给父亲做好一碗汤，父亲始终不肯解释自己为什么不喝；现实家庭故事。', plan }
writeFileSync(resolve(artifact, 'declared.json'), JSON.stringify({ source, mode: 'synthetic confirmed path + real reviewed expansion + production final writing/review', request }, null, 2))
const original = globalThis.fetch
const calls = []
globalThis.fetch = async (url, init) => {
  const input = JSON.parse(String(init.body))
  const response = await original(url, init)
  const output = await response.clone().json()
  const item = { system: input.messages[0].content, input: input.messages[1].content,
    status: response.status, content: output.choices?.[0]?.message?.content }
  calls.push(item)
  appendFileSync(resolve(artifact, 'qwen.jsonl'), JSON.stringify(item) + '\n')
  return response
}
try {
  const story = await generateStory(request)
  const reviews = calls.filter(c => c.system.includes('严谨但不过度保守')).map(c => {
    try { return JSON.parse(c.content) } catch { return null }
  })
  const result = { story, requests: calls.length, reviews, reviewActuallyPassed: reviews.at(-1)?.isConsistent === true }
  writeFileSync(resolve(artifact, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} catch (error) {
  writeFileSync(resolve(artifact, 'result.json'), JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2))
  throw error
} finally { globalThis.fetch = original }
