import { randomUUID } from 'node:crypto'
import { clarificationReviewSchema } from './storyOutputSchemas.js'
import type {
  CurveBeat,
  ProvisionalCurve,
  StoryAuthorClarification,
  StoryAuthorClarificationRequest,
  StorySourceFact,
} from '../../shared/story-contract.js'
import { AppError, requestQwenJson } from './qwen.js'
import { updateStoryDesignCoverage } from './storyDesign.js'

function getDependentBeatIds(beats: readonly CurveBeat[], beatId: string): string[] {
  const dependentIds = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const beat of beats) {
      if (beat.id === beatId || dependentIds.has(beat.id)) continue
      if (beat.dependsOn.includes(beatId) || beat.dependsOn.some((id) => dependentIds.has(id))) {
        dependentIds.add(beat.id)
        changed = true
      }
    }
  }
  return beats.filter((beat) => dependentIds.has(beat.id)).map((beat) => beat.id)
}

function rejectSystemBeat(curve: ProvisionalCurve, beatId: string): { curve: ProvisionalCurve; affectedBeatIds: string[] } {
  const target = curve.beats.find((beat) => beat.id === beatId)
  if (!target || target.source !== 'system-proposal') {
    throw new AppError('只有系统提案可以被放弃，作者编辑节点必须由作者修改。', 409, 'STORY_CLARIFICATION_AUTHOR_EDIT')
  }
  const affectedBeatIds = getDependentBeatIds(curve.beats, beatId)
  const affected = new Set(affectedBeatIds)
  return {
    curve: {
      ...curve,
      beats: curve.beats.map((beat) => beat.id === beatId
        ? { ...beat, status: 'rejected' as const }
        : affected.has(beat.id) && beat.source !== 'user-input' && beat.status !== 'rejected'
          ? { ...beat, status: 'stale' as const }
          : beat),
      rejectedProposals: [...(curve.rejectedProposals ?? []), { ...target, status: 'rejected' as const }],
      updatedAt: Date.now(),
    },
    affectedBeatIds: [beatId, ...affectedBeatIds],
  }
}

function requireClarification(curve: ProvisionalCurve, id: string | undefined): StoryAuthorClarification {
  const clarification = curve.clarifications?.find((item) => item.id === id)
  if (!clarification) throw new AppError('要处理的因果问题不存在，请刷新后重试。', 409, 'STORY_CLARIFICATION_NOT_FOUND')
  return clarification
}

export function getUnresolvedClarifications(curve: ProvisionalCurve): StoryAuthorClarification[] {
  return (curve.clarifications ?? []).filter((item) => !item.resolution
    && ((curve.reasoning && item.dependency.beatIds.length === 0) || item.dependency.beatIds.some((id) => [id, ...getDependentBeatIds(curve.beats, id)]
      .some((beatId) => curve.beats.some((beat) => beat.id === beatId && beat.status !== 'rejected'))))
    )
}

export function getClarificationsAffectingBeat(curve: ProvisionalCurve, beatId: string): StoryAuthorClarification[] {
  return getClarificationsForBeat(curve, beatId).filter((item) => !item.resolution)
}

/** Unknown premises stay excluded even after an independent proposal is accepted. */
export function getClarificationsForBeat(curve: ProvisionalCurve, beatId: string): StoryAuthorClarification[] {
  return (curve.clarifications ?? []).filter((item) =>
    item.dependency.beatIds.includes(beatId)
    || item.dependency.beatIds.some((id) => getDependentBeatIds(curve.beats, id).includes(beatId)))
}

function invalidateDraft(curve: ProvisionalCurve, beatIds: readonly string[]): ProvisionalCurve {
  const affected = new Set(beatIds)
  return {
    ...curve,
    beats: curve.beats.map((beat) => affected.has(beat.id) && beat.status !== 'rejected' && beat.source !== 'user-input'
      ? { ...beat, status: 'stale' as const }
      : beat),
    foundation: undefined,
    ...(curve.design ? { design: { ...curve.design, foundation: undefined } } : {}),
    updatedAt: Date.now(),
  }
}

