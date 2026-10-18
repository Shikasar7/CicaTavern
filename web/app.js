// Agent Tavern web UI. Plain DOM, no build step.
import { displayOf, htmlFrame, listenForFrameHeights, segments, streamingText, usesStatusPlaceholder } from '/render.js'
import { broadcastInput, installFrameBridge, parseSlash, storedFrameStorage, storedVariables } from '/compat.js'
import { renderUsage } from '/usage.js'
import { initPresets } from '/presets.js'
import { initProviders } from '/providers.js'
import { initMedia } from '/media.js'
import { initHistory } from '/history.js'
import { createMenu, MENU_ICONS, whoLine } from '/menu.js'

const $ = id => document.getElementById(id)
const EMPTY = $('empty')

// The subscription's parts of the page (/subscription.js), where the server has the subscription.
let subscriptionPage = null

const ui = {
  cards: [],
  books: [],
  chats: [],
  cardId: null,
  chat: null,
  settings: null,
  persona: null,
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
  return el('option', { value: m.id, selected: selected === m.id, title: m.note || undefined, text: m.extraCredits ? `${m.label}（需额外用量额度）` : m.label })
}

/** Options grouped by source (one group per provider). */
function modelOptions(selected) {
  const groups = new Map()
  for (const m of ui.models) {
    const group = m.group ?? '其他'
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
}

function renderModelSelect() {
  const select = $('chat-model')
  const chat = ui.chat
  select.hidden = !chat
  if (select.hidden) return
  const known = ui.models.some(m => m.id === ui.defaultModel)
  select.replaceChildren(...[
    el('option', { value: '', selected: !chat.model, text: known ? `默认（${labelOf(ui.defaultModel)}）` : '默认（未选，去设置里选一个）' }),
    ...modelOptions(chat.model),
    // A chat model that is gone (provider deleted, subscription off) still shows as selected.
    chat.model && !ui.models.some(m => m.id === chat.model) ? el('option', { value: chat.model, selected: true, text: `${chat.model}（不可用）` }) : null,
    el('option', { value: MANAGE_PROVIDERS, text: '管理模型供应商…' }),
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
  if (ui.chat.compactable >= SUGGEST_COMPACT && model !== (ui.chat.model ?? '')) {
    const choice = await askSwitch(ui.chat.compactable)
    const go = choice === 'switch' || (choice === 'compact' && (await runCompaction()))
    if (!go) {
      renderModelSelect()
      return
    }
  }
  const view = await api(`/api/chats/${ui.chat.id}`, { method: 'PUT', body: { model } })
  ui.chat = { ...ui.chat, model: view.model }
  renderModelSelect()
  toast(`这个对话改用 ${labelOf(view.model || ui.defaultModel)}。缓存按模型区分，下一轮会重新写入一次缓存。`)
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
  if (!res.ok) throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { status: res.status })
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
    throw new Error(data.error || `请求失败（${res.status}）`)
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

function toast(message, ms = 4000) {
  const el = $('toast')
  el.textContent = message
  el.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { el.hidden = true }, ms)
}

function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args)
    } catch (error) {
      toast(error.message, 6000)
    }
  }
}

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

function renderStory(text) {
  const folds = []
  const fold = (label, body) => (body.trim() ? `\n\n@@fold${folds.push({ label, body: body.trim() }) - 1}@@\n\n` : '')
  const source = text
    // A voice tag right after a line keeps its emotion for reading aloud (marked, then put on the line's span).
    .replace(QUOTE_VOICE, (_, quote, emotion) => (emotion.trim() ? `${quote}${emotion.trim()}` : quote))
    .replace(VOICE_TAG, '')
    .replace(/<\/?small>/gi, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(FOLD_BLOCK, (_, tag, body) => fold('思考过程', body))
    .replace(FOLD_OPEN, (_, tag, body) => fold('思考中…', body))
  let html = ''
  let last = 0
  for (const match of source.matchAll(STORY_TAG)) {
    html += escapeHtml(source.slice(last, match.index)) + inlineTag(match[1], match[2], match[3])
    last = match.index + match[0].length
  }
  html = (html + escapeHtml(source.slice(last)))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<em>$2</em>')
    .replace(/(“[^”\n]*”|「[^」\n]*」|&quot;[^&\n]*?&quot;)/g, '<span class="q">$1</span>')
    .replace(/<span class="q">([^<]*)<\/span>([^<]*)/g, '<span class="q" data-emotion="$2">$1</span>')
    .replace(/[^]*/g, '')
    .replace(CHOICE_LINE, (_, indent, n, body) => `${indent}<button type="button" class="choice" data-choice="${body.replace(/<[^>]+>/g, '').replace(/"/g, '&quot;')}"><b>${n}</b><span class="choice-text">${body}</span></button>`)
  return html
    .split(/\n{2,}/)
    .map(p => {
      const folded = /^@@fold(\d+)@@$/.exec(p.trim())
      if (folded) {
        const { label, body } = folds[folded[1]]
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
      return lines.length ? `<p>${lines.join('<br>')}</p>` : ''
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

function avatarFor(card) {
  if (card?.hasAvatar) return el('img', { class: 'avatar', src: `/api/cards/${card.id}/avatar`, alt: '' })
  return el('span', { class: 'avatar', text: (card?.name ?? '?').slice(0, 1) })
}

const fmt = n => (n ?? 0).toLocaleString('zh-CN')

/** "刚刚", "12 分钟前", "昨天", "3 天前", then the date. */
function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

// ─── Left pane ──────────────────────────────────────────────────────────
function renderCards() {
  const list = $('card-list')
  list.replaceChildren(
    ...ui.cards.map(card =>
      el('li', { class: card.id === ui.cardId ? 'active' : '', onclick: () => selectCard(card.id) }, [
        avatarFor(card),
        el('div', { class: 'item-main' }, [
          el('div', { class: 'item-title', text: card.name }),
          el('div', { class: 'item-sub', text: `${card.greetings} 个开场 · ${card.bookEntries} 条内嵌世界书${card.worldbookIds.length ? ` · 挂载 ${card.worldbookIds.length} 本` : ''}` }),
        ]),
        el('button', { class: 'item-del', title: '删除角色卡', text: '✕', onclick: event => { event.stopPropagation(); deleteCard(card) } }),
      ]),
    ),
  )
  if (ui.cards.length === 0) list.append(el('li', { class: 'muted small', text: '还没有角色卡' }))
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
          el('div', { class: 'item-title' }, [chat.title, ui.busy.has(chat.id) ? el('span', { class: 'busy-dot', title: '正在生成' }) : null]),
          el('div', { class: 'item-sub', text: `${ago(chat.updatedAt)}　${chat.turns} 轮　${chat.preview}` }),
        ]),
        document.documentElement.dataset.edition === 'android'
          ? null
          : el('a', { class: 'item-del item-edit', title: '打包整段对话（每一轮、每个分支和配图），在另一台设备上用「导入存档」导入', text: '⇩', href: `/api/chats/${chat.id}/package`, download: '', onclick: event => event.stopPropagation() }),
        el('button', { class: 'item-del item-edit', title: '重命名', text: '✎', onclick: event => { event.stopPropagation(); renameChat(chat) } }),
        el('button', { class: 'item-del', title: '删除对话', text: '✕', onclick: event => { event.stopPropagation(); deleteChat(chat) } }),
      ]),
    ),
  )
  if (ui.cardId && ui.chats.length === 0) list.append(el('li', { class: 'muted small', text: '还没有对话，点「新对话」' }))
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
  renderCards()
  await refreshChats()
  const card = await api(`/api/cards/${id}`)
  ui.cardDetails.set(id, card)
  $('card-info').textContent = [
    card.creator && `作者：${card.creator}`,
    card.tags?.length && `标签：${card.tags.join('、')}`,
    card.creatorNotes,
    card.regexScripts ? `正则脚本 ${card.regexScripts} 条（显示与发送规则已生效）` : '',
    card.helperScripts ? `酒馆助手脚本 ${card.helperScripts} 个（不执行；MVU 变量更新已内置）` : '',
  ].filter(Boolean).join('\n\n') || '—'
  if (ui.chats[0]) await openChat(ui.chats[0].id)
  else setChat(null)
  document.body.querySelector('.app').classList.remove('show-left')
})

