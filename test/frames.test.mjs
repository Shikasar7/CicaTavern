// What card frames read and write besides the turns (server/frames.mjs): Tavern
// Helper's worldbook entries over this app's, a chat's own changes to a book,
// chat variables, and the prompt a card lays out for generateRaw.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookByName, bookNames, entryFromTh, fieldChange, parseUpdates, rawRequest, setFrameVars, thEntry, withChatChanges, writeChatBook } from '../server/frames.mjs'
import { normalizeBook } from '../server/worldbook.mjs'

const book = () => ({
  ...normalizeBook({
    entries: {
      0: { uid: 0, key: [], comment: 'user', content: '', constant: true, order: 100, position: 0 },
      7: { uid: 7, key: ['码头', '渡口'], keysecondary: ['夜'], selectiveLogic: 3, comment: '码头', content: '旧码头', order: 20, position: 4, depth: 2, role: 2, group: '地点', sticky: 2 },
    },
  }, '性斗学园', { standalone: true }),
  id: 'card-c1',
})

test('an entry as Tavern Helper sees it, and back, keeping what only this app keeps', () => {
  const [user, dock] = book().entries.map(thEntry)
  assert.deepEqual(dock.strategy, { type: 'selective', keys: ['码头', '渡口'], keys_secondary: { logic: 'and_all', keys: ['夜'] }, scan_depth: 'same_as_global' })
  assert.deepEqual(dock.position, { type: 'at_depth', role: 'assistant', depth: 2, order: 20 })
  assert.deepEqual([user.uid, user.name, user.strategy.type, dock.effect.sticky], [0, 'user', 'constant', 2])
  const back = entryFromTh({ content: '新码头', strategy: { keys: ['码头'] } }, book().entries[1])
  assert.deepEqual([back.uid, back.content, back.keys, back.secondaryKeys, back.selectiveLogic, back.position, back.order], ['7', '新码头', ['码头'], ['夜'], 3, 4, 20])
  assert.equal(back.extra.group, '地点', 'a field Tavern Helper does not have stays')
  const fresh = entryFromTh({ name: '新的', content: '<%= getvar("x") %>', strategy: { type: 'constant' } }, null, '9')
  assert.deepEqual([fresh.uid, fresh.comment, fresh.constant, fresh.enabled, fresh.hasScript], ['9', '新的', true, true, true])
})

test('a card writes a book: the chat keeps its changes, the book stays as it was', () => {
  const base = book()
  const chat = {}
  const entries = base.entries.map(thEntry)
  assert.equal(writeChatBook(chat, base, entries).prefix, false)
  assert.deepEqual(chat.bookOverlay, {}, 'reading it back changes nothing')

  const written = writeChatBook(chat, base, [{ ...entries[0], content: '玩家：阿明' }, entries[1], { name: '新条目', content: '新的' }])
  assert.equal(written.prefix, true, 'the constant entry is in the frozen prefix')
  assert.deepEqual(written.entries.map(e => [e.uid, e.name, e.content]), [[0, 'user', '玩家：阿明'], [7, '码头', '旧码头'], [8, '新条目', '新的']])
  assert.deepEqual(Object.keys(chat.bookOverlay['card-c1']), ['0', '8'])
  assert.equal(base.entries[0].content, '', 'the book itself is untouched')
  const [seen] = withChatChanges([base], chat)
  assert.deepEqual(seen.entries.map(e => e.content), ['玩家：阿明', '旧码头', '新的'])
  assert.equal(withChatChanges([base], {})[0], base, 'a chat without changes reads the book as is')

  writeChatBook(chat, base, [entries[1]])
  assert.deepEqual(chat.bookOverlay['card-c1'], { 0: null }, 'one taken out is remembered as gone')
  assert.deepEqual(withChatChanges([base], chat)[0].entries.map(e => e.uid), ['7'])
  assert.throws(() => writeChatBook(chat, base, 'x'), /列表/)
})

test('books by the names a card uses: its own, mounted, global', () => {
  const books = [book(), { id: 'b2', name: '城市', entries: [] }, { id: 'g1', name: '通用', entries: [] }]
  const card = { id: 'c1', worldbookIds: ['b2'] }
  assert.deepEqual(bookNames(books, card, ['g1']), { own: '性斗学园', mounted: ['城市'], global: ['通用'] })
  assert.equal(bookByName(books, '', card).id, 'card-c1')
  assert.equal(bookByName(books, '城市', card).id, 'b2')
  assert.equal(bookByName(books, '没有', card), null)
})

test('/setentryfield fields, chat variables, and the MVU parser', () => {
  assert.deepEqual(fieldChange('content', '阿明'), { content: '阿明' })
  assert.deepEqual(fieldChange('key', 'a, b，c'), { strategy: { keys: ['a', 'b', 'c'] } })
  assert.deepEqual(fieldChange('disable', 'true'), { enabled: false })
  assert.throws(() => fieldChange('nonsense', 'x'), /不支持/)
  assert.deepEqual(setFrameVars({}, { 档案: { 胜: 1 } }).frameVars, { 档案: { 胜: 1 } })
  assert.throws(() => setFrameVars({}, [1]), /JSON 对象/)
  assert.throws(() => setFrameVars({}, { big: 'x'.repeat(200_001) }), /太大/)
  assert.deepEqual(parseUpdates({ 好感: 1 }, "<UpdateVariable>_.set('好感', 1, 5);</UpdateVariable>"), { 好感: 5 })
})

test('generateRaw: the card\'s own order, placeholders filled, the system parts first', () => {
  const card = { description: '天海学园', personality: '', scenario: '开学日', mesExample: '' }
  const history = [{ role: 'assistant', content: '开场' }, { role: 'user', content: '你好' }, { role: 'assistant', content: '欢迎' }]
  const request = rawRequest({ card, persona: { description: '剑士' }, history, config: {
    user_input: '生成用户信息',
    max_chat_history: 1,
    ordered_prompts: [{ role: 'system', content: '你是设定助手' }, 'char_description', 'scenario', 'persona_description', 'chat_history', 'user_input'],
    overrides: { scenario: '' },
  } })
  assert.equal(request.system, '你是设定助手\n\n天海学园\n\n剑士', 'an override of "" drops the part')
  assert.deepEqual(request.messages, [{ role: 'assistant', content: '欢迎' }, { role: 'user', content: '生成用户信息' }])
  assert.deepEqual(rawRequest({ card, history: [], config: { user_input: '' , ordered_prompts: ['char_description'] } }).messages, [{ role: 'user', content: '继续。' }], 'never a request without a user turn')
})
