// A card's Tavern Helper scripts on the page (server/card-scripts.mjs buttonsOf), and its 脚本按钮 on a bar above the
// input box. A script that only follows the variables runs on the server: its button is its event there. Every other
// enabled script starts here when the chat opens, as SillyTavern starts them, each in a sandboxed frame of its own
// (render.js htmlFrame with the Tavern Helper stand-in, compat.js), and stays while the chat is open; one loaded from
// an address only while 隐私与网络 → 加载酒馆助手脚本库 is on. What it puts on "SillyTavern's page" goes into its frame,
// and while there is something there the frame shows (compat.js reports it): as a big window when a button of its
// was just pressed, else as a small panel docked bottom right that does not cover the story (放大 makes it the big
// window). Put away, the script keeps running. What it needs of SillyTavern's own page that the stand-in has not (its
// chat list, its menus) does not work.
// Loaded only for a card that has such scripts: app.js imports this when one does.
import { t } from '/i18n.js'
import { htmlFrame } from '/render.js'
import { librariesOn } from '/compat.js'

const READY_MS = 8000
// After the chat is drawn: its own frames first.
const START_AFTER_MS = 800
// What a script shows this soon after a press of its button is that button's window.
const PRESS_SHOWS_MS = 5000

/** `</script>` in a script's own text would end the tag it is put in. */
const asModule = code => `<script type="module">${String(code).replace(/<\/script/gi, '<\\/script')}</script>`

/**
 * @param deps - { api, el, toast, getChat: () => the open chat, frameContext(chat): the latest floor's frame
 *   context, serverEvent(type, args): a card event to the scripts on the server (app.js) }
 */
