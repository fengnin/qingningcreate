/** Protocol identifiers are never narrative evidence. Preserve author text,
 * but reject newly leaked identifiers instead of silently rewriting prose. */
export function hasProposalProtocolLeak(prose: string, authorTexts: readonly string[]): boolean {
  const markers = prose.match(/\b(?:materialIds|resultBasisIds|preconditionIds|unknownIds|sourceFacts?|candidatePlan|lastAuthorConfirmedResult|executedHistory|referenceContract|fact-author-result-[\w-]+|m\d+)\b/giu) ?? []
  return markers.some(marker => !authorTexts.some(text => text.includes(marker)))
}
