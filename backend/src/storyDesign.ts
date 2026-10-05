import { randomUUID } from 'node:crypto'
import type {
  CreativeBrief,
  CurveBeat,
  StoryCurveFoundation,
  StoryDesignRecord,
  StorySeed,
  StorySourceFact,
} from '../../shared/story-contract.js'
import { getMissingStoryDesignSectionLabels } from '../../shared/story-design-rules.mjs'
import type { StoryDesignSectionLabel } from '../../shared/story-design-rules.mjs'
import { AppError } from './qwen.js'

const structuralBeatIds = {
  conflictCore: ['beat-current-state', 'beat-character-tension', 'beat-trigger'],
  predicament: ['beat-trigger', 'beat-escalation'],
  storyEnds: ['beat-current-state', 'beat-climax-choice', 'beat-resolution'],
  middleDevelopment: ['beat-escalation', 'beat-midpoint-turn', 'beat-climax-choice'],
} as const

export type StoryDesignSection = StoryDesignSectionLabel

/**
 * Return design areas that no longer have enough live curve material. The
 * minimums deliberately allow a valid five-beat curve (which has no explicit
 * midpoint node) while still preventing authors from confirming a curve after
 * removing the only node that carried a whole design area.
 */
export function getMissingStoryDesignSections(
  design: StoryDesignRecord | undefined,
  beats: readonly CurveBeat[],
): StoryDesignSection[] {
  return getMissingStoryDesignSectionLabels(design, getActiveBeatIds(beats))
}

/**
 * Preserve authored material before any model interpretation. The segmentation
 * intentionally keeps the original wording; it is a traceability aid, not an
 * attempt to infer new story facts.
 */
export function createStoryDesignRecord(idea: string, seed: StorySeed): StoryDesignRecord {
  const sourceTexts = collectAuthorSourceFacts(idea, seed)
  return {
    id: `design-${randomUUID()}`,
    sourceFacts: sourceTexts.map((text, index) => ({
      id: `source-fact-${index + 1}`,
      text,
      source: 'user-input',
      disposition: 'needs-author-decision',
      coveredByBeatIds: [],
    })),
    conflictCoreBeatIds: [...structuralBeatIds.conflictCore],
    predicamentBeatIds: [...structuralBeatIds.predicament],
    storyEndBeatIds: [...structuralBeatIds.storyEnds],
    middleDevelopmentBeatIds: [...structuralBeatIds.middleDevelopment],
  }
}

/**
 * Assemble the concrete design map while the curve is still a draft.  The
 * map deliberately contains the same design decisions that the later story
 * stages consume; it is not a second set of generic labels.
 */
