// 界面语言: Chinese is the source, English is looked up (web/shared/i18n.js,
// server/i18n.mjs). The check that nothing shown is left untranslated is
// scripts/i18n-check.mjs; it runs here, so a new Chinese string without English fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acceptedLanguages, createTag, hasCjk, htmlTexts, keyOf, pickLanguage, translateHtml } from '../web/shared/i18n.js'
import webEnglish from '../web/i18n/en.js'
import { chineseLiterals, checkTree, scanJs, serverScripts, webScripts } from '../scripts/i18n-check.mjs'
import { localize, msg, withLanguage } from '../server/i18n.mjs'
import { createApp } from '../server/http.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('every Chinese text the page shows has English, and every entry is English and still used', async () => {
  const { problems } = await checkTree(root)
  assert.deepEqual(problems.map(p => `${p.file}:${p.line} ${p.problem}: ${p.text.slice(0, 80)}`), [])
})

test('t`…`: Chinese as written, English by the text with its parts in place', () => {
  const zh = createTag(null)
  const en = createTag({
    '删除「{0}」？': 'Delete "{0}"?',
    '{0} 写的第 {1} 轮': 'Turn {1}, by {0}',
    '{0} 条': n => (n === 1 ? '1 entry' : `${n} entries`),
    取消: 'Cancel',
  })
  const name = '小雨'
  assert.equal(zh`删除「${name}」？`, '删除「小雨」？')
  assert.equal(en`删除「${name}」？`, 'Delete "小雨"?')
  assert.equal(en`${'Fake'} 写的第 ${3} 轮`, 'Turn 3, by Fake', 'the parts can move')
  assert.equal(en`${1} 条`, '1 entry')
  assert.equal(en`${4} 条`, '4 entries')
  assert.equal(en`没有英文的句子`, '没有英文的句子', 'a missing entry stays Chinese')
  assert.equal(en('取消'), 'Cancel', 't(text) looks up text that is not a literal')
  assert.equal(en('别的'), '别的')
  // The same call site twice (the entry is kept per template).
  const twice = [1, 2].map(n => en`${n} 条`)
  assert.deepEqual(twice, ['1 entry', '2 entries'])
})

test('a template\'s key is its text with {0}, {1}… for the parts, escapes as the program sees them', () => {
  const [lit] = scanJs('const x = t`第 ${n} 轮\\n${m}「${a ? `嵌套 ${b}` : \'\'}」`')
  assert.equal(lit.tag, 't')
  assert.equal(keyOf(lit.cooked), '第 {0} 轮\n{1}「{2}」')
  const nested = scanJs('t`外 ${t`内 ${x}`}`').map(l => keyOf(l.cooked))
  assert.deepEqual(nested.sort(), ['内 {0}', '外 {0}'])
})

test('the scan skips comments and regexes, and flags Chinese that is not behind a tag', () => {
  const src = [
    '// 注释里的中文',
    "const re = /[，。]/g",
    "const a = t`已保存`",
    "const b = zh`给模型的`",
    "const c = '漏掉的'",
    "const d = '留着的' // i18n-ignore: card content",
    'const e = x / 2 / y',
  ].join('\n')
  const found = chineseLiterals(src).map(l => [l.cooked.join(''), l.state])
  assert.deepEqual(found, [['已保存', 'tagged'], ['给模型的', 'kept'], ['漏掉的', 'bare'], ['留着的', 'kept']])
})

test('the language follows the setting, else the browser: Chinese or English, whichever it prefers first', () => {
  assert.equal(pickLanguage('en', ['zh-CN']), 'en')
  assert.equal(pickLanguage('zh', ['en-US']), 'zh')
  assert.equal(pickLanguage('auto', ['zh-CN', 'zh']), 'zh')
  assert.equal(pickLanguage('auto', ['zh-Hans-CN', 'ja', 'en-US']), 'zh')
  assert.equal(pickLanguage('auto', ['zh-TW']), 'zh')
  assert.equal(pickLanguage('auto', ['en-US', 'en']), 'en')
  assert.equal(pickLanguage('auto', ['ja']), 'en', 'not Chinese: English')
  assert.equal(pickLanguage('auto', ['ja', 'zh-CN', 'en']), 'zh', 'Chinese ranked above English')
  assert.equal(pickLanguage('auto', ['ja', 'en', 'zh-CN']), 'en')
  assert.equal(pickLanguage('auto', []), 'zh', 'no language at all: Chinese')
  assert.equal(pickLanguage('auto', ['*']), 'zh')
  assert.deepEqual(acceptedLanguages('en;q=0.5, zh-CN, ja;q=0.8'), ['zh-CN', 'ja', 'en'])
  assert.deepEqual(acceptedLanguages(''), [])
})

