import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleAlert, FileText, History, PencilLine, RefreshCcw, Sparkles, Trash2 } from 'lucide-react'
import type { CreativeBrief, CreativeTone, CurveBeat, DramaticForce, StoryAuthorClarification, StoryAuthorClarificationAction, StoryCurveVersion, StoryCurveRegenerationDecision } from '../story/types'
import type { StorySession } from '../story/useStorySession'
import { StoryRequirementsFields } from './StoryRequirementsFields'
import { StoryJourney } from './StoryScreens'
import { requestPreparationStoryDirections } from '../story/storyApi'
import { preparationActionFieldLimit, splitPreparationAction, updatePreparationAction } from '../story/preparationAction'
import type { StoryReasoningProposal, StoryReasoningStatement } from '../../../shared/story-reasoning-contract.js'
import { getMissingStoryDesignSectionLabels } from '../../../shared/story-design-rules.mjs'

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
  const [isSubmitting, setIsSubmitting] = useState(false)
  const submitLockRef = useRef(false)
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

  const submit = (event: MouseEvent<HTMLButtonElement>) => {
    if (submitLockRef.current || isLoading) return
    submitLockRef.current = true
    // React state updates are asynchronous; close the same-tick native click
    // window before the loading render has committed.
    event.currentTarget.disabled = true
    setIsSubmitting(true)
    session.updateCreativeBrief(brief)
    void session.generateProvisionalCurve(brief, hasExistingSession ? versionMode : undefined)
      .finally(() => {
        submitLockRef.current = false
        setIsSubmitting(false)
      })
  }

  return (
    <main className="app-shell setup-shell cocreation-shell">
      <header className="setup-header cocreation-header">
        <button className="opening-back" type="button" onClick={session.goBack} disabled={isLoading}>
          <ArrowLeft size={18} /> 返回想法
        </button>
        <StoryJourney current={1} loading={isLoading || isSubmitting} />
        {hasExistingSession ? <button className="text-action stage-forward" type="button" onClick={session.provisionalCurve?.preparation ? session.reviewStoryPredicament : session.resumeStoryDesign} disabled={isLoading || isSubmitting}>下一步 · {session.provisionalCurve?.preparation ? '故事走向' : '故事设计'} <ArrowRight size={16} /></button> : <span className="model-label"><span className="status-dot" /> 共创工作区</span>}
      </header>
      <div className="cocreation-layout">
        <section className="cocreation-main">
          <p className="eyebrow"><Sparkles size={15} /> 你的想法</p>
          <h1 className="cocreation-one-line-title">先决定，这件事要往哪里长。</h1>
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

          <StoryRequirementsFields brief={brief} onChange={updated => { setBrief(updated); session.updateCreativeBrief(updated) }} disabled={isLoading} />
          <label className="brief-note-field">
            <span>你更想看到什么 <small>会影响最终故事</small></span>
            <textarea value={brief.note ?? ''} onChange={(event) => setBrief((current) => ({ ...current, note: event.target.value }))} placeholder="例如：最后让主角主动道歉，并和朋友一起补救。" maxLength={180} disabled={isLoading} />
          </label>

          <label className="brief-permission">
            <input type="checkbox" checked={brief.allowSystemNamedCharacters} onChange={(event) => setBrief((current) => ({ ...current, allowSystemNamedCharacters: event.target.checked }))} disabled={isLoading} />
            <span><strong>允许系统提出具名人物</strong><small>关闭时，系统不给人物起具体名字。</small></span>
          </label>

          {session.stageError && <p className="cocreation-error" role="alert"><CircleAlert size={16} /> {session.stageError}</p>}
          <div className="cocreation-actions">
            {hasExistingSession && <button className="primary-action" type="button" onClick={session.provisionalCurve?.preparation ? session.reviewStoryPredicament : session.resumeStoryDesign} disabled={isLoading || isSubmitting}>下一步 · {session.provisionalCurve?.preparation ? '故事走向' : '故事设计'} <ArrowRight size={16} /></button>}
            <button className={hasExistingSession ? 'text-action' : 'primary-action'} type="button" onClick={submit} disabled={isLoading || isSubmitting}>{isLoading || isSubmitting ? '正在整理主线…' : hasExistingSession ? (versionMode === 'new-version' ? '生成并保留为新版本' : '更新当前草案') : '下一步 · 生成故事走向'} <ArrowRight size={18} /></button>
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

export function AcceptedPreparationScreen({ session }: { session: StorySession }) {
  return <PreparationReview session={session} />
}

export function ProvisionalCurveScreen({ session }: { session: StorySession }) {
  const curve = session.provisionalCurve
  const isLoading = session.stageStatus === 'loading'
  const [editingBeatId, setEditingBeatId] = useState<string>()
  const [editingValue, setEditingValue] = useState('')
  const [regeneratingBeatId, setRegeneratingBeatId] = useState<string>()
  const [rejectingBeatId, setRejectingBeatId] = useState<string>()
  const [rejectReason, setRejectReason] = useState('')
  const [affectedFeedback, setAffectedFeedback] = useState('')
  const [showAffectedRegeneration, setShowAffectedRegeneration] = useState(false)
  const [isRegeneratingAffected, setIsRegeneratingAffected] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [authorEditBeatId, setAuthorEditBeatId] = useState<string>()
  const [authorInstructionText, setAuthorInstructionText] = useState('')
  const [applyingAuthorRevisionBeatId, setApplyingAuthorRevisionBeatId] = useState<string>()
  const [authorRevisionErrorBeatId, setAuthorRevisionErrorBeatId] = useState<string>()
  const [regenerationDecisions, setRegenerationDecisions] = useState<Record<string, StoryCurveRegenerationDecision>>({})
  const [acceptedDesignIds, setAcceptedDesignIds] = useState<string[]>([])
  useEffect(() => setAcceptedDesignIds([]), [curve?.reasoning, curve?.id])
  const [isSavingBeat, setIsSavingBeat] = useState(false)
  const saveBeatLockRef = useRef(false)
  const staleBeats = useMemo(() => curve?.beats.filter((beat) => beat.status === 'stale') ?? [], [curve])
  const staleProposalBeats = useMemo(() => staleBeats.filter((beat) => beat.source === 'system-proposal'), [staleBeats])
  const staleAuthorBeats = useMemo(() => staleBeats.filter((beat) => beat.source === 'user-edit'), [staleBeats])
  const sourceFacts = curve?.design?.sourceFacts ?? []
  const unresolvedFacts = sourceFacts.filter((fact) => fact.disposition === 'needs-author-decision')
  const unresolvedClarifications = curve?.clarifications?.filter((item) => !item.resolution) ?? []
  const hasStartedStoryPath = Boolean(session.writingDraft || session.currentTurn)
  // Prepared simple actions need no invented climax or middle-development slot.
  // All fact, stale-node and explicit design-review gates remain below.
  const missingDesignSections = curve?.preparation ? [] : getMissingStoryDesignSectionLabels(
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
  if (curve.preparation?.status === 'needs-review') return <PreparationReview session={session} />
  const acceptedFutureChoice = curve.preparation?.candidates.find(candidate => curve.preparation?.acceptedCandidateIds.includes(candidate.id))?.futureChoice

  const beginEdit = (beat: CurveBeat) => {
    setEditingBeatId(beat.id)
    setEditingValue(beat.detail)
  }

  const saveBeatEdit = async (event?: MouseEvent<HTMLButtonElement>) => {
    if (!editingBeatId || !editingValue.trim() || saveBeatLockRef.current) return
    saveBeatLockRef.current = true
    if (event) event.currentTarget.disabled = true
    setIsSavingBeat(true)
    try {
      await session.updateCurveBeat(editingBeatId, editingValue)
      setEditingBeatId(undefined)
    } finally {
      saveBeatLockRef.current = false
      setIsSavingBeat(false)
    }
  }

  const regenerateBeat = async (beatId: string, replaceRejected = false) => {
    setRegeneratingBeatId(beatId)
    try {
      await session.regenerateCurveBeat(beatId, undefined, replaceRejected)
    } finally {
      setRegeneratingBeatId(undefined)
    }
  }

  const rejectBeat = async (beatId: string) => {
    setRejectingBeatId(beatId)
    try {
      await session.rejectCurveBeat(beatId, rejectReason.trim() || undefined)
      setRejectReason('')
    } finally {
      setRejectingBeatId(undefined)
    }
  }

  const regenerateAffected = async (feedback?: string) => {
    setIsRegeneratingAffected(true)
    try {
      await session.regenerateAffectedCurveBeats(feedback?.trim() || undefined)
    } finally {
      setIsRegeneratingAffected(false)
    }
  }

  const resolveRegeneration = async (independentUnknownIds?: string[], designIds?: string[]) => {
    const preview = session.pendingCurveRegeneration
    if (!preview || preview.items.some((item) => !regenerationDecisions[item.id])) return
    await session.resolveAffectedCurveBeats(regenerationDecisions, independentUnknownIds, designIds)
    setRegenerationDecisions({})
  }

  const applyAuthorRevision = async () => {
    if (!authorEditBeatId || !authorInstructionText.trim()) return
    setAuthorRevisionErrorBeatId(authorEditBeatId)
    setApplyingAuthorRevisionBeatId(authorEditBeatId)
    try {
      const applied = await session.applyAuthorInstruction(authorEditBeatId, authorInstructionText)
      if (applied) {
        setAuthorEditBeatId(undefined)
        setAuthorInstructionText('')
        setAuthorRevisionErrorBeatId(undefined)
      }
    } finally {
      setApplyingAuthorRevisionBeatId(undefined)
    }
  }

  const canConfirm = !isLoading
    && staleBeats.length === 0
    && unresolvedFacts.length === 0
    && unresolvedClarifications.length === 0
    && missingDesignSections.length === 0
    && !session.confirmedCurve
    && (!curve.reasoning?.designReview || designReviewItems(curve.reasoning).filter(s => s.basis.kind === 'design-proposal').every(s => acceptedDesignIds.includes(s.id) || curve.reasoning!.designReview!.acceptedProposalIds.includes(s.id)))
  const confirmAndStartWriting = async () => {
    const confirmed = await session.confirmProvisionalCurve(acceptedDesignIds)
    if (confirmed) session.openStoryWriting()
  }

  return (
    <main className="app-shell setup-shell cocreation-shell curve-shell">
      <header className="setup-header cocreation-header">
        <button className="opening-back" type="button" onClick={session.goBack} disabled={isLoading}><ArrowLeft size={18} /> 上一步 · {curve.preparation ? '故事走向' : '创意方向'}</button>
        <StoryJourney current={3} loading={isLoading} />
        {session.hasVisitedStoryWriting && <button className="text-action stage-forward" type="button" onClick={session.openStoryWriting} disabled={isLoading}>下一步 · 写成故事 <ArrowRight size={16} /></button>}
      </header>
      <div className="curve-layout">
        <section className="curve-main">
          <div className="curve-heading">
            <div><p className="eyebrow"><RouteIcon /> 故事地图</p><h1>{curve.title}</h1><p>先看这版故事怎样开始、发展和收束。每一段都可以编辑或局部重做；普通细节会在后续写作中展开。</p></div>
            <div className="curve-brief-summary"><span>创意方向</span><strong>{getBriefSummary(curve.brief)}</strong></div>
          </div>
          {session.stageError && !authorRevisionErrorBeatId && <p className="cocreation-error" role="alert"><CircleAlert size={16} /> {session.stageError}</p>}
          {curve.generation?.origin === 'fact-preserving-fallback' && <div className="curve-generation-notice is-fallback"><Sparkles size={15} /><span><strong>故事设计暂未完整生成</strong>{curve.generation.notice ?? '已保留原始材料，请检查草案或重新生成。'}</span></div>}
          {(curve.preparation?.authorReview?.selectedStoryDirection || acceptedFutureChoice) && <p className="curve-future-choice"><strong>{curve.preparation?.authorReview?.selectedStoryDirection ? '你选定的故事走向' : '选定方向可能推向'}</strong><span>{curve.preparation?.authorReview?.selectedStoryDirection || acceptedFutureChoice}</span><small>这是本版构思的起点；后续可以通过编辑和局部重做调整。</small></p>}
          <CurveDesignSummary curve={curve} />
          {curve.preparation && (curve.preparation.material.some(m => m.role === 'unknown') || !!curve.preparation.authorReview?.supersededMaterialIds?.length || !!curve.preparation.supplements?.length) && <details className="story-review-details"><summary>待定内容与设定调整</summary>{curve.preparation.material.filter(m => m.role === 'unknown').map(m => <p key={m.id}>待定：{m.quote}</p>)}
            {curve.preparation.authorReview?.supersededMaterialIds?.map(id => <p key={id}>被作者明确取代（保留原文，不再作为依据）：{curve.preparation!.material.find(m => m.id === id)?.quote}</p>)}
            {!!curve.preparation.supplements?.length && <aside aria-label="独立待审新增设计"><h4>独立待审新增设计</h4><p>这些内容不属于行动必需条件。接受只保存未来设计；若要纳入行动，仍需显式修订并再次审阅。</p>{curve.preparation.supplements.map(s => <PreparationSupplementReview key={s.id} item={s} disabled={isLoading || curve.status !== 'draft'} onReview={session.reviewPreparationSupplement} />)}</aside>}
          </details>}
          {curve.reasoning?.outcome === 'questions' && <p>这版尚未形成可接受的设计。以下问题等待作者决定；生成失败不等于作者资料不足。</p>}
          {(curve.clarifications ?? []).filter(c => c.dependency.beatIds.length === 0).map(c => <CurveClarificationReview
            key={c.id} beat={{ id: '', kind: 'trigger', title: '待审问题', detail: c.prompt, source: 'system-proposal', status: 'proposed', dependsOn: [] }}
            clarifications={[c]} disabled={isLoading} isConfirmed={Boolean(session.confirmedCurve)}
            onClarification={(action, fields) => session.changeCurveClarification(action, fields)} onRegenerate={() => void regenerateAffected()} />)}
          {curve.beats.length === 0 && !session.confirmedCurve && <button type="button" className="text-action" disabled={isLoading} onClick={() => void regenerateAffected()}>根据已确认回答或独立方向生成预览</button>}
          <div className="curve-track">
            {curve.beats.map((beat, index) => <CurveBeatCard
              key={beat.id}
              beat={beat}
              index={index}
              clarifications={curve.clarifications?.filter((item) => item.dependency.beatIds.includes(beat.id)) ?? []}
              onClarification={(action, fields) => session.changeCurveClarification(action, { targetBeatId: beat.id, ...fields })}
              isLoading={isLoading || isSavingBeat}
              isConfirmed={Boolean(session.confirmedCurve)}
              editingBeatId={editingBeatId}
              editingValue={editingValue}
              regeneratingBeatId={regeneratingBeatId}
              rejectingBeatId={rejectingBeatId}
              rejectReason={rejectReason}
              authorEditBeatId={authorEditBeatId}
              authorInstructionText={authorInstructionText}
              applyingAuthorRevisionBeatId={applyingAuthorRevisionBeatId}
              authorRevisionError={authorRevisionErrorBeatId === beat.id ? session.stageError : undefined}
              onBeginEdit={beginEdit}
              onEditingValueChange={setEditingValue}
              onSaveEdit={(event) => void saveBeatEdit(event)}
              onCancelEdit={() => setEditingBeatId(undefined)}
              onRegenerate={(beatId, replaceRejected) => void regenerateBeat(beatId, replaceRejected)}
              onToggleReject={(beatId) => setRejectingBeatId(rejectingBeatId === beatId ? undefined : beatId)}
              onRejectReasonChange={setRejectReason}
              onCancelReject={() => { setRejectingBeatId(undefined); setRejectReason('') }}
              onReject={(beatId) => void rejectBeat(beatId)}
              onToggleAuthorEdit={(beatId) => { setAuthorEditBeatId(authorEditBeatId === beatId ? undefined : beatId); setAuthorRevisionErrorBeatId(undefined); setAuthorInstructionText('') }}
              onAuthorInstructionChange={setAuthorInstructionText}
              onCancelAuthorEdit={() => { setAuthorEditBeatId(undefined); setAuthorRevisionErrorBeatId(undefined) }}
              onApplyAuthorRevision={() => void applyAuthorRevision()}
            />)}
          </div>
          {curve.reasoning && <ReasoningDesignReview reasoning={curve.reasoning} acceptedIds={acceptedDesignIds} onChange={setAcceptedDesignIds} disabled={isLoading || Boolean(session.confirmedCurve)} wholeStory={Boolean(curve.preparation)} />}
          {!session.confirmedCurve && <RejectedProposalHistory proposals={curve.rejectedProposals ?? []} />}
          {staleBeats.length > 0 && !session.confirmedCurve && <div className="curve-stale-panel">
            <p className="curve-stale-notice"><CircleAlert size={15} /> 前面的修改可能影响以下节点，原有内容已保留。由你决定怎样衔接。</p>
            <div className="curve-stale-actions">{staleBeats.map(beat => <button className="text-action" type="button" key={beat.id} onClick={() => beginEdit(beat)} disabled={isLoading}>{beat.title} <PencilLine size={14} /></button>)}</div>
            <div className="curve-stale-actions">
              <button className="text-action" type="button" onClick={() => void session.retainAffectedCurveBeats(staleBeats.map(beat => beat.id))} disabled={isLoading || isSavingBeat}>沿用原设计</button>
              {staleProposalBeats.length > 0 && <button className="text-action" type="button" aria-expanded={showAffectedRegeneration} onClick={() => setShowAffectedRegeneration(value => !value)} disabled={isLoading || isRegeneratingAffected || Boolean(session.pendingCurveRegeneration)}><RefreshCcw size={14} /> 重新推演受影响节点</button>}
              <button className="text-action" type="button" onClick={() => beginEdit(staleBeats[0])} disabled={isLoading || isSavingBeat}><PencilLine size={14} /> 手动调整</button>
            </div>
            {showAffectedRegeneration && staleProposalBeats.length > 0 && !session.pendingCurveRegeneration && <div className="author-instruction-box">
              <label><span>希望这些节点怎么衔接？ <small>可选，仅用于这次重新推演</small></span><textarea autoFocus value={affectedFeedback} onChange={event => setAffectedFeedback(event.target.value)} placeholder="例如：承接前面的新决定，保留原来的结局。" maxLength={180} disabled={isLoading || isRegeneratingAffected} /></label>
              <div><button className="text-action" type="button" disabled={isLoading || isRegeneratingAffected} onClick={() => setShowAffectedRegeneration(false)}>取消</button><button className="primary-action curve-save" type="button" disabled={isLoading || isRegeneratingAffected} onClick={() => void regenerateAffected(affectedFeedback)}>{isRegeneratingAffected ? '正在生成…' : '生成新提案'}</button></div>
            </div>}
            <p className="curve-impact-help">沿用表示你已核对这些节点仍能承接修改；重新推演会先展示新旧对照，由你逐项采用。完成后仍需确认整版故事。</p>
            {staleAuthorBeats.length > 0 && <p className="curve-impact-help">你之前手动编辑的节点会保留，可自行修改或核对后沿用。</p>}
          </div>}
           {session.pendingCurveRegeneration && <CurveRegenerationReview
             preview={session.pendingCurveRegeneration}
             decisions={regenerationDecisions}
             disabled={isLoading}
             onDecision={(id, decision) => setRegenerationDecisions((current) => ({ ...current, [id]: decision }))}
             onResolve={(ids, designIds) => void resolveRegeneration(ids, designIds)}
           />}
          {missingDesignSections.length > 0 && !session.confirmedCurve && <p className="curve-stale-notice curve-design-warning"><CircleAlert size={15} /> 故事设计记录还缺少：{missingDesignSections.join('、')}。请恢复或编辑相关节点后再确认。</p>}
          <div className="curve-version-bar"><button className="text-action" type="button" onClick={() => setShowVersions((visible) => !visible)} disabled={isLoading}><History size={15} /> {showVersions ? '收起版本记录' : `查看已保存版本（${session.curveVersions.length}）`}</button>{showVersions && <CurveVersionList versions={session.curveVersions} activeVersionId={session.activeCurveVersionId} disabled={isLoading} onSelect={(versionId) => void session.selectCurveVersion(versionId)} />}</div>
          <div className="curve-footer-actions">
            <button className="text-action" type="button" onClick={session.goBack} disabled={isLoading}><ArrowLeft size={16} /> 上一步 · {curve.preparation ? '故事走向' : '创意方向'}</button>
            {session.confirmedCurve ? <button className="primary-action" type="button" onClick={() => session.openStoryWriting()} disabled={isLoading}>{hasStartedStoryPath ? '继续写成故事' : '开始写成故事'} <ArrowRight size={18} /></button> : <button className="primary-action" type="button" onClick={() => void confirmAndStartWriting()} disabled={!canConfirm}>{isLoading ? '正在确认主线…' : '确认并开始写成故事'} <ArrowRight size={18} /></button>}
          </div>
        </section>
        <aside className="curve-aside"><div className="curve-aside-title"><Sparkles size={15} /> 共创边界</div><p>你在这里决定故事怎么发展。系统补出的名字、秘密和意外都只是可编辑提案；确认整条主线以前，不会开始写正文。</p><div className="curve-aside-divider" /><span>当前状态</span><strong>{session.confirmedCurve ? hasStartedStoryPath ? '主线已确认，可以继续写作' : '主线已确认，等待开始写作' : '仍在设计主线，尚未开始写作'}</strong>{!session.confirmedCurve && <small>拒绝的提案不会重新变成故事事实。原始材料必须被纳入，或由你明确暂不纳入。</small>}</aside>
      </div>
    </main>
  )
}

function preparationErrorMessage(session: StorySession) {
  if (session.stageErrorCode === 'STORY_PREPARATION_QUALITY_FAILED') return '模型生成的内容存在不确定性，本次结果未通过系统审阅。请再试一次。'
  if (session.stageErrorCode === 'STORY_PREPARATION_INVALID_OUTPUT') return '这次没能整理出完整的方向，可以用原来的想法再试一次。'
  return session.stageError
}

function ProvisionalCurveEmptyState({ session, isLoading }: { session: StorySession; isLoading: boolean }) {
  const activeBuildNode = session.directionBuildProgress

  return (
    <main className="app-shell setup-shell cocreation-shell curve-shell">
      <header className="setup-header cocreation-header">
        <button className="opening-back" type="button" onClick={session.goBack} disabled={isLoading}>
          <ArrowLeft size={18} /> 返回创意方向
        </button>
        <StoryJourney current={2} />
      </header>
      <section className="curve-empty-state" aria-live="polite">
        {isLoading ? (
          <div className="curve-building" role="status" aria-busy="true">
            <div className="curve-building-copy">
              <p className="eyebrow"><Sparkles size={15} /> 故事设计</p>
              <h1>故事正在成形</h1>
              <p>围绕你的想法，提出三种不同的推进方向；看完后，由你选定故事接下来怎么展开。</p>
            </div>
            <div className="curve-building-map preparation-building-map" aria-label="生成流程说明">
              <span className="curve-building-rail" />
              {[
                ['01', '梳理你的想法'],
                ['02', '构思故事走向'],
                ['03', '检查走向是否合理'],
              ].map(([number, label]) => (
                <div className={`curve-building-node ${Number(number) === activeBuildNode + 1 && activeBuildNode < 3 ? 'is-active' : ''} ${Number(number) <= activeBuildNode ? 'is-complete' : ''}`} key={number} aria-current={Number(number) === activeBuildNode + 1 && activeBuildNode < 3 ? 'step' : undefined}>
                  <span>{Number(number) <= activeBuildNode ? <Check size={15} /> : number}</span>
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
          <div className="preparation-recovery">
            <div className="preparation-recovery-copy" role="alert">
              <p className="eyebrow">故事方向</p>
              <h1>故事方向暂未生成</h1>
              <p>{preparationErrorMessage(session)}</p>
            </div>
            <div className="preparation-recovery-draft">
              <span><Check size={14} aria-hidden="true" /> 你的想法已保留</span>
              <blockquote>{session.trimmedIdea}</blockquote>
            </div>
            <div className="preparation-recovery-actions">
              <button className="primary-action" type="button" onClick={() => void session.retryCurrentStage()}><RefreshCcw size={16} aria-hidden="true" /> 再试一次</button>
              <button className="text-action" type="button" onClick={session.goBackToOpening}><PencilLine size={15} aria-hidden="true" /> 修改想法</button>
            </div>
          </div>
        ) : <p className="setup-lead">故事方向还没有生成。</p>}
      </section>
    </main>
  )
}

interface CurveBeatCardProps {
  beat: CurveBeat
  index: number
  clarifications: StoryAuthorClarification[]
  onClarification: (action: StoryAuthorClarificationAction, fields?: {
    clarificationId?: string; prompt?: string; causalGap?: string; answerText?: string
  }) => Promise<boolean>
  isLoading: boolean
  isConfirmed: boolean
  editingBeatId: string | undefined
  editingValue: string
  regeneratingBeatId: string | undefined
  rejectingBeatId: string | undefined
  rejectReason: string
  authorEditBeatId: string | undefined
  authorInstructionText: string
  applyingAuthorRevisionBeatId: string | undefined
  authorRevisionError: string | undefined
  onBeginEdit: (beat: CurveBeat) => void
  onEditingValueChange: (value: string) => void
  onSaveEdit: (event: MouseEvent<HTMLButtonElement>) => void
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
  clarifications,
  onClarification,
  isLoading,
  isConfirmed,
  editingBeatId,
  editingValue,
  regeneratingBeatId,
  rejectingBeatId,
  rejectReason,
  authorEditBeatId,
  authorInstructionText,
  applyingAuthorRevisionBeatId,
  authorRevisionError,
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
  const isApplyingAuthorRevision = applyingAuthorRevisionBeatId === beat.id
  const canRework = beat.kind !== 'current-state' && (beat.source === 'system-proposal' || beat.source === 'user-edit')
  const canReject = canRework && beat.status !== 'rejected'

  return (
    <article className={`curve-beat curve-beat-${beat.kind} ${beat.status === 'stale' ? 'is-stale' : ''} ${beat.status === 'confirmed' ? 'is-confirmed' : ''} ${beat.status === 'rejected' ? 'is-rejected' : ''}`}>
      <div className="curve-beat-marker"><span>{String(index + 1).padStart(2, '0')}</span></div>
      <div className="curve-beat-body">
        <div className="curve-beat-topline">
          <div><span className="curve-beat-kind">{getKindLabel(beat.kind)}</span><h2>{beat.title}</h2></div>
          {!(beat.source === 'system-proposal' && beat.status === 'proposed') && <span className={`curve-beat-status status-${beat.status}`}>{sourceLabel[beat.source]} · {statusLabel[beat.status]}</span>}
        </div>
        {isEditing ? (
          <div className="curve-edit-box">
            <textarea autoFocus value={editingValue} onChange={(event) => onEditingValueChange(event.target.value)} maxLength={220} disabled={isLoading} />
            <div><button className="text-action" type="button" onClick={onCancelEdit}>取消</button><button className="primary-action curve-save" type="button" onClick={onSaveEdit} disabled={isLoading || !editingValue.trim()}><Check size={15} /> 保存节点</button></div>
          </div>
        ) : <p>{beat.detail}</p>}
        {(beat.status !== 'rejected' || clarifications.length > 0) && <CurveClarificationReview
              beat={beat}
          clarifications={clarifications}
          disabled={isLoading}
          isConfirmed={isConfirmed}
          onClarification={onClarification}
              onRegenerate={(beatId) => onRegenerate(beatId)}
        />}
        {!isEditing && beat.status !== 'rejected' && (
          <div className="curve-beat-actions">
            <button className="text-action" type="button" onClick={() => onBeginEdit(beat)} disabled={isLoading}><PencilLine size={14} /> {beat.status === 'stale' && beat.source === 'user-edit' ? '编辑我的版本' : '编辑节点'}</button>
            <button className="text-action" type="button" onClick={() => onToggleAuthorEdit(beat.id)} disabled={isLoading}><PencilLine size={14} /> 调整故事设计</button>
            {canRework && <button className="text-action" type="button" onClick={() => onRegenerate(beat.id)} disabled={isLoading || isRegenerating}>{isRegenerating ? <><span className="generation-spinner curve-action-spinner" aria-hidden="true" /> 正在重推…</> : <><RefreshCcw size={14} /> {beat.source === 'user-edit' ? '重新构思' : '重推提案'}</>}</button>}
            {canReject && <button className="text-action danger-action" type="button" onClick={() => onToggleReject(beat.id)} disabled={isLoading}><Trash2 size={14} /> 不采用</button>}
          </div>
        )}
        {isRejecting && (
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
            <span><Trash2 size={13} /> 这个节点已不采用，原内容保留供查看。生成替代提案后，由你决定是否采用。</span>
            {canRework && <button className="text-action" type="button" onClick={() => onRegenerate(beat.id, true)} disabled={isLoading || isRegenerating}>{isRegenerating ? <><span className="generation-spinner curve-action-spinner" aria-hidden="true" /> 正在生成替代提案…</> : <><RefreshCcw size={14} /> 生成替代提案</>}</button>}
          </div>
        )}
        {isAuthorEditing && beat.status !== 'rejected' && (
          <div className="author-instruction-box">
            <label><span>调整要求 <small>写下你想调整的情节、人物行动或结局。</small></span><textarea value={authorInstructionText} onChange={(event) => onAuthorInstructionChange(event.target.value)} maxLength={180} placeholder="例如：让主角先尝试自己的办法，遇到阻碍后再向朋友求助。" disabled={isLoading} /></label>
            <div><button className="text-action" type="button" onClick={onCancelAuthorEdit} disabled={isLoading || isApplyingAuthorRevision}>取消</button><button className="primary-action curve-save" type="button" onClick={onApplyAuthorRevision} disabled={isLoading || isApplyingAuthorRevision || !authorInstructionText.trim()}>{isApplyingAuthorRevision ? <><span className="generation-spinner curve-action-spinner" aria-hidden="true" /> 正在调整…</> : <>提交调整 <ArrowRight size={15} /></>}</button></div>
            {authorRevisionError && <p className="cocreation-error" role="alert"><CircleAlert size={16} /> {authorRevisionError}</p>}
          </div>
        )}
      </div>
    </article>
  )
}

function CurveClarificationReview({ beat, clarifications, disabled, isConfirmed, onClarification, onRegenerate }: {
  beat: CurveBeat
  clarifications: StoryAuthorClarification[]
  disabled: boolean
  isConfirmed: boolean
  onClarification: (action: StoryAuthorClarificationAction, fields?: {
    clarificationId?: string; prompt?: string; causalGap?: string; answerText?: string
  }) => Promise<boolean>
  onRegenerate: (beatId: string) => void
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  if (!clarifications.length) return null
  return <div className="curve-clarifications">
    {clarifications.map((item) => {
      const answer = answers[item.id] ?? item.answerText ?? ''
      return <section className="curve-clarification" key={item.id} aria-label="节点因果问题">
      <div className="curve-clarification-heading"><strong>{item.prompt}</strong><span>{item.resolution ? '已处理' : item.status === 'unanswered' ? '尚未回答' : item.status === 'author-unknown' ? '作者未确定' : item.status === 'needs-review' ? '等待作者确认' : '回答已确认'}</span></div>
      <p>针对：{item.dependency.causalGap}</p>
      {item.answerText && <blockquote>{item.answerText}</blockquote>}
      {item.sourceFactId && <small>已进入事实账本 · {item.sourceFactId}</small>}
      {!item.resolution && !isConfirmed && <div className="curve-clarification-actions">
        {item.status !== 'confirmed' && <>
          <label><span>作者回答原文</span><textarea value={answer} onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))} maxLength={240} disabled={disabled} placeholder="只写已经确定的事实" /></label>
          <button className="text-action" type="button" disabled={disabled || !answer.trim()} onClick={() => void onClarification('save-answer', { clarificationId: item.id, answerText: answer })}>保存待审回答</button>
          {item.status === 'needs-review' && <button className="text-action" type="button" disabled={disabled || answer !== item.answerText} onClick={() => void onClarification('confirm-answer', { clarificationId: item.id })}><Check size={14} /> 确认已保存原文进入事实账本</button>}
          {item.status === 'needs-review' && answer !== item.answerText && <small>请先保存修改后的回答，再确认。</small>}
          <button className="text-action" type="button" disabled={disabled} onClick={() => void onClarification('declare-unknown', { clarificationId: item.id, ...(answer.trim() ? { answerText: answer } : {}) })}>明确未确定</button>
        </>}
        {item.status === 'author-unknown' && <>
          <button className="text-action" type="button" disabled={disabled} onClick={() => void onClarification('keep-unknown', { clarificationId: item.id })}>保留未知</button>
          <button className="text-action" type="button" disabled={disabled} onClick={() => void onClarification('request-independent-proposal', { clarificationId: item.id })}>请求独立提案</button>
          {item.unknownHandling === 'request-independent-proposal' && beat.source === 'system-proposal' && <button className="text-action" type="button" disabled={disabled} onClick={() => onRegenerate(beat.id)}><RefreshCcw size={14} /> 生成替代预览</button>}
          {beat.source === 'system-proposal' && <button className="text-action danger-action" type="button" disabled={disabled} onClick={() => void onClarification('abandon-dependent-proposal', { clarificationId: item.id })}><Trash2 size={14} /> 放弃这条提案</button>}
        </>}
        {item.status === 'confirmed' && beat.source === 'system-proposal' && <button className="text-action" type="button" disabled={disabled} onClick={() => onRegenerate(beat.id)}><RefreshCcw size={14} /> 用已确认回答生成替代预览</button>}
      </div>}
    </section>})}
  </div>
}

function CurveDesignSummary({ curve }: { curve: NonNullable<StorySession['provisionalCurve']> }) {
  const beatText = (kind: CurveBeat['kind']) => curve.beats.find((beat) => beat.kind === kind && beat.status !== 'rejected')?.detail ?? ''
  const developmentText = [beatText('escalation'), beatText('midpoint-turn')].filter(Boolean).join('\n')
  return <details className="story-review-details" aria-label="故事设定"><summary>查看故事设定</summary><section className="curve-design-summary">
    <header><strong>故事设定</strong><small>与下方当前故事节点同步，修改节点后会随之更新。</small></header>
    <div className="curve-five-stage" aria-label="五阶段故事推进">
      {[
        ['故事起点', beatText('current-state')],
        ['开始尝试', beatText('trigger')],
        ['尝试带来的变化', developmentText],
        ['关键选择', beatText('climax-choice') || '本版暂不需要单独的关键选择'],
        ['暂定结局', beatText('resolution')],
      ].map(([label, text]) => <section key={label}><b>{label}</b><p className={!text || text === '本版暂不需要单独的关键选择' ? 'is-empty' : ''}>{text || '待补充'}</p></section>)}
    </div>
  </section></details>
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
  onResolve: (independentUnknownIds?: string[], designIds?: string[]) => void
}) {
  const [independenceChecked, setIndependenceChecked] = useState(false)
  useEffect(() => setIndependenceChecked(false), [preview.id])
  // The explicit node decisions are the author's receipt for this preview.
  // The server keeps only accepted nodes and their dependencies before review.
  const acceptedDesignIds = preview.reasoning && preview.items.some(item => decisions[item.id] === 'accept')
    ? designReviewItems(preview.reasoning).filter(item => item.basis.kind === 'design-proposal').map(item => item.id)
    : []
  const needsIndependentReview = Boolean(preview.excludedUnknownIds?.length) && preview.items.some(i => decisions[i.id] === 'accept')
  const decidedCount = preview.items.filter((item) => decisions[item.id]).length
  const complete = preview.items.length > 0 && decidedCount === preview.items.length
  const nodeLabels: Record<string, string> = { 'current-state': '故事起点', trigger: '开始尝试', escalation: '情节推进', 'midpoint-turn': '新的转折', 'climax-choice': '关键选择', resolution: '暂定结局' }
  return <section className="curve-regeneration-review" aria-label="重推差异预览">
    <header><div><strong>查看这次调整</strong><small>对照原设计，逐项决定是否采用新提案。</small></div><span className="curve-regeneration-progress" role="status">{decidedCount} / {preview.items.length} 项已决定</span></header>
    <div className="curve-regeneration-list">{preview.items.map((item, index) => <article className={decisions[item.id] ? `is-${decisions[item.id]}` : ''} key={item.id}>
      <div className="curve-regeneration-title"><div><span className="curve-regeneration-index">{String(index + 1).padStart(2, '0')}</span><strong>{item.title}</strong></div><span>{nodeLabels[item.kind] ?? '故事节点'}</span></div>
      <div className="curve-regeneration-diff"><div className="curve-regeneration-original"><small>原设计</small><p>{item.oldDetail}</p></div><ArrowRight className="curve-regeneration-arrow" size={18} aria-hidden="true" /><div className="curve-regeneration-proposal"><small>新提案</small><p>{item.newDetail.replace(/^提案[：:]\s*/u, '')}</p></div></div>
      <div className="curve-regeneration-actions" role="group" aria-label={`${item.title}的决定`}>
        <span>{decisions[item.id] === 'accept' ? '将采用新提案' : decisions[item.id] === 'reject' ? '不采用此提案' : '这处调整由你决定'}</span>
        <button aria-pressed={decisions[item.id] === 'accept'} className={decisions[item.id] === 'accept' ? 'is-selected' : ''} type="button" onClick={() => onDecision(item.id, 'accept')} disabled={disabled}><Check size={15} /> 采用新提案</button>
        <button aria-pressed={decisions[item.id] === 'reject'} className={decisions[item.id] === 'reject' ? 'is-selected is-danger' : ''} type="button" onClick={() => onDecision(item.id, 'reject')} disabled={disabled}>不采用</button>
      </div>
    </article>)}</div>
    {!complete && <p className="curve-stale-notice"><CircleAlert size={15} /> 请先为每一项选择接受或拒绝。</p>}
    {needsIndependentReview && <label><input type="checkbox" checked={independenceChecked} onChange={e => setIndependenceChecked(e.target.checked)} disabled={disabled} />我已核对新提案未依赖保留的未知前提；这些前提仍未确定。</label>}
    <div className="curve-regeneration-footer"><p>确认后，采用的新提案会更新到故事设计中。</p><button className="primary-action" type="button" onClick={() => onResolve(independenceChecked ? preview.excludedUnknownIds : undefined, acceptedDesignIds)} disabled={disabled || !complete || (needsIndependentReview && !independenceChecked)}><Check size={16} /> 确认这次调整</button></div>
  </section>
}

function designReviewItems(p: StoryReasoningProposal): StoryReasoningStatement[] {
  return [...(p.goal ? [p.goal] : []), ...p.constraints, ...p.actions, ...p.relations, ...('steps' in p ? p.steps : [])]
}

function PreparationReview({ session }: { session: StorySession }) {
  const [editing, setEditing] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [reviewed, setReviewed] = useState<Record<string, { action: string; possibleResult: string; futureChoice?: string }>>({})
  const [pendingOperation, setPendingOperation] = useState<'regenerate' | 'accept'>()
  const [errorOperation, setErrorOperation] = useState<'regenerate' | 'accept'>()
  const [choosingDirection, setChoosingDirection] = useState(false)
  const p = session.provisionalCurve!.preparation!
  const busy = session.stageStatus === 'loading'
  const submitLock = useRef(false)
  useEffect(() => { setEditing(undefined); setSelectedId(undefined); setReviewed({}); setChoosingDirection(false) }, [session.provisionalCurve!.id, p.candidates])
  const candidates = p.candidates
  const available = candidates.filter(c => !c.unknownIds.length)
  const active = available[0] ?? candidates[0]
  const selected = candidates.find(c => c.id === selectedId)
  const renderAction = (value: string) => {
    const match = value.match(/^遇到的难处：([\s\S]*?)\s*眼前的选择：([\s\S]*)$/u)
    if (!match) return <span className="preparation-action-legacy"><small>遇到的难处与眼前的选择</small><span>{value}</span></span>
    return <><span className="preparation-action-part"><small>遇到的难处</small><span>{match[1]}</span></span><span className="preparation-action-part"><small>眼前的选择</small><span>{match[2]}</span></span></>
  }
  const editCandidate = (candidate: typeof candidates[number], field: 'difficulty' | 'choice' | 'possibleResult' | 'futureChoice', value: string) => {
    setChoosingDirection(false)
    setReviewed(current => {
      const wording = current[candidate.id] ?? candidate
      return { ...current, [candidate.id]: {
        action: field === 'difficulty' || field === 'choice' ? updatePreparationAction(wording.action, field, value) : wording.action,
        possibleResult: field === 'possibleResult' ? value : wording.possibleResult,
        futureChoice: field === 'futureChoice' ? value : wording.futureChoice,
      } }
    })
  }
  const requestAlternative = async () => {
    if (busy || submitLock.current) return
    submitLock.current = true
    setErrorOperation('regenerate')
    setPendingOperation('regenerate')
    try { await session.revisePreparation('regenerate') } finally { submitLock.current = false; setPendingOperation(undefined) }
  }
  const createReview = (c: typeof p.candidates[number]): import('../../../shared/story-preparation.js').StoryPreparationReview => {
    const wording = reviewed[c.id] ?? c
    return {
      originalText: `我选择这个困境，故事尚未发生。\n方向：${wording.action}${wording.futureChoice ? `\n后续的取舍：${wording.futureChoice}` : ''}\n可能带来的变化：${wording.possibleResult}`,
      candidates: [{ id: c.id, action: wording.action, possibleResult: wording.possibleResult, ...(wording.futureChoice !== undefined ? { futureChoice: wording.futureChoice } : {}) }],
    }
  }
  const accept = async (c: typeof p.candidates[number], direction: string) => {
    if (busy || submitLock.current || !direction.trim()) return
    submitLock.current = true
    setErrorOperation('accept')
    setPendingOperation('accept')
    // A click receipts exactly the displayed future design. It supplies no
    // confirmed facts, supersession or execution, and retains server checks.
    try { await session.acceptPreparation([c.id], {
      ...createReview(c), selectedStoryDirection: direction.trim(),
    }) } finally { submitLock.current = false; setPendingOperation(undefined) }
  }
  const alternativeError = session.stageError && errorOperation === 'regenerate' && <div className="preparation-generation-feedback is-error preparation-action-error" role="alert"><strong>换一组方向没有完成</strong><p>{preparationErrorMessage(session)}</p><p>当前方向和你的编辑仍保留，可以重试或继续修改。</p></div>
  return <main className="app-shell setup-shell cocreation-shell preparation-workspace">
    <header className="setup-header"><button className="opening-back" type="button" onClick={session.goBack} disabled={busy}><ArrowLeft size={18} /> 返回创意方向</button><StoryJourney current={2} loading={busy} /><div className="setup-header-actions">{p.status !== 'needs-review' && <button className="text-action" type="button" onClick={session.resumeStoryDesign} disabled={busy}>下一步 · 故事设计 <ArrowRight size={16} /></button>}</div></header>
    <div className="preparation-layout">
    <div className="preparation-direction-column" aria-busy={busy}>
    <div className="preparation-intro"><p className="eyebrow">02 / 05 · 故事走向选择</p><h1>这件事接下来会怎样发展？</h1><p className="setup-lead">以下是供你选择的故事提案，过程和结局仍可调整。</p></div>
   {!!candidates.length && <div className="preparation-direction-heading"><div><p>围绕你的想法继续</p><strong>原始目标不变，先选它会遇到什么难处。</strong></div><span>选定后，还可以继续修改故事规划。</span></div>}
    {candidates.map((active, index) => {
      const wording = reviewed[active.id] ?? active
      const actionParts = splitPreparationAction(wording.action)
      return <section className={`preparation-proposal ${selectedId === active.id ? 'is-selected' : ''}`} aria-label={`故事走向 ${index + 1}`} key={active.id}>
      <button className="preparation-choice" type="button" aria-pressed={selectedId === active.id} disabled={busy || !!active.unknownIds.length} onClick={() => { if (selectedId !== active.id) setChoosingDirection(false); setSelectedId(active.id) }}>
        <span className="preparation-choice-index">0{index + 1}</span>
        <span className="preparation-choice-icon"><FileText size={18} /></span>
        <span className="preparation-choice-copy"><span className="preparation-choice-action">{renderAction(wording.action)}</span>{wording.futureChoice && <span className="preparation-choice-outcome"><small>后续的取舍</small><span className="preparation-development">{wording.futureChoice}</span></span>}<span className="preparation-choice-outcome"><small>可能带来的变化</small><span className="preparation-development">{wording.possibleResult}</span></span></span>
        <span className="preparation-choice-indicator" aria-hidden="true">{selectedId === active.id && <Check size={16} />}</span>
      </button>
      {editing === active.id && <div className="preparation-editor">
        <label>遇到的难处<textarea maxLength={preparationActionFieldLimit(wording.action, 'difficulty')} disabled={busy} value={actionParts.difficulty} onChange={e => editCandidate(active, 'difficulty', e.target.value)} /></label>
        <label>眼前的选择<textarea maxLength={preparationActionFieldLimit(wording.action, 'choice')} disabled={busy} value={actionParts.choice} onChange={e => editCandidate(active, 'choice', e.target.value)} /></label>
        {wording.futureChoice !== undefined && <label>后续的取舍<textarea maxLength={240} disabled={busy} value={wording.futureChoice} onChange={e => editCandidate(active, 'futureChoice', e.target.value)} /></label>}
        <label>可能带来的变化<textarea maxLength={240} disabled={busy} value={wording.possibleResult} onChange={e => editCandidate(active, 'possibleResult', e.target.value)} /></label>
        <p>选定方向后，将根据最新内容展开推进过程，供你审阅和修改。难处与选择合计最多240字。</p>
        <button className="text-action" type="button" disabled={busy} onClick={() => setEditing(undefined)}>完成编辑</button>
      </div>}
      {active.unknownIds.length > 0 && <p className="preparation-missing-condition">暂不能选择，还需确定：{active.unknownIds.map(id => p.questions.find(q => q.id === id)?.question ?? '这条方向的关键条件').join('；')}</p>}
      <div className="preparation-actions">
        <button className="text-action" type="button" disabled={busy} onClick={() => setEditing(editing === active.id ? undefined : active.id)}><PencilLine size={16} /> 编辑</button>
      </div>
    </section>})}
    {!!candidates.length && <div className="preparation-direction-footer">{!choosingDirection && <button className="primary-action" type="button" disabled={busy || !selected || !((reviewed[selected.id]?.action ?? selected.action).trim()) || !((reviewed[selected.id]?.possibleResult ?? selected.possibleResult).trim())} onClick={() => { setEditing(undefined); setChoosingDirection(true) }}>展开这个方向 <ArrowRight size={16} /></button>}<div className="preparation-retry-action"><button className="text-action" type="button" disabled={busy} onClick={() => void requestAlternative()}><RefreshCcw size={16} /> 换一组故事走向</button>{alternativeError}</div></div>}
    {busy && pendingOperation === 'regenerate' && <p className="preparation-loading-status preparation-regeneration-status" role="status"><span className="generation-spinner" aria-hidden="true" />正在重新整理故事走向…</p>}
    {choosingDirection && selected && <PreparationStoryDirectionChoice
      key={JSON.stringify([session.revision, selected.id, createReview(selected)])}
      session={session} candidateId={selected.id} review={createReview(selected)} disabled={busy} accepting={pendingOperation === 'accept'}
      acceptError={session.stageError && errorOperation === 'accept' ? preparationErrorMessage(session) : undefined}
      onRetryDirections={() => void requestAlternative()}
      onConfirm={direction => accept(selected, direction)} />}
    {!!candidates.length && <p className="preparation-note">选中的是未来设计，不表示人物已经行动。</p>}
      {!active && <section className="preparation-question"><p>暂时没有形成可审阅的方向，可以重新生成一组。</p><div className="preparation-retry-action"><button className="primary-action" type="button" disabled={busy} onClick={() => void requestAlternative()}>再想三种方向</button>{alternativeError}</div></section>}
    </div>
    <aside className="preparation-source-column">
      <section className="preparation-original" aria-label="作者原文"><small>你的原始想法</small>{p.sources.map(s => <div key={s.id}>{s.id !== 'author-input' && <small>{({ 'author-setting': '已确定的设定', 'author-direction': '希望的发展', 'author-boundaries': '必须保留或避免的内容', 'author-note': '希望故事呈现' } as Record<string, string>)[s.id] ?? '你的补充'}</small>}<blockquote>{s.text}</blockquote></div>)}</section>
    </aside>
    </div>
  </main>
}

function PreparationStoryDirectionChoice({ session, candidateId, review, disabled, accepting, acceptError, onRetryDirections, onConfirm }: {
  session: StorySession
  candidateId: string
  review: import('../../../shared/story-preparation.js').StoryPreparationReview
  disabled: boolean
  accepting: boolean
  acceptError: string | undefined
  onRetryDirections: () => void
  onConfirm: (direction: string) => Promise<void>
}) {
  const [directions, setDirections] = useState<import('../../../shared/story-preparation.js').StoryPreparationStoryDirection[]>([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const directionRequest = useRef<{ retry: number; promise: ReturnType<typeof requestPreparationStoryDirections> }>()
  useEffect(() => {
    let active = true
    setLoading(true); setError(''); setDirections([]); setSelected('')
    if (!directionRequest.current || directionRequest.current.retry !== retry) {
      directionRequest.current = { retry, promise: requestPreparationStoryDirections({ storyId: session.storyId!, revision: session.revision,
        curveId: session.provisionalCurve!.id, acceptedCandidateIds: [candidateId], authorReview: review }) }
    }
    directionRequest.current.promise
      .then(value => { if (active) setDirections(value) })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '这次没能整理出走向，请再试一次。') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [retry])
  const directionPanel = useRef<HTMLElement>(null)
  useEffect(() => { directionPanel.current?.scrollIntoView({ block: 'start' }) }, [])
  const direction = (() => {
    const item = directions.find(d => d.id === selected)
    return item ? `${item.choice}\n可能承担的变化：${item.consequence}` : ''
  })()
  return <section ref={directionPanel} className="preparation-story-directions" aria-label="选择故事走向" aria-busy={loading}>
    <div><p className="eyebrow">接下来 / 故事走向</p><h2>你想让故事往哪里走？</h2><p className="preparation-direction-description">先决定关键取舍，再构思完整故事；具体过程和暂定结局仍可修改。</p></div>
    {loading && <p className="preparation-loading-status" role="status"><span className="generation-spinner" aria-hidden="true" />正在根据这张卡整理走向…</p>}
    {error && <div className="preparation-retry-action" role="alert"><button type="button" className="text-action" disabled={disabled || loading} onClick={() => setRetry(v => v + 1)}>重新整理走向</button><p>{error}</p></div>}
    <div className="preparation-story-direction-list" role="radiogroup" aria-label="本版故事走向">
      {directions.map((item, index) => <label className={`preparation-proposal preparation-story-direction ${selected === item.id ? 'is-selected' : ''}`} key={item.id}>
        <input type="radio" name="story-direction" checked={selected === item.id} disabled={disabled || loading} onChange={() => setSelected(item.id)} />
        <span className="preparation-choice-copy"><strong>方向{index + 1}</strong><span className="preparation-choice-action">{item.choice}</span><span className="preparation-choice-outcome"><small>可能的代价或变化</small><span className="preparation-development">{item.consequence}</span></span></span>
        <span className="preparation-choice-indicator" aria-hidden="true">{selected === item.id && <Check size={16} />}</span>
      </label>)}
    </div>
    <div className="preparation-direction-footer"><button className="primary-action" type="button" disabled={disabled || !direction} onClick={() => { if (direction) void onConfirm(direction) }}>确认并进入故事设计 <ArrowRight size={16} /></button>{accepting && <div className="preparation-generation-feedback preparation-generation-feedback-below" role="status"><span className="generation-spinner" aria-hidden="true" /><div><strong>正在按你选定的走向构思故事</strong><p>完成后可以审阅、编辑或局部重做故事设计。</p></div></div>}{acceptError && <div className="preparation-generation-feedback is-error preparation-action-error" role="alert"><strong>这次故事设计没有完成</strong><p>{acceptError}</p><p>你选定的走向和原有内容仍保留，可以重试或换一组方向。</p><div className="preparation-recovery-actions"><button className="text-action" type="button" disabled={disabled} onClick={onRetryDirections}>换一组方向</button><button className="text-action" type="button" disabled={disabled} onClick={session.goBackToOpening}>修改想法</button></div></div>}</div>
  </section>
}

function PreparationSupplementReview({ item, disabled, onReview }: { item: import('../../../shared/story-preparation.js').StoryPreparationSupplement; disabled: boolean; onReview: (id: string, decision: 'accepted-design'|'rejected'|'keep-unknown', text: string) => Promise<void> }) {
  const [authorText, setAuthorText] = useState('')
  return <article><p>待审 {item.kind}：{item.text}</p><p>{item.question}</p><p>审阅状态：{item.status}（不表示执行或结果发生）</p>{item.authorText && <blockquote>{item.authorText}</blockquote>}
    {item.status === 'needs-review' && <><label>独立审阅原文<textarea value={authorText} disabled={disabled} onChange={e => setAuthorText(e.target.value)} /></label>{(['accepted-design','rejected','keep-unknown'] as const).map((decision, i) => <button key={decision} type="button" disabled={disabled || !authorText.trim()} onClick={() => void onReview(item.id, decision, authorText)}>{['仅接受未来设计','拒绝这项设计','保留未知，不依赖它'][i]}</button>)}</>}
  </article>
}

function ReasoningDesignReview({ reasoning, acceptedIds, onChange, disabled, wholeStory = false }: { reasoning: StoryReasoningProposal; acceptedIds: string[]; onChange: (ids: string[]) => void; disabled: boolean; wholeStory?: boolean }) {
  const items = designReviewItems(reasoning)
  const groups = new Map<string, typeof items>()
  for (const item of items) {
    const key = JSON.stringify([item.basis.kind, item.text, item.basis.kind === 'author-text' ? [] : [...item.basis.unknownIds].sort()])
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const proposals = [...groups.values()].filter(group => group[0].basis.kind === 'design-proposal')
  const accepted = (id: string) => acceptedIds.includes(id) || Boolean(reasoning.designReview?.acceptedProposalIds.includes(id))
  const pending = proposals.filter(group => !group.every(s => accepted(s.id))).length
  const sources = [...new Set(items.filter(s => s.basis.kind === 'author-text').map(s => s.text))]
  const editableIds = proposals.flatMap(group => group.filter(s => !reasoning.designReview?.acceptedProposalIds.includes(s.id)).map(s => s.id))
  const unresolvedDesign = proposals.some(group => group.some(s => s.basis.kind !== 'author-text' && s.basis.unknownIds.length > 0))
  const selectableIds = proposals.filter(group => group.every(item => item.basis.kind === 'design-proposal' && !item.basis.unknownIds.length))
    .flatMap(group => group.filter(item => !reasoning.designReview?.acceptedProposalIds.includes(item.id)).map(item => item.id))
  const allSelectableAccepted = selectableIds.every(id => accepted(id))
  if (wholeStory) return reasoning.designReview ? <section className="story-direction-review" aria-label="故事方向确认">
    <label className="story-review-choice"><input type="checkbox" checked={pending === 0} disabled={disabled || unresolvedDesign || !editableIds.length} onChange={e => onChange(e.target.checked ? [...new Set([...acceptedIds, ...editableIds])] : acceptedIds.filter(id => !editableIds.includes(id)))} /><span>我已审阅上面的故事设计，采用当前版本</span></label>
  </section> : null
  return <section className="story-direction-review" aria-label="故事方向确认">
    <div className="design-review-panel">
      <header className="design-review-heading"><div><h3>确认这次调整中的创意</h3><p className="story-review-help">勾选愿意采用的内容，再确认这次调整。</p></div><span className={`design-review-progress ${pending ? '' : 'is-complete'}`} role="status">{pending ? `${pending} 项待确认` : proposals.length ? '已全部确认' : '暂无新增创意'}</span></header>
      {reasoning.designReview && selectableIds.length > 0 && <div className="design-review-toolbar"><button className="text-action" type="button" disabled={disabled} onClick={() => onChange(allSelectableAccepted ? acceptedIds.filter(id => !selectableIds.includes(id)) : [...new Set([...acceptedIds, ...selectableIds])])}>{allSelectableAccepted ? '取消本次勾选' : '采用全部可选创意'}</button></div>}
      <div className="design-review-list">{proposals.map((group, index) => {
        const s = group[0], checked = group.every(item => accepted(item.id))
        const unknownIds = s.basis.kind === 'author-text' ? [] : s.basis.unknownIds
        const unresolved = unknownIds.length > 0
        const editableIds = group.filter(item => !reasoning.designReview?.acceptedProposalIds.includes(item.id)).map(item => item.id)
        const quotes = [...new Set(group.flatMap(item => item.basis.kind === 'unknown' ? [] : item.basis.evidence.map(e => e.quote)))]
        return <article className={`story-review-choice design-review-item ${checked ? 'is-selected' : ''} ${unresolved ? 'is-unresolved' : ''}`} key={s.id}>
          <div className="design-review-item-heading"><span>创意 {String(index + 1).padStart(2, '0')}</span><span>{unresolved ? '需先补充条件' : checked ? '已采用' : '待确认'}</span></div>
          {reasoning.designReview ? <label><input type="checkbox" disabled={disabled || unresolved || !editableIds.length} checked={checked} onChange={e => onChange(e.target.checked ? [...new Set([...acceptedIds, ...editableIds])] : acceptedIds.filter(id => !editableIds.includes(id)))} /><span>{s.text}</span></label> : <p>{s.text}</p>}
          {unresolved && <p className="story-review-help">先决定：{unknownIds.map(id => reasoning.unknowns.find(q => q.id === id)?.question ?? '尚待补充的故事条件').join('；')}</p>}
          {!!quotes.length && <details className="story-review-source"><summary>从哪句话出发</summary>{quotes.map(quote => <blockquote key={quote}>{quote}</blockquote>)}<small>原文提供灵感，后续发展仍由你决定。</small></details>}
        </article>
      })}</div>
      {!!sources.length && <details className="story-review-source"><summary>你的原文</summary>{sources.map(text => <blockquote key={text}>{text}</blockquote>)}</details>}
      {!!reasoning.unknowns.length && <details className="story-review-source"><summary>还没决定的内容</summary>{reasoning.unknowns.map(q => <p key={q.id}>{q.question}</p>)}</details>}
      <p className="story-review-help design-review-footnote">有不合适的内容？先放弃这次预览，再手动调整或重新推演。</p>
    </div>
  </section>
}

function RejectedProposalHistory({ proposals }: { proposals: CurveBeat[] }) {
  if (!proposals.length) return null
  return <section className="rejected-proposal-history" aria-label="未采用内容与调整前版本"><header><strong>未采用内容与调整前版本</strong><small>这些内容仅作历史记录，不属于当前故事设计。</small></header><ul>{proposals.map((proposal, index) => <li key={`${proposal.id}-${index}`}><span>{proposal.title}</span><p>{proposal.detail}</p></li>)}</ul></section>
}

function CurveVersionList({ versions, activeVersionId, disabled, onSelect }: { versions: StoryCurveVersion[]; activeVersionId: string | undefined; disabled: boolean; onSelect: (versionId: string) => void }) {
  if (!versions.length) return <p className="curve-version-empty">还没有可恢复的旧版本。</p>
  return <div className="curve-version-list"><p>恢复版本会替换当前曲线和推演进度；当前版本不会被删除。</p>{versions.map((version) => <button className={`curve-version-item ${version.id === activeVersionId ? 'is-active' : ''}`} type="button" key={version.id} onClick={() => onSelect(version.id)} disabled={disabled || version.id === activeVersionId}><span><strong>{version.label}</strong><small>{getCurveVersionStatus(version)}</small></span>{version.id === activeVersionId ? <Check size={15} /> : <ArrowRight size={15} />}</button>)}</div>
}

function getCurveVersionStatus(version: StoryCurveVersion): string {
  if (version.path?.generatedStory) return '完整故事'
  if (version.confirmedCurve) return '写成故事'
  return '故事设计'
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
