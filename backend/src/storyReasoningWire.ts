import { AppError } from './qwen.js'
import { validateStoryReasoningProposal } from './storyReasoningContract.js'
import type { StoryReasoningProposal, StoryReasoningValidationContext } from '../../shared/story-reasoning-contract.js'

const invalid = (path: string): never => { throw new AppError(`${path}：模型协议2字段或内容类型不正确；不接受旧输出或补造依据。`, 502, 'STORY_REASONING_INVALID_OUTPUT') }
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path)
  return value as Record<string, unknown>
}
function exact(r: Record<string, unknown>, keys: string[], path: string) {
  const missing = keys.filter(k => !(k in r)), extra = Object.keys(r).filter(k => !keys.includes(k))
  if (missing.length || extra.length) invalid(`${path}（缺少 ${missing.join(', ') || '无'}；多余 ${extra.join(', ') || '无'}）`)
}

/** Model wire v2 -> stored contract v1. Only copies verified quotations or
 * supplied design text. No inference, reference repair or legacy fallback. */
export function parseStoryReasoningWire(value: unknown, context: StoryReasoningValidationContext): StoryReasoningProposal {
  const r = object(value, 'output')
  if (r.protocol !== 2) invalid('protocol')
  if ('designReview' in r) invalid('designReview（仅服务器记录作者审阅）')
  const node = (value: unknown, path: string, extra: string[] = []) => {
    const n = object(value, path); exact(n, ['id', 'content', ...extra], path)
    const c = object(n.content, `${path}.content`)
    const { content: _content, ...rest } = n
    if (c.kind === 'quote') {
      exact(c, ['kind', 'sourceId', 'quote'], `${path}.content`)
      return { ...rest, text: c.quote, basis: { kind: 'author-text', evidence: [{ sourceId: c.sourceId, quote: c.quote }] } }
    }
    if (c.kind === 'proposal') {
      exact(c, ['kind', 'text', 'evidence', 'unknownIds'], `${path}.content`)
      return { ...rest, text: c.text, basis: { kind: 'design-proposal', evidence: c.evidence, unknownIds: c.unknownIds } }
    }
    if (c.kind === 'unknown') {
      exact(c, ['kind', 'text', 'unknownIds'], `${path}.content`)
      return { ...rest, text: c.text, basis: { kind: 'unknown', unknownIds: c.unknownIds } }
    }
    if (c.kind === 'locked-goal' && path === 'goal' && context.lockedGoal !== undefined) {
      exact(c, ['kind'], `${path}.content`)
      // This is a reference to a server-owned intended goal, not a new fact.
      return { ...rest, text: context.lockedGoal, basis: { kind: 'design-proposal', evidence: [], unknownIds: [] } }
    }
    return invalid(`${path}.content`)
  }
  const list = (key: string, extra: string[] = []) => {
    if (!Array.isArray(r[key]) || r[key].length > 24) invalid(key)
    return (r[key] as unknown[]).map((n, i) => node(n, `${key}[${i}]`, extra))
  }
  const mapped = { ...r, protocol: 1, goal: r.goal === null ? null : node(r.goal, 'goal'),
    constraints: list('constraints'), actions: list('actions', ['constraintIds','relationIds','unknownIds','respondsToEditIds']),
    relations: list('relations', ['relation','fromIds','toIds']),
    ...(r.outcome === 'proposal' && context.stage !== 'action-candidates' ? { steps: list('steps', ['kind','title','actionIds','relationIds','dependsOn','respondsToEditIds']) } : {}),
  }
  const parsed = validateStoryReasoningProposal(mapped, context)
  return { ...parsed, designReview: { required: true, acceptedProposalIds: [] } }
}

/** Explicit serialization for prompt examples and model stubs. Never called
 * as a repair on an unvalidated model response. Stored sessions stay v1. */
export function storyReasoningWireExample(value: unknown, context: StoryReasoningValidationContext): Record<string, unknown> {
  const p = validateStoryReasoningProposal(value, context)
  const node = (n: any, goal = false) => {
    const { text, basis, ...rest } = n
    const content = goal && context.lockedGoal !== undefined ? { kind: 'locked-goal' }
      : basis.kind === 'author-text' ? { kind: 'quote', ...basis.evidence.find((e: any) => e.quote === text) }
      : basis.kind === 'unknown' ? { kind: 'unknown', text, unknownIds: basis.unknownIds }
      : { kind: 'proposal', text, evidence: basis.evidence, unknownIds: basis.unknownIds }
    return { ...rest, content }
  }
  const { designReview: _review, ...model } = p
  return { ...model, protocol: 2, goal: p.goal ? node(p.goal, true) : null, constraints: p.constraints.map(n => node(n)),
    actions: p.actions.map(n => node(n)), relations: p.relations.map(n => node(n)),
    ...('steps' in p ? { steps: p.steps.map(n => node(n)) } : {}),
  }
}
