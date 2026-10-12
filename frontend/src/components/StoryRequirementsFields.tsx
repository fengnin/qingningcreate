import type { CreativeBrief } from '../story/types'

const fields = [
  { key: 'setting', label: '已确定的设定', placeholder: '例如：青柠怕高，同行的是她的姐姐。' },
  { key: 'direction', label: '希望故事怎样发展', placeholder: '例如：两个人从争执到理解彼此。' },
  { key: 'boundaries', label: '必须保留或避免的内容', placeholder: '例如：不坐过山车；不要加入魔法。' },
] as const

export function StoryRequirementsFields({ brief, onChange, disabled = false }: {
  brief: CreativeBrief
  onChange: (brief: CreativeBrief) => void
  disabled?: boolean
}) {
  const count = fields.filter(f => brief.storyRequirements?.[f.key]?.trim()).length
  return <details className="story-requirements">
    <summary>补充故事要求 <small>{count ? `已填写 ${count} 项，可修改` : '可选'}</small></summary>
    <p>一句想法就能开始。写过的内容不用重复填写。</p>
    {fields.map(field => <label key={field.key}>
      <span>{field.label}</span>
      <textarea value={brief.storyRequirements?.[field.key] ?? ''}
        onChange={e => onChange({ ...brief, storyRequirements: { ...brief.storyRequirements, [field.key]: e.target.value } })}
        placeholder={field.placeholder} maxLength={240} disabled={disabled} />
    </label>)}
    <p>未指定的情节由系统构思，生成后你可以修改。</p>
  </details>
}
