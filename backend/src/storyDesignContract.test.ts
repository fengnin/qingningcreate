import assert from 'node:assert/strict'
import test from 'node:test'
import { compileStoryDesignContract, currentStoryDesignContract, storyDesignContractInput } from './storyDesignContract.js'
import type { StoryPreparation } from '../../shared/story-preparation.js'
import type { ProvisionalCurve } from '../../shared/story-contract.js'

function preparation(): StoryPreparation {
  return { protocol: 1, status: 'accepted-design', executed: false,
    sources: [{ id: 'input', text: '青柠想看演唱会。票能否补办尚未确定。' }],
    material: [{ id: 'g', sourceId: 'input', role: 'goal', quote: '青柠想看演唱会。' },
      { id: 'u', sourceId: 'input', role: 'unknown', quote: '票能否补办尚未确定。' }],
    mainlineGoals: [{ id: 'goal', sourceId: 'input', quote: '青柠想看演唱会。' }],
    mainlineAnchors: [{ id: 'anchor', kind: 'action', sourceId: 'input', quote: '看演唱会' }],
    candidates: [{ id: 'c', action: '联系朋友拼车。', possibleResult: '一起前往场馆。', materialIds: ['g'],
      preconditionIds: [], resultBasisIds: [], unknownIds: [],
      causalBridge: { method: '联系朋友拼车。', change: '一起前往场馆。', methodBasisIds: ['g'], changeBasisIds: [] } }],
    acceptedCandidateIds: ['c'], authorReview: { originalText: '', candidates: [], selectedStoryDirection: '与朋友拼车赴演。' }, questions: [] }
}
const steps = [
  { kind: 'current-state' as const, text: '青柠想看演唱会，却没赶上公交。', materialIds: ['g'] },
  { kind: 'trigger' as const, text: '她联系朋友拼车，两人约好在街口碰面。', materialIds: [], action: '联系朋友拼车', expectedChange: '两人约好在街口碰面' },
  { kind: 'resolution' as const, text: '两人到达场馆，一起看演唱会。', materialIds: [] },
]

test('design contract preserves source goal, selected bridge, dependencies and never executes proposals', () => {
  const p = preparation(), before = structuredClone(p)
  const contract = compileStoryDesignContract(p, steps)
  assert.equal(contract.authority, 'future-design')
  assert.deepEqual(contract.goal, { text: '青柠想看演唱会。', sourceIds: ['g'] })
  assert.equal(contract.causalBridge!.method, '联系朋友拼车。')
  assert.deepEqual(contract.nodes[1]!.dependsOn, ['beat-current-state'])
  assert.equal(contract.nodes[1]!.action, '联系朋友拼车')
  assert.equal(storyDesignContractInput(p).execution, 'none')
  assert.equal(storyDesignContractInput(p).reservedUnknowns[0]!.id, 'u')
  assert.deepEqual(p, before)
})

test('contract carries every supplemental requirement even when model anchors omit it', () => {
  const p = preparation()
  p.sources.push({ id: 'author-direction', text: '两人最终一起抵达。' })
  p.material.push({ id: 'ending', sourceId: 'author-direction', role: 'condition', quote: '两人最终一起抵达。' })
  assert.deepEqual(compileStoryDesignContract(p, steps).authorRequirements, [
    { id: 'ending', sourceId: 'author-direction', quote: '两人最终一起抵达。', kind: 'development', status: 'required' },
  ])
})

test('unknown references and empty action/change summaries are rejected', () => {
  for (const step of [
    { ...steps[1]!, materialIds: ['u'] }, { ...steps[1]!, materialIds: ['missing'] },
    { ...steps[1]!, action: '' }, { ...steps[1]!, expectedChange: '' },
  ]) assert.throws(() => compileStoryDesignContract(preparation(), [steps[0]!, step, steps[2]!]), { code: 'STORY_PREPARATION_INVALID_OUTPUT' })
})

test('latest author explanation replaces historical bridge and superseded anchors cannot return', () => {
  const p = preparation()
  p.authorReview!.supersededMaterialIds = ['g']
  p.authorReview!.confirmedQuotes = ['青柠决定陪伴朋友，放弃演唱会。']
  p.authorReview!.selectedStoryDirection = '留在朋友身边。'
  p.candidates[0]!.explanation = { wording: { action: '留在朋友身边。', possibleResult: '放弃赴演。' },
    method: '陪朋友留下。', change: '承担错过演出的代价。', issues: [], source: 'author' }
  const contract = storyDesignContractInput(p)
  assert.deepEqual(contract.mainlineGoals, [])
  assert.deepEqual(contract.mainlineAnchors, [])
  assert.deepEqual(contract.causalBridge, { method: '陪朋友留下。', change: '承担错过演出的代价。' })
  assert.equal(contract.selectedDirection, '留在朋友身边。')
})

test('changed node or selected direction invalidates historical contract without rewriting authored text', () => {
  const p = preparation(), contract = compileStoryDesignContract(p, steps)
  const curve: ProvisionalCurve = { id: 'c', title: '赴演', status: 'draft', brief: { tones: [], dramaticForces: [], allowSystemNamedCharacters: false },
    preparation: p, designContract: contract, beats: steps.map((step, i) => ({ id: `beat-${step.kind}`, kind: step.kind,
      title: step.kind, detail: step.text, source: 'system-proposal', status: 'proposed', dependsOn: contract.nodes[i]!.dependsOn })),
    instructions: [], createdAt: 1, updatedAt: 1 }
  assert.equal(currentStoryDesignContract(curve), contract)
  curve.beats[1]!.detail = '作者改成骑车。'
  assert.equal(currentStoryDesignContract(curve), undefined)
  assert.equal(curve.beats[1]!.detail, '作者改成骑车。')
  curve.beats[1]!.detail = steps[1]!.text
  p.authorReview!.selectedStoryDirection = '放弃演出。'
  assert.equal(currentStoryDesignContract(curve), undefined)
  assert.equal(currentStoryDesignContract({ ...curve, designContract: undefined }), undefined)
})
