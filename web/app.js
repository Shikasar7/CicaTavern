// Agent Tavern web UI. Plain DOM, no build step.
import { blockShown, displayOf, htmlFrame, listenForFrameHeights, nameMacros, segments, streamingText, useBlockWords, usesStatusPlaceholder, withoutOwnStatus } from '/render.js'
import { choiceList, statusBar, timeBox } from '/status.js'
import { BASIC_ID, VN_ID, builtinKey, builtinOptions, choicesOf, isBuiltinPreset, otherChoices, timeBoxOf } from '/shared/basic.js'
import { autoStatusSpec } from '/shared/status.js'
import { basicField, fieldsOf } from '/basic-options.js'
import { allowLibraries, broadcastChatVars, broadcastInput, broadcastRelay, broadcastState, installFrameBridge, parseSlash, storedFrameStorage, storedVariables } from '/compat.js'
import { renderUsage } from '/usage.js'
import { initPresets } from '/presets.js'
import { initProviders } from '/providers.js'
import { initMedia } from '/media.js'
import { initHistory } from '/history.js'
import { createMenu, MENU_ICONS, whoLine } from '/menu.js'
import { initForge } from '/forge.js'
import { initUpdate } from '/update.js'
import { initWhatsNew } from '/whatsnew.js'
import { connectionList, showPrivacyNotice } from '/privacy.js'
import { initTheme } from '/theme.js'
import { initRegex } from '/regex.js'
import { countText, initBooks, matchesTerms, searchBox, searchTerms } from '/books.js'
import { initCardEdit } from '/card-edit.js'
import { initTalkDialog } from '/talk-dialog.js'
import { initDrawChoice } from '/draw-choice.js'
import { initCardPermissions } from '/card-permissions.js'
import { createFramePermissions } from '/shared/frame-permissions.js'
import { initVn } from '/vn.js'
import { markSpeakers } from '/shared/vn.js'
import { chatScriptList, isRegexFile, scriptsInFile } from '/shared/regex.js'
import { lang, locale, t, zh } from '/i18n.js'
import { pickLanguage } from '/shared/i18n.js'

const $ = id => document.getElementById(id)
const EMPTY = $('empty')

// The subscription's parts of the page (/subscription.js), where the server has the subscription.
let subscriptionPage = null

const ui = {
  cards: [],
  archiveOpen: false, // the card list's 已归档 section, folded until opened
  books: [],
  chats: [],
  cardId: null,
  chat: null,
  settings: null,
  globalRegex: [], // 正则 → 全局: run before every chat's preset and card scripts
  regexSets: [], // 正则集: run after the card's own scripts in the chats of the cards ticked for them
  blockWords: [], // 屏蔽词: taken out of what is sent and shown (web/shared/blockwords.js)
  persona: null, // the default persona (你的角色), for names before a chat is open
  personas: null, // 你的角色 and 文风 as lists (web/shared/personas.js), loaded with the settings
  styles: null,
  // Work in progress per chat: chatId → { kind: 'turn'|'compact'|'server', text, note, echo }.
  // A turn keeps streaming when you switch chats; switching back redraws it.
  busy: new Map(),
  /** The open chat is busy (input, swipes and the like wait). Other chats are unaffected. */
  get generating() {
    return Boolean(this.chat && this.busy.has(this.chat.id))
  },
  branchFrom: null, // { parentId, label } — send from this node instead of the tip
  cardDetails: new Map(), // cardId → card detail incl. regexScriptList
  presetDetails: new Map(), // presetId → preset detail incl. regexScriptList
  models: [], // /api/models choices
  defaultModel: null,
  usageDays: 7,
  rateLimit: null,
}

// ─── Models ─────────────────────────────────────────────────────────────
const labelOf = id => ui.models.find(m => id && (m.id === id || String(id).startsWith(`${m.id}-`)))?.label ?? id ?? '—'
const MANAGE_PROVIDERS = '__providers'

function modelOption(m, selected) {
  return el('option', { value: m.id, selected: selected === m.id, title: m.note || undefined, text: m.extraCredits ? t`${m.label}（需额外用量额度）` : m.label })
}

/** Options grouped by source (one group per provider). */
function modelOptions(selected) {
  const groups = new Map()
  for (const m of ui.models) {
    const group = m.group ?? t`其他`
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(modelOption(m, selected))
  }
  return [...groups].map(([label, options]) => el('optgroup', { label }, options))
}

async function loadModels() {
  try {
    const data = await api('/api/models')
    ui.models = data.choices
    ui.defaultModel = data.defaultModel
  } catch {
    ui.models = []
  }
  renderModelSelect()
  // Whether 联网 is there depends on the model's provider: a chat opened before the list came reads it now.
  renderSearchButton()
}

function renderModelSelect() {
  const select = $('chat-model')
  const chat = ui.chat
  select.hidden = !chat
  if (select.hidden) return
  const known = ui.models.some(m => m.id === ui.defaultModel)
  select.replaceChildren(...[
    el('option', { value: '', selected: !chat.model, text: known ? t`默认（${labelOf(ui.defaultModel)}）` : t`默认（未选，去设置里选一个）` }),
    ...modelOptions(chat.model),
    // A chat model that is gone (provider deleted, subscription off) still shows as selected.
    chat.model && !ui.models.some(m => m.id === chat.model) ? el('option', { value: chat.model, selected: true, text: t`${chat.model}（不可用）` }) : null,
    el('option', { value: MANAGE_PROVIDERS, text: t`管理模型供应商…` }),
  ].filter(Boolean))
  select.disabled = ui.generating
}

const changeChatModel = guard(async () => {
  const model = $('chat-model').value
  if (model === MANAGE_PROVIDERS) {
    renderModelSelect()
    providersUi.open()
    return
  }
  const chosen = ui.models.find(m => m.id === model)
  if (subscriptionPage && !subscriptionPage.confirmModel(chosen)) {
    renderModelSelect()
    return
  }
  // The chat it was picked in: another may be open by the time compacting is done.
  const chat = ui.chat
  if (chat.compactable >= SUGGEST_COMPACT && model !== (chat.model ?? '')) {
    const choice = await askSwitch(chat.compactable)
    const go = choice === 'switch' || (choice === 'compact' && (await runCompaction()))
    if (!go) {
      renderModelSelect()
      return
    }
  }
  const view = await api(`/api/chats/${chat.id}`, { method: 'PUT', body: { model } })
  if (ui.chat?.id !== chat.id) return toast(t`「${chat.title}」改用 ${labelOf(view.model || ui.defaultModel)}。`)
  ui.chat = { ...ui.chat, model: view.model }
  renderModelSelect()
  renderSearchButton()
  toast(t`这个对话改用 ${labelOf(view.model || ui.defaultModel)}。缓存按模型区分，下一轮会重新写入一次缓存。`)
})

// ─── Usage dashboard ────────────────────────────────────────────────────
const loadUsage = guard(async () => {
  const [data, status] = await Promise.all([api(`/api/usage?days=${ui.usageDays}`), api('/api/status').catch(() => null)])
  if (status?.rateLimit) ui.rateLimit = status.rateLimit
  renderUsage($('usage-body'), data, ui.rateLimit, labelOf, { subscription: ui.features?.subscription !== false })
})

function openUsage() {
  for (const b of $('usage-range').querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === ui.usageDays))
  $('usage-dialog').showModal()
  loadUsage()
}

// ─── API ────────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-agent-tavern': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || t`请求失败（${res.status}）`), { status: res.status, contextFull: data.contextFull === true })
  return data
}

/** POST that answers with server-sent events; calls onEvent per event. */
async function stream(path, body, onEvent) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw Object.assign(new Error(data.error || t`请求失败（${res.status}）`), { status: res.status })
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let cut
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      const line = frame.split('\n').find(l => l.startsWith('data: '))
      if (line) onEvent(JSON.parse(line.slice(6)))
    }
  }
}

// The toast is a popover: shown again each time, it goes on top of whatever window is open
// (a modal dialog would otherwise cover it until it closes). `log`: an error, with a way to its log.
// A toast is in the top layer, but a dialog opened after it goes above it: shown again on top of that dialog.
// Held here, not looked up: it may sit in a dialog that is then taken out of the page.
const toastBox = $('toast')
// With a modal dialog open, all outside it is inert, the top layer too: the toast showed there but
// its 错误日志 could not be clicked. Inside the dialog it can (and back in the page once none is open).
const toastHost = () => document.querySelector('dialog:modal') ?? document.body
new MutationObserver(records => {
  const box = toastBox
  if (!box?.showPopover || box.hidden) return
  // Its dialog closed or went away while it showed: on to the page (or the dialog under it), still showing.
  const moved = box.parentElement !== toastHost()
  if (!moved && !records.some(record => record.type === 'attributes' && record.target !== box && record.target.open)) return
  if (moved) toastHost().append(box)
  if (box.matches(':popover-open')) box.hidePopover()
  box.showPopover()
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] })

function hideToast() {
  const box = toastBox
  clearTimeout(toast.timer)
  if (box.matches?.(':popover-open')) box.hidePopover()
  box.hidden = true
}

/** @param options.action - { text, run }: a button after the message that runs `run` and closes it. */
function toast(message, ms = 4000, { log = false, action = null } = {}) {
  const box = toastBox
  const hide = hideToast
  box.textContent = message
  if (action) {
    box.append(' ', el('button', {
      type: 'button', class: 'toast-link', text: action.text,
      onclick: event => { event.stopPropagation(); hide(); action.run() },
    }))
  }
  if (log) {
    box.append(' ', el('button', {
      type: 'button', class: 'toast-link', text: t`错误日志`,
      // Only the log opens: a click on the toast itself has its own meaning.
      onclick: event => { event.stopPropagation(); hide(); openErrorLog() },
    }))
  }
  box.hidden = false
  const host = toastHost()
  if (box.parentElement !== host) host.append(box)
  if (box.showPopover) {
    if (box.matches(':popover-open')) box.hidePopover()
    box.showPopover()
  }
  clearTimeout(toast.timer)
  toast.timer = setTimeout(hide, ms)
}

function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args)
    } catch (error) {
      // An answer from the server is in its log already; anything else went wrong in this page.
      if (!error?.status) reportError('action', error)
      toast(error.message, 6000, { log: true })
    }
  }
}

// ─── 错误日志 (server/diagnostics.mjs) ──────────────────────────────────
// The server logs the errors it answers with; mistakes in this page's own code are sent to it here.
let reports = 0
function reportError(kind, error) {
  // The same mistake over and over: the first ones say enough.
  if (reports >= 20) return
  reports++
  setTimeout(() => reports--, 60_000)
  fetch('/api/diagnostics/page', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' },
    body: JSON.stringify({ kind, message: String(error?.message ?? error ?? '').slice(0, 2000), stack: String(error?.stack ?? '').slice(0, 4000) }),
  }).catch(() => {})
}
addEventListener('error', event => {
  // This page's own scripts: a card's frame is a window of its own, a browser extension's script is not ours,
  // and a ResizeObserver running late is the browser's notice, not a mistake.
  if ((event.filename && !event.filename.startsWith(location.origin)) || (!event.error && /^Script error\.?$|ResizeObserver loop/.test(event.message ?? ''))) return
  reportError('error', event.error ?? { message: event.message, stack: `${event.filename}:${event.lineno}:${event.colno}` })
})
addEventListener('unhandledrejection', event => {
  if (event.reason?.status) return
  reportError('promise', event.reason)
})

/** 设置 → 更多 → 错误日志 (web/diagnostics.js, loaded when first opened). */
const openErrorLog = guard(async () => {
  const { openDiagnostics } = await import('/diagnostics.js').catch(() => {
    throw Object.assign(new Error(t`错误日志要重启后台服务后才能用：关掉所有窗口等一分钟，再从桌面图标打开。`), { status: 404 })
  })
  openDiagnostics({ api, el, toast, saveFile, getChat: () => ui.chat })
})

/** 屏蔽词 for what the page shows (render.js), with their matcher once there are any. */
async function showBlockWords(words) {
  ui.blockWords = words
  const matcher = words.length ? await import('/shared/blockwords.js').catch(() => null) : null
  useBlockWords(words, matcher?.blockText ?? null)
}

/** 设置 → 屏蔽词 (web/blockwords.js, loaded when first opened). */
const openBlockWords = guard(async () => {
  const { openBlockWords: open } = await import('/blockwords.js').catch(() => {
    throw Object.assign(new Error(t`屏蔽词要重启后台服务后才能用：关掉所有窗口等一分钟，再从桌面图标打开。`), { status: 404 })
  })
  await open({
    api, el, toast, guard,
    getChat: () => ui.chat,
    subscription: Boolean(ui.features.subscription),
    onChanged: async words => {
      await showBlockWords(words)
      settingsMenu?.refresh()
      if (ui.chat) renderChat()
      renderChats()
    },
  })
})

// ─── Rendering helpers ──────────────────────────────────────────────────
const escapeHtml = text => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

/** Minimal story markdown: paragraphs, **bold**, *italic*, highlighted dialogue. */
// 小白X conventions presets write for: [voice:情绪:台词] after a quoted line (its TTS reads it;
// here the quote is read, so the tag is noise), and a <small> block of numbered options.
const VOICE_TAG = /\[voice:[^\]:\n]*:[^\]\n]*\]/gi
const QUOTE_VOICE = /(“[^”\n]*”|「[^」\n]*」|"[^"\n]*")\s*\[voice:([^\]:\n]*):[^\]\n]*\]/gi
const CHOICE_LINE = /^(\s*)([1-9])\uFE0F?\u20E3\s*(\S.*)$/gm

// Tags left in story text after the regex scripts. SillyTavern renders inline formatting
// (<font color>, <b>, <br>…) and drops tags it does not know while keeping their text
// (<content>, <ai_last_output>…); so does this. Only a color survives as an attribute.
const INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'sub', 'sup', 'mark', 'big', 'center', 'q', 'code', 'ruby', 'rt', 'rp', 'br', 'hr', 'font', 'span'])
const STORY_TAG = /<(\/?)([A-Za-z][\w~:.-]*)([^<>]*)>/g
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d\s.,%]+\))$/i
// Reasoning a model writes in its own tag, with no regex to hide it: folded, not spread over the page.
const FOLD_TAG = '[\\w~-]*(?:think|draft|reasoning)[\\w~-]*'
const FOLD_BLOCK = new RegExp(`<(${FOLD_TAG})>([\\s\\S]*?)</\\1>`, 'gi')
const FOLD_OPEN = new RegExp(`<(${FOLD_TAG})>(?![\\s\\S]*</\\1>)([\\s\\S]*)$`, 'i')

function inlineTag(closing, name, attrs) {
  const tag = name.toLowerCase()
  if (!INLINE_TAGS.has(tag)) return ''
  if (tag === 'br' || tag === 'hr') return closing ? '' : `<${tag}>`
  if (closing) return tag === 'font' ? '</span>' : `</${tag}>`
  const color = tag === 'font' ? /\bcolor\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] : tag === 'span' ? /color\s*:\s*([^;"']+)/i.exec(attrs)?.[1]?.trim() : ''
  const style = color && SAFE_COLOR.test(color) ? ` style="color:${color}"` : ''
  return `<${tag === 'font' ? 'span' : tag}${style}>`
}

/** @param options.partial - the reply is still being written: a mark at its end may be half-typed. */
function renderStory(text, { partial = false } = {}) {
  const folds = []
  // A fold's place is held by a private-use character the text cannot bring in (it is taken out first).
  const fold = (label, body) => (body.trim() ? `\n\n\uE020${folds.push({ label, body: body.trim() }) - 1}\uE020\n\n` : '')
  // 视觉小说格式: 【名字|表情】 before a line shows as the name (drawn by CSS, so reading aloud skips it); 【效果|…】 goes.
  const source = markSpeakers(String(text ?? '').replace(/\uE020/g, ''), name => `${name}`, { partial })
    // A voice tag right after a line keeps its emotion for reading aloud (marked, then put on the line's span).
    .replace(QUOTE_VOICE, (_, quote, emotion) => (emotion.trim() ? `${quote}${emotion.trim()}` : quote))
    .replace(VOICE_TAG, '')
    .replace(/<\/?small>/gi, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(FOLD_BLOCK, (_, tag, body) => fold(t`思考过程`, body))
    .replace(FOLD_OPEN, (_, tag, body) => fold(t`思考中…`, body))
  let html = ''
  let last = 0
  for (const match of source.matchAll(STORY_TAG)) {
    html += escapeHtml(source.slice(last, match.index)) + inlineTag(match[1], match[2], match[3])
    last = match.index + match[0].length
  }
  html = (html + escapeHtml(source.slice(last)))
    .replace(/([^\n]*)/g, '<span class="speaker" data-name="$1"></span>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<em>$2</em>')
    .replace(/(“[^”\n]*”|「[^」\n]*」|&quot;[^&\n]*?&quot;)/g, '<span class="q">$1</span>')
    .replace(/<span class="q">([^<]*)<\/span>([^<]*)/g, '<span class="q" data-emotion="$2">$1</span>')
    .replace(/[^]*/g, '')
    .replace(CHOICE_LINE, (_, indent, n, body) => `${indent}<button type="button" class="choice" data-choice="${body.replace(/<[^>]+>/g, '').replace(/"/g, '&quot;')}"><b>${n}</b><span class="choice-text">${body}</span></button>`)
  return html
    .split(/\n{2,}/)
    .map(p => {
      const folded = folds[/^\uE020(\d+)\uE020$/.exec(p.trim())?.[1]]
      if (folded) {
        const { label, body } = folded
        return `<details class="fold"><summary>${label}</summary><div>${escapeHtml(body).replace(/\n+/g, '<br>')}</div></details>`
      }
      // A line that held only a dropped tag leaves nothing behind; one holding only
      // formatting tags (<font> on its own line) joins the text next to it.
      const lines = []
      let carry = ''
      for (const line of p.split('\n')) {
        if (line.replace(/<[^>]*>/g, '').trim() || /<(br|hr)>/.test(line)) {
          lines.push(carry + line)
          carry = ''
        } else {
          carry += line.trim()
        }
      }
      if (carry && lines.length) lines[lines.length - 1] += carry
      // Option buttons are blocks already: a line break next to one only adds an empty line.
      const isChoice = line => line.trimStart().startsWith('<button type="button" class="choice"')
      const body = lines.reduce((out, line, i) => (i === 0 ? line : out + (isChoice(lines[i - 1]) || isChoice(line) ? '' : '<br>') + line), '')
      return lines.length ? `<p>${body}</p>` : ''
    })
    .join('')
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'html') node.innerHTML = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of [].concat(children)) if (child) node.append(child)
  return node
}

// Cards whose picture changed in this page (创作角色卡 saving again): their URL skips the cached one.
const avatarVersions = new Map()

function avatarFor(card) {
  const version = avatarVersions.get(card?.id)
  if (card?.hasAvatar) return el('img', { class: 'avatar', src: `/api/cards/${card.id}/avatar${version ? `?v=${version}` : ''}`, alt: '' })
  return el('span', { class: 'avatar', text: (card?.name ?? '?').slice(0, 1) })
}

const fmt = n => (n ?? 0).toLocaleString(locale)

/** "刚刚", "12 分钟前", "昨天", "3 天前", then the date. */
function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return t`刚刚`
  if (min < 60) return t`${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return t`${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return t`昨天`
  if (days < 7) return t`${days} 天前`
  return new Date(iso).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
}

// ─── Left pane ──────────────────────────────────────────────────────────
// ─── Card list: groups and the archive ─────────────────────────────────
// Cards without a group come first, then each group (folded or open, remembered
// on this device), then the archive, folded unless asked for.
const FOLDED_KEY = 'cicatavern.foldedCardGroups'
const foldedGroups = new Set(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(FOLDED_KEY) || '[]')
    } catch {
      return []
    }
  })(),
)
function saveFolded() {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...foldedGroups]))
  } catch {
    // Private windows: folding lasts for this page only.
  }
}

function cardItem(card, nested = false) {
  return el('li', { class: [card.id === ui.cardId ? 'active' : '', nested ? 'nested' : '', card.archived ? 'archived' : ''].filter(Boolean).join(' '), onclick: () => selectCard(card.id) }, [
    avatarFor(card),
    el('div', { class: 'item-main' }, [
      el('div', { class: 'item-title', text: card.name }),
      el('div', { class: 'item-sub', text: t`${card.greetings} 个开场 · ${card.bookEntries} 条内嵌世界书${card.worldbookIds.length ? t` · 挂载 ${card.worldbookIds.length} 本` : ''}` }),
    ]),
    el('button', { type: 'button', class: 'item-del item-edit item-more', title: t`修改、分组、归档、删除`, 'aria-label': t`「${card.name}」：修改、分组、归档、删除`, text: '⋯', onclick: event => { event.stopPropagation(); openCardMenu(card, event.currentTarget) } }),
  ])
}

function groupHead(name, cards, folded, { archive = false } = {}) {
  const holdsCurrent = folded && cards.some(card => card.id === ui.cardId)
  return el('li', { class: `group-head${archive ? ' archive' : ''}`, role: 'button', tabindex: '0', 'aria-expanded': String(!folded), title: folded ? t`展开` : t`收起`, onclick: () => toggleGroup(name, archive), onkeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleGroup(name, archive) } } }, [
    el('span', { class: 'group-chevron', 'aria-hidden': 'true', text: '▸' }),
    el('span', { class: 'group-name', text: name }),
    holdsCurrent ? el('span', { class: 'group-current', title: t`正在用的角色卡在这一组里` }) : null,
    el('span', { class: 'group-count', text: String(cards.length) }),
    archive ? null : el('button', { type: 'button', class: 'item-del item-edit item-more', title: t`重命名、解散或整组归档`, 'aria-label': t`分组「${name}」：重命名、解散或整组归档`, text: '⋯', onclick: event => { event.stopPropagation(); openGroupMenu(name, cards, event.currentTarget) } }),
  ])
}

function toggleGroup(name, archive) {
  // While searching every group is open; folding waits until the box is cleared.
  if (searchTerms(cardQuery).length) return
  if (archive) ui.archiveOpen = !ui.archiveOpen
  else {
    foldedGroups.has(name) ? foldedGroups.delete(name) : foldedGroups.add(name)
    saveFolded()
  }
  renderCards()
}

/** Names of the groups in use, in a stable order. */
const cardGroups = () => [...new Set(ui.cards.filter(card => card.group).map(card => card.group))].sort((a, b) => a.localeCompare(b, 'zh-CN'))

// 搜索角色卡 (the box above the list): only the cards whose name, tags, group or
// author have every word show, in every group and the archive opened for it;
// emptied, the list folds as it was.
let cardQuery = ''
const cardText = card => [card.name, card.group, card.creator, ...(card.tags ?? [])].filter(Boolean).join('\n')

function renderCards() {
  const list = $('card-list')
  const terms = searchTerms(cardQuery)
  const found = terms.length ? ui.cards.filter(card => matchesTerms(cardText(card), terms)) : ui.cards
  const live = found.filter(card => !card.archived)
  const archived = found.filter(card => card.archived)
  const items = live.filter(card => !card.group).map(card => cardItem(card))
  for (const name of cardGroups()) {
    const cards = live.filter(card => card.group === name)
    if (!cards.length) continue
    const folded = !terms.length && foldedGroups.has(name)
    items.push(groupHead(name, cards, folded))
    if (!folded) items.push(...cards.map(card => cardItem(card, true)))
  }
  if (archived.length) {
    const open = terms.length > 0 || ui.archiveOpen
    items.push(groupHead(t`已归档`, archived, !open, { archive: true }))
    if (open) items.push(...archived.map(card => cardItem(card, true)))
  }
  list.replaceChildren(...items)
  if (ui.cards.length === 0) list.append(el('li', { class: 'muted small', text: t`还没有角色卡` }))
  else if (!found.length) list.append(el('li', { class: 'muted small', text: t`没有找到「${cardQuery.trim()}」` }))
  $('new-chat').disabled = !ui.cardId
  $('import-story').disabled = !ui.cardId
  $('import-story-label').setAttribute('aria-disabled', String(!ui.cardId))
}

