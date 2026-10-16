/** Keep the existing action contract while editing its two displayed parts. */
export function splitPreparationAction(action: string) {
  const match = action.match(/^遇到的难处：([\s\S]*?)(\s*眼前的选择：)([\s\S]*)$/u)
  return match
    ? { difficulty: match[1], choice: match[3], separator: match[2] }
    : { difficulty: action, choice: '', separator: '\n眼前的选择：' }
}

export function updatePreparationAction(action: string, field: 'difficulty' | 'choice', value: string) {
  const parts = { ...splitPreparationAction(action), [field]: value }
  return `遇到的难处：${parts.difficulty}${parts.separator}${parts.choice}`
}

export function preparationActionFieldLimit(action: string, field: 'difficulty' | 'choice') {
  return Math.max(0, 240 - updatePreparationAction(action, field, '').length)
}
