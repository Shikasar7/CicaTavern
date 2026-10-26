// 屏蔽词 (设置 → 屏蔽词): words taken out of, masked in or swapped in what is sent
// to the model (the system prompt, lore, history and the new message) and what
// the page shows, with the stored text left as written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { blockRequest, cleanBlockWords } from '../server/blockwords.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, createChat } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { cleanMedia, createMedia } from '../server/media.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'
import { normalizeBook } from '../server/worldbook.mjs'
import { blockReport, blockText, normalizeBlockWords, promptRules } from '../web/shared/blockwords.js'
import { displayOf, streamingText, useBlockWords } from '../web/render.js'
import { testSubscription } from './support/subscription.mjs'

const words = list => normalizeBlockWords(list.map((word, i) => ({ id: `w${i}`, ...word })))
const sent = (text, list) => blockText(text, list, { target: 'prompt' })
const shown = (text, list) => blockText(text, list, { target: 'display' })

test('each entry removes, masks or swaps its word, and a switched-off one does nothing', () => {
  const list = words([{ word: '猫', mode: 'remove' }, { word: '雨伞', mode: 'mask' }, { word: '咖啡', mode: 'replace', replacement: '茶' }, { word: '雪', mode: 'replace', replacement: '霜', disabled: true }])
  assert.equal(sent('猫把雨伞推倒了，咖啡洒在雪地上。', list), '把**推倒了，茶洒在雪地上。')
  const report = blockReport('猫猫和咖啡', list, { target: 'prompt' })
  assert.deepEqual(report, { text: '和茶', hits: 3 })
  assert.equal(normalizeBlockWords([{ word: ' 猫 ', mode: 'replace', replacement: '' }])[0].mode, 'remove', '换成 with nothing is 去掉')
  assert.equal(normalizeBlockWords([{ word: '  ' }, { mode: 'mask' }]).length, 0, 'an entry needs a word')
})

test('case, whole words, and exceptions for Chinese, which has no spaces between words', () => {
  const english = words([{ word: 'Cat', mode: 'replace', replacement: 'fox', wholeWord: true }])
  assert.equal(sent('A cat, a CAT and a catalog.', english), 'A fox, a fox and a catalog.', 'not case-sensitive unless ticked; catalog is another word')
  const exact = words([{ word: 'Cat', mode: 'remove', caseSensitive: true }])
  assert.equal(sent('Cat cat', exact), ' cat')
  // 整词 has nothing to look at between Chinese characters: the word is found anywhere,
  // and a longer word that holds it is spared only when listed.
  const chinese = words([{ word: '猫', mode: 'replace', replacement: '狐', wholeWord: true, exceptions: ['熊猫', '猫头鹰', '狗'] }])
  assert.equal(sent('小猫、熊猫和猫头鹰', chinese), '小狐、熊猫和猫头鹰')
  assert.deepEqual(normalizeBlockWords([{ word: '猫', exceptions: ['熊猫', '熊猫', ' ', 3] }])[0].exceptions, ['熊猫'])
  // A word next to Chinese text still counts as whole: its edge is a letter, the neighbour is not.
  assert.equal(sent('我养了cat。', english), '我养了fox。')
})

test('the longest word goes first, and no word ever matches what another was swapped for', () => {
  const list = words([{ word: '猫', mode: 'replace', replacement: '小猫' }, { word: '小', mode: 'mask' }, { word: '黑猫', mode: 'replace', replacement: '乌鸦' }])
  assert.equal(sent('小黑猫和猫', list), '*乌鸦和小猫', '黑猫 before 猫; the 小 that 猫 became stays')
  const pushed = words([{ word: '的', mode: 'remove' }, { word: '好人', mode: 'replace', replacement: '坏人' }])
  assert.equal(sent('好的人', pushed), '好人', 'text a removal pushed together is not matched again')
  assert.equal(sent('a.b*c', words([{ word: '.b*', mode: 'remove' }])), 'ac', 'a word is literal, not a pattern')
})

