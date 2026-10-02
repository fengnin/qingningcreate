import { randomUUID } from 'node:crypto'
import { AppError, requestQwenJson } from './qwen.js'
import {
  createStoryDesignRecord,
  deriveCoveredSourceFactIds,
  ensureStoryDesignRecord,
  getDramaticMechanism,
  getMissingStoryDesignSections,
  getParkedStorySourceFactsUsedByCurve,
  getUnresolvedStorySourceFacts,
  setStorySourceFactDisposition,
  updateStoryDesignCoverage,
} from './storyDesign.js'
import type {
  AuthorInstruction,
  ConfirmedCurve,
  CreativeBrief,
  CreativeTone,
  CurveBeat,
  CurveBeatKind,
  DramaticForce,
  ProvisionalCurve,
  StoryAction,
  StoryDesignRecord,
  StoryFact,
  StoryHeadTailOption,
  StoryPredicament,
  StoryPredicamentApproach,
  StorySeed,
  StoryTransition,
  StoryVariationAxis,
} from '../../shared/story-contract.js'

const maximumCurveBeatLength = 220
const maximumModelCurveBeatLength = 120
const maximumCurveInstructionLength = 180
const curveBeatKinds: readonly CurveBeatKind[] = [
  'current-state',
  'character-tension',
  'trigger',
  'escalation',
  'midpoint-turn',
  'climax-choice',
  'resolution',
]
const creativeTones: readonly CreativeTone[] = [
  'comedy',
  'warm',
  'friendship',
  'romance',
  'growth',
  'mystery',
  'fantasy',
]
const dramaticForces: readonly DramaticForce[] = [
  'misunderstanding',
  'cost',
  'surprise',
  'contrast',
  'relationship-tension',
]

