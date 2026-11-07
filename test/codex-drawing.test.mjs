// Codex（本机）as a 画图方式 (server/codex-drawing.mjs), on a computer.
// A fake `codex` (a small Node script written here) stands in for the real CLI:
// it records how it was called and answers as the prompt's MODE= says.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CODEX_SIZES, codexError, codexInstruction, codexModels, createCodexDrawing, defaultModel, findCodex, pathFromReply, usualCodexDirs } from '../server/codex-drawing.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { createMedia } from '../server/media.mjs'
import { createStore } from '../server/store.mjs'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

// The fake: reads the instruction on stdin, then draws, refuses or fails by MODE= in it.
const FAKE = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
const home = process.env.FAKE_CODEX_HOME
let input = ''
process.stdin.on('data', chunk => (input += chunk))
process.stdin.on('end', async () => {
  const mode = /MODE=(\\w+)/.exec(input)?.[1] ?? 'ok'
  appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({ args, input, mode, start: Date.now() }) + '\\n')
  const last = args[args.indexOf('-o') + 1]
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const picture = () => {
    const dir = path.join(home, 'generated_images', 'session-1')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'ig_' + Date.now() + '.png')
    writeFileSync(file, Buffer.from('${PNG.toString('hex')}', 'hex'))
    return file
  }
  if (mode === 'slow') await wait(3000)
  if (mode === 'brief') await wait(300)
  if (mode === 'ok' || mode === 'slow' || mode === 'brief') writeFileSync(last, 'Done:\\n\`' + picture() + '\`\\n')
  else if (mode === 'fallback') { picture(); writeFileSync(last, 'All done.') }
  else if (mode === 'refuse') writeFileSync(last, 'REFUSED: I can not create sexual content.')
  else if (mode === 'unsupported') { process.stderr.write("ERROR: The 'gpt-x' model is not supported when using Codex with a ChatGPT account."); process.exitCode = 1 }
  else if (mode === 'forbidden') { process.stderr.write('unexpected status 403 Forbidden: image generation is not available'); process.exitCode = 1 }
  else if (mode === 'login') { process.stderr.write('Not logged in. Please run codex login'); process.exitCode = 1 }
  else if (mode === 'nothing') process.exitCode = 0
  appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({ mode, end: Date.now() }) + '\\n')
})
`

async function setup(t, { signedIn = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-codex-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'codex-home')
  await mkdir(home, { recursive: true })
  if (signedIn) await writeFile(path.join(home, 'auth.json'), '{}')
  await writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', priority: 1 },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 2 },
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', priority: 5 },
  ] }))
  const fake = path.join(root, 'fake-codex.mjs')
  await writeFile(fake, FAKE)
  process.env.FAKE_CODEX_HOME = home
  const store = createStore(path.join(root, 'data'))
  await store.init()
  const codex = createCodexDrawing({ store, home, command: [process.execPath, fake] })
  const calls = () => (existsSync(path.join(home, 'calls.jsonl')) ? readFileSync(path.join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [])
  return { root, home, store, codex, calls, fake }
}

test('the account\'s models, the one drawn with when none is picked, and finding the CLI', async t => {
  const { home, root } = await setup(t)
  assert.deepEqual(await codexModels(home), [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-6-luna', label: 'GPT-6-Luna' }], 'hidden ones left out, Codex\'s order')
  assert.equal(defaultModel(await codexModels(home)), 'gpt-6-luna')
  assert.equal(defaultModel([{ id: 'gpt-7' }]), 'gpt-7')
  assert.deepEqual(await codexModels(path.join(root, 'nowhere')), [])
  // The npm shim on Windows: its codex.js runs with this Node.
  const bin = path.join(root, 'npm')
  await mkdir(path.join(bin, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true })
  await writeFile(path.join(bin, 'codex.cmd'), '@echo off')
  await writeFile(path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '')
  assert.deepEqual(findCodex({ PATH: [path.join(root, 'empty'), bin].join(path.delimiter) }, 'win32'), [process.execPath, path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')])
  await writeFile(path.join(bin, 'codex'), '#!/bin/sh')
  assert.deepEqual(findCodex({ PATH: bin }, 'linux'), [path.join(bin, 'codex')])
  assert.equal(findCodex({ PATH: path.join(root, 'empty') }, 'win32'), null)
  // An app opened from the Finder has a short PATH: Homebrew's and npm's folders are looked in as well.
  assert.deepEqual(findCodex({ PATH: '/usr/bin' }, 'darwin', [path.join(root, 'empty'), bin]), [path.join(bin, 'codex')])
  assert.deepEqual(findCodex({ PATH: '' }, 'win32', [bin]), [process.execPath, path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')])
  assert.ok(usualCodexDirs({}, 'darwin', '/Users/a').includes('/opt/homebrew/bin'))
  assert.deepEqual(usualCodexDirs({ APPDATA: 'C:\Users\a\AppData\Roaming' }, 'win32'), [path.join('C:\Users\a\AppData\Roaming', 'npm')])
  // npm's codex elsewhere is a link to its codex.js, which asks for a `node` the app's PATH may lack: run with this Node.
  const linked = path.join(root, 'linked')
  await mkdir(linked, { recursive: true })
  const script = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  const made = await symlink(script, path.join(linked, 'codex')).then(() => true, () => false)
  if (made) assert.deepEqual(findCodex({ PATH: linked }, 'darwin', []), [process.execPath, script])
})

test('a picture: the model always passed, references as -i, the size asked for, read from the path in the answer', async t => {
  const { codex, calls, root } = await setup(t)
  const drawn = await codex.draw({ prompt: 'MODE=ok a girl in a tea house', shape: 'portrait', references: [PNG, PNG], model: '' })
  assert.deepEqual(drawn.buffer, PNG)
  assert.equal(drawn.label, 'Codex · gpt-6-luna')
  const [call] = calls()
  const args = call.args
  assert.deepEqual(args.slice(0, 3), ['exec', '--skip-git-repo-check', '--ephemeral'])
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-luna')
  assert.equal(args.at(-1), '-', 'the instruction comes on stdin')
  const refs = args.flatMap((arg, i) => (arg === '-i' ? [args[i + 1]] : []))
  assert.equal(refs.length, 2)
  assert.ok(args.indexOf('-i') < args.indexOf('-m'), 'the images come before -m, so - is not read as one')
  assert.match(call.input, /Image size: 1024x1536\./)
  assert.match(call.input, /2 attached image\(s\) are reference pictures/)
  assert.match(call.input, /Request:\nMODE=ok a girl in a tea house$/)
  assert.deepEqual(await readdir(path.join(root, 'data', 'media', 'codex-work')), [], 'the work folder is cleared')
  // A model picked in the settings or for this one.
  await codex.draw({ prompt: 'MODE=ok', model: 'gpt-6.1-sol' })
  assert.equal(calls().at(-2).args[calls().at(-2).args.indexOf('-m') + 1], 'gpt-6.1-sol')
  // No path in the answer: the newest picture Codex saved since the start.
  assert.deepEqual((await codex.draw({ prompt: 'MODE=fallback' })).buffer, PNG)
})

test('when it can\'t draw: refusals point to NovelAI; models, 403, sign-in and missing CLI say what to do', async t => {
  const { codex, store, home, root } = await setup(t)
  await assert.rejects(codex.draw({ prompt: 'MODE=refuse' }), /Codex 不画这张：I can not create sexual content。OpenAI 不画露骨的画面，这类图可以在画图方式里换 NovelAI/)
  await assert.rejects(codex.draw({ prompt: 'MODE=unsupported', model: 'gpt-x' }), /gpt-x 在 ChatGPT 登录下用不了/)
  await assert.rejects(codex.draw({ prompt: 'MODE=forbidden' }), /403/)
  await assert.rejects(codex.draw({ prompt: 'MODE=login' }), /codex login/)
  await assert.rejects(codex.draw({ prompt: 'MODE=nothing' }), /Codex 没有画出图（退出码 0）/)
  await rm(path.join(home, 'auth.json'))
  await assert.rejects(codex.draw({ prompt: 'MODE=ok' }), /Codex 还没登录/)
  assert.deepEqual(await codex.status().then(s => [s.ready, s.need]), [false, 'Codex 没登录'])
  const missing = createCodexDrawing({ store, home: path.join(root, 'none'), command: [path.join(root, 'no-such-codex')] })
  await writeFile(path.join(root, 'none-auth'), '')
  await mkdir(path.join(root, 'none'), { recursive: true })
  await writeFile(path.join(root, 'none', 'auth.json'), '{}')
  await assert.rejects(missing.draw({ prompt: 'x' }), /没找到 Codex/)
  // The words for an error read from Codex's output.
  assert.match(codexError({ reply: "I can't help with creating that image." }), /NovelAI/)
  assert.match(codexError({ output: 'error: 429 Too Many Requests', code: 1 }), /用量到上限/)
  assert.equal(pathFromReply('`C:\\\\nope\\\\x.png`'), null, 'a path that is not there is no answer')
})

test('slow pictures: one at a time, stopped with the request, given up after the time limit', async t => {
  const { codex, calls, store, home, fake } = await setup(t)
  const [a, b] = await Promise.all([codex.draw({ prompt: 'MODE=brief' }), codex.draw({ prompt: 'MODE=brief' })])
  assert.ok(a.buffer && b.buffer)
  const runs = calls().filter(c => c.mode === 'brief')
  const [firstEnd, secondStart] = [runs.find(c => c.end)?.end, runs.filter(c => c.start)[1]?.start]
  assert.ok(secondStart >= firstEnd, 'the second starts once the first is done')

  const controller = new AbortController()
  const started = Date.now()
  setTimeout(() => controller.abort(), 300)
  await assert.rejects(codex.draw({ prompt: 'MODE=slow', signal: controller.signal }), error => error.name === 'AbortError')
  assert.ok(Date.now() - started < 2500, 'stopped at once, not after the picture')
  await new Promise(resolve => setTimeout(resolve, 3200))
  assert.equal(calls().filter(c => c.mode === 'slow' && c.end).length, 0, 'the run was killed')

  const quick = createCodexDrawing({ store, home, command: [process.execPath, fake], timeout: 300 })
  await assert.rejects(quick.draw({ prompt: 'MODE=slow' }), /Codex 十分钟还没画完/)
})

test('as the 画图方式 in media: the setting kept, status for the page, the cast\'s pictures sent', async t => {
  const { codex, store, calls } = await setup(t)
  const media = createMedia(store, { ownBackends: [codex] })
  const [view] = await media.ownBackends()
  assert.deepEqual([view.id, view.name, view.ready, view.model, view.models.map(m => m.id)], ['codex', 'Codex（本机）', true, 'gpt-6-luna', ['gpt-6.1-sol', 'gpt-6-luna']])
  await store.saveSettings({ media: media.cleanSettings({ imageBackend: 'codex', localModels: { codex: 'gpt-6.1-sol' } }, await media.settings()) })
  const card = normalizeCard({ name: '林青禾', description: 'MODE=ok', first_mes: '你好。' })
  card.media = { style: 'watercolor', roster: [{ id: 'aa11bb22cc', name: '林青禾', kind: 'girl', looks: 'MODE=ok long black hair' }] }
  await store.saveCard(card, PNG)
  await media.saveRosterRef(card.id, 'aa11bb22cc', `data:image/png;base64,${PNG.toString('base64')}`)
  const drawn = await media.drawAvatar(card.id, undefined, {})
  assert.equal(drawn.backend, 'Codex · gpt-6.1-sol')
  const call = calls().find(c => c.args)
  assert.match(call.input, /Image size: 1024x1024\./)
  assert.equal(call.args.filter(arg => arg === '-i').length, 1, 'her reference picture')
  assert.equal(CODEX_SIZES.landscape, '1536x1024')
  assert.match(codexInstruction('x'), /REFUSED:/)
})
