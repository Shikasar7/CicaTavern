// 只读变量 and 变量模板 (创作角色卡's plan page). A variable marked read-only is told to the model as one not to
// write, and a reply that writes it anyway has it put back; the card carries which they are. A template is a set of
// variables for a kind of story, as a plan keeps them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cleanReadOnly, normalizeCard, sillyTavernCard } from '../server/cards.mjs'
import { activePath, createChat } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { cleanVariables, editTracking, normalizePlan } from '../server/forge/prompts.mjs'
import { cardJson, newCard } from '../server/forge/write.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { applyStateUpdates, keepReadOnly } from '../server/state.mjs'
import { createStore } from '../server/store.mjs'
import { VARIABLE_TEMPLATES, templateVariables } from '../web/shared/status.js'

const PLAN = {
  name: '雨宿',
  summary: '深夜便利店里，只在雨夜出现的女孩。',
  user_role: { identity: '夜班店员' },
  world: { kind: '真实', overview: '多雨的港城', places: [{ name: '晴空便利店', description: '24 小时便利店' }] },
  characters: [{ name: '林小雨', kind: 'core', gender: '女', identity: '雨女', relationship: '下雨就来避雨', personality: { base: '孤独', main: ['温柔'] } }],
  style: { perspective: '第三人称' },
  tracking: { enabled: true, variables: [
    { path: '林小雨.好感度', label: '好感', type: 'number', initial: '10', range: '0~100', check: '真心相待时 +2' },
    { path: '林小雨.好感上限', label: '上限', type: 'number', initial: '100', locked: true, check: '写了也不算' },
    { path: '<user>.背包', label: '背包', type: 'book', columns: ['数量'], initial: [], locked: true, check: '得到加一行' },
  ] },
  greetings: [{ title: '第一场雨', start: '初遇', scene: '凌晨两点', situation: '她推门进来', state: {} }],
  avatar: { character: '林小雨' },
}