const deleteCard = guard(async card => {
  if (!confirm(`删除角色卡「${card.name}」？（它的对话记录会保留）`)) return
  await api(`/api/cards/${card.id}`, { method: 'DELETE' })
  if (ui.cardId === card.id) { ui.cardId = null; setChat(null) }
  await refreshCards()
  await refreshChats()
})

const renameChat = guard(async chat => {
  const title = prompt('对话的新名字', chat.title)?.trim()
  if (!title || title === chat.title) return
  const saved = await api(`/api/chats/${chat.id}`, { method: 'PUT', body: { title } })
  if (ui.chat?.id === chat.id) ui.chat = { ...ui.chat, title: saved.title }
  renderChat()
  await refreshChats()
})

const deleteChat = guard(async chat => {
  if (!confirm(`删除对话「${chat.title}」？`)) return
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
  for (const file of files) {
    const data = await fileToBase64(file)
    const json = await jsonOf(file)
    if (json?.format === STORY_FORMAT) {
      // Opens the new chat itself.
      done.push(await importStory(json))
      continue
    }
    // A SillyTavern preset, or one exported from this app (agent-tavern-preset).
    if (Array.isArray(json?.prompts) || Array.isArray(json?.preset?.prompts)) {
      const preset = await api('/api/presets/import', { method: 'POST', body: { filename: file.name, data } })
      done.push(`预设「${preset.name}」${preset.prompts} 条`)
      presets++
      continue
    }
    if (json && typeof json.findRegex === 'string') {
      done.push(`「${file.name}」是单独的正则脚本，暂不支持导入（预设和角色卡里带的正则会自动生效）`)
      continue
    }
    if (looksLikeWorldbook(json)) {
      const book = await api('/api/worldbooks/import', { method: 'POST', body: { filename: file.name, data } })
      done.push(`世界书「${book.name}」${book.entries} 条`)
      reselect = true
    } else {
      // A newer version of a card already here: update that one in place, or keep both.
      const { previous } = await api('/api/cards/inspect', { method: 'POST', body: { filename: file.name, data } })
      const replace = previous && confirm(`已经有「${previous.name}」。\n\n确定：更新这张卡（对话、配图与朗读设置、角色名册和人设图都保留）\n取消：另存为一张新卡（也会带上它的配图设置和人设图）`) ? previous.id : ''
      const card = await api('/api/cards/import', { method: 'POST', body: { filename: file.name, data, ...(replace ? { replace } : {}) } })
      done.push(card.updated ? `角色卡「${card.updated}」更新为「${card.name}」` : `角色卡「${card.name}」${card.inherited ? `（沿用了「${card.inherited}」的配图设置和人设图）` : ''}`)
      ui.cardId = card.id
      reselect = true
    }
  }
  ui.books = await api('/api/worldbooks')
  await refreshCards()
  if (ui.cardId && reselect) await selectCard(ui.cardId)
  toast(`已导入：${done.join('，')}`, 6000)
  if (presets) presetsUi.open()
})

// ─── Chat ───────────────────────────────────────────────────────────────
function setChat(chat) {
  ui.chat = chat
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
  const view = await api(`/api/chats/${id}`)
  followServerTurn(view)
  setChat(view)
  document.body.querySelector('.app').classList.remove('show-left')
})

const newChat = guard(async () => {
  const card = await api(`/api/cards/${ui.cardId}`)
  const texts = card.greetingTexts.length ? card.greetingTexts : ['']
  if (texts.length === 1) return startChat(0)
  const box = $('greetings')
  box.replaceChildren(
    ...texts.map((text, index) =>
      el('button', { class: 'greeting', type: 'button', text: text.slice(0, 400) || '（空开场）', onclick: () => { $('greeting-dialog').close(); startChat(index) } }),
    ),
  )
  $('greeting-dialog').showModal()
})

const startChat = guard(async greetingIndex => {
  const chat = await api('/api/chats', { method: 'POST', body: { cardId: ui.cardId, greetingIndex } })
  await refreshChats()
  setChat(chat)
  $('input').focus()
})

/** Regex scripts of the chat's preset, then its card (both cached), as the server applies them. */
function scriptsFor(chat) {
  return [...(ui.presetDetails.get(chat?.presetId)?.regexScriptList ?? []), ...(ui.cardDetails.get(chat?.cardId)?.regexScriptList ?? [])]
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
  if (!body.childNodes.length) body.append(el('div', { class: 'story muted', text: '（空）' }))
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
  heading.textContent = chat ? chat.title : ui.cardId ? '点「新对话」开始' : '选择一张角色卡开始'
  heading.classList.toggle('renamable', Boolean(chat))
  heading.title = chat ? '点击重命名' : ''
  renderModelSelect()
  renderQuickButton()
  const presetPill = $('chat-preset')
  presetPill.hidden = !chat
  if (chat) {
    presetPill.textContent = chat.presetName ? `预设：${chat.presetName}` : '不用预设'
    presetPill.classList.toggle('unset', !chat.presetName)
    presetPill.disabled = ui.generating
  }
  const compact = $('compact-chat')
  compact.hidden = !chat
  if (chat) {
    compact.disabled = ui.generating || !chat.compactable
    compact.title = chat.compactable
      ? `把前面的剧情压缩成一份存档（上次压缩后新增 ${chat.compactable} 轮），之后在新的上下文里接着写`
      : '上次压缩之后还不到 2 轮新剧情，不用压缩'
  }
  if (!chat) {
    box.replaceChildren(EMPTY)
    historyUi.refresh()
    return
  }
  const lastAssistant = [...chat.path].reverse().find(n => n.role === 'assistant')
  const nodes = chat.path.map((node, index) => renderNode(chat, node, node === lastAssistant, chat.path.length - 1 - index))
  if (chat.folded > 0) {
    nodes.push(
      el('div', { class: 'folded-note' }, [
        el('span', { text: `已回滚，后面 ${chat.folded} 轮收起了。接着写就从这里开新分支，原来的可以在下一条消息的 ‹ › 里切回。` }),
        el('button', { type: 'button', class: 'btn small', text: '恢复', disabled: ui.generating, onclick: () => restoreFolded() }),
      ]),
    )
  }
  box.replaceChildren(...nodes, ...liveNodes(chat))
  renderBranchNote()
  box.scrollTop = box.scrollHeight
  historyUi.refresh()
}

