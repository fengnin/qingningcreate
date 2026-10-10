import type { StoryReasoningValidationContext } from '../../shared/story-reasoning-contract.js'
import { storyReasoningWireExample } from './storyReasoningWire.js'

/** Examples describe encoding, not facts for the current story. Keep them
 * executable against the same validator used for real model responses. */
export const reasoningEncodingExample = {
  context: { stage: 'initial-design', sources: [
    { id: 'example-material', text: '许禾想整理旧照片；按日期分类不损坏照片。', authority: 'author-material' },
  ], protectedSteps: [], requiredEditIds: [], lockedGoal: '整理旧照片' } satisfies StoryReasoningValidationContext,
  output: {
    protocol: 1, stage: 'initial-design', status: 'needs-review', outcome: 'proposal',
    goal: { id: 'goal', text: '整理旧照片', basis: { kind: 'author-text', evidence: [{ sourceId: 'example-material', quote: '整理旧照片' }] } },
    constraints: [{ id: 'keep', text: '按日期分类不损坏照片', basis: { kind: 'author-text', evidence: [{ sourceId: 'example-material', quote: '按日期分类不损坏照片' }] } }],
    actions: [{ id: 'sort', text: '提案：先按日期分类，保留每张照片。', basis: { kind: 'design-proposal', evidence: [{ sourceId: 'example-material', quote: '按日期分类不损坏照片' }], unknownIds: [] }, constraintIds: ['keep'], relationIds: [], unknownIds: [], respondsToEditIds: [] }],
    relations: [], unknowns: [],
    steps: ['current-state', 'trigger', 'escalation', 'climax-choice', 'resolution'].map((kind, i, kinds) => ({
      id: `beat-${kind}`, kind, title: ['现状', '开始', '整理', '检查', '收尾'][i],
      text: ['许禾想整理旧照片', '提案：先拿一张照片辨认日期。', '提案：按日期逐张分类，保留无法辨认日期的照片。', '提案：检查分组；日期不清的先留待作者补充，不猜日期。', '提案：分类后核对照片数量，结果仍待作者确认。'][i],
      basis: i === 0 ? { kind: 'author-text', evidence: [{ sourceId: 'example-material', quote: '许禾想整理旧照片' }] }
        : { kind: 'design-proposal', evidence: [{ sourceId: 'example-material', quote: '按日期分类不损坏照片' }], unknownIds: [] },
      actionIds: i ? ['sort'] : [], relationIds: [], dependsOn: i ? [`beat-${kinds[i - 1]}`] : [], respondsToEditIds: [],
    })),
  },
}

export const reasoningQuestionExample = {
  context: { stage: 'initial-design', sources: [{ id: 'example-unknown', text: '盒内是什么尚未确定。', authority: 'unknown' }], protectedSteps: [], requiredEditIds: [] } satisfies StoryReasoningValidationContext,
  output: { protocol: 1, stage: 'initial-design', status: 'needs-review', outcome: 'questions', goal: null,
    constraints: [], actions: [], relations: [], unknowns: [{ id: 'contents', question: '盒内是什么？', sourceIds: ['example-unknown'], dependentIds: [] }],
    questions: [{ unknownId: 'contents', dependentIds: [] }] },
}

export const reasoningEditExample = {
  context: { ...reasoningEncodingExample.context, stage: 'edit-preview',
    sources: [...reasoningEncodingExample.context.sources, { id: 'edit-beat-trigger', text: '先分类，日期不清的保留待问。', authority: 'author-design' }],
    protectedSteps: [{ id: 'beat-trigger', text: '先分类，日期不清的保留待问。' }], requiredEditIds: ['beat-trigger'],
    previewTargetIds: ['beat-escalation'], externalNodeIds: ['beat-trigger'],
  } satisfies StoryReasoningValidationContext,
  prefix: 'preview-example',
  output: { ...reasoningEncodingExample.output, stage: 'edit-preview',
    goal: { ...reasoningEncodingExample.output.goal, id: 'preview-example-goal' },
    constraints: reasoningEncodingExample.output.constraints.map(c => ({ ...c, id: 'preview-example-keep' })),
    actions: [{ ...reasoningEncodingExample.output.actions[0]!, id: 'preview-example-sort', constraintIds: ['preview-example-keep'], respondsToEditIds: ['beat-trigger'],
      basis: { kind: 'design-proposal', evidence: [{ sourceId: 'edit-beat-trigger', quote: '先分类，日期不清的保留待问。' }], unknownIds: [] } }],
    steps: [{ ...reasoningEncodingExample.output.steps[2]!, actionIds: ['preview-example-sort'], dependsOn: ['beat-trigger'], respondsToEditIds: ['beat-trigger'],
      basis: { kind: 'design-proposal', evidence: [{ sourceId: 'edit-beat-trigger', quote: '先分类，日期不清的保留待问。' }], unknownIds: [] } }],
  },
}

