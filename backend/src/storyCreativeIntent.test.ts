import assert from 'node:assert/strict'
import test from 'node:test'
import { preparationCreativeFocus } from './storyCreativeIntent.js'

test('creative focus keeps only active known source excerpts, with no inferred facts or mandatory plot', () => {
  const sources = [{ id: 'input', text: '父子一起煮面。爸爸总抢先尝。结尾还没想好。' }]
  const material = [
    { id: 'm0', sourceId: 'input', quote: '父子一起煮面。', role: 'goal' as const },
    { id: 'm1', sourceId: 'input', quote: '爸爸总抢先尝。', role: 'fact' as const },
    { id: 'm2', sourceId: 'input', quote: '结尾还没想好。', role: 'unknown' as const },
    { id: 'fake', sourceId: 'input', quote: '父子最终和解。', role: 'fact' as const },
  ]
  const p = { sources, material, appealMaterialIds: ['m0', 'm1', 'm2', 'fake', 'absent'] }
  const before = structuredClone(p)
  assert.deepEqual(preparationCreativeFocus(p), { authority: 'creative-reference', excerpts: ['父子一起煮面。', '爸爸总抢先尝。'] })
  assert.deepEqual(preparationCreativeFocus({ ...p, authorReview: { originalText: '改为兄妹煮面。', candidates: [],
    supersededMaterialIds: ['m0'], confirmedQuotes: ['改为兄妹煮面。'] } }, ['m1']).excerpts, [])
  assert.deepEqual(preparationCreativeFocus(), { authority: 'creative-reference', excerpts: [] })
  assert.deepEqual(preparationCreativeFocus({ sources, material }).excerpts, [])
  assert.deepEqual(p, before)
})
