import { useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CircleAlert,
  FileText,
  GitBranch,
  Lightbulb,
  RefreshCcw,
  Route,
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
        <p className="opening-kicker"><Sparkles size={15} /> 从一句话开始</p>
        <h1>时光川行<br />青柠创作平台</h1>
        <p>先把念头变成困境，保持这件事原来的大小，再定下故事两端，一步一步让它发生。</p>
        <label className="idea-field">
          <span>此刻浮现的想法</span>
          <textarea
            value={session.idea}
            onChange={(event) => session.updateIdea(event.target.value)}
            placeholder="例如：毕业前最后一晚，林夏在社团仓库整理器材时发现一台借来的相机。"
            maxLength={maximumStoryIdeaLength}
          />
          <span className="field-footer">
            <button className="text-action" type="button" onClick={session.useExample}><RefreshCcw size={15} /> 换个示例</button>
            <small>{session.idea.length} / {maximumStoryIdeaLength}</small>
          </span>
        </label>
        <button className="primary-action opening-action" type="button" onClick={() => void session.openConflictCorePicker()} disabled={!session.trimmedIdea}>
          寻找冲突核心 <ArrowRight size={18} />
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
  const [isSystemDraftEditorOpen, setIsSystemDraftEditorOpen] = useState(false)
  const systemDraft = session.seed?.systemDraft
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
    setIsSystemDraftEditorOpen(false)
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
  const applySystemDraftAsContext = async (context: StoryConflictCoreContext) => {
    setIsSystemDraftEditorOpen(false)
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
    || isSystemDraftEditorOpen
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
      lead="先只选共同目标、核心阻碍和真正的两难；具体场景与当下压力留到下一步。"
      session={session}
      aside={<ConflictCoreSummary seed={session.seed} core={session.selectedConflictCore} />}
      onBack={goBackFromConflictCore}
      backLabel={shouldReturnToContextChoice ? '返回补充方式' : undefined}
    >
      {isLoading && <GenerationNotice label="正在寻找三种冲突核心" detail="先保留故事主线，再判断什么会真正阻断它。" />}
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
              <strong>三种不同的卡点，都从同一个目标出发。</strong>
            </div>
            <span>先比较难处，再确认哪一种值得展开。</span>
          </div>
          <div className="conflict-core-goal" aria-label="共同目标">
            <span><Target size={14} /> 共同目标</span>
            <strong>{session.seed?.lockedGoal ?? session.conflictCores[0]?.preservedGoal}</strong>
          </div>
          {systemDraft && (
            <SystemDraftSummary
              draft={systemDraft}
              onEdit={() => {
                setHasEnteredContextRoute(true)
                setIsSystemDraftEditorOpen(true)
              }}
            />
          )}
          {systemDraft && isSystemDraftEditorOpen && (
            <ConflictCoreContextForm
              idea={session.trimmedIdea}
              initialContext={mergeConflictCoreContext(session.conflictCoreContext, systemDraft)}
              systemDraft={systemDraft}
              disabled={isLoading}
              onApplyContext={applySystemDraftAsContext}
            />
          )}
          {session.conflictCoreFeedback.trim() && <p className="conflict-core-feedback-status"><Sparkles size={14} /> 已记住：“{session.conflictCoreFeedback.trim()}”</p>}
          <div className="conflict-core-list" aria-label="冲突核心">
            {session.conflictCores.map((core, index) => (
              <ConflictCoreOption
                core={core}
                branchPremise={systemDraft?.directions?.length === 3 ? systemDraft.directions[index]?.premise : undefined}
                index={index}
                key={core.id}
                selected={core.id === session.selectedConflictCoreId}
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
            nextLabel="确认这个冲突核心"
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

function SystemDraftSummary({
  draft,
  onEdit,
}: {
  draft: StoryConflictCoreSystemDraft
  onEdit: () => void
}) {
  const isDeterministicFallback = draft.origin === 'deterministic-fallback'

  return (
    <section className="system-draft-summary" aria-label="系统暂定设定">
      <header>
        <span><Sparkles size={14} /> 系统暂定设定</span>
        <button className="text-action" type="button" onClick={onEdit}>改为自己补充</button>
      </header>
      {isDeterministicFallback && (
        <p className="system-draft-fallback-note"><CircleAlert size={14} /> 模型审核暂时不可用；以下是可编辑的确定性草案，不代表原始事实，也不代表审核通过。</p>
      )}
      <dl>
        <div><dt>目标</dt><dd>{draft.goal}</dd></div>
        <div><dt>代价</dt><dd>{draft.stake}</dd></div>
        <div><dt>限制</dt><dd>{draft.constraint}</dd></div>
      </dl>
      {draft.directions?.length === 3 && (
        <ol className="system-draft-directions" aria-label="系统暂定冲突方向">
          {draft.directions.map((direction, index) => (
            <li key={`${direction.mechanismType}-${direction.label}`}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <div>
                <strong>{direction.label}</strong>
                <p>{direction.premise}</p>
                <p className="system-draft-direction-tradeoff"><small>取舍</small>{direction.tradeoff}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      <p>{draft.directions?.length === 3
        ? '三条前提是互斥的系统暂定分支；选中一条后，只有该方向会进入后续故事。'
        : '这组前提由系统提出，不是原始念头；当前冲突核心会以它为基础继续展开。'}
      </p>
    </section>
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
      lead="把冲突落到当前局面，再选择一条应对方向作为后续故事的起点。"
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
            selectedApproachId={session.selectedApproachId}
            onSelectApproach={session.selectPredicamentApproach}
            disabled={isLoading}
          />
        )}
        <StageActions
          onRegenerate={() => void session.regeneratePredicament()}
          onNext={() => void session.continueToHeadTail()}
          nextLabel="确认这个具体困境"
          disabled={!predicament || !session.selectedApproach}
        />
      </StepContent>
    </StoryWorkspace>
  )
}

export function HeadTailScreen({ session }: { session: StorySession }) {
  return (
    <StoryWorkspace
      step={3}
      eyebrow="03 / 06 · 故事两端"
      title="先定故事从哪里开始，最后如何结束。"
      lead="选择迫使故事开始的事件，并定下主角最后亲自完成的行动、目标结果与代价。"
      session={session}
      aside={<PredicamentSummary seed={session.seed} predicament={session.predicament} approach={session.selectedApproach} compact />}
    >
      <StepContent
        loading={session.stageStatus === 'loading'}
        error={session.stageError}
        loadingLabel="正在生成三种故事两端"
        loadingDetail="让开场线索在预定结尾中得到回应。"
        onRetry={() => void session.retryCurrentStage()}
      >
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
      </StepContent>
    </StoryWorkspace>
  )
}

export function StorySpineScreen({ session }: { session: StorySession }) {
  const currentTurn = session.currentTurn
  const story = session.generatedStory
  const hasConclusion = currentTurn?.isConclusion ?? false
  const canAdvance = Boolean(session.selectedTurnOption && !hasConclusion)
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
      title={hasConclusion ? '这些确认的选择，已经让故事可以走向结局。' : '先让这一段发生，再决定下一步。'}
      lead={hasConclusion ? '回看这条由你确认的因果链；结尾会在它之后自然完成。' : '每次只处理当前局面。选定行动后，下一段会承接它的实际后果。'}
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
          <TurnActions
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
  branchPremise,
  index,
  selected,
  onSelect,
}: {
  core: StoryConflictCore
  branchPremise?: string
  index: number
  selected: boolean
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
        <span className="conflict-core-option-axis">{conflictAxisLabel[core.variationAxis]}</span>
        <span className="conflict-core-option-choice" aria-hidden="true">{selected ? <Check size={14} /> : <span />}</span>
      </span>
      <span className="conflict-core-option-content">
        <strong className="conflict-core-option-title">{core.title}</strong>
        {branchPremise && <span className="conflict-core-option-premise"><small>本方向暂定</small><b>{branchPremise}</b></span>}
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
  selectedApproachId,
  onSelectApproach,
  disabled,
}: {
  predicament: StoryPredicament
  selectedApproachId: string | undefined
  onSelectApproach: (id: string) => void
  disabled: boolean
}) {
  return (
    <section className="predicament-detail" aria-label="具体困境">
      <header className="predicament-detail-heading">
        <span>{variationAxisLabel[predicament.variationAxis]}</span>
        <h2>{predicament.title}</h2>
      </header>
      <div className="predicament-scene">
        <span>当前场景</span>
        <p>{predicament.immediateSituation}</p>
      </div>
      <PredicamentContext predicament={predicament} />
      <PredicamentApproachPicker
        approaches={predicament.approaches}
        selectedApproachId={selectedApproachId}
        onSelectApproach={onSelectApproach}
        disabled={disabled}
      />
    </section>
  )
}

function PredicamentContext({ predicament }: { predicament: StoryPredicament }) {
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
      <section className="predicament-known-facts" aria-label="暂定事实">
        <p>暂定事实</p>
        <ul>
          {predicament.facts.map((fact) => <li key={fact.id}>{fact.statement}</li>)}
        </ul>
      </section>
    </>
  )
}

function PredicamentApproachPicker({
  approaches,
  selectedApproachId,
  onSelectApproach,
  disabled,
}: {
  approaches: StoryPredicamentApproach[]
  selectedApproachId: string | undefined
  onSelectApproach: (id: string) => void
  disabled: boolean
}) {
  return (
    <section className="predicament-approach-section" aria-label="选择应对方向">
      <p>选择一条应对方向</p>
      <div className="predicament-approaches">
        {approaches.map((approach, index) => (
          <PredicamentApproachOption
            approach={approach}
            index={index}
            key={approach.id}
            selected={approach.id === selectedApproachId}
            onSelect={onSelectApproach}
            disabled={disabled}
          />
        ))}
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
      <span className="predicament-approach-heading">
        <span className="predicament-approach-label">方向 {index + 1}</span>
        <span className="choice-indicator" aria-hidden="true">{selected ? <Check size={14} /> : <span />}</span>
      </span>
      <strong>{approach.intent}</strong>
      <span className="predicament-approach-cost"><b>直接代价</b><span>{approach.cost}</span></span>
    </button>
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
      <header className="turn-section-heading"><span>已经发生</span><small>这些行动和后果会成为下一段的前因。</small></header>
      <ol className="story-spine-chain">
        {history.map((item, index) => <ConfirmedTurnRow item={item} index={index} key={item.turnId} />)}
      </ol>
    </section>
  )
}

function ConfirmedTurnRow({ item, index }: { item: StoryTurnHistoryItem; index: number }) {
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
          <div><dt>主角选择</dt><dd>{item.selectedOption.action}</dd></div>
          <div><dt>当下结果</dt><dd>{item.selectedOption.immediateConsequence}</dd></div>
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
        <span>{currentTurn.isConclusion ? '故事结局' : '当前情境'}</span>
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
        <span><strong>{option.label}</strong><small>{option.action}</small><em><b>立即</b>{option.immediateConsequence}</em><em><b>可能影响</b>{option.laterEffect}</em></span>
      </button>
      <StoryTurnOptionRefinementControl option={option} disabled={disabled} onRefine={onRefineOption} />
    </div>
  )
}

function TurnActions({ canConclude, disabled, onContinue, onConclude }: {
  canConclude: boolean
  disabled: boolean
  onContinue: () => void
  onConclude: () => void
}) {
  return (
    <div className="stage-actions turn-actions">
      {canConclude && <button className="text-action" type="button" onClick={onConclude} disabled={disabled}>确认这次选择，开始写结尾 <ArrowRight size={15} /></button>}
      <button className="primary-action" type="button" onClick={onContinue} disabled={disabled}>确认选择，继续发展 <ArrowRight size={18} /></button>
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
