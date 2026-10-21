import assert from 'node:assert/strict'
import test from 'node:test'
import { generateDirectionCards, parseDirectionCardReview, directionCardReviewSchema } from './storyDirectionCards.js'
import { parsePreparationCandidates } from './storyPreparation.js'
import { outputShapeErrors } from './modelOutputSchema.js'

const plans = () => [0, 1, 2].map(i => ({ id: `d${i}`, difficulty: `第${i}种阻碍。`, options: [
  { action: '争取继续原计划', consequence: '可能继续，但要承担费用。' },
  { action: '主动改期再尝试', consequence: '机会延后，需要重新安排。' },
], materialIds: ['m0'], preconditionIds: [], resultBasisIds: [] }))
const pass = (ids: string[]) => ({ cards: ids.map(id => ({ id, branches: [0, 1].map(optionIndex => ({ optionIndex,
  analysis: '格式桩，不证明语义判断。', evidenceFields: ['action', 'consequence'], verdict: 'supported' })),
  mainline: { verdict: 'supported', reason: '相容' }, boundaries: { verdict: 'supported', reason: '相容' },
  scope: { verdict: 'supported', reason: '相容' },
})), diversity: { passed: true, repairIds: [] as string[], reason: '不同阻碍' } })
const material = [{ id: 'm0', sourceId: 'author-input', role: 'goal' as const, quote: '青柠想看电影。' }]

test('review has exactly one causal verdict per branch and no duplicated prose/checks', () => {
  const schema = directionCardReviewSchema(['d0'])
  assert.deepEqual(outputShapeErrors(pass(['d0']), schema), [])
  assert.ok(outputShapeErrors({ ...pass(['d0']), issues: [] }, schema).length)
  assert.deepEqual(Object.keys(schema.properties!.cards!.items!.properties!.branches!.items!.properties!),
    ['optionIndex', 'analysis', 'evidenceFields', 'verdict'])
})

test('review validates card coverage, branch order, field references and diversity attribution', () => {
  const valid = pass(['d0', 'd1', 'd2'])
  assert.deepEqual(parseDirectionCardReview(valid, plans()), [])
  for (const mutate of [
    (v: typeof valid) => { v.cards[1]!.id = 'd0' },
    (v: typeof valid) => { v.cards[0]!.branches.reverse() },
    (v: typeof valid) => { v.cards[0]!.branches[0]!.evidenceFields = ['invented'] },
    (v: typeof valid) => { v.cards[0]!.branches[0]!.evidenceFields = ['action', 'action'] },
    (v: typeof valid) => { v.diversity.passed = false },
    (v: typeof valid) => { v.diversity.repairIds = ['d0'] },
  ]) {
    const broken = structuredClone(valid); mutate(broken)
    assert.throws(() => parseDirectionCardReview(broken, plans()))
  }
})

for (const failure of ['unsupported', 'uncertain', 'scope', 'mainline', 'boundaries', 'diversity']) {
  test(`only failed card is repaired for ${failure}; approvals and order remain unchanged`, async () => {
    const original = plans(), seen: { stage: string; input: any }[] = []
    let generation = 0, reviews = 0
    const result = await generateDirectionCards({ input: { material }, prompt: '测试', compress: async raw => raw,
      parse: raw => parsePreparationCandidates(raw, material),
      request: async (options, parse) => {
        const input = JSON.parse(options.userPrompt)
        seen.push({ stage: options.diagnosticStage!, input })
        let output
        if (options.diagnosticStage === 'preparation-directions') {
          generation++
          if (generation === 1) output = { plans: original }
          else {
            assert.deepEqual(input.repairIds, ['d1'])
            assert.deepEqual(input.unchangedPlans, [original[0], original[2]])
            assert.deepEqual(input.previousOutput.plans, [original[1]])
            output = { plans: [{ ...original[1], difficulty: '修改后的独立阻碍。' }] }
          }
        } else {
          reviews++
          const audit = pass(input.reviewPlans.map((p: any) => p.id))
          if (reviews === 1) {
            if (failure === 'diversity') audit.diversity = { passed: false, repairIds: ['d1'], reason: 'd1与d0重复。' }
            else if (['scope', 'mainline', 'boundaries'].includes(failure)) {
              audit.cards[1]![failure as 'scope' | 'mainline' | 'boundaries'] = { verdict: 'unsupported', reason: '测试缺陷。' }
            } else audit.cards[1]!.branches[1]!.verdict = failure
          } else {
            assert.deepEqual(input.reviewPlans.map((p: any) => p.id), ['d1'])
            assert.deepEqual(input.unchangedPlans, [original[0], original[2]])
          }
          output = audit
        }
        assert.deepEqual(outputShapeErrors(output, options.outputSchema!), [])
        return parse(output)
      },
    })
    const before = parsePreparationCandidates((await import('./storyDirectionPlan.js')).compileDirectionPlans({ plans: original }), material)
    assert.deepEqual(result.candidates[0], before.candidates[0])
    assert.deepEqual(result.candidates[2], before.candidates[2])
    assert.match(result.candidates[1]!.action, /修改后的独立阻碍/)
    assert.deepEqual(result.candidates.map(c => c.id), ['d0', 'd1', 'd2'])
    assert.equal(seen.length, 4)
  })
}

