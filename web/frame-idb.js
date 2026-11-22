// IndexedDB for cards' frames. A card's page runs in a sandboxed frame with no origin of its own (render.js htmlFrame),
// where the browser refuses IndexedDB ("access to the Indexed Database API is denied in this context"). Cards made for
// SillyTavern keep their saves there, often through a library such as Dexie. `frameIdb` runs in the frame: an IndexedDB
// of its own, in memory, loaded from the page when a database is opened and saved to it as each transaction commits.
// The page keeps every card's databases in the app's own IndexedDB (`frameData`), each card apart from the others, as
// its frames' localStorage is (compat.js storedFrameStorage).

/** Whether a frame's page may use IndexedDB: only those get the stand-in (it is long, and most cards never need it). */
export const USES_INDEXED_DB = /indexeddb|IDBKeyRange|dexie|localforage|idb-keyval/i

/* Runs inside the frame. Self-contained: it is serialised with toString(). `call(op, args)` asks the page (compat.js). */
export function frameIdb({ call, frame }) {
  if (typeof window === 'undefined' || window.origin !== 'null') return
  const fail = (name, message) => new DOMException(message, name)
  const warn = error => console.warn('[酒馆] 卡的存档没能交给酒馆保存，只留在这个界面里：', error) // i18n-ignore: for the card's scripts, inside its frame

  // ── A task after this one, in order (nested timers wait at least 4 ms) ──
  const tasks = []
  let later
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      const job = tasks.shift()
      if (job) job()
    }
    later = job => {
      tasks.push(job)
      channel.port2.postMessage(null)
    }
  } else later = job => setTimeout(job, 0)

  // ── Copies, as IndexedDB keeps them (an old WebView has no structuredClone) ──
  const copy = (value, seen = new Map()) => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol') throw fail('DataCloneError', 'The object could not be cloned.')
      return value
    }
    if (seen.has(value)) return seen.get(value)
    if (value instanceof Date) return new Date(value.getTime())
    if (value instanceof RegExp) return new RegExp(value.source, value.flags)
    if (value instanceof ArrayBuffer) return value.slice(0)
    if (ArrayBuffer.isView(value)) return new value.constructor(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    if (typeof Blob === 'function' && value instanceof Blob) return value
    let out
    if (Array.isArray(value)) out = []
    else if (value instanceof Map) out = new Map()
    else if (value instanceof Set) out = new Set()
    else out = {}
    seen.set(value, out)
    if (value instanceof Map) for (const [k, v] of value) out.set(copy(k, seen), copy(v, seen))
    else if (value instanceof Set) for (const v of value) out.add(copy(v, seen))
    else for (const key of Object.keys(value)) out[key] = copy(value[key], seen)
    return out
  }
  const clone = typeof structuredClone === 'function' ? value => structuredClone(value) : value => copy(value)

  // ── Keys: numbers < dates < strings < binary < arrays ──
  const kind = key => {
    if (typeof key === 'number') return 1
    if (key instanceof Date) return 2
    if (typeof key === 'string') return 3
    if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) return 4
    if (Array.isArray(key)) return 5
    return 0
  }
  const validKey = (key, seen = []) => {
    const type = kind(key)
    if (type === 1) return !Number.isNaN(key)
    if (type === 2) return !Number.isNaN(key.getTime())
    if (type === 3 || type === 4) return true
    if (type !== 5 || seen.includes(key)) return false
    seen.push(key)
    for (let i = 0; i < key.length; i++) if (!(i in key) || !validKey(key[i], seen)) return false
    seen.pop()
    return true
  }
  const bytes = key => (key instanceof ArrayBuffer ? new Uint8Array(key) : new Uint8Array(key.buffer, key.byteOffset, key.byteLength))
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  const cmp = (a, b) => {
    const ta = kind(a)
    const tb = kind(b)
    if (ta !== tb) return order(ta, tb)
    if (ta === 1 || ta === 3) return order(a, b)
    if (ta === 2) return order(a.getTime(), b.getTime())
    if (ta === 4) {
      const x = bytes(a)
      const y = bytes(b)
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return order(x[i], y[i])
      return order(x.length, y.length)
    }
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = cmp(a[i], b[i])
      if (c) return c
    }
    return order(a.length, b.length)
  }
  const badKey = () => fail('DataError', 'The parameter is not a valid key.')
  const toRange = (query, needed) => {
    if (query === undefined || query === null) {
      if (needed) throw fail('DataError', 'No key or key range specified.')
      return null
    }
    if (typeof query === 'object' && 'lowerOpen' in query && 'upperOpen' in query) {
      return { lower: query.lower, upper: query.upper, lowerOpen: Boolean(query.lowerOpen), upperOpen: Boolean(query.upperOpen) }
    }
    if (!validKey(query)) throw badKey()
    return { lower: query, upper: query, lowerOpen: false, upperOpen: false }
  }

  // ── Key paths ──
  const validPath = path => {
    if (Array.isArray(path)) return path.length > 0 && path.every(part => typeof part === 'string' && validPath(part))
    return typeof path === 'string' && (path === '' || path.split('.').every(part => /^[$A-Z_a-z][$\w]*$/.test(part)))
  }
  const extract = (value, path) => {
    if (Array.isArray(path)) {
      const out = []
      for (const part of path) {
        const key = extract(value, part)
        if (key === undefined) return undefined
        out.push(key)
      }
      return out
    }
    if (path === '') return value
    let at = value
    for (const part of path.split('.')) {
      if (typeof at === 'string' && part === 'length') at = at.length
      else if (at === null || typeof at !== 'object' || !(part in at)) return undefined
      else at = at[part]
    }
    return at
  }
  const canInject = (value, path) => {
    let at = value
    for (const part of path.split('.').slice(0, -1)) {
      if (at === null || typeof at !== 'object') return false
      if (!(part in at)) return true
      at = at[part]
    }
    return at !== null && typeof at === 'object'
  }
  const inject = (value, path, key) => {
    const parts = path.split('.')
    let at = value
    for (const part of parts.slice(0, -1)) {
      if (!(part in at)) at[part] = {}
      at = at[part]
    }
    at[parts[parts.length - 1]] = key
  }

  // ── What a frame holds: each database by name ──
  // { name, version, stores: Map(name → store), rev, conns: Set, busy }; a store is
  // { name, keyPath, autoIncrement, current, indexes: Map, records: [{ key, primaryKey, value }] in key order, stamp, views }.
  const dbs = new Map()
  const makeStore = meta => ({
    name: meta.name,
    keyPath: meta.keyPath === undefined ? null : meta.keyPath,
    autoIncrement: Boolean(meta.autoIncrement),
    current: meta.current || 1,
    indexes: new Map((meta.indexes || []).map(index => [index.name, { ...index }])),
    records: [],
    stamp: 0,
    views: new Map(),
  })
  const metaOf = data => ({
    version: data.version,
    stores: [...data.stores.values()].map(store => ({
      name: store.name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      current: store.current,
      indexes: [...store.indexes.values()].map(index => ({ name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry })),
    })),
  })
  const sortRecords = store => store.records.sort((a, b) => cmp(a.key, b.key))
  // The first row at or past (key, primaryKey), past it when `after`; without a primary key, keys alone count.
  const seek = (rows, key, primaryKey, after) => {
    let lo = 0
    let hi = rows.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const c = cmp(rows[mid].key, key) || (primaryKey === undefined ? 0 : cmp(rows[mid].primaryKey, primaryKey))
      if (c < 0 || (after && c === 0)) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  // [start, end) of the rows in the range.
  const span = (rows, range) => [
    range && range.lower !== undefined ? seek(rows, range.lower, undefined, range.lowerOpen) : 0,
    range && range.upper !== undefined ? seek(rows, range.upper, undefined, !range.upperOpen) : rows.length,
  ]
  const indexKeys = (index, value) => {
    const key = extract(value, index.keyPath)
    if (index.multiEntry && Array.isArray(key)) {
      const out = []
      for (const one of key) if (validKey(one) && !out.some(k => cmp(k, one) === 0)) out.push(one)
      return out
    }
    return key !== undefined && validKey(key) ? [key] : []
  }
  // An index's rows, in (key, primaryKey) order, made again after the store changes.
  const rowsOf = (store, index) => {
    if (!index) return store.records
    let view = store.views.get(index.name)
    if (!view || view.stamp !== store.stamp) {
      const rows = []
      for (const record of store.records) for (const key of indexKeys(index, record.value)) rows.push({ key, primaryKey: record.key, value: record.value })
      rows.sort((a, b) => cmp(a.key, b.key) || cmp(a.primaryKey, b.primaryKey))
      view = { stamp: store.stamp, rows }
      store.views.set(index.name, view)
    }
    return view.rows
  }
  const putRecord = (store, key, value) => {
    const at = seek(store.records, key, undefined, false)
    const record = { key, primaryKey: key, value }
    if (at < store.records.length && cmp(store.records[at].key, key) === 0) store.records[at] = record
    else store.records.splice(at, 0, record)
    store.stamp++
  }
  const dropRecord = (store, key) => {
    const at = seek(store.records, key, undefined, false)
    if (at < store.records.length && cmp(store.records[at].key, key) === 0) store.records.splice(at, 1)
    store.stamp++
  }
  // Another frame of this card saved (the page passes it on): its schema, then its changes in order.
  const applyChanges = (data, meta, ops) => {
    const stores = new Map()
    for (const one of meta.stores) {
      const store = data.stores.get(one.name) || makeStore(one)
      store.keyPath = one.keyPath === undefined ? null : one.keyPath
      store.autoIncrement = Boolean(one.autoIncrement)
      store.current = one.current || 1
      store.indexes = new Map((one.indexes || []).map(index => [index.name, { ...index }]))
      store.stamp++
      stores.set(one.name, store)
    }
    data.version = meta.version
    data.stores = stores
    for (const op of ops) {
      const store = stores.get(op[1])
      if (!store) continue
      if (op[0] === 'put') putRecord(store, op[2], op[3])
      else if (op[0] === 'delete') dropRecord(store, op[2])
      else if (op[0] === 'clear') {
        store.records = []
        store.stamp++
      }
    }
  }
  const fill = (data, saved) => {
    data.version = saved ? saved.version : 0
    data.stores = new Map()
    for (const meta of saved ? saved.stores : []) data.stores.set(meta.name, makeStore(meta))
    for (const [name, key, value] of saved ? saved.rows : []) {
      const store = data.stores.get(name)
      if (store) store.records.push({ key, primaryKey: key, value })
    }
    for (const store of data.stores.values()) sortRecords(store)
  }
  let revs = 0
  const newRev = () => `${frame}:${Math.random().toString(36).slice(2, 8)}:${++revs}`
  // The database as the page keeps it, unless this frame has it already as it is (or is in the middle of using it).
  const hydrate = name => {
    let data = dbs.get(name)
    if (!data) {
      data = { name, version: 0, stores: new Map(), rev: null, conns: new Set(), busy: 0, local: false }
      dbs.set(name, data)
    }
    if (data.busy || data.local) return Promise.resolve(data)
    return call('idb', { op: 'load', name, rev: data.rev }).then(
      answer => {
        if (answer && !answer.same && !data.busy) {
          fill(data, answer.db)
          data.rev = answer.rev
        }
        return data
      },
      error => {
        warn(error)
        data.local = true
        return data
      },
    )
  }
  const save = (data, ops, always) => {
    if (data.local || (!ops.length && !always)) return
    data.rev = newRev()
    call('idb', { op: 'commit', name: data.name, rev: data.rev, meta: metaOf(data), ops }).catch(warn)
  }

  // ── Events ──
  const makeEvent = (type, { bubbles = false, cancelable = false, versions = null } = {}) => {
    let event
    if (versions && typeof IDBVersionChangeEvent === 'function') event = new IDBVersionChangeEvent(type, versions)
    else {
      event = new Event(type, { bubbles, cancelable })
      if (versions) {
        Object.defineProperty(event, 'oldVersion', { value: versions.oldVersion })
        Object.defineProperty(event, 'newVersion', { value: versions.newVersion })
      }
    }
    let stopped = false
    let stoppedNow = false
    Object.defineProperty(event, 'stopPropagation', {
      value() {
        stopped = true
        Event.prototype.stopPropagation.call(this)
      },
    })
    Object.defineProperty(event, 'stopImmediatePropagation', {
      value() {
        stopped = true
        stoppedNow = true
        Event.prototype.stopImmediatePropagation.call(this)
      },
    })
    Object.defineProperty(event, 'propagationStopped', { get: () => stopped })
    Object.defineProperty(event, 'immediateStopped', { get: () => stoppedNow })
    return event
  }
  const report = error => {
    if (typeof reportError === 'function') reportError(error)
    else setTimeout(() => { throw error })
  }
  // To one target's handler and listeners; true when one of them threw.
  const deliver = (target, event, origin) => {
    Object.defineProperty(event, 'target', { value: origin, configurable: true })
    Object.defineProperty(event, 'srcElement', { value: origin, configurable: true })
    Object.defineProperty(event, 'currentTarget', { value: target, configurable: true })
    const handler = target[`on${event.type}`]
    const listeners = (target.listeners.get(event.type) || []).slice()
    const all = [...(typeof handler === 'function' ? [{ fn: handler }] : []), ...listeners]
    let threw = false
    for (const one of all) {
      if (event.immediateStopped) break
      if (one.once) target.removeEventListener(event.type, one.fn)
      try {
        if (typeof one.fn === 'function') one.fn.call(target, event)
        else if (one.fn && typeof one.fn.handleEvent === 'function') one.fn.handleEvent(event)
      } catch (error) {
        threw = true
        report(error)
      }
    }
    return threw
  }
  // A request's events go on to its transaction and its database when they bubble.
  const dispatch = (target, event, path = []) => {
    let threw = false
    for (const at of [target, ...(event.bubbles ? path : [])]) {
      threw = deliver(at, event, target) || threw
      if (event.propagationStopped) break
    }
    return threw
  }
  class Target {
    constructor() {
      Object.defineProperty(this, 'listeners', { value: new Map() })
    }
    addEventListener(type, fn, options) {
      if (!fn) return
      const list = this.listeners.get(type) || []
      if (!list.some(one => one.fn === fn)) list.push({ fn, once: Boolean(options && typeof options === 'object' && options.once) })
      this.listeners.set(type, list)
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type)
      if (list) this.listeners.set(type, list.filter(one => one.fn !== fn))
    }
    dispatchEvent(event) {
      deliver(this, event, this)
      return !event.defaultPrevented
    }
  }
  const names = list => {
    const out = list.slice()
    Object.defineProperty(out, 'item', { value: i => (out[i] === undefined ? null : out[i]) })
    Object.defineProperty(out, 'contains', { value: name => out.includes(name) })
    return out
  }

  // ── Requests ──
  class Request extends Target {
    constructor(source, transaction) {
      super()
      this.source = source
      this.transaction = transaction
      this.readyState = 'pending'
      this.onsuccess = null
      this.onerror = null
      Object.defineProperty(this, 'answer', { value: { result: undefined, error: null }, writable: true })
    }
    get result() {
      return this.answer.result
    }
    get error() {
      return this.answer.error
    }
  }
  class OpenRequest extends Request {
    constructor() {
      super(null, null)
      this.onupgradeneeded = null
      this.onblocked = null
    }
  }
  const settle = (request, error, result, versions) => {
    request.readyState = 'done'
    request.answer = { result: error ? undefined : result, error: error || null }
    if (error) dispatch(request, makeEvent('error', { bubbles: true, cancelable: true }))
    else dispatch(request, versions ? makeEvent('success', { versions }) : makeEvent('success'))
  }

  // ── Transactions ──
  const snapshot = data => ({
    version: data.version,
    stores: new Map(data.stores),
    shapes: [...data.stores.values()].map(store => [store, store.indexes, store.keyPath, store.autoIncrement]),
  })
  class Transaction extends Target {
    constructor(conn, scope, mode, onDone, schema) {
      super()
      this.db = conn
      this.mode = mode
      this.error = null
      this.durability = 'default'
      this.onabort = null
      this.oncomplete = null
      this.onerror = null
      Object.defineProperty(this, 'state', {
        value: { data: conn.data, scope, queue: [], done: false, idle: false, scheduled: false, commit: false, ops: [], saved: new Map(), handles: new Map(), onDone, schema },
      })
      conn.data.busy++
      this.kick()
    }
    get objectStoreNames() {
      const state = this.state
      return names(this.mode === 'versionchange' ? [...state.data.stores.keys()].sort() : state.scope.slice().sort())
    }
    objectStore(name) {
      const state = this.state
      if (state.done) throw fail('InvalidStateError', 'The transaction has finished.')
      const store = state.data.stores.get(name)
      if (!store || (this.mode !== 'versionchange' && !state.scope.includes(name))) throw fail('NotFoundError', 'The specified object store was not found.')
      let handle = state.handles.get(name)
      if (!handle || handle.store !== store) {
        handle = new ObjectStore(this, store)
        state.handles.set(name, handle)
      }
      return handle
    }
    abort() {
      if (this.state.done) throw fail('InvalidStateError', 'The transaction has finished.')
      this.end(null)
    }
    commit() {
      if (this.state.done) throw fail('InvalidStateError', 'The transaction has finished.')
      this.state.commit = true
    }
    request(source, run, request) {
      const state = this.state
      if (state.done) throw fail('TransactionInactiveError', 'The transaction has finished.')
      const req = request || new Request(source, this)
      req.readyState = 'pending'
      state.queue.push({ req, run })
      state.idle = false
      this.kick()
      return req
    }
    // Before a store first changes: as it was, for an abort.
    keep(store) {
      const saved = this.state.saved
      if (!saved.has(store)) saved.set(store, { records: store.records.slice(), current: store.current })
    }
    kick() {
      const state = this.state
      if (state.scheduled) return
      state.scheduled = true
      later(() => {
        state.scheduled = false
        this.step()
      })
    }
    // One request a task, so the promises its handlers settled run before the next; done a task after the last.
    step() {
      const state = this.state
      if (state.done) return
      const item = state.queue.shift()
      if (!item) {
        if (state.idle || state.commit) this.finish()
        else {
          state.idle = true
          this.kick()
        }
        return
      }
      const { req, run } = item
      let result
      let error = null
      try {
        result = run()
      } catch (thrown) {
        error = thrown
      }
      req.readyState = 'done'
      req.answer = { result: error ? undefined : result, error }
      if (error) {
        const event = makeEvent('error', { bubbles: true, cancelable: true })
        const threw = dispatch(req, event, [this, this.db])
        if (threw || !event.defaultPrevented) this.end(threw ? fail('AbortError', 'An event handler threw.') : error)
      } else if (dispatch(req, makeEvent('success'))) this.end(fail('AbortError', 'An event handler threw.'))
      if (!state.done) this.kick()
    }
    finish() {
      const state = this.state
      state.done = true
      state.data.busy--
      if (this.mode !== 'readonly') save(state.data, state.ops, this.mode === 'versionchange')
      dispatch(this, makeEvent('complete'))
      if (state.onDone) state.onDone(true)
    }
    end(error) {
      const state = this.state
      if (state.done) return
      state.done = true
      this.error = error
      for (const [store, saved] of state.saved) {
        store.records = saved.records
        store.current = saved.current
        store.stamp++
      }
      if (state.schema) {
        state.data.version = state.schema.version
        state.data.stores = state.schema.stores
        for (const [store, indexes, keyPath, autoIncrement] of state.schema.shapes) Object.assign(store, { indexes, keyPath, autoIncrement, stamp: store.stamp + 1 })
      }
      state.data.busy--
      for (const { req } of state.queue.splice(0)) {
        req.readyState = 'done'
        req.answer = { result: undefined, error: fail('AbortError', 'The transaction was aborted.') }
        dispatch(req, makeEvent('error', { bubbles: true, cancelable: true }), [this, this.db])
      }
      dispatch(this, makeEvent('abort', { bubbles: true }), [this.db])
      if (state.onDone) state.onDone(false)
    }
  }

  // ── Object stores and indexes ──
  const writable = tx => {
    if (tx.state.done) throw fail('TransactionInactiveError', 'The transaction has finished.')
    if (tx.mode === 'readonly') throw fail('ReadOnlyError', 'The transaction is read-only.')
  }
  const readable = tx => {
    if (tx.state.done) throw fail('TransactionInactiveError', 'The transaction has finished.')
  }
  const take = (rows, range, count, pick) => {
    const [start, end] = span(rows, range)
    const last = count > 0 ? Math.min(end, start + count) : end
    const out = []
    for (let i = start; i < last; i++) out.push(pick(rows[i]))
    return out
  }
  const countOf = count => {
    if (count === undefined) return 0
    const n = Math.floor(Number(count))
    if (!(n >= 0)) throw new TypeError('The count is not a valid number.')
    return n
  }
  class Source {
    constructor(transaction, store, index) {
      Object.defineProperty(this, 'tx', { value: transaction })
      Object.defineProperty(this, 'store', { value: store })
      Object.defineProperty(this, 'indexed', { value: index || null })
    }
    rows() {
      return rowsOf(this.store, this.indexed)
    }
    get(query) {
      readable(this.tx)
      const range = toRange(query, true)
      return this.tx.request(this, () => {
        const rows = this.rows()
        const [start, end] = span(rows, range)
        return start < end ? clone(rows[start].value) : undefined
      })
    }
    getKey(query) {
      readable(this.tx)
      const range = toRange(query, true)
      return this.tx.request(this, () => {
        const rows = this.rows()
        const [start, end] = span(rows, range)
        return start < end ? clone(rows[start].primaryKey) : undefined
      })
    }
    getAll(query, count) {
      readable(this.tx)
      const range = toRange(query, false)
      const n = countOf(count)
      return this.tx.request(this, () => take(this.rows(), range, n, row => clone(row.value)))
    }
    getAllKeys(query, count) {
      readable(this.tx)
      const range = toRange(query, false)
      const n = countOf(count)
      return this.tx.request(this, () => take(this.rows(), range, n, row => clone(row.primaryKey)))
    }
    count(query) {
      readable(this.tx)
      const range = toRange(query, false)
      return this.tx.request(this, () => {
        const [start, end] = span(this.rows(), range)
        return end - start
      })
    }
    openCursor(query, direction) {
      return this.cursor(query, direction, true)
    }
    openKeyCursor(query, direction) {
      return this.cursor(query, direction, false)
    }
    cursor(query, direction = 'next', withValue) {
      readable(this.tx)
      const range = toRange(query, false)
      if (!['next', 'nextunique', 'prev', 'prevunique'].includes(direction)) throw new TypeError(`The provided value '${direction}' is not a valid enum value of type IDBCursorDirection.`)
      const req = new Request(this, this.tx)
      const cursor = withValue ? new CursorWithValue(this, range, direction, req) : new Cursor(this, range, direction, req)
      return this.tx.request(this, () => cursor.move(), req)
    }
  }
  class ObjectStore extends Source {
    get name() {
      return this.store.name
    }
    get keyPath() {
      return Array.isArray(this.store.keyPath) ? this.store.keyPath.slice() : this.store.keyPath
    }
    get autoIncrement() {
      return this.store.autoIncrement
    }
    get indexNames() {
      return names([...this.store.indexes.keys()].sort())
    }
    get transaction() {
      return this.tx
    }
    put(value, key) {
      return this.write(value, key, false)
    }
    add(value, key) {
      return this.write(value, key, true)
    }
    write(value, key, adding, sameKey) {
      writable(this.tx)
      const store = this.store
      if (store.keyPath !== null && key !== undefined) throw fail('DataError', 'The object store uses in-line keys and the key parameter was provided.')
      if (store.keyPath === null && !store.autoIncrement && key === undefined) throw fail('DataError', 'The object store uses out-of-line keys and has no key generator and the key parameter was not provided.')
      if (key !== undefined && !validKey(key)) throw badKey()
      const kept = clone(value)
      let generate = false
      if (store.keyPath !== null) {
        const own = extract(kept, store.keyPath)
        if (own !== undefined) {
          if (!validKey(own)) throw fail('DataError', 'Evaluating the object store\'s key path yielded a value that is not a valid key.')
          key = own
        } else if (!store.autoIncrement) throw fail('DataError', 'Evaluating the object store\'s key path did not yield a value.')
        else if (!canInject(kept, store.keyPath)) throw fail('DataError', 'A generated key could not be inserted into the value.')
        else generate = true
      } else if (key === undefined) generate = true
      if (sameKey !== undefined && (key === undefined || cmp(key, sameKey) !== 0)) throw fail('DataError', 'The effective object store of this cursor uses in-line keys and evaluating the key path of the value parameter results in a different value than the cursor\'s effective key.')
      const tx = this.tx
      return tx.request(this, () => {
        let own = key
        if (generate) {
          if (store.current > Number.MAX_SAFE_INTEGER) throw fail('ConstraintError', 'The key generator has reached its maximum.')
          own = store.current
          if (store.keyPath !== null) inject(kept, store.keyPath, own)
        } else own = clone(own)
        const at = seek(store.records, own, undefined, false)
        const exists = at < store.records.length && cmp(store.records[at].key, own) === 0
        if (exists && adding) throw fail('ConstraintError', 'Key already exists in the object store.')
        for (const index of store.indexes.values()) {
          if (!index.unique) continue
          for (const indexKey of indexKeys(index, kept)) {
            const rows = rowsOf(store, index)
            const i = seek(rows, indexKey, undefined, false)
            for (let j = i; j < rows.length && cmp(rows[j].key, indexKey) === 0; j++) {
              if (cmp(rows[j].primaryKey, own) !== 0) throw fail('ConstraintError', 'Unable to add key to index: at least one key does not satisfy the uniqueness requirements.')
            }
          }
        }
        tx.keep(store)
        if (store.autoIncrement && typeof own === 'number' && own >= store.current) store.current = Math.floor(own) + 1
        putRecord(store, own, kept)
        tx.state.ops.push(['put', store.name, own, kept])
        return clone(own)
      })
    }
    delete(query) {
      writable(this.tx)
      const range = toRange(query, true)
      const tx = this.tx
      const store = this.store
      return tx.request(this, () => {
        const [start, end] = span(store.records, range)
        if (start >= end) return undefined
        tx.keep(store)
        for (const record of store.records.splice(start, end - start)) tx.state.ops.push(['delete', store.name, record.key])
        store.stamp++
        return undefined
      })
    }
    clear() {
      writable(this.tx)
      const tx = this.tx
      const store = this.store
      return tx.request(this, () => {
        tx.keep(store)
        store.records = []
        store.stamp++
        tx.state.ops.push(['clear', store.name])
        return undefined
      })
    }
    index(name) {
      readable(this.tx)
      const index = this.store.indexes.get(name)
      if (!index) throw fail('NotFoundError', 'The specified index was not found.')
      return new Index(this.tx, this.store, index, this)
    }
    createIndex(name, keyPath, options = {}) {
      const tx = this.tx
      if (tx.mode !== 'versionchange' || tx.state.done) throw fail('InvalidStateError', 'The database is not running a version change transaction.')
      name = String(name)
      if (!validPath(keyPath)) throw fail('SyntaxError', 'The keyPath argument contains an invalid key path.')
      if (this.store.indexes.has(name)) throw fail('ConstraintError', `An index with the specified name already exists.`)
      const multiEntry = Boolean(options && options.multiEntry)
      if (multiEntry && Array.isArray(keyPath)) throw fail('InvalidAccessError', 'The keyPath argument was an array and the multiEntry option is true.')
      const index = { name, keyPath: Array.isArray(keyPath) ? keyPath.slice() : keyPath, unique: Boolean(options && options.unique), multiEntry }
      this.store.indexes = new Map(this.store.indexes).set(name, index)
      this.store.stamp++
      if (index.unique) {
        const rows = rowsOf(this.store, index)
        for (let i = 1; i < rows.length; i++) {
          if (cmp(rows[i - 1].key, rows[i].key) === 0) {
            later(() => tx.end(fail('ConstraintError', 'Unable to add key to index: at least one key does not satisfy the uniqueness requirements.')))
            break
          }
        }
      }
      return new Index(tx, this.store, index, this)
    }
    deleteIndex(name) {
      const tx = this.tx
      if (tx.mode !== 'versionchange' || tx.state.done) throw fail('InvalidStateError', 'The database is not running a version change transaction.')
      if (!this.store.indexes.has(name)) throw fail('NotFoundError', 'The specified index was not found.')
      const indexes = new Map(this.store.indexes)
      indexes.delete(name)
      this.store.indexes = indexes
      this.store.stamp++
    }
  }
  class Index extends Source {
    constructor(transaction, store, index, objectStore) {
      super(transaction, store, index)
      Object.defineProperty(this, 'owner', { value: objectStore })
    }
    get name() {
      return this.indexed.name
    }
    get keyPath() {
      return Array.isArray(this.indexed.keyPath) ? this.indexed.keyPath.slice() : this.indexed.keyPath
    }
    get unique() {
      return this.indexed.unique
    }
    get multiEntry() {
      return this.indexed.multiEntry
    }
    get objectStore() {
      return this.owner
    }
  }

  // ── Cursors ──
  class Cursor {
    constructor(source, range, direction, request) {
      Object.defineProperty(this, 'state', {
        value: { source, range, direction, request, key: undefined, primaryKey: undefined, value: undefined, started: false, got: false },
      })
    }
    get source() {
      return this.state.source
    }
    get direction() {
      return this.state.direction
    }
    get request() {
      return this.state.request
    }
    get key() {
      return this.state.key
    }
    get primaryKey() {
      return this.state.primaryKey
    }
    // The next row's place, or -1 past the end.
    find(target, targetPrimaryKey) {
      const state = this.state
      const rows = state.source.rows()
      const [start, end] = span(rows, state.range)
      const byKey = state.direction.endsWith('unique') || !state.source.indexed
      if (state.direction.startsWith('next')) {
        let i = start
        if (state.started) i = Math.max(i, seek(rows, state.key, byKey ? undefined : state.primaryKey, true))
        if (target !== undefined) i = Math.max(i, seek(rows, target, targetPrimaryKey, false))
        return i < end ? i : -1
      }
      let i = end - 1
      if (state.started) i = Math.min(i, seek(rows, state.key, byKey ? undefined : state.primaryKey, false) - 1)
      if (target !== undefined) i = Math.min(i, seek(rows, target, targetPrimaryKey, true) - 1)
      if (i < start) return -1
      if (state.direction === 'prevunique') i = Math.max(start, seek(rows, rows[i].key, undefined, false))
      return i
    }
    move(target, targetPrimaryKey, count = 1) {
      const state = this.state
      for (let n = 0; n < count; n++) {
        const i = this.find(n ? undefined : target, n ? undefined : targetPrimaryKey)
        if (i < 0) {
          state.key = state.primaryKey = state.value = undefined
          state.got = false
          return null
        }
        const row = state.source.rows()[i]
        state.key = clone(row.key)
        state.primaryKey = clone(row.primaryKey)
        state.value = this instanceof CursorWithValue ? clone(row.value) : undefined
        state.started = true
      }
      state.got = true
      return this
    }
    ready() {
      const state = this.state
      if (state.source.tx.state.done) throw fail('TransactionInactiveError', 'The transaction has finished.')
      if (!state.got) throw fail('InvalidStateError', 'The cursor is being iterated or has iterated past its end.')
    }
    again(run) {
      const state = this.state
      state.got = false
      state.source.tx.request(state.source, run, state.request)
    }
    continue(key) {
      this.ready()
      const state = this.state
      if (key !== undefined) {
        if (!validKey(key)) throw badKey()
        const c = cmp(key, state.key)
        if (state.direction.startsWith('next') ? c <= 0 : c >= 0) throw fail('DataError', 'The parameter is less than or equal to this cursor\'s position.')
      }
      this.again(() => this.move(key === undefined ? undefined : clone(key)))
    }
    advance(count) {
      const n = Math.floor(Number(count))
      if (!(n > 0)) throw new TypeError('A count argument with value 0 (zero) was supplied, must be greater than 0.')
      this.ready()
      this.again(() => this.move(undefined, undefined, n))
    }
    continuePrimaryKey(key, primaryKey) {
      this.ready()
      const state = this.state
      if (!state.source.indexed || state.direction.endsWith('unique')) throw fail('InvalidAccessError', 'The cursor\'s source is not an index or its direction is not \'next\' or \'prev\'.')
      if (!validKey(key) || !validKey(primaryKey)) throw badKey()
      const c = cmp(key, state.key) || cmp(primaryKey, state.primaryKey)
      if (state.direction === 'next' ? c <= 0 : c >= 0) throw fail('DataError', 'The parameter is not past this cursor\'s position.')
      this.again(() => this.move(clone(key), clone(primaryKey)))
    }
    update(value) {
      this.ready()
      const state = this.state
      if (!(this instanceof CursorWithValue)) throw fail('InvalidStateError', 'The cursor is a key cursor.')
      const store = state.source.indexed ? state.source.owner : state.source
      writable(store.tx)
      return store.store.keyPath === null ? store.write(value, state.primaryKey, false) : store.write(value, undefined, false, state.primaryKey)
    }
    delete() {
      this.ready()
      const state = this.state
      if (!(this instanceof CursorWithValue)) throw fail('InvalidStateError', 'The cursor is a key cursor.')
      const store = state.source.indexed ? state.source.owner : state.source
      return store.delete(state.primaryKey)
    }
  }
  class CursorWithValue extends Cursor {
    get value() {
      return this.state.value
    }
  }

  // ── Connections ──
  class Database extends Target {
    constructor(data, version) {
      super()
      this.onabort = null
      this.onclose = null
      this.onerror = null
      this.onversionchange = null
      Object.defineProperty(this, 'data', { value: data })
      Object.defineProperty(this, 'own', { value: { version, closed: false, upgrade: null } })
    }
    get name() {
      return this.data.name
    }
    get version() {
      return this.own.version
    }
    get objectStoreNames() {
      return names([...this.data.stores.keys()].sort())
    }
    upgrading() {
      const tx = this.own.upgrade
      if (!tx || tx.state.done) throw fail('InvalidStateError', 'The database is not running a version change transaction.')
      return tx
    }
    createObjectStore(name, options) {
      const tx = this.upgrading()
      name = String(name)
      const keyPath = options && options.keyPath !== undefined ? options.keyPath : null
      const autoIncrement = Boolean(options && options.autoIncrement)
      if (keyPath !== null && !validPath(keyPath)) throw fail('SyntaxError', 'The keyPath option is not a valid key path.')
      if (this.data.stores.has(name)) throw fail('ConstraintError', 'An object store with the specified name already exists.')
      if (autoIncrement && (keyPath === '' || Array.isArray(keyPath))) throw fail('InvalidAccessError', 'The autoIncrement option was set but the keyPath option was empty or an array.')
      const store = makeStore({ name, keyPath: Array.isArray(keyPath) ? keyPath.slice() : keyPath, autoIncrement })
      this.data.stores = new Map(this.data.stores).set(name, store)
      return tx.objectStore(name)
    }
    deleteObjectStore(name) {
      const tx = this.upgrading()
      if (!this.data.stores.has(name)) throw fail('NotFoundError', 'The specified object store was not found.')
      const stores = new Map(this.data.stores)
      stores.delete(name)
      this.data.stores = stores
      tx.state.ops.push(['clear', name])
    }
    transaction(storeNames, mode = 'readonly') {
      if (this.own.closed) throw fail('InvalidStateError', 'The database connection is closing.')
      if (this.own.upgrade && !this.own.upgrade.state.done) throw fail('InvalidStateError', 'A version change transaction is running.')
      const scope = [...new Set((typeof storeNames === 'string' ? [storeNames] : [...storeNames]).map(String))]
      if (!scope.length) throw fail('InvalidAccessError', 'The storeNames parameter was empty.')
      for (const name of scope) if (!this.data.stores.has(name)) throw fail('NotFoundError', 'One of the specified object stores was not found.')
      if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError(`The provided value '${mode}' is not a valid enum value of type IDBTransactionMode.`)
      return new Transaction(this, scope, mode)
    }
    close() {
      this.own.closed = true
      this.data.conns.delete(this)
    }
  }
  const tellOthers = (data, versions, except) => {
    for (const conn of [...data.conns]) if (conn !== except && !conn.own.closed) deliver(conn, makeEvent('versionchange', { versions }), conn)
  }

  // ── The factory ──
  const queues = new Map()
  // Opening and deleting one database go one after another, each once the one before has finished.
  const queued = (name, job) => {
    const run = (queues.get(name) || Promise.resolve()).then(
      () =>
        new Promise(finished =>
          job(finished, error => {
            report(error)
            finished()
          }),
        ),
    )
    queues.set(name, run.catch(() => {}))
  }
  // A step that threw lets the next open go on.
  const guarded = (job, broke) => () => {
    try {
      job()
    } catch (error) {
      broke(error)
    }
  }
  const openNow = (name, version, req, finished, broke) => {
    hydrate(name).then(data =>
      later(guarded(() => {
        const old = data.version
        const target = version === undefined ? old || 1 : version
        if (target < old) {
          settle(req, fail('VersionError', `The requested version (${target}) is less than the existing version (${old}).`))
          return finished()
        }
        const conn = new Database(data, target)
        if (target === old) {
          data.conns.add(conn)
          settle(req, null, conn)
          return finished()
        }
        tellOthers(data, { oldVersion: old, newVersion: target }, null)
        const schema = snapshot(data)
        data.version = target
        data.conns.add(conn)
        const tx = new Transaction(conn, [], 'versionchange', committed => {
          conn.own.upgrade = null
          req.transaction = null
          later(() => {
            if (!committed) {
              conn.close()
              settle(req, fail('AbortError', 'The version change transaction was aborted.'))
            } else if (conn.own.closed) settle(req, fail('AbortError', 'The connection was closed.'))
            else settle(req, null, conn)
            finished()
          })
        }, schema)
        conn.own.upgrade = tx
        req.transaction = tx
        req.readyState = 'done'
        req.answer = { result: conn, error: null }
        if (dispatch(req, makeEvent('upgradeneeded', { versions: { oldVersion: old, newVersion: target } }))) tx.end(fail('AbortError', 'An event handler threw.'))
      }, broke)),
    )
  }
  const factory = {
    open(name, version) {
      if (!arguments.length) throw new TypeError('1 argument required, but only 0 present.')
      name = String(name)
      if (version !== undefined) {
        version = Math.floor(Number(version))
        if (!(version >= 1 && version <= Number.MAX_SAFE_INTEGER)) throw new TypeError('The version provided is not a valid integer version.')
      }
      const req = new OpenRequest()
      queued(name, (finished, broke) => openNow(name, version, req, finished, broke))
      return req
    },
    deleteDatabase(name) {
      if (!arguments.length) throw new TypeError('1 argument required, but only 0 present.')
      name = String(name)
      const req = new OpenRequest()
      queued(name, (finished, broke) =>
        hydrate(name).then(data =>
          later(guarded(() => {
            const old = data.version
            tellOthers(data, { oldVersion: old, newVersion: null }, null)
            for (const conn of [...data.conns]) conn.close()
            data.version = 0
            data.stores = new Map()
            if (old && !data.local) {
              data.rev = newRev()
              call('idb', { op: 'drop', name, rev: data.rev }).catch(warn)
            }
            settle(req, null, undefined, { oldVersion: old, newVersion: null })
            finished()
          }, broke)),
        ),
      )
      return req
    },
    databases() {
      return call('idb', { op: 'list' }).then(
        list => list,
        () => [],
      ).then(list => {
        const out = new Map((Array.isArray(list) ? list : []).map(one => [one.name, one]))
        for (const data of dbs.values()) {
          if (data.version) out.set(data.name, { name: data.name, version: data.version })
          else out.delete(data.name)
        }
        return [...out.values()]
      })
    },
    cmp(a, b) {
      if (!validKey(a) || !validKey(b)) throw badKey()
      return cmp(a, b)
    },
  }
  try {
    Object.defineProperty(window, 'indexedDB', { value: factory, configurable: true, enumerable: true })
  } catch {
    return
  }

  // Another frame of this card saved or deleted a database this frame has open (the page tells the frames that read it).
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return
    const news = event.data && event.data.agentTavernIdb
    if (!news || typeof news.name !== 'string') return
    const data = dbs.get(news.name)
    if (!data || data.local) return
    if (data.busy) {
      data.rev = null
      return
    }
    const old = data.version
    if (news.drop) {
      data.version = 0
      data.stores = new Map()
      tellOthers(data, { oldVersion: old, newVersion: null }, null)
    } else if (news.meta) {
      if (news.meta.version > old) tellOthers(data, { oldVersion: old, newVersion: news.meta.version }, null)
      applyChanges(data, news.meta, Array.isArray(news.ops) ? news.ops : [])
    }
    data.rev = news.rev
  })
}

