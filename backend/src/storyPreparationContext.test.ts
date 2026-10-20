import assert from 'node:assert/strict'
import test from 'node:test'
import { activePreparationMaterial, preparationExplanationContext, preparationAuthorRequirements } from './storyPreparationContext.js'
import type { StoryPreparation } from '../../shared/story-preparation.js'

function fixture(): StoryPreparation {
  return {
    protocol: 1, status: 'needs-review', executed: false, questions: [], acceptedCandidateIds: [],
    sources: [
      { id: 'author-input', text: '青柠想赶上比赛。朋友担心近路会迷路。是否获奖暂不决定。' },
      { id: 'author-setting', text: '朋友正与青柠同行。' },
      { id: 'author-boundaries', text: '不能使用魔法。' },
      { id: 'author-direction', text: '最终两人一起抵达赛场。' },
      { id: 'author-note', text: '希望过程轻松。' },
    ],
    material: [
      { id: 'goal', sourceId: 'author-input', role: 'goal', quote: '青柠想赶上比赛。' },
      { id: 'worry', sourceId: 'author-input', role: 'fact', quote: '朋友担心近路会迷路。' },
      { id: 'unknown', sourceId: 'author-input', role: 'unknown', quote: '是否获奖暂不决定。' },
      { id: 'company', sourceId: 'author-setting', role: 'fact', quote: '朋友正与青柠同行。' },
      { id: 'boundary', sourceId: 'author-boundaries', role: 'condition', quote: '不能使用魔法。' },
      { id: 'ending', sourceId: 'author-direction', role: 'fact', quote: '最终两人一起抵达赛场。' },
      { id: 'tone', sourceId: 'author-note', role: 'condition', quote: '希望过程轻松。' },
    ],
    candidates: [{ id: 'c0', action: '旧行动', possibleResult: '旧预测', futureChoice: '旧选择', materialIds: ['goal'], preconditionIds: [], resultBasisIds: [], unknownIds: [] }],
  }
}
const candidate = { id: 'c0', action: '青柠走近路，在岔路口迷路了。', possibleResult: '走错路耽误时间。', futureChoice: '询问朋友，还是自己找路？' }

test('requirements survive missing anchor selection and keep supersession and reserved unknown semantics', () => {
  const p = fixture()
  p.mainlineAnchors = []
  p.material.find(m => m.id === 'tone')!.role = 'unknown'
  p.authorReview = { originalText: '', candidates: [], supersededMaterialIds: ['boundary'] }
  const requirements = preparationAuthorRequirements(p)
  assert.deepEqual(requirements.map(r => [r.id, r.kind, r.status]), [
    ['company', 'setting', 'required'], ['ending', 'development', 'required'], ['tone', 'development', 'reserved-unknown'],
  ])
  assert.deepEqual(preparationExplanationContext(p, candidate).authorRequirements, requirements)
})

test('separates author premise, goals, boundaries, future requirements, and explicitly reserved unknowns', () => {
  const p = fixture()
  const original = structuredClone(p)
  const c = preparationExplanationContext(p, candidate)
  assert.deepEqual(c.authorMaterial.settings.map(m => m.id), ['worry', 'company'])
  assert.deepEqual(c.authorMaterial.goals.map(m => m.id), ['goal'])
  assert.deepEqual(c.authorMaterial.conditions.map(m => m.id), ['boundary'])
  assert.deepEqual(c.authorDevelopmentRequirements, { authority: 'author-development-requirement', scope: 'as-stated-by-author', defaultScope: 'whole-story', entries: [p.material[5], p.material[6]] })
  assert.deepEqual(c.authorReservedUnknowns.entries, [p.material[2]])
  assert.deepEqual(c.futureDesign, { authority: 'draft-future-design', executed: false, candidate })
  assert.ok(!JSON.stringify(c.authorMaterial).includes('岔路口迷路了'))
  assert.ok(!JSON.stringify(c).includes('旧预测'))
  assert.deepEqual(p, original)
})

test('missing everyday details do not create reserved unknowns; source context preserves conditional scope verbatim', () => {
  const p = fixture()
  p.sources = [{ id: 'author-input', text: '朋友已经在场；如果迷路就请朋友帮忙，是否获奖暂不决定。' }]
  p.material = [{ id: 'unknown', sourceId: 'author-input', role: 'unknown', quote: '暂不决定' }]
  const c = preparationExplanationContext(p, candidate)
  assert.deepEqual(c.authorReservedUnknowns.entries, p.material)
  assert.deepEqual(c.sourceContext.sources, [{ id: 'author-input', scope: 'full-source', text: p.sources[0]!.text }])
  assert.equal(c.authorReservedUnknowns.entries.length, 1)
  p.material = []
  assert.deepEqual(preparationExplanationContext(p, candidate).authorReservedUnknowns.entries, [])
})

test('superseded facts and unknowns cannot leak back through full original source or raw author review', () => {
  const p = fixture()
  p.authorReview = { originalText: '朋友不再担心近路。可以获得第一名；之后飞走只是未采用设计。', candidates: [],
    supersededMaterialIds: ['worry', 'unknown'], confirmedQuotes: ['朋友不再担心近路。', '可以获得第一名'] }
  const original = structuredClone(p)
  const c = preparationExplanationContext(p, candidate)
  assert.deepEqual(activePreparationMaterial(p).filter(m => m.sourceId === 'author-review').map(m => m.quote), p.authorReview.confirmedQuotes)
  assert.deepEqual(c.authorReservedUnknowns.entries, [])
  assert.deepEqual(c.sourceContext.sources[0], { id: 'author-input', scope: 'active-excerpts', excerpts: [{ id: 'goal', quote: '青柠想赶上比赛。' }] })
  const serialized = JSON.stringify(c)
  assert.ok(!serialized.includes('朋友担心近路会迷路'))
  assert.ok(!serialized.includes('是否获奖暂不决定'))
  assert.ok(!serialized.includes('之后飞走'))
  assert.deepEqual(c.authorMaterial.conditions.filter(m => m.sourceId === 'author-review').map(m => m.quote), p.authorReview.confirmedQuotes)
  assert.deepEqual(p, original)
})

test('acceptance of a direction never turns its result or editable explanation into established material', () => {
  const p = fixture()
  p.status = 'accepted-design'
  p.acceptedCandidateIds = ['c0']
  p.candidates[0]!.explanation = { wording: candidate, method: '虚构办法', change: '虚构结果', issues: [], source: 'author' }
  const c = preparationExplanationContext(p, candidate)
  assert.equal(c.futureDesign.executed, false)
  assert.ok(!JSON.stringify(c.authorMaterial).includes('旧预测'))
  assert.ok(!JSON.stringify(c).includes('虚构结果'))
})
