import type { ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'

interface ConflictCoreContextPanelProps {
  idea: string
  titleId: string
  eyebrow: string
  title: string
  note: ReactNode
  noteId?: string
  children: ReactNode
}

export function ConflictCoreContextPanel({
  idea,
  titleId,
  eyebrow,
  title,
  note,
  noteId,
  children,
}: ConflictCoreContextPanelProps) {
  return (
    <section className="conflict-core-context" aria-labelledby={titleId}>
      <div className="conflict-core-context-heading">
        <span className="conflict-core-context-icon" aria-hidden="true"><CircleAlert size={17} /></span>
        <div>
          <p>{eyebrow}</p>
          <h2 id={titleId}>{title}</h2>
          <p id={noteId}>{note}</p>
        </div>
      </div>
      <div className="conflict-core-context-idea" aria-label="原始念头">
        <span>原始念头</span>
        <strong>{idea}</strong>
      </div>
      {children}
    </section>
  )
}