export function buildStoryCurveFoundation(
  beats: readonly CurveBeat[],
  brief: CreativeBrief,
  seed: Pick<StorySeed, 'activeSituation' | 'lockedGoal'>,
): StoryCurveFoundation | undefined {
  const active = beats.filter((beat) => beat.status !== 'rejected')
  const byKind = (kind: CurveBeat['kind']): CurveBeat | undefined => active.find((beat) => beat.kind === kind)
  const current = byKind('current-state')
  const trigger = byKind('trigger')
  const escalation = byKind('escalation')
  const midpoint = byKind('midpoint-turn')
  const climax = byKind('climax-choice')
  const resolution = byKind('resolution')
  if (!current || !trigger || !escalation || !climax || !resolution) return undefined

  const characterTension = byKind('character-tension')
  const preservedGoal = (seed.lockedGoal?.trim() || current.detail.trim() || seed.activeSituation.trim()).trim()
  // Causal anchors are the compact planner handles selected while the draft
  // is being reviewed. Prefer them here so the confirmed foundation does not
  // turn a short deadline or promise into a repeated full sentence.
  const triggerAnchor = getFoundationBeatAnchor(trigger, '当前触发点')
  const escalationAnchor = getFoundationBeatAnchor(escalation, '当前阻碍')
  const midpointAnchor = midpoint
    ? getFoundationBeatAnchor(midpoint, '原来的办法不再足够')
    : escalationAnchor
  const climaxAnchor = getFoundationBeatAnchor(climax, '选择会带来明确代价')
  const forceLabel = brief.dramaticForces[0] ? getDramaticForceLabel(brief.dramaticForces[0]) : '开放方向'
  const variationAxis: StoryCurveFoundation['predicament']['variationAxis'] = brief.dramaticForces.includes('relationship-tension')
    ? 'relationship'
    : brief.dramaticForces.includes('cost')
      ? 'commitment'
      : brief.dramaticForces.includes('surprise')
        ? 'time'
        : brief.tones.some((tone) => tone === 'mystery' || tone === 'fantasy')
          ? 'resource'
          : 'commitment'

  const conflictObstacle = joinCausalDetails([
    triggerAnchor,
    escalationAnchor,
    characterTension ? getFoundationBeatAnchor(characterTension, '') : undefined,
  ], '当前办法会被这道阻碍打断')
  const tradeoff = getFoundationTradeoff(climax.detail, climaxAnchor)
  // Urgency belongs to the first concrete interruption, while the plausible
  // cost belongs to the choice that follows. Reading both from the same
  // midpoint sentence made the frozen map look like a set of duplicated
  // labels instead of a progression.
  const urgency = triggerAnchor
  const plausibleCost = getFoundationCost(
    resolution.detail,
    getFoundationCost(climax.detail, resolution.causalAnchor ?? '选择会改变目标和关系'),
  )
  const openingClue = triggerAnchor
  const opening = current.detail.trim()
  const middleEscalation = escalationAnchor
  const midpointPressure = midpointAnchor
  const climaxPressure = tradeoff
  const decisionLabel = getFoundationDecisionLabel(preservedGoal)
  const predicamentObstacle = `${shortenFoundationLabel(triggerAnchor)}使${decisionLabel}不能照原安排推进；${shortenFoundationLabel(escalationAnchor)}把取舍推到眼前。`

  const allSourceFactIds = getSourceFactIds(active)
  const sourceFactIds = {
    conflictCore: getSourceFactIds([current, characterTension, trigger]),
    predicament: getSourceFactIds([trigger, escalation]),
    middleDevelopment: getSourceFactIds([escalation, midpoint, climax]),
    storyEnds: getSourceFactIds([current, climax, resolution]),
  }
  // A sparse idea may have one source fact that is intentionally developed
  // through a system proposal rather than copied into every card. Keep that
  // trace visible in each design area so the author can see that the single
  // fact is the common causal material, not an unresolved omission.
  for (const section of Object.keys(sourceFactIds) as Array<keyof typeof sourceFactIds>) {
    if (!sourceFactIds[section].length) sourceFactIds[section] = [...allSourceFactIds]
  }
  const beatSignatures = Object.fromEntries(active.map((beat) => [
    beat.id,
    createBeatSignature(beat),
  ]))

  return {
    conflictCore: {
      goal: preservedGoal,
      obstacle: conflictObstacle,
      tradeoff,
    },
    preservedGoal,
    predicament: {
      title: `${forceLabel} · ${shortenFoundationLabel(triggerAnchor)}带来的困境`,
      variationAxis,
      immediateSituation: current.detail.trim(),
        obstacle: shortenFoundationLabel(predicamentObstacle),
        tradeoff,
        urgency,
        choice: tradeoff,
        plausibleCost,
    },
    middleDevelopment: {
        escalation: middleEscalation,
        midpoint: midpointPressure,
        climaxPressure,
    },
    storyEnds: {
      opening,
        openingClue,
        // Keep the reviewed display sentences for the two ends. The compact
        // causal handles above are used by the planner, while these fields are
        // the author's visible wording carried into the confirmed map.
        climax: climax.detail.trim(),
        resolution: resolution.detail.trim(),
      cost: plausibleCost,
      promise: `围绕${shortenFoundationLabel(decisionLabel)}处理${shortenFoundationLabel(escalationAnchor)}，让${forceLabel}的取舍决定结局变化。`,
    },
    approach: {
      intent: `先处理${shortenFoundationLabel(triggerAnchor)}带来的限制，再围绕${shortenFoundationLabel(decisionLabel)}回应${shortenFoundationLabel(escalationAnchor)}。`,
      cost: plausibleCost,
    },
    sourceFactIds,
    beatSignatures,
  }
}

