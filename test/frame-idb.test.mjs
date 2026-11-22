import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frameIdb, USES_INDEXED_DB } from '../web/frame-idb.js'

// The browser's key ranges, as far as these tests use them (the stand-in reads lower, upper and whether each is open).
const IDBKeyRange = {
  bound: (lower, upper, lowerOpen = false, upperOpen = false) => ({ lower, upper, lowerOpen, upperOpen }),
  lowerBound: (lower, open = false) => ({ lower, upper: undefined, lowerOpen: open, upperOpen: true }),
}

// The page's side as frame-idb.js frameData keeps it, in memory: what a frame saved, a later frame loads.
function fakePage() {
  const saved = new Map()
  const calls = []
  const call = async (op, args) => {
    assert.equal(op, 'idb')
    calls.push(args.op)
    const kept = structuredClone(args)
    if (kept.op === 'load') {
      const db = saved.get(kept.name)
      if (db && kept.rev === db.rev) return { rev: db.rev, same: true }
      return { rev: db?.rev ?? 'saved', db: db ? { ...db.meta, rows: [...db.rows.values()] } : null }
    }
    if (kept.op === 'drop') saved.delete(kept.name)
    if (kept.op === 'commit') {
      const db = saved.get(kept.name) ?? { rows: new Map() }
      db.meta = kept.meta
      db.rev = kept.rev
      for (const op of kept.ops) {
        const id = JSON.stringify([op[1], op[2]])
        if (op[0] === 'put') db.rows.set(id, [op[1], op[2], op[3]])
        else if (op[0] === 'delete') db.rows.delete(id)
        else for (const [key, row] of db.rows) if (row[0] === op[1]) db.rows.delete(key)
      }
      saved.set(kept.name, db)
    }
    if (kept.op === 'list') return [...saved].map(([name, db]) => ({ name, version: db.meta.version }))
    return {}
  }
  return { call, calls, saved }
}

// A frame: a window of its own whose indexedDB is the stand-in.
function frameWith(page, id = 'f1') {
  globalThis.MessageChannel = undefined
  globalThis.window = { origin: 'null', parent: {}, addEventListener() {} }
  frameIdb({ call: page.call, frame: id })
  return globalThis.window.indexedDB
}

const ask = request =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = event => {
      event.preventDefault()
      reject(request.error)
    }
  })
const settled = tx =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve('complete')
    tx.onabort = () => reject(tx.error ?? new Error('aborted'))
  })

function openSaves(idb, version = 1) {
  const request = idb.open('saves', version)
  request.onupgradeneeded = event => {
    const db = request.result
    assert.equal(event.oldVersion, 0)
    if (!db.objectStoreNames.contains('saveData')) db.createObjectStore('saveData', { keyPath: 'key' })
    const log = db.createObjectStore('log', { autoIncrement: true })
    log.createIndex('byTurn', 'turn')
    log.createIndex('byTag', 'tags', { multiEntry: true })
    log.createIndex('byName', 'name', { unique: true })
  }
  return ask(request)
}

test('only pages that may use IndexedDB get the stand-in', () => {
  assert.ok(USES_INDEXED_DB.test('<script src="https://unpkg.com/dexie/dist/dexie.js"></script>'))
  assert.ok(USES_INDEXED_DB.test('const request = indexedDB.open(DB_NAME)'))
  assert.ok(!USES_INDEXED_DB.test('<div class="status">HP 10</div>'))
})

