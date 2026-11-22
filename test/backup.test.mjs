// 备份与换设备 (server/backup.mjs, server/backup-zip.mjs): the data folder by kind into one zip, written as it goes,
// and that zip merged into another device's folder. What stays on this device never travels; keys only when ticked;
// what the other device has already is kept or replaced as asked; a chat still finds its card, book and preset or
// lets go of them; one broken card does not stop the rest; zip64 reads back.
import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createZipWriter, openZipFile } from '../server/backup-zip.mjs'
import { BACKUP_MANIFEST, cleanInclude } from '../server/backup.mjs'
import { createApp } from '../server/http.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const json = value => JSON.stringify(value, null, 1)
const put = async (root, rel, data) => {
  const file = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : json(data))
}
const read = async (root, rel) => JSON.parse(await readFile(path.join(root, ...rel.split('/')), 'utf8'))
const has = async (root, rel) => Boolean(await readFile(path.join(root, ...rel.split('/'))).catch(() => null))

async function start(t, prepare) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'backup-'))
  await prepare?.(dataRoot)
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const exported = async include => {
    const made = await call('/api/backup/export', { method: 'POST', body: { include } })
    assert.equal(made.status, 200)
    assert.match(made.body.name, /^CicaTavern-backup-\d{8}-\d{4}\.zip$/)
    const res = await fetch(`${base}${made.body.path}`)
    assert.equal(res.status, 200)
    return Buffer.from(await res.arrayBuffer())
  }
  const upload = async zip => {
    const res = await fetch(`${base}/api/backup/upload`, { method: 'POST', headers: { 'content-type': 'application/zip', 'x-agent-tavern': '1' }, body: zip })
    return { status: res.status, body: await res.json() }
  }
  const imported = async (zip, include, conflict = 'keep') => {
    const sent = await upload(zip)
    assert.equal(sent.status, 200, JSON.stringify(sent.body))
    const started = await call('/api/backup/import', { method: 'POST', body: { upload: sent.body.upload, include, conflict } })
    assert.equal(started.status, 200, JSON.stringify(started.body))
    for (let i = 0; i < 200; i++) {
      const { body } = await call('/api/backup/import')
      if (body.state === 'done') return { seen: sent.body, report: body.report }
      if (body.state === 'failed') throw new Error(body.error)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('import never ended')
  }
  return { dataRoot, call, exported, upload, imported }
}

/** Every entry of a zip, unpacked, as one text: what a key search must not find. */
async function everything(file) {
  const zip = await openZipFile(file)
  const texts = []
  for (const entry of zip.entries) texts.push((await zip.read(entry)).toString('utf8'))
  await zip.close()
  return texts.join(' ')
}

const CARD = id => ({ id, name: '雨宿', importedAt: '2026-11-01T00:00:00.000Z', description: '雨夜便利店', creatorNotes: '', firstMes: '雨下起来了。', alternateGreetings: [], worldbookIds: ['bk1', 'gone'] })