/** The turn being written in this chat, as far as it has come (also after switching back). */
function liveNodes(chat, { animate = false } = {}) {
  const job = ui.busy.get(chat.id)
  if (!job || job.kind === 'compact') return []
  const nodes = []
  if (job.echo) {
    const echo = renderNode(chat, { id: 'pending-user', role: 'user', text: job.echo, siblingCount: 1 }, false)
    if (animate) echo.classList.add('enter')
    nodes.push(echo)
  }
  const live = el('article', { class: `msg assistant streaming${animate ? ' enter' : ''}` }, [
    el('div', { class: 'msg-head' }, [speakerFace(chat, 'assistant'), el('span', { class: 'name', text: chat.names.char }), el('span', { class: 'live-note', text: job.note })]),
    el('div', { class: 'msg-body', html: job.text ? renderStory(streamingText(job.text)) : '' }),
  ])
  nodes.push(live)
  return nodes
}

/** Opened a chat the server is still writing (started from an earlier page): wait for it. */
function followServerTurn(view) {
  if (!view.running || ui.busy.has(view.id)) return
  ui.busy.set(view.id, { kind: 'server', text: '', note: '正在生成（之前的页面发起的，写完会自动显示）' })
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
  const name = isUser ? chat.names.user : chat.names.char
  const tools = []
  if (node.siblingCount > 1) {
    tools.push(
      el('button', { title: '上一个版本', text: '‹', disabled: node.siblingIndex === 0 || ui.generating, onclick: () => selectNode(node.siblingIds[node.siblingIndex - 1]) }),
      el('span', { class: 'swipe', text: `${node.siblingIndex + 1}/${node.siblingCount}` }),
      el('button', { title: '下一个版本', text: '›', disabled: node.siblingIndex === node.siblingCount - 1 || ui.generating, onclick: () => selectNode(node.siblingIds[node.siblingIndex + 1]) }),
    )
  }
  if (node.id !== 'root' && node.id !== 'pending-user' && !node.compaction) {
    tools.push(el('button', { text: '修改', title: '直接改这条消息的原文，模型之后看到的也是改过的；不重新生成', disabled: ui.generating, onclick: event => openEditor(chat, node, event.currentTarget.closest('.msg')) }))
  }
  if (!isUser && node.id !== 'root' && isLastAssistant) {
    tools.push(el('button', { text: '重新生成', disabled: ui.generating, onclick: () => regenerate(node.parent) }))
  }
  if (!isUser && isLastAssistant && (node.id !== 'root' || node.compaction)) {
    tools.push(el('button', { text: '导出存档', title: '把剧情存档、最近几轮原文和变量存成文件，可以在新对话或新版本的角色卡里接着写', disabled: ui.generating, onclick: () => exportStory(node) }))
  }
  if (!isUser && (node.id !== 'root' || node.compaction)) {
    tools.push(el('button', { text: '分支到新对话', title: '开一个新对话，只带上到这一条为止的剧情（之后的对话和其他版本都不带），原对话不变', disabled: ui.generating, onclick: () => forkChat(node.id) }))
  }
  if (!isUser && !isLastAssistant) {
    tools.push(el('button', { text: '回滚到这里', title: '收起之后的对话，状态也回到这一轮；随时可以恢复', disabled: ui.generating, onclick: () => rollbackTo(node.id) }))
    tools.push(el('button', { text: '从这里分支', disabled: ui.generating, onclick: () => branchFrom(node.id, `从「${node.text.slice(0, 16)}…」之后分支`) }))
  }
  if (isUser) {
    tools.push(el('button', { text: '编辑重发', disabled: ui.generating, onclick: () => { $('input').value = node.text; branchFrom(node.parent, '编辑重发：将作为这一轮的新版本') } }))
    if (node.injected?.length) tools.push(el('span', { class: 'chips' }, node.injected.map(t => el('span', { class: 'chip', title: '本轮注入的世界书', text: `📖 ${t}` }))))
  }
  if (!isUser && node.id !== 'pending-user') tools.push(mediaUi.toolsFor(node))
  if (!isUser && node.stateChanges?.length) {
    const changes = node.stateChanges
    const text = changes.length <= 3 ? `状态：${changes.join('、')}` : `状态更新 ${changes.length} 项`
    tools.push(el('span', { class: 'chip', title: changes.join('\n'), text }))
  }
  if (!isUser && node.historyTrim?.removedChars > 0) {
    tools.push(el('span', { class: 'chip', title: '按角色卡的「仅发送」正则，这条回复在之后的上下文里去掉了这些内容（比如变量更新块），显示不受影响', text: `上下文精简 ${fmt(node.historyTrim.removedChars)} 字` }))
  }
  if (!isUser && node.truncated) {
    tools.push(el('span', { class: 'chip warn', title: '模型写到了单次输出的上限，回复后半段（常见的是变量更新、行动选项这些放在最后的块）没写出来。上限取预设的「最大回复长度」；供应商设置里填了「最大输出」时以那个为准。可以重新生成，或调大上限。', text: '⚠ 写到输出上限，被截断' }))
  }
  if (node.edited) tools.push(el('span', { class: 'chip', title: `${new Date(node.edited.at).toLocaleString('zh-CN')} 改过${node.edited.count > 1 ? ` ${node.edited.count} 次` : ''}`, text: '已修改' }))
  if (isUser && node.templateErrors?.length) tools.push(el('span', { class: 'chip warn', title: node.templateErrors.join('\n'), text: `⚠ ${node.templateErrors.length} 条 EJS 模板出错` }))
  const scripts = scriptsFor(chat)
  const shown = displayOf(node, { scripts, names: chat.names, depth, withStatus: isLastAssistant && usesStatusPlaceholder(scripts) })
  const imported = node.compaction?.imported
  const recap = !isUser && node.compaction
    ? el('div', { class: 'compaction-note' }, [
        el('span', {
          text: imported
            ? `从剧情存档接着写：「${imported.title || imported.card || '导入的故事'}」前 ${node.compaction.turns} 轮 → ${fmt(node.compaction.chars)} 字存档，上面是存档里的最后一轮。`
            : `已压缩上下文：前 ${node.compaction.turns} 轮 → ${fmt(node.compaction.chars)} 字剧情存档，之后在新的上下文里接着写。`,
        }),
        el('button', { type: 'button', class: 'btn small', text: node.compaction.editable ? '查看 / 修改' : '查看', onclick: () => openRecap(node) }),
      ])
    : null
  return el('article', { class: `msg ${isUser ? 'user' : 'assistant'}${isLastAssistant ? ' latest' : ''}`, 'data-id': node.id }, [
    el('div', { class: 'msg-head' }, [speakerFace(chat, node.role), el('span', { class: 'name', text: name }), node.id === 'root' ? el('span', { text: imported ? '存档' : '开场' }) : null]),
    messageBody(shown, frameContextFor(chat, node)),
    isUser ? null : mediaUi.gallery(chat, node),
    tools.length ? el('div', { class: 'msg-tools' }, tools) : null,
    recap,
  ])
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
  const area = el('textarea', { class: 'edit-text', spellcheck: 'false', 'aria-label': '消息原文' })
  area.value = original
  const fit = () => {
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight + 2, innerHeight * 0.62)}px`
  }
  const count = el('span', { class: 'edit-count' })
  const blocks = el('div', { class: 'edit-blocks' })
  const refresh = () => {
    const now = area.value.length
    count.textContent = now === original.length ? `${fmt(now)} 字` : `${fmt(original.length)} → ${fmt(now)} 字`
    const found = tagBlocks(area.value)
    blocks.hidden = !found.length
    blocks.replaceChildren(
      el('span', { class: 'edit-blocks-label', text: '整块删掉' }),
      ...found.map(([tag, size]) =>
        el('button', {
          type: 'button',
          class: 'edit-block',
          title: `删掉所有 <${tag}>…</${tag}>`,
          onclick: () => {
            area.focus()
            area.select()
            // execCommand keeps the browser's undo (Ctrl+Z) working.
            const next = area.value.replace(blockPattern(tag), '').replace(/\n{3,}/g, '\n\n').trim()
            if (!document.execCommand('insertText', false, next)) area.value = next
            refresh()
            fit()
          },
        }, [el('code', { text: tag }), el('span', { text: `${fmt(size)} 字` })]),
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
          ? '已修改。这条在剧情存档之前，模型现在读的是存档，所以只改了显示'
          : outcome.missed && subscriptionPage
            ? subscriptionPage.EDIT_MISSED
            : '已修改。之后每轮按改过的内容发送，下一轮从这条起重新写一次缓存',
        6000,
      )
    } finally {
      saveButton.disabled = false
    }
  })
  const saveButton = el('button', { type: 'button', class: 'btn small primary', text: '保存', onclick: save })
  const editor = el('div', { class: 'msg-editor' }, [
    blocks,
    area,
    el('div', { class: 'edit-foot' }, [
      el('span', { class: 'edit-note', text: node.role === 'user' ? '改的是你这条输入；模型之后看到的也是改过的。' : '这是发给模型的原文，隐藏的状态块也在里面。删掉的内容之后不会再进上下文，已经算好的变量不变。' }),
      count,
      el('span', { class: 'edit-actions' }, [
        el('button', { type: 'button', class: 'btn small ghost', text: '取消', onclick: close }),
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

/** What a message's HTML may read: its floor, nearby messages, variables and saved storage. */
function frameContextFor(chat, node) {
  const index = chat.path.findIndex(n => n.id === node.id)
  if (index < 0) return null
  const last = chat.path.length - 1
  const floors = [...new Set([0, index - 1, index, last - 1, last].filter(i => i >= 0))].sort((a, b) => a - b)
  return {
    messageId: index,
    lastId: last,
    chatId: chat.id,
    cardId: chat.cardId,
    names: chat.names,
    vars: { message: node.state ?? {}, latest: chat.state ?? {}, ...storedVariables({ presetId: chat.presetId, cardId: chat.cardId }) },
    messages: floors.map(i => {
      const n = chat.path[i]
      return { message_id: i, name: n.role === 'user' ? chat.names.user : chat.names.char, role: n.role, message: n.raw ?? n.text ?? '', state: n.state ?? {} }
    }),
    storage: storedFrameStorage(),
    input: $('input').value,
    viewport: { width: innerWidth, height: innerHeight },
  }
}

function setDraft(text, focus = true) {
  const input = $('input')
  input.value = text
  fitInput()
  broadcastInput(text)
  if (focus) input.focus()
}

let lastFrameSend = 0

/** A card asked to send what is in the input box: once per few seconds, never mid-generation. */
async function frameSend() {
  if (!ui.chat || ui.generating) throw new Error('正在生成，稍后再试')
  if (Date.now() - lastFrameSend < 3000) throw new Error('发送太频繁')
  lastFrameSend = Date.now()
  await send()
}

/** Slash commands from card HTML: the input-box ones work; the model and chat editing stay out of reach. */
async function runFrameSlash(command) {
  let staged = null
  let output = ''
  for (const step of parseSlash(command)) {
    if (step.name === 'setinput') setDraft(step.text)
    else if (step.name === 'send') staged = step.text
    else if (step.name === 'trigger') {
      if (staged !== null) setDraft(staged, false)
      staged = null
      await frameSend()
    } else if (step.name === 'echo') toast(step.text)
    else if (step.name === 'pass') output = step.text
    else toast(`界面里的命令 /${step.name} 在这里不支持`)
  }
  // `/send` without `/trigger` adds a message in SillyTavern; here it waits in the input box.
  if (staged !== null) setDraft(staged)
  return output
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
  note.replaceChildren(el('span', { text: ui.branchFrom.label }), el('button', { type: 'button', text: '取消', onclick: () => { ui.branchFrom = null; renderBranchNote() } }))
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
  toast(`已回滚，收起了 ${ui.chat.folded} 轮`)
})

const forkChat = guard(async nodeId => {
  const chat = await api(`/api/chats/${ui.chat.id}/fork`, { method: 'POST', body: { nodeId } })
  await refreshChats()
  setChat(chat)
  toast(`已分支到新对话「${chat.title}」，原对话没动`, 5000)
})

const restoreFolded = guard(async () => {
  setChat(await api(`/api/chats/${ui.chat.id}/restore`, { method: 'POST', body: {} }))
  toast('已恢复')
})

// ─── Context compaction (server/recap.mjs) ──────────────────────────────

/** Switching models with at least this many new turns offers to compact first. */
const SUGGEST_COMPACT = 6

function askSwitch(turns) {
  const dialog = $('switch-dialog')
  $('switch-text').textContent =
    `缓存按模型区分，换模型后下一轮要把整段历史重新写一遍缓存。先把前面的剧情（上次压缩后新增 ${turns} 轮）压缩成存档，新模型只需读存档和最近两轮原文。` +
    '存档由现在这个模型来写，它的缓存还在，大约花一轮的额度。'
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

/** Ask the model that wrote the story for an archive. Resolves true when it was saved. */
async function runCompaction() {
  const chatId = ui.chat.id
  const title = ui.chat.title
  ui.busy.set(chatId, { kind: 'compact' })
  renderChat()
  renderChats()
  toast('正在写剧情存档，长对话大约要半分钟到一分钟……', 180000)
  try {
    const view = await api(`/api/chats/${chatId}/compact`, { method: 'POST', body: {} })
    ui.busy.delete(chatId)
    const info = view.path.at(-1).compaction
    if (ui.chat?.id === chatId) {
      setChat(view)
      toast(`已压缩：前 ${info.turns} 轮 → ${fmt(info.chars)} 字剧情存档。下一轮在新的上下文里接着写。`, 6000)
    } else {
      toast(`「${title}」已压缩：前 ${info.turns} 轮 → ${fmt(info.chars)} 字剧情存档。`, 6000)
    }
    return true
  } catch (error) {
    toast(error.status === 499 ? '已停止压缩，什么都没改' : error.message, 8000)
    return false
  } finally {
    ui.busy.delete(chatId)
    if (ui.chat?.id === chatId) renderChat()
    renderChats()
  }
}

const compactNow = guard(async () => {
  const model = ui.chat.path.at(-1).model
  const ask =
    '把前面的剧情压缩成一份存档？\n\n' +
    `会调用一次模型写存档（由写这段剧情的 ${labelOf(model || ui.chat.model || ui.defaultModel)} 来写，大约花一轮的额度）。` +
    '之后的对话在新的上下文里接着写。之前的内容不会删除，随时可以回滚到压缩之前。'
  if (confirm(ask)) await runCompaction()
})

function openRecap(node) {
  const info = node.compaction
  ui.recapNode = node.id
  $('recap-text').value = info.summary
  $('recap-text').readOnly = !info.editable
  $('recap-save').hidden = !info.editable
  $('recap-drop').hidden = !info.editable || Boolean(info.imported)
  const source = info.imported
    ? `从「${info.imported.title || info.imported.card || '剧情存档'}」导入，${info.model ? `${labelOf(info.model)} 写的，` : ''}`
    : `${labelOf(info.model)} 写的，`
  $('recap-meta').textContent =
    `${source}覆盖前 ${info.turns} 轮，${fmt(info.chars)} 字。` +
    (info.editable ? '还没接着写，可以直接修改，下一轮会带上改过的版本。' : '之后已经接着写了，这份存档只能查看；想换一份，可以回滚到这里再压缩。')
  $('recap-dialog').showModal()
}

const saveRecap = guard(async () => {
  setChat(await api(`/api/chats/${ui.chat.id}/compaction`, { method: 'PUT', body: { nodeId: ui.recapNode, summary: $('recap-text').value } }))
  $('recap-dialog').close()
  toast('存档已保存')
})

const dropRecap = guard(async () => {
  if (!confirm('撤销这次压缩？下一轮会照常接着原来的上下文写。')) return
  setChat(await api(`/api/chats/${ui.chat.id}/compaction?nodeId=${encodeURIComponent(ui.recapNode)}`, { method: 'DELETE' }))
  $('recap-dialog').close()
  toast('已撤销压缩')
})

// ─── Story archive: export / import (server/chats.mjs exportStory) ──────

const STORY_FORMAT = 'agent-tavern-story'

/** Save a JSON file, then toast `message` (one toast, so the Android note is not overwritten). */
function saveFile(name, text, message = '') {
  const filename = name.replace(/[\\/:*?"<>|]+/g, ' ').trim()
  // The Android WebView ignores <a download>; the app saves to Downloads itself.
  if (window.AgentTavernAndroid?.saveFile) {
    const ok = window.AgentTavernAndroid.saveFile(filename, text)
    toast(ok ? `已保存到「下载」文件夹。${message}` : '保存失败', 9000)
    return
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = el('a', { href: url, download: filename })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
  if (message) toast(message, 9000)
}

async function downloadStory(nodeId) {
  const archive = await api(`/api/chats/${ui.chat.id}/archive?nodeId=${encodeURIComponent(nodeId)}`)
  saveFile(`${archive.title} 剧情存档.json`, JSON.stringify(archive, null, 2),
    `已导出：前 ${archive.turns} 轮的剧情存档、最近 ${archive.recent.filter(m => m.role === 'user').length} 轮原文和变量。在角色卡下点「导入存档」就能接着写。`)
}

/**
 * Export from the latest reply. The summary must cover the story: with two or
 * more turns since the last compaction, compact first (one model call).
 */
const exportStory = guard(async node => {
  const chat = ui.chat
  if (!node.compaction && chat.compactable) {
    const ask =
      `导出前要先把剧情压缩成存档（上次压缩后新增 ${chat.compactable} 轮）。\n\n` +
      `会调用一次模型写存档（${labelOf(node.model || chat.model || ui.defaultModel)}，大约花一轮的额度），之后的对话也会接着这份存档写。继续？`
    if (!confirm(ask)) return
    if (!(await runCompaction())) return
    return downloadStory(ui.chat.path.at(-1).id)
  }
  const index = chat.path.findIndex(n => n.id === node.id)
  if (!chat.path.slice(0, index + 1).some(n => n.compaction)) throw new Error('剧情还不到 2 轮，先多写几轮再导出')
  await downloadStory(node.id)
})

const exportRecap = guard(async () => {
  await downloadStory(ui.recapNode)
})

/** Start a chat for the selected card from an archive. Returns a line for the import toast. */
async function importStory(archive) {
  if (!ui.cardId) throw new Error('先在左边选一张角色卡，存档会导入成它的新对话')
  const card = ui.cards.find(c => c.id === ui.cardId)
  if (archive.card && card && archive.card !== card.name && !confirm(`这份存档来自「${archive.card}」，要导入到「${card.name}」下接着写吗？`)) {
    return '存档没有导入'
  }
  const chat = await api('/api/chats/import', { method: 'POST', body: { cardId: ui.cardId, archive } })
  await refreshChats()
  setChat(chat)
  return `剧情存档「${archive.title || archive.card}」（${archive.turns} 轮）`
}

const PACKAGE_MAGIC = 'AGENT-TAVERN-CHAT 1\n'

/**
 * A whole chat from another device (server/transfer.mjs): the header creates the
 * chat under the card of the same name, then each picture is uploaded on its own.
 */
async function importPackageFile(file) {
  const head = await file.slice(0, 64).text()
  if (!head.startsWith(PACKAGE_MAGIC)) throw new Error(`「${file.name}」不是酒馆的对话包`)
  const line = head.slice(PACKAGE_MAGIC.length, head.indexOf('\n', PACKAGE_MAGIC.length))
  const start = new TextEncoder().encode(`${PACKAGE_MAGIC}${line}\n`).length
  const end = start + Number(line)
  const header = JSON.parse(await file.slice(start, end).text())
  const { media = [], ...rest } = header
  const result = await api('/api/chats/import-package', { method: 'POST', body: { cardId: ui.cardId, header: rest } })
  let failed = 0
  for (const [index, picture] of media.entries()) {
    toast(`「${result.chat.title}」：上传配图 ${index + 1}/${media.length}`, 2000)
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
  const notes = done.map(d => `「${d.chat.title}」→ ${d.cardName}${d.pictures ? `，配图 ${d.pictures - d.failed}/${d.pictures}` : ''}${d.missingPreset ? `，没有预设「${d.missingPreset}」，先导入它再到预设里选上` : ''}`)
  toast(`已导入 ${done.length} 段对话：${notes.join('；')}`, 10000)
}

const importStoryFile = guard(async file => {
  const json = await jsonOf(file)
  if (json?.format !== STORY_FORMAT) throw new Error('这不是酒馆导出的剧情存档')
  const line = await importStory(json)
  toast(line === '存档没有导入' ? line : `已导入${line}。下一轮在新的上下文里接着写。`, 6000)
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
  try {
    await stream(`/api/chats/${chatId}/${endpoint}`, body, event => {
      if (event.type === 'start') {
        job.note = event.newSession ? '接着存档续写' : event.api ? `${event.api} 续写` : event.fork ? '分支续写' : '续写'
        const note = live()?.querySelector('.live-note')
        if (note) note.textContent = job.note
        if (event.compacted?.removedChars && viewing()) toast(`已清掉历史里堆积的变量列表（${fmt(event.compacted.removedChars)} 字）。这一轮会重写对话历史的缓存，固定前缀还在。`)
      } else if (event.type === 'delta') {
        job.text += event.text
        const target = live()?.querySelector('.msg-body')
        if (target) {
          target.innerHTML = renderStory(streamingText(job.text))
          const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160
          if (nearBottom) box.scrollTop = box.scrollHeight
        }
      } else if (event.type === 'rate_limit') {
        ui.rateLimit = event.info
        renderQuota(event.info)
      } else if (event.type === 'done') {
        finished = event.chat
        finishedNode = event.nodeId
      } else if (event.type === 'error') {
        failure = event
      }
    })
  } catch (error) {
    failure = { message: error.message }
  }
  ui.busy.delete(chatId)
  if (finished) {
    if (viewing()) {
      setChat(finished)
      mediaUi.afterTurn(finishedNode)
    } else {
      toast(`「${title}」这一轮写好了`, 5000)
    }
    await refreshChats()
    return true
  }
  if (viewing()) renderChat()
  renderChats()
  if (failure && failure.status !== 499) toast(viewing() ? failure.message : `「${title}」：${failure.message}`, 8000)
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
  const ok = await generate('turn', { parentId, input: text }, text)
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
  $('state-view').textContent = chat ? (Object.keys(state).length ? JSON.stringify(state, null, 2) : '（这张卡没有状态变量）') : '—'
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
    ['缓存命中', el('span', { class: `hit ${hit >= 80 ? 'good' : 'mid'}`, text: `${hit}%` })],
    ['缓存读取', fmt(u.cacheRead)],
    ['缓存写入', fmt(u.cacheWrite)],
    ['未缓存输入', fmt(u.input)],
    ['输出', fmt(u.output)],
    ['首字', last.timing?.firstTokenMs ? `${(last.timing.firstTokenMs / 1000).toFixed(1)} 秒` : '—'],
    ['总耗时', last.timing ? `${(last.timing.totalMs / 1000).toFixed(1)} 秒` : '—'],
    ['方式', last.timing?.api ? 'API（按对话记录重发）' : last.timing?.forked ? '分支（fork）' : '续接（resume）'],
    ['模型', last.model ? labelOf(last.model) : '—'],
  ]
  // A relay that moves the same model to another upstream answers with another name, and that
  // upstream has none of the cache: say so, or a cache miss looks like the tavern's fault.
  if (last.served) {
    const provider = ref => String(ref ?? '').split('/')[0]
    const before = chat.path.slice(0, chat.path.indexOf(last)).reverse().find(n => n.role === 'assistant' && n.served && provider(n.model) === provider(last.model))
    const switched = before && before.served !== last.served
    rows.push(['返回的模型', el('span', { class: switched ? 'hit mid' : '', text: last.served })])
    if (switched && hit < 80) {
      rows.push(['提示', `供应商这轮换了上游（${before.served} → ${last.served}），缓存在新上游上没有，这不是酒馆的历史变了。中转一直这样的话，可以在供应商设置里换一个分组 / 线路，或问问中转方。`])
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
    throw new Error('状态不是合法的 JSON')
  }
  setChat(await api(`/api/chats/${ui.chat.id}/state`, { method: 'PUT', body: { state } }))
  toast('已保存，下一轮会把完整状态发给模型')
})

// ─── Settings ───────────────────────────────────────────────────────────
const openSettings = guard(async () => {
  settingsMenu ??= createMenu({ dialog: $('settings-dialog'), form: $('settings-form'), el, title: '设置' })
  ;[ui.settings, ui.persona, ui.books] = await Promise.all([api('/api/settings'), api('/api/persona'), api('/api/worldbooks')])
  if (!ui.models.length) await loadModels()
  const form = $('settings-form')
  $('settings-model').replaceChildren(...modelOptions(ui.defaultModel))
  form.personaName.value = ui.persona.name
  form.personaDescription.value = ui.persona.description
  for (const key of ['model', 'thinking', 'effort', 'language', 'scanDepth', 'reinjectAfter', 'stateRefreshEvery', 'dynamicStrip', 'replyLength', 'writingRules', 'listen']) {
    form[key].value = ui.settings[key] ?? (key === 'listen' ? 'local' : '')
  }
  renderAccess(await api('/api/access').catch(() => null))
  fillProxy(form, ui.settings.proxy, await api('/api/network').catch(() => null))
  if (!ui.models.some(m => m.id === form.model.value)) form.model.value = ui.defaultModel ?? ui.models[0]?.id ?? ''
  const card = ui.cards.find(c => c.id === ui.cardId)
  const options = $('book-options')
  if (!card) options.replaceChildren(document.createTextNode('先选择一张角色卡'))
  else if (!ui.books.length) options.replaceChildren(document.createTextNode('还没有导入独立世界书'))
  else {
    options.replaceChildren(
      ...ui.books.map(book =>
        el('label', {}, [el('input', { type: 'checkbox', name: 'book', value: book.id, checked: card.worldbookIds.includes(book.id) }), `${book.name}（${book.entries} 条）`]),
      ),
    )
  }
  const [providers, presets] = await Promise.all([api('/api/providers').catch(() => null), api('/api/presets').catch(() => [])])
  settingsMenu.start()
  layOutSettings({ form, card, providers: providers?.providers ?? [], presets })
  $('settings-dialog').showModal()
})

// The settings window as a menu (web/menu.js). Its pages are in index.html;
// they are taken out of the form once, then placed by every layout.
let settingsMenu = null
let settingsPages = null

/** The menu: 模型, 写作, 世界书与状态, 连接, 更多, each row with what it is set to now. */
function layOutSettings({ form, card, providers, presets }) {
  settingsPages ??= Object.fromEntries([...form.querySelectorAll('[data-section]')].map(page => [page.dataset.section, page]))
  const value = name => form.elements[name]?.value ?? ''
  const modelName = id => {
    const model = ui.models.find(m => m.id === id)
    return model ? `${model.group === 'Claude 订阅' ? '' : `${model.group} · `}${model.label}` : ''
  }
  const STRIP = { rare: '动态设定少清', often: '动态设定勤清', off: '动态设定不清' }
  const noChat = () => (ui.chat ? '' : '先打开一个对话')
  const sections = [
    {
      id: 'model', title: '默认模型', pane: settingsPages.model,
      summary: () => [modelName(value('model')) || '还没选', value('thinking') === 'off' ? '不思考' : '自适应思考', `努力 ${value('effort')}`].join(' · '),
      status: () => (value('model') ? null : ['warn', '没选模型']),
    },
    {
      id: 'providers', title: '模型供应商', look: 'shared', action: () => providersUi.open(),
      summary: () => (providers.length ? `${providers.length} 个：${providers.slice(0, 3).map(p => p.name).join('、')}${providers.length > 3 ? '…' : ''}` : '还没添加：接入 DeepSeek、OpenRouter、Anthropic 等'),
      status: () => (providers.length ? null : ['warn', '先添加一个']),
    },
    {
      id: 'persona', title: '你的角色', pane: settingsPages.persona,
      summary: () => `${value('personaName').trim() || '你'} · ${value('personaDescription').trim() ? '有角色设定' : '没写角色设定'}`,
    },
    {
      id: 'style', title: '文风与字数', pane: settingsPages.style,
      summary: () => [value('language').trim() || '简体中文', Number(value('replyLength')) > 0 ? `每轮约 ${value('replyLength')} 字` : '字数不限', value('writingRules').trim() ? '有文风要求' : '没写文风要求'].join(' · '),
    },
    {
      id: 'presets', title: '预设', look: 'shared', action: () => presetsUi.open(),
      summary: () => {
        const preferred = presets.find(p => p.id === ui.settings?.presetId)
        return presets.length ? `${presets.length} 个 · 新对话默认：${preferred?.name ?? '不用预设'}` : '还没导入：导入 SillyTavern 的 Chat Completion 预设'
      },
    },
    {
      id: 'scan', title: '扫描与状态', look: 'shared', tag: '所有对话', pane: settingsPages.scan,
      summary: () => `扫描最近 ${value('scanDepth')} 条 · 隔 ${value('reinjectAfter')} 轮再注入 · 每 ${value('stateRefreshEvery')} 轮重发状态 · ${STRIP[value('dynamicStrip')] ?? ''}`,
    },
    card && {
      id: 'books', title: '挂载的世界书', pane: settingsPages.books, crumb: `世界书与状态 · ${card.name}`,
      summary: () => {
        if (!ui.books.length) return '还没导入独立世界书'
        const names = [...form.querySelectorAll('input[name="book"]:checked')].map(input => ui.books.find(b => b.id === input.value)?.name).filter(Boolean)
        return names.length ? `${names.length} 本：${names.join('、')}` : '没挂独立世界书（卡里自带的照常生效）'
      },
    },
    {
      id: 'network', title: '网络代理', pane: settingsPages.network, hidden: () => document.documentElement.dataset.featureProxy === 'false',
      summary: () => {
        const mode = value('proxyMode')
        if (mode === 'none') return '不用代理（国内服务直连）'
        if (mode === 'manual') return `走 ${value('proxyUrl').trim() || '（还没填地址）'}`
        return ui.network?.mode === 'system' && ui.network.effective ? `跟随系统代理：${ui.network.effective}` : '跟随系统代理'
      },
      status: () => (ui.network?.locked ? ['', '启动参数指定'] : value('proxyMode') === 'system' && ui.network?.mode === 'system' && !ui.network.effective ? ['warn', '系统代理没开'] : null),
    },
    {
      id: 'access', title: '手机访问', look: 'shared', pane: settingsPages.access, hidden: () => document.documentElement.dataset.featureLan === 'false',
      summary: () => {
        if (value('listen') !== 'lan') return '仅这台电脑'
        return ui.access?.running === 'lan' ? `同一 WiFi 或 Tailscale · ${ui.access.links?.length ?? 0} 个链接` : '同一 WiFi 或 Tailscale（重启服务后生效）'
      },
    },
    {
      id: 'media', title: '配图与朗读', action: () => mediaUi.openSettings(),
      summary: () => '画图方式、朗读来源，每张卡的画风、名册和音色',
    },
    {
      id: 'show-prompt', title: '查看当前对话的提示词', look: 'shared',
      action: () => (ui.chat ? showPrompt() : toast('先打开一个对话')),
      summary: () => noChat() || '固定前缀和最近一轮发出去的内容',
    },
    {
      id: 'rebuild-prompt', title: '重建当前对话的前缀', look: 'shared',
      action: () => (!ui.chat ? toast('先打开一个对话') : ui.generating ? toast('正在生成，先停止') : rebuildPrompt()),
      summary: () => noChat() || '按现在的卡、设置和预设重写固定前缀，下一轮多写一次缓存',
    },
    {
      id: 'stop-server', title: '停止后台服务', look: 'shared', action: () => stopServer(), hidden: () => document.documentElement.dataset.edition === 'android',
      summary: () => '电脑和手机上的页面都会断开，下次从桌面图标打开',
    },
  ].filter(Boolean)
  const cardRow = card
    ? whoLine(el, { cardId: card.hasAvatar ? card.id : '', name: card.name, note: '这张卡挂的' })
    : el('p', { class: 'menu-who none', text: '选一张角色卡后，可以给它挂独立世界书。' })
  settingsMenu.mount({
    panels: [
      { id: 'model', title: '模型', icon: MENU_ICONS.model, rows: ['model', 'providers'] },
      { id: 'write', title: '写作', icon: MENU_ICONS.write, rows: ['persona', 'style', 'presets'] },
      { id: 'books', title: '世界书与状态', icon: MENU_ICONS.book, rows: ['scan', cardRow, 'books'] },
      { id: 'link', title: '连接', icon: MENU_ICONS.link, rows: ['network', 'access'] },
      { id: 'more', title: '更多', icon: MENU_ICONS.tools, rows: ['media', 'show-prompt', 'rebuild-prompt', 'stop-server'] },
    ],
    sections,
    note: '名字、角色设定和文风写进对话开局时的固定前缀，只对之后新开的对话生效；模型、思考、字数和世界书扫描随时生效。',
    save: { text: '保存', onClick: () => saveSettings() },
  })
}

const saveSettings = guard(async () => {
  const form = $('settings-form')
  const num = name => Number(form[name].value) || 0
  ;[, ui.settings] = await Promise.all([
    api('/api/persona', { method: 'PUT', body: { name: form.personaName.value.trim() || '你', description: form.personaDescription.value } }),
    api('/api/settings', {
      method: 'PUT',
      body: {
        model: form.model.value,
        thinking: form.thinking.value,
        effort: form.effort.value,
        language: form.language.value.trim() || '简体中文',
        writingRules: form.writingRules.value,
        scanDepth: Math.max(1, num('scanDepth')),
        reinjectAfter: num('reinjectAfter'),
        stateRefreshEvery: num('stateRefreshEvery'),
        dynamicStrip: form.dynamicStrip.value,
        replyLength: Math.max(0, num('replyLength')),
        listen: form.listen.value === 'lan' ? 'lan' : 'local',
        ...(form.proxyMode.disabled ? {} : { proxy: form.proxyMode.value === 'manual' ? form.proxyUrl.value.trim() : form.proxyMode.value }),
      },
    }),
  ])
  fillProxy(form, ui.settings.proxy, await api('/api/network').catch(() => null))
  if (ui.cardId) {
    const ids = [...form.querySelectorAll('input[name="book"]:checked')].map(i => i.value)
    await api(`/api/cards/${ui.cardId}/worldbooks`, { method: 'PUT', body: { ids } })
    await refreshCards()
  }
  const access = await api('/api/access').catch(() => null)
  renderAccess(access)
  settingsMenu?.markClean()
  settingsMenu?.refresh()
  toast(form.listen.value === 'lan' && access?.running !== 'lan' ? '已保存。重启服务后，手机才能连上。' : '设置已保存')
})

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
  const now = network.effective ? `现在走 ${network.effective}` : '现在不走代理'
  const via = network.mode === 'system' ? (network.source === 'windows' ? '（Windows 系统代理）' : network.source === 'env' ? '（环境变量 HTTPS_PROXY）' : '：系统代理没开') : ''
  status.textContent = locked ? `${now}。启动时用 --proxy 或 AGENT_TAVERN_PROXY 指定了代理，这里改不了。` : `${now}${via}。`
}

const ACCESS_KINDS = { wifi: '同一 WiFi', wired: '有线局域网', tailscale: 'Tailscale（出门用）', virtual: '虚拟网卡' }

function renderAccess(info) {
  ui.access = info
  const box = $('access-links')
  if (!box) return
  if (!info) {
    box.textContent = ''
    return
  }
  if (info.running !== 'lan') {
    box.textContent = info.saved === 'lan' ? '已设为局域网。重启服务后，这里会出现手机链接。' : '现在只能在这台电脑上打开。'
    return
  }
  const links = info.links ?? []
  if (!links.length) {
    box.textContent = '没有找到局域网地址。'
    return
  }
  const row = link =>
    el('div', { class: 'access-row' }, [
      el('span', { class: 'access-kind', text: ACCESS_KINDS[link.kind] ?? link.adapter }),
      el('code', { text: link.url }),
      el('button', {
        type: 'button',
        class: 'btn small',
        text: '复制',
        onclick: () => navigator.clipboard.writeText(link.url).then(() => toast('已复制'), () => toast('复制失败，请长按链接选择')),
      }),
    ])
  const main = links.filter(link => link.primary)
  // Nothing recognised as Wi-Fi / wired / Tailscale: show everything rather than hide the only links.
  if (!main.length) return box.replaceChildren(...links.map(row))
  const rest = links.filter(link => !link.primary)
  box.replaceChildren(
    ...main.map(row),
    ...(rest.length
      ? [el('details', { class: 'access-more' }, [el('summary', { text: `其他地址（${rest.length}），手机一般用不上` }), ...rest.map(row)])]
      : []),
  )
}

const rebuildPrompt = guard(async () => {
  if (!ui.chat) return
  if (!confirm('按现在的角色卡、设置和预设重新生成这个对话的固定前缀？历史不变；下一轮会重新写入一次缓存（大卡约占一轮的额度）。')) return
  setChat(await api(`/api/chats/${ui.chat.id}/preset`, { method: 'POST', body: {} }))
  toast('已重建固定前缀，下一轮生效')
})

// Tells the server a page is open. The desktop launcher's server exits about a
// minute after the last of these closes.
let presence = null
function holdPresence() {
  if (!window.EventSource) return
  presence = new EventSource('/api/presence')
}

const stopServer = guard(async () => {
  if (ui.generating) throw new Error('正在生成，先停止')
  if (!confirm('停止后台服务？这个窗口和手机上的页面都会断开，下次从桌面图标打开。')) return
  await api('/api/shutdown', { method: 'POST', body: {} })
  presence?.close()
  $('settings-dialog').close()
  toast('服务已停止，可以关掉这个窗口了')
})

const showPrompt = guard(async () => {
  const data = await api(`/api/chats/${ui.chat.id}/prompt`)
  $('prompt-system').textContent = data.systemPrompt
  $('prompt-chars').textContent = fmt(data.systemPrompt.length)
  $('prompt-turn').textContent = data.lastTurnPrompt || '（还没有发送过）'
  $('prompt-dialog').showModal()
})

// ─── Presets ────────────────────────────────────────────────────────────
const mediaUi = initMedia({
  api,
  el,
  toast,
  guard,
  getChat: () => ui.chat,
  getModels: () => ui.models,
  openProviders: () => providersUi.open(),
  saveFile,
})

const historyUi = initHistory({ el, getChat: () => ui.chat })

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
    }
    checkAuth()
  },
})

const presetsUi = initPresets({
  api, el, toast, guard, saveFile,
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
})

// ─── Quick switches: preset entries pinned in the preset editor ─────────

function quickEntries() {
  const detail = ui.presetDetails.get(ui.chat?.presetId)
  return (detail?.quick ?? []).map(id => detail.prompts?.find(p => p.id === id)).filter(Boolean)
}

function renderQuickButton() {
  const button = $('quick-open')
  button.hidden = !ui.chat || !quickEntries().length
  button.disabled = ui.generating
}

/** Entries placed after the chat history are sent every turn; the rest live in the frozen prefix. */
const needsRebuild = (entries, ids) => ids.some(id => entries.find(p => p.id === id)?.placement !== 'turn')

function openQuick() {
  const entries = quickEntries()
  const changed = new Map()
  const update = () => {
    $('quick-apply').disabled = !changed.size
    $('quick-hint').textContent = !changed.size
      ? '在「预设」里点条目右边的「快捷」，可以把它放到这里。改动会存进预设，并用到这个对话。'
      : needsRebuild(entries, [...changed.keys()])
        ? '应用后会重建这个对话的固定前缀，下一轮重写一次缓存。'
        : '这些条目每轮单独发送，应用后下一轮就生效，不影响缓存。'
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
  const presetId = ui.chat.presetId
  const rebuild = needsRebuild(quickEntries(), [...changed.keys()])
  await api(`/api/presets/${presetId}`, { method: 'PUT', body: { prompts: [...changed].map(([id, enabled]) => ({ id, enabled })) } })
  ui.presetDetails.delete(presetId)
  if (rebuild) setChat(await api(`/api/chats/${ui.chat.id}/preset`, { method: 'POST', body: {} }))
  await loadPresetDetail(presetId)
  renderQuickButton()
  $('quick-dialog').close()
  toast(rebuild ? '已应用。下一轮会重写一次缓存。' : '已应用，下一轮生效。')
})

// ─── Small interactions ─────────────────────────────────────────────────
/** The composer grows with its text, up to its max height. */
function fitInput() {
  const input = $('input')
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`
}

