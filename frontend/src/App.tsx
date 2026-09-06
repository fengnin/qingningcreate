import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CircleAlert,
  CircleDot,
  Clock3,
  FileText,
  Flame,
  GitBranch,
  Lightbulb,
  Map,
  PenLine,
  Plus,
  RefreshCcw,
  Sparkles,
  Target,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react'

type Act = '起' | '承' | '转' | '合'
type ValidationTone = 'pass' | 'warn' | 'pending'

interface StoryDirection {
  id: string
  title: string
  genre: string
  logline: string
  protagonist: string
  goal: string
  obstacle: string
  stakes: string
  urgency: string
  icon: LucideIcon
}

interface Choice {
  id: string
  strategy: string
  title: string
  action: string
  gain: string
  risk: string
  consequence: string
  clue: string
}

interface StoryStage {
  id: string
  act: Act
  label: string
  title: string
  scene: string
  question: string
  pressure: number
  marker?: string
  choices: Choice[]
}

interface StoryNode {
  id: string
  act: Act
  title: string
  action: string
  summary: string
  risk: string
  clue: string
  pressure: number
  marker?: string
}

interface ValidationItem {
  label: string
  value: string
  detail: string
  tone: ValidationTone
}

const examples = [
  '一个失忆侦探收到三天后的自己寄来的信。',
  '一个总是迟到的人，发现时间开始替他倒流。',
  '毕业前夜，三位朋友收到一张十年前写给未来的地图。',
]

const directions: StoryDirection[] = [
  {
    id: 'truth',
    title: '倒计时的证词',
    genre: '悬疑 / 自证清白',
    logline: '主角必须在一条会反噬自己的线索里，找出谁在提前安排结局。',
    protagonist: '陆沉，一名遗失关键记忆的调查者',
    goal: '赶在真相被销毁前找到证词',
    obstacle: '每靠近答案，证据都会将他推成嫌疑人',
    stakes: '他可能害死唯一愿意相信自己的人',
    urgency: '天亮前，最后一位知情人将消失',
    icon: FileText,
  },
  {
    id: 'promise',
    title: '没有终点的末班车',
    genre: '都市奇幻 / 守住承诺',
    logline: '主角发现一趟列车只为未能告别的人停留，却必须决定谁能下车。',
    protagonist: '周予，夜班调度员',
    goal: '把迷路女孩送回她本该抵达的地方',
    obstacle: '女孩的地址与整座旧街区都已从现实中消失',
    stakes: '错过终点，女孩会永远留在车上',
    urgency: '列车将在零点被强制回库',
    icon: Clock3,
  },
  {
    id: 'memory',
    title: '借来的明天',
    genre: '情感奇幻 / 重新选择',
    logline: '主角能用未来换一次改写今天的机会，却发现代价正在落到最亲近的人身上。',
    protagonist: '林晓，一名陷入停滞的插画师',
    goal: '挽回一段正在失去的关系',
    obstacle: '每次改写，都会抹掉共同拥有的一段记忆',
    stakes: '她会成为最爱的人眼中的陌生人',
    urgency: '交易只剩最后一次使用机会',
    icon: Sparkles,
  },
]

