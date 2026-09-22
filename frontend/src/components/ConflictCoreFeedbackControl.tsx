import { useState, type KeyboardEvent } from 'react'
import { PenLine, RefreshCcw } from 'lucide-react'

interface ConflictCoreFeedbackControlProps {
  appliedFeedback: string
  disabled?: boolean
  onApplyFeedback: (feedback: string) => Promise<void>
  onShowDifferentConflictCores: () => Promise<void>
}

export function ConflictCoreFeedbackControl({
  appliedFeedback,
  disabled = false,
  onApplyFeedback,
  onShowDifferentConflictCores,
}: ConflictCoreFeedbackControlProps) {
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
    <section className={`conflict-core-refine ${isFormOpen ? 'is-open' : ''}`} aria-label="调整冲突核心">
      {!isFormOpen ? (
        <div className="conflict-core-refine-actions">
          <button className="text-action" type="button" onClick={() => void onShowDifferentConflictCores()} disabled={disabled}><RefreshCcw size={15} /> 换一种阻碍看看</button>
          <button className="text-action" type="button" onClick={openFeedbackForm} disabled={disabled}><PenLine size={15} /> 说说你想看的感觉</button>
        </div>
      ) : (
        <div className="conflict-core-refine-form">
          <label htmlFor="conflict-core-feedback">这一次，你更想让它遇到怎样的阻碍？</label>
          <input
            id="conflict-core-feedback"
            value={feedbackDraft}
            onChange={(event) => setFeedbackDraft(event.target.value)}
            onKeyDown={handleFeedbackKeyDown}
            placeholder="例如：时间更紧，或关系上更难选择"
            maxLength={80}
            autoFocus
          />
          <div>
            <button className="text-action" type="button" onClick={closeFeedbackForm} disabled={disabled}>取消</button>
            <button className="secondary-action conflict-core-refine-submit" type="button" onClick={() => void submitFeedback()} disabled={disabled || !trimmedFeedbackDraft}><RefreshCcw size={15} /> 带着这个想法再看看</button>
          </div>
        </div>
      )}
    </section>
  )
}
