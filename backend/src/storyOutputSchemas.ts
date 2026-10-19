import { shape as s, type OutputSchema } from './modelOutputSchema.js'
import { developmentFields, developmentResultFields, developmentChoiceSchema } from './storyDevelopmentState.js'
import { bridgeReviewCheckSchema } from './storyBridgeReview.js'
import { factReviewCheckSchema } from './storyFactReview.js'

const refs = s.array(s.text)
const question = s.object({ id: s.text, question: s.text, materialIds: refs })
const bridgeFields = { method: s.text, change: s.text, methodBasisIds: refs, changeBasisIds: refs }
const candidate = s.object({ id: s.text, action: s.text, materialIds: refs, preconditionIds: refs,
  possibleResult: s.text, resultBasisIds: refs, unknownIds: refs,
  futureChoice: s.text, causalBridge: s.object(bridgeFields) }, ['futureChoice', 'causalBridge'])
const sourceSpan = { sourceId: s.text, quote: s.text }
const referenceNode = (extra: Record<string, OutputSchema> = {}) => s.either(
  s.object({ id: s.text, ...extra, materialIds: refs }), s.object({ id: s.text, ...extra, ...sourceSpan }))
export const preparationOutputSchemas = {
  classification: s.object({ material: s.array(s.object({ id: s.text, role: s.enum('fact', 'condition', 'goal', 'unknown') })) }),
  uncertainty: s.object({ decisions: s.array(s.object({ id: s.text, role: s.enum('fact', 'condition', 'unknown'), evidenceIds: refs })) }),
  intent: s.object({ characterGoalIds: refs, mainlineGoals: s.array(referenceNode(), 0, 8),
    mainlineAnchors: s.array(referenceNode({ kind: s.enum('character', 'relationship', 'place', 'action', 'object', 'constraint', 'condition', 'time') }), 0, 16),
    appealMaterialIds: s.array(s.text, 0, 3) }),
  directions: s.object({ candidates: s.array(candidate, 1, 3), questions: s.array(question, 0, 8) }),
  questions: s.object({ candidates: s.array(candidate, 0, 0), questions: s.array(question, 1, 8) }),
  compression: s.object({ texts: s.array(s.object({ id: s.text, text: s.text }), 1, 24) }),
  // Qwen may sort object keys. These nested names keep attempt -> change ->
  // futureChoice in that order even then, instead of writing choices first.
  projection: s.object({ developments: s.array(s.object({
    attempt: s.object({ ...developmentFields, text: s.text, materialIds: refs }),
    change: s.object({ ...developmentResultFields, text: s.text, materialIds: refs }),
    futureChoice: developmentChoiceSchema, id: s.text }), 1, 3) }),
  factReview: s.object({ checks: s.array(factReviewCheckSchema(), 1, 3) }),
  causalReview: s.object({ checks: s.array(bridgeReviewCheckSchema(), 1, 3) }),
  goal: s.object({ goalMaterialId: s.either(s.text, s.nil) }),
  suggestion: s.object({ suggestion: s.text }),
  storyDirections: s.object({ directions: s.array(s.object({
    id: s.text, title: s.text, choice: s.text, consequence: s.text,
  }), 1, 2) }),
  // New model requests only select canonical IDs. Keep legacy decoding in the
  // domain parser, without inviting fresh rewording through an anyOf branch.
  arrangement: s.object({ steps: s.array(
    s.object({ kind: s.enum('current-state', 'trigger', 'escalation', 'climax-choice', 'resolution'),
      candidateIds: refs, materialIds: refs, displayMaterialIds: refs }), 3, 5),
  supplements: s.array(s.object({ id: s.text, kind: s.enum('hypothesis', 'observation', 'criterion', 'condition'),
    text: s.text, question: s.text, materialIds: refs }), 0, 8) }),
  storyDesign: s.object({ steps: s.array(s.object({
    kind: s.enum('current-state', 'trigger', 'escalation', 'midpoint-turn', 'climax-choice', 'resolution'),
    text: s.text, materialIds: refs, action: s.either(s.text, s.nil), expectedChange: s.either(s.text, s.nil),
  }), 3, 6) }),
}

/** Bound reference encoding before generation, without treating IDs as proof
 * of story causality. Per-candidate membership is still checked locally. */
export function projectionOutputSchema(candidates: { materialIds: string[]; resultBasisIds: string[] }[]): OutputSchema {
  const schema = structuredClone(preparationOutputSchemas.projection)
  const development = schema.properties!.developments!
  development.minItems = candidates.length
  development.maxItems = candidates.length
  const fields = development.items!.properties!
  for (const [key, ids, minimum] of [
    ['attempt', [...new Set(candidates.flatMap(candidate => candidate.materialIds))], 1],
    ['change', [...new Set(candidates.flatMap(candidate => candidate.resultBasisIds))], 0],
  ] as const) fields[key]!.properties!.materialIds = s.array(ids.length ? s.enum(...ids) : s.text, minimum, ids.length)
  return schema
}