const stages: StoryStage[] = [
  {
    id: 'trace',
    act: '起',
    label: '第一次判断',
    title: '线索开始反咬',
    scene: '刚刚出现的痕迹，比预想中更熟悉，也更像一场为主角准备的陷阱。',
    question: '此刻，他要先保住安全，还是先追住答案？',
    pressure: 2,
    marker: '意外',
    choices: [
      {
        id: 'secure',
        strategy: '保守',
        title: '先收起线索，给自己留一条退路',
        action: '先收起线索，给自己留一条退路',
        gain: '暂时避开了立即到来的怀疑。',
        risk: '现场会被别人先一步清理。',
        consequence: '他保住了行动空间，却发现最直接的痕迹已经被擦去。',
        clue: '一枚没有留下姓名的钥匙',
      },
      {
        id: 'pursue',
        strategy: '冒险',
        title: '沿着异常痕迹追到现场深处',
        action: '沿着异常痕迹追到现场深处',
        gain: '拿到了比原计划更接近真相的证物。',
        risk: '自己的行踪也被人完整记录。',
        consequence: '他追到了封闭现场，并在里面看见一件本不该属于自己的东西。',
        clue: '一张拍下主角背影的旧照片',
      },
      {
        id: 'contact',
        strategy: '承担',
        title: '主动联系唯一的知情人',
        action: '主动联系唯一的知情人',
        gain: '让沉默的人给出了一句关键提示。',
        risk: '也让对方知道主角已经入局。',
        consequence: '电话那头只留下一个地点，但有人已经在那里等着他。',
        clue: '一句被刻意省略的地址',
      },
    ],
  },
  {
    id: 'cost',
    act: '承',
    label: '代价浮现',
    title: '每个答案都要付费',
    scene: '新线索没有解除困境，反而把主角与最重要的人绑在同一个风险里。',
    question: '他要把代价留给自己，还是把风险转嫁出去？',
    pressure: 3,
    choices: [
      {
        id: 'hide',
        strategy: '保守',
        title: '隐去最危险的一部分，独自继续调查',
        action: '隐去最危险的一部分，独自继续调查',
        gain: '暂时保护了身边的人。',
        risk: '他失去了可以互相印证的证词。',
        consequence: '他独自背着证据前进，却发现对手早已知道他的下一步。',
        clue: '一段被剪掉开头的录音',
      },
      {
        id: 'trade',
        strategy: '冒险',
        title: '拿一条线索交换另一条线索',
        action: '拿一条线索交换另一条线索',
        gain: '换回了一个能证明时间顺序的细节。',
        risk: '主动交出了自己的软肋。',
        consequence: '交换完成后，他知道了谁在撒谎，也让对方知道了自己最怕失去什么。',
        clue: '一份被改过日期的记录',
      },
      {
        id: 'confess',
        strategy: '承担',
        title: '把危险告诉应该知道的人',
        action: '把危险告诉应该知道的人',
        gain: '得到了一个愿意同行的见证者。',
        risk: '两个人都无法再退回原来的生活。',
        consequence: '有人选择相信他，但这份相信也把对方推到了对手视线里。',
        clue: '一段只有两人听过的旧承诺',
      },
    ],
  },
  {
    id: 'reversal',
    act: '转',
    label: '局势翻面',
    title: '看似闭合的证据',
    scene: '所有碎片短暂拼成了一个合理答案，主角终于有机会离开这场风暴。',
    question: '面对一份刚好足够的答案，他要停下，还是亲手撕开它？',
    pressure: 4,
    marker: '虚假胜利',
    choices: [
      {
        id: 'accept',
        strategy: '保守',
        title: '接受这份足以脱身的答案',
        action: '接受这份足以脱身的答案',
        gain: '暂时洗清了自己的嫌疑。',
        risk: '真正被牺牲的人将再也无法开口。',
        consequence: '他走到门口时，才发现这份答案替另一个人盖上了罪名。',
        clue: '一个与答案不相符的时间空白',
      },
      {
        id: 'break',
        strategy: '冒险',
        title: '当众指出证据里的裂缝',
        action: '当众指出证据里的裂缝',
        gain: '逼出了对手最想藏起的反应。',
        risk: '主角重新成为所有人目光的焦点。',
        consequence: '证据在众目睽睽下崩开，主角也被迫交出自己无法解释的过去。',
        clue: '一处被伪造的签名',
      },
      {
        id: 'protect',
        strategy: '承担',
        title: '先救下被答案牺牲的人',
        action: '先救下被答案牺牲的人',
        gain: '留住了唯一还能说出真相的人。',
        risk: '主角放弃了最容易自证的机会。',
        consequence: '他把人带离现场，也主动背下了本可以推开的嫌疑。',
        clue: '一段尚未说完的证词',
      },
    ],
  },
  {
    id: 'climax',
    act: '合',
    label: '主动完成',
    title: '没有人能替他决定',
    scene: '退路已经消失，所有未说出口的代价在这一刻同时到场。',
    question: '最后，他愿意为了什么主动承担后果？',
    pressure: 5,
    marker: '低点',
    choices: [
      {
        id: 'self',
        strategy: '保守',
        title: '保住自己，再等待下一次机会',
        action: '保住自己，再等待下一次机会',
        gain: '留下了继续追查的可能。',
        risk: '眼前的人和事可能无法被挽回。',
        consequence: '他选择活着带走证据，却必须承认有些失去已经无法倒转。',
        clue: '一份等待日后公开的完整档案',
      },
      {
        id: 'truth',
        strategy: '冒险',
        title: '用最重要的东西换回真相',
        action: '用最重要的东西换回真相',
        gain: '终于让真相被所有人看见。',
        risk: '他会永久失去自己最珍视的一部分。',
        consequence: '他把代价留给自己，让那句被掩埋的证词重新回到光里。',
        clue: '被完整保留下来的最后一句话',
      },
      {
        id: 'rescue',
        strategy: '承担',
        title: '先救人，再面对自己的嫌疑',
        action: '先救人，再面对自己的嫌疑',
        gain: '守住了比清白更重要的选择。',
        risk: '他会主动走进最难证明自己的处境。',
        consequence: '他没有等任何人替自己辩护，而是先把人从危险中带了出来。',
        clue: '被救下的人亲眼看见的真相',
      },
    ],
  },
]

