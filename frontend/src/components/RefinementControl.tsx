import { useId, useState } from 'react'
import { PenLine, RefreshCcw, SlidersHorizontal } from 'lucide-react'

export interface RefinementControlOption<TFocus extends string> {
  focus: TFocus
  label: string
  placeholder: string
}

interface RefinementControlProps<TFocus extends string> {
  ariaLabel: string
  appliedRefinement: { focus: TFocus; feedback: string } | undefined
  options: readonly RefinementControlOption<TFocus>[]
  defaultFocus: TFocus
  openLabel: string
  openButtonClassName?: string
  focusLegend: string
  disabled?: boolean
  onApply: (focus: TFocus, feedback: string) => Promise<void>
  onRegenerate?: () => Promise<void>
  regenerateLabel?: string
}

export function RefinementControl<TFocus extends string>({
  ariaLabel,
  appliedRefinement,
  options,
  defaultFocus,
  openLabel,
  openButtonClassName,
  focusLegend,
  disabled = false,
  onApply,
  onRegenerate,
  regenerateLabel,
}: RefinementControlProps<TFocus>) {
  const feedbackId = useId()
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [focus, setFocus] = useState<TFocus>(defaultFocus)
  const [feedbackDraft, setFeedbackDraft] = useState('')
  const trimmedFeedback = feedbackDraft.trim()
  const selectedOption = options.find((option) => option.focus === focus) ?? options[0]
  const appliedOption = appliedRefinement
    ? options.find((option) => option.focus === appliedRefinement.focus)
    : undefined

  const openForm = () => {
    setFocus(appliedRefinement?.focus ?? defaultFocus)
    setFeedbackDraft(appliedRefinement?.feedback ?? '')
    setIsFormOpen(true)
  }

  const closeForm = () => {
    setIsFormOpen(false)
    setFeedbackDraft('')
  }

  const submitRefinement = async () => {
    if (!trimmedFeedback) return
    await onApply(focus, trimmedFeedback)
    closeForm()
  }

  return (
    <section className={`refinement-control ${isFormOpen ? 'is-open' : ''}`} aria-label={ariaLabel}>
      {appliedRefinement && (
        <p className="refinement-control-status"><SlidersHorizontal size={14} /> 本次调整 · {appliedOption?.label}：{appliedRefinement.feedback}</p>
      )}
      {!isFormOpen ? (
        <div className="refinement-control-actions">
          {onRegenerate && regenerateLabel && (
            <button className="text-action" type="button" onClick={() => void onRegenerate()} disabled={disabled}><RefreshCcw size={15} /> {regenerateLabel}</button>
          )}
          <button className={`text-action ${openButtonClassName ?? ''}`.trim()} type="button" onClick={openForm} disabled={disabled}><PenLine size={15} /> {openLabel}</button>
        </div>
      ) : (
        <form className="refinement-control-form" onSubmit={(event) => { event.preventDefault(); void submitRefinement() }}>
          <fieldset>
            <legend>{focusLegend}</legend>
            <div className="refinement-control-focus" role="group" aria-label={focusLegend}>
              {options.map((option) => (
                <button
                  className={option.focus === focus ? 'is-selected' : ''}
                  type="button"
                  onClick={() => setFocus(option.focus)}
                  aria-pressed={option.focus === focus}
                  disabled={disabled}
                  key={option.focus}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
          <label htmlFor={feedbackId}>具体想怎么调整？</label>
          <textarea
            id={feedbackId}
            value={feedbackDraft}
            onChange={(event) => setFeedbackDraft(event.target.value)}
            placeholder={selectedOption.placeholder}
            maxLength={160}
            rows={3}
            disabled={disabled}
            autoFocus
          />
          <div className="refinement-control-form-actions">
            <small>{feedbackDraft.length} / 160</small>
            <span>
              <button className="text-action" type="button" onClick={closeForm} disabled={disabled}>取消</button>
              <button className="secondary-action refinement-control-submit" type="submit" disabled={disabled || !trimmedFeedback}><RefreshCcw size={15} /> 按此调整</button>
            </span>
          </div>
        </form>
      )}
    </section>
  )
}
