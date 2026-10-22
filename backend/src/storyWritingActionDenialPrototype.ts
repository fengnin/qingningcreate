import { AppError, requestQwenJson } from './qwen.js'
import { shape as s } from './modelOutputSchema.js'

export type ActionClaim = {
  sentenceIndex: number
  actor: string
  action: 'contact' | 'enter' | 'exit' | 'see' | 'speak' | 'transfer' | 'acquire' | 'return' | 'open-close' | 'other'
  object: string
  objectIdentity?: string
  timeScope: 'same-event' | 'before' | 'after' | 'unknown'
  polarity: 'affirmed' | 'denied' | 'pending'
  layer: 'narration' | 'dialogue' | 'thought'
}

export type ActionDenialCandidate = { first: ActionClaim; second: ActionClaim }
export type ActionDenialNature = 'narration-fact' | 'unverified-character-claim' | 'explicit-lie' | 'narrator-confirmed-claim' | 'correction' | 'thought' | 'pending'
export type ActionDenialAssessment = { candidateIndex: number; firstNature: ActionDenialNature; secondNature: ActionDenialNature; relation: 'conflict' | 'compatible' | 'uncertain'; reason: string; correctionEvidenceIndices?: number[] }

const sentenceSchema = s.object({
  claims: s.array(s.object({ sentenceIndex: { type: 'integer' }, actor: s.text,
    action: s.enum('contact', 'enter', 'exit', 'see', 'speak', 'transfer', 'acquire', 'return', 'open-close', 'other'),
    object: s.text, objectIdentity: s.text, timeScope: s.enum('same-event', 'before', 'after', 'unknown'), polarity: s.enum('affirmed', 'denied', 'pending'),
    layer: s.enum('narration', 'dialogue', 'thought') }), 0, 30),
})

