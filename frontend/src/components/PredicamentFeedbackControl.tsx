import { useState, type KeyboardEvent } from 'react'
import { PenLine, RefreshCcw } from 'lucide-react'

interface PredicamentFeedbackControlProps {
  appliedFeedback: string
  disabled?: boolean
  onApplyFeedback: (feedback: string) => Promise<void>
  onShowDifferentPredicaments: () => Promise<void>
}

export function PredicamentFeedbackControl({
  appliedFeedback,
  disabled = false,
  onApplyFeedback,
  onShowDifferentPredicaments,
}: PredicamentFeedbackControlProps) {
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [feedbackDraft, setFeedbackDraft] = useState('')
  const trimmedFeedbackDraft = feedbackDraft.trim()

  const openFeedbackForm = () => {
    setFeedbackDraft(appliedFeedback)
    setIsFormOpen(true)
  }

  const closeFeedbackForm = () => {
    setIsFormOpen(false)
    setFeedbackDraft('')
  }

  const submitFeedback = async () => {
    if (!trimmedFeedbackDraft) return

    await onApplyFeedback(trimmedFeedbackDraft)
    closeFeedbackForm()
  }

  const handleFeedbackKeyDown = async (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') await submitFeedback()
  }

  return (
    <section className={`direction-refine ${isFormOpen ? 'is-open' : ''}`} aria-label="调整故事困境">
      {!isFormOpen ? (
        <div className="direction-refine-actions">
          <button className="text-action" type="button" onClick={() => void onShowDifferentPredicaments()} disabled={disabled}><RefreshCcw size={15} /> 换一种阻碍看看</button>
          <button className="text-action" type="button" onClick={openFeedbackForm} disabled={disabled}><PenLine size={15} /> 说说你想看的感觉</button>
        </div>
      ) : (
        <div className="direction-refine-form">
          <label htmlFor="direction-feedback">这一次，你更想让它遇到怎样的难处？</label>
          <input
            id="direction-feedback"
            value={feedbackDraft}
            onChange={(event) => setFeedbackDraft(event.target.value)}
            onKeyDown={handleFeedbackKeyDown}
            placeholder="例如：更悬疑一些，结尾别太轻松"
            maxLength={80}
            autoFocus
          />
          <div>
            <button className="text-action" type="button" onClick={closeFeedbackForm} disabled={disabled}>取消</button>
            <button className="secondary-action direction-refine-submit" type="button" onClick={() => void submitFeedback()} disabled={disabled || !trimmedFeedbackDraft}><RefreshCcw size={15} /> 带着这个想法再看看</button>
          </div>
        </div>
      )}
    </section>
  )
}
