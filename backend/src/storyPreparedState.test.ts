import assert from 'node:assert/strict'
import test from 'node:test'
import { createNarrativeStateMachine } from './storyState.js'
import type { StorySeed, StoryPredicament } from '../../shared/story-contract.js'

test('prepared state counts materialized author evidence once, while preserving source IDs and capacity gates', () => {
  const texts = Array.from({ length: 7 }, (_, i) => `作者明确材料 ${i + 1}`)
  const seed = { subject: '林筝', activeSituation: '', lockedGoal: null, lockedFacts: texts,
    worldMode: 'realistic-default', expansionScope: 'keep-scale', unknowns: [],
    creativeBrief: { tones: ['growth'], dramaticForces: [], allowSystemNamedCharacters: false } } as StorySeed
  const facts = texts.map((statement, i) => ({ id: `fact-source-m${i + 1}`, statement, source: 'confirmed-curve' as const, mutability: 'fixed' as const }))
  const predicament = { id: 'p', designProtocol: 'prepared-action', title: '', variationAxis: 'commitment',
    preservedGoal: '', immediateSituation: '', obstacle: '', tradeoff: '', urgency: '', choice: '', plausibleCost: '',
    approaches: [], facts, actions: [] } as StoryPredicament
  const machine = createNarrativeStateMachine({ maximumFacts: 12, maximumActions: 24 })
  const before = structuredClone({ seed, predicament })
  assert.deepEqual(machine.createInitialState(seed, predicament).facts, facts)
  assert.equal(machine.createInitialState({ ...seed, lockedFacts: [...texts, '另一条独立事实'] }, predicament).facts.length, 8)
  assert.throws(() => machine.createInitialState(seed, { ...predicament, facts: [...facts, facts[0]!] }), /事实标识重复/u)
  const tooMany = Array.from({ length: 13 }, (_, i) => ({ ...facts[0]!, id: `distinct-${i}`, statement: `独立材料 ${i}` }))
  assert.throws(() => machine.createInitialState({ ...seed, lockedFacts: [] }, { ...predicament, facts: tooMany }), /事实数量超过/u)
  assert.throws(() => machine.createInitialState(seed, { ...predicament, designProtocol: undefined }), /事实数量超过/u)
  assert.deepEqual({ seed, predicament }, before)
})
