import { randomUUID } from 'node:crypto'
import { AppError, requestQwenJson, summarizeModelResponse, withModelDiagnostic } from './qwen.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'
import type { StoryReasoningProposal, StoryReasoningStatement, StoryReasoningValidationContext } from '../../shared/story-reasoning-contract.js'
import type { CreativeBrief, CurveBeat, ProvisionalCurve, StoryCurveFoundation, StoryDesignRecord, StorySeed } from '../../shared/story-contract.js'

export const initialReasoningSystemPrompt = `你是故事设计提案生成器，输出 protocol=1 的 initial-design JSON，不输出执行结果或事实更新。
直接生成目标、行动、约束、关系、未知项和节点文案；服务端不会补写因果。事实不自动是冲突：没有期限不是阻碍，可兼容条件不能编成无法兼得。
author-text 的 text 必须等于 evidence 中的原文 quote；推断、未来行动及冲突/代价设计使用 design-proposal，保留 unknownIds。引用 ID 不证明因果成立。
不得把设计接受写成事件发生，不得替作者回答未知项。信息不足可返回 questions，不能用空泛二选一凑完整方案。
共同字段必须齐全且只能包含 protocol,stage,status,outcome,goal,constraints,actions,relations,unknowns 以及 steps 或 questions。
protocol:1, stage:initial-design, status:needs-review, outcome:proposal|questions。
statement={id,text,basis}；basis={kind:author-text,evidence:[{sourceId,quote}]} 或 {kind:design-proposal,evidence:[],unknownIds:[]} 或 {kind:unknown,unknownIds:[id]}。
constraint 是 statement。action 是 statement 加 constraintIds,relationIds,unknownIds,respondsToEditIds（初次为空）。
relation 是 statement 加 relation:cause|conflict|compatible|sequence,fromIds,toIds（两端引用来源或结构 ID）。
unknown={id,question,sourceIds,dependentIds}。
proposal 的 steps 为5至7个节点，包含 current-state,trigger,escalation,climax-choice,resolution，可加 character-tension,midpoint-turn；kind 不代表必须存在阻碍或损失，可以设计兼容的推进。
step 是 statement 加 kind,title,actionIds,relationIds,dependsOn（只引用节点且不循环）,respondsToEditIds:[]。每种 kind 只出现一次，id 为 beat-加kind。不要把目标与期限列为两个行动。
questions 输出 questions:[{unknownId,dependentIds}]，actions,relations 为空，goal 可为 null。
所有文本最多240字，title最多40字；输出完整 JSON，不含解释。`

export function createInitialReasoningContext(design: StoryDesignRecord, seed: StorySeed): StoryReasoningValidationContext {
  return { stage: 'initial-design', sources: design.sourceFacts.map(f => ({ id: f.id, text: f.text, authority: 'author-material' })),
    protectedSteps: [], requiredEditIds: [], ...(seed.lockedGoal ? { lockedGoal: seed.lockedGoal } : {}) }
}

/** Projection only: no role detection, causal joins or inferred cost/urgency.
 * The complete proposal is retained; strings are compatibility display slots,
 * not authority for narrative facts. Empty slots deliberately remain empty. */
export function mapInitialReasoningProposal(proposal: StoryReasoningProposal, design: StoryDesignRecord, brief: CreativeBrief): ProvisionalCurve {
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
  const steps = proposal.outcome === 'proposal' && 'steps' in proposal ? proposal.steps : []
  if (steps.length && (steps.length < 5 || new Set(steps.map(s => s.kind)).size !== steps.length
    || steps.some(s => s.id !== `beat-${s.kind}`)
    || !['current-state','trigger','escalation','climax-choice','resolution'].every(kind => steps.some(s => s.kind === kind))
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
    reasoning: structuredClone(proposal), preservedGoal: goal,
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
    return { ...f, coveredByBeatIds, disposition: coveredByBeatIds.length ? 'integrated' : 'needs-author-decision' }
  }) }
  const now = Date.now()
  return { id: `curve-${randomUUID()}`, title: '待审阅的故事设计', status: 'draft', brief, beats, instructions: [],
    reasoning: structuredClone(proposal), design: nextDesign, foundation,
    generation: { origin: 'model', dramaticMechanism: '模型直接生成待审结构；引用只证明来源，不证明因果成立' }, createdAt: now, updatedAt: now }
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
        temperature: attempt === 0 ? 0.35 : 0.1, maxTokens: 6500, diagnosticStage: 'initial-reasoning-generation' })
      const proposal = validateStoryReasoningProposal(output, context)
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