const curveProposalPrefixPattern = /^暂定[：:]/u
const curveSceneSignalPattern = /(?:[“”"']|——|(?:一阵|这时|随后|紧接着|与此同时)|(?:站在|走向|走进|钻进|翻过|爬上|蹲下|握紧|掀飞|飘向|落在|赶来|喊|广播|门票|手环|围栏|检修|铁链|闸机|工作人员|手机|电话|账号|预约|VIP|快速通行|代排|通道卡))/iu
const curveActionChainPattern = /(?:先[^。！？；\n]{0,28}再|然后|接着|随后|(?:一边|并且)[^。！？；\n]{0,28}(?:走|拿|捡|钻|翻|爬|交|放))/u
const curveSettledOutcomePattern = /(?:最终|终于|真相大白|已经(?:成功|完成|解决|得到|失去|到达|离开))/u

const creativeToneLabels: Record<CreativeTone, string> = {
  comedy: '搞笑',
  warm: '温暖',
  friendship: '友情',
  romance: '恋爱',
  growth: '成长',
  mystery: '悬疑',
  fantasy: '奇幻',
}

const dramaticForceLabels: Record<DramaticForce, string> = {
  misunderstanding: '误会',
  cost: '代价',
  surprise: '意外',
  contrast: '反差',
  'relationship-tension': '关系拉扯',
}

export interface CurveMutationResult {
  curve: ProvisionalCurve
  affectedBeatIds: string[]
}

export interface MaterializedCurveFoundation {
  seed: StorySeed
  predicament: StoryPredicament
  approach: StoryPredicamentApproach
  headTail: StoryHeadTailOption
}

export function parseCreativeBrief(value: unknown): CreativeBrief {
  if (!isRecord(value)) {
    throw new AppError('创意方向格式不正确，请重新选择。', 400, 'INVALID_REQUEST')
  }
  if (Object.keys(value).some((field) => !['tones', 'dramaticForces', 'allowSystemNamedCharacters', 'note'].includes(field))) {
    throw new AppError('创意方向包含不支持的字段，请重新提交。', 400, 'INVALID_REQUEST')
  }

  const tones = parseEnumList(value.tones, creativeTones, '故事感觉', 2)
  const forces = parseEnumList(value.dramaticForces, dramaticForces, '戏剧力量', 2)
  if (typeof value.allowSystemNamedCharacters !== 'boolean') {
    throw new AppError('请确认是否允许系统新增具名人物。', 400, 'INVALID_REQUEST')
  }

  const note = readOptionalText(value.note, maximumCurveInstructionLength)
  return {
    tones,
    dramaticForces: forces,
    allowSystemNamedCharacters: value.allowSystemNamedCharacters,
    ...(note ? { note } : {}),
  }
}

export async function generateProvisionalCurve(
  idea: string,
  seed: StorySeed,
  brief: CreativeBrief,
  excludedProposalDetails: readonly string[] = [],
): Promise<ProvisionalCurve> {
  const design = createStoryDesignRecord(idea, seed)
  try {
    const modelOutput = await requestQwenJson({
      systemPrompt: curveGenerationSystemPrompt,
      userPrompt: buildCurveGenerationPrompt(idea, seed, brief, excludedProposalDetails),
      temperature: 0.72,
      maxTokens: 1_700,
    })
    const curve = parseModelCurve(modelOutput, idea, seed, brief, design, excludedProposalDetails)
    if (curve) return curve
  } catch (error) {
    if (!(error instanceof AppError)) throw error
  }

  return createProvisionalCurveFallback(idea, seed, brief, design, excludedProposalDetails)
}

export function updateCurveBeat(
  curve: ProvisionalCurve,
  beatId: string,
  detail: string,
): CurveMutationResult {
  const normalizedDetail = normalizeCurveText(detail, '曲线节点内容不能为空。')
  const target = curve.beats.find((beat) => beat.id === beatId)
  if (target?.status === 'rejected') {
    throw new AppError('这条提案已被你拒绝，不能直接恢复。请编辑其他节点，或创建一个新的主线版本。', 409, 'STORY_CURVE_REJECTED_IMMUTABLE')
  }
  if (!target) throw new AppError('要编辑的曲线节点不存在，请刷新后重试。', 409, 'STORY_SESSION_CONFLICT')
  if (curve.status !== 'draft') throw new AppError('主线已经确认，请从确认前的版本重新编辑。', 409, 'STORY_CURVE_ALREADY_CONFIRMED')

  const affectedBeatIds = getDependentBeatIds(curve.beats, beatId)
  const instruction: AuthorInstruction = {
    id: `instruction-${randomUUID()}`,
    kind: 'replace',
    text: normalizedDetail,
    targetBeatId: beatId,
    createdAt: Date.now(),
  }
  const now = Date.now()
  const beats = curve.beats.map((beat) => {
    if (beat.id === beatId) {
      return {
        ...beat,
        detail: normalizedDetail,
        source: 'user-edit' as const,
        status: 'edited' as const,
        sourceFactIds: curve.design
          ? deriveCoveredSourceFactIds(curve.design, normalizedDetail, true)
          : beat.sourceFactIds,
      }
    }
    if (affectedBeatIds.includes(beat.id) && beat.source !== 'user-input') {
      return { ...beat, status: 'stale' as const }
    }
    return beat
  })
  const design = curve.design
    ? updateStoryDesignCoverage(curve.design, beats)
    : undefined

  return {
    curve: {
      ...curve,
      beats,
      ...(design ? { design } : {}),
      instructions: [...curve.instructions, instruction],
      updatedAt: now,
    },
    affectedBeatIds,
  }
}

export async function regenerateCurveBeat(
  idea: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  beatId: string,
  feedback?: string,
  replaceRejected = false,
): Promise<CurveMutationResult> {
  const target = curve.beats.find((beat) => beat.id === beatId)
  const targetWasRejected = target?.status === 'rejected'
  if (targetWasRejected && !replaceRejected) {
    throw new AppError('这条提案已被你拒绝，不能重新生成。请编辑其他节点，或创建一个新的主线版本。', 409, 'STORY_CURVE_REJECTED_IMMUTABLE')
  }
  if (!target) throw new AppError('要重推的曲线节点不存在，请刷新后重试。', 409, 'STORY_SESSION_CONFLICT')
  if (curve.status !== 'draft') throw new AppError('主线已经确认，请从确认前的版本重新编辑。', 409, 'STORY_CURVE_ALREADY_CONFIRMED')
  if (target.source === 'user-input' || target.kind === 'current-state') {
    throw new AppError('当前状态来自你的原始想法，请直接编辑它，不要让系统重写。', 400, 'STORY_CURVE_USER_NODE_REGENERATE_FORBIDDEN')
  }
  if (target.source === 'user-edit') {
    throw new AppError('这条内容是你的作者编辑。请继续编辑它，或先修改上游节点后再决定如何调整，系统不会覆盖它。', 400, 'STORY_CURVE_AUTHOR_NODE_REGENERATE_FORBIDDEN')
  }

  const normalizedFeedback = feedback ? normalizeCurveText(feedback, '重推说明不能为空。') : undefined
  const effectiveSeed = applyCurrentCurveEditToSeed(seed, curve)
  let detail = createReplacementDetail(target.kind, effectiveSeed, curve.brief, curve, target)
  let usedFallback = true
  try {
    const modelOutput = await requestQwenJson({
      systemPrompt: curveBeatRegenerationSystemPrompt,
      userPrompt: buildCurveBeatRegenerationPrompt(idea, effectiveSeed, curve, target, normalizedFeedback),
      temperature: 0.68,
      maxTokens: 480,
    })
    const modelDetail = parseRegeneratedBeatDetail(modelOutput, target.kind, curve.brief, effectiveSeed, curve, target)
    if (modelDetail) {
      detail = modelDetail
      usedFallback = false
    }
  } catch (error) {
    if (!(error instanceof AppError)) throw error
  }

  if (targetWasRejected && repeatsRejectedProposal(detail, curve)) {
    // A replacement is an explicit new proposal, never a resurrection of the
    // wording the author rejected. Keep the fallback deterministic when the
    // model returns the same premise again.
    const alternateBrief = getAlternativeFallbackBrief(curve.brief, [target.detail])
    const relatedFact = curve.design?.sourceFacts.find((fact) => target.sourceFactIds?.includes(fact.id))?.text
      ?? curve.design?.sourceFacts.find((fact) => fact.disposition !== 'parked')?.text
      ?? getGoal(seed, seed.activeSituation)
    detail = getFallbackDetailForKind(target.kind, getSubject(seed), getGoal(seed, seed.activeSituation), alternateBrief, relatedFact)
    if (repeatsRejectedProposal(detail, curve)) {
      detail = `暂定：${getSubject(seed)}需要围绕“${shortenCurveContext(relatedFact)}”重新判断如何继续，具体代价留待作者决定。`
    }
    usedFallback = true
  }

  const affectedBeatIds = getDependentBeatIds(curve.beats, beatId)
  const instruction: AuthorInstruction = {
    id: `instruction-${randomUUID()}`,
    kind: 'regenerate',
    text: normalizedFeedback ?? '请按当前创意方向重推这个节点。',
    targetBeatId: beatId,
    createdAt: Date.now(),
  }
  const now = Date.now()
  const beats = curve.beats.map((beat) => {
    if (beat.id === beatId) {
      return {
        ...beat,
        detail,
        source: 'system-proposal' as const,
        status: 'proposed' as const,
        sourceFactIds: curve.design
          ? deriveCoveredSourceFactIds(curve.design, detail)
          : beat.sourceFactIds,
      }
    }
    if (affectedBeatIds.includes(beat.id) && beat.source !== 'user-input') {
      return { ...beat, status: 'stale' as const }
    }
    return beat
  })
  const rejectedProposals = targetWasRejected
    ? [
        ...(curve.rejectedProposals ?? []),
        {
          ...target,
          status: 'rejected' as const,
        },
      ]
    : curve.rejectedProposals
  const design = curve.design
    ? updateStoryDesignCoverage(curve.design, beats)
    : undefined

  return {
    curve: {
      ...curve,
      beats,
      ...(rejectedProposals ? { rejectedProposals } : {}),
      ...(design ? { design } : {}),
      generation: usedFallback
        ? {
            origin: 'fact-preserving-fallback',
            dramaticMechanism: getDramaticMechanism(curve.brief),
            notice: '系统未能可靠重推这一节点，已保留原始材料并生成可编辑的结构草案。',
          }
        : curve.generation,
      instructions: [...curve.instructions, instruction],
      updatedAt: now,
    },
    affectedBeatIds,
  }
}

export function rejectCurveBeat(
  curve: ProvisionalCurve,
  beatId: string,
  reason?: string,
): CurveMutationResult {
  const target = curve.beats.find((beat) => beat.id === beatId)
  if (!target) throw new AppError('要不采用的曲线节点不存在，请刷新后重试。', 409, 'STORY_SESSION_CONFLICT')
  if (curve.status !== 'draft') throw new AppError('主线已经确认，请从确认前的版本重新编辑。', 409, 'STORY_CURVE_ALREADY_CONFIRMED')
  if (target.source === 'user-input') {
    throw new AppError('这条内容来自你的原始想法，请编辑它或标记为暂不纳入，而不是删除。', 400, 'STORY_CURVE_USER_NODE_REJECT_FORBIDDEN')
  }
  if (target.source !== 'system-proposal') {
    throw new AppError('只有系统提出的内容可以标记为不采用。你的编辑请直接修改或恢复。', 400, 'STORY_CURVE_AUTHOR_NODE_REJECT_FORBIDDEN')
  }

  const affectedBeatIds = getDependentBeatIds(curve.beats, beatId)
  const now = Date.now()
  const beats = curve.beats.map((beat) => {
    if (beat.id === beatId) return { ...beat, status: 'rejected' as const }
    if (affectedBeatIds.includes(beat.id) && beat.status !== 'rejected' && beat.source !== 'user-input') {
      return { ...beat, status: 'stale' as const }
    }
    return beat
  })
  const instruction: AuthorInstruction = {
    id: `instruction-${randomUUID()}`,
    kind: 'remove',
    text: reason?.trim() || `不采用“${target.title}”这条系统提案。`,
    targetBeatId: beatId,
    createdAt: now,
  }
  const design = curve.design ? updateStoryDesignCoverage(curve.design, beats) : undefined
  return {
    curve: {
      ...curve,
      beats,
      ...(design ? { design } : {}),
      instructions: [...curve.instructions, instruction],
      updatedAt: now,
    },
    affectedBeatIds,
  }
}

export async function regenerateAffectedCurveBeats(
  idea: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  feedback?: string,
): Promise<CurveMutationResult> {
  if (curve.status !== 'draft') throw new AppError('主线已经确认，请从确认前的版本重新编辑。', 409, 'STORY_CURVE_ALREADY_CONFIRMED')
  let nextCurve = curve
  const affectedBeatIds = nextCurve.beats
    .filter((beat) => beat.status === 'stale')
    .map((beat) => beat.id)

  // Batch regeneration is only allowed to replace system proposals. An
  // author-edited downstream node stays visibly stale until the author edits
  // it, rather than being silently overwritten by a convenient re-generation.
  for (const beatId of affectedBeatIds) {
    const beat = nextCurve.beats.find((candidate) => candidate.id === beatId)
    if (!beat || beat.source !== 'system-proposal') continue
    const result = await regenerateCurveBeat(idea, seed, nextCurve, beatId, feedback)
    nextCurve = result.curve
  }

  return { curve: nextCurve, affectedBeatIds }
}

export function updateCurveSourceFactDisposition(
  curve: ProvisionalCurve,
  factId: string,
  disposition: 'parked' | 'integrated',
): CurveMutationResult {
  if (curve.status !== 'draft') throw new AppError('主线已经确认，请从确认前的版本重新编辑。', 409, 'STORY_CURVE_ALREADY_CONFIRMED')
  const design = ensureStoryDesignRecord(curve.design, curve.title, {
    subject: '',
    activeSituation: '',
    lockedGoal: null,
    lockedFacts: [],
    worldMode: 'realistic-default',
    expansionScope: 'keep-scale',
    unknowns: [],
  })
  const coverageBeforeDisposition = updateStoryDesignCoverage(design, curve.beats)
  const targetBeforeDisposition = coverageBeforeDisposition.sourceFacts.find((fact) => fact.id === factId)
  const updatedDesign = setStorySourceFactDisposition(
    coverageBeforeDisposition,
    factId,
    disposition,
  )
  const affectedBeatIds = disposition === 'parked'
    ? curve.beats
      .filter((beat) => beat.status !== 'rejected' && beat.sourceFactIds?.includes(factId))
      .map((beat) => beat.id)
    : targetBeforeDisposition?.disposition === 'parked'
      ? targetBeforeDisposition.coveredByBeatIds.filter((beatId) => (
          curve.beats.some((beat) => beat.id === beatId && beat.status !== 'rejected')
        ))
    : []
  const beats = disposition === 'parked'
    ? curve.beats.map((beat) => {
      if (!affectedBeatIds.includes(beat.id)) return beat
      // Remove the live traceability claim immediately. The text remains
      // visible for author review, and updateStoryDesignCoverage keeps the
      // prior beat ids as history. If the author edits a node to mention this
      // fact again, updateCurveBeat will create a fresh explicit claim and the
      // parked-material guard will require an explicit reintegration decision.
      return {
        ...beat,
        status: 'stale' as const,
        sourceFactIds: beat.sourceFactIds?.filter((sourceFactId) => sourceFactId !== factId),
      }
    })
    : targetBeforeDisposition?.disposition === 'parked'
      ? curve.beats.map((beat) => {
          if (!affectedBeatIds.includes(beat.id)) return beat
          return {
            ...beat,
            // Restoring a parked fact is an explicit author decision. Restore
            // its former traceability links, but require another review before
            // the old material can be confirmed as part of this version.
            status: 'stale' as const,
            sourceFactIds: [...new Set([...(beat.sourceFactIds ?? []), factId])],
          }
        })
      : curve.beats
  const instruction: AuthorInstruction = {
    id: `instruction-${randomUUID()}`,
    kind: 'park-fact',
    text: disposition === 'parked' ? '作者明确暂不把这条原始材料纳入当前主线。' : '作者要求把这条原始材料纳入当前主线。',
    createdAt: Date.now(),
  }
  return {
    curve: {
      ...curve,
      beats,
      design: updateStoryDesignCoverage(updatedDesign, beats),
      instructions: [...curve.instructions, instruction],
      updatedAt: Date.now(),
    },
    affectedBeatIds,
  }
}

export function confirmProvisionalCurve(curve: ProvisionalCurve): {
  curve: ProvisionalCurve
  confirmedCurve: ConfirmedCurve
} {
  if (curve.status !== 'draft') {
    throw new AppError('这条主线已经不是可确认的草案，请刷新后重试。', 409, 'STORY_CURVE_NOT_DRAFT')
  }
  if (curve.beats.length < 5 || curve.beats.length > 7) {
    throw new AppError('暂定故事曲线需要包含 5 至 7 个节点。', 400, 'STORY_CURVE_INCOMPLETE')
  }
  if (curve.beats.some((beat) => beat.status === 'stale' || beat.source === 'undecided')) {
    throw new AppError('请先处理被修改影响的曲线节点，再确认主线。', 400, 'STORY_CURVE_HAS_STALE_BEATS')
  }

  const requiredKinds: CurveBeatKind[] = ['current-state', 'trigger', 'escalation', 'climax-choice', 'resolution']
  if (requiredKinds.some((kind) => !curve.beats.some((beat) => beat.kind === kind && beat.status !== 'rejected'))) {
    throw new AppError('暂定故事曲线还缺少关键节点，请重新生成。', 400, 'STORY_CURVE_INCOMPLETE')
  }

  const design = curve.design ? updateStoryDesignCoverage(curve.design, curve.beats) : undefined
  if (getUnresolvedStorySourceFacts(design).length) {
    throw new AppError('还有原始材料尚未纳入或明确暂不采用，请先由你决定。', 400, 'STORY_SOURCE_FACTS_UNRESOLVED')
  }
  const parkedFactsStillUsed = getParkedStorySourceFactsUsedByCurve(design, curve.beats)
  if (parkedFactsStillUsed.length) {
    throw new AppError(
      `你已选择暂不纳入的原始材料仍出现在${parkedFactsStillUsed.length}个曲线节点中，请先编辑或重推这些节点，或重新纳入材料。`,
      400,
      'STORY_PARKED_FACT_STILL_USED',
    )
  }
  const missingDesignSections = getMissingStoryDesignSections(design, curve.beats)
  if (missingDesignSections.length) {
    throw new AppError(
      `故事设计记录还缺少有效的${missingDesignSections.join('、')}节点，请补回或编辑后再确认。`,
      400,
      'STORY_DESIGN_INCOMPLETE',
    )
  }

  const confirmedAt = Date.now()
  const beats = curve.beats.map((beat) => (
    beat.status === 'rejected' ? beat : { ...beat, status: 'confirmed' as const }
  ))
  const confirmed = {
    ...curve,
    beats,
    ...(design ? { design } : {}),
    status: 'confirmed' as const,
    updatedAt: confirmedAt,
  }
  return {
    curve: confirmed,
    confirmedCurve: {
      id: `confirmed-curve-${randomUUID()}`,
      provisionalCurveId: confirmed.id,
      title: confirmed.title,
      brief: confirmed.brief,
      beats: confirmed.beats,
      ...(confirmed.design ? { design: confirmed.design } : {}),
      ...(confirmed.generation ? { generation: confirmed.generation } : {}),
      confirmedAt,
    },
  }
}

export function materializeConfirmedCurve(
  seed: StorySeed,
  confirmedCurve: ConfirmedCurve,
): MaterializedCurveFoundation {
  const getBeat = (kind: CurveBeatKind): CurveBeat => {
    const beat = confirmedCurve.beats.find((candidate) => candidate.kind === kind && candidate.status !== 'rejected')
    if (!beat) throw new AppError('已确认主线缺少必要节点，请重新确认。', 409, 'STORY_CURVE_INCOMPLETE')
    return beat
  }

  const currentState = getBeat('current-state')
  const trigger = getBeat('trigger')
  const escalation = getBeat('escalation')
  const climax = getBeat('climax-choice')
  const resolution = getBeat('resolution')
  const characterTension = confirmedCurve.beats.find((beat) => beat.kind === 'character-tension' && beat.status !== 'rejected')
  const midpoint = confirmedCurve.beats.find((beat) => beat.kind === 'midpoint-turn' && beat.status !== 'rejected')
  const materializedSeed = applyCurrentCurveEditToSeed(seed, confirmedCurve)
  const parkedSourceFactTexts = (confirmedCurve.design?.sourceFacts ?? [])
    .filter((fact) => fact.disposition === 'parked')
    .map((fact) => fact.text.trim())
  const isParkedMaterial = (value: string) => parkedSourceFactTexts.some((parked) => {
    const normalizedValue = value.trim()
    return normalizedValue === parked || (parked.length >= 4 && normalizedValue.includes(parked))
  })
  const narrativeSeed: StorySeed = {
    ...materializedSeed,
    lockedFacts: materializedSeed.lockedFacts.filter((fact) => !isParkedMaterial(fact)),
    lockedGoal: materializedSeed.lockedGoal && !isParkedMaterial(materializedSeed.lockedGoal)
      ? materializedSeed.lockedGoal
      : null,
  }
  const confirmedGoal = getConfirmedCurveGoal(narrativeSeed, currentState)
  // Only the present obstacle and middle-development constraints belong in
  // the initial narrative state. The climax and resolution remain future
  // commitments in the confirmed curve, rather than facts that already
  // happened before the first turn.
  // Materialize every source fact that the author elected to integrate. The
  // curve is no longer merely a visible outline: these entries become the
  // factual contract for subsequent turns. Parked material is deliberately
  // absent even when it still appears in an older version record.
  const seedFactStatements = new Set(seed.lockedFacts.map((statement) => statement.trim()))
  const sourceFacts = (confirmedCurve.design?.sourceFacts ?? [])
    .filter((fact) => fact.disposition === 'integrated')
    // The narrative state already carries seed.lockedFacts as user-owned
    // facts. Do not materialize the same statement a second time merely
    // because the design ledger also tracks it.
    .filter((fact) => !seedFactStatements.has(fact.text.trim()))
    .map((fact): StoryFact => ({
      id: `fact-source-${fact.id}`,
      statement: fact.text,
      source: 'confirmed-curve',
      mutability: 'fixed',
      ...(fact.coveredByBeatIds.length
        ? {
            // A source fact may also be referenced by the curve's future
            // choices. Keep those references in the design ledger, but do
            // not make a climax or resolution look like it already happened
            // in the opening state.
            originCurveBeatIds: fact.coveredByBeatIds.filter((beatId) => {
              const beat = confirmedCurve.beats.find((candidate) => candidate.id === beatId)
              return beat && ['current-state', 'character-tension', 'trigger', 'escalation', 'midpoint-turn'].includes(beat.kind)
            }),
          }
        : {}),
    }))
  const sourceFactStatements = new Set(sourceFacts.map((fact) => fact.statement))
  const proposalFactLimit = Math.max(0, 4 - sourceFacts.length)
  const proposalFacts = confirmedCurve.beats
    .filter((beat) => beat.status !== 'rejected')
    .filter((beat) => (
      beat.source === 'system-proposal'
      || (beat.kind === 'current-state' && beat.source === 'user-edit')
    ))
    .filter((beat) => (
      beat.kind === 'current-state'
      || beat.kind === 'character-tension'
      || beat.kind === 'trigger'
      || beat.kind === 'escalation'
      || beat.kind === 'midpoint-turn'
    ))
    .filter((beat) => !sourceFactStatements.has(beat.detail))
    .slice(0, proposalFactLimit)
    .map((beat): StoryFact => ({
      id: `fact-curve-${beat.id}`,
      statement: beat.detail,
      source: 'confirmed-curve',
      mutability: 'fixed',
      originCurveBeatIds: [beat.id],
    }))
  const curveFacts = [...sourceFacts, ...proposalFacts]
  const climaxAction: StoryAction = {
    id: 'curve-climax-action',
    intent: climax.detail,
    preconditions: [],
    effects: [],
    source: 'generated',
    originCurveBeatIds: [climax.id],
  }
  const approach: StoryPredicamentApproach = {
    id: 'curve-approach',
    intent: `沿着已确认主线，先面对“${trigger.title}”。`,
    cost: climax.detail,
  }
  const variationAxis = getCurveVariationAxis(confirmedCurve.brief)
  const predicament: StoryPredicament = {
    id: 'curve-predicament',
    title: '已确认的故事起点',
    variationAxis,
    preservedGoal: confirmedGoal,
    immediateSituation: joinCurveDetails([currentState, trigger]),
    obstacle: joinCurveDetails([characterTension, escalation]),
    tradeoff: climax.detail,
    urgency: midpoint?.detail ?? escalation.detail,
    choice: climax.detail,
    plausibleCost: climax.detail,
    approaches: [approach],
    facts: curveFacts,
    actions: [climaxAction],
  }
  const transition: StoryTransition = {
    actionId: climaxAction.id,
    consumedFacts: [],
    changedFacts: [],
    introducedFacts: [],
  }
  const headTail: StoryHeadTailOption = {
    id: 'curve-head-tail',
    opening: joinCurveDetails([currentState, trigger]),
    openingClue: trigger.detail,
    climax: climax.detail,
    resolution: resolution.detail,
    cost: climax.detail,
    promise: `围绕“${confirmedGoal}”完成一次会改变人物的选择。`,
    climaxActionId: climaxAction.id,
    transition,
  }
  const { systemDraft: _systemDraft, ...seedWithoutDraft } = narrativeSeed

  return {
    seed: {
      ...seedWithoutDraft,
      activeSituation: narrativeSeed.activeSituation,
      lockedGoal: narrativeSeed.lockedGoal,
      creativeBrief: confirmedCurve.brief,
    },
    predicament,
    approach,
    headTail,
  }
}

export function getDependentBeatIds(beats: readonly CurveBeat[], beatId: string): string[] {
  const dependentIds = new Set<string>()
  let didFindMore = true
  while (didFindMore) {
    didFindMore = false
    for (const beat of beats) {
      if (beat.id === beatId || dependentIds.has(beat.id)) continue
      if (beat.dependsOn.includes(beatId) || beat.dependsOn.some((dependency) => dependentIds.has(dependency))) {
        dependentIds.add(beat.id)
        didFindMore = true
      }
    }
  }
  return beats.filter((beat) => dependentIds.has(beat.id)).map((beat) => beat.id)
}

export function createProvisionalCurveFallback(
  idea: string,
  seed: StorySeed,
  brief: CreativeBrief,
  existingDesign?: StoryDesignRecord,
  excludedProposalDetails: readonly string[] = [],
): ProvisionalCurve {
  const design = ensureStoryDesignRecord(existingDesign, idea, seed)
  const subject = getSubject(seed)
  const goal = getGoal(seed, idea)
  // A fact the author has parked belongs to this version's record, but is not
  // eligible as material for a new proposal. This keeps a rejected direction
  // from leaking back in through a deterministic fallback.
  const sourceFacts = design.sourceFacts.filter((fact) => fact.disposition !== 'parked')
  const sourceFact = (index: number) => sourceFacts[Math.min(index, sourceFacts.length - 1)]
  const factText = (index: number, fallback: string) => sourceFact(index)?.text || fallback
  const factIds = (...indexes: number[]) => indexes
    .map((index) => sourceFact(index)?.id)
    .filter((id): id is string => Boolean(id))
  const currentMaterial = factText(0, `${subject}想${goal}`)
  const observedMaterial = factText(1, currentMaterial)
  const pressureMaterial = factText(2, observedMaterial)
  const commitmentMaterial = factText(3, pressureMaterial)
  const decisionMaterial = factText(4, commitmentMaterial)
  const hook = getFallbackHook(subject, goal, brief, pressureMaterial)
  const tension = getFallbackTension(subject, goal, brief, observedMaterial)
  const currentStateDetail = seed.lockedGoal?.trim()
    ? `${seed.activeSituation.trim() || idea.trim()}（当前目标：${seed.lockedGoal.trim()}）`
    : seed.activeSituation.trim() || idea.trim()
  const now = Date.now()
  const proposalBrief = getAlternativeFallbackBrief(brief, excludedProposalDetails)
  const beats: CurveBeat[] = [
    createCurveBeat(
      'current-state',
      '此刻想要什么',
      currentStateDetail,
      'user-input',
      'confirmed',
      [],
      deriveCoveredSourceFactIds(design, currentStateDetail),
    ),
    createCurveBeat('character-tension', '人物的矛盾', avoidExcludedProposal(tension, 'character-tension', subject, goal, proposalBrief, observedMaterial, excludedProposalDetails), 'system-proposal', 'proposed', ['beat-current-state'], factIds(1)),
    createCurveBeat('trigger', '让目标停住的钩子', avoidExcludedProposal(hook, 'trigger', subject, goal, proposalBrief, pressureMaterial, excludedProposalDetails), 'system-proposal', 'proposed', ['beat-current-state', 'beat-character-tension'], factIds(2)),
    createCurveBeat(
      'escalation',
      '阻碍开始升级',
      avoidExcludedProposal(getFallbackEscalation(subject, goal, brief, commitmentMaterial), 'escalation', subject, goal, proposalBrief, commitmentMaterial, excludedProposalDetails),
      'system-proposal',
      'proposed',
      ['beat-trigger'],
      factIds(3),
    ),
    createCurveBeat(
      'midpoint-turn',
      '中段转折',
      avoidExcludedProposal(getFallbackMidpointTurn(subject, goal, brief, decisionMaterial), 'midpoint-turn', subject, goal, proposalBrief, decisionMaterial, excludedProposalDetails),
      'system-proposal',
      'proposed',
      ['beat-escalation'],
      factIds(4),
    ),
    createCurveBeat(
      'climax-choice',
      '高潮时的选择与代价',
      avoidExcludedProposal(getFallbackClimaxChoice(subject, goal, brief, decisionMaterial), 'climax-choice', subject, goal, proposalBrief, decisionMaterial, excludedProposalDetails),
      'system-proposal',
      'proposed',
      ['beat-midpoint-turn'],
      factIds(4),
    ),
    createCurveBeat(
      'resolution',
      '结局中的变化',
      avoidExcludedProposal(getFallbackResolution(subject, goal, brief, currentMaterial), 'resolution', subject, goal, proposalBrief, currentMaterial, excludedProposalDetails),
      'system-proposal',
      'proposed',
      ['beat-climax-choice'],
      factIds(0, 4),
    ),
  ]
  const coveredDesign = updateStoryDesignCoverage(design, beats)
  return {
    id: `curve-${randomUUID()}`,
    title: `${getShortIdeaLabel(idea)}的暂定主线`,
    status: 'draft',
    brief,
    beats,
    instructions: [],
    design: coveredDesign,
    generation: {
      origin: 'fact-preserving-fallback',
      dramaticMechanism: getDramaticMechanism(brief),
      notice: '系统未能完成可靠扩写，以下草案已逐条保留原始材料；请由你决定是否采用。',
    },
    createdAt: now,
    updatedAt: now,
  }
}

function createCurveBeat(
  kind: CurveBeatKind,
  title: string,
  detail: string,
  source: CurveBeat['source'],
  status: CurveBeat['status'],
  dependsOn: string[],
  sourceFactIds: string[] = [],
): CurveBeat {
  return {
    id: `beat-${kind}`,
    kind,
    title,
    detail,
    source,
    status,
    dependsOn,
    sourceFactIds,
  }
}

function getAlternativeFallbackBrief(
  brief: CreativeBrief,
  excludedProposalDetails: readonly string[],
): CreativeBrief {
  if (!excludedProposalDetails.length) return brief
  const availableForces = dramaticForces.filter((force) => !brief.dramaticForces.includes(force))
  const alternateForce = availableForces[0] ?? dramaticForces.find((force) => force !== brief.dramaticForces[0])
  return alternateForce
    ? { ...brief, dramaticForces: [alternateForce, ...brief.dramaticForces.filter((force) => force !== alternateForce).slice(0, 1)] }
    : brief
}

function avoidExcludedProposal(
  detail: string,
  kind: CurveBeatKind,
  subject: string,
  goal: string,
  alternateBrief: CreativeBrief,
  material: string,
  excludedProposalDetails: readonly string[],
): string {
  if (!repeatsExcludedProposal(detail, excludedProposalDetails)) return detail

  const alternate = getFallbackDetailForKind(kind, subject, goal, alternateBrief, material)
  if (!repeatsExcludedProposal(alternate, excludedProposalDetails)) return alternate

  // This final guard keeps a rejected proposal from leaking through even if a
  // future dramatic-mechanism template happens to converge with the original.
  return `暂定：${subject}需要围绕“${material}”重新判断如何继续${goal}，具体代价留待作者决定。`
}

function getFallbackDetailForKind(
  kind: CurveBeatKind,
  subject: string,
  goal: string,
  brief: CreativeBrief,
  material: string,
): string {
  switch (kind) {
    case 'character-tension':
      return getFallbackTension(subject, goal, brief, material)
    case 'trigger':
      return getFallbackHook(subject, goal, brief, material)
    case 'escalation':
      return getFallbackEscalation(subject, goal, brief, material)
    case 'midpoint-turn':
      return getFallbackMidpointTurn(subject, goal, brief, material)
    case 'climax-choice':
      return getFallbackClimaxChoice(subject, goal, brief, material)
    case 'resolution':
      return getFallbackResolution(subject, goal, brief, material)
    case 'current-state':
      return material
  }
}

function parseModelCurve(
  value: unknown,
  idea: string,
  seed: StorySeed,
  brief: CreativeBrief,
  design: StoryDesignRecord,
  excludedProposalDetails: readonly string[] = [],
): ProvisionalCurve | undefined {
  if (!isRecord(value) || !Array.isArray(value.beats)) return undefined
  if (value.beats.length < 5 || value.beats.length > 7) return undefined
  const title = `${getShortIdeaLabel(idea)}的暂定主线`
  const parsedBeats: CurveBeat[] = []
  const seenKinds = new Set<CurveBeatKind>()

  for (const item of value.beats) {
    if (!isRecord(item) || typeof item.kind !== 'string' || !isCurveBeatKind(item.kind)) return undefined
    if (seenKinds.has(item.kind)) return undefined
    const detail = readOptionalText(item.detail, maximumModelCurveBeatLength)
    if (
      !detail
      || (!brief.allowSystemNamedCharacters && hasNewNamedCharacter(detail, seed))
      || (item.kind !== 'current-state' && !isSystemCurveProposalSafe(item.kind, detail))
      || (item.kind !== 'current-state' && repeatsExcludedProposal(detail, excludedProposalDetails))
    ) return undefined
    seenKinds.add(item.kind)
    const sourceFactIds = parseSourceFactIds(item.sourceFactIds, design)
      ?? deriveCoveredSourceFactIds(design, detail)
    parsedBeats.push(createCurveBeat(
      item.kind,
      getCurveBeatTitle(item.kind),
      item.kind === 'current-state' ? getCurrentState(seed, idea) : detail,
      item.kind === 'current-state' ? 'user-input' : 'system-proposal',
      item.kind === 'current-state' ? 'confirmed' : 'proposed',
      parseDependencies(item.dependsOn),
      sourceFactIds,
      ))
  }

  const requiredKinds: CurveBeatKind[] = ['current-state', 'trigger', 'escalation', 'climax-choice', 'resolution']
  if (requiredKinds.some((kind) => !seenKinds.has(kind))) return undefined
  const orderedBeats = curveBeatKinds
    .filter((kind) => seenKinds.has(kind))
    .map((kind) => parsedBeats.find((beat) => beat.kind === kind)!)
  if (!isCurveGroundedToSeed(orderedBeats, seed)) return undefined
  const coveredDesign = updateStoryDesignCoverage(design, orderedBeats)
  if (getUnresolvedStorySourceFacts(coveredDesign).length) return undefined

  const now = Date.now()
  return {
    id: `curve-${randomUUID()}`,
    title,
    status: 'draft',
    brief,
    beats: normalizeCurveDependencies(orderedBeats),
    instructions: [],
    design: updateStoryDesignCoverage(coveredDesign, normalizeCurveDependencies(orderedBeats)),
    generation: {
      origin: 'model',
      dramaticMechanism: getDramaticMechanism(brief),
    },
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeProposalForComparison(value: string): string {
  return value
    .replace(/^暂定[：:]/u, '')
    .replace(/[“”"']/gu, '')
    .replace(/\s+/gu, '')
    .trim()
}

function repeatsExcludedProposal(detail: string, excludedProposalDetails: readonly string[]): boolean {
  const normalizedDetail = normalizeProposalForComparison(detail)
  if (normalizedDetail.length < 12) return false
  return excludedProposalDetails
    .map(normalizeProposalForComparison)
    .filter((value) => value.length >= 12)
    .some((excluded) => normalizedDetail === excluded || normalizedDetail.includes(excluded) || excluded.includes(normalizedDetail))
}

function parseSourceFactIds(value: unknown, design: StoryDesignRecord): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return undefined
  const availableIds = new Set(design.sourceFacts.map((fact) => fact.id))
  const ids = value.filter((candidate): candidate is string => (
    typeof candidate === 'string' && availableIds.has(candidate)
  ))
  return ids.length === value.length ? [...new Set(ids)] : undefined
}

function parseDependencies(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const allowedIds = new Set(curveBeatKinds.map((kind) => `beat-${kind}`))
  return value
    .filter((candidate): candidate is string => typeof candidate === 'string' && allowedIds.has(candidate))
    .slice(0, 3)
}

function normalizeCurveDependencies(beats: CurveBeat[]): CurveBeat[] {
  const ids = new Set(beats.map((beat) => beat.id))
  return beats.map((beat, index) => {
    const priorIds = new Set(beats.slice(0, index).map((candidate) => candidate.id))
    const dependencies = beat.dependsOn.filter((dependency) => (
      dependency !== beat.id && ids.has(dependency) && priorIds.has(dependency)
    ))
    return {
      ...beat,
      dependsOn: dependencies.length
        ? dependencies
        : index === 0 ? [] : [beats[index - 1]!.id],
    }
  })
}

function parseRegeneratedBeatDetail(
  value: unknown,
  kind: CurveBeatKind,
  brief: CreativeBrief,
  seed: StorySeed,
  curve: ProvisionalCurve,
  target: CurveBeat,
): string | undefined {
  if (!isRecord(value)) return undefined
  const detail = readOptionalText(value.detail, maximumModelCurveBeatLength)
  if (
    !detail
    || (!brief.allowSystemNamedCharacters && hasNewNamedCharacter(detail, seed))
    || !isCurveDetailGroundedToContext(detail, seed, curve, target)
    || !isSystemCurveProposalSafe(kind, detail)
    || repeatsRejectedProposal(detail, curve)
  ) return undefined
  return detail
}

function repeatsRejectedProposal(detail: string, curve: ProvisionalCurve): boolean {
  const normalizedDetail = detail.replace(/^暂定[：:]/u, '').replace(/[“”"']/gu, '').trim()
  if (normalizedDetail.length < 12) return false
  return [
    ...curve.beats.filter((beat) => beat.status === 'rejected' && beat.source === 'system-proposal'),
    ...(curve.rejectedProposals ?? []),
  ]
    .some((beat) => {
      const rejected = beat.detail.replace(/^暂定[：:]/u, '').replace(/[“”"']/gu, '').trim()
      return rejected.length >= 12 && normalizedDetail.includes(rejected)
    })
}

function isCurveDetailGroundedToContext(
  detail: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  target: CurveBeat,
): boolean {
  if (isCurveDetailGroundedToSeed(detail, seed)) return true
  const upstreamTexts = curve.beats
    .filter((beat) => target.dependsOn.includes(beat.id) && beat.status !== 'rejected')
    .map((beat) => beat.detail)
  const sourceFactTexts = curve.design?.sourceFacts
    .filter((fact) => fact.disposition !== 'parked')
    .map((fact) => fact.text) ?? []
  return [...upstreamTexts, ...sourceFactTexts]
    .flatMap(getGroundingFragments)
    .some((fragment) => detail.includes(fragment))
}

function getGroundingFragments(value: string): string[] {
  const compact = value.replace(/^暂定[：:]/u, '').replace(/[^\p{L}\p{N}]/gu, '')
  if (compact.length < 3) return []
  const fragments = new Set<string>()
  const size = Math.min(6, compact.length)
  for (let start = 0; start + size <= compact.length; start += Math.max(1, size - 2)) {
    fragments.add(compact.slice(start, start + size))
  }
  return [...fragments]
}

export function isSystemCurveProposalSafe(kind: CurveBeatKind, detail: string): boolean {
  if (kind === 'current-state') return true

  const normalized = detail.trim()
  if (!curveProposalPrefixPattern.test(normalized)) return false
  if (
    curveSceneSignalPattern.test(normalized)
    || curveActionChainPattern.test(normalized)
    || curveSettledOutcomePattern.test(normalized)
  ) return false

  switch (kind) {
    case 'character-tension':
      return /(?:想|却|不愿|害怕|习惯|容易|总|表面|性格|关系)/u.test(normalized)
    case 'trigger':
      return /(?:想|目标|计划|原来的办法|出现|让|迫使|阻碍|停住)/u.test(normalized)
    case 'escalation':
      return /(?:继续|若|必须|取舍|代价|原本|升级|两难)/u.test(normalized)
    case 'midpoint-turn':
      return /(?:发现|办法|代价|重新|转折|问题|表面)/u.test(normalized)
    case 'climax-choice':
      return /(?:必须|选择|承担|放下|决定|代价)/u.test(normalized)
    case 'resolution':
      return /(?:结果|变化|得到|失去|理解|成长|离开|落点)/u.test(normalized)
  }
}

function getCurveBeatTitle(kind: CurveBeatKind): string {
  const titles: Record<CurveBeatKind, string> = {
    'current-state': '此刻想要什么',
    'character-tension': '人物的矛盾',
    trigger: '让目标停住的钩子',
    escalation: '阻碍开始升级',
    'midpoint-turn': '中段转折',
    'climax-choice': '高潮时的选择与代价',
    resolution: '结局中的变化',
  }
  return titles[kind]
}

function isCurveGroundedToSeed(beats: readonly CurveBeat[], seed: StorySeed): boolean {
  const proposalBeats = beats.filter((beat) => beat.kind !== 'current-state')
  const anchors = getCurveAnchorTerms(seed)
  const groundedBeatCount = proposalBeats.filter((beat) => (
    anchors.some((anchor) => beat.detail.includes(anchor))
  )).length
  return groundedBeatCount >= Math.min(2, proposalBeats.length)
}

function isCurveDetailGroundedToSeed(detail: string, seed: StorySeed): boolean {
  return getCurveAnchorTerms(seed).some((anchor) => detail.includes(anchor))
}

function getCurveAnchorTerms(seed: StorySeed): string[] {
  const genericTerms = new Set(['主角', '故事', '目标', '当前', '此刻', '事情', '东西', '一个', '这件'])
  const anchors = [...new Set([
    seed.subject,
    seed.lockedGoal ?? '',
    ...seed.lockedFacts,
  ])]
    .map((value) => value.trim())
    .filter((value) => value.length >= 2)
  const terms = new Set(anchors.filter((anchor) => !genericTerms.has(anchor)))

  for (const anchor of anchors) {
    for (const segment of anchor.match(/[A-Za-z0-9]+|[\u4e00-\u9fff]+/g) ?? []) {
      if (/^[\u4e00-\u9fff]+$/u.test(segment)) {
        const maximumLength = Math.min(4, segment.length)
        for (let length = maximumLength; length >= 2; length -= 1) {
          for (let start = 0; start + length <= segment.length; start += 1) {
            const candidate = segment.slice(start, start + length)
            if (!genericTerms.has(candidate)) terms.add(candidate)
          }
        }
      } else if (segment.length >= 2 && !genericTerms.has(segment)) {
        terms.add(segment)
      }
    }
  }

  return [...terms]
}

function createReplacementDetail(
  kind: CurveBeatKind,
  seed: StorySeed,
  brief: CreativeBrief,
  curve: ProvisionalCurve,
  target: CurveBeat,
): string {
  const subject = getSubject(seed)
  const goal = getGoal(seed, seed.activeSituation)
  const relatedFact = curve.design?.sourceFacts.find((fact) => target.sourceFactIds?.includes(fact.id))?.text
    ?? curve.design?.sourceFacts.find((fact) => fact.disposition !== 'parked')?.text
    ?? goal
  const premise = getCausalAnchor(curve, target, relatedFact)
  switch (kind) {
    case 'current-state':
      return getCurrentState(seed, seed.activeSituation)
    case 'character-tension':
      return getFallbackTension(subject, goal, brief, relatedFact)
    case 'trigger':
      return getFallbackHook(subject, goal, brief, relatedFact)
    case 'escalation':
      return getFallbackEscalation(subject, goal, brief, premise)
    case 'midpoint-turn':
      return getFallbackMidpointTurn(subject, goal, brief, premise)
    case 'climax-choice':
      return getFallbackClimaxChoice(subject, goal, brief, premise)
    case 'resolution':
      return getFallbackResolution(subject, goal, brief, premise)
  }
}

function getFallbackTension(subject: string, goal: string, brief: CreativeBrief, material: string): string {
  if (brief.dramaticForces.includes('relationship-tension')) {
    return `暂定：“${material}”让${subject}想${goal}时，必须面对重要关系里尚未说开的分歧。`
  }
  if (brief.dramaticForces.includes('contrast')) {
    return `暂定：“${material}”让${subject}表面上很笃定，但真正碰到代价时总想先绕开。`
  }
  return `暂定：${subject}面对“${material}”想把事情做好，却还没有想清楚愿意为此放下什么。`
}

function getFallbackHook(subject: string, goal: string, brief: CreativeBrief, material: string): string {
  const force = brief.dramaticForces[0]
  switch (force) {
    case 'misunderstanding':
      return `暂定：“${material}”中的一处细节被误解，让${subject}想${goal}的原计划停住。`
    case 'cost':
      return `暂定：“${material}”让${subject}发现继续${goal}会失去一件眼下重要的东西。`
    case 'surprise':
      return `暂定：“${material}”引出一个意外，迫使${subject}原本简单的选择变复杂。`
    case 'relationship-tension':
      return `暂定：“${material}”迫使${subject}在${stripLeadingLocationMarker(goal)}前面对一段关系里尚未说开的分歧。`
    case 'contrast':
    default:
      return `暂定：“${material}”让${subject}最擅长的办法恰好变成继续${goal}的新阻碍。`
  }
}

function getFallbackEscalation(subject: string, goal: string, brief: CreativeBrief, material: string): string {
  switch (brief.dramaticForces[0]) {
    case 'misunderstanding':
      return `暂定：“${material}”的含义迟迟无法确认，${subject}若继续${goal}，就必须决定先澄清还是承担误解留下的后果。`
    case 'cost':
      return `暂定：“${material}”把继续${goal}的代价具体化，${subject}不能同时保住眼前便利和真正想完成的事。`
    case 'surprise':
      return `暂定：“${material}”改变了原本可用的时机或条件，${subject}必须在变化继续扩大前重排${goal}的办法。`
    case 'relationship-tension':
      return `暂定：“${material}”让${subject}继续${goal}时不得不回应一段关系里的承诺或分歧，回避本身也会成为代价。`
    case 'contrast':
    default:
      return `暂定：“${material}”让${subject}最依赖的办法反而卡住${goal}，必须承认原来的强项解决不了这次问题。`
  }
}

function getFallbackMidpointTurn(subject: string, goal: string, brief: CreativeBrief, material: string): string {
  switch (brief.dramaticForces[0]) {
    case 'misunderstanding':
      return `暂定：${subject}发现，围绕“${material}”继续猜测只会放大误解，必须决定要不要改变处理${goal}的方式。`
    case 'cost':
      return `暂定：${subject}发现，“${material}”要求的放弃比预想更接近自己在意的东西，${goal}因此变成真正的取舍。`
    case 'surprise':
      return `暂定：${subject}发现，“${material}”带来的变化让原计划失效，必须重新判断还有什么条件可以依靠。`
    case 'relationship-tension':
      return `暂定：${subject}发现，若绕开“${material}”中的关系问题，${goal}即使完成也会留下无法回避的裂痕。`
    case 'contrast':
    default:
      return `暂定：${subject}发现，继续用最熟悉的办法处理“${material}”只能遮住问题，必须承认自己真正害怕失去什么。`
  }
}

function getFallbackClimaxChoice(subject: string, goal: string, brief: CreativeBrief, material: string): string {
  switch (brief.dramaticForces[0]) {
    case 'misunderstanding':
      return `暂定：面对“${material}”，${subject}必须选择公开澄清并承担可能的误解，还是保留${goal}却让误会继续定义自己。`
    case 'cost':
      return `暂定：面对“${material}”，${subject}必须明确放下一项真实利益，才有资格继续${goal}。`
    case 'surprise':
      return `暂定：面对“${material}”造成的新条件，${subject}必须主动舍弃原计划的一部分，换取继续${goal}的可能。`
    case 'relationship-tension':
      return `暂定：面对“${material}”，${subject}必须亲自说清自己愿意承担什么，不能再用完成${goal}来替代关系里的回答。`
    case 'contrast':
    default:
      return `暂定：面对“${material}”，${subject}必须放下最擅长也最省事的办法，以一种更诚实的选择继续${goal}。`
  }
}

function getFallbackResolution(subject: string, goal: string, brief: CreativeBrief, material: string): string {
  const toneChange = getResolutionToneChange(brief)
  switch (brief.dramaticForces[0]) {
    case 'misunderstanding':
      return `暂定：${subject}对“${material}”作出的澄清或承担，让${goal}的结果不再由误会决定，并${toneChange}。`
    case 'cost':
      return `暂定：${subject}为“${material}”付出的代价，让${goal}得到一个明确结果，并${toneChange}。`
    case 'surprise':
      return `暂定：${subject}接受“${material}”带来的新条件后，让${goal}出现新的结果，并${toneChange}。`
    case 'relationship-tension':
      return `暂定：${subject}回应“${material}”中的关系问题后，让${goal}与这段关系都出现可见结果，并${toneChange}。`
    case 'contrast':
    default:
      return `暂定：${subject}不再依赖旧办法来处理“${material}”，让${goal}出现可见结果，并${toneChange}。`
  }
}

function getResolutionToneChange(brief: CreativeBrief): string {
  if (brief.tones.includes('romance')) return '让心意与行动不再彼此回避'
  if (brief.tones.includes('friendship')) return '让关系中的信任被重新看见'
  if (brief.tones.includes('mystery')) return '让仍未解开的信息获得新的位置'
  if (brief.tones.includes('comedy')) return '让尴尬的代价成为人物关系的新理解'
  if (brief.tones.includes('fantasy')) return '让人物重新理解这件事背后的规则'
  return `在${getPrimaryToneLabel(brief)}上发生可见变化`
}

function stripLeadingLocationMarker(value: string): string {
  return value.replace(/^(?:在|于)/u, '')
}

function shortenCurveContext(value: string): string {
  const normalized = value.replace(/^暂定[：:]/u, '').trim()
  return normalized.length > 58 ? `${normalized.slice(0, 58)}…` : normalized || '此前的作者决定'
}

function extractCausalConsequence(value: string): string {
  // System proposals usually quote the material they build on. Removing that
  // quoted premise before selecting a clause keeps the next node focused on
  // the consequence, instead of recursively embedding the whole prior node.
  const withoutQuotedMaterial = value
    .replace(/“[^”]*”/gu, '')
    .replace(/"[^"]*"/gu, '')
    .replace(/[“”"']/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  const clauses = withoutQuotedMaterial
    .split(/[，。！？；\n]/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
  const usefulClause = clauses.find((clause) => (
    clause.length >= 8
    && !/^(?:面对|围绕|关于|由于|因此)$/u.test(clause)
    && !/(?:发现|意识到|知道)$/u.test(clause)
  ))
  return usefulClause
    ?? clauses.sort((left, right) => right.length - left.length)[0]
    ?? withoutQuotedMaterial
    ?? '上一步暴露的后果'
}

function getCausalAnchor(curve: ProvisionalCurve, target: CurveBeat, fallback: string): string {
  const visited = new Set<string>()
  const queue = [...target.dependsOn]
  const upstream: CurveBeat[] = []
  while (queue.length) {
    const candidateId = queue.shift()
    if (!candidateId || visited.has(candidateId)) continue
    visited.add(candidateId)
    const candidate = curve.beats.find((beat) => beat.id === candidateId)
    if (!candidate || candidate.status === 'rejected') continue
    upstream.push(candidate)
    queue.push(...candidate.dependsOn)
  }
  const nearest = upstream[0]
  // Carry the edit through the nearest causal beat. Looking all the way back
  // to the first author edit for every downstream node makes each proposal
  // repeat the same sentence instead of showing how the consequence evolves.
  if (!nearest) return shortenCurveContext(fallback)
  const anchor = nearest.source === 'user-edit'
    ? nearest.detail
    : extractCausalConsequence(nearest.detail)
  return shortenCurveContext(anchor)
}

function getCurveVariationAxis(brief: CreativeBrief): StoryVariationAxis {
  if (brief.dramaticForces.includes('relationship-tension')) return 'relationship'
  if (brief.dramaticForces.includes('cost')) return 'commitment'
  if (brief.dramaticForces.includes('surprise')) return 'time'
  return 'commitment'
}

function joinCurveDetails(beats: Array<CurveBeat | undefined>): string {
  return beats
    .filter((beat): beat is CurveBeat => Boolean(beat))
    .map((beat) => beat.detail)
    .join(' ')
}

function getSubject(seed: StorySeed): string {
  return seed.subject.trim() || '主角'
}

function getGoal(seed: StorySeed, fallback: string): string {
  return seed.lockedGoal?.trim() || `围绕“${getShortIdeaLabel(fallback)}”作出决定`
}

function getConfirmedCurveGoal(seed: StorySeed, currentState: CurveBeat): string {
  return currentState.source === 'user-edit'
    ? currentState.detail.trim()
    : getGoal(seed, currentState.detail)
}

function applyCurrentCurveEditToSeed<TCurve extends Pick<ProvisionalCurve | ConfirmedCurve, 'beats'>>(
  seed: StorySeed,
  curve: TCurve,
): StorySeed {
  const currentState = curve.beats.find((beat) => beat.kind === 'current-state')
  if (!currentState || currentState.source !== 'user-edit') return seed

  return {
    ...seed,
    activeSituation: currentState.detail,
    lockedGoal: currentState.detail,
  }
}

function getCurrentState(seed: StorySeed, fallback: string): string {
  return seed.activeSituation.trim() || fallback.trim()
}

function getShortIdeaLabel(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  return normalized.length > 16 ? `${normalized.slice(0, 16)}…` : normalized || '这个念头'
}

function getPrimaryToneLabel(brief: CreativeBrief): string {
  return brief.tones[0] ? creativeToneLabels[brief.tones[0]] : '人物理解'
}

function normalizeCurveText(value: string, emptyMessage: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (!normalized) throw new AppError(emptyMessage, 400, 'INVALID_REQUEST')
  if (normalized.length > maximumCurveBeatLength) {
    throw new AppError(`曲线节点最多 ${maximumCurveBeatLength} 个字符，请简短描述。`, 400, 'INVALID_REQUEST')
  }
  return normalized
}

function parseEnumList<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  label: string,
  maximumLength: number,
): T[] {
  if (!Array.isArray(value) || value.length > maximumLength || value.some((item) => typeof item !== 'string' || !allowedValues.includes(item as T))) {
    throw new AppError(`${label}格式不正确，请重新选择。`, 400, 'INVALID_REQUEST')
  }
  const items = value as T[]
  if (new Set(items).size !== items.length) {
    throw new AppError(`${label}不能重复选择。`, 400, 'INVALID_REQUEST')
  }
  return items
}

function readOptionalText(value: unknown, maximumLength: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replace(/\s+/gu, ' ')
  return normalized && normalized.length <= maximumLength ? normalized : undefined
}

function isCurveBeatKind(value: string): value is CurveBeatKind {
  return curveBeatKinds.includes(value as CurveBeatKind)
}

function hasNewNamedCharacter(text: string, seed?: StorySeed): boolean {
  const knownText = [seed?.subject ?? '', seed?.activeSituation ?? '', ...(seed?.lockedFacts ?? [])].join(' ')
  const explicitNamePattern = /(?:名叫|名字叫|名为|叫做|叫)[“「]?([\u4e00-\u9fff]{2,4})[”」]?/gu
  const delimitedSurnameNamePattern = /(?:^|[\s，。；：、！？“”‘’「」『』（）()])([赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦许何吕施张孔曹严华金魏陶姜戚谢邹喻范彭郎鲁韦昌马苗方俞任袁柳鲍史唐费廉薛雷贺倪汤滕殷罗毕郝邬安常乐于傅皮卞齐康伍余顾孟平黄穆萧尹姚邵汪祁毛狄米贝明成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季贾路江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万柯管卢莫房裘解应宗丁宣邓洪包左石崔吉龚程邢裴陆荣翁荀惠甄曲封段武符刘景詹龙叶黎白][\u4e00-\u9fff]{1,2})(?=$|[\s，。；：、！？“”‘’「」『』（）()])/gu
  for (const pattern of [explicitNamePattern, delimitedSurnameNamePattern]) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]
      if (candidate && !knownText.includes(candidate)) return true
    }
  }

  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const curveGenerationSystemPrompt = `你是故事共创编辑。你的职责是把用户的模糊想法整理成一条可讨论、可编辑的暂定故事曲线，而不是写小说或代替用户决定主线。

只输出 JSON 对象，不要 Markdown。必须给出 5 至 7 个 beats。每个 beat 只能是一个结构假设，不写连续场景、对白、角色回合、既定结果或固定路径事实。必含 kind：current-state、trigger、escalation、climax-choice、resolution；可选 character-tension 与 midpoint-turn。每个 detail 最多 110 个汉字。除 current-state 外，每个 detail 必须以“暂定：”开头。

所有不是用户原文的内容都是系统提案：可以提出人物弱点、钩子、阻碍、代价与结局方向，但不要把它们写成已发生事实。若 allowSystemNamedCharacters 为 false，绝不新增任何具名人物，使用“陌生人”“同行者”等匿名指代。不要默认写成悬疑，除非 brief 明确选择 mystery。

输出：{"title":"简短标题","beats":[{"kind":"current-state","title":"节点标题","detail":"节点内容","dependsOn":[],"sourceFactIds":["source-fact-1"]}]}`

const curveBeatRegenerationSystemPrompt = `你是故事共创编辑。只重写一条暂定故事曲线节点，不写连续剧情。返回 JSON：{"detail":"暂定：一句可编辑的系统提案"}。detail 必须以“暂定：”开头，不得把提案写成既定事实、行动结果或长场景；未允许新增具名人物时不得新增名字。`

function buildCurveGenerationPrompt(
  idea: string,
  seed: StorySeed,
  brief: CreativeBrief,
  excludedProposalDetails: readonly string[] = [],
): string {
  const design = createStoryDesignRecord(idea, seed)
  return `用户原始想法：\n${idea}\n\n不可丢失的原始材料：\n${JSON.stringify(design.sourceFacts.map((fact) => ({ id: fact.id, text: fact.text })))}\n\n可保留的原始信息：\n${JSON.stringify({ subject: seed.subject, activeSituation: seed.activeSituation, lockedGoal: seed.lockedGoal, lockedFacts: seed.lockedFacts })}\n\n作者创意方向：\n${JSON.stringify({
    tones: brief.tones.map((tone) => creativeToneLabels[tone]),
    dramaticForces: brief.dramaticForces.map((force) => dramaticForceLabels[force]),
    allowSystemNamedCharacters: brief.allowSystemNamedCharacters,
    note: brief.note ?? '',
  })}\n\n戏剧机制必须是：${getDramaticMechanism(brief)}。每条原始材料都必须至少被一个 beat 的 sourceFactIds 引用；无法纳入时不要编造，直接返回空数组让系统向作者说明。${excludedProposalDetails.length ? `以下提案已经被作者拒绝，不能在新版本中重现：${JSON.stringify(excludedProposalDetails)}` : ''}\n请给出一条主张明确、因果递进的暂定曲线。`
}

function buildCurveBeatRegenerationPrompt(
  idea: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  target: CurveBeat,
  feedback: string | undefined,
): string {
  const activeBeats = curve.beats
    .filter((beat) => beat.status !== 'rejected')
    .map((beat) => ({ id: beat.id, kind: beat.kind, detail: beat.detail, status: beat.status, sourceFactIds: beat.sourceFactIds }))
  const upstream = curve.beats
    .filter((beat) => target.dependsOn.includes(beat.id) && beat.status !== 'rejected')
    .map((beat) => ({ id: beat.id, detail: beat.detail }))
  const rejectedProposals = curve.beats
    .filter((beat) => beat.status === 'rejected' && beat.source === 'system-proposal')
    .map((beat) => ({ id: beat.id, detail: beat.detail }))
  const rejectedHistory = (curve.rejectedProposals ?? []).map((beat) => ({ id: beat.id, detail: beat.detail }))
  return `用户原始想法：${idea}\n原始信息：${JSON.stringify({ subject: seed.subject, lockedGoal: seed.lockedGoal, lockedFacts: seed.lockedFacts })}\n不可丢失的原始材料：${JSON.stringify(curve.design?.sourceFacts.filter((fact) => fact.disposition !== 'parked').map((fact) => ({ id: fact.id, text: fact.text })) ?? [])}\n创意方向：${JSON.stringify(curve.brief)}\n戏剧机制：${getDramaticMechanism(curve.brief)}\n当前有效曲线：${JSON.stringify(activeBeats)}\n目标节点的上游依据：${JSON.stringify(upstream)}\n已拒绝、不可重用的系统提案：${JSON.stringify([...rejectedProposals, ...rejectedHistory])}\n\n只重写目标节点：${JSON.stringify({ id: target.id, kind: target.kind, title: target.title, detail: target.detail })}${feedback ? `\n作者说明：${feedback}` : ''}\n重写必须具体承接上游依据或作者说明；不得重新使用已拒绝内容，也不得用“更重要的事”“承担代价”等无对象的泛化句代替因果。`
}
