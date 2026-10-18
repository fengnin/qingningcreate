import assert from 'node:assert/strict'
import test from 'node:test'
import { createNarrativeStateMachine } from './storyState.js'
import type { StoryTurnOption } from '../../shared/story-contract.js'

test('focus and future action cannot create facts; executed result needs an exact author receipt', () => {
  const machine = createNarrativeStateMachine({ maximumFacts: 30, maximumActions: 30 })
  const state = { revision: 0, facts: [], actions: [], appliedTransitions: [] }
  const option: StoryTurnOption = { id: 'o', label: '审阅', action: '检查裂口', immediateConsequence: '未执行', laterEffect: '待审',
    narrativeAction: { id: 'a', intent: '检查裂口', mode: 'focus', source: 'generated', preconditions: [], effects: [], focusSourceTexts: ['陶碗有裂口'] },
    transition: { actionId: 'a', consumedFacts: [], changedFacts: [], introducedFacts: [] } }
  const focused = machine.applyTransition(state, option.narrativeAction, option.transition)
  assert.deepEqual(focused.facts, [])
  assert.deepEqual(focused.actions, [])
  assert.deepEqual(focused.appliedTransitions, [])
  option.narrativeAction.mode = 'candidate'
  assert.deepEqual(machine.applyTransition(state, option.narrativeAction, option.transition), state)
  option.transition.introducedFacts = [{ id: 'result', statement: '裂口已经修好', source: 'confirmed-action', mutability: 'changeable' }]
  assert.throws(() => machine.applyTransition(state, option.narrativeAction, option.transition))
  option.narrativeAction.mode = 'executed'
  option.narrativeAction.source = 'user-choice'
  option.transition.authorConfirmation = { proposalId: 'p', turnId: 't', actionText: '检查裂口', resultText: '只是检查，尚未修复', confirmedAt: 1 }
  assert.throws(() => machine.applyTransition(state, option.narrativeAction, option.transition))
  option.transition.introducedFacts[0]!.statement = option.transition.authorConfirmation.resultText
  const executed = machine.applyTransition(state, option.narrativeAction, option.transition)
  assert.deepEqual(executed.facts.map(f => f.statement), ['只是检查，尚未修复'])
  assert.equal(executed.revision, 1)
})
