import { randomUUID } from 'node:crypto'
import { AppError, requestQwenJson } from './qwen.js'
import {
  createStoryDesignRecord,
  buildStoryCurveFoundation,
  deriveCoveredSourceFactIds,
  ensureStoryDesignRecord,
  getDramaticMechanism,
  getMissingStoryDesignSections,
  getParkedStorySourceFactsUsedByCurve,
  getUnresolvedStorySourceFacts,
  isStoryCurveFoundationCurrent,
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
  CurveGenerationMetadata,
  DramaticForce,
  ProvisionalCurve,
  StoryAction,
  StoryCurveFoundation,
  StoryCurveRegenerationDecision,
  StoryCurveRegenerationPreview,
  StoryCurveRegenerationPreviewItem,
  StoryDesignRecord,
  StoryFact,
  StoryHeadTailOption,
  StoryPredicament,
  StoryPredicamentApproach,
  StorySeed,
  StorySourceFact,
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
const requiredConfirmationBeatKinds: readonly CurveBeatKind[] = [
  'current-state',
  'trigger',
  'escalation',
  'climax-choice',
  'resolution',
]
const initialNarrativeBeatKinds: readonly CurveBeatKind[] = [
  'current-state',
  'character-tension',
  'trigger',
  'escalation',
  'midpoint-turn',
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
const curveFallbackModelErrorCodes = new Set([
  'INVALID_MODEL_OUTPUT',
  'QWEN_NOT_CONFIGURED',
  'QWEN_EMPTY_RESPONSE',
  'QWEN_INVALID_JSON',
  'QWEN_INVALID_RESPONSE',
])

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

const variationAxisLabels: Record<StoryVariationAxis, string> = {
  time: '时机',
  resource: '资源',
  relationship: '关系',
  commitment: '承诺',
}

interface FallbackStoryMaterial {
  subject: string
  goal: string
  current: string
  observed: string
  deadline: string
  commitment: string
  decision: string
  /** Facts that were not selected as a primary role. They still need a
   * deliberate home in the curve instead of becoming unresolved noise. */
  remainingFacts: StorySourceFact[]
  factIds: {
    current: string[]
    observed: string[]
    deadline: string[]
    commitment: string[]
    decision: string[]
  }
}

export interface CurveMutationResult {
  curve: ProvisionalCurve
  affectedBeatIds: string[]
}

export interface CurveRegenerationPreviewResult {
  preview: StoryCurveRegenerationPreview
  affectedBeatIds: string[]
}

export interface MaterializedCurveFoundation {
  seed: StorySeed
  predicament: StoryPredicament
  approach: StoryPredicamentApproach
  headTail: StoryHeadTailOption
}

type CurveMutationOverrides = {
  rejectedProposals?: CurveBeat[]
  generation?: CurveGenerationMetadata
}

function assertDraftCurve(curve: ProvisionalCurve): void {
  if (curve.status !== 'draft') {
    throw new AppError('主线已经确认，请从确认前的版本重新编辑。', 409, 'STORY_CURVE_ALREADY_CONFIRMED')
  }
}

function requireCurveBeat(curve: ProvisionalCurve, beatId: string, action: string): CurveBeat {
  const beat = curve.beats.find((candidate) => candidate.id === beatId)
  if (!beat) {
    throw new AppError(`要${action}的曲线节点不存在，请刷新后重试。`, 409, 'STORY_SESSION_CONFLICT')
  }
  return beat
}

function createAuthorInstruction(
  kind: AuthorInstruction['kind'],
  text: string,
  targetBeatId?: string,
): AuthorInstruction {
  return {
    id: `instruction-${randomUUID()}`,
    kind,
    text,
    ...(targetBeatId ? { targetBeatId } : {}),
    createdAt: Date.now(),
  }
}

function markDependentBeatsStale(
  beats: readonly CurveBeat[],
  affectedBeatIds: readonly string[],
  options: { preserveRejected?: boolean } = {},
): CurveBeat[] {
  const affected = new Set(affectedBeatIds)
  return beats.map((beat) => (
    affected.has(beat.id)
      && beat.source !== 'user-input'
      && (!options.preserveRejected || beat.status !== 'rejected')
      ? { ...beat, status: 'stale' as const }
      : beat
  ))
}

function finalizeCurveMutation(
  curve: ProvisionalCurve,
  beats: CurveBeat[],
  instruction: AuthorInstruction,
  overrides: CurveMutationOverrides = {},
): ProvisionalCurve {
  const design = curve.design ? updateStoryDesignCoverage(curve.design, beats) : undefined
  const currentState = beats.find((beat) => beat.kind === 'current-state')
  const foundation = design
    ? buildStoryCurveFoundation(beats, curve.brief, {
      activeSituation: currentState?.detail ?? '',
      lockedGoal: currentState?.source === 'user-edit'
        ? currentState.detail
        : curve.foundation?.preservedGoal
        ?? curve.design?.foundation?.preservedGoal
        ?? null,
    })
    : undefined
  const nextDesign = design && foundation ? { ...design, foundation } : design
  const rejectedProposals = overrides.rejectedProposals ?? curve.rejectedProposals
  const generation = overrides.generation ?? curve.generation
  return {
    ...curve,
    beats,
    ...(nextDesign ? { design: nextDesign } : {}),
    ...(foundation ? { foundation } : {}),
    ...(rejectedProposals ? { rejectedProposals } : {}),
    ...(generation ? { generation } : {}),
    instructions: [...curve.instructions, instruction],
    updatedAt: Date.now(),
  }
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
      userPrompt: buildCurveGenerationPrompt(idea, seed, brief, design, excludedProposalDetails),
      temperature: 0.72,
      maxTokens: 1_700,
    })
    const curve = parseModelCurve(modelOutput, idea, seed, brief, design, excludedProposalDetails)
    if (curve) return curve
  } catch (error) {
    // A deterministic draft is only a valid recovery for the explicit local
    // acceptance switch or an unusable model payload. Configuration, auth and
    // network failures must remain visible instead of being returned as a
    // seemingly successful curve.
    if (!(error instanceof AppError)
      || (!isModelDisabled() && !curveFallbackModelErrorCodes.has(error.code))) {
      throw error
    }
  }

  return createProvisionalCurveFallback(idea, seed, brief, design, excludedProposalDetails)
}

export function updateCurveBeat(
  curve: ProvisionalCurve,
  beatId: string,
  detail: string,
): CurveMutationResult {
  const normalizedDetail = normalizeCurveText(detail, '曲线节点内容不能为空。')
  const target = requireCurveBeat(curve, beatId, '编辑')
  if (target?.status === 'rejected') {
    throw new AppError('这条提案已被你拒绝，不能直接恢复。请编辑其他节点，或创建一个新的主线版本。', 409, 'STORY_CURVE_REJECTED_IMMUTABLE')
  }
  assertDraftCurve(curve)

  const affectedBeatIds = getDependentBeatIds(curve.beats, beatId)
  const instruction = createAuthorInstruction('replace', normalizedDetail, beatId)
  const beats = markDependentBeatsStale(curve.beats.map((beat) => {
      if (beat.id === beatId) {
        return {
          ...beat,
          detail: normalizedDetail,
          causalAnchor: compactAuthorMaterial(normalizedDetail),
          source: 'user-edit' as const,
        status: 'edited' as const,
        sourceFactIds: curve.design
          ? deriveCoveredSourceFactIds(curve.design, normalizedDetail, true)
          : beat.sourceFactIds,
      }
    }
    return beat
  }), affectedBeatIds)

  return {
    curve: finalizeCurveMutation(curve, beats, instruction),
    affectedBeatIds,
  }
}

interface GeneratedCurveBeatDetail {
  detail: string
  causalAnchor: string
  usedFallback: boolean
}

async function generateCurveBeatDetail(
  idea: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  target: CurveBeat,
  feedback?: string,
): Promise<GeneratedCurveBeatDetail> {
  const seedWithAuthorEdits = applyCurrentCurveEditToSeed(seed, curve)
  const authorAnchor = getNearestAuthorEditAnchor(curve, target)
  const fallbackDetail = authorAnchor
    ? createAuthorDrivenReplacementDetail(
        target.kind,
        getStorySubject(seedWithAuthorEdits),
        getStoryGoal(seedWithAuthorEdits, seedWithAuthorEdits.activeSituation),
        curve.brief,
        authorAnchor,
      )
    : createReplacementDetail(
        idea,
        target.kind,
        seedWithAuthorEdits,
        curve.brief,
        curve,
        target,
      )
  const fallbackAnchor = authorAnchor
    ? getAuthorDrivenCausalAnchor(target.kind, authorAnchor)
    : getFallbackCausalAnchor(
        target.kind,
        getStorySubject(seedWithAuthorEdits),
        getStoryGoal(seedWithAuthorEdits, seedWithAuthorEdits.activeSituation),
        curve.brief,
        getCausalAnchor(curve, target, getStoryGoal(seedWithAuthorEdits, seedWithAuthorEdits.activeSituation)),
      )

  try {
    const modelOutput = await requestQwenJson({
      systemPrompt: curveBeatRegenerationSystemPrompt,
      userPrompt: buildCurveBeatRegenerationPrompt(idea, seedWithAuthorEdits, curve, target, feedback),
      temperature: 0.68,
      maxTokens: 480,
    })
    const modelDetail = parseRegeneratedBeatDetail(
      modelOutput,
      target.kind,
      curve.brief,
      seedWithAuthorEdits,
      curve,
      target,
    )
    if (modelDetail) {
      return {
        detail: modelDetail,
        causalAnchor: authorAnchor
          ? getAuthorDrivenCausalAnchor(target.kind, authorAnchor)
          : getFallbackCausalAnchor(
              target.kind,
              getStorySubject(seedWithAuthorEdits),
              getStoryGoal(seedWithAuthorEdits, seedWithAuthorEdits.activeSituation),
              curve.brief,
              getCausalAnchor(curve, target, modelDetail),
            ),
        usedFallback: false,
      }
    }
  } catch (error) {
    // Invalid/empty model payloads may use the visible deterministic draft,
    // but configuration, auth, network and timeout failures must reach the
    // author instead of being disguised as a successful regeneration.
    if (!(error instanceof AppError)
      || (!isModelDisabled() && !curveFallbackModelErrorCodes.has(error.code))) {
      throw error
    }
  }

  return { detail: fallbackDetail, causalAnchor: fallbackAnchor, usedFallback: true }
}

function getNearestAuthorEditAnchor(curve: ProvisionalCurve, target: CurveBeat): string | undefined {
  const visited = new Set<string>()
  // Only the first downstream node should carry the author's compact handle.
  // Once that node has been regenerated, later nodes inherit its causal
  // consequence through `getCausalAnchor`; walking all the way back to the
  // author edit would reprint the same sentence at every level.
  for (const beatId of target.dependsOn) {
    if (visited.has(beatId)) continue
    visited.add(beatId)
    const beat = curve.beats.find((candidate) => candidate.id === beatId)
    if (beat?.source === 'user-edit' && beat.status !== 'rejected') {
      return compactAuthorMaterial(beat.detail)
    }
  }
  return undefined
}

function getAuthorDrivenCausalAnchor(kind: CurveBeatKind, authorAnchor: string): string {
  const compact = compactAuthorMaterial(authorAnchor)
  const purpose = compact.split(/[，；]/u).at(-1)?.trim() || compact
  switch (kind) {
    case 'character-tension': return `${purpose}暴露的矛盾`
    case 'trigger': return `${purpose}带来的限制`
    case 'escalation': return `${purpose}带来的前置条件`
    case 'midpoint-turn': return `${purpose}改变了原办法`
    case 'climax-choice': return `${purpose}要求作出取舍`
    case 'resolution': return `${purpose}留下的责任`
    case 'current-state': return purpose
  }
}

function createAuthorDrivenReplacementDetail(
  kind: CurveBeatKind,
  subject: string,
  goal: string,
  brief: CreativeBrief,
  authorAnchor: string,
): string {
  // The author handle may intentionally contain two short clauses (the
  // decision and its consequence). `shortenCurveContext` would split at the
  // semicolon and discard the consequence, so preserve the compact author
  // handle as-is here.
  const anchor = shortenAuthorAnchor(authorAnchor)
  const goalPhrase = getGoalPhrase(goal)
  const goalObject = getGoalObject(goal)
  switch (kind) {
    case 'character-tension':
      return `暂定：${subject}原来依赖的办法与“${anchor}”发生冲突；继续${goalPhrase}前，必须重新界定自己愿意承担的部分。`
    case 'trigger':
      return `暂定：“${anchor}”让${subject}不能再把${goalObject}当成照旧执行的安排，原来的办法因此停住；${getToneCausalClause(brief, 'trigger')}。`
    case 'escalation':
      return `暂定：围绕“${anchor}”，${subject}继续${goalPhrase}时必须先处理这项决定带来的前置条件；回避会让代价变得具体。`
    case 'midpoint-turn':
      return `暂定：${subject}发现“${anchor}”改变了自己对${goalObject}的判断，旧办法无法同时保留这项决定和目标；${getToneCausalClause(brief, 'midpoint')}。`
    case 'climax-choice':
      return `暂定：${subject}必须在“${anchor}”的要求与继续${goalPhrase}之间作出取舍；选择会明确放弃另一项条件，不能由别人代替。`
    case 'resolution':
      return `暂定：${subject}如何兑现“${anchor}”中的决定，会决定${goalPhrase}最终保留什么，并留下可辨认的人物变化。`
    case 'current-state':
      return `暂定：${subject}需要先明确“${anchor}”如何改变${goalPhrase}。`
  }
}

