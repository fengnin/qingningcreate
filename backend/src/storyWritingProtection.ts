import { createHash } from 'node:crypto'
import { AppError, requestQwenJson } from './qwen.js'
import { shape as s } from './modelOutputSchema.js'
import { selectStoryEvidence } from './storyEvidence.js'
import { activePreparationMaterial, preparationAuthorRequirements, authorRequirementsGuidance } from './storyPreparationContext.js'
import { selectedExpansionNeeds, storyExpansionGuidance } from './storyBridgeReview.js'
import { storyWritingConsistencyReviewSchema, storyWritingMainlineReviewSchema } from './storyOutputSchemas.js'
import { serializeWritingInput, writingInputEncodingGuidance } from './storyWritingInput.js'
import type { ConfirmedCurve, StoryWritingDraft } from '../../shared/story-contract.js'

type Entry = { id: string; sourceId: string; scope: 'author' | 'unknown' | 'future-design' | 'prose' | 'previous' | 'text'; quote: string; start: number; end: number }
type Snapshot = NonNullable<StoryWritingDraft['continuity']>['snapshots'][number]
const kinds = ['future-event', 'repeated-event', 'author-conflict', 'causal-break'] as const
type Issue = { kind: typeof kinds[number]; textEvidenceId: string; referenceEvidenceId: string; reason: string }
type WritingRepair = { kind: Issue['kind']; evidence: Entry[]; instruction: string }
const factKinds = ['event', 'condition', 'location', 'possession', 'time', 'relationship', 'unknown'] as const
const statuses = ['established', 'not-established', 'open'] as const
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invalid = (): never => { throw new AppError('正文审阅证据无效，尚未通过审阅，请重试。已采用正文仍保留。', 502, 'STORY_WRITING_INVALID_EVIDENCE') }

