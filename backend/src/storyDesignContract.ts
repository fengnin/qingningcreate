import { AppError } from './qwen.js'
import { createHash } from 'node:crypto'
import { activePreparationMaterial, preparationAuthorRequirements } from './storyPreparationContext.js'
import type { StoryPreparation } from '../../shared/story-preparation.js'
import type { CurveBeatKind, StoryDesignContract, ProvisionalCurve, ConfirmedCurve } from '../../shared/story-contract.js'

export type DesignContractStep = {
  kind: CurveBeatKind
  text: string
  materialIds: string[]
  action?: string | null
  expectedChange?: string | null
}

/** Compile only recorded author/selection data. No inference of completed events. */
export function compileStoryDesignContract(p: StoryPreparation, steps: DesignContractStep[], goalText?: string): StoryDesignContract {
  const active = activePreparationMaterial(p)
  const selected = p.candidates.find(candidate => p.acceptedCandidateIds.includes(candidate.id))
  const retiredSources = new Set(p.material.filter(item => p.authorReview?.supersededMaterialIds?.includes(item.id)).map(item => item.sourceId))
  const current = <T extends { sourceId: string; quote: string }>(entries: T[]) => entries.filter(entry =>
    !retiredSources.has(entry.sourceId) && p.sources.some(source => source.id === entry.sourceId && source.text.includes(entry.quote)))
  const goals = active.filter(item => item.role === 'goal')
  const goal = goalText?.trim() || goals[0]?.quote || ''
  const known = new Set(active.filter(item => item.role !== 'unknown').map(item => item.id))
  const objective = p.authorReview?.selectedStoryDirection?.trim() || goal || selected?.action || ''
  const fail = (): never => { throw new AppError('故事设计契约引用无效，请重试；已选方向仍保留。', 502, 'STORY_PREPARATION_INVALID_OUTPUT') }
  const nodes = steps.map((step, index) => {
    if (step.materialIds.some(id => !known.has(id))) fail()
    for (const excerpt of [step.action, step.expectedChange]) {
      if (excerpt !== undefined && excerpt !== null && (typeof excerpt !== 'string' || !excerpt.trim())) fail()
    }
    return { beatId: `beat-${step.kind}`, kind: step.kind, text: step.text, objective,
      dependsOn: index ? [`beat-${steps[index - 1]!.kind}`] : [],
      ...(step.action === undefined ? {} : { action: step.action }),
      ...(step.expectedChange === undefined ? {} : { expectedChange: step.expectedChange }),
      sourceIds: [...step.materialIds] }
  })
  return { protocol: 1, authority: 'future-design',
    sourceHash: createHash('sha256').update(JSON.stringify({ active, selected, sources: p.sources,
      selectedDirection: p.authorReview?.selectedStoryDirection, mainlineGoals: p.mainlineGoals, mainlineAnchors: p.mainlineAnchors })).digest('hex'),
    goal: { text: goal, sourceIds: active.filter(item => item.quote === goal).map(item => item.id) },
    authorRequirements: preparationAuthorRequirements(p),
    mainlineGoals: current(p.mainlineGoals ?? []).map(({ sourceId, quote }) => ({ sourceId, quote })),
    mainlineAnchors: current(p.mainlineAnchors ?? []).map(({ sourceId, quote, kind }) => ({ sourceId, quote, kind })),
    causalBridge: selected?.explanation
      ? { method: selected.explanation.method, change: selected.explanation.change }
      : selected?.causalBridge ? { method: selected.causalBridge.method, change: selected.causalBridge.change } : null,
    ...(p.authorReview?.selectedStoryDirection ? { selectedDirection: p.authorReview.selectedStoryDirection } : {}), nodes }
}

/** Never consume a historical contract after author editing or source changes.
 * A later compiler can rebuild it explicitly; reading does not invent new metadata. */
