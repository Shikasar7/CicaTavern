// 创作角色卡 → 方案 → 状态栏 → 定制外观: a look asked for the bar of the card being made. It waits beside the draft,
// is the draft's once put on (a plan written again wears it too), goes into the saved card, and one put on the saved
// card elsewhere stays when the draft has none of its own.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createForge } from '../server/forge/index.mjs'
import { normalizePlan, withCardOptions } from '../server/forge/prompts.mjs'
import { newCard } from '../server/forge/write.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'
import { cleanStatusSpec } from '../web/shared/status.js'

const PLAN = {
  name: '雨宿',
  summary: '深夜便利店里，只在雨夜出现的女孩。',
  user_role: { identity: '夜班店员' },
  world: { kind: '真实', overview: '多雨的港城', places: [{ name: '晴空便利店', description: '24 小时便利店' }] },
  characters: [{ name: '林小雨', kind: 'core', aliases: ['小雨'], gender: '女', identity: '雨女', relationship: '下雨就来避雨', personality: { base: '孤独', main: ['温柔'] } }],
  style: { perspective: '第三人称' },
  tracking: { enabled: true, variables: [
    { path: '林小雨.好感度', label: '好感', type: 'number', initial: '10', range: '0~100', check: '真心相待时 +2' },
    { path: '林小雨.心情', label: '心情', type: 'string', initial: '平静', show: 'badge', check: '随剧情变' },
  ] },
  greetings: [{ title: '第一场雨', start: '初遇', scene: '凌晨两点', situation: '她推门进来', state: {} }],
  avatar: { character: '林小雨' },
}
const CSS = '.status-bar { border-radius: 4px; border: 1px solid var(--accent) }\n.status-title::before { content: "◆ " }'
const PALETTE = { bg: '#101820', ink: '#f2f2f2', accent: '#e0a030' }
const ANSWER = `<reply>雨夜的橱窗。</reply>\n<name>雨夜橱窗</name>\n<palette>${JSON.stringify(PALETTE)}</palette>\n<css>\n${CSS}\nbody { display: none }\n</css>`
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

