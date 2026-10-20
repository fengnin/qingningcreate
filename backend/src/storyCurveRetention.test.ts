import assert from 'node:assert/strict'
import test from 'node:test'
import { createStoryDesignRecord, isStoryCurveFoundationCurrent } from './storyDesign.js'
import { mapInitialReasoningProposal } from './storyInitialReasoning.js'
import { confirmProvisionalCurve, retainAffectedCurveBeats, updateCurveBeat } from './storyCoCreation.js'
import { requiredDesignProposalIds } from './storyDesignReview.js'
import { parseStoryCurveBeatRetentionRequest } from './storyService.js'
import { compileStoryDesignContract, currentStoryDesignContract, rebuildStoryDesignContract } from './storyDesignContract.js'
import type { StoryReasoningProposal } from '../../shared/story-reasoning-contract.js'
import type { CreativeBrief, StorySeed } from '../../shared/story-contract.js'

function fixture() {
  const text = '余禾想和姐姐一起整理书架。'
  const seed: StorySeed = { subject: '余禾', activeSituation: text, lockedGoal: text, lockedFacts: [], worldMode: 'realistic-default', expansionScope: 'keep-scale', unknowns: [] }
  const brief: CreativeBrief = { tones: [], dramaticForces: [], allowSystemNamedCharacters: false }
  const design = createStoryDesignRecord(text, seed)
  const evidence = design.sourceFacts.map(f => ({ sourceId: f.id, quote: f.text }))
  const basis = { kind: 'design-proposal' as const, evidence, unknownIds: [] }
  const kinds = ['current-state', 'trigger', 'escalation', 'climax-choice', 'resolution'] as const
  const p: StoryReasoningProposal = { protocol: 1, stage: 'initial-design', status: 'needs-review', outcome: 'proposal',
    goal: { id: 'goal', text, basis: { kind: 'author-text', evidence } }, constraints: [], relations: [], unknowns: [],
    actions: [{ id: 'action', text: '两人商量分工，再一起整理书架。', basis, constraintIds: [], relationIds: [], unknownIds: [], respondsToEditIds: [] }],
    steps: kinds.map((kind, i) => ({ id: `beat-${kind}`, kind, title: kind, text: `${kind}：两人一起整理书架。`, basis,
      actionIds: ['action'], relationIds: [], dependsOn: i ? [`beat-${kinds[i - 1]}`] : [], respondsToEditIds: [] })),
    designReview: { required: true, acceptedProposalIds: [] } }
  return mapInitialReasoningProposal(p, design, brief)
}

test('explicit retention preserves downstream text and source authority, rebuilds foundation, and still needs design review', () => {
  const edited = updateCurveBeat(fixture(), 'beat-trigger', '让两人先讨论分工，再开始整理。').curve
  const before = structuredClone(edited)
  const stale = edited.beats.filter(b => b.status === 'stale')
  const result = retainAffectedCurveBeats(edited, stale.map(b => b.id)).curve
  assert.deepEqual(edited, before, 'retention does not mutate the caller snapshot')
  for (const beat of stale) {
    const kept = result.beats.find(b => b.id === beat.id)!
    assert.equal(kept.detail, beat.detail)
    assert.equal(kept.source, beat.source)
    assert.equal(kept.status, 'proposed')
  }
  assert.equal(isStoryCurveFoundationCurrent(result.foundation, result.beats), true)
  assert.deepEqual(result.design!.sourceFacts.map(f => f.text), edited.design!.sourceFacts.map(f => f.text))
  assert.match(result.instructions.at(-1)!.text, /作者已核对并沿用/u)
  assert.throws(() => confirmProvisionalCurve(result), { code: 'STORY_DESIGN_REVIEW_REQUIRED' })
  const confirmed = confirmProvisionalCurve(result, requiredDesignProposalIds(result.reasoning!))
  assert.equal(confirmed.confirmedCurve.beats.find(b => b.id === 'beat-trigger')!.detail, '让两人先讨论分工，再开始整理。')
})

test('partial retention keeps remaining impact unresolved; rejected and non-stale nodes cannot be retained', () => {
  const original = fixture()
  original.beats.find(b => b.id === 'beat-resolution')!.status = 'rejected'
  const edited = updateCurveBeat(original, 'beat-trigger', '先讨论分工。').curve
  assert.equal(edited.beats.find(b => b.id === 'beat-resolution')!.status, 'rejected')
  const partial = retainAffectedCurveBeats(edited, ['beat-escalation']).curve
  assert.equal(partial.beats.find(b => b.id === 'beat-climax-choice')!.status, 'stale')
  assert.equal(partial.foundation, undefined)
  for (const ids of [[], ['missing'], ['beat-trigger'], ['beat-resolution'], ['beat-escalation', 'beat-escalation']]) {
    assert.throws(() => retainAffectedCurveBeats(edited, ids), { code: 'STORY_CURVE_RETENTION_CONFLICT' })
  }
})

