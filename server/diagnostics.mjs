// 错误日志 (设置 → 更多 → 错误日志): what went wrong lately, kept in
// <data>/logs/errors.jsonl, and a report the player reads, then copies or saves
// to send to the developer. The app sends it nowhere. Errors and the setup
// only: no story, card text or prompts, unless the player ticks the open
// chat's last turn in. Keys, tokens, passwords, and the folders of this
// computer's user and of the app are taken out on the way in, and the keys
// saved in the data folder again in the report.
import { appendFileSync, mkdirSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir, release, type } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { activePath } from './chats.mjs'
import { msg } from './i18n.mjs'
import { refLabel } from './providers.mjs'

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// Entries kept, and shown in a report (newest first).
const KEEP = 200
const SHOWN = 50
const MESSAGE_MAX = 2000
const STACK_MAX = 4000
const STACK_LINES = 8
// The same error again within this long, among this many latest entries, counts on that entry instead of adding one.
const REPEAT_MS = 10 * 60_000
const REPEAT_LOOK = 20
const TURN_MAX = 20_000
const HIDDEN = '[redacted]'

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A folder as it shows in messages and stacks: either slash, and as a file:// URL. */
function folderPattern(dir) {
  const forms = new Set([dir, dir.replace(/\\/g, '/'), `file:///${dir.replace(/\\/g, '/').replace(/^\//, '')}`])
  return new RegExp([...forms].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'gi')
}
const APP_FOLDER = folderPattern(APP_ROOT)
const HOME_FOLDER = homedir() ? folderPattern(homedir()) : null

