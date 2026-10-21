import { AppError } from './qwen.js'

/** Initial model output is a short design, not a scene. Only this compiler
 * creates the presentation strings consumed by the existing editing flow. */
export function compileDirectionPlans(value: unknown, count = 3): unknown {
  const fail = (): never => { throw new AppError('方向设计须包含一个阻碍、两个应对及各自的可能代价。', 502, 'STORY_PREPARATION_INVALID_OUTPUT') }
  if (!value || typeof value !== 'object' || !('plans' in value)) return value
  const root = value as Record<string, unknown>
  if (Object.keys(root).some(key => key !== 'plans') || !Array.isArray(root.plans) || root.plans.length !== count) return fail()
  const shortText = (raw: unknown) => typeof raw === 'string' && raw.trim() ? raw.trim() : fail()
  return { candidates: root.plans.map(raw => {
    if (!raw || typeof raw !== 'object') return fail()
    const p = raw as Record<string, unknown>
    if (Object.keys(p).some(key => !['id', 'difficulty', 'options', 'materialIds', 'preconditionIds', 'resultBasisIds'].includes(key))
      || !Array.isArray(p.options) || p.options.length !== 2) return fail()
    const options = p.options.map(raw => {
      if (!raw || typeof raw !== 'object') return fail()
      const o = raw as Record<string, unknown>
      if (Object.keys(o).some(key => !['action', 'consequence'].includes(key))) return fail()
      return { action: shortText(o.action), consequence: shortText(o.consequence) }
    })
    return { id: shortText(p.id), action: `遇到的难处：${shortText(p.difficulty)}\n眼前的选择：${options[0]!.action}；还是${options[1]!.action}`,
      possibleResult: `选择一：${options[0]!.consequence}；选择二：${options[1]!.consequence}`,
      materialIds: p.materialIds, preconditionIds: p.preconditionIds, resultBasisIds: p.resultBasisIds, unknownIds: [] }
  }), questions: [] }
}
