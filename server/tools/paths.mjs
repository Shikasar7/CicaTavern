// Where 直连对话's file tools may go (plans/24 四): the folders the player added to the chat and nothing else. Every path
// the model writes is checked here twice: as text (what it must not say), then as the real place on disk it comes to
// (links, junctions and short names followed), against the folder and against the places nothing may touch.
import { lstat, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { msg } from '../i18n.mjs'

/** A path refused: said to the model as it is. */
export class PathError extends Error {}

// Folders of secrets, wherever they are.
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', '.claude', '.codex', '.gemini', '.agent-tavern', '.cicatavern'])
// Names Windows keeps for devices, whatever extension follows.
const DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(?:\..*)?$/i
// Read only when the player says so each time: files that usually hold keys.
const SENSITIVE = /^\.env(?:\..*)?$|\.(?:pem|key|pfx|p12|kdbx|keystore|jks|ppk)$|^id_(?:rsa|dsa|ecdsa|ed25519)|credential|secret|token|passwd|password|\.npmrc$|^\.netrc$|^\.git-credentials$/i
// Programs and scripts, and what starts one: writing them is asked each time.
const RUNS = /\.(?:exe|com|scr|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|mjs|cjs|jse|wsf|wsh|hta|msi|msp|reg|lnk|url|pif|cpl|dll|sys|jar|sh|bash|zsh|fish|command|app|applescript|scpt|workflow|desktop|py|pyw|rb|pl|php|service|plist|inf|scf|library-ms|settingcontent-ms)$/i
// Files a tool runs without being asked to by name (hooks, build files).
const RUNS_NAMED = /^(?:makefile|dockerfile|package\.json|\.bashrc|\.zshrc|\.profile|\.bash_profile|\.gitattributes|\.gitmodules|autorun\.inf|desktop\.ini)$/i

export const isSensitive = name => SENSITIVE.test(name)
export const runsThings = name => RUNS.test(name) || RUNS_NAMED.test(name)

/** The model's path as its parts, forward slashes; a path no folder of its own could be meant by throws. */
export function pathParts(value) {
  const text = String(value ?? '').trim()
  if (!text) throw new PathError('路径是空的')
  if (text.length > 1000) throw new PathError('路径太长了')
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new PathError('路径里有不能用的字符')
  const slashed = text.replace(/\\/g, '/')
  if (slashed.startsWith('/') || slashed.startsWith('~') || /^[a-z]:/i.test(slashed)) throw new PathError('只能写「文件夹名/里面的路径」，不能写绝对路径')
  const parts = slashed.split('/').filter((part, index, all) => part !== '' && !(part === '.' && all.length > 1))
  for (const part of parts) {
    if (part === '..') throw new PathError('路径里不能有 ..')
    if (part === '.') continue
    // A stream of a file (a.txt:b), and what Windows drops from a name's end (so it would be another name).
    if (/[:*?"<>|]/.test(part)) throw new PathError(`「${part}」里有不能用的字符`)
    if (/[. ]$/.test(part)) throw new PathError(`「${part}」不能以点或空格结尾`)
    if (DEVICE.test(part)) throw new PathError(`「${part}」是系统保留的名字`)
    if (part.length > 255) throw new PathError('文件名太长了')
  }
  return parts.filter(part => part !== '.')
}

/**
 * @param options - { dataRoot, appRoot, workspace, home, env, platform }: this install's own places; `workspace` is the one
 *   folder under dataRoot the tools may use.
 */
export function createGuard({ dataRoot, appRoot, workspace = null, home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix
  const folded = platform === 'win32' || platform === 'darwin'
  // macOS keeps names decomposed; compared the same way on both sides.
  const norm = value => {
    const text = api.resolve(String(value)).normalize('NFC')
    return folded ? text.toLowerCase() : text
  }
  const within = (real, root) => {
    const rel = api.relative(norm(root), norm(real))
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel))
  }
  const system = (platform === 'win32'
    ? [env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.ProgramData, env.APPDATA, env.LOCALAPPDATA, home && api.join(home, 'AppData')]
    : platform === 'darwin'
      ? ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/dev', '/opt', '/Applications', home && api.join(home, 'Library'), home && api.join(home, 'Applications')]
      : ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/proc', '/sys', '/dev', '/root', '/opt', home && api.join(home, '.config'), home && api.join(home, '.local')]
  ).filter(Boolean)
  const own = [dataRoot, appRoot].filter(Boolean)

  /** Why nothing may touch `real` (a resolved path), or ''. */
  function blocked(real) {
    if (workspace && within(real, workspace)) return ''
    if (own.some(root => within(real, root))) return msg`CicaTavern 自己的文件夹不能用（里面有供应商的密钥）`
    if (system.some(root => within(real, root))) return msg`系统的文件夹不能用`
    const parts = norm(real).split(/[\\/]+/)
    if (parts.some(part => SECRET_DIRS.has(part))) return msg`存密钥和登录信息的文件夹不能用`
    return ''
  }

  /** Why `real` cannot be added as a folder, or ''. */
  function unfit(real) {
    const why = blocked(real)
    if (why) return why
    if (api.parse(api.resolve(real)).root.toLowerCase() === api.resolve(real).toLowerCase()) return msg`不能加整个盘：选里面的一个文件夹`
    if (/^[\\/]{2}/.test(real)) return msg`不能加网络上的文件夹（\\\\开头的）`
    if (home && within(home, real)) return msg`不能加整个用户文件夹：选里面的一个文件夹`
    return ''
  }

  const isInside = (real, root) => within(real, root)

  /**
   * Where `parts` in `folder` ({ path }) comes to on disk: { real, exists, kind: 'file' | 'dir' | '' }. A part that is a
   * link is followed; what it comes to must still be inside the folder. Throws PathError.
   */
  async function locate(folder, parts) {
    const root = await realpath(folder.path).catch(() => null)
    if (!root) throw new PathError('这个文件夹现在打不开（被移走或删掉了）')
    const why = unfit(root)
    if (why) throw new PathError(why)
    let at = root
    let missing = []
    for (let i = 0; i < parts.length; i++) {
      const next = path.join(at, parts[i])
      // A link is there whether or not what it names is: a dead one must not become a new file somewhere else.
      const there = await lstat(next).catch(() => null)
      if (!there) {
        missing = parts.slice(i)
        break
      }
      const real = await realpath(next).catch(() => null)
      if (!real) throw new PathError(`「${parts[i]}」是一个失效的链接`)
      if (!within(real, root)) throw new PathError('这个路径是指向文件夹外面的链接，不能用')
      at = real
    }
    const real = missing.length ? path.join(at, ...missing) : at
    if (!within(real, root)) throw new PathError('路径到了文件夹外面')
    const barred = blocked(real)
    if (barred) throw new PathError(barred)
    if (missing.length) {
      const parent = await stat(at).catch(() => null)
      if (parent && !parent.isDirectory()) throw new PathError(`「${path.basename(at)}」是文件，不是文件夹`)
      return { root, real, exists: false, kind: '' }
    }
    const info = await stat(real)
    if (!info.isFile() && !info.isDirectory()) throw new PathError('这不是普通的文件')
    return { root, real, exists: true, kind: info.isDirectory() ? 'dir' : 'file', size: info.size }
  }

  /** Inside a repository's .git: read, never written (a hook there runs by itself). */
  const inGit = (real, root) => path.relative(root, real).split(/[\\/]+/).some(part => part.toLowerCase() === '.git')

  return { locate, blocked, unfit, isInside, inGit }
}
