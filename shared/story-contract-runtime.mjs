const storyFactKinds = Object.freeze([
  'obstacle',
  'deadline',
  'route',
  'transport',
  'resource',
  'access',
  'relationship',
  'rule',
  'context',
])

const storyApproachRequirementKinds = Object.freeze([
  'obstacle',
  'route',
  'transport',
  'resource',
  'access',
  'relationship',
  'rule',
])

const storyApproachCostTypes = Object.freeze([
  'time',
  'money',
  'access',
  'relationship',
  'safety',
  'goal',
  'uncertainty',
])

export const PREDICAMENT_CONTRACT_LIMITS = Object.freeze({
  minimumCandidateCount: 2,
  maximumCandidateCount: 3,
  minimumFactCount: 2,
  maximumFactCount: 6,
  maximumFactReferences: 3,
  maximumFactExcerptLength: 90,
})

const explicitCostTypes = Object.freeze([
  ['money', /元|费用|支付|花钱|金额|余额|超支|车费/],
  ['access', /门禁|权限|许可|登记|进入|通行|资格|证件/],
  ['relationship', /关系|信任|承诺|失约/],
  ['safety', /受伤|危险|安全|摔|风险加剧/],
  ['time', /分钟|时间|等待|延误|迟到|错过|耗时/],
  ['goal', /目标|无法完成|放弃|错失/],
  ['uncertainty', /可能|不确定|未必|无法确认|不保证|失败/],
])

const approachCostTypePriority = Object.freeze([
  'time',
  'money',
  'access',
  'relationship',
  'safety',
  'goal',
  'uncertainty',
])

export function isStoryFactKind(value) {
  return typeof value === 'string' && storyFactKinds.includes(value)
}

export function isStoryApproachRequirementKind(value) {
  return typeof value === 'string' && storyApproachRequirementKinds.includes(value)
}

export function isStoryApproachCostType(value) {
  return typeof value === 'string' && storyApproachCostTypes.includes(value)
}

export function inferApproachCostType(cost, costBasis, factsById) {
  const factKinds = getReferencedFacts(costBasis, factsById).map((fact) => fact.kind)
  const explicitCostType = getExplicitApproachCostType(cost)

  if (explicitCostType && factKinds.some((kind) => factSupportsCostType(kind, explicitCostType))) {
    return explicitCostType
  }

  return approachCostTypePriority.find((candidate) => (
    factKinds.some((kind) => factSupportsCostType(kind, candidate))
  )) ?? 'uncertainty'
}

export function hasGroundedPredicamentAnchors(factsById, obstacleFactId, urgencyFactId) {
  const obstacleFact = factsById.get(obstacleFactId)
  const urgencyFact = factsById.get(urgencyFactId)
  if (!obstacleFact || !urgencyFact) return false

  return obstacleFactId !== urgencyFactId
    && obstacleFact.mutability !== 'unknown'
    && urgencyFact.mutability !== 'unknown'
    && isStoryApproachRequirementKind(obstacleFact.kind)
    && urgencyFact.kind === 'deadline'
}

export function hasGroundedPredicamentApproach(approach, factsById, obstacleFactId) {
  const requirementsAreGrounded = approach.requirements.every((requirement) => {
    const fact = factsById.get(requirement.factId)
    return Boolean(
      fact
      && fact.mutability !== 'unknown'
      && fact.kind === requirement.kind
      && factIncludesExcerpt(fact.statement, requirement.excerpt),
    )
  })
  const costBasisIsGrounded = approach.costBasis.every((reference) => {
    const fact = factsById.get(reference.factId)
    return Boolean(fact && fact.mutability !== 'unknown' && factIncludesExcerpt(fact.statement, reference.excerpt))
  })
  const namesObstacleFact = approach.requirements.some((requirement) => requirement.factId === obstacleFactId)
  const supportsCostType = approach.costBasis.some((reference) => {
    const fact = factsById.get(reference.factId)
    return Boolean(fact && factSupportsCostType(fact.kind, approach.costType))
  })

  return requirementsAreGrounded
    && costBasisIsGrounded
    && namesObstacleFact
    && supportsCostType
    && hasExplicitApproachCostBasis(approach.cost, approach.costBasis, factsById)
}

function getReferencedFacts(references, factsById) {
  return references.flatMap((reference) => {
    const fact = factsById.get(reference.factId)
    return fact ? [fact] : []
  })
}

function getExplicitApproachCostType(cost) {
  const text = cost.toLowerCase()
  const match = explicitCostTypes.find(([, pattern]) => pattern.test(text))
  return match?.[0]
}

function hasExplicitApproachCostBasis(cost, costBasis, factsById) {
  const basisFacts = getReferencedFacts(costBasis, factsById)
  if (basisFacts.length !== costBasis.length) return false

  const explicitCostType = getExplicitApproachCostType(cost)
  if (explicitCostType && !basisFacts.some((fact) => factSupportsCostType(fact.kind, explicitCostType))) {
    return false
  }

  const citedStatements = basisFacts.map((fact) => normalizeGroundingText(fact.statement))
  return getExplicitCostQuantities(cost).every((quantity) => (
    citedStatements.some((statement) => statement.includes(normalizeGroundingText(quantity)))
  ))
}

function getExplicitCostQuantities(value) {
  return [...value.matchAll(/\d+(?:[.:：]\d+)?\s*(?:秒钟?|分钟|分|小时|天|元|块|米|公里|千米|次|%)/g)]
    .map((match) => match[0])
}

function normalizeGroundingText(value) {
  return value.replace(/\s/g, '').replace(/[：]/g, ':')
}

function factIncludesExcerpt(statement, excerpt) {
  return Boolean(excerpt.trim()) && statement.includes(excerpt)
}

function factSupportsCostType(factKind, costType) {
  if (costType === 'time') return factKind === 'deadline' || factKind === 'route' || factKind === 'transport'
  if (costType === 'money') return factKind === 'resource' || factKind === 'transport'
  if (costType === 'access') return factKind === 'access' || factKind === 'resource' || factKind === 'rule'
  if (costType === 'relationship') return factKind === 'relationship'
  if (costType === 'safety') return factKind === 'obstacle' || factKind === 'route' || factKind === 'transport' || factKind === 'rule'
  if (costType === 'goal') return factKind === 'obstacle' || factKind === 'deadline' || factKind === 'rule' || factKind === 'context'
  return factKind !== 'context'
}
