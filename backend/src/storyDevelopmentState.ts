import { shape as s } from './modelOutputSchema.js'

/** Internal design state, never author facts or an execution receipt. */
export interface DevelopmentState {
  means: { id: string; capability: string; status: 'available' | 'unavailable' | 'uncertain' }[]
  methodUses: { meansId: string; mode: 'rely' | 'test' }[]
  outcome: 'success' | 'partial' | 'failure' | 'uncertain'
  states: { id: string; statement: string; status: 'holds' | 'absent' | 'uncertain' }[]
  choiceRequires: { stateId: string; status: 'holds' | 'absent' | 'uncertain' }[]
}

export const developmentFields = {
  means: s.array(s.object({ id: s.text, capability: s.text, status: s.enum('available', 'unavailable', 'uncertain') }), 1, 3),
  methodUses: s.array(s.object({ meansId: s.text, mode: s.enum('rely', 'test') }), 1, 3),
}
export const developmentResultFields = {
  outcome: s.enum('success', 'partial', 'failure', 'uncertain'),
  states: s.array(s.object({ id: s.text, statement: s.text, status: s.enum('holds', 'absent', 'uncertain') }), 1, 5),
}
export const developmentChoiceSchema = s.object({ text: s.text,
  requires: s.array(s.object({ stateId: s.text, status: s.enum('holds', 'absent', 'uncertain') }), 0, 5) })

/** Compare declared dependencies only. Matching IDs do not establish that the
 * model's description is true; the semantic reviewer still sees all prose. */
export function developmentStateIssues(plan: DevelopmentState): { issueType: 'causal-gap' | 'world-implausible'; reason: string }[] {
  const issues: ReturnType<typeof developmentStateIssues> = []
  for (const use of plan.methodUses) {
    const means = plan.means.find(item => item.id === use.meansId)
    if (means && use.mode === 'rely' && means.status !== 'available') issues.push({ issueType: 'world-implausible',
      reason: `办法依赖能力“${means.capability}”，但本条将其标为${means.status}。可改用可用手段，或保留试用失败及其后果；不要凭空补能力。` })
  }
  for (const requirement of plan.choiceRequires) {
    const state = plan.states.find(item => item.id === requirement.stateId)
    if (state && requirement.status !== state.status) issues.push({ issueType: 'causal-gap',
      reason: `后续选择要求“${state.statement}”为${requirement.status}，但本次结果状态为${state.status}。使结果与选择一致，保留尚未确定的条件，不另加麻烦圆场。` })
  }
  return issues
}

export const developmentStateGuidance = `按每条方向连续构造：先确定这次办法实际可用的能力，再写人物办法和可能结果，记下结果状态，最后依据这些状态写后续选择。内部状态只是本条未来设计，不是已发生事实。
means只列直接支持办法的1至3项实际手段或条件，可为设备、信息、权限、奇幻能力或普通互动；日常相处只记“当面交谈”等一项即可，不拆成技术步骤。只把明确不可用的能力标unavailable；普通合理能力可用，未说明特殊资格不代表没有资格。不替无关细节补背景。methodUses列办法实际依赖的meansId，至少1项，rely要求available；试探尚不确定或不可用的能力用test，不保证奏效。遵守作者限制和故事世界；不能只把预期效果写成一个“可用能力”就认为途径成立。capability与statement尽量在40字以内。
outcome可为success、partial、failure或uncertain，无需保住上一版好结果。states只记这次发展中影响下一步的1至5个关键状态，statement用单一、简短的肯定命题，不把多个人物或多个条件合成一项，status为holds（本条结果中成立）、absent（不成立）或uncertain（仍未确定），如人物状态、持有物、知识或机会；不强制涉及受伤、故障或技术。先确定状态，再写futureChoice，不能因后续需要另改状态。
futureChoice.requires只记录作出这次选择时实际依据的当前状态，status可为holds、absent或uncertain，须与states一致。尚未确定就填uncertain，不能用absent代替“不知道”；如“同桌已读纸条”为uncertain，下一步选择核实还是暂不追问，requires也填uncertain，不预先判定读过或没读过。条件分支中将要争取、测试或改变的状态不是眼前已具备的前提，不填成holds或absent；仅与选择无关的状态可省略。新事件或未来行动可以改变状态，但须写清改变的行动与条件，不把将来可能发生的事当作眼前既成条件。means和states的ID只在本条内部使用，不写入正文，不冒充作者材料引用。无需输出推理过程。`
