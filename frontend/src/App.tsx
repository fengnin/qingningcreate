import { useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleDot,
  GitBranch,
  Lightbulb,
  PenLine,
  Plus,
  RefreshCcw,
  Sparkles,
  Target,
  Undo2,
  WandSparkles,
} from 'lucide-react'

type StepId = 'foundation' | 'anchors' | 'spine' | 'pressure' | 'structure' | 'branches'
type Act = '起' | '承' | '转' | '合'

interface Concept {
  id: string
  title: string
  label: string
  logline: string
  protagonist: string
  goal: string
  obstacle: string
  stakes: string
  urgency: string
}

interface StoryNode {
  id: string
  title: string
  summary: string
  act: Act
  pressure: number
  marker?: '意外' | '虚假胜利' | '低点'
}

const steps: Array<{ id: StepId; number: string; title: string; subtitle: string }> = [
  { id: 'foundation', number: '01', title: '故事内核', subtitle: '五大要素' },
  { id: 'anchors', number: '02', title: '先定头尾', subtitle: '激励与高潮' },
  { id: 'spine', number: '03', title: '情境发散', subtitle: '故事脊椎' },
  { id: 'pressure', number: '04', title: '冲突升级', subtitle: '压力曲线' },
  { id: 'structure', number: '05', title: '起承转合', subtitle: '四幕结构' },
  { id: 'branches', number: '06', title: '分支细化', subtitle: '选择与后果' },
]

const examples = [
  '一个失忆侦探收到三天后的自己寄来的信。',
  '一个总是迟到的人，发现时间开始替他倒流。',
  '毕业前夜，三位朋友收到一张十年前写给未来的地图。',
]

const conceptSets: Concept[][] = [
  [
    {
      id: 'letter',
      title: '雨夜来信',
      label: '悬疑 / 选择相信未来',
      logline: '失忆侦探必须在一封未来来信与眼前证据之间，决定该相信哪个版本的自己。',
      protagonist: '陆沉，失忆的私家侦探',
      goal: '找回丢失的三天记忆',
      obstacle: '信件指向他可能犯下的罪',
      stakes: '若信是真的，他会亲手害死委托人',
      urgency: '午夜前，信中预告的命案将发生',
    },
    {
      id: 'witness',
      title: '第七位目击者',
      label: '悬疑 / 追寻真相',
      logline: '唯一能证明侦探清白的目击者，只存在于他正在消失的记忆里。',
      protagonist: '陆沉，失忆的私家侦探',
      goal: '找到不存在档案中的第七位目击者',
      obstacle: '每靠近真相，记忆就被人为篡改',
      stakes: '他会成为谋杀案的唯一嫌疑人',
      urgency: '警方将在天亮时正式逮捕他',
    },
    {
      id: 'loop',
      title: '倒计时的证词',
      label: '科幻悬疑 / 逆转命运',
      logline: '侦探每读完一封未来来信，就会失去一段更重要的过去。',
      protagonist: '陆沉，能看见未来片段的侦探',
      goal: '阻止信中描述的死亡',
      obstacle: '未来信息以牺牲记忆为代价',
      stakes: '救下别人，或彻底遗忘所爱之人',
      urgency: '下一封信将在死亡发生前十分钟送达',
    },
  ],
  [
    {
      id: 'station',
      title: '末班车座位',
      label: '都市奇幻 / 守住承诺',
      logline: '末班车上空着的一张座位，只会为一位不该出现的乘客保留。',
      protagonist: '周予，夜班公交调度员',
      goal: '送迷路女孩回家',
      obstacle: '女孩的住址十年前已被拆除',
      stakes: '错过终点站，女孩将永远留在车上',
      urgency: '车辆将在零点被强制回库',
    },
    {
      id: 'contract',
      title: '借来的明天',
      label: '情感奇幻 / 重新选择',
      logline: '一个普通人用明天换来一次改写今天的机会，却发现代价正落在家人身上。',
      protagonist: '林晓，濒临离职的插画师',
      goal: '挽回一场已经失去的关系',
      obstacle: '每次改写都会抹去身边人的共同记忆',
      stakes: '她会成为最爱的人眼中的陌生人',
      urgency: '交易只剩最后一次使用机会',
    },
    {
      id: 'room',
      title: '凌晨四点的门',
      label: '温情悬疑 / 直面告别',
      logline: '一扇只在凌晨四点打开的门，让失去母亲的女孩得到七次告别机会。',
      protagonist: '许葵，拒绝告别的录音师',
      goal: '录下母亲最后想说的话',
      obstacle: '每次进门，现实中的一件东西会消失',
      stakes: '她可能失去与母亲有关的一切',
      urgency: '门只剩七次开启机会',
    },
  ],
]