test('an entry changes what is sent, what is shown, or both', () => {
  const list = words([{ word: '猫', mode: 'replace', replacement: '狐', scope: 'prompt' }, { word: '狗', mode: 'replace', replacement: '狼', scope: 'display' }, { word: '鸟', mode: 'remove' }])
  assert.equal(sent('猫狗鸟', list), '狐狗')
  assert.equal(shown('猫狗鸟', list), '猫狼')
  assert.equal(promptRules(list), promptRules(words([{ word: '猫', mode: 'replace', replacement: '狐' }, { word: '鸟', mode: 'remove', scope: 'prompt' }])), 'the same words to send are the same send')
  assert.notEqual(promptRules(list), promptRules(words([{ word: '猫', mode: 'replace', replacement: '狐', scope: 'prompt' }])))
})

test('a model request: the system prompt and every message, the cache marks kept', () => {
  const list = words([{ word: '猫', mode: 'replace', replacement: '狐' }])
  const request = { system: '林雪养了一只猫。', messages: [{ role: 'user', content: '猫呢？', cache: true }, { role: 'assistant', content: [{ type: 'text', text: '猫睡了。' }, { type: 'image', source: 'x' }] }], maxTokens: 9 }
  assert.deepEqual(blockRequest(request, list), {
    system: '林雪养了一只狐。',
    messages: [{ role: 'user', content: '狐呢？', cache: true }, { role: 'assistant', content: [{ type: 'text', text: '狐睡了。' }, { type: 'image', source: 'x' }] }],
    maxTokens: 9,
  })
  assert.equal(blockRequest(request, words([{ word: '猫', scope: 'display' }])), request, 'display-only words leave it as it is')
})

test('the page: a reply shown without its words before the display regex, and an unfinished word held back while it streams', () => {
  const list = words([{ word: '猫', mode: 'replace', replacement: '狐' }, { word: '咖啡', mode: 'remove', scope: 'prompt' }])
  useBlockWords(list, blockText)
  try {
    const scripts = [{ id: 's', scriptName: '', findRegex: '/狐/g', replaceString: '<b>狐</b>', trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, substituteRegex: 0, minDepth: null, maxDepth: null }]
    assert.equal(displayOf({ role: 'assistant', raw: '猫喝了咖啡。', state: {} }, { scripts, names: { char: '林雪', user: '你' }, depth: 0 }), '<b>狐</b>喝了咖啡。', 'the card regex sees the swapped word')
    assert.equal(displayOf({ role: 'user', text: '猫呢', state: {} }, { scripts: [], names: { char: '林雪', user: '你' }, depth: 0 }), '狐呢')
    useBlockWords(words([{ word: '咖啡豆', mode: 'remove' }]), blockText)
    assert.equal(streamingText('她磨了咖啡'), '她磨了', 'the end may still become 咖啡豆')
    assert.equal(streamingText('她磨了咖啡豆。'), '她磨了。')
  } finally {
    useBlockWords([], null)
  }
})

test('stored entries: each gets an id of its own; limits', () => {
  const cleaned = cleanBlockWords([{ id: 'same', word: '猫' }, { id: 'same', word: '狗' }, { word: '' }])
  assert.deepEqual(cleaned.map(w => w.word), ['猫', '狗'])
  assert.equal(cleaned[0].id, 'same')
  assert.notEqual(cleaned[1].id, 'same')
  assert.throws(() => cleanBlockWords('猫'), /格式/)
  assert.throws(() => cleanBlockWords(Array.from({ length: 501 }, (_, i) => ({ word: `w${i}` }))), /最多/)
  assert.throws(() => cleanBlockWords([{ word: '猫'.repeat(201) }]), /太长了/)
})

const textOf = content => (typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''))

/** An OpenAI-compatible model that answers `replies` in turn and keeps each request it was sent. */
async function fakeModel(t, replies) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    const text = replies[Math.min(requests.length, replies.length) - 1]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests }
}