function renderChats() {
  const list = $('chat-list')
  list.replaceChildren(
    ...ui.chats.map(chat =>
      el('li', { class: chat.id === ui.chat?.id ? 'active' : '', onclick: () => openChat(chat.id) }, [
        el('div', { class: 'item-main' }, [
          el('div', { class: 'item-title' }, [chat.title, ui.busy.has(chat.id) ? el('span', { class: 'busy-dot', title: t`正在生成` }) : null]),
          el('div', { class: 'item-sub', text: t`${ago(chat.updatedAt)}　${chat.turns} 轮　${blockShown(chat.preview)}` }),
        ]),
        document.documentElement.dataset.edition === 'android'
          ? null
          : el('a', { class: 'item-del item-edit', title: t`打包整段对话（每一轮、每个分支和配图），在另一台设备上用「导入存档」导入`, text: '⇩', href: `/api/chats/${chat.id}/package`, download: '', onclick: event => event.stopPropagation() }),
        el('button', { class: 'item-del item-edit', title: t`重命名`, text: '✎', onclick: event => { event.stopPropagation(); renameChat(chat) } }),
        el('button', { class: 'item-del', title: t`删除对话`, text: '✕', onclick: event => { event.stopPropagation(); deleteChat(chat) } }),
      ]),
    ),
  )
  if (ui.cardId && ui.chats.length === 0) list.append(el('li', { class: 'muted small', text: t`还没有对话，点「新对话」` }))
}

async function refreshCards() {
  ui.cards = await api('/api/cards')
  if (ui.cardId && !ui.cards.some(c => c.id === ui.cardId)) ui.cardId = null
  renderCards()
}

async function refreshChats() {
  ui.chats = ui.cardId ? await api(`/api/chats?cardId=${ui.cardId}`) : []
  renderChats()
}

const selectCard = guard(async id => {
  ui.cardId = id
  mediaUi.setCard(id)
  // The chosen card shows in the list, even when it sits in a folded group or the archive.
  const chosen = ui.cards.find(card => card.id === id)
  if (chosen?.archived) ui.archiveOpen = true
  else if (chosen?.group && foldedGroups.delete(chosen.group)) saveFolded()
  renderCards()
  await refreshChats()
  const card = await api(`/api/cards/${id}`)
  ui.cardDetails.set(id, card)
  showCardInfo(card)
  if (ui.chats[0]) await openChat(ui.chats[0].id)
  else setChat(null)
  document.body.querySelector('.app').classList.remove('show-left')
})

/** The chosen card's author, tags, notes and scripts, under the card list. */
function showCardInfo(card) {
  $('card-info').textContent = [
    card.creator && t`作者：${card.creator}`,
    card.tags?.length && t`标签：${card.tags.join(t`、`)}`,
    card.creatorNotes,
    card.regexScripts ? t`正则脚本 ${card.regexScripts} 条（已生效；设置 → 正则 里可以开关和修改）` : '',
    card.helperScripts ? t`酒馆助手脚本 ${card.helperScripts} 个（不执行；MVU 变量更新已内置）` : '',
  ].filter(Boolean).join('\n\n') || '—'
}

// ─── A small menu next to a button ─────────────────────────────────────
// entries: { label, onClick, danger, current, hint } | { header } | '-'
let openMenu = null
function closeMenu() {
  openMenu?.remove()
  openMenu = null
}
function popMenu(anchor, entries) {
  closeMenu()
  const menu = el(
    'div',
    { class: 'pop-menu', role: 'menu' },
    entries.map(entry => {
      if (entry === '-') return el('hr')
      if (entry.header) return el('div', { class: 'pop-head', text: entry.header })
      return el('button', { type: 'button', role: 'menuitem', class: [entry.danger ? 'danger' : '', entry.current ? 'current' : ''].filter(Boolean).join(' '), disabled: entry.current, title: entry.hint, onclick: () => { closeMenu(); entry.onClick() } }, [entry.current ? '✓ ' : '', entry.label])
    }),
  )
  document.body.append(menu)
  const at = anchor.getBoundingClientRect()
  const left = Math.max(8, Math.min(at.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))
  const below = at.bottom + 4 + menu.offsetHeight <= innerHeight - 8
  menu.style.left = `${left}px`
  menu.style.top = `${below ? at.bottom + 4 : Math.max(8, at.top - menu.offsetHeight - 4)}px`
  openMenu = menu
  menu.querySelector('button:not(:disabled)')?.focus()
  menu.addEventListener('keydown', event => {
    const items = [...menu.querySelectorAll('button:not(:disabled)')]
    const index = items.indexOf(document.activeElement)
    if (event.key === 'Escape') {
      closeMenu()
      anchor.focus()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    }
  })
}
document.addEventListener('pointerdown', event => {
  if (openMenu && !openMenu.contains(event.target)) closeMenu()
}, true)
addEventListener('resize', closeMenu)

const organizeCard = guard(async (card, change, done) => {
  await api(`/api/cards/${card.id}/organize`, { method: 'PUT', body: change })
  await refreshCards()
  if (done) toast(done)
})

function askGroupName(title, initial = '') {
  const name = prompt(title, initial)?.replace(/\s+/g, ' ').trim()
  return name ? name.slice(0, 30) : ''
}

/**
 * 做成视觉小说 (创作角色卡 after saving, or a card's ⋯ menu): a new chat with the card, then the mode,
 * the preset offer, how to draw, the 角色名册, 立绘 and 表情 (web/vn.js makeReady), and `places` backgrounds.
 */
async function makeVisualNovel(id, places = []) {
  await refreshCards()
  await selectCard(id)
  // Done once the chat starts (after the opening is picked, when there are several).
  ui.vnPending = { cardId: id, places }
  await newChat()
}

function openCardMenu(card, anchor) {
  const groups = cardGroups()
  popMenu(anchor, [
    { label: t`修改角色卡`, hint: t`改名字、描述、开场白和世界书，也可以说说想怎么改，让向导来改`, onClick: () => cardEditUi.open(card.id) },
    { label: t`做成视觉小说`, hint: t`开一个新对话进入视觉小说模式：选画图方式，再备齐角色名册、立绘和表情`, onClick: guard(() => makeVisualNovel(card.id)) },
    { label: t`卡片界面权限…`, hint: t`卡片界面自己发送、调用模型、经 CicaTavern 联网：问过一次之后照你的选择来，在这里改`, onClick: () => cardPermissions.open(card) },
    '-',
    { header: t`移到分组` },
    ...groups.map(name => ({ label: name, current: card.group === name, onClick: () => organizeCard(card, { group: name }) })),
    { label: t`新分组…`, onClick: () => { const name = askGroupName(t`把「${card.name}」放进哪个新分组？`); if (name) organizeCard(card, { group: name }) } },
    card.group ? { label: t`移出分组`, onClick: () => organizeCard(card, { group: '' }) } : null,
    '-',
    card.archived
      ? { label: t`恢复到列表`, onClick: () => organizeCard(card, { archived: false }, t`「${card.name}」回到列表里了${card.group ? t`，在「${card.group}」组` : ''}。`) }
      : { label: t`归档`, hint: t`从列表里收起来，对话和设置都保留，随时可以恢复`, onClick: () => organizeCard(card, { archived: true }, t`已归档「${card.name}」：在列表最下面的「已归档」里，随时可以恢复。`) },
    '-',
    { label: t`删除角色卡…`, danger: true, onClick: () => deleteCard(card) },
  ].filter(Boolean))
}

const renameGroup = guard(async (from, to, done) => {
  await api('/api/cards/groups', { method: 'POST', body: { from, to } })
  if (foldedGroups.delete(from) && to) foldedGroups.add(to)
  saveFolded()
  await refreshCards()
  if (done) toast(done)
})

const archiveGroup = guard(async (name, cards) => {
  if (!confirm(t`把「${name}」组的 ${cards.length} 张卡全部归档？对话和设置都保留，随时可以恢复。`)) return
  for (const card of cards) await api(`/api/cards/${card.id}/organize`, { method: 'PUT', body: { archived: true } })
  await refreshCards()
  toast(t`「${name}」组已归档，在列表最下面的「已归档」里。`)
})

function openGroupMenu(name, cards, anchor) {
  popMenu(anchor, [
    { label: t`重命名…`, onClick: () => { const to = askGroupName(t`分组的新名字`, name); if (to && to !== name) renameGroup(name, to) } },
    { label: t`解散分组`, hint: t`分组去掉，卡片回到未分组`, onClick: () => { if (confirm(t`解散「${name}」？里面的 ${cards.length} 张卡会回到未分组，卡片本身不受影响。`)) renameGroup(name, '', t`「${name}」已解散。`) } },
    '-',
    { label: t`整组归档…`, onClick: () => archiveGroup(name, cards) },
  ])
}

const deleteCard = guard(async card => {
  if (!confirm(t`删除角色卡「${card.name}」？（它的对话记录会保留）`)) return
  await api(`/api/cards/${card.id}`, { method: 'DELETE' })
  if (ui.cardId === card.id) { ui.cardId = null; setChat(null) }
  await refreshCards()
  await refreshChats()
})

const renameChat = guard(async chat => {
  const title = prompt(t`对话的新名字`, chat.title)?.trim()
  if (!title || title === chat.title) return
  const saved = await api(`/api/chats/${chat.id}`, { method: 'PUT', body: { title } })
  if (ui.chat?.id === chat.id) ui.chat = { ...ui.chat, title: saved.title }
  renderChat()
  await refreshChats()
})

const deleteChat = guard(async chat => {
  if (!confirm(t`删除对话「${chat.title}」？`)) return
  await api(`/api/chats/${chat.id}`, { method: 'DELETE' })
  if (ui.chat?.id === chat.id) setChat(null)
  await refreshChats()
})

// ─── Import ─────────────────────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** A JSON file's content; an editor workspace ({ kind, raw }, e.g. DSH Tavern) yields its `raw`. */
async function jsonOf(file) {
  if (!/\.json$/i.test(file.name)) return null
  try {
    const json = JSON.parse(await file.text())
    return json && typeof json.kind === 'string' && json.raw && typeof json.raw === 'object' ? json.raw : json
  } catch {
    return null
  }
}

/** Worldbooks have `entries`; a card may embed one but has card fields around it. A worldbook may have a name. */
function looksLikeWorldbook(json) {
  if (!json || typeof json !== 'object' || json.entries === undefined) return false
  return !(json.spec || json.data || json.first_mes !== undefined || json.char_name !== undefined)
}

const importFiles = guard(async files => {
  const done = []
  let presets = 0
  let reselect = false
  // Chat packages go as they do from 导入存档 (read in parts, never sent whole as a card).
  const packages = files.filter(file => /\.tavernchat$/i.test(file.name))
  for (const file of files) {
    if (packages.includes(file)) continue
    // A SillyTavern chat: under the selected card (opens it and says so itself).
    if (/\.jsonl$/i.test(file.name)) {
      await importSillyTavernFile(file)
      continue
    }
    const json = await jsonOf(file)
    if (json?.format === STORY_FORMAT) {
      // Opens the new chat itself.
      const line = await importStory(json)
      if (line) done.push(line)
      continue
    }
    const data = await fileToBase64(file)
    // A SillyTavern preset, or one exported from this app (agent-tavern-preset).
    if (Array.isArray(json?.prompts) || Array.isArray(json?.preset?.prompts)) {
      const preset = await api('/api/presets/import', { method: 'POST', body: { filename: file.name, data } })
      done.push(t`预设「${preset.name}」${preset.prompts} 条`)
      presets++
      continue
    }
    // A SillyTavern regex export (one script or a list): into the global ones (正则).
    if (isRegexFile(json)) {
      const added = await regexUi.importScripts(scriptsInFile(json))
      done.push(t`正则 ${added} 条（放在全局）`)
      continue
    }
    if (looksLikeWorldbook(json)) {
      const book = await api('/api/worldbooks/import', { method: 'POST', body: { filename: file.name, data } })
      done.push(t`世界书「${book.name}」${book.entries} 条`)
      reselect = true
    } else {
      // A newer version of a card already here: update that one in place, or keep both.
      const { previous } = await api('/api/cards/inspect', { method: 'POST', body: { filename: file.name, data } })
      const replace = previous && confirm(t`已经有「${previous.name}」。\n\n确定：更新这张卡（对话、配图与朗读设置、角色名册和人设图都保留）\n取消：另存为一张新卡（也会带上它的配图设置和人设图）`) ? previous.id : ''
      const card = await api('/api/cards/import', { method: 'POST', body: { filename: file.name, data, ...(replace ? { replace } : {}) } })
      done.push(card.updated ? t`角色卡「${card.updated}」更新为「${card.name}」` : t`角色卡「${card.name}」${card.inherited ? t`（沿用了「${card.inherited}」的配图设置和人设图）` : ''}`)
      ui.cardId = card.id
      reselect = true
    }
  }
  ui.books = await api('/api/worldbooks')
  await refreshCards()
  if (ui.cardId && reselect) await selectCard(ui.cardId)
  // A SillyTavern chat says so itself, and a refused one adds nothing: no empty 已导入.
  if (done.length) toast(t`已导入：${done.join(t`，`)}`, 6000)
  if (presets) presetsUi.open()
  if (packages.length) await importPackages(packages)
})

// ─── Chat ───────────────────────────────────────────────────────────────
function setChat(chat) {
  ui.chat = chat
  // A chat opened some other way (a new one, an import): its frames' book names and global variables follow.
  if (chat && ui.frameInfo?.chatId !== chat.id) {
    loadFrameInfo(chat.id).then(() => {
      if (ui.chat?.id === chat.id && document.querySelector('#transcript iframe.card-frame')) renderChat()
    })
  }
  if (chat && (!ui.cardDetails.has(chat.cardId) || (chat.presetId && !ui.presetDetails.has(chat.presetId)))) {
    // Render once the card's and preset's regex scripts are known.
    Promise.all([loadCardDetail(chat.cardId), loadPresetDetail(chat.presetId)]).then(() => { if (ui.chat === chat) renderChat() })
  }
  ui.branchFrom = null
  renderChat()
  renderChats()
  renderSide()
}

const openChat = guard(async id => {
  const [view] = await Promise.all([api(`/api/chats/${id}`), loadFrameInfo(id)])
  followServerTurn(view)
  setChat(view)
  document.body.querySelector('.app').classList.remove('show-left')
})

const newChat = guard(async () => {
  const card = await api(`/api/cards/${ui.cardId}`)
  const texts = card.greetingTexts.length ? card.greetingTexts : ['']
  if (texts.length === 1) return startChat(0)
  const pick = index => {
    $('greeting-dialog').close()
    startChat(index)
  }
  $('greeting-count').textContent = t`${texts.length} 个开场。点一下文字读完整的，再选一个开始。`
  $('greetings').replaceChildren(...texts.map((text, index) => greetingItem(text, index, pick)))
  $('greeting-dialog').showModal()
  $('greetings').scrollTop = 0
  // Only the ones cut short open.
  for (const item of $('greetings').children) {
    const body = item.querySelector('.greeting-text')
    item.querySelector('.greeting-more').hidden = body.scrollHeight <= body.clientHeight + 1
  }
})

/** One opening in 选择开场白: its first lines (blank lines left out), the whole of it on a tap, and a button to start with it. */
function greetingItem(text, index, pick) {
  const whole = text.trim() || t`（空开场）`
  const brief = whole.replace(/\n\s*\n+/g, '\n')
  const item = el('li', { class: 'greeting' })
  const body = el('div', { class: 'greeting-text', text: brief })
  const more = el('button', { type: 'button', class: 'btn small ghost greeting-more', text: t`展开全文`, 'aria-expanded': 'false' })
  const toggle = () => {
    if (more.hidden) return
    const open = item.classList.toggle('open')
    body.textContent = open ? whole : brief
    more.textContent = open ? t`收起` : t`展开全文`
    more.setAttribute('aria-expanded', String(open))
    if (!open) item.scrollIntoView({ block: 'nearest' })
  }
  body.addEventListener('click', toggle)
  more.addEventListener('click', toggle)
  item.append(
    el('div', { class: 'greeting-head' }, [el('b', { text: t`开场 ${index + 1}` }), el('span', { text: t`${[...whole].length} 字` })]),
    body,
    el('div', { class: 'greeting-foot' }, [more, el('button', { type: 'button', class: 'btn small greeting-use', text: t`用这个开场`, onclick: () => pick(index) })]),
  )
  return item
}

const startChat = guard(async greetingIndex => {
  const chat = await api('/api/chats', { method: 'POST', body: { cardId: ui.cardId, greetingIndex } })
  await refreshChats()
  setChat(chat)
  $('input').focus()
  // 做成视觉小说 waited for the opening to be picked.
  const ready = ui.vnPending
  ui.vnPending = null
  if (ready?.cardId === chat.cardId) await vnUi.makeReady(ready.cardId, ready.places)
})

/** Regex scripts: the global ones, the chat's preset's, its card's, then the 正则集 on its card (all cached), as the server applies them. */
function scriptsFor(chat) {
  const card = ui.cardDetails.get(chat?.cardId)
  const scripts = chatScriptList({ global: ui.globalRegex, preset: ui.presetDetails.get(chat?.presetId)?.regexScriptList ?? [], card: card?.regexScriptList ?? [], cardId: chat?.cardId, sets: ui.regexSets })
  // A card creator card's bar is drawn here from its layout; its SillyTavern copy stays out.
  return card?.statusBar ? withoutOwnStatus(scripts) : scripts
}

/**
 * The status bar layout for a reply: the card's own (card creator cards), else,
 * with the built-in preset's 状态栏 on, one laid out from the variables.
 */
function statusSpecFor(chat, node) {
  const own = ui.cardDetails.get(chat.cardId)?.statusBar
  if (own) return own
  const builtin = !chat.presetId || isBuiltinPreset(chat.presetId)
  if (!builtin || builtinOptions(ui.settings, chat.presetId).statusBar === 'off') return null
  return autoStatusSpec(node.state ?? {})
}

/** The state before a reply: the assistant message before it on the path. */
function previousState(chat, node) {
  const index = chat.path.findIndex(n => n.id === node.id)
  return chat.path.slice(0, Math.max(0, index)).reverse().find(n => n.role === 'assistant')?.state ?? null
}

function fillInput(text) {
  const input = $('input')
  input.value = text
  fitInput()
  input.focus()
  input.setSelectionRange(text.length, text.length)
}

function sendChoice(text) {
  $('input').value = text
  fitInput()
  send()
}

async function loadPresetDetail(presetId) {
  if (!presetId || ui.presetDetails.has(presetId)) return
  try {
    ui.presetDetails.set(presetId, await api(`/api/presets/${presetId}`))
  } catch {
    ui.presetDetails.set(presetId, { regexScriptList: [] })
  }
}

async function loadCardDetail(cardId) {
  if (!cardId || ui.cardDetails.has(cardId)) return
  try {
    ui.cardDetails.set(cardId, await api(`/api/cards/${cardId}`))
  } catch {
    ui.cardDetails.set(cardId, { regexScriptList: [] }) // card deleted: show plain text
  }
}

/** Message body: story text as markdown-lite, HTML in sandboxed frames, code as <pre>. */
function messageBody(text, frameContext = null) {
  const body = el('div', { class: 'msg-body' })
  for (const part of segments(text)) {
    if (part.kind === 'html') body.append(htmlFrame(part.body, frameContext))
    else if (part.kind === 'code') body.append(el('pre', { class: 'code' }, el('code', { text: part.body })))
    else body.append(el('div', { class: 'story', html: renderStory(part.body.trim()) }))
  }
  if (!body.childNodes.length) body.append(el('div', { class: 'story muted', text: t`（空）` }))
  return body
}

function renderChat() {
  const box = $('transcript')
  const chat = ui.chat
  $('input').disabled = !chat || ui.generating
  $('send').disabled = !chat || ui.generating
  $('stop').hidden = !ui.generating
  $('send').hidden = ui.generating
  $('edit-state').disabled = !chat || ui.generating
  const heading = $('chat-title')
  heading.textContent = chat ? chat.title : ui.cardId ? t`点「新对话」开始` : t`选择一张角色卡开始`
  heading.classList.toggle('renamable', Boolean(chat))
  heading.title = chat ? t`点击重命名` : ''
  renderModelSelect()
  renderQuickButton()
  renderSearchButton()
  renderDictateButton()
  const presetPill = $('chat-preset')
  presetPill.hidden = !chat
  if (chat) {
    presetPill.textContent = usesBasic(chat) ? t`预设：${chat.presetId === VN_ID ? t`视觉小说预设` : t`基础预设`}` : chat.presetName ? t`预设：${chat.presetName}` : t`不用预设`
    presetPill.classList.toggle('unset', !chat.presetName)
    presetPill.disabled = ui.generating
  }
  const compact = $('compact-chat')
  compact.hidden = !chat
  if (chat) {
    // Not compactable yet it still answers a click (compactNow says why), only dimmed.
    compact.disabled = ui.generating
    compact.classList.toggle('idle', !chat.compactable)
    const meter = contextMeter(chat)
    $('context-meter').hidden = !meter
    $('context-meter').textContent = meter?.text ?? ''
    compact.classList.toggle('near', Boolean(meter?.near || meter?.heavy))
    if (meter?.heavy && !toldHeavy.has(chat.id)) {
      toldHeavy.add(chat.id)
      toast(t`这个对话的固定前缀（角色卡、常驻世界书、预设）约 ${tokensText(chat.systemPromptTokens)} token，压缩压不掉，所以上下文会很快又满。把鼠标放在上面的「压缩上下文」上看详情。`, 9000)
    }
    const why = chat.compactable
      ? t`把前面的剧情压缩成一份存档（上次压缩后新增 ${chat.compactable} 轮），之后在新的上下文里接着写`
      : compactBlockText()[chat.compactBlock] ?? t`上次压缩之后还不到 2 轮新剧情，不用压缩`
    compact.title = meter ? `${why}\n\n${meter.title}` : why
  }
  if (!chat) {
    box.replaceChildren(EMPTY)
    historyUi.refresh()
    vnUi.render(null)
    return
  }
  const lastAssistant = [...chat.path].reverse().find(n => n.role === 'assistant')
  const nodes = chat.path.map((node, index) => renderNode(chat, node, node === lastAssistant, chat.path.length - 1 - index))
  if (chat.folded > 0) {
    nodes.push(
      el('div', { class: 'folded-note' }, [
        el('span', { text: t`已回滚，后面 ${chat.folded} 轮收起了。接着写就从这里开新分支，原来的可以在下一条消息的 ‹ › 里切回。` }),
        el('button', { type: 'button', class: 'btn small', text: t`恢复`, disabled: ui.generating, onclick: () => restoreFolded() }),
      ]),
    )
  }
  box.replaceChildren(...nodes, ...liveNodes(chat))
  renderBranchNote()
  box.scrollTop = box.scrollHeight
  historyUi.refresh()
  vnUi.render(chat)
}

/** The turn being written in this chat, as far as it has come (also after switching back). */
function liveNodes(chat, { animate = false } = {}) {
  const job = ui.busy.get(chat.id)
  if (!job || job.kind === 'compact' || job.kind === 'fill' || job.kind === 'choices') return []
  const nodes = []
  if (job.echo) {
    const echo = renderNode(chat, { id: 'pending-user', role: 'user', text: job.echo, siblingCount: 1 }, false)
    if (animate) echo.classList.add('enter')
    nodes.push(echo)
  }
  const live = el('article', { class: `msg assistant streaming${animate ? ' enter' : ''}` }, [
    el('div', { class: 'msg-head' }, [speakerFace(chat, 'assistant'), el('span', { class: 'name', text: chat.names.char }), el('span', { class: 'live-note', text: job.note })]),
    el('div', { class: 'msg-body', html: job.text ? renderStory(streamingText(job.text), { partial: true }) : '' }),
  ])
  nodes.push(live)
  return nodes
}