function App() {
  const [idea, setIdea] = useState('')
  const [exampleIndex, setExampleIndex] = useState(0)
  const [selectedDirectionId, setSelectedDirectionId] = useState(directions[0].id)
  const [started, setStarted] = useState(false)
  const [directionPickerOpen, setDirectionPickerOpen] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [stageIndex, setStageIndex] = useState(0)
  const [nodes, setNodes] = useState<StoryNode[]>([])
  const [customChoiceOpen, setCustomChoiceOpen] = useState(false)
  const [customAction, setCustomAction] = useState('')
  const [mapOpen, setMapOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)

  const direction = useMemo(
    () => directions.find((item) => item.id === selectedDirectionId) ?? directions[0],
    [selectedDirectionId],
  )
  const activeStage = stages[stageIndex]
  const currentNode = nodes[nodes.length - 1]
  const completedChoices = Math.max(nodes.length - 1, 0)
  const progress = Math.round((completedChoices / stages.length) * 100)
  const canUndo = nodes.length > 1
  const cleanIdea = idea.trim()

  const validationItems = useMemo<ValidationItem[]>(() => {
    const pressure = currentNode?.pressure ?? 1
    return [
      {
        label: '五大要素',
        value: '已具备',
        detail: '主角、目标、阻碍、代价和时间压力已写入开端。',
        tone: 'pass',
      },
      {
        label: '因果链',
        value: completedChoices ? `${completedChoices} 次已写入` : '等待选择',
        detail: completedChoices ? '每次选择都已变成一个节点和新的风险。' : '第一次选择会决定故事如何离开开端。',
        tone: completedChoices ? 'pass' : 'pending',
      },
      {
        label: '冲突递进',
        value: `压力 ${pressure} / 5`,
        detail: pressure >= 3 ? '代价已经进入可见阶段。' : '下一步需要让失去的代价变得具体。',
        tone: pressure >= 3 ? 'pass' : 'pending',
      },
      {
        label: '高潮主动性',
        value: completed ? '主角已行动' : stageIndex === stages.length - 1 ? '等待最终决定' : '将在高潮验证',
        detail: completed ? '结局由主角的最后一个行动推动。' : '重要的事必须留给主角亲自完成。',
        tone: completed ? 'pass' : 'pending',
      },
      {
        label: '线索回收',
        value: completed ? '建议补强' : '1 条待回收',
        detail: completed ? '可在结局前补回最早出现的一条线索，让回响更有力量。' : '记录当前线索，结局时将检查它是否被回答。',
        tone: 'warn',
      },
    ]
  }, [completed, completedChoices, currentNode?.pressure, stageIndex])

  const beginStory = () => {
    if (!cleanIdea) return

    setNodes([
      {
        id: 'opening',
        act: '起',
        title: '激励事件',
        action: '被最初的念头推入困境',
        summary: `“${cleanIdea}”让${direction.protagonist}不得不在${direction.urgency}前${direction.goal}。`,
        risk: direction.stakes,
        clue: '最初出现、尚未被解释的异常',
        pressure: 1,
        marker: '开始',
      },
    ])
    setStageIndex(0)
    setCustomChoiceOpen(false)
    setCustomAction('')
    setCompleted(false)
    setDirectionPickerOpen(false)
    setStarted(true)
  }

  const openDirectionPicker = () => {
    if (cleanIdea) setDirectionPickerOpen(true)
  }

  const choose = (choice: Choice) => {
    const stage = stages[stageIndex]
    setNodes((current) => [
      ...current,
      {
        id: `${stage.id}-${current.length}-${choice.id}`,
        act: stage.act,
        title: choice.title,
        action: choice.action,
        summary: choice.consequence,
        risk: choice.risk,
        clue: choice.clue,
        pressure: stage.pressure,
        marker: stage.marker,
      },
    ])
    setCustomChoiceOpen(false)
    setCustomAction('')
    setMapOpen(false)
    setInspectorOpen(false)

    if (stageIndex === stages.length - 1) {
      setCompleted(true)
      return
    }

    setStageIndex((current) => current + 1)
  }

  const submitCustomChoice = () => {
    const action = customAction.trim()
    if (!action) return

    choose({
      id: `custom-${stageIndex}`,
      strategy: '自定义',
      title: action,
      action: `选择${action}`,
      gain: '把故事带向了你亲自定义的方向。',
      risk: '这个行动会暴露新的代价，等待下一幕回应。',
      consequence: `他没有沿着既定路线行动，而是决定${action}。局面因此发生偏移，也留下一个必须被回答的新问题。`,
      clue: '由这次行动留下的新线索',
    })
  }

  const undo = () => {
    if (!canUndo) return

    if (completed) {
      setCompleted(false)
      setStageIndex(stages.length - 1)
    } else {
      setStageIndex((current) => Math.max(0, current - 1))
    }

    setNodes((current) => current.slice(0, -1))
    setCustomChoiceOpen(false)
    setCustomAction('')
  }

  const restart = () => {
    setIdea('')
    setExampleIndex(0)
    setSelectedDirectionId(directions[0].id)
    setStarted(false)
    setDirectionPickerOpen(false)
    setCompleted(false)
    setStageIndex(0)
    setNodes([])
    setCustomChoiceOpen(false)
    setCustomAction('')
    setMapOpen(false)
    setInspectorOpen(false)
  }

  const useExample = () => {
    const next = (exampleIndex + 1) % examples.length
    setExampleIndex(next)
    setIdea(examples[next])
  }

  if (!started && !directionPickerOpen) {
    return (
      <main className="app-shell opening-shell">
        <div className="opening-image" aria-hidden="true" />
        <div className="opening-shade" aria-hidden="true" />
        <header className="opening-header">
          <Brand />
          <span className="prototype-label"><span className="status-dot" /> 可点击原型</span>
        </header>
        <section className="opening-content">
          <p className="opening-kicker"><Sparkles size={15} /> 从一个念头开始</p>
          <h1>时光川行<br />青柠创作平台</h1>
          <p>先写下一个画面、一句设定，或一个你总忘不掉的瞬间。</p>
          <label className="idea-field">
            <span>此刻浮现的想法</span>
            <textarea
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              placeholder="例如：一个失忆侦探收到三天后的自己寄来的信。"
              maxLength={240}
            />
            <span className="field-footer">
              <button className="text-action" type="button" onClick={useExample}><RefreshCcw size={15} /> 换个示例</button>
              <small>{idea.length} / 240</small>
            </span>
          </label>
          <button className="primary-action opening-action" type="button" onClick={openDirectionPicker} disabled={!cleanIdea}>
            开始展开 <ArrowRight size={18} />
          </button>
        </section>
        <footer className="opening-footer">
          <span>01 - 04</span>
          <span>困境 / 选择 / 后果 / 验证</span>
        </footer>
      </main>
    )
  }

  if (!started) {
    return (
      <main className="app-shell setup-shell direction-shell">
        <header className="setup-header">
          <Brand />
          <button className="opening-back" type="button" onClick={() => setDirectionPickerOpen(false)}><ArrowLeft size={16} /> 返回想法</button>
        </header>

        <section className="setup-layout direction-layout">
          <div className="setup-main">
            <p className="eyebrow"><Sparkles size={15} /> 故事取向</p>
            <h1>为这个念头，选一条会不断加压的路。</h1>
            <p className="setup-lead">“{cleanIdea}”会成为第一幕的激励事件，接下来由你决定故事如何向前。</p>

            <div className="direction-header">
              <div>
                <p>三个不同方向</p>
                <strong>选择一个最想继续追问的困境</strong>
              </div>
              <span>每个方向都包含主角、目标、阻碍、代价和时间压力</span>
            </div>

            <div className="direction-list" aria-label="故事方向">
              {directions.map((item, index) => {
                const Icon = item.icon
                const selected = item.id === selectedDirectionId
                return (
                  <button
                    key={item.id}
                    className={`direction-option ${selected ? 'is-selected' : ''}`}
                    type="button"
                    onClick={() => setSelectedDirectionId(item.id)}
                  >
                    <span className="direction-index">0{index + 1}</span>
                    <span className="direction-icon"><Icon size={18} /></span>
                    <span className="direction-copy">
                      <span className="direction-topline"><em>{item.genre}</em><strong>{item.title}</strong></span>
                      <span>从“{cleanIdea}”出发，{item.logline}</span>
                    </span>
                    <span className="choice-indicator" aria-hidden="true">{selected ? <Check size={15} /> : <CircleDot size={15} />}</span>
                  </button>
                )
              })}
            </div>

            <button className="primary-action setup-submit" type="button" onClick={beginStory}>
              进入共同创作 <ArrowRight size={18} />
            </button>
          </div>

          <aside className="setup-aside" aria-label="创作方式">
            <span className="aside-icon"><GitBranch size={19} /></span>
            <p className="eyebrow">共同创作</p>
            <h2>让结构跟着选择生长。</h2>
            <ol>
              <li><span>01</span><p>先让主角进入一个必须行动的困境。</p></li>
              <li><span>02</span><p>每次选择都会写入新的剧情、风险和线索。</p></li>
              <li><span>03</span><p>最后检查因果、代价与主角是否主动完成高潮。</p></li>
            </ol>
            <div className="aside-principle"><Lightbulb size={16} /><span>重要的事，留给主角亲自完成。</span></div>
          </aside>
        </section>
      </main>
    )
  }

  if (completed) {
    return (
      <CompletedStory
        direction={direction}
        idea={cleanIdea}
        nodes={nodes}
        validationItems={validationItems}
        onUndo={undo}
        onRestart={restart}
      />
    )
  }

  const lastActionCopy = completedChoices === 0
    ? `“${cleanIdea}”不再只是一个念头。${direction.protagonist}想要${direction.goal}，但${direction.obstacle}。`
    : `上一回合，${direction.protagonist}${currentNode.action}。${currentNode.summary}`

  return (
    <main className="app-shell workspace-shell">
      <header className="workspace-topbar">
        <Brand compact />
        <div className="draft-title">
          <small>本地草稿</small>
          <strong>{direction.title}</strong>
          <span>{progress}% 已成形</span>
        </div>
        <div className="topbar-actions">
          <button className="toolbar-action desktop-action" type="button" onClick={undo} disabled={!canUndo}><Undo2 size={16} /> 撤销</button>
          <button className="toolbar-icon mobile-only" type="button" onClick={() => setMapOpen(true)} aria-label="打开故事地图" title="打开故事地图"><Map size={18} /></button>
          <button className="toolbar-icon mobile-only" type="button" onClick={() => setInspectorOpen(true)} aria-label="打开故事检查" title="打开故事检查"><CircleAlert size={18} /></button>
          <button className="toolbar-action restart-action" type="button" onClick={restart} aria-label="新建故事" title="新建故事"><RefreshCcw size={15} /> 新建故事</button>
        </div>
      </header>

      <div className="workspace-grid">
        <StoryMapPanel
          activeStage={activeStage}
          nodes={nodes}
          open={mapOpen}
          progress={progress}
          onClose={() => setMapOpen(false)}
        />

        <section className="story-canvas" aria-labelledby="current-scene-title">
          <header className="canvas-header">
            <div className="canvas-path"><span>共同创作</span><ArrowRight size={13} /><strong>{activeStage.label}</strong></div>
            <span className="canvas-counter">第 {stageIndex + 1} 次选择 / {stages.length}</span>
          </header>

          <div className="scene-copy" key={activeStage.id}>
            <div className="scene-meta"><span>{activeStage.act}</span>{activeStage.marker && <em>{activeStage.marker}</em>}</div>
            <p className="eyebrow">当前局面</p>
            <h1 id="current-scene-title">{activeStage.title}</h1>
            <p>{lastActionCopy}</p>
            <p>{activeStage.scene} {direction.urgency}。</p>
          </div>

          <section className="decision-section" aria-labelledby="decision-title">
            <div className="decision-heading">
              <div>
                <p className="eyebrow">由这段剧情自然产生的问题</p>
                <h2 id="decision-title">{activeStage.question}</h2>
              </div>
              <span className="pressure-badge"><Flame size={14} /> 压力 {activeStage.pressure} / 5</span>
            </div>

            <div className="choice-list">
              {activeStage.choices.map((choice, index) => (
                <button className="story-choice" type="button" key={choice.id} onClick={() => choose(choice)}>
                  <span className="choice-number">0{index + 1}</span>
                  <span className="choice-copy">
                    <span className="choice-topline"><em>{choice.strategy}</em><strong>{choice.title}</strong></span>
                    <span className="choice-impact"><b>得到</b>{choice.gain}</span>
                    <span className="choice-impact is-risk"><b>风险</b>{choice.risk}</span>
                  </span>
                  <ArrowRight className="choice-arrow" size={18} />
                </button>
              ))}
            </div>

            <div className={`custom-choice ${customChoiceOpen ? 'is-open' : ''}`}>
              {!customChoiceOpen ? (
                <button className="text-action" type="button" onClick={() => setCustomChoiceOpen(true)}><PenLine size={15} /> 写下另一个行动</button>
              ) : (
                <div className="custom-choice-form">
                  <label htmlFor="custom-action">主角要怎么做？</label>
                  <div>
                    <input
                      id="custom-action"
                      autoFocus
                      value={customAction}
                      onChange={(event) => setCustomAction(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') submitCustomChoice()
                      }}
                      placeholder="写下一个具体行动"
                      maxLength={120}
                    />
                    <button className="submit-icon" type="button" onClick={submitCustomChoice} disabled={!customAction.trim()} aria-label="写入自定义行动" title="写入自定义行动"><ArrowRight size={17} /></button>
                    <button className="cancel-icon" type="button" onClick={() => { setCustomChoiceOpen(false); setCustomAction('') }} aria-label="取消自定义行动" title="取消"><X size={16} /></button>
                  </div>
                  <small>这句话会成为新节点，并带来下一次需要回答的问题。</small>
                </div>
              )}
            </div>
          </section>

          <footer className="canvas-footer">
            <button className="text-action" type="button" onClick={undo} disabled={!canUndo}><ArrowLeft size={16} /> 撤销上一次选择</button>
            <span>选择后会立即生成新的局面</span>
          </footer>
        </section>

        <InspectorPanel
          direction={direction}
          items={validationItems}
          latestNode={currentNode!}
          open={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
        />
      </div>
    </main>
  )
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'brand-compact' : ''}`}>
      <span className="brand-mark"><BookOpen size={compact ? 17 : 20} /></span>
      <span><strong>时光川行</strong><small>青柠创作平台</small></span>
    </div>
  )
}

function StoryMapPanel({
  activeStage,
  nodes,
  open,
  progress,
  onClose,
}: {
  activeStage: StoryStage
  nodes: StoryNode[]
  open: boolean
  progress: number
  onClose: () => void
}) {
  return (
    <aside className={`story-map-panel ${open ? 'is-open' : ''}`} aria-label="故事地图">
      <header className="panel-heading">
        <div><span className="panel-icon"><Map size={17} /></span><div><p>故事地图</p><strong>选择正在留下轨迹</strong></div></div>
        <button className="panel-close mobile-only" type="button" onClick={onClose} aria-label="关闭故事地图" title="关闭"><X size={18} /></button>
      </header>

      <div className="map-progress" aria-label={`故事完成度 ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
      <p className="map-progress-copy">{nodes.length} 个节点 · {progress}% 骨架已形成</p>

      <ol className="node-timeline">
        {nodes.map((node, index) => (
          <li className="map-node" key={node.id}>
            <span className="map-node-point">{String(index + 1).padStart(2, '0')}</span>
            <div>
              <div className="node-tags"><em>{node.act}</em>{node.marker && <span>{node.marker}</span>}</div>
              <strong>{node.title}</strong>
              <p>{node.summary}</p>
              <small><Flame size={12} /> 风险 {node.pressure} / 5</small>
            </div>
          </li>
        ))}
        <li className="map-node is-pending">
          <span className="map-node-point"><Plus size={13} /></span>
          <div>
            <div className="node-tags"><em>{activeStage.act}</em></div>
            <strong>下一次选择</strong>
            <p>{activeStage.question}</p>
          </div>
        </li>
      </ol>

      <div className="map-note"><GitBranch size={16} /><span>每个节点都由一次具体行动和它带来的后果组成。</span></div>
    </aside>
  )
}

