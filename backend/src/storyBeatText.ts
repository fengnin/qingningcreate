/** Presentation labels and typography do not make a new story development. */
export function normalizeStoryBeatText(text: string): string {
  return text.trim().replace(/^(?:(?:暂定|提案)\s*[：:]\s*)+/u, '')
    .replace(/[\s\p{P}]/gu, '')
}

export function repeatsStoryBeatText(text: string, existing: readonly string[]): boolean {
  const normalized = normalizeStoryBeatText(text)
  return normalized.length > 0 && existing.some(value => normalizeStoryBeatText(value) === normalized)
}
