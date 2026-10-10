import { AppError } from './qwen.js'
import type {
  StoryAction,
  StoryFact,
  StoryNarrativeState,
  StoryPredicament,
  StorySeed,
  StoryTransition,
  StoryTurnHistoryItem,
  StoryTurnOption,
} from '../../shared/story-contract.js'

export interface StoryValidationContext {
  statusCode: number
  code: string
}

export interface NarrativeStateLimits {
  maximumActions: number
  maximumFacts: number
}

export interface NarrativeStateMachine {
  createInitialState(seed: StorySeed, predicament: StoryPredicament): StoryNarrativeState
  replayConfirmedTurns(
    seed: StorySeed,
    predicament: StoryPredicament,
    history: StoryTurnHistoryItem[],
    context: StoryValidationContext,
    message: string,
  ): StoryNarrativeState
  validateTurnOption(
    state: StoryNarrativeState,
    option: StoryTurnOption,
    context: StoryValidationContext,
    message: string,
  ): void
  validateActionTransition(
    state: StoryNarrativeState,
    action: StoryAction,
    transition: StoryTransition,
    context: StoryValidationContext,
    message: string,
  ): void
  validateExpectedTransition(
    state: StoryNarrativeState,
    transition: StoryTransition | null,
    expectedActionId: string,
    context: StoryValidationContext,
    message: string,
  ): void
  applyTransition(
    state: StoryNarrativeState,
    action: StoryAction,
    transition: StoryTransition,
  ): StoryNarrativeState
  applyExpectedTransition(
    state: StoryNarrativeState,
    transition: StoryTransition | null,
    expectedActionId: string,
    context: StoryValidationContext,
    message: string,
  ): StoryNarrativeState
}

export function createNarrativeStateMachine(limits: NarrativeStateLimits): NarrativeStateMachine {
  return {
    createInitialState: (seed, predicament) => createInitialNarrativeState(seed, predicament, limits),
    replayConfirmedTurns: (seed, predicament, history, context, message) => (
      replayConfirmedTurns(seed, predicament, history, limits, context, message)
    ),
    validateTurnOption: (state, option, context, message) => (
      validateTurnOption(state, option, limits, context, message)
    ),
    validateActionTransition: (state, action, transition, context, message) => (
      validateActionTransition(state, action, transition, limits, context, message)
    ),
    validateExpectedTransition: (state, transition, expectedActionId, context, message) => (
      validateExpectedTransition(state, transition, expectedActionId, limits, context, message)
    ),
    applyTransition,
    applyExpectedTransition: (state, transition, expectedActionId, context, message) => (
      applyExpectedTransition(state, transition, expectedActionId, limits, context, message)
    ),
  }
}

function replayConfirmedTurns(
  seed: StorySeed,
  predicament: StoryPredicament,
  history: StoryTurnHistoryItem[],
  limits: NarrativeStateLimits,
  context: StoryValidationContext,
  message: string,
): StoryNarrativeState {
  let state = createInitialNarrativeState(seed, predicament, limits)

  for (const item of history) {
    validateTurnOption(state, item.selectedOption, limits, context, message)
    state = applyTransition(state, item.selectedOption.narrativeAction, item.selectedOption.transition)
  }

  return state
}

function createInitialNarrativeState(
  seed: StorySeed,
  predicament: StoryPredicament,
  { maximumFacts }: NarrativeStateLimits,
): StoryNarrativeState {
  const userFacts: StoryFact[] = seed.lockedFacts.map((statement, index) => ({
    id: `fact-user-${index + 1}`,
    statement,
    source: 'user',
    mutability: 'fixed',
  }))
  const systemDraftFacts = createSystemDraftFacts(seed)
  const facts = [...userFacts, ...systemDraftFacts, ...predicament.facts]

  if (facts.length > maximumFacts || hasDuplicateIds(facts)) {
    throw new AppError('故事困境中的事实标识重复，请重新生成。', 502, 'INVALID_MODEL_OUTPUT')
  }

  return {
    revision: 0,
    facts,
    actions: predicament.actions,
    appliedTransitions: [],
  }
}