const incitingOptions = [
  {
    id: 'missing-file',
    title: '一封没有寄件人的信',
    description: '雨夜，陆沉在办公室门缝里发现一封写着“别相信今晚的你”的信。',
  },
  {
    id: 'client-call',
    title: '来自委托人的求救电话',
    description: '失联的委托人只说出一句“你已经来过一次了”，电话随即中断。',
  },
  {
    id: 'evidence',
    title: '案发现场的旧照片',
    description: '警察在命案现场找到一张三天前拍下的照片，画面中的陆沉正站在死者身后。',
  },
]

const climaxOptions = [
  {
    id: 'burn-letter',
    title: '烧掉最后一封信',
    description: '陆沉拒绝再被未来操控，带着残缺记忆亲自走进凶手布下的终局。',
  },
  {
    id: 'choose-memory',
    title: '用记忆换回真相',
    description: '他选择读完最后一封信，代价是永远忘记自己为何开始调查这起案件。',
  },
  {
    id: 'be-witness',
    title: '成为自己的目击者',
    description: '他重返三天前的现场，证明未来的自己曾为救人而主动背下嫌疑。',
  },
]

const storyNodes: StoryNode[] = [
  { id: 'n1', title: '雨夜来信', summary: '信中预告了一桩尚未发生的命案。', act: '起', pressure: 1 },
  { id: 'n2', title: '照片里的自己', summary: '现场照片将他推向第一嫌疑人的位置。', act: '起', pressure: 1 },
  { id: 'n3', title: '失效的地址', summary: '信件指向的地址早已废弃，却留下新的血迹。', act: '承', pressure: 2 },
  { id: 'n4', title: '看似闭合的证据', summary: '他找到凶器并暂时洗清嫌疑。', act: '承', pressure: 2, marker: '虚假胜利' },
  { id: 'n5', title: '另一份笔迹', summary: '凶器上的指纹证明，三天前的他曾来过这里。', act: '转', pressure: 3, marker: '意外' },
  { id: 'n6', title: '被抹去的约定', summary: '委托人原来是他遗忘的旧友，警方封锁所有出口。', act: '转', pressure: 4 },
  { id: 'n7', title: '最后一封信', summary: '他必须在救人和保住记忆之间作出选择。', act: '转', pressure: 5, marker: '低点' },
  { id: 'n8', title: '成为目击者', summary: '陆沉主动重返现场，把真相从自己的过去里带回来。', act: '合', pressure: 5 },
]

const branchGroups = [
  {
    id: 'trust',
    title: '岔路一 · 信件可信吗？',
    node: '看似闭合的证据之后',
    choices: [
      { id: 'trust-letter', title: '相信信件', effect: '提前转移委托人，但触发更早的追捕。' },
      { id: 'trust-evidence', title: '相信证据', effect: '留在现场查验凶器，却错过关键人物。' },
      { id: 'trust-custom', title: '写下自己的选择', effect: '为这一刻定义新的行动。' },
    ],
  },
  {
    id: 'cost',
    title: '岔路二 · 最后要失去什么？',
    node: '最后一封信之前',
    choices: [
      { id: 'cost-memory', title: '交出记忆', effect: '得知真相，却忘记旧友的名字。' },
      { id: 'cost-risk', title: '冒险不读', effect: '保住自我，却只能用现在的判断救人。' },
      { id: 'cost-custom', title: '写下自己的代价', effect: '选择一种新的结局代价。' },
    ],
  },
]

