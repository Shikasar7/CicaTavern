// The phone apps run the server on a Node built without ICU: a \p{…} written in a regex literal is a syntax error there,
// so the whole server fails to load, while every test on a desktop Node passes. Found in a simulator run of 2.4.0.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))

/** The server's files and all the page's shared files they import, directly or not. */
function loaded() {
  const seen = new Set()
  const queue = walk(path.join(root, 'server')).filter(file => file.endsWith('.mjs') && !file.includes(`${path.sep}subscription${path.sep}`))
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(/from '(\.{1,2}\/[^']+)'/g)) queue.push(path.resolve(path.dirname(file), match[1]))
  }
  return [...seen]
}

test('nothing the server loads has a \\p{…} regex literal', () => {
  const found = []
  for (const file of loaded()) {
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      // In a comment it is only words; in a string (written \\p) it is built at run time, where a failure can be caught.
      if (!/^\s*(\/\/|\*|\/\*)/.test(line) && /(?<!\\)\\[pP]\{/.test(line)) found.push(`${path.relative(root, file)}:${index + 1}`)
    })
  }
  assert.deepEqual(found, [])
})