function createSystemDraftFacts(seed: StorySeed): StoryFact[] {
  // Co-creation sessions materialize only author-confirmed curve beats.
  // A system draft must never become a path fact in that workflow.
  if (seed.creativeBrief) return []
  if (!seed.systemDraft) return []

  const knownStatements = new Set(
    [...seed.lockedFacts, seed.lockedGoal]
      .filter((statement): statement is string => Boolean(statement))
      .map(normalizeFactStatement),
  )
  const systemDraftStatements: string[] = []
  const directions = seed.systemDraft.activeDirection
    ? [seed.systemDraft.activeDirection]
    : seed.systemDraft.directions ?? []

  for (const statement of [
    seed.systemDraft.goal,
    ...directions.flatMap((direction) => [direction.premise, direction.tradeoff]),
  ]) {
    const normalized = normalizeFactStatement(statement)
    if (knownStatements.has(normalized)) continue

    knownStatements.add(normalized)
    systemDraftStatements.push(statement)
  }

  return systemDraftStatements.map((statement, index) => ({
    id: `fact-system-draft-${index + 1}`,
    statement,
    source: 'system-draft',
    mutability: 'fixed',
  }))
}

function normalizeFactStatement(statement: string): string {
  return statement.trim().replace(/\s+/gu, ' ')
}

function validateTurnOption(
  state: StoryNarrativeState,
  option: StoryTurnOption,
  limits: NarrativeStateLimits,
  context: StoryValidationContext,
  message: string,
) {
  validateActionTransition(state, option.narrativeAction, option.transition, limits, context, message)
}

function validateActionTransition(
  state: StoryNarrativeState,
  action: StoryAction,
  transition: StoryTransition,
  limits: NarrativeStateLimits,
  context: StoryValidationContext,
  message: string,
) {
  if (state.actions.some((candidate) => candidate.id === action.id)) {
    throwValidationError(context, message, 'narrativeAction 的 id 已与当前状态中的行动重复。')
  }

  validateTransitionForAction(state, action, transition, limits, context, message)
}

function validateExpectedTransition(
  state: StoryNarrativeState,
  transition: StoryTransition | null,
  expectedActionId: string,
  limits: NarrativeStateLimits,
  context: StoryValidationContext,
  message: string,
) {
  resolveExpectedTransition(state, transition, expectedActionId, limits, context, message)
}

function applyExpectedTransition(
  state: StoryNarrativeState,
  transition: StoryTransition | null,
  expectedActionId: string,
  limits: NarrativeStateLimits,
  context: StoryValidationContext,
  message: string,
): StoryNarrativeState {
  const { action, transition: resolvedTransition } = resolveExpectedTransition(
    state,
    transition,
    expectedActionId,
    limits,
    context,
    message,
  )
  return applyTransition(state, action, resolvedTransition)
}

function resolveExpectedTransition(
  state: StoryNarrativeState,
  transition: StoryTransition | null,
  expectedActionId: string,
  limits: NarrativeStateLimits,
  context: StoryValidationContext,
  message: string,
): { action: StoryAction; transition: StoryTransition } {
  if (!transition || transition.actionId !== expectedActionId) {
    throwValidationError(context, message, 'transition 必须绑定输入中指定的行动 ID。')
  }

  const action = state.actions.find((candidate) => candidate.id === expectedActionId)
  if (!action) throwValidationError(context, message, 'transition 引用的行动不在当前状态中。')

  validateTransitionForAction(state, action, transition, limits, context, message)
  return { action, transition }
}

