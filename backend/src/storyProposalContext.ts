import type { ConfirmedCurve, StorySeed, StoryTurnHistoryItem } from '../../shared/story-contract.js'
import { activePreparationMaterial } from './storyPreparation.js'

/** Generation context separates narrative evidence from reviewed story design.
 * None of these roles is inferred from a date, an object name or a keyword. */
export function createStoryProposalContext(
  seed: StorySeed,
  curve: ConfirmedCurve,
  history: StoryTurnHistoryItem[],
  selectedFocus: string[],
) {
  const authorTexts = curve.preparation
    ? activePreparationMaterial(curve.preparation).filter(item => item.role !== 'unknown').map(item => item.quote)
    : [...new Set([
    seed.lockedGoal ?? '', ...seed.lockedFacts,
    ...(curve.design?.sourceFacts.filter((f) => f.disposition === 'integrated').map((f) => f.text) ?? []),
  ].filter((text) => text.trim()))]
  const executedHistory = history.flatMap((item) => {
    const { narrativeAction, transition } = item.selectedOption
    const receipt = transition.authorConfirmation
    if (narrativeAction.mode !== 'executed' || !receipt) return []
    // A receipt must match the exact result. Historical model prose, even in a
    // saved history entry, is never promoted to evidence by this adapter.
    const resultFacts = transition.introducedFacts.filter((f) => f.statement === receipt.resultText)
    if (narrativeAction.intent !== receipt.actionText || resultFacts.length !== 1) return []
    return [{ turnId: item.turnId, actionText: receipt.actionText, resultText: receipt.resultText,
      factId: resultFacts[0]!.id }]
  })
  const sourceFacts = [
    ...authorTexts.map((text, index) => ({ id: `author-${index + 1}`, text, authority: 'author-material' as const })),
    ...executedHistory.map((item) => ({ id: item.factId, text: item.resultText, authority: 'author-confirmed-result' as const })),
  ]
  const designBeats = curve.beats.filter((beat) => beat.status !== 'rejected').map((beat) => ({
    id: beat.id, kind: beat.kind, text: beat.detail, dependsOn: beat.dependsOn,
    authority: beat.source === 'user-edit' ? 'author-design' as const : 'reviewed-system-design' as const,
  }))
  const authorEdits = designBeats.filter((beat) => beat.authority === 'author-design')
  const unresolvedQuestions = (curve.clarifications ?? [])
    .filter((q) => q.status !== 'confirmed' && !q.resolution).map((q) => ({
      id: q.id, prompt: q.prompt, status: q.status,
      // Raw unconfirmed answers remain review material, never sourceFacts.
      ...(q.answerText === undefined ? {} : { answerText: q.answerText }),
      beatIds: q.dependency.beatIds, causalGap: q.dependency.causalGap,
      unknownHandling: q.unknownHandling,
    }))
  return {
    subject: seed.subject, goal: seed.lockedGoal, sourceFacts,
    authorEdits, designBeats, unresolvedQuestions, selectedFocus,
    executedHistory,
    lastAuthorConfirmedResult: executedHistory.at(-1) ?? null,
    priorities: [
      '承接最近已确认的实际结果，不把已执行行动重新当作待执行行动。',
      '保留作者编辑的行动对象、约束及尚待决定的部分，系统节点不覆盖作者编辑。',
      '关注点只是审阅角度；结合完整目标和相关编辑，不把被点选的单一材料替换成整个故事任务。',
      '设计节点与条件句不是已发生事件；未确认回答及未知因果不得用作成立的前提。',
    ],
  }
}

export const storyProposalGenerationInstruction = `你是中文故事共创提案编辑。生成具体、成立、可审阅的下一步行动，不生成既成事件或事实状态。
先读完整上下文：sourceFacts 是作者材料或逐字确认的实际结果；authorEdits 是作者设计意图而非已发生事实；designBeats 只给结构方向，不能替代因果证据。executedHistory 是已确认行动结果。selectedFocus 是关注角度，不是执行授权，也不能使作者编辑的核心问题消失。
行动、约束和代价分开：行动须说明谁针对什么对象做什么；目标与期限、承诺、资源条件都不是行动选项。比较解决同一当前问题的不同做法，不把可同时满足的条件硬写成二选一。没有期限就不制造倒计时；已有条件可兼容就不声称必然冲突。
因果依据：事实并列不等于因果，引用 ID 不等于证明。仅作者明确写出的因果关系可以作为成立的理由；从物件用途、关系身份、期限或承诺推断出的能力、动机、权限、回应和代价都不是已知。不要通过新增人员、机构、设备、流程或便利权限绕开核心问题。
给三项有实质差异的候选。优先使用已有行动对象和条件。若一项行动依赖未知前提，把整项写成条件性候选，同时在 causalClaims 列出每个依赖，在 questions 提出能核对它的具体问题；不得把未知前提写成确定句。资料不足时可以给围绕该缺口的具体核对行动，明确哪些决定尚不能作出，不能凑出三个伪选择。作者明确保留未知时，提供不依赖该前提的审阅行动，不替作者回答。
编辑承接：优先推进 authorEdits 指向的行动与问题；期限仍作约束，不把编辑后的任务变成归还安排等旁支。最近确认结果已解决的事项不能再重复，不推断其未写出的其他后果；后续行动要处理作者仍未解决的部分。
action 是候选行动，不是执行结果；proposedConsequence 须区分作者已有因果与待核对的条件性承接，不能保证未获证实的效果。整个候选留在待审区不意味着内容合格。不要引用系统模板作为理由。
严格输出 JSON 对象 candidatePlan，不输出 turn、transition、introducedFacts、review 或任何确认凭证。`
