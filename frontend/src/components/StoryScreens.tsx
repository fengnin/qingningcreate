import { type ReactNode } from 'react'
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
import { PredicamentFeedbackControl } from './PredicamentFeedbackControl'
import type {
  StoryHeadTailOption,
  StoryNode,
  StoryPredicament,
  StoryStep,
  StoryTurn,
  StoryTurnHistoryItem,
  StoryTurnOption,
} from '../story/types'
import type { StorySession } from '../story/useStorySession'

const journeyStages: { step: StoryStep; label: string; detail: string }[] = [
  { step: 1, label: '故事困境', detail: '保留念头，补齐阻碍' },
  { step: 2, label: '故事两端', detail: '确定开始与结尾' },
  { step: 3, label: '逐步发展', detail: '选择后，再发生下一步' },
  { step: 4, label: '收束故事', detail: '让主角完成关键行动' },
  { step: 5, label: '写成故事', detail: '生成场景与对白' },
]

const variationAxisLabel: Record<StoryPredicament['variationAxis'], string> = {
  time: '时间',
  resource: '条件',
  relationship: '关系',
  commitment: '承诺',
}

const goalStateLabel: Record<StoryNode['goalState'], string> = {
  trying: '正在尝试',
  blocked: '遇到阻碍',
  'changed-plan': '换一种做法',
  'near-completion': '接近做到',
  resolved: '结果已定',
}

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
            placeholder="例如：李明第一天自己去上学。"
            maxLength={60}
          />
          <span className="field-footer">
            <button className="text-action" type="button" onClick={session.useExample}><RefreshCcw size={15} /> 换个示例</button>
            <small>{session.idea.length} / 60</small>
          </span>
        </label>
        <button className="primary-action opening-action" type="button" onClick={() => void session.openDirectionPicker()} disabled={!session.trimmedIdea}>
          展开故事困境 <ArrowRight size={18} />
        </button>
      </section>
      <footer className="opening-footer"><StoryJourney current={0} /></footer>
    </main>
  )
}

export function DirectionPickerScreen({ session }: { session: StorySession }) {
  const isLoading = session.stageStatus === 'loading'
  const hasDirections = session.predicamentOptions.length > 0

  return (
    <StoryWorkspace
      step={1}
      eyebrow="01 / 05 · 故事困境"
      title="先看看这件事，会遇到什么难处。"
      lead="人物和愿望先不补写；现在只决定阻碍、时机，以及主角要怎样继续。"
      session={session}
      aside={<PredicamentSummary seed={session.seed} predicament={session.selectedPredicament} />}
    >
      {isLoading && <GenerationNotice label="正在展开三种故事困境" detail="保留你的原始念头，再补齐阻碍、时机和代价。" />}
      {session.stageError && <GenerationError message={session.stageError} onRetry={() => void session.retryCurrentStage()} />}
      {!isLoading && hasDirections && (
        <>
          <div className="stage-heading">
            <div>
              <p>围绕“{session.trimmedIdea}”继续</p>
              <strong>原始目标不变，先选它此刻会遇到什么难处。</strong>
            </div>
            <span>选定一种困境后，再决定故事从哪里开始，最后如何收束。</span>
          </div>
          {session.predicamentFeedback.trim() && <p className="direction-feedback-status"><Sparkles size={14} /> 已记住：“{session.predicamentFeedback.trim()}”</p>}
          <div className="direction-list" aria-label="故事困境">
            {session.predicamentOptions.map((predicament, index) => (
              <StoryPredicamentOption
                predicament={predicament}
                index={index}
                key={predicament.id}
                selected={predicament.id === session.selectedPredicamentId}
                onSelect={session.selectPredicament}
              />
            ))}
          </div>
          <PredicamentFeedbackControl
            appliedFeedback={session.predicamentFeedback}
            disabled={isLoading}
            onApplyFeedback={session.applyPredicamentFeedback}
            onShowDifferentPredicaments={session.showDifferentPredicaments}
          />
          <StageActions
            onNext={() => void session.continueToHeadTail()}
            nextLabel="确认这个困境"
            disabled={!session.selectedPredicament}
          />
        </>
      )}
    </StoryWorkspace>
  )
}

