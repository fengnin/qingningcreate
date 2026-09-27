import { useState, type FormEvent } from 'react'
import { CircleAlert, Heart, RefreshCcw, Target, type LucideIcon } from 'lucide-react'
import { ConflictCoreContextPanel } from './ConflictCoreContextPanel'
import { normalizeConflictCoreContext } from '../story/conflictCoreContext'
import type {
  StoryConflictCoreContext,
  StoryConflictCoreContextPrefill,
  StoryConflictCoreSystemDraft,
} from '../story/types'

interface ConflictCoreContextFormProps {
  idea: string
  initialContext: StoryConflictCoreContext
  prefill?: StoryConflictCoreContextPrefill
  systemDraft?: StoryConflictCoreSystemDraft
  isSystemDraftRecovery?: boolean
  disabled?: boolean
  onApplyContext: (context: StoryConflictCoreContext) => Promise<void>
}

type ConflictCoreContextField = keyof StoryConflictCoreContext

interface ConflictCoreContextFieldDefinition {
  field: ConflictCoreContextField
  Icon: LucideIcon
  label: string
  placeholder: string
}

const conflictCoreContextFieldDefinitions: readonly ConflictCoreContextFieldDefinition[] = [
  {
    field: 'goal',
    Icon: Target,
    label: '主角此刻想做什么？',
    placeholder: '例如：想主动和对方说几句话',
  },
  {
    field: 'stake',
    Icon: Heart,
    label: '主角最在意什么？',
    placeholder: '例如：不想失去这次把话说清楚的机会',
  },
  {
    field: 'constraint',
    Icon: CircleAlert,
    label: '已经有什么限制？',
    placeholder: '例如：不知道对方是否愿意回应，而且时间有限',
  },
]

export function ConflictCoreContextForm({
  idea,
  initialContext,
  prefill,
  systemDraft,
  isSystemDraftRecovery = false,
  disabled = false,
  onApplyContext,
}: ConflictCoreContextFormProps) {
  const [draft, setDraft] = useState<StoryConflictCoreContext>(initialContext)
  const confirmedContext = normalizeConflictCoreContext(draft)
  const contextNote = getConflictCoreContextNote(prefill, systemDraft, isSystemDraftRecovery)

  const updateDraft = (field: ConflictCoreContextField, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const submitContext = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!confirmedContext) return
    void onApplyContext(confirmedContext)
  }

  return (
    <ConflictCoreContextPanel
      idea={idea}
      titleId="conflict-core-context-title"
      eyebrow="这条念头还缺少能支撑冲突的事实。"
      title="补充故事设定"
      note={contextNote}
      noteId="conflict-core-context-note"
    >
      <form className="conflict-core-context-form" onSubmit={submitContext}>
        <div className="conflict-core-context-fields">
          {conflictCoreContextFieldDefinitions.map(({ field, Icon, label, placeholder }) => (
            <ContextField
              field={field}
              Icon={Icon}
              key={field}
              label={label}
              placeholder={placeholder}
              value={draft[field] ?? ''}
              sourceText={prefill?.[field]}
              systemText={systemDraft?.[field]}
              onChange={updateDraft}
            />
          ))}
        </div>
        <div className="conflict-core-context-actions">
          <small>补充内容会作为已确认事实保留。</small>
          <button className="primary-action conflict-core-context-submit" type="submit" disabled={disabled || !confirmedContext}>
            按这些设定重新生成 <RefreshCcw size={16} />
          </button>
        </div>
      </form>
    </ConflictCoreContextPanel>
  )
}

function getConflictCoreContextNote(
  prefill: StoryConflictCoreContextPrefill | undefined,
  systemDraft: StoryConflictCoreSystemDraft | undefined,
  isSystemDraftRecovery: boolean,
): string {
  if (systemDraft) {
    if (isSystemDraftRecovery) {
      return '系统给出的暂定设定没有自动采用。你可以直接修改并确认；提交后才会成为你确认的故事事实。'
    }

    return '以下内容来自系统暂定设定，可直接修改；提交后才会成为你确认的故事事实。'
  }

  if (conflictCoreContextFieldDefinitions.some(({ field }) => Boolean(prefill?.[field]))) {
    return '系统已从原始念头填入明确内容；空白项再由你补充。'
  }

  return '只填写你愿意确认进入故事的设定，至少补充一项。'
}

function ContextField({
  field,
  Icon,
  label,
  placeholder,
  value,
  sourceText,
  systemText,
  onChange,
}: {
  field: ConflictCoreContextField
  Icon: LucideIcon
  label: string
  placeholder: string
  value: string
  sourceText?: string
  systemText?: string
  onChange: (field: ConflictCoreContextField, value: string) => void
}) {
  const id = `conflict-core-context-${field}`
  const sourceLabel = getConflictCoreContextSourceLabel(sourceText, systemText, value)

  return (
    <label className="conflict-core-context-field" htmlFor={id}>
      <span><i aria-hidden="true"><Icon size={15} /></i>{label}<small>{sourceLabel ? `${sourceLabel} · ` : ''}{value.length} / 120</small></span>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(field, event.target.value)}
        placeholder={placeholder}
        maxLength={120}
        rows={3}
        aria-describedby="conflict-core-context-note"
      />
    </label>
  )
}

function getConflictCoreContextSourceLabel(
  sourceText: string | undefined,
  systemText: string | undefined,
  value: string,
): string | undefined {
  if (sourceText && sourceText === value) return '原文'
  if (systemText && systemText === value) return '系统暂定'
  return undefined
}
