import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CircleAlert,
  FileText,
  GitBranch,
  Lightbulb,
  PencilLine,
  RefreshCcw,
  Route,
  Send,
  Sparkles,
  Target,
  Waypoints,
} from 'lucide-react'
import { ConflictCoreFeedbackControl } from './ConflictCoreFeedbackControl'
import { ConflictCoreContextChoice } from './ConflictCoreContextChoice'
import { ConflictCoreContextForm } from './ConflictCoreContextForm'
import { StoryTurnOptionRefinementControl } from './StoryTurnOptionRefinementControl'
import { mergeConflictCoreContext } from '../story/conflictCoreContext'
import type {
  StoryHeadTailOption,
  StoryConflictCore,
  StoryConflictCoreContext,
  StoryConflictCoreSystemDraft,
  StoryNode,
  StoryPredicament,
  StoryPredicamentApproach,
  StoryStep,
  StoryTurn,
  StoryTurnHistoryItem,
  StoryTurnOption,
  StoryVariationAxis,
} from '../story/types'
import type { StorySession } from '../story/useStorySession'

const maximumStoryIdeaLength = 120

const journeyStages: { step: StoryStep; label: string; detail: string }[] = [
  { step: 1, label: '冲突核心', detail: '先确定它卡在哪里' },
  { step: 2, label: '具体困境', detail: '再落到当前局面' },
  { step: 3, label: '故事两端', detail: '确定开始与结尾' },
  { step: 4, label: '逐步发展', detail: '选择后，再发生下一步' },
  { step: 5, label: '收束故事', detail: '让主角完成关键行动' },
  { step: 6, label: '写成故事', detail: '生成场景与对白' },
]

const variationAxisLabel: Record<StoryVariationAxis, string> = {
  time: '时间',
  resource: '条件',
  relationship: '关系',
  commitment: '承诺',
}

const conflictAxisLabel: Record<StoryVariationAxis, string> = {
  time: '时间在逼近',
  resource: '条件在收紧',
  relationship: '关系在拉扯',
  commitment: '承诺在施压',
}

const goalStateLabel: Record<StoryNode['goalState'], string> = {
  trying: '正在尝试',
  blocked: '遇到阻碍',
  'changed-plan': '换一种做法',
  'near-completion': '接近做到',
  resolved: '结果已定',
}

type ConflictCoreContextRouteView = 'choice' | 'manual'

export function OpeningScreen({ session }: { session: StorySession }) {
  return (
    <main className="app-shell opening-shell">
      <div className="opening-image" aria-hidden="true" />
      <div className="opening-shade" aria-hidden="true" />
      <header className="opening-header">
        <Brand />
        <span className="model-label"><span className="status-dot" /> 通义千问</span>
      </header>
      <section className="opening-content">
        {session.restoreError && <p className="cocreation-error" role="alert"><CircleAlert size={16} /> {session.restoreError} <button className="text-action" type="button" onClick={() => void session.retryRestoreSession()}>重试恢复</button></p>}
        <p className="opening-kicker"><Sparkles size={15} /> 从一句话开始</p>
        <h1>时光川行<br />青柠创作平台</h1>
        <p>先由你决定它要讲什么，系统再把想法整理成可编辑的故事曲线；确认主线后，才开始让它发生。</p>
        <label className="idea-field">
          <span className="idea-field-label">此刻浮现的想法 <small>一个人想做的一件事就够了</small></span>
            <textarea
              value={session.idea}
              onChange={(event) => session.updateIdea(event.target.value)}
              placeholder="例如：青柠想去游乐园玩"
              maxLength={maximumStoryIdeaLength}
              disabled={session.restoreLoading}
            />
          <span className="field-footer">
            <button className="text-action" type="button" onClick={session.useExample}><RefreshCcw size={15} /> 换个示例</button>
            <small>{session.idea.length} / {maximumStoryIdeaLength}</small>
          </span>
        </label>
        <button className="primary-action opening-action" type="button" onClick={session.openCreativeBrief} disabled={!session.trimmedIdea || session.restoreLoading}>
          {session.restoreLoading ? '正在恢复上次会话…' : '先定创意方向'} {!session.restoreLoading && <ArrowRight size={18} />}
        </button>
      </section>
      <footer className="opening-footer"><StoryJourney current={0} /></footer>
    </main>
  )
}

