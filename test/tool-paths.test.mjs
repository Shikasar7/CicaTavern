// 直连对话的文件工具, where they may go (server/tools/paths.mjs): what a path may say, links and junctions, the places
// nothing may touch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGuard, isSensitive, PathError, pathParts, runsThings } from '../server/tools/paths.mjs'

const windows = process.platform === 'win32'

async function setup(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cica-paths-')))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const folder = path.join(root, 'novel')
  const outside = path.join(root, 'outside')
  await mkdir(path.join(folder, 'chapters'), { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(folder, 'chapters', '一.txt'), '雨')
  await writeFile(path.join(outside, 'key.txt'), 'secret')
  // None of this machine's own places (the temp folder is in one of them).
  const guard = createGuard({ dataRoot: path.join(root, 'data'), appRoot: path.join(root, 'app'), workspace: path.join(root, 'data', 'workspace'), home: path.join(root, 'home', 'me'), env: {} })
  return { root, folder, outside, guard }
}

test('what a path may say', () => {
  assert.deepEqual(pathParts('novel/chapters/一.txt'), ['novel', 'chapters', '一.txt'])
  assert.deepEqual(pathParts(' novel\\chapters//./一.txt '), ['novel', 'chapters', '一.txt'])
  assert.deepEqual(pathParts('novel/.gitignore'), ['novel', '.gitignore'])
  for (const bad of ['', '  ', '/etc/passwd', '\\\\server\\share\\a', '\\\\?\\C:\\a', '//./PhysicalDrive0', 'C:\\a', 'C:a', 'c:', '~/a', 'a/../b', '..', 'a\\..\\..\\b', 'a.txt:b', 'a.txt::$DATA', 'a/CON', 'a/nul.txt', 'a/com1.log', 'a/LPT¹', 'a/b.', 'a /b', 'a/b\u0000.txt', 'a/b\nc', 'a/*.txt', 'a/b?', `${'x/'.repeat(600)}a`, `a/${'x'.repeat(300)}`]) {
    assert.throws(() => pathParts(bad), PathError, JSON.stringify(bad))
  }
})

test('a file inside, a new one, and the folder itself', async t => {
  const { folder, guard } = await setup(t)
  const here = await guard.locate({ path: folder }, ['chapters', '一.txt'])
  assert.deepEqual([here.exists, here.kind, here.real], [true, 'file', path.join(folder, 'chapters', '一.txt')])
  const fresh = await guard.locate({ path: folder }, ['new', 'deep', '二.txt'])
  assert.deepEqual([fresh.exists, fresh.real], [false, path.join(folder, 'new', 'deep', '二.txt')])
  assert.equal((await guard.locate({ path: folder }, [])).kind, 'dir')
  await assert.rejects(guard.locate({ path: folder }, ['chapters', '一.txt', 'x']), PathError)
  await assert.rejects(guard.locate({ path: path.join(folder, 'gone') }, []), /打不开/)
})

test('links out of the folder are refused, dead ones too; links within it are followed', async t => {
  const { folder, outside, guard } = await setup(t)
  // A junction needs no rights on Windows.
  await symlink(outside, path.join(folder, 'out'), 'junction')
  await symlink(path.join(folder, 'chapters'), path.join(folder, 'in'), 'junction')
  await symlink(path.join(outside, 'gone'), path.join(folder, 'dead'), 'junction')
  await assert.rejects(guard.locate({ path: folder }, ['out', 'key.txt']), /文件夹外面/)
  await assert.rejects(guard.locate({ path: folder }, ['out', 'new.txt']), /文件夹外面/)
  await assert.rejects(guard.locate({ path: folder }, ['dead', 'new.txt']), /失效的链接/)
  assert.equal((await guard.locate({ path: folder }, ['in', '一.txt'])).real, path.join(folder, 'chapters', '一.txt'))
  if (windows) return
  await symlink(path.join(outside, 'key.txt'), path.join(folder, 'key.txt'))
  await assert.rejects(guard.locate({ path: folder }, ['key.txt']), /文件夹外面/)
})

test('a folder that is itself a link is where it leads: checked there', async t => {
  const { root, folder, guard } = await setup(t)
  await mkdir(path.join(root, 'data'))
  await writeFile(path.join(root, 'data', 'providers.json'), '{}')
  await symlink(path.join(root, 'data'), path.join(root, 'looks-fine'), 'junction')
  await assert.rejects(guard.locate({ path: path.join(root, 'looks-fine') }, ['providers.json']), PathError)
  await symlink(folder, path.join(root, 'alias'), 'junction')
  assert.equal((await guard.locate({ path: path.join(root, 'alias') }, ['chapters', '一.txt'])).exists, true)
})

test('a folder next to it with the same beginning is not inside it; case follows the system', async t => {
  const { root, folder, guard } = await setup(t)
  assert.equal(guard.isInside(path.join(root, 'novel2', 'a'), folder), false)
  assert.equal(guard.isInside(path.join(folder, 'a'), folder), true)
  assert.equal(guard.isInside(path.join(folder, '..a'), folder), true)
  if (windows) assert.equal(guard.isInside(path.join(folder.toUpperCase(), 'A'), folder), true)
})

test('places nothing may touch: the app’s own, the system’s, folders of secrets; the workspace is the exception', async t => {
  const { root, folder, guard } = await setup(t)
  assert.ok(guard.blocked(path.join(root, 'data', 'providers.json')))
  assert.ok(guard.blocked(path.join(root, 'app', 'server', 'http.mjs')))
  assert.equal(guard.blocked(path.join(root, 'data', 'workspace', 'a.txt')), '')
  assert.equal(guard.blocked(path.join(folder, 'a.txt')), '')
  for (const dir of ['.ssh', '.SSH', '.gnupg', '.aws', '.codex', '.claude', '.gemini']) assert.ok(guard.blocked(path.join(folder, dir === '.SSH' && !windows && process.platform !== 'darwin' ? '.ssh' : dir, 'x')), dir)
  const win = createGuard({ dataRoot: 'D:\\data', appRoot: 'D:\\app', home: 'C:\\Users\\me', platform: 'win32', env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } })
  for (const bad of ['C:\\windows\\system32', 'c:\\PROGRAM FILES\\x', 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup', 'D:\\Data\\x', 'C:\\Users\\me\\.ssh\\id']) assert.ok(win.blocked(bad), bad)
  assert.equal(win.blocked('C:\\Users\\me\\Documents\\小说\\a.txt'), '')
  for (const bad of ['C:\\', 'D:\\', 'C:\\Users', 'C:\\Users\\me', 'C:\\Users\\me\\', '\\\\nas\\share']) assert.ok(win.unfit(bad), bad)
  assert.equal(win.unfit('C:\\Users\\me\\Documents'), '')
  assert.equal(win.unfit('D:\\novels'), '')
  const mac = createGuard({ dataRoot: '/Users/me/.cicatavern', appRoot: '/Applications/CicaTavern.app', home: '/Users/me', platform: 'darwin', env: {} })
  for (const bad of ['/', '/Users', '/Users/me', '/etc', '/private/etc', '/Users/me/Library/LaunchAgents', '/Users/me/.SSH', '/System']) assert.ok(mac.unfit(bad), bad)
  assert.equal(mac.unfit('/Users/me/Documents/novel'), '')
})

test('a blocked place inside an added folder stays blocked', async t => {
  const { folder, guard } = await setup(t)
  await mkdir(path.join(folder, '.ssh'))
  await writeFile(path.join(folder, '.ssh', 'id_rsa'), 'x')
  await assert.rejects(guard.locate({ path: folder }, ['.ssh', 'id_rsa']), PathError)
  await assert.rejects(guard.locate({ path: folder }, ['.ssh', 'new']), PathError)
})

test('names asked about: keys when read, programs when written; .git is never written', async t => {
  const { folder, guard } = await setup(t)
  for (const name of ['.env', '.env.local', 'server.pem', 'id_rsa', 'id_ed25519.pub', 'my-credentials.json', 'API_SECRET.txt', 'access_token.txt', 'vault.kdbx', '.netrc']) assert.ok(isSensitive(name), name)
  for (const name of ['第三章.txt', 'environment.md', 'notes.env.md', 'keys.md']) assert.equal(isSensitive(name), false, name)
  for (const name of ['a.EXE', 'run.ps1', 'x.lnk', 'a.sh', 'a.command', 'Makefile', 'package.json', 'index.js', 'a.py', 'desktop.ini']) assert.ok(runsThings(name), name)
  for (const name of ['a.txt', 'a.md', 'a.json', 'a.yaml', 'a.html', 'a.csv']) assert.equal(runsThings(name), false, name)
  assert.equal(guard.inGit(path.join(folder, '.git', 'hooks', 'x'), folder), true)
  assert.equal(guard.inGit(path.join(folder, '.GIT', 'x'), folder), true)
  assert.equal(guard.inGit(path.join(folder, '.gitignore'), folder), false)
})

test('a hard link is seen as the file it is here', async t => {
  const { folder, outside, guard } = await setup(t)
  await link(path.join(outside, 'key.txt'), path.join(folder, 'linked.txt'))
  // Cannot be told apart by its path: writing makes a new file (files.mjs), so the one outside is not changed.
  assert.equal((await guard.locate({ path: folder }, ['linked.txt'])).exists, true)
})
