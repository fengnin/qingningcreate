import { AppError } from './qwen.js'

export type DirectionConsequenceExcerpt = {
  id: string; candidateId: string; optionIndex: number; text: string; consequence: string
}

/** These are source slices, not program-inferred facts. Full consequences and
 * option context stay in the review request so conditions are never discarded. */
export function directionConsequenceCatalog(plans: readonly {
  id: string; options: readonly { consequence: string }[]
}[]): DirectionConsequenceExcerpt[] {
  return plans.flatMap((plan, candidateIndex) => plan.options.flatMap((option, optionIndex) => {
    const slices = option.consequence.split(/(?<=[，。！？；,;!?\n])/u).filter(Boolean)
    // Bound output cost without dropping any part of the original consequence.
    const groupSize = Math.max(1, Math.ceil(slices.length / 3))
    const excerpts: DirectionConsequenceExcerpt[] = []
    for (let offset = 0; offset < slices.length; offset += groupSize) {
      excerpts.push({ id: `effect-${candidateIndex}-${optionIndex}-${excerpts.length}`, candidateId: plan.id.trim(), optionIndex,
        text: slices.slice(offset, offset + groupSize).join(''), consequence: option.consequence })
    }
    return excerpts
  }))
}

export function parseDirectionConsequenceChecks(value: unknown, catalog: readonly DirectionConsequenceExcerpt[]) {
  const invalid = (): never => { throw new AppError('后果审阅必须恰好覆盖所有原文片段，使用合法ID、supported/unsupported及简短理由；不能漏掉后半句或补写结果。', 502, 'STORY_PREPARATION_INVALID_OUTPUT') }
  if (!Array.isArray(value) || value.length !== catalog.length) return invalid()
  const seen = new Set<string>()
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid()
    const check = raw as Record<string, unknown>
    if (Object.keys(check).length !== 6 || typeof check.id !== 'string' || seen.has(check.id)
      || !['asserted', 'conditional', 'uncertain', 'planned'].includes(String(check.resultStatus))
      || !['satisfied-by-action', 'explicit-condition', 'only-planned', 'missing', 'not-needed'].includes(String(check.prerequisiteStatus))
      || typeof check.prerequisite !== 'string' || check.prerequisite.length > 160
      || check.prerequisiteStatus !== 'not-needed' && !check.prerequisite.trim()
      || !['supported', 'unsupported'].includes(String(check.verdict)) || typeof check.reason !== 'string'
      || !check.reason.trim() || check.reason.length > 240) return invalid()
    const excerpt = catalog.find(entry => entry.id === check.id)
    if (!excerpt) return invalid()
    seen.add(check.id)
    // A plan for a later essential event cannot establish an unconditional
    // result now, even if the model's overall verdict says supported.
    const prematureCompletion = check.resultStatus === 'asserted'
      && ['only-planned', 'missing'].includes(String(check.prerequisiteStatus))
    return { ...excerpt, resultStatus: String(check.resultStatus), prerequisite: check.prerequisite,
      prerequisiteStatus: String(check.prerequisiteStatus),
      verdict: prematureCompletion ? 'unsupported' as const : check.verdict as 'supported' | 'unsupported',
      reason: prematureCompletion ? `原文断言变化成立，但关键前提“${check.prerequisite}”仅计划或缺失。${check.reason}` : check.reason }
  })
}