export function ConflictCorePickerScreen({ session }: { session: StorySession }) {
  const isLoading = session.stageStatus === 'loading'
  const hasConflictCores = session.conflictCores.length > 0
  const [contextRouteView, setContextRouteView] = useState<ConflictCoreContextRouteView>()
  const [hasEnteredContextRoute, setHasEnteredContextRoute] = useState(false)
  const hasSystemDraftGenerationFailure = session.stageErrorCode === 'SYSTEM_DRAFT_GENERATION_FAILED'
  const hasSystemDraftConflictCoreFailure = session.stageErrorCode === 'SYSTEM_DRAFT_CONFLICT_CORE_RETRY_EXHAUSTED'
  const systemDraftPrefill = hasSystemDraftGenerationFailure
    ? session.stageErrorSystemDraftPrefill
    : undefined
  const isSystemDraftFallbackEditorOpen = contextRouteView === undefined && Boolean(systemDraftPrefill)
  const isContextChoiceVisible = contextRouteView === 'choice'
    || (contextRouteView === undefined && (
      session.stageErrorCode === 'CONFLICT_CORE_NEEDS_CONTEXT'
      || (hasSystemDraftGenerationFailure && !isSystemDraftFallbackEditorOpen)
    ))
  const isManualContextFormOpen = contextRouteView === 'manual'
  const isContextRecoveryVisible = isContextChoiceVisible
    || isManualContextFormOpen
    || isSystemDraftFallbackEditorOpen

  const showContextRouteChoice = () => {
    setContextRouteView('choice')
  }
  const chooseManualContext = () => {
    setHasEnteredContextRoute(true)
    setContextRouteView('manual')
  }
  const generateSystemDraft = () => {
    setHasEnteredContextRoute(true)
    setContextRouteView(undefined)
    void session.generateSystemDraft()
  }
  const applyManualContext = async (context: StoryConflictCoreContext) => {
    setContextRouteView(undefined)
    await session.applyConflictCoreContext(context)
  }
  const retryConflictCoreStage = () => {
    if (hasSystemDraftGenerationFailure || hasSystemDraftConflictCoreFailure) {
      generateSystemDraft()
      return
    }

    void session.retryCurrentStage()
  }
  const shouldReturnToContextChoice = isManualContextFormOpen
    || isSystemDraftFallbackEditorOpen
    || (hasEnteredContextRoute && !isContextChoiceVisible)
  const goBackFromConflictCore = () => {
    if (shouldReturnToContextChoice) {
      showContextRouteChoice()
      return
    }

    session.goBack()
  }

  return (
    <StoryWorkspace
      step={1}
      eyebrow="01 / 06 · 冲突核心"
      title="先确认，主角到底会被什么卡住。"
      lead="先比较同一目标下的阻碍与取舍；具体场景、紧迫性和应对方向留到下一步。"
      session={session}
      aside={<ConflictCoreSummary seed={session.seed} core={session.selectedConflictCore} />}
      onBack={goBackFromConflictCore}
      backLabel={shouldReturnToContextChoice ? '返回补充方式' : undefined}
    >
      {isLoading && <GenerationNotice label="正在生成三条冲突核心" detail="先保留故事主线，再判断什么会真正阻断它。" />}
      {isContextRecoveryVisible ? (
        <ConflictCoreContextRecovery
          session={session}
          disabled={isLoading}
          isManualContextFormOpen={isManualContextFormOpen}
          isSystemDraftFallbackEditorOpen={isSystemDraftFallbackEditorOpen}
          hasSystemDraftGenerationFailure={hasSystemDraftGenerationFailure}
          systemDraftPrefill={systemDraftPrefill}
          onGenerateSystemDraft={generateSystemDraft}
          onChooseManualContext={chooseManualContext}
          onApplyContext={applyManualContext}
        />
      ) : session.stageError ? (
        <GenerationError
          message={session.stageError}
          onRetry={retryConflictCoreStage}
          retryLabel={hasSystemDraftConflictCoreFailure ? '重新生成系统暂定分支' : undefined}
        />
      ) : null}
      {!isLoading && !isContextRecoveryVisible && hasConflictCores && (
        <>
          <div className="stage-heading">
            <div>
              <p>围绕“{session.trimmedIdea}”继续</p>
              <strong>三种不同的冲突机制，都从同一个目标出发。</strong>
            </div>
            <span>比较阻碍和取舍，再确认哪一种值得展开。</span>
          </div>
          <div className="conflict-core-goal" aria-label="共同目标">
            <span><Target size={14} /> 原始目标</span>
            <strong>{session.seed?.lockedGoal ?? session.conflictCores[0]?.preservedGoal}</strong>
          </div>
          {session.seed?.systemDraft && (
            <p className="conflict-core-feedback-status"><Sparkles size={14} /> 以下三条是系统暂定的创意方向；选中一条后，才会成为后续故事的前提。</p>
          )}
          {session.conflictCoreFeedback.trim() && <p className="conflict-core-feedback-status"><Sparkles size={14} /> 已记住：“{session.conflictCoreFeedback.trim()}”</p>}
          <div className="conflict-core-list" aria-label="冲突核心">
            {session.conflictCores.map((core, index) => (
              <ConflictCoreOption
                core={core}
                index={index}
                key={core.id}
                selected={core.id === session.selectedConflictCoreId}
                isSystemDraft={Boolean(session.seed?.systemDraft)}
                onSelect={session.selectConflictCore}
              />
            ))}
          </div>
          <ConflictCoreFeedbackControl
            appliedFeedback={session.conflictCoreFeedback}
            disabled={isLoading}
            onApplyFeedback={session.applyConflictCoreFeedback}
            onShowDifferentConflictCores={session.showDifferentConflictCores}
          />
          <StageActions
            onNext={() => void session.continueToPredicament()}
            nextLabel="展开这条冲突核心"
            disabled={!session.selectedConflictCore}
          />
        </>
      )}
    </StoryWorkspace>
  )
}

function ConflictCoreContextRecovery({
  session,
  disabled,
  isManualContextFormOpen,
  isSystemDraftFallbackEditorOpen,
  hasSystemDraftGenerationFailure,
  systemDraftPrefill,
  onGenerateSystemDraft,
  onChooseManualContext,
  onApplyContext,
}: {
  session: StorySession
  disabled: boolean
  isManualContextFormOpen: boolean
  isSystemDraftFallbackEditorOpen: boolean
  hasSystemDraftGenerationFailure: boolean
  systemDraftPrefill: StoryConflictCoreSystemDraft | undefined
  onGenerateSystemDraft: () => void
  onChooseManualContext: () => void
  onApplyContext: (context: StoryConflictCoreContext) => Promise<void>
}) {
  if (isSystemDraftFallbackEditorOpen && systemDraftPrefill) {
    return (
      <ConflictCoreContextForm
        idea={session.trimmedIdea}
        initialContext={mergeConflictCoreContext(
          systemDraftPrefill,
          session.stageErrorContextPrefill,
          session.conflictCoreContext,
        )}
        prefill={session.stageErrorContextPrefill}
        systemDraft={systemDraftPrefill}
        isSystemDraftRecovery
        disabled={disabled}
        onApplyContext={onApplyContext}
      />
    )
  }

  if (isManualContextFormOpen) {
    return (
      <ConflictCoreContextForm
        idea={session.trimmedIdea}
        initialContext={mergeConflictCoreContext(session.stageErrorContextPrefill, session.conflictCoreContext)}
        prefill={session.stageErrorContextPrefill}
        disabled={disabled}
        onApplyContext={onApplyContext}
      />
    )
  }

  return (
    <ConflictCoreContextChoice
      idea={session.trimmedIdea}
      disabled={disabled}
      hasSystemDraftGenerationFailure={hasSystemDraftGenerationFailure}
      onGenerateSystemDraft={onGenerateSystemDraft}
      onChooseManualContext={onChooseManualContext}
    />
  )
}

