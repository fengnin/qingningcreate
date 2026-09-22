import { RefinementControl, type RefinementControlOption } from './RefinementControl'
import type {
  StoryTurnOptionsRefinement,
  StoryTurnOptionsRefinementFocus,
} from '../story/types'

interface StoryTurnOptionsRefinementControlProps {
  disabled?: boolean
  onApplyRefinement: (refinement: StoryTurnOptionsRefinement) => Promise<void>
}

const refinementOptions: RefinementControlOption<StoryTurnOptionsRefinementFocus>[] = [
  { focus: 'actions', label: '行动方向', placeholder: '例如：保留一个先确认情况的做法，不要三条都立刻行动' },
  { focus: 'consequences', label: '后果与代价', placeholder: '例如：不要让每条都马上奏效，把代价写得更真实一些' },
  { focus: 'contrast', label: '三条差异', placeholder: '例如：让三条分别体现尝试、求助和等待的不同取舍' },
  { focus: 'tone', label: '情绪走向', placeholder: '例如：整体克制一些，不要把眼前的紧张马上化解' },
]

export function StoryTurnOptionsRefinementControl({
  disabled = false,
  onApplyRefinement,
}: StoryTurnOptionsRefinementControlProps) {
  return (
    <div className="turn-options-refinement">
      <RefinementControl
        ariaLabel="调整这三种选择"
        appliedRefinement={undefined}
        options={refinementOptions}
        defaultFocus="actions"
        openLabel="调整这三种选择"
        openButtonClassName="turn-options-refinement-open"
        focusLegend="想调整哪一部分？"
        disabled={disabled}
        onApply={(focus, feedback) => onApplyRefinement({ focus, feedback })}
      />
    </div>
  )
}