// Secrets as they show up in error texts, URLs and headers.
const SECRETS = [
  // sk-… (OpenAI, Anthropic, DeepSeek…), xai-, gsk_ (Groq), pst- (NovelAI), hf_, GitHub and GitLab tokens.
  [/\b(?:sk|rk|xai|gsk|pst|hf|ghp|gho|ghu|ghs|github_pat|glpat)[-_][A-Za-z0-9_-]{12,}/g, HIDDEN],
  // Google API keys.
  [/\bAIza[0-9A-Za-z_-]{20,}/g, HIDDEN],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${HIDDEN}`],
  // key=…, "apiKey": "…", Authorization: …, password=… (URLs, JSON, headers).
  [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|x-api-key|key)["']?\s*[:=]\s*["']?)[^\s"'&,;)}]{6,}/gi, `$1${HIDDEN}`],
  // user:password@ in a URL (a proxy's).
  [/(\/\/)[^\s/:@]+:[^\s/@]+@/g, `$1${HIDDEN}@`],
  [/data:([\w/+.-]+);base64,[A-Za-z0-9+/=]{40,}/g, 'data:$1;base64,…'],
  // Anything else long enough to be a token.
  [/\b[A-Za-z0-9_-]{40,}\b/g, HIDDEN],
]

/** Text with the secrets saved here (`known`) taken out. */
const withoutKnown = (text, known) => known.reduce((out, secret) => out.split(secret).join(HIDDEN), String(text ?? ''))

/** Text with secrets, this computer's user folder and the app's folder taken out. */
export function redact(text, known = []) {
  let out = withoutKnown(text, known)
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement)
  out = out.replace(APP_FOLDER, '<app>')
  if (HOME_FOLDER) out = out.replace(HOME_FOLDER, '~')
  return out
}

// A key name whose value is a secret, in the data folder's JSON files (providers.json, novelai.json, access.json…).
const SECRET_KEY = /key|token|secret|pass|auth|cookie/i
// What such a value must look like to be hidden everywhere it shows (not a word like "always").
const SECRET_VALUE = /^(?=\S*\d)\S{8,}$|^\S{20,}$/

/** The secrets saved in the data folder's own files: providers' keys and headers, tokens, passwords. */
export async function savedSecrets(root) {
  const found = new Set()
  const walk = (value, secret) => {
    if (typeof value === 'string') {
      if (secret && SECRET_VALUE.test(value.trim())) found.add(value.trim())
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, secret)
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, secret || key === 'headers' || SECRET_KEY.test(key))
    }
  }
  const names = await readdir(root).catch(() => [])
  for (const name of names.filter(name => name.endsWith('.json'))) {
    try {
      walk(JSON.parse(await readFile(path.join(root, name), 'utf8')), false)
    } catch {
      // Not JSON, or gone: nothing to hide from it.
    }
  }
  // The longest first, so a key containing another goes whole.
  return [...found].sort((a, b) => b.length - a.length)
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)
const pad = n => String(n).padStart(2, '0')

/** Local time: 2026-10-25 21:03:07 (with the offset when `zone`). */
function stamp(date, zone = false) {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  if (!zone) return day
  const offset = -date.getTimezoneOffset()
  return `${day} UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

/** An entry as kept: short, with its secrets and folders taken out. */
function cleanEntry(entry) {
  const text = (value, max) => clip(redact(typeof value === 'string' ? value : value == null ? '' : String(value)), max)
  // A page's stack names its scripts by address (the computer's, or a phone's LAN one): the path is enough.
  const stack = text(entry.stack, STACK_MAX).replace(/https?:\/\/[^/\s)]+\//g, '/')
  return {
    at: new Date().toISOString(),
    source: ['request', 'turn', 'page', 'process'].includes(entry.source) ? entry.source : 'page',
    what: text(entry.what, 200),
    ...(Number.isInteger(entry.status) ? { status: entry.status } : {}),
    message: text(entry.message, MESSAGE_MAX),
    ...(stack ? { stack } : {}),
    ...(entry.model ? { model: text(entry.model, 200) } : {}),
  }
}

/**
 * @param root - the data folder (its logs/ holds errors.jsonl).
 * @param store - for the report's setup and the last turn.
 * @param about - { version, edition, appName }.
 */
export function createDiagnostics(root, store, { version, edition, appName }) {
  const file = path.join(root, 'logs', 'errors.jsonl')
  let entries = null // oldest first
  let writing = Promise.resolve()

  async function load() {
    if (entries) return entries
    const text = await readFile(file, 'utf8').catch(() => '')
    const read = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry && typeof entry.at === 'string' && typeof entry.message === 'string') read.push(entry)
      } catch {
        // A line cut short by a crash.
      }
    }
    entries ??= read.slice(-KEEP)
    return entries
  }

  function save() {
    const lines = entries.map(entry => `${JSON.stringify(entry)}\n`).join('')
    writing = writing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, lines)
    }).catch(() => {})
    return writing
  }

  /**
   * Adds an entry ({ source, what, status, message, stack, model }). The same error again
   * soon, among the latest few, counts on that one and moves it up to the newest.
   */
  async function record(entry) {
    const next = cleanEntry(entry)
    const list = await load()
    const index = list.findLastIndex((old, i) => i >= list.length - REPEAT_LOOK && old.source === next.source && old.what === next.what && old.status === next.status && old.message === next.message && Date.now() - Date.parse(old.last ?? old.at) < REPEAT_MS)
    if (index >= 0) {
      const [same] = list.splice(index, 1)
      list.push({ ...same, count: (same.count ?? 1) + 1, last: next.at })
    } else {
      list.push(next)
      if (list.length > KEEP) list.splice(0, list.length - KEEP)
    }
    return save()
  }

  /** The process is going down (or, on the phone, carrying on past) an error nothing caught: written at once. */
  function recordNow(entry) {
    try {
      const next = cleanEntry(entry)
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(next)}\n`)
      entries?.push(next)
    } catch {
      // Nowhere else to write.
    }
  }

  /**
   * Errors nothing caught. The monitor does not change what happens next (the desktop
   * server exits); unhandled rejections are watched too where something already handles
   * them (the phone's entry), since then they do not reach the monitor.
   */
  function watchProcess() {
    const note = (error, origin) => recordNow({ source: 'process', what: origin, message: error?.message ?? String(error), stack: error?.stack })
    process.on('uncaughtExceptionMonitor', note)
    if (process.listenerCount('unhandledRejection') > 0) process.on('unhandledRejection', error => note(error, 'unhandledRejection'))
  }

  async function clear() {
    entries = []
    await save()
    return { count: 0 }
  }

  async function count(dir) {
    return (await readdir(dir).catch(() => [])).filter(name => !name.startsWith('.') && !/\.bak|\.tmp/i.test(name)).length
  }

  /** One entry for the report: when, where, what it said. */
  function entryLines(entry) {
    const where = entry.source === 'request' ? entry.what
      : entry.source === 'turn' ? (entry.model ? msg`生成回复 · ${entry.model}` : msg`生成回复`)
      : entry.source === 'process' ? msg`服务出错（${entry.what}）`
      : msg`页面（${entry.what}）`
    const times = entry.count > 1 ? `  ${msg`共 ${entry.count} 次，第一次 ${stamp(new Date(entry.at))}`}` : ''
    const head = `${stamp(new Date(entry.last ?? entry.at))}  ${where}${entry.status ? `  ${entry.status}` : ''}${times}`
    const stack = (entry.stack ?? '').split('\n').map(line => line.trim()).filter(Boolean)
    // The stack's first line repeats the message.
    if (stack[0] && entry.message && stack[0].includes(entry.message)) stack.shift()
    return [head, ...entry.message.split('\n').map(line => `  ${line}`), ...stack.slice(0, STACK_LINES).map(line => `    ${line}`)].join('\n')
  }

  /**
   * The text to send: the setup, the latest errors and, when asked, the open chat's last turn.
   * @param page - what the page knows: { userAgent, screen, standalone, language }.
   * @param chatId - the open chat; `lastTurn` adds its last input and reply.
   */
  async function report({ page = {}, chatId = '', lastTurn = false } = {}) {
    const [settings, providers, list, known] = await Promise.all([store.getSettings(), store.getProviders(), load(), savedSecrets(root)])
    const label = ref => (ref ? refLabel(ref, providers) ?? ref : msg`没选`)
    const proxy = settings.proxy === 'none' ? msg`不用` : settings.proxy === 'system' || !settings.proxy ? msg`跟随系统` : msg`手动设置`
    const [cards, chats, presets, books] = await Promise.all([count(store.dirs.cards), count(store.dirs.chats), count(store.dirs.presets), count(store.dirs.books)])
    const short = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
    const lines = [
      msg`${appName} 错误日志`,
      msg`生成于 ${stamp(new Date(), true)}`,
      '',
      msg`版本 ${version}（${edition}） · ${type()} ${release()} ${process.arch} · Node ${process.version}`,
      ...(page.userAgent ? [msg`页面：${short(page.userAgent)} · 屏幕 ${short(page.screen)}${page.standalone ? msg` · 应用窗口` : ''}`] : []),
      msg`界面语言 ${settings.uiLanguage} · 模型 ${label(settings.model)} · 辅助模型 ${label(settings.media?.helperModel)}`,
      msg`代理 ${proxy} · 手机访问 ${settings.listen === 'lan' ? msg`开` : msg`关`} · 卡 ${cards} 张 · 对话 ${chats} 个 · 预设 ${presets} 个 · 世界书 ${books} 本`,
    ]
    if (providers.length) {
      lines.push(msg`模型供应商：`)
      for (const provider of providers) {
        let host = ''
        try {
          host = new URL(provider.baseURL).host
        } catch {
          host = msg`默认地址`
        }
        lines.push(`  ${provider.name} · ${provider.api} · ${host} · ${msg`${provider.models?.length ?? 0} 个模型`}`)
      }
    }
    lines.push('')
    const newest = [...list].reverse()
    if (!newest.length) lines.push(msg`还没有记录到错误。`)
    else {
      lines.push(msg`最近的错误（${newest.length} 条，新的在前）：`, '')
      for (const entry of newest.slice(0, SHOWN)) lines.push(entryLines(entry), '')
      if (newest.length > SHOWN) lines.push(msg`更早的 ${newest.length - SHOWN} 条没有列出。`, '')
    }
    const text = redact(lines.join('\n').trimEnd(), known)
    if (!lastTurn || !chatId) return { text, count: list.length }
    // The player's own story, as they chose to send it: only the keys saved here come out.
    const chat = await store.getChat(String(chatId)).catch(() => null)
    const nodes = chat ? activePath(chat) : []
    const reply = nodes.findLast(node => node.role === 'assistant' && node.id !== 'root')
    const input = reply ? nodes.slice(0, nodes.indexOf(reply)).findLast(node => node.role === 'user') : null
    const card = chat ? await store.getCard(chat.cardId).catch(() => null) : null
    const turn = [msg`── 当前对话的最后一轮（导出时勾选了附带） ──`]
    if (!reply) turn.push(msg`这个对话还没有回复。`)
    else {
      turn.push(
        msg`对话「${chat.title ?? ''}」 · 卡「${card?.name ?? chat.names?.char ?? ''}」 · 预设「${chat.presetName ?? ''}」 · 模型 ${label(chat.model || settings.model)}`,
        '',
        msg`你的输入：`,
        clip(input?.text ?? '', TURN_MAX),
        '',
        msg`模型的原始输出：`,
        clip(reply.text ?? '', TURN_MAX),
      )
    }
    return { text: `${text}\n\n${withoutKnown(turn.join('\n'), known)}`, count: list.length }
  }

  return { record, recordNow, watchProcess, clear, report, list: async () => [...(await load())] }
}