export function changeCurveClarification(
  curve: ProvisionalCurve,
  request: StoryAuthorClarificationRequest,
): { curve: ProvisionalCurve; affectedBeatIds: string[] } {
  if (curve.status !== 'draft') throw new AppError('请先创建一个新的主线草案。', 409, 'STORY_CURVE_NOT_DRAFT')
  const now = Date.now()
  if (request.action === 'create') {
    const target = curve.beats.find((beat) => beat.id === request.targetBeatId && beat.status !== 'rejected')
    if (!target || target.source === 'user-input') {
      throw new AppError('请选择需要审阅的系统或作者编辑节点。', 400, 'STORY_CLARIFICATION_INVALID_TARGET')
    }
    const causalGap = request.causalGap?.trim() ?? ''
    const prompt = request.prompt?.trim() ?? ''
    if (!causalGap || !target.detail.includes(causalGap) || !prompt) {
      throw new AppError('因果缺口必须是该节点中的原句，且需要提出明确问题。', 400, 'STORY_CLARIFICATION_INVALID_GAP')
    }
    const affectedBeatIds = [target.id, ...getDependentBeatIds(curve.beats, target.id)]
    const clarification: StoryAuthorClarification = {
      id: `clarification-${randomUUID()}`,
      prompt,
      status: 'unanswered',
      dependency: {
        beatIds: [target.id],
        causalGap,
        requiredFor: ['review-beat', 'confirm-curve'],
      },
      source: 'author-review',
      createdAt: now,
      updatedAt: now,
    }
    return {
      curve: invalidateDraft({ ...curve, clarifications: [...(curve.clarifications ?? []), clarification] }, affectedBeatIds),
      affectedBeatIds,
    }
  }

  const current = requireClarification(curve, request.clarificationId)
  if (current.resolution || current.status === 'confirmed') {
    throw new AppError('已确认或已解决的问题不能原地改写，请另建主线版本。', 409, 'STORY_CLARIFICATION_IMMUTABLE')
  }
  const target = curve.beats.find((beat) => beat.id === current.dependency.beatIds[0])
  if (!target && !current.reasoningUnknownId) throw new AppError('相关节点已不存在，请刷新。', 409, 'STORY_CLARIFICATION_INVALID_TARGET')
  let next: StoryAuthorClarification
  switch (request.action) {
    case 'save-answer': {
      const answer = request.answerText ?? ''
      if (!answer.trim() || answer.length > 240) throw new AppError('请填写不超过 240 字的作者回答。', 400, 'STORY_CLARIFICATION_INVALID_ANSWER')
      next = { ...current, status: 'needs-review', answerText: answer, unknownHandling: undefined, updatedAt: now }
      break
    }
    case 'declare-unknown':
    case 'keep-unknown':
    case 'request-independent-proposal': {
      if (request.action !== 'declare-unknown' && current.status !== 'author-unknown') {
        throw new AppError('请先明确这项设定目前未确定。', 409, 'STORY_CLARIFICATION_NOT_UNKNOWN')
      }
      next = {
        ...current,
        status: 'author-unknown',
        answerText: request.action === 'declare-unknown' ? request.answerText || '未确定' : current.answerText,
        unknownHandling: request.action === 'request-independent-proposal'
          ? 'request-independent-proposal'
          : 'keep-unknown',
        updatedAt: now,
      }
      break
    }
    case 'abandon-dependent-proposal': {
      if (!target && current.reasoningUnknownId) return {
        curve: { ...curve, clarifications: curve.clarifications?.map(c => c.id === current.id ? { ...c, resolution: 'proposal-abandoned' as const, unknownHandling: 'abandon-dependent-proposal' as const, updatedAt: now } : c) }, affectedBeatIds: [],
      }
      if (target!.source !== 'system-proposal') {
        throw new AppError('作者编辑的节点只能由作者修改，系统不能删除或覆盖。', 409, 'STORY_CLARIFICATION_AUTHOR_EDIT')
      }
      const rejected = rejectSystemBeat(curve, target!.id)
      return {
        curve: {
          ...rejected.curve,
          clarifications: curve.clarifications?.map((item) => !item.resolution
            && item.dependency.beatIds.every((id) => id === target!.id)
            ? { ...item,
                ...(item.id === current.id ? { status: 'author-unknown' as const } : {}),
                unknownHandling: 'abandon-dependent-proposal' as const,
                resolution: 'proposal-abandoned' as const, updatedAt: now }
            : item),
        },
        affectedBeatIds: rejected.affectedBeatIds,
      }
    }
    case 'confirm-answer':
      throw new AppError('请先保存回答，确认必须独立提交。', 409, 'STORY_CLARIFICATION_NOT_REVIEWED')
    default:
      throw new AppError('不支持的作者补充操作。', 400, 'INVALID_REQUEST')
  }
  return {
    curve: { ...curve, clarifications: curve.clarifications?.map((item) => item.id === current.id ? next : item), updatedAt: now },
    affectedBeatIds: [],
  }
}