export function causalReviewOutputSchema(count: number, evidenceIds?: string[]): OutputSchema {
  const schema = structuredClone(preparationOutputSchemas.causalReview)
  schema.properties!.checks!.minItems = count
  schema.properties!.checks!.maxItems = count
  schema.properties!.checks!.items = bridgeReviewCheckSchema(evidenceIds)
  return schema
}

export function factReviewOutputSchema(candidateIds: string[], materialIds: string[], proposalIds: string[]): OutputSchema {
  return s.object({ checks: s.array(factReviewCheckSchema(candidateIds, materialIds, proposalIds), candidateIds.length, candidateIds.length) })
}

export const qualityOutputSchema = (criteria: string[], issue: OutputSchema = s.text): OutputSchema => s.object({
  checks: s.array(s.object({ criterion: s.enum(...criteria), passed: s.bool, evidence: s.text }), criteria.length, criteria.length),
  issues: s.array(issue, 0, 8),
})
export const storyWritingMainlineReviewSchema = s.object({
  verdict: s.enum('supported', 'drift', 'uncertain'),
  reason: s.text,
  evidenceIds: refs,
})
export const preparationQualitySchema = qualityOutputSchema(['facts', 'causality', 'requirements', 'author-control', 'questions'])
export const clarificationReviewSchema = s.object({ grounded: s.bool, dependsOnUnconfirmedPremise: s.bool })
export const headTailReviewSchema = s.object({ reviews: s.array(s.object({ optionId: s.text,
  keepsConfirmedGoal: s.bool, followsSelectedApproach: s.bool, climaxIsProtagonistAction: s.bool,
  resolutionFulfillsPlan: s.bool, transitionIsGrounded: s.bool }), 1, 3) })
export const openingContinuationReviewSchema = s.object({ continuesSelectedFocus: s.bool, distinctChoices: s.bool,
  checks: s.array(s.object({ id: s.text, verdict: s.enum('supported', 'unsupported'), sourceIds: refs, reason: s.text }), 1, 64),
  missingAuthorDetails: s.array(s.text, 0, 3) })
export const continuationOutputSchemas = {
  routing: s.object({ route: s.enum('action', 'question', 'closure', 'design'), unresolved: s.text, reason: s.text,
    sourceIds: refs, contradictions: s.array(s.object({ text: s.text, sourceIds: refs }), 0, 3) }),
  composition: s.object({ options: s.array(s.object({ label: s.text, action: s.text, proposedConsequence: s.text }), 1, 3) }),
  question: s.object({ questions: s.array(s.text, 1, 1) }),
  review: qualityOutputSchema(['continuity', 'causality', 'requirements', 'author-control']),
}
export const sceneOutputSchemas = {
  intent: s.either(s.object({ goal: s.text, tension: s.text, focusIds: refs }), s.object({ questions: s.array(question, 1, 8) })),
  composition: (authorAction: boolean) => s.object({
    attempt: s.object({ ...(authorAction ? {} : { action: s.text }), materialIds: refs, preconditionIds: refs }),
    development: s.object({ change: s.text, response: s.text, resultBasisIds: refs }),
  }),
  review: qualityOutputSchema(['boundaries', 'causality', 'state', 'scope'], s.object({ part: s.enum('attempt', 'development'), evidence: s.text })),
}

const evidence = s.array(s.either(s.object({ sourceId: s.text }), s.object(sourceSpan)))
const content = s.either(s.object({ kind: s.enum('source'), sourceId: s.text }),
  s.object({ kind: s.enum('quote'), ...sourceSpan }),
  s.object({ kind: s.enum('proposal'), text: s.text, evidence, unknownIds: refs }),
  s.object({ kind: s.enum('unknown'), text: s.text, unknownIds: refs }))
const node = (extra: Record<string, OutputSchema> = {}) => s.object({ id: s.text, content, ...extra })
export const reasoningOutputSchema = (stage: 'initial-design' | 'edit-preview'): OutputSchema => {
  const common = { protocol: s.enum(2), stage: s.enum(stage), status: s.enum('needs-review'),
    goal: s.either(s.nil, node(), s.object({ id: s.text, content: s.object({ kind: s.enum('locked-goal') }) })),
    constraints: s.array(node()), actions: s.array(node({ constraintIds: refs, relationIds: refs, unknownIds: refs, respondsToEditIds: refs }), 0, 12),
    relations: s.array(node({ relation: s.enum('cause', 'conflict', 'compatible', 'sequence'), fromIds: refs, toIds: refs })),
    unknowns: s.array(s.object({ id: s.text, question: s.text, sourceIds: refs, dependentIds: refs })) }
  return s.either(s.object({ ...common, outcome: s.enum('proposal'), steps: s.array(node({ kind: s.text, title: s.text,
    actionIds: refs, relationIds: refs, dependsOn: refs, respondsToEditIds: refs }), 1, 7) }),
    s.object({ ...common, outcome: s.enum('questions'), questions: s.array(s.object({ unknownId: s.text, dependentIds: refs }), 1, 8) }))
}
