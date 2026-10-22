import assert from 'node:assert/strict'
import test from 'node:test'
import { applyActionDenialSourcePolicy, pairActionDenialCandidates, reuseActionDenialCorrections, splitActionClaimChunks, type ActionClaim, type ActionDenialAssessment } from './storyWritingActionDenialPrototype.js'

const claim = (overrides: Partial<ActionClaim> = {}): ActionClaim => ({ sentenceIndex: 0, actor: '主角A', action: 'contact',
  object: '隔间门', timeScope: 'same-event', polarity: 'affirmed', layer: 'narration', ...overrides })

test('splits extraction into bounded core ranges with global indices and neighboring context', () => {
  const chunks = splitActionClaimChunks(['a', 'b', 'c', 'd', 'e'], 2, 20)
  assert.deepEqual(chunks.map(chunk => chunk.coreSentenceIndices), [[0, 1], [2, 3], [4]])
  assert.deepEqual(chunks.map(chunk => chunk.sentences.map(sentence => sentence.sentenceIndex)), [[0, 1, 2], [1, 2, 3, 4], [3, 4]])
  assert.equal(new Set(chunks.flatMap(chunk => chunk.coreSentenceIndices)).size, 5)
  assert.deepEqual(chunks.flatMap(chunk => chunk.coreSentenceIndices), [0, 1, 2, 3, 4])
})

test('starts a new extraction chunk before the character budget is exceeded', () => {
  const chunks = splitActionClaimChunks(['aaaa', 'bbbb', 'cc'], 6, 7)
  assert.deepEqual(chunks.map(chunk => chunk.coreSentenceIndices), [[0], [1, 2]])
})

test('default extraction chunks stay within the sentence and character budgets', () => {
  const sentences = Array.from({ length: 20 }, (_, index) => `${index}: ${'句'.repeat(120)}`)
  const chunks = splitActionClaimChunks(sentences)
  assert.ok(chunks.every(chunk => chunk.coreSentenceIndices.length <= 8))
  assert.ok(chunks.every(chunk => chunk.coreSentenceIndices.reduce((total, index) => total + sentences[index]!.length, 0) <= 900))
  assert.deepEqual(chunks.flatMap(chunk => chunk.coreSentenceIndices), sentences.map((_, index) => index))
})

test('pairs a direct denial of the same action and overlapping object scope', () => {
  const candidates = pairActionDenialCandidates([claim(), claim({ sentenceIndex: 4, object: '任何东西', polarity: 'denied', layer: 'dialogue' })])
  assert.equal(candidates.length, 1)
})

test('does not pair a denial about a different object scope or action', () => {
  const candidates = pairActionDenialCandidates([
    claim(),
    claim({ sentenceIndex: 1, object: '隔间里的物品', polarity: 'denied', layer: 'dialogue' }),
    claim({ sentenceIndex: 2, action: 'enter', polarity: 'denied', layer: 'dialogue' }),
  ])
  assert.equal(candidates.length, 0)
})

test('requires the same canonical actor and time scope', () => {
  const candidates = pairActionDenialCandidates([
    claim(),
    claim({ sentenceIndex: 1, actor: '另一人', polarity: 'denied' }),
    claim({ sentenceIndex: 2, timeScope: 'before', polarity: 'denied' }),
  ])
  assert.equal(candidates.length, 0)
})

test('does not create a candidate without opposite polarity', () => {
  assert.deepEqual(pairActionDenialCandidates([claim(), claim({ sentenceIndex: 1 })]), [])
})

test('ignores planned or not-yet-completed actions', () => {
  assert.deepEqual(pairActionDenialCandidates([claim(), claim({ sentenceIndex: 1, polarity: 'pending' })]), [])
})

test('an unverified dialogue claim cannot become a hard contradiction', () => {
  const candidate = { first: claim(), second: claim({ sentenceIndex: 1, polarity: 'denied', layer: 'dialogue' }) }
  const assessment: ActionDenialAssessment = { candidateIndex: 0, firstNature: 'narration-fact',
    secondNature: 'unverified-character-claim', relation: 'conflict', reason: 'model overreached' }
  assert.equal(applyActionDenialSourcePolicy(candidate, assessment), 'uncertain')
})

test('an explicitly false dialogue denial is compatible despite opposite surface wording', () => {
  const candidate = { first: claim(), second: claim({ sentenceIndex: 1, polarity: 'denied', layer: 'dialogue' }) }
  const assessment: ActionDenialAssessment = { candidateIndex: 0, firstNature: 'narration-fact',
    secondNature: 'explicit-lie', relation: 'conflict', reason: 'model overreached' }
  assert.equal(applyActionDenialSourcePolicy(candidate, assessment), 'compatible')
})

test('a contradiction remains possible when both sides are established facts', () => {
  const candidate = { first: claim(), second: claim({ sentenceIndex: 1, polarity: 'denied' }) }
  const assessment: ActionDenialAssessment = { candidateIndex: 0, firstNature: 'narration-fact',
    secondNature: 'narration-fact', relation: 'conflict', reason: 'both are narrator assertions' }
  assert.equal(applyActionDenialSourcePolicy(candidate, assessment), 'conflict')
})

