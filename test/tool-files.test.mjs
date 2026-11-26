// 直连对话的文件工具 (server/tools/files.mjs, text.mjs, history.mjs): reading, changing, what is asked, taking it back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFileHistory, newRun } from '../server/tools/history.mjs'
import { createFileTools, editsOf, fileToolsText, LEFT_OUT } from '../server/tools/files.mjs'
import { createGuard } from '../server/tools/paths.mjs'
import { decodeText, diffLines, encodeText, notInGbk, replaceOnce } from '../server/tools/text.mjs'

async function setup(t, { mode = 'write', free = false, masked } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cica-files-')))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const dir = path.join(root, 'novel')
  await mkdir(path.join(dir, '第一卷'), { recursive: true })
  await writeFile(path.join(dir, '第一卷', '一.txt'), '她抬起头。\n雨停了。\n他说：走吧。\n')
  const guard = createGuard({ dataRoot: path.join(root, 'data'), appRoot: path.join(root, 'app'), workspace: path.join(root, 'data', 'workspace'), home: path.join(root, 'home', 'me'), env: {} })
  const history = createFileHistory({ dir: path.join(root, 'history'), guard })
  const tools = createFileTools({ guard, history })
  const ctx = { folders: [{ id: 'f1', label: 'novel', path: dir, mode, free }], seen: new Map(), run: newRun(), chatId: 'c1', masked }
  const prepare = (name, args = {}, body = '') => tools.prepare({ name, args, body }, ctx)
  const go = async (name, args, body) => {
    const made = await prepare(name, args, body)
    return made.result ?? made.run()
  }
  const at = (...parts) => path.join(dir, ...parts)
  const text = (...parts) => readFile(at(...parts), 'utf8')
  const gone = real => access(real).then(() => false, () => true)
  return { root, dir, ctx, history, prepare, go, at, text, gone, guard }
}