export function confirmCurveClarification(
  curve: ProvisionalCurve,
  clarificationId: string | undefined,
): { curve: ProvisionalCurve; affectedBeatIds: string[] } {
  const current = requireClarification(curve, clarificationId)
  if (curve.status !== 'draft' || current.status !== 'needs-review' || !current.answerText?.trim() || current.resolution) {
    throw new AppError('这条回答尚未经过作者审阅或已被确认。', 409, 'STORY_CLARIFICATION_NOT_REVIEWED')
  }
  if (!curve.design) throw new AppError('事实账本不存在，请先恢复草案。', 409, 'STORY_DESIGN_INCOMPLETE')
  const now = Date.now()
  const sourceFactId = `source-fact-${randomUUID()}`
  const fact: StorySourceFact = {
    id: sourceFactId,
    text: current.answerText,
    source: 'author-supplement',
    clarificationId: current.id,
    disposition: 'needs-author-decision',
    coveredByBeatIds: [],
  }
  const affectedBeatIds = [...new Set(current.dependency.beatIds.flatMap((id) =>
    [id, ...getDependentBeatIds(curve.beats, id)]))]
  return {
    curve: invalidateDraft({
      ...curve,
      clarifications: curve.clarifications?.map((item) => item.id === current.id
        ? { ...item, status: 'confirmed' as const, sourceFactId, confirmedAt: now, updatedAt: now }
        : item),
      design: { ...curve.design, sourceFacts: [...curve.design.sourceFacts, fact] },
    }, affectedBeatIds),
    affectedBeatIds,
  }
}

