// A card's Tavern Helper scripts on the page (server/card-scripts.mjs buttonsOf), and its 脚本按钮 on a bar above the
// input box. A script that only follows the variables runs on the server: its button is its event there. Every other
// enabled script starts here when the chat opens, as SillyTavern starts them, each in a sandboxed frame of its own
// (render.js htmlFrame with the Tavern Helper stand-in, compat.js), and stays while the chat is open; one loaded from
// an address only while 隐私与网络 → 加载酒馆助手脚本库 is on. What it puts on "SillyTavern's page" goes into its frame,
// and while there is something there the frame shows (compat.js reports it): as a big window when a button of its
// was just pressed, else as a small panel docked bottom right that does not cover the story (放大 makes it the big
// window). Put away, the script keeps running. What it needs of SillyTavern's own page that the stand-in has not (its
// chat list, its menus) does not work.
//
// The chat's preset may carry scripts too (server/preset-scripts.mjs): they start here the same way, before the card's
// (SillyTavern's order), and stop when the chat moves to another preset or the preset switches them off. A preset's
// script is the preset's own: its frame keeps its storage and asks what it may do under preset:<id>, not the card.
// Both may have a button of the same name: each shows, and each press reaches only its own script.
// Loaded only for a card or preset that has such scripts: app.js imports this when one does.
import { t } from '/i18n.js'
import { htmlFrame } from '/render.js'
import { librariesOn, storedScriptVariables } from '/compat.js'