// ─── The page's side: each card's databases, kept in the app's own IndexedDB ───
// 'dbs': [card, name] → { version, stores }; 'rows': [card, name, store, key] → value.
const HOME = 'cicatavern-card-data'
let home = null
const done = request =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
const finished = tx =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error || new DOMException('The transaction was aborted.', 'AbortError'))
  })
function openHome() {
  if (!home) {
    home = new Promise((resolve, reject) => {
      const request = indexedDB.open(HOME, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('dbs')
        request.result.createObjectStore('rows')
      }
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => {
          db.close()
          home = null
        }
        resolve(db)
      }
      request.onerror = () => reject(request.error)
    })
    home.catch(() => {
      home = null
    })
  }
  return home
}
// One database's loads and saves in the order they came, a later load after an earlier save.
const turns = new Map()
const inTurn = (key, job) => {
  const run = (turns.get(key) || Promise.resolve()).then(job)
  const settled = run.catch(() => {})
  turns.set(key, settled)
  settled.then(() => {
    if (turns.get(key) === settled) turns.delete(key)
  })
  return run
}
// Each database's latest save (a frame that has it as it is need not load it again), and the frames that have it open.
const revs = new Map()
const readers = new Map()

/**
 * A frame's request (compat.js installFrameBridge, op 'idb'). `owner` is the card the frame was made for, never one it
 * names; `tell(frameId, message)` passes a change to another frame of that card and says whether that frame is still there.
 */