function InspectorPanel({
  direction,
  items,
  latestNode,
  open,
  onClose,
}: {
  direction: StoryDirection
  items: ValidationItem[]
  latestNode: StoryNode
  open: boolean
  onClose: () => void
}) {
  return (
    <aside className={`inspector-panel ${open ? 'is-open' : ''}`} aria-label="故事检查">
      <header className="panel-heading">
        <div><span className="panel-icon"><CircleAlert size={17} /></span><div><p>故事检查</p><strong>可验证，而不是只给分数</strong></div></div>
        <button className="panel-close mobile-only" type="button" onClick={onClose} aria-label="关闭故事检查" title="关闭"><X size={18} /></button>
      </header>

      <section className="element-section">
        <p className="section-label">五大要素</p>
        <dl className="element-list">
          <div><dt>主角</dt><dd>{direction.protagonist}</dd></div>
          <div><dt>目标</dt><dd>{direction.goal}</dd></div>
          <div><dt>阻碍</dt><dd>{direction.obstacle}</dd></div>
          <div><dt>代价</dt><dd>{direction.stakes}</dd></div>
          <div><dt>现在</dt><dd>{direction.urgency}</dd></div>
        </dl>
      </section>

      <section className="latest-state">
        <p className="section-label">最新变化</p>
        <strong>{latestNode.title}</strong>
        <p>{latestNode.summary}</p>
        <div><span>留下线索</span><b>{latestNode.clue}</b></div>
      </section>

      <section className="validation-section">
        <p className="section-label">结构验证</p>
        <div className="validation-list">
          {items.map((item) => <ValidationRow item={item} key={item.label} />)}
        </div>
      </section>
    </aside>
  )
}