export function currentStoryDesignContract(curve: ProvisionalCurve | ConfirmedCurve): StoryDesignContract | undefined {
  const contract = curve.designContract
  if (!contract || !curve.preparation) return undefined
  const current = compileStoryDesignContract(curve.preparation, [], contract.goal.text)
  if (current.sourceHash !== contract.sourceHash) return undefined
  const beats = curve.beats.filter(beat => beat.status !== 'rejected')
  if (beats.length !== contract.nodes.length || beats.some((beat, index) => {
    const node = contract.nodes[index]!
    return beat.id !== node.beatId || beat.kind !== node.kind || beat.detail !== node.text || beat.status === 'stale'
  })) return undefined
  return contract
}

/** Explicit compilation at author confirmation, never an implicit read repair.
 * Changed text has no trustworthy old action/change summaries to carry over. */
export function rebuildStoryDesignContract(curve: ProvisionalCurve): StoryDesignContract {
  if (!curve.preparation || curve.beats.some(b => b.status === 'stale')) {
    throw new AppError('请先核对受影响的故事节点。', 409, 'STORY_CURVE_FOUNDATION_OUT_OF_DATE')
  }
  const activeIds = new Set(activePreparationMaterial(curve.preparation).filter(m => m.role !== 'unknown').map(m => m.id))
  const beats = curve.beats.filter(b => b.status !== 'rejected')
  const contract = compileStoryDesignContract(curve.preparation, beats.map(b => {
    const prior = curve.designContract?.nodes.find(n => n.beatId === b.id && n.text === b.detail)
    return { kind: b.kind, text: b.detail, materialIds: (prior?.sourceIds ?? []).filter(id => activeIds.has(id)),
      ...(prior ? { action: prior.action, expectedChange: prior.expectedChange } : {}) }
  }), curve.designContract?.goal.text ?? curve.foundation?.preservedGoal ?? curve.reasoning?.goal?.text)
  contract.nodes = contract.nodes.map((n, i) => ({ ...n, beatId: beats[i]!.id, dependsOn: [...beats[i]!.dependsOn] }))
  contract.authorRequirements = [...contract.authorRequirements ?? [], ...beats.filter(b => b.source === 'user-edit').map(b => ({
    id: `edit-${b.id}`, sourceId: `edit-${b.id}`, quote: b.detail, kind: 'development' as const, status: 'required' as const,
  }))]
  // Carry the author's actual request, not just the model's interpretation.
  // A later direct node edit supersedes this request for that node.
  for (const beat of beats.filter(b => b.source === 'user-edit')) {
    const instruction = [...curve.instructions].reverse().find(i => i.targetBeatId === beat.id)
    if (instruction?.kind === 'author-revision') contract.authorRequirements.push({
      id: `author-request-${beat.id}`, sourceId: `author-request-${beat.id}`, quote: instruction.text,
      kind: 'development', status: 'required',
    })
  }
  return contract
}

/** Compact source-bound input shared by generation and its existing semantic review. */
export function storyDesignContractInput(p: StoryPreparation, goalText?: string) {
  const active = activePreparationMaterial(p)
  const selected = p.candidates.find(candidate => p.acceptedCandidateIds.includes(candidate.id))
  return { ...compileStoryDesignContract(p, [], goalText),
    selectedAction: selected?.action ?? '',
    reservedUnknowns: active.filter(item => item.role === 'unknown').map(item => ({ id: item.id, quote: item.quote })),
    execution: 'none' as const }
}

export const storyDesignContractGuidance = `designContract是本次故事设计的结构化主线契约，authority=future-design，execution=none；目标、选定方向、办法与变化均不是已发生事实。每个节点必须服务goal或作者选定方向，合理绕路须对原问题、选择或代价产生作用；不能只在结尾重提目标来掩盖新任务接管。允许有动机的放弃或目标变化，不要求目标必定成功，不限定动作白名单。
生成节点必须返回action和expectedChange两个键，分别概括本节点提出的行动和预期变化；可以使用简洁概括，但不能添加节点没有的新事实。current-state没有明确行动或变化时相应字段填null；其他推进节点两个字段都必须是非空文本。变化可以是回应、决定或结果，不要求成功或反转，不为填字段增添新事件。依赖由服务器按节点顺序建立，未来节点不会因此成为已发生事件。
审阅时核对节点实际文本与契约目标、已选方向和因果桥是否相符；编号与字段完整不代表语义成立。`