function replaceRejectedProposalIfNeeded(
  generated: GeneratedCurveBeatDetail,
  seed: StorySeed,
  curve: ProvisionalCurve,
  target: CurveBeat,
): GeneratedCurveBeatDetail {
  if (!repeatsRejectedProposal(generated.detail, curve)) return generated

  // A replacement is an explicit new proposal, never a resurrection of the
  // wording the author rejected. Keep the fallback deterministic when the
  // model returns the same premise again.
  const alternateBrief = getAlternativeFallbackBrief(curve.brief, [target.detail])
  const relatedFact = curve.design?.sourceFacts.find((fact) => target.sourceFactIds?.includes(fact.id))?.text
    ?? curve.design?.sourceFacts.find((fact) => fact.disposition !== 'parked')?.text
    ?? getStoryGoal(seed, seed.activeSituation)
  let detail = getFallbackDetailForKind(
    target.kind,
    getStorySubject(seed),
    getStoryGoal(seed, seed.activeSituation),
    alternateBrief,
    relatedFact,
  )
  if (repeatsRejectedProposal(detail, curve)) {
    detail = `暂定：${getStorySubject(seed)}需要围绕“${shortenCurveContext(relatedFact)}”重新判断如何继续，具体代价留待作者决定。`
  }
  return {
    detail,
    causalAnchor: getFallbackCausalAnchor(
      target.kind,
      getStorySubject(seed),
      getStoryGoal(seed, seed.activeSituation),
      alternateBrief,
      relatedFact,
    ),
    usedFallback: true,
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
  const target = requireCurveBeat(curve, beatId, '重推')
  const targetWasRejected = target?.status === 'rejected'
  if (targetWasRejected && !replaceRejected) {
    throw new AppError('这条提案已被你拒绝，不能重新生成。请编辑其他节点，或创建一个新的主线版本。', 409, 'STORY_CURVE_REJECTED_IMMUTABLE')
  }
  assertDraftCurve(curve)
  if (target.source === 'user-input' || target.kind === 'current-state') {
    throw new AppError('当前状态来自你的原始想法，请直接编辑它，不要让系统重写。', 400, 'STORY_CURVE_USER_NODE_REGENERATE_FORBIDDEN')
  }
  if (target.source === 'user-edit') {
    throw new AppError('这条内容是你的作者编辑。请继续编辑它，或先修改上游节点后再决定如何调整，系统不会覆盖它。', 400, 'STORY_CURVE_AUTHOR_NODE_REGENERATE_FORBIDDEN')
  }

  const normalizedFeedback = feedback ? normalizeCurveText(feedback, '重推说明不能为空。') : undefined
  const regenerated = await generateCurveBeatDetail(idea, seed, curve, target, normalizedFeedback)
  const replacement = targetWasRejected
    ? replaceRejectedProposalIfNeeded(regenerated, seed, curve, target)
    : regenerated

  const affectedBeatIds = getDependentBeatIds(curve.beats, beatId)
  const instruction = createAuthorInstruction(
    'regenerate',
    normalizedFeedback ?? '请按当前创意方向重推这个节点。',
    beatId,
  )
  const beats = markDependentBeatsStale(curve.beats.map((beat) => {
      if (beat.id === beatId) {
        return {
          ...beat,
          detail: replacement.detail,
          causalAnchor: replacement.causalAnchor,
        source: 'system-proposal' as const,
        status: 'proposed' as const,
        sourceFactIds: curve.design
          ? deriveCoveredSourceFactIds(curve.design, replacement.detail)
          : beat.sourceFactIds,
      }
    }
    return beat
  }), affectedBeatIds)
  const rejectedProposals = targetWasRejected
    ? [
        ...(curve.rejectedProposals ?? []),
        {
          ...target,
          status: 'rejected' as const,
        },
      ]
    : curve.rejectedProposals

  return {
    curve: finalizeCurveMutation(curve, beats, instruction, {
      rejectedProposals,
      ...(replacement.usedFallback
        ? {
            generation: {
              origin: 'fact-preserving-fallback' as const,
              dramaticMechanism: getDramaticMechanism(curve.brief),
              notice: '系统未能可靠重推这一节点，已保留原始材料并生成可编辑的结构草案。',
            },
          }
        : {}),
    }),
    affectedBeatIds,
  }
}

export function rejectCurveBeat(
  curve: ProvisionalCurve,
  beatId: string,
  reason?: string,
): CurveMutationResult {
  const target = requireCurveBeat(curve, beatId, '不采用')
  assertDraftCurve(curve)
  if (target.source === 'user-input') {
    throw new AppError('这条内容来自你的原始想法，请编辑它或标记为暂不纳入，而不是删除。', 400, 'STORY_CURVE_USER_NODE_REJECT_FORBIDDEN')
  }
  if (target.source !== 'system-proposal') {
    throw new AppError('只有系统提出的内容可以标记为不采用。你的编辑请直接修改或恢复。', 400, 'STORY_CURVE_AUTHOR_NODE_REJECT_FORBIDDEN')
  }

  const affectedBeatIds = getDependentBeatIds(curve.beats, beatId)
  const beats = markDependentBeatsStale(curve.beats.map((beat) => (
    beat.id === beatId ? { ...beat, status: 'rejected' as const } : beat
  )), affectedBeatIds, { preserveRejected: true })
  const instruction = createAuthorInstruction(
    'remove',
    reason?.trim() || `不采用“${target.title}”这条系统提案。`,
    beatId,
  )
  return {
    curve: finalizeCurveMutation(curve, beats, instruction),
    affectedBeatIds,
  }
}

export async function regenerateAffectedCurveBeats(
  idea: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  feedback?: string,
): Promise<CurveMutationResult> {
  assertDraftCurve(curve)
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

/**
 * Generate replacements into a private working copy. Nothing reaches the
 * author-visible curve until resolveAffectedCurveBeats receives an explicit
 * decision for every item.
 */
export async function previewAffectedCurveBeats(
  idea: string,
  seed: StorySeed,
  curve: ProvisionalCurve,
  feedback?: string,
): Promise<CurveRegenerationPreviewResult> {
  assertDraftCurve(curve)
  let working = structuredClone(curve)
  const affectedBeatIds = working.beats
    .filter((beat) => beat.status === 'stale')
    .map((beat) => beat.id)
  const items: StoryCurveRegenerationPreviewItem[] = []

  for (const beatId of affectedBeatIds) {
    const target = working.beats.find((beat) => beat.id === beatId)
    if (!target || target.source !== 'system-proposal') continue
    const previous = structuredClone(target)
    const result = await regenerateCurveBeat(idea, seed, working, beatId, feedback)
    working = result.curve
    const proposed = working.beats.find((beat) => beat.id === beatId)
    if (!proposed) continue
    items.push({
      id: `regen-preview-item-${randomUUID()}`,
      beatId,
      title: target.title,
      kind: target.kind,
      oldDetail: previous.detail,
      newDetail: proposed.detail,
      newSourceFactIds: [...(proposed.sourceFactIds ?? [])],
      ...(proposed.causalAnchor ? { newCausalAnchor: proposed.causalAnchor } : {}),
    })
  }

  return {
    affectedBeatIds,
    preview: {
      id: `regen-preview-${randomUUID()}`,
      curveId: curve.id,
      items,
      createdAt: Date.now(),
    },
  }
}

export function resolveAffectedCurveBeats(
  curve: ProvisionalCurve,
  preview: StoryCurveRegenerationPreview,
  decisions: Record<string, StoryCurveRegenerationDecision>,
): CurveMutationResult {
  assertDraftCurve(curve)
  if (preview.curveId !== curve.id) {
    throw new AppError('批量重推预览不属于当前主线，请刷新后重试。', 409, 'STORY_SESSION_CONFLICT')
  }
  if (!preview.items.length) {
    throw new AppError('没有可供审阅的重推提案。', 400, 'STORY_CURVE_REGENERATION_EMPTY')
  }
  const previewItemIds = new Set(preview.items.map((item) => item.id))
  const decisionIds = Object.keys(decisions)
  if (decisionIds.some((id) => !previewItemIds.has(id))
    || preview.items.some((item) => decisions[item.id] !== 'accept' && decisions[item.id] !== 'reject')) {
    throw new AppError('请逐项接受或拒绝所有重推提案。', 400, 'STORY_CURVE_REGENERATION_DECISIONS_INCOMPLETE')
  }

  const itemByBeatId = new Map(preview.items.map((item) => [item.beatId, item]))
  const acceptedBeatIds = new Set(
    preview.items
      .filter((item) => decisions[item.id] === 'accept')
      .map((item) => item.beatId),
  )
  const rejectedBeatIds = new Set(
    preview.items
      .filter((item) => decisions[item.id] === 'reject')
      .map((item) => item.beatId),
  )
  const rejectedPreviewProposals = preview.items
    .filter((item) => decisions[item.id] === 'reject')
    .map((item): CurveBeat => {
      const original = curve.beats.find((beat) => beat.id === item.beatId)
      return {
        id: `rejected-preview-${randomUUID()}`,
        kind: item.kind,
        title: item.title,
        detail: item.newDetail,
        source: 'system-proposal',
        status: 'rejected',
        dependsOn: [...(original?.dependsOn ?? [])],
        sourceFactIds: [...item.newSourceFactIds],
        ...(item.newCausalAnchor ? { causalAnchor: item.newCausalAnchor } : {}),
      }
    })
  const beats = curve.beats.map((beat) => {
    const item = itemByBeatId.get(beat.id)
    if (!item || decisions[item.id] !== 'accept') return beat
    const blockedByRejectedDependency = beat.dependsOn.some((dependencyId) => {
      if (rejectedBeatIds.has(dependencyId)) return true
      const dependency = curve.beats.find((candidate) => candidate.id === dependencyId)
      return dependency?.status === 'stale' && !acceptedBeatIds.has(dependencyId)
    })
    if (blockedByRejectedDependency) return beat
      return {
        ...beat,
        detail: item.newDetail,
        ...(item.newCausalAnchor ? { causalAnchor: item.newCausalAnchor } : { causalAnchor: compactCausalMaterial(item.newDetail, item.newDetail) }),
      source: 'system-proposal' as const,
      status: 'proposed' as const,
      sourceFactIds: item.newSourceFactIds,
    }
  })
  const instruction = createAuthorInstruction(
    'regenerate',
    '作者逐项审阅了受影响节点的重推提案。',
  )
  return {
    curve: finalizeCurveMutation(curve, beats, instruction, {
      rejectedProposals: [
        ...(curve.rejectedProposals ?? []),
        ...rejectedPreviewProposals,
      ],
    }),
    affectedBeatIds: preview.items.map((item) => item.beatId),
  }
}

export function updateCurveSourceFactDisposition(
  curve: ProvisionalCurve,
  factId: string,
  disposition: 'parked' | 'integrated',
): CurveMutationResult {
  assertDraftCurve(curve)
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
  const affectedBeatIds = getSourceFactAffectedBeatIds(curve, factId, disposition, targetBeforeDisposition)
  const beats = updateBeatsForSourceFactDisposition(curve.beats, factId, disposition, affectedBeatIds)
  const instruction = createAuthorInstruction(
    'park-fact',
    disposition === 'parked' ? '作者明确暂不把这条原始材料纳入当前主线。' : '作者要求把这条原始材料纳入当前主线。',
  )
  return {
    curve: finalizeCurveMutation({ ...curve, design: updatedDesign }, beats, instruction),
    affectedBeatIds,
  }
}

function getSourceFactAffectedBeatIds(
  curve: ProvisionalCurve,
  factId: string,
  disposition: 'parked' | 'integrated',
  previousFact: StoryDesignRecord['sourceFacts'][number] | undefined,
): string[] {
  if (disposition === 'parked') {
    return curve.beats
      .filter((beat) => beat.status !== 'rejected' && beat.sourceFactIds?.includes(factId))
      .map((beat) => beat.id)
  }
  if (previousFact?.disposition !== 'parked') return []
  return previousFact.coveredByBeatIds.filter((beatId) => (
    curve.beats.some((beat) => beat.id === beatId && beat.status !== 'rejected')
  ))
}

function updateBeatsForSourceFactDisposition(
  beats: readonly CurveBeat[],
  factId: string,
  disposition: 'parked' | 'integrated',
  affectedBeatIds: readonly string[],
): CurveBeat[] {
  const affected = new Set(affectedBeatIds)
  if (!affected.size) return [...beats]

  return beats.map((beat) => {
    if (!affected.has(beat.id)) return beat
    if (disposition === 'parked') {
      // Keep the text visible for review, but remove the live traceability
      // claim until the author explicitly integrates the fact again.
      return {
        ...beat,
        status: 'stale' as const,
        sourceFactIds: beat.sourceFactIds?.filter((sourceFactId) => sourceFactId !== factId),
      }
    }
    // Restoring a parked fact is explicit, but still requires another review
    // before the old material can be confirmed in this version.
    return {
      ...beat,
      status: 'stale' as const,
      sourceFactIds: [...new Set([...(beat.sourceFactIds ?? []), factId])],
    }
  })
}

export function confirmProvisionalCurve(curve: ProvisionalCurve): {
  curve: ProvisionalCurve
  confirmedCurve: ConfirmedCurve
} {
  const design = validateCurveForConfirmation(curve)
  const foundation = curve.foundation
    ?? design?.foundation
  if (!foundation) {
    throw new AppError('这条主线还没有形成完整的故事设计基础，请重新生成曲线。', 400, 'STORY_CURVE_FOUNDATION_INCOMPLETE')
  }
  const confirmedAt = Date.now()
  const beats = curve.beats.map((beat) => (
    beat.status === 'rejected' ? beat : { ...beat, status: 'confirmed' as const }
  ))
  const confirmed = {
    ...curve,
    beats,
    ...(design ? { design } : {}),
    foundation,
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
      foundation,
      ...(confirmed.generation ? { generation: confirmed.generation } : {}),
      confirmedAt,
    },
  }
}

function validateCurveForConfirmation(curve: ProvisionalCurve): StoryDesignRecord | undefined {
  if (curve.status !== 'draft') {
    throw new AppError('这条主线已经不是可确认的草案，请刷新后重试。', 409, 'STORY_CURVE_NOT_DRAFT')
  }
  if (curve.beats.length < 5 || curve.beats.length > 7) {
    throw new AppError('暂定故事曲线需要包含 5 至 7 个节点。', 400, 'STORY_CURVE_INCOMPLETE')
  }
  if (curve.beats.some((beat) => beat.status === 'stale' || beat.source === 'undecided')) {
    throw new AppError('请先处理被修改影响的曲线节点，再确认主线。', 400, 'STORY_CURVE_HAS_STALE_BEATS')
  }

  const hasAllRequiredKinds = requiredConfirmationBeatKinds.every((kind) => (
    curve.beats.some((beat) => beat.kind === kind && beat.status !== 'rejected')
  ))
  if (!hasAllRequiredKinds) {
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
  const foundation = curve.foundation ?? design?.foundation
  if (!foundation || !isStoryCurveFoundationCurrent(foundation, curve.beats)) {
    throw new AppError(
      '故事设计基础已经过期，请先重新生成或逐条重看受影响节点，再确认主线。',
      409,
      'STORY_CURVE_FOUNDATION_OUT_OF_DATE',
    )
  }
  const liveFactIds = new Set(design?.sourceFacts
    .filter((fact) => fact.disposition === 'integrated')
    .map((fact) => fact.id) ?? [])
  const foundationFactIds = new Set([
    ...(foundation.sourceFactIds?.conflictCore ?? []),
    ...(foundation.sourceFactIds?.predicament ?? []),
    ...(foundation.sourceFactIds?.middleDevelopment ?? []),
    ...(foundation.sourceFactIds?.storyEnds ?? []),
  ])
  if (liveFactIds.size && [...liveFactIds].some((factId) => !foundationFactIds.has(factId))) {
    throw new AppError(
      '还有原始材料没有进入冲突、困境、中段或故事两端的统一设计，请编辑或重推后再确认。',
      400,
      'STORY_CURVE_FOUNDATION_FACTS_INCOMPLETE',
    )
  }
  return design
}

export function materializeConfirmedCurve(
  seed: StorySeed,
  confirmedCurve: ConfirmedCurve,
): MaterializedCurveFoundation {
  const beats = getConfirmedCurveBeats(confirmedCurve)
  const foundation = confirmedCurve.foundation
    ?? confirmedCurve.design?.foundation
  if (!foundation) {
    throw new AppError('已确认主线缺少冻结的故事设计基础，请恢复旧版本后重新确认。', 409, 'STORY_CURVE_FOUNDATION_INCOMPLETE')
  }
  if (!isStoryCurveFoundationCurrent(foundation, confirmedCurve.beats)) {
    throw new AppError('已确认主线的故事设计基础与节点不一致，不能重新反向生成困境。请恢复匹配的主线版本。', 409, 'STORY_CURVE_FOUNDATION_OUT_OF_DATE')
  }
  const narrativeSeed = createNarrativeSeed(seed, confirmedCurve, foundation)
  const confirmedGoal = foundation.preservedGoal || getConfirmedCurveGoal(narrativeSeed, beats.currentState)
  const curveFacts = materializeConfirmedCurveFacts(seed, confirmedCurve)
  const climaxAction = createConfirmedClimaxAction(beats.climax)
  const approach = createConfirmedApproach(foundation)
  const predicament = createConfirmedPredicament(
    confirmedCurve,
    beats,
    foundation,
    confirmedGoal,
    curveFacts,
    climaxAction,
    approach,
  )
  const headTail = createConfirmedHeadTail(foundation, confirmedGoal, climaxAction)
  const { systemDraft: _systemDraft, ...seedWithoutDraft } = narrativeSeed

  return {
    seed: { ...seedWithoutDraft, creativeBrief: confirmedCurve.brief },
    predicament,
    approach,
    headTail,
  }
}

interface ConfirmedCurveBeats {
  currentState: CurveBeat
  trigger: CurveBeat
  escalation: CurveBeat
  climax: CurveBeat
  resolution: CurveBeat
  characterTension?: CurveBeat
  midpoint?: CurveBeat
}

function getConfirmedCurveBeats(curve: ConfirmedCurve): ConfirmedCurveBeats {
  const requiredBeat = (kind: CurveBeatKind): CurveBeat => {
    const beat = curve.beats.find((candidate) => candidate.kind === kind && candidate.status !== 'rejected')
    if (!beat) throw new AppError('已确认主线缺少必要节点，请重新确认。', 409, 'STORY_CURVE_INCOMPLETE')
    return beat
  }
  return {
    currentState: requiredBeat('current-state'),
    trigger: requiredBeat('trigger'),
    escalation: requiredBeat('escalation'),
    climax: requiredBeat('climax-choice'),
    resolution: requiredBeat('resolution'),
    characterTension: curve.beats.find((beat) => beat.kind === 'character-tension' && beat.status !== 'rejected'),
    midpoint: curve.beats.find((beat) => beat.kind === 'midpoint-turn' && beat.status !== 'rejected'),
  }
}

function createNarrativeSeed(
  seed: StorySeed,
  confirmedCurve: ConfirmedCurve,
  foundation?: NonNullable<ConfirmedCurve['foundation']>,
): StorySeed {
  const materializedSeed = applyCurrentCurveEditToSeed(seed, confirmedCurve)
  const parkedFacts = (confirmedCurve.design?.sourceFacts ?? [])
    .filter((fact) => fact.disposition === 'parked')
    .map((fact) => fact.text.trim())
  const isParkedMaterial = (value: string) => parkedFacts.some((parked) => {
    const normalizedValue = value.trim()
    return normalizedValue === parked || (parked.length >= 4 && normalizedValue.includes(parked))
  })
  const foundationGoal = foundation?.preservedGoal?.trim()
  const currentStateWasEdited = confirmedCurve.beats.some((beat) => (
    beat.kind === 'current-state' && beat.source === 'user-edit'
  ))
  const lockedGoal = currentStateWasEdited
    ? materializedSeed.lockedGoal
    : foundationGoal || materializedSeed.lockedGoal
  return {
    ...materializedSeed,
    lockedFacts: materializedSeed.lockedFacts.filter((fact) => !isParkedMaterial(fact)),
    lockedGoal: lockedGoal && !isParkedMaterial(lockedGoal)
      ? lockedGoal
      : null,
  }
}

function materializeConfirmedCurveFacts(seed: StorySeed, curve: ConfirmedCurve): StoryFact[] {
  // Only the present obstacle and middle-development constraints belong in
  // the initial narrative state. Climax and resolution remain future
  // commitments in the confirmed curve.
  const seedFactStatements = new Set(seed.lockedFacts.map((statement) => statement.trim()))
  const sourceFacts = (curve.design?.sourceFacts ?? [])
    .filter((fact) => fact.disposition === 'integrated')
    .filter((fact) => !seedFactStatements.has(fact.text.trim()))
    .map((fact): StoryFact => ({
      id: `fact-source-${fact.id}`,
      statement: fact.text,
      source: 'confirmed-curve',
      mutability: 'fixed',
      ...(fact.coveredByBeatIds.length
        ? { originCurveBeatIds: getInitialCurveBeatIds(curve, fact.coveredByBeatIds) }
        : {}),
    }))
  const sourceFactStatements = new Set(sourceFacts.map((fact) => fact.statement))
  const proposalFactLimit = Math.max(0, 4 - sourceFacts.length)
  const proposalFacts = curve.beats
    .filter((beat) => beat.status !== 'rejected')
    .filter((beat) => beat.source === 'system-proposal' || (beat.kind === 'current-state' && beat.source === 'user-edit'))
    .filter((beat) => isInitialCurveBeat(beat.kind))
    .filter((beat) => !sourceFactStatements.has(beat.detail))
    .slice(0, proposalFactLimit)
    .map((beat): StoryFact => ({
      id: `fact-curve-${beat.id}`,
      statement: beat.detail,
      source: 'confirmed-curve',
      mutability: 'fixed',
      originCurveBeatIds: [beat.id],
    }))
  return [...sourceFacts, ...proposalFacts]
}

function getInitialCurveBeatIds(curve: ConfirmedCurve, beatIds: readonly string[]): string[] {
  return beatIds.filter((beatId) => {
    const beat = curve.beats.find((candidate) => candidate.id === beatId)
    return Boolean(beat && initialNarrativeBeatKinds.includes(beat.kind))
  })
}

function isInitialCurveBeat(kind: CurveBeatKind): boolean {
  return initialNarrativeBeatKinds.includes(kind)
}

function createConfirmedClimaxAction(climax: CurveBeat): StoryAction {
  return {
    id: 'curve-climax-action',
    intent: climax.detail,
    preconditions: [],
    effects: [],
    source: 'generated',
    originCurveBeatIds: [climax.id],
  }
}

function createConfirmedApproach(foundation: NonNullable<ConfirmedCurve['foundation']>): StoryPredicamentApproach {
  return {
    id: 'curve-approach',
    intent: foundation.approach.intent,
    cost: foundation.approach.cost,
  }
}

function createConfirmedPredicament(
  curve: ConfirmedCurve,
  beats: ConfirmedCurveBeats,
  foundation: NonNullable<ConfirmedCurve['foundation']>,
  confirmedGoal: string,
  facts: StoryFact[],
  climaxAction: StoryAction,
  approach: StoryPredicamentApproach,
): StoryPredicament {
  return {
    id: 'curve-predicament',
    title: foundation.predicament.title,
    variationAxis: foundation.predicament.variationAxis,
    preservedGoal: confirmedGoal,
    immediateSituation: foundation.predicament.immediateSituation,
    obstacle: foundation.predicament.obstacle,
    tradeoff: foundation.predicament.tradeoff,
    urgency: foundation.predicament.urgency,
    choice: foundation.predicament.choice,
    plausibleCost: foundation.predicament.plausibleCost,
    approaches: [approach],
    facts,
    actions: [climaxAction],
  }
}

function createConfirmedHeadTail(
  foundation: NonNullable<ConfirmedCurve['foundation']>,
  confirmedGoal: string,
  climaxAction: StoryAction,
): StoryHeadTailOption {
  const transition: StoryTransition = {
    actionId: climaxAction.id,
    consumedFacts: [],
    changedFacts: [],
    introducedFacts: [],
  }
  return {
    id: 'curve-head-tail',
    opening: foundation.storyEnds.opening,
    openingClue: foundation.storyEnds.openingClue,
    climax: foundation.storyEnds.climax,
    resolution: foundation.storyEnds.resolution,
    cost: foundation.storyEnds.cost,
    promise: foundation.storyEnds.promise || `围绕“${confirmedGoal}”完成一次会改变人物的选择。`,
    climaxActionId: climaxAction.id,
    transition,
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
  // A fact the author has parked belongs to this version's record, but is not
  // eligible as material for a new proposal. This keeps a rejected direction
  // from leaking back in through a deterministic fallback.
  const sourceFacts = design.sourceFacts.filter((fact) => fact.disposition !== 'parked')
  const material = deriveFallbackStoryMaterial(idea, seed, sourceFacts)
  const proposalBrief = getAlternativeFallbackBrief(brief, excludedProposalDetails)
  const turningMaterial = proposalBrief.dramaticForces.includes('relationship-tension')
    ? material.commitment
    : material.decision
  const hook = getFallbackTriggerDetail(material.subject, material.goal, proposalBrief, material.deadline, material)
  const tension = getFallbackTension(material.subject, material.goal, proposalBrief, material.observed, material)
  const currentStateDetail = material.current
  const now = Date.now()
  const proposalContext: FallbackProposalContext = {
    sourceFacts,
    subject: material.subject,
    goal: material.goal,
    proposalBrief,
    excludedProposalDetails,
    material,
  }
  const beats: CurveBeat[] = [
    createCurveBeat(
      'current-state',
      '此刻想要什么',
      currentStateDetail,
      'user-input',
      'confirmed',
      [],
      material.factIds.current,
      `当前状态是${compactCausalMaterial(currentStateDetail, material.goal)}`,
    ),
    createFallbackProposalBeat(proposalContext, {
      kind: 'character-tension',
      title: '人物的矛盾',
      detail: tension,
      material: material.observed,
      dependsOn: ['beat-current-state'],
      sourceFactIds: material.factIds.observed,
    }),
    createFallbackProposalBeat(proposalContext, {
      kind: 'trigger',
      title: '让目标停住的钩子',
      detail: hook,
      material: material.deadline,
      dependsOn: ['beat-current-state', 'beat-character-tension'],
      sourceFactIds: material.factIds.deadline,
    }),
    createFallbackProposalBeat(proposalContext, {
      kind: 'escalation',
      title: '阻碍开始升级',
      detail: getFallbackEscalation(material.subject, material.goal, proposalBrief, material.commitment, material),
      material: material.commitment,
      dependsOn: ['beat-trigger'],
      sourceFactIds: material.factIds.commitment,
    }),
    createFallbackProposalBeat(proposalContext, {
      kind: 'midpoint-turn',
      title: '中段转折',
      detail: getFallbackMidpointTurn(material.subject, material.goal, proposalBrief, turningMaterial, material),
      material: turningMaterial,
      dependsOn: ['beat-escalation'],
      sourceFactIds: material.factIds.decision,
    }),
    createFallbackProposalBeat(proposalContext, {
      kind: 'climax-choice',
      title: '高潮时的选择与代价',
      detail: getFallbackClimaxChoice(material.subject, material.goal, proposalBrief, turningMaterial, material),
      material: turningMaterial,
      dependsOn: ['beat-midpoint-turn'],
      sourceFactIds: [...new Set([...material.factIds.commitment, ...material.factIds.decision])],
    }),
    createFallbackProposalBeat(proposalContext, {
      kind: 'resolution',
      title: '结局中的变化',
      detail: getFallbackResolution(material.subject, material.goal, proposalBrief, turningMaterial, material),
      material: turningMaterial,
      dependsOn: ['beat-climax-choice'],
      sourceFactIds: [...new Set([...material.factIds.commitment, ...material.factIds.decision])],
    }),
  ]
  attachRemainingFallbackFacts(beats, material.remainingFacts, material.goal)
  const coveredDesign = updateStoryDesignCoverage(design, beats)
  const foundation = buildStoryCurveFoundation(beats, proposalBrief, {
    activeSituation: material.current,
    lockedGoal: material.goal,
  })
  return {
    id: `curve-${randomUUID()}`,
    title: `${getShortIdeaLabel(idea)}的暂定主线`,
    status: 'draft',
    brief,
    beats,
    instructions: [],
    design: foundation ? { ...coveredDesign, foundation } : coveredDesign,
    ...(foundation ? { foundation } : {}),
    generation: {
      origin: 'fact-preserving-fallback',
      dramaticMechanism: getDramaticMechanism(brief),
      notice: '系统未能完成可靠扩写，以下草案已逐条保留原始材料；请由你决定是否采用。',
    },
    createdAt: now,
    updatedAt: now,
  }
}

interface FallbackProposalContext {
  sourceFacts: StorySourceFact[]
  subject: string
  goal: string
  proposalBrief: CreativeBrief
  excludedProposalDetails: readonly string[]
  material: FallbackStoryMaterial
}

interface FallbackProposalSpec {
  kind: Exclude<CurveBeatKind, 'current-state'>
  title: string
  detail: string
  material: string
  dependsOn: string[]
  sourceFactIds: string[]
}

function deriveFallbackStoryMaterial(
  idea: string,
  seed: StorySeed,
  sourceFacts: readonly StorySourceFact[],
): FallbackStoryMaterial {
  const subject = getStorySubject(seed)
  const goal = getStoryGoal(seed, idea)
  const remaining = [...sourceFacts]
  const take = (predicate: (fact: StorySourceFact) => boolean, fallbackIndex = 0): StorySourceFact | undefined => {
    const index = remaining.findIndex(predicate)
    const selectedIndex = index >= 0 ? index : Math.min(fallbackIndex, Math.max(remaining.length - 1, 0))
    if (selectedIndex < 0 || !remaining[selectedIndex]) return undefined
    return remaining.splice(selectedIndex, 1)[0]
  }
  const currentFact = take((fact) => fact.text.includes(subject) || fact.text.includes('前') || fact.text.length > 18, 0)
  const observedFact = take((fact) => /(?:看到|发现|遇到|收到|拿到|作品|报告|耳环|短片)/u.test(fact.text), 0)
  const deadlineFact = take((fact) => /(?:今晚|明早|明天|截止|归还|交接|展出前|仪式前|布置前|之前|期限)/u.test(fact.text), 0)
  const commitmentFact = take((fact) => /(?:答应|承诺|不再|必须|约定|保证)/u.test(fact.text), 0)
  const decisionFact = take((fact) => fact.text.includes(goal) || /(?:想|决定|是否|要不要|打算|准备)/u.test(fact.text), 0)
  const fallbackFact = (candidate: StorySourceFact | undefined, fallback: string): StorySourceFact => (
    candidate ?? { id: `synthetic-${fallback}`, text: fallback, source: 'user-input', disposition: 'integrated', coveredByBeatIds: [] }
  )
  const currentBase = getAtomicFactHandle(fallbackFact(currentFact, '当前处境').text, '当前处境')
  const observed = getAtomicFactHandle(fallbackFact(observedFact, '原定安排').text, '原定安排')
  const deadline = getAtomicFactHandle(fallbackFact(deadlineFact, '眼前的时机').text, '眼前的时机')
  const commitment = getAtomicFactHandle(fallbackFact(commitmentFact, '尚未明确的取舍').text, '尚未明确的取舍')
  const decision = getAtomicFactHandle(fallbackFact(decisionFact, goal).text, goal)
  const ids = (fact: StorySourceFact | undefined, fallback: StorySourceFact | undefined): string[] => {
    const selected = fact ?? fallback
    return selected?.id.startsWith('synthetic-') ? [] : selected ? [selected.id] : []
  }
  // The current-state card is a compact starting point, not a second copy of
  // the whole premise. Other facts are assigned to the beat that develops
  // them, so repeating `observed` here would make a rich input look inflated.
  const current = currentBase
  const goalPhrase = getGoalPhrase(goal)
  const goalDecision = getGoalDecisionPhrase(goal)
  const currentWithGoal = current.includes(goalPhrase) || current.includes(goalDecision)
    ? current
    : `${current}；${subject}当前要决定${goalDecision}`
  return {
    subject,
    goal,
    current: currentWithGoal,
    observed,
    deadline,
    commitment,
    decision,
    remainingFacts: [...remaining],
    factIds: {
      current: ids(currentFact, sourceFacts[0]),
      observed: ids(observedFact, undefined),
      deadline: ids(deadlineFact, undefined),
      commitment: ids(commitmentFact, undefined),
      decision: ids(decisionFact, undefined),
    },
  }
}

/**
 * Role assignment deliberately starts with one primary fact per causal beat.
 * Rich ideas often contain one more consequence than the five obvious roles
 * (for example, a possible loss after a decision). Keep that consequence
 * visible and traceable by attaching it to the beat that can actually develop
 * it, while adding only a short object phrase to the proposal text.
 */
function attachRemainingFallbackFacts(
  beats: CurveBeat[],
  remainingFacts: readonly StorySourceFact[],
  goal: string,
): void {
  for (const fact of remainingFacts) {
    const normalized = fact.text.trim()
    if (!normalized) continue
    const kind: CurveBeatKind = /(?:期限|今晚|明早|明天|截止|归还|交接|之前|展出前|仪式前)/u.test(normalized)
      ? 'trigger'
      : /(?:答应|承诺|不再|约定|保证|要求|禁止|必须)/u.test(normalized)
        ? 'escalation'
        : /(?:决定|是否|要不要|可能|失去|代价|名字|署名|选择)/u.test(normalized)
          ? 'climax-choice'
          : 'character-tension'
    const target = beats.find((beat) => beat.kind === kind)
      ?? beats.find((beat) => beat.kind === 'resolution')
    if (!target) continue
    target.sourceFactIds = [...new Set([...(target.sourceFactIds ?? []), fact.id])]
    const handle = getAtomicFactHandle(normalized, getGoalPhrase(goal))
    if (!handle || target.detail.includes(handle)) continue
    const suffix = kind === 'trigger'
      ? `；处理时还要顾及${handle}`
      : kind === 'escalation'
        ? `；这项条件会让取舍更具体`
        : kind === 'climax-choice'
          ? `；代价还包括${handle}`
          : `；它会改变${getGoalPhrase(goal)}的判断`
    const nextDetail = `${target.detail.replace(/[。！？]$/u, '')}${suffix}。`
    target.detail = nextDetail.length > maximumCurveBeatLength
      ? `${nextDetail.slice(0, maximumCurveBeatLength - 1)}…`
      : nextDetail
    target.causalAnchor = shortenAuthorAnchor(handle)
  }
}

/** Keep one source fact as a short causal handle. The full wording remains in
 * the ledger; curve cards should carry only the object that the next beat
 * actually develops. */
function getAtomicFactHandle(value: string, fallback: string): string {
  const cleaned = value
    .replace(/^暂定[：:]/u, '')
    .replace(/^(?:却|但|并且|同时|然后|随后)\s*/u, '')
    .replace(/[“”"']/gu, '')
    .trim()
  const sceneMatch = cleaned.match(/(?:在|于)(?:借来的)?(.+?)(?:里|中)看到(?:和)?(.+)$/u)
  if (sceneMatch?.[1] && sceneMatch[2]) return shortenAtomicFact(`${sceneMatch[1]}里的${sceneMatch[2]}`)
  const decisionMatch = cleaned.match(/(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (decisionMatch?.[1]) return shortenAtomicFact(`是否${decisionMatch[1].trim()}`)
  const intentionMatch = cleaned.match(/(?:想要|想|希望|打算|准备)(?:在[^，。！？；]{0,16})?(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (intentionMatch?.[1]) return shortenAtomicFact(`是否${intentionMatch[1].trim()}`)
  const commitmentMatch = cleaned.match(/(?:答应|承诺|约定|保证)(.+)$/u)
  if (commitmentMatch?.[1]) return shortenAtomicFact(commitmentMatch[1].trim())
  const clauses = cleaned.split(/[，。！？；\n]/u).map((part) => part.trim()).filter(Boolean)
  const candidate = clauses.find((part) => part.length >= 4) ?? cleaned
  const withoutSubject = candidate.replace(/^[\u4e00-\u9fff]{1,4}(?=(?:在|于|想|要|答应|承诺|却))/u, '').trim()
  return shortenAtomicFact(withoutSubject || candidate || fallback)
}

function shortenAtomicFact(value: string): string {
  const normalized = value.trim()
  return normalized.length > 36 ? `${normalized.slice(0, 36)}…` : normalized
}

function createFallbackProposalBeat(
  context: FallbackProposalContext,
  spec: FallbackProposalSpec,
): CurveBeat {
  return createCurveBeat(
    spec.kind,
    spec.title,
    avoidExcludedProposal(
      spec.detail,
      spec.kind,
      context.subject,
      context.goal,
      context.proposalBrief,
      spec.material,
      context.excludedProposalDetails,
    ),
    'system-proposal',
    'proposed',
    spec.dependsOn,
    spec.sourceFactIds,
    getFallbackCausalAnchor(spec.kind, context.subject, context.goal, context.proposalBrief, spec.material, context.material),
  )
}

function createCurveBeat(
  kind: CurveBeatKind,
  title: string,
  detail: string,
  source: CurveBeat['source'],
  status: CurveBeat['status'],
  dependsOn: string[],
  sourceFactIds: string[] = [],
  causalAnchor?: string,
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
    ...(causalAnchor?.trim() ? { causalAnchor: causalAnchor.trim() } : {}),
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
      return getFallbackTriggerDetail(subject, goal, brief, material)
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

function getFallbackCausalAnchor(
  kind: CurveBeatKind,
  subject: string,
  goal: string,
  brief: CreativeBrief,
  material: string,
  storyMaterial?: FallbackStoryMaterial,
): string {
  const anchor = getConcreteMaterialHandle(material, goal, brief)
  switch (kind) {
    case 'character-tension':
      return storyMaterial?.observed && !isPlaceholderMaterial(storyMaterial.observed, goal)
        ? `${subject}对${getConcreteMaterialHandle(storyMaterial.observed, goal, brief)}的旧判断开始动摇`
        : `${subject}原来依赖的办法暴露出局限`
    case 'trigger':
      return anchor
    case 'escalation':
      return anchor
    case 'midpoint-turn':
      return anchor
    case 'climax-choice':
      return anchor
    case 'resolution':
      return anchor
    case 'current-state':
      return compactCausalMaterial(material, goal)
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
    const parsedDetail = item.kind === 'current-state' ? getCurrentState(seed, idea) : detail
    const suppliedAnchor = readOptionalText(item.causalAnchor, 90)
    parsedBeats.push(createCurveBeat(
      item.kind,
      getCurveBeatTitle(item.kind),
      parsedDetail,
      item.kind === 'current-state' ? 'user-input' : 'system-proposal',
      item.kind === 'current-state' ? 'confirmed' : 'proposed',
      parseDependencies(item.dependsOn),
      sourceFactIds,
      suppliedAnchor ?? compactCausalMaterial(parsedDetail, parsedDetail),
      ))
  }

  if (requiredConfirmationBeatKinds.some((kind) => !seenKinds.has(kind))) return undefined
  const orderedBeats = curveBeatKinds
    .filter((kind) => seenKinds.has(kind))
    .map((kind) => parsedBeats.find((beat) => beat.kind === kind)!)
  if (!isCurveGroundedToSeed(orderedBeats, seed)) return undefined
  const coveredDesign = updateStoryDesignCoverage(design, orderedBeats)
  if (getUnresolvedStorySourceFacts(coveredDesign).length) return undefined
  if (!hasStableCreativeDirection(orderedBeats, brief)) return undefined
  const plannedFoundation = buildStoryCurveFoundation(orderedBeats, brief, seed)
  // The model may suggest richer wording for the design map, but traceability
  // always comes from the exact beats that passed the source-fact and proposal
  // checks. This keeps one reviewed foundation shared by confirmation and the
  // first spine instead of reconstructing it after the fact.
  const modelFoundation = parseModelCurveFoundation(value.foundation)
  const foundation = modelFoundation && isModelFoundationGoalCompatible(modelFoundation, seed)
    ? mergeFoundationTrace(modelFoundation, plannedFoundation)
    : plannedFoundation
  if (!foundation) return undefined

  const now = Date.now()
  return {
    id: `curve-${randomUUID()}`,
    title,
    status: 'draft',
    brief,
    beats: normalizeCurveDependencies(orderedBeats),
    instructions: [],
    design: { ...updateStoryDesignCoverage(coveredDesign, normalizeCurveDependencies(orderedBeats)), foundation },
    foundation,
    generation: {
      origin: 'model',
      dramaticMechanism: getDramaticMechanism(brief),
    },
    createdAt: now,
    updatedAt: now,
  }
}

function mergeFoundationTrace(
  foundation: StoryCurveFoundation,
  trace: StoryCurveFoundation | undefined,
): StoryCurveFoundation {
  if (!trace) return foundation
  return {
    ...foundation,
    sourceFactIds: trace.sourceFactIds,
    beatSignatures: trace.beatSignatures,
  }
}

function isModelFoundationGoalCompatible(
  foundation: StoryCurveFoundation,
  seed: Pick<StorySeed, 'lockedGoal' | 'activeSituation'>,
): boolean {
  const expected = seed.lockedGoal?.trim()
  if (!expected) return true
  const expectedPhrase = getGoalPhrase(expected).replace(/[“”"']/gu, '')
  const candidate = `${foundation.preservedGoal} ${foundation.conflictCore.goal}`.replace(/[“”"']/gu, '')
  return Boolean(expectedPhrase)
    && (candidate.includes(expectedPhrase) || expectedPhrase.includes(getGoalPhrase(foundation.preservedGoal)))
}

function hasStableCreativeDirection(beats: readonly CurveBeat[], brief: CreativeBrief): boolean {
  const details = beats
    .filter((beat) => beat.kind !== 'current-state' && beat.status !== 'rejected')
    .map((beat) => beat.detail)
  const force = brief.dramaticForces[0]
  const tone = brief.tones[0]
  const forcePattern: Record<DramaticForce, RegExp> = {
    misunderstanding: /误会|理解|澄清|猜测|解释|信息/u,
    cost: /代价|放弃|牺牲|承担|交换|两全/u,
    surprise: /意外|突然|新条件|变化|时机|失效/u,
    contrast: /反而|局限|旧办法|依赖|露出|失效/u,
    'relationship-tension': /承诺|关系|信任|回应|裂痕|分歧/u,
  }
  const tonePattern: Record<CreativeTone, RegExp> = {
    comedy: /尴尬|体面|笑/u,
    warm: /理解|照顾|温暖|彼此/u,
    friendship: /朋友|信任|友情|同行/u,
    romance: /心意|喜欢|恋爱|告白/u,
    growth: /改变|成长|习惯|重新|承担/u,
    mystery: /信息|疑问|真相|解释|缺口/u,
    fantasy: /规则|边界|奇幻|魔法/u,
  }
  const forceHits = force ? details.filter((detail) => forcePattern[force].test(detail)).length : 3
  const toneHits = tone ? details.filter((detail) => tonePattern[tone].test(detail)).length : 3
  return forceHits >= 3 && toneHits >= 3
}

function parseModelCurveFoundation(value: unknown): StoryCurveFoundation | undefined {
  if (!isRecord(value)) return undefined
  const conflictCore = isRecord(value.conflictCore) ? value.conflictCore : undefined
  const predicament = isRecord(value.predicament) ? value.predicament : undefined
  const middleDevelopment = isRecord(value.middleDevelopment) ? value.middleDevelopment : undefined
  const storyEnds = isRecord(value.storyEnds) ? value.storyEnds : undefined
  const approach = isRecord(value.approach) ? value.approach : undefined
  if (!conflictCore || !predicament || !middleDevelopment || !storyEnds || !approach) return undefined
  const read = (record: Record<string, unknown>, key: string): string | undefined => (
    typeof record[key] === 'string' && record[key].trim() ? record[key].trim() : undefined
  )
  const variationAxis = predicament.variationAxis
  if (variationAxis !== 'time' && variationAxis !== 'resource' && variationAxis !== 'relationship' && variationAxis !== 'commitment') return undefined
  const required = [
    read(conflictCore, 'goal'), read(conflictCore, 'obstacle'), read(conflictCore, 'tradeoff'),
    read(value, 'preservedGoal'), read(predicament, 'title'), read(predicament, 'immediateSituation'),
    read(predicament, 'obstacle'), read(predicament, 'tradeoff'), read(predicament, 'urgency'),
    read(predicament, 'choice'), read(predicament, 'plausibleCost'), read(middleDevelopment, 'escalation'),
    read(middleDevelopment, 'midpoint'), read(middleDevelopment, 'climaxPressure'), read(storyEnds, 'opening'),
    read(storyEnds, 'openingClue'), read(storyEnds, 'climax'), read(storyEnds, 'resolution'),
    read(storyEnds, 'cost'), read(storyEnds, 'promise'), read(approach, 'intent'), read(approach, 'cost'),
  ]
  if (required.some((text) => !text)) return undefined
  return {
    conflictCore: {
      goal: required[0]!,
      obstacle: required[1]!,
      tradeoff: required[2]!,
    },
    preservedGoal: required[3]!,
    predicament: {
      title: required[4]!,
      variationAxis,
      immediateSituation: required[5]!,
      obstacle: required[6]!,
      tradeoff: required[7]!,
      urgency: required[8]!,
      choice: required[9]!,
      plausibleCost: required[10]!,
    },
    middleDevelopment: {
      escalation: required[11]!,
      midpoint: required[12]!,
      climaxPressure: required[13]!,
    },
    storyEnds: {
      opening: required[14]!,
      openingClue: required[15]!,
      climax: required[16]!,
      resolution: required[17]!,
      cost: required[18]!,
      promise: required[19]!,
    },
    approach: {
      intent: required[20]!,
      cost: required[21]!,
    },
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
    || repeatsFullUpstreamDetail(detail, curve, target)
    || hasNestedCurveQuotes(detail)
    || hasUnboundGenericCausalPhrase(detail)
    || repeatsRejectedProposal(detail, curve)
  ) return undefined
  return detail
}

function repeatsFullUpstreamDetail(
  detail: string,
  curve: ProvisionalCurve,
  target: CurveBeat,
): boolean {
  const normalizedDetail = normalizeCausalText(detail)
  if (normalizedDetail.length < 18) return false
  return curve.beats
    .filter((beat) => target.dependsOn.includes(beat.id) && beat.status !== 'rejected')
    .map((beat) => normalizeCausalText(beat.detail))
    .filter((upstream) => upstream.length >= 18)
    .some((upstream) => normalizedDetail.includes(upstream))
}

function hasNestedCurveQuotes(detail: string): boolean {
  return /“[^”]*“[^”]*”[^”]*”/u.test(detail)
    || /"[^"]*"[^"]*"/u.test(detail)
}

function hasUnboundGenericCausalPhrase(detail: string): boolean {
  // These phrases are acceptable only when they name the concrete object
  // immediately around them. A bare occurrence turns a regeneration into a
  // vague template and gives the next beat nothing causal to inherit.
  return /(?:更重要的事|承担代价)(?:[，。！？；]|$)/u.test(detail)
    || /(?:出现新的结果|发生可见变化)(?:[，。！？；]|$)/u.test(detail)
}

function normalizeCausalText(value: string): string {
  return value
    .replace(/^暂定[：:]/u, '')
    .replace(/[“”"']/gu, '')
    .replace(/\s+/gu, '')
    .trim()
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
  idea: string,
  kind: CurveBeatKind,
  seed: StorySeed,
  brief: CreativeBrief,
  curve: ProvisionalCurve,
  target: CurveBeat,
): string {
  const subject = getStorySubject(seed)
  const goal = getStoryGoal(seed, seed.activeSituation)
  const relatedFact = curve.design?.sourceFacts.find((fact) => target.sourceFactIds?.includes(fact.id))?.text
    ?? curve.design?.sourceFacts.find((fact) => fact.disposition !== 'parked')?.text
    ?? goal
  // Carry only the nearest causal consequence forward. This gives the first
  // dependent beat the author's edit, then lets each later beat advance the
  // consequence instead of repeatedly quoting the original edit.
  const premise = getCausalAnchor(curve, target, relatedFact)
  const storyMaterial = deriveFallbackStoryMaterial(
    idea,
    seed,
    curve.design?.sourceFacts.filter((fact) => fact.disposition !== 'parked') ?? [],
  )
  switch (kind) {
    case 'current-state':
      return getCurrentState(seed, seed.activeSituation)
    case 'character-tension':
      return getFallbackTension(subject, goal, brief, relatedFact, storyMaterial)
    case 'trigger':
      return getFallbackTriggerDetail(subject, goal, brief, relatedFact, storyMaterial)
    case 'escalation':
      return getFallbackEscalation(subject, goal, brief, premise, storyMaterial)
    case 'midpoint-turn':
      return getFallbackMidpointTurn(subject, goal, brief, premise, storyMaterial)
    case 'climax-choice':
      return getFallbackClimaxChoice(subject, goal, brief, premise, storyMaterial)
    case 'resolution':
      return getFallbackResolution(subject, goal, brief, premise, storyMaterial)
  }
}

function getFallbackTension(subject: string, goal: string, brief: CreativeBrief, material: string, storyMaterial?: FallbackStoryMaterial): string {
  const hasMaterial = !isPlaceholderMaterial(material, goal)
  const commitmentSource = storyMaterial?.commitment ?? material
  const hasCommitment = !isPlaceholderMaterial(commitmentSource, goal)
  const anchor = hasMaterial ? getConcreteMaterialHandle(material, goal, brief) : getDirectionAnchor(brief, goal)
  const goalPhrase = getGoalPhrase(goal)
  const goalDecision = getGoalDecisionPhrase(goal)
  const goalObject = getGoalObject(goal)
  const goalAction = getWantGoal(goal)
  const commitment = hasCommitment
    ? getConcreteMaterialHandle(commitmentSource, goal, brief)
    : getDirectionAnchor(brief, goal)
  const tone = getToneCausalClause(brief, 'tension')
  if (storyMaterial && hasConcreteFallbackMaterial(storyMaterial.observed, goal)) {
    const observed = getConcreteMaterialHandle(storyMaterial.observed, goal, brief)
    if (brief.dramaticForces.includes('relationship-tension') && hasConcreteFallbackMaterial(storyMaterial.commitment, goal)) {
      return `暂定：${observed}让${subject}原本的安排出现缺口，而${commitment}把这项帮忙变成必须回应的承诺；${tone}。`
    }
    switch (brief.dramaticForces[0]) {
      case 'misunderstanding':
        return `暂定：${observed}让${subject}无法确定这段材料究竟意味着什么；不同理解会把${goalDecision}带向不同方向。`
      case 'cost':
        return `暂定：${observed}让${subject}发现，继续${goalPhrase}必须先拿一项眼前条件来交换。`
      case 'surprise':
        return `暂定：${observed}打断了${subject}原本对${goalPhrase}的准备，原计划缺少一个关键条件。`
      case 'contrast':
        return `暂定：${observed}暴露出${subject}最依赖的办法并不能直接支持${goalPhrase}；旧把握开始动摇。`
      default:
        break
    }
    return `暂定：${observed}暴露出${subject}原本办法的缺口；${subject}仍要${goalPhrase}，却不能再假装条件齐全。`
  }
  if (brief.dramaticForces.includes('relationship-tension')) {
    return `暂定：${subject}${goalAction}，但“${commitment}”使已经说出的承诺与现在的选择无法同时成立；${tone}`
  }
  if (brief.dramaticForces.includes('contrast')) {
    if (brief.tones.includes('mystery')) {
      return `暂定：${anchor}让${subject}无法只凭表面判断是否${getGoalObject(goal)}；信息缺口开始拖住${goalPhrase}。`
    }
    if (brief.tones.includes('growth')) {
      if (!hasMaterial && !hasCommitment) {
        return `暂定：${subject}想${goalPhrase}，却还没有决定是否由自己承担这次选择；${tone}`
      }
      return `暂定：${anchor}让${subject}原来依赖的做法露出局限；要${goalPhrase}就得重新承担${commitment}。`
    }
    if (brief.tones.includes('comedy')) {
      return `暂定：${anchor}让${subject}越想维持体面，越容易暴露原来办法的漏洞；${goalPhrase}因此不能照旧进行。`
    }
    return `暂定：${anchor}让${subject}原本最有把握的做法露出局限，继续照做反而会拖住${goalPhrase}；${tone}`
  }
  return `暂定：${subject}面对${anchor}仍${goalAction}，却必须先承认这件事会改变自己愿意承担的范围；${tone}`
}

function getFallbackTriggerDetail(subject: string, goal: string, brief: CreativeBrief, material: string, storyMaterial?: FallbackStoryMaterial): string {
  const hasMaterial = !isPlaceholderMaterial(material, goal)
  const commitmentSource = storyMaterial?.commitment ?? material
  const hasCommitment = !isPlaceholderMaterial(commitmentSource, goal)
  const anchor = hasMaterial ? getConcreteMaterialHandle(material, goal, brief) : getDirectionAnchor(brief, goal)
  const goalPhrase = getGoalPhrase(goal)
  const goalDecision = getGoalDecisionPhrase(goal)
  const goalAction = getWantGoal(goal)
  const commitment = hasCommitment
    ? getConcreteMaterialHandle(commitmentSource, goal, brief)
    : getDirectionAnchor(brief, goal)
  const tone = getToneCausalClause(brief, 'trigger')
  const force = brief.dramaticForces[0]
  if (storyMaterial && hasConcreteFallbackMaterial(storyMaterial.deadline, goal)) {
    const deadline = getConcreteMaterialHandle(storyMaterial.deadline, goal, brief)
    switch (force) {
      case 'misunderstanding':
        return `暂定：“${deadline}”让${subject}对${goalDecision}的理解出现分歧；在澄清前，原计划不能照常推进。`
      case 'cost':
        return `暂定：“${deadline}”把${goalDecision}变成时间与${commitment}之间的取舍；继续${goalPhrase}会先消耗一项条件。`
      case 'surprise':
        return `暂定：“${deadline}”提前压缩了${subject}处理${goalDecision}的时间；原来安排的缓冲被意外拿走。`
      case 'relationship-tension':
        return `暂定：“${deadline}”让${subject}必须同时回应${commitment}和${goalDecision}，拖延会先伤到关系。`
      case 'contrast':
      default:
        return `暂定：“${deadline}”暴露出${subject}原来以为足够的准备并不够；${goalDecision}不能照旧进行。`
    }
  }
  switch (force) {
    case 'misunderstanding':
      return `暂定：${anchor}中的关键信息尚未被同样理解，让${subject}${goalAction}的原计划停住；${tone}`
    case 'cost':
      return `暂定：${anchor}让${subject}发现继续${goalPhrase}会直接牺牲${commitment}所代表的条件；${tone}`
    case 'surprise':
      return `暂定：${anchor}改变了${subject}原本依赖的条件，迫使其重新判断是否继续${goalPhrase}；${tone}`
    case 'relationship-tension':
      return `暂定：${anchor}让${subject}不能把${getGoalObject(goal)}与已经说出的承诺分开处理，拖延会留下关系上的代价；${tone}`
    case 'contrast':
    default:
      if (brief.tones.includes('mystery')) {
        return `暂定：${anchor}留下一个不能立即解释的信息缺口，${subject}若继续${goalPhrase}就得先决定相信哪部分；信息仍交给作者确认。`
      }
      if (brief.tones.includes('growth')) {
        if (!hasMaterial && !hasCommitment) {
          return `暂定：${subject}要${goalPhrase}，必须先说明这次选择由谁负责；${tone}`
        }
        return `暂定：${anchor}让${subject}不能把${getGoalObject(goal)}和${commitment}分开处理，拖延会缩小${subject}重新选择的空间。`
      }
      if (brief.tones.includes('comedy')) {
        return `暂定：${anchor}把${subject}想维持的体面变成公开风险，继续${goalPhrase}不再只是照原计划行动。`
      }
      return `暂定：${anchor}让${subject}最擅长的办法恰好变成继续${goalPhrase}的新阻碍；${tone}`
  }
}

function getFallbackEscalation(subject: string, goal: string, brief: CreativeBrief, material: string, storyMaterial?: FallbackStoryMaterial): string {
  const hasMaterial = !isPlaceholderMaterial(material, goal)
  const commitmentSource = storyMaterial?.commitment ?? material
  const hasCommitment = !isPlaceholderMaterial(commitmentSource, goal)
  const anchor = hasMaterial ? getConcreteMaterialHandle(material, goal, brief) : getDirectionAnchor(brief, goal)
  const goalPhrase = getGoalPhrase(goal)
  const goalObject = getGoalObject(goal)
  const commitment = hasCommitment
    ? getConcreteMaterialHandle(commitmentSource, goal, brief)
    : getDirectionAnchor(brief, goal)
  const commitmentEvidence = hasCommitment
    ? getCommitmentEvidence(commitment, goal, brief)
    : `由${subject}承担这次选择`
  const goalDecision = getGoalDecisionPhrase(goal)
  const progression = getProgressionAnchor(material, storyMaterial, goal, brief, commitment)
  const tone = getToneCausalClause(brief, 'escalation')
  if (storyMaterial && hasConcreteFallbackMaterial(storyMaterial.commitment, goal)) {
    const commitmentLabel = getConcreteMaterialHandle(storyMaterial.commitment, goal, brief)
    switch (brief.dramaticForces[0]) {
      case 'misunderstanding':
        return `暂定：“${commitmentLabel}”与${subject}对${goalDecision}的理解不一致；继续推进会把误会扩大到下一步。`
      case 'cost':
        return `暂定：“${commitmentLabel}”要求${subject}在${goalDecision}和一项已承诺条件之间先放弃其一；代价开始具体。`
      case 'surprise':
        return `暂定：“${commitmentLabel}”把${goalDecision}推向原计划没有预留的条件；越拖越难回到原办法。`
      case 'relationship-tension':
        return `暂定：“${commitmentLabel}”让${subject}不能同时兑现承诺和${goalDecision}；回避本身会让关系失去退路。`
      case 'contrast':
      default:
        return `暂定：“${commitmentLabel}”让${subject}最依赖的办法反而卡住${goalDecision}；继续拖延会迫使${subject}承认旧办法失效。`
    }
  }
  switch (brief.dramaticForces[0]) {
    case 'misunderstanding':
      return `暂定：${anchor}的含义迟迟无法确认，${subject}若继续${goalPhrase}，就必须先决定是否公开自己的理解；${tone}`
    case 'cost':
      return `暂定：${commitmentEvidence}使${subject}不能同时保住${goalPhrase}和眼前条件，${anchor}把代价具体化；${tone}`
    case 'surprise':
      return `暂定：${anchor}改变了原本可用的条件，${subject}必须在变化扩大前重新安排${goalPhrase}的取舍；${tone}`
    case 'relationship-tension':
      return `暂定：${commitmentEvidence}让${subject}继续${goalPhrase}时必须先回应${progression}，回避本身会让关系失去退路；${tone}`
    case 'contrast':
    default:
      if (brief.tones.includes('mystery')) {
        return `暂定：${progression}的不同解释会把${subject}带向不同决定；她不能一边保留信息缺口，一边照旧${goalPhrase}。`
      }
      if (brief.tones.includes('growth')) {
        if (!hasMaterial && !hasCommitment) {
          return `暂定：${subject}继续${goalPhrase}时，必须在照原安排进行与自己承担这次选择之间取舍；回避会让两边都失去空间。`
        }
        return `暂定：${commitmentEvidence}使${subject}必须在兑现承诺与${getGoalObject(goal)}之间取舍；继续回避会让${progression}两边都失去空间。`
      }
      if (brief.tones.includes('comedy')) {
        return `暂定：${progression}证明旧办法只能延后尴尬，${subject}若继续${goalPhrase}就得先承认自己无法同时保住体面和目标。`
      }
      return `暂定：${progression}让${subject}最依赖的办法反而卡住${goalPhrase}，必须承认原来的强项解决不了这次问题；${tone}`
  }
}

function getFallbackMidpointTurn(subject: string, goal: string, brief: CreativeBrief, material: string, storyMaterial?: FallbackStoryMaterial): string {
  const hasMaterial = !isPlaceholderMaterial(material, goal)
  const anchor = hasMaterial ? getConcreteMaterialHandle(material, goal, brief) : getDirectionAnchor(brief, goal)
  const goalPhrase = getGoalPhrase(goal)
  const goalObject = getGoalObject(goal)
  const commitmentSource = storyMaterial?.commitment ?? material
  const hasCommitment = !isPlaceholderMaterial(commitmentSource, goal)
  const commitment = hasCommitment
    ? getConcreteMaterialHandle(commitmentSource, goal, brief)
    : getDirectionAnchor(brief, goal)
  const progression = getProgressionAnchor(material, storyMaterial, goal, brief, commitment)
  const tone = getToneCausalClause(brief, 'midpoint')
  if (storyMaterial && hasConcreteFallbackMaterial(storyMaterial.decision, goal)) {
    const decision = getConcreteMaterialHandle(storyMaterial.decision, goal, brief)
    const decisionObject = getGoalObject(decision)
    switch (brief.dramaticForces[0]) {
      case 'misunderstanding':
        return `暂定：${subject}发现，对“${decision}”的不同理解会改变这项决定的后果；必须先选定自己相信的解释。`
      case 'cost':
        return `暂定：${subject}发现，“${decision}”要求拿一项眼前条件换取${goalPhrase}；旧办法无法两全。`
      case 'surprise':
        return `暂定：${subject}发现，“${decision}”把${goalPhrase}推向新的时机或资源条件；必须重排优先级。`
      case 'relationship-tension':
        return `暂定：${subject}发现，若绕开${commitment}，“${decision}”即使完成也会留下关系裂痕。`
      case 'contrast':
      default:
        return `暂定：${subject}发现，“${decisionObject}”让自己最熟悉的办法反而失去作用；要继续${goalPhrase}必须承认这一点。`
    }
  }
  switch (brief.dramaticForces[0]) {
    case 'misunderstanding':
      return `暂定：${subject}发现，围绕${anchor}继续猜测只会放大误解，必须决定要不要先承担澄清带来的风险；${tone}`
    case 'cost':
      return `暂定：${subject}发现，${anchor}要求放弃的条件正是自己想保住的部分，${goalPhrase}因此变成真正的取舍；${tone}`
    case 'surprise':
      return `暂定：${subject}发现，${anchor}带来的变化让原计划失效，必须重新判断还能依靠什么；${tone}`
    case 'relationship-tension':
      return `暂定：${subject}发现，若绕开${anchor}这项承诺，${goalPhrase}即使完成也会留下无法回避的关系裂痕；${tone}`
    case 'contrast':
    default:
      if (brief.tones.includes('mystery')) {
        return `暂定：${subject}发现，${progression}的不同解释会让${goalObject}导向不同结果；${subject}必须决定先保留哪条可能，而不是继续照旧${goalPhrase}。`
      }
      if (brief.tones.includes('growth')) {
        return `暂定：${subject}发现，真正要改变的不是${goalObject}，而是自己如何面对${progression}；旧办法已无法替${subject}作答。`
      }
      if (brief.tones.includes('comedy')) {
        return `暂定：${subject}发现，越想用熟悉办法维持体面，${progression}造成的尴尬越大；${subject}必须承认笑点背后有真实代价。`
      }
      return `暂定：${subject}发现，继续用最熟悉的办法处理${anchor}只能遮住问题，必须承认旧办法会失去什么；${tone}`
  }
}

function getFallbackClimaxChoice(subject: string, goal: string, brief: CreativeBrief, material: string, storyMaterial?: FallbackStoryMaterial): string {
  const hasMaterial = !isPlaceholderMaterial(material, goal)
  const anchor = hasMaterial ? getConcreteMaterialHandle(material, goal, brief) : getDirectionAnchor(brief, goal)
  const goalPhrase = getGoalPhrase(goal)
  const goalObject = getGoalObject(goal)
  const commitmentSource = storyMaterial?.commitment ?? material
  const hasCommitment = !isPlaceholderMaterial(commitmentSource, goal)
  const commitment = hasCommitment
    ? getConcreteMaterialHandle(commitmentSource, goal, brief)
    : getDirectionAnchor(brief, goal)
  const progression = getProgressionAnchor(material, storyMaterial, goal, brief, commitment)
  const tone = getToneCausalClause(brief, 'climax')
  if (storyMaterial && hasConcreteFallbackMaterial(storyMaterial.decision, goal)) {
    const decision = getConcreteMaterialHandle(storyMaterial.decision, goal, brief)
    const decisionObject = getGoalObject(decision)
    const otherSide = hasConcreteFallbackMaterial(storyMaterial.commitment, goal)
      ? getConcreteMaterialHandle(storyMaterial.commitment, goal, brief)
      : `继续${goalPhrase}`
    switch (brief.dramaticForces[0]) {
      case 'misunderstanding':
        return `暂定：${subject}必须在${decisionObject}与先澄清“${otherSide}”之间作出选择；选择会决定这项决定依据哪种理解继续。`
      case 'cost':
        return `暂定：${subject}必须在${decisionObject}与${otherSide}之间放弃一项条件；这项决定的代价不能再由别人承担。`
      case 'surprise':
        return `暂定：${subject}必须在${decisionObject}与${otherSide}之间重排先后；新条件会让其中一边失去原来的保障。`
      case 'relationship-tension':
        return `暂定：${subject}必须在${decisionObject}与回应${otherSide}之间作出选择；两边不能靠沉默同时保住。`
      case 'contrast':
      default:
        return `暂定：${subject}必须在${decisionObject}与${otherSide}之间作出选择；要继续${goalPhrase}，就得承认原来的办法已经失效。`
    }
  }
  switch (brief.dramaticForces[0]) {
    case 'misunderstanding':
      return `暂定：面对${anchor}，${subject}必须选择公开自己的判断并承担被误解的风险，还是保留${goalPhrase}却让信息缺口继续存在；${tone}`
    case 'cost':
      return `暂定：面对${anchor}，${subject}必须明确放弃一项眼下条件，才可能继续${goalPhrase}；${tone}`
    case 'surprise':
      return `暂定：面对${anchor}造成的新条件，${subject}必须主动舍弃原计划的一部分，换取继续${goalPhrase}的可能；${tone}`
    case 'relationship-tension':
      return `暂定：面对${anchor}，${subject}必须选择先兑现${commitment}，还是明确改变它来继续${goalPhrase}；${tone}`
    case 'contrast':
    default:
      if (brief.tones.includes('mystery')) {
        return `暂定：面对${progression}，${subject}必须选择先按已知信息作出${goalObject}的决定，还是保留疑问并承担延误；两边都不能由别人代替。`
      }
      if (brief.tones.includes('growth')) {
        if (!hasMaterial && !hasCommitment) {
          return `暂定：面对这次${goalPhrase}，${subject}必须选择照原安排继续，还是先说清自己真正要承担的决定；两种选择都会留下可辨认的代价。`
        }
        return `暂定：面对${progression}，${subject}必须选择兑现承诺而暂缓${goalObject}，还是明确改变承诺后继续${goalPhrase}；两边都要承担责任。`
      }
      if (brief.tones.includes('comedy')) {
        return `暂定：面对${progression}，${subject}必须选择继续维护体面，还是主动承认尴尬并推进${goalPhrase}；选择会留下不同的关系代价。`
      }
      return `暂定：面对${anchor}，${subject}必须放下最擅长也最省事的办法，以另一种方式继续${goalPhrase}；${tone}`
  }
}

function getFallbackResolution(subject: string, goal: string, brief: CreativeBrief, material: string, storyMaterial?: FallbackStoryMaterial): string {
  const hasMaterial = !isPlaceholderMaterial(material, goal)
  const anchor = hasMaterial ? getConcreteMaterialHandle(material, goal, brief) : getDirectionAnchor(brief, goal)
  const goalPhrase = getGoalPhrase(goal)
  const goalObject = getGoalObject(goal)
  const commitmentSource = storyMaterial?.commitment ?? material
  const hasCommitment = !isPlaceholderMaterial(commitmentSource, goal)
  const commitment = hasCommitment
    ? getConcreteMaterialHandle(commitmentSource, goal, brief)
    : getDirectionAnchor(brief, goal)
  const progression = getProgressionAnchor(material, storyMaterial, goal, brief, commitment)
  const toneChange = getResolutionToneChange(brief)
  if (storyMaterial && (hasConcreteFallbackMaterial(storyMaterial.decision, goal) || hasConcreteFallbackMaterial(storyMaterial.commitment, goal))) {
    const decision = hasConcreteFallbackMaterial(storyMaterial.decision, goal)
      ? getConcreteMaterialHandle(storyMaterial.decision, goal, brief)
      : getConcreteMaterialHandle(storyMaterial.commitment, goal, brief)
    const commitmentLabel = hasConcreteFallbackMaterial(storyMaterial.commitment, goal)
      ? getConcreteMaterialHandle(storyMaterial.commitment, goal, brief)
      : '这项承诺'
    const decisionObject = getGoalObject(decision)
    switch (brief.dramaticForces[0]) {
      case 'misunderstanding':
        return `暂定：${subject}如何解释“${decision}”并回应${commitmentLabel}，会决定这项选择最后留下的关系和信息缺口。`
      case 'cost':
        return `暂定：${subject}如何处理${decisionObject}并回应${commitmentLabel}，会决定为了${goalPhrase}放弃什么，并留下可见代价。`
      case 'surprise':
        return `暂定：${subject}如何处理${decisionObject}带来的新条件，会决定${goalPhrase}能否成立，以及旧计划被怎样改写。`
      case 'relationship-tension':
        return `暂定：${subject}如何处理${decisionObject}并回应${commitmentLabel}，会决定这项选择与这项承诺能否同时被诚实面对。`
      case 'contrast':
      default:
        return `暂定：${subject}处理${decisionObject}并回应${commitmentLabel}后，必须用一个可验证的改变替代旧办法；${subject}承认原来的局限。`
    }
  }
  switch (brief.dramaticForces[0]) {
    case 'misunderstanding':
      return `暂定：${subject}如何处理${anchor}，会决定${goalPhrase}最终保留的意义，并${toneChange}。`
    case 'cost':
      return `暂定：${subject}是否放下${anchor}，会决定${goalPhrase}得到什么结果，并${toneChange}。`
    case 'surprise':
      return `暂定：${subject}如何回应${anchor}带来的新条件，会决定${goalPhrase}出现什么结果，并${toneChange}。`
    case 'relationship-tension':
      return `暂定：${subject}如何兑现或重新解释${commitment}，会同时改变${goalObject}和相关关系的结果，并${toneChange}。`
    case 'contrast':
    default:
      if (brief.tones.includes('mystery')) {
        return `暂定：${subject}如何安置${progression}留下的信息缺口，会决定${goalObject}是否按原意完成，并${toneChange}。`
      }
      if (brief.tones.includes('growth')) {
        if (!hasMaterial && !hasCommitment) {
          return `暂定：${subject}如何为${goalPhrase}承担自己的决定，会决定这次选择之后保留什么；${toneChange}。`
        }
        return `暂定：${subject}如何处理${progression}，会决定${goalObject}能否继续，以及${subject}愿意为这项选择承担什么；${toneChange}。`
      }
      if (brief.tones.includes('comedy')) {
        return `暂定：${subject}是否承认${progression}带来的尴尬，会决定${goalPhrase}留下怎样的结果，并${toneChange}。`
      }
      return `暂定：${subject}是否改用新的办法处理${anchor}，会决定${goalPhrase}最后留下的结果，并${toneChange}。`
  }
}

function getToneCausalClause(brief: CreativeBrief, stage: 'tension' | 'trigger' | 'escalation' | 'midpoint' | 'climax'): string {
  const tone = brief.tones[0]
  switch (tone) {
    case 'friendship': return stage === 'climax' ? '先把信任说清，再决定要保住什么' : '信任会随着这次选择一起被检验'
    case 'romance': return stage === 'climax' ? '让心意和行动承担同一份风险' : '心意与行动的落差会放大这道阻碍'
    case 'mystery': return stage === 'midpoint' ? '信息缺口仍由作者决定是否揭开' : '信息缺口保持开放，不能直接变成事实'
    case 'comedy': return stage === 'climax' ? '尴尬会逼出一个比体面更诚实的选择' : '尴尬的后果会暴露旧办法的局限'
    case 'fantasy': return stage === 'midpoint' ? '规则的边界需要在下一步由作者确认' : '这条规则只作为待确认的提案'
    case 'warm': return '人物仍有机会先理解彼此再行动'
    case 'growth':
      switch (stage) {
        case 'tension': return '旧习惯与当前选择开始冲突'
        case 'trigger': return '这会检验主角是否愿意改变旧习惯'
        case 'escalation': return '继续回避会让旧习惯的代价变得可见'
        case 'midpoint': return '主角必须重新判断要改变的是办法还是目标'
        case 'climax': return '成长由主角愿意承担的取舍体现'
      }
    default: return '具体走向仍交给作者确认'
  }
}

function getResolutionToneChange(brief: CreativeBrief): string {
  if (brief.tones.includes('romance')) return '让心意与行动不再彼此回避'
  if (brief.tones.includes('friendship')) return '让关系中的信任被重新看见'
  if (brief.tones.includes('mystery')) return '让仍未解开的信息获得新的位置'
  if (brief.tones.includes('comedy')) return '让尴尬的代价成为人物关系的新理解'
  if (brief.tones.includes('fantasy')) return '让人物重新理解这件事背后的规则'
  if (brief.tones.includes('growth')) return '让主角重新定义自己愿意承担的承诺'
  return `让${getPrimaryToneLabel(brief)}落在一个可辨认的选择结果上`
}

function getGoalPhrase(goal: string): string {
  const normalized = goal
    .trim()
    .replace(/^当前(?:目标|想法)[：:]\s*/u, '')
    .replace(/^(?:想要|想|希望|打算|准备|计划)\s*/u, '')
  const decisionMatch = normalized.match(/(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (decisionMatch?.[1]) return compactGoalPhrase(decisionMatch[1].trim() || '作出选择')
  if (normalized.startsWith('是否')) return compactGoalPhrase(normalized.slice(2).trim() || '作出选择')
  return compactGoalPhrase(normalized || '作出选择')
}

function getGoalDecisionPhrase(goal: string): string {
  const normalized = goal
    .trim()
    .replace(/^当前(?:目标|想法)[：:]\s*/u, '')
    .replace(/^(?:想要|想|希望|打算|准备|计划)\s*/u, '')
  const decisionMatch = normalized.match(/(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (decisionMatch?.[1]) return `是否${compactGoalPhrase(decisionMatch[1].trim())}`
  if (normalized.startsWith('是否')) return compactGoalPhrase(normalized)
  return `是否${getGoalPhrase(goal)}`
}

function getWantGoal(goal: string): string {
  const phrase = getGoalPhrase(goal)
  return `想${phrase}`
}

function getGoalObject(goal: string): string {
  const phrase = getGoalPhrase(goal)
  const deliveryMatch = phrase.match(/^把(.+?)(?:送到|带到|交给|归还|提交|放回)(?:[^，。！？；\n]+)?$/u)
  if (deliveryMatch?.[1]) return deliveryMatch[1].trim()
  const decisionMatch = phrase.match(/^(?:是否|要不要)(?:删掉|删除|保留|拆掉|改掉|放弃)(.+)$/u)
  if (decisionMatch?.[1]) return decisionMatch[1].trim()
  return phrase.replace(/^把/u, '').trim() || '这项目标'
}

function compactGoalPhrase(value: string): string {
  let normalized = value
    .replace(/^在[^，。！？；\n]{1,24}前(?=(?:把|将|去|看|提交|参加|寻找|归还|离开|决定|选择))/u, '')
    .replace(/^于[^，。！？；\n]{1,24}(?=(?:把|将|去|看|提交|参加|寻找|归还|离开|决定|选择))/u, '')
    .trim()

  // Long goals often carry a deadline and a complete sentence. Keep the
  // action/object that later beats need, while the ledger retains the exact
  // source wording and deadline as separate facts.
  if (normalized.length > 32) {
    const action = normalized.match(/(?:把|将)?[^，。！？；\n]{0,24}(?:送到|带到|交给|归还|提交|放回|拆掉|删掉|删除|保留)[^，。！？；\n]{0,16}/u)
      ?? normalized.match(/(?:去|看|参加|寻找|离开|决定|选择)[^，。！？；\n]{0,24}/u)
    if (action?.[0]?.trim()) normalized = action[0].trim()
  }
  return normalized.length > 34 ? `${normalized.slice(0, 34)}…` : normalized
}

function getConcreteMaterialHandle(value: string, fallback: string, brief?: CreativeBrief): string {
  if (brief && isPlaceholderMaterial(value, fallback)) return getDirectionAnchor(brief, fallback)
  let cleaned = compactCausalMaterial(value, fallback)
    .replace(/^(?:却|但|并且|同时|然后|随后|让|迫使|需要|使|发现|如果|若)\s*/u, '')
    .trim()
  // Keep the author's concrete object while removing reporting verbs that make
  // every later card sound like it is repeating the source sentence.
  cleaned = cleaned
    .replace(/^(?:途中|随后|然后|当时)?(?:发现|看到|遇到|收到|拿到)\s*/u, '')
    .replace(/^(?:主角|她|他|其)\s*(?:发现|看到|遇到|收到|拿到)\s*/u, '')
    .trim()
  const sceneMatch = cleaned.match(/(?:在|于)(?:借来的)?(.+?)(?:里|中)看到(?:和)?(.+)$/u)
  if (sceneMatch?.[1] && sceneMatch[2]) {
    const sceneObject = `${sceneMatch[1]}里的${sceneMatch[2]}`
    return sceneObject.length > 34 ? `${sceneObject.slice(0, 34)}…` : sceneObject
  }
  const commitmentMatch = cleaned.match(/(?:答应|承诺|约定|保证)(.+)$/u)
  if (commitmentMatch?.[1]) {
    const commitment = `${commitmentMatch[1].replace(/[了过]/gu, '').trim()}的承诺`
    return commitment.length > 34 ? `${commitment.slice(0, 34)}…` : commitment
  }
  const boundaryMatch = cleaned.match(/(?:要求|禁止|不许)(.+)$/u)
  if (boundaryMatch?.[1]) {
    const boundary = `不${boundaryMatch[1].replace(/^不/u, '').trim()}`
    return boundary.length > 34 ? `${boundary.slice(0, 34)}…` : boundary
  }
  const decisionMatch = cleaned.match(/(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (decisionMatch?.[1]) return `是否${decisionMatch[1].trim()}`
  const intentionDecisionMatch = cleaned.match(/(?:想|希望|打算|准备|计划)(?:在[^，。！？；]{0,24})?(?:决定|选择|判断|确认)(?:要不要|是否)(.+)$/u)
  if (intentionDecisionMatch?.[1]) return `是否${intentionDecisionMatch[1].trim()}`
  const clauses = cleaned.split(/[，。！？；\n]/u).map((part) => part.trim()).filter(Boolean)
  const candidate = clauses.find((part) => (
    part.length >= 4
    && !/(?:想|决定|必须|会|可能|结果|代价|问题|选择|承诺|办法|原计划)/u.test(part)
  )) ?? clauses.find((part) => part.length >= 4) ?? cleaned
  const withoutSubjectLead = candidate.replace(/^[\u4e00-\u9fff]{2,4}(?=在|正|正在|想|要)/u, '').trim()
  const normalized = withoutSubjectLead || candidate
  return normalized.length > 34 ? `${normalized.slice(0, 34)}…` : normalized
}

function hasConcreteFallbackMaterial(value: string | undefined, goal: string): value is string {
  const normalized = value?.trim() ?? ''
  return Boolean(normalized) && !isPlaceholderMaterial(normalized, goal)
}

function getCommitmentEvidence(value: string, goal?: string, brief?: CreativeBrief): string {
  const normalized = value.trim().replace(/^暂定[：:]/u, '')
  if (goal && brief && isPlaceholderMaterial(normalized, goal)) {
    return getDirectionAnchor(brief, goal)
  }
  if (/^(?:自己决定是否|是否)/u.test(normalized)) return `${normalized}这项决定`
  if (/(?:答应|承诺|约定|保证)/u.test(normalized)) return normalized
  if (/(?:要求|禁止|不许|不再|不要)/u.test(normalized)) return normalized
  return `${normalized}的承诺`
}

/**
 * Preserve a genuinely new author consequence while keeping ordinary fallback
 * beats tied to their assigned source material. This is what prevents a later
 * node from silently falling back to a generic "原本的安排方式" after an
 * author edits an upstream node.
 */
function getProgressionAnchor(
  material: string,
  storyMaterial: FallbackStoryMaterial | undefined,
  goal: string,
  brief: CreativeBrief,
  fallback: string,
): string {
  const candidate = isPlaceholderMaterial(material, goal)
    ? ''
    : getConcreteMaterialHandle(material, goal, brief)
  if (!storyMaterial) return candidate || fallback
  const known = [
    storyMaterial.current,
    storyMaterial.observed,
    storyMaterial.deadline,
    storyMaterial.commitment,
    storyMaterial.decision,
  ].map((value) => getConcreteMaterialHandle(value, goal, brief))
  if (candidate && !known.includes(candidate) && !isPlaceholderMaterial(material, goal)) return candidate
  if (!isPlaceholderMaterial(fallback, goal)) return getConcreteMaterialHandle(fallback, goal, brief)
  return getDirectionAnchor(brief, goal)
}

function isPlaceholderMaterial(value: string, goal: string): boolean {
  const normalized = value.trim()
  const normalizedGoal = goal.trim()
  const goalPhrase = getGoalPhrase(goal)
  return !normalized
    || normalized === '当前处境'
    || normalized === '当前可用的条件'
    || normalized === '眼前的时机'
    || normalized === '自己必须作决定的习惯'
    || normalized === '尚未明确的取舍'
    || normalized === `${goal}的原计划`
    // A bare goal is useful as the preserved objective, but it is not a
    // separate obstacle, promise or deadline. Treating it as material made a
    // sparse idea fabricate a promise around the same words.
    || normalized === normalizedGoal
    || normalized === goalPhrase
}

function getDirectionAnchor(brief: CreativeBrief, goal: string): string {
  const goalPhrase = getGoalPhrase(goal)
  if (goalPhrase && /^(?:继续|去|看|参加|寻找|归还|离开)/u.test(goalPhrase)) {
    if (brief.tones.includes('growth')) return `是否由主角自己决定${goalPhrase}`
    if (brief.tones.includes('comedy')) return `想维持体面却会暴露${goalPhrase}局限的办法`
    if (brief.tones.includes('mystery')) return `关于${goalPhrase}的关键信息`
  }
  if (brief.dramaticForces.includes('misunderstanding')) return `与${goalPhrase}有关的理解落差`
  if (brief.dramaticForces.includes('cost')) return `继续${goalPhrase}会占用的一项现实条件`
  if (brief.dramaticForces.includes('surprise')) return `改变${goalPhrase}时机的意外条件`
  if (brief.dramaticForces.includes('relationship-tension')) return `同行者对${goalPhrase}的期待落差`
  if (brief.tones.includes('mystery')) return `尚未确认、却影响${goalPhrase}的信息缺口`
  if (brief.tones.includes('comedy')) return `会暴露${goalPhrase}局限的一次临场尴尬`
  if (brief.tones.includes('friendship')) return `主角与同行者对${goalPhrase}的不同期待`
  if (brief.tones.includes('growth')) return `围绕${goalPhrase}的原本安排`
  return `主角原本最依赖的${goalPhrase}安排方式`
}

function stripLeadingLocationMarker(value: string): string {
  return value.replace(/^(?:在|于)/u, '')
}

function shortenCurveContext(value: string): string {
  return compactCausalMaterial(value, '此前的作者决定')
}

function extractCausalConsequence(value: string): string {
  // System proposals usually quote the material they build on. Removing that
  // quoted premise before selecting a clause keeps the next node focused on
  // the consequence, instead of recursively embedding the whole prior node.
  return compactCausalMaterial(value, '上一步暴露的后果')
}

function getCausalAnchor(curve: ProvisionalCurve, target: CurveBeat, fallback: string): string {
  const visited = new Set<string>()
  const queue = [...target.dependsOn]
  let nearest: CurveBeat | undefined
  while (queue.length && !nearest) {
    const dependencyId = queue.shift()!
    if (visited.has(dependencyId)) continue
    visited.add(dependencyId)
    const candidate = curve.beats.find((beat) => beat.id === dependencyId)
    if (!candidate || candidate.status === 'rejected') continue
    nearest = candidate
    if (candidate.source !== 'user-edit') queue.push(...candidate.dependsOn)
  }
  if (!nearest) return compactCausalMaterial(fallback, fallback)
  if (nearest.causalAnchor?.trim()) return nearest.source === 'user-edit'
    ? compactAuthorMaterial(nearest.causalAnchor)
    : compactCausalMaterial(nearest.causalAnchor, fallback)
  if (nearest.source === 'user-edit') return compactAuthorMaterial(nearest.detail)
  return compactGeneratedConsequence(nearest.detail, fallback)
}

/** Reduce a source fact or author instruction to one quote-free causal handle. */
function compactCausalMaterial(value: string, fallback: string): string {
  const cleaned = value
    .replace(/^暂定[：:]/u, '')
    .replace(/(?:作者(?:第一次)?(?:明确)?编辑|作者指令|作者调整)[：:]?/u, '')
    .replace(/“[^”]*”/gu, '')
    .replace(/"[^"]*"/gu, '')
    .replace(/[“”"']/gu, '')
    .replace(/\s+/gu, ' ')
    // Do not strip the leading "是" from the decision marker "是否".
    .replace(/^(?:是(?!否)|却想|却|但|并且|然后|随后|让|因为|由于)\s*/u, '')
    .trim()
  const clauses = cleaned
    .split(/[，。！？；\n]/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 4)
  const candidate = clauses.find((clause) => (
    !/^(?:面对|围绕|关于|由于|因此|继续|如果|若|让|并且)$/u.test(clause)
    && !/(?:发现|意识到|知道)$/u.test(clause)
  )) ?? clauses[0] ?? cleaned
  const normalized = candidate.trim()
  if (!normalized) return fallback.trim() || '此前的作者决定'
  return normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized
}

function compactAuthorMaterial(value: string): string {
  const cleaned = value
    .replace(/^暂定[：:]/u, '')
    .replace(/^(?:作者(?:第一次)?(?:明确)?编辑|作者指令|作者调整)[：:]?/u, '')
    .replace(/[“”"']/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  const clauses = cleaned.split(/[，。！？；\n]/u).map((part) => part.trim()).filter((part) => part.length >= 4)
  // Keep an author's action and its stated purpose together. Splitting on
  // punctuation and joining with a semicolon made the downstream proposal
  // sound like two unrelated facts (and often dropped the purpose entirely).
  const purposeIndex = clauses.findIndex((part, index) => index > 0 && /^(?:是)?(?:想|希望|为了|打算|准备|决定|选择|证明|要)/u.test(part))
  if (purposeIndex > 0) {
    const action = clauses.slice(0, purposeIndex).join('，')
    const purpose = compactAuthorPurpose(clauses.slice(purposeIndex).join('，'))
    return shortenAuthorAnchor(`${action}，${purpose}`)
  }
  const decisionClauses = clauses.filter((part) => /(?:回应|处理|兑现|改变|保留|放弃|承担|证明|坚持|决定|想|希望|打算|承诺|必须|愿意|不愿|独自|自己)/u.test(part))
  if (decisionClauses.length >= 2) {
    return shortenAuthorAnchor(`${decisionClauses[0]}，${decisionClauses.at(-1)}`)
  }
  const objectMatch = cleaned.match(/(?:回应|处理|兑现|改变|保留|放弃|承担|证明|坚持)(?:了|着|这|该)?([^，。；]+)$/u)
  const object = objectMatch?.[1]
    ?.replace(/^(?:先|再|继续|是否|要不要|自己的|当前的|也是在|就是)/u, '')
    .trim()
  if (object && object.length >= 4) return shortenAuthorAnchor(object)

  // Prefer the clause that names the author's new decision or consequence.
  // Taking the last matching clause preserves the useful object in inputs such
  // as “不只是想玩，也是为了证明自己能独自做决定”。
  const candidate = [...clauses].reverse().find((part) => /(?:想|希望|打算|决定|承诺|证明|必须|愿意|不愿|独自|自己)/u.test(part))
    ?? clauses.at(-1)
    ?? cleaned
  return shortenAuthorAnchor(candidate)
}

function compactAuthorPurpose(value: string): string {
  let normalized = value
    .replace(/^(?:是)?(?:想|希望|为了|打算|准备|决定|选择)s*/u, '')
    .replace(/^证明(?:自己)?(?:已经|能够|能)?s*/u, '')
    .replace(/^让(?:自己)?(?:能够|能)?s*/u, '')
    .trim()
  const decision = normalized.match(/(?:独自|自己|亲自)?(?:作|做|承担|决定|选择|回应|处理|保留|放弃).+$/u)
  if (decision?.[0]) normalized = decision[0].trim()
  return normalized || value.trim()
}

function shortenAuthorAnchor(value: string): string {
  const normalized = value
    .replace(/^(?:也是在|就是|而是|让|需要|先|再)\s*/u, '')
    .trim()
  return normalized.length > 54 ? `${normalized.slice(0, 54)}…` : normalized
}

function compactGeneratedConsequence(value: string, fallback: string): string {
  const cleaned = value
    .replace(/^暂定[：:]/u, '')
    .replace(/“[^”]*”/gu, '')
    .replace(/"[^"]*"/gu, '')
    .replace(/[“”"']/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  const clauses = cleaned.split(/[，。！？；\n]/u).map((part) => part.trim()).filter((part) => part.length >= 4)
  const candidate = [...clauses].reverse().find((part) => /(?:必须|因此|结果|只能|会|改变|承担|决定|代价|阻碍|失去|无法)/u.test(part))
    ?? clauses.at(-1)
    ?? fallback
  return compactAuthorMaterial(candidate) || compactCausalMaterial(candidate, fallback)
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

function getStorySubject(seed: StorySeed): string {
  return seed.subject.trim() || '主角'
}

function getStoryGoal(seed: StorySeed, fallback: string): string {
  return seed.lockedGoal?.trim() || `围绕“${getShortIdeaLabel(fallback)}”作出决定`
}

function getConfirmedCurveGoal(seed: StorySeed, currentState: CurveBeat): string {
  return currentState.source === 'user-edit'
    ? currentState.detail.trim()
    : getStoryGoal(seed, currentState.detail)
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

function getFallbackCurrentStateDetail(
  seed: StorySeed,
  fallback: string,
  sourceFacts: readonly StorySourceFact[] = [],
): string {
  const currentState = getCurrentState(seed, fallback)
  const lockedGoal = seed.lockedGoal?.trim()
  if (!lockedGoal) return currentState
  const isRichSource = sourceFacts.length >= 3 || currentState.length > 48
  if (!isRichSource && currentState.length <= 72) return currentState
  const conciseMaterial = sourceFacts.length
    ? sourceFacts.slice(0, 2).map((fact) => fact.text.trim()).filter(Boolean).join('；')
    : currentState
  return conciseMaterial && conciseMaterial !== currentState
    ? `${conciseMaterial}；当前要决定：${lockedGoal}`
    : `${currentState}（当前目标：${lockedGoal}）`
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

function isModelDisabled(): boolean {
  return /^(?:1|true|yes)$/iu.test(process.env.STORY_DISABLE_MODEL?.trim() ?? '')
}

const curveGenerationSystemPrompt = `你是故事共创编辑。你的职责是把用户的模糊想法整理成一条可讨论、可编辑的暂定故事曲线，而不是写小说或代替用户决定主线。

只输出 JSON 对象，不要 Markdown。必须给出 5 至 7 个 beats。每个 beat 只能是一个结构假设，不写连续场景、对白、角色回合、既定结果或固定路径事实。必含 kind：current-state、trigger、escalation、climax-choice、resolution；可选 character-tension 与 midpoint-turn。每个 detail 最多 110 个汉字。除 current-state 外，每个 detail 必须以“暂定：”开头。

所有不是用户原文的内容都是系统提案：可以提出人物弱点、钩子、阻碍、代价与结局方向，但不要把它们写成已发生事实。若 allowSystemNamedCharacters 为 false，绝不新增任何具名人物，使用“陌生人”“同行者”等匿名指代。不要默认写成悬疑，除非 brief 明确选择 mystery。

输出：{"title":"简短标题","beats":[{"kind":"current-state","title":"节点标题","detail":"节点内容","dependsOn":[],"sourceFactIds":["source-fact-1"],"causalAnchor":"一句短因果承接"}],"foundation":{"conflictCore":{"goal":"保留的目标","obstacle":"具体阻碍如何卡住目标","tradeoff":"主角必须承担的取舍"},"preservedGoal":"保留的目标","predicament":{"title":"具体困境标题","variationAxis":"time|resource|relationship|commitment","immediateSituation":"当前处境","obstacle":"当前阻碍","tradeoff":"取舍","urgency":"为什么现在要处理","choice":"主角要作的选择","plausibleCost":"选择的代价"},"middleDevelopment":{"escalation":"阻碍如何升级","midpoint":"中段如何改变原办法","climaxPressure":"高潮压力"},"storyEnds":{"opening":"故事开端","openingClue":"开端钩子","climax":"高潮选择","resolution":"结局变化","cost":"承担的代价","promise":"故事承诺"},"approach":{"intent":"第一步设计方向","cost":"第一步代价"}}}`

const curveBeatRegenerationSystemPrompt = `你是故事共创编辑。只重写一条暂定故事曲线节点，不写连续剧情。返回 JSON：{"detail":"暂定：一句可编辑的系统提案"}。detail 必须以“暂定：”开头，不得把提案写成既定事实、行动结果或长场景；未允许新增具名人物时不得新增名字。只提取上游节点的核心后果，用新的短语推进下一层；不要复制上游整句，不要出现嵌套引号。`

function buildCurveGenerationPrompt(
  idea: string,
  seed: StorySeed,
  brief: CreativeBrief,
  design: StoryDesignRecord,
  excludedProposalDetails: readonly string[] = [],
): string {
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
  return `用户原始想法：${idea}\n原始信息：${JSON.stringify({ subject: seed.subject, lockedGoal: seed.lockedGoal, lockedFacts: seed.lockedFacts })}\n不可丢失的原始材料：${JSON.stringify(curve.design?.sourceFacts.filter((fact) => fact.disposition !== 'parked').map((fact) => ({ id: fact.id, text: fact.text })) ?? [])}\n创意方向：${JSON.stringify(curve.brief)}\n戏剧机制：${getDramaticMechanism(curve.brief)}\n当前有效曲线：${JSON.stringify(activeBeats)}\n目标节点的上游依据：${JSON.stringify(upstream)}\n已拒绝、不可重用的系统提案：${JSON.stringify([...rejectedProposals, ...rejectedHistory])}\n\n只重写目标节点：${JSON.stringify({ id: target.id, kind: target.kind, title: target.title, detail: target.detail })}${feedback ? `\n作者说明：${feedback}` : ''}\n重写必须具体承接上游依据或作者说明；只保留核心后果并推进新的因果，不得复制上游整句或使用嵌套引号；不得重新使用已拒绝内容，也不得用“更重要的事”“承担代价”等无对象的泛化句代替因果。`
}