test('listing, searching, reading: in the folders only, in pieces', async t => {
  const { go, at, ctx, dir, root } = await setup(t)
  assert.match(await go('list_files'), /novel\/（可以改）/)
  assert.match(await go('list_files', { path: 'novel' }), /第一卷\//)
  assert.match(await go('list_files', { path: 'novel', find: '一.TXT' }), /novel\/第一卷\/一\.txt/)
  assert.match(await go('search_files', { query: '雨|没有的' }), /novel\/第一卷\/一\.txt:2: 雨停了。/)
  assert.match(await go('search_files', { query: '.*' }), /没有搜到/, 'words, not a pattern')
  assert.equal(await go('read_file', { path: 'novel/第一卷/一.txt', from: '2', to: '2' }), '「novel/第一卷/一.txt」第 2–2 行，共 3 行：\n雨停了。\n……（后面还有 1 行，从 3 行接着读）')
  // One folder: its name may be left out.
  assert.match(await go('read_file', { path: '第一卷/一.txt' }), /共 3 行：\n她抬起头。\n雨停了。\n他说：走吧。$/)
  await assert.rejects(go('read_file', { path: 'novel/没有.txt' }), /没有「novel\/没有\.txt」/)
  await assert.rejects(go('read_file', { path: '../data/providers.json' }), /\.\./)
  await assert.rejects(go('read_file', { path: 'C:/Windows/win.ini' }), /绝对路径/)
  await writeFile(at('图.png'), Buffer.from([137, 80, 78, 71, 0, 1]))
  await assert.rejects(go('read_file', { path: 'novel/图.png' }), /图片/)
  await writeFile(at('长.txt'), Array.from({ length: 900 }, (_, i) => `第 ${i + 1} 行`).join('\n'))
  assert.match(await go('read_file', { path: 'novel/长.txt' }), /第 1–400 行，共 900 行[\s\S]*从 401 行接着读/)
  await writeFile(at('大.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 97))
  await assert.rejects(go('read_file', { path: 'novel/大.txt' }), /太大/)
  // Two folders: which one must be said. Links are not walked into.
  await mkdir(path.join(root, 'other'))
  await writeFile(path.join(root, 'other', 'x.txt'), '雨在别处')
  await symlink(path.join(root, 'other'), path.join(dir, 'out'), 'junction')
  assert.doesNotMatch(await go('search_files', { query: '雨' }), /别处/)
  ctx.folders.push({ id: 'f2', label: 'other', path: path.join(root, 'other'), mode: 'read', free: false })
  await assert.rejects(go('read_file', { path: '第一卷/一.txt' }), /能用的是：novel、other/)
  assert.match(await go('search_files', { query: '雨' }), /other\/x\.txt:1/)
})

test('a file that usually holds keys: asked before it is read, left out of searches', async t => {
  const { prepare, go, at } = await setup(t)
  await writeFile(at('.env'), 'KEY=雨')
  const made = await prepare('read_file', { path: 'novel/.env' })
  assert.equal(made.ask, 'always')
  assert.match(await made.run(), /KEY=雨/)
  assert.doesNotMatch(await go('search_files', { query: 'KEY' }), /KEY/)
})

test('edits: read first, one place, the rest byte for byte; asked with the change to look at', async t => {
  const { prepare, go, at, text, ctx } = await setup(t)
  const edit = (from, to) => `\n<old>${from}</old>\n<new>${to}</new>\n`
  await assert.rejects(prepare('edit_file', { path: 'novel/第一卷/一.txt' }, edit('她', '他')), /先用 read_file/)
  await go('read_file', { path: 'novel/第一卷/一.txt', to: '1' })
  const made = await prepare('edit_file', { path: 'novel/第一卷/一.txt' }, edit('她抬起头。', '她慢慢抬起头。'))
  assert.equal(made.ask, 'write')
  assert.deepEqual([made.view.op, made.view.diff.added, made.view.diff.removed], ['edit', 1, 1])
  assert.equal(await text('第一卷', '一.txt'), '她抬起头。\n雨停了。\n他说：走吧。\n', 'nothing yet')
  assert.match(await made.run(), /\+1 −1/)
  assert.equal(await text('第一卷', '一.txt'), '她慢慢抬起头。\n雨停了。\n他说：走吧。\n')
  // Its own change is known: edited again without reading again.
  await go('edit_file', { path: 'novel/第一卷/一.txt' }, '<old>\n雨停了。\n</old><new>\n雨又下了。\n</new>')
  assert.equal(await text('第一卷', '一.txt'), '她慢慢抬起头。\n雨又下了。\n他说：走吧。\n')
  await assert.rejects(go('edit_file', { path: 'novel/第一卷/一.txt' }, edit('没有这句', 'x')), /没有「没有这句」/)
  await assert.rejects(go('edit_file', { path: 'novel/第一卷/一.txt' }, edit('。', 'x')), /有 3 处/)
  await assert.rejects(go('edit_file', { path: 'novel/第一卷/一.txt' }, '改成雨'), /<old>/)
  // Two at once: both or neither.
  await assert.rejects(go('edit_file', { path: 'novel/第一卷/一.txt' }, edit('走吧', '走') + edit('没有', 'x')), /没有改任何地方/)
  assert.match(await text('第一卷', '一.txt'), /走吧/)
  // Changed by something else.
  await writeFile(at('第一卷', '一.txt'), '别人改的')
  await assert.rejects(go('edit_file', { path: 'novel/第一卷/一.txt' }, edit('别人', '我')), /变了/)
  assert.equal(ctx.seen.size, 1)
  assert.deepEqual(editsOf('<old>a</old><new></new>'), [{ from: 'a', to: '' }])
})

test('changed while the player was asked: not written', async t => {
  const { prepare, go, at, text, dir, root } = await setup(t)
  await go('read_file', { path: 'novel/第一卷/一.txt' })
  const made = await prepare('edit_file', { path: 'novel/第一卷/一.txt' }, '<old>雨停了。</old><new>雪停了。</new>')
  await writeFile(at('第一卷', '一.txt'), '别人改的')
  await assert.rejects(made.run(), /等用户确认的时候变了/)
  assert.equal(await text('第一卷', '一.txt'), '别人改的')
  // A new file whose folder became a link out of the folder meanwhile.
  const fresh = await prepare('write_file', { path: 'novel/sub/new.txt' }, 'x')
  await mkdir(path.join(root, 'elsewhere'))
  await symlink(path.join(root, 'elsewhere'), path.join(dir, 'sub'), 'junction')
  await assert.rejects(fresh.run(), /外面|变了/)
  assert.deepEqual(await readdir(path.join(root, 'elsewhere')), [])
})

test('whole files: a new one in a new folder; one that is there must have been read to its end', async t => {
  const { prepare, go, at, text } = await setup(t)
  const made = await prepare('write_file', { path: 'novel/第二卷/一.txt' }, '\n开头\n结尾\n')
  assert.equal(made.view.op, 'create')
  await made.run()
  assert.equal(await text('第二卷', '一.txt'), '开头\n结尾\n')
  // Just written, so known whole.
  await go('write_file', { path: 'novel/第二卷/一.txt' }, '新的')
  assert.equal(await text('第二卷', '一.txt'), '新的\n')
  await assert.rejects(go('write_file', { path: 'novel/第一卷/一.txt' }, 'x'), /先用 read_file/)
  await go('read_file', { path: 'novel/第一卷/一.txt', to: '2' })
  await assert.rejects(go('write_file', { path: 'novel/第一卷/一.txt' }, 'x'), /还没有读完/)
  await go('read_file', { path: 'novel/第一卷/一.txt', from: '3' })
  await go('write_file', { path: 'novel/第一卷/一.txt' }, 'x')
  assert.equal(await text('第一卷', '一.txt'), 'x\n')
  assert.match(await go('write_file', { path: 'novel/第一卷/一.txt' }, 'x'), /没有改/)
  await assert.rejects(go('write_file', { path: 'novel/a.txt' }, LEFT_OUT), /占位/)
  await assert.rejects(go('write_file', { path: 'novel/第一卷' }, 'x'), /文件夹/)
  await assert.rejects(go('write_file', { path: 'novel' }, 'x'), /文件夹/)
  assert.deepEqual((await readdir(at())).filter(name => name.startsWith('.cica')), [], 'no temporary files left')
})

test('encodings and line ends stay: GBK, a byte order mark, \\r\\n, mixed ends', async t => {
  const { go, at } = await setup(t)
  const gbk = encodeText('雨停了。\r\n他说：走吧。\r\n', { encoding: 'gbk' })
  assert.deepEqual(decodeText(gbk), { text: '雨停了。\r\n他说：走吧。\r\n', encoding: 'gbk', bom: false })
  await writeFile(at('旧.txt'), gbk)
  await go('read_file', { path: 'novel/旧.txt' })
  await go('edit_file', { path: 'novel/旧.txt' }, '<old>走吧。</old><new>走吧。\n她点头。</new>')
  assert.deepEqual(await readFile(at('旧.txt')), encodeText('雨停了。\r\n他说：走吧。\r\n她点头。\r\n', { encoding: 'gbk' }))
  await assert.rejects(go('edit_file', { path: 'novel/旧.txt' }, '<old>她点头。</old><new>她点头👍</new>'), /GBK[\s\S]*👍/)
  await writeFile(at('bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb')]))
  await go('read_file', { path: 'novel/bom.txt' })
  await go('write_file', { path: 'novel/bom.txt' }, 'a\nc')
  assert.deepEqual(await readFile(at('bom.txt')), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nc')]))
  await writeFile(at('mixed.txt'), 'a\r\nb\nc\r\nd')
  await go('read_file', { path: 'novel/mixed.txt' })
  await go('edit_file', { path: 'novel/mixed.txt' }, '<old>b\nc</old><new>B\nC</new>')
  assert.equal(await readFile(at('mixed.txt'), 'utf8'), 'a\r\nB\r\nC\r\nd')
  assert.deepEqual(notInGbk('雨👍a'), ['👍'])
  assert.equal(decodeText(Buffer.from([0x80, 0x81, 0xff, 0xfe])), null)
  assert.deepEqual(replaceOnce('a\r\nb\r\n', '\nb', '\nc'), { text: 'a\r\nc\r\n' })
  assert.deepEqual(replaceOnce('aaa', 'aa', 'b'), { found: 2 })
})

test('read only means read only; .git is never written', async t => {
  const { prepare, ctx, at } = await setup(t, { mode: 'read' })
  for (const [name, args, body] of [['write_file', { path: 'novel/a.txt' }, 'x'], ['edit_file', { path: 'novel/第一卷/一.txt' }, '<old>她</old><new>他</new>'], ['move_file', { path: 'novel/第一卷/一.txt', to: 'novel/b.txt' }], ['delete_file', { path: 'novel/第一卷/一.txt' }]]) {
    await assert.rejects(prepare(name, args, body), /只读/, name)
  }
  ctx.folders[0].mode = 'write'
  await mkdir(at('.git', 'hooks'), { recursive: true })
  await assert.rejects(prepare('write_file', { path: 'novel/.git/hooks/pre-commit' }, 'x'), /\.git/)
})

test('what is asked: every change, unless the folder is free; programs, keys and deleting always', async t => {
  const { prepare, go, ctx } = await setup(t, { free: true })
  await go('read_file', { path: 'novel/第一卷/一.txt' })
  assert.equal((await prepare('write_file', { path: 'novel/a.txt' }, 'x')).ask, 'no')
  assert.equal((await prepare('edit_file', { path: 'novel/第一卷/一.txt' }, '<old>雨</old><new>雪</new>')).ask, 'no')
  assert.equal((await prepare('move_file', { path: 'novel/第一卷/一.txt', to: 'novel/第一卷/二.txt' })).ask, 'no')
  for (const name of ['run.bat', 'x.ps1', 'a.js', '.env', 'package.json']) assert.equal((await prepare('write_file', { path: `novel/${name}` }, 'x')).ask, 'always', name)
  assert.equal((await prepare('move_file', { path: 'novel/第一卷/一.txt', to: 'novel/一.cmd' })).ask, 'always', 'renamed into a program')
  assert.equal((await prepare('delete_file', { path: 'novel/第一卷/一.txt' })).ask, 'always')
  ctx.folders[0].free = false
  assert.equal((await prepare('write_file', { path: 'novel/a.txt' }, 'x')).ask, 'write')
})

test('moving and deleting: never over another file, folders not at all', async t => {
  const { go, at, text, gone } = await setup(t)
  await writeFile(at('b.txt'), 'b')
  await assert.rejects(go('move_file', { path: 'novel/第一卷/一.txt', to: 'novel/b.txt' }), /已经有了/)
  await assert.rejects(go('move_file', { path: 'novel/第一卷', to: 'novel/c' }), /文件夹/)
  await go('move_file', { path: 'novel/b.txt', to: 'novel/深/处/c.txt' })
  assert.equal(await text('深', '处', 'c.txt'), 'b')
  assert.ok(await gone(at('b.txt')))
  await assert.rejects(go('delete_file', { path: 'novel/第一卷' }), /文件夹/)
  await go('delete_file', { path: 'novel/深/处/c.txt' })
  assert.ok(await gone(at('深', '处', 'c.txt')))
})

test('a hard link elsewhere keeps what it was', async t => {
  const { go, at, text, root } = await setup(t)
  await writeFile(path.join(root, 'outside.txt'), 'mine')
  await link(path.join(root, 'outside.txt'), at('linked.txt'))
  await go('read_file', { path: 'novel/linked.txt' })
  await go('write_file', { path: 'novel/linked.txt' }, 'changed')
  assert.equal(await text('linked.txt'), 'changed')
  assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8'), 'mine')
})

test('屏蔽词: a file the model saw changed is not rewritten whole', async t => {
  const { go } = await setup(t, { masked: text => text.includes('雨') })
  assert.match(await go('read_file', { path: 'novel/第一卷/一.txt' }), /屏蔽词/)
  await assert.rejects(go('write_file', { path: 'novel/第一卷/一.txt' }, 'x'), /屏蔽词/)
  await go('edit_file', { path: 'novel/第一卷/一.txt' }, '<old>她抬起头</old><new>她低下头</new>')
})

test('taking a turn back: changed, new, moved and deleted files, and the folders made', async t => {
  const { go, at, text, gone, history, ctx } = await setup(t)
  await writeFile(at('删.txt'), '要删的')
  await go('read_file', { path: 'novel/第一卷/一.txt' })
  await go('edit_file', { path: 'novel/第一卷/一.txt' }, '<old>雨</old><new>雪</new>')
  await go('edit_file', { path: 'novel/第一卷/一.txt' }, '<old>雪</old><new>霜</new>')
  await go('move_file', { path: 'novel/第一卷/一.txt', to: 'novel/新/一.txt' })
  await go('edit_file', { path: 'novel/新/一.txt' }, '<old>霜</old><new>雾</new>')
  await go('write_file', { path: 'novel/另/新.txt' }, '新')
  await go('delete_file', { path: 'novel/删.txt' })
  const view = await history.view(ctx.run)
  assert.deepEqual(view.files.map(file => file.op), ['write', 'write', 'move', 'write', 'create', 'delete'])
  assert.deepEqual((await history.runsOf('c1')).map(run => run.run), [ctx.run])
  assert.deepEqual(await history.runsOf('c2'), [])
  const done = await history.undo(ctx.run)
  assert.deepEqual([done.changed, done.failed], [[], []])
  assert.equal(await text('第一卷', '一.txt'), '她抬起头。\n雨停了。\n他说：走吧。\n')
  assert.equal(await text('删.txt'), '要删的')
  assert.ok(await gone(at('新')))
  assert.ok(await gone(at('另')))
  assert.equal((await history.view(ctx.run)).undone, true)
  // Once more does nothing.
  assert.deepEqual(await history.undo(ctx.run), { undone: [], changed: [], failed: [] })
  await assert.rejects(history.undo('0123456789abcdef'), { status: 404 })
  await assert.rejects(history.undo('../x'), { status: 400 })
})

test('taking back what was changed since: said first, done only when told, what it was kept', async t => {
  const { go, at, text, history, ctx, root } = await setup(t)
  await go('read_file', { path: 'novel/第一卷/一.txt' })
  await go('edit_file', { path: 'novel/第一卷/一.txt' }, '<old>雨</old><new>雪</new>')
  await go('write_file', { path: 'novel/新.txt' }, '新')
  await writeFile(at('第一卷', '一.txt'), '我后来改的')
  const asked = await history.undo(ctx.run)
  assert.deepEqual(asked, { undone: [], changed: ['novel/第一卷/一.txt'], failed: [] })
  assert.equal(await text('新.txt'), '新\n', 'nothing is done')
  const forced = await history.undo(ctx.run, { force: true })
  assert.equal(forced.failed.length, 0)
  assert.match(await text('第一卷', '一.txt'), /雨停了/)
  assert.equal(await readFile(path.join(root, 'history', ctx.run, '0.now'), 'utf8'), '我后来改的')
})

test('taking back does not follow a folder turned into a link', async t => {
  const { go, at, dir, root, history, ctx } = await setup(t)
  await go('read_file', { path: 'novel/第一卷/一.txt' })
  await go('edit_file', { path: 'novel/第一卷/一.txt' }, '<old>雨</old><new>雪</new>')
  const changed = await readFile(at('第一卷', '一.txt'))
  await rm(path.join(dir, '第一卷'), { recursive: true })
  await mkdir(path.join(root, 'elsewhere'))
  await writeFile(path.join(root, 'elsewhere', '一.txt'), changed)
  await symlink(path.join(root, 'elsewhere'), path.join(dir, '第一卷'), 'junction')
  assert.deepEqual((await history.undo(ctx.run, { force: true })).failed, ['novel/第一卷/一.txt'])
  assert.deepEqual(await readFile(path.join(root, 'elsewhere', '一.txt')), changed)
})

test('old versions go after 30 days', async t => {
  const { go, history, ctx, root } = await setup(t)
  await go('write_file', { path: 'novel/a.txt' }, 'x')
  await history.prune()
  assert.ok(await history.view(ctx.run))
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
  await utimes(path.join(root, 'history', ctx.run), old, old)
  await history.prune()
  assert.equal(await history.view(ctx.run), null)
})

test('a change line by line', () => {
  const diff = diffLines('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nd\nE\nf\ng\nh\n', { context: 1 })
  assert.deepEqual([diff.added, diff.removed], [1, 1])
  assert.deepEqual(diff.rows.map(row => `${row.kind}:${row.text || row.lines}`), ['gap:3', 'same:d', 'del:e', 'add:E', 'same:f', 'gap:2'])
  assert.deepEqual(diffLines('', 'x\n').rows, [{ kind: 'add', text: 'x' }])
  assert.deepEqual([diffLines('x\n', '').added, diffLines('x\n', '').removed], [0, 1])
  assert.equal(diffLines('', Array.from({ length: 900 }, (_, i) => `${i}`).join('\n')).clipped, 500)
  const many = n => Array.from({ length: 3000 }, (_, i) => `${n}${i}`).join('\n')
  assert.deepEqual([diffLines(many('a'), many('b')).added, diffLines(many('a'), many('b')).removed], [3000, 3000])
})

test('what the model is told: the folders, and the writing tools only where there is something to write', () => {
  const read = fileToolsText([{ label: '设定', mode: 'read' }])
  assert.match(read, /「设定」（只读）/)
  assert.doesNotMatch(read, /write_file/)
  assert.match(fileToolsText([{ label: '设定', mode: 'read' }, { label: '稿子', mode: 'write' }]), /delete_file/)
})