export function storyReasoningSystemPrompt(stage: 'initial-design' | 'edit-preview'): string {
  return `你是故事设计提案生成器。只输出 protocol=2、stage=${stage}、status=needs-review 的完整 JSON。服务端不会补写因果。
这是未来设计，不是执行结果；不得输出 facts、transition、执行确认或成功状态。接受设计不代表事件发生。
系统可以提出创意，但不能把创意伪装成已有事实。新增人物、物件、规则、权限或代价可以作为明确、可拒绝的设计建议；不能写成作者已经提供的条件、机构已经有的流程、已取得权限或已发生结果。请在 proposal 文案中写清“建议新增什么”，以及“仅当作者接受该设定时，后续提案才依赖它”；不要一边标成提案，一边把新增设定当现有规则。作者接受设计也不等于人物已经行动或后果发生。
事实不自动等于冲突：没有期限不是阻碍；可兼容条件不能写成无法兼得；目标与期限不是两个行动。优先承接作者已有行动对象，必要创意明确说明用途和可拒绝性；不能用未审阅的新创意绕开原有问题。不成立的因果不能靠引用 ID 证明。未知项不能由你代答，也不能把已有明确事实改称未知来制造压力。
来源编码与内容分开：原文 content.kind=quote 只输出 sourceId 和 quote 一次，不输出 text 或 basis。quote 必须是对应 context.sources.text 中保持条件的连续原文。不拼接片段、不换代词、不丢否定或条件。新行动、推断、冲突或代价只能是 content.kind=proposal；改变 kind 不能使越界内容合格。
顶层仅有 protocol,stage,status,outcome,goal,constraints,actions,relations,unknowns，以及 outcome=proposal 时的 steps 或 outcome=questions 时的 questions。两者不可同时出现。
字段用途与规则：
- goal：目标 statement 或 null；若 context.lockedGoal 存在，必须输出 {id:"本次唯一goalID",content:{kind:"locked-goal"}}，不重复目标文本、不编目标依据。锁定目标是服务器提供的意图，不是新发生事实。
- statement={id,content}；id 最长80字，全结构唯一，不得覆盖 sources 的 ID。禁止旧的 text/basis 双份编码。
- content 三选一，键必须精确：{kind:"quote",sourceId:"来源ID",quote:"连续原文"}；{kind:"proposal",text:"具体待审设计",evidence:[{sourceId,quote}],unknownIds:[]}；{kind:"unknown",text:"未确定的内容",unknownIds:["具体问题ID"]}。text/quote 非空最长240字。proposal 的 evidence 可空；新增关键因果须明确为新设计及其审阅依赖，不能冒充已有依据。unknown 依赖至少一个问题。locked-goal 仅限目标。
- sourceId 只引用 context.sources 的 ID，不能写 goal/action/constraint/relation/step ID。quote 必须在该来源原文中。authority=unknown 和 excludedUnknowns.sourceIds 不能当证据；authority=author-design 只能作 proposal 的依据，不能提升为原文事实。
- constraints：约束 statement 数组，最多24项。没有阻碍可以为空；事实也可兼容。作者原规则用 quote；新增规则用 proposal，例如“建议新增提交前需勾选确认项的规则；仅在作者接受该设定后用于设计压力”，不能写“需要勾选才可提交”冒充现有规则。依赖这项新规则的行动须在 constraintIds 引用它，关系须在 fromIds/toIds 引用它。未知原规则用 unknown；不能把未知当确定。
- actions：候选行动数组，最多12项。每项为 statement 加 constraintIds,relationIds,unknownIds,respondsToEditIds。constraintIds 只引用本次 constraints；relationIds 只引用本次 relations；unknownIds 只引用本次 unknowns 或 context.excludedUnknowns，须包含 content 及所引用关系中的未知依赖。它描述可选行动，不是已经执行的结果。
- relations：最多24项。每项必须包含 id,content,relation,fromIds,toIds，不能仅输出关系边。relation:"cause"|"conflict"|"compatible"|"sequence"。两端非空，引用已存在来源或结构节点；引用不等于因果成立。作者没有确认的因果关系只能作为明确待审设计，不写成事实。冲突须有互斥依据；没有互斥可以不输出 conflict。合法编码示例（ID须替换为本次存在的ID）：{"id":"relation-example","content":{"kind":"proposal","text":"提案：先分类，再核对数量。","evidence":[],"unknownIds":[]},"relation":"sequence","fromIds":["action-sort"],"toIds":["action-count"]}。缺少 content 必须拒绝，服务器不补关系含义。
- unknowns：最多24项，每项 {id,question,sourceIds,dependentIds}。sourceIds 只指 context.sources，不是结构节点；无可引用来源时为 []。dependentIds 只指存在的结构节点（不能写来源ID），表示哪些提案依赖该答案。依赖未知的 statement 在 content.unknownIds 声明；不要只列问题却在节点里假定答案。
- steps：每项为 statement 加 kind,title,actionIds,relationIds,dependsOn,respondsToEditIds。title 非空最长40字；actionIds/relationIds 引用本次行动/关系。dependsOn 表示节点上游，不是事实来源，不得自依赖或成环。kind 仅 current-state,character-tension,trigger,escalation,midpoint-turn,climax-choice,resolution。
- respondsToEditIds 只引用 context.protectedSteps 的节点ID；声明承接不等于语义承接。所有 requiredEditIds 都必须被行动或节点承接，并引用作者编辑原文。不得输出或覆盖 protectedSteps。作者编辑是未来设计，不是执行结果。
- questions：最多8项，每项 {unknownId,dependentIds}；unknownId 必须存在，dependentIds 只指存在的结构节点。此结果 actions 和 relations 必须为空，goal 可 null。它是可恢复的审阅请求，不是指责作者资料不足；生成编码失败不要改成向作者索要原文已经提供的信息。
所有引用数组不重复，最多24项；空依赖写 []，不可省略必需字段。依赖未知可以留待审阅，不能暗中假定已解决。
${stage === 'initial-design' ? '初次 proposal 输出5至7个节点，每种 kind 仅一次，id=beat-加kind；必须包含 current-state,trigger,escalation,climax-choice,resolution。dependsOn 仅引用本次 steps。kind 不要求新增损失或障碍；可设计兼容条件下的具体推进。respondsToEditIds 均为 []。' : '编辑预览仅输出 context.previewTargetIds 的节点，须覆盖全部目标，不要求5个。节点id=beat-加kind；所有非节点 ID 使用请求 prefix 开头。dependsOn 可引用本次节点及 context.externalNodeIds/protectedSteps；保留作者节点，用 author-design 原文逐字作为证据承接 requiredEditIds。新提案不依赖 excludedUnknowns 才能作为独立替代，但仍须作者审阅。'}
以下是来源编码示例，不是当前故事资料，禁止复制人物、照片或示例ID；完整故事内容必须独立审阅，示例不代表内容质量标准。
${JSON.stringify(stage === 'initial-design' ? { context: reasoningEncodingExample.context, output: storyReasoningWireExample(reasoningEncodingExample.output, reasoningEncodingExample.context) } : { context: reasoningEditExample.context, prefix: reasoningEditExample.prefix, output: storyReasoningWireExample(reasoningEditExample.output, reasoningEditExample.context) })}
以下是问题输出示例；按本次 stage 输出，不得把未知来源当事实：
${JSON.stringify({ context: { ...reasoningQuestionExample.context, stage }, output: storyReasoningWireExample({ ...reasoningQuestionExample.output, stage }, { ...reasoningQuestionExample.context, stage }) })}
只返回当前故事的 JSON，不输出解释。`
}
