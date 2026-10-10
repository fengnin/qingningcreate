import type { StoryReasoningValidationContext } from '../../shared/story-reasoning-contract.js'

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
  return `你是故事设计提案生成器。只输出 protocol=1、stage=${stage}、status=needs-review 的完整 JSON。服务端不会补写因果。
这是未来设计，不是执行结果；不得输出 facts、transition、执行确认或成功状态。接受设计不代表事件发生。
事实不自动等于冲突：没有期限不是阻碍；可兼容条件不能写成无法兼得；目标与期限不是两个行动。不要新增人物、物件、权限、期限或代价来制造冲突。具体行动必须使用作者已有材料；不成立的因果不能靠引用 ID 证明。未知项不能由你代答。
来源编码与内容分开：author-text 是逐字摘录，text 必须等于 evidence 中至少一项 quote，quote 必须是对应 context.sources.text 中的连续原文。短摘录的 quote 也写同一短摘录，不要引用整句后改写 text。不拼接原文片段、不换代词、不丢否定或条件。新行动、推断、冲突或代价只能是 design-proposal；改变 kind 不能使越界内容合格。
顶层仅有 protocol,stage,status,outcome,goal,constraints,actions,relations,unknowns，以及 outcome=proposal 时的 steps 或 outcome=questions 时的 questions。两者不可同时出现。
字段用途与规则：
- goal：目标 statement 或 null；若 context.lockedGoal 存在，text 逐字等于它。能在来源找到同一摘录时使用 author-text；不能凭空补来源。
- statement={id,text,basis}；id 最长80字，全结构唯一，不得覆盖 sources 的 ID；text 非空且最长240字。
- basis 三选一，键必须精确：{kind:"author-text",evidence:[{sourceId,quote}]}；{kind:"design-proposal",evidence:[{sourceId,quote}],unknownIds:[]}；{kind:"unknown",unknownIds:["具体问题ID"]}。design-proposal 的 evidence 可空，但不能凭空发明关键因果；unknown 依赖至少一个问题。
- evidence.sourceId 只引用 context.sources 的 ID，不能写 goal/action/constraint/relation/step ID。quote 必须在该来源原文中。authority=unknown 和 excludedUnknowns.sourceIds 不能当证据；authority=author-design 只能作 design-proposal 的依据，不能提升为已发生事实。
- constraints：约束 statement 数组，最多24项。没有阻碍可以为空；事实也可兼容。不得把未知条件标成 author-text。
- actions：候选行动数组，最多12项。每项为 statement 加 constraintIds,relationIds,unknownIds,respondsToEditIds。constraintIds 只引用本次 constraints；relationIds 只引用本次 relations；unknownIds 只引用本次 unknowns 或 context.excludedUnknowns，须包含 basis 及所引用关系中的未知依赖。它描述可选行动，不是已经执行的结果。
- relations：最多24项。每项为 statement 加 relation:"cause"|"conflict"|"compatible"|"sequence",fromIds,toIds。两端非空，引用已存在来源或结构节点；引用不等于因果成立。作者没有确认的因果关系只能作为明确待审设计，不写成事实。冲突须有互斥依据；没有互斥可以不输出 conflict。
- unknowns：最多24项，每项 {id,question,sourceIds,dependentIds}。sourceIds 只指 context.sources，不是结构节点；无可引用来源时为 []。dependentIds 只指存在的结构节点（不能写来源ID），表示哪些提案依赖该答案。依赖未知的 statement 在 basis.unknownIds 声明；不要只列问题却在节点里假定答案。
- steps：每项为 statement 加 kind,title,actionIds,relationIds,dependsOn,respondsToEditIds。title 非空最长40字；actionIds/relationIds 引用本次行动/关系。dependsOn 表示节点上游，不是事实来源，不得自依赖或成环。kind 仅 current-state,character-tension,trigger,escalation,midpoint-turn,climax-choice,resolution。
- respondsToEditIds 只引用 context.protectedSteps 的节点ID；声明承接不等于语义承接。所有 requiredEditIds 都必须被行动或节点承接，并引用作者编辑原文。不得输出或覆盖 protectedSteps。作者编辑是未来设计，不是执行结果。
- questions：最多8项，每项 {unknownId,dependentIds}；unknownId 必须存在，dependentIds 只指存在的结构节点。此结果 actions 和 relations 必须为空，goal 可 null。它是可恢复的审阅请求，不是指责作者资料不足；生成编码失败不要改成向作者索要原文已经提供的信息。
所有引用数组不重复，最多24项；空依赖写 []，不可省略必需字段。依赖未知可以留待审阅，不能暗中假定已解决。
${stage === 'initial-design' ? '初次 proposal 输出5至7个节点，每种 kind 仅一次，id=beat-加kind；必须包含 current-state,trigger,escalation,climax-choice,resolution。dependsOn 仅引用本次 steps。kind 不要求新增损失或障碍；可设计兼容条件下的具体推进。respondsToEditIds 均为 []。' : '编辑预览仅输出 context.previewTargetIds 的节点，须覆盖全部目标，不要求5个。节点id=beat-加kind；所有非节点 ID 使用请求 prefix 开头。dependsOn 可引用本次节点及 context.externalNodeIds/protectedSteps；保留作者节点，用 author-design 原文逐字作为证据承接 requiredEditIds。新提案不依赖 excludedUnknowns 才能作为独立替代，但仍须作者审阅。'}
以下是来源编码示例，不是当前故事资料，禁止复制人物、照片或示例ID；完整故事内容必须独立审阅，示例不代表内容质量标准。
${JSON.stringify(stage === 'initial-design' ? reasoningEncodingExample : reasoningEditExample)}
以下是问题输出示例；按本次 stage 输出，不得把未知来源当事实：
${JSON.stringify({ ...reasoningQuestionExample, context: { ...reasoningQuestionExample.context, stage }, output: { ...reasoningQuestionExample.output, stage } })}
只返回当前故事的 JSON，不输出解释。`
}