export function frameData(owner, frameId, args, tell) {
  owner = String(owner || '')
  if (args.op === 'list') {
    return Promise.all([...turns.values()]).then(async () => {
      const db = await openHome()
      const range = IDBKeyRange.bound([owner], [owner, []])
      const store = db.transaction('dbs').objectStore('dbs')
      const [keys, metas] = await Promise.all([done(store.getAllKeys(range)), done(store.getAll(range))])
      return keys.map((key, i) => ({ name: key[1], version: metas[i].version }))
    })
  }
  const name = String(args.name ?? '')
  const key = JSON.stringify([owner, name])
  const lower = [owner, name]
  const all = IDBKeyRange.bound(lower, [owner, name, []])
  return inTurn(key, async () => {
    const db = await openHome()
    if (args.op === 'load') {
      if (!readers.has(key)) readers.set(key, new Set())
      readers.get(key).add(frameId)
      const rev = revs.get(key) || 'saved'
      if (args.rev && args.rev === rev) return { rev, same: true }
      const tx = db.transaction(['dbs', 'rows'])
      const rows = tx.objectStore('rows')
      const [meta, keys, values] = await Promise.all([done(tx.objectStore('dbs').get(lower)), done(rows.getAllKeys(all)), done(rows.getAll(all))])
      return { rev, db: meta ? { ...meta, rows: keys.map((k, i) => [k[2], k[3], values[i]]) } : null }
    }
    if (args.op !== 'commit' && args.op !== 'drop') throw new Error(`unknown op ${args.op}`)
    const tx = db.transaction(['dbs', 'rows'], 'readwrite')
    const metas = tx.objectStore('dbs')
    const rows = tx.objectStore('rows')
    if (args.op === 'drop') {
      metas.delete(lower)
      rows.delete(all)
    } else {
      metas.put(args.meta, lower)
      for (const op of Array.isArray(args.ops) ? args.ops : []) {
        if (op[0] === 'put') rows.put(op[3], [owner, name, op[1], op[2]])
        else if (op[0] === 'delete') rows.delete([owner, name, op[1], op[2]])
        else if (op[0] === 'clear') rows.delete(IDBKeyRange.bound([owner, name, op[1]], [owner, name, op[1], []]))
      }
    }
    await finished(tx)
    const rev = String(args.rev)
    revs.set(key, rev)
    const message = args.op === 'drop' ? { name, rev, drop: true } : { name, rev, meta: args.meta, ops: args.ops }
    const others = readers.get(key) || new Set()
    for (const other of [...others]) if (other !== frameId && !tell(other, message)) others.delete(other)
    return { rev }
  })
}
