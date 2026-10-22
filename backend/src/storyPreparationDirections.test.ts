import assert from 'node:assert/strict'
import test from 'node:test'
import { compileDirectionPlans } from './storyDirectionPlan.js'
import { parsePreparationCandidates } from './storyPreparation.js'
import { suggestPreparationStoryDirections } from './storyPreparationDirections.js'
import type { ProvisionalCurve } from '../../shared/story-contract.js'
import type { StoryPreparation } from '../../shared/story-preparation.js'

test('expanding a generated card returns its existing action/consequence pairs without a model call', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Existing branches must not be regenerated') }
  try {
    const material = [{ id: 'm0', sourceId: 'author-input', role: 'goal' as const, quote: '青柠想去看电影' }]
    const pairs = [
      { action: '立即改约明天', consequence: '朋友可能无法同行，观影延后。' },
      { action: '去影院询问其他场次', consequence: '或许能改场，也可能白跑一趟。' },
    ]
    const cards = parsePreparationCandidates(compileDirectionPlans({ plans: [{ id: 'd0', difficulty: '影院临时取消场次。',
      options: pairs, materialIds: ['m0'], preconditionIds: [], resultBasisIds: [] }] }, 1), material)
    const preparation: StoryPreparation = { protocol: 1, status: 'accepted-design', sources: [{ id: 'author-input', text: material[0]!.quote }],
      material, ...cards, acceptedCandidateIds: ['d0'], executed: false }
    const curve = { brief: { tones: [], dramaticForces: [], allowSystemNamedCharacters: false } } as unknown as ProvisionalCurve
    const before = structuredClone(preparation)
    const result = await suggestPreparationStoryDirections(curve, preparation)
    assert.deepEqual(result.directions.map(({ choice, consequence }) => ({ action: choice, consequence })), pairs)
    assert.deepEqual(result.directions.map(d => d.id), ['path-1', 'path-2'])
    assert.deepEqual(preparation, before)

    preparation.candidates[0]!.action = preparation.candidates[0]!.action.replace('立即改约明天', '先联系朋友一起改约')
    preparation.candidates[0]!.possibleResult = preparation.candidates[0]!.possibleResult.replace('朋友可能无法同行，观影延后。', '需要重新协调时间。')
    const edited = await suggestPreparationStoryDirections(curve, preparation)
    assert.equal(edited.directions[0]!.choice, '先联系朋友一起改约')
    assert.equal(edited.directions[0]!.consequence, '需要重新协调时间。')
    assert.deepEqual(edited.directions[1], result.directions[1])
  } finally { globalThis.fetch = originalFetch }
})
