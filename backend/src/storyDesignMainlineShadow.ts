import { requestQwenJson, withQwenRequestBudget } from './qwen.js'
import { outputShapeErrors, shape as s } from './modelOutputSchema.js'
import { activePreparationMaterial, preparationExplanationContext, preparationMaterialAuthorityGuidance } from './storyPreparationContext.js'
import { storySemanticReviewGuidance } from './storySemanticReview.js'
import type { StoryPreparation } from '../../shared/story-preparation.js'

export const storyDesignMainlineShadowPrompt = `仅观察故事设计是否发生 mainline-drift，不参与通过、修复或作者确认。按整版骨架判断，不能把“事件A引出事件B”本身当成主线仍成立的证明。
核对原愿望、已选方向、人物办法及其后果，是否仍影响后续选择和代价；若被另一任务取代，指出从哪个节点开始，以及被取代的原问题。临时绕路、失败、办理手续、处理技术问题本身不算偏航。合理改变目标、主动放弃原计划可以成立，前提是动机可理解、原愿望或关系仍构成取舍的代价；不要求人物必须完成原目标、不要求每段重复目标词。仅结尾重提目标也不能证明主线承接。
不审阅文风、精彩程度、普通省略、逐段正文连续性或节点抢跑。不设计修复方案，不追加情节。若证据不足，返回uncertain，不能猜测未写出的限制。
严格返回JSON {verdict,reason,evidenceIds}。verdict为supported、mainline-drift或uncertain。reason用不超过400字解释判断。evidenceIds只选evidenceCatalog已有编号，不重抄原文；mainline-drift至少选一个作者材料或已选方向编号及一个设计节点编号，引用须实际支持判断；其他结论可用空数组。编号只定位原文，不证明语义正确。
${preparationMaterialAuthorityGuidance}
${storySemanticReviewGuidance}`

export type ShadowInput = {
  curveId: string
  designId: string
  preparation: StoryPreparation
  steps: { kind: string; text: string }[]
}

export type MainlineAudit = { verdict: 'supported' | 'mainline-drift' | 'uncertain'; reason: string; evidenceIds: string[] }
export type MainlineResult = { status: 'completed'; audit: MainlineAudit } | { status: 'unavailable' }

/** Observation only: no shared contract fields, mutations, repair feedback or
 * awaited dependency in the generation path. Logs identify this exact version,
 * not a later author-edited design. Disable with STORY_DESIGN_MAINLINE_SHADOW=false. */
export async function observeStoryDesignMainline(input: ShadowInput): Promise<void> {
  if (process.env.STORY_DESIGN_MAINLINE_SHADOW === 'false') return
  await reviewStoryDesignMainline(input)
}

/** Same reviewer and evidence contract for shadow observation and opt-in repair. */
export async function reviewStoryDesignMainline(input: ShadowInput): Promise<MainlineResult> {
  const identity = { curveId: input.curveId, designId: input.designId, mode: 'shadow', stage: 'generated-design' }
  try {
    const p = input.preparation
    const candidate = p.candidates.find(c => p.acceptedCandidateIds.includes(c.id))
    if (!candidate) throw new Error('missing-selected-candidate')
    const active = activePreparationMaterial(p)
    const retiredSources = new Set(p.material.filter(m => p.authorReview?.supersededMaterialIds?.includes(m.id)).map(m => m.sourceId))
    // Retired source excerpts must not re-enter through historical intent extraction.
    const current = <T extends { sourceId: string; quote: string }>(entries: T[]) => entries.filter(e =>
      !retiredSources.has(e.sourceId) && p.sources.some(source => source.id === e.sourceId && source.text.includes(e.quote)))
    const evidenceCatalog = [
      ...active.filter(m => m.role !== 'unknown').map(m => ({ id: `material:${m.id}`, kind: 'author', text: m.quote })),
      ...(p.authorReview?.selectedStoryDirection ? [{ id: 'selected-direction', kind: 'direction', text: p.authorReview.selectedStoryDirection }] : []),
      ...input.steps.map(step => ({ id: `beat:${step.kind}`, kind: 'design', text: step.text })),
    ]
    const context = { ...preparationExplanationContext(p, candidate),
      mainlineGoals: current(p.mainlineGoals ?? []), mainlineAnchors: current(p.mainlineAnchors ?? []), evidenceCatalog }
    const schema = s.object({ verdict: s.enum('supported', 'mainline-drift', 'uncertain'), reason: s.text,
      evidenceIds: s.array(s.enum(...evidenceCatalog.map(e => e.id)), 0, evidenceCatalog.length) })
    const raw = await withQwenRequestBudget(1, () => requestQwenJson({ systemPrompt: storyDesignMainlineShadowPrompt, userPrompt: JSON.stringify(context),
      temperature: 0, maxTokens: 1000, diagnosticStage: 'preparation-story-design-mainline-shadow', outputSchema: schema }))
    if (outputShapeErrors(raw, schema).length) throw new Error('invalid-shadow-output')
    const audit = raw as MainlineAudit
    if (!audit.reason.trim() || audit.reason.length > 400 || new Set(audit.evidenceIds).size !== audit.evidenceIds.length
      || audit.verdict === 'mainline-drift' && (!audit.evidenceIds.some(id => evidenceCatalog.some(e => e.id === id && e.kind !== 'design'))
        || !audit.evidenceIds.some(id => evidenceCatalog.some(e => e.id === id && e.kind === 'design')))) throw new Error('invalid-shadow-evidence')
    console.info('[story-design-mainline-shadow]', JSON.stringify({ ...identity, status: 'completed', audit, context }))
    return { status: 'completed', audit }
  } catch {
    // An unavailable or malformed audit is explicitly NOT a passing verdict.
    // Do not log arbitrary provider errors, secrets or feed them into generation.
    console.info('[story-design-mainline-shadow]', JSON.stringify({ ...identity, status: 'unavailable' }))
    return { status: 'unavailable' }
  }
}
