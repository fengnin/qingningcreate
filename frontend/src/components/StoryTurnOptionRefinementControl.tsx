import { RefinementControl, type RefinementControlOption } from './RefinementControl'
import type {
  StoryTurnOption,
  StoryTurnOptionRefinement,
  StoryTurnOptionRefinementFocus,
} from '../story/types'

interface StoryTurnOptionRefinementControlProps {
  option: StoryTurnOption
  disabled?: boolean
  onRefine: (refinement: StoryTurnOptionRefinement) => Promise<void>
}

const refinementOptions: RefinementControlOption<StoryTurnOptionRefinementFocus>[] = [
  { focus: 'action', label: '行动方式', placeholder: '例如：先确认情况再行动，不要让这条马上解决问题' },
  { focus: 'consequence', label: '当下结果', placeholder: '例如：结果别太顺利，保留一个需要继续处理的后果' },
  { focus: 'tradeoff', label: '代价取舍', placeholder: '例如：代价更现实一些，但不要新增没有依据的设定' },
  { focus: 'tone', label: '情绪走向', placeholder: '例如：整体克制一些，不要把眼前的紧张马上化解' },
]

export function StoryTurnOptionRefinementControl({
  option,
  disabled = false,
  onRefine,
}: StoryTurnOptionRefinementControlProps) {
  return (
    <div className="turn-option-refinement">
      <RefinementControl
        ariaLabel={`调整选项：${option.label}`}
        appliedRefinement={undefined}
        options={refinementOptions}
        defaultFocus="action"
        openLabel="调整此项"
        focusLegend="想调整哪一部分？"
        disabled={disabled}
        onApply={(focus, feedback) => onRefine({ optionId: option.id, focus, feedback })}
      />
    </div>
  )
}