export function PredicamentPickerScreen({ session }: { session: StorySession }) {
  const isLoading = session.stageStatus === 'loading'
  const predicament = session.predicament

  return (
    <StoryWorkspace
      step={2}
      eyebrow="02 / 06 · 具体困境"
      title="再把这个阻碍，落到一个当下局面。"
      lead="补齐当前场景、缘由、暂定事实和两条应对方向，先确认故事为什么必须从这里开始。"
      session={session}
      aside={<PredicamentSummary seed={session.seed} predicament={predicament} approach={session.selectedApproach} />}
    >
      <StepContent
        loading={isLoading}
        error={session.stageError}
        loadingLabel="正在展开具体困境"
        loadingDetail="保留已确认的目标和阻碍，再补齐此刻能进入故事的局面。"
        onRetry={() => void session.retryCurrentStage()}
      >
        {predicament && (
          <PredicamentDetail
            predicament={predicament}
            isSystemDraft={Boolean(session.seed?.systemDraft?.activeDirection)}
          />
        )}
        <StageActions
          onRegenerate={() => void session.regeneratePredicament()}
          onNext={session.continueToHeadTail}
          nextLabel="确认这个具体困境"
          disabled={!predicament}
        />
      </StepContent>
    </StoryWorkspace>
  )
}

export function HeadTailScreen({ session }: { session: StorySession }) {
  const isLoading = session.stageStatus === 'loading'
  const hasHeadTailOptions = session.headTailOptions.length > 0

  return (
    <StoryWorkspace
      step={3}
      eyebrow="03 / 06 · 故事两端"
      title="先定故事从哪里开始，最后如何结束。"
      lead="先选故事要从哪条应对方向开始，再定下开场、关键行动和结尾。"
      session={session}
      aside={<PredicamentSummary seed={session.seed} predicament={session.predicament} approach={session.selectedApproach} compact />}
    >
      <StepContent
        loading={isLoading}
        error={session.stageError}
        loadingLabel="正在生成三种故事两端"
        loadingDetail="让开场线索在预定结尾中得到回应。"
        onRetry={() => void session.retryCurrentStage()}
      >
        {session.predicament && (
          <PredicamentApproachPicker
            approaches={session.predicament.approaches}
            selectedApproachId={session.selectedApproachId}
            onSelectApproach={session.selectPredicamentApproach}
            disabled={isLoading}
            heading="选择故事要从哪条方向开始"
          />
        )}
        {hasHeadTailOptions ? (
          <>
            <div className="head-tail-list">
              {session.headTailOptions.map((option, index) => (
                <HeadTailOption
                  key={option.id}
                  option={option}
                  index={index}
                  selected={option.id === session.selectedHeadTailId}
                  onSelect={session.selectHeadTail}
                />
              ))}
            </div>
            <StageActions
              onRegenerate={() => void session.regenerateHeadTail()}
              onNext={() => void session.continueToStorySpine()}
              nextLabel="确认两端，开始逐步发展"
              disabled={!session.selectedHeadTail}
            />
          </>
        ) : (
          <StageActions
            onNext={() => void session.regenerateHeadTail()}
            nextLabel="按这条方向生成故事两端"
            disabled={!session.selectedApproach}
          />
        )}
      </StepContent>
    </StoryWorkspace>
  )
}

export function StorySpineScreen({ session }: { session: StorySession }) {
  const currentTurn = session.currentTurn
  const story = session.generatedStory
  const hasConclusion = currentTurn?.isConclusion ?? false
  const canAdvance = Boolean((session.selectedTurnOption || (currentTurn?.presentation === 'closure-review' && currentTurn.canConclude)) && !hasConclusion)
  const canConclude = currentTurn?.canConclude ?? false
  const isWritingStory = hasConclusion && session.stageStatus === 'loading'
  const hasStoryGenerationError = hasConclusion && Boolean(session.stageError)
  const step = hasConclusion ? 5 : 4
  const currentTurnPanel = currentTurn ? (
    <CurrentStoryTurn
      currentTurn={currentTurn}
      selectedOptionId={session.selectedTurnOptionId}
      onSelect={session.selectTurnOption}
      onRefineOption={session.refineTurnOption}
      disabled={session.stageStatus === 'loading'}
      hasGeneratedStory={Boolean(story)}
    />
  ) : null

  return (
    <StoryWorkspace
      step={step}
      eyebrow={hasConclusion ? '05 / 06 · 故事收束' : '04 / 06 · 逐步发展'}
      title={hasConclusion ? '这些确认的选择，已经让故事可以走向结局。' : '先审阅行动，再确认实际结果。'}
      lead={hasConclusion ? '回看这条由你确认的因果链；结尾会在它之后自然完成。' : '关注点选择不执行动作。候选行动与因果均待审阅，只有你明确确认的实际结果才能进入故事事实。'}
      session={session}
      aside={<ProgressSummary option={session.selectedHeadTail} history={session.turnHistory} currentTurn={currentTurn} hasGeneratedStory={Boolean(story)} />}
    >
      {hasConclusion ? (
        <>
          <StoryTurnHistory history={session.turnHistory} />
          {currentTurnPanel}
          {isWritingStory && <GenerationNotice label="正在按这条路径写成完整故事" detail="完成后会在独立的完整故事页中打开。" />}
          {hasStoryGenerationError && <GenerationError message={session.stageError!} onRetry={() => void session.retryCurrentStage()} />}
          {!isWritingStory && !hasStoryGenerationError && (story ? (
            <StageActions
              onNext={session.viewGeneratedStory}
              nextLabel="查看完整故事"
            />
          ) : (
            <StageActions
              onNext={() => void session.generateFullStory()}
              nextLabel="按这条因果链写成故事"
              disabled={!session.storyPlan}
            />
          ))}
        </>
      ) : (
        <StepContent
          loading={session.stageStatus === 'loading'}
          error={session.stageError}
          loadingLabel="正在承接这次选择，生成下一段情境"
          loadingDetail="只会生成当前这一步，并保留此前已经确认的行动和后果。"
          onRetry={() => void session.retryCurrentStage()}
        >
          <StoryTurnHistory history={session.turnHistory} />
          {currentTurnPanel}
          {session.confirmedCurve && currentTurn && <StoryControlPanel session={session} currentTurn={currentTurn} />}
          <TurnActions
            reviewMode={currentTurn?.presentation}
            canConclude={canConclude}
            disabled={!canAdvance}
            onContinue={() => void session.continueStory()}
            onConclude={() => void session.concludeStory()}
          />
        </StepContent>
      )}
    </StoryWorkspace>
  )
}

