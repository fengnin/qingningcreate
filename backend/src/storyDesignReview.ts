import { AppError } from './qwen.js'
import type { StoryReasoningProposal, StoryReasoningStatement } from '../../shared/story-reasoning-contract.js'
type DependencyStatement = StoryReasoningStatement & { actionIds?: string[]; relationIds?: string[]; constraintIds?: string[]; fromIds?: string[]; toIds?: string[]; dependsOn?: string[]; unknownIds?: string[] }

export function reasoningDesignStatements(p: StoryReasoningProposal): StoryReasoningStatement[] {
  return [...(p.goal ? [p.goal] : []), ...p.constraints, ...p.actions, ...p.relations, ...('steps' in p ? p.steps : [])]
}
export function requiredDesignProposalIds(p: StoryReasoningProposal): string[] {
  return reasoningDesignStatements(p).filter(s => s.basis.kind === 'design-proposal').map(s => s.id)
}
/** Keep only the selected node designs and their explicit dependencies. No
 * rejected design can supply a hidden rule to the accepted subset. */
export function selectReasoningDesign(p: StoryReasoningProposal, stepIds: string[]): StoryReasoningProposal {
  if (!('steps' in p)) return p
  const nodes = new Map(reasoningDesignStatements(p).map(s => [s.id, s]))
  const reachable = new Set<string>()
  const visit = (id: string) => {
    if (reachable.has(id)) return; reachable.add(id)
    const s = nodes.get(id) as DependencyStatement | undefined
    if (!s) return
    for (const id of [...(s.actionIds ?? []), ...(s.relationIds ?? []), ...(s.constraintIds ?? []), ...(s.fromIds ?? []), ...(s.toIds ?? []), ...(s.dependsOn ?? [])]) visit(id)
  }
  if (p.goal) visit(p.goal.id)
  for (const id of stepIds) visit(id)
  if (p.steps.some(s => reachable.has(s.id) && !stepIds.includes(s.id))) {
    throw new AppError('接受的设计依赖未采用的节点，请修改依赖或重新生成。', 409, 'STORY_DESIGN_REJECTED_DEPENDENCY')
  }
  const statements = reasoningDesignStatements(p).filter(s => reachable.has(s.id))
  const unknowns = new Set(statements.flatMap(s => [...(s.basis.kind === 'author-text' ? [] : s.basis.unknownIds), ...((s as DependencyStatement).unknownIds ?? [])]))
  const next = { ...p, steps: p.steps.filter(s => reachable.has(s.id)), actions: p.actions.filter(s => reachable.has(s.id)),
    constraints: p.constraints.filter(s => reachable.has(s.id)), relations: p.relations.filter(s => reachable.has(s.id)),
    unknowns: p.unknowns.filter(q => unknowns.has(q.id)).map(q => ({ ...q, dependentIds: q.dependentIds.filter(id => reachable.has(id)) })) }
  if (next.designReview) next.designReview = { required: true, acceptedProposalIds: next.designReview.acceptedProposalIds.filter(id => reachable.has(id)) }
  return next
}
export function reviewSelectedReasoningDesign(p: StoryReasoningProposal, stepIds: string[], acceptedIds: string[] = []): StoryReasoningProposal {
  const selected = selectReasoningDesign(p, stepIds)
  const allIds = requiredDesignProposalIds(p), selectedIds = requiredDesignProposalIds(selected)
  if (new Set(acceptedIds).size !== acceptedIds.length || acceptedIds.some(id => !allIds.includes(id))) {
    throw new AppError('设计审阅包含不存在或重复的提案。', 409, 'STORY_DESIGN_REVIEW_REQUIRED')
  }
  return reviewReasoningDesign(selected, acceptedIds.filter(id => selectedIds.includes(id)))
}
/** Explicit author receipt; never called with IDs supplied by the model. */
export function reviewReasoningDesign(p: StoryReasoningProposal, acceptedProposalIds: string[] = []): StoryReasoningProposal {
  if (!p.designReview) return p // Retain historical contract behavior.
  const required = requiredDesignProposalIds(p)
  const all = new Set([...p.designReview.acceptedProposalIds, ...acceptedProposalIds])
  if (new Set(acceptedProposalIds).size !== acceptedProposalIds.length || [...all].some(id => !required.includes(id))
    || required.some(id => !all.has(id))) {
    throw new AppError('请逐项审阅并接受设计提案；不采用的创意请拒绝或编辑相关节点。设计接受不代表规则已生效、动作已执行或后果已发生。', 409, 'STORY_DESIGN_REVIEW_REQUIRED')
  }
  return { ...structuredClone(p), designReview: { required: true, acceptedProposalIds: required } }
}
