/** Resolve program-owned excerpts. Invalid selections are errors, never approvals. */
export function selectStoryEvidence<T extends { id: string }>(
  ids: unknown, catalog: readonly T[], allowed: (entry: T) => boolean,
  minimum: number, maximum: number, invalid: () => never,
): T[] {
  if (!Array.isArray(ids) || ids.length < minimum || ids.length > maximum || new Set(ids).size !== ids.length) return invalid()
  return ids.map(id => {
    const entry = catalog.find(entry => entry.id === id)
    if (!entry || !allowed(entry)) return invalid()
    return entry
  })
}
