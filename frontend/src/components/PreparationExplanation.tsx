import { useRef, useState } from 'react'
import { PencilLine, RefreshCcw } from 'lucide-react'
import type { StoryPreparationCandidate, StoryPreparationExplanation, StoryExpansionNeed } from '../../../shared/story-preparation.js'
import { requestPreparationExplanation } from '../story/storyApi'

type Wording = StoryPreparationExplanation['wording']
export function explanationMatches(a: Wording, b: Wording) {
  return a.action === b.action && a.possibleResult === b.possibleResult && (a.futureChoice ?? '') === (b.futureChoice ?? '')
}

export function currentExplanationNeeds(explanation: StoryPreparationExplanation) {
  const prose = { ...explanation.wording, method: explanation.method, change: explanation.change }
  return (explanation.expansionNeeds ?? []).filter(need => need.anchors.every(a => prose[a.field] === a.quote))
}

const expansionLabels = { setup: '因果铺垫', 'action-detail': '关键行动', 'response-detail': '重要回应',
  'character-detail': '人物变化', 'emotional-beat': '情绪效果', payoff: '反差与呼应' }
export function ExplanationExpansionNotes({ value }: { value: StoryPreparationExplanation }) {
  const needs = currentExplanationNeeds(value)
  return needs.length ? <div className="preparation-explanation-expansion"><strong>留到正文展开</strong><p>保留值得兑现的故事作用，随采用的解释保存。普通细节在正文自然补足。</p>{needs.map((need, i) => <p key={i}><small>{expansionLabels[need.kind]}</small> · {need.anchors.map(a => a.quote).join('；')}</p>)}</div> : null
}