function normalizePremise(text: string): string {
  return text.replace(/[\s，。！？；“”"']/gu, '')
}

/** An explicitly questioned premise must not be relabelled as confirmed context. */
export function getClarificationGroundingFacts(curve: ProvisionalCurve): StorySourceFact[] {
  const unknownGaps = (curve.clarifications ?? [])
    .filter((item) => item.status !== 'confirmed')
    .map((item) => normalizePremise(item.dependency.causalGap))
  return (curve.design?.sourceFacts ?? []).filter((fact) => fact.disposition !== 'parked'
    && !unknownGaps.some((gap) => normalizePremise(fact.text).includes(gap)))
}

/** A reviewer is required for causal equivalence; substring checks alone miss paraphrases. */
export async function reviewClarificationReplacement(
  curve: ProvisionalCurve,
  clarification: StoryAuthorClarification,
  candidate: CurveBeat,
): Promise<void> {
  const groundingFacts = getClarificationGroundingFacts(curve)
  const confirmedFacts = groundingFacts.map((fact) => fact.text)
  const answer = clarification.status === 'confirmed' ? clarification.answerText : undefined
  const normalized = normalizePremise
  const candidateText = `${candidate.detail} ${candidate.causalAnchor ?? ''}`
  if (!answer && normalized(candidateText).includes(normalized(clarification.dependency.causalGap))) {
    throw new AppError('替代提案仍在复用作者明确未确定的因果前提。', 502, 'STORY_CLARIFICATION_REPLACEMENT_UNGROUNDED')
  }
  const groundingIds = new Set(groundingFacts.map((fact) => fact.id))
  const unresolvedFactIds = new Set((curve.design?.sourceFacts ?? [])
    .filter((fact) => !groundingIds.has(fact.id))
    .map((fact) => fact.id))
  if (unresolvedFactIds.size && (candidate.sourceFactIds ?? []).some((id) => unresolvedFactIds.has(id))) {
    throw new AppError('替代提案仍声明依赖未确认的原始材料。', 502, 'STORY_CLARIFICATION_REPLACEMENT_UNGROUNDED')
  }
  // A local fixture cannot prove semantic independence. Accept only a verbatim
  // known fact; arbitrary paraphrases must wait for a configured reviewer.
  if (/^(?:1|true|yes)$/iu.test(process.env.STORY_DISABLE_MODEL?.trim() ?? '')) {
    const candidateFact = normalized(candidate.detail.replace(/^暂定[：:]/u, ''))
    if (confirmedFacts.some((fact) => normalized(fact) === candidateFact)
      && (!candidate.causalAnchor || confirmedFacts.some((fact) => normalized(fact) === normalized(candidate.causalAnchor!)))) return
    throw new AppError('禁模合同模式无法审核这项因果提案，请保留待审状态。', 503, 'STORY_CLARIFICATION_REVIEW_UNAVAILABLE')
  }
  const review = await requestQwenJson({
    systemPrompt: '你是故事事实审核员。严格返回 JSON 对象 {"grounded": boolean, "dependsOnUnconfirmedPremise": boolean}。仅据已确认作者事实判断候选是否把未经确认的因果前提当作已成立；同义改写也算依赖。信息未定只能是待查状态，不得变成已成立的动作条件或具体代价。无法判断时 grounded=false。',
    userPrompt: JSON.stringify({ confirmedFacts, question: clarification.prompt,
      questionedPremise: clarification.dependency.causalGap,
      authorAnswer: answer ?? null, candidate: candidateText }),
    temperature: 0,
    maxTokens: 120,
    diagnosticStage: 'curve-clarification-replacement-review',
    outputSchema: clarificationReviewSchema,
  })
  if (!review || typeof review !== 'object' || Array.isArray(review)
    || Object.keys(review).some((key) => !['grounded', 'dependsOnUnconfirmedPremise'].includes(key))
    || (review as Record<string, unknown>).grounded !== true
    || (review as Record<string, unknown>).dependsOnUnconfirmedPremise !== false) {
    throw new AppError('替代提案未通过未确认前提的事实审核，请修改或重试。', 502, 'STORY_CLARIFICATION_REPLACEMENT_UNGROUNDED')
  }
}

export function markClarificationsResolved(curve: ProvisionalCurve, acceptedBeatIds: readonly string[]): ProvisionalCurve {
  const accepted = new Set(acceptedBeatIds)
  const clarifications = curve.clarifications?.map((item) =>
    !item.resolution && item.dependency.beatIds.every((id) => accepted.has(id))
      && (item.status === 'confirmed' || item.unknownHandling === 'request-independent-proposal')
       ? { ...item, resolution: item.status === 'confirmed' ? 'answer-applied' as const : 'independent-proposal-accepted' as const, updatedAt: Date.now() }
      : item)
  const design = curve.design ? updateStoryDesignCoverage(curve.design, curve.beats) : undefined
  return { ...curve, ...(clarifications ? { clarifications } : {}), ...(design ? { design } : {}) }
}