function ValidationRow({ item }: { item: ValidationItem }) {
  const Icon = item.tone === 'pass' ? Check : item.tone === 'warn' ? CircleAlert : CircleDot
  return (
    <div className={`validation-row is-${item.tone}`}>
      <div><span>{item.label}</span><small>{item.detail}</small></div>
      <strong><Icon size={14} /> {item.value}</strong>
    </div>
  )
}

function CompletedStory({
  direction,
  idea,
  nodes,
  validationItems,
  onUndo,
  onRestart,
}: {
  direction: StoryDirection
  idea: string
  nodes: StoryNode[]
  validationItems: ValidationItem[]
  onUndo: () => void
  onRestart: () => void
}) {
  const finalNode = nodes[nodes.length - 1]
  return (
    <main className="app-shell complete-shell">
      <header className="workspace-topbar">
        <Brand compact />
        <div className="draft-title"><small>故事骨架</small><strong>{direction.title}</strong><span>已完成一条可追溯路径</span></div>
        <div className="topbar-actions">
          <button className="toolbar-action desktop-action" type="button" onClick={onUndo}><Undo2 size={16} /> 修改高潮</button>
          <button className="toolbar-action restart-action" type="button" onClick={onRestart} aria-label="新建故事" title="新建故事"><RefreshCcw size={15} /> 新建故事</button>
        </div>
      </header>

      <section className="completed-content">
        <header className="completed-heading">
          <span className="complete-mark"><Check size={20} /></span>
          <div><p className="eyebrow">选定路径已生成</p><h1>{direction.title}</h1></div>
          <button className="text-action mobile-complete-edit" type="button" onClick={onUndo}><Undo2 size={15} /> 修改高潮</button>
        </header>

        <div className="completed-grid">
          <article className="manuscript">
            <p className="manuscript-label">故事梗概 · 当前路径</p>
            <h2>最初的念头，终于抵达了一个由主角自己做出的结局。</h2>
            <p>故事从“{idea}”开始。{direction.protagonist}必须在{direction.urgency}前{direction.goal}，而{direction.obstacle}让每条路都带着新的代价。</p>
            {nodes.map((node, index) => (
              <section className="manuscript-node" key={node.id}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div><em>{node.act}{node.marker ? ` · ${node.marker}` : ''}</em><strong>{node.title}</strong><p>{node.summary}</p></div>
              </section>
            ))}
            <p>最后，{direction.protagonist}{finalNode.action}。{finalNode.summary} 这个结局没有把决定交给别人，也让最初出现的问题获得了回应。</p>
          </article>

          <aside className="completion-checks">
            <div className="completion-check-heading"><Target size={18} /><div><p>结构验证</p><strong>看见证据，再决定修改哪里</strong></div></div>
            <div className="validation-list">
              {validationItems.map((item) => <ValidationRow item={item} key={item.label} />)}
            </div>
            <div className="completion-note"><Lightbulb size={16} /><p>建议回到高潮前，将“{nodes[1]?.clue ?? '最早出现的线索'}”再出现一次，让开头和结局形成更强的回响。</p></div>
            <button className="secondary-action" type="button" onClick={onUndo}><Undo2 size={16} /> 回到最后一次选择</button>
          </aside>
        </div>
      </section>
    </main>
  )
}

export default App
