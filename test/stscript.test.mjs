// STscript (web/stscript.js): what card interfaces send through triggerSlash.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScript, runScript } from '../web/stscript.js'

/** A host that keeps chat and global variables, and notes what it was asked for. */
function host(known = {}) {
  const vars = new Map()
  const globals = new Map()
  const calls = []
  const skipped = []
  const toasts = []
  return {
    vars,
    globals,
    calls,
    skipped,
    toasts,
    getVar: key => vars.get(key),
    setVar: (key, value) => void vars.set(key, value),
    deleteVar: key => void vars.delete(key),
    getGlobal: key => globals.get(key),
    setGlobal: (key, value) => void globals.set(key, value),
    deleteGlobal: key => void globals.delete(key),
    macro: name => ({ user: '你', char: '林雪' })[name],
    toast: text => toasts.push(text),
    sleep: async () => {},
    unknown: name => skipped.push(name),
    command: async (name, args) => {
      if (!(name in known)) return undefined
      calls.push([name, args.text, args.named])
      return known[name](args)
    },
  }
}

test('stscript: commands, named arguments, quotes and the lenient pipe', () => {
  assert.deepEqual(parseScript('/send 你好|/trigger').map(c => [c.name, c.unnamed]), [['send', '你好'], ['trigger', null]])
  assert.deepEqual(parseScript('/setinput A|B 两个选项').map(c => [c.name, c.unnamed]), [['setinput', 'A|B 两个选项']], 'a | not before a command stays in the text')
  const [echo] = parseScript('/echo severity=warning title="提 示" 注意')
  assert.deepEqual([echo.named, echo.unnamed], [{ severity: 'warning', title: '提 示' }, '注意'])
  assert.deepEqual(parseScript('/sys [仙缘已定]\n**道号**: 测试 | /cut 0 | /trigger').map(c => [c.name, c.unnamed]), [
    ['sys', '[仙缘已定]\n**道号**: 测试'],
    ['cut', '0'],
    ['trigger', null],
  ])
  assert.equal(parseScript('/echo a \\| /b')[0].unnamed, 'a | /b', 'an escaped | is text')
  assert.deepEqual(parseScript('// 注释 | /echo hi').map(c => c.name), ['echo'], 'a comment is left out')
})

test('stscript: the pipe carries a result on, {{pipe}} and the unnamed argument it fills', async () => {
  const h = host()
  assert.equal(await runScript('/add 2 3 | /mul {{pipe}} 4', h), '20')
  assert.equal(await runScript('/pass 7 | /setvar key=n', h), '7')
  assert.equal(h.vars.get('n'), 7, 'a number stays one')
  assert.equal(await runScript('/getvar n | /add 1', h), '1', '/add 1 has its own argument: the pipe is not added')
  assert.equal(await runScript('/getvar n | /incvar n | /getvar n', h), '8')
})

test('stscript: chat and global variables, their macros, lists and objects', async () => {
  const h = host()
  await runScript('/setvar key=hp 100 | /addvar key=hp -30 | /setglobalvar key=round 3', h)
  assert.equal(h.vars.get('hp'), 70)
  assert.equal(h.globals.get('round'), 3)
  assert.equal(await runScript('/echo 生命 {{getvar::hp}}，第 {{getglobalvar::round}} 轮，{{user}} 与 {{char}}', h), '生命 70，第 3 轮，你 与 林雪')
  await runScript('/setvar key=bag ["剑"] | /addvar key=bag 丹药 | /setvar key=info index=名字 小雪', h)
  assert.deepEqual(h.vars.get('bag'), ['剑', '丹药'])
  assert.deepEqual(h.vars.get('info'), { 名字: '小雪' })
  assert.equal(await runScript('/getvar key=bag index=1', h), '丹药')
  assert.equal(await runScript('/len {{getvar::bag}}', h), '2')
  await runScript('/flushvar hp', h)
  assert.equal(h.vars.has('hp'), false)
  assert.equal(await runScript('/echo {{unknownmacro}}', h), '{{unknownmacro}}', 'a macro no one knows stays as written')
})

test('stscript: /if with else, rules and variable names; /while with its guard; /times with its index', async () => {
  const h = host()
  h.vars.set('gold', 50)
  assert.equal(await runScript('/if left=gold rule=gte right=30 {: /pass 买得起 :} else={: /pass 太贵 :}', h), '买得起')
  assert.equal(await runScript('/if left=gold rule=lt right=30 {: /pass 买得起 :} else={: /pass 太贵 :}', h), '太贵')
  assert.equal(await runScript('/if left={{getvar::gold}} right=50 {: /echo 正好 :}', h), '正好')
  assert.equal(await runScript('/if left=剑 rule=in right=铁剑与盾 {: /pass yes :}', h), 'yes')
  await runScript('/setvar key=i 0 | /while left=i rule=lt right=5 {: /incvar i :}', h)
  assert.equal(h.vars.get('i'), 5)
  await runScript('/setvar key=j 0 | /while left=1 right=1 {: /incvar j :}', h)
  assert.equal(h.vars.get('j'), 100, 'a loop that would not end stops at 100')
  assert.equal(await runScript('/setvar key=log 第 | /times 3 {: /addvar key=log {{timesIndex}} :} | /getvar log', h), '第012')
  assert.equal(await runScript('/times 5 {: /if left={{timesIndex}} right=2 {: /break 停在 2 :} :}', h), '停在 2')
})

test('stscript: scoped variables, closures in them, /run with arguments, /return and /abort', async () => {
  const h = host()
  assert.equal(await runScript('/let x 5 | /var x', h), '5')
  assert.equal(await runScript('/let greet {: /pass 你好，{{var::who}} :} | /run who=小雪 greet', h), '你好，小雪')
  assert.equal(await runScript('/let greet {: /pass 你好，{{var::who}} :} | /run greet who=阿青', h), '你好，阿青', 'the arguments after the name too')
  assert.equal(await runScript('/let f {: /return 早退 | /pass 不到这里 :} | /run f', h), '早退')
  assert.equal(await runScript('/echo 前 | /abort | /echo 后', h), '')
  assert.deepEqual(h.toasts, ['前'], '/abort stops the rest')
})

test('stscript: what the host knows goes to it; SillyTavern-only window commands are quiet; unknown ones are skipped and the rest runs', async () => {
  const h = host({ sys: () => '', trigger: () => '', cut: () => '' })
  const out = await runScript('/bg forest.jpg | /qr-set 我的按钮 | /sys 开局 | /cut 0 | /trigger | /echo done', h)
  assert.equal(out, 'done')
  assert.deepEqual(h.calls.map(c => [c[0], c[1]]), [['sys', '开局'], ['cut', '0'], ['trigger', '']])
  assert.deepEqual(h.skipped, ['qr-set'], '/bg is a window command, /qr-set unknown: neither stops the script')
})

test('stscript: math, random, text', async () => {
  const h = host()
  assert.equal(await runScript('/sub 10 3 2', h), '5')
  assert.equal(await runScript('/div 7 2', h), '3.5')
  assert.equal(await runScript('/div 1 0', h), '0')
  assert.equal(await runScript('/max 3 9 4', h), '9')
  assert.equal(await runScript('/round 2.6', h), '3')
  const roll = Number(await runScript('/rand from=1 to=6 round=round', h))
  assert.ok(Number.isInteger(roll) && roll >= 1 && roll <= 6)
  assert.equal(await runScript('/replace mode=literal pattern=猫 replacer=狗 我的猫', h), '我的狗')
  assert.equal(await runScript('/upper abc | /substr start=1', h), 'BC')
})