function shortenFoundationLabel(value: string): string {
  const normalized = value.trim()
  return normalized.length > 76 ? `${normalized.slice(0, 76)}…` : normalized
}

function getFoundationCost(value: string, fallback: string): string {
  const cleaned = value
    .replace(/^暂定[：:]/u, '')
    .replace(/[“”"']/gu, '')
    .trim()
  const clauses = cleaned.split(/[，。！？；\n]/u).map((part) => part.trim()).filter((part) => part.length >= 4)
  const costClause = [...clauses].reverse().find((part) => /(?:还是|放弃|失去|承担|代价|无法同时|暂缓|留下|改变|改用|局限)/u.test(part))
  if (costClause) {
    const choice = costClause.match(/(?:必须在|在)(.+?)与(.+?)之间(?:作出选择|放弃一项条件|取舍)/u)
    if (choice?.[1] && choice[2]) {
      return shortenFoundationLabel(`无法同时保留${choice[1].trim()}和${choice[2].trim()}`)
    }
    const consequence = costClause.match(/(?:会|将|只能|必须)(.+)$/u)
    if (consequence?.[1] && !/(?:选择|取舍|放弃一项条件)/u.test(consequence[1])) {
      const consequenceText = consequence[1].trim()
      if (consequenceText.length >= 4) return shortenFoundationLabel(consequenceText)
    }
    const explicitCost = costClause
      .replace(/^(?:代价(?:是|还包括)|需要承担|必须承担)\s*/u, '')
      .trim()
    if (explicitCost && explicitCost !== costClause) return shortenFoundationLabel(explicitCost)
    return shortenFoundationLabel(costClause)
  }
  return shortenFoundationLabel(getFoundationAnchor(cleaned, fallback))
}

/**
 * Confirm that the foundation was produced from the exact live draft currently
 * being reviewed. Legacy foundations without signatures intentionally fail so
 * they cannot silently become the source of a new narrative path.
 */
export function isStoryCurveFoundationCurrent(
  foundation: StoryCurveFoundation | undefined,
  beats: readonly CurveBeat[],
): boolean {
  if (!foundation?.beatSignatures) return false
  const active = beats.filter((beat) => beat.status !== 'rejected')
  const expected = Object.fromEntries(active.map((beat) => [beat.id, createBeatSignature(beat)]))
  const actualEntries = Object.entries(foundation.beatSignatures)
  const expectedEntries = Object.entries(expected)
  if (actualEntries.length !== expectedEntries.length) return false
  return expectedEntries.every(([beatId, signature]) => foundation.beatSignatures?.[beatId] === signature)
}

function getSourceFactIds(beats: Array<CurveBeat | undefined>): string[] {
  return [...new Set(beats.flatMap((beat) => beat?.sourceFactIds ?? []))]
}

function createBeatSignature(beat: CurveBeat): string {
  return [
    beat.kind,
    beat.detail.trim(),
    beat.causalAnchor?.trim() ?? '',
    [...(beat.sourceFactIds ?? [])].sort().join(','),
  ].join('|')
}

function getDramaticForceLabel(force: CreativeBrief['dramaticForces'][number]): string {
  const labels: Record<CreativeBrief['dramaticForces'][number], string> = {
    misunderstanding: '误会机制',
    cost: '代价机制',
    surprise: '意外机制',
    contrast: '反差机制',
    'relationship-tension': '关系机制',
  }
  return labels[force]
}

function getFoundationAnchor(value: string, fallback: string): string {
  const cleaned = value
    .replace(/^暂定[：:]/u, '')
    .replace(/^(?:作者(?:第一次)?(?:明确)?编辑|作者指令|作者调整)[：:]?/u, '')
    .replace(/[“”"']/gu, '')
    .trim()
  const clauses = cleaned
    .split(/[，。！？；\n]/u)
    .map((part) => part.trim().replace(/^(?:而是|也是|并且|却|但)\s*/u, ''))
    .filter((part) => part.length >= 4)
  const normalized = clauses
    .map((part, index) => ({
      part,
      index,
      score: scoreFoundationClause(part),
    }))
    .sort((left, right) => right.score - left.score || right.part.length - left.part.length || left.index - right.index)
    .find(({ part }) => !isFoundationMetaClause(part))
    ?.part ?? fallback
  return normalized.length > 72 ? `${normalized.slice(0, 72)}…` : normalized
}

function getFoundationBeatAnchor(beat: CurveBeat, fallback: string): string {
  const causalAnchor = beat.causalAnchor?.trim()
  if (causalAnchor && !isFoundationMetaClause(causalAnchor)) {
    return shortenFoundationLabel(causalAnchor.replace(/^暂定[：:]/u, '').trim())
  }
  return getFoundationAnchor(beat.detail, fallback)
}

function getFoundationTradeoff(detail: string, fallback: string): string {
  const cleaned = detail
    .replace(/^暂定[：:]/u, '')
    .replace(/[“”"']/gu, '')
    .trim()
  const clauses = cleaned
    .split(/[。！？；]/u)
    .map((part) => part.trim())
    .filter(Boolean)
  const candidate = clauses.find((part) => /(?:必须在|选择|取舍|放弃|还是|承担)/u.test(part))
  return shortenFoundationLabel(candidate ?? fallback)
}

function getFoundationDecisionLabel(goal: string): string {
  const cleaned = goal
    .replace(/^当前(?:目标|想法)[：:]\s*/u, '')
    .replace(/^(?:想要|想|希望|打算|准备|计划)\s*/u, '')
    .trim()
  const decision = cleaned.match(/(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (decision?.[1]) return `是否${shortenFoundationLabel(decision[1].trim())}`
  if (cleaned.startsWith('是否')) return shortenFoundationLabel(cleaned)
  return `是否${shortenFoundationLabel(cleaned || '作出选择')}`
}

function scoreFoundationClause(value: string): number {
  let score = Math.min(value.length, 28) / 8
  if (/(?:选择|决定|判断|承诺|归还|删掉|保留|放弃|改变|回应|取舍|代价|阻碍|关系|目标|名字|作品|投影仪)/u.test(value)) score += 8
  if (/(?:必须|不能|无法|不再|继续|仍然|会让|因此)/u.test(value)) score += 3
  if (/(?:发现|意识到|知道|认为)$/u.test(value)) score -= 8
  if (/^(?:面对|围绕|关于|因此|继续|如果|若|让|需要|主角|她|他)\s*$/u.test(value)) score -= 12
  return score
}

function isFoundationMetaClause(value: string): boolean {
  return /^(?:面对|围绕|关于|因此|继续|如果|若|让|需要|主角|她|他)\s*$/u.test(value)
    || /^(?:[^，。！？；]{0,10})(?:发现|意识到|知道|认为)$/u.test(value)
}

function joinCausalDetails(values: Array<string | undefined>, fallback: string): string {
  const unique = [...new Set(values
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => getFoundationAnchor(value, ''))
    .filter(Boolean))]
  return unique.slice(0, 3).join('；') || fallback
}

export function ensureStoryDesignRecord(
  design: StoryDesignRecord | undefined,
  idea: string,
  seed: StorySeed,
): StoryDesignRecord {
  return design ?? createStoryDesignRecord(idea, seed)
}

export function updateStoryDesignCoverage(
  design: StoryDesignRecord,
  beats: readonly CurveBeat[],
): StoryDesignRecord {
  const activeBeats = getActiveBeats(beats)
  const activeBeatIds = new Set(activeBeats.map((beat) => beat.id))
  const sourceFacts = design.sourceFacts.map((fact) => {
    const liveCoverage = getLiveCoverageForFact(activeBeats, fact)
    // Keep prior coverage as an audit trail while a fact is parked. This is
    // intentionally not treated as live use by getParkedStorySourceFactsUsedByCurve;
    // it lets the author see what the material used to support and restore it
    // explicitly without silently reintroducing it into the narrative.
    const coveredByBeatIds = fact.disposition === 'parked'
      ? [...new Set([
          ...fact.coveredByBeatIds.filter((id) => activeBeatIds.has(id)),
          ...liveCoverage,
        ])]
      : liveCoverage
    return {
      ...fact,
      coveredByBeatIds,
      // Parking is an explicit author decision. A later edit may show where
      // the material could fit again, but it remains parked until the author
      // explicitly brings it back into this version.
      disposition: getUpdatedFactDisposition(fact.disposition, coveredByBeatIds),
    }
  })
  return {
    ...design,
    sourceFacts,
    conflictCoreBeatIds: design.conflictCoreBeatIds.filter((id) => activeBeatIds.has(id)),
    predicamentBeatIds: design.predicamentBeatIds.filter((id) => activeBeatIds.has(id)),
    storyEndBeatIds: design.storyEndBeatIds.filter((id) => activeBeatIds.has(id)),
    middleDevelopmentBeatIds: design.middleDevelopmentBeatIds.filter((id) => activeBeatIds.has(id)),
  }
}

export function getUnresolvedStorySourceFacts(design: StoryDesignRecord | undefined): StorySourceFact[] {
  return design?.sourceFacts.filter((fact) => fact.disposition === 'needs-author-decision') ?? []
}

/**
 * A parked fact is an explicit author decision to keep material out of this
 * version. It must not remain embedded in a live curve node through a broad
 * aggregate sentence or a stale sourceFactIds claim.
 */
export function getParkedStorySourceFactsUsedByCurve(
  design: StoryDesignRecord | undefined,
  beats: readonly CurveBeat[],
): StorySourceFact[] {
  if (!design) return []
  const activeBeats = getActiveBeats(beats)
  return design.sourceFacts.filter((fact) => (
    fact.disposition === 'parked'
    && activeBeats.some((beat) => (
      // New curve records carry an explicit sourceFactIds list. Once that
      // list exists, it is the author's/model's traceability decision and must
      // take precedence over substring matching (for example, a parked goal
      // can naturally occur inside a larger, still-integrated sentence).
      beat.sourceFactIds !== undefined
        ? beat.sourceFactIds.includes(fact.id)
        : isTextGroundedToFact(beat.detail, fact.text)
    ))
  ))
}

export function setStorySourceFactDisposition(
  design: StoryDesignRecord,
  factId: string,
  disposition: 'parked' | 'integrated',
): StoryDesignRecord {
  const target = design.sourceFacts.find((fact) => fact.id === factId)
  if (!target) throw new AppError('要处理的原始材料不存在，请刷新后重试。', 409, 'STORY_SESSION_CONFLICT')
  if (disposition === 'integrated' && !target.coveredByBeatIds.length) {
    throw new AppError('这条材料尚未被曲线承接，请先编辑或重推相关节点。', 400, 'STORY_SOURCE_FACT_NOT_COVERED')
  }

  return {
    ...design,
    sourceFacts: design.sourceFacts.map((fact) => (
      fact.id === factId ? { ...fact, disposition } : fact
    )),
  }
}

export function getDramaticMechanism(brief: CreativeBrief): string {
  const force = brief.dramaticForces[0]
  const tonalFocus = getTonalMechanismFocus(brief)
  switch (force) {
    case 'misunderstanding': return `误会让原计划失效；主角必须在澄清与承担误解的后果之间决定${tonalFocus}`
    case 'cost': return `目标必须以一项具体放弃或承担为代价；主角不能同时保住两件重要的事${tonalFocus}`
    case 'surprise': return `意外改变时机、资源或信息；主角必须放弃原办法的一部分来继续目标${tonalFocus}`
    case 'contrast': return `主角最依赖的办法反而暴露弱点；主角必须承认旧办法解决不了这次问题${tonalFocus}`
    case 'relationship-tension': return `关系中的承诺或分歧直接阻断目标；主角必须回应关系而非只完成任务${tonalFocus}`
    default: return `围绕已知材料逐步增加阻碍、代价和主动选择${tonalFocus}`
  }
}

export function getSourceFactTexts(design: StoryDesignRecord | undefined): string[] {
  return design?.sourceFacts.map((fact) => fact.text) ?? []
}

export function deriveCoveredSourceFactIds(
  design: StoryDesignRecord,
  detail: string,
  includeParked = false,
): string[] {
  return design.sourceFacts
    .filter((fact) => includeParked || fact.disposition !== 'parked')
    .filter((fact) => isTextGroundedToFact(detail, fact.text))
    .map((fact) => fact.id)
}

function collectAuthorSourceFacts(idea: string, seed: StorySeed): string[] {
  const text = normalizeText(idea)
  const collected: Array<{ text: string; priority: number }> = []

  // Prefer atomic clauses from the author's text.  A whole sentence that is
  // made up of those clauses is not another fact and must not be re-added.
  for (const sentence of text.split(/[。！？；]+/u)) {
    const normalizedSentence = normalizeText(sentence)
    if (!normalizedSentence) continue
    const clauses = normalizedSentence
      .split(/[，、]/u)
      .map(normalizeText)
      .filter((clause) => clause.length >= 3)
    for (const clause of (clauses.length > 1 ? clauses : [normalizedSentence])) {
      collected.push({ text: clause, priority: 3 })
    }
  }

  for (const fact of seed.lockedFacts) {
    collected.push({ text: normalizeText(fact), priority: 2 })
  }
  if (seed.lockedGoal) collected.push({ text: normalizeText(seed.lockedGoal), priority: 1 })

  const unique = dedupeAuthorFacts(collected.filter(({ text: value }) => Boolean(value)), text)
  return unique.length ? unique : [text || '作者尚未提供可拆分的原始材料']
}

function dedupeAuthorFacts(values: readonly { text: string; priority: number }[], originalIdea: string): string[] {
  // Preserve the author's original order. Sorting by length makes a rich
  // paragraph look like unrelated facts and causes later beats to inherit the
  // wrong clause. Duplicate entries are replaced in place by the richer form.
  const kept: Array<{ text: string; compact: string; canonical: string; priority: number }> = []

  for (const raw of values) {
    const candidate = { text: normalizeText(raw.text), priority: raw.priority }
    if (!candidate.text) continue
    const compact = compactFact(candidate.text)
    const canonical = canonicalFact(candidate.text)
    if (compact.length < 3) continue
    const duplicate = kept.find((existing) => (
      existing.compact === compact
      || (canonical.length >= 4 && existing.canonical === canonical)
      || (Math.min(existing.compact.length, compact.length) >= 6
        && (existing.compact.includes(compact) || compact.includes(existing.compact))
        && isNearDuplicateFact(existing.text, candidate.text))
    ))
    if (duplicate) {
      // Keep the author's richer clause, while allowing a short explicit goal
      // to survive when it is not actually represented in the prose.
       if (candidate.priority > duplicate.priority
         || (candidate.priority === duplicate.priority && candidate.text.length > duplicate.text.length)) {
         duplicate.text = candidate.text
         duplicate.compact = compact
         duplicate.canonical = canonical
         duplicate.priority = candidate.priority
      }
      continue
    }
    kept.push({ text: candidate.text, compact, canonical, priority: candidate.priority })
  }

  // For a one-clause idea, the explicit goal is the useful atomic fact; the
  // subject-plus-goal sentence is only a larger restatement of it.
  const compactOriginal = compactFact(originalIdea)
  const explicitGoal = values.find(({ priority, text }) => priority === 1 && text)?.text
  if (explicitGoal && compactOriginal.includes(compactFact(explicitGoal))
    && values.filter(({ priority }) => priority >= 3).length <= 1) {
    const goalCompact = compactFact(explicitGoal)
    return [explicitGoal, ...kept.filter((candidate) => candidate.compact !== compactOriginal && candidate.compact !== goalCompact).map(({ text }) => text)]
  }

  // Keep a short explicit goal for a bare idea. Several existing workflows use
  // it as the stable anchor while the longer subject phrase remains context.
  if (explicitGoal && !kept.some((candidate) => candidate.text === explicitGoal)) {
    const ideaLength = compactFact(originalIdea)
    const goalLength = compactFact(explicitGoal).length
    if (ideaLength.length <= goalLength + 6) {
      kept.push({
        text: explicitGoal,
        compact: compactFact(explicitGoal),
        canonical: canonicalFact(explicitGoal),
        priority: 4,
      })
    }
  }

  // A whole sentence is an audit copy, not a second fact, when two or more
  // atomic clauses already cover it. Remove it after the pairwise pass.
  return kept
    .filter((candidate) => {
      const contained = kept.filter((other) => (
        other !== candidate
        && other.compact.length >= 6
        && candidate.compact.includes(other.compact)
      ))
      return contained.length < 2
    })
    .map(({ text }) => text)
}

/**
 * Normalize decision wording before comparing source facts. Rich ideas often
 * state the same decision three ways ("想在展出前决定要不要...",
 * "决定要不要...", and an explicit "是否..."). Those are one author fact,
 * not three independent items for the curve to repeat.
 */
function canonicalFact(value: string): string {
  let normalized = stripFactLead(value)
    .replace(/^(?:她|他|其|主角|我|你)\s*/u, '')
    .trim()

  const decision = normalized.match(/(?:想|希望|打算|准备|计划|决定|选择|判断|确认)(?:在[^，。！？；]{0,24})?(?:决定|选择|判断|确认)?(?:要不要|是否)(.+)$/u)
  if (decision?.[1]) return compactFact(decision[1])

  const explicitDecision = normalized.match(/(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (explicitDecision?.[1]) return compactFact(explicitDecision[1])

  const leadingDecision = normalized.match(/^(?:是否|要不要)(.+)$/u)
  if (leadingDecision?.[1]) return compactFact(leadingDecision[1])

  normalized = normalized
    .replace(/^(?:想|希望|打算|准备|计划)\s*/u, '')
    .replace(/^(?:在[^，。！？；]{0,24})前\s*/u, '')
    .replace(/^(?:是否|要不要)\s*/u, '')
  return compactFact(normalized)
}

function isNearDuplicateFact(left: string, right: string): boolean {
  const normalizedLeft = stripFactLead(left)
  const normalizedRight = stripFactLead(right)
  return normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft)
    || sharedFactTokenCount(normalizedLeft, normalizedRight) >= 2
}

function stripFactLead(value: string): string {
  return value
    .replace(/^(?:却|但|并且|同时|然后|随后|她|他|其|并)\s*/u, '')
    .trim()
}

function sharedFactTokenCount(left: string, right: string): number {
  const leftTokens = new Set(left.match(/[\p{L}\p{N}]{2,}/gu) ?? [])
  return (right.match(/[\p{L}\p{N}]{2,}/gu) ?? [])
    .filter((token) => leftTokens.has(token)).length
}

function compactFact(value: string): string {
  return value.replace(/[，。！？；、\s]/gu, '')
}

function isBeatGroundedToFact(beat: CurveBeat, fact: StorySourceFact): boolean {
  return isTextGroundedToFact(beat.detail, fact.text)
}

function getActiveBeats(beats: readonly CurveBeat[]): CurveBeat[] {
  return beats.filter((beat) => beat.status !== 'rejected')
}

function getActiveBeatIds(beats: readonly CurveBeat[]): Set<string> {
  return new Set(getActiveBeats(beats).map((beat) => beat.id))
}

function getLiveCoverageForFact(beats: readonly CurveBeat[], fact: StorySourceFact): string[] {
  return beats
    .filter((beat) => {
      // An explicit sourceFactIds list is the author's/model's traceability
      // claim. Do not let a long verbatim paragraph in one node accidentally
      // claim every smaller fact as covered.
      if (beat.sourceFactIds !== undefined) return beat.sourceFactIds.includes(fact.id)
      return isBeatGroundedToFact(beat, fact)
    })
    .map((beat) => beat.id)
}

function getUpdatedFactDisposition(
  current: StorySourceFact['disposition'],
  coveredByBeatIds: readonly string[],
): StorySourceFact['disposition'] {
  if (current === 'parked') return 'parked'
  return coveredByBeatIds.length ? 'integrated' : 'needs-author-decision'
}

function getTonalMechanismFocus(brief: CreativeBrief): string {
  if (brief.tones.includes('mystery')) return '，并把信息缺口留给作者继续判断'
  if (brief.tones.includes('romance')) return '，并让人物不能再回避心意与行动的差距'
  if (brief.tones.includes('friendship')) return '，并让关系中的信任成为选择的一部分'
  if (brief.tones.includes('comedy')) return '，并让尴尬的后果推动人物重新选择'
  return ''
}

function isTextGroundedToFact(detail: string, fact: string): boolean {
  if (detail.includes(fact)) return true
  const compactFact = fact.replace(/[，。！？；、\s]/gu, '')
  const compactDetail = detail.replace(/[，。！？；、\s]/gu, '')
  if (compactFact.length < 4 || compactDetail.length < compactFact.length) return false
  return compactDetail.includes(compactFact)
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}