function sentenceCatalog(text: string): string[] {
  return [...text.matchAll(/[^。！？\n]+[。！？]?[”’」』"']*|[^\n]+/gu)].map(match => match[0].trim()).filter(Boolean)
}

export type ActionClaimChunk = { sentences: { sentenceIndex: number; quote: string }[]; coreSentenceIndices: number[] }

/** Keep model extraction bounded while retaining one neighboring sentence for local reference. */
export function splitActionClaimChunks(sentences: string[], maxSentences = 8, maxChars = 900): ActionClaimChunk[] {
  const ranges: { start: number; end: number }[] = []
  let start = 0
  while (start < sentences.length) {
    let end = start
    let size = 0
    while (end < sentences.length && end - start < maxSentences
      && (end === start || size + sentences[end]!.length <= maxChars)) {
      size += sentences[end]!.length
      end++
    }
    ranges.push({ start, end })
    start = end
  }
  return ranges.map(({ start, end }) => {
    const contextStart = Math.max(0, start - 1)
    const contextEnd = Math.min(sentences.length, end + 1)
    return {
      sentences: sentences.slice(contextStart, contextEnd).map((quote, offset) => ({ sentenceIndex: contextStart + offset, quote })),
      coreSentenceIndices: Array.from({ length: end - start }, (_, offset) => start + offset),
    }
  })
}

function normalized(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()
}

function objectScopesOverlap(left: string, right: string): boolean {
  const a = normalized(left), b = normalized(right)
  if (!a || !b || a === '未知' || b === '未知') return false
  if (a === b) return true
  const broad = new Set(['任何东西', '所有东西', '任何物品', '所有物品', '一切东西'])
  return broad.has(a) || broad.has(b)
}

/** Only exact canonical actor/action/time matches with opposite polarity become candidates. */
export function pairActionDenialCandidates(claims: ActionClaim[]): ActionDenialCandidate[] {
  const candidates = new Map<string, ActionDenialCandidate>()
  const claimKey = (claim: ActionClaim) => JSON.stringify([
    claim.sentenceIndex,
    normalized(claim.actor),
    claim.action,
    claim.timeScope,
    claim.polarity,
    claim.layer,
    normalized(claim.objectIdentity ?? '') && normalized(claim.objectIdentity ?? '') !== '未知'
      ? `identity:${normalized(claim.objectIdentity!)}`
      : `object:${normalized(claim.object)}`,
  ])
  for (let i = 0; i < claims.length; i++) for (let j = i + 1; j < claims.length; j++) {
    const first = claims[i]!, second = claims[j]!
    if (first.polarity === 'pending' || second.polarity === 'pending' || first.polarity === second.polarity
      || first.action === 'other' || second.action === 'other' || first.timeScope === 'unknown' || second.timeScope === 'unknown'
      || !normalized(first.actor) || normalized(first.actor) === '未知' || normalized(second.actor) === '未知'
      || normalized(first.actor) !== normalized(second.actor)
      || normalized(first.action) !== normalized(second.action)
      || normalized(first.timeScope) !== normalized(second.timeScope)
      || !(objectScopesOverlap(first.object, second.object)
        || first.objectIdentity && second.objectIdentity && normalized(first.objectIdentity) !== '未知'
          && normalized(first.objectIdentity) !== '' && normalized(first.objectIdentity) === normalized(second.objectIdentity))) continue
    const key = [claimKey(first), claimKey(second)].sort().join('|')
    if (!candidates.has(key)) candidates.set(key, { first, second })
  }
  return [...candidates.values()]
}

export function applyActionDenialSourcePolicy(candidate: ActionDenialCandidate, assessment: ActionDenialAssessment): ActionDenialAssessment['relation'] {
  const natures = [assessment.firstNature, assessment.secondNature]
  if (natures.some(value => value === 'explicit-lie' || value === 'correction')) return 'compatible'
  const unresolved = natures.some(value => value === 'unverified-character-claim' || value === 'thought' || value === 'pending')
    || [candidate.first, candidate.second].some((claim, index) => claim.layer === 'dialogue'
      && !['explicit-lie', 'correction', 'narrator-confirmed-claim'].includes(natures[index]!))
  return unresolved ? 'uncertain' : assessment.relation
}

/** Reuse a validated retraction only for the identical extracted claim, not its whole sentence. */
export function reuseActionDenialCorrections(candidates: ActionDenialCandidate[], assessments: ActionDenialAssessment[]): ActionDenialAssessment[] {
  const key = (claim: ActionClaim) => JSON.stringify([claim.sentenceIndex, claim.actor, claim.action, claim.object,
    claim.timeScope, claim.polarity, claim.layer])
  const corrections = new Map<string, number[]>()
  for (const assessment of assessments) {
    const candidate = candidates[assessment.candidateIndex]!
    if (assessment.firstNature === 'correction') corrections.set(key(candidate.first), assessment.correctionEvidenceIndices ?? [])
    if (assessment.secondNature === 'correction') corrections.set(key(candidate.second), assessment.correctionEvidenceIndices ?? [])
    // A validated correction between two opposite versions of the same
    // character claim retracts the earlier version as well.
    if ((candidate.first.layer === 'dialogue' || assessment.firstNature === 'unverified-character-claim')
      && (candidate.second.layer === 'dialogue' || assessment.secondNature === 'correction')
      && (assessment.firstNature === 'correction' || assessment.secondNature === 'correction')) {
      corrections.set(key(candidate.first), assessment.correctionEvidenceIndices ?? [])
      corrections.set(key(candidate.second), assessment.correctionEvidenceIndices ?? [])
    }
  }
  return assessments.map(assessment => {
    const candidate = candidates[assessment.candidateIndex]!
    const first = corrections.get(key(candidate.first)), second = corrections.get(key(candidate.second))
    const resolved = { ...assessment,
      firstNature: first ? 'correction' as const : assessment.firstNature,
      secondNature: second ? 'correction' as const : assessment.secondNature,
      correctionEvidenceIndices: [...new Set([...(assessment.correctionEvidenceIndices ?? []), ...(first ?? []), ...(second ?? [])])],
      reason: first || second ? `${assessment.reason} 同一条原话的撤回已由纠正证据确认，沿用该纠正结论。` : assessment.reason }
    return { ...resolved, relation: applyActionDenialSourcePolicy(candidate, resolved) }
  })
}

/** Isolated diagnostic prototype. Not imported by the production writing path. */
export async function reviewActionDenialPrototype(text: string): Promise<{ claims: ActionClaim[]; candidates: ActionDenialCandidate[]; assessments: ActionDenialAssessment[]; extractionChunkCount: number }> {
  const sentences = sentenceCatalog(text)
  if (!sentences.length) return { claims: [], candidates: [], assessments: [], extractionChunkCount: 0 }
  const chunks = splitActionClaimChunks(sentences)
  const claims: ActionClaim[] = []
  for (const chunk of chunks) {
    const extracted = await requestQwenJson({
    systemPrompt: `从给定编号原句中提取明确的动作陈述及其后续否认，不补写原文没有的事实。把已经发生/被明确否认的动作标成affirmed/denied；“想、准备、等待、将要、尚未、之后再做”等计划或未完成状态一律标成pending，程序会忽略。动作只能从枚举选最具体的类别：contact（敲、叩、碰、触、摸），enter，exit，see，speak，transfer，acquire，return，open-close，other。把上下文中明确指向同一人的代词归一为同一个主体标签。时间范围描述的是被陈述动作发生的时间，不是说话时间；回忆或否认先前动作应选same-event。时间关系无法判断选unknown。object保留原始对象和限定范围。objectIdentity用于同一对象的指代归一：同一人物或物件仅有位置、描述差异时用相同标签；如“窗边的老师”和“老师”在上下文明确同一人时相同。不同人、不同物、内外范围、整体和部件必须用不同标签，不能仅因词语包含就合并；如甲班老师/乙班老师、柜门/柜里的物品、左侧房间/右侧房间。无法确定同一对象填未知。“任何东西”保留全称范围。不能确定主体、动作或对象时填“未知”。对白和内心想法必须标记层级，不能把对白自动当作客观事实。` ,
    userPrompt: JSON.stringify({ sentences: chunk.sentences, coreSentenceIndices: chunk.coreSentenceIndices,
      identityInstructions: '先通读全文解决身份，再输出动作。objectIdentity是实体的核心身份标签，不是object原文复述；默认删除位置、时间和一般描述修饰词。“台上的主唱”和“主唱”都标“主唱”，“窗边的老师”和“老师”都标“老师”。若正文明确写“A就是B/那位正是B”，A和B必须用同一个标签，包括身份揭示前的动作。若文本明确区分同类实体（甲班老师/乙班老师、两个不同的老师），必须用不同标签。若无法判断是同一人还是不同人，填未知，不能自行合并。',
      actionInstructions: '进入/进过/走进都是enter；获得/取得/拿到才是acquire；不得因为否定就换动作类别。对“她说：我没进过房间”应提取enter、denied、dialogue，外面有“她说”不代表引号里的内容是旁白。' }),
    outputSchema: sentenceSchema, diagnosticStage: 'story-writing-action-denial-prototype-extract', temperature: 0, maxTokens: 2200,
    }) as { claims: ActionClaim[] }
    const core = new Set(chunk.coreSentenceIndices)
    claims.push(...extracted.claims.filter(claim => Number.isInteger(claim.sentenceIndex)
      && core.has(claim.sentenceIndex) && claim.sentenceIndex >= 0 && claim.sentenceIndex < sentences.length
      && ['affirmed', 'denied', 'pending'].includes(claim.polarity)
      && ['narration', 'dialogue', 'thought'].includes(claim.layer)))
  }
  const candidates = pairActionDenialCandidates(claims)
  if (!candidates.length) return { claims, candidates, assessments: [], extractionChunkCount: chunks.length }
  const nature = s.enum('narration-fact', 'unverified-character-claim', 'explicit-lie', 'narrator-confirmed-claim', 'correction', 'thought', 'pending')
  const assessmentSchema = s.object({ assessments: s.array(s.object({ candidateIndex: { type: 'integer' },
    firstNature: nature, secondNature: nature, correctionEvidenceIndices: s.array({ type: 'integer' }, 0, 4), relation: s.enum('conflict', 'compatible', 'uncertain'), reason: s.text }), candidates.length, candidates.length) })
  const result = await requestQwenJson({
    systemPrompt: `先判断两处陈述各自是什么性质，再判断它们是否构成故事事实矛盾。nature分类：narration-fact=叙述者直接确立的事实；unverified-character-claim=人物对白中的说法，正文没有确认真假；explicit-lie=正文明确说人物故意撒谎/谎称；narrator-confirmed-claim=对白内容被对白之外的叙述明确证实；correction=正文明确纠正前述说法；thought=人物想法；pending=计划、愿望或尚未发生。
规则：任何一方是explicit-lie/correction，判compatible；任何一方是unverified-character-claim/thought/pending，不能判conflict，判uncertain；只有两方都是narration-fact或narrator-confirmed-claim，且主体、动作、对象范围、时间确实互斥，才可判conflict。没有撒谎标记，不等于人物对白就是真实事实。对白、想法、回忆不要自动升级为客观叙述事实。
判例：①“她摸过展柜。为了掩饰，她故意向保安撒谎：‘我没碰任何东西。’”=>第二处explicit-lie，compatible。②“她摸过展柜。后来她说：‘我没碰任何东西。’”=>第二处unverified-character-claim，uncertain，不能仅因没有撒谎提示而判冲突。③“她摸过展柜。后来旁白确认她刚才说的是真话：她确实没有碰展柜。”=>若同一时间、对象的两处叙述事实互斥，conflict。④“她摸过柜子，但没碰柜里的展品。”=>对象范围不同，compatible。
事后纠正需检查完整上下文，而非只检查候选原句：人物先说A，随后明确说“刚才说错了”并改为非A时，被撤回的A和用于纠正的非A都可标correction，返回真正说明纠正关系的原句编号correctionEvidenceIndices。纠正可发生在同一句或后一句，且不必使用“撒谎”。不能把纠正别的事、别人说错、假设将纠正、只改变后续行动，当成撤回本候选陈述。没有针对本候选的明确纠正时该数组为空。
必须按顺序输出firstNature、secondNature及relation，性质与layer字段一致；对白不得标narration-fact，除非被独立旁白确认。理由同时解释两处证据及任何纠正关系。严格按候选编号逐一输出。`,
    userPrompt: JSON.stringify({ fullText: text, sentences: sentences.map((quote, sentenceIndex) => ({ sentenceIndex, quote })), candidates: candidates.map((candidate, candidateIndex) => ({ candidateIndex,
      first: { ...candidate.first, quote: sentences[candidate.first.sentenceIndex] },
      second: { ...candidate.second, quote: sentences[candidate.second.sentenceIndex] } })) }),
    outputSchema: assessmentSchema, diagnosticStage: 'story-writing-action-denial-prototype-review', temperature: 0, maxTokens: 1400,
  }) as { assessments: ActionDenialAssessment[] }
  if (result.assessments.length !== candidates.length
    || new Set(result.assessments.map(assessment => assessment.candidateIndex)).size !== candidates.length
    || result.assessments.some(assessment => !Number.isInteger(assessment.candidateIndex) || !candidates[assessment.candidateIndex]
      || !['conflict', 'compatible', 'uncertain'].includes(assessment.relation) || !assessment.reason.trim())) {
    throw new AppError('动作否认原型未返回完整有效判断。', 502, 'ACTION_DENIAL_PROTOTYPE_INVALID')
  }
  const assessments = result.assessments.map(assessment => {
    const candidate = candidates[assessment.candidateIndex]!
    const evidence = assessment.correctionEvidenceIndices ?? []
    const validCorrection = evidence.length > 0 && evidence.every(index => Number.isInteger(index) && index >= 0 && index < sentences.length)
      && evidence.some(index => /纠正|改口|口误|说错|更正|收回/u.test(sentences[index]!))
      && [candidate.first, candidate.second].some((claim, index) => (claim.layer === 'dialogue'
        || /[“「"']/u.test(sentences[claim.sentenceIndex]!))
        && [assessment.firstNature, assessment.secondNature][index] === 'correction'
        && evidence.some(sentenceIndex => sentenceIndex >= claim.sentenceIndex))
    if (!validCorrection) {
      if (assessment.firstNature === 'correction') assessment.firstNature = 'unverified-character-claim'
      if (assessment.secondNature === 'correction') assessment.secondNature = 'unverified-character-claim'
    }
    return { ...assessment, relation: applyActionDenialSourcePolicy(candidate, assessment) }
  })
  return { claims, candidates, assessments: reuseActionDenialCorrections(candidates, assessments), extractionChunkCount: chunks.length }
}