test('a repair response cannot replace an approved card by changing its id', async () => {
  let calls = 0
  await assert.rejects(() => generateDirectionCards({ input: { material }, prompt: '测试', compress: async raw => raw,
    parse: raw => parsePreparationCandidates(raw, material), request: async (options, parse) => {
      calls++
      if (calls === 1) return parse({ plans: plans() })
      if (calls === 2) {
        const audit = pass(['d0', 'd1', 'd2']); audit.cards[1]!.scope.verdict = 'unsupported'
        return parse(audit)
      }
      assert.ok(outputShapeErrors({ plans: [plans()[0]] }, options.outputSchema!).length)
      return parse({ plans: [plans()[0]] })
    },
  }))
})

test('semantic failures stop after bounded repair rather than passing or looping', async () => {
  let calls = 0
  await assert.rejects(() => generateDirectionCards({ input: { material }, prompt: '测试', compress: async raw => raw,
    parse: raw => parsePreparationCandidates(raw, material), request: async (options, parse) => {
      calls++
      const input = JSON.parse(options.userPrompt)
      if (options.diagnosticStage === 'preparation-directions') return parse({ plans: input.repairIds ? [plans()[1]] : plans() })
      const audit = pass(input.reviewPlans.map((p: any) => p.id))
      audit.cards.find(c => c.id === 'd1')!.branches[0]!.verdict = 'uncertain'
      return parse(audit)
    },
  }), (e: any) => e.code === 'STORY_PREPARATION_QUALITY_FAILED')
  assert.equal(calls, 4)
})

test('misclassified goal IDs are discarded from preconditions without weakening source evidence checks', async () => {
  const input = { material, referenceContract: { preconditionMaterialIds: ['m1'], knownMaterialIds: ['m0', 'm1'] } }
  const source = [
    { ...plans()[0]!, preconditionIds: ['m1', 'm0'] },
    plans()[1]!, plans()[2]!,
  ]
  const result = await generateDirectionCards({ input, prompt: '测试', compress: async raw => raw,
    parse: raw => parsePreparationCandidates(raw, [
      ...material,
      { id: 'm1', sourceId: 'author-input', role: 'condition' as const, quote: '作者确定条件。' },
    ]),
    request: async (options, parse) => {
      const output = options.diagnosticStage === 'preparation-directions' ? { plans: source } : pass(['d0', 'd1', 'd2'])
      return parse(output)
    },
  })
  assert.deepEqual(result.candidates[0]!.preconditionIds, ['m1'])
})

for (const field of ['preconditionIds', 'materialIds', 'resultBasisIds'] as const) {
  test(`precondition recovery never hides unknown or fabricated ${field}`, async () => {
    await assert.rejects(generateDirectionCards({
      input: { referenceContract: { preconditionMaterialIds: [], knownMaterialIds: ['m0'] } },
      prompt: '测试', compress: async raw => raw, parse: raw => parsePreparationCandidates(raw, material),
      request: async (_options, parse) => parse({ plans: [{ ...plans()[0]!, [field]: ['missing'] }, ...plans().slice(1)] }),
    }), { code: 'STORY_PREPARATION_INVALID_OUTPUT' })
  })
}