const READY_MS = 8000
// After the chat is drawn: its own frames first.
const START_AFTER_MS = 800
// What a script shows this soon after a press of its button is that button's window.
const PRESS_SHOWS_MS = 5000
// What a script shows this soon after its frame is made is it coming back with the chat, not news of its own.
const COMING_BACK_MS = 15000
// The scripts whose window the player put away, by key (its owner's and its name), on this device: another chat, or
// the page loaded again, makes their frames anew, and they stay put away.
const AWAY_KEY = 'agentTavernScriptsAway'
const AWAY_KEPT = 200
// A script that uses Tavern Helper's preset or regex functions gets the chat's presets and regex in its frame (GET
// /api/chats/:id/th-preset): Tavern Helper answers those at once, not later.
const USES_PRESETS = /\b(?:getPreset|getLoadedPresetName|getPresetNames|replacePreset|updatePresetWith|setPreset|getTavernRegexes)\s*\(/

// A script that looks for SillyTavern's chat messages (a status bar put under the latest reply): its frame gets one to
// find (compat.js stubChat).
const LOOKS_FOR_CHAT = /\.mes(?:_text)?\b|#chat\b/

/** `</script>` in a script's own text would end the tag it is put in. */
const asModule = code => `<script type="module">${String(code).replace(/<\/script/gi, '<\\/script')}</script>`

/**
 * @param deps - { api, el, toast, getChat: () => the open chat, frameContext(chat): the latest floor's frame
 *   context, ownerContext(owner): what a preset's script frame has of its own instead of the card's (its storage,
 *   the addresses it may reach), serverEvent(type, args, owner): a button's event to the scripts on the server of
 *   'card' or 'preset' (app.js), onPresetChanged(answer): a script changed the chat's preset (app.js) }
 */
export function initCardScripts({ api, el, toast, getChat, frameContext, ownerContext, serverEvent, onPresetChanged }) {
  const bar = el('div', { class: 'script-bar', role: 'toolbar', 'aria-label': t`卡的脚本按钮`, hidden: true })
  document.querySelector('#composer .composer-box')?.before(bar)
  const title = el('h2', { class: 'script-window-title' })
  const body = el('div', { class: 'script-window-body' })
  const enlarge = el('button', { type: 'button', class: 'btn small ghost script-enlarge', text: t`放大`, title: t`在大窗口里看`, onclick: () => open(false) })
  // A layer always laid out, put away by being invisible (not a closed <dialog>, whose content is not laid out): the
  // scripts' frames keep their size while put away, for a script that measures what it draws.
  const head = el('div', { class: 'script-window-head' }, [
    title,
    el('div', { class: 'script-window-tools' }, [
      enlarge,
      el('button', { type: 'button', class: 'btn small ghost', text: t`收起`, title: t`收起窗口，脚本还在运行；右下角留一个小按钮，点它或脚本的按钮都会再打开`, onclick: () => close() }),
    ]),
  ])
  const panel = el('div', { class: 'script-window', role: 'dialog', 'aria-modal': 'true' }, [head, body])
  const windowBox = el('div', { class: 'script-layer', 'aria-hidden': 'true' }, [panel])
  // Not the click a drag of the docked panel ends with (it lands on the layer).
  let dragEnded = false
  windowBox.addEventListener('click', event => event.target === windowBox && !dragEnded && close())
  // Where a window put away with something still on it comes back: a small chip for each, where the docked panel
  // sits. A status bar has no button of its own to bring it back.
  const chips = el('div', { class: 'script-chips', role: 'toolbar', 'aria-label': t`收起的脚本窗口`, hidden: true })
  document.body.append(windowBox, chips)
  const isOpen = () => windowBox.classList.contains('open')
  const isDocked = () => windowBox.classList.contains('docked')
  /**
   * Docked, the panel sits above the input box and the script buttons, wherever they are on this screen; in the visual
   * novel, above its text box (or the input box over it, while that is open).
   */
  function placeDock() {
    const vn = document.querySelector('.stage.vn-on')
    const spots = vn ? [vn.querySelector('.vn-box'), vn.classList.contains('vn-compose') ? document.querySelector('#composer') : null] : [document.querySelector('#composer')]
    const tops = spots.map(node => node?.getBoundingClientRect().top).filter(top => top > 0)
    const top = tops.length ? Math.min(...tops) : 0
    if (top > 0) for (const box of [windowBox, chips]) box.style.setProperty('--dock-bottom', `${Math.max(12, Math.round(window.innerHeight - top + 8))}px`)
  }
  const placeIfShown = () => {
    if (isDocked() || !chips.hidden) placeDock()
    if (isDocked()) placeSpot()
  }
  window.addEventListener('resize', placeIfShown)

  // The docked panel dragged by its title row to where the player wants it, and resized by its edges and corners, both
  // kept on this device; a double click there puts it back above the input box, at its first size.
  const SPOT_KEY = 'agentTavernScriptDock'
  let spot = (() => {
    try {
      const kept = JSON.parse(localStorage.getItem(SPOT_KEY) || 'null')
      return kept && Number.isFinite(kept.x) && Number.isFinite(kept.y) ? kept : null
    } catch {
      return null
    }
  })()
  const keepSpot = () => {
    try {
      if (spot) localStorage.setItem(SPOT_KEY, JSON.stringify(spot))
      else localStorage.removeItem(SPOT_KEY)
    } catch {}
  }
  /** Where `spot` puts the panel, kept inside the window (a smaller window, a phone turned). */
  function placeSpot() {
    windowBox.classList.toggle('moved', Boolean(spot))
    if (!spot) return
    const x = Math.min(Math.max(0, spot.x), Math.max(0, window.innerWidth - panel.offsetWidth))
    const y = Math.min(Math.max(0, spot.y), Math.max(0, window.innerHeight - panel.offsetHeight))
    panel.style.setProperty('--dock-x', `${Math.round(x)}px`)
    panel.style.setProperty('--dock-y', `${Math.round(y)}px`)
    return { x, y }
  }
  head.addEventListener('pointerdown', event => {
    if (!isDocked() || event.button !== 0 || event.target.closest('button')) return
    event.preventDefault()
    const box = panel.getBoundingClientRect()
    const dx = event.clientX - box.left
    const dy = event.clientY - box.top
    // The whole layer takes the pointer while dragging: over a frame (the story's, a script's) the moves would go to it.
    windowBox.classList.add('dragging')
    const move = moved => {
      spot = { x: moved.clientX - dx, y: moved.clientY - dy }
      spot = placeSpot()
    }
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      windowBox.classList.remove('dragging')
      dragEnded = true
      setTimeout(() => { dragEnded = false }, 0)
      keepSpot()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  })
  // The docked panel's size: its width and its frame's height (--size-w, --size-body in style.css). Resized by a top or
  // left edge while above the input box, it stays there; by a right or bottom edge it stays where the player put it.
  const SIZE_KEY = 'agentTavernScriptDockSize'
  let size = null
  let forgetSize = () => {}
  const applySize = () => {
    for (const [name, value] of [['--size-w', size?.w], ['--size-body', size?.h]]) {
      if (value) panel.style.setProperty(name, `${Math.round(value)}px`)
      else panel.style.removeProperty(name)
    }
  }
  // Loaded when it can be: an older server that has not the file still has the panel, without resizing.
  import('/resize-grips.js').then(({ addResizeGrips, readSize, keepSize }) => {
    size = readSize(SIZE_KEY)
    applySize()
    forgetSize = () => keepSize(SIZE_KEY, null)
    addResizeGrips(panel, {
      el,
      min: { w: 260, h: 180 },
      allowed: isDocked,
      // As for a drag: the layer takes the pointer, not the frames under it.
      onStart: () => windowBox.classList.add('dragging'),
      onResize: (box, edge) => {
        const chrome = panel.offsetHeight - body.offsetHeight
        size = { w: box.w, h: Math.max(80, box.h - chrome) }
        applySize()
        if (spot || /[es]/.test(edge)) {
          spot = { x: box.left, y: box.top }
          spot = placeSpot()
        }
      },
      onEnd: () => {
        windowBox.classList.remove('dragging')
        dragEnded = true
        setTimeout(() => { dragEnded = false }, 0)
        keepSize(SIZE_KEY, size)
        keepSpot()
      },
    })
  }).catch(() => {})
  head.addEventListener('dblclick', event => {
    if (!isDocked() || event.target.closest('button')) return
    spot = null
    keepSpot()
    size = null
    applySize()
    forgetSize()
    placeSpot()
  })
  // The visual novel turned on or off, its input box opened or put away.
  const stage = document.querySelector('.stage')
  if (stage) new MutationObserver(() => requestAnimationFrame(placeIfShown)).observe(stage, { attributes: true, attributeFilter: ['class'] })

  const away = new Set((() => {
    try {
      const kept = JSON.parse(localStorage.getItem(AWAY_KEY) || '[]')
      return Array.isArray(kept) ? kept.filter(key => typeof key === 'string') : []
    } catch {
      return []
    }
  })())
  /** The player put a script's window away (on), or brought it back. */
  function setDismissed(entry, on) {
    entry.dismissed = on
    const key = entry.frame.dataset.script
    if (away.has(key) === on) return
    if (on) away.add(key)
    else away.delete(key)
    try {
      localStorage.setItem(AWAY_KEY, JSON.stringify([...away].slice(-AWAY_KEPT)))
    } catch {}
  }
  // Which script's window was in front when its chat was left, the latest the highest: it is in front again when
  // several come back.
  const fronts = new Map()
  let frontCount = 0

  /** A chip for each script the player put away while it still has something on it; pressed, it comes back docked. */
  function drawChips() {
    const put = [...frames.values()].filter(entry => entry.visible && entry.dismissed && entry.frame.dataset.script !== showing)
    chips.replaceChildren(...put.map(entry => el('button', {
      type: 'button',
      class: 'btn small script-chip',
      text: entry.label,
      title: t`打开「${entry.label}」`,
      onclick: () => {
        setDismissed(entry, false)
        showFrame(entry, true)
      },
    })))
    // Not over the window while it is open: they come back when it is put away.
    chips.hidden = !put.length || isOpen()
    if (!chips.hidden) placeDock()
  }
  /** Shown as the big window, or docked (the small panel bottom right). */
  function open(docked) {
    if (docked) placeDock()
    windowBox.classList.add('open')
    windowBox.classList.toggle('docked', docked)
    if (docked) placeSpot()
    head.title = docked ? t`按住标题拖到想放的地方，拖边角调大小；双击标题回到右下角、恢复原来的大小` : ''
    panel.setAttribute('aria-modal', docked ? 'false' : 'true')
    enlarge.hidden = !docked
    windowBox.setAttribute('aria-hidden', 'false')
    drawChips()
  }
  /**
   * The window put away. Another script with something on it that the player has not put away comes back docked
   * (a floating panel the big window covered), unless `next` is false.
   */
  function putAway({ next = true } = {}) {
    windowBox.classList.remove('open', 'docked')
    windowBox.setAttribute('aria-hidden', 'true')
    const was = showing
    showing = null
    const waiting = next ? [...frames.values()].find(entry => entry.visible && !entry.dismissed && entry.frame.dataset.script !== was) : null
    if (waiting) showFrame(waiting, true)
    else drawChips()
  }
  /** The player puts the window away: what it shows stays away until its button is pressed, though it changes. */
  function close() {
    const entry = showing ? frames.get(showing) : null
    if (entry) setDismissed(entry, true)
    putAway()
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen() && !isDocked()) close()
  })

  // For the chat open now: whose scripts (`owners`: its card and preset as they were read), the scripts, the frames
  // made so far (script key → { frame, ready, … }) and the presets for the scripts that read them.
  let shown = { chatId: '', owners: '', list: null, presets: null }
  const frames = new Map()
  let showing = null // the key of the script whose frame the window shows
  let starting = 0 // which start of the chat's scripts is current (a later chat drops an earlier one)

  function dropFrames() {
    if (showing) fronts.set(showing, ++frontCount)
    putAway({ next: false })
    body.replaceChildren()
    frames.clear()
    showing = null
    starting++
    drawChips()
  }

  /** A list of the server's (buttonsOf) as this page keeps it: each script and button says whose it is. */
  function tagged(list, owner) {
    return {
      page: (list?.page ?? []).map(script => ({ ...script, ...owner, key: `${owner.ownerKey}/${script.name}` })),
      server: (list?.server ?? []).map(item => ({ ...item, ...owner })),
    }
  }

  /**
   * The bar for `chat` (null: none open). A chat of another card or preset, or a preset whose scripts changed, drops
   * the frames of the one before and starts its own.
   * @param which - { card: the card has scripts for the page, preset: { id, name, sign } when the chat's preset has
   *   (sign changes with its scripts and switches), else null }
   */
  async function show(chat, which = {}) {
    const preset = chat && which.preset ? which.preset : null
    const owners = chat ? JSON.stringify([chat.cardId, which.card === true, preset?.id ?? '', preset?.sign ?? '']) : ''
    const fresh = !chat || chat.id !== shown.chatId || owners !== shown.owners
    if (fresh) dropFrames()
    if (!chat) {
      shown = { chatId: '', owners: '', list: null, presets: null }
      bar.hidden = true
      return
    }
    if (owners !== shown.owners || !shown.list) {
      shown = { chatId: chat.id, owners, list: null, presets: null }
      const none = { page: [], server: [] }
      const [own, presetList] = await Promise.all([
        which.card ? api(`/api/cards/${chat.cardId}/script-buttons`).catch(() => null) : none,
        preset ? api(`/api/presets/${preset.id}/script-buttons`).catch(() => null) : none,
      ])
      if (shown.owners !== owners) return
      const fromPreset = tagged(presetList, { owner: 'preset', ownerKey: `preset:${preset?.id}`, ownerName: preset?.name ?? '' })
      const fromCard = tagged(own, { owner: 'card', ownerKey: chat.cardId, ownerName: '' })
      shown.list = { page: [...fromPreset.page, ...fromCard.page], server: [...fromPreset.server, ...fromCard.server] }
    }
    shown.chatId = chat.id
    const titleOf = item => (item.owner === 'preset' ? t`预设「${item.ownerName}」的「${item.script}」脚本的按钮` : t`「${item.script}」脚本的按钮`)
    const buttons = [
      ...shown.list.server.map(item => ({ label: item.name, title: titleOf(item), owner: item.owner, press: () => serverEvent(item.name, [], item.owner) })),
      ...shown.list.page.flatMap(script => script.buttons.map(name => ({ label: name, title: titleOf({ ...script, script: script.name }), owner: script.owner, press: () => pressOnPage(script, name) }))),
    ]
    bar.replaceChildren(...buttons.map(item => el('button', {
      type: 'button',
      class: `btn small script-btn${item.owner === 'preset' ? ' from-preset' : ''}`,
      text: item.label,
      title: item.title,
      onclick: () => Promise.resolve(item.press()).catch(error => toast(error.message, 6000)),
    })))
    bar.hidden = !buttons.length
    if (fresh) startAll(chat.id)
  }

  /** Every page script of the chat, started one after another once the chat is drawn: the preset's, then the card's. */
  async function startAll(chatId) {
    const run = starting
    await new Promise(resolve => setTimeout(resolve, START_AFTER_MS))
    if (shown.list?.page.some(script => USES_PRESETS.test(script.content))) {
      const presets = await api(`/api/chats/${chatId}/th-preset`).catch(() => null)
      if (run !== starting) return
      shown.presets = presets
    }
    for (const script of shown.list?.page ?? []) {
      if (run !== starting || shown.chatId !== chatId) return
      if (script.remote && !librariesOn()) continue
      try {
        await frameOf(script).ready
      } catch {
        return // no chat open any more
      }
    }
  }

  /** The script's frame, made when the chat opens or at its first press: loaded when `ready` resolves. */
  function frameOf(script) {
    const made = frames.get(script.key)
    if (made) return made
    const chat = getChat()
    const context = chat ? frameContext(chat) : null
    if (!context) throw new Error(t`没有打开的对话`)
    const own = script.owner === 'preset' ? { owner: script.ownerKey, ...ownerContext(script.ownerKey) } : {}
    const presets = shown.presets && USES_PRESETS.test(script.content) ? { presets: shown.presets } : {}
    // Its own variables: what its author shipped (its data), as it last saved them here.
    const vars = { ...context.vars, script: storedScriptVariables(script.key, script.data) }
    const frame = htmlFrame(asModule(script.content), { ...context, ...own, ...presets, vars, scriptFrame: script.name, stubChat: LOOKS_FOR_CHAT.test(script.content) })
    frame.classList.add('script-frame')
    frame.removeAttribute('loading')
    frame.dataset.script = script.key
    const ready = new Promise(resolve => {
      const timer = setTimeout(resolve, READY_MS)
      // Its own setup (`$(fn)`, after waitGlobalInitialized) runs right after it loads.
      frame.addEventListener('load', () => {
        clearTimeout(timer)
        setTimeout(resolve, 150)
      }, { once: true })
    })
    body.append(frame)
    const label = script.owner === 'preset' ? t`${script.name}（预设）` : script.name
    const entry = { frame, ready, visible: false, pressedAt: 0, madeAt: Date.now(), dismissed: away.has(script.key), label }
    frames.set(script.key, entry)
    return entry
  }

  async function pressOnPage(script, name, args = []) {
    if (script.remote && !librariesOn()) throw new Error(t`「${script.name}」要从网上加载，先在 设置 → 更多 → 隐私与网络 里打开「加载酒馆助手脚本库」`)
    const entry = frameOf(script)
    entry.pressedAt = Date.now()
    setDismissed(entry, false)
    await entry.ready
    entry.frame.contentWindow?.postMessage({ agentTavernButton: name, args }, '*')
    // Its window put away with something still on it: a press brings it back (the frame says nothing new then).
    if (entry.visible) showFrame(entry, false)
  }

  function showFrame(entry, docked) {
    for (const other of frames.values()) other.frame.classList.toggle('shown', other === entry)
    showing = entry.frame.dataset.script
    title.textContent = entry.label
    open(docked)
  }

  /**
   * A card event another frame emitted (a status bar's button): to the page scripts that listen for it, the preset's
   * and the card's, their frame made if it is not yet. Not back to the frame it came from.
   */
  async function deliver(type, args = [], from = '') {
    for (const script of shown.list?.page ?? []) {
      if (!script.events.includes(type)) continue
      if (script.remote && !librariesOn()) continue
      if (frames.get(script.key)?.frame.dataset.frame === from) continue
      await pressOnPage(script, type, args)
    }
  }

  /**
   * A script frame says whether it has something on it (compat.js): the window shows it (big right after a press of
   * its button, docked otherwise), or is put away.
   */
  function scriptView({ visible }, context = {}) {
    const entry = [...frames.values()].find(item => item.frame.dataset.frame === context.frame)
    if (!entry) return
    entry.visible = visible
    const name = entry.frame.dataset.script
    if (!visible) {
      if (showing === name) putAway()
      else drawChips()
      return
    }
    const pressed = Date.now() - entry.pressedAt < PRESS_SHOWS_MS
    if (pressed) return showFrame(entry, false)
    if (entry.dismissed) return drawChips()
    // The big window open on another script stays; this one waits for its button or that window to close.
    if (isOpen() && !isDocked() && showing !== name) return
    // Come back with the chat behind the one that was in front: it waits for that one to be put away.
    const front = key => fronts.get(key) ?? 0
    if (showing && showing !== name && Date.now() - entry.madeAt < COMING_BACK_MS && front(showing) > front(name)) return
    showFrame(entry, isOpen() && showing === name ? isDocked() : true)
  }

  /**
   * A script asked to change a preset (replacePreset and the rest, compat.js): saved, the chat's prefix built again
   * when it is the one in use, and every script frame that reads presets told of it.
   */
  async function changePreset({ name, preset }) {
    const chat = getChat()
    if (!chat) throw new Error(t`没有打开的对话`)
    const answer = await api(`/api/chats/${chat.id}/th-preset`, { method: 'PUT', body: { name, preset } })
    if (answer?.info) {
      shown.presets = answer.info
      for (const entry of frames.values()) entry.frame.contentWindow?.postMessage({ agentTavernPresets: answer.info }, '*')
    }
    if (answer?.changed) onPresetChanged?.(answer, chat.id)
    return { changed: Boolean(answer?.changed), info: answer?.info ?? null }
  }

  /** Whether a frame is one of the scripts' (its owner is then the preset or the card it was made for). */
  const isScriptFrame = frameId => [...frames.values()].some(entry => entry.frame.dataset.frame === frameId)

  return { show, scriptView, deliver, changePreset, isScriptFrame }
}
