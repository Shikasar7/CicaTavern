// The Android app runs the server on nodejs-mobile's Node 18, built without ICU:
// \p{…} in a regex is a syntax error there, and toLocale*String / Intl ignore
// the locale. These checks catch that on the desktop instead of on the phone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IDENT_WITHOUT_ICU } from '../server/state.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** server/*.mjs, bin/android.mjs, and the web/shared files the server imports. */
function serverSources() {
  const files = readdirSync(path.join(root, 'server')).filter(f => f.endsWith('.mjs')).map(f => path.join(root, 'server', f))
  // The phone app's entry, where this tree has the Android app.
  const android = path.join(root, 'bin', 'android.mjs')
  if (existsSync(android)) files.push(android)
  const shared = new Set()
  for (const file of files) {
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(/from '\.\.\/web\/shared\/([\w.-]+)'/g)) shared.add(path.join(root, 'web', 'shared', spec))
  }
  return [...files, ...shared]
}

test('server code avoids what the ICU-less Android Node lacks', () => {
  const problems = []
  for (const file of serverSources()) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line)) return
      if (/(?<!\\)\\[pP]\{/.test(line)) problems.push(`${path.relative(root, file)}:${index + 1} Unicode property escape`)
      if (/\btoLocale\w*String\(|\bIntl\./.test(line)) problems.push(`${path.relative(root, file)}:${index + 1} locale formatting`)
    })
  }
  assert.deepEqual(problems, [])
})

test('unquoted keys without ICU: same answers as \\p{L} for ordinary keys', () => {
  const withIcu = new RegExp('^[\\p{L}_$][\\p{L}\\p{N}_$]*', 'u')
  for (const key of ['好感度', '角色.好感度', 'stat_1', '$x', 'Ärger', 'ハート', '체력', '𠀀字', 'café2']) {
    assert.equal(IDENT_WITHOUT_ICU.exec(key)?.[0], withIcu.exec(key)?.[0], key)
  }
  // Punctuation and spaces end a key, as with \p{L}.
  for (const text of ['名字：小雨', '好感，度', '状态 值', '（括号）', '1abc']) {
    assert.equal(IDENT_WITHOUT_ICU.exec(text)?.[0], withIcu.exec(text)?.[0], text)
  }
})
