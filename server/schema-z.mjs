// The part of Zod that MVU variable schemas use, written for this app so a release carries no copy of Zod.
// server/schema.mjs puts createZ's source into the sandbox a card's schema runs in, so it refers to nothing
// outside itself. test/schema-z.test.mjs holds it to Zod 4's results. What a schema asks for that is not here
// fails where it is called, and that card's schema is then not kept to: the state stays as the model wrote it.
export function createZ() {
  const result = (value, issues = []) => ({ value, issues })
  const bad = (value, message) => result(value, [{ message, path: [] }])
  const within = (key, issues) => issues.map(item => ({ ...item, path: [key, ...item.path] }))
  const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
  const made = value => (typeof value === 'function' ? value() : Array.isArray(value) ? [...value] : isObject(value) ? { ...value } : value)
  const withValue = (values, extra) => (values ? new Set([...values, extra]) : undefined)
  const failure = issues => {
    const error = new Error(issues.map(item => `${item.path.join('.') || '（根）'}: ${item.message}`).join('; '))
    error.issues = issues
    return error
  }

  // optin and optout say what a field does when its key is absent, as Zod's do: 'optional' (nothing needed),
  // 'defaulted' (it supplies a value), or undefined (the key is required). `values`: all it can be, when that is known.
  class Schema {
    constructor(read, { optin, optout, values } = {}) {
      this.read = read
      this.optin = optin
      this.optout = optout
      this.values = values
      this.checks = []
    }

    run(value) {
      let out = this.read(value)
      for (const check of this.checks) {
        if (out.issues.length) break
        out = check(out)
      }
      return out
    }

    safeParse(value) {
      const out = this.run(value)
      return out.issues.length ? { success: false, error: failure(out.issues) } : { success: true, data: out.value }
    }

    parse(value) {
      const out = this.safeParse(value)
      if (!out.success) throw out.error
      return out.data
    }

    with(check) {
      const copy = Object.assign(Object.create(Object.getPrototypeOf(this)), this)
      copy.checks = [...this.checks, check]
      return copy
    }

    test(passes, message) {
      return this.with(out => (passes(out.value) ? out : bad(out.value, message)))
    }

    rewrite(change) {
      return this.with(out => result(change(out.value)))
    }

    // Numbers by size, strings and lists by length.
    min(n) {
      return this.test(v => (typeof v === 'number' ? v : v.length) >= n, `至少 ${n}`)
    }

    max(n) {
      return this.test(v => (typeof v === 'number' ? v : v.length) <= n, `至多 ${n}`)
    }

    gte(n) { return this.min(n) }
    lte(n) { return this.max(n) }
    gt(n) { return this.test(v => v > n, `大于 ${n}`) }
    lt(n) { return this.test(v => v < n, `小于 ${n}`) }
    positive() { return this.gt(0) }
    negative() { return this.lt(0) }
    nonnegative() { return this.min(0) }
    nonpositive() { return this.max(0) }
    int() { return this.test(Number.isSafeInteger, '要是整数') }
    finite() { return this }
    length(n) { return this.test(v => v.length === n, `长度 ${n}`) }
    nonempty() { return this.min(1) }
    regex(pattern) { return this.test(v => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(v), '格式不对') }
    trim() { return this.rewrite(v => v.trim()) }
    toLowerCase() { return this.rewrite(v => v.toLowerCase()) }
    toUpperCase() { return this.rewrite(v => v.toUpperCase()) }

    refine(passes, message) {
      return this.test(passes, typeof message === 'string' ? message : message?.message ?? '不符合规则')
    }

    // A label for tools: nothing to do with what a value becomes.
    describe() { return this }
    meta() { return this }
    readonly() { return this }
    brand() { return this }

    optional() {
      const optin = this.optin === 'defaulted' ? 'defaulted' : 'optional'
      return new Schema(value => {
        if (value !== undefined) return this.run(value)
        if (this.optin !== 'defaulted') return result(undefined)
        const out = this.run(undefined)
        return result(out.issues.length ? undefined : out.value)
      }, { optin, optout: 'optional', values: withValue(this.values, undefined) })
    }

    nullable() {
      return new Schema(value => (value === null ? result(null) : this.run(value)), { optin: this.optin, optout: this.optout, values: withValue(this.values, null) })
    }

    nullish() {
      return this.nullable().optional()
    }

    default(fallback) {
      return new Schema(value => {
        if (value === undefined) return result(made(fallback))
        const out = this.run(value)
        return out.value === undefined ? { ...out, value: made(fallback) } : out
      }, { optin: 'defaulted', values: this.values })
    }

    prefault(fallback) {
      return new Schema(value => this.run(value === undefined ? made(fallback) : value), { optin: 'defaulted', values: this.values })
    }

    catch(fallback) {
      const value = input => (typeof fallback === 'function' ? fallback(input) : fallback)
      return new Schema(input => {
        const out = this.run(input)
        return out.issues.length ? result(value({ value: input, input, issues: out.issues, error: { issues: out.issues } })) : out
      }, { optin: this.optin === 'defaulted' ? 'defaulted' : 'optional', optout: this.optout, values: this.values })
    }

    pipe(next) {
      return new Schema(value => {
        const left = this.run(value)
        return left.issues.length ? left : next.run(left.value)
      }, { optin: this.optin, optout: next.optout, values: this.values })
    }

    transform(change) {
      return this.pipe(transform(change))
    }

    or(other) {
      return union([this, other])
    }

    array() {
      return array(this)
    }
  }

  function transform(change) {
    return new Schema(value => {
      const issues = []
      const out = change(value, { value, issues, addIssue: item => issues.push({ message: String(item?.message ?? item), path: item?.path ?? [] }) })
      return result(out, issues)
    }, { optin: 'optional' })
  }

  const kind = (type, passes, turn = value => value) => new Schema(input => {
    const value = turn(input)
    return passes(value) ? result(value) : bad(value, `要是 ${type}`)
  })
  const string = turn => kind('string', v => typeof v === 'string', turn)
  const number = turn => kind('number', v => typeof v === 'number' && Number.isFinite(v), turn)
  const boolean = turn => kind('boolean', v => typeof v === 'boolean', turn)

  function oneOf(list, name) {
    const values = new Set(list)
    const schema = new Schema(value => (values.has(value) ? result(value) : bad(value, `要是 ${name}`)), { values })
    schema.options = [...values]
    return schema
  }

  /** One field of an object into `out`, as Zod treats a key that is absent. */
  function place(out, issues, key, field, input) {
    const present = key in input
    const optionalOut = field.optout === 'optional'
    if (!present && optionalOut && field.optin === 'optional') return
    const got = field.run(input[key])
    if (got.issues.length) {
      if (field.optin !== undefined && optionalOut && !present) return
      issues.push(...within(key, got.issues))
    }
    if (!present && field.optin === undefined) {
      if (!got.issues.length) issues.push({ message: '缺这个字段', path: [key] })
      return
    }
    if (got.value !== undefined) out[key] = got.value
    else if (present || (field.optin === 'defaulted' && !optionalOut)) out[key] = undefined
  }

  class ObjectSchema extends Schema {
    constructor(shape, unknown = 'strip') {
      super(input => {
        if (!isObject(input)) return bad(input, '要是对象')
        const out = {}
        const issues = []
        for (const key of Object.keys(shape)) place(out, issues, key, shape[key], input)
        if (unknown === 'strip') return result(out, issues)
        for (const key in input) {
          if (Object.hasOwn(shape, key) || key === '__proto__') continue
          if (unknown === 'strict') issues.push({ message: '多余的字段', path: [key] })
          else if (unknown === 'loose') out[key] = input[key]
          else place(out, issues, key, unknown, input)
        }
        return result(out, issues)
      })
      this.shape = shape
      this.unknown = unknown
    }

    passthrough() { return new ObjectSchema(this.shape, 'loose') }
    loose() { return new ObjectSchema(this.shape, 'loose') }
    strict() { return new ObjectSchema(this.shape, 'strict') }
    strip() { return new ObjectSchema(this.shape, 'strip') }
    catchall(schema) { return new ObjectSchema(this.shape, schema) }
    extend(more) { return new ObjectSchema({ ...this.shape, ...more }, this.unknown) }
    merge(other) { return new ObjectSchema({ ...this.shape, ...other.shape }, other.unknown) }
    pick(keys) { return new ObjectSchema(Object.fromEntries(Object.entries(this.shape).filter(([key]) => keys[key])), this.unknown) }
    omit(keys) { return new ObjectSchema(Object.fromEntries(Object.entries(this.shape).filter(([key]) => !keys[key])), this.unknown) }
    partial() { return new ObjectSchema(Object.fromEntries(Object.entries(this.shape).map(([key, field]) => [key, field.optional()])), this.unknown) }
  }

  function array(element) {
    return new Schema(input => {
      if (!Array.isArray(input)) return bad(input, '要是列表')
      const issues = []
      const value = input.map((item, index) => {
        const got = element.run(item)
        issues.push(...within(index, got.issues))
        return got.value
      })
      return result(value, issues)
    })
  }

  function union(options) {
    const defaulted = options.some(option => option.optin === 'defaulted')
    return new Schema(value => {
      let last = null
      for (const option of options) {
        last = option.run(value)
        if (!last.issues.length) return last
      }
      return options.length === 1 ? last : bad(value, '不符合任何一种写法')
    }, {
      optin: defaulted ? 'defaulted' : options.some(option => option.optin !== undefined) ? 'optional' : undefined,
      optout: options.some(option => option.optout === 'optional') ? 'optional' : undefined,
      values: options.every(option => option.values) ? new Set(options.flatMap(option => [...option.values])) : undefined,
    })
  }

  function record(keys, values, partial = false) {
    // Zod 3's z.record(valueSchema).
    const [keySchema, valueSchema] = values instanceof Schema ? [keys, values] : [string(), keys]
    const known = keySchema.values
    return new Schema(input => {
      if (!isObject(input)) return bad(input, '要是对象')
      const out = {}
      const issues = []
      const put = (key, finalKey) => {
        if (finalKey === '__proto__') return
        const got = valueSchema.run(input[key])
        issues.push(...within(key, got.issues))
        out[finalKey] = got.value
      }
      if (known && !partial) {
        for (const key of known) {
          if ((typeof key === 'string' || typeof key === 'number') && key !== '__proto__') put(String(key), keySchema.run(key).value)
        }
        for (const key in input) if (!known.has(key) && !known.has(Number(key))) issues.push({ message: '多余的字段', path: [key] })
        return result(out, issues)
      }
      for (const key of Object.keys(input)) {
        if (key === '__proto__') continue
        const named = keySchema.run(key)
        if (named.issues.length) issues.push({ message: '字段名不对', path: [key] })
        else put(key, named.value)
      }
      return result(out, issues)
    })
  }

  return {
    string: () => string(),
    number: () => number(),
    boolean: () => boolean(),
    int: () => number().int(),
    any: () => new Schema(value => result(value)),
    unknown: () => new Schema(value => result(value)),
    never: () => new Schema(value => bad(value, '不该有值')),
    null: () => oneOf([null], 'null'),
    undefined: () => new Schema(value => (value === undefined ? result(value) : bad(value, '不该有值')), { values: new Set([undefined]) }),
    literal: value => oneOf(Array.isArray(value) ? value : [value], JSON.stringify(value)),
    enum: values => oneOf(Array.isArray(values) ? values : Object.values(values), '给定的选项之一'),
    object: shape => new ObjectSchema(shape),
    looseObject: shape => new ObjectSchema(shape, 'loose'),
    strictObject: shape => new ObjectSchema(shape, 'strict'),
    array,
    record: (keys, values) => record(keys, values),
    partialRecord: (keys, values) => record(keys, values, true),
    union,
    transform,
    preprocess: (change, schema) => transform(change).pipe(schema),
    coerce: { string: () => string(String), number: () => number(Number), boolean: () => boolean(Boolean) },
    NEVER: Object.freeze({}),
  }
}
