import { Undo2 } from 'lucide-react'
import type { StoryPredicamentApproach } from '../story/types'

interface StoryProgressControlProps {
  selectedApproach: StoryPredicamentApproach | undefined
  canUndo: boolean
  disabled?: boolean
  onUndo: () => Promise<void>
}

export function StoryProgressControl({
  selectedApproach,
  canUndo,
  disabled = false,
  onUndo,
}: StoryProgressControlProps) {
  if (!selectedApproach) return null

  return (
    <section className="story-progress-control" aria-label="已选方案">
      <div className="story-progress-summary">
        <div>
          <span>已选方案</span>
          <strong>{selectedApproach.intent}</strong>
        </div>
        <small>代价：{selectedApproach.cost}</small>
        {canUndo && (
          <button
            className="story-progress-undo"
            type="button"
            onClick={() => void onUndo()}
            disabled={disabled}
            aria-label="回退上一步"
            title="回退上一步"
          >
            <Undo2 size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  )
}