test('retention cannot clear unresolved author questions or operate on a confirmed curve', () => {
  const edited = updateCurveBeat(fixture(), 'beat-trigger', '先讨论分工。').curve
  edited.clarifications = [{ id: 'question', prompt: '作者明确保留的未知', status: 'unanswered', source: 'author-review', createdAt: 1, updatedAt: 1,
    dependency: { beatIds: ['beat-resolution'], causalGap: '作者明确保留的未知', requiredFor: ['confirm-curve'] } }]
  const kept = retainAffectedCurveBeats(edited, edited.beats.filter(b => b.status === 'stale').map(b => b.id)).curve
  assert.deepEqual(kept.clarifications, edited.clarifications)
  assert.throws(() => confirmProvisionalCurve(kept, requiredDesignProposalIds(kept.reasoning!)), { code: 'STORY_CURVE_CLARIFICATIONS_UNRESOLVED' })
  assert.throws(() => retainAffectedCurveBeats({ ...edited, status: 'confirmed' }, ['beat-resolution']), { code: 'STORY_CURVE_ALREADY_CONFIRMED' })
})

test('retention wire request requires explicit unique node IDs and rejects unrelated fields', () => {
  const request = { storyId: 'story-test', revision: 1, curveId: 'curve-test', beatIds: ['beat-resolution'] }
  assert.deepEqual(parseStoryCurveBeatRetentionRequest(request), request)
  for (const invalid of [{ ...request, beatIds: [] }, { ...request, beatIds: ['beat-resolution', 'beat-resolution'] }, { ...request, overwrite: true }]) {
    assert.throws(() => parseStoryCurveBeatRetentionRequest(invalid), { code: 'INVALID_REQUEST' })
  }
})

test('confirming retained or manually revised preparation restores a current contract with author requirements', () => {
  for (const mode of ['retain', 'manual']) {
    const original = fixture()
    const text = original.reasoning!.goal!.text
    original.preparation = { protocol: 1, status: 'accepted-design', executed: false,
      sources: [{ id: 'input', text }], material: [{ id: 'g', sourceId: 'input', role: 'goal', quote: text }],
      candidates: [], acceptedCandidateIds: [], questions: [] }
    original.designContract = compileStoryDesignContract(original.preparation,
      original.beats.map(b => ({ kind: b.kind, text: b.detail, materialIds: [], action: '旧动作', expectedChange: '旧变化' })))
    let edited = updateCurveBeat(original, 'beat-trigger', '先讨论分工，再整理。').curve
    edited.instructions.push({ id: 'original-request', kind: 'author-revision', targetBeatId: 'beat-trigger',
      text: '先和姐姐确定分工，不要边整理边商量。', createdAt: Date.now() })
    assert.equal(currentStoryDesignContract(edited), undefined)
    if (mode === 'retain') edited = retainAffectedCurveBeats(edited, edited.beats.filter(b => b.status === 'stale').map(b => b.id)).curve
    else for (const b of edited.beats.filter(b => b.status === 'stale')) edited = updateCurveBeat(edited, b.id, `${b.kind}：承接讨论的分工共同整理。`).curve
    const before = structuredClone(edited)
    const result = confirmProvisionalCurve(edited, requiredDesignProposalIds(edited.reasoning!))
    assert.deepEqual(edited, before)
    assert.ok(currentStoryDesignContract(result.confirmedCurve))
    const contract = result.confirmedCurve.designContract!
    assert.deepEqual(contract.nodes.map(n => n.text), result.confirmedCurve.beats.map(b => b.detail))
    assert.ok(contract.authorRequirements!.some(r => r.quote === '先讨论分工，再整理。'))
    assert.ok(contract.authorRequirements!.some(r => r.quote === '先和姐姐确定分工，不要边整理边商量。'), 'original request survives model paraphrase')
    assert.equal(contract.nodes.find(n => n.beatId === 'beat-trigger')!.action, undefined, 'old summaries cannot survive changed node text')
    assert.equal(contract.goal.text, text)
    const manual = updateCurveBeat(edited, 'beat-trigger', '余禾决定自己先整理第一层。').curve
    assert.equal(manual.instructions.at(-1)!.kind, 'replace', 'direct editing supersedes the original instruction')
    const resolved = retainAffectedCurveBeats(manual, manual.beats.filter(b => b.status === 'stale').map(b => b.id)).curve
    assert.ok(!rebuildStoryDesignContract(resolved).authorRequirements!.some(r => r.id === 'author-request-beat-trigger'), 'superseded instructions are not imposed on later manual edits')
  }
})
