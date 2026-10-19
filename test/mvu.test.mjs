import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyStateUpdates } from '../server/state.mjs'
import { applyScripts, normalizeScripts, PLACEMENT, regexFromString } from '../web/shared/regex.js'
import { formatValue, replaceVariableMacros } from '../web/shared/vars.js'
import { compileEjs, initTemplates, renderTemplate } from '../server/template.mjs'
import { normalizeBook, constantEntries, dynamicEntries } from '../server/worldbook.mjs'
import { buildSystemPrompt, renderEntry } from '../server/prompt.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { createApp } from '../server/http.mjs'

before(() => initTemplates())

test('MVU JSON Patch: replace / add / remove / delta, stat_data prefix, <update> spelling', () => {
  const state = { 角色: { 好感度: 10, 标签: ['a'] }, 金钱: 5, 临时: 1 }
  const reply = `正文
<UpdateVariable>
<Analysis>好感上升</Analysis>
<JSONPatch>
[
  { "op": "replace", "path": "/角色/好感度", "value": 15 },
  { "op": "add", "path": "/角色/标签/-", "value": "b" },
  { "op": "remove", "path": "/临时" },
  { "op": "delta", "path": "/stat_data/金钱", "value": -2 },
]
</JSONPatch>
</UpdateVariable>`
  const { state: next, changes } = applyStateUpdates(state, reply)
  assert.deepEqual(next, { 角色: { 好感度: 15, 标签: ['a', 'b'] }, 金钱: 3 })
  assert.deepEqual(changes, ['角色.好感度', '角色.标签.-', '临时', '金钱'])
  const lower = applyStateUpdates({ x: 1 }, '<update><JSONPatch>[{"op":"replace","path":"/x","value":2}]</JSONPatch></update>')
  assert.equal(lower.state.x, 2)
  assert.deepEqual(state.角色.好感度, 10, 'input state is not mutated')
})

test('update blocks with a stray or missing closing tag: applied when whole, hidden either way, story kept', async () => {
  const { displayText } = await import('../server/state.mjs')
  const { displayOf } = await import('../web/render.js')
  const shown = text => displayOf({ role: 'assistant', raw: text, state: {} }, { scripts: [], names: { char: '她', user: '你' }, depth: 0 })
  const cases = [
    // [reply, state after, why]
    ['她笑了。\n<state>{"好感": 30}</UpdateVariable>', { 好感: 30 }, 'closed with the MVU tag'],
    ['她笑了。\n<UpdateVariable>\n_.set(\'好感\', 10, 30);\n</state>', { 好感: 30 }, 'MVU closed with the state tag'],
    ['她笑了。\n<state>{"好感": 30}', { 好感: 30 }, 'never closed, but whole'],
    ['她笑了。\n<state>{"好感": 3', {}, 'cut off mid-block: nothing applied'],
    ['她笑了。\n<UpdateVariable>\n<JSONPatch>[{"op":"replace","path":"/好感","value":30}]</JSONPatch>\n_.set(\'金', { 好感: 30 }, 'cut off after a whole patch'],
  ]
  for (const [reply, after, why] of cases) {
    assert.deepEqual(applyStateUpdates({}, reply).state, after, why)
    assert.equal(displayText(reply), '她笑了。', why)
    assert.equal(shown(reply), '她笑了。', why)
  }
  // Two blocks, one closed wrong: each read on its own; well-formed replies read as before.
  assert.deepEqual(applyStateUpdates({}, '<state>{"a": 1}</update>正文<state>{"b": 2}</state>').state, { a: 1, b: 2 })
  assert.equal(displayText('<state>{"a": 1}</update>正文<state>{"b": 2}</state>'), '正文')
  assert.equal(displayText('前文<state>{"a": 1}</state>后文'), '前文后文')
})

test('SillyTavern regex rules: parsing, placement, prompt/display split, depth, trim, groups, macros', () => {
  assert.equal(regexFromString('<StatusPlaceHolderImpl/>').source, '<StatusPlaceHolderImpl\\/>')
  assert.equal(regexFromString('/a+/gi').flags, 'gi')
  const scripts = normalizeScripts([
    { scriptName: 'hide', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '', placement: [2], promptOnly: true },
    { scriptName: 'bar', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '[{{user}}的状态]', placement: [2], markdownOnly: true },
    { scriptName: 'wrap', findRegex: '/<b>(.*?)<\\/b>/g', replaceString: '«$1|{{match}}»', trimStrings: ['x'], placement: [2] },
    { scriptName: 'old-only', findRegex: '/旧/g', replaceString: '新', placement: [2], markdownOnly: true, minDepth: 2 },
    { scriptName: 'off', findRegex: '/.+/', replaceString: '', placement: [2], disabled: true },
    { findRegex: '' },
  ])
  assert.equal(scripts.length, 5)
  const macros = t => t.replace('{{user}}', '阿明')
  const text = '旧<b>xab</b><StatusPlaceHolderImpl/>'
  assert.equal(applyScripts(text, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth: 0, macros }), '旧«ab|<b>ab</b>»')
  assert.equal(applyScripts(text, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'display', depth: 0, macros }), '旧«ab|<b>ab</b>»[阿明的状态]')
  assert.equal(applyScripts(text, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'display', depth: 3, macros }), '新«ab|<b>ab</b>»[阿明的状态]')
  assert.equal(applyScripts(text, scripts, { placement: PLACEMENT.USER_INPUT, target: 'display', depth: 0, macros }), text)
})

