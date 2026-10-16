// Real configured Qwen calls. Expectations stay outside model input.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { suggestPreparationExplanation } from '../dist/storyPreparationExplanation.js'
import { acceptPreparation } from '../dist/storyPreparation.js'
import { selectedExpansionNeeds } from '../dist/storyBridgeReview.js'

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(backend, '.env'), quiet: true })
process.env.STORY_DISABLE_MODEL = 'false'
const cases = [
  { name: 'ordinary-talk', expected: 'supported', text: '青柠想和朋友去游乐园，朋友害怕刺激项目。',
    action: '青柠问朋友想玩什么，两人一起商量路线。', possibleResult: '朋友说出顾虑，两人重新安排游玩顺序。', futureChoice: '先玩温和项目还是先逛逛？' },
  { name: 'ordinary-tool', expected: 'supported', text: '青柠在公园画画，风把画纸吹起来。',
    action: '青柠拿出口袋里的普通夹子，把纸夹在画板上。', possibleResult: '画纸固定住了，青柠可以继续画画。', futureChoice: '继续画风景还是画路边的小狗？' },
  { name: 'same-tool-character-role', expected: 'expandable', kinds: ['character-detail'], text: '青柠一直坚持独自画画，不肯接受朋友帮助。这段故事重点是他第一次愿意接受朋友照顾。',
    action: '风吹起画纸，朋友递来一枚普通夹子。青柠这次没有像以往那样拒绝，而是接过夹子，把纸夹在画板上。', possibleResult: '夹住画纸的作用很普通，但接过夹子意味着青柠第一次接纳朋友的关心，两人关系向前一步。', futureChoice: '继续画风景还是画朋友？' },
  { name: 'ordinary-explicit-deferral', expected: 'supported', text: '青柠想去公园和朋友画画。',
    action: '青柠带着画板走进公园，在长椅上坐下；如何拿画板、如何坐下留到正文展开。', possibleResult: '他在长椅上等朋友来。', futureChoice: '先画眼前的树还是等朋友一起选景？' },
  { name: 'important-tool-setup', expected: 'expandable', kinds: ['setup'], text: '阿禾被熟人堵在后台，想不被认出地离开。',
    action: '阿禾决定用包里待送洗的戏服伪装后离开；戏服为何在包里的铺垫留到正文表现。', possibleResult: '他可能走到出口，但仍有被认出的风险。', futureChoice: '走正门还是先等熟人离开？' },
  { name: 'character-choice', expected: 'expandable', kinds: ['character-detail'], text: '阿禾一直怕惹麻烦，误入后台后想赶紧离开。',
    action: '出口已经无人看守，阿禾却看见邻人被困，决定放弃脱身的机会，转身冲出去求救。', possibleResult: '他暴露了行踪，却让救援得以及时开始；这次主动承担风险体现他不再只顾自保。', futureChoice: '先为自己解释还是留下协助救援？' },
  { name: 'emotion-without-causal-gap', expected: 'expandable', kinds: ['emotional-beat'], text: '青柠等了很久，今天终于接到远行回来的朋友。',
    action: '见面后两人仍谈着路上的琐事。此前积累的想念在拥抱时化成眼泪，这次重逢的情绪释放是这一段的重点。', possibleResult: '两人一起走回家，情节因果已完整；正文要让平静寒暄到拥抱落泪的情绪变化可感。', futureChoice: '先去吃饭还是先回家放行李？' },
  { name: 'costume-contrast', expected: 'expandable', kinds: ['payoff'], text: '阿禾用戏服伪装离开后台，包里戏服的来源已经交代。',
    action: '阿禾仍穿着夸张的戏服，放弃躲藏，冲出去帮邻人叫来救援。', possibleResult: '救援及时赶到。原本用于躲藏的滑稽装扮伴着他勇敢求救，形成紧张中带笑的反差；不是缺少因果解释。', futureChoice: '先解释自己为什么换装还是先帮忙引路？' },
  { name: 'callback-without-causal-gap', expected: 'expandable', kinds: ['payoff'], text: '青柠小时候怕黑，朋友总说“我陪你走”；如今朋友刚失去工作，青柠来陪他回家。',
    action: '朋友不愿谈失业，青柠没有逼问，在路口把小时候朋友说过的“我陪你走”还给他，两人继续往前走。', possibleResult: '这句话首尾呼应，让照顾与被照顾的关系交换自然落地；不需要新增事件才能成立。', futureChoice: '继续安静陪伴还是等朋友主动开口？' },
  { name: 'unselected-future-branches', expected: 'supported', text: '青柠想赶在闭馆前还书，途中看见朋友摔倒。',
    action: '青柠扶朋友到长椅休息。', possibleResult: '朋友得到照顾，青柠可能赶不上还书。', futureChoice: '留下陪朋友，还是确认朋友能独自休息后赶去还书？尚未选择。' },
  { name: 'undecided-core-plan', expected: 'supported', text: '阿禾想离开后台，还没有确定脱身办法。',
    action: '爬通风口还是换装脱身，关键办法留给创作者选择，目前不作决定。', possibleResult: '是否脱身及承担何种代价也尚未确定。', futureChoice: '先选择哪一种脱身办法？' },
  { name: 'negative-rule', expected: 'contradictory', text: '青柠的伞只能带一个人飞，载两个人绝对飞不起来。',
    action: '青柠和朋友同时抓住伞起飞，不借助任何其他工具。', possibleResult: '这把伞顺利把两个人同时送过河。', futureChoice: '先去送信还是先休息？' },
  { name: 'negative-mechanism', expected: 'contradictory', text: '入园票没有朋友的位置，也没有任何定位或通信功能。',
    action: '青柠只看这张票，不问任何人也不借助其他线索。', possibleResult: '青柠据此准确知道朋友现在在哪个项目旁。', futureChoice: '立刻过去还是先等朋友？' },
  { name: 'edited-trust-four-fields', expected: 'expandable', kinds: ['character-detail', 'response-detail', 'action-detail'], text: '青柠想和朋友去游乐园，朋友第一次去，害怕刺激项目。',
    action: '遇到的难处：朋友因青柠以前失约而不愿再相信他，也害怕刺激项目。\n眼前的选择：青柠承认以前失约的责任，把是否挑战的决定交给朋友；谈话中关系变化的表现留到正文。', possibleResult: '朋友愿意再给一次机会，两人先玩温和项目，刺激项目仍可拒绝。', futureChoice: '青柠接下来怎样用行动守住约定？' },
]