/** A device with a bit of everything, and things that must stay on it. */
async function filled(root) {
  await put(root, 'cards/card1/card.json', CARD('card1'))
  await put(root, 'cards/card1/avatar.png', PNG)
  await put(root, 'cards/card1/scenes/s1.png', PNG)
  await put(root, 'cards/card1/history.json', { slots: { avatar: [{ file: 'h1.png' }] } })
  await put(root, 'cards/card1/history/h1.png', PNG)
  await put(root, 'cards/card1/card.json.bak-options', 'old')
  await put(root, 'card-order.json', { ids: ['card1'] })
  await put(root, 'chats/chat1.json', {
    id: 'chat1', cardId: 'card1', title: '第一夜', presetId: 'p1', bookIds: ['bk1', 'gone'], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
    nodes: { root: { id: 'root', parent: null, role: 'system' }, n1: { id: 'n1', parent: 'root', role: 'assistant', text: '雨', media: { images: [{ file: 'a.png', history: [{ file: 'old.png' }] }] } } },
  })
  await put(root, 'media/chat1/a.png', PNG)
  await put(root, 'guides/chat1.json', { chatId: 'chat1', model: 'chat', turns: [{ user: { text: '她怎么了？' }, assistant: { text: '在等你。', plans: [] } }] })
  await put(root, 'guides/orphan.json', { chatId: 'orphan', model: 'chat', turns: [] })
  await put(root, 'media/chat1/old.png', PNG)
  await put(root, 'chats/orphan.json', { id: 'orphan', cardId: 'nocard', title: '没有卡', nodes: { root: { id: 'root' } }, updatedAt: '2026-11-02T00:00:00.000Z' })
  await put(root, 'media/tts/cache.mp3', 'tts')
  await put(root, 'media/codex-work/x.txt', 'work')
  await put(root, 'worldbooks/bk1.json', { id: 'bk1', name: '雨夜设定', entries: [] })
  await put(root, 'presets/p1.json', { id: 'p1', name: '预设甲', importedAt: '2026-11-01T00:00:00.000Z' })
  await put(root, 'preset-scripts/p1.json', { scripts: [{ id: 's', name: '脚本' }] })
  await put(root, 'personas.json', { defaultId: 'me', items: [{ id: 'me', name: '阿青', description: '' }, { id: 'p2', name: '阿白', description: '' }], cards: { card1: 'p2' } })
  await put(root, 'regex.json', { scripts: [{ id: 'r1', scriptName: '去括号', findRegex: '/（.*?）/g', replaceString: '' }] })
  await put(root, 'providers.json', { providers: [
    { id: 'relay', name: '中转', api: 'openai-completions', baseURL: 'https://relay.example.com/v1', apiKey: 'sk-test-0123456789', headers: { Authorization: 'Bearer abcdef123456', 'X-Title': 'cica' }, models: ['m1'] },
    { id: 'local', name: '本机', api: 'openai-completions', baseURL: 'http://127.0.0.1:3000/v1', apiKey: 'sk-local-0123456789', models: ['m2'] },
  ] })
  await put(root, 'voice-keys.json', { fish: 'fish-test-key-0123456789' })
  await put(root, 'settings.json', { replyLength: 777, listen: 'lan', proxy: 'http://127.0.0.1:7890', model: 'relay/m1', globalBookIds: ['bk1', 'gone'], media: { comfyUrl: 'http://192.168.1.5:8188', comfySteps: 30 } })
  await put(root, 'usage.jsonl', '{"a":1}\n{"a":2}\n')
  await put(root, 'access.json', { token: 'f'.repeat(36) })
  await put(root, 'logs/errors.jsonl', '{}\n')
  await put(root, 'forge/draft1.json', { id: 'draft1', card: {} })
  await put(root, 'forge/draft1.history/avatar-1.png', PNG)
}

test('ticking 密钥 brings 供应商; unknown kinds are dropped', () => {
  assert.deepEqual([...cleanInclude(['keys', 'nope', 'cards'])].sort(), ['cards', 'keys', 'providers'])
})

test('the survey lists each kind with its size; the export leaves this device\'s own things, keys and old pictures behind', async t => {
  const from = await start(t, filled)
  const { body: survey } = await from.call('/api/backup')
  const kinds = Object.fromEntries(survey.kinds.map(kind => [kind.key, kind]))
  assert.equal(kinds.cards.count, 1)
  assert.equal(kinds.chats.count, 2)
  assert.ok(kinds.history.bytes > 0)
  assert.deepEqual(survey.skippedProviders, ['本机'])
  assert.deepEqual(survey.defaultOff.sort(), ['history', 'keys'])

  const zip = await from.exported(['cards', 'chats', 'books', 'presets', 'lists', 'settings', 'providers', 'usage'])
  const file = path.join(from.dataRoot, 'out.zip')
  await writeFile(file, zip)
  const opened = await openZipFile(file)
  const names = opened.entries.map(entry => entry.name)
  const text = async name => (await opened.read(opened.entries.find(entry => entry.name === name))).toString('utf8')
  const manifest = JSON.parse(await text(BACKUP_MANIFEST))
  const providers = JSON.parse(await text('data/providers.json'))
  const settings = JSON.parse(await text('data/settings.json'))
  const chat = JSON.parse(await text('data/chats/chat1.json'))
  await opened.close()
  assert.equal(manifest.format, 'cicatavern-backup')
  assert.equal(manifest.keys, false)
  assert.ok(names.includes('data/cards/card1/scenes/s1.png'))
  assert.ok(names.includes('data/media/chat1/a.png'))
  assert.ok(names.includes('data/forge/draft1.json'))
  for (const gone of ['data/cards/card1/history.json', 'data/cards/card1/history/h1.png', 'data/media/chat1/old.png', 'data/forge/draft1.history/avatar-1.png', 'data/cards/card1/card.json.bak-options', 'data/access.json', 'data/logs/errors.jsonl', 'data/media/tts/cache.mp3', 'data/media/codex-work/x.txt', 'data/voice-keys.json']) {
    assert.ok(!names.includes(gone), gone)
  }
  assert.equal(chat.nodes.n1.media.images[0].history, undefined)
  assert.deepEqual(providers.providers.map(p => p.id), ['relay'])
  assert.equal(providers.providers[0].apiKey, '')
  assert.deepEqual(providers.providers[0].headers, { 'X-Title': 'cica' })
  assert.equal(settings.listen, undefined)
  assert.equal(settings.proxy, undefined)
  assert.equal(settings.replyLength, 777)
  assert.equal(settings.media.comfyUrl, undefined)
  assert.equal(settings.media.comfySteps, 30)
  assert.ok(!(await everything(file)).includes('sk-test-0123456789'))
  assert.ok(!(await everything(file)).includes('abcdef123456'))

  const keyFile = path.join(from.dataRoot, 'keys.zip')
  await writeFile(keyFile, await from.exported(['keys', 'history', 'cards', 'chats']))
  assert.ok((await everything(keyFile)).includes('sk-test-0123456789'))
  const again = await openZipFile(keyFile)
  const all = again.entries.map(entry => entry.name)
  await again.close()
  assert.ok(all.includes('data/voice-keys.json'))
  assert.ok(all.includes('data/cards/card1/history/h1.png'))
  assert.ok(all.includes('data/media/chat1/old.png'))
})