export function CompletedStory({ session }: { session: StorySession }) {
  const story = session.generatedStory

  if (!story) return <StorySpineScreen session={session} />

  return (
    <main className="app-shell setup-shell stage-shell complete-shell">
      <header className="setup-header complete-header">
        <Brand />
        <StoryJourney current={6} />
        <div className="stage-header-actions complete-header-actions">
          <button className="opening-back" type="button" onClick={session.goBack}>
            <ArrowLeft size={18} /> 返回故事路径
          </button>
          <button className="toolbar-action restart-action" type="button" onClick={session.restartStory} aria-label="新建故事" title="新建故事">
            <RefreshCcw size={15} /> 新建故事
          </button>
        </div>
      </header>
      <section className="completed-content">
        <header className="completed-heading">
          <span className="complete-mark"><Check size={20} /></span>
          <div>
            <p className="eyebrow"><FileText size={16} /> 06 / 06 · 完整故事</p>
            <h1>{story.title}</h1>
            <p className="completed-logline">{story.logline}</p>
          </div>
        </header>
        <div className="completed-grid">
          <article className="manuscript" aria-label="完整正文">
            <p className="manuscript-label">完整正文</p>
            <StoryBody body={story.body} />
          </article>
          <CompletedStoryPath
            predicament={session.predicament}
            headTail={session.selectedHeadTail}
            history={session.turnHistory}
            conclusion={session.currentTurn?.isConclusion ? session.currentTurn : undefined}
          />
        </div>
      </section>
    </main>
  )
}

function CompletedStoryPath({
  predicament,
  headTail,
  history,
  conclusion,
}: {
  predicament: StoryPredicament | undefined
  headTail: StoryHeadTailOption | undefined
  history: StoryTurnHistoryItem[]
  conclusion: StoryTurn | undefined
}) {
  const startingTitle = headTail?.opening ?? predicament?.title
  const startingDetail = predicament?.immediateSituation ?? headTail?.promise
  const conclusionAction = conclusion?.narrativeAction?.intent ?? conclusion?.conflict.action

  return (
    <aside className="completed-path" aria-label="故事走过的路">
      <p className="manuscript-label"><Route size={16} /> 故事走过的路</p>
      <ol className="completed-path-list">
        {startingTitle && (
          <li className="completed-path-item is-start">
            <span className="completed-path-marker">起点</span>
            <div className="completed-path-copy">
              <p className="completed-path-phase">开场</p>
              <strong>{startingTitle}</strong>
              {startingDetail && <p className="completed-path-summary">{startingDetail}</p>}
              {predicament && (
                <dl className="completed-path-details">
                  <div><dt>目标</dt><dd>{predicament.preservedGoal}</dd></div>
                  <div><dt>阻碍</dt><dd>{predicament.obstacle}</dd></div>
                </dl>
              )}
            </div>
          </li>
        )}
        {history.map((item, index) => (
          <li className="completed-path-item" key={item.turnId}>
            <span className="completed-path-marker">{String(index + 1).padStart(2, '0')}</span>
            <div className="completed-path-copy">
              <p className="completed-path-phase">{turnPhaseLabel[item.phase]}</p>
              <strong>{item.node.title}</strong>
              <p className="completed-path-summary">{item.node.event}</p>
              <dl className="completed-path-details">
                <div><dt>选择</dt><dd>{item.selectedOption.action}</dd></div>
                <div><dt>当下结果</dt><dd>{item.selectedOption.immediateConsequence}</dd></div>
              </dl>
            </div>
          </li>
        ))}
        {conclusion && (
          <li className="completed-path-item is-conclusion">
            <span className="completed-path-marker">结局</span>
            <div className="completed-path-copy">
              <p className="completed-path-phase">实际收束</p>
              <strong>{conclusion.node.title}</strong>
              <p className="completed-path-summary">{conclusion.node.event}</p>
              <dl className="completed-path-details">
                {conclusionAction && <div><dt>完成</dt><dd>{conclusionAction}</dd></div>}
                <div><dt>结果</dt><dd>{conclusion.conflict.consequence}</dd></div>
              </dl>
            </div>
          </li>
        )}
      </ol>
    </aside>
  )
}

function StoryWorkspace({
  step,
  eyebrow,
  title,
  lead,
  session,
  aside,
  onBack,
  backLabel,
  children,
}: {
  step: StoryStep
  eyebrow: string
  title: string
  lead: string
  session: StorySession
  aside: ReactNode
  onBack?: () => void
  backLabel?: string
  children: ReactNode
}) {
  const isRecoveringStoryPath = session.stageStatus === 'error' && step >= 4
  const handleBack = onBack ?? session.goBack

  return (
    <main className="app-shell setup-shell stage-shell">
      <header className="setup-header">
        <Brand />
        <StoryJourney current={step} />
        <div className="stage-header-actions">
          {session.generatedStory && <button className="toolbar-action restart-action" type="button" onClick={session.restartStory}><RefreshCcw size={15} /> 新建故事</button>}
          <button className="opening-back" type="button" onClick={handleBack} disabled={session.stageStatus === 'loading'}><ArrowLeft size={18} /> {backLabel ?? (isRecoveringStoryPath ? '回到当前故事路径' : '返回上一步')}</button>
        </div>
      </header>
      <section className="setup-layout stage-layout">
        <div className="setup-main stage-main">
          <p className="eyebrow"><StageIcon step={step} size={16} /> {eyebrow}</p>
          <h1 className={step === 3 ? 'head-tail-title' : undefined}>{title}</h1>
          <p className="setup-lead">{lead}</p>
          {step > 1 && session.trimmedIdea && (
            <p className="locked-idea"><span><FileText size={14} /> 原始念头</span><strong>{session.trimmedIdea}</strong></p>
          )}
          {children}
        </div>
        <aside className="setup-aside stage-aside" aria-label="已确认的故事资料">{aside}</aside>
      </section>
    </main>
  )
}

function StepContent({ loading, error, loadingLabel, loadingDetail, onRetry, children }: {
  loading: boolean
  error: string | undefined
  loadingLabel: string
  loadingDetail: string
  onRetry: () => void
  children: ReactNode
}) {
  if (loading) return <GenerationNotice label={loadingLabel} detail={loadingDetail} />
  return <>{error && <GenerationError message={error} onRetry={onRetry} />}{children}</>
}

function StageActions({ onRegenerate, onNext, nextLabel, disabled }: {
  onRegenerate?: () => void
  onNext: () => void
  nextLabel: string
  disabled?: boolean
}) {
  return (
    <div className="stage-actions">
      {onRegenerate && <button className="text-action" type="button" onClick={onRegenerate}><RefreshCcw size={15} /> 重新生成这一步</button>}
      <button className="primary-action" type="button" onClick={onNext} disabled={disabled}>{nextLabel} <ArrowRight size={18} /></button>
    </div>
  )
}

