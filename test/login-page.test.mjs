import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { loginPage } from '../server/access.mjs'

/** Runs the login page's own script against a form and a fetch of the test's. */
async function submit({ typed = '', hash = '', reply }) {
  const script = /<script>([\s\S]*)<\/script>/.exec(loginPage('Test'))[1]
  const sent = []
  const moved = []
  const form = {
    token: { value: typed },
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener },
  }
  const err = { textContent: '' }
  const sandbox = {
    URLSearchParams,
    JSON,
    navigator: { userAgent: 'Android' },
    location: { hash, pathname: '/', replace: url => moved.push(url) },
    document: { getElementById: id => (id === 'gate' ? form : err) },
    fetch: async (url, options) => {
      sent.push({ url, body: JSON.parse(options.body) })
      return reply
    },
  }
  vm.runInNewContext(script, sandbox)
  await form.listeners.submit({ preventDefault() {} })
  return { sent, moved, error: err.textContent }
}

const ok = { ok: true, json: async () => ({ ok: true }) }
const refused = error => ({ ok: false, json: async () => ({ error }) })

test('the login page sends the key as typed, and goes in when it is right', async () => {
  const { sent, moved, error } = await submit({ typed: '  abc123  ', reply: ok })
  assert.equal(sent[0].url, '/api/access/unlock')
  assert.equal(sent[0].body.token, 'abc123')
  assert.deepEqual(moved, ['/'])
  assert.equal(error, '')
})

test('the login page takes the whole link pasted into its box', async () => {
  const { sent, moved } = await submit({ typed: 'http://192.168.0.2:8791/#k=abc123\n', reply: ok })
  assert.equal(sent[0].body.token, 'abc123')
  assert.deepEqual(moved, ['/'])
})

test('the login page shows what the server said, and only says the key is wrong when it has no words of its own', async () => {
  assert.equal((await submit({ typed: 'abc', reply: refused('不允许从这个地址访问') })).error, '不允许从这个地址访问')
  assert.equal((await submit({ typed: 'abc', reply: refused('口令不对') })).error, '口令不对')
  const notJson = { ok: false, json: async () => { throw new Error('not JSON') } }
  const { error, moved } = await submit({ typed: 'abc', reply: notJson })
  assert.equal(error, '口令不对')
  assert.deepEqual(moved, [])
})
