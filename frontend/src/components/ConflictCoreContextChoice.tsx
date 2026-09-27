import { ArrowRight, CircleAlert, PencilLine, Sparkles } from 'lucide-react'
import { ConflictCoreContextPanel } from './ConflictCoreContextPanel'

interface ConflictCoreContextChoiceProps {
  idea: string
  disabled?: boolean
  hasSystemDraftGenerationFailure?: boolean
  onGenerateSystemDraft: () => void
  onChooseManualContext: () => void
}

export function ConflictCoreContextChoice({
  idea,
  disabled = false,
  hasSystemDraftGenerationFailure = false,
  onGenerateSystemDraft,
  onChooseManualContext,
}: ConflictCoreContextChoiceProps) {
  return (
    <ConflictCoreContextPanel
      idea={idea}
      titleId="conflict-core-context-choice-title"
      eyebrow="这条念头还缺少能支撑三种冲突的事实。"
      title="先决定怎么补足这一步"
      note="系统可以先提出一组可修改的暂定设定，或由你直接确认故事前提。"
    >
      {hasSystemDraftGenerationFailure && (
        <p className="conflict-core-context-notice" role="status">
          <CircleAlert size={15} aria-hidden="true" />
          <span>系统的上一版建议没有自动采用。你可以直接再试一次，或自己补充设定。</span>
        </p>
      )}
      <div className="conflict-core-context-routes" role="group" aria-label="补充设定方式">
        <button className="conflict-core-context-route is-system" type="button" onClick={onGenerateSystemDraft} disabled={disabled}>
          <span className="conflict-core-context-route-icon" aria-hidden="true"><Sparkles size={17} /></span>
          <span className="conflict-core-context-route-copy"><strong>{hasSystemDraftGenerationFailure ? '让系统再给一版' : '让系统先给一版'}</strong><small>系统会补一组共同起点，并拆成三条互斥方向；内容都会明确标为暂定设定。</small></span>
          <ArrowRight size={17} aria-hidden="true" />
        </button>
        <button className="conflict-core-context-route" type="button" onClick={onChooseManualContext} disabled={disabled}>
          <span className="conflict-core-context-route-icon" aria-hidden="true"><PencilLine size={17} /></span>
          <span className="conflict-core-context-route-copy"><strong>我来补充设定</strong><small>你提交的内容会作为故事事实保留。</small></span>
          <ArrowRight size={17} aria-hidden="true" />
        </button>
      </div>
    </ConflictCoreContextPanel>
  )
}