function ConflictCoreOption({
  core,
  index,
  selected,
  isSystemDraft,
  onSelect,
}: {
  core: StoryConflictCore
  index: number
  selected: boolean
  isSystemDraft: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      className={`conflict-core-option ${selected ? 'is-selected' : ''}`}
      type="button"
      onClick={() => onSelect(core.id)}
      aria-pressed={selected}
    >
      <span className="conflict-core-option-topline">
        <span className="conflict-core-option-index">{String(index + 1).padStart(2, '0')}</span>
        <span className="conflict-core-option-axis">{isSystemDraft ? '创意方向' : conflictAxisLabel[core.variationAxis]}</span>
        <span className="conflict-core-option-choice" aria-hidden="true">{selected ? <Check size={14} /> : <span />}</span>
      </span>
      <span className="conflict-core-option-content">
        <strong className="conflict-core-option-title">{core.title}</strong>
        <span className="conflict-core-option-obstacle">
          <small>核心阻碍</small>
          <b>{core.obstacle}</b>
        </span>
      </span>
      <span className="conflict-core-option-tradeoff">
        <small>真正的两难</small>
        <b>{core.tradeoff}</b>
      </span>
    </button>
  )
}

function PredicamentDetail({
  predicament,
  isSystemDraft,
}: {
  predicament: StoryPredicament
  isSystemDraft: boolean
}) {
  return (
    <section className="predicament-detail" aria-label="具体困境">
      <header className="predicament-detail-heading">
        <span>{variationAxisLabel[predicament.variationAxis]}</span>
        <h2>{predicament.title}</h2>
      </header>
      <div className="predicament-scene">
        <span>{isSystemDraft ? '当前场景（系统暂定）' : '当前场景'}</span>
        <p>{predicament.immediateSituation}</p>
      </div>
      <PredicamentContext predicament={predicament} isSystemDraft={isSystemDraft} />
      <PredicamentApproachPreviewList approaches={predicament.approaches} />
    </section>
  )
}

function PredicamentContext({
  predicament,
  isSystemDraft,
}: {
  predicament: StoryPredicament
  isSystemDraft: boolean
}) {
  return (
    <>
      <dl className="predicament-facts">
        <div><dt>原始目标</dt><dd>{predicament.preservedGoal}</dd></div>
        <div><dt>直接阻碍</dt><dd>{predicament.obstacle}</dd></div>
        <div><dt>核心取舍</dt><dd>{predicament.tradeoff}</dd></div>
        <div><dt>为什么必须现在处理</dt><dd>{predicament.urgency}</dd></div>
        <div><dt>必须面对</dt><dd>{predicament.choice}</dd></div>
        <div><dt>共同风险</dt><dd>{predicament.plausibleCost}</dd></div>
      </dl>
      <section className="predicament-known-facts" aria-label={isSystemDraft ? '系统暂定事实' : '暂定事实'}>
        <p>{isSystemDraft ? '系统暂定事实' : '暂定事实'}</p>
        <ul>
          {predicament.facts.map((fact) => <li key={fact.id}>{fact.statement}</li>)}
        </ul>
      </section>
    </>
  )
}

function PredicamentApproachPreviewList({ approaches }: { approaches: StoryPredicamentApproach[] }) {
  return (
    <PredicamentApproachList
      approaches={approaches}
      heading="两条可行的应对方向"
      ariaLabel="可行应对方向"
      renderApproach={(approach, index) => (
        <div className="predicament-approach is-preview" key={approach.id}>
          <PredicamentApproachCardContent approach={approach} index={index} />
        </div>
      )}
    />
  )
}

function PredicamentApproachPicker({
  approaches,
  selectedApproachId,
  onSelectApproach,
  disabled,
  heading,
}: {
  approaches: StoryPredicamentApproach[]
  selectedApproachId: string | undefined
  onSelectApproach: (id: string) => void
  disabled: boolean
  heading: string
}) {
  return (
    <PredicamentApproachList
      approaches={approaches}
      heading={heading}
      ariaLabel="选择应对方向"
      renderApproach={(approach, index) => (
          <PredicamentApproachOption
            approach={approach}
            index={index}
            key={approach.id}
            selected={approach.id === selectedApproachId}
            onSelect={onSelectApproach}
            disabled={disabled}
          />
      )}
    />
  )
}

function PredicamentApproachList({
  approaches,
  heading,
  ariaLabel,
  renderApproach,
}: {
  approaches: StoryPredicamentApproach[]
  heading: string
  ariaLabel: string
  renderApproach: (approach: StoryPredicamentApproach, index: number) => ReactNode
}) {
  return (
    <section className="predicament-approach-section" aria-label={ariaLabel}>
      <p>{heading}</p>
      <div className="predicament-approaches">
        {approaches.map(renderApproach)}
      </div>
    </section>
  )
}

function PredicamentApproachOption({
  approach,
  index,
  selected,
  onSelect,
  disabled,
}: {
  approach: StoryPredicamentApproach
  index: number
  selected: boolean
  onSelect: (id: string) => void
  disabled: boolean
}) {
  return (
    <button
      className={`predicament-approach ${selected ? 'is-selected' : ''}`}
      type="button"
      onClick={() => onSelect(approach.id)}
      aria-pressed={selected}
      disabled={disabled}
    >
      <PredicamentApproachCardContent approach={approach} index={index} selected={selected} />
    </button>
  )
}

function PredicamentApproachCardContent({
  approach,
  index,
  selected,
}: {
  approach: StoryPredicamentApproach
  index: number
  selected?: boolean
}) {
  return (
    <>
      <span className="predicament-approach-heading">
        <span className="predicament-approach-label">方向 {index + 1}</span>
        {selected !== undefined && (
          <span className="choice-indicator" aria-hidden="true">{selected ? <Check size={14} /> : <span />}</span>
        )}
      </span>
      <strong>{approach.intent}</strong>
      <span className="predicament-approach-cost"><b>直接代价</b><span>{approach.cost}</span></span>
    </>
  )
}

function HeadTailOption({ option, index, selected, onSelect }: { option: StoryHeadTailOption; index: number; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button className={`head-tail-option ${selected ? 'is-selected' : ''}`} type="button" onClick={() => onSelect(option.id)}>
      <span className="stage-option-number">0{index + 1}</span>
      <span className="head-tail-copy">
        <span className="head-tail-promise">{option.promise}</span>
        <span className="head-tail-pair"><span><small>开场</small><b>{option.opening}</b></span><ArrowRight size={17} /><span><small>结尾</small><b>{option.resolution}</b></span></span>
        <span className="head-tail-meta"><span className="head-tail-key-action"><b>关键行动</b>{option.climax}</span><span><b>线索</b>{option.openingClue}</span><span><b>代价</b>{option.cost}</span></span>
      </span>
      <span className="choice-indicator" aria-hidden="true">{selected ? <Check size={15} /> : <span />}</span>
    </button>
  )
}