/** Opened a chat the server is still writing (started from an earlier page): wait for it. */
function followServerTurn(view) {
  if (!view.running || ui.busy.has(view.id)) return
  ui.busy.set(view.id, { kind: 'server', text: '', note: t`正在生成（之前的页面发起的，写完会自动显示）` })
  const poll = async () => {
    const fresh = await api(`/api/chats/${view.id}`).catch(() => null)
    if (fresh?.running) return setTimeout(poll, 2000)
    ui.busy.delete(view.id)
    if (ui.chat?.id === view.id && fresh) setChat(fresh)
    else renderChats()
  }
  setTimeout(poll, 2000)
}

/** A small portrait before the speaker's name: the card's avatar for the character, your initial for you. */
function speakerFace(chat, role) {
  // A one-character name (the default 你) would just be repeated.
  if (role === 'user') return [...(chat.names.user ?? '')].length > 1 ? el('span', { class: 'face user', 'aria-hidden': 'true', text: [...chat.names.user][0] }) : null
  const card = ui.cards.find(c => c.id === chat.cardId)
  if (card?.hasAvatar) return el('img', { class: 'face', src: `/api/cards/${card.id}/avatar`, alt: '', decoding: 'async' })
  return el('span', { class: 'face', 'aria-hidden': 'true', text: (chat.names.char || '?').slice(0, 1) })
}

function renderNode(chat, node, isLastAssistant, depth = 0) {
  const isUser = node.role === 'user'
  // The default persona name is the Chinese 你 (for the model); an English page says You.
  const name = isUser ? (chat.names.user === zh`你` ? t`你` : chat.names.user) : chat.names.char
  const tools = []
  if (node.siblingCount > 1) {
    tools.push(
      el('button', { title: t`上一个版本`, text: '‹', disabled: node.siblingIndex === 0 || ui.generating, onclick: () => selectNode(node.siblingIds[node.siblingIndex - 1]) }),
      el('span', { class: 'swipe', text: `${node.siblingIndex + 1}/${node.siblingCount}` }),
      el('button', { title: t`下一个版本`, text: '›', disabled: node.siblingIndex === node.siblingCount - 1 || ui.generating, onclick: () => selectNode(node.siblingIds[node.siblingIndex + 1]) }),
    )
  }
  if (node.id !== 'root' && node.id !== 'pending-user' && !node.compaction) {
    tools.push(el('button', { text: t`修改`, title: t`直接改这条消息的原文，模型之后看到的也是改过的；不重新生成`, disabled: ui.generating, onclick: event => openEditor(chat, node, event.currentTarget.closest('.msg')) }))
  }
  if (!isUser && node.id !== 'root' && isLastAssistant) {
    tools.push(el('button', { text: t`重新生成`, disabled: ui.generating, onclick: () => regenerate(node.parent) }))
  }
  if (!isUser && isLastAssistant && (node.id !== 'root' || node.compaction)) {
    tools.push(el('button', { text: t`导出存档`, title: t`把剧情存档、最近几轮原文和变量存成文件，可以在新对话或新版本的角色卡里接着写`, disabled: ui.generating, onclick: () => exportStory(node) }))
  }
  if (!isUser && (node.id !== 'root' || node.compaction)) {
    tools.push(el('button', { text: t`分支到新对话`, title: t`开一个新对话，只带上到这一条为止的剧情（之后的对话和其他版本都不带），原对话不变`, disabled: ui.generating, onclick: () => forkChat(node.id) }))
  }
  if (!isUser && !isLastAssistant) {
    tools.push(el('button', { text: t`回滚到这里`, title: t`收起之后的对话，状态也回到这一轮；随时可以恢复`, disabled: ui.generating, onclick: () => rollbackTo(node.id) }))
    tools.push(el('button', { text: t`从这里分支`, disabled: ui.generating, onclick: () => branchFrom(node.id, t`从「${node.text.slice(0, 16)}…」之后分支`) }))
  }
  if (isUser) {
    tools.push(el('button', { text: t`编辑重发`, disabled: ui.generating, onclick: () => { $('input').value = node.text; branchFrom(node.parent, t`编辑重发：将作为这一轮的新版本`) } }))
    if (node.injected?.length) tools.push(el('span', { class: 'chips' }, node.injected.map(name => el('span', { class: 'chip', title: t`本轮注入的世界书`, text: `📖 ${name}` }))))
  }
  if (!isUser && node.id !== 'pending-user') tools.push(mediaUi.toolsFor(node))
  if (!isUser && node.stateChanges?.length) {
    const changes = node.stateChanges
    const text = changes.length <= 3 ? t`状态：${changes.join(t`、`)}` : t`状态更新 ${changes.length} 项`
    tools.push(el('span', { class: 'chip', title: changes.join('\n'), text }))
  }
  if (!isUser && node.historyTrim?.removedChars > 0) {
    tools.push(el('span', { class: 'chip', title: t`按角色卡的「仅发送」正则，这条回复在之后的上下文里去掉了这些内容（比如变量更新块），显示不受影响`, text: t`上下文精简 ${fmt(node.historyTrim.removedChars)} 字` }))
  }
  if (!isUser && node.truncated === 'paused') {
    tools.push(el('span', { class: 'chip warn', title: t`联网搜索时模型中途暂停了（搜了很多次的时候会这样），这条回复没写完。可以重新生成。`, text: t`⚠ 联网搜索中途停了，没写完` }))
  } else if (!isUser && node.truncated) {
    tools.push(el('span', { class: 'chip warn', title: t`模型写到了单次输出的上限，回复后半段（常见的是变量更新、行动选项这些放在最后的块）没写出来。上限取预设的「最大回复长度」；供应商设置里填了「最大输出」时以那个为准。可以重新生成，或调大上限。`, text: t`⚠ 写到输出上限，被截断` }))
  }
  if (!isUser && isLastAssistant && node.id !== 'root' && !node.compaction && missingUpdate(chat, node)) {
    const filling = ui.busy.get(chat.id)?.kind === 'fill'
    tools.push(el('span', { class: 'chip warn', title: t`这张卡每轮结尾要写 <UpdateVariable> 变量更新块，这一轮模型没写，状态不会跟着剧情变。「补写变量」让模型只补这一块，正文不动。`, text: t`⚠ 这轮没写变量更新` }))
    tools.push(el('button', { text: filling ? t`补写中…` : t`补写变量`, title: t`按这张卡的变量规则，让模型为这一轮补写变量更新，补完状态立即更新`, disabled: ui.generating, onclick: () => fillUpdate(node.id) }))
  }
  if (node.edited) tools.push(el('span', { class: 'chip', title: t`${new Date(node.edited.at).toLocaleString(locale)} 改过${node.edited.count > 1 ? t` ${node.edited.count} 次` : ''}`, text: t`已修改` }))
  if (node.templateErrors?.length) tools.push(el('span', { class: 'chip warn', title: node.templateErrors.join('\n'), text: t`⚠ ${node.templateErrors.length} 条 EJS 模板出错` }))
  const { shown, raw, time, choices, cardStatus } = replyDisplay(chat, node, isLastAssistant, depth)
  if (!isUser && isLastAssistant && chat.asksChoices && node.id !== 'root' && !node.compaction) tools.push(...choicesTools(chat, node, raw, choices))
  const bar = !isUser && isLastAssistant && !cardStatus ? statusFor(chat, node) : null
  const imported = node.compaction?.imported
  const recap = !isUser && node.compaction
    ? el('div', { class: 'compaction-note' }, [
        el('span', {
          text: imported
            ? t`从剧情存档接着写：「${imported.title || imported.card || t`导入的故事`}」前 ${node.compaction.turns} 轮 → ${fmt(node.compaction.chars)} 字存档，上面是存档里的最后一轮。`
            : node.compaction.kept
              ? t`已压缩上下文：只保留了最近两轮原文，之前的 ${node.compaction.kept} 轮没有写进存档（模型读不下全文）。可以在存档里补写要记住的内容。`
              : t`已压缩上下文：前 ${node.compaction.turns} 轮 → ${fmt(node.compaction.chars)} 字剧情存档，之后在新的上下文里接着写。`,
        }),
        el('button', { type: 'button', class: 'btn small', text: node.compaction.editable ? t`查看 / 修改` : t`查看`, onclick: () => openRecap(node) }),
      ])
    : null
  return el('article', { class: `msg ${isUser ? 'user' : 'assistant'}${isLastAssistant ? ' latest' : ''}`, 'data-id': node.id }, [
    el('div', { class: 'msg-head' }, [speakerFace(chat, node.role), el('span', { class: 'name', text: name }), node.id === 'root' ? el('span', { text: imported ? t`剧情存档` : t`开场` }) : null]),
    time ? timeBox(el, time) : null,
    messageBody(shown, frameContextFor(chat, node)),
    isUser ? null : mediaUi.gallery(chat, node),
    bar,
    choices.length ? choiceList(el, choices, { onFill: fillInput, onSend: sendChoice, disabled: ui.generating }) : null,
    tools.length ? el('div', { class: 'msg-tools' }, tools) : null,
    !isUser && node.search ? searchSources(node.search) : null,
    recap,
  ])
}

/** What a reply shows (the transcript and the visual novel view): text after the card's regex, its time box, its choices. */
function replyDisplay(chat, node, isLastAssistant, depth = 0) {
  const isUser = node.role === 'user'
  const scripts = scriptsFor(chat)
  const cardStatus = usesStatusPlaceholder(scripts)
  const variables = { local: chat.frameVars ?? {}, global: ui.frameInfo?.chatId === chat.id ? ui.frameInfo.globalVars ?? {} : {} }
  let shown = renderedDisplay(chat, node, displayOf(node, { scripts, names: chat.names, depth, withStatus: isLastAssistant && cardStatus, variables }))
  // The time box and choice buttons are shown too: the 屏蔽词 apply to them.
  const raw = blockShown(node.raw ?? node.text)
  let choices = !isUser && isLastAssistant ? choicesOf(raw) : []
  // A card's or preset's own options (🩶探索选项🩶：…, <w2g>, a 请选择… list) as the same buttons,
  // unless its display regex already drew them.
  if (!isUser && isLastAssistant && !choices.length) {
    const other = otherChoices(shown)
    if (other.choices.length) ({ choices, text: shown } = other)
  }
  return { shown, raw, cardStatus, time: isUser ? null : timeBoxOf(raw), choices }
}

// 楼层渲染: EJS left in what a message shows (a card's display regex writes `<%= getvar(…) %>`) is rendered
// on the server with that floor's variables, once per text; then only that message is drawn again.
const displayRenders = new Map() // chat:node:text → rendered text, or null while asked
const EJS = /<%[\s\S]*?%>/g
const displayWaiting = new Set() // node ids drawn before their text came back
let displayRedraw = 0

/** One message drawn again in place; the others, and the card frames in them, keep running. */
function redrawMessage(nodeId) {
  const chat = ui.chat
  const index = chat ? chat.path.findIndex(n => n.id === nodeId) : -1
  const old = index < 0 ? null : $('transcript').querySelector(`.msg[data-id="${CSS.escape(nodeId)}"]`)
  if (!old) return
  const lastAssistant = [...chat.path].reverse().find(n => n.role === 'assistant')
  patchKeepingFrames(old, renderNode(chat, chat.path[index], chat.path[index] === lastAssistant, chat.path.length - 1 - index))
}

// A frame that is moved or taken out of the page starts again (its card loses what it was doing), so the
// frames still in the new drawing (same content, same order) stay where they are and what is around them changes.
const frameKeysIn = node => node.nodeType !== 1 ? [] : node.matches('iframe.card-frame') ? [node.dataset.key] : [...node.querySelectorAll('iframe.card-frame')].map(frame => frame.dataset.key)

function patchKeepingFrames(old, fresh) {
  if (old.nodeName !== fresh.nodeName) return old.replaceWith(fresh)
  for (const { name } of [...old.attributes]) if (!fresh.hasAttribute(name)) old.removeAttribute(name)
  for (const { name, value } of [...fresh.attributes]) if (old.getAttribute(name) !== value) old.setAttribute(name, value)
  let cursor = old.firstChild
  for (const kid of [...fresh.childNodes]) {
    const keys = frameKeysIn(kid)
    let match = null
    for (let at = cursor; keys.length && at && !match; at = at.nextSibling) if (at.nodeName === kid.nodeName && frameKeysIn(at).some(key => keys.includes(key))) match = at
    if (!match) {
      old.insertBefore(kid, cursor)
      continue
    }
    while (cursor !== match) { const next = cursor.nextSibling; cursor.remove(); cursor = next }
    if (match.nodeName !== 'IFRAME') patchKeepingFrames(match, kid)
    cursor = match.nextSibling
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next }
}

function textKey(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return `${text.length}:${h}`
}

function renderedDisplay(chat, node, shown) {
  if (!/<%[\s\S]*?%>/.test(shown)) return shown
  // A reply still being written changes with every chunk: rendered once it is done.
  if (ui.generating && node.id === chat.path.at(-1)?.id) return shown.replace(EJS, '')
  const key = `${chat.id}:${node.id}:${textKey(shown)}`
  displayWaiting.add(node.id)
  if (displayRenders.has(key)) {
    const done = displayRenders.get(key)
    if (done !== null) displayWaiting.delete(node.id)
    return done ?? heldDisplay(node, shown)
  }
  displayRenders.set(key, null)
  api(`/api/chats/${chat.id}/display-render`, { method: 'POST', body: { nodeId: node.id, texts: [shown] } })
    .then(({ texts }) => displayRenders.set(key, typeof texts?.[0] === 'string' ? texts[0] : shown.replace(EJS, '')))
    .catch(() => displayRenders.set(key, shown.replace(EJS, '')))
    .finally(() => {
      // Several messages come back together: drawn in one go.
      clearTimeout(displayRedraw)
      displayRedraw = setTimeout(() => {
        if (ui.chat?.id !== chat.id) return displayWaiting.clear()
        for (const id of [...displayWaiting]) redrawMessage(id)
        if (vnUi.isOn(ui.chat.cardId)) vnUi.render(ui.chat)
      }, 30)
    })
  return heldDisplay(node, shown)
}

// Until the render comes back: a message already on screen is drawn without the EJS, so the card frames in it
// that stay the same keep running; a new one waits (a moment), so its frames start once, with the rendered text.
function heldDisplay(node, shown) {
  const onScreen = $('transcript').querySelector(`.msg[data-id="${CSS.escape(node.id)}"] iframe.card-frame`)
  return onScreen ? shown.replace(EJS, '') : '…'
}

/** The built-in status bar under a reply, or null (cards that draw their own use their regex). */
function statusFor(chat, node) {
  const spec = statusSpecFor(chat, node)
  return spec ? statusBar(el, spec, node.state ?? {}, { previous: previousState(chat, node) }) : null
}

// ─── Editing a message in place ─────────────────────────────────────────

// Whole tagged blocks in a reply (thinking, status, variable updates…): offered for one-tap removal.
const BLOCK = /<([A-Za-z_][\w~:.-]*)(?:\s[^<>]*)?>[\s\S]*?<\/\1>\s*/g
const blockPattern = tag => {
  const name = tag.replace(/\./g, '\\.')
  return new RegExp(`<${name}(?:\\s[^<>]*)?>[\\s\\S]*?</${name}>\\s*`, 'g')
}

function tagBlocks(text) {
  const sizes = new Map()
  for (const match of text.matchAll(BLOCK)) {
    const tag = match[1]
    if (INLINE_TAGS.has(tag.toLowerCase())) continue
    sizes.set(tag, (sizes.get(tag) ?? 0) + match[0].length)
  }
  // A block that is most of the message (<content>) is the story itself, not something to drop.
  return [...sizes].filter(([, size]) => size < text.length * 0.7).sort((a, b) => b[1] - a[1]).slice(0, 6)
}

