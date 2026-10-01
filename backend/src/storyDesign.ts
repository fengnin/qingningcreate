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
  const activeBeats = beats.filter((beat) => beat.status !== 'rejected')
  const sourceFacts = design.sourceFacts.map((fact) => {
    const coveredByBeatIds = activeBeats
      .filter((beat) => beat.sourceFactIds?.includes(fact.id) || isBeatGroundedToFact(beat, fact))
      .map((beat) => beat.id)
    return {
      ...fact,
      coveredByBeatIds,
      disposition: coveredByBeatIds.length
        ? 'integrated' as const
        : fact.disposition === 'parked' ? 'parked' as const : 'needs-author-decision' as const,
    }
  })
  return { ...design, sourceFacts }
}

export function getUnresolvedStorySourceFacts(design: StoryDesignRecord | undefined): StorySourceFact[] {
  return design?.sourceFacts.filter((fact) => fact.disposition === 'needs-author-decision') ?? []
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
  switch (force) {
    case 'misunderstanding': return '误会如何让原计划失效，再通过澄清改变选择'
    case 'cost': return '目标必须以一项具体放弃或承担为代价'
    case 'surprise': return '意外改变资源、时机或信息，使原办法失效'
    case 'contrast': return '主角最依赖的办法反而暴露其弱点'
    case 'relationship-tension': return '关系中的承诺或分歧迫使主角重新选择'
    default: return '围绕已知材料逐步增加阻碍、代价和主动选择'
  }
}

export function getSourceFactTexts(design: StoryDesignRecord | undefined): string[] {
  return design?.sourceFacts.map((fact) => fact.text) ?? []
}

export function deriveCoveredSourceFactIds(
  design: StoryDesignRecord,
  detail: string,
): string[] {
  return design.sourceFacts
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

function isTextGroundedToFact(detail: string, fact: string): boolean {
  if (detail.includes(fact)) return true
  const compactFact = fact.replace(/[，。！？；、\s]/gu, '')
  if (compactFact.length < 4) return false
  const fragment = compactFact.slice(0, Math.min(6, compactFact.length))
  return detail.includes(fragment)
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}