function validateTransitionForAction(
  state: StoryNarrativeState,
  action: StoryAction,
  transition: StoryTransition,
  limits: NarrativeStateLimits,
  context: StoryValidationContext,
  message: string,
) {
  if (transition.actionId !== action.id) {
    throwValidationError(context, message, 'transition.actionId 必须与 narrativeAction 对应。')
  }

  if (action.mode === 'focus' || action.mode === 'candidate') {
    if (action.effects.length || transition.changedFacts.length || transition.introducedFacts.length
      || transition.authorConfirmation || (action.mode === 'focus' && (action.preconditions.length || transition.consumedFacts.length))) {
      throwValidationError(context, message, '关注点与候选行动不能包含已执行结果或事实变更。')
    }
  }
  if (action.mode === 'executed') {
    const receipt = transition.authorConfirmation
    if (!receipt || !receipt.proposalId || !receipt.turnId || !receipt.resultText.trim()
      || !Number.isFinite(receipt.confirmedAt) || receipt.actionText !== action.intent
      || action.source !== 'user-choice' || action.effects.length || transition.changedFacts.length
      || transition.introducedFacts.length !== 1
      || transition.introducedFacts[0]!.statement !== receipt.resultText) {
      throwValidationError(context, message, '已执行结果必须逐字对应作者明确确认的结果，模型引用不能作为确认凭证。')
    }
  }

  const factsById = new Map(state.facts.map((fact) => [fact.id, fact]))
  validateReferencedFacts(action, transition, factsById, context, message)
  validateConsumedPreconditions(action, transition, context, message)
  validateFactPermissions(action, transition, factsById, context, message)
  validateEffectChanges(action, transition, factsById, context, message)
  validateIntroducedFacts(state, action, transition, factsById, limits, context, message)

  if (!transition.changedFacts.length
    && !transition.introducedFacts.length
    && action.mode !== 'focus' && action.mode !== 'candidate'
    && !isImplicitNarrativeTransition(action, transition)) {
    throwValidationError(context, message, 'transition 至少需要更新一个 effect 或引入一个行动直接带来的新事实。')
  }
}

function isImplicitNarrativeTransition(action: StoryAction, transition: StoryTransition): boolean {
  return action.source === 'generated'
    && action.preconditions.length === 0
    && action.effects.length === 0
    && transition.consumedFacts.length === 0
    && transition.changedFacts.length === 0
    && transition.introducedFacts.length === 0
}

function validateReferencedFacts(
  action: StoryAction,
  transition: StoryTransition,
  factsById: ReadonlyMap<string, StoryFact>,
  context: StoryValidationContext,
  message: string,
) {
  const referencedFactIds = [
    ...action.preconditions,
    ...action.effects,
    ...transition.consumedFacts,
  ]
  if (referencedFactIds.some((factId) => !factsById.has(factId))) {
    throwValidationError(context, message, 'narrativeAction 或 transition 引用了当前状态中不存在的 fact ID。')
  }
}

function validateConsumedPreconditions(
  action: StoryAction,
  transition: StoryTransition,
  context: StoryValidationContext,
  message: string,
) {
  if (action.preconditions.some((factId) => !transition.consumedFacts.includes(factId))) {
    throwValidationError(context, message, 'transition.consumedFacts 必须覆盖 narrativeAction.preconditions。')
  }
}

function validateFactPermissions(
  action: StoryAction,
  transition: StoryTransition,
  factsById: ReadonlyMap<string, StoryFact>,
  context: StoryValidationContext,
  message: string,
) {
  const usesUnknownFact = [...action.preconditions, ...transition.consumedFacts]
    .some((factId) => factsById.get(factId)?.mutability === 'unknown')
  const changesImmutableFact = action.effects
    .some((factId) => factsById.get(factId)?.mutability !== 'changeable')

  if (usesUnknownFact) {
    throwValidationError(context, message, 'narrativeAction.preconditions 和 transition.consumedFacts 不能引用 unknown fact。')
  }
  if (changesImmutableFact) {
    throwValidationError(context, message, 'narrativeAction.effects 只能引用 changeable fact。')
  }
}

function validateEffectChanges(
  action: StoryAction,
  transition: StoryTransition,
  factsById: ReadonlyMap<string, StoryFact>,
  context: StoryValidationContext,
  message: string,
) {
  const changesOnlyDeclaredEffects = transition.changedFacts.every(({ factId }) => {
    const fact = factsById.get(factId)
    return fact?.mutability === 'changeable' && action.effects.includes(factId)
  })
  const changedFactIds = new Set(transition.changedFacts.map((change) => change.factId))
  const changesEveryEffect = action.effects.every((factId) => changedFactIds.has(factId))
  const leavesEffectUnchanged = transition.changedFacts.some(({ factId, statement }) => {
    const previous = factsById.get(factId)?.statement
    return previous !== undefined && normalizeFactStatement(previous) === normalizeFactStatement(statement)
  })

  if (!changesOnlyDeclaredEffects || !changesEveryEffect || leavesEffectUnchanged) {
    throwValidationError(context, message, 'transition.changedFacts 必须只更新 narrativeAction.effects，并覆盖每一个 effect。')
  }
}