const stepTitles: Record<StepId, { eyebrow: string; title: string; description: string }> = {
  foundation: {
    eyebrow: '第 1 层 · 先让故事有一颗心',
    title: '从三个方向里，挑一个最想追下去的困境。',
    description: '每个方向都已把主角、目标、阻碍、代价和时间压力放进同一条线里。',
  },
  anchors: {
    eyebrow: '第 2 层 · 给故事两端钉住坐标',
    title: '先确定为什么现在开始，以及最后要抵达哪里。',
    description: '头尾一旦选定，中间的每一个情境都会有可追溯的方向。',
  },
  spine: {
    eyebrow: '第 3 层 · 铺开中间发生的事',
    title: '这条路径从谜面出发，逐步把人推向终局。',
    description: '你可以保留、替换或加入自己的情境。每一格都应把故事向前推进。',
  },
  pressure: {
    eyebrow: '第 4 层 · 让困难变得更难',
    title: '冲突不是重复出现，而是不断提高失去的代价。',
    description: '系统标出了意外、虚假胜利与低点，方便判断故事的压力是否持续上升。',
  },
  structure: {
    eyebrow: '第 5 层 · 看见故事的骨架',
    title: '同一串事件，被放进起、承、转、合之后才有了节奏。',
    description: '关键问题留给主角亲自解决，转折要改变局势，结局要回应开头。',
  },
  branches: {
    eyebrow: '第 6 层 · 把选择变成后果',
    title: '在真正改变故事的地方，留下你的判断。',
    description: '每个选择都会改变下一段的风险、线索或结局代价。',
  },
}

