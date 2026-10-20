import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { accumulatedDynamic, COMPACT_AT, compactThreshold, dynamicMemory, planDynamic, stripDynamicText } from '../server/dynamic.mjs'
import { hostAllowed, hostOf, isLoopback, lanAddresses, tokensEqual } from '../server/access.mjs'

const list = ['好感: 3', '位置: 厅堂', '时间: 午后', ...Array.from({ length: 30 }, (_, i) => `备忘${i}: 未变的一长行说明`)].join('\n')

test('planDynamic sends the full list once, then only changes', () => {
  const first = planDynamic({ rendered: list, anchor: '', lastRendered: '', sinceFull: 0 })
  assert.equal(first.mode, 'full')
  assert.equal(first.text, list)
  assert.equal(first.state.rendered, list)

  const same = planDynamic({ rendered: list, anchor: list, lastRendered: list, sinceFull: 1 })
  assert.equal(same.mode, 'omit')
  assert.equal(same.text, '')

  const changed = planDynamic({ rendered: list.replace('好感: 3', '好感: 5').replace('时间: 午后', '时间: 傍晚'), anchor: list, lastRendered: list, sinceFull: 1 })
  assert.equal(changed.mode, 'diff')
  assert.match(changed.text, /\+ 好感: 5/)
  assert.match(changed.text, /\+ 时间: 傍晚/)
  assert.match(changed.text, /- 好感: 3/)
  assert.doesNotMatch(changed.text, /位置: 厅堂/)
  assert.ok(changed.text.length < list.length * 0.7)
})

test('planDynamic refreshes the full list on demand and after several turns', () => {
  const forced = planDynamic({ rendered: list, anchor: list, lastRendered: list, sinceFull: 1, forceFull: true })
  assert.equal(forced.mode, 'full')
  assert.match(forced.text, /更早的动态设定作废/)
  assert.match(forced.text, /好感: 3/)

  const due = planDynamic({ rendered: list, anchor: list, lastRendered: list, sinceFull: 7 })
  assert.equal(due.mode, 'full')
})

test('accumulatedDynamic ignores copies already stripped', () => {
  const path = [
    { role: 'user', prompt: '<动态设定>\n旧\n</动态设定>', dynamic: { mode: 'full', rendered: '旧' } },
    { role: 'assistant' },
    { role: 'user', prompt: '<动态设定>\n新\n</动态设定>', dynamic: { mode: 'full', rendered: '新', compacted: true } },
    { role: 'user', prompt: '<动态设定>\n增量\n</动态设定>', dynamic: { mode: 'diff', rendered: '新2' } },
  ]
  assert.equal(accumulatedDynamic(path), '\n新\n'.length + '\n增量\n'.length)
  assert.equal(dynamicMemory(path).anchor, '新')
  assert.equal(dynamicMemory(path).lastRendered, '新2')
})

test('stripDynamicText removes the block and leaves the input', () => {
  const text = '<世界书>\n一条\n</世界书>\n\n<动态设定>\n好感: 1\n</动态设定>\n\n<玩家输入>\n你好\n</玩家输入>'
  const next = stripDynamicText(text)
  assert.doesNotMatch(next, /动态设定/)
  assert.match(next, /你好/)
  assert.match(next, /一条/)
})

test('access checks loopback, host and token', () => {
  assert.equal(isLoopback('::ffff:127.0.0.1'), true)
  assert.equal(isLoopback('192.168.1.8'), false)
  assert.equal(hostOf('[::1]:8791'), '::1')
  const names = new Set(['127.0.0.1', 'localhost', '::1', '192.168.1.5'])
  assert.equal(hostAllowed('192.168.1.5:8791', { lan: true, names }), true)
  assert.equal(hostAllowed('evil.example:8791', { lan: true, names }), false)
  assert.equal(hostAllowed('192.168.1.5:8791', { lan: false, names }), false)
  assert.equal(tokensEqual('abc', 'abc'), true)
  assert.equal(tokensEqual('abc', 'abd'), false)
  assert.equal(tokensEqual('', 'abc'), false)
})

test('phone links put Wi-Fi first and fold VPN / virtual adapters', () => {
  const v4 = address => ({ address, family: 'IPv4', internal: false })
  const v6 = address => ({ address, family: 'IPv6', internal: false })
  const { addresses, names } = lanAddresses({
    'Radmin VPN': [v6('fdfd::1a83:f43a'), v4('26.131.244.58')],
    'vEthernet (Default Switch)': [v4('172.17.224.1')],
    WLAN: [v6('fe80::1'), v4('192.168.0.191')],
    Tailscale: [v6('fd7a:115c:a1e0::1'), v4('100.101.1.2')],
    'vEthernet (WSL (Hyper-V firewall))': [v4('172.31.16.1')],
  })
  assert.deepEqual(
    addresses.map(item => [item.host, item.kind, item.primary]),
    [
      ['192.168.0.191', 'wifi', true],
      ['100.101.1.2', 'tailscale', true],
      ['[fd7a:115c:a1e0::1]', 'tailscale', false],
      ['26.131.244.58', 'other', false],
      ['[fdfd::1a83:f43a]', 'other', false],
      ['172.17.224.1', 'virtual', false],
      ['172.31.16.1', 'virtual', false],
    ],
  )
  assert.equal(names.has('172.31.16.1'), true)
  assert.equal(names.has('fe80::1'), false)
  // macOS: en0 is the Wi-Fi (or wired) link; bridges and tunnels are folded; Tailscale by its address.
  const mac = lanAddresses({
    bridge100: [v4('192.168.64.1')],
    en0: [v4('192.168.0.23')],
    utun4: [v4('100.80.1.9')],
    utun2: [v6('fd00::1')],
  })
  assert.deepEqual(mac.addresses.map(item => [item.host, item.kind]), [['192.168.0.23', 'wifi'], ['100.80.1.9', 'tailscale'], ['192.168.64.1', 'virtual'], ['[fd00::1]', 'virtual']])
})

test('compactThreshold grows with the full list, so one full copy never strips every turn', () => {
  assert.equal(compactThreshold([]), COMPACT_AT)
  const full = 'x'.repeat(10000)
  const path = [{ role: 'user', dynamic: { mode: 'full', rendered: full, compacted: true }, prompt: `<动态设定>${full}</动态设定>` }]
  assert.equal(compactThreshold(path, 'often'), 25000)
  assert.equal(compactThreshold(path), 60000, 'rare by default')
  assert.equal(compactThreshold(path, 'off'), Infinity)
  assert.equal(compactThreshold(path, 'nonsense'), 60000)
  assert.ok(accumulatedDynamic(path) < compactThreshold(path, 'often'))
})
