import { useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleAlert, PencilLine, RefreshCcw, Sparkles } from 'lucide-react'
import type { CreativeBrief, CreativeTone, CurveBeat, DramaticForce } from '../story/types'
import type { StorySession } from '../story/useStorySession'

const toneOptions: Array<{ value: CreativeTone; label: string; detail: string }> = [
  { value: 'comedy', label: '搞笑', detail: '用反差和尴尬制造轻快张力' },
  { value: 'warm', label: '温暖', detail: '让关系和理解成为落点' },
  { value: 'friendship', label: '友情', detail: '把选择放在伙伴之间' },
  { value: 'romance', label: '恋爱', detail: '让心意和行动互相拉扯' },
  { value: 'growth', label: '成长', detail: '让主角在代价中改变' },
  { value: 'mystery', label: '悬疑', detail: '保留信息缺口和身份疑问' },
  { value: 'fantasy', label: '奇幻', detail: '允许现实规则出现偏移' },
]

const forceOptions: Array<{ value: DramaticForce; label: string }> = [
  { value: 'misunderstanding', label: '误会' },
  { value: 'cost', label: '代价' },
  { value: 'surprise', label: '意外' },
  { value: 'contrast', label: '反差' },
  { value: 'relationship-tension', label: '关系拉扯' },
]

const sourceLabel: Record<CurveBeat['source'], string> = {
  'user-input': '来自你的想法',
  'system-proposal': '系统提案',
  'user-edit': '你已编辑',
  undecided: '待决定',
}

const statusLabel: Record<CurveBeat['status'], string> = {
  proposed: '待确认',
  edited: '已编辑',
  confirmed: '已确认',
  stale: '需要重看',
  rejected: '已拒绝',
}

