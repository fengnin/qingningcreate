import { randomUUID } from 'node:crypto'
import type {
  CreativeBrief,
  CurveBeat,
  StoryDesignRecord,
  StorySeed,
  StorySourceFact,
} from '../../shared/story-contract.js'
import { AppError } from './qwen.js'

const structuralBeatIds = {
  conflictCore: ['beat-current-state', 'beat-character-tension', 'beat-trigger'],
  predicament: ['beat-trigger', 'beat-escalation'],
  storyEnds: ['beat-current-state', 'beat-climax-choice', 'beat-resolution'],
  middleDevelopment: ['beat-escalation', 'beat-midpoint-turn', 'beat-climax-choice'],
} as const

export type StoryDesignSection = '冲突核心' | '具体困境' | '故事两端' | '中间发展'

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
  if (!design) return ['冲突核心', '具体困境', '故事两端', '中间发展']
  const activeIds = getActiveBeatIds(beats)
  const sections: Array<[StoryDesignSection, string[], number]> = [
    ['冲突核心', design.conflictCoreBeatIds, 2],
    ['具体困境', design.predicamentBeatIds, 2],
    ['故事两端', design.storyEndBeatIds, 3],
    ['中间发展', design.middleDevelopmentBeatIds, 2],
  ]
  return sections
    .filter(([, ids, minimum]) => ids.filter((id) => activeIds.has(id)).length < minimum)
    .map(([label]) => label)
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
  const collected: string[] = []

  for (const sentence of text.split(/[。！？；]+/u)) {
    const normalizedSentence = normalizeText(sentence)
    if (!normalizedSentence) continue
    const clauses = normalizedSentence
      .split(/[，、]/u)
      .map(normalizeText)
      .filter((clause) => clause.length >= 3)
    if (clauses.length > 1) {
      collected.push(...clauses)
    } else {
      collected.push(normalizedSentence)
    }
  }

  for (const fact of seed.lockedFacts) {
    const normalizedFact = normalizeText(fact)
    if (normalizedFact) collected.push(normalizedFact)
  }
  if (seed.lockedGoal) collected.push(normalizeText(seed.lockedGoal))

  const unique = [...new Set(collected.filter(Boolean))]
  return unique.length ? unique : [text || '作者尚未提供可拆分的原始材料']
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