function openEditor(chat, node, article) {
  if (!article || article.classList.contains('editing')) return
  const original = node.raw ?? node.text
  const body = article.querySelector('.msg-body')
  const tools = article.querySelector('.msg-tools')
  const area = el('textarea', { class: 'edit-text', spellcheck: 'false', 'aria-label': t`消息原文` })
  area.value = original
  const fit = () => {
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight + 2, innerHeight * 0.62)}px`
  }
  const count = el('span', { class: 'edit-count' })
  const blocks = el('div', { class: 'edit-blocks' })
  const refresh = () => {
    const now = area.value.length
    count.textContent = now === original.length ? t`${fmt(now)} 字` : t`${fmt(original.length)} → ${fmt(now)} 字`
    const found = tagBlocks(area.value)
    blocks.hidden = !found.length
    blocks.replaceChildren(
      el('span', { class: 'edit-blocks-label', text: t`整块删掉` }),
      ...found.map(([tag, size]) =>
        el('button', {
          type: 'button',
          class: 'edit-block',
          title: t`删掉所有 <${tag}>…</${tag}>`,
          onclick: () => {
            area.focus()
            area.select()
            // execCommand keeps the browser's undo (Ctrl+Z) working.
            const next = area.value.replace(blockPattern(tag), '').replace(/\n{3,}/g, '\n\n').trim()
            if (!document.execCommand('insertText', false, next)) area.value = next
            refresh()
            fit()
          },
        }, [el('code', { text: tag }), el('span', { text: t`${fmt(size)} 字` })]),
      ),
    )
  }
  const close = () => {
    editor.remove()
    body.hidden = false
    if (tools) tools.hidden = false
    article.classList.remove('editing')
  }
  const save = guard(async () => {
    const text = area.value.trim()
    if (text === original.trim()) return close()
    saveButton.disabled = true
    try {
      const box = $('transcript')
      const keep = box.scrollTop
      const view = await api(`/api/chats/${chat.id}/messages/${node.id}`, { method: 'PUT', body: { text } })
      const outcome = view.edit ?? {}
      setChat(view)
      box.scrollTop = keep
      box.querySelector(`[data-id="${node.id}"]`)?.classList.add('swap')
      toast(
        outcome.behindCompaction
          ? t`已修改。这条在剧情存档之前，模型现在读的是存档，所以只改了显示`
          : outcome.missed && subscriptionPage
            ? subscriptionPage.EDIT_MISSED
            : outcome.promptMissed
              ? t`已修改显示，但在这轮发出的内容里没找到原文，模型之后可能还会看到旧内容；可以从这条之后分支或重新生成`
              : t`已修改。之后每轮按改过的内容发送，下一轮从这条起重新写一次缓存`,
        6000,
      )
    } finally {
      saveButton.disabled = false
    }
  })
  const saveButton = el('button', { type: 'button', class: 'btn small primary', text: t`保存`, onclick: save })
  const editor = el('div', { class: 'msg-editor' }, [
    blocks,
    area,
    el('div', { class: 'edit-foot' }, [
      el('span', { class: 'edit-note', text: node.role === 'user' ? t`改的是你这条输入；模型之后看到的也是改过的。` : t`这是发给模型的原文，隐藏的状态块也在里面。删掉的内容之后不会再进上下文，已经算好的变量不变。` }),
      count,
      el('span', { class: 'edit-actions' }, [
        el('button', { type: 'button', class: 'btn small ghost', text: t`取消`, onclick: close }),
        saveButton,
      ]),
    ]),
  ])
  area.addEventListener('input', () => { refresh(); fit() })
  area.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save() }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  })
  article.classList.add('editing')
  body.hidden = true
  if (tools) tools.hidden = true
  body.after(editor)
  refresh()
  fit()
  area.focus()
  area.setSelectionRange(0, 0)
  area.scrollTop = 0
}

// ─── Tavern Helper stand-in for card HTML (web/compat.js) ───────────────

// How much story the frames of the latest messages get to read (getChatMessages over the whole chat).
const FRAME_HISTORY_CHARS = 300_000

/**
 * What a message's HTML may read: its floor, the messages (all of them for the
 * latest two floors, where a card's live UI is; nearby ones elsewhere),
 * variables, the books this chat uses and saved storage.
 */
function frameContextFor(chat, node) {
  const index = chat.path.findIndex(n => n.id === node.id)
  if (index < 0) return null
  const last = chat.path.length - 1
  let floors = [...new Set([0, index - 1, index, last - 1, last].filter(i => i >= 0))]
  if (index >= last - 1) {
    // Newest first until the budget, then oldest first again.
    let used = 0
    floors = []
    for (let i = last; i >= 0; i--) {
      used += (chat.path[i].raw ?? chat.path[i].text ?? '').length
      if (used > FRAME_HISTORY_CHARS && floors.length > 2) break
      floors.push(i)
    }
  }
  const card = ui.cards.find(c => c.id === chat.cardId)
  const info = ui.frameInfo?.chatId === chat.id ? ui.frameInfo : null
  return {
    app: ui.appVersion ?? '',
    messageId: index,
    nodeId: node.id,
    lastId: last,
    chatId: chat.id,
    cardId: chat.cardId,
    names: chat.names,
    // With the key that lets a frame (no cookie of its own) read the avatar on a phone too.
    card: { avatar: card?.hasAvatar ? `${location.origin}/api/cards/${chat.cardId}/avatar${info?.avatarKey ? `?fk=${info.avatarKey}` : ''}` : '' },
    persona: { description: info?.persona?.description ?? '' },
    books: info?.books ?? { own: '', mounted: [], global: [] },
    vars: {
      message: node.state ?? {},
      latest: chat.state ?? {},
      ...storedVariables({ presetId: chat.presetId, cardId: chat.cardId }),
      global: info?.globalVars ?? {},
      chat: chat.frameVars ?? info?.vars ?? {},
    },
    messages: floors.sort((a, b) => a - b).map(i => {
      const n = chat.path[i]
      return { message_id: i, name: n.role === 'user' ? chat.names.user : chat.names.char, role: n.role, message: n.raw ?? n.text ?? '', state: n.state ?? {} }
    }),
    storage: storedFrameStorage(chat.cardId),
    // Direct API calls: this app's own address is never relayed; the addresses allowed for this card go through it at once.
    appOrigin: location.origin,
    relay: framePermissions.allowedOrigins(chat.cardId),
    // A chat still on its opening can switch to another of the card's (a welcome page's swipe).
    openings: last === 0 ? card?.greetings ?? 0 : 0,
    input: $('input').value,
    viewport: { width: innerWidth, height: innerHeight },
  }
}

/** The books a chat's card frames see by name, the app's global variables and the player's description. */
async function loadFrameInfo(chatId) {
  // Asked once per chat, even when it fails: frames then see no book names.
  ui.frameInfo = { chatId }
  const info = await api(`/api/chats/${chatId}/frame-info`).catch(() => null)
  if (info && ui.frameInfo.chatId === chatId) ui.frameInfo = { ...info, chatId }
  return ui.frameInfo
}

function setDraft(text, focus = true) {
  const input = $('input')
  input.value = text
  fitInput()
  broadcastInput(text)
  if (focus) input.focus()
}

let lastFrameSend = 0

/**
 * A card asked to send what is in the input box: once per few seconds, never
 * mid-generation. A slash command it typed there (`/sendas … <fight>`) runs as
 * a command instead of going to the model as text. Right after a click in the
 * card's interface it is the player sending; without one, the card is asked about once.
 * @param context - who asked (compat.js installFrameBridge): { card, clicked }.
 */
async function frameSend(context = {}) {
  if (!ui.chat || ui.generating) throw new Error(t`正在生成，稍后再试`)
  const draft = $('input').value.trim()
  if (draft.startsWith('/')) {
    setDraft('', false)
    await runFrameSlash(draft, context)
    return
  }
  if (Date.now() - lastFrameSend < 3000) throw new Error(t`发送太频繁`)
  const cardId = context.card ?? ui.chat.cardId
  // One click, one send: a command that triggers again after it is asked about like any other.
  const clicked = context.clicked === true
  context.clicked = false
  if (!clicked && !permitted(cardId, 'send', t`「${cardName(cardId)}」的卡片界面想自己把输入框里的内容发出去（你没有点它），每发一次按一轮对话计费。\n\n允许这张卡这样做吗？`)) {
    throw new Error(t`没有允许这张卡的界面自己发送`)
  }
  lastFrameSend = Date.now()
  await send()
}

/**
 * Slash commands from card HTML: the input-box ones, `/sendas` (a message from
 * the character, added to the latest reply), `/setentryfield` (this chat's copy
 * of a book entry) and the chat variables. Anything else is refused, so the card
 * takes its own way round instead of thinking it worked.
 * @param context - who asked, for `/trigger` (frameSend).
 */
async function runFrameSlash(command, context = {}) {
  let staged = null
  let output = ''
  for (const step of parseSlash(command)) {
    if (step.name === 'setinput') setDraft(step.text)
    else if (step.name === 'send') staged = step.text
    else if (step.name === 'trigger') {
      if (staged !== null) setDraft(staged, false)
      staged = null
      await frameSend(context)
    } else if (step.name === 'echo') toast(step.text)
    else if (step.name === 'pass') output = step.text
    else if (step.name === 'sendas') await frameHandlers.createMessages({ messages: [{ role: 'assistant', text: step.text }] })
    else if (step.name === 'setentryfield') {
      const { file = '', uid, field = 'content' } = step.named
      await frameHandlers.worldbook({ action: 'field', name: file, uid: Number(uid), field, value: step.text })
    } else if (step.name === 'setvar' || step.name === 'getvar' || step.name === 'addvar') output = await frameChatVar(step)
    else {
      toast(t`界面里的命令 /${step.name} 在这里不支持`)
      throw new Error(t`不支持 /${step.name}`)
    }
  }
  // `/send` without `/trigger` adds a message in SillyTavern; here it waits in the input box.
  if (staged !== null) setDraft(staged)
  return output
}

/** `/setvar key=… value`, `/getvar key`, `/addvar key=… n`: the chat variables (Tavern Helper's, the templates' local scope). */
async function frameChatVar(step) {
  const vars = { ...(ui.chat?.frameVars ?? ui.frameInfo?.vars ?? {}) }
  const key = step.named.key ?? step.text.trim()
  if (step.name === 'getvar') {
    const value = vars[key]
    return value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  const text = step.text
  vars[key] = step.name === 'addvar' ? (Number(vars[key]) || 0) + (Number(text) || 0) : text
  await frameHandlers.chatVars({ value: vars, set: { [key]: vars[key] } })
  return String(vars[key])
}

// What a card's interface may do without a click (send, call the model, reach an address through the app): asked
// once per card, the answer kept either way; changed in the card's menu (卡片界面权限).
const framePermissions = createFramePermissions(
  (() => {
    try {
      return localStorage
    } catch {
      return null
    }
  })(),
)
const PERMISSION_NOTE = t`\n\n不管允许还是不允许，之后都不再问；要改的话，在角色卡菜单的「卡片界面权限」里改。`
const cardName = cardId => ui.cards.find(c => c.id === cardId)?.name ?? ''

/** The player's answer for this card: asked the first time, then kept (a no as well). */
function permitted(cardId, kind, question, origin) {
  const decided = framePermissions.decision(cardId, kind, origin)
  if (decided) return decided === 'allow'
  const yes = confirm(question + PERMISSION_NOTE)
  framePermissions.decide(cardId, kind, yes ? 'allow' : 'deny', origin)
  return yes
}

// Model calls card frames make (generate / generateRaw): allowed per card, one at a time, at most ten a minute.
const GENERATE_PER_MINUTE = 10
const frameGenerations = new Map() // generation id → AbortController
const frameGenerationTimes = []

// A card frame's own API call the browser could not make, made from the app instead (server/relay.mjs): allowed
// per card and address, asked once. An address on this computer or the local network is allowed as one besides
// (the server says when an address leads there, whatever its name).
const relayQuiet = new Set() // cards told no about an address: not asked about others until the page is opened again
const frameFetches = new Map() // relay id → AbortController
// The frame each relayed call and model call came from: they end with it (the chat drawn again, another opened),
// as nobody is left to read them, and a model call stops being billed (watchCallFrames).
const callFrames = new WeakMap() // AbortController → frame id

function watchCallFrames() {
  const gone = id => !document.querySelector(`iframe[data-frame="${CSS.escape(id)}"]`)
  new MutationObserver(() => {
    if (!frameGenerations.size && !frameFetches.size) return
    for (const controller of [...frameGenerations.values(), ...frameFetches.values()]) {
      const frame = callFrames.get(controller)
      if (frame && gone(frame)) controller.abort()
    }
  }).observe(document.body, { childList: true, subtree: true })
}
// This computer or the local network by its name: warned of in the first question (the server checks every address).
const LOCAL_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i

function relayTargetOf(url) {
  try {
    return new URL(url)
  } catch {
    throw new Error(t`地址不对`)
  }
}

const relayRefusal = target => new Error(t`没有允许这张卡经 CicaTavern 连接 ${target.origin}`)

/**
 * Asks once per card and address whether the app may make a card frame's calls there, and keeps the answer; throws
 * on a no. A card told no is not asked about other addresses until the page is opened again (one card trying
 * address after address would keep the player answering).
 */
function askRelay(cardId, target) {
  const decided = framePermissions.decision(cardId, 'relay', target.origin)
  if (decided === 'allow') return
  if (decided === 'deny' || relayQuiet.has(cardId)) throw relayRefusal(target)
  const local = LOCAL_HOST.test(target.hostname)
  const how = local ? t`会直接连过去，不走应用的网络代理；` : t`会走应用的网络代理；`
  const warning = local ? t`\n\n这是这台电脑或局域网里的地址：只有你知道那里是什么服务时才允许。` : ''
  if (!permitted(cardId, 'relay', t`「${cardName(cardId)}」的卡片界面要连接 ${target.origin}，浏览器直接连没有连上（多半是对方不让网页直接调用，或者网页够不着这个地址）。\n\n改由 CicaTavern 替它连接吗？${how}卡片界面发出的内容（包括它自己的 API Key）会经过 CicaTavern 发到这个地址。${warning}`, target.origin)) {
    relayQuiet.add(cardId)
    throw relayRefusal(target)
  }
  // Frames already open learn it too: their next call goes through the app at once.
  broadcastRelay(framePermissions.allowedOrigins(cardId))
}

/** Whether the player let this card reach `target` knowing it is on this computer or the local network. */
const relayLocalAllowed = (cardId, target) =>
  framePermissions.decision(cardId, 'local', target.origin) === 'allow' || (LOCAL_HOST.test(target.hostname) && framePermissions.decision(cardId, 'relay', target.origin) === 'allow')

/**
 * The server found `target` on this computer or the local network, or could not tell where it leads
 * (`unverified`: fake-IP DNS, or a name only the proxy knows): asked once more, as such, and kept.
 */
function askRelayLocal(cardId, target, unverified = false) {
  const name = cardName(cardId)
  const question = unverified
    ? t`「${name}」的卡片界面要连接的 ${target.origin}，CicaTavern 查不到它实际指向哪里（网络代理或 TUN 模式接管了域名解析），它也可能是这台电脑或局域网里的服务。\n\n只有你信任这张卡和这个地址时才允许：允许后，这张卡能读到那里的回答。`
    : t`「${name}」的卡片界面要连接的 ${target.origin} 是这台电脑或局域网里的地址。\n\n只有你知道那里是什么服务时才允许：允许后，这张卡能读到那个服务的回答。`
  if (!permitted(cardId, 'local', question, target.origin)) throw relayRefusal(target)
}

/** The API's own headers, which the server sends as data (x-relay-headers) so that none of them acts on this app. */
function relayedHeaders(res) {
  try {
    const list = JSON.parse(decodeURIComponent(res.headers.get('x-relay-headers') ?? '[]'))
    return Array.isArray(list) ? list.filter(pair => Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string')) : []
  } catch {
    return []
  }
}

/** Bytes as base64, in slices (a spread of a large array overflows the stack). */
function base64Of(bytes) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

/** The page's answers to what card frames ask for (web/compat.js installFrameBridge). */
// A frame's change is saved to the chat it was drawn in; what comes back is shown only while that chat is still
// the open one (the player may have opened another meanwhile, and the next message would go to the wrong chat).
const stillOpen = chatId => ui.chat?.id === chatId

const frameHandlers = {
  // The latest floor's variables (Mvu.replaceMvuData, replaceVariables on the message): saved as 编辑状态 saves
  // them, without drawing the chat again (the frame that wrote them would start over).
  async state({ state }) {
    if (!ui.chat) throw new Error(t`没有打开的对话`)
    const chatId = ui.chat.id
    const view = await api(`/api/chats/${chatId}/state`, { method: 'PUT', body: { state } })
    if (!stillOpen(chatId)) return
    ui.chat = view
    renderSide()
    broadcastState(view.state ?? state)
  },
  // A frame sends the keys it changed (set / unset), saved over what is saved now: another frame's or a
  // template's keys stay. Without them (an older frame), the whole value as before.
  async chatVars({ value, set, unset }) {
    if (!ui.chat) throw new Error(t`没有打开的对话`)
    const chatId = ui.chat.id
    const body = set || unset ? { set, unset } : { vars: value }
    const { vars } = await api(`/api/chats/${chatId}/frame-vars`, { method: 'PUT', body })
    if (stillOpen(chatId)) {
      ui.chat.frameVars = vars
      broadcastChatVars(vars)
    }
    if (ui.frameInfo?.chatId === chatId) ui.frameInfo.vars = vars
  },
  async globalVars(value, patch = null) {
    const saved = await api('/api/settings', { method: 'PUT', body: patch ? { globalVarsPatch: patch } : { globalVars: value } })
    if (ui.frameInfo) ui.frameInfo.globalVars = saved?.globalVars ?? value
  },
  mvuParse: ({ text, state }) => api('/api/mvu/parse', { method: 'POST', body: { text, state } }),
  // EjsTemplate: rendered at the frame's floor as what messages show is (楼层渲染), or only checked.
  async ejs({ code, messageId, check }) {
    if (check) return api('/api/ejs/check', { method: 'POST', body: { code } })
    const node = ui.chat?.path[Number(messageId)] ?? ui.chat?.path.at(-1)
    if (!node) throw new Error(t`没有打开的对话`)
    const { texts, errors } = await api(`/api/chats/${ui.chat.id}/display-render`, { method: 'POST', body: { nodeId: node.id, texts: [code] } })
    if (errors?.length) throw new Error(errors[0].error)
    return { text: texts[0] }
  },
  async editMessage({ messageId, text }, context = {}) {
    const node = ui.chat?.path[messageId]
    if (!node) throw new Error(t`没有这一楼`)
    // Held here too, not only in the frame's own script (which a card can go round): its own floor or the latest.
    if (messageId !== ui.chat.path.length - 1 && node.id !== context.node) throw new Error(t`只能改这个界面所在的楼层或最新一楼`)
    if (ui.generating) throw new Error(t`正在生成，稍后再试`)
    const chatId = ui.chat.id
    const view = await api(`/api/chats/${chatId}/messages/${node.id}`, { method: 'PUT', body: { text: String(text ?? '') } })
    if (stillOpen(chatId)) setChat(view)
  },
  // The character's messages are added to the end of the latest reply (a subscription session can only carry on
  // from replies it wrote); the player's go into the input box for the card's /trigger.
  async createMessages({ messages }) {
    if (!ui.chat) throw new Error(t`没有打开的对话`)
    const list = Array.isArray(messages) ? messages : []
    const said = list.filter(m => m.role === 'user').map(m => String(m.text ?? '')).join('\n\n')
    const told = list.filter(m => m.role !== 'user').map(m => String(m.text ?? '')).filter(Boolean).join('\n\n')
    if (told) {
      const tip = ui.chat.path.at(-1)
      if (tip?.role !== 'assistant') throw new Error(t`最新一楼不是角色的回复`)
      if (ui.generating) throw new Error(t`正在生成，稍后再试`)
      // Drawn again in place: the frame that asked (usually in this very reply) keeps running.
      const chatId = ui.chat.id
      const view = await api(`/api/chats/${chatId}/messages/${tip.id}`, { method: 'PUT', body: { text: `${(tip.raw ?? tip.text ?? '').trimEnd()}\n\n${told}` } })
      if (!stillOpen(chatId)) return
      ui.chat = view
      redrawMessage(tip.id)
      renderSide()
      if (vnUi.isOn(ui.chat.cardId)) vnUi.render(ui.chat)
    }
    if (said) setDraft(said, false)
  },
  // Only the last floors, folded away as 回滚 does (「恢复」 brings them back).
  async deleteMessages({ ids }) {
    if (!ui.chat || ui.generating) throw new Error(t`正在生成，稍后再试`)
    const last = ui.chat.path.length - 1
    const wanted = [...new Set((ids ?? []).map(Number))].sort((a, b) => a - b)
    if (!wanted.length) return
    if (wanted.some((id, i) => id !== last - (wanted.length - 1) + i) || wanted[0] < 1) throw new Error(t`只能删掉最后的几楼`)
    let keep = wanted[0] - 1
    if (ui.chat.path[keep]?.role === 'user') keep -= 1
    const chatId = ui.chat.id
    const view = await api(`/api/chats/${chatId}/rollback`, { method: 'POST', body: { nodeId: ui.chat.path[Math.max(0, keep)].id } })
    if (stillOpen(chatId)) setChat(view)
  },
  async worldbook(args) {
    if (!ui.chat) throw new Error(t`没有打开的对话`)
    const { entries, prefix } = await api(`/api/chats/${ui.chat.id}/worldbook`, { method: args.action === 'get' ? 'POST' : 'PUT', body: args })
    if (prefix) toast(t`卡片界面改了世界书的常驻条目（只对这个对话）：下一轮会重新写入一次缓存`)
    return entries
  },
  async generate({ id, raw, config }, { frame, window: source, card }) {
    const chat = ui.chat
    if (!chat) throw new Error(t`没有打开的对话`)
    if (ui.generating) throw new Error(t`正在生成，稍后再试`)
    if (frameGenerations.size) throw new Error(t`卡片界面已经在调用模型了`)
    while (frameGenerationTimes.length && Date.now() - frameGenerationTimes[0] > 60000) frameGenerationTimes.shift()
    if (frameGenerationTimes.length >= GENERATE_PER_MINUTE) throw new Error(t`调用太频繁`)
    const cardId = card ?? chat.cardId
    if (!permitted(cardId, 'generate', t`「${cardName(cardId)}」的卡片界面想自己调用模型（比如生成角色信息），每次都按一次对话计费。\n\n允许这张卡这样做吗？`)) throw new Error(t`用户没有允许这张卡调用模型`)
    frameGenerationTimes.push(Date.now())
    const controller = new AbortController()
    frameGenerations.set(id, controller)
    callFrames.set(controller, frame)
    const relay = message => source?.postMessage({ agentTavernStream: { frame, id, ...message } }, '*')
    // The notice stays while it runs; a click on it stops the call (see the toast's listener at start-up).
    toast(t`卡片界面正在调用模型，点这条提示可以停止`, 600000)
    let full = ''
    try {
      full = await streamFrameGeneration(chat.id, { raw, config }, controller.signal, delta => {
        full += delta
        if (config.should_stream) relay({ delta, full })
      })
      relay({ full, done: true })
      toast(t`卡片界面的模型调用完成`, 2000)
      return full
    } catch (error) {
      toast(controller.signal.aborted ? t`已停止卡片界面的模型调用` : error.message, 4000)
      throw error
    } finally {
      frameGenerations.delete(id)
    }
  },
  stopGenerate({ id }) {
    for (const [key, controller] of frameGenerations) if (!id || key === id) controller.abort()
  },
  // A frame's own API call that failed in the browser: made from the app once the player allows this card and
  // address, the answer streamed back as it comes (status and headers, then the body).
  async fetch({ id, url, method, headers, body }, { frame, window: source, card }) {
    const chat = ui.chat
    if (!chat) throw new Error(t`没有打开的对话`)
    const cardId = card ?? chat.cardId
    const target = relayTargetOf(url)
    askRelay(cardId, target)
    const controller = new AbortController()
    frameFetches.set(id, controller)
    callFrames.set(controller, frame)
    const send = message => source?.postMessage({ agentTavernFetch: { frame, id, ...message } }, '*')
    const encoded = body ? base64Of(new Uint8Array(body)) : null
    const relay = local => fetch('/api/frame-fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' },
      body: JSON.stringify({ url: target.href, method, headers, body: encoded, local }),
      signal: controller.signal,
    })
    // Not the API's answer: this app could not make the call.
    const failure = async res => new Error((await res.json().catch(() => ({}))).error ?? t`请求失败（${res.status}）`)
    try {
      const local = relayLocalAllowed(cardId, target)
      let res = await relay(local)
      if (!res.headers.get('x-relay')) {
        const answer = await res.clone().json().catch(() => ({}))
        // The address leads to this computer or the local network (whatever its name says): asked as such, then again.
        if (!answer.local || local) throw await failure(res)
        askRelayLocal(cardId, target, answer.unverified === true)
        res = await relay(true)
        if (!res.headers.get('x-relay')) throw await failure(res)
      }
      send({ head: { status: Number(res.headers.get('x-relay-status')) || 502, statusText: decodeURIComponent(res.headers.get('x-relay-status-text') ?? ''), headers: relayedHeaders(res) } })
      const reader = res.body?.getReader()
      for (;;) {
        const { value, done } = reader ? await reader.read() : { done: true }
        if (done) break
        send({ chunk: value })
      }
      send({ done: true })
    } finally {
      frameFetches.delete(id)
    }
  },
  fetchCancel({ id }) {
    frameFetches.get(id)?.abort()
  },
  // A frame's call other than GET / HEAD that failed in the browser may have reached the API all the same (a page
  // is refused the answer after the API took the call), so it is not sent again: the player is asked as for any
  // other, and the card's next call goes through the app.
  fetchAllow({ url }, { card }) {
    const chat = ui.chat
    if (!chat) throw new Error(t`没有打开的对话`)
    const target = relayTargetOf(url)
    askRelay(card ?? chat.cardId, target)
    return t`已允许这张卡经 CicaTavern 连接 ${target.origin}。这一次的请求可能已经送到对方，所以没有重发：再试一次就会经 CicaTavern 连接。`
  },
}

/** One frame-requested model call, streamed from the server; resolves with the whole text. */
async function streamFrameGeneration(chatId, body, signal, onDelta) {
  const res = await fetch(`/api/chats/${chatId}/frame-generate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: JSON.stringify(body), signal })
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let cut
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const line = buffer.slice(0, cut).replace(/^data: /, '')
      buffer = buffer.slice(cut + 2)
      if (!line.trim()) continue
      const event = JSON.parse(line)
      if (event.type === 'delta') onDelta(event.text)
      else if (event.type === 'done') text = event.text
      else if (event.type === 'error') throw new Error(event.message)
    }
  }
  return text
}

function branchFrom(parentId, label) {
  ui.branchFrom = { parentId, label }
  renderBranchNote()
  $('input').focus()
}

function renderBranchNote() {
  const note = $('branch-note')
  if (!ui.branchFrom) { note.hidden = true; return }
  note.hidden = false
  note.replaceChildren(el('span', { text: ui.branchFrom.label }), el('button', { type: 'button', text: t`取消`, onclick: () => { ui.branchFrom = null; renderBranchNote() } }))
}

const selectNode = guard(async nodeId => {
  const box = $('transcript')
  const keep = box.scrollTop
  setChat(await api(`/api/chats/${ui.chat.id}/select`, { method: 'POST', body: { nodeId } }))
  // Swiping keeps the reader where they were and fades the new version in.
  box.scrollTop = keep
  box.querySelector(`[data-id="${nodeId}"]`)?.classList.add('swap')
})

const rollbackTo = guard(async nodeId => {
  ui.branchFrom = null
  setChat(await api(`/api/chats/${ui.chat.id}/rollback`, { method: 'POST', body: { nodeId } }))
  toast(t`已回滚，收起了 ${ui.chat.folded} 轮`)
})

const forkChat = guard(async nodeId => {
  const chat = await api(`/api/chats/${ui.chat.id}/fork`, { method: 'POST', body: { nodeId } })
  await refreshChats()
  setChat(chat)
  toast(t`已分支到新对话「${chat.title}」，原对话没动`, 5000)
})

const restoreFolded = guard(async () => {
  setChat(await api(`/api/chats/${ui.chat.id}/restore`, { method: 'POST', body: {} }))
  toast(t`已恢复`)
})

// ─── Context compaction (server/recap.mjs) ──────────────────────────────

/** Switching models with at least this many new turns offers to compact first. */
const SUGGEST_COMPACT = 6

function askSwitch(turns) {
  const dialog = $('switch-dialog')
  $('switch-text').textContent =
    t`缓存按模型区分，换模型后下一轮要把整段历史重新写一遍缓存。先把前面的剧情（上次压缩后新增 ${turns} 轮）压缩成存档，新模型只需读存档和最近两轮原文。` +
    t`存档由现在这个模型来写，它的缓存还在，大约花一轮的额度。`
  dialog.showModal()
  // Buttons answer on click (a hidden window may hold back the `close` event); Esc or any other close means cancel.
  return new Promise(resolve => {
    const onClick = event => {
      const button = event.target.closest('button[value]')
      if (button) done(button.value)
    }
    const onClose = () => done('cancel')
    function done(value) {
      dialog.removeEventListener('click', onClick)
      dialog.removeEventListener('close', onClose)
      if (dialog.open) dialog.close()
      resolve(value)
    }
    dialog.addEventListener('click', onClick)
    dialog.addEventListener('close', onClose)
  })
}

/** An MVU card's reply that came without its <UpdateVariable> block. */
function missingUpdate(chat, node) {
  const card = ui.cards.find(c => c.id === chat.cardId)
  return Boolean(card?.mvu) && !/<UpdateVariable>/i.test(node.raw ?? node.text ?? '')
}

/**
 * 重写选项 on the latest reply of a chat whose preset asks for <choices>: 换一组 when it has them, 补写 (with a
 * warning) when it has none; a card's own options (🩶探索选项🩶…) are its format, left alone.
 */
function choicesTools(chat, node, raw, choices) {
  const own = choicesOf(raw).length > 0
  if (!own && choices.length) return []
  const rewriting = ui.busy.get(chat.id)?.kind === 'choices'
  return [
    own ? null : el('span', { class: 'chip warn', title: t`模型这一轮没有在结尾写行动选项。「补写选项」让模型只写这四项，正文不动。`, text: t`⚠ 这轮没写选项` }),
    el('button', {
      text: rewriting ? t`重写中…` : own ? t`换一组选项` : t`补写选项`,
      title: t`只重写这一轮结尾的四个行动选项，正文不动。用写这条回复的模型，读的是和下一轮一样的上下文（命中缓存）`,
      disabled: ui.generating,
      onclick: () => rewriteChoices(node.id),
    }),
  ].filter(Boolean)
}

/** 重写选项: the model writes the latest reply's four choices again; they replace its own (or are added). */
async function rewriteChoices(nodeId) {
  const chatId = ui.chat?.id
  if (!chatId || ui.generating) return
  ui.busy.set(chatId, { kind: 'choices' })
  renderChat()
  renderChats()
  toast(t`正在重写选项……`, 120000)
  try {
    const view = await api(`/api/chats/${chatId}/nodes/${nodeId}/rewrite-choices`, { method: 'POST', body: {} })
    ui.busy.delete(chatId)
    if (ui.chat?.id === chatId) setChat(view)
    toast(t`已换上新的选项`, 4000)
  } catch (error) {
    toast(error.status === 499 ? t`已停止重写，选项没有变` : error.message, 8000)
  } finally {
    ui.busy.delete(chatId)
    if (ui.chat?.id === chatId) renderChat()
    renderChats()
  }
}