test('a fresh device takes everything; references to what did not come are let go of', async t => {
  const from = await start(t, filled)
  const to = await start(t)
  const zip = await from.exported(['cards', 'chats', 'history', 'books', 'presets', 'lists', 'settings', 'providers', 'keys', 'usage'])
  const { seen, report } = await to.imported(zip, ['cards', 'chats', 'history', 'lists', 'settings', 'providers', 'keys', 'usage'])
  const kinds = Object.fromEntries(seen.kinds.map(kind => [kind.key, kind]))
  assert.equal(kinds.cards.here, 0)
  assert.deepEqual(seen.keys.providers, ['中转'])
  assert.deepEqual(seen.keys.files, ['voice-keys.json'])

  assert.equal(report.added.cards, 1)
  assert.equal(report.added.chats, 1)
  assert.deepEqual(report.failed, [])
  assert.deepEqual(report.skipped.map(item => item.reason), ['no-card'])
  const root = to.dataRoot
  assert.ok(await has(root, 'cards/card1/scenes/s1.png'))
  assert.ok(await has(root, 'cards/card1/history/h1.png'))
  assert.ok(await has(root, 'media/chat1/old.png'))
  // 剧情向导's talk goes with its chat; the one of a chat left out stays behind.
  assert.equal((await read(root, 'guides/chat1.json')).turns[0].assistant.text, '在等你。')
  assert.ok(!(await has(root, 'guides/orphan.json')))
  assert.ok(await has(root, 'forge/draft1.history/avatar-1.png'))
  // Books and presets were not ticked: the card and chat let go of them.
  assert.deepEqual((await read(root, 'cards/card1/card.json')).worldbookIds, [])
  const chat = await read(root, 'chats/chat1.json')
  assert.equal(chat.presetId, null)
  assert.deepEqual(chat.bookIds, [])
  assert.equal(chat.updatedAt, '2026-11-02T00:00:00.000Z')
  const settings = await read(root, 'settings.json')
  assert.equal(settings.replyLength, 777)
  assert.equal(settings.listen, 'local')
  assert.equal(settings.model, 'relay/m1')
  assert.deepEqual(settings.globalBookIds, [])
  assert.equal(settings.media.comfySteps, 30)
  assert.notEqual(settings.media.comfyUrl, 'http://192.168.1.5:8188')
  const providers = (await read(root, 'providers.json')).providers
  assert.equal(providers.length, 1)
  assert.equal(providers[0].apiKey, 'sk-test-0123456789')
  assert.ok(await has(root, 'voice-keys.json'))
  assert.equal((await read(root, 'personas.json')).cards.card1, 'p2')
  assert.equal(await readFile(path.join(root, 'usage.jsonl'), 'utf8'), '{"a":1}\n{"a":2}\n')
  assert.ok(!(await has(root, 'access.json')) || (await read(root, 'access.json')).token !== 'f'.repeat(36))
  // The card list and the chat list read them.
  const cards = (await to.call('/api/cards')).body
  assert.ok((Array.isArray(cards) ? cards : cards.cards).some(card => card.id === 'card1'))
  assert.equal((await readdir(root)).includes('backup-upload') ? (await readdir(path.join(root, 'backup-upload'))).length : 0, 0)
})

test('keys stay behind unless ticked on import too, and books brought keep the chat\'s references', async t => {
  const from = await start(t, filled)
  const to = await start(t)
  const zip = await from.exported(['cards', 'chats', 'books', 'presets', 'providers', 'keys'])
  const { report } = await to.imported(zip, ['cards', 'chats', 'books', 'presets', 'providers'])
  assert.equal(report.added.books, 1)
  const providers = (await read(to.dataRoot, 'providers.json')).providers
  assert.equal(providers[0].apiKey, '')
  assert.ok(!(await has(to.dataRoot, 'voice-keys.json')))
  const chat = await read(to.dataRoot, 'chats/chat1.json')
  assert.equal(chat.presetId, 'p1')
  assert.deepEqual(chat.bookIds, ['bk1'])
  assert.ok(await has(to.dataRoot, 'preset-scripts/p1.json'))
  // No 抽图历史 ticked: the chat's old picture neither in its file nor its folder.
  assert.equal(chat.nodes.n1.media.images[0].history, undefined)
  assert.ok(!(await has(to.dataRoot, 'media/chat1/old.png')))
})

