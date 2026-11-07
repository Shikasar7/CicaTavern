// Codex（本机）as a 画图方式, on a computer (features.codexDrawing): the Codex CLI the
// user installed and signed in to themselves, run the way OpenAI offers it to other
// programs: `codex exec` with an instruction on stdin to draw with its built-in image
// generation tool and answer with the file's path; the picture is read from there, or
// failing that, the newest one Codex saved since the start. This app never signs in
// for it or reads its credentials: auth.json is only looked for. The model is always
// passed (-m): the account's default gets switched by other tools. Reference pictures
// go along as -i.
//
// A picture takes one to three minutes: one at a time, ten minutes at most, and
// the process tree is killed when the request goes away. media.mjs calls this
// as one of the install's own backends ({ id, status, draw }).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { httpError } from './store.mjs'
import { currentLanguage } from './i18n.mjs'
import { createTag } from '../web/shared/i18n.js'

// English for this file's messages (界面语言), kept with them. scripts/i18n-check.mjs reads it between the markers.
// i18n-dictionary-start
const ENGLISH = {
  'Codex（本机）': 'Codex (this PC)',
  '没装 Codex': 'Codex not installed',
  'Codex 没登录': 'Codex not signed in',
  '用这台电脑上的 Codex 画（ChatGPT 订阅里的图片生成）。一张要一到三分钟，一次画一张；名册角色有人设图时会一起发过去，长相更稳。OpenAI 不画露骨的画面，这类图换 NovelAI 画。':
    "Draws with Codex on this computer (the image generation in your ChatGPT subscription). A picture takes one to three minutes, one at a time; cast members' reference pictures go along so faces stay the same. OpenAI won't draw explicit scenes: use NovelAI for those.",
  '没找到 Codex：先装好 Codex CLI（npm i -g @openai/codex），再在终端运行 codex login 登录。': 'Codex not found: install the Codex CLI (npm i -g @openai/codex), then run codex login in a terminal.',
  'Codex 还没登录：在终端运行 codex login，用 ChatGPT 账号登录。': "Codex isn't signed in: run codex login in a terminal and sign in with your ChatGPT account.",
  'Codex 没登录或登录过期了：在终端运行 codex login 再试。': "Codex isn't signed in, or the sign-in has expired: run codex login in a terminal and try again.",
  'Codex 不画这张：{0}。OpenAI 不画露骨的画面，这类图可以在画图方式里换 NovelAI。': "Codex won't draw this one: {0}. OpenAI doesn't draw explicit scenes; for those, pick NovelAI as the image backend.",
  '{0} 在 ChatGPT 登录下用不了：在「配图与朗读 → 画图方式」里给 Codex 换一个模型。': "{0} isn't available with a ChatGPT sign-in: pick another model for Codex in Pictures & voice → Image backend.",
  'Codex 画图被拒绝（403）：ChatGPT 订阅可能过期了，或者这个账号用不了图片生成。': 'Codex was refused image generation (403): the ChatGPT subscription may have lapsed, or this account has no image generation.',
  'Codex 的用量到上限了，等额度恢复再画。': "Codex has reached its usage limit. Draw again once it resets.",
  'Codex 十分钟还没画完，停下了。': "Codex hadn't finished after ten minutes, so it was stopped.",
  'Codex 没有画出图（退出码 {0}）：{1}': "Codex didn't produce a picture (exit code {0}): {1}",
  '已经停下了。': 'Stopped.',
  '装 Codex CLI：先装 Node.js（nodejs.org 下载安装），再在终端运行：': 'Install the Codex CLI: install Node.js first (from nodejs.org), then run in a terminal:',
  '装 Codex CLI：在终端运行（没有 Homebrew 的话，装好 Node.js 后用 npm i -g @openai/codex）：': "Install the Codex CLI: run in a terminal (without Homebrew, install Node.js and use npm i -g @openai/codex):",
  '装 Codex CLI，在终端运行：': 'Install the Codex CLI by running in a terminal:',
  '登录：在终端运行下面这句，在打开的网页里用 ChatGPT 账号登录。CicaTavern 不经手登录，也不读你的登录信息。': 'Sign in: run this in a terminal and sign in with your ChatGPT account on the page it opens. CicaTavern takes no part in the sign-in and never reads it.',
  '回到这里点「重新检查」，状态变成可用就能用它画图；下面可以选模型，不选就用默认的。': 'Come back and click Check again. Once it says ready, it can draw; pick a model below, or leave the default.',
  'Codex CLI 说明 ↗': 'Codex CLI docs ↗',
}
// i18n-dictionary-end
const tags = { zh: createTag(null), en: createTag(ENGLISH) }
const msg = (strings, ...args) => tags[currentLanguage()](strings, ...args)

