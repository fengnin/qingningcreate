import type { StoryPreparation, StoryPreparationItem } from '../../shared/story-preparation.js'
import type { StoryPreparationExplanationRequest } from '../../shared/story-preparation-request.js'

/** Only selected author quotations can revise material. Review prose also
 * contains future actions, so it must never be imported wholesale as facts. */
export function activePreparationMaterial(p: StoryPreparation): StoryPreparationItem[] {
  const superseded = new Set(p.authorReview?.supersededMaterialIds ?? [])
  return [...p.material.filter(m => !superseded.has(m.id)), ...(p.authorReview?.confirmedQuotes ?? []).map((quote, i) => ({
    id: `author-review-${i + 1}`, role: 'condition' as const, sourceId: 'author-review', quote,
  }))]
}

/** Classify existing author excerpts by their recorded role/source, without
 * inferring events, new unknowns, or authority from the candidate's wording. */
export function preparationExplanationContext(p: StoryPreparation, candidate: StoryPreparationExplanationRequest['candidate']) {
  const active = activePreparationMaterial(p)
  const known = active.filter(m => m.role !== 'unknown')
  const isDevelopmentRequirement = (m: StoryPreparationItem) => ['author-direction', 'author-note'].includes(m.sourceId)
  const established = known.filter(m => !isDevelopmentRequirement(m))
  const superseded = new Set(p.authorReview?.supersededMaterialIds ?? [])
  const revisedSources = new Set(p.material.filter(m => superseded.has(m.id)).map(m => m.sourceId))
  return {
    stage: 'direction-design' as const,
    authorMaterial: {
      authority: 'author-established-material' as const,
      settings: established.filter(m => m.role === 'fact'),
      goals: established.filter(m => m.role === 'goal'),
      conditions: established.filter(m => m.role === 'condition'),
    },
    authorDevelopmentRequirements: {
      authority: 'author-development-requirement' as const,
      scope: 'as-stated-by-author' as const,
      defaultScope: 'whole-story' as const,
      entries: known.filter(isDevelopmentRequirement),
    },
    authorReservedUnknowns: {
      authority: 'author-reserved-unknown' as const,
      entries: active.filter(m => m.role === 'unknown'),
    },
    sourceContext: {
      authority: 'author-source-context' as const,
      // Full text explains the scope of excerpts/unknowns. A revised source
      // instead exposes active excerpts only, so retired clauses cannot return
      // through this second copy of the original source.
      sources: p.sources.map(source => revisedSources.has(source.id)
        ? { id: source.id, scope: 'active-excerpts' as const, excerpts: active.filter(m => m.sourceId === source.id).map(m => ({ id: m.id, quote: m.quote })) }
        : { id: source.id, scope: 'full-source' as const, text: source.text }),
    },
    futureDesign: {
      authority: 'draft-future-design' as const,
      executed: false as const,
      candidate: { ...candidate },
      ...(p.authorReview?.selectedStoryDirection ? { selectedStoryDirection: p.authorReview.selectedStoryDirection } : {}),
    },
  }
}

export const preparationMaterialAuthorityGuidance = `输入分区：authorMaterial 是作者已定材料，含设定、目标与条件。authorDevelopmentRequirements 是希望未来兑现的发展要求，尚不是结果；按作者原文指定的范围兑现，默认约束整篇，当前短卡只需相容并保留发展空间，不必在这一张卡内保证或提前完成全篇结局。例如要求结尾获奖，当前卡片拟设报名或练习，尚未获奖并非缺口；若拟设永远不参赛，才需核对是否与结尾要求冲突。分组不改变原句中的其他含义，空分组仅表示未提供此类片段，不是禁止创作或必须补答。
sourceContext 保留作者原句，帮助理解条件及未知的范围；scope=active-excerpts 的来源已经修订，只按有效片段理解，不恢复被取代内容。
authorReservedUnknowns 仅限作者明确保留的未知，不扩大到整句其他事实；未提及的细节不自动成为保留未知，空数组表示没有此类要求。
futureDesign.candidate 整张卡是允许提出新情境、道具、动作和回应的未来设计，其内容可用于解释内部因果，不必先在原文中出现或另获确认；即使用“迷路了”“答应了”的叙述语气，也不是事件已发生的证据。新情节仍须遵守作者明确条件、保留的未知和卡片自身因果。
futureDesign.selectedStoryDirection 若存在，是作者明确选定的关键走向；承接该分支，不自行改选其他分支，不当作已发生事实或已定成败。后续明确的作者编辑或修改指令优先于旧走向。`