/** A card whose description (the system prompt) and lorebook entry both say 猫, and a chat with it. */
async function setup(t, replies, { subscription = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-blockwords-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const store = createStore(root)
  await store.init()
  const fake = await fakeModel(t, replies)
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: fake.baseURL, apiKey: 'sk-test', models: [{ id: 'm1' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: subscription ? 'sonnet' : `${provider.id}/m1`, subscription: subscription ? 'on' : 'off' })
  const book = normalizeBook({ name: '雪国', entries: { 0: { uid: 0, key: ['灯笼'], content: '灯笼上画着一只猫。' } } }, 'x', { standalone: true })
  await store.saveBook(book)
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', description: '林雪养了一只猫。', first_mes: '雪下了一整夜。' } })
  card.worldbookIds = [book.id]
  await store.saveCard(card)
  const engine = createEngine(store, { proxy: null }, null, { subscription: subscription?.(store, root) ?? null })
  const chat = await createChat(store, card.id)
  const turn = async input => {
    const tip = activePath(await store.getChat(chat.id)).at(-1)
    await engine.runTurn(chat.id, { parentId: tip.id, input }, () => {})
    return activePath(await store.getChat(chat.id))
  }
  return { root, store, engine, chat, turn, fake }
}

test('a turn sends the card, the lore, the input and the history without the word; the chat keeps what was written; switched off, it comes back', async t => {
  const { store, turn, fake } = await setup(t, ['猫在窗台上睡着了。', '雪停了。', '天亮了。'])
  await store.saveBlockWords(cleanBlockWords([{ word: '猫', mode: 'replace', replacement: '狐狸' }]))

  let nodes = await turn('灯笼亮了，猫呢？')
  const first = JSON.stringify(fake.requests[0].messages)
  assert.ok(!first.includes('猫'), 'nothing sent has the word')
  assert.match(first, /林雪养了一只狐狸/, 'the card in the system prompt')
  assert.match(first, /灯笼上画着一只狐狸/, 'the lorebook entry the keyword brought in')
  assert.match(first, /灯笼亮了，狐狸呢？/, 'the input')
  const [, user, reply] = nodes
  assert.equal(user.text, '灯笼亮了，猫呢？', 'the input is kept as typed')
  assert.equal(reply.text, '猫在窗台上睡着了。', 'the reply is kept as the model wrote it')

  nodes = await turn('嗯')
  const second = fake.requests[1].messages
  assert.ok(!JSON.stringify(second).includes('猫'))
  assert.ok(second.some(m => m.role === 'assistant' && textOf(m.content).includes('狐狸在窗台上睡着了')), 'the earlier reply, swapped')
  assert.deepEqual(second.slice(0, 2).map(m => textOf(m.content)), fake.requests[0].messages.slice(0, 2).map(m => textOf(m.content)), 'the prefix is sent as before, so the cache hits')

  const words = await store.getBlockWords()
  await store.saveBlockWords(words.map(w => ({ ...w, disabled: true })))
  await turn('然后呢')
  const third = JSON.stringify(fake.requests[2].messages)
  assert.match(third, /林雪养了一只猫/, 'switched off, the card says 猫 again')
  assert.match(third, /猫在窗台上睡着了/)
  assert.match(third, /灯笼亮了，猫呢？/)
  assert.ok(!third.includes('狐狸'))
})

test('saving says where the open chat\'s cache is written again; the prompt view and the preview show what is sent', async t => {
  const { root, store, chat, turn } = await setup(t, ['夜深了。', '一只黑鸟落在窗台上。', '雪停了。'])
  await turn('你好')
  await turn('窗外有什么？')
  await turn('然后呢')
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(() => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const save = list => call('/api/blockwords', { method: 'PUT', body: { words: list, chatId: chat.id } })

  assert.deepEqual((await call('/api/blockwords')).body, { words: [] })
  let saved = await save([{ word: '黑鸟', mode: 'replace', replacement: '乌鸦' }])
  assert.equal(saved.status, 200)
  assert.equal(saved.body.words[0].word, '黑鸟')
  assert.deepEqual(saved.body.impact, { prompt: true, chat: true, system: false, turnsAgo: 1, subscription: false }, 'only the second reply has it: from one turn back')
  saved = await save([...saved.body.words, { word: '猫', mode: 'remove' }])
  assert.equal(saved.body.impact.system, true, 'the card in the system prompt has it: all of it again')
  saved = await save(saved.body.words.map(w => (w.word === '猫' ? { ...w, scope: 'display' } : w)))
  assert.equal(saved.body.impact.system, true, 'made display-only, the card is sent as written again')
  saved = await save([...saved.body.words, { word: '狼', mode: 'remove' }])
  assert.deepEqual(saved.body.impact, { prompt: true, chat: true, system: false, turnsAgo: null, subscription: false }, 'a word the chat never sends')
  saved = await save([...saved.body.words, { word: '雪', mode: 'mask', scope: 'display' }])
  assert.deepEqual(saved.body.impact, { prompt: false }, 'display only: the cache is untouched')
  assert.equal((await call('/api/blockwords', { method: 'PUT', body: { words: 'x' } })).status, 400)

  await store.saveBlockWords(cleanBlockWords([{ word: '猫', mode: 'replace', replacement: '狐狸' }, { word: '黑鸟', mode: 'replace', replacement: '乌鸦' }]))
  const prompt = (await call(`/api/chats/${chat.id}/prompt`)).body
  assert.match(prompt.systemPrompt, /林雪养了一只狐狸/)
  assert.ok(!prompt.systemPrompt.includes('猫'))
  const tip = activePath(await store.getChat(chat.id)).at(-1)
  const preview = (await call(`/api/chats/${chat.id}/preview`, { method: 'POST', body: { parentId: tip.id, input: '灯笼下的猫' } })).body
  assert.match(preview.prompt, /灯笼下的狐狸/)
  assert.match(preview.prompt, /灯笼上画着一只狐狸/)
})

test('a card UI\'s own model call gets back its text with the words that change what is shown', async t => {
  const { store, engine, chat, turn } = await setup(t, ['夜深了。', '猫跳上了桌子。'])
  await turn('你好')
  await store.saveBlockWords(cleanBlockWords([{ word: '猫', mode: 'replace', replacement: '狐狸', scope: 'display' }]))
  const text = await engine.frameGenerate(chat.id, { raw: false, config: { user_input: '描述一下' } }, new AbortController().signal, () => {})
  assert.equal(text, '狐狸跳上了桌子。')
})

test('the helper model writing a picture\'s prompt gets the card and the passage without the word', async t => {
  const { store, chat, fake } = await setup(t, ['a fox sleeping on a table'])
  const [provider] = await store.getProviders()
  await store.saveSettings({ media: cleanMedia({ helperModel: `${provider.id}/m1` }) })
  await store.saveBlockWords(cleanBlockWords([{ word: '猫', mode: 'replace', replacement: '狐狸' }]))
  const fresh = await store.getChat(chat.id)
  await createMedia(store).writeImagePrompt(fresh, fresh.nodes.root, { reply: '猫在桌上睡着了。', input: '' })
  const sent = JSON.stringify(fake.requests.at(-1).messages)
  assert.ok(!sent.includes('猫'))
  assert.match(sent, /林雪养了一只狐狸/, 'the card')
  assert.match(sent, /狐狸在桌上睡着了/, 'the passage')
})

test('the Claude subscription gets the system prompt and the turn\'s message without the word', async t => {
  const calls = []
  const query = ({ prompt, options }) => {
    calls.push({ prompt, options })
    return (async function* () {
      yield { type: 'assistant', session_id: 's1', uuid: `m${calls.length}`, message: { model: options.model, content: [{ type: 'text', text: '猫打了个哈欠。' }] } }
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: {} }
    })()
  }
  let backend = null
  const { store, turn } = await setup(t, ['unused'], { subscription: (store, root) => (backend = testSubscription(store, root, query)) })
  if (!backend) return t.skip('no subscription backend in this tree')
  await store.saveBlockWords(cleanBlockWords([{ word: '猫', mode: 'replace', replacement: '狐狸' }]))
  const nodes = await turn('灯笼亮了，猫呢？')
  assert.match(calls[0].options.systemPrompt, /林雪养了一只狐狸/)
  assert.ok(!calls[0].options.systemPrompt.includes('猫'))
  assert.match(calls[0].prompt, /灯笼上画着一只狐狸/)
  assert.match(calls[0].prompt, /灯笼亮了，狐狸呢？/)
  assert.ok(!calls[0].prompt.includes('猫'))
  assert.equal(nodes.at(-1).text, '猫打了个哈欠。', 'the reply is kept as written')
  assert.equal(nodes.at(-2).text, '灯笼亮了，猫呢？')
})