test('variable macros read stat_data and format structures', () => {
  const state = { 系统: { 时间: '清晨' }, 角色: { 好感度: [12, '0-100'], 物品: ['伞', '钥匙'] } }
  assert.equal(replaceVariableMacros('{{format_message_variable::stat_data.系统.时间}}/{{get_message_variable::stat_data.角色.好感度}}', state), '清晨/12')
  assert.equal(replaceVariableMacros('{{getvar::stat_data.角色.物品}}', state), '["伞","钥匙"]')
  assert.match(formatValue(state), /系统:\n  时间: 清晨\n角色:\n  好感度: 12\n  物品: 伞、钥匙/)
  assert.equal(replaceVariableMacros('{{get_message_variable::stat_data.不存在}}', state), '')
})

test('EJS runs in the QuickJS sandbox: getvar branches, whitespace control, no host access, time limit', () => {
  const template = [
    '<%_ const 好感 = getvar("stat_data.角色.好感度") _%>',
    '<%_ if (好感 >= 50) { _%>',
    '亲密阶段：<%= 好感 %>',
    '<%_ } else { _%>',
    '陌生阶段：<%= 好感 %>',
    '<%_ } _%>',
    '<%# 注释 %>结束',
  ].join('\n')
  const vars = hp => ({ stat_data: { 角色: { 好感度: hp } } })
  assert.equal(renderTemplate(template, { variables: vars(70) }).text, '亲密阶段：70\n结束')
  assert.equal(renderTemplate(template, { variables: vars(10) }).text, '陌生阶段：10\n结束')
  assert.equal(renderTemplate('<%= typeof process %>/<%= typeof require %>/<%= typeof fetch %>', { variables: {} }).text, 'undefined/undefined/undefined')
  const loop = renderTemplate('<% while (true) {} %>', { variables: {} })
  assert.equal(loop.text, null)
  assert.match(loop.error, /interrupt/i)
  assert.match(compileEjs('a<%% b'), /<%/)
  assert.equal(renderTemplate('<% setvar("x", 1) %><%= getvar("x", { defaults: "无" }) %>', { variables: {} }).text, '无', 'setvar is a no-op')
})

test('state-dependent entries stay out of the frozen prefix and render with current state', () => {
  const book = normalizeBook({
    entries: [
      { keys: [], content: '世界观：静态设定', constant: true, comment: '世界' },
      { keys: [], content: '<status>\n{{format_message_variable::stat_data}}\n</status>', constant: true, comment: '变量列表' },
      { keys: [], content: '<% if (getvar("stat_data.阶段") === 2) { %>第二阶段<% } else { %>第一阶段<% } %>', constant: true, comment: '阶段' },
    ],
  })
  const books = [{ ...book, id: 'b' }]
  assert.deepEqual(constantEntries(books).map(e => e.comment), ['世界'])
  assert.deepEqual(dynamicEntries(books).map(e => e.comment), ['变量列表', '阶段'])
  const card = normalizeCard({ name: 'c', description: 'd', first_mes: 'hi' })
  const system = buildSystemPrompt({ card, persona: { name: 'u' }, settings: {}, books, hasState: true })
  assert.match(system, /静态设定/)
  assert.doesNotMatch(system, /format_message_variable|第二阶段|第一阶段/)
  const names = { char: 'c', user: 'u' }
  assert.equal(renderEntry(dynamicEntries(books)[1], { state: { 阶段: 2 }, names }).text, '第二阶段')
  assert.match(renderEntry(dynamicEntries(books)[0], { state: { 好感: 3 }, names }).text, /好感: 3/)
})