test('what the device has already is kept, or replaced when asked; its own settings stay unless replaced', async t => {
  const from = await start(t, filled)
  const mine = async root => {
    await put(root, 'cards/card1/card.json', { ...CARD('card1'), name: '这边的雨宿' })
    await put(root, 'cards/card1/mine.png', PNG)
    await put(root, 'settings.json', { replyLength: 300 })
  }
  const keep = await start(t, mine)
  const zip = await from.exported(['cards', 'settings'])
  const seen = (await keep.upload(zip)).body
  assert.equal(seen.kinds.find(kind => kind.key === 'cards').here, 1)
  assert.equal(seen.kinds.find(kind => kind.key === 'settings').here, 1)
  const kept = await keep.imported(zip, ['cards', 'settings'], 'keep')
  assert.equal(kept.report.kept.cards, 1)
  assert.equal((await read(keep.dataRoot, 'cards/card1/card.json')).name, '这边的雨宿')
  assert.equal((await read(keep.dataRoot, 'settings.json')).replyLength, 300)

  const replace = await start(t, mine)
  const replaced = await replace.imported(zip, ['cards', 'settings'], 'replace')
  assert.equal(replaced.report.replaced.cards, 1)
  assert.equal((await read(replace.dataRoot, 'cards/card1/card.json')).name, '雨宿')
  assert.ok(!(await has(replace.dataRoot, 'cards/card1/mine.png')))
  assert.equal((await read(replace.dataRoot, 'settings.json')).replyLength, 777)
})

test('a zip that is no backup, names paths outside its folders or brings broken cards is refused, passed over or reported', async t => {
  const to = await start(t)
  const notZip = await to.upload(Buffer.from('hello'))
  assert.equal(notZip.status, 400)
  const file = path.join(to.dataRoot, 'evil.zip')
  const out = createWriteStream(file)
  const zip = createZipWriter(async buffer => {
    if (!out.write(buffer)) await once(out, 'drain')
  })
  await zip.addBuffer(BACKUP_MANIFEST, Buffer.from(JSON.stringify({ format: 'cicatavern-backup', version: 1, include: ['cards'], items: { cards: [] } })))
  await zip.addBuffer('data/cards/x/../../../evil.txt', Buffer.from('no'))
  await zip.addBuffer('data/cards/ok/card.json', Buffer.from(JSON.stringify({ id: 'ok', name: '好卡', importedAt: '2026-01-01T00:00:00.000Z' })))
  // One card cut off, one that would break the card list: each reported, the rest still in.
  await zip.addBuffer('data/cards/broken/card.json', Buffer.from('{ not json'))
  await zip.addBuffer('data/cards/odd/card.json', Buffer.from(JSON.stringify({ id: 'odd', name: '没有时间' })))
  await zip.finish()
  out.end()
  await once(out, 'finish')
  const { seen, report } = await to.imported(await readFile(file), ['cards'])
  assert.equal(seen.unknown, 1)
  assert.equal(report.added.cards, 1)
  assert.deepEqual(report.failed.map(item => item.what).sort(), ['broken', 'odd'])
  assert.ok(!(await has(path.dirname(to.dataRoot), 'evil.txt')))
  assert.equal((await to.call('/api/cards')).status, 200)
})

test('zip64 throughout reads back, here and in its sizes', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zip64-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'z.zip')
  const out = createWriteStream(file)
  const zip = createZipWriter(async buffer => {
    if (!out.write(buffer)) await once(out, 'drain')
  }, { always64: true })
  await zip.addBuffer('a.json', Buffer.from(JSON.stringify({ text: '雨'.repeat(4000) })))
  await zip.addBuffer('b.png', PNG)
  await zip.addBuffer('empty.txt', Buffer.alloc(0))
  await zip.finish()
  out.end()
  await once(out, 'finish')
  const opened = await openZipFile(file)
  assert.deepEqual(opened.entries.map(entry => entry.name), ['a.json', 'b.png', 'empty.txt'])
  assert.equal(JSON.parse((await opened.read(opened.entries[0])).toString('utf8')).text.length, 4000)
  await opened.copyTo(opened.entries[1], path.join(dir, 'b.png'))
  assert.deepEqual(await readFile(path.join(dir, 'b.png')), PNG)
  await opened.copyTo(opened.entries[2], path.join(dir, 'e.txt'))
  assert.equal((await readFile(path.join(dir, 'e.txt'))).length, 0)
  await opened.close()
})