export function CreativeBriefScreen({ session }: { session: StorySession }) {
  const [brief, setBrief] = useState<CreativeBrief>(session.creativeBrief)
  const isLoading = session.stageStatus === 'loading'

  const toggleTone = (value: CreativeTone) => {
    setBrief((current) => ({
      ...current,
      tones: current.tones.includes(value)
        ? current.tones.filter((item) => item !== value)
        : current.tones.length >= 2 ? [...current.tones.slice(1), value] : [...current.tones, value],
    }))
  }

  const toggleForce = (value: DramaticForce) => {
    setBrief((current) => ({
      ...current,
      dramaticForces: current.dramaticForces.includes(value)
        ? current.dramaticForces.filter((item) => item !== value)
        : current.dramaticForces.length >= 2 ? [...current.dramaticForces.slice(1), value] : [...current.dramaticForces, value],
    }))
  }

  const submit = () => {
    session.updateCreativeBrief(brief)
    void session.generateProvisionalCurve(brief)
  }

  return (
    <main className="app-shell setup-shell cocreation-shell">
      <header className="setup-header cocreation-header">
        <button className="opening-back" type="button" onClick={session.goBack} disabled={isLoading}>
          <ArrowLeft size={18} /> 返回想法
        </button>
        <div className="cocreation-step"><span>01</span><strong>创意方向</strong><small>先决定这件事往哪里变有趣</small></div>
        <span className="model-label"><span className="status-dot" /> 共创工作区</span>
      </header>
      <div className="cocreation-layout">
        <section className="cocreation-main">
          <p className="eyebrow"><Sparkles size={15} /> 你的想法</p>
          <h1>先决定，<br />这件事要往哪里长。</h1>
          <p className="setup-lead cocreation-lead">“{session.trimmedIdea}”会保留为起点。下面只选择创作方向，系统不会替你定下故事事实。</p>

          <div className="brief-section">
            <div className="brief-section-heading"><div><span>故事感觉</span><small>最多选两个</small></div><strong>{brief.tones.length}/2</strong></div>
            <div className="brief-options tone-options">
              {toneOptions.map((option) => {
                const selected = brief.tones.includes(option.value)
                return <button key={option.value} className={`brief-option ${selected ? 'is-selected' : ''}`} type="button" onClick={() => toggleTone(option.value)} disabled={isLoading}>
                  <span className="brief-option-check">{selected ? <Check size={14} /> : null}</span>
                  <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                </button>
              })}
            </div>
          </div>

          <div className="brief-section">
            <div className="brief-section-heading"><div><span>戏剧力量</span><small>最多选两个</small></div><strong>{brief.dramaticForces.length}/2</strong></div>
            <div className="brief-force-list">
              {forceOptions.map((option) => {
                const selected = brief.dramaticForces.includes(option.value)
                return <button key={option.value} className={`brief-force ${selected ? 'is-selected' : ''}`} type="button" onClick={() => toggleForce(option.value)} disabled={isLoading}>
                  <span className="brief-force-dot" /> {option.label}
                </button>
              })}
            </div>
          </div>

          <label className="brief-note-field">
            <span>你更想看到什么 <small>可选</small></span>
            <textarea value={brief.note ?? ''} onChange={(event) => setBrief((current) => ({ ...current, note: event.target.value }))} placeholder="例如：我想让主角最后主动承担一点尴尬。" maxLength={180} disabled={isLoading} />
          </label>

          <label className="brief-permission">
            <input type="checkbox" checked={brief.allowSystemNamedCharacters} onChange={(event) => setBrief((current) => ({ ...current, allowSystemNamedCharacters: event.target.checked }))} disabled={isLoading} />
            <span><strong>允许系统提出具名人物</strong><small>关闭时，系统只使用“陌生人”“工作人员”等匿名称呼。</small></span>
          </label>

          {session.stageError && <p className="cocreation-error" role="alert"><CircleAlert size={16} /> {session.stageError}</p>}
          <div className="cocreation-actions">
            <button className="primary-action" type="button" onClick={submit} disabled={isLoading}>{isLoading ? '正在整理主线…' : '生成暂定故事曲线'} <ArrowRight size={18} /></button>
          </div>
        </section>
        <aside className="cocreation-aside">
          <div className="brief-idea-mark"><span>原始念头</span><strong>{session.trimmedIdea}</strong></div>
          <div className="brief-aside-rule" />
          <p>方向会影响系统提出的钩子、代价和人物变化，但它们都要先经过你的确认。</p>
          <div className="brief-aside-note"><PencilLine size={16} /><span>你可以在下一步逐条编辑曲线节点。</span></div>
        </aside>
      </div>
    </main>
  )
}

