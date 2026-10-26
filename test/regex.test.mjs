// 正则管理: global scripts for every chat, a card's and a preset's own with
// their switches, SillyTavern regex files imported into the global ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { cleanScripts } from '../server/regex.mjs'
import { chatScripts, scriptsOf } from '../server/chats.mjs'
import { applyScripts, effectFlags, effectOf, isRegexFile, normalizeScripts, PLACEMENT, scriptsInFile } from '../web/shared/regex.js'
import { effectOf as forgeEffectOf, scriptOf, touchesPrompt } from '../server/forge/regex-edit.mjs'

test('the display / prompt switches as SillyTavern reads them: both ticked changes both, and stays ticked when kept', () => {
  const script = flags => normalizeScripts([{ findRegex: '/<thinking>[\\s\\S]*?<\\/thinking>/g', replaceString: '', placement: [PLACEMENT.AI_OUTPUT], ...flags }])
  const text = 'a<thinking>想法</thinking>b'
  const run = (scripts, target) => applyScripts(text, scripts, { placement: PLACEMENT.AI_OUTPUT, target })
  for (const [flags, display, prompt, effect] of [
    [{ markdownOnly: true, promptOnly: true }, 'ab', 'ab', 'both'],
    [{ markdownOnly: true }, 'ab', text, 'display'],
    [{ promptOnly: true }, text, 'ab', 'prompt'],
    [{}, 'ab', 'ab', 'both'],
  ]) {
    const scripts = script(flags)
    assert.equal(run(scripts, 'display'), display, JSON.stringify(flags))
    assert.equal(run(scripts, 'prompt'), prompt, JSON.stringify(flags))
    assert.equal(effectOf(scripts[0]), effect)
    assert.equal(forgeEffectOf(scripts[0]), effect)
  }
  const both = script({ markdownOnly: true, promptOnly: true })[0]
  assert.equal(touchesPrompt(both), true, 'it changes what the model reads')
  assert.deepEqual(effectFlags('both', both), { markdownOnly: true, promptOnly: true }, 'kept as SillyTavern had it')
  assert.deepEqual(effectFlags('display', both), { markdownOnly: true, promptOnly: false })
  assert.deepEqual(effectFlags('both', script({})[0]), { markdownOnly: false, promptOnly: false })
  const kept = scriptOf({ on: 'ai', effect: 'both', findAfter: '/x/g', replaceAfter: '' }, both)
  assert.deepEqual([kept.markdownOnly, kept.promptOnly], [true, true], 'an assistant edit that leaves the effect keeps the switches')
})

test('replace strings as SillyTavern reads them: $0 and {{match}} the whole match, one pass, missing groups empty', () => {
  const run = (findRegex, replaceString, text) => applyScripts(text, normalizeScripts([{ findRegex, replaceString, placement: [PLACEMENT.AI_OUTPUT] }]), { placement: PLACEMENT.AI_OUTPUT, target: 'display' })
  assert.equal(run('/hello/g', '<b>$0</b>', 'say hello'), 'say <b>hello</b>')
  assert.equal(run('/cost: (.+)/', '[{{match}}]', 'cost: $10'), '[cost: $10]', 'what the match brings in is not read again')
  assert.equal(run('/(a)(x)?/', '$1-$2-$3', 'a'), 'a--')
  assert.equal(run('/(?<who>小雨)说/', '$<who>：', '小雨说你好'), '小雨：你好')
})

const script = (name, extra = {}) => ({ id: '', scriptName: name, findRegex: `/${name}/g`, replaceString: '', placement: [2], ...extra })

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-regex-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  return { app, call }
}

test('stored scripts: each gets an id of its own; one without a pattern is dropped', () => {
  const cleaned = cleanScripts([script('a', { id: 'same' }), script('b', { id: 'same' }), { scriptName: 'empty', findRegex: '' }])
  assert.deepEqual(cleaned.map(s => s.scriptName), ['a', 'b'])
  assert.equal(cleaned[0].id, 'same')
  assert.notEqual(cleaned[1].id, 'same')
  assert.throws(() => cleanScripts('nope'), /格式/)
  assert.throws(() => cleanScripts(Array.from({ length: 201 }, (_, i) => script(`s${i}`))), /最多/)
  // A beautifier's page of HTML (a preset's 行动选项美化 is 41 839 characters) is kept; only a runaway one is refused.
  const page = `<div class="fox">${'<span>狐</span>'.repeat(3000)}</div>`
  assert.equal(cleanScripts([script('美化', { replaceString: page })])[0].replaceString.length, page.length)
  assert.throws(() => cleanScripts([script('太大', { replaceString: 'x'.repeat(400_001) })]), /太长了/)
})

test('a SillyTavern regex file: one script, a list, or a card\'s regex_scripts', () => {
  const one = { id: 'x', scriptName: 'Hide', findRegex: '/a/g', replaceString: '' }
  assert.equal(scriptsInFile(one).length, 1)
  assert.equal(scriptsInFile([one, one]).length, 2)
  assert.equal(scriptsInFile({ regex_scripts: [one] }).length, 1)
  assert.equal(isRegexFile(one), true)
  assert.equal(isRegexFile([one]), true)
  assert.equal(isRegexFile({ prompts: [], extensions: { regex_scripts: [one] } }), false, 'a preset stays a preset')
  assert.equal(isRegexFile({ spec: 'chara_card_v2', data: { extensions: { regex_scripts: [one] } } }), false, 'a card stays a card')
})

test('a chat runs the global scripts, then its preset\'s, then its card\'s', async t => {
  assert.deepEqual(scriptsOf({ regexScripts: [script('card')] }, { regexScripts: [script('preset')] }, [script('global')]).map(s => s.scriptName), ['global', 'preset', 'card'])
  const { app, call } = await tavern(t)
  await call('/api/regex', { method: 'PUT', body: { scripts: [script('global')] } })
  const scripts = await chatScripts(app.store, { cardId: 'gone', presetId: 'basic' })
  assert.deepEqual(scripts.map(s => s.scriptName), ['global', '旧回复的行动选项不再发给模型'])
})

test('global scripts, imports, a card\'s switches; the built-in preset\'s stays as it is', async t => {
  const { app, call } = await tavern(t)
  assert.deepEqual((await call('/api/regex')).body, { scripts: [] })
  const saved = (await call('/api/regex', { method: 'PUT', body: { scripts: [script('one')] } })).body.scripts
  assert.match(saved[0].id, /^[0-9a-f-]{36}$/)

  // Imported after the ones here; an id already taken gets a new one.
  const imported = (await call('/api/regex/import', { method: 'POST', body: { scripts: [{ ...script('two'), id: saved[0].id }] } })).body
  assert.equal(imported.added, 1)
  assert.deepEqual(imported.scripts.map(s => s.scriptName), ['one', 'two'])
  assert.notEqual(imported.scripts[1].id, saved[0].id)
  assert.equal((await call('/api/regex/import', { method: 'POST', body: { scripts: [{ findRegex: '' }] } })).status, 400)

  // A card's own scripts: switched off, saved in the card.
  const card = { id: 'c1', name: '雨', regexScripts: cleanScripts([script('bar')]) }
  await app.store.saveCard(card)
  const off = (await call('/api/cards/c1/regex', { method: 'PUT', body: { scripts: [{ ...card.regexScripts[0], disabled: true }] } })).body.scripts
  assert.equal(off[0].disabled, true)
  assert.equal((await app.store.getCard('c1')).regexScripts[0].disabled, true)

  assert.equal((await call('/api/presets/basic/regex', { method: 'PUT', body: { scripts: [] } })).status, 400)
})