function App() {
  const [idea, setIdea] = useState('')
  const [exampleIndex, setExampleIndex] = useState(0)
  const [started, setStarted] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [variationIndex, setVariationIndex] = useState(0)
  const [selectedConceptId, setSelectedConceptId] = useState<string | null>(null)
  const [customConcept, setCustomConcept] = useState('')
  const [showCustomConcept, setShowCustomConcept] = useState(false)
  const [selectedInciting, setSelectedInciting] = useState<string | null>(null)
  const [selectedClimax, setSelectedClimax] = useState<string | null>(null)
  const [showCustomAnchors, setShowCustomAnchors] = useState(false)
  const [customInciting, setCustomInciting] = useState('')
  const [customClimax, setCustomClimax] = useState('')
  const [addedNode, setAddedNode] = useState('')
  const [selectedBranches, setSelectedBranches] = useState<Record<string, string>>({})
  const [customBranches, setCustomBranches] = useState<Record<string, string>>({})
  const [showCustomBranch, setShowCustomBranch] = useState<Record<string, boolean>>({})
  const [completed, setCompleted] = useState(false)

  const activeStep = steps[activeIndex]
  const concepts = conceptSets[variationIndex]
  const selectedConcept = useMemo(
    () => concepts.find((concept) => concept.id === selectedConceptId) ?? conceptSets[0][0],
    [concepts, selectedConceptId],
  )

  const resolvedInciting = useMemo(() => {
    if (showCustomAnchors && customInciting.trim()) return customInciting.trim()
    return incitingOptions.find((item) => item.id === selectedInciting)?.title ?? '尚未确定'
  }, [customInciting, selectedInciting, showCustomAnchors])

  const resolvedClimax = useMemo(() => {
    if (showCustomAnchors && customClimax.trim()) return customClimax.trim()
    return climaxOptions.find((item) => item.id === selectedClimax)?.title ?? '尚未确定'
  }, [customClimax, selectedClimax, showCustomAnchors])

  const selectedConceptTitle = selectedConceptId === 'custom' ? customConcept || '你的故事方向' : selectedConcept.title
  const isCustomConceptValid = selectedConceptId === 'custom' && customConcept.trim().length > 0
  const hasFoundation = Boolean(selectedConceptId && (selectedConceptId !== 'custom' || isCustomConceptValid))
  const hasAnchors = showCustomAnchors
    ? Boolean(customInciting.trim() && customClimax.trim())
    : Boolean(selectedInciting && selectedClimax)
  const hasBranches = branchGroups.every((group) => {
    const choice = selectedBranches[group.id]
    return Boolean(choice && (choice !== `${group.id}-custom` || customBranches[group.id]?.trim()))
  })

  const canAdvance = [hasFoundation, hasAnchors, true, true, true, hasBranches][activeIndex]

  const handleBegin = () => {
    if (idea.trim()) {
      setStarted(true)
    }
  }

  const handleExample = () => {
    const next = (exampleIndex + 1) % examples.length
    setExampleIndex(next)
    setIdea(examples[next])
  }

  const moveNext = () => {
    if (!canAdvance) return
    if (activeIndex === steps.length - 1) {
      setCompleted(true)
      return
    }
    setActiveIndex((index) => index + 1)
  }

  const reset = () => {
    setIdea('')
    setStarted(false)
    setActiveIndex(0)
    setVariationIndex(0)
    setSelectedConceptId(null)
    setCustomConcept('')
    setShowCustomConcept(false)
    setSelectedInciting(null)
    setSelectedClimax(null)
    setShowCustomAnchors(false)
    setCustomInciting('')
    setCustomClimax('')
    setAddedNode('')
    setSelectedBranches({})
    setCustomBranches({})
    setShowCustomBranch({})
    setCompleted(false)
  }

  if (!started) {
    return (
      <main className="app-shell opening-shell">
        <div className="opening-image" aria-hidden="true" />
        <div className="opening-shade" aria-hidden="true" />
        <header className="opening-header">
          <Brand />
          <div className="prototype-status"><span className="status-dot" /> 可点击原型</div>
        </header>
        <section className="opening-content">
          <div className="opening-kicker"><Sparkles size={15} /> 从一个念头开始</div>
          <h1>把还说不清的想法，<br />一步步写成故事。</h1>
          <p>先写下一个画面、一句设定，或一个你总忘不掉的瞬间。</p>
          <label className="idea-field">
            <span>此刻浮现的想法</span>
            <textarea
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              placeholder="例如：一个失忆侦探收到三天后的自己寄来的信。"
              maxLength={240}
            />
            <div className="field-footer">
              <button className="quiet-action" type="button" onClick={handleExample}><RefreshCcw size={15} /> 换个示例</button>
              <span>{idea.length}/240</span>
            </div>
          </label>
          <button className="primary-action opening-action" type="button" onClick={handleBegin} disabled={!idea.trim()}>
            开始展开 <ArrowRight size={18} />
          </button>
        </section>
        <footer className="opening-footer">
          <span>01 - 06</span>
          <span>故事内核 / 头尾 / 脊椎 / 冲突 / 结构 / 分支</span>
        </footer>
      </main>
    )
  }

  if (completed) {
    return (
      <main className="app-shell complete-shell">
        <header className="topbar">
          <Brand />
          <button className="quiet-action" type="button" onClick={reset}><RefreshCcw size={15} /> 新建故事</button>
        </header>
        <section className="story-output">
          <div className="story-output-heading">
            <div className="completion-mark"><Check size={18} /></div>
            <div>
              <p className="eyebrow">剧情已生成 · 原型版本</p>
              <h1>{selectedConceptTitle}</h1>
            </div>
            <button className="secondary-action" type="button" onClick={() => setCompleted(false)}><Undo2 size={16} /> 返回分支</button>
          </div>
          <div className="output-grid">
            <article className="story-manuscript">
              <p className="manuscript-label">完整剧情 · 选定路径</p>
              <h2>最初的念头，终于有了可以抵达的结局。</h2>
              <p>故事从“{idea}”开始。{selectedConceptTitle}让{selectedConcept.protagonist}不得不追赶一个越来越难以辨认的真相。</p>
              <p>为了{selectedConcept.goal}，主角不断面对{selectedConcept.obstacle}。每一次看似接近答案，都会让{selectedConcept.stakes}变得更真实。</p>
              <p>当{resolvedClimax}成为唯一出口时，主角没有再把决定交给别人，而是带着不完整的线索，主动走回最初的现场。</p>
              <p>故事在那一刻完成了回响：{resolvedInciting}留下的问题，终于被主角用自己的选择回答。</p>
            </article>
            <aside className="verification-panel">
              <p className="manuscript-label">结构验证</p>
              <div className="verification-score"><strong>86</strong><span>/ 100</span></div>
              <p className="score-caption">故事骨架可继续细化</p>
              <VerificationRow label="人物目标一致" state="通过" />
              <VerificationRow label="冲突递进" state="通过" />
              <VerificationRow label="分支产生后果" state="通过" />
              <VerificationRow label="线索闭合" state="提示" warning />
              <div className="verification-note">建议在“最后一封信”之前补一处旧友与陆沉的共同记忆，使结局回收更有力量。</div>
            </aside>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell workspace-shell">
      <aside className="left-rail">
        <div className="rail-top">
          <Brand compact />
        </div>
        <div className="draft-meta">
          <p>本地草稿</p>
          <strong>{idea.length > 18 ? `${idea.slice(0, 18)}...` : idea}</strong>
        </div>
        <nav className="step-nav" aria-label="创作步骤">
          {steps.map((step, index) => {
            const isActive = index === activeIndex
            const isDone = index < activeIndex
            const isAvailable = index <= activeIndex
            return (
              <button
                key={step.id}
                className={`step-link ${isActive ? 'is-active' : ''} ${isDone ? 'is-done' : ''}`}
                type="button"
                disabled={!isAvailable}
                onClick={() => setActiveIndex(index)}
              >
                <span className="step-index">{isDone ? <Check size={13} /> : step.number}</span>
                <span className="step-label"><strong>{step.title}</strong><small>{step.subtitle}</small></span>
              </button>
            )
          })}
        </nav>
        <div className="rail-bottom">
          <button className="quiet-action" type="button" onClick={reset}><RefreshCcw size={15} /> 重新开始</button>
          <span>原型 · 本地运行</span>
        </div>
      </aside>

      <section className="workspace-main">
        <header className="workspace-header">
          <div className="path-label"><span>故事创作</span><ChevronRight size={14} /><strong>{activeStep.title}</strong></div>
          <div className="step-counter">第 {activeIndex + 1} / {steps.length} 步</div>
        </header>

        <section className="workspace-content" key={activeStep.id}>
          <div className="section-heading">
            <p className="eyebrow">{stepTitles[activeStep.id].eyebrow}</p>
            <h1>{stepTitles[activeStep.id].title}</h1>
            <p>{stepTitles[activeStep.id].description}</p>
          </div>

          {activeStep.id === 'foundation' && (
            <FoundationStep
              concepts={concepts}
              selectedConceptId={selectedConceptId}
              showCustomConcept={showCustomConcept}
              customConcept={customConcept}
              onSelect={setSelectedConceptId}
              onChangeSet={() => {
                setVariationIndex((index) => (index + 1) % conceptSets.length)
                setSelectedConceptId(null)
                setShowCustomConcept(false)
              }}
              onShowCustom={() => {
                setShowCustomConcept(true)
                setSelectedConceptId('custom')
              }}
              onCustomChange={setCustomConcept}
            />
          )}
          {activeStep.id === 'anchors' && (
            <AnchorsStep
              selectedInciting={selectedInciting}
              selectedClimax={selectedClimax}
              showCustom={showCustomAnchors}
              customInciting={customInciting}
              customClimax={customClimax}
              onSelectInciting={setSelectedInciting}
              onSelectClimax={setSelectedClimax}
              onShowCustom={() => {
                setShowCustomAnchors(true)
                setSelectedInciting(null)
                setSelectedClimax(null)
              }}
              onCustomIncitingChange={setCustomInciting}
              onCustomClimaxChange={setCustomClimax}
            />
          )}
          {activeStep.id === 'spine' && <SpineStep addedNode={addedNode} onAddedNodeChange={setAddedNode} />}
          {activeStep.id === 'pressure' && <PressureStep />}
          {activeStep.id === 'structure' && <StructureStep />}
          {activeStep.id === 'branches' && (
            <BranchesStep
              selectedBranches={selectedBranches}
              customBranches={customBranches}
              showCustomBranch={showCustomBranch}
              onSelect={(groupId, optionId) => setSelectedBranches((current) => ({ ...current, [groupId]: optionId }))}
              onShowCustom={(groupId) => {
                setShowCustomBranch((current) => ({ ...current, [groupId]: true }))
                setSelectedBranches((current) => ({ ...current, [groupId]: `${groupId}-custom` }))
              }}
              onCustomChange={(groupId, value) => setCustomBranches((current) => ({ ...current, [groupId]: value }))}
            />
          )}
        </section>

        <footer className="workspace-footer">
          <button className="back-action" type="button" onClick={() => setActiveIndex((index) => Math.max(index - 1, 0))} disabled={activeIndex === 0}>
            <ArrowLeft size={17} /> 上一步
          </button>
          <div className="footer-progress"><span style={{ width: `${((activeIndex + 1) / steps.length) * 100}%` }} /></div>
          <button className="primary-action" type="button" disabled={!canAdvance} onClick={moveNext}>
            {activeIndex === steps.length - 1 ? '生成完整剧情' : '进入下一层'} <ArrowRight size={17} />
          </button>
        </footer>
      </section>

      <aside className="inspector">
        <div className="inspector-heading">
          <span className="inspector-icon"><GitBranch size={17} /></span>
          <div><p>故事脊椎</p><strong>正在成形</strong></div>
        </div>
        <div className="idea-reference">
          <span>最初想法</span>
          <p>{idea}</p>
        </div>
        <div className="spine-list">
          <SpineItem index="01" label="故事内核" value={hasFoundation ? selectedConceptTitle : '等待选择'} active={activeIndex === 0} complete={hasFoundation} />
          <SpineItem index="02" label="激励事件" value={hasAnchors ? resolvedInciting : '等待确定'} active={activeIndex === 1} complete={hasAnchors} />
          <SpineItem index="03" label="高潮结局" value={hasAnchors ? resolvedClimax : '等待确定'} active={activeIndex === 1} complete={hasAnchors} />
          <SpineItem index="04" label="情境节点" value={`${storyNodes.length + (addedNode.trim() ? 1 : 0)} 个节点，向终局推进`} active={activeIndex === 2} complete={activeIndex > 2} />
          <SpineItem index="05" label="关键分支" value={hasBranches ? '2 处选择已写入后果' : '等待你的判断'} active={activeIndex === 5} complete={hasBranches} />
        </div>
        <div className="principle-note"><Lightbulb size={16} /><p>重要的事，留给主角主动完成。</p></div>
      </aside>
    </main>
  )
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'brand-compact' : ''}`}>
      <span className="brand-mark"><BookOpen size={compact ? 18 : 20} /></span>
      <span><strong>Story Lens</strong><small>故事折光</small></span>
    </div>
  )
}

function FoundationStep({
  concepts,
  selectedConceptId,
  showCustomConcept,
  customConcept,
  onSelect,
  onChangeSet,
  onShowCustom,
  onCustomChange,
}: {
  concepts: Concept[]
  selectedConceptId: string | null
  showCustomConcept: boolean
  customConcept: string
  onSelect: (id: string) => void
  onChangeSet: () => void
  onShowCustom: () => void
  onCustomChange: (value: string) => void
}) {
  return (
    <div className="foundation-step stage-enter">
      <div className="choice-toolbar"><span>从 AI 提案里选，或从你的方向继续写。</span><button className="quiet-action" type="button" onClick={onChangeSet}><RefreshCcw size={15} /> 换一组方向</button></div>
      <div className="concept-list">
        {concepts.map((concept, index) => {
          const selected = selectedConceptId === concept.id
          return (
            <button key={concept.id} type="button" className={`concept-option ${selected ? 'is-selected' : ''}`} onClick={() => onSelect(concept.id)}>
              <span className="concept-number">0{index + 1}</span>
              <span className="concept-content">
                <span className="concept-topline"><em>{concept.label}</em><strong>{concept.title}</strong></span>
                <span className="concept-logline">{concept.logline}</span>
                <span className="element-line"><b>主角</b>{concept.protagonist}<b>目标</b>{concept.goal}<b>代价</b>{concept.stakes}</span>
              </span>
              <span className="choice-indicator">{selected ? <Check size={16} /> : <CircleDot size={16} />}</span>
            </button>
          )
        })}
      </div>
      <div className={`custom-composer ${showCustomConcept ? 'is-open' : ''}`}>
        <button type="button" className="custom-trigger" onClick={onShowCustom}><Plus size={18} /> 我有另一个方向</button>
        {showCustomConcept && (
          <textarea autoFocus value={customConcept} onChange={(event) => onCustomChange(event.target.value)} placeholder="写下你想继续追下去的故事困境..." maxLength={300} />
        )}
      </div>
    </div>
  )
}

function AnchorsStep({
  selectedInciting,
  selectedClimax,
  showCustom,
  customInciting,
  customClimax,
  onSelectInciting,
  onSelectClimax,
  onShowCustom,
  onCustomIncitingChange,
  onCustomClimaxChange,
}: {
  selectedInciting: string | null
  selectedClimax: string | null
  showCustom: boolean
  customInciting: string
  customClimax: string
  onSelectInciting: (id: string) => void
  onSelectClimax: (id: string) => void
  onShowCustom: () => void
  onCustomIncitingChange: (value: string) => void
  onCustomClimaxChange: (value: string) => void
}) {
  return (
    <div className="anchors-step stage-enter">
      <AnchorColumn label="故事从这里被迫开始" title="激励事件" icon={<WandSparkles size={18} />} options={incitingOptions} selected={selectedInciting} onSelect={onSelectInciting} />
      <div className="anchor-connector" aria-hidden="true"><span /><ArrowRight size={17} /><span /></div>
      <AnchorColumn label="故事最终必须抵达这里" title="高潮结局" icon={<Target size={18} />} options={climaxOptions} selected={selectedClimax} onSelect={onSelectClimax} />
      <div className="anchor-custom-area">
        {!showCustom ? <button type="button" className="quiet-action" onClick={onShowCustom}><PenLine size={15} /> 自己填写头尾</button> : (
          <div className="anchor-custom-fields">
            <label><span>我的激励事件</span><input value={customInciting} onChange={(event) => onCustomIncitingChange(event.target.value)} placeholder="什么事迫使故事从此刻开始？" /></label>
            <label><span>我的高潮结局</span><input value={customClimax} onChange={(event) => onCustomClimaxChange(event.target.value)} placeholder="主角最终必须完成什么？" /></label>
          </div>
        )}
      </div>
    </div>
  )
}

function AnchorColumn({ label, title, icon, options, selected, onSelect }: { label: string; title: string; icon: ReactNode; options: Array<{ id: string; title: string; description: string }>; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <section className="anchor-column">
      <div className="anchor-heading"><span>{icon}</span><div><p>{label}</p><h2>{title}</h2></div></div>
      <div className="anchor-options">
        {options.map((option) => (
          <button type="button" key={option.id} className={`anchor-option ${selected === option.id ? 'is-selected' : ''}`} onClick={() => onSelect(option.id)}>
            <span className="choice-indicator">{selected === option.id ? <Check size={15} /> : <CircleDot size={15} />}</span>
            <span><strong>{option.title}</strong><small>{option.description}</small></span>
          </button>
        ))}
      </div>
    </section>
  )
}

function SpineStep({ addedNode, onAddedNodeChange }: { addedNode: string; onAddedNodeChange: (value: string) => void }) {
  return (
    <div className="spine-step stage-enter">
      <div className="node-path">
        {storyNodes.map((node, index) => (
          <div className="story-node" key={node.id}>
            <div className="node-rail"><span>{String(index + 1).padStart(2, '0')}</span><i /></div>
            <div className="node-copy"><div><em>{node.act}</em>{node.marker && <mark>{node.marker}</mark>}</div><strong>{node.title}</strong><p>{node.summary}</p></div>
          </div>
        ))}
        <div className="add-node">
          <Plus size={17} />
          <input value={addedNode} onChange={(event) => onAddedNodeChange(event.target.value)} placeholder="在这里加入你自己的情境节点" />
        </div>
      </div>
    </div>
  )
}

function PressureStep() {
  return (
    <div className="pressure-step stage-enter">
      <div className="pressure-head"><span>冲突等级</span><span>从不安到无法回头</span></div>
      <div className="pressure-chart" aria-label="冲突等级曲线">
        {storyNodes.map((node, index) => (
          <div className="pressure-column" key={node.id}>
            <div className="pressure-value">{node.pressure}</div>
            <div className="pressure-track"><span style={{ height: `${node.pressure * 18}%` }} /></div>
            <div className="pressure-node"><small>{String(index + 1).padStart(2, '0')}</small><strong>{node.title}</strong>{node.marker && <em>{node.marker}</em>}</div>
          </div>
        ))}
      </div>
      <div className="pressure-legend"><span><i className="legend-line" />正常升级</span><span><i className="legend-marker" />节奏锚点</span><p>第 4 节点让人误以为已经安全，第 7 节点将主角推到最低处。</p></div>
    </div>
  )
}

function StructureStep() {
  const acts: Act[] = ['起', '承', '转', '合']
  return (
    <div className="structure-step stage-enter">
      {acts.map((act) => (
        <section className={`act-column act-${act}`} key={act}>
          <header><span>{act}</span><p>{{ 起: '建立困境', 承: '扩大阻碍', 转: '改变局势', 合: '主动完成' }[act]}</p></header>
          <div className="act-events">
            {storyNodes.filter((node) => node.act === act).map((node) => (
              <div className="act-event" key={node.id}><small>{node.marker ?? '推进'}</small><strong>{node.title}</strong><p>{node.summary}</p></div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function BranchesStep({ selectedBranches, customBranches, showCustomBranch, onSelect, onShowCustom, onCustomChange }: {
  selectedBranches: Record<string, string>
  customBranches: Record<string, string>
  showCustomBranch: Record<string, boolean>
  onSelect: (groupId: string, optionId: string) => void
  onShowCustom: (groupId: string) => void
  onCustomChange: (groupId: string, value: string) => void
}) {
  return (
    <div className="branches-step stage-enter">
      {branchGroups.map((group, index) => (
        <section className="branch-group" key={group.id}>
          <header><span>0{index + 1}</span><div><p>{group.node}</p><h2>{group.title}</h2></div></header>
          <div className="branch-options">
            {group.choices.map((choice) => {
              const selected = selectedBranches[group.id] === choice.id
              const isCustom = choice.id === `${group.id}-custom`
              return (
                <div className={`branch-option ${selected ? 'is-selected' : ''}`} key={choice.id}>
                  <button type="button" onClick={() => isCustom ? onShowCustom(group.id) : onSelect(group.id, choice.id)}>
                    <span className="choice-indicator">{selected ? <Check size={15} /> : <CircleDot size={15} />}</span>
                    <span><strong>{choice.title}</strong><small>{choice.effect}</small></span>
                  </button>
                  {isCustom && showCustomBranch[group.id] && <input autoFocus value={customBranches[group.id] ?? ''} onChange={(event) => onCustomChange(group.id, event.target.value)} placeholder="写下这个分支的选择与后果" />}
                </div>
              )
            })}
          </div>
        </section>
      ))}
      <div className="branch-footnote"><GitBranch size={16} /><span>本原型保留 2 个关键分叉，后续分支会在终局前重新汇合，避免故事失控膨胀。</span></div>
    </div>
  )
}

function SpineItem({ index, label, value, active, complete }: { index: string; label: string; value: string; active: boolean; complete: boolean }) {
  return (
    <div className={`spine-item ${active ? 'is-active' : ''} ${complete ? 'is-complete' : ''}`}>
      <span>{complete ? <Check size={12} /> : index}</span><div><small>{label}</small><strong>{value}</strong></div>
    </div>
  )
}

function VerificationRow({ label, state, warning = false }: { label: string; state: string; warning?: boolean }) {
  return <div className={`verification-row ${warning ? 'is-warning' : ''}`}><span>{label}</span><strong>{warning ? <CircleDot size={14} /> : <Check size={14} />}{state}</strong></div>
}

export default App