test('display segments: prose stays prose, HTML blocks (even across blank lines) become frames', async () => {
  const { segments, streamingText } = await import('../web/render.js')
  const parts = segments('正文一。\n\n<details><summary>更新</summary>\n\n<div>好感 +1</div>\n\n</details>\n\n尾声。\n\n```\n<div>状态栏</div>\n```\n\n```js\nconst a = 1\n```')
  assert.deepEqual(parts.map(p => p.kind), ['story', 'html', 'story', 'html', 'code'])
  assert.match(parts[1].body, /<\/details>$/)
  const styled = segments('正文。\n\n<div class="x">块</div>\n\n<style>.x{color:red}</style>\n\n尾声。')
  assert.deepEqual(styled.map(p => p.kind), ['story', 'html', 'story'], 'a style-only chunk joins its markup instead of becoming an empty frame')
  assert.match(styled[1].body, /<div class="x">块<\/div>\n+<style>/)
  const lone = segments('<div class="y">块</div>\n\n正文。\n\n<style>.y{}</style>')
  assert.deepEqual(lone.map(p => p.kind), ['html', 'story'], 'a style chunk with no adjacent markup is dropped')
  assert.equal(streamingText('正文<UpdateVariable><Analysis>想'), '正文', 'an unfinished update block is hidden while streaming')
  assert.equal(streamingText('正文<state>{}</state>后文'), '正文后文')
})

test('the status bar goes after the story wherever the model put its placeholder', async () => {
  const { displayOf } = await import('../web/render.js')
  const scripts = normalizeScripts([{ scriptName: 'bar', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '[状态栏]', placement: [2], markdownOnly: true }])
  const names = { char: '小雨', user: '你' }
  const shown = text => displayOf({ role: 'assistant', text, state: {} }, { scripts, names, depth: 0, withStatus: true })
  assert.equal(shown('<StatusPlaceHolderImpl/>\n正文。'), '正文。\n\n[状态栏]')
  assert.equal(shown('正文。<StatusPlaceHolderImpl/>\n<UpdateVariable>x</UpdateVariable>\n尾声。'), '正文。\n\n尾声。\n\n[状态栏]')
  assert.equal(shown('正文。'), '正文。\n\n[状态栏]')
  // An older reply keeps its bar (if the card shows one there), also at the end.
  assert.equal(displayOf({ role: 'assistant', text: '<StatusPlaceHolderImpl/>旧文。', state: {} }, { scripts, names, depth: 4, withStatus: false }), '旧文。\n\n[状态栏]')
})

// End-to-end on the author's own MVU card (test/local-paths.mjs; skipped elsewhere):
// import, open, and preview the first turn without calling the model.
const { realCard: REAL_CARD = '' } = existsSync(new URL('./local-paths.mjs', import.meta.url)) ? await import('./local-paths.mjs') : {}
test('real MVU card: first-turn preview hides placeholders and feeds variables', { skip: !existsSync(REAL_CARD) }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-mvu-'))
  const app = createApp({ dataRoot: root, proxy: 'off' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'content-type': 'application/json', 'x-agent-tavern': '1' }
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) })).json()
  const card = await post('/api/cards/import', { filename: 'c.png', data: readFileSync(REAL_CARD).toString('base64') })
  assert.ok(card.regexScripts >= 5)
  const chat = await post('/api/chats', { cardId: card.id })
  assert.ok(Object.keys(chat.path[0].state).length > 0, 'initvar became the chat state')
  const preview = await post(`/api/chats/${chat.id}/preview`, { parentId: 'root', input: '你好' })
  assert.doesNotMatch(preview.prompt, /StatusPlaceHolderImpl/, 'prompt-only regex removed the placeholder')
  assert.match(preview.prompt, /<动态设定>[\s\S]*status_current_variable[\s\S]*<\/动态设定>/, 'variable list rendered each turn')
  assert.doesNotMatch(preview.prompt, /format_message_variable|<%/, 'no raw macros or EJS reach the model')
  assert.doesNotMatch(preview.prompt, /<当前状态>/, 'card shows state itself, so ours is skipped')
  assert.deepEqual(preview.templateErrors, [])
  const system = (await (await fetch(`${base}/api/chats/${chat.id}/prompt`)).json()).systemPrompt
  assert.doesNotMatch(system, /format_message_variable|<%/, 'frozen prefix holds only static entries')
})

test('ST-Prompt-Template decorators: @@private is dropped, @@if gates the entry', () => {
  const vars = 阶段 => ({ stat_data: { 阶段 } })
  const priv = '@@private\n---\n<%_ const 阶段 = getvar("stat_data.阶段") _%>\n阶段<%= 阶段 %>'
  assert.equal(renderTemplate(priv, { variables: vars(2) }).text, '---\n阶段2')
  const gated = '@@if getvar("stat_data.阶段", { defaults: 0 }) >= 2\n第二阶段设定'
  assert.equal(renderTemplate(gated, { variables: vars(2) }).text, '第二阶段设定')
  assert.equal(renderTemplate(gated, { variables: vars(1) }).text, '')
  const book = normalizeBook({ entries: [{ keys: [], content: gated, constant: true, comment: '阶段' }] })
  assert.equal(constantEntries([book]).length, 0, 'an @@if entry is dynamic, not part of the frozen prefix')
  assert.equal(dynamicEntries([book]).length, 1)
})
