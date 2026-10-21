import { AppError } from './qwen.js'
import { shape as s } from './modelOutputSchema.js'

export type DirectionLogicPlan = {
  id: string
  difficulty: string
  options: { action: string; consequence: string }[]
}

// Kept first in the combined response, before goal/style/authority judgments.
// This changes review order, not the number of model requests.
export const directionLogicReviewGuidance = `提供structuredProposal时，先单独完成actionChecks，再做candidateChecks和五项总评。在actionChecks阶段只核对方向卡的因果可行性，不审文风、趣味、主线相关性、命名或作者权限，不扩写或改进故事。
对每个分支回答：按difficulty已有条件执行action后，consequence实际声称的结果能成立吗？逐项核对其中全部关键断言；前半句合理不能抵消后半句错误。
先在analysis核对需要的时间、金额或资源计算，再解释动作实际改变了什么、尚未改变什么，最后给verdict。时间和金额按原文计算；各卡为互斥备选，不能把其他卡的条件混入本卡。
verdict只用supported/unsupported/uncertain。unsupported须有原文支持的具体矛盾或缺失的关键作用：请求不是已获批准，约定未来归还不是已经完成交付；不能因为是未来提案就把无条件声称的成功解释成隐含条件。明确允许创作对方答应的情节，但原文必须写出该回应或条件，审阅者不能替原文补上。条件式与可能失败的合理尝试可成立，不要求保证成功；普通动作细节未展开不算缺失关键作用。条件统领其后的同组结果，不能割裂条件句后半句。不能把所有第三方回应一概判错。
无法确定依据时uncertain，不用猜测新规则来判通过或不通过。evidence只选本卡difficulty及对应分支action/consequence中的连续原文短句；不提供修复方案。actionChecks:[{id,branches:[{optionIndex,analysis,evidence,verdict}]}]，每卡一次，每分支一次、按原顺序，optionIndex=0或1。analysis不超过140字，evidence为1至3条短句。unsupported是独立缺陷，不被其他通过结论覆盖；uncertain不是通过。不提供structuredProposal时不返回actionChecks，保持编辑与问题路径原有规则。`

export function directionLogicReviewSchema(candidateIds: string[]) {
  return s.array(s.object({ id: s.enum(...candidateIds), branches: s.array(s.object({
    optionIndex: s.enum(0, 1), analysis: s.text, evidence: s.array(s.text, 1, 3),
    verdict: s.enum('supported', 'unsupported', 'uncertain'),
  }), 2, 2) }), candidateIds.length, candidateIds.length)
}

/** Encoding/coverage checks only. Story semantics remain a model judgment. */
export function parseDirectionLogicReview(value: unknown, plans: DirectionLogicPlan[]): string[] {
  const invalid = (): never => { throw new AppError('方向因果审阅未完成有效的分支与原文核对，请重试审阅。', 502, 'STORY_PREPARATION_INVALID_OUTPUT') }
  if (!Array.isArray(value) || value.length !== plans.length) return invalid()
  const seen = new Set<string>(), issues: string[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || seen.has(raw.id)) return invalid()
    const plan = plans.find(p => p.id === raw.id)
    if (!plan || !Array.isArray(raw.branches) || raw.branches.length !== plan.options.length) return invalid()
    seen.add(raw.id)
    for (let i = 0; i < plan.options.length; i++) {
      const branch = raw.branches[i], option = plan.options[i]!
      if (!branch || branch.optionIndex !== i || !['supported', 'unsupported', 'uncertain'].includes(branch.verdict)
          || typeof branch.analysis !== 'string' || !branch.analysis.trim() || branch.analysis.length > 500
          || !Array.isArray(branch.evidence) || branch.evidence.length < 1 || branch.evidence.length > 3
          || new Set(branch.evidence).size !== branch.evidence.length
          || branch.evidence.some((q: unknown) => typeof q !== 'string' || !q.trim()
            || ![plan.difficulty, option.action, option.consequence].some(text => text.includes(q)))) return invalid()
      // Uncertainty is a semantic result, not malformed output. Keep it as a
      // content issue so the normal proposal-regeneration path can replace an
      // ambiguous card instead of retrying the same review until it blocks.
      if (branch.verdict === 'uncertain') issues.push(`${plan.id} 分支${i + 1} 因果依据不足，无法确认：${branch.analysis}；原文：${branch.evidence.join(' / ')}`)
      if (branch.verdict === 'unsupported') issues.push(`${plan.id} 分支${i + 1} 因果不成立：${branch.analysis}；原文：${branch.evidence.join(' / ')}`)
    }
  }
  return issues
}