function validateIntroducedFacts(
  state: StoryNarrativeState,
  action: StoryAction,
  transition: StoryTransition,
  factsById: ReadonlyMap<string, StoryFact>,
  { maximumActions, maximumFacts }: NarrativeStateLimits,
  context: StoryValidationContext,
  message: string,
) {
  const introducedFactIds = transition.introducedFacts.map((fact) => fact.id)
  const introducesExistingFact = introducedFactIds.some((factId) => factsById.has(factId))
  const hasDuplicateIntroducedFacts = new Set(introducedFactIds).size !== introducedFactIds.length
  const hasInvalidIntroducedFact = transition.introducedFacts.some(
    (fact) => fact.source !== 'confirmed-action' || fact.mutability !== 'changeable',
  )
  const exceedsFactLimit = state.facts.length + introducedFactIds.length > maximumFacts
  const addsActionBeyondLimit = !state.actions.some((candidate) => candidate.id === action.id)
    && state.actions.length >= maximumActions

  if (introducesExistingFact) {
    throwValidationError(context, message, 'transition.introducedFacts 不能复用当前已有的 fact ID。')
  }
  if (hasDuplicateIntroducedFacts) {
    throwValidationError(context, message, 'transition.introducedFacts 中的 fact ID 不能重复。')
  }
  if (hasInvalidIntroducedFact) {
    throwValidationError(context, message, 'transition.introducedFacts 必须是本次行动带来的 changeable 事实。')
  }
  if (exceedsFactLimit) {
    throwValidationError(context, message, '当前状态中的事实已接近上限，请不要引入新的 fact。')
  }
  if (addsActionBeyondLimit) {
    throwValidationError(context, message, '当前故事路径已接近行动上限，请不要增加新的 narrativeAction。')
  }
}

function applyTransition(
  state: StoryNarrativeState,
  action: StoryAction,
  transition: StoryTransition,
): StoryNarrativeState {
  if (action.mode === 'focus' || action.mode === 'candidate') {
    if (action.effects.length || transition.changedFacts.length || transition.introducedFacts.length || transition.authorConfirmation) {
      throw new AppError('未确认提案不能写入事实状态。', 409, 'STORY_ACTION_REVIEW_REQUIRED')
    }
    return action.mode === 'focus'
      ? { ...state, focus: { actionId: action.id, sourceTexts: [...(action.focusSourceTexts ?? [])] } }
      : state
  }
  if (action.mode === 'executed') {
    validateActionTransition(state, action, transition, { maximumActions: Infinity, maximumFacts: Infinity },
      { statusCode: 409, code: 'STORY_ACTION_REVIEW_REQUIRED' }, '作者未确认这项行动的实际结果。')
  }
  const changesByFactId = new Map(transition.changedFacts.map((change) => [change.factId, change.statement]))
  const facts = state.facts.map((fact) => {
    const statement = changesByFactId.get(fact.id)
    return statement ? { ...fact, statement } : fact
  })

  return {
    ...(state.focus ? { focus: state.focus } : {}),
    revision: state.revision + 1,
    facts: [...facts, ...transition.introducedFacts],
    actions: state.actions.some((candidate) => candidate.id === action.id)
      ? state.actions
      : [...state.actions, action],
    appliedTransitions: [...state.appliedTransitions, transition],
  }
}

function hasDuplicateIds(facts: StoryFact[]): boolean {
  return new Set(facts.map((fact) => fact.id)).size !== facts.length
}

function throwValidationError(
  context: StoryValidationContext,
  message: string,
  modelMessage = message,
): never {
  throw new AppError(
    context.code === 'INVALID_MODEL_OUTPUT' ? modelMessage : message,
    context.statusCode,
    context.code,
  )
}