/** 补写变量: the model writes the latest reply's missing update block; it is appended and the state follows. */
async function fillUpdate(nodeId) {
  const chatId = ui.chat?.id
  if (!chatId || ui.generating) return
  ui.busy.set(chatId, { kind: 'fill' })
  renderChat()
  renderChats()
  toast(t`正在补写变量更新……`, 120000)
  try {
    const view = await api(`/api/chats/${chatId}/nodes/${nodeId}/fill-update`, { method: 'POST', body: {} })
    ui.busy.delete(chatId)
    if (ui.chat?.id === chatId) setChat(view)
    const changes = view.path.at(-1).stateChanges?.length ?? 0
    toast(changes ? t`已补写变量更新，${changes} 项变了` : t`已补写变量更新（模型认为这一轮没有变量变化）`, 6000)
  } catch (error) {
    toast(error.status === 499 ? t`已停止补写，什么都没改` : error.message, 8000)
  } finally {
    ui.busy.delete(chatId)
    if (ui.chat?.id === chatId) renderChat()
    renderChats()
  }
}

/** Token counts as the page says them: 8.6万 / 86K. */
const tokensText = n => new Intl.NumberFormat(document.documentElement.lang || undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)

/** What a reply's turn held in the model's context, thinking left out (server/context.mjs contextUsed). */
function contextUsed(usage) {
  if (!usage) return 0
  const write = Number(usage.cacheWrite) || (Number(usage.cacheWrite5m) || 0) + (Number(usage.cacheWrite1h) || 0)
  const prompt = usage.prompt != null ? Number(usage.prompt) || 0 : (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + write
  return prompt + Math.max(0, (Number(usage.output) || 0) - (Number(usage.thinking) || 0))
}

const windowSource = () => ({ set: t`你填的`, learned: t`供应商给的`, table: t`按官方文档`, guess: t`不认识这个模型，按 12.8 万估计` })

/** Why 压缩 is greyed out (chats.mjs compactBlock). */
const compactBlockText = () => ({
  none: t`还没有剧情可以压缩：聊满 2 轮之后才能压缩`,
  start: t`这段对话还不到 2 轮，不用压缩`,
  recent: t`上次压缩之后还不到 2 轮新剧情，不用压缩`,
  folded: t`回滚后这里只剩不到 2 轮：先点对话底部的「恢复」放回后面的回合，再压缩`,
  session: t`回滚收起的回合还在后面：先点「恢复」，或从这里接着写一轮再压缩`,
})

/** The 压缩 pill's meter: the last turn's context against the chat model's window and threshold (/api/models). */
function contextMeter(chat) {
  const tip = chat.path.at(-1)
  const info = ui.models.find(m => m.id === (chat.model || ui.defaultModel))?.context
  if (!info || tip?.role !== 'assistant') return null
  if (tip.compaction) return { text: t`已压缩`, near: false, title: t`下一轮从剧情存档和最近两轮原文开始。` }
  const auto = ui.settings?.compaction?.auto !== false
  const limits = t`这个模型上限 ${tokensText(info.window)}（${windowSource()[info.source] ?? ''}），用到 ${tokensText(info.threshold)} 时${auto ? t`自动压缩` : t`提醒压缩`}。`
  // Nothing sent yet: the first turn's count comes with its reply.
  if (tip.id === 'root') return { text: `0/${tokensText(info.window)}`, near: false, title: t`还没有发过：第一轮之后显示实际用了多少（开头就会带上角色卡、预设和常驻世界书）。${limits}` }
  const used = contextUsed(tip.usage)
  // The fixed prefix (card, constant worldbook entries, preset) stays through compaction: when it is half the
  // threshold or more, compacting cannot bring the chat down for long, and the meter says why.
  const prefix = chat.systemPromptTokens ?? 0
  const heavy = prefix >= info.threshold * 0.5
  const fixed = prefix ? t`其中固定前缀（角色卡、常驻世界书、预设）约 ${tokensText(prefix)}，压缩压不掉它。` : ''
  const advice = heavy ? t`这张卡的固定前缀很大，压缩后也会很快再满：可以把大段的常驻世界书条目改成按关键词触发，或者在「上下文压缩」里把百分比调高。` : ''
  // A reply with no count (imported from SillyTavern): the window only.
  if (!used) return { text: `—/${tokensText(info.window)}`, near: false, heavy, title: [t`这条回复没有用量记录，发下一轮之后显示。${limits}`, fixed, advice].filter(Boolean).join('\n') }
  return {
    text: `${tokensText(used)}/${tokensText(info.window)}`,
    near: used >= info.threshold,
    heavy,
    title: [t`上下文已用 ${tokensText(used)} token（上一轮实际计算的，不算思考），${limits}`, fixed, advice].filter(Boolean).join('\n'),
  }
}

// Chats already told their fixed prefix is most of the threshold: once each in this page.
const toldHeavy = new Set()

// Reminders already given (自动压缩 off): once per chat and reply.
const reminded = new Set()

/** 自动压缩 off: past the threshold, say so once, with the button. */
function remindCompaction(chat) {
  if (ui.settings?.compaction?.auto !== false || !chat.compactable) return
  const meter = contextMeter(chat)
  const key = `${chat.id}/${chat.path.at(-1)?.id}`
  if (!meter?.near || reminded.has(key)) return
  reminded.add(key)
  toast(t`上下文快满了（${meter.text}），建议压缩成剧情存档再接着写。`, 15000, { action: { text: t`压缩`, run: () => compactNow() } })
}

/** 压缩后重试: the turn was too long for the model; its words are back in the input box. */
const compactThenSend = guard(async chatId => {
  if (ui.chat?.id !== chatId || ui.generating) return
  if ((await runCompaction()) && $('input').value.trim()) await send()
})

/**
 * Ask the model that wrote the story for an archive (or `options.model`, or none: keepRecent).
 * A story read in parts shows which part it is at. A failure offers the ways on (compactFallback).
 * → the chat compacted (its view), or false.
 */
async function runCompaction(options = {}) {
  const chatId = ui.chat.id
  const title = ui.chat.title
  ui.busy.set(chatId, { kind: 'compact' })
  renderChat()
  renderChats()
  toast(options.keepRecent ? t`正在保留最近两轮……` : t`正在写剧情存档，长对话大约要半分钟到一分钟……`, 180000)
  let shown = 1
  const progress = setInterval(async () => {
    const { parts } = await api(`/api/chats/${chatId}/compact`).catch(() => ({ parts: 0 }))
    if (parts > shown && ui.busy.get(chatId)?.kind === 'compact') {
      shown = parts
      toast(t`正在写剧情存档：故事太长，分段读，第 ${parts} 段……`, 180000)
    }
  }, 2500)
  try {
    const view = await api(`/api/chats/${chatId}/compact`, { method: 'POST', body: options })
    ui.busy.delete(chatId)
    const info = view.path.at(-1).compaction
    const done = info.kept
      ? t`已压缩：只保留了最近两轮原文${info.chars > 200 ? t`和之前的存档` : ''}。可以在「查看 / 修改」里补写要记住的内容。`
      : t`已压缩：前 ${info.turns} 轮 → ${fmt(info.chars)} 字剧情存档。下一轮在新的上下文里接着写。`
    if (ui.chat?.id === chatId) {
      setChat(view)
      toast(done, 7000)
    } else {
      toast(t`「${title}」${done}`, 7000)
    }
    return view
  } catch (error) {
    if (error.status === 499) toast(t`已停止压缩，什么都没改`, 6000)
    // Refused for a reason it names (too few turns, a rollback): nothing else to try.
    else if (error.status === 400 || error.status === 409 || ui.chat?.id !== chatId) toast(error.message, 9000)
    else {
      ui.busy.delete(chatId)
      return compactFallback(error, options)
    }
    return false
  } finally {
    clearInterval(progress)
    ui.busy.delete(chatId)
    if (ui.chat?.id === chatId) renderChat()
    renderChats()
  }
}

/**
 * A compaction that failed: try again, have another model write it (longer windows first),
 * or keep only the last turns. However long the story, there is always a way on.
 */
async function compactFallback(error, tried) {
  const dialog = $('compact-fail-dialog')
  const models = ui.models
    .filter(m => !m.subscription && m.context)
    .sort((a, b) => b.context.window - a.context.window)
  // The one that just failed is not the first offered.
  const failed = tried.model || ui.chat.path.at(-1).model
  const offered = models.find(m => m.id !== failed)?.id
  $('compact-fail-text').textContent = error.message
  $('compact-fail-model').replaceChildren(
    ...models.map(m => el('option', { value: m.id, text: t`${m.group} · ${m.label}（${tokensText(m.context.window)}）`, selected: m.id === offered })),
  )
  $('compact-fail-other').hidden = !models.length
  // The 正在写剧情存档 note would stay up behind the window.
  hideToast()
  dialog.showModal()
  const choice = await new Promise(resolve => {
    const onClick = event => {
      const button = event.target.closest('button[value]')
      if (button) done(button.value)
    }
    const onClose = () => done('cancel')
    function done(value) {
      dialog.removeEventListener('click', onClick)
      dialog.removeEventListener('close', onClose)
      if (dialog.open) dialog.close()
      resolve(value)
    }
    dialog.addEventListener('click', onClick)
    dialog.addEventListener('close', onClose)
  })
  if (choice === 'retry') return runCompaction(tried)
  if (choice === 'model') return runCompaction({ model: $('compact-fail-model').value })
  if (choice === 'keep') return runCompaction({ keepRecent: true })
  return false
}

/**
 * 压缩: the model that wrote the last turn writes the archive (its cache read), unless another
 * is picked in the window (any provider's model; the server falls back the same way, compactionTarget).
 */
const compactNow = guard(async () => {
  if (!ui.chat.compactable) {
    toast(compactBlockText()[ui.chat.compactBlock] ?? t`上次压缩之后还不到 2 轮新剧情，不用压缩`, 5000)
    return
  }
  const own = ui.chat.path.at(-1).model || ''
  const select = $('compact-model')
  const others = ui.models.filter(m => !m.subscription && m.id !== own)
  const withWindow = m => (m.context ? t`${m.group} · ${m.label}（${tokensText(m.context.window)}）` : `${m.group} · ${m.label}`)
  select.replaceChildren(
    el('option', { value: '', text: own ? t`${labelOf(own)}（写最后一轮的模型，能读缓存）` : t`写这段剧情的模型（默认）` }),
    ...others.map(m => el('option', { value: m.id, text: withWindow(m) })),
  )
  const note = () => {
    $('compact-model-note').textContent = select.value
      ? t`换了模型读不了这段剧情的缓存，这一次会比平时的一轮贵一些。`
      : t`会调用一次模型写存档，大约花一轮的额度。`
  }
  select.onchange = note
  note()
  const dialog = $('compact-dialog')
  dialog.showModal()
  const choice = await new Promise(resolve => {
    const onClick = event => {
      const button = event.target.closest('button[value]')
      if (button) done(button.value)
    }
    const onClose = () => done('cancel')
    function done(value) {
      dialog.removeEventListener('click', onClick)
      dialog.removeEventListener('close', onClose)
      if (dialog.open) dialog.close()
      resolve(value)
    }
    dialog.addEventListener('click', onClick)
    dialog.addEventListener('close', onClose)
  })
  if (choice === 'compact') await runCompaction(select.value ? { model: select.value } : {})
})

function openRecap(node) {
  const info = node.compaction
  ui.recapNode = node.id
  $('recap-text').value = info.summary
  $('recap-text').readOnly = !info.editable
  $('recap-save').hidden = !info.editable
  $('recap-drop').hidden = !info.editable || Boolean(info.imported)
  const source = info.imported
    ? t`从「${info.imported.title || info.imported.card || t`剧情存档`}」导入，${info.model ? t`${labelOf(info.model)} 写的，` : ''}`
    : t`${labelOf(info.model)} 写的，`
  $('recap-meta').textContent =
    t`${source}覆盖前 ${info.turns} 轮，${fmt(info.chars)} 字。` +
    (info.editable ? t`还没接着写，可以直接修改，下一轮会带上改过的版本。` : t`之后已经接着写了，这份存档只能查看；想换一份，可以回滚到这里再压缩。`)
  $('recap-dialog').showModal()
}

const saveRecap = guard(async () => {
  setChat(await api(`/api/chats/${ui.chat.id}/compaction`, { method: 'PUT', body: { nodeId: ui.recapNode, summary: $('recap-text').value } }))
  $('recap-dialog').close()
  toast(t`存档已保存`)
})

const dropRecap = guard(async () => {
  if (!confirm(t`撤销这次压缩？下一轮会照常接着原来的上下文写。`)) return
  setChat(await api(`/api/chats/${ui.chat.id}/compaction?nodeId=${encodeURIComponent(ui.recapNode)}`, { method: 'DELETE' }))
  $('recap-dialog').close()
  toast(t`已撤销压缩`)
})

// ─── Story archive: export / import (server/chats.mjs exportStory) ──────

const STORY_FORMAT = 'agent-tavern-story'

// The phone app's bridge (android MainActivity.Bridge). The WebView puts it in every frame, card frames too, so each
// call carries this launch's key: a cookie the app sets, which an opaque-origin card frame cannot read.
const android = (() => {
  const native = window.AgentTavernAndroid
  const key = /(?:^|;\s*)cicatavern_bridge=(\w+)/.exec(document.cookie)?.[1]
  return native && key
    ? {
        saveFile: (name, text) => native.saveFile(key, name, text),
        installUpdate: (url, sha256) => native.installUpdate(key, url, sha256),
        cancelUpdate: () => native.cancelUpdate(key),
        updateState: () => native.updateState(key),
      }
    : null
})()

/** Save a JSON file, then toast `message` (one toast, so the Android note is not overwritten). */
function saveFile(name, text, message = '') {
  const filename = name.replace(/[\\/:*?"<>|]+/g, ' ').trim()
  // The Android WebView ignores <a download>; the app saves to Downloads itself.
  if (android) {
    const ok = android.saveFile(filename, text)
    toast(ok ? t`已保存到「下载」文件夹。${message}` : t`保存失败`, 9000)
    return
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = el('a', { href: url, download: filename })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
  // CicaTavern.app (launcher/mac) asks where to save in its own panel and says afterwards how it went:
  // nothing is said to be saved before it is, and nothing when the panel was cancelled.
  if (window.cicatavernNative?.saves) {
    addEventListener('cicatavern-save', event => {
      if (event.detail?.state === 'saved') toast(message || t`已保存`, 9000)
      else if (event.detail?.state === 'failed') toast(t`保存失败`, 9000)
    }, { once: true })
    return
  }
  if (message) toast(message, 9000)
}

async function downloadStory(nodeId, chatId = ui.chat.id) {
  const archive = await api(`/api/chats/${chatId}/archive?nodeId=${encodeURIComponent(nodeId)}`)
  saveFile(t`${archive.title} 剧情存档.json`, JSON.stringify(archive, null, 2),
    t`已导出：前 ${archive.turns} 轮的剧情存档、最近 ${archive.recent.filter(m => m.role === 'user').length} 轮原文和变量。在角色卡下点「导入存档」就能接着写。`)
}

/**
 * Export from the latest reply. The summary must cover the story: with two or
 * more turns since the last compaction, compact first (one model call).
 */
const exportStory = guard(async node => {
  const chat = ui.chat
  if (!node.compaction && chat.compactable) {
    const ask =
      t`导出前要先把剧情压缩成存档（上次压缩后新增 ${chat.compactable} 轮）。\n\n` +
      t`会调用一次模型写存档（${labelOf(node.model || chat.model || ui.defaultModel)}，大约花一轮的额度），之后的对话也会接着这份存档写。继续？`
    if (!confirm(ask)) return
    // From the chat compacted, whichever is open by then.
    const compacted = await runCompaction()
    if (!compacted) return
    return downloadStory(compacted.path.at(-1).id, chat.id)
  }
  const index = chat.path.findIndex(n => n.id === node.id)
  if (!chat.path.slice(0, index + 1).some(n => n.compaction)) throw new Error(t`剧情还不到 2 轮，先多写几轮再导出`)
  await downloadStory(node.id)
})

const exportRecap = guard(async () => {
  await downloadStory(ui.recapNode)
})

/** Start a chat for the selected card from an archive. Returns a line for the import toast. */
async function importStory(archive) {
  if (!ui.cardId) throw new Error(t`先在左边选一张角色卡，存档会导入成它的新对话`)
  const card = ui.cards.find(c => c.id === ui.cardId)
  if (archive.card && card && archive.card !== card.name && !confirm(t`这份存档来自「${archive.card}」，要导入到「${card.name}」下接着写吗？`)) {
    return null
  }
  const chat = await api('/api/chats/import', { method: 'POST', body: { cardId: ui.cardId, archive } })
  await refreshChats()
  setChat(chat)
  return t`剧情存档「${archive.title || archive.card}」（${archive.turns} 轮）`
}

const PACKAGE_MAGIC = 'AGENT-TAVERN-CHAT 1\n'

/**
 * A whole chat from another device (server/transfer.mjs): the header creates the
 * chat under the card of the same name, then each picture is uploaded on its own.
 */
async function importPackageFile(file) {
  const head = await file.slice(0, 64).text()
  if (!head.startsWith(PACKAGE_MAGIC)) throw new Error(t`「${file.name}」不是酒馆的对话包`)
  const line = head.slice(PACKAGE_MAGIC.length, head.indexOf('\n', PACKAGE_MAGIC.length))
  const start = new TextEncoder().encode(`${PACKAGE_MAGIC}${line}\n`).length
  const end = start + Number(line)
  const header = JSON.parse(await file.slice(start, end).text())
  const { media = [], ...rest } = header
  const result = await api('/api/chats/import-package', { method: 'POST', body: { cardId: ui.cardId, header: rest } })
  let failed = 0
  for (const [index, picture] of media.entries()) {
    toast(t`「${result.chat.title}」：上传配图 ${index + 1}/${media.length}`, 2000)
    const res = await fetch(`/api/chats/${result.chat.id}/media/${picture.file}`, {
      method: 'PUT',
      headers: { 'x-agent-tavern': '1', 'content-type': 'application/octet-stream' },
      body: file.slice(end + picture.offset, end + picture.offset + picture.length),
    }).catch(() => null)
    if (!res?.ok) failed++
  }
  return { ...result, pictures: media.length, failed }
}

async function importPackages(files) {
  const done = []
  for (const file of files) {
    try {
      done.push(await importPackageFile(file))
    } catch (error) {
      toast(error.message, 8000)
    }
  }
  if (!done.length) return
  const last = done.at(-1)
  if (ui.cardId !== last.cardId) await selectCard(last.cardId)
  await refreshChats()
  openChat(last.chat.id)
  const notes = done.map(d => t`「${d.chat.title}」→ ${d.cardName}${d.pictures ? t`，配图 ${d.pictures - d.failed}/${d.pictures}` : ''}${d.missingPreset ? t`，没有预设「${d.missingPreset}」，先导入它再到预设里选上` : ''}`)
  toast(t`已导入 ${done.length} 段对话：${notes.join(t`；`)}`, 10000)
}

// Past this many characters an imported chat is worth compacting before it continues.
const LONG_IMPORT = 60000

/** A card name without its version (顾念念-武当抽奖系统-v1.6 → 顾念念-武当抽奖系统). */
const unversioned = name => String(name ?? '').trim().replace(/[\s_-]*v?\d+(?:\.\d+)*$/i, '').trim()

/**
 * A SillyTavern chat file (.jsonl) as a new chat under the selected card: every
 * turn comes in; a long one is offered a compaction before it continues, and a
 * last line with no reply goes back into the input box.
 */
const importSillyTavernFile = guard(async file => {
  if (!ui.cardId) throw new Error(t`先在左边选一张角色卡，对话会导入到它下面`)
  const text = await file.text()
  // Who the chat was with: the header's name, or (newer SillyTavern writes "unused" there) the first reply's.
  const head = text.split('\n', 8).map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  let character = String(head[0]?.character_name ?? '')
  if (!character || character === 'unused') character = String(head.find(row => typeof row?.mes === 'string' && !row.is_user && !row.is_system)?.name ?? '')
  const card = ui.cards.find(c => c.id === ui.cardId)
  if (character && card && unversioned(character) !== unversioned(card.name) && !confirm(t`这段对话是和「${character}」的，要导入到「${card.name}」下吗？`)) return
  toast(t`正在导入「${file.name}」……`, 60000)
  const view = await api('/api/chats/import-sillytavern', { method: 'POST', body: { cardId: ui.cardId, filename: file.name, text } })
  await refreshChats()
  setChat(view)
  const { turns, chars, pendingInput } = view.imported
  if (pendingInput) fillInput(pendingInput)
  toast(t`已导入「${file.name}」：${turns} 轮、${fmt(chars)} 字${pendingInput ? t`；最后一句还没有回复，放回了输入框` : ''}。`, 7000)
  if (chars > LONG_IMPORT && view.compactable) {
    const ask =
      t`这段对话有 ${turns} 轮、约 ${fmt(chars)} 字。接着写时，每一轮都会把它整个发给模型，又慢又费额度。\n\n` +
      t`先压缩成剧情存档吗？会用 ${labelOf(ui.chat.model || ui.defaultModel)} 把全文读一遍（太长的分几段读），之后每轮只发存档和最近两轮。原文都留着，随时可以往上翻看。`
    if (confirm(ask)) await runCompaction()
  }
})

const importStoryFile = guard(async file => {
  const json = await jsonOf(file)
  if (json?.format !== STORY_FORMAT) throw new Error(t`这不是酒馆导出的剧情存档`)
  const line = await importStory(json)
  toast(line === null ? t`存档没有导入` : t`已导入${line}。下一轮在新的上下文里接着写。`, 6000)
})

function tipId() {
  const path = ui.chat.path
  const last = path.at(-1)
  return last.role === 'assistant' ? last.id : last.parent
}

/**
 * Shared streaming flow for a new turn or a regeneration. The stream belongs
 * to its chat, not to the screen: switching away keeps it running, switching
 * back redraws what has arrived (liveNodes).
 * @returns true when the turn was saved.
 */
async function generate(endpoint, body, echoUserText) {
  const chatId = ui.chat.id
  const title = ui.chat.title
  const tipBefore = ui.chat.path.at(-1)?.id
  const job = { kind: 'turn', text: '', note: '…', echo: echoUserText }
  ui.busy.set(chatId, job)
  renderChat()
  renderChats()
  const box = $('transcript')
  // The freshly drawn turn animates in once; later redraws do not.
  box.querySelectorAll('.msg.streaming, .msg[data-id="pending-user"]').forEach(node => node.classList.add('enter'))
  const viewing = () => ui.chat?.id === chatId
  const live = () => (viewing() ? box.querySelector('.msg.streaming') : null)
  let finished = null
  let finishedNode = null
  let failure = null
  // The connection went before the turn's end was heard (a phone's screen locked): the server writes on.
  let dropped = false
  try {
    await stream(`/api/chats/${chatId}/${endpoint}`, body, event => {
      if (event.type === 'start') {
        job.note = event.newSession ? t`接着存档续写` : event.api ? t`${event.api} 续写` : event.fork ? t`分支续写` : t`续写`
        const note = live()?.querySelector('.live-note')
        if (note) note.textContent = job.note
        if (event.compacted?.removedChars && viewing()) toast(t`已清掉历史里堆积的变量列表（${fmt(event.compacted.removedChars)} 字）。这一轮会重写对话历史的缓存，固定前缀还在。`)
      } else if (event.type === 'delta' || event.type === 'restart') {
        // restart: the relay lost the system prompt (the card), and the answer is being asked for again.
        job.text = event.type === 'restart' ? '' : job.text + event.text
        if (viewing()) vnUi.streamed()
        const target = live()?.querySelector('.msg-body')
        if (target) {
          target.innerHTML = renderStory(streamingText(job.text), { partial: true })
          const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160
          if (nearBottom) box.scrollTop = box.scrollHeight
        }
      } else if (event.type === 'rate_limit') {
        ui.rateLimit = event.info
        renderQuota(event.info)
      } else if (event.type === 'compacting') {
        // 自动压缩 before the turn (engine.compactBeforeTurn).
        job.note = t`上下文快满了，先压缩成剧情存档……`
        const note = live()?.querySelector('.live-note')
        if (note) note.textContent = job.note
      } else if (event.type === 'compacted') {
        if (viewing()) toast(t`上下文到了阈值，已自动压缩：前 ${event.turns} 轮 → ${fmt(event.chars)} 字剧情存档，这一轮从存档接着写。`, 7000)
      } else if (event.type === 'compact_failed') {
        if (viewing()) toast(t`自动压缩没成功，这一轮照常发出：${event.message}`, 9000, { log: true })
      } else if (event.type === 'done') {
        finished = event.chat
        finishedNode = event.nodeId
      } else if (event.type === 'error') {
        failure = event
      }
    })
  } catch (error) {
    failure = { message: error.message }
    dropped = !error.status
  }
  if (!finished && !failure) dropped = true
  ui.busy.delete(chatId)
  if (dropped) {
    // What the server has: still writing, or written already. Followed from here, so sending again is not a second turn.
    const fresh = await api(`/api/chats/${chatId}`).catch(() => null)
    if (fresh && (fresh.running || fresh.path.at(-1)?.id !== tipBefore)) {
      followServerTurn(fresh)
      if (viewing()) setChat(fresh)
      else renderChats()
      if (fresh.running) toast(viewing() ? t`连接断开了：这一轮还在后台写，写完会显示出来` : t`「${title}」：连接断开了，这一轮还在后台写`, 6000)
      return true
    }
  }
  if (finished) {
    if (viewing()) {
      setChat(finished)
      mediaUi.afterTurn(finishedNode, vnUi.turnFlags(finished.cardId))
      remindCompaction(finished)
    } else {
      toast(t`「${title}」这一轮写好了`, 5000)
    }
    await refreshChats()
    return true
  }
  if (viewing()) renderChat()
  renderChats()
  if (failure && failure.status !== 499) {
    // Too long for the model: compact, and send the same words again (they wait in the input box).
    const retry = failure.contextFull && endpoint === 'turn' && viewing() && ui.chat.compactable
      ? { text: t`压缩后重试`, run: () => compactThenSend(chatId) }
      : null
    toast(viewing() ? failure.message : t`「${title}」：${failure.message}`, retry ? 15000 : 8000, { log: !retry, action: retry })
  }
  return false
}

const send = guard(async () => {
  const input = $('input')
  const text = input.value.trim()
  if (!text || !ui.chat || ui.generating) return
  const parentId = ui.branchFrom?.parentId ?? tipId()
  input.value = ''
  fitInput()
  const chatId = ui.chat.id
  const ok = await generate('turn', { parentId, input: text, marks: vnUi.marks(ui.chat) }, text)
  // Keep the draft so nothing is lost, unless you have moved on to another chat or typed anew.
  if (!ok && ui.chat?.id === chatId && !input.value.trim()) { input.value = text; fitInput() }
})

const regenerate = guard(async userNodeId => {
  if (ui.generating) return
  await generate('regenerate', { userNodeId }, null)
})

const stop = guard(async () => {
  if (ui.chat) await api(`/api/chats/${ui.chat.id}/stop`, { method: 'POST', body: {} })
})

// ─── Right pane ─────────────────────────────────────────────────────────
function renderSide() {
  const chat = ui.chat
  const state = chat?.state ?? {}
  $('state-view').textContent = chat ? (Object.keys(state).length ? JSON.stringify(state, null, 2) : t`（这张卡没有状态变量）`) : '—'
  $('state-editor').hidden = true
  $('state-view').hidden = false
  const last = chat ? [...chat.path].reverse().find(n => n.role === 'assistant' && n.usage) : null
  const dl = $('usage')
  if (!last) {
    dl.replaceChildren(el('dt', { text: '—' }))
    return
  }
  const u = last.usage
  const prompt = u.input + u.cacheRead + u.cacheWrite
  const hit = prompt ? Math.round((u.cacheRead / prompt) * 100) : 0
  const rows = [
    [t`缓存命中`, el('span', { class: `hit ${hit >= 80 ? 'good' : 'mid'}`, text: `${hit}%` })],
    [t`缓存读取`, fmt(u.cacheRead)],
    [t`缓存写入`, fmt(u.cacheWrite)],
    [t`未缓存输入`, fmt(u.input)],
    [t`输出`, fmt(u.output)],
    [t`首字`, last.timing?.firstTokenMs ? t`${(last.timing.firstTokenMs / 1000).toFixed(1)} 秒` : '—'],
    [t`总耗时`, last.timing ? t`${(last.timing.totalMs / 1000).toFixed(1)} 秒` : '—'],
    [t`方式`, last.timing?.api ? t`API（按对话记录重发）` : last.timing?.forked ? t`分支（fork）` : t`续接（resume）`],
    [t`模型`, last.model ? labelOf(last.model) : '—'],
  ]
  // A relay that moves the same model to another upstream answers with another name, and that
  // upstream has none of the cache: say so, or a cache miss looks like the tavern's fault.
  if (last.served) {
    const provider = ref => String(ref ?? '').split('/')[0]
    const before = chat.path.slice(0, chat.path.indexOf(last)).reverse().find(n => n.role === 'assistant' && n.served && provider(n.model) === provider(last.model))
    const switched = before && before.served !== last.served
    rows.push([t`返回的模型`, el('span', { class: switched ? 'hit mid' : '', text: last.served })])
    if (switched && hit < 80) {
      rows.push([t`提示`, t`供应商这轮换了上游（${before.served} → ${last.served}），缓存在新上游上没有，这不是酒馆的历史变了。中转一直这样的话，可以在供应商设置里换一个分组 / 线路，或问问中转方。`])
    }
  }
  dl.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, typeof v === 'string' ? document.createTextNode(v) : v)]))
}

