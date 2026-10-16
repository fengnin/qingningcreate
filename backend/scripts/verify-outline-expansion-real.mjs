// Real production projection/review on deliberately brief direction outlines.
// Expectations and example solutions are not sent to the model.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { projectFutureChoices } from '../dist/storyPreparation.js'

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(backend, '.env'), quiet: true })
process.env.STORY_DISABLE_MODEL = 'false'
process.env.STORY_PREPARATION_DIAGNOSTICS = 'true'
const artifact = resolve(backend, '../logs/outline-expansion-' + new Date().toISOString().replaceAll(':', '-'))
mkdirSync(artifact, { recursive: true })
console.log('ARTIFACT', artifact)
const cases = [
  { idea: '女孩想在小区演出前找回邻居的猫，邻居不愿再让她帮忙；写现实日常故事。',
    action: '她想通过一次真诚沟通争取邻居让她继续找猫，具体说法尚未设计。',
    method: '她设法让邻居感到自己这次会认真听取他的担心，沟通行动的关键过程待展开。',
    change: '邻居最终愿意和她一起去猫常去的院子，但要求这次不要擅自把猫抱走。',
    futureChoice: '请邻居带路并接受他的节奏，还是自己先去寻找但承担再次伤害信任的代价？' },
  { idea: '普通厨师想在闭店前给父亲做好一碗汤，父亲始终不肯解释自己为什么不喝；现实家庭故事。',
    action: '厨师想先通过交谈听懂父亲为何不肯喝汤，不靠发现秘密病历或新的外部事件。',
    method: '他换一种能让父亲愿意交谈的说法，具体问法及回应过程还没有展开。',
    change: '父亲终于承认不喝是怕儿子为自己耽误闭店，两人能开始讨论怎样一起收拾厨房。',
    futureChoice: '让父亲帮忙收拾后一起喝，还是自己收拾并请他先喝？' },
  { idea: '年轻木匠想修好外婆的摇椅，只有普通工具，椅子一条腿已经明确断裂；现实故事。',
    action: '木匠只把摇椅从屋里搬到院子，没有修理。',
    method: '他只是搬椅子，没有更换、连接或加固断腿，椅腿仍然断裂。',
    change: '同一条断腿没有任何修理却已恢复完好，椅子结构完全复原。',
    futureChoice: '请外婆坐下，还是把完好的椅子搬回屋？' },
]
writeFileSync(resolve(artifact, 'declared.json'), JSON.stringify({ cases, model: process.env.QWEN_MODEL || 'qwen-plus' }, null, 2))
const results = []
const selected = process.argv.find(value => value.startsWith('--only='))?.slice(7).split(',').map(Number)
for (const [index, sample] of cases.entries()) {
  if (selected && !selected.includes(index)) continue
  const candidate = { id: 'd0', action: sample.action, possibleResult: sample.change, futureChoice: sample.futureChoice,
    materialIds: ['m0'], preconditionIds: [], resultBasisIds: [], unknownIds: [],
    causalBridge: { method: sample.method, change: sample.change, methodBasisIds: ['m0'], changeBasisIds: [] } }
  const started = Date.now()
  try {
    const output = await projectFutureChoices([candidate], [{ id: 'author-input', text: sample.idea }],
      { tones: [], dramaticForces: [], allowSystemNamedCharacters: false })
    results.push({ index, elapsedMs: Date.now() - started, output,
      expansionRecorded: Boolean(output[0]?.expansionNeeds?.length),
      originalBridgePreserved: JSON.stringify(output[0]?.causalBridge) === JSON.stringify(candidate.causalBridge) })
  } catch (error) { results.push({ index, elapsedMs: Date.now() - started, error: { code: error.code, message: error.message } }) }
  writeFileSync(resolve(artifact, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results.at(-1)))
}
