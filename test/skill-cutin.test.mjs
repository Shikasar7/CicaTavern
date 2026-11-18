// 技能特写: a skill's own picture in the rule book (web/shared/game/sheet.js skillPictures), kept and served by
// server/game.mjs, put by hand or drawn (server/http.mjs), left behind when the book travels in a card file.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cleanRulebook, cleanSkillPictures, skillsNamed } from '../web/shared/game/sheet.js'
import { writeCardPng } from '../server/cards.mjs'
import { createApp } from '../server/http.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const url = buffer => `data:image/png;base64,${buffer.toString('base64')}`
const CARD = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '灵契', description: '御兽', first_mes: '开始。', extensions: {} } }

test('a book keeps the pictures of its skills by name, and nothing that is not a picture file of its own', () => {
  assert.equal(cleanRulebook({}).skillPictures, undefined)
  assert.deepEqual(cleanRulebook({ skillPictures: { 灵焰汲取: 'skill-0123456789ab.png', 鬼火: '../game.json', '': 'skill-aa.png', ' 擒贼奇袭 ': 'skill-1.webp' } }).skillPictures, { 灵焰汲取: 'skill-0123456789ab.png', 擒贼奇袭: 'skill-1.webp' })
  assert.deepEqual(cleanSkillPictures(null), {})
  assert.deepEqual(cleanSkillPictures(['skill-1.png']), {})
})

test('every skill the book names, with whose it is', () => {
  const book = cleanRulebook({
    start: { skills: ['灵焰汲取', '擒贼奇袭'] },
    skills: { 灵焰汲取: 'strike', 擒王奇袭: 'strike' },
    companions: { 铃音狐: { keys: ['妖狐'], skills: { 鬼火连弹: 'flurry', 擒贼奇袭: 'strike' } } },
    forms: { 铃音狐: [{ name: '妖狐' }, { name: '九尾妖狐', at: { level: 5 }, skills: { 九尾迷界: 'rally' } }] },
  })
  const owners = Object.fromEntries(skillsNamed(book).map(({ name, owner }) => [name, owner]))
  assert.equal(owners['灵焰汲取'], '')
  // The player's comes first: a name both have is theirs.
  assert.equal(owners['擒贼奇袭'], '')
  assert.equal(owners['鬼火连弹'], '铃音狐')
  assert.equal(owners['九尾迷界'], '铃音狐')
  assert.equal(owners['擒王奇袭'], '')
  assert.deepEqual(skillsNamed({}), [])
})

async function setup(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'skill-cutin-'))
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
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) }
  }
  const card = (await call('/api/cards/import', { method: 'POST', body: { filename: '灵契.png', data: writeCardPng(PNG, CARD).toString('base64') } })).body
  return { call, id: card.id, dataRoot }
}

test('a skill picture is put, served, replaced and taken off; the old file goes each time', async t => {
  const { call, id, dataRoot } = await setup(t)
  const files = () => readdir(path.join(dataRoot, 'cards', id, 'skills')).catch(() => [])
  const first = (await call(`/api/cards/${id}/skills/image`, { method: 'PUT', body: { name: '灵焰汲取', image: url(PNG) } })).body
  assert.match(first.skillPictures['灵焰汲取'], /^skill-[0-9a-f]{12}\.png$/)
  const served = await call(`/api/skills/${id}/${first.skillPictures['灵焰汲取']}`)
  assert.equal(served.status, 200)
  assert.ok(served.body.equals(PNG))
  const second = (await call(`/api/cards/${id}/skills/image`, { method: 'PUT', body: { name: '灵焰汲取', image: url(PNG) } })).body
  assert.notEqual(second.skillPictures['灵焰汲取'], first.skillPictures['灵焰汲取'])
  assert.deepEqual(await files(), [second.skillPictures['灵焰汲取']])
  assert.equal((await call(`/api/skills/${id}/${first.skillPictures['灵焰汲取']}`)).status, 404)
  // The rest of the book is not touched by it, nor it by a change to the rest.
  await call(`/api/cards/${id}/game`, { method: 'PUT', body: { level: 'full' } })
  assert.equal((await call(`/api/cards/${id}/game`)).body.skillPictures['灵焰汲取'], second.skillPictures['灵焰汲取'])
  const gone = (await call(`/api/cards/${id}/skills/image`, { method: 'PUT', body: { name: '灵焰汲取', image: null } })).body
  assert.equal(gone.skillPictures, undefined)
  assert.deepEqual(await files(), [])
})

test('a newer version of the card keeps the skill and foe pictures, files and all', async t => {
  const { call, id } = await setup(t)
  const skill = (await call(`/api/cards/${id}/skills/image`, { method: 'PUT', body: { name: '灵焰汲取', image: url(PNG) } })).body.skillPictures['灵焰汲取']
  const foe = (await call(`/api/cards/${id}/foes/image`, { method: 'PUT', body: { name: '雾影', image: url(PNG) } })).body.foes['雾影'].file
  const newer = (await call('/api/cards/import', { method: 'POST', body: { filename: '灵契.png', data: writeCardPng(PNG, { ...CARD, data: { ...CARD.data, description: '御兽，第二版' } }).toString('base64') } })).body
  assert.notEqual(newer.id, id)
  assert.ok(newer.inherited)
  const book = (await call(`/api/cards/${newer.id}/game`)).body
  assert.equal(book.skillPictures['灵焰汲取'], skill)
  assert.equal(book.foes['雾影'].file, foe)
  assert.ok((await call(`/api/skills/${newer.id}/${skill}`)).body.equals(PNG))
  assert.ok((await call(`/api/foes/${newer.id}/${foe}`)).body.equals(PNG))
})

test('what is not a picture, no skill named, and a name outside the card are refused', async t => {
  const { call, id } = await setup(t)
  assert.equal((await call(`/api/cards/${id}/skills/image`, { method: 'PUT', body: { name: '灵焰汲取', image: 'data:text/plain;base64,aGk=' } })).status, 400)
  assert.equal((await call(`/api/cards/${id}/skills/image`, { method: 'PUT', body: { name: '  ', image: url(PNG) } })).status, 400)
  assert.equal((await call(`/api/skills/${id}/..%2Fgame.json`)).status, 404)
  // Drawing one is for a skill the rules have.
  assert.equal((await call(`/api/cards/${id}/skills/draw`, { method: 'POST', body: { name: '没有的技能' } })).status, 404)
})