const turnPhaseLabel: Record<StoryTurn['phase'], string> = {
  opening: '开端',
  development: '发展',
  turn: '转折',
  climax: '高潮前夜',
  resolution: '结局',
}

function StoryTurnHistory({ history }: { history: StoryTurnHistoryItem[] }) {
  if (!history.length) return null

  return (
    <section className="turn-history" aria-label="已确认的故事路径">
      <header className="turn-section-heading"><span>审阅与确认记录</span><small>关注点不属于已执行行动；实际结果另行确认。</small></header>
      <ol className="story-spine-chain">
        {history.map((item, index) => <ConfirmedTurnRow item={item} index={index} key={item.turnId} />)}
      </ol>
    </section>
  )
}

function ConfirmedTurnRow({ item, index }: { item: StoryTurnHistoryItem; index: number }) {
  const isFocus = item.selectedOption.narrativeAction.mode === 'focus'
  return (
    <li className="story-spine-row is-confirmed">
      <span className="story-spine-marker">{String(index + 1).padStart(2, '0')}</span>
      <div className="story-spine-copy">
        <header className="story-spine-heading">
          <span>{turnPhaseLabel[item.phase]}</span>
          <small>目标：{goalStateLabel[item.node.goalState]} · {item.conflict.anchor}</small>
        </header>
        <strong>{item.node.title}</strong>
        <p>{item.node.event}</p>
        <dl className="story-spine-consequences">
          <div><dt>当时阻力</dt><dd>{item.conflict.conflict}</dd></div>
          <div><dt>{isFocus ? '审阅关注点' : '确认行动'}</dt><dd>{item.selectedOption.action}</dd></div>
          <div><dt>{isFocus ? '事实状态' : '作者确认结果'}</dt><dd>{isFocus ? '未执行动作，未改变故事事实。' : item.selectedOption.immediateConsequence}</dd></div>
        </dl>
      </div>
    </li>
  )
}