const THEMES = ['auto', 'light', 'dark']
const THEME_LABEL = { auto: '自动', light: '浅色', dark: '深色' }
function currentTheme() {
  return document.documentElement.dataset.theme || 'auto'
}
function renderThemeButton() {
  const theme = currentTheme()
  $('toggle-theme').textContent = THEME_LABEL[theme]
  $('toggle-theme').title = `主题：${THEME_LABEL[theme]}（点击切换）`
}
function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]
  if (next === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = next
  try { localStorage.setItem('theme', next) } catch { /* private mode: theme just isn't remembered */ }
  renderThemeButton()
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
  // On a phone the full placeholder wraps under the one-line box.
  if (matchMedia('(max-width: 560px)').matches) $('input').placeholder = '写下行动、对白或想看的发展'
  // Phones show a list dialog's list and its selected item one at a time (style.css .show-main).
  for (const layout of document.querySelectorAll('.preset-layout')) {
    // Capture phase: the provider list re-renders inside the item's own click
    // handler, after which the clicked item is no longer in the list.
    layout.addEventListener('click', event => {
      if (event.target.closest('.preset-list li, #provider-add')) layout.classList.add('show-main')
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
  listenForFrameHeights()
  installFrameBridge({
    toast: (_level, text) => toast(text),
    input: text => setDraft(text, false),
    slash: runFrameSlash,
    send: frameSend,
    ids: () => ({ presetId: ui.chat?.presetId ?? null, cardId: ui.chat?.cardId ?? null }),
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
    toast('已填进输入框，可以改一改再发送')
  })
  $('new-chat').addEventListener('click', newChat)
  $('import-story').addEventListener('change', event => {
    const packages = [...event.target.files].filter(file => /\.tavernchat$/i.test(file.name) || file.type === 'application/octet-stream')
    if (packages.length) {
      event.target.value = ''
      guard(importPackages)(packages)
      return
    }
    const file = event.target.files[0]
    event.target.value = ''
    if (file) importStoryFile(file)
  })
  $('recap-export').addEventListener('click', exportRecap)
  $('composer').addEventListener('submit', event => { event.preventDefault(); send() })
  $('input').addEventListener('input', () => {
    fitInput()
    broadcastInput($('input').value)
  })
  $('input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send() }
  })
  $('stop').addEventListener('click', stop)
  $('edit-state').addEventListener('click', editState)
  $('cancel-state').addEventListener('click', renderSide)
  $('save-state').addEventListener('click', saveState)
  $('open-settings').addEventListener('click', openSettings)
  $('open-usage').addEventListener('click', openUsage)
  $('open-presets').addEventListener('click', () => presetsUi.open())
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
  $('toggle-theme').addEventListener('click', cycleTheme)
  $('scrim').addEventListener('click', closeDrawers)
  renderThemeButton()
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
  bind()
  holdPresence()
  const status = await api('/api/status').catch(() => null)
  if (status?.edition) document.documentElement.dataset.edition = status.edition
  // data-feature-lan="false" and the like hide what this edition cannot do (style.css).
  ui.features = status?.features ?? {}
  for (const [key, value] of Object.entries(ui.features)) {
    if (typeof value === 'boolean') document.documentElement.dataset[`feature${key[0].toUpperCase()}${key.slice(1)}`] = String(value)
  }
  if (ui.features.subscription) {
    subscriptionPage = await import('/subscription.js').catch(() => null)
    document.querySelector('.brand-sub').textContent = '用 Claude 订阅游玩角色卡'
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
  ui.books = await api('/api/worldbooks').catch(() => [])
  await refreshCards()
  if (ui.cards[0]) await selectCard(ui.cards[0].id)
  else renderChat()
}

boot()
