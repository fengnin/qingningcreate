import { RefinementControl, type RefinementControlOption } from './RefinementControl'
import type {
  StoryHeadTailOption,
  StoryHeadTailRefinement,
  StoryHeadTailRefinementFocus,
} from '../story/types'

interface HeadTailRefinementControlProps {
  selectedOption: StoryHeadTailOption
  appliedRefinement: StoryHeadTailRefinement | undefined
  disabled?: boolean
  onApplyRefinement: (refinement: StoryHeadTailRefinement) => Promise<void>
}

const refinementOptions: RefinementControlOption<StoryHeadTailRefinementFocus>[] = [
  { focus: 'opening', label: '开场切入', placeholder: '例如：开场先突出眼前阻碍，不要立刻出现解决办法' },
  { focus: 'development', label: '推进与行动', placeholder: '例如：仍沿用这条方向，但不要让第一次尝试马上奏效' },
  { focus: 'resolution', label: '结尾结果', placeholder: '例如：结尾改成部分达成，保留一个真实的后续代价' },
  { focus: 'cost', label: '代价与取舍', placeholder: '例如：代价更现实一些，不要增加没有依据的精确数字' },
  { focus: 'tone', label: '情绪节奏', placeholder: '例如：节奏更克制，不要把这次联系写得过分煽情' },
]

export function HeadTailRefinementControl({
  selectedOption,
  appliedRefinement,
  disabled = false,
  onApplyRefinement,
}: HeadTailRefinementControlProps) {
  const appliedForOption = appliedRefinement?.optionId === selectedOption.id ? appliedRefinement : undefined

  return (
    <RefinementControl
      ariaLabel="调整已选故事两端"
      appliedRefinement={appliedForOption}
      options={refinementOptions}
      defaultFocus="opening"
      openLabel="调整已选方案"
      focusLegend="调整重点"
      disabled={disabled}
      onApply={(focus, feedback) => onApplyRefinement({ optionId: selectedOption.id, focus, feedback })}
    />
  )
}