export function initCardScripts({ api, el, toast, getChat, frameContext, serverEvent }) {
  const bar = el('div', { class: 'script-bar', role: 'toolbar', 'aria-label': t`卡的脚本按钮`, hidden: true })
  document.querySelector('#composer .composer-box')?.before(bar)
  const title = el('h2', { class: 'script-window-title' })
  const body = el('div', { class: 'script-window-body' })
  const enlarge = el('button', { type: 'button', class: 'btn small ghost script-enlarge', text: t`放大`, title: t`在大窗口里看`, onclick: () => open(false) })
  // A layer always laid out, put away by being invisible (not a closed <dialog>, whose content is not laid out): the
  // scripts' frames keep their size while put away, for a script that measures what it draws.
  const panel = el('div', { class: 'script-window', role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'script-window-head' }, [
      title,
      el('div', { class: 'script-window-tools' }, [
        enlarge,
        el('button', { type: 'button', class: 'btn small ghost', text: t`收起`, title: t`收起窗口，脚本还在运行；再按它的按钮会打开`, onclick: () => close() }),
      ]),
    ]),
    body,
  ])
  const windowBox = el('div', { class: 'script-layer', 'aria-hidden': 'true' }, [panel])
  windowBox.addEventListener('click', event => event.target === windowBox && close())
  document.body.append(windowBox)
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
    if (top > 0) windowBox.style.setProperty('--dock-bottom', `${Math.max(12, Math.round(window.innerHeight - top + 8))}px`)
  }
  window.addEventListener('resize', () => isDocked() && placeDock())
  // The visual novel turned on or off, its input box opened or put away.
  const stage = document.querySelector('.stage')
  if (stage) new MutationObserver(() => isDocked() && requestAnimationFrame(placeDock)).observe(stage, { attributes: true, attributeFilter: ['class'] })
  /** Shown as the big window, or docked (the small panel bottom right). */
  function open(docked) {
    if (docked) placeDock()
    windowBox.classList.add('open')
    windowBox.classList.toggle('docked', docked)
    panel.setAttribute('aria-modal', docked ? 'false' : 'true')
    enlarge.hidden = !docked
    windowBox.setAttribute('aria-hidden', 'false')
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
  }
  /** The player puts the window away: what it shows stays away until its button is pressed, though it changes. */
  function close() {
    const entry = showing ? frames.get(showing) : null
    if (entry) entry.dismissed = true
    putAway()
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen() && !isDocked()) close()
  })

  // For the chat open now: its card, its scripts, and the frames made so far (script name → { frame, ready, … }).
  let shown = { chatId: '', cardId: '', list: null }
  const frames = new Map()
  let showing = null // the script whose frame the window shows
  let starting = 0 // which start of the chat's scripts is current (a later chat drops an earlier one)

  function dropFrames() {
    putAway({ next: false })
    body.replaceChildren()
    frames.clear()
    showing = null
    starting++
  }

  /** The bar for `chat` (null: none open). A chat of another card drops the frames of the one before. */
  async function show(chat) {
    const fresh = !chat || chat.cardId !== shown.cardId || chat.id !== shown.chatId
    if (fresh) dropFrames()
    if (!chat) {
      shown = { chatId: '', cardId: '', list: null }
      bar.hidden = true
      return
    }
    if (chat.cardId !== shown.cardId || !shown.list) {
      shown = { chatId: chat.id, cardId: chat.cardId, list: null }
      const list = await api(`/api/cards/${chat.cardId}/script-buttons`).catch(() => null)
      if (shown.cardId !== chat.cardId) return
      shown.list = list ?? { page: [], server: [] }
    }
    shown.chatId = chat.id
    const buttons = [
      ...shown.list.server.map(item => ({ label: item.name, script: item.script, press: () => serverEvent(item.name, []) })),
      ...shown.list.page.flatMap(script => script.buttons.map(name => ({ label: name, script: script.name, press: () => pressOnPage(script, name) }))),
    ]
    bar.replaceChildren(...buttons.map(item => el('button', {
      type: 'button',
      class: 'btn small script-btn',
      text: item.label,
      title: t`「${item.script}」脚本的按钮`,
      onclick: () => Promise.resolve(item.press()).catch(error => toast(error.message, 6000)),
    })))
    bar.hidden = !buttons.length
    if (fresh) startAll(chat.id)
  }

  /** Every page script of the chat, started one after another once the chat is drawn. */
  async function startAll(chatId) {
    const run = starting
    await new Promise(resolve => setTimeout(resolve, START_AFTER_MS))
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
    const made = frames.get(script.name)
    if (made) return made
    const chat = getChat()
    const context = chat ? frameContext(chat) : null
    if (!context) throw new Error(t`没有打开的对话`)
    const frame = htmlFrame(asModule(script.content), { ...context, scriptFrame: script.name })
    frame.classList.add('script-frame')
    frame.removeAttribute('loading')
    frame.dataset.script = script.name
    const ready = new Promise(resolve => {
      const timer = setTimeout(resolve, READY_MS)
      // Its own setup (`$(fn)`, after waitGlobalInitialized) runs right after it loads.
      frame.addEventListener('load', () => {
        clearTimeout(timer)
        setTimeout(resolve, 150)
      }, { once: true })
    })
    body.append(frame)
    const entry = { frame, ready, visible: false, pressedAt: 0, dismissed: false }
    frames.set(script.name, entry)
    return entry
  }

  async function pressOnPage(script, name, args = []) {
    if (script.remote && !librariesOn()) throw new Error(t`「${script.name}」要从网上加载，先在 设置 → 更多 → 隐私与网络 里打开「加载酒馆助手脚本库」`)
    const entry = frameOf(script)
    entry.pressedAt = Date.now()
    entry.dismissed = false
    await entry.ready
    entry.frame.contentWindow?.postMessage({ agentTavernButton: name, args }, '*')
    // Its window put away with something still on it: a press brings it back (the frame says nothing new then).
    if (entry.visible) showFrame(entry, false)
  }

  function showFrame(entry, docked) {
    for (const other of frames.values()) other.frame.classList.toggle('shown', other === entry)
    showing = entry.frame.dataset.script
    title.textContent = showing
    open(docked)
  }

  /**
   * A card event another frame emitted (a status bar's button): to the page scripts that listen for it, their frame
   * made if it is not yet. Not back to the frame it came from.
   */
  async function deliver(type, args = [], from = '') {
    for (const script of shown.list?.page ?? []) {
      if (!script.events.includes(type)) continue
      if (script.remote && !librariesOn()) continue
      if (frames.get(script.name)?.frame.dataset.frame === from) continue
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
      return
    }
    const pressed = Date.now() - entry.pressedAt < PRESS_SHOWS_MS
    if (pressed) return showFrame(entry, false)
    if (entry.dismissed) return
    // The big window open on another script stays; this one waits for its button or that window to close.
    if (isOpen() && !isDocked() && showing !== name) return
    showFrame(entry, isOpen() && showing === name ? isDocked() : true)
  }

  return { show, scriptView, deliver, refresh: () => show(getChat()) }
}
