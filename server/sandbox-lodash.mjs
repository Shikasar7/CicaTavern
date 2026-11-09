// The lodash a card's scripts find as `_` in a sandbox (card-scripts.mjs): Tavern Helper preloads lodash into every
// script, and scripts use a few dozen of its functions. createLodash is put into the sandbox as its source text
// (`(${createLodash})()`), so it uses nothing from outside itself. A function not here throws, as a missing one would.
export function createLodash() {
  const isObjectLike = value => value !== null && typeof value === 'object'
  const isPlainObject = value => isObjectLike(value) && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  const BLOCKED = new Set(['__proto__', 'constructor', 'prototype'])
  const toPath = path => {
    if (Array.isArray(path)) return path.map(String)
    const out = []
    String(path ?? '').replace(/[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g, (match, number, quote, sub) => {
      out.push(quote ? sub.replace(/\\(\\)?/g, '$1') : number ?? match)
      return match
    })
    return out.filter(key => key !== '')
  }
  const cloneDeep = value => {
    if (!isObjectLike(value)) return value
    if (Array.isArray(value)) return value.map(cloneDeep)
    if (value instanceof Date) return new Date(value.getTime())
    const out = {}
    for (const key of Object.keys(value)) out[key] = cloneDeep(value[key])
    return out
  }
  const get = (object, path, fallback) => {
    let cursor = object
    for (const key of toPath(path)) {
      if (cursor === null || cursor === undefined) return fallback
      cursor = cursor[key]
    }
    return cursor === undefined ? fallback : cursor
  }
  const has = (object, path) => {
    let cursor = object
    for (const key of toPath(path)) {
      if (!isObjectLike(cursor) || !Object.prototype.hasOwnProperty.call(cursor, key)) return false
      cursor = cursor[key]
    }
    return true
  }
  const set = (object, path, value) => {
    if (!isObjectLike(object)) return object
    const keys = toPath(path)
    if (keys.some(key => BLOCKED.has(key))) return object
    let cursor = object
    keys.forEach((key, i) => {
      if (i === keys.length - 1) cursor[key] = value
      else {
        if (!isObjectLike(cursor[key])) cursor[key] = /^\d+$/.test(keys[i + 1]) ? [] : {}
        cursor = cursor[key]
      }
    })
    return object
  }
  const unset = (object, path) => {
    const keys = toPath(path)
    const parent = keys.length > 1 ? get(object, keys.slice(0, -1)) : object
    if (!isObjectLike(parent)) return true
    if (Array.isArray(parent)) parent.splice(Number(keys.at(-1)), 1)
    else delete parent[keys.at(-1)]
    return true
  }
  const update = (object, path, fn) => set(object, path, fn(get(object, path)))
  const mergeWith = (target, ...sources) => {
    const custom = typeof sources.at(-1) === 'function' ? sources.pop() : null
    const into = (to, from) => {
      for (const key of Object.keys(from ?? {})) {
        if (BLOCKED.has(key)) continue
        const chosen = custom ? custom(to[key], from[key], key, to, from) : undefined
        if (chosen !== undefined) to[key] = chosen
        else if (isPlainObject(from[key]) || Array.isArray(from[key])) {
          if (!isObjectLike(to[key])) to[key] = Array.isArray(from[key]) ? [] : {}
          into(to[key], from[key])
        } else if (from[key] !== undefined || !(key in to)) to[key] = from[key]
      }
      return to
    }
    for (const source of sources) if (isObjectLike(source)) into(target, source)
    return target
  }
  const isEqual = (a, b) => {
    if (a === b) return true
    if (Number.isNaN(a) && Number.isNaN(b)) return true
    if (!isObjectLike(a) || !isObjectLike(b) || Array.isArray(a) !== Array.isArray(b)) return false
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every(key => Object.prototype.hasOwnProperty.call(b, key) && isEqual(a[key], b[key]))
  }
  const iteratee = fn => {
    if (typeof fn === 'function') return fn
    if (fn === undefined || fn === null) return value => value
    if (Array.isArray(fn)) return value => isEqual(get(value, fn[0]), fn[1])
    if (isObjectLike(fn)) return value => Object.keys(fn).every(key => isEqual(get(value, key), fn[key]))
    return value => get(value, fn)
  }
  const list = value => (Array.isArray(value) ? value : isObjectLike(value) ? Object.values(value) : typeof value === 'string' ? [...value] : [])
  const random = (...args) => {
    let [lower = 0, upper, floating = false] = args
    if (typeof upper === 'boolean') [floating, upper] = [upper, undefined]
    if (upper === undefined) [lower, upper] = args.length ? [0, lower] : [0, 1]
    if (lower > upper) [lower, upper] = [upper, lower]
    if (floating || !Number.isInteger(lower) || !Number.isInteger(upper)) return lower + Math.random() * (upper - lower)
    return lower + Math.floor(Math.random() * (upper - lower + 1))
  }
  const shuffle = value => {
    const out = list(value).slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }
  const sortBy = (value, ...fns) => {
    const keys = fns.flat().map(iteratee)
    if (!keys.length) keys.push(item => item)
    return list(value).map((item, index) => ({ item, index })).sort((a, b) => {
      for (const key of keys) {
        const x = key(a.item)
        const y = key(b.item)
        if (x < y) return -1
        if (x > y) return 1
      }
      return a.index - b.index
    }).map(entry => entry.item)
  }
  const orderBy = (value, fns = [], orders = []) => {
    const keys = (Array.isArray(fns) ? fns : [fns]).map(iteratee)
    return list(value).map((item, index) => ({ item, index })).sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const x = keys[i](a.item)
        const y = keys[i](b.item)
        const sign = String(orders[i] ?? 'asc').toLowerCase() === 'desc' ? -1 : 1
        if (x < y) return -sign
        if (x > y) return sign
      }
      return a.index - b.index
    }).map(entry => entry.item)
  }
  const groupBy = (value, fn) => {
    const key = iteratee(fn)
    const out = {}
    for (const item of list(value)) (out[key(item)] ??= []).push(item)
    return out
  }
  const debounced = fn => {
    const wrapped = (...args) => fn(...args)
    wrapped.cancel = () => {}
    wrapped.flush = () => {}
    return wrapped
  }
  const tools = {
    get, set, has, unset, update, toPath, cloneDeep,
    clone: value => (Array.isArray(value) ? value.slice() : isObjectLike(value) ? { ...value } : value),
    merge: (target, ...sources) => mergeWith(target, ...sources),
    mergeWith,
    assign: (target, ...sources) => Object.assign(target, ...sources),
    defaults: (target, ...sources) => {
      for (const source of sources) for (const key of Object.keys(source ?? {})) if (target[key] === undefined) target[key] = source[key]
      return target
    },
    defaultsDeep: (target, ...sources) => {
      const into = (to, from) => {
        for (const key of Object.keys(from ?? {})) {
          if (to[key] === undefined) to[key] = cloneDeep(from[key])
          else if (isPlainObject(to[key]) && isPlainObject(from[key])) into(to[key], from[key])
        }
      }
      for (const source of sources) into(target, source)
      return target
    },
    isEqual, isPlainObject,
    isObject: value => value !== null && (typeof value === 'object' || typeof value === 'function'),
    isObjectLike, isArray: Array.isArray,
    isString: value => typeof value === 'string',
    isNumber: value => typeof value === 'number',
    isFinite: Number.isFinite, isInteger: Number.isInteger, isNaN: value => typeof value === 'number' && Number.isNaN(value),
    isBoolean: value => typeof value === 'boolean',
    isFunction: value => typeof value === 'function',
    isNil: value => value === null || value === undefined,
    isNull: value => value === null,
    isUndefined: value => value === undefined,
    isEmpty: value => value === null || value === undefined || (typeof value === 'string' || Array.isArray(value) ? value.length === 0 : isObjectLike(value) ? Object.keys(value).length === 0 : true),
    keys: value => Object.keys(value ?? {}),
    values: value => Object.values(value ?? {}),
    entries: value => Object.entries(value ?? {}),
    toPairs: value => Object.entries(value ?? {}),
    fromPairs: pairs => Object.fromEntries(pairs ?? []),
    pick: (object, ...paths) => {
      const out = {}
      for (const path of paths.flat()) if (has(object, path)) set(out, path, get(object, path))
      return out
    },
    omit: (object, ...paths) => {
      const out = cloneDeep(object ?? {})
      for (const path of paths.flat()) unset(out, path)
      return out
    },
    pickBy: (object, fn = value => Boolean(value)) => Object.fromEntries(Object.entries(object ?? {}).filter(([key, value]) => fn(value, key))),
    omitBy: (object, fn) => Object.fromEntries(Object.entries(object ?? {}).filter(([key, value]) => !fn(value, key))),
    mapValues: (object, fn) => Object.fromEntries(Object.entries(object ?? {}).map(([key, value]) => [key, iteratee(fn)(value, key)])),
    mapKeys: (object, fn) => Object.fromEntries(Object.entries(object ?? {}).map(([key, value]) => [fn(value, key), value])),
    forEach: (value, fn) => {
      if (Array.isArray(value)) value.forEach(fn)
      else for (const [key, item] of Object.entries(value ?? {})) if (fn(item, key, value) === false) break
      return value
    },
    each: (value, fn) => tools.forEach(value, fn),
    forOwn: (value, fn) => tools.forEach(value, fn),
    map: (value, fn) => (Array.isArray(value) ? value.map(iteratee(fn)) : Object.entries(value ?? {}).map(([key, item]) => iteratee(fn)(item, key, value))),
    filter: (value, fn) => list(value).filter(iteratee(fn)),
    reject: (value, fn) => list(value).filter(item => !iteratee(fn)(item)),
    find: (value, fn) => list(value).find(iteratee(fn)),
    findIndex: (value, fn) => (value ?? []).findIndex(iteratee(fn)),
    findLast: (value, fn) => list(value).slice().reverse().find(iteratee(fn)),
    some: (value, fn) => list(value).some(iteratee(fn)),
    every: (value, fn) => list(value).every(iteratee(fn)),
    includes: (value, item) => (typeof value === 'string' ? value.includes(item) : list(value).includes(item)),
    reduce: (value, fn, start) => list(value).reduce(fn, start),
    size: value => list(value).length,
    first: value => (value ?? [])[0], head: value => (value ?? [])[0], last: value => (value ?? []).at(-1),
    initial: value => (value ?? []).slice(0, -1), tail: value => (value ?? []).slice(1),
    take: (value, n = 1) => (value ?? []).slice(0, n),
    takeRight: (value, n = 1) => (n > 0 ? (value ?? []).slice(-n) : []),
    drop: (value, n = 1) => (value ?? []).slice(n),
    dropRight: (value, n = 1) => (value ?? []).slice(0, Math.max(0, (value ?? []).length - n)),
    chunk: (value, size = 1) => {
      const out = []
      for (let i = 0; i < (value ?? []).length; i += Math.max(1, size)) out.push(value.slice(i, i + Math.max(1, size)))
      return out
    },
    flatten: value => (value ?? []).flat(), flattenDeep: value => (value ?? []).flat(Infinity),
    compact: value => (value ?? []).filter(Boolean),
    concat: (...values) => [].concat(...values),
    uniq: value => [...new Set(value ?? [])],
    uniqBy: (value, fn) => {
      const key = iteratee(fn)
      const seen = new Set()
      return (value ?? []).filter(item => (seen.has(key(item)) ? false : (seen.add(key(item)), true)))
    },
    union: (...values) => [...new Set(values.flat())],
    difference: (value, ...others) => (value ?? []).filter(item => !others.flat().includes(item)),
    intersection: (first, ...others) => (first ?? []).filter(item => others.every(other => (other ?? []).includes(item))),
    without: (value, ...items) => (value ?? []).filter(item => !items.includes(item)),
    pull: (value, ...items) => {
      for (let i = value.length - 1; i >= 0; i--) if (items.includes(value[i])) value.splice(i, 1)
      return value
    },
    remove: (value, fn) => {
      const removed = []
      for (let i = value.length - 1; i >= 0; i--) if (iteratee(fn)(value[i], i, value)) removed.unshift(...value.splice(i, 1))
      return removed
    },
    range: (start, end, step) => {
      if (end === undefined) [start, end] = [0, start]
      step ??= start < end ? 1 : -1
      const out = []
      if (step === 0) return out
      for (let i = start; step > 0 ? i < end : i > end; i += step) out.push(i)
      return out
    },
    times: (n, fn = i => i) => Array.from({ length: Math.max(0, n) }, (_, i) => fn(i)),
    sum: value => (value ?? []).reduce((total, item) => total + (Number(item) || 0), 0),
    sumBy: (value, fn) => (value ?? []).reduce((total, item) => total + (Number(iteratee(fn)(item)) || 0), 0),
    mean: value => ((value ?? []).length ? tools.sum(value) / value.length : NaN),
    max: value => ((value ?? []).length ? Math.max(...value) : undefined),
    min: value => ((value ?? []).length ? Math.min(...value) : undefined),
    maxBy: (value, fn) => (value ?? []).reduce((best, item) => (best === undefined || iteratee(fn)(item) > iteratee(fn)(best) ? item : best), undefined),
    minBy: (value, fn) => (value ?? []).reduce((best, item) => (best === undefined || iteratee(fn)(item) < iteratee(fn)(best) ? item : best), undefined),
    sortBy, orderBy, groupBy,
    keyBy: (value, fn) => Object.fromEntries(list(value).map(item => [iteratee(fn)(item), item])),
    countBy: (value, fn) => {
      const out = {}
      for (const item of list(value)) out[iteratee(fn)(item)] = (out[iteratee(fn)(item)] ?? 0) + 1
      return out
    },
    partition: (value, fn) => [list(value).filter(iteratee(fn)), list(value).filter(item => !iteratee(fn)(item))],
    zip: (...arrays) => Array.from({ length: Math.max(0, ...arrays.map(a => a.length)) }, (_, i) => arrays.map(a => a[i])),
    zipObject: (keys = [], values = []) => Object.fromEntries(keys.map((key, i) => [key, values[i]])),
    invert: object => Object.fromEntries(Object.entries(object ?? {}).map(([key, value]) => [value, key])),
    random, shuffle,
    sample: value => {
      const items = list(value)
      return items.length ? items[Math.floor(Math.random() * items.length)] : undefined
    },
    sampleSize: (value, n = 1) => shuffle(value).slice(0, n),
    clamp: (n, lower, upper) => (upper === undefined ? Math.min(n, lower) : Math.min(Math.max(n, lower), upper)),
    inRange: (n, start, end) => {
      if (end === undefined) [start, end] = [0, start]
      return n >= Math.min(start, end) && n < Math.max(start, end)
    },
    round: (n, precision = 0) => Math.round(n * 10 ** precision) / 10 ** precision,
    floor: (n, precision = 0) => Math.floor(n * 10 ** precision) / 10 ** precision,
    ceil: (n, precision = 0) => Math.ceil(n * 10 ** precision) / 10 ** precision,
    toNumber: Number, toString: value => (value === null || value === undefined ? '' : String(value)),
    toInteger: value => Math.trunc(Number(value) || 0),
    toArray: list,
    trim: (value, chars) => (chars ? String(value ?? '').replace(new RegExp(`^[${chars}]+|[${chars}]+$`, 'g'), '') : String(value ?? '').trim()),
    startsWith: (value, prefix) => String(value ?? '').startsWith(prefix),
    endsWith: (value, suffix) => String(value ?? '').endsWith(suffix),
    padStart: (value, length, chars = ' ') => String(value ?? '').padStart(length, chars),
    padEnd: (value, length, chars = ' ') => String(value ?? '').padEnd(length, chars),
    repeat: (value, n) => String(value ?? '').repeat(n),
    split: (value, separator, limit) => String(value ?? '').split(separator, limit),
    capitalize: value => String(value ?? '').charAt(0).toUpperCase() + String(value ?? '').slice(1).toLowerCase(),
    escapeRegExp: value => String(value ?? '').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'),
    identity: value => value, noop: () => {},
    constant: value => () => value,
    debounce: debounced, throttle: debounced,
    once: fn => {
      let done = false
      let result
      return (...args) => (done ? result : ((done = true), (result = fn(...args))))
    },
    memoize: fn => {
      const cache = new Map()
      return key => (cache.has(key) ? cache.get(key) : (cache.set(key, fn(key)), cache.get(key)))
    },
    uniqueId: (() => {
      let n = 0
      return (prefix = '') => `${prefix}${++n}`
    })(),
    now: () => Date.now(),
  }
  const chain = value => {
    const wrapper = new Proxy({}, {
      get: (_target, name) => {
        if (name === 'value' || name === 'valueOf') return () => value
        if (typeof tools[name] !== 'function') return undefined
        return (...args) => chain(tools[name](value, ...args))
      },
    })
    return wrapper
  }
  const lodash = value => chain(value)
  return Object.assign(lodash, tools, { chain })
}
