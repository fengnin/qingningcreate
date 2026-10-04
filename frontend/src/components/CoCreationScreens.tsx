import { useEffect, useMemo, useState } from 'react'
import { Archive, ArrowLeft, ArrowRight, Check, CircleAlert, History, PencilLine, RefreshCcw, Sparkles, Trash2 } from 'lucide-react'
import type { CreativeBrief, CreativeTone, CurveBeat, DramaticForce, StoryCurveVersion, StorySourceFact, StoryCurveRegenerationDecision } from '../story/types'
import type { StorySession } from '../story/useStorySession'
import {
  getMissingStoryDesignSectionLabels,
  STORY_DESIGN_SECTION_RULES,
} from '../../../shared/story-design-rules.mjs'

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

const toneLabels = Object.fromEntries(toneOptions.map(({ value, label }) => [value, label])) as Record<CreativeTone, string>
const forceLabels = Object.fromEntries(forceOptions.map(({ value, label }) => [value, label])) as Record<DramaticForce, string>

const curveBeatKindLabels: Record<CurveBeat['kind'], string> = {
  'current-state': '起 · 当前状态',
  'character-tension': '人物 · 内在矛盾',
  trigger: '起 · 触发钩子',
  escalation: '承 · 阻碍升级',
  'midpoint-turn': '转 · 中段转折',
  'climax-choice': '转 · 高潮选择',
  resolution: '合 · 结局变化',
}

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
  const [versionMode, setVersionMode] = useState<'replace-draft' | 'new-version'>('new-version')
  const isLoading = session.stageStatus === 'loading'
  const hasExistingSession = Boolean(session.storyId && session.provisionalCurve)

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
    void session.generateProvisionalCurve(brief, hasExistingSession ? versionMode : undefined)
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

          {hasExistingSession && (
            <div className="version-decision" role="group" aria-label="重新生成主线时的版本处理">
              <div><strong>当前已有一版主线</strong><small>重新生成不会静默覆盖它，请先选择保存方式。</small></div>
              <label className={versionMode === 'new-version' ? 'is-selected' : ''}>
                <input type="radio" name="curve-version-mode" value="new-version" checked={versionMode === 'new-version'} onChange={() => setVersionMode('new-version')} disabled={isLoading} />
                <span><b>保留旧版，生成新版本</b><small>推荐。旧版仍可在曲线页恢复。</small></span>
              </label>
              <label className={versionMode === 'replace-draft' ? 'is-selected' : ''}>
                <input type="radio" name="curve-version-mode" value="replace-draft" checked={versionMode === 'replace-draft'} onChange={() => setVersionMode('replace-draft')} disabled={isLoading || session.confirmedCurve !== undefined} />
                <span><b>更新当前草案</b><small>{session.confirmedCurve ? '已确认主线不能覆盖。' : '只适用于还没有确认或推演的草案。'}</small></span>
              </label>
            </div>
          )}

          {!hasExistingSession && <p className="brief-boundary-note" role="status">这一步只决定系统提案的方向；还不会生成冲突选项或连续剧情。</p>}

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
            <button className="primary-action" type="button" onClick={submit} disabled={isLoading}>{isLoading ? '正在整理主线…' : hasExistingSession ? (versionMode === 'new-version' ? '生成并保留为新版本' : '更新当前草案') : '生成暂定故事曲线'} <ArrowRight size={18} /></button>
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
  const [rejectingBeatId, setRejectingBeatId] = useState<string>()
  const [rejectReason, setRejectReason] = useState('')
  const [regenerationFeedback, setRegenerationFeedback] = useState('')
  const [isRegeneratingAffected, setIsRegeneratingAffected] = useState(false)
  const [busyFactId, setBusyFactId] = useState<string>()
  const [showVersions, setShowVersions] = useState(false)
  const [authorEditBeatId, setAuthorEditBeatId] = useState<string>()
  const [authorInstructionText, setAuthorInstructionText] = useState('')
  const [regenerationDecisions, setRegenerationDecisions] = useState<Record<string, StoryCurveRegenerationDecision>>({})
  const staleBeats = useMemo(() => curve?.beats.filter((beat) => beat.status === 'stale') ?? [], [curve])
  const staleProposalBeats = useMemo(() => staleBeats.filter((beat) => beat.source === 'system-proposal'), [staleBeats])
  const sourceFacts = curve?.design?.sourceFacts ?? []
  const unresolvedFacts = sourceFacts.filter((fact) => fact.disposition === 'needs-author-decision')
  const hasStartedStoryPath = Boolean(session.currentTurn)
  const missingDesignSections = getMissingStoryDesignSectionLabels(
    curve?.design,
    new Set(curve?.beats.filter((beat) => beat.status !== 'rejected').map((beat) => beat.id)),
  )

  useEffect(() => {
    const preview = session.pendingCurveRegeneration
    if (!preview) {
      setRegenerationDecisions({})
      return
    }
    // Every replacement is an editable proposal. Do not silently accept a
    // whole batch just because the preview arrived; the author must decide on
    // each item before anything is written back to the curve.
    setRegenerationDecisions({})
  }, [session.pendingCurveRegeneration?.id])

  if (!curve) {
    return <ProvisionalCurveEmptyState session={session} isLoading={isLoading} />
  }

  const beginEdit = (beat: CurveBeat) => {
    setEditingBeatId(beat.id)
    setEditingValue(beat.detail)
  }

  const saveBeatEdit = async () => {
    if (!editingBeatId || !editingValue.trim()) return
    await session.updateCurveBeat(editingBeatId, editingValue)
    setEditingBeatId(undefined)
  }

  const regenerateBeat = async (beatId: string, replaceRejected = false) => {
    setRegeneratingBeatId(beatId)
    await session.regenerateCurveBeat(beatId, regenerationFeedback, replaceRejected)
    setRegeneratingBeatId(undefined)
    setRegenerationFeedback('')
  }

  const rejectBeat = async (beatId: string) => {
    setRejectingBeatId(beatId)
    await session.rejectCurveBeat(beatId, rejectReason.trim() || undefined)
    setRejectingBeatId(undefined)
    setRejectReason('')
  }

  const regenerateAffected = async () => {
    setIsRegeneratingAffected(true)
    await session.regenerateAffectedCurveBeats(regenerationFeedback.trim() || undefined)
    setIsRegeneratingAffected(false)
    setRegenerationFeedback('')
  }

  const resolveRegeneration = async () => {
    const preview = session.pendingCurveRegeneration
    if (!preview || preview.items.some((item) => !regenerationDecisions[item.id])) return
    await session.resolveAffectedCurveBeats(regenerationDecisions)
    setRegenerationDecisions({})
  }

  const updateFactDisposition = async (fact: StorySourceFact, disposition: 'parked' | 'integrated') => {
    setBusyFactId(fact.id)
    await session.setSourceFactDisposition(fact.id, disposition)
    setBusyFactId(undefined)
  }

  const applyAuthorRevision = async () => {
    if (!authorEditBeatId || !authorInstructionText.trim()) return
    await session.applyAuthorInstruction(authorEditBeatId, authorInstructionText)
    setAuthorEditBeatId(undefined)
    setAuthorInstructionText('')
  }

  const canConfirm = !isLoading
    && staleBeats.length === 0
    && unresolvedFacts.length === 0
    && missingDesignSections.length === 0
    && !session.confirmedCurve

  return (
    <main className="app-shell setup-shell cocreation-shell curve-shell">
      <header className="setup-header cocreation-header">
        <button className="opening-back" type="button" onClick={session.goBack} disabled={isLoading}><ArrowLeft size={18} /> 返回创意方向</button>
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
          {curve.generation && <div className={`curve-generation-notice ${curve.generation.origin === 'fact-preserving-fallback' ? 'is-fallback' : ''}`}><Sparkles size={15} /><span><strong>{curve.generation.origin === 'fact-preserving-fallback' ? '已使用保留原始材料的结构草案' : '已完成一版结构提案'}</strong>{curve.generation.notice ?? '新增内容仍是提案，尚未成为故事事实。'}</span></div>}
          <CurveDesignSummary curve={curve} />
          <div className="curve-track">
            {curve.beats.map((beat, index) => <CurveBeatCard
              key={beat.id}
              beat={beat}
              index={index}
              sourceFacts={sourceFacts}
              isLoading={isLoading}
              isConfirmed={Boolean(session.confirmedCurve)}
              editingBeatId={editingBeatId}
              editingValue={editingValue}
              regeneratingBeatId={regeneratingBeatId}
              rejectingBeatId={rejectingBeatId}
              rejectReason={rejectReason}
              authorEditBeatId={authorEditBeatId}
              authorInstructionText={authorInstructionText}
              onBeginEdit={beginEdit}
              onEditingValueChange={setEditingValue}
              onSaveEdit={() => void saveBeatEdit()}
              onCancelEdit={() => setEditingBeatId(undefined)}
              onRegenerate={(beatId, replaceRejected) => void regenerateBeat(beatId, replaceRejected)}
              onToggleReject={(beatId) => setRejectingBeatId(rejectingBeatId === beatId ? undefined : beatId)}
              onRejectReasonChange={setRejectReason}
              onCancelReject={() => { setRejectingBeatId(undefined); setRejectReason('') }}
              onReject={(beatId) => void rejectBeat(beatId)}
              onToggleAuthorEdit={(beatId) => { setAuthorEditBeatId(authorEditBeatId === beatId ? undefined : beatId); setAuthorInstructionText('') }}
              onAuthorInstructionChange={setAuthorInstructionText}
              onCancelAuthorEdit={() => setAuthorEditBeatId(undefined)}
              onApplyAuthorRevision={() => void applyAuthorRevision()}
            />)}
          </div>
          {!session.confirmedCurve && <RejectedProposalHistory proposals={curve.rejectedProposals ?? []} />}
          {!session.confirmedCurve && <label className="curve-feedback-field"><span>给系统一句修改方向 <small>可选，作用于下一次重推</small></span><input value={regenerationFeedback} onChange={(event) => setRegenerationFeedback(event.target.value)} placeholder="例如：让阻碍来自关系承诺，而不是新增一个外部人物" maxLength={180} disabled={isLoading} /></label>}
           {staleBeats.length > 0 && !session.confirmedCurve && !session.pendingCurveRegeneration && <div className="curve-stale-panel"><p className="curve-stale-notice"><CircleAlert size={15} /> 你修改了上游节点，下面的节点需要重新看一遍。作者编辑不会被系统批量覆盖。</p><div className="curve-stale-actions">{staleProposalBeats.length > 0 && <button className="text-action" type="button" onClick={() => void regenerateAffected()} disabled={isLoading || isRegeneratingAffected}>{isRegeneratingAffected ? '正在生成重推预览…' : <><RefreshCcw size={14} /> 生成重推差异预览</>}</button>}{staleBeats.length - staleProposalBeats.length > 0 && <span>仍有作者编辑需要逐条重看。</span>}</div></div>}
           {session.pendingCurveRegeneration && <CurveRegenerationReview
             preview={session.pendingCurveRegeneration}
             decisions={regenerationDecisions}
             disabled={isLoading}
             onDecision={(id, decision) => setRegenerationDecisions((current) => ({ ...current, [id]: decision }))}
             onResolve={() => void resolveRegeneration()}
           />}
          {missingDesignSections.length > 0 && !session.confirmedCurve && <p className="curve-stale-notice curve-design-warning"><CircleAlert size={15} /> 故事设计记录还缺少：{missingDesignSections.join('、')}。请恢复或编辑相关节点后再确认。</p>}
          {!session.confirmedCurve && <SourceFactLedger facts={sourceFacts} beats={curve.beats} busyFactId={busyFactId} disabled={isLoading} onSetDisposition={updateFactDisposition} />}
          <div className="curve-version-bar"><button className="text-action" type="button" onClick={() => setShowVersions((visible) => !visible)} disabled={isLoading}><History size={15} /> {showVersions ? '收起版本记录' : `查看已保存版本（${session.curveVersions.length}）`}</button>{showVersions && <CurveVersionList versions={session.curveVersions} activeVersionId={session.activeCurveVersionId} disabled={isLoading} onSelect={(versionId) => void session.selectCurveVersion(versionId)} />}</div>
          <div className="curve-footer-actions">
            {session.confirmedCurve ? <button className="primary-action" type="button" onClick={() => hasStartedStoryPath ? void session.continueToStorySpine() : void session.startStorySpineFromCurve()} disabled={isLoading}>{isLoading ? '正在准备第一回合…' : hasStartedStoryPath ? '返回当前推演' : '确认主线后，开始第一回合'} <ArrowRight size={18} /></button> : <button className="primary-action" type="button" onClick={() => void session.confirmProvisionalCurve()} disabled={!canConfirm}>{isLoading ? '正在确认主线…' : '确认主线（仍停留在设计阶段）'} <Check size={18} /></button>}
          </div>
        </section>
        <aside className="curve-aside"><div className="curve-aside-title"><Sparkles size={15} /> 共创边界</div><p>你在这里决定故事怎么发展。系统补出的名字、秘密和意外都只是可编辑提案；确认整条主线以前，不会创建连续剧情。</p><div className="curve-aside-divider" /><span>当前状态</span><strong>{session.confirmedCurve ? hasStartedStoryPath ? '主线已确认，正在推演当前情境' : '主线已确认，等待你开始第一回合' : '仍在设计主线，尚未创建剧情回合'}</strong>{!session.confirmedCurve && <small>拒绝的提案不会重新变成故事事实。原始材料必须被纳入，或由你明确暂不纳入。</small>}</aside>
      </div>
    </main>
  )
}

