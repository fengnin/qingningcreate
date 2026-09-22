/**
 * Validates only explicit countdown arithmetic. It deliberately ignores vague
 * timing language and ordinary clock readings so story prose stays flexible.
 */
const countdownMarkerPattern = /倒计时|计时器|还剩|仅剩|剩余|距(?:离)?[^。！？；\n]{0,32}(?:开始|截止|结束|到期|登场|前奏)|(?:开始|截止|结束|到期|登场|前奏)[^。！？；\n]{0,32}(?:还剩|仅剩|剩余)/
const remainingSecondsMarkerPattern = /倒计时|还剩|仅剩|剩余|距(?:离)?|(?:开始|截止|结束|到期|登场|前奏)[^。！？；\n]{0,24}前/
const countdownPattern = /(?<!\d)(\d{1,2})\s*[:：]\s*([0-5]\d)(?!\d)/g
const secondsPattern = /(?<!\d)(\d{1,5})\s*秒(?:钟)?/g

interface CountdownValue {
  text: string
  seconds: number
}

/**
 * Finds contradictions such as “倒计时 02:58，距开始仅剩 112 秒”.
 * Both values must occur in the same sentence-like clause and carry clear
 * countdown context; otherwise the claim is left to semantic review.
 */
export function getExplicitCountdownConsistencyIssues(texts: readonly string[]): string[] {
  const issues = new Set<string>()

  for (const text of texts) {
    for (const clause of splitTimelineClauses(text)) {
      const countdowns = getCountdownValues(clause)
      const remainingSeconds = getRemainingSeconds(clause)
      if (countdowns.length !== 1 || remainingSeconds.length !== 1) continue

      const countdown = countdowns[0]!
      const actualSeconds = remainingSeconds[0]!
      if (countdown.seconds === actualSeconds) continue

      issues.add(`倒计时 ${countdown.text} 等于 ${countdown.seconds} 秒，不能同时写成仅剩 ${actualSeconds} 秒`)
    }
  }

  return [...issues]
}

function splitTimelineClauses(text: string): string[] {
  return text
    .split(/[。！？；\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

function getCountdownValues(clause: string): CountdownValue[] {
  const values: CountdownValue[] = []

  for (const match of clause.matchAll(countdownPattern)) {
    const [text, minutesText, secondsText] = match
    const index = match.index ?? 0
    if (!hasCountdownContext(clause, index, text.length)) continue

    const minutes = Number(minutesText)
    const seconds = Number(secondsText)
    values.push({ text: text.replace('：', ':'), seconds: minutes * 60 + seconds })
  }

  return values
}

function getRemainingSeconds(clause: string): number[] {
  const values: number[] = []

  for (const match of clause.matchAll(secondsPattern)) {
    const [text, secondsText] = match
    const index = match.index ?? 0
    if (!hasRemainingSecondsContext(clause, index, text.length)) continue

    values.push(Number(secondsText))
  }

  return values
}

function hasCountdownContext(clause: string, index: number, length: number): boolean {
  return countdownMarkerPattern.test(getNearbyText(clause, index, length))
}

function hasRemainingSecondsContext(clause: string, index: number, length: number): boolean {
  return remainingSecondsMarkerPattern.test(getNearbyText(clause, index, length))
}

function getNearbyText(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40)
  const end = Math.min(text.length, index + length + 40)
  return text.slice(start, end)
}
