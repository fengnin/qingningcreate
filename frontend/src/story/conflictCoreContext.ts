import type {
  StoryConflictCoreContext,
  StoryConflictCoreContextPrefill,
} from './types'

export function normalizeConflictCoreContext(
  context: StoryConflictCoreContext | undefined,
): StoryConflictCoreContext | undefined {
  const goal = context?.goal?.trim()
  const stake = context?.stake?.trim()
  const constraint = context?.constraint?.trim()
  if (!goal && !stake && !constraint) return undefined

  return {
    ...(goal ? { goal } : {}),
    ...(stake ? { stake } : {}),
    ...(constraint ? { constraint } : {}),
  }
}

export function mergeConflictCoreContext(
  ...contexts: Array<StoryConflictCoreContext | StoryConflictCoreContextPrefill | undefined>
): StoryConflictCoreContext {
  return normalizeConflictCoreContext(Object.assign({}, ...contexts)) ?? {}
}