/** The subscription's quota line in the top bar (hidden without one). */
function renderQuota(info) {
  if (subscriptionPage) subscriptionPage.renderQuota($('quota'), info)
  else $('quota').hidden = true
}

function editState() {
  $('state-input').value = JSON.stringify(ui.chat?.state ?? {}, null, 2)
  $('state-view').hidden = true
  $('state-editor').hidden = false
}

const saveState = guard(async () => {
  let state
  try {
    state = JSON.parse($('state-input').value || '{}')
  } catch {
    throw new Error(t`状态不是合法的 JSON`)
  }
  setChat(await api(`/api/chats/${ui.chat.id}/state`, { method: 'PUT', body: { state } }))
  toast(t`已保存，下一轮会把完整状态发给模型`)
})

// ─── Settings ───────────────────────────────────────────────────────────
// The providers the settings menu shows (模型供应商's row): kept current when the providers window changes them.
const settingsProviders = []

const openSettings = guard(async () => {
  settingsMenu ??= createMenu({ dialog: $('settings-dialog'), form: $('settings-form'), el, title: t`设置` })
  await loadPersonas()
  ;[ui.settings, ui.personas, ui.styles, ui.books] = await Promise.all([api('/api/settings'), personas && api('/api/personas'), personas && api('/api/styles'), api('/api/worldbooks')])
  ui.persona = personas ? personas.defaultOf(ui.personas) : await api('/api/persona').catch(() => null)
  if (!ui.models.length) await loadModels()
  const form = $('settings-form')
  $('settings-model').replaceChildren(...modelOptions(ui.defaultModel))
  for (const key of ['model', 'thinking', 'effort', 'language', 'scanDepth', 'reinjectAfter', 'stateRefreshEvery', 'dynamicStrip', 'replyLength', 'listen']) {
    form[key].value = ui.settings[key] ?? (key === 'listen' ? 'local' : '')
  }
  showDefaultAsHint(form.language, zh`简体中文`, t`简体中文`)
  fillCompaction(form)
  renderAccess(await api('/api/access').catch(() => null))
  fillProxy(form, ui.settings.proxy, await api('/api/network').catch(() => null))
  form.webFonts.checked = ui.settings.webFonts !== false
  form.cdnLibraries.checked = ui.settings.cdnLibraries !== false
  fillInterfaceLanguage(form)
  $('privacy-list').replaceChildren(connectionList(el, { updates: Boolean(ui.features?.updates) }))
  if (!ui.models.some(m => m.id === form.model.value)) form.model.value = ui.defaultModel ?? ui.models[0]?.id ?? ''
  const card = ui.cards.find(c => c.id === ui.cardId)
  renderBookOptions(card)
  renderCardPicks(card)
  const [providers, presets] = await Promise.all([api('/api/providers').catch(() => null), api('/api/presets').catch(() => []), updateUi.load()])
  settingsMenu.start()
  settingsProviders.splice(0, Infinity, ...(providers?.providers ?? []))
  layOutSettings({ form, card, providers: settingsProviders, presets })
  $('settings-dialog').showModal()
})

/**
 * 设置 → 挂载的世界书: the card's own book, then a checkable row per imported
 * book; each opens its entries (web/books.js). `ticked` keeps the boxes as the
 * page had them when it is drawn again after an edit there.
 */
function renderBookOptions(card, ticked = new Set(card?.worldbookIds ?? [])) {
  const options = $('book-options')
  if (!card) return options.replaceChildren(document.createTextNode(t`先选择一张角色卡`))
  options.replaceChildren(
    cardBookLine(card),
    ...(ui.books.length
      ? ui.books.map(book =>
        el('label', { class: book.global ? 'global' : '' }, [
          // A global book applies to every card: ticked and fixed here. Whether this card
          // has it mounted as well is kept (the hidden box), for when it stops being global.
          book.global
            ? el('input', { type: 'checkbox', checked: true, disabled: true, 'aria-label': t`${book.name}（全局）` })
            : el('input', { type: 'checkbox', name: 'book', value: book.id, checked: ticked.has(book.id), 'aria-label': book.name }),
          book.global ? el('input', { type: 'checkbox', name: 'book', value: book.id, checked: ticked.has(book.id), hidden: true }) : null,
          el('span', { class: 'book-text' }, [
            el('span', { class: 'book-name', text: book.name }),
            el('span', { class: 'book-count', text: bookCount({ entries: book.entries, enabled: book.enabled, constant: book.constant }) }),
          ]),
          book.global ? el('span', { class: 'card-book-on', title: t`全局世界书：每张卡的对话都用。在世界书窗口这本的「书的设置」里关掉。`, text: t`全局` }) : null,
          bookEntriesButton(book.id),
        ]))
      : [el('p', { class: 'book-none', text: t`还没有导入独立世界书。想给这张卡多挂一本，先用「导入角色卡、世界书或预设」导入世界书 JSON。` })]),
  )
}

// 你的角色 / 文风 (web/personas.js), loaded with 设置: a server started before those files existed answers 404
// for them until it restarts. 设置 still opens then, and those rows say so.
let personas = null
let personasUi = null
const personasMissing = () => Object.assign(new Error(t`你的角色和文风要重启后台服务后才能用：关掉所有窗口等一分钟，再从桌面图标打开。`), { status: 404 })

/** The module and its window, once; null on a server that does not have them yet. */
async function loadPersonas() {
  personas ??= await import('/personas.js').catch(() => null)
  personasUi ??= personas?.initPersonas({
    api, el, toast, guard, saveFile,
    getChat: () => ui.chat,
    getCardId: () => ui.chat?.cardId ?? ui.cardId,
    getCards: () => ui.cards,
    isGenerating: () => ui.generating,
    onChatChanged: chat => setChat(chat),
    onListChanged: personasChanged,
  }) ?? null
  return personasUi
}

const openPersonas = guard(async kind => {
  if (!(await loadPersonas())) throw personasMissing()
  await personasUi.open(kind)
})

/**
 * A list saved in the 你的角色 / 文风 window: 设置 → 写作 shows it as it is now, its rows and the card's choices.
 * A choice made there and not saved yet stays; otherwise a box shows what the card picks now (a tick in that
 * window included).
 */
function personasChanged(kind, list) {
  const key = kind === 'persona' ? 'personas' : 'styles'
  const before = ui[key]
  ui[key] = list
  if (kind === 'persona') ui.persona = personas.defaultOf(list)
  if (!$('settings-dialog').open) return
  const form = $('settings-form')
  const unsaved = {}
  for (const [name, of, was] of [['pickPersona', 'persona', ui.personas], ['pickStyle', 'style', ui.styles]]) {
    const saved = of === kind ? before : was
    if (form[name] && saved && form[name].value !== (personas.cardPick(saved, ui.cardId)?.id ?? '')) unsaved[name] = form[name].value
  }
  renderCardPicks(ui.cards.find(c => c.id === ui.cardId))
  for (const [name, value] of Object.entries(unsaved)) {
    if ([...form[name].options].some(option => option.value === value)) form[name].value = value
  }
  settingsMenu?.refresh()
}

/** The name of a 你的角色 or 文风 item as its list shows it (web/personas.js). */
const pickLabel = (kind, item) => (kind === 'persona' ? personas.personaName(item.name) + (item.title ? ` · ${item.title}` : '') : item.name || t`我的文风`)

/**
 * 设置 → 写作 → 这张卡用的角色和文风: a choice from each list, the default first. Saved with 保存
 * (saveCardPicks); what the card picks now is what the boxes start at.
 */
function renderCardPicks(card) {
  const box = $('card-picks')
  if (!card) return box.replaceChildren(document.createTextNode(t`先选择一张角色卡`))
  if (!ui.personas) return box.replaceChildren(document.createTextNode(personasMissing().message))
  const choice = (kind, name, list, title) => {
    const select = el('select', { name, 'aria-label': title }, [
      el('option', { value: '', text: t`默认（${pickLabel(kind, personas.defaultOf(list))}）` }),
      ...list.items.map(item => el('option', { value: item.id, text: pickLabel(kind, item) })),
    ])
    select.value = personas.cardPick(list, card.id)?.id ?? ''
    return el('label', {}, [title, select])
  }
  box.replaceChildren(
    el('div', { class: 'grid' }, [choice('persona', 'pickPersona', ui.personas, t`你的角色`), choice('style', 'pickStyle', ui.styles, t`文风`)]),
    el('div', { class: 'row card-picks-open' }, [
      el('button', { type: 'button', class: 'btn small ghost', text: t`管理你的角色…`, onclick: () => openPersonas('persona') }),
      el('button', { type: 'button', class: 'btn small ghost', text: t`管理文风…`, onclick: () => openPersonas('style') }),
    ]),
  )
}

/** The picks in 设置 → 写作 saved for the chosen card; the open chat on it may switch too. → whether it did. */
async function saveCardPicks(form) {
  if (!ui.cardId || !form.pickPersona || !ui.personas) return false
  const was = { persona: personas.cardPick(ui.personas, ui.cardId)?.id ?? '', style: personas.cardPick(ui.styles, ui.cardId)?.id ?? '' }
  const now = { persona: form.pickPersona.value, style: form.pickStyle.value }
  const kinds = ['persona', 'style'].filter(kind => was[kind] !== now[kind])
  if (!kinds.length) return false
  const saved = await api(`/api/cards/${ui.cardId}/picks`, { method: 'PUT', body: { personaId: now.persona, styleId: now.style } })
  ui.personas = saved.persona
  ui.styles = saved.style
  return Boolean(await personasUi.offerSwitch(ui.cardId, kinds))
}

/** The card's own book, which always applies, so it is a line and not a checkbox. */
function cardBookLine(card) {
  if (!card.bookEntries) return el('div', { class: 'card-book none', text: t`这张卡没有自带世界书` })
  return el('div', { class: 'card-book' }, [
    el('span', { text: t`卡里自带：${bookCount({ entries: card.bookEntries, enabled: card.bookEnabled, constant: card.bookConstant })}` }),
    el('span', { class: 'card-book-on', text: t`始终生效` }),
    bookEntriesButton(`card-${card.id}`),
  ])
}

/** "42 条（启用 41，其中常驻 24）"; just the total from a server that does not count the rest yet. */
function bookCount(counts) {
  return counts.enabled == null ? t`${counts.entries} 条` : countText(counts)
}

// Inside a row's label: a button there does not tick the box.
function bookEntriesButton(id) {
  return el('button', { type: 'button', class: 'btn small ghost book-open', text: t`查看条目`, onclick: () => openBookEntries(id) })
}

const tickedBooks = () => [...$('book-options').querySelectorAll('input[name="book"]:checked')].map(input => input.value)

/** The 世界书 window on every imported book (the card list's 世界书, 设置 → 管理世界书). */
const openBookManager = guard(async () => {
  ui.books = await api('/api/worldbooks')
  await booksUi.open({ books: ui.books })
})

function openBookEntries(id) {
  booksUi.open({ card: ui.cards.find(c => c.id === ui.cardId), books: ui.books, mounted: tickedBooks(), select: id })
}

// The settings window as a menu (web/menu.js). Its pages are in index.html;
// they are taken out of the form once, then placed by every layout.
let settingsMenu = null
let settingsPages = null

/** 你的角色 / 文风 in the settings menu: the default, how many, and how many cards picked one. */
function listSummary(kind, list) {
  if (!list) return t`重启后台服务后才能用`
  const picked = Object.keys(list.cards).length
  return [t`默认：${pickLabel(kind, personas.defaultOf(list))}`, t`共 ${list.items.length} 个`, picked ? t`${picked} 张卡指定了` : t`可以给每张卡指定`].join(' · ')
}

/**
 * 上下文压缩 in the settings: the saved numbers, and the window of the open chat's model (else the
 * default one): its own number if the player set one, else what /api/models found for it.
 */
function fillCompaction(form) {
  const saved = ui.settings.compaction ?? {}
  form.compactAuto.checked = saved.auto !== false
  form.compactPercent.value = saved.percent ?? 70
  const ref = ui.chat?.model || ui.defaultModel || ''
  const choice = ui.models.find(m => m.id === ref)
  form.compactWindow.dataset.ref = ref
  form.compactWindow.value = saved.windows?.[ref] ?? ''
  form.compactWindow.placeholder = choice?.context ? String(choice.context.window) : ''
  $('compact-window-hint').textContent = choice?.context
    ? t`${labelOf(ref)}：上下文 ${tokensText(choice.context.window)} token（${windowSource()[choice.context.source] ?? ''}），用到 ${tokensText(choice.context.threshold)} 时压缩。上下文越长，每轮发送的越多、花得越多；想省一点就把百分比调低。` +
      (choice.context.source === 'guess' ? t`知道它的上下文的话，填在「当前模型的上下文」里。` : '') +
      // What compaction cannot shrink, for the chat open now.
      (ui.chat?.systemPromptTokens ? t`这个对话的固定前缀（角色卡、常驻世界书、预设）约 ${tokensText(ui.chat.systemPromptTokens)}，压缩压不掉它。` : '')
    : t`还没选模型`
}

/** settings.compaction from the form; the window typed for the chat's model goes with the others kept. */
function compactionOf(form, num) {
  const ref = form.compactWindow.dataset.ref
  const windows = { ...(ui.settings.compaction?.windows ?? {}) }
  if (ref) windows[ref] = num('compactWindow')
  return { auto: form.compactAuto.checked, percent: num('compactPercent') || 70, windows }
}