export function ProvisionalCurveScreen({ session }: { session: StorySession }) {
  const curve = session.provisionalCurve
  const isLoading = session.stageStatus === 'loading'
  const [editingBeatId, setEditingBeatId] = useState<string>()
  const [editingValue, setEditingValue] = useState('')
  const [regeneratingBeatId, setRegeneratingBeatId] = useState<string>()
  const [feedback, setFeedback] = useState('')
  const staleBeats = useMemo(() => curve?.beats.filter((beat) => beat.status === 'stale') ?? [], [curve])

  if (!curve) {
    return (
      <main className="app-shell setup-shell cocreation-shell curve-shell">
        <header className="setup-header cocreation-header">
          <button className="opening-back" type="button" onClick={session.goBack} disabled={isLoading}>
            <ArrowLeft size={18} /> 返回创意方向
          </button>
          <div className="cocreation-step"><span>02</span><strong>暂定故事曲线</strong><small>先看见要讲什么，再进入剧情</small></div>
        </header>
        <section className="curve-empty-state" aria-live="polite">
          {isLoading ? (
            <div className="curve-building" role="status" aria-busy="true">
              <div className="curve-building-copy">
                <p className="eyebrow"><Sparkles size={15} /> 故事地图</p>
                <h1>故事正在<br />成形</h1>
                <p>把你的创意方向整理成一条可编辑的主线。</p>
                <div className="curve-building-status"><span aria-hidden="true" /><strong>正在梳理故事的起、承、转、合</strong></div>
              </div>
              <div className="curve-building-map" aria-hidden="true">
                <span className="curve-building-rail" />
                <span className="curve-building-traveler" />
                {[
                  ['01', '起点'],
                  ['02', '拉扯'],
                  ['03', '转折'],
                  ['04', '选择'],
                  ['05', '变化'],
                ].map(([number, label], index) => (
                  <div className={`curve-building-node ${index === 0 ? 'is-origin' : ''}`} key={number}>
                    <span>{number}</span>
                    <strong>{label}</strong>
                  </div>
                ))}
              </div>
              <blockquote className="curve-building-idea">
                <span>原始念头</span>
                <p>{session.trimmedIdea}</p>
              </blockquote>
            </div>
          ) : session.stageError ? (
            <div className="generation-error" role="alert">
              <CircleAlert size={17} />
              <div>
                <strong>曲线没有生成</strong>
                <p>{session.stageError}</p>
                <button className="primary-action" type="button" onClick={() => void session.retryCurrentStage()}>
                  再试一次 <RefreshCcw size={16} />
                </button>
              </div>
            </div>
          ) : <p className="setup-lead">暂定故事曲线还没有生成。</p>}
        </section>
      </main>
    )
  }

  const beginEdit = (beat: CurveBeat) => {
    setEditingBeatId(beat.id)
    setEditingValue(beat.detail)
  }

  const saveEdit = async () => {
    if (!editingBeatId || !editingValue.trim()) return
    await session.updateCurveBeat(editingBeatId, editingValue)
    setEditingBeatId(undefined)
  }

  const regenerate = async (beatId: string) => {
    setRegeneratingBeatId(beatId)
    await session.regenerateCurveBeat(beatId, feedback)
    setRegeneratingBeatId(undefined)
    setFeedback('')
  }

  const canConfirm = !isLoading && staleBeats.length === 0 && !session.confirmedCurve

  return (
    <main className="app-shell setup-shell cocreation-shell curve-shell">
      <header className="setup-header cocreation-header">
        <button className="opening-back" type="button" onClick={session.goBack} disabled={isLoading || Boolean(session.confirmedCurve)}><ArrowLeft size={18} /> 返回创意方向</button>
        <div className="cocreation-step"><span>02</span><strong>暂定故事曲线</strong><small>{session.confirmedCurve ? '主线已确认，可以开始推演' : '先看见要讲什么，再进入剧情'}</small></div>
        <span className={`curve-status ${session.confirmedCurve ? 'is-confirmed' : ''}`}>{session.confirmedCurve ? <><Check size={14} /> 已确认</> : '系统提案 · 待你决定'}</span>
      </header>
      <div className="curve-layout">
        <section className="curve-main">
          <div className="curve-heading">
            <div><p className="eyebrow"><RouteIcon /> 故事地图</p><h1>{curve.title}</h1><p>这不是最终大纲。每个节点都可以编辑，系统提案也可以重推；确认前不会进入连续剧情。</p></div>
            <div className="curve-brief-summary"><span>创意方向</span><strong>{getBriefSummary(curve.brief)}</strong></div>
          </div>
          {session.stageError && <p className="cocreation-error" role="alert"><CircleAlert size={16} /> {session.stageError}</p>}
          <div className="curve-track">
            {curve.beats.map((beat, index) => {
              const isEditing = editingBeatId === beat.id
              const isRegenerating = regeneratingBeatId === beat.id
              return <article className={`curve-beat curve-beat-${beat.kind} ${beat.status === 'stale' ? 'is-stale' : ''} ${beat.status === 'confirmed' ? 'is-confirmed' : ''}`} key={beat.id}>
                <div className="curve-beat-marker"><span>{String(index + 1).padStart(2, '0')}</span></div>
                <div className="curve-beat-body">
                  <div className="curve-beat-topline"><div><span className="curve-beat-kind">{getKindLabel(beat.kind)}</span><h2>{beat.title}</h2></div><span className={`curve-beat-status status-${beat.status}`}>{sourceLabel[beat.source]} · {statusLabel[beat.status]}</span></div>
                  {isEditing ? <div className="curve-edit-box"><textarea value={editingValue} onChange={(event) => setEditingValue(event.target.value)} maxLength={220} disabled={isLoading} /><div><button className="text-action" type="button" onClick={() => setEditingBeatId(undefined)}>取消</button><button className="primary-action curve-save" type="button" onClick={() => void saveEdit()} disabled={isLoading || !editingValue.trim()}><Check size={15} /> 保存节点</button></div></div> : <p>{beat.detail}</p>}
                  {!isEditing && !session.confirmedCurve && <div className="curve-beat-actions"><button className="text-action" type="button" onClick={() => beginEdit(beat)} disabled={isLoading}><PencilLine size={14} /> 编辑</button>{beat.source !== 'user-input' && <button className="text-action" type="button" onClick={() => void regenerate(beat.id)} disabled={isLoading || isRegenerating}>{isRegenerating ? '正在重推…' : <><RefreshCcw size={14} /> 重推这个节点</>}</button>}</div>}
                </div>
              </article>
            })}
          </div>
          {!session.confirmedCurve && <label className="curve-feedback-field"><span>给系统一句修改方向 <small>可选，作用于下一次重推</small></span><input value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="例如：把悬疑感换成更温暖的关系冲突" maxLength={180} disabled={isLoading} /></label>}
          {staleBeats.length > 0 && !session.confirmedCurve && <p className="curve-stale-notice"><CircleAlert size={15} /> 你修改了较早节点。请重新编辑或重推标记为“需要重看”的节点，再确认主线。</p>}
          <div className="curve-footer-actions">
            {session.confirmedCurve ? <button className="primary-action" type="button" onClick={() => void session.startStorySpineFromCurve()} disabled={isLoading}>{isLoading ? '正在准备推演…' : '按这条主线开始推演'} <ArrowRight size={18} /></button> : <button className="primary-action" type="button" onClick={() => void session.confirmProvisionalCurve()} disabled={!canConfirm}>{isLoading ? '正在确认…' : '确认这条主线，进入故事推演'} <ArrowRight size={18} /></button>}
          </div>
        </section>
        <aside className="curve-aside"><div className="curve-aside-title"><Sparkles size={15} /> 共创边界</div><p>系统补出的名字、秘密和意外现在都只是提案。只有你确认整条曲线后，它们才可能进入故事状态。</p><div className="curve-aside-divider" /><span>当前状态</span><strong>{session.confirmedCurve ? '主线已成为本次推演依据' : '尚未创建剧情回合'}</strong>{!session.confirmedCurve && <small>你可以放心修改，不会破坏后续路线。</small>}</aside>
      </div>
    </main>
  )
}

function getKindLabel(kind: CurveBeat['kind']): string {
  const labels: Record<CurveBeat['kind'], string> = {
    'current-state': '起 · 当前状态',
    'character-tension': '人物 · 内在矛盾',
    trigger: '起 · 触发钩子',
    escalation: '承 · 阻碍升级',
    'midpoint-turn': '转 · 中段转折',
    'climax-choice': '转 · 高潮选择',
    resolution: '合 · 结局变化',
  }
  return labels[kind]
}

function getBriefSummary(brief: CreativeBrief): string {
  const labels: Record<CreativeTone, string> = { comedy: '搞笑', warm: '温暖', friendship: '友情', romance: '恋爱', growth: '成长', mystery: '悬疑', fantasy: '奇幻' }
  const forceLabels: Record<DramaticForce, string> = { misunderstanding: '误会', cost: '代价', surprise: '意外', contrast: '反差', 'relationship-tension': '关系拉扯' }
  return [...brief.tones.map((tone) => labels[tone]), ...brief.dramaticForces.map((force) => forceLabels[force])].join(' · ') || '开放方向'
}

function RouteIcon() {
  return <span className="route-icon" aria-hidden="true"><ArrowRight size={14} /></span>
}