/** Sentence spans are copied by the program, never retyped by the reviewer. */
function excerpts(sourceId: string, scope: Entry['scope'], text: string): Entry[] {
  return [...text.matchAll(/[^。！？\n]+[。！？]?[”’」』"']*|[^\n]+/gu)].filter(match => match[0].trim())
    .map((match, i) => ({ id: `${sourceId}:${i}`, sourceId, scope, quote: match[0], start: match.index!, end: match.index! + match[0].length }))
}

// Keep confirmation evidence near the original selection and within its source/category.
function evidenceWindow(catalog: Entry[], anchor: Entry): Entry[] {
  const source = catalog.filter(entry => entry.sourceId === anchor.sourceId && entry.scope === anchor.scope)
  const index = source.findIndex(entry => entry.id === anchor.id)
  return source.slice(Math.max(0, index - 4), index + 5)
}

function resolveConfirmationEvidence(ids: unknown, candidates: Entry[], anchor: Entry): Entry[] {
  const selected = selectStoryEvidence(ids, candidates, () => true, 1, 5, invalid)
  const indices = selected.map(entry => candidates.indexOf(entry))
  if (!selected.some(entry => entry.id === anchor.id)
    || indices.some((index, i) => i > 0 && index <= indices[i - 1]!)) invalid()
  return selected
}

export function writingAuthority(idea: string, curve: ConfirmedCurve) {
  const p = curve.preparation
  const parked = new Set(curve.design?.sourceFacts.filter(f => f.disposition === 'parked').map(f => f.id) ?? [])
  const material = p ? activePreparationMaterial(p).filter(m => !parked.has(m.id)) : []
  const superseded = new Set(p?.authorReview?.supersededMaterialIds ?? [])
  const revisedSources = new Set(p?.material.filter(m => superseded.has(m.id) || parked.has(m.id)).map(m => m.sourceId))
  // A retired source must not re-enter through idea, sourceFacts or another copy.
  const sourceContext = p?.sources.length ? p.sources.map(source => ({ id: source.id,
    text: revisedSources.has(source.id) ? material.filter(m => m.sourceId === source.id).map(m => m.quote).join('\n') : source.text,
  })) : parked.size || superseded.size ? [] : [{ id: 'original-idea', text: idea }]
  const authorMaterial = p ? material.filter(m => m.role !== 'unknown').map(m => ({ id: m.id, text: m.quote }))
    : (curve.design?.sourceFacts.filter(f => f.disposition !== 'parked') ?? [])
  const explicitUnknowns = material.filter(m => m.role === 'unknown')
  const evidence = [
    ...sourceContext.flatMap((source, i) => excerpts(`author-source-${i}`, 'author', source.text)),
    ...authorMaterial.flatMap((source, i) => excerpts(`author-material-${i}`, 'author', source.text)),
    ...explicitUnknowns.flatMap((source, i) => excerpts(`unknown-${i}`, 'unknown', source.quote)),
  ]
  return { sourceContext, authorMaterial, explicitUnknowns, evidence }
}

export const writingAuthorityGuidance = `authorMaterial/sourceContext是作者材料；明确事实、条件及explicitUnknowns不可被新细节推翻。发展要求依作者原句的时间和范围兑现，不当作已经发生。futureDesign只是未来设计，executed=false；continuity按段落顺序记录已采用正文的原句，含已发生、明确未发生及未定状态，不能提升为作者设定。已采用正文中的明确作者编辑优先于旧设计；但模型新正文不能自行推翻作者材料。状态可以通过正文实际写出的新行动改变，不能无过渡倒退或凭空完成；明确没拍照就不能直接使用那张照片，已进门不能无过渡重新进门。回忆、否定、设想、打算、尝试均不等于完成；同一物品的新动作、简短承接和呼应不算重演。保留未知只约束作者明确保留的内容，不把普通细节变成禁区。`

/** Cache only exact source excerpts, bound to the complete accepted prefix and design. */
export async function ensureWritingContinuity(idea: string, curve: ConfirmedCurve, draft: StoryWritingDraft) {
  const previous = draft.continuity?.snapshots ?? []
  const snapshots: Snapshot[] = []
  const prefix: unknown[] = []
  for (const segment of draft.segments) {
    if (segment.status !== 'accepted') break
    prefix.push({ id: segment.id, beatId: segment.beatId, text: segment.text, authorship: segment.authorship ?? 'model' })
    const sourceHash = hash({ authority: writingAuthority(idea, curve), beats: curve.beats, prefix })
    const catalog = excerpts(segment.id, 'prose', segment.text)
    const cached = previous.find(item => item.segmentId === segment.id && item.sourceHash === sourceHash)
    if (cached && cached.facts.every(f => factKinds.includes(f.kind) && statuses.includes(f.status)
      && catalog.some(e => e.id === f.evidenceId && e.quote === f.quote))) {
      snapshots.push(cached)
      continue
    }
    let snapshot: Snapshot | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = await requestQwenJson({
        systemPrompt: `从本段正文选择影响后续连续性的原句，严格输出JSON {facts:[{kind,status,evidenceId}]}。kind=event/condition/location/possession/time/relationship/unknown；status=established（已发生或明确成立）/not-established（明确没有发生或不成立）/open（明确未定、设想或打算）。必须特别记录否定行动、物品是否取得、人物到离场、先后时间及未完成事项。只选输入evidenceCatalog编号；不得概括改写、补设定或把计划当完成。普通修辞可省略；没有关键状态可以为空。同一句可含时间、位置等不同类别，每句每个kind至多选一次；状态只描述该类别，不能把部分动作的否定扩大到整句其他动作。`,
        userPrompt: JSON.stringify({ evidenceCatalog: catalog, ...(attempt ? { retry: '上次证据编号无效，请重新选择目录中的不同编号。' } : {}) }),
        outputSchema: s.object({ facts: s.array(s.object({ kind: s.enum(...factKinds), status: s.enum(...statuses), evidenceId: s.enum(...catalog.map(e => e.id)) }), 0, 24) }),
        diagnosticStage: 'story-writing-state', temperature: 0.1, maxTokens: 1800,
      }) as { facts: Array<{ kind: Snapshot['facts'][number]['kind']; status: Snapshot['facts'][number]['status']; evidenceId: string }> }
      try {
        if (new Set(output.facts.map(f => `${f.evidenceId}/${f.kind}`)).size !== output.facts.length) invalid()
        for (const f of output.facts) selectStoryEvidence([f.evidenceId], catalog, () => true, 1, 1, invalid)
        snapshot = { segmentId: segment.id, sourceHash, facts: output.facts.map(f => ({ ...f, quote: catalog.find(e => e.id === f.evidenceId)!.quote })) }
        break
      } catch (error) { if (attempt) throw error }
    }
    snapshots.push(snapshot!)
  }
  draft.continuity = { snapshots }
}

export function writingContext(idea: string, curve: ConfirmedCurve, draft: StoryWritingDraft, index: number, feedback?: string) {
  const beats = curve.beats.filter(b => b.status !== 'rejected')
  const beat = beats[index]!
  const authority = writingAuthority(idea, curve)
  const followingBeats = beats.slice(index + 1).map(({ id, kind, title, detail }) => ({ id, kind, title, detail }))
  const acceptedProse = draft.segments.slice(0, index).filter(s => s.status === 'accepted').map(({ id, label, text, authorship }) => ({ id, label, text, authorship: authorship ?? 'model' }))
  return {
    reviewIdentity: hash({ idea, curve }),
    brief: curve.brief, ...authority,
    authorRequirements: [...new Map([
      ...curve.preparation ? preparationAuthorRequirements(curve.preparation) : [],
      ...curve.designContract?.authorRequirements ?? [],
    ].map(requirement => [requirement.id, requirement])).values()]
      .filter(requirement => !curve.design?.sourceFacts.some(fact => fact.id === requirement.id && fact.disposition === 'parked')),
    // Historical hidden summaries are not another source of node events.
    designContract: curve.designContract ? { ...curve.designContract,
      nodes: beats.map(b => ({ beatId: b.id, kind: b.kind, text: b.detail, objective: b.detail,
        dependsOn: [...b.dependsOn], sourceIds: curve.designContract!.nodes.find(n => n.beatId === b.id)?.sourceIds ?? [] })) } : null,
    designMainlineReview: curve.mainlineReview ?? null,
    currentBeat: { id: beat.id, kind: beat.kind, title: beat.title, detail: beat.detail },
    nextBeatBoundary: followingBeats[0] ?? null,
    followingBeats, futureDesign: { executed: false, beats: followingBeats },
    isLast: index === beats.length - 1, acceptedProse,
    continuity: draft.continuity?.snapshots.filter(s => acceptedProse.some(p => p.id === s.segmentId)) ?? [],
    expansionNeeds: selectedExpansionNeeds(curve.preparation),
    ...(draft.segments[index] ? { previousText: draft.segments[index]!.text, previousAuthorship: draft.segments[index]!.authorship ?? 'model',
      rewriteContract: '替换本段，不是续写。只按feedback修改；风格意见不改变原段事件、结果、人物关系和时间顺序。已有错误必须修复，但不扩大为无关改写。' } : {}),
    ...(feedback ? { feedback } : {}),
  }
}
type Context = ReturnType<typeof writingContext>

/** Only writing instructions and full prose go to generation, never old reviews. */
export function writingGenerationInput(context: Context) {
  return {
    brief: context.brief,
    sourceContext: context.sourceContext,
    authorMaterial: context.authorMaterial,
    explicitUnknowns: context.explicitUnknowns,
    authorRequirements: context.authorRequirements,
    storyIntent: context.designContract ? { goal: context.designContract.goal.text,
      selectedDirection: context.designContract.selectedDirection ?? null } : null,
    acceptedProse: context.acceptedProse,
    currentBeat: context.currentBeat,
    followingBeats: context.followingBeats,
    isLast: context.isLast,
    expansionNeeds: context.expansionNeeds,
    ...(context.previousText !== undefined ? { previousText: context.previousText,
      previousAuthorship: context.previousAuthorship, rewriteContract: context.rewriteContract } : {}),
    ...(context.feedback ? { feedback: context.feedback } : {}),
  }
}

export type WritingMainlineReview = {
  verdict: 'supported' | 'drift' | 'uncertain'
  reason: string
  evidenceIds: string[]
}

export type WritingConsistencyReview = {
  verdict: 'supported' | 'conflict' | 'uncertain'
  issues: Array<{ kind: 'state-reversal' | 'repeated-completion' | 'time-order' | 'location-reversal' | 'possession-reversal'; evidenceIds: string[]; reason: string }>
}

type PassedReview = WritingMainlineReview | WritingConsistencyReview
// Process-local and bounded: retries can reuse a successful stage even when
// another stage failed, without mutating or committing a rejected draft.
const passedFinalReviews = new Map<string, { expiresAt: number; review: PassedReview }>()
const finalReviewCacheLimit = 128
const finalReviewCacheTtlMs = 30 * 60 * 1000

function finalReviewKey(context: Context, options: Parameters<typeof requestQwenJson>[0]): string | undefined {
  if (/^(?:1|true|yes)$/iu.test(process.env.STORY_DISABLE_MODEL?.trim() ?? '') || !process.env.DASHSCOPE_API_KEY?.trim()) return undefined
  return hash({ identity: context.reviewIdentity, options,
    provider: { model: process.env.QWEN_MODEL?.trim() || 'qwen-plus',
      baseUrl: process.env.DASHSCOPE_BASE_URL?.trim() ?? '', credential: hash(process.env.DASHSCOPE_API_KEY.trim()) } })
}

function cachedFinalReview<T extends PassedReview>(key: string | undefined): T | undefined {
  if (!key) return undefined
  const entry = passedFinalReviews.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) { passedFinalReviews.delete(key); return undefined }
  return structuredClone(entry.review) as T
}

function rememberFinalReview(key: string | undefined, review: PassedReview) {
  if (!key || review.verdict !== 'supported' || 'issues' in review && review.issues.length) return
  if (passedFinalReviews.size >= finalReviewCacheLimit) passedFinalReviews.delete(passedFinalReviews.keys().next().value!)
  passedFinalReviews.set(key, { expiresAt: Date.now() + finalReviewCacheTtlMs, review: structuredClone(review) })
}

/** Final-only, conservative factual audit. It does not judge style or plot quality. */
export async function reviewCompleteWritingConsistency(context: Context, text: string): Promise<WritingConsistencyReview> {
  if (!context.designContract) return { verdict: 'supported', issues: [] }
  const catalog = excerpts('complete-text', 'text', text)
  const allowed = new Set(catalog.map(entry => entry.id))
  let confirmingConflict = false
  const validateReview = (review: WritingConsistencyReview) => {
    if (!['supported', 'conflict', 'uncertain'].includes(review.verdict) || !Array.isArray(review.issues)
      || review.verdict === 'conflict' && !review.issues.length
      || review.verdict === 'supported' && review.issues.length
      || review.issues.some(issue => !issue.reason.trim() || !Array.isArray(issue.evidenceIds)
        || issue.evidenceIds.length < 2 || issue.evidenceIds.length > 4
        || new Set(issue.evidenceIds).size !== issue.evidenceIds.length
        || issue.evidenceIds.some(id => typeof id !== 'string' || !allowed.has(id)))) {
      throw new AppError('完整故事事实审阅返回了无效证据，请重试。', 502, 'STORY_WRITING_CONSISTENCY_INVALID')
    }
  }
  try {
    const options = {
      systemPrompt: `你是完整故事的事实连续性审阅员。严格输出JSON {verdict,issues}。只找有明确正文证据的前后矛盾，不审文风、不审主线、不要求目标成功。\n` +
        `conflict仅用于正文明确陈述的互斥事实：同一事件同时被叙述为已完成与未完成；同一时间范围的同一事实被明确肯定又否定；人物位置、物品持有状态或先后时间存在无法同时成立的明确陈述；同一次动作在没有重新尝试或阶段变化时被重复完成。只使用state-reversal、repeated-completion、time-order、location-reversal、possession-reversal。\n` +
        `只按正文顺序和实际时间核对同一主体、对象与事实范围。区分意图、准备、开始、进行、暂停与完成：前一阶段可以发展到后一阶段，开始不等于完成，局部动作不等于整个任务完成。先前状态不是全文结束时必须保持的状态；不同时间的状态不同不自动矛盾。\n` +
        `必须通读两处证据之间及相邻的正文，查找已写出的行动、位置变化和状态转换，包括一句话已蕴含的必要子动作。同一场景内不同位置不自动等于不同场景。跨句、跨段或时间推进中的普通动作可以自然省略；仅缺少逐动作描写不能判causal-break或scene-transition。若需要新增关键能力、资源、例外或推翻明确限制才能连接，才是实质因果缺口；不能靠想象补齐这些关键事实，也不能自行添加时间、位置、持有或动作不变的限制来制造冲突。\n` +
        `不审一般因果完整度、转场是否详写、材料用途是否解释充分；缺少普通过渡不是事实互斥。区分叙述者确认的事实与人物对白、猜测、回忆和意象；未经叙述确认的人物说法不能自动作为事实。文学表达不按物理状态逐字审判，但叙述明确声称某个现实目标成功或失败时，应按正文核对，不能擅自改成象征含义替矛盾圆场。不要把合理新动作、重新确认、设想、尝试、开放结尾或阶段变化判为矛盾。无法确认时用uncertain。每个issue引用2至4个不同的正文目录编号。没有明确矛盾时verdict=supported且issues为空。` + writingInputEncodingGuidance,
      userPrompt: serializeWritingInput({
        evidenceCatalog: catalog,
        completeText: text,
      }),
      outputSchema: storyWritingConsistencyReviewSchema,
      diagnosticStage: 'story-writing-consistency-review', temperature: 0.1, maxTokens: 1600,
    }
    const key = finalReviewKey(context, options)
    const cached = cachedFinalReview<WritingConsistencyReview>(key)
    if (cached) return cached
    let output = await requestQwenJson(options) as WritingConsistencyReview
    validateReview(output)
    if (output.verdict === 'conflict') {
      confirmingConflict = true
      // A valid quote ID proves provenance, not a contradiction. Recheck the
      // whole prose without forwarding the first reviewer's interpretation.
      const candidates = output.issues.map(({ kind, evidenceIds }) => ({ kind, evidenceIds }))
      output = await requestQwenJson({ ...options,
        systemPrompt: `${options.systemPrompt}\n你现在是独立复核员。candidateConflicts仅是待核对的证据组合，不代表矛盾成立。逐项结合完整正文，核对是否确为同一时间范围内互斥的事实；尤其查找中间已有的状态转换，区分普通省略与关键因果缺失。不能因两端状态不同就判冲突。不新增问题，只保留正文确实证明的原候选矛盾；全部不成立则supported，不能确定则uncertain。reason写你独立核实的具体依据。`,
        userPrompt: serializeWritingInput({ evidenceCatalog: catalog, completeText: text, candidateConflicts: candidates }),
        diagnosticStage: 'story-writing-consistency-confirmation',
      }) as WritingConsistencyReview
      validateReview(output)
      if (output.issues.some(issue => !candidates.some(candidate =>
        candidate.kind === issue.kind && candidate.evidenceIds.every(id => issue.evidenceIds.includes(id))))) {
        throw new AppError('完整故事事实复核改换了原候选证据，请重试。', 502, 'STORY_WRITING_CONSISTENCY_INVALID')
      }
    }
    rememberFinalReview(key, output)
    return output
  } catch (error) {
    const unavailableCodes = new Set(['QWEN_NOT_CONFIGURED', 'QWEN_TIMEOUT', 'QWEN_NETWORK_ERROR', 'QWEN_UPSTREAM_ERROR', 'QWEN_RATE_LIMITED', 'QWEN_REQUEST_BUDGET_EXHAUSTED'])
    if (error instanceof AppError && unavailableCodes.has(error.code)) return { verdict: confirmingConflict ? 'uncertain' : 'supported', issues: [] }
    if (error instanceof AppError) throw new AppError('完整故事事实审阅暂不可用，请重试最终审阅。已采用正文仍保留。', 502, 'STORY_WRITING_CONSISTENCY_REVIEW_INVALID')
    throw error
  }
}

/** Review the current proposal's relationship to the confirmed design only. */
export async function reviewWritingMainline(context: Context, text: string, mode: 'segment' | 'complete' = 'segment'): Promise<WritingMainlineReview> {
  const contract = context.designContract
  if (!contract) return { verdict: 'supported', reason: '当前故事没有结构化设计契约，沿用既有正文流程。', evidenceIds: [] }
  if (context.designMainlineReview?.status === 'unavailable' || context.designMainlineReview?.status === 'repair-failed') {
    return { verdict: 'supported', reason: '故事设计主线审阅暂不可用，沿用正文流程；可稍后重试审阅。', evidenceIds: [] }
  }
  const catalog = [
    { id: 'design-contract:goal', text: contract.goal.text, scope: 'goal' },
    ...(contract.selectedDirection ? [{ id: 'design-contract:selected-direction', text: contract.selectedDirection, scope: 'direction' }] : []),
    ...(mode === 'segment' && contract.causalBridge ? [{ id: 'design-contract:causal-bridge', text: `${contract.causalBridge.method}；${contract.causalBridge.change}`, scope: 'causal-bridge' }] : []),
    { id: `design-contract:node:${context.currentBeat.id}`, text: context.currentBeat.detail, scope: 'current-node' },
    ...(mode === 'complete' ? contract.nodes.filter(node => node.beatId !== context.currentBeat.id)
      .map(node => ({ id: `design-contract:node:${node.beatId}`, text: node.text, scope: 'confirmed-node' })) : []),
    ...context.acceptedProse.map(segment => ({ id: `accepted:${segment.id}`, text: segment.text, scope: 'accepted-prose' })),
    ...context.authorRequirements.map(requirement => ({ id: `author-requirement:${requirement.id}`, text: requirement.quote, scope: 'author-requirement' })),
  ]
  const allowed = new Set(catalog.map(item => item.id))
  let output: WritingMainlineReview
  let key: string | undefined
  try {
    const options = {
      systemPrompt: `你是故事正文的主线审阅员。${mode === 'complete' ? '现在审阅已经拼接完成的完整正文。' : '现在审阅当前段正文提案。'}只判断正文是否仍服务已确认的故事主线，严格输出JSON {verdict,reason,evidenceIds}。\n` +
        `supported：当前段服务原始目标、作者选定方向、当前节点，或通过有动机的绕路/取舍继续让目标、风险、承诺或代价产生作用。新事件不因未逐字出现在设计里而失败。\n` +
        `drift：${mode === 'complete' ? '完整正文的主要篇幅或结尾已经被无关任务接管，原目标只剩装饰性提及，且' : '新事件已经接管故事，替代原目标和当前节点，而且'}没有目标、风险、承诺、代价或动机上的连接。不能因为${mode === 'complete' ? '目标没有成功、结尾开放或' : '本段尚未完成目标、出现普通交通/服务/交流过程、或'}目标没有逐字复述而判drift。\n` +
        `uncertain：输入不足以判断。未来节点只是停笔边界，不是已发生事实；不能把它当成正文事实。reason简要说明判断。evidenceIds只能从目录中选择；没有必要时为空。\n` +
        (mode === 'complete' ? '终审只核对创作者可见并确认的confirmedNodes.text与明确作者要求中的关键行动、关键选择和约定结果是否遗漏。只因无关任务接管、关键行动被意象收尾替代或明确要求被推翻才判drift，并引用对应设计或作者要求的编号。不能从历史行动摘要、审阅意见或自己的偏好新增必须完成的事件。普通走路、开关物件、取放、转场等子动作未逐一描写不算遗漏。原设计允许暂缓、放弃或开放结局时，不能强求原愿望成功；不要用“故事仍提到目标”替代对关键行动的核对，也不能用文学深意替明确相反的结果圆场。\n' : '') +
        authorRequirementsGuidance + `\n明确推翻作者设定、违反边界或${mode === 'complete' ? '完整故事遗漏明确要求兑现的发展' : '本段消除了后续兑现发展要求的可能性'}也判drift，并引用对应要求及正文证据；未在当前段兑现全篇要求不算失败。` + writingInputEncodingGuidance,
      userPrompt: serializeWritingInput({
        designContract: {
          goal: contract.goal,
          mainlineGoals: contract.mainlineGoals,
          mainlineAnchors: contract.mainlineAnchors,
          selectedDirection: contract.selectedDirection ?? null,
          ...(mode === 'segment' ? { causalBridge: contract.causalBridge } : {}),
          currentNode: contract.nodes.find(node => node.beatId === context.currentBeat.id) ?? null,
          ...(mode === 'complete' ? { confirmedNodes: contract.nodes } : {}),
        },
        authorRequirements: context.authorRequirements,
        currentBeat: context.currentBeat,
        acceptedProse: context.acceptedProse,
        proposal: text,
        evidenceCatalog: catalog,
      }),
      outputSchema: storyWritingMainlineReviewSchema,
      diagnosticStage: 'story-writing-mainline-review', temperature: 0.1, maxTokens: 1200,
    }
    key = mode === 'complete' ? finalReviewKey(context, options) : undefined
    const cached = cachedFinalReview<WritingMainlineReview>(key)
    if (cached) return cached
    output = await requestQwenJson(options) as WritingMainlineReview
  } catch (error) {
    const unavailableCodes = new Set(['QWEN_NOT_CONFIGURED', 'QWEN_TIMEOUT', 'QWEN_NETWORK_ERROR', 'QWEN_UPSTREAM_ERROR', 'QWEN_RATE_LIMITED', 'QWEN_REQUEST_BUDGET_EXHAUSTED'])
    if (error instanceof AppError && unavailableCodes.has(error.code)) return {
      verdict: 'supported',
      reason: '本段主线审阅暂不可用，未作主线裁决；可在当前段重试审阅。',
      evidenceIds: [],
    }
    if (error instanceof AppError) throw new AppError('本段主线审阅返回无效结果，请重试当前段。已采用正文仍保留。', 502, 'STORY_WRITING_MAINLINE_REVIEW_INVALID')
    throw error
  }
  if (!['supported', 'drift', 'uncertain'].includes(output.verdict)
    || typeof output.reason !== 'string'
    || !Array.isArray(output.evidenceIds)
    || output.evidenceIds.some(id => typeof id !== 'string' || !allowed.has(id))) {
    throw new AppError('本段主线审阅返回了无效证据，请重试当前段。已采用正文仍保留。', 502, 'STORY_WRITING_MAINLINE_REVIEW_INVALID')
  }
  if (mode === 'complete' && output.verdict === 'drift' && !output.evidenceIds.some(id =>
    id.startsWith('design-contract:node:') || id.startsWith('author-requirement:'))) {
    return { verdict: 'uncertain', reason: '未引用明确约定的节点行动或作者要求，不能据此否定完整正文。', evidenceIds: [] }
  }
  rememberFinalReview(key, output)
  return output
}

const repairProblems = {
  'future-event': '本段停在当前节点范围内，把后续独有的新动作和结果留到后续；保留当前节点明确包含的直接结果。',
  'repeated-event': '从已发生事件的结果承接并推进新内容，不再完整表演同一次事件；保留必要的简短承接。',
  'author-conflict': '保留作者明确事实、条件和未知，修正冲突的新正文；不得发明例外来绕开边界。',
  'causal-break': '核对前后事件、否定状态、物品、位置和时间；保留已有事实，通过当前节点允许的实际行动承接，不能凭空完成、撤销或倒退。',
}

export async function reviewWritingText(context: Context, text: string, mode: 'segment' | 'state' | 'final' = 'segment'): Promise<WritingRepair[]> {
  const catalog: Entry[] = mode === 'final' ? [
    ...context.evidence,
    ...context.acceptedProse.flatMap(segment => excerpts(segment.id, 'text', segment.text)),
  ] : [
    ...context.evidence,
    ...excerpts('current-text', 'text', text),
    ...(mode === 'segment' ? context.followingBeats.flatMap(beat => excerpts(beat.id, 'future-design', beat.detail)) : []),
    ...context.acceptedProse.flatMap(segment => excerpts(segment.id, 'prose', segment.text)),
    ...('previousText' in context ? excerpts('previous-text', 'previous', context.previousText!) : []),
  ]
  // State/final audits cannot see future plans as evidence of executed events.
  const reviewInput = mode === 'segment' ? context : {
    sourceContext: context.sourceContext, authorMaterial: context.authorMaterial, explicitUnknowns: context.explicitUnknowns,
    acceptedProse: context.acceptedProse, continuity: context.continuity,
    ...(mode === 'state' && context.previousText ? { previousText: context.previousText, rewriteContract: context.rewriteContract, feedback: context.feedback } : {}),
  }
  const allowedKinds = kinds.filter(kind => kind === 'future-event' ? mode === 'segment' && catalog.some(e => e.scope === 'future-design')
    : kind === 'author-conflict' ? catalog.some(e => mode === 'final' ? e.scope === 'unknown' : e.scope === 'author' || e.scope === 'unknown')
    : mode === 'final' ? catalog.filter(e => e.scope === 'text').length > 1
    : catalog.some(e => e.scope === 'prose' || kind === 'causal-break' && e.scope === 'previous'))
  if (!allowedKinds.length) return []
  const issueSchema = s.object({ kind: s.enum(...allowedKinds), textEvidenceId: s.enum(...catalog.filter(e => e.scope === 'text').map(e => e.id)),
    referenceEvidenceId: s.enum(...catalog.filter(e => mode === 'final' ? ['text', 'unknown'].includes(e.scope) : e.scope !== 'text').map(e => e.id)), reason: s.text })
  let issues: Issue[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = await requestQwenJson({
      systemPrompt: `你是正文连续性审阅者。严格输出JSON {issues:[{kind,textEvidenceId,referenceEvidenceId,reason}]}。只从evidenceCatalog选择两条不同的原句编号，不重抄引用。textEvidenceId必须来自text。${mode === 'segment' ? 'future-event参照future-design；repeated-event参照prose；author-conflict参照author/unknown；causal-break仅参照prose或previous。currentBeat.detail是本段创作范围，不是已发生事实的证据。后续人物首次到场/离场、取得关键物品和完成结果都要逐项对照。' : mode === 'state' ? '没有future-event类别。repeated-event与causal-break只能参照prose或previous；author-conflict只能参照author/unknown。照片等结果无过渡出现用causal-break，不是future-event。' : '没有future-event类别。repeated-event与causal-break参照另一个text原句；author-conflict仅用于unknown明确保留的未知。'}reason仅解释具体矛盾，不给改写指令。${mode === 'final' ? '本次是完整正文终审；text包含按顺序排列的全部已采用段落。只检查正文内部的事实衔接和明确保留的未知，不以旧设计否定作者编辑。' : ''}
${mode === 'state' ? '本次专查跨段状态，不检查节点分工：逐项对照continuity中已完成、明确未完成和未定状态，检查本段是否无过渡把未发生当已发生、物品凭空取得、人物重复到离场、时间倒退或撤销结果。' : '检查实质抢写后续节点、完整重演同一次事件、作者边界冲突与关键因果断裂。节点范围以currentBeat.detail为准，不按kind机械截断。'}
${writingAuthorityGuidance}
只报告有双方原句支持、影响理解的具体问题；普通细节、比喻、呼应、合理新行动、后续尚未展开及写作偏好不算问题；不要求补背景或情感分析。找不到问题输出issues:[]。`,
      userPrompt: JSON.stringify({ ...reviewInput, allowedIssueKinds: allowedKinds, evidenceCatalog: catalog, text,
        ...(attempt ? { retry: '上次引用无效。重新审阅同一正文，只选择目录内且来源类别正确的编号，不得将无效审阅当作通过。' } : {}) }),
      outputSchema: s.object({ issues: s.array(issueSchema, 0, 5) }),
      diagnosticStage: `story-writing-${mode === 'segment' ? 'review' : mode === 'state' ? 'state-review' : 'final-review'}`,
      temperature: 0.1, maxTokens: 1700,
    }) as { issues: Issue[] }
    try {
      for (const issue of output.issues) {
        if (!kinds.includes(issue.kind) || !issue.reason.trim() || issue.reason.length > 500) invalid()
        const pair = selectStoryEvidence([issue.textEvidenceId, issue.referenceEvidenceId], catalog, () => true, 2, 2, invalid)
        const [current, reference] = pair as [Entry, Entry]
        if (current.scope !== 'text') invalid()
        if (mode === 'final') {
          if (reference.scope !== 'text' && reference.scope !== 'unknown') invalid()
          if (issue.kind === 'future-event' || issue.kind === 'author-conflict' && reference.scope !== 'unknown') invalid()
        } else if (!(issue.kind === 'future-event' ? reference.scope === 'future-design' && mode !== 'state'
          : issue.kind === 'repeated-event' ? reference.scope === 'prose'
          : issue.kind === 'author-conflict' ? reference.scope === 'author' || reference.scope === 'unknown'
          : ['prose', 'previous'].includes(reference.scope))) invalid()
      }
      issues = output.issues
      break
    } catch (error) { if (attempt) throw error }
  }
  if (!issues.length) return []
  // Review reasons are not sent to either confirmation or generation.
  const grounded = issues.map(issue => ({ kind: issue.kind,
    evidence: [catalog.find(e => e.id === issue.textEvidenceId)!, catalog.find(e => e.id === issue.referenceEvidenceId)!] }))
  const confirmationIssues = grounded.map((issue, index) => ({ index, ...issue,
    textCandidates: evidenceWindow(catalog, issue.evidence[0]!), referenceCandidates: evidenceWindow(catalog, issue.evidence[1]!),
    // Complete source passages, not model-selected excerpts: omitted sentences
    // remain visible even when the selected evidence is sparse or far apart.
    contextPassages: issue.evidence.map(anchor => ({ sourceId: anchor.sourceId, scope: anchor.scope,
      sentences: catalog.filter(entry => entry.sourceId === anchor.sourceId && entry.scope === anchor.scope) })) }))
  type Assessment = { index: number; textEvidenceIds: string[]; referenceEvidenceIds: string[]; analysis: string; relation: string }
  for (let attempt = 0; attempt < 2; attempt++) {
    const confirmation = await requestQwenJson({
      systemPrompt: `你是独立的故事连续性复核员。严格输出JSON {assessments:[{index,textEvidenceIds,referenceEvidenceIds,analysis,relation}]}。每个问题只评估一次，不新增问题。evidence[0]是当前正文原始锚点，evidence[1]是参照原始锚点。不重抄原句：textEvidenceIds只能选该问题textCandidates中的编号，referenceEvidenceIds只能选referenceCandidates中的编号；每侧必须包含原始锚点编号，按原文顺序选择1至5条，可以不连续。每条是独立证据，不能拼成一段连续引文，不能跨来源或类别。contextPassages是程序提供的完整来源原句，含未被选中的中间句；text和acceptedProse还提供跨段正文顺序。判断前必须检查完整上下文：两处状态之间是否有找回、归还、修补、重新取得、读取或到离场等实际过渡。analysis说明是否存在改变结论的过渡及其原句编号；存在有效过渡应判later-action或compatible，不能仅凭两端状态不同判矛盾。不存在过渡才进一步判断是否确有矛盾，不把计划、假设、否定当作实际完成。relation只能为compatible、later-action、retelling、contradiction、boundary-crossed、unrelated-evidence、uncertain；请根据原文的时间顺序、动作和状态判断。unrelated-evidence表示所选原句本身不支持所述判断。${writingAuthorityGuidance}`,
      userPrompt: JSON.stringify({ text, currentBeat: mode === 'segment' ? context.currentBeat : undefined,
        acceptedProse: context.acceptedProse, feedback: context.feedback, rewriteContract: context.rewriteContract,
        issues: confirmationIssues,
        ...(attempt ? { retry: '上次复核证据无效。仅选择各问题对应候选目录的编号，包含原始锚点并按原文顺序选择独立证据，可不连续。核对完整上下文中的过渡；审阅尚未完成，不得把失败当通过。' } : {}) }),
      diagnosticStage: 'story-writing-review-confirmation', temperature: 0.1, maxTokens: 1600,
      outputSchema: s.object({ assessments: s.array(s.object({ index: s.enum(...issues.map((_, i) => i)),
        textEvidenceIds: s.array(s.enum(...new Set(confirmationIssues.flatMap(issue => issue.textCandidates.map(entry => entry.id)))), 1, 5),
        referenceEvidenceIds: s.array(s.enum(...new Set(confirmationIssues.flatMap(issue => issue.referenceCandidates.map(entry => entry.id)))), 1, 5),
        analysis: s.text,
        relation: s.enum('compatible', 'later-action', 'retelling', 'contradiction', 'boundary-crossed', 'unrelated-evidence', 'uncertain') }), issues.length, issues.length) }),
    }) as { assessments: Assessment[] }
    try {
      if (new Set(confirmation.assessments.map(a => a.index)).size !== issues.length
        || confirmation.assessments.some(a => !Number.isInteger(a.index) || !issues[a.index] || !a.analysis.trim() || a.analysis.length > 700)) invalid()
      return confirmation.assessments.flatMap(a => {
        const issue = confirmationIssues[a.index]!
        const evidence = [...resolveConfirmationEvidence(a.textEvidenceIds, issue.textCandidates, issue.evidence[0]!),
          ...resolveConfirmationEvidence(a.referenceEvidenceIds, issue.referenceCandidates, issue.evidence[1]!)]
        if (a.relation === 'unrelated-evidence') invalid()
        return a.relation === (issue.kind === 'repeated-event' ? 'retelling' : issue.kind === 'future-event' ? 'boundary-crossed' : 'contradiction')
          ? [{ kind: issue.kind, evidence, instruction: repairProblems[issue.kind] }] : []
      })
    } catch (error) { if (attempt) throw error }
  }
  return invalid()
}

export async function auditCompleteWriting(idea: string, curve: ConfirmedCurve, draft: StoryWritingDraft) {
  const context = writingContext(idea, curve, draft, draft.segments.length - 1)
  context.acceptedProse = draft.segments.map(({ id, label, text, authorship }) => ({ id, label, text, authorship: authorship ?? 'model' }))
  context.continuity = draft.continuity?.snapshots ?? []
  const issues = await reviewWritingText(context, draft.segments.map(s => s.text).join('\n\n'), 'final')
  if (issues.length) throw new AppError(`全文尚未通过连续性审阅，请修改或重写相关段落后重试：${issues.slice(0, 3).map(i => i.evidence.filter(e => e.scope === 'text')
    .map(e => `${draft.segments.find(s => s.id === e.sourceId)?.label ?? '正文'}：${e.quote.slice(0, 160)}`).join(' / ')).join('；')}`,
    502, 'STORY_WRITING_REVIEW_FAILED')
  draft.continuity!.auditedHash = writingDraftHash(curve, draft)
}

export function writingDraftHash(curve: ConfirmedCurve, draft: StoryWritingDraft) {
  return hash({ curve, segments: draft.segments })
}

export { storyExpansionGuidance }