test('a save outlives the frame: the next frame of the card loads it from the page', async () => {
  const page = fakePage()
  let idb = frameWith(page)
  let db = await openSaves(idb)
  assert.deepEqual([...db.objectStoreNames], ['log', 'saveData'])
  let tx = db.transaction('saveData', 'readwrite')
  tx.objectStore('saveData').put({ key: 'slot1', turn: 3, when: new Date(5) })
  assert.equal(await settled(tx), 'complete')
  db.close()
  assert.deepEqual(page.calls, ['load', 'commit', 'commit'])

  idb = frameWith(page, 'f2')
  const request = idb.open('saves')
  request.onupgradeneeded = () => assert.fail('the saved version is opened as it is')
  db = await ask(request)
  assert.equal(db.version, 1)
  tx = db.transaction(['saveData'])
  const value = await ask(tx.objectStore('saveData').get('slot1'))
  assert.equal(value.turn, 3)
  assert.ok(value.when instanceof Date)
  assert.equal(await ask(tx.objectStore('saveData').get('missing')), undefined)
})

test('requests made after an await stay in the transaction; it commits once they are done', async () => {
  const idb = frameWith(fakePage())
  const db = await openSaves(idb)
  const tx = db.transaction(['saveData'], 'readwrite')
  const store = tx.objectStore('saveData')
  const done = settled(tx)
  await ask(store.put({ key: 'a', n: 1 }))
  const a = await ask(store.get('a'))
  await ask(store.put({ key: 'a', n: a.n + 1 }))
  await Promise.resolve()
  await ask(store.add({ key: 'b', n: 0 }))
  await done
  const read = db.transaction('saveData').objectStore('saveData')
  assert.deepEqual(await ask(read.getAll()), [{ key: 'a', n: 2 }, { key: 'b', n: 0 }])
  assert.deepEqual(await ask(read.getAllKeys()), ['a', 'b'])
  assert.equal(await ask(read.count()), 2)
  assert.throws(() => read.put({ key: 'c' }), { name: 'ReadOnlyError' })
})

test('a failed request aborts the transaction and its changes go, unless its error is handled', async () => {
  const idb = frameWith(fakePage())
  const db = await openSaves(idb)
  let tx = db.transaction('saveData', 'readwrite')
  tx.objectStore('saveData').put({ key: 'x', n: 1 })
  tx.objectStore('saveData').add({ key: 'x', n: 2 }).onerror = null
  await assert.rejects(settled(tx), { name: 'ConstraintError' })
  assert.equal(await ask(db.transaction('saveData').objectStore('saveData').count()), 0)

  tx = db.transaction('saveData', 'readwrite')
  tx.objectStore('saveData').put({ key: 'x', n: 1 })
  await assert.rejects(ask(tx.objectStore('saveData').add({ key: 'x', n: 2 })), { name: 'ConstraintError' })
  await settled(tx)
  assert.equal((await ask(db.transaction('saveData').objectStore('saveData').get('x'))).n, 1)
})

test('key generators, indexes and cursors', async () => {
  const idb = frameWith(fakePage())
  const db = await openSaves(idb)
  const tx = db.transaction('log', 'readwrite')
  const log = tx.objectStore('log')
  const keys = []
  for (const [turn, name, tags] of [[2, 'b', ['x', 'y']], [1, 'a', ['y']], [2, 'c', []], [3, 'd', ['x', 'x']]]) keys.push(await ask(log.add({ turn, name, tags })))
  assert.deepEqual(keys, [1, 2, 3, 4])
  await assert.rejects(ask(log.add({ turn: 9, name: 'a' })), { name: 'ConstraintError' })
  await settled(tx)

  const read = db.transaction('log').objectStore('log')
  assert.deepEqual((await ask(read.index('byTurn').getAll(2))).map(v => v.name), ['b', 'c'])
  assert.deepEqual(await ask(read.index('byTag').getAllKeys('x')), [1, 4])
  assert.equal(await ask(read.index('byName').getKey('d')), 4)
  assert.equal(await ask(read.index('byTurn').count(IDBKeyRange.lowerBound(2, true))), 1)

  const walk = (source, ...args) =>
    new Promise(resolve => {
      const seen = []
      source.openCursor(...args).onsuccess = event => {
        const cursor = event.target.result
        if (!cursor) return resolve(seen)
        seen.push(`${cursor.key}:${cursor.primaryKey}`)
        cursor.continue()
      }
    })
  const store = db.transaction('log').objectStore('log')
  assert.deepEqual(await walk(store.index('byTurn')), ['1:2', '2:1', '2:3', '3:4'])
  assert.deepEqual(await walk(store.index('byTurn'), null, 'prev'), ['3:4', '2:3', '2:1', '1:2'])
  assert.deepEqual(await walk(store.index('byTurn'), null, 'nextunique'), ['1:2', '2:1', '3:4'])
  assert.deepEqual(await walk(store.index('byTurn'), null, 'prevunique'), ['3:4', '2:1', '1:2'])
  assert.deepEqual(await walk(store, IDBKeyRange.bound(2, 3)), ['2:2', '3:3'])

  // Changing and deleting through a cursor.
  const edit = db.transaction('log', 'readwrite')
  edit.objectStore('log').openCursor().onsuccess = event => {
    const cursor = event.target.result
    if (!cursor) return
    if (cursor.value.turn === 2) cursor.delete()
    else cursor.update({ ...cursor.value, turn: cursor.value.turn * 10 })
    cursor.continue()
  }
  await settled(edit)
  const after = db.transaction('log').objectStore('log')
  assert.deepEqual((await ask(after.getAll())).map(v => v.turn), [10, 30])
  assert.equal(await ask(after.count()), 2)
})

