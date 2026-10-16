import type { CreativeBrief } from '../../shared/story-contract.js'
import type { StoryCreativeFocus, StoryPreparation } from '../../shared/story-preparation.js'

export const storyCreativeFocusGuidance = `creativeFocus 是从原想法选出的创作参考原文，不是新增事实或强制情节。优先发展其中已有的人物关系、不同期待、习惯、反差或活动本身的趣味，让人物的办法和回应改变处境；新增规则、手续或技术条件应服务这些选择，避免接管故事。允许有铺垫的意外、合理的新设定及目标转变，不要求每件事由上一步直接造成。参考可以为空，服从作者明确要求、后续编辑、已确认结果及当前情境，不预设结局、成长或笑点。审阅不得仅以不够有趣、复杂或没有兑现推测的看点打回；只有具体矛盾、脱离原问题及选择代价等现有职责内的实质问题才可拒绝。`

/** Resolve only active, known, source-backed quotations. Selection never
 * promotes an unknown or superseded preference into narrative evidence. */
export function preparationCreativeFocus(p?: Pick<StoryPreparation, 'sources' | 'material' | 'appealMaterialIds' | 'authorReview'>, excludedIds: string[] = []): StoryCreativeFocus {
  const excluded = new Set([...excludedIds, ...(p?.authorReview?.supersededMaterialIds ?? [])])
  const selected = new Set(p?.appealMaterialIds ?? [])
  return { authority: 'creative-reference', excerpts: [...new Set((p?.material ?? [])
    .filter(m => selected.has(m.id) && !excluded.has(m.id) && m.role !== 'unknown'
      && p?.sources.some(s => s.id === m.sourceId && s.text.includes(m.quote)))
    .map(m => m.quote))] }
}

const toneGuidance: Record<CreativeBrief['tones'][number], string> = {
  comedy: '搞笑：让人物目标与行动造成具体的尴尬、误判或反差，后果继续推动选择；俏皮对白不能代替情节中的笑点。',
  warm: '温暖：让人物的具体照顾或理解改变关系和选择，不靠结尾说教。',
  friendship: '友情：让伙伴之间的信任或不同期待影响关键行动与结果。',
  romance: '恋爱：让心意与实际行动之间的落差影响人物选择。',
  growth: '成长：让主角因具体代价改变做法，并在结尾体现变化。',
  mystery: '悬疑：让信息缺口影响判断，并在后续以已有线索回应。',
  fantasy: '奇幻：让明确提出的规则变化影响目标和行动，保持规则一致。',
}

const forceGuidance: Record<CreativeBrief['dramaticForces'][number], string> = {
  misunderstanding: '误会：信息差应改变人物判断与行动，并有可追溯的澄清或后果。',
  cost: '代价：推进目标需要具体的放弃或承担，不能只口头宣称有代价。',
  surprise: '意外：与原目标相关的非预期变化应改变处境，迫使人物调整计划；不能只是无关的插曲。',
  contrast: '反差：预期与实际的差距应使原办法失效或改变选择。',
  'relationship-tension': '关系拉扯：人物之间不同期待应影响目标的推进和取舍。',
}

export function storyCreativeIntentGuidance(brief: CreativeBrief, stage: 'directions' | 'curve' | 'story'): string {
  const choices = [...brief.tones.map(tone => toneGuidance[tone]), ...brief.dramaticForces.map(force => forceGuidance[force])]
  const note = brief.note?.trim()
  if (!choices.length && !note) return ''
  const stageRule = stage === 'directions'
    ? '三条方向都必须与所选感觉和力量相容，并各自指出一个可发展的机制；它们不必在卡片中完成整篇故事，也不应重复同一种意外、误会、线索或笑点。作者希望看到的共同变化是三条方向的终点约束，不是三条卡片都重复同一条转折；每条要用不同的起因和关键选择通向它。作者选定一条后，才要求整条曲线和正文完整兑现这些选择。'
    : stage === 'curve'
      ? '曲线须保留已选方向的机制，展示它如何使处境变化、行动升级并通向可能结果；按整条路径理解节奏，不要求每个节点分别兑现全部感觉或戏剧力量，不要为迎合标签新增作者未确认的事实。'
      : '正文须通过已确认事件的行动、反应和后果，在整篇的节奏和主要阅读体验中兑现这些选择；允许局部气质变化，不要求逐段兑现。不靠题材标签、形容词或几句俏皮对白冒充实现。若已确认路径缺少相关事件，不得擅自新增关键事实来补齐。'
  const preference = note
    ? `作者希望最终故事兑现的创作要求（不是已经发生的事实）：${note}\n这不是可随意忽略的气氛参考。方向阶段要给出通向它的合理因果空间；选定方向后，曲线和正文应通过可观察的行动、变化或收束兑现，而非仅复述愿望或贴标签。不能把愿望直接写成已发生结果，也不能为了兑现要求违背作者事实、明确未知或已确认路径；若路径与要求冲突，应明确暴露冲突，不能暗中忽略或擅自补造关键事件。`
    : ''
  return `作者选择的创作倾向（服从作者明确事实和已确认路径）：\n感觉与戏剧力量描述整篇故事的主要体验及推进方式，不是每张卡、每个事件或每段文字的即时配额。搞笑可以先认真铺垫，也可以有紧张、温暖或抒情片段；其他感觉和力量同样允许蓄势、间歇和局部变化。未展开的阶段保留合理发展空间即可，不为了当下贴合标签硬加笑点、反转、代价或危机；整篇完成后才综合判断是否兑现。作者明确指定某个场景或结尾的具体要求，仍按其指定范围执行。\n${choices.join('\n')}${choices.length && preference ? '\n' : ''}${preference}\n${stageRule}`
}