/** The menu: 模型, 写作, 世界书与状态, 连接, 更多, each row with what it is set to now. */
function layOutSettings({ form, card, providers, presets }) {
  settingsPages ??= Object.fromEntries([...form.querySelectorAll('[data-section]')].map(page => [page.dataset.section, page]))
  const value = name => form.elements[name]?.value ?? ''
  const modelName = id => {
    const model = ui.models.find(m => m.id === id)
    return model ? `${model.subscription ? '' : `${model.group} · `}${model.label}` : ''
  }
  const STRIP = { rare: t`动态设定少清`, often: t`动态设定勤清`, off: t`动态设定不清` }
  const noChat = () => (ui.chat ? '' : t`先打开一个对话`)
  const sections = [
    {
      id: 'model', title: t`默认模型`, pane: settingsPages.model,
      summary: () => [modelName(value('model')) || t`还没选`, value('thinking') === 'off' ? t`不思考` : t`自适应思考`, t`努力 ${value('effort')}`].join(' · '),
      status: () => (value('model') ? null : ['warn', t`没选模型`]),
    },
    {
      id: 'providers', title: t`模型供应商`, look: 'shared', action: () => providersUi.open(),
      summary: () => (providers.length ? t`${providers.length} 个：${providers.slice(0, 3).map(p => p.name).join(t`、`)}${providers.length > 3 ? '…' : ''}` : t`还没添加：接入 DeepSeek、OpenRouter、Anthropic 等`),
      status: () => (providers.length ? null : ['warn', t`先添加一个`]),
    },
    {
      id: 'persona', title: t`你的角色`, action: () => openPersonas('persona'),
      summary: () => listSummary('persona', ui.personas),
    },
    {
      id: 'styles', title: t`文风`, action: () => openPersonas('style'),
      summary: () => listSummary('style', ui.styles),
    },
    {
      id: 'style', title: t`语言与字数`, pane: settingsPages.style,
      summary: () => [value('language').trim() || t`简体中文`, Number(value('replyLength')) > 0 ? t`每轮约 ${value('replyLength')} 字` : t`字数不限`].join(' · '),
    },
    // Like 挂载的世界书: the row hides without a card, its page stays mounted (#card-picks is filled by id).
    {
      id: 'picks', title: t`这张卡用的角色和文风`, pane: settingsPages.picks, crumb: card ? t`写作 · ${card.name}` : undefined, hidden: () => !card,
      summary: () => {
        if (!card || !form.pickPersona || !ui.personas) return ''
        const named = (kind, list, id) => (id ? pickLabel(kind, personas.itemOf(list, id) ?? personas.defaultOf(list)) : t`默认`)
        return t`角色：${named('persona', ui.personas, value('pickPersona'))} · 文风：${named('style', ui.styles, value('pickStyle'))}`
      },
    },
    {
      id: 'presets', title: t`预设`, look: 'shared', action: () => presetsUi.open(),
      summary: () => {
        const preferred = presets.find(p => p.id === ui.settings?.presetId)
        return presets.length ? t`${presets.length} 个 · 新对话默认：${preferred?.name ?? t`基础预设`}` : t`新对话默认：基础预设 · 也可以导入 SillyTavern 的预设`
      },
    },
    {
      id: 'regex', title: t`正则`, look: 'shared', action: () => regexUi.open(),
      summary: () => [
        ui.globalRegex.length ? t`全局 ${ui.globalRegex.length} 条` : t`导入或新建全局正则`,
        ui.regexSets.length ? t`正则集 ${ui.regexSets.length} 个` : t`可以建正则集挂到指定的卡上`,
        t`卡和预设自带的也在这里开关`,
      ].join(' · '),
    },
    {
      id: 'blockwords', title: t`屏蔽词`, look: 'shared', tag: t`所有对话`, action: () => openBlockWords(),
      summary: () => {
        const on = ui.blockWords.filter(word => !word.disabled)
        if (!ui.blockWords.length) return t`把某些词去掉、遮住或换成别的词：发给模型的和显示出来的都管`
        const count = t`${ui.blockWords.length} 个，开着 ${on.length} 个`
        return on.length ? `${count} · ${on.slice(0, 4).map(word => word.word).join(t`、`)}${on.length > 4 ? '…' : ''}` : count
      },
    },
    {
      id: 'scan', title: t`扫描与状态`, look: 'shared', tag: t`所有对话`, pane: settingsPages.scan,
      summary: () => t`扫描最近 ${value('scanDepth')} 条 · 隔 ${value('reinjectAfter')} 轮再注入 · 每 ${value('stateRefreshEvery')} 轮重发状态 · ${STRIP[value('dynamicStrip')] ?? ''}`,
    },
    {
      id: 'compaction', title: t`上下文压缩`, look: 'shared', tag: t`所有对话`, pane: settingsPages.compaction,
      summary: () => (form.compactAuto.checked ? t`上下文用到 ${value('compactPercent')}% 时自动压缩` : t`上下文用到 ${value('compactPercent')}% 时提醒`),
    },
    // The 世界书 window, as beside the card list's heading: every imported book, whatever card is picked.
    {
      id: 'manage-books', title: t`管理世界书`, look: 'shared', action: () => openBookManager(),
      summary: () => (ui.books.length ? t`导入的 ${ui.books.length} 本：改名、导出、挂到哪些卡上，成批编辑条目` : t`还没导入：在这里导入 SillyTavern 的世界书，或新建一本`),
    },
    // Without a card the row hides but the page stays mounted: a page left out of
    // the layout leaves the document, and openSettings fills #book-options by id.
    {
      id: 'books', title: t`挂载的世界书`, pane: settingsPages.books, crumb: card ? t`世界书与状态 · ${card.name}` : undefined, hidden: () => !card,
      summary: () => {
        if (!card) return ''
        // Counted again after edits in the entries window.
        const entries = (ui.cards.find(c => c.id === card.id) ?? card).bookEntries
        const own = entries ? t`卡里自带 ${entries} 条` : t`卡里没带世界书`
        // The global ones count on their own, mounted or not.
        const globals = ui.books.filter(b => b.global).length
        const names = [...form.querySelectorAll('input[name="book"]:checked')].map(input => ui.books.find(b => b.id === input.value && !b.global)?.name).filter(Boolean)
        const mounted = !ui.books.length ? t`还没导入独立世界书` : names.length ? t`挂了 ${names.length} 本：${names.join(t`、`)}` : t`没挂独立世界书`
        return [own, mounted, globals ? t`全局 ${globals} 本` : ''].filter(Boolean).join(' · ')
      },
    },
    {
      id: 'network', title: t`网络代理`, pane: settingsPages.network, hidden: () => document.documentElement.dataset.featureProxy === 'false',
      summary: () => {
        const mode = value('proxyMode')
        if (mode === 'none') return t`不用代理（国内服务直连）`
        if (mode === 'manual') return t`走 ${value('proxyUrl').trim() || t`（还没填地址）`}`
        return ui.network?.mode === 'system' && ui.network.effective ? t`跟随系统代理：${ui.network.effective}` : t`跟随系统代理`
      },
      status: () => (ui.network?.locked ? ['', t`启动参数指定`] : value('proxyMode') === 'system' && ui.network?.mode === 'system' && !ui.network.effective ? ['warn', t`系统代理没开`] : null),
    },
    {
      id: 'access', title: t`手机访问`, look: 'shared', pane: settingsPages.access, hidden: () => document.documentElement.dataset.featureLan === 'false',
      summary: () => {
        if (value('listen') !== 'lan') return t`仅这台电脑`
        return ui.access?.running === 'lan' ? t`同一 WiFi 或 Tailscale · ${ui.access.links?.length ?? 0} 个链接` : t`同一 WiFi 或 Tailscale（重启服务后生效）`
      },
    },
    {
      id: 'media', title: t`配图与朗读`, action: () => mediaUi.openSettings(),
      summary: () => t`画图方式、朗读来源，每张卡的画风、名册和音色`,
    },
    {
      id: 'dictation', title: t`语音输入`, action: () => mediaUi.openSettings('stt'),
      summary: () => t`点输入框旁的麦克风说话，转成文字填进输入框：录音交给谁转写`,
    },
    {
      id: 'update', title: t`更新`, look: 'shared', pane: settingsPages.update, hidden: () => !updateUi.enabled(),
      summary: () => updateUi.summary(),
      status: () => updateUi.status(),
    },
    {
      id: 'interface', title: t`界面语言`, look: 'shared', pane: settingsPages.interface,
      summary: () => `${form.uiLanguage.selectedOptions[0]?.text ?? ''} · ${OTHER_LANGUAGE_NAME}`,
    },
    {
      id: 'privacy', title: t`隐私与网络`, look: 'shared', pane: settingsPages.privacy,
      summary: () => t`不用配置也会连：${[form.webFonts.checked && t`网络字体`, form.cdnLibraries.checked && t`酒馆助手脚本库`].filter(Boolean).join(t`、`) || t`都关了`}`,
    },
    {
      id: 'errors', title: t`错误日志`, look: 'shared', action: () => openErrorLog(),
      summary: () => t`出了问题时导出来发给开发者：版本、设置概要和最近的出错记录`,
    },
    {
      id: 'shortcut', title: t`桌面快捷方式`, look: 'shared', action: () => makeShortcut(), hidden: () => !ui.launcher,
      summary: () => t`在桌面放一个 CicaTavern 图标，指向这个文件夹里的 CicaTavern.exe`,
    },
    {
      id: 'show-prompt', title: t`查看当前对话的提示词`, look: 'shared',
      action: () => (ui.chat ? showPrompt() : toast(t`先打开一个对话`)),
      summary: () => noChat() || t`固定前缀和最近一轮发出去的内容`,
    },
    {
      id: 'rebuild-prompt', title: t`重建当前对话的前缀`, look: 'shared',
      action: () => (!ui.chat ? toast(t`先打开一个对话`) : ui.generating ? toast(t`正在生成，先停止`) : rebuildPrompt()),
      summary: () => noChat() || t`按现在的卡、设置和预设重写固定前缀，下一轮多写一次缓存`,
    },
    {
      id: 'stop-server', title: t`停止后台服务`, look: 'shared', action: () => stopServer(), hidden: () => document.documentElement.dataset.edition === 'android',
      summary: () => t`电脑和手机上的页面都会断开，下次从桌面图标打开`,
    },
  ].filter(Boolean)
  const cardRow = card
    ? whoLine(el, { cardId: card.hasAvatar ? card.id : '', name: card.name, note: t`这张卡挂的` })
    : el('p', { class: 'menu-who none', text: t`选一张角色卡后，可以给它挂独立世界书。` })
  const cardPicksRow = card
    ? whoLine(el, { cardId: card.hasAvatar ? card.id : '', name: card.name, note: t`这张卡指定的` })
    : el('p', { class: 'menu-who none', text: t`选一张角色卡后，可以给它指定你的角色和文风。` })
  settingsMenu.mount({
    panels: [
      { id: 'model', title: t`模型`, icon: MENU_ICONS.model, rows: ['model', 'providers', 'compaction'] },
      { id: 'write', title: t`写作`, icon: MENU_ICONS.write, rows: ['persona', 'styles', 'style', 'presets', 'regex', 'blockwords', cardPicksRow, 'picks'] },
      { id: 'media', title: t`配图与朗读`, icon: MENU_ICONS.picture, rows: ['media', 'dictation'] },
      { id: 'books', title: t`世界书与状态`, icon: MENU_ICONS.book, rows: ['scan', 'manage-books', cardRow, 'books'] },
      { id: 'link', title: t`连接`, icon: MENU_ICONS.link, rows: ['network', 'access'] },
      { id: 'more', title: t`更多`, icon: MENU_ICONS.tools, rows: ['interface', 'update', 'privacy', 'errors', 'shortcut', 'show-prompt', 'rebuild-prompt', 'stop-server'] },
    ],
    sections,
    note: t`你的角色、文风和写作语言写进对话开局时的固定前缀，只对之后新开的对话生效（已有的对话在各自的窗口里点「用于当前对话」换）；模型、思考、字数和世界书扫描随时生效。`,
    save: { text: t`保存`, onClick: () => saveSettings() },
  })
}

const saveSettings = guard(async () => {
  const form = $('settings-form')
  const num = name => Number(form[name].value) || 0
  ;[ui.settings] = await Promise.all([
    api('/api/settings', {
      method: 'PUT',
      body: {
        model: form.model.value,
        thinking: form.thinking.value,
        effort: form.effort.value,
        language: form.language.value.trim() || zh`简体中文`,
        scanDepth: Math.max(1, num('scanDepth')),
        reinjectAfter: num('reinjectAfter'),
        stateRefreshEvery: num('stateRefreshEvery'),
        dynamicStrip: form.dynamicStrip.value,
        compaction: compactionOf(form, num),
        replyLength: Math.max(0, num('replyLength')),
        listen: form.listen.value === 'lan' ? 'lan' : 'local',
        webFonts: form.webFonts.checked,
        cdnLibraries: form.cdnLibraries.checked,
        uiLanguage: form.uiLanguage.value,
        ...(form.proxyMode.disabled ? {} : { proxy: form.proxyMode.value === 'manual' ? form.proxyUrl.value.trim() : form.proxyMode.value }),
      },
    }),
  ])
  fillProxy(form, ui.settings.proxy, await api('/api/network').catch(() => null))
  allowLibraries(ui.settings.cdnLibraries !== false)
  // 默认（…） in the chat's model picker follows the default just saved.
  if (ui.settings.model !== undefined) ui.defaultModel = ui.settings.model || null
  // The models' thresholds follow the 上下文压缩 numbers just saved (the 压缩 pill's meter reads them).
  await loadModels()
  if (ui.chat) renderChat()
  let applied = await saveCardPicks(form)
  if (ui.cardId) {
    const ids = [...form.querySelectorAll('input[name="book"]:checked')].map(i => i.value)
    const before = ui.cards.find(c => c.id === ui.cardId)?.worldbookIds ?? []
    const changed = ids.length !== before.length || ids.some(id => !before.includes(id))
    const chatId = ui.chat?.cardId === ui.cardId ? ui.chat.id : undefined
    const saved = await api(`/api/cards/${ui.cardId}/worldbooks`, { method: 'PUT', body: { ids, chatId } })
    await refreshCards()
    if (changed) applied = (await offerMountRebuild(saved.prefixChange)) || applied
  }
  const access = await api('/api/access').catch(() => null)
  renderAccess(access)
  settingsMenu?.markClean()
  // Another interface language: the page comes back in it (index.html is translated when sent).
  if (pickLanguage(ui.settings.uiLanguage, navigator.languages ?? []) !== lang) {
    location.reload()
    return
  }
  settingsMenu?.refresh()
  toast(form.listen.value === 'lan' && access?.running !== 'lan' ? t`已保存。重启服务后，手机才能连上。` : applied ? t`设置已保存，并已应用到当前对话（下一轮会重写一次缓存）` : t`设置已保存`)
})

/**
 * The persona's name and the writing language default to Chinese words, which
 * are for the model. On an English page such a field shows empty with the
 * English as its hint; saving it empty keeps the default.
 */
function showDefaultAsHint(input, value, shown) {
  if (lang === 'zh') return
  input.placeholder = shown
  if (input.value === value) input.value = ''
}

// 设置 → 更多 → 界面语言. The setting's name also in the other language, so a page
// in a language you cannot read still shows where to change it.
const OTHER_LANGUAGE_NAME = lang === 'en' ? zh`界面语言` : 'Interface language'

function fillInterfaceLanguage(form) {
  const system = pickLanguage('', navigator.languages ?? []) === 'en' ? 'English' : t`简体中文`
  form.uiLanguage.replaceChildren(
    el('option', { value: 'auto', text: t`跟随系统（${system}）` }),
    el('option', { value: 'zh', lang: 'zh-CN', text: zh`简体中文` }),
    el('option', { value: 'en', lang: 'en', text: 'English' }),
  )
  form.uiLanguage.value = ui.settings.uiLanguage ?? 'auto'
  $('ui-language-other').textContent = ` · ${OTHER_LANGUAGE_NAME}`
}

/**
 * 网络代理: the saved choice (null = the edition's default, which /api/network
 * reports as the mode in force) and what it resolved to.
 */
function fillProxy(form, saved, network) {
  ui.network = network
  const mode = saved ?? network?.mode ?? 'none'
  const manual = mode !== 'none' && mode !== 'system'
  form.proxyMode.value = manual ? 'manual' : mode
  if (manual) form.proxyUrl.value = mode
  const sync = () => (form.querySelector('.proxy-url').hidden = form.proxyMode.value !== 'manual')
  form.proxyMode.onchange = sync
  sync()
  const locked = network?.locked === true
  form.proxyMode.disabled = locked
  form.proxyUrl.disabled = locked
  const status = $('network-status')
  if (!network) return (status.textContent = '')
  const now = network.effective ? t`现在走 ${network.effective}` : t`现在不走代理`
  const via = network.mode === 'system' ? (network.source === 'windows' ? t`（Windows 系统代理）` : network.source === 'macos' ? t`（macOS 系统代理）` : network.source === 'env' ? t`（环境变量 HTTPS_PROXY）` : t`：系统代理没开`) : ''
  status.textContent = locked ? t`${now}。启动时用 --proxy 或 AGENT_TAVERN_PROXY 指定了代理，这里改不了。` : t`${now}${via}。`
}

const ACCESS_KINDS = { wifi: t`同一 WiFi`, wired: t`有线局域网`, tailscale: t`Tailscale（出门用）`, virtual: t`虚拟网卡` }

function renderAccess(info) {
  ui.access = info
  const box = $('access-links')
  if (!box) return
  // 「添加到主屏幕」 reads "open a link above": there are links only while phones are let in.
  const homeHint = $('access-home-hint')
  if (homeHint) homeHint.hidden = info?.running !== 'lan' || !(info.links ?? []).length
  if (!info) {
    box.textContent = ''
    return
  }
  if (info.running !== 'lan') {
    box.textContent = info.saved === 'lan' ? t`已设为局域网。重启服务后，这里会出现手机链接。` : t`现在只能在这台电脑上打开。`
    return
  }
  const links = info.links ?? []
  if (!links.length) {
    box.textContent = t`没有找到局域网地址。`
    return
  }
  const row = link =>
    el('div', { class: 'access-row' }, [
      el('span', { class: 'access-kind', text: ACCESS_KINDS[link.kind] ?? link.adapter }),
      el('code', { text: link.url }),
      el('button', {
        type: 'button',
        class: 'btn small',
        text: t`复制`,
        onclick: () => navigator.clipboard.writeText(link.url).then(() => toast(t`已复制`), () => toast(t`复制失败，请长按链接选择`)),
      }),
    ])
  const main = links.filter(link => link.primary)
  // Nothing recognised as Wi-Fi / wired / Tailscale: show everything rather than hide the only links.
  if (!main.length) return box.replaceChildren(...links.map(row))
  const rest = links.filter(link => !link.primary)
  box.replaceChildren(
    ...main.map(row),
    ...(rest.length
      ? [el('details', { class: 'access-more' }, [el('summary', { text: t`其他地址（${rest.length}），手机一般用不上` }), ...rest.map(row)])]
      : []),
  )
}

/**
 * Books mounted or taken off that hold constant entries: the open chat keeps the
 * prefix it started with (keyword entries follow on the next turn by themselves).
 * Ask whether to rebuild it now.
 */
async function offerMountRebuild(change) {
  if (!change || !ui.chat || ui.generating) return false
  const list = books => books.map(book => t`「${book.name}」（${book.entries} 条常驻）`).join(t`、`)
  const what = [change.added.length ? t`挂上了${list(change.added)}` : '', change.removed.length ? t`摘下了${list(change.removed)}` : ''].filter(Boolean).join(t`；`)
  const ok = confirm(t`本次改动涉及常驻条目：${what}。\n\n常驻条目写在对话开局时的固定前缀里，当前对话还在用改动前的。现在应用到当前对话吗？会重建这个对话的固定前缀（历史不变），下一轮会重新写一次缓存，那一轮慢一点、贵一点。\n\n取消：当前对话先不变，新开的对话直接用新的；以后也可以在「设置 → 更多」里重建前缀。`)
  if (!ok) return false
  setChat(await api(`/api/chats/${ui.chat.id}/preset`, { method: 'POST', body: {} }))
  return true
}

const rebuildPrompt = guard(async () => {
  if (!ui.chat) return
  if (!confirm(t`按现在的角色卡、设置和预设重新生成这个对话的固定前缀？历史不变；下一轮会重新写入一次缓存（大卡约占一轮的额度）。`)) return
  setChat(await api(`/api/chats/${ui.chat.id}/preset`, { method: 'POST', body: {} }))
  toast(t`已重建固定前缀，下一轮生效`)
})

// Tells the server a page is open. The desktop launcher's server exits about a
// minute after the last of these closes.
let presence = null
function holdPresence() {
  if (!window.EventSource) return
  presence = new EventSource('/api/presence')
}

// CicaTavern.exe makes the shortcut itself (IShellLink); the server only asks it to.
const makeShortcut = guard(async () => {
  const { file } = await api('/api/shortcut', { method: 'POST', body: {} })
  toast(t`已创建：${file}`, 6000)
})

const stopServer = guard(async () => {
  if (ui.generating) throw new Error(t`正在生成，先停止`)
  if (!confirm(t`停止后台服务？这个窗口和手机上的页面都会断开，下次从桌面图标打开。`)) return
  await api('/api/shutdown', { method: 'POST', body: {} })
  presence?.close()
  $('settings-dialog').close()
  toast(t`服务已停止，可以关掉这个窗口了`)
})

const showPrompt = guard(async () => {
  const data = await api(`/api/chats/${ui.chat.id}/prompt`)
  $('prompt-system').textContent = data.systemPrompt
  $('prompt-chars').textContent = fmt(data.systemPrompt.length)
  $('prompt-turn').textContent = data.lastTurnPrompt || t`（还没有发送过）`
  $('prompt-dialog').showModal()
})

// ─── Presets ────────────────────────────────────────────────────────────
// 这一张怎么画: the 画图方式 and model for one drawing (配图's 重画, 角色名册's 画一张,
// 创作角色卡's avatar, 修改角色卡's 生成头像); nothing it picks is saved.
const drawChoice = initDrawChoice({ api, el, guard, openSettings: section => mediaUi.openSettings(section) })

// 卡片界面权限 (角色卡菜单): what a card's interface may do without a click, as answered when it asked.
const cardPermissions = initCardPermissions({ el, permissions: framePermissions, onRelayChange: cardId => broadcastRelay(framePermissions.allowedOrigins(cardId)) })

const mediaUi = initMedia({
  api,
  el,
  toast,
  guard,
  getChat: () => ui.chat,
  getModels: () => ui.models,
  openProviders: () => providersUi.open(),
  saveFile,
  pickDraw: drawChoice.pick,
})

const historyUi = initHistory({ el, getChat: () => ui.chat })
const vnUi = initVn({
  api, el, toast, guard, renderStory,
  // 一键备齐 / 做成视觉小说 ask how to draw first (web/draw-choice.js).
  pickDraw: drawChoice.pick,
  // 视觉小说预设, offered on going into the mode: the chat's prefix rebuilt with it.
  async usePreset(chatId, presetId) {
    const chat = await api(`/api/chats/${chatId}/preset`, { method: 'POST', body: { presetId } })
    if (ui.chat?.id === chatId) setChat(chat)
    toast(t`这个对话改用「${t`视觉小说预设`}」。下一轮会重新写入一次缓存。`)
  },
  getChat: () => ui.chat,
  isGenerating: () => ui.generating,
  live: () => (ui.chat ? ui.busy.get(ui.chat.id) ?? null : null),
  display: (chat, node, latest = true) => replyDisplay(chat, node, latest),
  statusFor: (chat, node) => (usesStatusPlaceholder(scriptsFor(chat)) ? null : statusFor(chat, node)),
  // The HUD reads any card's variables: its own status bar layout, else one laid out from the state (whatever the preset).
  hudSpec: (chat, node) => ui.cardDetails.get(chat.cardId)?.statusBar ?? autoStatusSpec(node.state ?? {}),
  frameContext: frameContextFor,
  cardOf: id => ui.cards.find(card => card.id === id),
  send: sendChoice,
  fill: fillInput,
  fitInput,
  regenerate: userNodeId => regenerate(userNodeId),
  rewriteChoices: nodeId => rewriteChoices(nodeId),
  selectNode: nodeId => selectNode(nodeId),
  // 读档: the save's chat as the server left it (that reply on screen).
  showChat: view => {
    followServerTurn(view)
    setChat(view)
  },
  readBeat: (nodeId, text, done, speaker) => mediaUi.readBeat(nodeId, text, done, speaker),
  fillQuick: (box, kind) => mediaUi.fillQuick(box, kind),
  stopReading: () => mediaUi.stopReading(),
  toggleReading: () => mediaUi.toggleReading(),
  mediaFlags: () => mediaUi.flags(),
  openMedia: section => mediaUi.openSettings(section),
  viewPicture: (src, caption, meta, options) => mediaUi.viewPicture(src, caption, meta, options),
})

/**
 * What the regex window shows besides the global scripts: the open chat's card
 * and preset (or, with no chat open, the chosen card and the default preset),
 * and the latest reply for its test box.
 */
async function regexContext() {
  const cardId = ui.chat?.cardId ?? ui.cardId
  // Old chats made before the built-in preset (presetId null) have no preset.
  const presetId = ui.chat ? ui.chat.presetId : ui.settings?.presetId
  const presetKey = presetId === null ? null : presetId || BASIC_ID
  await Promise.all([loadCardDetail(cardId), presetKey ? loadPresetDetail(presetKey) : null])
  const card = cardId ? ui.cardDetails.get(cardId) : null
  const preset = presetKey ? ui.presetDetails.get(presetKey) : null
  const reply = ui.chat?.path?.findLast(node => node.role === 'assistant')?.text ?? ''
  const names = ui.chat?.names ?? { char: card?.name ?? '', user: ui.persona?.name ?? '' }
  return {
    card: card?.name ? { id: cardId, name: card.name, scripts: card.regexScriptList ?? [] } : null,
    preset: preset?.name ? { id: presetKey, name: preset.name, builtin: Boolean(preset.builtin), scripts: preset.regexScriptList ?? [] } : null,
    sample: reply.slice(0, 4000),
    macros: text => nameMacros(text, names),
    names,
  }
}

/** Scripts were saved (the global ones, the 正则集, a card's or a preset's own): the page draws with them from now on. */
function regexChanged({ global, sets, card, preset }) {
  if (global) ui.globalRegex = global
  if (sets) ui.regexSets = sets
  for (const [details, saved] of [[ui.cardDetails, card], [ui.presetDetails, preset]]) {
    const detail = saved && details.get(saved.id)
    if (detail) Object.assign(detail, { regexScriptList: saved.scripts, regexScripts: saved.scripts.length })
  }
  if (ui.chat) renderChat()
}

// 世界书 / 预设 / 正则 / 主题 → 对话修改: the talk on one of them, over the window it came from.
const talkUi = initTalkDialog({ api, el, guard, openProviders: () => providersUi.open() })
const regexUi = initRegex({ api, el, toast, guard, saveFile, context: regexContext, getCards: () => ui.cards, onChanged: regexChanged, openTalk: talkUi.open })
const themeUi = initTheme({ api, el, toast, guard, getSettings: () => ui.settings, setSettings: settings => { ui.settings = settings }, onReading: () => fitInput(), openTalk: talkUi.open })
const whatsNewUi = initWhatsNew({ el })
const updateUi = initUpdate({ api, el, toast, guard, android, onChange: () => settingsMenu?.refresh(), isGenerating: () => ui.generating, openNotes: () => whatsNewUi.open() })

const forgeUi = initForge({
  api,
  el,
  toast,
  guard,
  openProviders: () => providersUi.open(),
  pickDraw: drawChoice.pick,
  async onCardSaved(id) {
    avatarVersions.set(id, Date.now())
    ui.cardDetails.delete(id)
    await refreshCards()
    await selectCard(id)
  },
  async startChatWith(id) {
    await refreshCards()
    await selectCard(id)
    await newChat()
  },
  makeVisualNovel,
})

