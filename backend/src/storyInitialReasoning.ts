import { randomUUID } from 'node:crypto'
import { AppError, requestQwenJson, summarizeModelResponse, withModelDiagnostic } from './qwen.js'
import { parseStoryReasoningWire } from './storyReasoningWire.js'
import { storyReasoningSystemPrompt } from './storyReasoningPrompt.js'
import { reasoningOutputSchema } from './storyOutputSchemas.js'
import type { StoryReasoningProposal, StoryReasoningDesignStep, StoryReasoningStatement, StoryReasoningValidationContext } from '../../shared/story-reasoning-contract.js'
import type { CreativeBrief, CurveBeat, ProvisionalCurve, StoryCurveFoundation, StoryDesignRecord, StorySeed } from '../../shared/story-contract.js'

export const initialReasoningSystemPrompt = storyReasoningSystemPrompt('initial-design')

export function createInitialReasoningContext(design: StoryDesignRecord, seed: StorySeed): StoryReasoningValidationContext {
  return { stage: 'initial-design', sources: design.sourceFacts.map(f => ({ id: f.id, text: f.text, authority: 'author-material' })),
    protectedSteps: [], requiredEditIds: [], ...(seed.lockedGoal ? { lockedGoal: seed.lockedGoal } : {}) }
}

/** Projection only: no role detection, causal joins or inferred cost/urgency.
 * The complete proposal is retained; strings are compatibility display slots,
 * not authority for narrative facts. Empty slots deliberately remain empty. */
export function mapInitialReasoningProposal(proposal: StoryReasoningProposal, design: StoryDesignRecord, brief: CreativeBrief, options: { allowSimplePlan?: boolean } = {}): ProvisionalCurve {
  if (proposal.stage !== 'initial-design') throw new AppError('初次生成协议阶段不匹配。', 502, 'STORY_REASONING_INVALID_OUTPUT')
  const nodes = [...(proposal.goal ? [proposal.goal] : []), ...proposal.constraints, ...proposal.actions, ...proposal.relations,
    ...(proposal.outcome === 'proposal' && 'steps' in proposal ? proposal.steps : [])]
  const byId = new Map(nodes.map(n => [n.id, n]))
  const sourcesFor = (statement: StoryReasoningStatement, seen = new Set<string>()): string[] => {
    if (seen.has(statement.id)) return []
    seen.add(statement.id)
    const evidence = statement.basis.kind === 'unknown' ? [] : statement.basis.evidence.map(e => e.sourceId)
    const linked = statement as StoryReasoningStatement & { actionIds?: string[]; relationIds?: string[]; constraintIds?: string[]; fromIds?: string[]; toIds?: string[] }
    const refs = [...(linked.actionIds ?? []), ...(linked.relationIds ?? []), ...(linked.constraintIds ?? []), ...(linked.fromIds ?? []), ...(linked.toIds ?? [])]
    return [...new Set([...evidence, ...refs.flatMap((id: string) => byId.has(id) ? sourcesFor(byId.get(id)!, seen) : [])])]
  }
  const steps = proposal.outcome === 'proposal' && 'steps' in proposal ? orderReasoningSteps(proposal.steps) : []
  const normalizedProposal = structuredClone(proposal)
  if (normalizedProposal.outcome === 'proposal' && 'steps' in normalizedProposal) normalizedProposal.steps = steps
  const requiredKinds = options.allowSimplePlan ? ['current-state','trigger','resolution'] : ['current-state','trigger','escalation','climax-choice','resolution']
  if (steps.length && (steps.length < requiredKinds.length || new Set(steps.map(s => s.kind)).size !== steps.length
    || steps.some(s => s.id !== `beat-${s.kind}`)
    || !requiredKinds.every(kind => steps.some(s => s.kind === kind))
    || steps.some(s => s.dependsOn.some(id => !steps.some(parent => parent.id === id))))) {
    throw new AppError('初次设计必须保留唯一、完整且可追踪的曲线节点。', 502, 'STORY_REASONING_INVALID_OUTPUT')
  }
  const beats: CurveBeat[] = steps.map(s => ({ id: s.id, kind: s.kind, title: s.title, detail: s.text,
    source: s.basis.kind === 'author-text' ? 'user-input' : 'system-proposal', status: 'proposed',
    dependsOn: [...s.dependsOn], sourceFactIds: sourcesFor(s) }))
  const coverage = (kinds: string[]) => [...new Set(beats.filter(b => kinds.includes(b.kind)).flatMap(b => b.sourceFactIds ?? []))]
  const text = (kind: string) => steps.find(s => s.kind === kind)?.text ?? ''
  const conflicts = proposal.relations.filter(r => r.relation === 'conflict').map(r => r.text).join('\n')
  const goal = proposal.goal?.text ?? ''
  const foundation: StoryCurveFoundation | undefined = steps.length ? {
    reasoning: structuredClone(normalizedProposal), preservedGoal: goal,
    conflictCore: { goal, obstacle: conflicts, tradeoff: '' },
    predicament: { title: text('trigger'), variationAxis: 'commitment', immediateSituation: text('current-state'),
      obstacle: conflicts, tradeoff: '', urgency: '', choice: text('climax-choice'), plausibleCost: '' },
    middleDevelopment: { escalation: text('escalation'), midpoint: text('midpoint-turn'), climaxPressure: text('climax-choice') },
    storyEnds: { opening: text('current-state'), openingClue: text('trigger'), climax: text('climax-choice'), resolution: text('resolution'), cost: '', promise: '' },
    approach: { intent: proposal.actions.map(a => a.text).join('\n'), cost: '' },
    sourceFactIds: { conflictCore: coverage(['current-state','character-tension','trigger']), predicament: coverage(['trigger','escalation']),
      middleDevelopment: coverage(['escalation','midpoint-turn','climax-choice']), storyEnds: coverage(['current-state','climax-choice','resolution']) },
    beatSignatures: Object.fromEntries(beats.map(b => [b.id, [b.kind,b.detail.trim(),'', [...(b.sourceFactIds ?? [])].sort().join(',')].join('|')])),
  } : undefined
  const nextDesign: StoryDesignRecord = { ...design, foundation, sourceFacts: design.sourceFacts.map(f => {
    const coveredByBeatIds = beats.filter(b => b.sourceFactIds?.includes(f.id)).map(b => b.id)
    return { ...f, coveredByBeatIds, disposition: f.disposition === 'parked' ? 'parked' : coveredByBeatIds.length ? 'integrated' : 'needs-author-decision' }
  }) }
  const now = Date.now()
  return { id: `curve-${randomUUID()}`, title: '待审阅的故事设计', status: 'draft', brief, beats, instructions: [],
    reasoning: structuredClone(normalizedProposal), design: nextDesign, foundation,
    generation: { origin: 'model', dramaticMechanism: '模型直接生成待审结构；引用只证明来源，不证明因果成立' }, createdAt: now, updatedAt: now }
}