export function PreparationExplanation({ candidate, wording, explanation, disabled, storyId, revision, curveId, onChange }: {
  candidate: StoryPreparationCandidate; wording: Wording; explanation?: StoryPreparationExplanation; disabled: boolean
  storyId?: string; revision: number; curveId: string; onChange: (value: StoryPreparationExplanation) => void
}) {
  const [preview, setPreview] = useState<StoryPreparationExplanation>()
  const [history, setHistory] = useState<StoryPreparationExplanation[]>([])
  const [draft, setDraft] = useState<StoryPreparationExplanation>()
  const [needField, setNeedField] = useState<'action' | 'possibleResult' | 'futureChoice' | 'method' | 'change'>('action')
  const [needKind, setNeedKind] = useState<StoryExpansionNeed['kind']>('action-detail')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const requestLock = useRef(false)
  const baseline = candidate.explanation ?? (candidate.causalBridge ? {
    wording: { action: candidate.action, possibleResult: candidate.possibleResult, futureChoice: candidate.futureChoice },
    method: candidate.causalBridge.method, change: candidate.causalBridge.change, issues: [], source: 'system' as const, expansionNeeds: candidate.expansionNeeds,
  } : undefined)
  const current = explanation ?? baseline
  const stale = !current || !explanationMatches(current.wording, wording)
  const apply = (next: StoryPreparationExplanation) => {
    if (!explanationMatches(next.wording, wording)) return
    if (current) setHistory(items => [...items, current])
    onChange({ ...next, ...(next.expansionNeeds === undefined ? {} : { expansionNeeds: currentExplanationNeeds(next) }) })
    setDraft(undefined)
    setPreview(undefined)
  }
  const regenerate = async () => {
    if (!storyId || disabled || requestLock.current) return
    requestLock.current = true
    setGenerating(true)
    setError('')
    try {
      setPreview(await requestPreparationExplanation({ storyId, revision, curveId, candidate: {
        id: candidate.id, action: wording.action, possibleResult: wording.possibleResult,
        ...(wording.futureChoice === undefined ? {} : { futureChoice: wording.futureChoice }),
      } }))
    } catch (e) {
      setError(e instanceof Error ? e.message : '推演暂未完成，请重试。')
    } finally { requestLock.current = false; setGenerating(false) }
  }
  const show = (value: StoryPreparationExplanation) => <>
    <dl><dt>可能采取的办法</dt><dd>{value.method}</dd><dt>处境变化</dt><dd>{value.change}</dd></dl>
    <ExplanationExpansionNotes value={value} />
    {!!value.issues.length && <div className="preparation-explanation-issues"><strong>待作者判断</strong>{value.issues.map((issue, i) => <p key={i}>{issue}</p>)}</div>}
  </>
  return <div className="preparation-explanation">
    <p className="preparation-explanation-status" role="status">{!current ? '解释待补充' : stale ? '内容已修改，解释待核对' : explanation ? '当前解释 · 已由你采用' : '当前解释 · 系统提案'}</p>
    {stale && current && <p>点击“重新推演这张卡”，千问会结合最新四项内容生成新解释，供你决定是否采用。旧解释仍可查看，也可以手动编辑或核对后沿用。</p>}
    <p className="preparation-evidence-note">采用的解释会随“确认这个困境”一起保存。</p>
    {current ? <div className={stale ? 'is-stale' : undefined}>{stale && <small>旧解释 · 尚未核对当前内容</small>}{show(current)}</div> : <p>这张卡还没有推演解释。</p>}
    <div className="preparation-explanation-actions">
      <button className="text-action" type="button" disabled={disabled} onClick={() => setDraft({
        wording: { action: wording.action, possibleResult: wording.possibleResult, futureChoice: wording.futureChoice },
        method: current?.method ?? '', change: current?.change ?? '', issues: current?.issues ?? [], source: 'author',
        expansionNeeds: current?.expansionNeeds,
      })}><PencilLine size={14} /> 编辑解释</button>
      <button className="text-action" type="button" disabled={disabled || generating || !wording.action.trim() || !wording.possibleResult.trim()} onClick={() => void regenerate()}><RefreshCcw size={14} /> {generating ? '正在推演这张卡…' : '重新推演这张卡'}</button>
      {stale && current && <button className="text-action" type="button" disabled={disabled} onClick={() => apply({ ...current, wording: { action: wording.action, possibleResult: wording.possibleResult, futureChoice: wording.futureChoice }, source: 'author' })}>我已核对，沿用解释</button>}
    </div>
    {error && <p role="alert">{error} 当前解释和编辑已保留。</p>}
    {generating && <p role="status">新解释会先展示为预览，供你决定是否采用。</p>}
    {draft && <div className="preparation-explanation-editor">
      <label>可能采取的办法<textarea maxLength={240} disabled={disabled} value={draft.method} onChange={e => setDraft({ ...draft, method: e.target.value })} /></label>
      <label>处境变化<textarea maxLength={240} disabled={disabled} value={draft.change} onChange={e => setDraft({ ...draft, change: e.target.value })} /></label>
      <label>保留的问题或说明（每行一项，最多三项）<textarea maxLength={722} disabled={disabled} value={draft.issues.join('\n')} onChange={e => setDraft({ ...draft, issues: e.target.value.split('\n') })} /></label>
      <div className="preparation-expansion-editor"><strong>添加正文待展开标记</strong><p>保留让故事成立、体现人物、情绪或前后呼应的重要铺垫与过程，最多两项。普通细节交给正文；关键办法与选择应先确定。</p>
        <label>对应内容<select aria-label="待展开对应内容" disabled={disabled} value={needField} onChange={e => setNeedField(e.target.value as typeof needField)}>
          <option value="action">遇到的难处与眼前的选择</option><option value="futureChoice">故事将推向</option><option value="possibleResult">可能走向</option><option value="method">可能采取的办法</option><option value="change">处境变化</option>
        </select></label>
        <label>故事作用<select aria-label="待展开类型" disabled={disabled} value={needKind} onChange={e => setNeedKind(e.target.value as typeof needKind)}>
          {Object.entries(expansionLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
        </select></label>
        <button type="button" className="text-action" disabled={disabled || currentExplanationNeeds(draft).length >= 2 || !(needField in draft.wording ? draft.wording[needField as keyof Wording] : draft[needField as 'method' | 'change'])?.trim()} onClick={() => {
          const prose = { ...draft.wording, method: draft.method, change: draft.change }
          const quote = prose[needField]
          if (!quote?.trim()) return
          const need: StoryExpansionNeed = { kind: needKind, anchors: [{ field: needField, quote }] }
          const needs = currentExplanationNeeds(draft)
          if (needs.length < 2 && !needs.some(n => JSON.stringify(n) === JSON.stringify(need))) setDraft({ ...draft, expansionNeeds: [...needs, need] })
        }}>添加标记</button>
      </div>
      {!!draft.expansionNeeds?.length && <div><strong>留到正文展开</strong><p>可以移除不需要的标记；所引内容修改后，旧标记会在保存时移除。</p>{draft.expansionNeeds.map((need, i) => <p key={i}>{expansionLabels[need.kind]} · {need.anchors.map(a => a.quote).join('；')} <button type="button" className="text-action" disabled={disabled} onClick={() => setDraft({ ...draft, expansionNeeds: draft.expansionNeeds?.filter((_, index) => index !== i) })}>移除此标记</button></p>)}</div>}
      {!explanationMatches(draft.wording, wording) && <div><p role="status">卡片又有修改，请对照新内容核对解释；本次草稿仍保留。</p><button className="text-action" type="button" disabled={disabled} onClick={() => setDraft({ ...draft, wording: { action: wording.action, possibleResult: wording.possibleResult, futureChoice: wording.futureChoice } })}>对照当前卡片继续编辑</button></div>}
      <div className="preparation-explanation-actions"><button className="text-action" type="button" disabled={disabled || !draft.method.trim() || !draft.change.trim() || !explanationMatches(draft.wording, wording) || draft.issues.filter(i => i.trim()).length > 3 || draft.issues.some(i => i.length > 240)} onClick={() => apply({ ...draft, issues: draft.issues.filter(i => i.trim()) })}>保存并采用解释</button><button className="text-action" type="button" disabled={disabled} onClick={() => setDraft(undefined)}>取消编辑</button></div>
    </div>}
    {preview && <section className="preparation-explanation-preview" aria-label="新解释预览">
      <strong>新解释预览 · 尚未采用</strong>
      {show(preview)}
      {!explanationMatches(preview.wording, wording) && <p role="status">卡片已再次修改，这版预览已过期；可重新推演。</p>}
      <div className="preparation-explanation-actions"><button className="text-action" type="button" disabled={disabled || !explanationMatches(preview.wording, wording)} onClick={() => apply(preview)}>采用这版解释</button><button className="text-action" type="button" disabled={disabled} onClick={() => setDraft({ ...preview, source: 'author' })}>修改这版解释</button><button className="text-action" type="button" disabled={disabled} onClick={() => setPreview(undefined)}>放弃预览</button></div>
    </section>}
    {(history.length > 0 || explanation && baseline) && <details><summary>查看此前解释</summary>{(history.length ? history : baseline ? [baseline] : []).map((item, i) => <section key={i}><small>此前版本 {i + 1} · {item.source === 'author' ? '作者编辑或核对' : '系统提案'}</small>{show(item)}</section>)}</details>}
  </div>
}