const providersUi = initProviders({
  api,
  el,
  toast,
  guard,
  saveFile,
  async onChanged() {
    await loadModels()
    if ($('settings-dialog').open) {
      ui.settings = await api('/api/settings')
      $('settings-model').replaceChildren(...modelOptions(ui.defaultModel))
      const { providers } = await api('/api/providers').catch(() => ({ providers: null }))
      if (providers) settingsProviders.splice(0, Infinity, ...providers)
      settingsMenu?.refresh()
    }
    renderModelSelect()
    checkAuth()
  },
})

const presetsUi = initPresets({
  api, el, toast, guard, saveFile,
  openTalk: talkUi.open,
  getChat: () => ui.chat,
  isGenerating: () => ui.generating,
  onChatChanged: chat => {
    ui.presetDetails.clear()
    setChat(chat)
  },
  onPresetEdited: id => {
    ui.presetDetails.delete(id)
    if (ui.chat?.presetId === id) loadPresetDetail(id).then(renderQuickButton)
  },
  // The built-in preset's 状态栏 option shows at once.
  onBasicChanged: settings => {
    ui.settings = settings
    renderChat()
  },
})

const booksUi = initBooks({
  api, el, toast, guard, saveFile,
  openTalk: talkUi.open,
  getChat: () => ui.chat,
  getCards: () => ui.cards,
  getScanDepth: () => ui.settings?.scanDepth ?? 4,
  isGenerating: () => ui.generating,
  onChatChanged: chat => setChat(chat),
  // The counts under 设置 → 挂载的世界书 and in the card list follow each edit.
  onChanged: guard(async ({ mounts = [] } = {}) => {
    const ticked = new Set(tickedBooks())
    ;[ui.books] = await Promise.all([api('/api/worldbooks'), refreshCards()])
    if (!$('settings-dialog').open) return
    const card = ui.cards.find(c => c.id === ui.cardId)
    // A book whose cards were ticked in its own page is ticked here as the card has it now.
    for (const id of mounts) {
      if ((card?.worldbookIds ?? []).includes(id)) ticked.add(id)
      else ticked.delete(id)
    }
    renderBookOptions(card, ticked)
    settingsMenu?.refresh()
  }),
})

// 修改角色卡 (the card list's ⋯): the card's fields, its picture and its own book, and 对话修改.
const cardEditUi = initCardEdit({
  api, el, toast, guard, saveFile,
  pickDraw: drawChoice.pick,
  getChat: () => ui.chat,
  isGenerating: () => ui.generating,
  openProviders: () => providersUi.open(),
  onChatChanged: chat => setChat(chat),
  // The entries window on the card's own book (its first entry may just have been made).
  async openBook(id) {
    ;[ui.books] = await Promise.all([api('/api/worldbooks'), refreshCards()])
    const card = ui.cards.find(c => c.id === id)
    await booksUi.open({ card, books: ui.books, mounted: card?.worldbookIds ?? [], select: `card-${id}` })
  },
  // The list, the card's details under it and its picture follow an edit.
  async onCardChanged(id, { avatar = false } = {}) {
    if (avatar) avatarVersions.set(id, Date.now())
    ui.cardDetails.delete(id)
    await refreshCards()
    if (ui.cardId !== id) return
    await loadCardDetail(id)
    showCardInfo(ui.cardDetails.get(id))
    if (ui.chat?.cardId === id) renderChat()
  },
})

// ─── Quick switches: preset entries pinned in the preset editor ─────────

function quickEntries() {
  const detail = ui.presetDetails.get(ui.chat?.presetId)
  return (detail?.quick ?? []).map(id => detail.prompts?.find(p => p.id === id)).filter(Boolean)
}

// The built-in presets (基础预设, 视觉小说预设): options of their own instead of entries.
const usesBasic = chat => isBuiltinPreset(chat?.presetId)

// 联网: the provider searches the web for this chat's turns when the model asks, as SillyTavern's
// 「Enable web search」 does. Only models whose provider has a search of its own (providers.mjs webSearchKind).
const SEARCH_BY = {
  get anthropic() { return t`Anthropic 的网页搜索，每次搜索另收费` },
  get openai() { return t`OpenAI 的网页搜索，每次搜索另收费` },
  get openrouter() { return t`OpenRouter 的联网插件，每轮约另收 0.02 美元` },
}

const searchKindOf = chat => (chat ? ui.models.find(m => m.id === (chat.model || ui.defaultModel))?.search ?? null : null)

function renderSearchButton() {
  const button = $('search-toggle')
  const chat = ui.chat
  button.hidden = !chat
  if (!chat) return
  const kind = searchKindOf(chat)
  const on = Boolean(chat.webSearch && kind)
  button.setAttribute('aria-pressed', String(on))
  button.classList.toggle('unavailable', !kind)
  button.disabled = ui.generating
  button.title = !kind
    ? t`联网搜索：这个模型用不了（Anthropic 接口的 Claude、OpenAI Responses 接口和 OpenRouter 的模型可以）`
    : on
      ? t`联网搜索已打开：需要现实世界的信息时，模型会先搜网页（${SEARCH_BY[kind]}）。点一下关掉`
      : t`联网搜索：打开后，需要现实世界的信息时模型会先搜网页（${SEARCH_BY[kind]}）`
}

const toggleSearch = guard(async () => {
  const chat = ui.chat
  const kind = searchKindOf(chat)
  if (!chat || ui.generating) return
  if (!kind) return toast(t`这个模型用不了联网搜索：Anthropic 接口的 Claude、OpenAI Responses 接口和 OpenRouter 的模型可以。`)
  const view = await api(`/api/chats/${chat.id}`, { method: 'PUT', body: { webSearch: !chat.webSearch } })
  if (ui.chat?.id !== chat.id) return
  ui.chat = { ...ui.chat, webSearch: view.webSearch }
  renderSearchButton()
  toast(view.webSearch ? t`这个对话打开了联网搜索：${SEARCH_BY[kind]}。开关之后的第一轮会重新写一次缓存。` : t`这个对话关掉了联网搜索。`)
})

// 语音输入 (web/dictation.js, loaded on the first press): what is said goes into the box, never sent by itself.
let dictation = null

/** The microphone beside the box: with a chat open, unless 语音输入 is set to 不用. */
function renderDictateButton() {
  $('dictate').hidden = !ui.chat || mediaUi.settings()?.sttSource === 'off'
}

const pressDictate = guard(async () => {
  if (!dictation) {
    const { createDictation } = await import('/dictation.js').catch(() => {
      throw Object.assign(new Error(t`语音输入要重启后台服务后才能用：关掉所有窗口等一分钟，再从桌面图标打开。`), { status: 404 })
    })
    dictation ??= createDictation({
      el, toast,
      input: $('input'),
      button: $('dictate'),
      composer: $('composer'),
      settings: () => mediaUi.settings(),
      names: () => [ui.chat?.names?.char, ui.chat?.names?.user].filter(Boolean),
      openSettings: section => mediaUi.openSettings(section),
    })
  }
  dictation.press()
})

/** What a reply searched for and the pages it drew on, folded under it. */
function searchSources(search) {
  const host = url => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }
  const sources = (search.sources ?? []).filter(source => /^https?:\/\//i.test(source.url))
  const label = sources.length ? t`联网搜索 · ${sources.length} 个来源` : t`联网搜索了 ${search.count || 1} 次`
  return el('details', { class: 'search-sources' }, [
    el('summary', { text: label }),
    search.queries?.length ? el('p', { class: 'asked', text: t`搜了：${search.queries.join(t`；`)}` }) : null,
    sources.length
      ? el('ol', {}, sources.map(source => el('li', {}, [
          el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', text: source.title || host(source.url) || source.url }),
          source.title ? el('span', { class: 'host', text: host(source.url) }) : null,
        ])))
      : null,
  ])
}

function renderQuickButton() {
  const button = $('quick-open')
  button.hidden = !ui.chat || !(usesBasic(ui.chat) || quickEntries().length)
  button.disabled = ui.generating
}

/** With the built-in preset the quick switches are its options. */
function openBasicQuick() {
  const presetId = ui.chat.presetId
  const fields = fieldsOf(presetId)
  const saved = builtinOptions(ui.settings, presetId)
  const changed = new Map()
  const rebuilds = () => [...changed.keys()].some(key => fields.find(f => f.key === key)?.prompt !== false)
  const update = () => {
    $('quick-apply').disabled = !changed.size
    $('quick-hint').textContent = !changed.size
      ? presetId === VN_ID ? t`视觉小说预设的选项，改动对这个对话和之后的新对话都生效。` : t`基础预设的选项，改动对这个对话和之后的新对话都生效。`
      : rebuilds()
        ? t`应用后会重建这个对话的固定前缀，下一轮重写一次缓存。`
        : t`只影响显示，应用后马上生效。`
  }
  const pick = (key, value) => {
    if (value === saved[key]) changed.delete(key)
    else changed.set(key, value)
    update()
  }
  $('quick-list').replaceChildren(...fields.map(field => el('li', {}, basicField(el, field, saved[field.key], { onPick: pick, compact: true }))))
  ui.quickChanges = changed
  ui.quickBasic = { saved, rebuilds, presetId }
  update()
  $('quick-dialog').showModal()
}

const applyBasicQuick = async () => {
  const { saved, rebuilds, presetId } = ui.quickBasic
  const rebuild = rebuilds()
  ui.settings = await api('/api/settings', { method: 'PUT', body: { [builtinKey(presetId)]: { ...saved, ...Object.fromEntries(ui.quickChanges) } } })
  if (rebuild) setChat(await api(`/api/chats/${ui.chat.id}/preset`, { method: 'POST', body: { presetId } }))
  else renderChat()
  $('quick-dialog').close()
  toast(rebuild ? t`已应用。下一轮会重写一次缓存。` : t`已应用。`)
}

/** Entries placed after the chat history are sent every turn; the rest live in the frozen prefix. */
const needsRebuild = (entries, ids) => ids.some(id => entries.find(p => p.id === id)?.placement !== 'turn')

function openQuick() {
  if (usesBasic(ui.chat)) return openBasicQuick()
  ui.quickBasic = null
  const entries = quickEntries()
  const changed = new Map()
  const update = () => {
    $('quick-apply').disabled = !changed.size
    $('quick-hint').textContent = !changed.size
      ? t`在「预设」里点条目右边的「快捷」，可以把它放到这里。改动会存进预设，并用到这个对话。`
      : needsRebuild(entries, [...changed.keys()])
        ? t`应用后会重建这个对话的固定前缀，下一轮重写一次缓存。`
        : t`这些条目每轮单独发送，应用后下一轮就生效，不影响缓存。`
  }
  $('quick-list').replaceChildren(
    ...entries.map(p => {
      const box = el('input', { type: 'checkbox', class: 'switch', checked: p.enabled })
      const name = el('span', { text: p.name })
      box.addEventListener('change', () => {
        if (box.checked === p.enabled) changed.delete(p.id)
        else changed.set(p.id, box.checked)
        name.classList.toggle('changed', changed.has(p.id))
        update()
      })
      return el('li', {}, el('label', {}, [box, name]))
    }),
  )
  ui.quickChanges = changed
  update()
  $('quick-dialog').showModal()
}

const applyQuick = guard(async () => {
  const changed = ui.quickChanges
  if (!changed?.size || !ui.chat || ui.generating) return
  if (ui.quickBasic) return applyBasicQuick()
  const presetId = ui.chat.presetId
  const rebuild = needsRebuild(quickEntries(), [...changed.keys()])
  await api(`/api/presets/${presetId}`, { method: 'PUT', body: { prompts: [...changed].map(([id, enabled]) => ({ id, enabled })) } })
  ui.presetDetails.delete(presetId)
  if (rebuild) setChat(await api(`/api/chats/${ui.chat.id}/preset`, { method: 'POST', body: {} }))
  await loadPresetDetail(presetId)
  renderQuickButton()
  $('quick-dialog').close()
  toast(rebuild ? t`已应用。下一轮会重写一次缓存。` : t`已应用，下一轮生效。`)
})

// ─── Small interactions ─────────────────────────────────────────────────
/** The composer grows with its text, up to its max height. */
function fitInput() {
  const input = $('input')
  input.style.height = 'auto'
  // Hidden (the visual novel's text box in its place) it measures 0: one line until it shows again.
  if (!input.getClientRects().length) return
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`
}

function closeDrawers() {
  document.querySelector('.app').classList.remove('show-left', 'show-right')
}

// ─── Boot ───────────────────────────────────────────────────────────────
/** The subscription's sign-in banner (hidden without one). */
async function checkAuth() {
  if (subscriptionPage) await subscriptionPage.checkAuth($('auth-banner'), api)
  else $('auth-banner').hidden = true
}

function bind() {
  // On a phone the full placeholder wraps under the one-line box: the short one there, as the width changes too.
  const narrow = matchMedia('(max-width: 560px)')
  const fullPlaceholder = $('input').placeholder
  const fitPlaceholder = () => { $('input').placeholder = narrow.matches ? t`写下行动、对白或想看的发展` : fullPlaceholder }
  fitPlaceholder()
  narrow.addEventListener('change', fitPlaceholder)
  // Phones show a list dialog's list and its selected item one at a time (style.css .show-main).
  for (const layout of document.querySelectorAll('.preset-layout')) {
    // Capture phase: the provider list re-renders inside the item's own click
    // handler, after which the clicked item is no longer in the list.
    layout.addEventListener('click', event => {
      if (event.target.closest('.preset-list li, #provider-add, #regex-new') && !event.target.closest('.switch')) layout.classList.add('show-main')
    }, { capture: true })
    layout.querySelector('.preset-back')?.addEventListener('click', () => layout.classList.remove('show-main'))
    const dialog = layout.closest('dialog')
    dialog.addEventListener('close', () => layout.classList.remove('show-main'))
    // As in the settings windows: from an item, Esc or a click outside goes back to the list.
    const showingItem = () => layout.classList.contains('show-main') && matchMedia('(max-width: 780px)').matches
    dialog.addEventListener('cancel', event => {
      if (!showingItem()) return
      event.preventDefault()
      layout.classList.remove('show-main')
    })
    dialog.addEventListener('click', event => {
      if (event.target !== dialog || !showingItem()) return
      const box = dialog.getBoundingClientRect()
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) layout.classList.remove('show-main')
    })
  }
  const cardSearch = searchBox(el, {
    placeholder: t`搜索角色卡：名字、标签、分组`,
    label: t`搜索角色卡`,
    onInput: value => {
      cardQuery = value
      renderCards()
    },
  })
  $('card-list').before(cardSearch.box)
  listenForFrameHeights()
  watchCallFrames()
  installFrameBridge({
    ...frameHandlers,
    toast: (_level, text) => toast(text),
    input: text => setDraft(text, false),
    slash: runFrameSlash,
    send: frameSend,
    opening: async index => {
      if (!ui.chat || ui.generating) throw new Error(t`正在生成，稍后再试`)
      const chatId = ui.chat.id
      const view = await api(`/api/chats/${chatId}/opening`, { method: 'POST', body: { index } })
      if (stillOpen(chatId)) setChat(view)
    },
    ids: () => ({ presetId: ui.chat?.presetId ?? null, cardId: ui.chat?.cardId ?? null }),
  })
  // A card frame's model call shows a notice; clicking it stops the call.
  toastBox.addEventListener('click', () => {
    if (frameGenerations.size) frameHandlers.stopGenerate({})
  })
  $('import-input').addEventListener('change', event => {
    const files = [...event.target.files]
    event.target.value = ''
    if (files.length) importFiles(files)
  })
  // Options a preset writes after a reply (1️⃣ …): a click puts the option in the input box to edit or send.
  $('transcript').addEventListener('click', event => {
    const choice = event.target.closest('.choice')
    if (!choice) return
    setDraft(choice.dataset.choice)
    toast(t`已填进输入框，可以改一改再发送`)
  })
  $('new-chat').addEventListener('click', newChat)
  // Every file picked, each kind its own way (the title says several can go at once).
  $('import-story').addEventListener('change', async event => {
    const files = [...event.target.files]
    event.target.value = ''
    const tavern = files.filter(file => /\.jsonl$/i.test(file.name))
    const packages = files.filter(file => !tavern.includes(file) && (/\.tavernchat$/i.test(file.name) || file.type === 'application/octet-stream'))
    for (const file of tavern) await importSillyTavernFile(file)
    if (packages.length) await guard(importPackages)(packages)
    for (const file of files.filter(file => !tavern.includes(file) && !packages.includes(file))) await importStoryFile(file)
  })
  $('recap-export').addEventListener('click', exportRecap)
  $('composer').addEventListener('submit', event => { event.preventDefault(); send() })
  $('input').addEventListener('input', () => {
    fitInput()
    broadcastInput($('input').value)
  })
  // A phone's keyboard has no Shift+Enter: there its Enter key starts a new line and the send button
  // sends. Ctrl+Enter sends everywhere (a tablet with a keyboard).
  const touchKeyboard = matchMedia('(hover: none) and (pointer: coarse)')
  $('input').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return
    if (event.ctrlKey || event.metaKey || (!event.shiftKey && !touchKeyboard.matches)) {
      event.preventDefault()
      send()
    }
  })
  $('stop').addEventListener('click', stop)
  $('edit-state').addEventListener('click', editState)
  $('cancel-state').addEventListener('click', renderSide)
  $('save-state').addEventListener('click', saveState)
  $('open-settings').addEventListener('click', openSettings)
  $('open-usage').addEventListener('click', openUsage)
  $('open-presets').addEventListener('click', () => presetsUi.open())
  $('open-books').addEventListener('click', openBookManager)
  $('forge-open').addEventListener('click', () => forgeUi.open())
  // A card being written when the page loaded (closed, reloaded, another device started it): its chip.
  forgeUi.watch()
  $('open-providers').addEventListener('click', () => providersUi.open())
  $('provider-add').addEventListener('click', () => providersUi.add())
  $('provider-import-dsh').addEventListener('click', () => providersUi.importDsh())
  $('provider-export').addEventListener('click', () => providersUi.exportAll())
  $('provider-import').addEventListener('click', () => $('provider-import-input').click())
  $('provider-import-input').addEventListener('change', event => {
    const [file] = event.target.files
    event.target.value = ''
    if (file) providersUi.importFile(file)
  })
  $('chat-preset').addEventListener('click', () => presetsUi.open(ui.chat?.presetId))
  $('chat-title').addEventListener('click', () => { if (ui.chat) renameChat(ui.chat) })
  $('scrim').addEventListener('click', closeDrawers)
  if (window.visualViewport) {
    const syncKeyboard = () => {
      const viewport = window.visualViewport
      const gap = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      document.documentElement.style.setProperty('--kb', `${gap}px`)
    }
    window.visualViewport.addEventListener('resize', syncKeyboard)
    window.visualViewport.addEventListener('scroll', syncKeyboard)
  }
  $('chat-model').addEventListener('change', changeChatModel)
  $('usage-range').addEventListener('click', event => {
    const button = event.target.closest('button[data-days]')
    if (!button) return
    ui.usageDays = Number(button.dataset.days)
    for (const b of $('usage-range').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === button))
    loadUsage()
  })
  $('compact-chat').addEventListener('click', compactNow)
  $('quick-open').addEventListener('click', openQuick)
  $('search-toggle').addEventListener('click', toggleSearch)
  $('dictate').addEventListener('click', pressDictate)
  document.addEventListener('cicatavern:media-settings', renderDictateButton)
  $('quick-apply').addEventListener('click', applyQuick)
  $('recap-save').addEventListener('click', saveRecap)
  $('recap-drop').addEventListener('click', dropRecap)
  $('toggle-left').addEventListener('click', () => document.querySelector('.app').classList.toggle('show-left'))
  $('toggle-right').addEventListener('click', () => document.querySelector('.app').classList.toggle('show-right'))
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawers() })
  // Drop files anywhere to import.
  const app = document.querySelector('.app')
  let dragDepth = 0
  const hasFiles = event => [...(event.dataTransfer?.types ?? [])].includes('Files')
  document.addEventListener('dragenter', event => { if (hasFiles(event) && dragDepth++ === 0) app.classList.add('dragging') })
  document.addEventListener('dragleave', () => { if (dragDepth > 0 && --dragDepth === 0) app.classList.remove('dragging') })
  document.addEventListener('dragover', event => event.preventDefault())
  document.addEventListener('drop', event => {
    event.preventDefault()
    dragDepth = 0
    app.classList.remove('dragging')
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length) importFiles(files)
  })
}

async function boot() {
  // Opened from a phone's home screen with the key in its address (manifest, login page): logged in by now.
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches
  if (standalone && location.hash.startsWith('#k=')) history.replaceState(null, '', location.pathname + location.search)
  bind()
  holdPresence()
  const status = await api('/api/status').catch(() => null)
  if (status?.edition) document.documentElement.dataset.edition = status.edition
  // data-feature-lan="false" and the like hide what this edition cannot do (style.css).
  ui.features = status?.features ?? {}
  for (const [key, value] of Object.entries(ui.features)) {
    if (typeof value === 'boolean') document.documentElement.dataset[`feature${key[0].toUpperCase()}${key.slice(1)}`] = String(value)
  }
  ui.launcher = Boolean(status?.launcher)
  ui.settings = await api('/api/settings').catch(() => null)
  const regex = await api('/api/regex').catch(() => null)
  ui.globalRegex = regex?.scripts ?? []
  ui.regexSets = regex?.sets ?? []
  await showBlockWords((await api('/api/blockwords').catch(() => null))?.words ?? [])
  // The style and the picture saved here win over the copy this browser drew at start.
  if (ui.settings) themeUi.apply()
  // The public builds say, once, what they connect to without being configured; nothing of it happens before.
  if (ui.features.privacyNotice && ui.settings && ui.settings.privacyNotice < (status?.privacyNoticeVersion ?? 1)) {
    allowLibraries(false)
    const update = await api('/api/update').catch(() => ({}))
    await showPrivacyNotice({
      el,
      features: ui.features,
      settings: ui.settings,
      autoCheck: update.autoCheck,
      async save(choice) {
        if (choice.autoCheck !== undefined) await api('/api/update/settings', { method: 'PUT', body: { autoCheck: choice.autoCheck } })
        ui.settings = await api('/api/settings', { method: 'PUT', body: { webFonts: choice.webFonts, cdnLibraries: choice.cdnLibraries, privacyNotice: status.privacyNoticeVersion } })
      },
    })
    // The web font, when wanted, comes with the page.
    if (ui.settings.webFonts) return location.reload()
  }
  allowLibraries(ui.settings?.cdnLibraries !== false)
  if (ui.features.subscription) {
    subscriptionPage = await import('/subscription.js').catch(() => null)
    document.querySelector('.brand-sub').textContent = t`个人版 · 可用 Claude 订阅`
  }
  const appName = ui.features.appName ?? 'CicaTavern'
  document.querySelector('.brand-name').textContent = appName
  document.title = appName
  if (status) {
    document.querySelector('.brand').title = `${appName} v${status.version}`
    ui.rateLimit = status.rateLimit
    renderQuota(status.rateLimit)
  }
  checkAuth()
  loadModels()
  // The daily update check runs on the server; this only asks how it went.
  updateUi.boot()
  ui.books = await api('/api/worldbooks').catch(() => [])
  await refreshCards()
  // Start on the newest card still in the list; archived ones wait until asked for.
  const first = ui.cards.find(card => !card.archived)
  if (first) await selectCard(first.id)
  else renderChat()
  // After an update: what is new, once (someone with cards already has updated; a new player has not).
  ui.appVersion = status?.version ?? ''
  whatsNewUi.boot({ version: status?.version, returning: ui.cards.length > 0 })
}

boot()