test('same-object identity pairs descriptions without merging different objects or scopes', () => {
  assert.equal(pairActionDenialCandidates([
    claim({ action: 'see', object: '窗边的老师', objectIdentity: '老师A' }),
    claim({ action: 'see', object: '老师', objectIdentity: '老师A', polarity: 'denied' }),
  ]).length, 1)
  for (const [left, right] of [['门板', '门内物品'], ['左侧房间', '右侧房间'], ['甲班老师', '乙班老师']]) {
    assert.equal(pairActionDenialCandidates([
      claim({ object: left, objectIdentity: left }), claim({ object: right, objectIdentity: right, polarity: 'denied' }),
    ]).length, 0)
  }
})

test('unknown object identity never supplies an alias match', () => {
  assert.equal(pairActionDenialCandidates([
    claim({ object: 'A', objectIdentity: '未知' }), claim({ object: 'B', objectIdentity: '未知', polarity: 'denied' }),
  ]).length, 0)
})

test('deduplicates aliases in the same evidence pair while preserving the original claims', () => {
  const affirmed = claim({ sentenceIndex: 3, object: '模型的底座', objectIdentity: '模型底座' })
  const denied = claim({ sentenceIndex: 12, object: '模型的底座', objectIdentity: '模型底座', polarity: 'denied' })
  const alias = { ...denied, object: '那块底座' }
  const results = pairActionDenialCandidates([affirmed, denied, alias])
  assert.deepEqual(results, [{ first: affirmed, second: denied }])
  assert.equal(alias.object, '那块底座')
  assert.equal(pairActionDenialCandidates([denied, alias, affirmed]).length, 1)
})

test('deduplication preserves separate evidence, sources, object identities and unknown scopes', () => {
  const affirmed = claim({ objectIdentity: '门板' })
  const denied = claim({ sentenceIndex: 4, polarity: 'denied', objectIdentity: '门板' })
  assert.equal(pairActionDenialCandidates([affirmed, denied,
    { ...denied, sentenceIndex: 5 }, { ...denied, layer: 'dialogue' },
  ]).length, 3)
  // Universal denials can overlap both objects, but the objects must not merge.
  assert.equal(pairActionDenialCandidates([
    claim({ object: '甲物品', objectIdentity: '甲' }),
    claim({ object: '乙物品', objectIdentity: '乙' }),
    claim({ sentenceIndex: 4, object: '任何东西', polarity: 'denied' }),
  ]).length, 2)
  assert.equal(pairActionDenialCandidates([affirmed,
    { ...denied, object: '任何东西', objectIdentity: '未知' },
    { ...denied, object: '所有物品', objectIdentity: '未知' },
  ]).length, 2)
})

test('a retracted character statement is compatible with the corrected fact', () => {
  const candidate = { first: claim(), second: claim({ polarity: 'denied', layer: 'dialogue' }) }
  assert.equal(applyActionDenialSourcePolicy(candidate, { candidateIndex: 0, firstNature: 'narration-fact',
    secondNature: 'correction', relation: 'uncertain', reason: 'the denial was explicitly withdrawn' }), 'compatible')
})

test('validated correction is shared across pairs for the same claim, never other claims in its sentence', () => {
  const denied = claim({ sentenceIndex: 1, polarity: 'denied', layer: 'dialogue' })
  const other = { ...denied, object: '另一个物品' }
  const candidates = [ { first: claim(), second: denied },
    { first: denied, second: claim({ sentenceIndex: 2, layer: 'dialogue' }) },
    { first: claim({ object: '另一个物品' }), second: other } ]
  const assessments: ActionDenialAssessment[] = [
    { candidateIndex: 0, firstNature: 'narration-fact', secondNature: 'correction', relation: 'compatible', reason: 'withdrawn', correctionEvidenceIndices: [2] },
    { candidateIndex: 1, firstNature: 'unverified-character-claim', secondNature: 'unverified-character-claim', relation: 'uncertain', reason: 'uncertain' },
    { candidateIndex: 2, firstNature: 'narration-fact', secondNature: 'unverified-character-claim', relation: 'uncertain', reason: 'unrelated claim' },
  ]
  const results = reuseActionDenialCorrections(candidates, assessments)
  assert.deepEqual(results.map(result => result.relation), ['compatible', 'compatible', 'uncertain'])
  assert.deepEqual(results[1]!.correctionEvidenceIndices, [2])
  assert.equal(assessments[1]!.firstNature, 'unverified-character-claim')
})

test('a validated correcting reply also retracts its paired earlier dialogue version', () => {
  const denied = claim({ sentenceIndex: 1, polarity: 'denied', layer: 'dialogue' })
  const candidates = [{ first: claim(), second: denied },
    { first: denied, second: claim({ sentenceIndex: 2, layer: 'dialogue' }) }]
  const results = reuseActionDenialCorrections(candidates, [
    { candidateIndex: 0, firstNature: 'narration-fact', secondNature: 'unverified-character-claim', relation: 'uncertain', reason: 'unverified' },
    { candidateIndex: 1, firstNature: 'unverified-character-claim', secondNature: 'correction', relation: 'compatible', reason: 'corrected earlier denial', correctionEvidenceIndices: [2] },
  ])
  assert.deepEqual(results.map(result => result.relation), ['compatible', 'compatible'])
})
