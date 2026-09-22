import { RefinementControl, type RefinementControlOption } from './RefinementControl'
import type {
  StoryPredicamentRefinement,
  StoryPredicamentRefinementFocus,
} from '../story/types'

interface PredicamentRefinementControlProps {
  appliedRefinement: StoryPredicamentRefinement | undefined
  disabled?: boolean
  onApplyRefinement: (refinement: StoryPredicamentRefinement) => Promise<void>
  onRegenerate: () => Promise<void>
}

const refinementOptions: RefinementControlOption<StoryPredicamentRefinementFocus>[] = [
  { focus: 'scene', label: '当前场景', placeholder: '例如：场景简单一些，不要出现陌生人物' },
  { focus: 'urgency', label: '紧迫性', placeholder: '例如：时间不要这么紧，但要有现在必须处理的理由' },
  { focus: 'facts', label: '暂定事实', placeholder: '例如：不要加入危险提示或未经说明的规则' },
  { focus: 'approaches', label: '应对方向', placeholder: '例如：第二条方向改成先询问负责人' },
  { focus: 'costs', label: '代价与不确定性', placeholder: '例如：代价更现实一些，不要出现受伤风险' },
]

export function PredicamentRefinementControl({
  appliedRefinement,
  disabled = false,
  onApplyRefinement,
  onRegenerate,
}: PredicamentRefinementControlProps) {
  return (
    <RefinementControl
      ariaLabel="调整当前困境"
      appliedRefinement={appliedRefinement}
      options={refinementOptions}
      defaultFocus="scene"
      openLabel="调整这版"
      focusLegend="想调整哪个部分？"
      disabled={disabled}
      onApply={(focus, feedback) => onApplyRefinement({ focus, feedback })}
      onRegenerate={onRegenerate}
      regenerateLabel="换一个具体场景"
    />
  )
}
