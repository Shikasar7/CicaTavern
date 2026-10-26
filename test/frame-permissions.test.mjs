// 卡片界面权限: asked once per card, a yes and a no both kept, changed in the card's menu (web/shared/frame-permissions.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFramePermissions, PERMISSIONS_KEY } from '../web/shared/frame-permissions.js'

function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: key => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: key => items.delete(key),
  }
}

test('a yes and a no are both kept per card; null forgets, so the card is asked again', () => {
  const storage = memoryStorage()
  const permissions = createFramePermissions(storage)
  assert.equal(permissions.decision('c1', 'send'), undefined)
  permissions.decide('c1', 'send', 'deny')
  permissions.decide('c1', 'generate', 'allow')
  permissions.decide('c2', 'send', 'allow')
  // Another page of this browser reads the same answers.
  const again = createFramePermissions(storage)
  assert.equal(again.decision('c1', 'send'), 'deny')
  assert.equal(again.decision('c1', 'generate'), 'allow')
  assert.equal(again.decision('c2', 'send'), 'allow')
  again.decide('c1', 'send', null)
  assert.equal(permissions.decision('c1', 'send'), undefined)
  permissions.decide('c1', 'generate', 'maybe')
  assert.equal(permissions.decision('c1', 'generate'), undefined, 'anything but allow / deny forgets')
})

test('addresses: per card and origin; a changed answer asks about this computer or the local network again', () => {
  const permissions = createFramePermissions(memoryStorage())
  permissions.decide('c1', 'relay', 'allow', 'https://api.example.com')
  permissions.decide('c1', 'relay', 'deny', 'https://evil.example')
  permissions.decide('c1', 'local', 'allow', 'https://api.example.com')
  assert.deepEqual(permissions.allowedOrigins('c1'), ['https://api.example.com'])
  assert.deepEqual(permissions.allowedOrigins('c1', 'local'), ['https://api.example.com'])
  assert.deepEqual(permissions.allowedOrigins('c2'), [])
  assert.equal(permissions.decision('c1', 'relay', 'https://evil.example'), 'deny')
  permissions.decide('c1', 'relay', 'deny', 'https://api.example.com')
  assert.equal(permissions.decision('c1', 'local', 'https://api.example.com'), undefined)
  assert.deepEqual(permissions.of('c1'), { send: undefined, generate: undefined, relay: { 'https://api.example.com': 'deny', 'https://evil.example': 'deny' }, local: {} })
})

test('what the old keys allowed is moved over once, and they are removed', () => {
  const storage = memoryStorage({
    'agent-tavern:frame-generate': JSON.stringify(['c1']),
    'agent-tavern:frame-relay': JSON.stringify({ c1: ['https://a.example'], c2: ['http://192.168.1.5:8080'] }),
    'agent-tavern:frame-relay-local': JSON.stringify({ c2: ['http://192.168.1.5:8080'] }),
  })
  const permissions = createFramePermissions(storage)
  assert.equal(permissions.decision('c1', 'generate'), 'allow')
  assert.deepEqual(permissions.allowedOrigins('c1'), ['https://a.example'])
  assert.deepEqual(permissions.allowedOrigins('c2', 'local'), ['http://192.168.1.5:8080'])
  assert.deepEqual([...storage.items.keys()], [PERMISSIONS_KEY])
})

test('storage that is missing, throws or holds junk: answers last for the page, nothing breaks', () => {
  const broken = { getItem: () => { throw new Error('SecurityError') }, setItem: () => { throw new Error('SecurityError') }, removeItem: () => {} }
  for (const storage of [null, broken]) {
    const permissions = createFramePermissions(storage)
    assert.equal(permissions.decision('c1', 'send'), undefined)
    permissions.decide('c1', 'send', 'deny')
    assert.equal(permissions.decision('c1', 'send'), 'deny', 'kept until the page is closed')
  }
  const junk = createFramePermissions(memoryStorage({ [PERMISSIONS_KEY]: '{"c1":{"send":"yes","relay":{"x":1}},"c2":5' }))
  assert.equal(junk.decision('c1', 'send'), undefined)
  const odd = createFramePermissions(memoryStorage({ [PERMISSIONS_KEY]: JSON.stringify({ c1: { send: 'yes', generate: 'deny', relay: { a: 1, b: 'allow' } }, c2: 5 }) }))
  assert.deepEqual(odd.of('c1'), { send: undefined, generate: 'deny', relay: { b: 'allow' }, local: {} })
})
