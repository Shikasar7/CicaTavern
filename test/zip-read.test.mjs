// The zip reader the page uses for an expression pack (web/shared/zip.js), on a zip the update packer makes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { zipFolder } from '../server/update/zip.mjs'
import { zipData, zipEntries } from '../web/shared/zip.js'

test('a zip\'s files and their bytes, stored or deflated, names in UTF-8', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cicatavern-zip-'))
  try {
    const pack = path.join(dir, '青禾')
    await mkdir(pack)
    const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const text = Buffer.from('joy '.repeat(200))
    await writeFile(path.join(pack, 'joy.png'), picture)
    await writeFile(path.join(pack, '微笑.txt'), text)
    const bytes = new Uint8Array(await zipFolder(pack))
    const entries = zipEntries(bytes)
    assert.deepEqual(entries.map(entry => entry.name).sort(), ['青禾/joy.png', '青禾/微笑.txt'])
    const inflateRaw = async data => new Uint8Array(zlib.inflateRawSync(data))
    for (const [name, want] of [['青禾/joy.png', picture], ['青禾/微笑.txt', text]]) {
      const data = await zipData(bytes, entries.find(entry => entry.name === name), inflateRaw)
      assert.deepEqual(Buffer.from(data), want)
    }
    assert.throws(() => zipEntries(new Uint8Array(64)), /not a zip/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