test('index.html in English: every shown text translated, <html lang> set', () => {
  const html = readFileSync(path.join(root, 'web', 'index.html'), 'utf8')
  const english = translateHtml(html, webEnglish, 'en')
  assert.match(english, /<html lang="en" data-ui-lang="en">/)
  assert.deepEqual(htmlTexts(english).filter(piece => hasCjk(piece.text)).map(piece => piece.text), [])
  assert.match(translateHtml(html, null, 'zh'), /<html lang="zh-CN" data-ui-lang="zh">/)
  assert.equal(translateHtml(html, null, 'zh').replace(/<html[^>]*>/, ''), html.replace(/<html[^>]*>/, ''), 'Chinese is the page as written')
})

test('server messages: msg`…` in the request\'s language; whole messages from the launcher\'s modules matched on the way out', () => {
  const name = 'Fake'
  assert.equal(withLanguage('zh', () => msg`供应商「${name}」还没有填 API Key`), '供应商「Fake」还没有填 API Key')
  assert.equal(withLanguage('en', () => msg`供应商「${name}」还没有填 API Key`), 'Provider "Fake" has no API key yet')
  assert.equal(withLanguage('en', () => localize('角色卡不存在')), 'Character card not found')
  assert.equal(withLanguage('en', () => localize('更新包损坏：a/b.txt 校验不对')), 'The update package is damaged: a/b.txt fails its checksum')
  assert.equal(withLanguage('en', () => localize('新版本的 node.exe 不完整')), "The new version's node.exe is incomplete", 'the most specific pattern wins')
  assert.equal(withLanguage('en', () => localize('upstream said no')), 'upstream said no')
  assert.equal(withLanguage('zh', () => localize('角色卡不存在')), '角色卡不存在')
})

test('the tags are not shadowed: where t or msg is imported, nothing else takes the name', () => {
  const shadows = []
  const check = (files, name, imported) => {
    const own = new RegExp(`(?:\\(|,)\\s*${name}\\s*(?:[,)=]|=>)|\\b${name}\\s*=>|\\b(?:const|let|var|function)\\s+${name}\\b`)
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      if (!imported.test(src)) continue
      src.split(/\r?\n/).forEach((line, i) => {
        if (/^\s*(\/\/|\*|import )/.test(line)) return
        if (own.test(line.replace(/(['"`]).*?\1/g, '""'))) shadows.push(`${path.relative(root, file)}:${i + 1}`)
      })
    }
  }
  check(webScripts(root), 't', /^import \{[^}]*\bt\b[^}]*\} from '\/i18n\.js'/m)
  check(serverScripts(root), 'msg', /^import \{[^}]*\bmsg\b[^}]*\} from '(\.\.?\/)+i18n\.mjs'/m)
  assert.deepEqual(shadows, [])
})

async function tavern(t, settings) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-i18n-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body, language } = {}) => {
    const headers = { 'content-type': 'application/json', 'x-agent-tavern': '1', ...(language ? { 'accept-language': language } : {}) }
    const res = await fetch(`${base}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, text: await res.text() }
  }
  if (settings) await call('/api/settings', { method: 'PUT', body: settings })
  return call
}

test('the page and its errors come in the language the setting or the browser picks', async t => {
  const call = await tavern(t)
  assert.equal(JSON.parse((await call('/api/settings')).text).uiLanguage, 'auto')

  const english = await call('/', { language: 'en-US,en;q=0.9' })
  assert.match(english.text, /<html lang="en" data-ui-lang="en">/)
  assert.match(english.text, /Import a card, lorebook or preset/)
  assert.match((await call('/', { language: 'zh-CN,zh;q=0.9' })).text, /<html lang="zh-CN" data-ui-lang="zh">[\s\S]*导入角色卡、世界书或预设/)

  const missing = await call('/api/cards/abcdef123456', { language: 'en' })
  assert.equal(missing.status, 404)
  assert.equal(JSON.parse(missing.text).error, 'Character card not found')
  assert.equal(JSON.parse((await call('/api/cards/abcdef123456', { language: 'zh-CN' })).text).error, '角色卡不存在')
  const bad = await call('/api/chats/import', { method: 'POST', body: { cardId: 'abcdef123456', archive: { format: 'nope' } }, language: 'en' })
  assert.equal(JSON.parse(bad.text).error, "This isn't a CicaTavern story archive")
})

test('a saved 界面语言 wins over the browser, and 写作语言 is untouched', async t => {
  const call = await tavern(t, { uiLanguage: 'en' })
  assert.match((await call('/', { language: 'zh-CN' })).text, /<html lang="en"/)
  const settings = JSON.parse((await call('/api/settings')).text)
  assert.equal(settings.uiLanguage, 'en')
  assert.equal(settings.language, '简体中文', 'the story is still written in Chinese')
  await call('/api/settings', { method: 'PUT', body: { uiLanguage: 'zh' } })
  assert.match((await call('/', { language: 'en-US' })).text, /<html lang="zh-CN"/)
  await call('/api/settings', { method: 'PUT', body: { uiLanguage: 'klingon' } })
  assert.equal(JSON.parse((await call('/api/settings')).text).uiLanguage, 'auto', 'anything else is 跟随系统')
})