test('a plan keeps which variables are read-only; the card says so to the model and carries their paths', () => {
  const plan = normalizePlan(PLAN)
  const [liking, cap, bag] = plan.tracking.variables
  assert.deepEqual([liking.locked, cap.locked, bag.locked], [undefined, true, undefined], 'a book is rows that come and go')
  assert.equal(cleanVariables([{ path: 'a.b', locked: 'yes' }])[0].locked, undefined, 'only true counts')
  // Changed by hand in the plan page: the mark goes with the rest of the variable.
  const edited = editTracking(plan, { variables: plan.tracking.variables.map(v => ({ ...v, locked: v.path === '林小雨.好感度' })) })
  assert.deepEqual(edited.tracking.variables.map(v => v.locked), [true, undefined, undefined])

  const card = newCard(plan)
  const rules = card.entries.find(entry => entry.part === 'rules').content
  assert.match(rules, /好感上限: 只读：故事里不会变，不要写进更新/)
  assert.match(rules, /好感度:\n\s+type: number\n\s+range: 0~100\n\s+check:\n\s+- 真心相待时 \+2/)
  const format = card.entries.find(entry => entry.part === 'format').content
  assert.match(format, /"path": "\/林小雨\/好感度"/, 'the example changes something that may change')
  const raw = cardJson(plan, { ...card, greetings: ['雨又下起来了。'] })
  assert.deepEqual(raw.data.extensions.cicatavern.read_only, ['林小雨.好感上限'])
  // Read from the file, kept on the card, and written back out.
  const kept = normalizeCard(raw)
  assert.deepEqual(kept.readOnly, ['林小雨.好感上限'])
  assert.deepEqual(sillyTavernCard(kept, raw).data.extensions.cicatavern.read_only, ['林小雨.好感上限'])
  assert.deepEqual(normalizeCard({ spec: 'chara_card_v2', data: { name: '别的卡', description: 'x' } }).readOnly, [])
  assert.deepEqual(cleanReadOnly(['a.b', ' a.b ', '', 7, 'c[0].d']), ['a.b', 'c.0.d'])
  // English, said in English.
  const english = newCard(normalizePlan({ ...PLAN, tracking: { enabled: true, variables: [{ path: 'Rain.cap', type: 'number', initial: '100', locked: true }] } }, { language: 'English' }))
  assert.match(english.entries.find(entry => entry.part === 'rules').content, /cap: "?read-only: the story never changes it/)
})

test('a reply that writes a read-only variable has it put back, whatever way it wrote it', () => {
  const before = { 林小雨: { 好感度: 10, 好感上限: [100, '好感最多到这里'] }, 主角: { 称号: '店员' } }
  const paths = ['林小雨.好感上限', '主角.称号', '没有的.变量']
  const patch = applyStateUpdates(before, '正文。\n<state>{"林小雨": {"好感度": 12, "好感上限": 200}, "主角": {"称号": "店长"}}</state>')
  assert.equal(patch.state.林小雨.好感上限, 200)
  const held = keepReadOnly(before, patch, paths)
  assert.deepEqual(held.state, { 林小雨: { 好感度: 12, 好感上限: [100, '好感最多到这里'] }, 主角: { 称号: '店员' } })
  assert.deepEqual(held.readOnlyKept, ['林小雨.好感上限', '主角.称号'])
  assert.equal(patch.state.林小雨.好感上限, 200, 'what it was given is not changed')
  // MVU's JSON Patch and its calls.
  const json = applyStateUpdates(before, '<UpdateVariable><JSONPatch>[{"op": "replace", "path": "/林小雨/好感上限", "value": 999}, {"op": "replace", "path": "/林小雨/好感度", "value": 15}]</JSONPatch></UpdateVariable>')
  const heldJson = keepReadOnly(before, json, paths)
  assert.deepEqual([heldJson.state.林小雨.好感度, heldJson.state.林小雨.好感上限], [15, [100, '好感最多到这里']])
  assert.ok(!heldJson.changes.some(change => /好感上限/.test(change)), 'not listed as changed')
  const call = keepReadOnly(before, applyStateUpdates(before, "<UpdateVariable>_.set('主角.称号', '店员', '老板');</UpdateVariable>"), paths)
  assert.equal(call.state.主角.称号, '店员')
  // Taken out by the reply: back as well.
  const removed = keepReadOnly(before, applyStateUpdates(before, '<state>{"主角": {"称号": null}}</state>'), paths)
  assert.equal(removed.state.主角.称号, '店员')
  // Nothing read-only written, or no list: the update as it is.
  const plain = applyStateUpdates(before, '<state>{"林小雨": {"好感度": 11}}</state>')
  assert.equal(keepReadOnly(before, plain, paths), plain)
  assert.equal(keepReadOnly(before, patch, []), patch)
  assert.equal(keepReadOnly(before, patch, undefined), patch)
  // One the chat did not have yet may be written once.
  const late = keepReadOnly({ 林小雨: { 好感度: 10 } }, applyStateUpdates({ 林小雨: { 好感度: 10 } }, '<state>{"林小雨": {"好感上限": 100}}</state>'), paths)
  assert.equal(late.state.林小雨.好感上限, 100)
})

test('in a chat: the turn keeps what the card marks read-only', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-readonly-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* the request is not looked at */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '她笑了。\n<state>{"好感度": 14, "好感上限": 500}</state>' }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: [{ id: 'm1' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off', autoFillUpdate: false })
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林小雨', description: '雨女。', first_mes: '雨又下起来了。', extensions: { cicatavern: { read_only: ['好感上限'] } }, character_book: { entries: [{ keys: [], content: '好感度: 10\n好感上限: 100', constant: true, enabled: false, comment: '[initvar]初始变量' }] } } })
  await store.saveCard(card)
  const engine = createEngine(store, { proxy: null })
  const chat = await createChat(store, card.id)
  await engine.runTurn(chat.id, { parentId: activePath(await store.getChat(chat.id)).at(-1).id, input: '你好' }, () => {})
  const reply = activePath(await store.getChat(chat.id)).at(-1)
  assert.deepEqual(reply.state, { 好感度: 14, 好感上限: 100 })
  assert.ok(!reply.stateChanges.includes('好感上限'))
})

test('变量模板: every set is variables a plan takes as they are, in the card\'s language', () => {
  assert.deepEqual(VARIABLE_TEMPLATES, ['romance', 'adventure', 'mystery', 'survival', 'growth', 'business'])
  for (const id of VARIABLE_TEMPLATES) {
    for (const english of [false, true]) {
      const variables = templateVariables(id, { character: english ? 'Rain' : '林小雨', english })
      assert.ok(variables.length >= 4, `${id} has enough to start from`)
      const cleaned = cleanVariables(variables)
      assert.equal(cleaned.length, variables.length, `${id}: none dropped, no path twice`)
      for (const [i, variable] of cleaned.entries()) {
        assert.equal(variable.path, variables[i].path)
        assert.deepEqual([variable.type, variable.show, variable.check], [variables[i].type, variables[i].show, variables[i].check])
        assert.ok(variable.label && variable.check, `${variable.path} says what it is and how it changes`)
        if (variable.show === 'meter') assert.match(variable.range, /^\d+~\d+$/)
        if (english) assert.doesNotMatch(JSON.stringify(variable), /[一-鿿]/, `${variable.path} is in English`)
      }
    }
  }
  const romance = templateVariables('romance', { character: '林小雨' })
  assert.deepEqual(romance.map(v => v.path), ['林小雨.好感度', '林小雨.关系', '林小雨.心情', '主角.约定'])
  assert.deepEqual(templateVariables('romance', { character: 'Rain', english: true }).map(v => v.path), ['Rain.affection', 'Rain.bond', 'Rain.mood', 'Protagonist.promises'])
  // A card with no main character gets the set without what is theirs.
  assert.deepEqual(templateVariables('romance', {}).map(v => v.path), ['主角.约定'])
  assert.deepEqual(templateVariables('nonsense', { character: '林小雨' }), [])
  assert.deepEqual(templateVariables('adventure', { character: '林小雨' }).find(v => v.type === 'book').columns, ['数量', '说明'])
})