const selected = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',')
const samples = selected ? cases.filter(c => selected.includes(c.name)) : cases
assert.ok(samples.length, 'No matching test cases')
const artifact = resolve(backend, '../local-evidence/story-expansion-value-' + new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(artifact, { recursive: true })
const report = { model: process.env.QWEN_MODEL || 'qwen-plus', startedAt: new Date().toISOString(), results: [] }
const actualFetch = globalThis.fetch
const modelResponses = []
globalThis.fetch = async (url, init) => {
  const request = JSON.parse(String(init?.body || '{}'))
  const response = await actualFetch(url, init)
  const result = await response.clone().json()
  modelResponses.push({ stage: request.response_format?.json_schema?.name,
    candidateId: JSON.parse(request.messages[1].content).futureDesign?.candidate?.id,
    content: result.choices?.[0]?.message?.content })
  writeFileSync(resolve(artifact, 'model-responses.json'), JSON.stringify(modelResponses, null, 2))
  return response
}
for (let i = 0; i < samples.length; i += 3) {
  const results = await Promise.allSettled(samples.slice(i, i + 3).map(async sample => {
    const { name: id, action, possibleResult, futureChoice, text } = sample
    const candidate = { id, action, possibleResult, futureChoice, materialIds: ['m0'], preconditionIds: [], resultBasisIds: [], unknownIds: [] }
    const preparation = { protocol: 1, status: 'needs-review', sources: [{ id: 'author-input', text }],
      material: [{ id: 'm0', sourceId: 'author-input', role: 'condition', quote: text }], candidates: [candidate], questions: [], acceptedCandidateIds: [], executed: false }
    const before = structuredClone(preparation)
    const output = await suggestPreparationExplanation(preparation, { id, action, possibleResult, futureChoice })
    assert.deepEqual(preparation, before)
    const verdict = output.issues.length ? 'contradictory' : output.expansionNeeds?.length ? 'expandable' : 'supported'
    const kinds = output.expansionNeeds?.map(n => n.kind) ?? []
    const markedUnselectedBranch = output.expansionNeeds?.some(n => n.anchors.every(a => a.field === 'futureChoice')) ?? false
    const pass = verdict === sample.expected && (!sample.kinds || kinds.some(k => sample.kinds.includes(k))) && !markedUnselectedBranch
    const accepted = acceptPreparation(preparation, [id], { originalText: '核对方向、解释及重要故事作用。', candidates: [{ id, action, possibleResult, futureChoice, explanation: output }] })
    assert.deepEqual(selectedExpansionNeeds(accepted), output.expansionNeeds ?? [])
    assert.deepEqual(accepted.material, before.material)
    assert.equal(accepted.executed, false)
    return { sample, output, verdict, kinds, markedUnselectedBranch, pass }
  }))
  results.forEach((result, index) => {
    const row = result.status === 'fulfilled' ? result.value : { sample: samples[i + index], pass: false, error: String(result.reason) }
    report.results.push(row)
    console.log(JSON.stringify({ name: row.sample.name, verdict: row.verdict, kinds: row.kinds, pass: row.pass, error: row.error }))
  })
  writeFileSync(resolve(artifact, 'report.json'), JSON.stringify(report, null, 2))
}
console.log('EVIDENCE ' + artifact)
if (report.results.some(r => !r.pass)) process.exitCode = 1
