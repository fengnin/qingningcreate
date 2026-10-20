/** Lossless, request-local text interning. IDs, roles, order and short values
 * stay in place; every reference points directly to the first original string.
 * This is a wire format only: saved designs and drafts are never rewritten. */
export const writingInputEncodingGuidance = '\n输入去重格式：若某个字段为{"$textRef":"/路径"}，它与该路径处的完整原文完全相同。路径使用JSON Pointer，数组下标从0开始，~1表示/、~0表示~。请读取引用指向的完整文本，并按引用所在字段的身份、来源和顺序理解；引用不表示省略、未知或新的事实。不在输出中返回引用格式。'

export function serializeWritingInput(input: object): string {
  // Match JSON.stringify's existing handling of undefined fields before walking.
  const source = JSON.parse(JSON.stringify(input)) as unknown
  const strings = new Map<string, string>()
  const escape = (part: string) => part.replaceAll('~', '~0').replaceAll('/', '~1')
  function visit(value: unknown, path: string): unknown {
    if (typeof value === 'string' && value.length >= 48) {
      const previous = strings.get(value)
      if (previous !== undefined) return { $textRef: previous }
      strings.set(value, path)
    }
    if (Array.isArray(value)) return value.map((item, i) => visit(item, `${path}/${i}`))
    if (value !== null && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, visit(item, `${path}/${escape(key)}`)]),
    )
    return value
  }
  const compact = JSON.stringify(visit(source, ''))
  const original = JSON.stringify(source)
  // Small inputs or unusually long reference paths need not get larger.
  return compact.length < original.length ? compact : original
}