/** Keep model/source order where possible while ensuring every dependency is shown first. */
function orderReasoningSteps(steps: StoryReasoningDesignStep[]): StoryReasoningDesignStep[] {
  const byId = new Map(steps.map(step => [step.id, step]))
  const remaining = new Set(steps.map(step => step.id))
  const ordered: StoryReasoningDesignStep[] = []
  while (remaining.size) {
    const next = steps.find(step => remaining.has(step.id)
      && step.dependsOn.every(id => !byId.has(id) || !remaining.has(id)))
    if (!next) throw new AppError('故事设计节点的先后依赖存在循环，无法确定展示顺序。', 502, 'STORY_REASONING_INVALID_OUTPUT')
    ordered.push(next)
    remaining.delete(next.id)
  }
  return ordered
}

export async function generateInitialReasoningCurve(idea: string, seed: StorySeed, brief: CreativeBrief, design: StoryDesignRecord,
  excludedProposalDetails: readonly string[], maxAttempts: number): Promise<ProvisionalCurve> {
  const context = createInitialReasoningContext(design, seed)
  let failure: AppError | undefined
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let output: unknown
    try {
      output = await requestQwenJson({ systemPrompt: initialReasoningSystemPrompt,
        userPrompt: JSON.stringify({ idea, brief, context, excludedProposalDetails, validationFailure: failure?.message }),
        temperature: attempt === 0 ? 0.35 : 0.1, maxTokens: 6500, diagnosticStage: 'initial-reasoning-generation', outputSchema: reasoningOutputSchema('initial-design') })
      const proposal = parseStoryReasoningWire(output, context)
      if (proposal.outcome === 'proposal' && 'steps' in proposal && proposal.steps.some(s => excludedProposalDetails.includes(s.text))) {
        throw new AppError('输出重新采用了作者已拒绝的提案。', 502, 'STORY_REASONING_INVALID_OUTPUT')
      }
      return mapInitialReasoningProposal(proposal, design, brief)
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      failure = withModelDiagnostic(error, { stage: 'initial-reasoning-validation', attempt: attempt + 1, maxAttempts,
        reason: error.message, response: summarizeModelResponse(output) })
      if (!['STORY_REASONING_INVALID_OUTPUT','INVALID_MODEL_OUTPUT','QWEN_EMPTY_RESPONSE','QWEN_INVALID_JSON','QWEN_INVALID_RESPONSE'].includes(error.code)) throw failure
    }
  }
  throw new AppError('模型设计输出未通过合同校验，请重试；这不表示作者资料缺失。', 502,
    'STORY_CURVE_MODEL_GENERATION_FAILED', undefined, undefined, undefined, failure?.modelDiagnostic)
}