async function setup(t, { format = 'mvu-ui' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-skin-'))
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: ['writer'] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/writer` })
  const recorded = []
  const forge = createForge(store, { ledger: { recordTurn: async chat => recorded.push(chat) } })
  const plan = withCardOptions(normalizePlan(PLAN), { format })
  const card = { ...newCard(plan), writtenAt: new Date().toISOString() }
  card.greetings[0].text = '雨下起来了。'
  const now = new Date().toISOString()
  const file = path.join(root, 'forge', 'lookdraft.json')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ id: 'lookdraft', createdAt: now, updatedAt: now, stage: 'polish', model: '', rounds: [{ user: { text: '雨夜', picks: [] }, assistant: null }], brief: { title: '雨宿', readiness: 1 }, options: { format }, plan, card }))
  const asked = async body => {
    let view = await forge.skinAsk('lookdraft', body)
    for (let i = 0; i < 300 && view.job; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      view = await forge.skinGet('lookdraft')
    }
    return view
  }
  return { forge, store, seen, recorded, asked, file, plan }
}

test('a look is asked for the plan\'s bar, put on the draft, and stays on a plan written again', async t => {
  const { forge, seen, recorded, asked, file, plan } = await setup(t)
  const before = await forge.skinGet('lookdraft')
  assert.equal(before.skin, null)
  assert.equal(before.estimate.ready, true)
  assert.equal(seen.length, 0, 'reading the page sends nothing')

  const drafted = await asked({ wish: '雨夜的橱窗' })
  assert.equal(drafted.error, '')
  assert.deepEqual({ name: drafted.skin.name, css: drafted.skin.css, palette: drafted.skin.palette }, { name: '雨夜橱窗', css: CSS, palette: PALETTE })
  const sent = seen[0].messages.at(-1).content
  assert.match(sent, /<card name="雨宿">\n深夜便利店里，只在雨夜出现的女孩。/)
  assert.match(sent, /好感 · meter · 10\n {2}心情 · badge · 平静/)
  assert.match(sent, /开场白的开头：雨下起来了。/)
  assert.match(sent, /用户想要的样子：雨夜的橱窗$/)
  assert.equal(recorded.at(-1).title, '创作：雨宿')
  // Nothing is the draft's yet, and the drafts listed are still one.
  assert.equal((await forge.get('lookdraft')).plan.status.skin, undefined)
  assert.equal((await forge.list()).length, 1)

  // Put on: the plan wears it, with its three colors.
  const worn = await forge.update('lookdraft', { look: { palette: drafted.skin.palette, skin: { name: drafted.skin.name, css: `${drafted.skin.css}\nhtml { color: red }` } } })
  assert.deepEqual(worn.plan.status.skin, { name: '雨夜橱窗', css: CSS })
  assert.deepEqual(worn.plan.status.palette, PALETTE)
  // The colors changed by hand under it are the look's.
  const tinted = await forge.update('lookdraft', { tracking: { palette: { ...PALETTE, accent: '#ffcc00' } } })
  assert.equal(tinted.plan.status.palette.accent, '#ffcc00')
  // A plan written again (as a revision is) has no look of its own: the draft's goes on it.
  const kept = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...kept, plan }))
  const again = await forge.update('lookdraft', { model: '' })
  assert.deepEqual(again.plan.status.skin, { name: '雨夜橱窗', css: CSS })
  assert.equal(again.plan.status.palette.accent, '#ffcc00')

  // Taken off: the bar is as the picks have it.
  const off = await forge.update('lookdraft', { look: null })
  assert.equal(off.plan.status.skin, undefined)
  assert.equal(off.plan.status.palette, undefined)
  assert.equal(off.plan.status.theme, 'plain')
  // The draft beside the draft can be dropped; a deleted draft takes it along.
  assert.equal((await forge.skinDrop('lookdraft')).skin, null)
  await asked({})
  await forge.remove('lookdraft')
  await assert.rejects(() => forge.skinGet('lookdraft'), /不存在/)
})

test('a card with no bar of its own to dress is not asked about', async t => {
  const { forge, seen } = await setup(t, { format: 'text' })
  await assert.rejects(() => forge.skinAsk('lookdraft', {}), /没有可以设计外观的状态栏/)
  assert.equal(seen.length, 0)
})

test('the saved card wears the draft\'s look; one put on elsewhere stays when the draft has none', async t => {
  const { forge, store } = await setup(t)
  await forge.update('lookdraft', { look: { palette: PALETTE, skin: { name: '雨夜橱窗', css: CSS } } })
  const first = await forge.saveCard('lookdraft', { avatar: PNG })
  const saved = await store.getCard(first.card.id)
  assert.deepEqual(saved.statusBar.skin, { name: '雨夜橱窗', css: CSS })
  assert.deepEqual(saved.statusBar.palette, PALETTE)
  // SillyTavern's copy wears it too.
  const copy = card => card.regexScripts.find(item => item.id === 'cicatavern-status-bar').replaceString
  assert.match(copy(saved), /\.skin-[0-9a-f]{8}\.status-bar \{ border-radius: 4px/)

  // Taken off in the draft and saved again: gone from the card too (it was this draft's).
  await forge.update('lookdraft', { look: null })
  await forge.saveCard('lookdraft', { avatar: PNG })
  assert.equal((await store.getCard(first.card.id)).statusBar.skin, undefined)
  assert.doesNotMatch(copy(await store.getCard(first.card.id)), /skin-/)

  // Put on the saved card elsewhere (修改角色卡): saving the draft again leaves it on.
  const card = await store.getCard(first.card.id)
  const other = { name: '借书卡', css: '.status-bar { border-radius: 0 }' }
  await store.saveCard({ ...card, statusBar: cleanStatusSpec({ ...card.statusBar, palette: { bg: '#f3e9cf', ink: '#3a2a16', accent: '#a8322a' }, skin: other }) })
  await forge.saveCard('lookdraft', { avatar: PNG })
  const after = await store.getCard(first.card.id)
  assert.deepEqual(after.statusBar.skin, other)
  assert.equal(after.statusBar.palette.bg, '#f3e9cf')
  assert.deepEqual(after.statusBar.fields.filter(field => field.show !== 'hidden').map(field => field.path), ['林小雨.好感度', '林小雨.心情'])
  // And so does SillyTavern's copy, written again after the look came back on.
  assert.match(copy(after), /\.skin-[0-9a-f]{8}\.status-bar \{ border-radius: 0/)
  // The draft's own look, put on again, goes over it.
  await forge.update('lookdraft', { look: { palette: PALETTE, skin: { name: '雨夜橱窗', css: CSS } } })
  await forge.saveCard('lookdraft', { avatar: PNG })
  assert.equal((await store.getCard(first.card.id)).statusBar.skin.name, '雨夜橱窗')
})
