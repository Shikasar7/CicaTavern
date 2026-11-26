// Every script of the page is in the server's list of files (server/http.mjs STATIC): one that is not answers 404, and the
// page that imports it does not start.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

async function scripts(dir, base = '') {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...await scripts(path.join(dir, entry.name), `${base}${entry.name}/`))
    else if (/\.m?js$/.test(entry.name)) found.push(`${base}${entry.name}`)
  }
  return found
}

test('every script under web/ is served', async () => {
  const source = await readFile(path.join(ROOT, 'server', 'http.mjs'), 'utf8')
  const table = /const STATIC = \{[\s\S]*?\n\}/.exec(source)[0]
  const served = new Set([...table.matchAll(/\['([^']+\.m?js)'/g)].map(match => match[1]))
  const missing = (await scripts(path.join(ROOT, 'web'))).filter(file => !served.has(file))
  assert.deepEqual(missing, [], 'add them to STATIC in server/http.mjs')
})