export function HeadTailScreen({ session }: { session: StorySession }) {
  return (
    <StoryWorkspace
      step={2}
      eyebrow="02 / 05 · 故事两端"
      title="先定故事从哪里开始，最后如何结束。"
      lead="选择迫使故事开始的事件，并定下主角最后亲自完成的行动、目标结果与代价。"
      session={session}
      aside={<PredicamentSummary seed={session.seed} predicament={session.selectedPredicament} compact />}
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
  const step = hasConclusion ? 4 : 3

  return (
    <StoryWorkspace
      step={step}
      eyebrow={hasConclusion ? '04 / 05 · 故事收束' : '03 / 05 · 逐步发展'}
      title={hasConclusion ? '这些确认的选择，已经让故事可以走向结局。' : '先让这一段发生，再决定下一步。'}
      lead={hasConclusion ? '回看这条由你确认的因果链；结尾会在它之后自然完成。' : '每次只处理当前局面。选定行动后，下一段会承接它的实际后果。'}
      session={session}
      aside={<ProgressSummary option={session.selectedHeadTail} history={session.turnHistory} currentTurn={currentTurn} hasGeneratedStory={Boolean(story)} />}
    >
      {hasConclusion ? (
        <>
          <StoryTurnHistory history={session.turnHistory} />
          {currentTurn && <CurrentStoryTurn currentTurn={currentTurn} selectedOptionId={session.selectedTurnOptionId} onSelect={session.selectTurnOption} hasGeneratedStory={Boolean(story)} />}
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
        {currentTurn && <CurrentStoryTurn currentTurn={currentTurn} selectedOptionId={session.selectedTurnOptionId} onSelect={session.selectTurnOption} />}
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
        <StoryJourney current={5} />
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
            <p className="eyebrow"><FileText size={16} /> 05 / 05 · 完整故事</p>
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
            predicament={session.selectedPredicament}
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
  children,
}: {
  step: StoryStep
  eyebrow: string
  title: string
  lead: string
  session: StorySession
  aside: ReactNode
  children: ReactNode
}) {
  const isRecoveringStoryPath = session.stageStatus === 'error' && step >= 3

  return (
    <main className="app-shell setup-shell stage-shell">
      <header className="setup-header">
        <Brand />
        <StoryJourney current={step} />
        <div className="stage-header-actions">
          {session.generatedStory && <button className="toolbar-action restart-action" type="button" onClick={session.restartStory}><RefreshCcw size={15} /> 新建故事</button>}
          <button className="opening-back" type="button" onClick={session.goBack} disabled={session.stageStatus === 'loading'}><ArrowLeft size={18} /> {isRecoveringStoryPath ? '回到当前故事路径' : '返回上一步'}</button>
        </div>
      </header>
      <section className="setup-layout stage-layout">
        <div className="setup-main stage-main">
          <p className="eyebrow"><StageIcon step={step} size={16} /> {eyebrow}</p>
          <h1 className={step === 2 ? 'head-tail-title' : undefined}>{title}</h1>
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

function StoryPredicamentOption({ predicament, index, selected, onSelect }: { predicament: StoryPredicament; index: number; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button className={`direction-option ${selected ? 'is-selected' : ''}`} type="button" onClick={() => onSelect(predicament.id)}>
      <span className="direction-index">0{index + 1}</span>
      <span className="direction-icon"><FileText size={18} /></span>
      <span className="direction-copy">
        <span className="direction-topline"><em>{variationAxisLabel[predicament.variationAxis]}</em><strong>{predicament.title}</strong></span>
        <span className="direction-premise">{predicament.immediateSituation}</span>
        <span className="direction-anchor-points">
          <span className="direction-anchor-point is-opening"><small>原本想做的事</small><b>{predicament.preservedGoal}</b></span>
          <span className="direction-anchor-connector" aria-hidden="true"><ArrowRight size={15} /></span>
          <span className="direction-anchor-point is-climax"><small>这次必须做的选择</small><b>{predicament.choice}</b></span>
        </span>
        <span className="direction-bridge"><b>眼前阻碍</b>{predicament.obstacle}</span>
        <span className="direction-anchor-meta"><span><b>为什么现在</b>{predicament.urgency}</span><span><b>可能代价</b>{predicament.plausibleCost}</span></span>
      </span>
      <span className="choice-indicator" aria-hidden="true">{selected ? <Check size={15} /> : <span />}</span>
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

function CurrentStoryTurn({ currentTurn, selectedOptionId, onSelect, hasGeneratedStory }: {
  currentTurn: StoryTurn
  selectedOptionId: string | undefined
  onSelect: (optionId: string) => void
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
              />
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function TurnOption({ option, selected, onSelect }: {
  option: StoryTurnOption
  selected: boolean
  onSelect: (optionId: string) => void
}) {
  return (
    <button className={`branch-option ${selected ? 'is-selected' : ''}`} type="button" onClick={() => onSelect(option.id)} aria-pressed={selected}>
      <span className="branch-choice-mark">{selected ? <Check size={15} /> : null}</span>
      <span><strong>{option.label}</strong><small>{option.action}</small><em><b>立即</b>{option.immediateConsequence}</em><em><b>可能影响</b>{option.laterEffect}</em></span>
    </button>
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

function PredicamentSummary({ seed, predicament, compact = false }: { seed: StorySession['seed']; predicament: StoryPredicament | undefined; compact?: boolean }) {
  if (!predicament) return <AsideEmpty icon={<Target size={19} />} label="正在等你确认一个故事困境" detail="选中后，原始目标和这次阻碍会固定下来。" />
  return (
    <>
      <span className="aside-icon"><Target size={19} /></span>
      <p className="eyebrow">已确认的故事困境</p>
      <h2>{predicament.title}</h2>
      <dl className="anchor-preview">
        <div><dt>原始目标</dt><dd>{seed?.lockedGoal ?? predicament.preservedGoal}</dd></div>
        <div><dt>当前阻碍</dt><dd>{predicament.obstacle}</dd></div>
        <div><dt>此刻选择</dt><dd>{predicament.choice}</dd></div>
        {!compact && <div><dt>可能代价</dt><dd>{predicament.plausibleCost}</dd></div>}
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

function StoryBody({ body }: { body: string }) {
  return <div className="story-body">{body.split(/\n{2,}/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
}

function GenerationNotice({ label, detail }: { label: string; detail: string }) {
  return <div className="generation-notice" role="status"><span className="generation-spinner" aria-hidden="true" /><div><strong>{label}</strong><p>{detail}</p></div></div>
}

function GenerationError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="generation-error" role="alert"><CircleAlert size={17} /><div><strong>这一步没有生成成功</strong><p>{message}</p><button className="text-action" type="button" onClick={onRetry}><RefreshCcw size={14} /> 再试一次</button></div></div>
}

function StoryJourney({ current, compact = false }: { current: number; compact?: boolean }) {
  return <nav className={`story-journey ${compact ? 'is-compact' : ''}`} aria-label="创作进度"><ol>{journeyStages.map((stage) => { const isComplete = stage.step < current; const isCurrent = stage.step === current; return <li className={`${isComplete ? 'is-complete' : ''} ${isCurrent ? 'is-current' : ''}`} key={stage.label} aria-current={isCurrent ? 'step' : undefined}><span className="journey-marker">{isComplete ? <Check size={14} /> : String(stage.step).padStart(2, '0')}</span><span className="journey-copy"><strong>{stage.label}</strong><small>{stage.detail}</small></span></li> })}</ol></nav>
}

function StageIcon({ step, size }: { step: StoryStep; size: number }) {
  const Icon = [Target, Route, Waypoints, GitBranch, FileText][step - 1]
  return <Icon size={size} />
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-mark"><BookOpen size={compact ? 17 : 20} /></span><span><strong>时光川行</strong><small>青柠创作平台</small></span></div>
}
