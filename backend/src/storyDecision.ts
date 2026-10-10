import type { StorySourceFact } from '../../shared/story-contract.js'

export interface AuthorDecisionMaterial {
  action: string
  alternative: string
  fact: StorySourceFact
  riskFacts: StorySourceFact[]
}

/** A stated "whether" decision licenses a proposed negative action, not a cost. */
export function getAuthorDecisionMaterial(
  facts: readonly StorySourceFact[],
  goalFact: StorySourceFact,
  goal: string,
): AuthorDecisionMaterial {
  const active = facts.filter((fact) => fact.disposition !== 'parked')
  const explicit = active.map((fact) => ({ fact,
    action: fact.text.match(/(?:决定|选择|判断|不知道|不确定)\s*(?:是否|要不要)(?:该)?(.+?)[。！？；]*$/u)?.[1]?.trim(),
  })).filter((item): item is { fact: StorySourceFact; action: string } => Boolean(item.action))
  const selected = explicit.find((item) => item.fact.id === goalFact.id)
    ?? (explicit.length === 1 ? explicit[0] : undefined)
  const action = selected?.action ?? goal
  // Keep the alternative an action. Never turn a deadline, promise, or risk
  // into the other side, or infer that performing the action violates it.
  const alternative = action.startsWith('删掉') ? action.replace(/^删掉/u, '保留')
    : action.startsWith('删除') ? action.replace(/^删除/u, '保留')
      : action.startsWith('拆掉') ? action.replace(/^拆掉/u, '不拆').replace(/供电$/u, '')
        : /提交$/u.test(action) ? '暂不提交'
          : '暂不执行这项行动'
  return { action, alternative, fact: selected?.fact ?? goalFact,
    riskFacts: active.filter((fact) => /(?:可能|也许|风险|代价|失去|放弃|损失)/u.test(fact.text)
      && fact.id !== (selected?.fact.id ?? goalFact.id)) }
}

export function getAuthorDecisionCost(material: AuthorDecisionMaterial): string {
  // A risk in the same input is not proof that either choice causes it.
  return material.riskFacts.length
    ? `材料中的风险是${material.riskFacts.map((fact) => fact.text.trim().replace(/[。！？；]+$/u, '')).join('、')}，与行动的因果关系待作者确认`
    : '具体代价待作者确认'
}

export function renderAuthorDecisionChoice(
  subject: string,
  material: AuthorDecisionMaterial,
  constraint: string,
): string {
  return `暂定：${subject}需要选择${material.action}还是${material.alternative}；既有约束：${constraint}；代价：${getAuthorDecisionCost(material)}`
}
