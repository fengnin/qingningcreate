import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { Archive, ArrowLeft, ArrowRight, Check, CircleAlert, FileText, History, PencilLine, RefreshCcw, Sparkles, Trash2 } from 'lucide-react'
import type { CreativeBrief, CreativeTone, CurveBeat, DramaticForce, StoryAuthorClarification, StoryAuthorClarificationAction, StoryCurveVersion, StorySourceFact, StoryCurveRegenerationDecision } from '../story/types'
import type { StorySession } from '../story/useStorySession'
import { StoryRequirementsFields } from './StoryRequirementsFields'
import { requestPreparationGoalSuggestion } from '../story/storyApi'
import type { StoryReasoningProposal, StoryReasoningStatement } from '../../../shared/story-reasoning-contract.js'
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
        <div className="cocreation-step"><span>01</span><strong>创意方向</strong><small>先决定这件事往哪里变有趣</small></div>
        <span className="model-label"><span className="status-dot" /> 共创工作区</span>
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
            <span><strong>允许系统提出具名人物</strong><small>关闭时，系统只使用“陌生人”“工作人员”等匿名称呼。</small></span>
          </label>

          {session.stageError && <p className="cocreation-error" role="alert"><CircleAlert size={16} /> {session.stageError}</p>}
          <div className="cocreation-actions">
            <button className="primary-action" type="button" onClick={submit} disabled={isLoading || isSubmitting}>{isLoading || isSubmitting ? '正在整理主线…' : hasExistingSession ? (versionMode === 'new-version' ? '生成并保留为新版本' : '更新当前草案') : '生成暂定故事曲线'} <ArrowRight size={18} /></button>
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
  const hasStartedStoryPath = Boolean(session.currentTurn)
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
      await session.regenerateCurveBeat(beatId, regenerationFeedback, replaceRejected)
      setRegenerationFeedback('')
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

  const regenerateAffected = async () => {
    setIsRegeneratingAffected(true)
    try {
      await session.regenerateAffectedCurveBeats(regenerationFeedback.trim() || undefined)
      setRegenerationFeedback('')
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

  const updateFactDisposition = async (fact: StorySourceFact, disposition: 'parked' | 'integrated') => {
    setBusyFactId(fact.id)
    try {
      await session.setSourceFactDisposition(fact.id, disposition)
    } finally {
      setBusyFactId(undefined)
    }
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
    && unresolvedClarifications.length === 0
    && missingDesignSections.length === 0
    && !session.confirmedCurve
    && (!curve.reasoning?.designReview || designReviewItems(curve.reasoning).filter(s => s.basis.kind === 'design-proposal').every(s => acceptedDesignIds.includes(s.id) || curve.reasoning!.designReview!.acceptedProposalIds.includes(s.id)))

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
          {acceptedFutureChoice && <p className="curve-future-choice"><strong>选定方向可能推向</strong><span>{acceptedFutureChoice}</span></p>}
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
              sourceFacts={sourceFacts}
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
              onBeginEdit={beginEdit}
              onEditingValueChange={setEditingValue}
              onSaveEdit={(event) => void saveBeatEdit(event)}
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
          {curve.reasoning && <ReasoningDesignReview reasoning={curve.reasoning} acceptedIds={acceptedDesignIds} onChange={setAcceptedDesignIds} disabled={isLoading || Boolean(session.confirmedCurve)} />}
          {!session.confirmedCurve && <RejectedProposalHistory proposals={curve.rejectedProposals ?? []} />}
          {!session.confirmedCurve && <label className="curve-feedback-field"><span>给系统一句修改方向 <small>可选，作用于下一次重推</small></span><input value={regenerationFeedback} onChange={(event) => setRegenerationFeedback(event.target.value)} placeholder="例如：让阻碍来自关系承诺，而不是新增一个外部人物" maxLength={180} disabled={isLoading} /></label>}
           {staleBeats.length > 0 && !session.confirmedCurve && !session.pendingCurveRegeneration && <div className="curve-stale-panel"><p className="curve-stale-notice"><CircleAlert size={15} /> 你修改了上游节点，下面的节点需要重新看一遍。作者编辑不会被系统批量覆盖。</p><div className="curve-stale-actions">{staleProposalBeats.length > 0 && <button className="text-action" type="button" onClick={() => void regenerateAffected()} disabled={isLoading || isRegeneratingAffected}>{isRegeneratingAffected ? '正在生成重推预览…' : <><RefreshCcw size={14} /> 生成重推差异预览</>}</button>}{staleAuthorBeats.length > 0 && <div className="curve-stale-author-actions"><span>你的版本需要单独决定：</span>{staleAuthorBeats.map((beat) => <button className="text-action" type="button" key={beat.id} onClick={() => beginEdit(beat)} disabled={isLoading}><PencilLine size={14} /> 编辑我的版本</button>)}</div>}{staleBeats.length - staleProposalBeats.length > 0 && <span>原始材料可在下方账本中选择“暂不纳入本版本”；处理完所有 stale 节点后才能确认。</span>}</div></div>}
           {session.pendingCurveRegeneration && <CurveRegenerationReview
             preview={session.pendingCurveRegeneration}
             decisions={regenerationDecisions}
             disabled={isLoading}
             onDecision={(id, decision) => setRegenerationDecisions((current) => ({ ...current, [id]: decision }))}
             onResolve={(ids, designIds) => void resolveRegeneration(ids, designIds)}
           />}
          {missingDesignSections.length > 0 && !session.confirmedCurve && <p className="curve-stale-notice curve-design-warning"><CircleAlert size={15} /> 故事设计记录还缺少：{missingDesignSections.join('、')}。请恢复或编辑相关节点后再确认。</p>}
          {!session.confirmedCurve && sourceFacts.length > 0 && <details className="story-review-details" open={unresolvedFacts.length > 0}><summary>查看原文保留情况{unresolvedFacts.length > 0 && <span>{unresolvedFacts.length} 项待决定</span>}</summary><SourceFactLedger facts={sourceFacts} beats={curve.beats} busyFactId={busyFactId} disabled={isLoading} onSetDisposition={updateFactDisposition} /></details>}
          <div className="curve-version-bar"><button className="text-action" type="button" onClick={() => setShowVersions((visible) => !visible)} disabled={isLoading}><History size={15} /> {showVersions ? '收起版本记录' : `查看已保存版本（${session.curveVersions.length}）`}</button>{showVersions && <CurveVersionList versions={session.curveVersions} activeVersionId={session.activeCurveVersionId} disabled={isLoading} onSelect={(versionId) => void session.selectCurveVersion(versionId)} />}</div>
          <div className="curve-footer-actions">
            {session.confirmedCurve ? <button className="primary-action" type="button" onClick={() => hasStartedStoryPath ? void session.continueToStorySpine() : void session.startStorySpineFromCurve()} disabled={isLoading}>{isLoading ? '正在准备第一回合…' : hasStartedStoryPath ? '返回当前推演' : '确认主线后，开始第一回合'} <ArrowRight size={18} /></button> : <button className="primary-action" type="button" onClick={() => void session.confirmProvisionalCurve(acceptedDesignIds)} disabled={!canConfirm}>{isLoading ? '正在确认主线…' : '确定这版故事方向'} <Check size={18} /></button>}
          </div>
        </section>
        <aside className="curve-aside"><div className="curve-aside-title"><Sparkles size={15} /> 共创边界</div><p>你在这里决定故事怎么发展。系统补出的名字、秘密和意外都只是可编辑提案；确认整条主线以前，不会创建连续剧情。</p><div className="curve-aside-divider" /><span>当前状态</span><strong>{session.confirmedCurve ? hasStartedStoryPath ? '主线已确认，正在推演当前情境' : '主线已确认，等待你开始第一回合' : '仍在设计主线，尚未创建剧情回合'}</strong>{!session.confirmedCurve && <small>拒绝的提案不会重新变成故事事实。原始材料必须被纳入，或由你明确暂不纳入。</small>}</aside>
      </div>
    </main>
  )
}

function preparationErrorMessage(session: StorySession) {
  if (session.stageErrorCode === 'STORY_PREPARATION_QUALITY_FAILED') return '这次故事方向没能合理接上你的想法。可以重新构思，也可以修改想法后再试。'
  if (session.stageErrorCode === 'STORY_PREPARATION_INVALID_OUTPUT') return '这次故事方向没有整理完整。可以重新构思；你的想法无需重复填写。'
  return session.stageError
}

function ProvisionalCurveEmptyState({ session, isLoading }: { session: StorySession; isLoading: boolean }) {
  return (
    <main className="app-shell setup-shell cocreation-shell curve-shell">
      <header className="setup-header cocreation-header">
        <button className="opening-back" type="button" onClick={session.goBack} disabled={isLoading}>
          <ArrowLeft size={18} /> 返回创意方向
        </button>
        <div className="cocreation-step"><span>02</span><strong>故事方向</strong><small>比较三种困境，选定一条主线</small></div>
      </header>
      <section className="curve-empty-state" aria-live="polite">
        {isLoading ? (
          <div className="curve-building" role="status" aria-busy="true">
            <div className="curve-building-copy">
              <p className="eyebrow"><Sparkles size={15} /> 故事方向</p>
              <h1>故事正在成形</h1>
              <p>围绕你的想法构思三种不同困境，完成后由你选择故事要往哪里走。</p>
              <div className="curve-building-status"><span aria-hidden="true" /><strong>正在构思故事方向</strong></div>
            </div>
            <div className="curve-building-map preparation-building-map" aria-label="生成流程说明">
              <span className="curve-building-rail" />
              {[
                ['01', '理解你的想法'],
                ['02', '构思困境'],
                ['03', '比较方向'],
              ].map(([number, label]) => (
                <div className="curve-building-node" key={number}>
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
              <strong>这次方向还没准备好</strong>
              <p>{preparationErrorMessage(session)}</p>
              <p>你的想法仍保留在这里。</p>
              <blockquote className="preparation-recovery-idea">{session.trimmedIdea}</blockquote>
              <div className="preparation-recovery-actions">
                <button className="primary-action" type="button" onClick={() => void session.retryCurrentStage()}>重新构思 <RefreshCcw size={16} /></button>
                <button className="text-action" type="button" onClick={session.goBackToOpening}><PencilLine size={16} /> 修改想法</button>
              </div>
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
  sourceFacts: StorySourceFact[]
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
  sourceFacts,
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
        {sourceFactText && <details className="story-review-source"><summary>查看原文</summary><blockquote>{sourceFactText}</blockquote></details>}
        {(beat.status !== 'rejected' || clarifications.length > 0) && <CurveClarificationReview
          beat={beat}
          clarifications={clarifications}
          disabled={isLoading}
          isConfirmed={isConfirmed}
          onClarification={onClarification}
          onRegenerate={onRegenerate}
        />}
        {!isEditing && !isConfirmed && beat.status !== 'rejected' && (
          <div className="curve-beat-actions">
            <button className="text-action" type="button" onClick={() => onBeginEdit(beat)} disabled={isLoading}><PencilLine size={14} /> {beat.status === 'stale' && beat.source === 'user-edit' ? '编辑我的版本' : '编辑节点'}</button>
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
  const [isAdding, setIsAdding] = useState(false)
  const [causalGap, setCausalGap] = useState('')
  const [question, setQuestion] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const submitQuestion = async () => {
    if (!beat.detail.includes(causalGap.trim()) || !question.trim()) return
    if (!await onClarification('create', { causalGap: causalGap.trim(), prompt: question.trim() })) return
    setIsAdding(false)
    setCausalGap('')
    setQuestion('')
  }
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
    {beat.status !== 'rejected' && beat.source !== 'user-input' && (isAdding
      ? <div className="curve-clarification-entry">
        <label><span>节点中的待核对原句</span><input value={causalGap} onChange={(event) => setCausalGap(event.target.value)} maxLength={180} disabled={disabled} /></label>
        <label><span>向作者询问</span><input value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={180} disabled={disabled} /></label>
        <div><button className="text-action" type="button" onClick={() => setIsAdding(false)}>取消</button><button className="text-action" type="button" disabled={disabled || !causalGap.trim() || !beat.detail.includes(causalGap.trim()) || !question.trim()} onClick={() => void submitQuestion()}>记录问题</button></div>
      </div>
      : <button className="text-action" type="button" disabled={disabled} onClick={() => setIsAdding(true)}>{isConfirmed ? '保留旧版并标记待核对前提' : '标记待核对前提'}</button>)}
  </div>
}

function CurveDesignSummary({ curve }: { curve: NonNullable<StorySession['provisionalCurve']> }) {
  const design = curve.design
  if (!design) return null
  const sections = STORY_DESIGN_SECTION_RULES.map(({ key, label }) => [label, design[key]] as const)
  const beatLabel = (id: string) => curve.beats.find((beat) => beat.id === id)?.title ?? id
  const foundation = curve.foundation ?? design.foundation
  return <details className="story-review-details" aria-label="故事设定"><summary>查看故事设定</summary><section className="curve-design-summary">
    <header><strong>故事设定</strong><small>人物目标、阻碍与可能发展</small></header>
    <div className="curve-design-coverage">{sections.map(([label, ids]) => <span key={label}><b>{label}</b>{ids.map(beatLabel).join('、') || '待补充'}</span>)}</div>
    {foundation && <div className="curve-foundation" aria-label="统一故事设计基础">
      <section><b>冲突核心</b><dl><dt>目标</dt><dd>{foundation.conflictCore.goal}</dd><dt>阻碍</dt><dd>{foundation.conflictCore.obstacle}</dd><dt>取舍</dt><dd>{foundation.conflictCore.tradeoff}</dd></dl></section>
      <section><b>具体困境</b><dl><dt>当前处境</dt><dd>{foundation.predicament.immediateSituation}</dd><dt>紧迫性</dt><dd>{foundation.predicament.urgency}</dd><dt>代价</dt><dd>{foundation.predicament.plausibleCost}</dd></dl></section>
      <section><b>中间发展</b><dl><dt>升级</dt><dd>{foundation.middleDevelopment.escalation}</dd><dt>转折</dt><dd>{foundation.middleDevelopment.midpoint}</dd><dt>高潮压力</dt><dd>{foundation.middleDevelopment.climaxPressure}</dd></dl></section>
      <section><b>故事两端</b><dl><dt>开端</dt><dd>{foundation.storyEnds.openingClue}</dd><dt>高潮</dt><dd>{foundation.storyEnds.climax}</dd><dt>变化</dt><dd>{foundation.storyEnds.resolution}</dd></dl></section>
    </div>}
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
  const [acceptedDesignIds, setAcceptedDesignIds] = useState<string[]>([])
  useEffect(() => setAcceptedDesignIds([]), [preview.id])
  useEffect(() => setIndependenceChecked(false), [preview.id])
  const needsIndependentReview = Boolean(preview.excludedUnknownIds?.length) && preview.items.some(i => decisions[i.id] === 'accept')
  const decidedCount = preview.items.filter((item) => decisions[item.id]).length
  const complete = preview.items.length > 0 && decidedCount === preview.items.length
  return <section className="curve-regeneration-review" aria-label="重推差异预览">
    <header><div><strong>重推差异预览</strong><small>逐项查看旧内容和新提案，只有你明确接受的内容才会回到主线。</small></div><span>{decidedCount}/{preview.items.length} 已决定</span></header>
    {preview.reasoning && <ReasoningDesignReview reasoning={preview.reasoning} acceptedIds={acceptedDesignIds} onChange={setAcceptedDesignIds} disabled={disabled} />}
    <div className="curve-regeneration-list">{preview.items.map((item) => <article key={item.id}>
      <div className="curve-regeneration-title"><strong>{item.title}</strong><span>{item.kind}</span></div>
      <div className="curve-regeneration-diff"><div><small>旧内容</small><p>{item.oldDetail}</p></div><ArrowRight size={16} /><div><small>新提案</small><p>{item.newDetail}</p></div></div>
      <div className="curve-regeneration-actions" role="group" aria-label={`${item.title}的决定`}>
        <button className={decisions[item.id] === 'accept' ? 'is-selected' : ''} type="button" onClick={() => onDecision(item.id, 'accept')} disabled={disabled}><Check size={14} /> 接受</button>
        <button className={decisions[item.id] === 'reject' ? 'is-selected is-danger' : ''} type="button" onClick={() => onDecision(item.id, 'reject')} disabled={disabled}><Trash2 size={14} /> 拒绝</button>
      </div>
    </article>)}</div>
    {!complete && <p className="curve-stale-notice"><CircleAlert size={15} /> 请先为每一项选择接受或拒绝。</p>}
    {needsIndependentReview && <label><input type="checkbox" checked={independenceChecked} onChange={e => setIndependenceChecked(e.target.checked)} disabled={disabled} />我已核对新提案未依赖保留的未知前提；这些前提仍未确定。</label>}
    <button className="primary-action" type="button" onClick={() => onResolve(independenceChecked ? preview.excludedUnknownIds : undefined, acceptedDesignIds)} disabled={disabled || !complete || (needsIndependentReview && !independenceChecked)}><Check size={16} /> 应用设计决定（不确认执行）</button>
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
  const p = session.provisionalCurve!.preparation!
  const busy = session.stageStatus === 'loading'
  const submitLock = useRef(false)
  useEffect(() => { setEditing(undefined); setSelectedId(undefined); setReviewed({}) }, [session.provisionalCurve!.id, p.candidates])
  const candidates = p.candidates
  const available = candidates.filter(c => !c.unknownIds.length)
  const active = available[0] ?? candidates[0]
  const criticalQuestion = active?.unknownIds.length ? p.questions.find(q => active.unknownIds.includes(q.id)) : !p.candidates.length ? p.questions[0] : undefined
  const selected = candidates.find(c => c.id === selectedId)
  const renderAction = (value: string) => {
    const match = value.match(/^遇到的难处：([\s\S]*?)\s*眼前的选择：([\s\S]*)$/u)
    if (!match) return <span className="preparation-action-legacy"><small>遇到的难处与眼前的选择</small><span>{value}</span></span>
    return <><span className="preparation-action-part"><small>遇到的难处</small><span>{match[1]}</span></span><span className="preparation-action-part"><small>眼前的选择</small><span>{match[2]}</span></span></>
  }
  const evidenceFor = (ids: string[]) => [...new Set(ids)]
    .map(id => p.material.find(material => material.id === id))
    .filter((material): material is typeof p.material[number] => Boolean(material))
  const editCandidate = (candidate: typeof candidates[number], field: 'action' | 'possibleResult' | 'futureChoice', value: string) => {
    setReviewed(current => ({ ...current, [candidate.id]: {
      action: current[candidate.id]?.action ?? candidate.action,
      possibleResult: current[candidate.id]?.possibleResult ?? candidate.possibleResult,
      futureChoice: current[candidate.id]?.futureChoice ?? candidate.futureChoice,
      [field]: value,
    } }))
  }
  const requestAlternative = async () => {
    if (busy || submitLock.current) return
    submitLock.current = true
    setPendingOperation('regenerate')
    try { await session.revisePreparation('regenerate') } finally { submitLock.current = false; setPendingOperation(undefined) }
  }
  const accept = async (c: typeof p.candidates[number]) => {
    if (busy || submitLock.current) return
    submitLock.current = true
    setPendingOperation('accept')
    const wording = reviewed[c.id] ?? c
    // A click receipts exactly the displayed future design. It supplies no
    // confirmed facts, supersession or execution, and retains server checks.
    try { await session.acceptPreparation([c.id], {
      originalText: `我选择这个故事方向，故事尚未发生。\n方向：${wording.action}${wording.futureChoice ? `\n故事将推向：${wording.futureChoice}` : ''}\n可能走向：${wording.possibleResult}`,
      candidates: [{ id: c.id, action: wording.action, possibleResult: wording.possibleResult, ...(c.futureChoice !== undefined ? { futureChoice: wording.futureChoice ?? '' } : {}) }],
    }) } finally { submitLock.current = false; setPendingOperation(undefined) }
  }
  return <main className="app-shell setup-shell cocreation-shell preparation-workspace">
    <header className="setup-header"><button className="opening-back" type="button" onClick={session.goBackToOpening} disabled={busy}><ArrowLeft size={18} /> 修改想法</button><span className="preparation-brand">青柠创作<span> / </span>一起构思</span><span className="model-label">尚未开始剧情</span></header>
    <div className="preparation-layout">
    <div className="preparation-direction-column" aria-busy={busy}>
    <div className="preparation-intro"><p className="eyebrow">01 / 故事困境</p><h1>这件事会遇到什么难处？</h1><p className="setup-lead">先选一种阻碍与取舍，再继续展开故事。</p></div>
    {!!candidates.length && <div className="preparation-direction-heading"><div><p>围绕你的想法继续</p><strong>原始目标不变，先选它会遇到什么难处。</strong></div><span>选定后，还可以继续修改故事规划。</span></div>}
    {busy && <div className="preparation-generation-feedback" role="status"><strong>{pendingOperation === 'accept' ? '正在整理选中的故事方向' : '正在构思新的一组方向'}</strong><p>{pendingOperation === 'accept' ? '故事方向尚未发生，接下来可以继续修改故事规划。' : '当前方向会保留到操作完成。'}</p></div>}
    {session.stageError && <div className="preparation-generation-feedback is-error" role="alert"><strong>这次调整没有完成</strong><p>{preparationErrorMessage(session)}</p><p>当前方向和你的编辑仍保留，可以继续修改。</p><div className="preparation-recovery-actions"><button className="text-action" type="button" disabled={busy} onClick={() => void requestAlternative()}>换一组方向</button><button className="text-action" type="button" disabled={busy} onClick={session.goBackToOpening}>修改想法</button></div></div>}
    {candidates.map((active, index) => {
      const wording = reviewed[active.id] ?? active
      const directionEvidence = evidenceFor(active.materialIds)
      const goalEvidence = directionEvidence.filter(material => material.role === 'goal')
      const proposedSetup = wording.action.match(/^遇到的难处：([\s\S]*?)\s*眼前的选择：/u)?.[1]?.trim() ?? wording.action
      const bridgeCurrent = wording.action === active.action && wording.possibleResult === active.possibleResult
      return <section className={`preparation-proposal ${selectedId === active.id ? 'is-selected' : ''}`} aria-label={`故事困境 ${index + 1}`} key={active.id}>
      <button className="preparation-choice" type="button" aria-pressed={selectedId === active.id} disabled={busy || !!active.unknownIds.length} onClick={() => setSelectedId(active.id)}>
        <span className="preparation-choice-index">0{index + 1}</span>
        <span className="preparation-choice-icon"><FileText size={18} /></span>
        <span className="preparation-choice-copy"><span className="preparation-choice-action">{renderAction(wording.action)}</span>{wording.futureChoice && <span className="preparation-choice-outcome"><small>故事可能推向</small><span className="preparation-development">{wording.futureChoice}</span></span>}<span className="preparation-choice-outcome"><small>可能走向 · 尚未发生</small><span className="preparation-development">{wording.possibleResult}</span></span></span>
        <span className="preparation-choice-indicator" aria-hidden="true">{selectedId === active.id && <Check size={16} />}</span>
      </button>
      {editing === active.id && <div className="preparation-editor">
        <label>目标、阻碍与取舍<textarea maxLength={240} disabled={busy} value={wording.action} onChange={e => editCandidate(active, 'action', e.target.value)} /></label>
        {wording.futureChoice !== undefined && <label>故事将推向<textarea maxLength={240} disabled={busy} value={wording.futureChoice} onChange={e => editCandidate(active, 'futureChoice', e.target.value)} /></label>}
        <label>可能走向<textarea maxLength={240} disabled={busy} value={wording.possibleResult} onChange={e => editCandidate(active, 'possibleResult', e.target.value)} /></label>
        <p>改变阻碍或取舍后，也请调整可能走向；原始设定请回到“修改想法”。</p>
        <button className="text-action" type="button" disabled={busy} onClick={() => setEditing(undefined)}>完成编辑</button>
      </div>}
      {active.unknownIds.length > 0 && <p className="preparation-missing-condition">暂不能选择，还需确定：{active.unknownIds.map(id => p.questions.find(q => q.id === id)?.question ?? '这条方向的关键条件').join('；')}</p>}
      <div className="preparation-actions">
        <button className="text-action" type="button" disabled={busy} onClick={() => setEditing(editing === active.id ? undefined : active.id)}><PencilLine size={16} /> 编辑</button>
      </div>
      <details className="preparation-evidence preparation-card-evidence">
        <summary>查看依据</summary>
        <p className="preparation-evidence-note">原目标来自你的输入；其余内容是这条方向提出的可能发展，尚未发生。</p>
        <dl>
          <dt>{goalEvidence.length ? '原目标 · 作者原文' : '作者原文'}</dt>
          <dd>{(goalEvidence.length ? goalEvidence : directionEvidence).length ? (goalEvidence.length ? goalEvidence : directionEvidence).map(material => <blockquote key={material.id}>{material.quote}</blockquote>) : '这条方向没有可展示的作者原文。'}</dd>
          <dt>已有铺垫 · 方向提案</dt>
          <dd>{proposedSetup}</dd>
          <dt>可能采取的办法</dt>
          <dd>{!bridgeCurrent ? '方向已调整，原有办法不再作为当前依据。' : active.causalBridge?.method ?? '这条方向尚无可展示的因果桥。'}</dd>
          <dt>处境变化</dt>
          <dd>{!bridgeCurrent ? '方向已调整，原有变化不再作为当前依据。' : active.causalBridge?.change ?? '这条方向尚无可展示的因果桥。'}</dd>
          <dt>更重要的选择</dt>
          <dd>{wording.futureChoice || '这条方向尚未提出下一层选择。'}</dd>
        </dl>
      </details>
    </section>})}
    {!!candidates.length && <div className="preparation-direction-footer"><button className="primary-action" type="button" disabled={busy || !selected || !((reviewed[selected.id]?.action ?? selected.action).trim()) || !((reviewed[selected.id]?.possibleResult ?? selected.possibleResult).trim())} onClick={() => selected && void accept(selected)}>确认这个困境 <ArrowRight size={16} /></button><button className="text-action" type="button" disabled={busy} onClick={() => void requestAlternative()}><RefreshCcw size={16} /> 换一组困境</button></div>}
    {!!candidates.length && <p className="preparation-note">选中的是未来设计，不表示人物已经行动。</p>}
    {!candidates.length && criticalQuestion && <PreparationContextRecovery session={session} disabled={busy} />}
    {!active && !criticalQuestion && <section className="preparation-question"><p>这些方向都先放一放。可以换一组，或继续修改你的想法。</p><button className="primary-action" type="button" disabled={busy} onClick={() => void requestAlternative()}>再想三种方向</button></section>}
    </div>
    <aside className="preparation-source-column">
      <section className="preparation-original" aria-label="作者原文"><small>你的原始想法</small>{p.sources.map(s => <div key={s.id}>{s.id !== 'author-input' && <small>{({ 'author-setting': '已确定的设定', 'author-direction': '希望的发展', 'author-boundaries': '必须保留或避免的内容', 'author-note': '希望故事呈现' } as Record<string, string>)[s.id] ?? '你的补充'}</small>}<blockquote>{s.text}</blockquote></div>)}<button className="text-action" type="button" disabled={busy} onClick={session.goBackToOpening}><PencilLine size={14} /> 修改想法与要求</button></section>
      <details className="preparation-evidence"><summary>查看原文整理</summary>{p.material.map(m => <p key={m.id}><small>{({ fact: '你提供的内容', condition: '故事条件', goal: '人物目标', unknown: '待定内容' })[m.role]}</small> · {m.quote}</p>)}</details>
    </aside>
    </div>
  </main>
}

function PreparationContextRecovery({ session, disabled }: { session: StorySession; disabled: boolean }) {
  const [mode, setMode] = useState<'system' | 'manual'>()
  const [supplement, setSupplement] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [suggestionError, setSuggestionError] = useState('')
  const combinedIdea = `${session.trimmedIdea}${/[。！？]$/u.test(session.trimmedIdea) ? '' : '。'}${supplement.trim()}`
  const getSuggestion = async () => {
    if (!session.storyId || !session.provisionalCurve || suggesting) return
    setMode('system')
    setSuggesting(true)
    setSuggestionError('')
    try {
      setSupplement(await requestPreparationGoalSuggestion({ storyId: session.storyId, revision: session.revision, curveId: session.provisionalCurve.id }))
    } catch (error) {
      setSuggestionError(error instanceof Error ? error.message : '暂时无法生成建议，请再试一次。')
    } finally {
      setSuggesting(false)
    }
  }
  const useSupplement = () => {
    if (!supplement.trim() || combinedIdea.length > 120) return
    session.updateIdea(combinedIdea)
    session.goBackToOpening()
  }
  return <section className="preparation-context-recovery" aria-label="补充故事起点">
    <p className="eyebrow">补充故事起点</p>
    <h2>先决定怎么继续</h2>
    <p>可以让系统提出一条可修改的起点，也可以自己补一句，再生成故事方向。</p>
    <div className="preparation-context-routes" role="group" aria-label="补充方式">
      <button type="button" className={mode === 'system' ? 'is-selected' : ''} disabled={disabled || suggesting} onClick={() => void getSuggestion()}><Sparkles size={17} /><span><strong>让系统先给一版</strong><small>只是一句可修改的建议，不会自动成为你的设定。</small></span><ArrowRight size={16} /></button>
      <button type="button" className={mode === 'manual' ? 'is-selected' : ''} disabled={disabled || suggesting} onClick={() => { setMode('manual'); setSupplement(''); setSuggestionError('') }}><PencilLine size={17} /><span><strong>我来补充设定</strong><small>写一句你愿意加入原始想法的内容。</small></span><ArrowRight size={16} /></button>
    </div>
    {suggesting && <p role="status">正在构思暂定起点…</p>}
    {suggestionError && <p role="alert">{suggestionError}</p>}
    {mode && !suggesting && <div className="preparation-context-editor"><label htmlFor="preparation-context-supplement">{mode === 'system' ? '系统建议 · 可修改' : '你的补充'}</label><textarea id="preparation-context-supplement" value={supplement} onChange={e => setSupplement(e.target.value)} maxLength={120} placeholder="例如：主角想完成哪件事？" disabled={disabled} /><small>{combinedIdea.length} / 120{combinedIdea.length > 120 ? ' · 请缩短补充' : ''}</small><button className="primary-action" type="button" disabled={disabled || !supplement.trim() || combinedIdea.length > 120} onClick={useSupplement}>带着补充返回想法 <ArrowRight size={16} /></button></div>}
  </section>
}
function PreparationSupplementReview({ item, disabled, onReview }: { item: import('../../../shared/story-preparation.js').StoryPreparationSupplement; disabled: boolean; onReview: (id: string, decision: 'accepted-design'|'rejected'|'keep-unknown', text: string) => Promise<void> }) {
  const [authorText, setAuthorText] = useState('')
  return <article><p>待审 {item.kind}：{item.text}</p><p>{item.question}</p><p>审阅状态：{item.status}（不表示执行或结果发生）</p>{item.authorText && <blockquote>{item.authorText}</blockquote>}
    {item.status === 'needs-review' && <><label>独立审阅原文<textarea value={authorText} disabled={disabled} onChange={e => setAuthorText(e.target.value)} /></label>{(['accepted-design','rejected','keep-unknown'] as const).map((decision, i) => <button key={decision} type="button" disabled={disabled || !authorText.trim()} onClick={() => void onReview(item.id, decision, authorText)}>{['仅接受未来设计','拒绝这项设计','保留未知，不依赖它'][i]}</button>)}</>}
  </article>
}

function ReasoningDesignReview({ reasoning, acceptedIds, onChange, disabled }: { reasoning: StoryReasoningProposal; acceptedIds: string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
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
  return <section className="story-direction-review" aria-label="故事方向确认">
    <details className="story-review-details">
      <summary>确认这版故事中的创意 <span>{pending ? `${pending} 项待决定` : proposals.length ? '已选择' : '暂无新增创意'}</span></summary>
      <p className="story-review-help">选择你愿意保留的内容。这里决定下一步怎么写，人物还没有行动。</p>
      {proposals.map(group => {
        const s = group[0], checked = group.every(item => accepted(item.id))
        const unknownIds = s.basis.kind === 'author-text' ? [] : s.basis.unknownIds
        const unresolved = unknownIds.length > 0
        const editableIds = group.filter(item => !reasoning.designReview?.acceptedProposalIds.includes(item.id)).map(item => item.id)
        const quotes = [...new Set(group.flatMap(item => item.basis.kind === 'unknown' ? [] : item.basis.evidence.map(e => e.quote)))]
        return <article className="story-review-choice" key={s.id}>
          {reasoning.designReview ? <label><input type="checkbox" disabled={disabled || unresolved || !editableIds.length} checked={checked} onChange={e => onChange(e.target.checked ? [...new Set([...acceptedIds, ...editableIds])] : acceptedIds.filter(id => !editableIds.includes(id)))} /><span>{s.text}</span></label> : <p>{s.text}</p>}
          {unresolved && <p className="story-review-help">先决定：{unknownIds.map(id => reasoning.unknowns.find(q => q.id === id)?.question ?? '尚待补充的故事条件').join('；')}</p>}
          {!!quotes.length && <details className="story-review-source"><summary>从哪句话出发</summary>{quotes.map(quote => <blockquote key={quote}>{quote}</blockquote>)}<small>原文提供灵感，后续发展仍由你决定。</small></details>}
        </article>
      })}
      {!!sources.length && <details className="story-review-source"><summary>你的原文</summary>{sources.map(text => <blockquote key={text}>{text}</blockquote>)}</details>}
      {!!reasoning.unknowns.length && <details className="story-review-source"><summary>还没决定的内容</summary>{reasoning.unknowns.map(q => <p key={q.id}>{q.question}</p>)}</details>}
      <p className="story-review-help">不想保留的内容，可以回到对应故事节点编辑或换一个提案。</p>
    </details>
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