test('versions: a higher one upgrades, a lower one is refused, an aborted upgrade leaves it as it was', async () => {
  const idb = frameWith(fakePage())
  const first = await openSaves(idb)
  let heard = null
  first.onversionchange = event => {
    heard = [event.oldVersion, event.newVersion]
    first.close()
  }
  const request = idb.open('saves', 3)
  request.onupgradeneeded = event => {
    assert.equal(event.oldVersion, 1)
    request.result.createObjectStore('extra')
  }
  const db = await ask(request)
  assert.deepEqual(heard, [1, 3])
  assert.equal(db.version, 3)
  assert.ok(db.objectStoreNames.contains('extra'))
  await assert.rejects(ask(idb.open('saves', 2)), { name: 'VersionError' })

  db.close()
  const broken = idb.open('saves', 4)
  broken.onupgradeneeded = () => {
    broken.result.createObjectStore('gone')
    broken.transaction.abort()
  }
  await assert.rejects(ask(broken), { name: 'AbortError' })
  const again = await ask(idb.open('saves'))
  assert.equal(again.version, 3)
  assert.ok(!again.objectStoreNames.contains('gone'))
})

test('deleting a database deletes what the page keeps', async () => {
  const page = fakePage()
  const idb = frameWith(page)
  const db = await openSaves(idb)
  const tx = db.transaction('saveData', 'readwrite')
  tx.objectStore('saveData').put({ key: 'slot', n: 1 })
  await settled(tx)
  db.close()
  assert.deepEqual(await idb.databases(), [{ name: 'saves', version: 1 }])
  await ask(idb.deleteDatabase('saves'))
  assert.ok(!page.saved.has('saves'))
  assert.deepEqual(await idb.databases(), [])

  const fresh = frameWith(page, 'f3')
  const request = fresh.open('saves')
  let upgraded = false
  request.onupgradeneeded = event => {
    upgraded = event.oldVersion === 0
  }
  await ask(request)
  assert.ok(upgraded)
})

test('keys order as IndexedDB orders them', () => {
  const idb = frameWith(fakePage())
  const sorted = [-1, 0, 2, new Date(0), '', 'a', 'b', new Uint8Array([1]), [], [0], ['a']]
  for (let i = 1; i < sorted.length; i++) assert.equal(idb.cmp(sorted[i - 1], sorted[i]), -1, `${i}`)
  assert.equal(idb.cmp([1, 'x'], [1, 'x']), 0)
  assert.throws(() => idb.cmp({}, 1), { name: 'DataError' })
})