function ProvisionalCurveEmptyState({ session, isLoading }: { session: StorySession; isLoading: boolean }) {
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

interface CurveBeatCardProps {
  beat: CurveBeat
  index: number
  sourceFacts: StorySourceFact[]
  isLoading: boolean
  isConfirmed: boolean
  editingBeatId: string | undefined
  editingValue: string
  regeneratingBeatId: string | undefined
  rejectingBeatId: string | undefined
  rejectReason: string
  authorEditBeatId: string | undefined
  authorInstructionText: string
  onBeginEdit: (beat: CurveBeat) => void
  onEditingValueChange: (value: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onRegenerate: (beatId: string, replaceRejected?: boolean) => void
  onToggleReject: (beatId: string) => void
  onRejectReasonChange: (value: string) => void
  onCancelReject: () => void
  onReject: (beatId: string) => void
  onToggleAuthorEdit: (beatId: string) => void
  onAuthorInstructionChange: (value: string) => void
  onCancelAuthorEdit: () => void
  onApplyAuthorRevision: () => void
}

function CurveBeatCard({
  beat,
  index,
  sourceFacts,
  isLoading,
  isConfirmed,
  editingBeatId,
  editingValue,
  regeneratingBeatId,
  rejectingBeatId,
  rejectReason,
  authorEditBeatId,
  authorInstructionText,
  onBeginEdit,
  onEditingValueChange,
  onSaveEdit,
  onCancelEdit,
  onRegenerate,
  onToggleReject,
  onRejectReasonChange,
  onCancelReject,
  onReject,
  onToggleAuthorEdit,
  onAuthorInstructionChange,
  onCancelAuthorEdit,
  onApplyAuthorRevision,
}: CurveBeatCardProps) {
  const isEditing = editingBeatId === beat.id
  const isRegenerating = regeneratingBeatId === beat.id
  const isRejecting = rejectingBeatId === beat.id
  const isAuthorEditing = authorEditBeatId === beat.id
  const canReject = !isConfirmed && beat.source === 'system-proposal' && beat.status !== 'rejected'
  const sourceFactText = (beat.sourceFactIds ?? [])
    .map((id) => sourceFacts.find((fact) => fact.id === id)?.text)
    .filter((text): text is string => Boolean(text))
    .join('；')

  return (
    <article className={`curve-beat curve-beat-${beat.kind} ${beat.status === 'stale' ? 'is-stale' : ''} ${beat.status === 'confirmed' ? 'is-confirmed' : ''} ${beat.status === 'rejected' ? 'is-rejected' : ''}`}>
      <div className="curve-beat-marker"><span>{String(index + 1).padStart(2, '0')}</span></div>
      <div className="curve-beat-body">
        <div className="curve-beat-topline">
          <div><span className="curve-beat-kind">{getKindLabel(beat.kind)}</span><h2>{beat.title}</h2></div>
          <span className={`curve-beat-status status-${beat.status}`}>{sourceLabel[beat.source]} · {statusLabel[beat.status]}</span>
        </div>
        {isEditing ? (
          <div className="curve-edit-box">
            <textarea value={editingValue} onChange={(event) => onEditingValueChange(event.target.value)} maxLength={220} disabled={isLoading} />
            <div>
              <button className="text-action" type="button" onClick={onCancelEdit}>取消</button>
              <button className="primary-action curve-save" type="button" onClick={onSaveEdit} disabled={isLoading || !editingValue.trim()}><Check size={15} /> 保存节点</button>
            </div>
          </div>
        ) : <p>{beat.detail}</p>}
        {sourceFactText && <p className="curve-beat-facts"><Archive size={13} /> 原始材料：{sourceFactText}</p>}
        {!isEditing && !isConfirmed && beat.status !== 'rejected' && (
          <div className="curve-beat-actions">
            <button className="text-action" type="button" onClick={() => onBeginEdit(beat)} disabled={isLoading}><PencilLine size={14} /> 编辑节点</button>
            {beat.source === 'system-proposal' && <button className="text-action" type="button" onClick={() => onRegenerate(beat.id)} disabled={isLoading || isRegenerating}>{isRegenerating ? '正在重推…' : <><RefreshCcw size={14} /> 重推提案</>}</button>}
            {canReject && <button className="text-action danger-action" type="button" onClick={() => onToggleReject(beat.id)} disabled={isLoading}><Trash2 size={14} /> 不采用</button>}
          </div>
        )}
        {isRejecting && !isConfirmed && (
          <div className="curve-reject-box">
            <label><span>不采用的理由 <small>可选，帮助后续重推避开它</small></span><input value={rejectReason} onChange={(event) => onRejectReasonChange(event.target.value)} maxLength={180} placeholder="例如：这条冲突不符合我想写的关系" disabled={isLoading} /></label>
            <div>
              <button className="text-action" type="button" onClick={onCancelReject}>取消</button>
              <button className="text-action danger-action" type="button" onClick={() => onReject(beat.id)} disabled={isLoading}><Trash2 size={14} /> 确认不采用</button>
            </div>
          </div>
        )}
        {beat.status === 'rejected' && (
          <div className="curve-rejected-note">
            <span><Trash2 size={13} /> 这条系统提案不会进入确认后的故事事实，也不会作为后续重推依据。</span>
            {!isConfirmed && <button className="text-action" type="button" onClick={() => onRegenerate(beat.id, true)} disabled={isLoading || isRegenerating}>{isRegenerating ? '正在生成替代提案…' : <><RefreshCcw size={14} /> 生成替代提案</>}</button>}
          </div>
        )}
        {isConfirmed && beat.status !== 'rejected' && (
          <div className="curve-beat-actions"><button className="text-action" type="button" onClick={() => onToggleAuthorEdit(beat.id)} disabled={isLoading}><PencilLine size={14} /> 作者调整主线</button></div>
        )}
        {isAuthorEditing && isConfirmed && (
          <div className="author-instruction-box">
            <label><span>作者指令 <small>这是改故事，不是角色行动</small></span><textarea value={authorInstructionText} onChange={(event) => onAuthorInstructionChange(event.target.value)} maxLength={180} placeholder="例如：把这个转折改成两人必须先说清承诺，再决定是否继续。" disabled={isLoading} /></label>
            <div>
              <button className="text-action" type="button" onClick={onCancelAuthorEdit}>取消</button>
              <button className="primary-action curve-save" type="button" onClick={onApplyAuthorRevision} disabled={isLoading || !authorInstructionText.trim()}>提交作者调整 <ArrowRight size={15} /></button>
            </div>
          </div>
        )}
      </div>
    </article>
  )
}

function CurveDesignSummary({ curve }: { curve: NonNullable<StorySession['provisionalCurve']> }) {
  const design = curve.design
  if (!design) return null
  const sections = STORY_DESIGN_SECTION_RULES.map(({ key, label }) => [label, design[key]] as const)
  const beatLabel = (id: string) => curve.beats.find((beat) => beat.id === id)?.title ?? id
  return <section className="curve-design-summary" aria-label="故事设计记录覆盖情况"><header><strong>故事设计记录</strong><small>这条曲线同时承接冲突、困境、两端和中间发展</small></header><div>{sections.map(([label, ids]) => <span key={label}><b>{label}</b>{ids.map(beatLabel).join('、') || '待补充'}</span>)}</div></section>
}

function CurveRegenerationReview({
  preview,
  decisions,
  disabled,
  onDecision,
  onResolve,
}: {
  preview: NonNullable<StorySession['pendingCurveRegeneration']>
  decisions: Record<string, StoryCurveRegenerationDecision>
  disabled: boolean
  onDecision: (id: string, decision: StoryCurveRegenerationDecision) => void
  onResolve: () => void
}) {
  const decidedCount = preview.items.filter((item) => decisions[item.id]).length
  const complete = preview.items.length > 0 && decidedCount === preview.items.length
  return <section className="curve-regeneration-review" aria-label="重推差异预览">
    <header><div><strong>重推差异预览</strong><small>逐项查看旧内容和新提案，只有你明确接受的内容才会回到主线。</small></div><span>{decidedCount}/{preview.items.length} 已决定</span></header>
    <div className="curve-regeneration-list">{preview.items.map((item) => <article key={item.id}>
      <div className="curve-regeneration-title"><strong>{item.title}</strong><span>{item.kind}</span></div>
      <div className="curve-regeneration-diff"><div><small>旧内容</small><p>{item.oldDetail}</p></div><ArrowRight size={16} /><div><small>新提案</small><p>{item.newDetail}</p></div></div>
      <div className="curve-regeneration-actions" role="group" aria-label={`${item.title}的决定`}>
        <button className={decisions[item.id] === 'accept' ? 'is-selected' : ''} type="button" onClick={() => onDecision(item.id, 'accept')} disabled={disabled}><Check size={14} /> 接受</button>
        <button className={decisions[item.id] === 'reject' ? 'is-selected is-danger' : ''} type="button" onClick={() => onDecision(item.id, 'reject')} disabled={disabled}><Trash2 size={14} /> 拒绝</button>
      </div>
    </article>)}</div>
    {!complete && <p className="curve-stale-notice"><CircleAlert size={15} /> 请先为每一项选择接受或拒绝。</p>}
    <button className="primary-action" type="button" onClick={onResolve} disabled={disabled || !complete}><Check size={16} /> 应用逐项决定</button>
  </section>
}

function SourceFactLedger({ facts, beats, busyFactId, disabled, onSetDisposition }: {
  facts: StorySourceFact[]
  beats: CurveBeat[]
  busyFactId: string | undefined
  disabled: boolean
  onSetDisposition: (fact: StorySourceFact, disposition: 'parked' | 'integrated') => Promise<void>
}) {
  if (!facts.length) return null
  const beatTitle = (id: string) => beats.find((beat) => beat.id === id)?.title ?? id
  return <section className="source-fact-ledger" aria-label="原始材料账本"><header><div><strong>原始材料账本</strong><small>你的事实不会被静默删掉；每一条都要有去处。</small></div><span>{facts.filter((fact) => fact.disposition === 'integrated').length}/{facts.length} 已纳入</span></header><div className="source-fact-list">{facts.map((fact) => {
    const isBusy = busyFactId === fact.id
    const status = fact.disposition === 'integrated' ? '已纳入主线' : fact.disposition === 'parked' ? '暂不纳入本版本' : '待你决定'
    return <article className={`source-fact-row fact-${fact.disposition}`} key={fact.id}><div><span className="source-fact-status">{status}</span><p>{fact.text}</p><small>{fact.coveredByBeatIds.length ? `承接节点：${fact.coveredByBeatIds.map(beatTitle).join('、')}` : '目前没有曲线节点承接'}</small></div>{fact.disposition === 'needs-author-decision' ? <div className="source-fact-actions"><button className="text-action" type="button" onClick={() => void onSetDisposition(fact, 'integrated')} disabled={disabled || isBusy || !fact.coveredByBeatIds.length}><Check size={14} /> 纳入主线</button><button className="text-action" type="button" onClick={() => void onSetDisposition(fact, 'parked')} disabled={disabled || isBusy}><Archive size={14} /> 暂不纳入</button></div> : fact.disposition === 'parked' ? <button className="text-action" type="button" onClick={() => void onSetDisposition(fact, 'integrated')} disabled={disabled || isBusy || !fact.coveredByBeatIds.length}><Check size={14} /> 重新纳入</button> : <div className="source-fact-actions"><span className="source-fact-locked"><Check size={14} /> 已有节点承接</span><button className="text-action" type="button" onClick={() => void onSetDisposition(fact, 'parked')} disabled={disabled || isBusy}><Archive size={14} /> 暂不纳入本版本</button></div>}</article>
  })}</div></section>
}

function RejectedProposalHistory({ proposals }: { proposals: CurveBeat[] }) {
  if (!proposals.length) return null
  return <section className="rejected-proposal-history" aria-label="已拒绝的系统提案"><header><strong>已拒绝的提案</strong><small>这些内容只保留作记录，不会重新进入故事事实。</small></header><ul>{proposals.map((proposal, index) => <li key={`${proposal.id}-${index}`}><span>{proposal.title}</span><p>{proposal.detail}</p></li>)}</ul></section>
}

function CurveVersionList({ versions, activeVersionId, disabled, onSelect }: { versions: StoryCurveVersion[]; activeVersionId: string | undefined; disabled: boolean; onSelect: (versionId: string) => void }) {
  if (!versions.length) return <p className="curve-version-empty">还没有可恢复的旧版本。</p>
  return <div className="curve-version-list"><p>恢复版本会替换当前曲线和推演进度；当前版本不会被删除。</p>{versions.map((version) => <button className={`curve-version-item ${version.id === activeVersionId ? 'is-active' : ''}`} type="button" key={version.id} onClick={() => onSelect(version.id)} disabled={disabled || version.id === activeVersionId}><span><strong>{version.label}</strong><small>{version.confirmedCurve ? '已确认主线' : '暂定草案'} · {version.curve.title}</small></span>{version.id === activeVersionId ? <Check size={15} /> : <ArrowRight size={15} />}</button>)}</div>
}

function getKindLabel(kind: CurveBeat['kind']): string {
  return curveBeatKindLabels[kind]
}

function getBriefSummary(brief: CreativeBrief): string {
  return [...brief.tones.map((tone) => toneLabels[tone]), ...brief.dramaticForces.map((force) => forceLabels[force])].join(' · ') || '开放方向'
}

function RouteIcon() {
  return <span className="route-icon" aria-hidden="true"><ArrowRight size={14} /></span>
}