function CurrentStoryTurn({ currentTurn, selectedOptionId, onSelect, onRefineOption, disabled, hasGeneratedStory }: {
  currentTurn: StoryTurn
  selectedOptionId: string | undefined
  onSelect: (optionId: string) => void
  onRefineOption: StorySession['refineTurnOption']
  disabled: boolean
  hasGeneratedStory?: boolean
}) {
  const { conflict, node } = currentTurn

  return (
    <section className={`current-story-turn ${currentTurn.isConclusion ? 'is-conclusion' : ''}`} aria-label={currentTurn.isConclusion ? '故事结局' : '当前故事情境'}>
      <header className="turn-section-heading">
        <span>{currentTurn.isConclusion ? '故事结局' : currentTurn.presentation === 'candidate-actions' ? '待审阅行动提案' : currentTurn.presentation === 'closure-review' ? '收束审阅' : currentTurn.presentation === 'focus-selection' ? '选择审阅关注点' : '当前情境'}</span>
        <small>{turnPhaseLabel[currentTurn.phase]} · 目标：{goalStateLabel[node.goalState]} · {conflict.anchor}</small>
      </header>
      <div className="current-turn-copy">
        <h2>{node.title}</h2>
        <p>{node.event}</p>
        <p className="story-spine-purpose"><b>这一步如何接上前文</b>{node.purpose}</p>
        <dl className="story-spine-consequences">
          <div><dt>眼前阻力</dt><dd>{conflict.conflict}</dd></div>
          <div><dt>需要面对</dt><dd>{conflict.action}</dd></div>
          <div><dt>若不处理</dt><dd>{conflict.consequence}</dd></div>
        </dl>
      </div>
      {currentTurn.isConclusion ? (
        <p className="conclusion-note"><Check size={16} /> {hasGeneratedStory ? '完整正文已生成，可在独立的完整故事页查看。' : '主角已经亲自完成关键行动，故事可以写成正文。'}</p>
      ) : (
        <>
          <h3 className="turn-question">{currentTurn.question}</h3>
          <div className="branch-options turn-options">
            {currentTurn.options.map((option) => (
              <TurnOption
                key={option.id}
              option={option}
              selected={option.id === selectedOptionId}
              onSelect={onSelect}
              onRefineOption={onRefineOption}
              disabled={disabled}
            />
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function TurnOption({ option, selected, onSelect, onRefineOption, disabled }: {
  option: StoryTurnOption
  selected: boolean
  onSelect: (optionId: string) => void
  onRefineOption: StorySession['refineTurnOption']
  disabled: boolean
}) {
  return (
    <div className="turn-option-group">
      <button className={`branch-option ${selected ? 'is-selected' : ''}`} type="button" onClick={() => onSelect(option.id)} aria-pressed={selected} disabled={disabled}>
        <span className="branch-choice-mark">{selected ? <Check size={15} /> : null}</span>
        <span><strong>{option.label}</strong><small>{option.action}</small><em><b>{option.narrativeAction.mode === 'focus' ? '关注点' : option.proposal ? '待审状态' : '立即'}</b>{option.immediateConsequence}</em><em><b>{option.proposal ? '待审因果' : '可能影响'}</b>{option.laterEffect}</em>
          {option.proposal?.causalClaims.map((claim, index) => <em key={index}><b>待核对</b>{claim.statement}</em>)}
          {option.proposal?.questions.map((question, index) => <em key={index}><b>作者问题</b>{question}</em>)}
        </span>
      </button>
      {!option.narrativeAction.mode && <StoryTurnOptionRefinementControl option={option} disabled={disabled} onRefine={onRefineOption} />}
    </div>
  )
}

function StoryControlPanel({ session, currentTurn }: {
  session: StorySession
  currentTurn: StoryTurn
}) {
  const confirmedBeats = session.confirmedCurve?.beats.filter((beat) => beat.status !== 'rejected') ?? []
  const [authorBeatId, setAuthorBeatId] = useState(confirmedBeats[0]?.id ?? '')
  const [authorText, setAuthorText] = useState('')
  const [roleAction, setRoleAction] = useState('')
  const [executedResult, setExecutedResult] = useState('')
  const [confirmExecuted, setConfirmExecuted] = useState(false)
  const pendingProposal = session.pendingActionProposal?.turnId === currentTurn.id
    ? session.pendingActionProposal
    : undefined
  const disabled = session.stageStatus === 'loading'
  useEffect(() => { setExecutedResult(''); setConfirmExecuted(false) }, [pendingProposal?.id])

  const submitAuthorInstruction = async () => {
    if (!authorBeatId || !authorText.trim()) return
    await session.applyAuthorInstruction(authorBeatId, authorText.trim())
    setAuthorText('')
  }

  const submitRoleAction = async () => {
    if (!roleAction.trim()) return
    await session.proposeStoryAction(roleAction.trim())
  }

  return (
    <section className="story-control-panel" aria-label="作者控制与角色行动">
      <div className="author-control-block">
        <header className="control-block-heading">
          <span><PencilLine size={15} /> 作者调整主线</span>
          <small>修改故事设计，提交后回到主线确认</small>
        </header>
        <div className="author-control-fields">
          <label>
            <span>调整节点</span>
            <select value={authorBeatId} onChange={(event) => setAuthorBeatId(event.target.value)} disabled={disabled}>
              {confirmedBeats.map((beat) => <option value={beat.id} key={beat.id}>{beat.title}</option>)}
            </select>
          </label>
          <label className="control-wide-field">
            <span>作者指令</span>
            <textarea value={authorText} onChange={(event) => setAuthorText(event.target.value)} maxLength={180} placeholder="例如：让这个转折先回应前面的承诺，再决定是否继续。" disabled={disabled} />
          </label>
          <button className="text-action" type="button" onClick={() => void submitAuthorInstruction()} disabled={disabled || !authorBeatId || !authorText.trim()}>
            <PencilLine size={14} /> 提交作者调整
          </button>
        </div>
      </div>

      {!currentTurn.isConclusion && (
        <div className="role-action-block">
          <header className="control-block-heading">
            <span><Send size={15} /> 提出角色行动</span>
            <small>只改变当前回合的角色选择，不修改主线</small>
          </header>
          <div className="role-action-fields">
            <label>
              <span>这一次，角色可以怎么做</span>
              <textarea value={roleAction} onChange={(event) => setRoleAction(event.target.value)} maxLength={180} placeholder="例如：先把手里的信息说清楚，再回应眼前的阻碍。" disabled={disabled} />
            </label>
            <button className="text-action" type="button" onClick={() => void submitRoleAction()} disabled={disabled || !roleAction.trim()}>
              <Send size={14} /> 生成行动提案
            </button>
          </div>
          {pendingProposal && (
            <div className="pending-action-proposal">
              <div className="pending-action-heading"><strong>角色行动提案</strong><span>尚未写入故事</span></div>
              <p>{pendingProposal.action}</p>
              <dl>
                <div><dt>依据</dt><dd>{pendingProposal.grounding}</dd></div>
                <div><dt>审阅状态</dt><dd>{pendingProposal.immediateConsequence}</dd></div>
                <div><dt>待审承接</dt><dd>{pendingProposal.laterEffect}</dd></div>
                {pendingProposal.option.proposal?.causalClaims.map((claim, index) => <div key={index}><dt>待核对因果</dt><dd>{claim.statement}</dd></div>)}
                {pendingProposal.option.proposal?.questions.map((question, index) => <div key={index}><dt>作者问题</dt><dd>{question}</dd></div>)}
              </dl>
              {pendingProposal.requiresExecutedResultConfirmation && <>
                <p>结果尚未确定时，保留待审状态，或重新提出不依赖未知前提的行动。材料引用与模型提案不代表事实确认。</p>
                <label><span>作者确认的实际结果原文</span><textarea value={executedResult} onChange={(event) => setExecutedResult(event.target.value)} maxLength={180} placeholder="仅填写你确认已发生的结果；不要复制模型预测代替判断。" disabled={disabled} /></label>
                <label><input type="checkbox" checked={confirmExecuted} onChange={(event) => setConfirmExecuted(event.target.checked)} disabled={disabled} />我明确确认上述行动已执行，填写的是实际结果。</label>
              </>}
              <div className="pending-action-buttons">
                <button className="text-action" type="button" onClick={() => void session.confirmStoryActionProposal('continue', pendingProposal.requiresExecutedResultConfirmation ? { actionText: pendingProposal.action, resultText: executedResult.trim() } : undefined)} disabled={disabled || Boolean(pendingProposal.requiresExecutedResultConfirmation && (!confirmExecuted || !executedResult.trim()))}>{pendingProposal.requiresExecutedResultConfirmation ? '确认实际行动与结果，审阅下一步' : '接受并继续发展'} <ArrowRight size={14} /></button>
                {!pendingProposal.requiresExecutedResultConfirmation && currentTurn.canConclude && <button className="text-action" type="button" onClick={() => void session.confirmStoryActionProposal('conclude')} disabled={disabled}>接受并进入收束 <Check size={14} /></button>}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function TurnActions({ canConclude, disabled, onContinue, onConclude, reviewMode }: {
  reviewMode?: StoryTurn['presentation']
  canConclude: boolean
  disabled: boolean
  onContinue: () => void
  onConclude: () => void
}) {
  return (
    <div className="stage-actions turn-actions">
      {reviewMode === 'closure-review' ? <p className="conclusion-note">已没有新的待执行行动；请在作者调整入口提出下一目标，或直接结束当前主线。</p> : null}
      {reviewMode === 'closure-review' && canConclude && <button className="primary-action" type="button" onClick={onConclude} disabled={disabled}>按已确认路径收束 <Check size={15} /></button>}
      {reviewMode !== 'closure-review' && canConclude && <button className="text-action" type="button" onClick={onConclude} disabled={disabled}>确认这次选择，开始写结尾 <ArrowRight size={15} /></button>}
      {reviewMode !== 'closure-review' && <button className="primary-action" type="button" onClick={onContinue} disabled={disabled}>{reviewMode === 'focus-selection' ? '选择关注点，生成待审行动' : reviewMode === 'candidate-actions' ? '打开这项提案审阅' : '确认选择，继续发展'} <ArrowRight size={18} /></button>}
    </div>
  )
}

function ConflictCoreSummary({ seed, core }: { seed: StorySession['seed']; core: StoryConflictCore | undefined }) {
  if (!core) return <AsideEmpty icon={<Target size={19} />} label="正在等你确认一个冲突核心" detail="先选定故事目标会被什么真正卡住。" />
  return (
    <>
      <span className="aside-icon"><Target size={19} /></span>
      <p className="eyebrow">已确认的冲突核心</p>
      <dl className="anchor-preview">
        <div><dt>{getStoryGoalLabel(seed)}</dt><dd>{seed?.lockedGoal ?? core.preservedGoal}</dd></div>
        <div><dt>核心阻碍</dt><dd>{core.obstacle}</dd></div>
        <div><dt>真正的两难</dt><dd>{core.tradeoff}</dd></div>
      </dl>
      <div className="aside-principle"><Lightbulb size={16} /><span>下一步会把这个阻碍落到具体局面，但不会偷偷换掉目标。</span></div>
    </>
  )
}

function PredicamentSummary({
  seed,
  predicament,
  approach,
  compact = false,
}: {
  seed: StorySession['seed']
  predicament: StoryPredicament | undefined
  approach: StoryPredicamentApproach | undefined
  compact?: boolean
}) {
  if (!predicament) return <AsideEmpty icon={<Target size={19} />} label="正在等你确认一个故事困境" detail="选中后，故事目标和这次阻碍会固定下来。" />
  return (
    <>
      <span className="aside-icon"><Target size={19} /></span>
      <p className="eyebrow">已确认的故事困境</p>
      <h2>{predicament.title}</h2>
      <dl className="anchor-preview">
        <div><dt>{getStoryGoalLabel(seed)}</dt><dd>{seed?.lockedGoal ?? predicament.preservedGoal}</dd></div>
        <div><dt>当前阻碍</dt><dd>{predicament.obstacle}</dd></div>
        <div><dt>核心取舍</dt><dd>{predicament.tradeoff}</dd></div>
        <div><dt>眼前取舍</dt><dd>{predicament.choice}</dd></div>
        {approach && <div><dt>已选方向</dt><dd>{approach.intent}</dd></div>}
        {!compact && approach && <div><dt>方向代价</dt><dd>{approach.cost}</dd></div>}
        {!compact && <div><dt>共同风险</dt><dd>{predicament.plausibleCost}</dd></div>}
      </dl>
      <div className="aside-principle"><Lightbulb size={16} /><span>后续步骤会保留这件事和这次阻碍，不会悄悄换成另一条主线。</span></div>
    </>
  )
}

function ProgressSummary({ option, history, currentTurn, hasGeneratedStory }: {
  option: StoryHeadTailOption | undefined
  history: StoryTurnHistoryItem[]
  currentTurn: StoryTurn | undefined
  hasGeneratedStory?: boolean
}) {
  if (!option) return <AsideEmpty icon={<Route size={19} />} label="正在等你确认故事两端" detail="选定开场、关键行动和结尾后，故事才能逐步发展。" />

  const currentLabel = hasGeneratedStory
    ? '完整故事已写成'
    : currentTurn?.isConclusion
    ? '已收束，可以写成故事'
    : history.length
      ? `已确认 ${history.length} 次行动`
      : '正在生成第一个情境'

  return (
    <>
      <span className="aside-icon"><Waypoints size={19} /></span>
      <p className="eyebrow">故事约束</p>
      <h2>{currentLabel}</h2>
      <dl className="anchor-preview">
        <div><dt>开场</dt><dd>{option.opening}</dd></div>
        <div><dt>结尾</dt><dd>{option.resolution}</dd></div>
        <div><dt>线索</dt><dd>{option.openingClue}</dd></div>
        <div><dt>最终行动</dt><dd>{option.climax}</dd></div>
        <div><dt>要承担的代价</dt><dd>{option.cost}</dd></div>
      </dl>
      <div className="aside-principle"><Lightbulb size={16} /><span>{hasGeneratedStory ? '完整正文仍保留这条已确认的因果链，修改时可以回到路径中的任一步。' : '每次选择都会承接前一段的后果，并朝已确认的结尾推进。'}</span></div>
    </>
  )
}

function AsideEmpty({ icon, label, detail }: { icon: ReactNode; label: string; detail: string }) {
  return <><span className="aside-icon">{icon}</span><p className="eyebrow">创作向导</p><h2>{label}</h2><div className="aside-principle"><Lightbulb size={16} /><span>{detail}</span></div></>
}

function getStoryGoalLabel(seed: StorySession['seed']): string {
  if (seed?.lockedGoal) return '原始目标'
  return seed?.systemDraft ? '暂定目标' : '故事目标'
}

function StoryBody({ body }: { body: string }) {
  return <div className="story-body">{body.split(/\n{2,}/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
}

function GenerationNotice({ label, detail }: { label: string; detail: string }) {
  return <div className="generation-notice" role="status"><span className="generation-spinner" aria-hidden="true" /><div><strong>{label}</strong><p>{detail}</p></div></div>
}

function GenerationError({ message, onRetry, retryLabel = '再试一次' }: {
  message: string
  onRetry: () => void
  retryLabel?: string
}) {
  return (
    <div className="generation-error" role="alert">
      <CircleAlert size={17} />
      <div>
        <strong>这一步没有生成成功</strong>
        <p>{message}</p>
        <button className="text-action" type="button" onClick={onRetry}><RefreshCcw size={14} /> {retryLabel}</button>
      </div>
    </div>
  )
}

function StoryJourney({ current, compact = false }: { current: number; compact?: boolean }) {
  return <nav className={`story-journey ${compact ? 'is-compact' : ''}`} aria-label="创作进度"><ol>{journeyStages.map((stage) => { const isComplete = stage.step < current; const isCurrent = stage.step === current; return <li className={`${isComplete ? 'is-complete' : ''} ${isCurrent ? 'is-current' : ''}`} key={stage.label} aria-current={isCurrent ? 'step' : undefined}><span className="journey-marker">{isComplete ? <Check size={14} /> : String(stage.step).padStart(2, '0')}</span><span className="journey-copy"><strong>{stage.label}</strong><small>{stage.detail}</small></span></li> })}</ol></nav>
}

function StageIcon({ step, size }: { step: StoryStep; size: number }) {
  const Icon = [Target, FileText, Route, Waypoints, GitBranch, FileText][step - 1]
  return <Icon size={size} />
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-mark"><BookOpen size={compact ? 17 : 20} /></span><span><strong>时光川行</strong><small>青柠创作平台</small></span></div>
}