export const CODEX_ID = 'codex'
const TIMEOUT = 10 * 60 * 1000
// The app's shapes as gpt-image sizes.
export const CODEX_SIZES = Object.freeze({ square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' })
// Drawn with when nothing is picked and the account lists it: it has drawn reliably.
const PREFERRED = 'gpt-6-luna'
const MAX_REFERENCES = 4
const IMAGE_FILE = /\.(png|jpe?g|webp)$/i
const OUTPUT_TAIL = 8000

export const codexHome = (env = process.env) => env.CODEX_HOME || path.join(homedir(), '.codex')

/** The account's models as Codex last listed them (models_cache.json): [{ id, label }], by Codex's own order. */
export async function codexModels(home = codexHome()) {
  try {
    const cache = JSON.parse(await readFile(path.join(home, 'models_cache.json'), 'utf8'))
    return (Array.isArray(cache?.models) ? cache.models : [])
      .filter(m => m && typeof m.slug === 'string' && m.slug && m.visibility !== 'hide')
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map(m => ({ id: m.slug, label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug }))
  } catch {
    return []
  }
}

/** The model when none is picked: the preferred one where the account has it, else Codex's first. */
export const defaultModel = models => (models.some(m => m.id === PREFERRED) ? PREFERRED : models[0]?.id ?? PREFERRED)

/**
 * Where Codex may be besides the PATH: an app opened from the Finder or the Start menu gets a short one, without
 * Homebrew's folder or npm's global one.
 */
export function usualCodexDirs(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') return [env.APPDATA && path.join(env.APPDATA, 'npm')].filter(Boolean)
  return ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin')]
}

/**
 * How to start Codex: [program, ...leading args], or null. npm's codex is a script for Node (on Windows a codex.cmd
 * shim, which can't be spawned without a shell; elsewhere a link to codex.js, which asks for a `node` the app's PATH
 * may not have), so its codex.js runs with this Node; Homebrew's and the standalone one are programs.
 */
export function findCodex(env = process.env, platform = process.platform, extra = usualCodexDirs(env, platform)) {
  const dirs = [...String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean), ...extra]
  for (const dir of dirs) {
    if (platform === 'win32') {
      const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      if (existsSync(path.join(dir, 'codex.cmd')) && existsSync(script)) return [process.execPath, script]
      if (existsSync(path.join(dir, 'codex.exe'))) return [path.join(dir, 'codex.exe')]
      continue
    }
    const file = path.join(dir, 'codex')
    if (!existsSync(file)) continue
    let real = file
    try {
      real = realpathSync(file)
    } catch {
      // A broken link: tried as it is.
    }
    return /\.m?js$/.test(real) ? [process.execPath, real] : [file]
  }
  return null
}

/** What Codex is asked, on stdin. A refusal is asked for in a form that can be told apart. */
export function codexInstruction(prompt, { size = CODEX_SIZES.square, references = 0 } = {}) {
  const lines = [
    'Use your built-in image generation tool (NOT any script, NOT the CLI fallback) to generate 1 image for the request below.',
    `Image size: ${size}.`,
    'Do not ask questions; make reasonable choices. Do not copy or move files.',
    'When done, reply with ONLY the absolute file path of the generated image.',
    'If you will not draw it, reply with one line that starts with REFUSED: and says why.',
  ]
  if (references) lines.push(`The ${references} attached image(s) are reference pictures of the characters in it: keep their faces, hair and build the same in the new picture.`)
  return [...lines, '', 'Request:', String(prompt ?? '').trim()].join('\n')
}

/** The picture's path in Codex's answer: the first line naming an image file that exists. */
export function pathFromReply(reply) {
  for (const raw of String(reply ?? '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*]\s+/, '').replace(/^!?\[[^\]]*\]\((.*)\)$/, '$1').replace(/^[`"'<]+|[`"'>]+$/g, '').trim()
    if (line && IMAGE_FILE.test(line) && path.isAbsolute(line) && existsSync(line)) return line
  }
  return null
}

/** The newest picture Codex saved under its generated_images since `since` (ms), or null. */
export async function newestSince(dir, since) {
  let names
  try {
    names = await readdir(dir, { recursive: true })
  } catch {
    return null
  }
  let best = null
  for (const name of names.map(String).filter(n => IMAGE_FILE.test(n))) {
    const file = path.join(dir, name)
    const info = await stat(file).catch(() => null)
    if (info?.isFile() && info.mtimeMs >= since - 1000 && (!best || info.mtimeMs > best.time)) best = { file, time: info.mtimeMs }
  }
  return best?.file ?? null
}

const REFUSAL = /^\s*REFUSED:|can(?:no|')t (?:help|create|generate|draw)|unable to (?:create|generate|draw)|won't (?:create|generate|draw)|content policy|not able to (?:create|generate)|无法(?:生成|绘制|画)|不能(?:生成|画)/im

/** Why nothing was drawn, in words that say what to do. */
export function codexError({ output = '', reply = '', model = '', code = null } = {}) {
  const said = String(reply ?? '').trim()
  if (said && REFUSAL.test(said)) return msg`Codex 不画这张：${said.replace(/^\s*REFUSED:\s*/i, '').replace(/\s+/g, ' ').slice(0, 160).replace(/[。.!！\s]+$/, '')}。OpenAI 不画露骨的画面，这类图可以在画图方式里换 NovelAI。`
  const text = `${output}\n${said}`
  if (/not supported (?:when using Codex )?with a ChatGPT account|model[^\n]{0,80}(?:is not supported|not found|does not exist)|unsupported model|model_not_found/i.test(text)) return msg`${model} 在 ChatGPT 登录下用不了：在「配图与朗读 → 画图方式」里给 Codex 换一个模型。`
  if (/\b403\b|forbidden/i.test(text)) return msg`Codex 画图被拒绝（403）：ChatGPT 订阅可能过期了，或者这个账号用不了图片生成。`
  if (/not logged in|please (?:log|sign) ?in|codex login|\b401\b|unauthori[sz]ed|token (?:has )?expired|refresh token/i.test(text)) return msg`Codex 没登录或登录过期了：在终端运行 codex login 再试。`
  if (/usage limit|rate limit|\b429\b|quota/i.test(text)) return msg`Codex 的用量到上限了，等额度恢复再画。`
  const tail = text.replace(/\s+/g, ' ').trim().slice(-240) || said.slice(0, 160)
  return msg`Codex 没有画出图（退出码 ${code ?? '?'}）：${tail}`
}

/** End a run and whatever it started (on Windows, Codex runs under a Node wrapper). */
function killTree(child) {
  if (child.exitCode !== null || child.killed) return
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
  else child.kill('SIGTERM')
}

/** One run of Codex: { code, output } (stdout and stderr, the last part); throws when stopped or too slow. */
function runCodex(command, args, { input, cwd, env, signal, timeout = TIMEOUT }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error(msg`已经停下了。`), { name: 'AbortError' }))
    const child = spawn(command[0], [...command.slice(1), ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let why = null
    const keep = chunk => (output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL))
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const stop = reason => {
      why ??= reason
      killTree(child)
    }
    const timer = setTimeout(() => stop('timeout'), timeout)
    const onAbort = () => stop('abort')
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    child.on('error', error => {
      done()
      reject(error.code === 'ENOENT' ? httpError(400, msg`没找到 Codex：先装好 Codex CLI（npm i -g @openai/codex），再在终端运行 codex login 登录。`) : error)
    })
    child.on('close', code => {
      done()
      if (why === 'abort') return reject(Object.assign(new Error(msg`已经停下了。`), { name: 'AbortError' }))
      if (why === 'timeout') return reject(httpError(504, msg`Codex 十分钟还没画完，停下了。`))
      resolve({ code, output })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/** How to set it up on this computer, for 设置 → 画图方式: steps, each with the command to run if it has one. */
export function codexGuide(platform = process.platform) {
  const install = platform === 'win32'
    ? { text: msg`装 Codex CLI：先装 Node.js（nodejs.org 下载安装），再在终端运行：`, command: 'npm i -g @openai/codex' }
    : platform === 'darwin'
      ? { text: msg`装 Codex CLI：在终端运行（没有 Homebrew 的话，装好 Node.js 后用 npm i -g @openai/codex）：`, command: 'brew install codex' }
      : { text: msg`装 Codex CLI，在终端运行：`, command: 'npm i -g @openai/codex' }
  return {
    steps: [
      install,
      { text: msg`登录：在终端运行下面这句，在打开的网页里用 ChatGPT 账号登录。CicaTavern 不经手登录，也不读你的登录信息。`, command: 'codex login' },
      { text: msg`回到这里点「重新检查」，状态变成可用就能用它画图；下面可以选模型，不选就用默认的。` },
    ],
    link: { url: 'https://github.com/openai/codex', label: msg`Codex CLI 说明 ↗` },
  }
}

/**
 * Codex as an image backend for media.mjs.
 * @param proxy - the app's proxy now (a URL or null): handed to Codex when the
 *   environment names none, so it reaches OpenAI the way the app does.
 * @param command - [program, ...args] to run instead of the Codex found on PATH (tests).
 * @param home - Codex's own folder (CODEX_HOME, else ~/.codex).
 */
export function createCodexDrawing({ store, proxy = () => null, command = null, home = codexHome(), timeout = TIMEOUT } = {}) {
  const workRoot = path.join(store.dirs.root, 'media', 'codex-work')
  const commandFor = () => command ?? findCodex()
  const signedIn = () => existsSync(path.join(home, 'auth.json'))

  // One picture at a time: Codex is slow and finds a picture by its path, or by the newest file.
  let tail = Promise.resolve()
  const alone = fn => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => {})
    return run
  }

  function environment() {
    const env = { ...process.env }
    const url = proxy?.()
    const named = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some(key => env[key])
    if (url && !named) Object.assign(env, { HTTPS_PROXY: url, HTTP_PROXY: url })
    return env
  }

  async function draw({ prompt, shape = 'square', references = [], model = '', signal } = {}) {
    const program = commandFor()
    if (!program) throw httpError(400, msg`没找到 Codex：先装好 Codex CLI（npm i -g @openai/codex），再在终端运行 codex login 登录。`)
    if (!signedIn()) throw httpError(400, msg`Codex 还没登录：在终端运行 codex login，用 ChatGPT 账号登录。`)
    const chosen = model || defaultModel(await codexModels(home))
    return alone(async () => {
      if (signal?.aborted) throw Object.assign(new Error(msg`已经停下了。`), { name: 'AbortError' })
      const work = path.join(workRoot, `${Date.now()}-${randomBytes(4).toString('hex')}`)
      await mkdir(work, { recursive: true })
      try {
        const refs = []
        for (const [i, buffer] of references.slice(0, MAX_REFERENCES).entries()) {
          const file = path.join(work, `reference-${i + 1}.${buffer[0] === 0xff ? 'jpg' : 'png'}`)
          await writeFile(file, buffer)
          refs.push(file)
        }
        const last = path.join(work, 'last-message.txt')
        const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-C', work, '-o', last, ...refs.flatMap(file => ['-i', file]), '-m', chosen, '-']
        const started = Date.now()
        const { code, output } = await runCodex(program, args, { input: codexInstruction(prompt, { size: CODEX_SIZES[shape] ?? CODEX_SIZES.square, references: refs.length }), cwd: work, env: environment(), signal, timeout })
        const reply = await readFile(last, 'utf8').catch(() => '')
        const file = pathFromReply(reply) ?? (REFUSAL.test(reply) ? null : await newestSince(path.join(home, 'generated_images'), started))
        if (!file) throw httpError(502, codexError({ output, reply, model: chosen, code }))
        return { buffer: await readFile(file), label: `Codex · ${chosen}`, note: '' }
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {})
      }
    })
  }

  return {
    id: CODEX_ID,
    draw,
    /** For the picker and 设置 → 画图方式: whether it can draw, the account's models, the one used when none is picked. */
    async status() {
      const models = await codexModels(home)
      const installed = Boolean(commandFor())
      const ready = installed && signedIn()
      return {
        id: CODEX_ID,
        name: msg`Codex（本机）`,
        ready,
        need: ready ? '' : installed ? msg`Codex 没登录` : msg`没装 Codex`,
        hint: msg`用这台电脑上的 Codex 画（ChatGPT 订阅里的图片生成）。一张要一到三分钟，一次画一张；名册角色有人设图时会一起发过去，长相更稳。OpenAI 不画露骨的画面，这类图换 NovelAI 画。`,
        models,
        model: defaultModel(models),
        guide: codexGuide(),
      }
    },
  }
}
