/** The JSON Schema subset used by our model contracts, also checked locally.
 * Schemas constrain encoding only. References and story meaning stay with the
 * domain validators; no missing text, IDs or permissions are inferred here. */
export type OutputSchema = {
  type?: 'object' | 'array' | 'string' | 'boolean' | 'integer' | 'null'
  properties?: Record<string, OutputSchema>
  required?: string[]
  additionalProperties?: false
  items?: OutputSchema
  minItems?: number
  maxItems?: number
  enum?: readonly (string | number | boolean | null)[]
  anyOf?: OutputSchema[]
  description?: string
}

export const shape = {
  text: { type: 'string' } as OutputSchema,
  bool: { type: 'boolean' } as OutputSchema,
  nil: { type: 'null' } as OutputSchema,
  enum: (...values: (string | number | boolean | null)[]): OutputSchema => ({ enum: values }),
  array: (items: OutputSchema, minItems = 0, maxItems = 24): OutputSchema => ({ type: 'array', items, minItems, maxItems }),
  object: (properties: Record<string, OutputSchema>, optional: string[] = []): OutputSchema => ({ type: 'object', properties,
    required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false }),
  either: (...anyOf: OutputSchema[]): OutputSchema => ({ anyOf }),
}

/** Bounded, path-specific errors. Never copy narrative text into diagnostics. */
export function outputShapeErrors(value: unknown, schema: OutputSchema, path = '$'): string[] {
  const errors: string[] = []
  const fail = (message: string) => { if (errors.length < 12) errors.push(`${path}: ${message}`) }
  if (schema.anyOf && !schema.anyOf.some(branch => outputShapeErrors(value, branch, path).length === 0)) {
    // Report the nearest branch rather than dumping all alternatives or text.
    const nearest = schema.anyOf.map(branch => outputShapeErrors(value, branch, path)).sort((a, b) => a.length - b.length)[0]!
    return nearest.slice(0, 12)
  }
  if (schema.enum && !schema.enum.some(allowed => allowed === value)) fail('值不在允许的枚举中')
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { fail('必须是对象'); return errors }
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) fail(`缺少独立字段 ${key}`)
    for (const key of Object.keys(record)) {
      const property = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined
      if (property) errors.push(...outputShapeErrors(record[key], property, `${path}.${key}`))
      // Unexpected keys can themselves contain model prose. Only schema-owned
      // paths and field names may enter the server-side diagnostic.
      else if (schema.additionalProperties === false) fail('含有当前步骤不允许的字段')
      if (errors.length >= 12) break
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) { fail('必须是数组，不能是字符串或对象'); return errors }
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`至少 ${schema.minItems} 项`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`最多 ${schema.maxItems} 项`)
    for (let i = 0; schema.items && i < value.length && errors.length < 12; i++) {
      errors.push(...outputShapeErrors(value[i], schema.items, `${path}[${i}]`))
    }
  } else if (schema.type === 'null' ? value !== null
    : schema.type === 'integer' ? !Number.isInteger(value)
      : schema.type && typeof value !== schema.type) fail(`必须是 ${schema.type}`)
  return errors.slice(0, 12)
}
