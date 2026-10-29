// 视觉小说模式: the latest reply shown a line at a time in a text box over the
// chat, like a visual novel — a name plate when the speaker can be told, the
// ones in the scene standing on the stage (立绘 cut out of a plain background,
// the speaker lit, each with the expression their lines last showed), a shake
// or a flash where the narration plainly calls for one, the place as a small
// sign over its background, choices as buttons at the end, save slots
// (web/vn-saves.js). On or off per card (localStorage). It only reads the chat:
// what the model is sent never changes. The transcript keeps rendering underneath.
import { t } from '/i18n.js'
import { htmlFrame, segments, streamingText } from '/render.js'
import { timeBox } from '/status.js'
import { advanceDay, latestPlace, matchScene, normalizePlace, opensNextDay, placeIn, sameLine, speakerNames, splitLines, stateTime, storyDay, timeOfDay, timesIn, weatherOf } from '/shared/vn.js'
import { cutOut, spriteFrame } from '/shared/cutout.js'
import { EXPRESSIONS, PACK_PICTURE, packFaces, stageAt } from '/shared/stage.js'
import { initVnSaves } from '/vn-saves.js'
import { initVnHud } from '/vn-hud.js'
import { changeNotes } from '/shared/hud.js'
import { shrink } from '/theme.js'
import { VN_ID, isBuiltinPreset } from '/shared/basic.js'
import { historyStrip, keptItems } from '/draw-choice.js'

const MODE_KEY = 'cicatavern.vnMode'
const PREFS_KEY = 'cicatavern.vnPrefs'
// A scene drawn for one turn (画这一轮的场景) stays this chat's background while the place is the same.
const PINS_KEY = 'cicatavern.vnPins'
// Tried at least once: the top bar's switch stops calling for attention.
const TRIED_KEY = 'cicatavern.vnTried'
// 视觉小说格式 (【名字|表情】「…」) switched on or off by hand, per card: { cardId: boolean }.
const FORMAT_KEY = 'cicatavern.vnFormat'
// 视觉小说预设 offered on going into the mode: 'never' once the player said 不再提示.
const PRESET_OFFER_KEY = 'cicatavern.vnPresetOffer'
const SPEEDS = { slow: 25, normal: 45, fast: 90, instant: 0 }
const SPEED_LABEL = { slow: t`慢`, normal: t`中`, fast: t`快`, instant: t`瞬间` }
// A place with no background, a speaker with no 立绘: draw one at once, offer to, or leave it.
const NEW_ART = { auto: t`自动画`, ask: t`先问`, off: t`不画` }
const LOG_REPLIES = 20
const SPRITE_SIDE = 1400
// Where the ones on stage stand (percent across), by how many there are.
const SLOTS = { 1: [50], 2: [32, 68], 3: [20, 50, 80] }
const FACE_LABEL = { neutral: t`平静`, smile: t`微笑`, happy: t`开心`, shy: t`害羞`, angry: t`生气`, sad: t`难过`, surprised: t`惊讶`, thinking: t`思考` }
// Why a 立绘 cannot be cut out (web/shared/cutout.js's why; 'load': not a picture the page can read).
const WHY_UNUSABLE = {
  busy: t`背景不是一种纯色，抠不出人物（重画一张，或上传白底的图）`,
  fill: t`人物占满了画面，几乎没有背景可抠（重画一张）`,
  faint: t`人物和背景颜色太近，几乎整张都被当成了背景（重画一张）`,
  edge: t`画面两边还留着一大块（另一种颜色的背景，或者人物被画框切掉了），抠不干净（重画一张）`,
  load: t`图片读不出来`,
}
// A phone (or a phone on its side) has room for two.
const NARROW = '(max-width: 560px), (orientation: landscape) and (max-height: 520px)'

function recall(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback
  } catch {
    return fallback
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode: the choice lasts until the page closes.
  }
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// Speech the story renderer leaves unmarked ('』' and straight quotes), and bracketed system text (【叮！…】, […]).
const MARKED = /『[^』\n]*』|"[^"\n]*"|【[^】\n]*】|\[[^\]\n]*\]/g
const HAS_MARKED = /『[^』\n]*』|"[^"\n]*"|【[^】\n]*】|\[[^\]\n]*\]/

/** Wraps unmarked quotes in .q and bracketed text in .vn-sys, so each has its colour (text box and backlog). */
function markSpeech(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  for (const node of nodes) {
    const text = node.textContent
    if (!HAS_MARKED.test(text) || node.parentElement?.closest('.q, .vn-sys, button')) continue
    const pieces = []
    let last = 0
    for (const match of text.matchAll(MARKED)) {
      pieces.push(document.createTextNode(text.slice(last, match.index)))
      const span = document.createElement('span')
      span.className = /^[【[]/.test(match[0]) ? 'vn-sys' : 'q'
      span.textContent = match[0]
      pieces.push(span)
      last = match.index + match[0].length
    }
    pieces.push(document.createTextNode(text.slice(last)))
    node.replaceWith(...pieces)
  }
}

/** A hue for a cast member's name plate, the same every time. */
const hueOf = name => [...String(name)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 17)

/** A picture file from the player → a PNG data URL (a 立绘 keeps its transparency). */
async function asPng(file) {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(t`读不出这张图片，换一张 PNG、JPG 或 WebP 试试`)
  })
  const scale = Math.min(1, SPRITE_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) })
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/png')
}

/**
 * @param deps.display - (chat, node, latest) → { shown, raw, choices }: what the transcript shows for a reply
 *   (latest: as the newest reply, with its status bar and choices).
 * @param deps.live - () → the open chat's job while a turn is written ({ kind, text, echo }), or null.
 * @param deps.statusFor - (chat, node) → the status bar element for the latest reply, or null.
 * @param deps.readBeat - (nodeId, text, done, speaker) reads one line aloud, in its speaker's voice; done() once it has been read.
 * @param deps.fillQuick - (box, 'voice'|'image') fills the ▾ menu with the settings the transcript shares.
 * @param deps.mediaFlags - () → { read, image } as the transcript has them, or null before they load.
 * @param deps.openMedia - (section) opens 配图与朗读 there.
 */
export function initVn(deps) {
  const { api, el, toast, guard, renderStory, getChat, live, display, statusFor, frameContext, cardOf, send, fill, fitInput, regenerate, selectNode, isGenerating } = deps
  const $ = id => document.getElementById(id)
  const stage = document.querySelector('.stage')
  const root = $('vn')
  const toggle = $('vn-toggle')
  const prefs = { speed: 'normal', newScene: 'auto', newSprite: 'auto', ...recall(PREFS_KEY, {}) }
  const state = {
    on: false, chatId: null, cardId: null, key: null, node: null, steps: [], trailing: [], options: [], available: 0,
    index: -1, seen: -1, phase: 'idle', streaming: false, pending: false, auto: false, follow: false,
    typing: 0, autoTimer: 0, names: [], roster: new Map(), readId: null, reading: false,
  }

  // ─── The layers, back to front ──────────────────────────────────────
  const bg = el('div', { class: 'vn-bg' })
  const tint = el('div', { class: 'vn-tint' })
  const actors = el('div', { class: 'vn-actors' })
  // 回忆滤镜: over the picture and the people while a memory's lines are read.
  const memoryLayer = el('div', { class: 'vn-memory', 'aria-hidden': 'true' })
  const flash = el('div', { class: 'vn-flash', 'aria-hidden': 'true' })
  const sign = el('div', { class: 'vn-sign' })
  const sceneChip = el('div', { class: 'vn-scene-chip', hidden: true })
  const cgButton = el('button', { type: 'button', class: 'vn-cg-thumb', hidden: true, title: t`这一轮的配图` })
  // 游戏式 HUD: a few variables under the time box; what a reply changed pops up at its end.
  const hud = initVnHud({ el, prefs, savePrefs: () => remember(PREFS_KEY, prefs), open: () => togglePop('hud') })
  const corner = el('div', { class: 'vn-corner' }, [sign, hud.box, hud.notes, sceneChip, cgButton])
  const title = el('div', { class: 'vn-title', hidden: true })
  // A new day: its title across the picture for a moment (第 3 天, the date, the place).
  const chapter = el('div', { class: 'vn-chapter', 'aria-hidden': 'true' })
  const panel = el('div', { class: 'vn-panel', hidden: true })
  // The turn's choices, as a game's: a menu in the middle of the picture.
  const menu = el('div', { class: 'vn-menu', hidden: true, role: 'dialog', 'aria-label': t`行动选项` })
  // The line being read aloud (web/media.js announces it): a small sign in the text box.
  const voice = el('button', { type: 'button', class: 'vn-voice', hidden: true, title: t`正在朗读这一句：点一下暂停或继续（右上角「朗读」关掉就不读了）` }, [el('i'), el('i'), el('i')])
  const plate = el('div', { class: 'vn-name', hidden: true })
  const lineBox = el('div', { class: 'vn-text story' })
  const spoken = el('div', { class: 'vn-sr', 'aria-live': 'polite' })
  const nextMark = el('span', { class: 'vn-next', 'aria-hidden': 'true' })
  const endRow = el('div', { class: 'vn-end', hidden: true })
  const box = el('div', { class: 'vn-box' }, [plate, voice, lineBox, nextMark, endRow, spoken])
  const logBox = el('section', { class: 'vn-log', hidden: true, role: 'dialog', 'aria-label': t`回看` })
  const cgView = el('div', { class: 'vn-cg', hidden: true, role: 'dialog', 'aria-label': t`配图` })

  const control = (label, titleText, onClick) => {
    const b = el('button', { type: 'button', class: 'vn-btn', title: titleText, text: label })
    b.addEventListener('click', event => {
      event.stopPropagation()
      onClick(b)
    })
    return b
  }
  const autoButton = control(t`自动`, t`自动翻页（A）`, () => setAuto(!state.auto))
  const statusButton = control(t`状态`, t`状态栏`, () => togglePanel('status'))
  const hudControl = control('HUD', t`角落里常驻显示的变量：显示哪些、怎么显示，还有数值变化提示`, () => togglePop('hud'))
  const speedButton = control('', t`打字速度`, () => {
    const order = Object.keys(SPEEDS)
    prefs.speed = order[(order.indexOf(prefs.speed) + 1) % order.length]
    remember(PREFS_KEY, prefs)
    renderSpeed()
  })
  // 朗读 and 配图 here are kept apart from the transcript's own switches; ▾ opens their settings.
  const readButton = control(t`朗读`, t`逐句朗读：每显示一句读一句。和普通模式的「自动朗读」分开记。`, () => setQuick('read', !prefs.read))
  const imageButton = control(t`配图`, t`新回复自动配图，画好后在左上角点开看。和普通模式的「自动配图」分开记。`, () => setQuick('image', !prefs.image))
  const readMore = control('▾', t`朗读设置：音色、每个角色的音色、朗读模型`, () => togglePop('voice'))
  const imageMore = control('▾', t`配图设置：画图方式、模型、场景和立绘`, () => togglePop('image'))
  for (const b of [readMore, imageMore]) b.classList.add('vn-more')
  const split = (main, more) => el('span', { class: 'vn-split' }, [main, more])
  // The settings by those switches: this mode's own first, then what the transcript shares (web/media.js).
  const pop = el('div', { class: 'vn-pop', hidden: true, role: 'dialog' })
  // On a phone the menu is a sheet over a dimmed picture: a tap there closes it, and reaches nothing under it.
  const scrim = el('div', { class: 'vn-scrim', hidden: true })
  let popKind = null
  const optionsButton = control(t`选项`, t`这一轮的行动选项（O）`, () => (menu.hidden ? showMenu() : hideMenu()))
  const fullButton = control(t`全屏`, t`全屏（F），Esc 退出`, () => toggleFullscreen())
  const cgControl = control('CG', t`CG 回廊：这条故事线上所有的配图（G）`, () => openGallery())
  const sceneControl = control(t`场景`, t`这张卡的场景图`, () => openLibrary('scenes'))
  const spriteControl = control(t`立绘`, t`角色说话时显示的立绘`, () => openLibrary('sprites'))
  const hideControl = control(t`隐藏`, t`隐藏界面（H），点一下恢复`, () => root.classList.add('bare'))
  const actControl = control(t`✎ 行动`, t`写下你的行动（回车）`, () => compose(true))
  const exitControl = control(t`退出`, t`退出视觉小说模式`, () => setOn(state.cardId, false))
  const saveControl = control(t`存档`, t`存档（F5 快速存档）`, () => saves.open('save'))
  const loadControl = control(t`读档`, t`读档（F9 快速读档）`, () => saves.open('load'))
  // On a phone the row keeps 朗读, 配图, 回看, 自动, 跳过; the rest wait behind ⋯ (CSS hides them, its menu lists them).
  const extras = [cgControl, speedButton, statusButton, hudControl, optionsButton, saveControl, loadControl, sceneControl, spriteControl, hideControl, fullButton, actControl, exitControl]
  for (const b of extras) b.classList.add('vn-extra')
  const moreButton = control('⋯', t`更多：CG、速度、状态、HUD、选项、存档、读档、场景、立绘、隐藏、全屏、行动、退出`, () => togglePop('more'))
  moreButton.classList.add('vn-overflow')
  const logControl = control(t`回看`, t`回看（L）`, () => openLog())
  const skipControl = control(t`跳过`, t`跳到最新一句`, () => skip())
  // Where even that row runs long (English on a narrow phone), these go behind ⋯ too, in this order.
  const tuckable = [logControl, skipControl, autoButton]
  const controls = el('div', { class: 'vn-controls' }, [
    el('span', { class: 'vn-quick' }, [split(readButton, readMore), split(imageButton, imageMore)]),
    logControl,
    cgControl,
    autoButton,
    skipControl,
    speedButton,
    statusButton,
    hudControl,
    optionsButton,
    saveControl,
    loadControl,
    sceneControl,
    spriteControl,
    hideControl,
    fullButton,
    actControl,
    exitControl,
    moreButton,
  ])
  root.append(bg, tint, actors, memoryLayer, flash, corner, title, chapter, panel, menu, box, controls, scrim, pop, logBox, cgView)

  // Where the layers in between may go: under the controls (however they wrapped), above the text box,
  // and the text box itself above the input while it is open.
  function placeLayers() {
    if (root.hidden) return
    fitControls()
    const composer = $('composer')
    if (composer) root.style.setProperty('--vn-composer', `${composer.offsetHeight}px`)
    const below = controls.offsetTop + controls.offsetHeight
    root.style.setProperty('--vn-above', `${below + 8}px`)
    // The choices also keep clear of the time box (the CG under it may go behind them).
    const signFoot = sign.hidden || !sign.offsetHeight ? 0 : corner.offsetTop + sign.offsetTop + sign.offsetHeight
    root.style.setProperty('--vn-menu-top', `${Math.max(below, signFoot) + 8}px`)
    root.style.setProperty('--vn-below', `${root.clientHeight - box.offsetTop + 10}px`)
  }
  /** With ⋯ showing, the row keeps what fits; it is aligned right, so too much runs off its left edge. */
  function fitControls() {
    for (const b of tuckable) b.classList.remove('vn-tucked')
    if (getComputedStyle(moreButton).display === 'none') return
    const runsOver = () => controls.firstElementChild.getBoundingClientRect().left < controls.getBoundingClientRect().left - 0.5
    for (const b of tuckable) {
      if (!runsOver()) break
      b.classList.add('vn-tucked')
    }
  }
  const layout = new ResizeObserver(() => placeLayers())
  for (const node of [root, controls, box, sign, $('composer')]) if (node) layout.observe(node)

  voice.addEventListener('click', event => {
    event.stopPropagation()
    deps.toggleReading?.()
  })
  document.addEventListener('cicatavern:reading', event => {
    const reading = event.detail?.state ?? ''
    voice.hidden = !reading || !state.on
    voice.dataset.state = reading
  })

  // ─── Fullscreen: the stage fills the window (side panels and top bar out of the way), and the
  // screen too where the browser allows it (not iPhone Safari, not every embedded view).
  let screenFull = false
  function setFull(on) {
    stage.classList.toggle('vn-full', on)
    fullButton.classList.toggle('on', on)
    fullButton.setAttribute('aria-pressed', String(on))
    if (on) stage.requestFullscreen?.().catch(() => {})
    else if (document.fullscreenElement === stage) document.exitFullscreen?.().catch(() => {})
  }
  const toggleFullscreen = () => setFull(!stage.classList.contains('vn-full'))
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement === stage) screenFull = true
    else if (screenFull) {
      // Left with Esc or the browser's own control: the window goes back to normal too.
      screenFull = false
      if (stage.classList.contains('vn-full')) setFull(false)
    }
  })

  function renderSpeed() {
    speedButton.textContent = t`速度：${SPEED_LABEL[prefs.speed]}`
  }
  renderSpeed()

  /** The first time: 朗读 and 配图 start as the transcript has them. */
  function quickDefaults() {
    if (prefs.read !== undefined) return
    const flags = deps.mediaFlags?.()
    if (!flags) return
    prefs.read = Boolean(flags.read)
    prefs.image = Boolean(flags.image)
    remember(PREFS_KEY, prefs)
  }

  function renderQuick() {
    for (const [button, on] of [[readButton, prefs.read], [imageButton, prefs.image]]) {
      button.classList.toggle('on', Boolean(on))
      button.setAttribute('aria-pressed', String(Boolean(on)))
    }
    renderPopOwn()
  }

  function setQuick(key, on) {
    prefs[key] = on
    remember(PREFS_KEY, prefs)
    renderQuick()
    if (key === 'read') {
      state.readId = null
      if (on) readStep()
      else if (state.reading) {
        state.reading = false
        deps.stopReading?.()
      }
    }
  }

  // ─── 朗读 / 配图 settings (▾) ──────────────────────────────────────
  const popOwn = el('div', { class: 'vn-pop-own' })
  const popShared = el('div', { class: 'vn-pop-shared' })
  // Going on to the settings window: this menu is done.
  popShared.addEventListener('click', event => {
    if (event.target.closest('[data-settings]')) closePop()
  })

  function togglePop(kind) {
    if (!pop.hidden && popKind === kind) return closePop()
    openPop(kind)
  }

  function openPop(kind) {
    popKind = kind
    const close = el('button', { type: 'button', class: 'vn-btn', text: '×', title: t`关闭（Esc）`, onclick: closePop })
    if (kind === 'hud') {
      pop.setAttribute('aria-label', t`HUD 设置`)
      pop.replaceChildren(el('div', { class: 'vn-pop-head' }, [el('b', { text: t`HUD` }), close]), el('div', { class: 'vn-pop-own vn-hud-settings' }, hud.settings(() => openPop('hud'))))
    } else if (kind === 'more') {
      pop.setAttribute('aria-label', t`更多`)
      pop.replaceChildren(
        el('div', { class: 'vn-pop-head' }, [el('b', { text: t`更多` }), close]),
        el('div', { class: 'vn-more-grid' }, [...tuckable.filter(b => b.classList.contains('vn-tucked')), ...extras].filter(b => !b.hidden).map(proxyOf)),
      )
    } else {
      const tabs = el('div', { class: 'seg' }, [['voice', t`朗读`], ['image', t`配图`]].map(([value, text]) => {
        const b = el('button', { type: 'button', 'aria-pressed': String(kind === value), text })
        b.addEventListener('click', () => openPop(value))
        return b
      }))
      pop.setAttribute('aria-label', kind === 'voice' ? t`朗读设置` : t`配图设置`)
      pop.replaceChildren(el('div', { class: 'vn-pop-head' }, [tabs, close]), popOwn, popShared)
      renderPopOwn()
    }
    // Just below the controls, wherever they wrapped to (on a phone it rises from the foot instead).
    placeLayers()
    pop.hidden = false
    scrim.hidden = false
    for (const [button, which] of [[readMore, 'voice'], [imageMore, 'image'], [moreButton, 'more']]) button.classList.toggle('open', kind === which)
    if (kind === 'more' || kind === 'hud') return
    if (deps.fillQuick) deps.fillQuick(popShared, kind)
    else popShared.replaceChildren()
  }

  /** ⋯'s menu: a control from the row, as it is now. */
  function proxyOf(button) {
    const proxy = el('button', { type: 'button', class: 'vn-btn', title: button.title, text: button.textContent })
    proxy.classList.toggle('on', button.classList.contains('on'))
    proxy.addEventListener('click', event => {
      event.stopPropagation()
      // 速度 changes in place; the rest open something or leave, so the menu goes first.
      if (button === speedButton) {
        button.click()
        return openPop('more')
      }
      closePop()
      button.click()
    })
    return proxy
  }

  function closePop() {
    pop.hidden = true
    scrim.hidden = true
    popKind = null
    for (const button of [readMore, imageMore, moreButton]) button.classList.remove('open')
  }

  /** This mode's own switches at the top of the menu, as they are now. */
  function renderPopOwn() {
    if (popKind !== 'voice' && popKind !== 'image') return
    const switchRow = (text, on, onChange, hint) => {
      const input = el('input', { type: 'checkbox', class: 'switch', checked: Boolean(on) })
      input.addEventListener('change', () => onChange(input.checked))
      return el('label', { class: 'vn-pop-switch' }, [el('span', {}, [text, el('small', { text: hint })]), input])
    }
    popOwn.replaceChildren(...(popKind === 'voice'
      ? [
          switchRow(t`逐句朗读`, prefs.read, on => setQuick('read', on), t`每显示一句读一句`),
          switchRow(t`自动翻页`, state.auto, on => setAuto(on), t`读完一句接着下一句（A）`),
        ]
      : [
          switchRow(t`新回复自动配图`, prefs.image, on => setQuick('image', on), t`画好后在左上角点开看`),
          artMode('newScene', t`到了新地点：`, renderPopOwn),
          artMode('newSprite', t`没有立绘的角色说话时：`, renderPopOwn),
        ]))
  }

  // ─── Saves (web/vn-saves.js): the line on screen, and getting back to it ──
  const saves = initVnSaves({
    api, el, toast, guard,
    // What a save keeps: the reply and the line in it, where and when, a picture of the stage.
    current: () => {
      const chat = getChat()
      const step = state.steps[state.index]
      if (!chat || !state.node || state.streaming || !step) return null
      const where = state.stepWhere ?? latestPlace(chat.path)
      return {
        cardId: chat.cardId, chatId: chat.id, chatTitle: chat.title ?? '', nodeId: state.node.id, line: state.index,
        place: where?.place ?? '', time: where?.time ?? '', text: `${step.speaker ? t`${shownName(step.speaker)}：` : ''}${step.plain ?? ''}`.slice(0, 80),
      }
    },
    snapshot: () => snapshot(),
    cardId: () => state.cardId,
    busy: () => isGenerating(),
    // A save's reply opened (its chat, its branch), then its line once that reply is on screen.
    open: async (save, chat) => {
      state.jump = { key: `${save.chatId}:${save.nodeId}`, line: save.line, at: Date.now() }
      await deps.showChat(chat)
    },
  })

  /** The stage as a small picture for a save: the background, then whoever stands there. */
  async function snapshot() {
    const width = 384
    const height = Math.round(width * Math.min(0.75, Math.max(0.42, root.clientHeight / Math.max(1, root.clientWidth))))
    const canvas = Object.assign(document.createElement('canvas'), { width, height })
    const context = canvas.getContext('2d')
    context.fillStyle = getComputedStyle(root).getPropertyValue('--bg') || '#222'
    context.fillRect(0, 0, width, height)
    const load = src => new Promise(resolve => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => resolve(null)
      image.src = src
    })
    const back = bg.dataset.url ? await load(bg.dataset.url) : null
    if (back) {
      const scale = Math.max(width / back.width, height / back.height)
      context.drawImage(back, (width - back.width * scale) / 2, (height - back.height * scale) / 2, back.width * scale, back.height * scale)
    }
    for (const box of actors.querySelectorAll('.vn-actor.show')) {
      const face = box.querySelector('img.show')
      if (!face?.naturalHeight) continue
      const h = height * 0.86
      const w = face.naturalWidth * (h / face.naturalHeight)
      const x = (parseFloat(box.style.getPropertyValue('--x')) || 50) / 100 * width
      context.globalAlpha = box.classList.contains('idle') ? 0.75 : 1
      context.drawImage(face, x - w / 2, height - h, w, h)
      context.globalAlpha = 1
    }
    return canvas.toDataURL('image/jpeg', 0.78)
  }

  // ─── On / off per card ─────────────────────────────────────────────
  const cardsOn = () => new Set(recall(MODE_KEY, []))
  const isOn = cardId => Boolean(cardId) && cardsOn().has(cardId)
  function setOn(cardId, on) {
    if (!cardId) return
    const set = cardsOn()
    if (on) set.add(cardId)
    else set.delete(cardId)
    remember(MODE_KEY, [...set])
    render(getChat())
  }
  toggle?.addEventListener('click', () => {
    remember(TRIED_KEY, true)
    toggle.classList.remove('fresh')
    const chat = getChat()
    if (!chat) return
    const on = !isOn(chat.cardId)
    setOn(chat.cardId, on)
    if (on) offerPreset(chat)
  })

  // Chats offered the preset in this page already: asked once each.
  const offered = new Set()

  /**
   * Going into the mode with another preset: offer the 视觉小说预设 (more dialogue, short
   * narration). Switching rebuilds the chat's prefix (deps.usePreset). Resolves once answered.
   */
  function offerPreset(chat) {
    if (!chat || chat.presetId === VN_ID || offered.has(chat.id) || recall(PRESET_OFFER_KEY, '') === 'never' || !deps.usePreset) return Promise.resolve(false)
    offered.add(chat.id)
    return new Promise(resolve => {
      const box = el('dialog', { class: 'dialog vn-preset-offer' })
      const done = async answer => {
        box.close()
        box.remove()
        if (answer === 'never') remember(PRESET_OFFER_KEY, 'never')
        if (answer === 'use') {
          try {
            await deps.usePreset(chat.id, VN_ID)
          } catch (error) {
            toast(error.message)
          }
        }
        resolve(answer === 'use')
      }
      const imported = chat.presetId && !isBuiltinPreset(chat.presetId) ? chat.presetName : ''
      box.append(
        el('h2', { text: t`改用视觉小说预设？` }),
        el('p', { text: t`为了获得更好的体验，可以让这个对话改用视觉小说预设：对白更多，旁白和场景描写简明扼要，段落短，更像视觉小说和 galgame 的写法。对白比重、旁白长短、展开方式这些都能在「预设」里调。` }),
        el('p', { class: 'muted small', text: imported
          ? t`现在用的是「${imported}」，换了之后它的条目不再生效，随时可以在「预设」里换回来。会重建这个对话的固定前缀，下一轮重写一次缓存。`
          : t`会重建这个对话的固定前缀，下一轮重写一次缓存。随时可以在「预设」里换回来。` }),
        el('div', { class: 'row end' }, [
          el('button', { type: 'button', class: 'btn ghost', text: t`不再提示`, onclick: () => done('never') }),
          el('span', { class: 'grow' }),
          el('button', { type: 'button', class: 'btn', text: t`这次不用`, onclick: () => done('no') }),
          el('button', { type: 'button', class: 'btn primary', text: t`改用视觉小说预设`, disabled: isGenerating(), onclick: () => done('use') }),
        ]),
      )
      box.addEventListener('cancel', () => done('no'))
      document.body.append(box)
      box.showModal()
    })
  }

  // ─── The text and its steps ────────────────────────────────────────
  /** The latest reply on the path (the greeting counts). */
  const latestReply = chat => [...(chat?.path ?? [])].reverse().find(node => node.role === 'assistant') ?? null

  /**
   * Story lines become steps; a card's HTML between them is a step of its own;
   * HTML after the story waits behind 状态; the story's options (1️⃣ …) wait for the end.
   */
  function stepsOf(text, partial) {
    const parts = segments(text)
    const lines = parts.map((part, i) => (part.kind === 'story' ? splitLines(part.body, { names: state.names, partial: partial && i === parts.length - 1 }) : null))
    // The last part with a line to show: an options block after a variable-update card is not story.
    const lastStory = lines.findLastIndex(list => list?.some(line => line.kind !== 'option' && line.kind !== 'scene'))
    const steps = []
    const trailing = []
    const options = []
    // Each line carries the place it happens in once the reply has named one (a header line, at the top or halfway).
    let where = null
    parts.forEach((part, i) => {
      if (part.kind === 'story') {
        for (const line of lines[i]) {
          if (line.kind === 'option') options.push(line.plain)
          else if (line.kind === 'scene') where = line.where
          else steps.push({ type: 'line', ...line, where })
        }
      } else if (partial) {
        // A frame still being written is not shown yet.
      } else if (i < lastStory) steps.push({ type: 'panel', kind: part.kind, body: part.body, plain: '' })
      else trailing.push(part)
    })
    return { steps, trailing, options }
  }

  /** A reply's story lines only: no status panels, code, options (the backlog, 画这一轮的场景). */
  function storyLines(chat, node, latest = false) {
    return stepsOf(display(chat, node, latest).shown, false).steps.filter(step => step.type === 'line')
  }

  /** The card's 角色名册, once (`fresh`: again, as the library opens). */
  async function loadRoster(cardId, fresh = false) {
    if (!cardId || (!fresh && state.roster.has(cardId))) return
    if (!state.roster.has(cardId)) state.roster.set(cardId, [])
    const media = await api(`/api/cards/${cardId}/media`).catch(() => null)
    if (media || !fresh) takeRoster(cardId, media?.roster)
  }

  /**
   * A card's 角色名册 as it is now: the names, the stage and the library follow.
   * Its 人设图 and picture are cut out again: they keep their address when replaced
   * (a drawn 立绘 gets a new file name each time).
   */
  function takeRoster(cardId, roster) {
    state.roster.set(cardId, Array.isArray(roster) ? roster : [])
    cast.none.clear()
    for (const url of cast.cuts.keys()) if (url.startsWith(`/api/cards/${cardId}/`)) cast.cuts.delete(url)
    if (state.cardId !== cardId) return
    if (state.on) {
      render(getChat())
      // The same line stays on screen: its people in their new pictures.
      drawStage()
    }
    if (library?.open) renderLibrary()
  }
  // Saved in 配图与朗读 (web/media.js): the cast here is that one from now on.
  document.addEventListener('cicatavern:card-media', event => {
    const { cardId, media } = event.detail ?? {}
    if (cardId && Array.isArray(media?.roster)) takeRoster(cardId, media.roster)
  })

  /** Redraws from the chat as it is now: a new reply starts at its first line, the same one keeps its place. */
  function render(chat) {
    const on = Boolean(chat) && isOn(chat.cardId)
    toggle?.setAttribute('aria-pressed', String(on))
    if (toggle) {
      toggle.hidden = !chat
      toggle.classList.toggle('fresh', !recall(TRIED_KEY, false))
    }
    if (state.on && !on) leave()
    state.on = on
    root.hidden = !on
    stage.classList.toggle('vn-on', on)
    if (!on) return fitInput?.()
    quickDefaults()
    renderQuick()
    if (chat.cardId !== state.cardId) {
      // The settings menu was another card's.
      if (state.cardId) closePop()
      state.cardId = chat.cardId
      loadRoster(chat.cardId)
    }
    state.names = speakerNames({ char: chat.names?.char, user: chat.names?.user, roster: state.roster.get(chat.cardId) ?? [] })
    const job = live()
    const writing = job?.kind === 'turn'
    const node = latestReply(chat)
    const key = writing ? `live:${chat.id}` : `${chat.id}:${node?.id}`
    const text = writing ? streamingText(job.text) : node ? display(chat, node, true).shown : ''
    const { steps, trailing, options } = stepsOf(text, writing)
    // The reply that was streaming, now finished: the same reply, read on from where the player is.
    const finishing = !writing && state.key === `live:${chat.id}`
    const fresh = key !== state.key && !finishing
    const before = state.steps
    const current = before[state.index]
    const furthest = before[state.seen]
    state.key = key
    // Another chat's pictures don't stay open over this one.
    if (state.chatId !== chat.id) closeCg()
    state.chatId = chat.id
    state.node = writing ? null : node
    state.steps = steps
    state.trailing = trailing
    state.options = options
    state.streaming = writing
    state.available = writing ? Math.max(0, steps.length - 1) : steps.length
    if (writing) compose(false)
    if (fresh) {
      // Which day the story had reached before this reply; its own dates count on from there.
      // Opening a chat (or coming back to this mode) shows no title for the reply already there.
      const quiet = state.day?.chatId !== chat.id
      const before = (chat.path ?? []).filter(item => item.role === 'assistant' && (writing || item.id !== node?.id))
      state.day = { chatId: chat.id, at: storyDay(before.map(item => ({ text: item.raw ?? item.text, time: stateTime(item.state) }))), dated: false, shown: false, quiet }
      // The HUD shows the state before this reply until the player reaches its end (one already there counts as read).
      state.reached = quiet ? key : null
      state.index = -1
      state.seen = -1
      state.stepWhere = null
      state.follow = false
      state.pending = true
      state.readId = null
      closePanel()
    } else if (current) {
      // The same reply again (more of it in, finished, or its regex changed): stay on the same line.
      const same = sameLine(before, state.index, steps)
      const far = furthest ? sameLine(before, state.seen, steps) : -1
      state.index = same >= 0 ? same : Math.min(state.index, steps.length - 1)
      state.seen = Math.max(state.index, far >= 0 ? far : Math.min(state.seen, steps.length - 1))
    }
    // Whether this reply says its date (its time box may still be coming): then 次日 in it is no new day.
    if (state.day && !state.day.dated) state.day.dated = timesIn(writing ? job.text : node ? node.raw ?? node.text : '').length > 0 || Boolean(!writing && stateTime(node?.state))
    // Loaded from a save (a moment ago): straight to its line, everything before it read.
    const jumped = state.jump?.key === key && Date.now() - state.jump.at < 10_000 && steps.length > 0
    if (jumped) {
      state.index = Math.min(state.jump.line, steps.length - 1)
      state.seen = Math.max(state.seen, state.index)
      state.stepWhere = [...steps.slice(0, state.index + 1)].reverse().find(step => step.where)?.where ?? null
      state.pending = false
      state.follow = false
      state.jump = null
      closePanel()
    }
    drawScene(chat, writing ? job.text : null)
    drawStatus(chat)
    drawCg(chat)
    drawHud(chat)
    if (!writing && node) labelFaces()
    if (jumped) showStep(false)
    else if (state.index < 0 || state.pending) catchUp()
    else if (!writing && state.index >= state.available - 1 && state.phase !== 'typing') showStep(false)
    else {
      // The cast arrived while this line was being typed (it names someone else now): its plate follows.
      const now = state.steps[state.index]
      if (now?.type === 'line' && current?.type === 'line' && now.plain === current.plain && now.speaker !== current.speaker) drawSpeaker(now)
    }
    if (writing && state.index < 0) waitingLine(job.echo)
  }

  /** The text arrived since the last frame: lines that are complete now may show. */
  let frame = 0
  function streamed() {
    if (!state.on || frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      render(getChat())
    })
  }

  /** While waiting for the first line: what the player just said, dimmed. */
  function waitingLine(echo) {
    plate.hidden = true
    box.dataset.kind = 'narration'
    lineBox.replaceChildren(el('p', { class: 'vn-waiting', text: echo ? `${echo}` : '…' }))
    nextMark.className = 'vn-next wait'
    clearStage()
  }

  /** Moves on when the player is waiting for a line that has now arrived. */
  function catchUp() {
    if (!state.pending) return
    if (state.follow && state.available) {
      state.index = state.available - 1
      state.pending = state.streaming
      return showStep(false)
    }
    if (state.index + 1 < state.available) {
      state.index++
      state.pending = false
      showStep(true)
    } else if (!state.streaming && state.available) {
      state.pending = false
      state.index = Math.max(0, Math.min(state.index, state.available - 1))
      showStep(false)
    }
  }

  // ─── One line ──────────────────────────────────────────────────────
  function cancelTyping() {
    cancelAnimationFrame(state.typing)
    state.typing = 0
  }

  /** The speaker's name as the plate shows it (the default player name reads 你 on a Chinese page, You in English). */
  const shownName = speaker => (speaker === '你' ? t`你` : speaker) // i18n-ignore: the default player name

  /** Who a name is: the card's own, the player, or someone else in the cast (each their own colour). */
  function whoIs(speaker) {
    const entry = state.names.find(item => item.name === speaker)
    return entry?.char ? 'char' : entry?.player ? 'player' : 'cast'
  }

  /** The name plate and the stage, for a line; `fresh`: just reached, so its effects play. */
  function drawSpeaker(step, fresh = false) {
    box.dataset.kind = step.kind
    plate.hidden = !step.speaker
    plate.textContent = step.speaker ? shownName(step.speaker) : ''
    plate.dataset.who = step.speaker ? whoIs(step.speaker) : ''
    plate.style.setProperty('--who', step.speaker ? String(hueOf(step.speaker)) : '')
    drawStage({ effects: fresh })
  }

  function showStep(animate) {
    const step = state.steps[state.index]
    clearTimeout(state.autoTimer)
    cancelTyping()
    hideMenu()
    endRow.hidden = true
    if (!step) return
    state.seen = Math.max(state.seen, state.index)
    // The story moved on to another place or time: the sign, the background and the day follow.
    if (step.where?.place && (step.where.place !== state.stepWhere?.place || step.where.time !== state.stepWhere?.time)) {
      state.stepWhere = step.where
      const chat = getChat()
      if (chat) drawScene(chat, state.streaming ? live()?.text ?? null : null)
    }
    // A story that writes no dates: a paragraph opening on 次日 is the next day.
    if (step.type === 'line' && state.day && !state.day.dated && opensNextDay(step.text)) {
      state.day.at = { day: state.day.at.day + 1, date: null }
      turnDay(state.day.at.day, state.stepWhere ?? latestPlace(getChat()?.path))
    }
    root.classList.toggle('memory', step.type === 'line' && Boolean(step.memory) && prefs.effects !== false)
    if (step.type === 'panel') {
      plate.hidden = true
      box.dataset.kind = 'narration'
      clearStage()
      lineBox.replaceChildren(el('p', { class: 'vn-waiting', text: t`（卡片画面）` }))
      showPanel(step.kind === 'html' ? frameOf(step.body, getChat()) : el('pre', { class: 'code', text: step.body }))
      return lineShown()
    }
    closePanel()
    drawSpeaker(step, animate)
    lineBox.innerHTML = renderStory(step.text)
    markSpeech(lineBox)
    spoken.textContent = `${step.speaker ? t`${shownName(step.speaker)}：` : ''}${step.plain}`
    // Not the last line's 'shown' any more: a line with nothing to read is done at once, and must not take it for its own.
    state.phase = 'showing'
    readStep()
    const cps = SPEEDS[prefs.speed]
    if (!animate || !cps || reducedMotion() || state.follow) return lineShown()
    // Type it out: fill the text nodes a few characters per frame, markup and all.
    const walker = document.createTreeWalker(lineBox, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push({ node: walker.currentNode, text: walker.currentNode.textContent })
    for (const item of nodes) item.node.textContent = ''
    const total = nodes.reduce((sum, item) => sum + item.text.length, 0)
    const start = performance.now()
    state.phase = 'typing'
    nextMark.className = 'vn-next'
    const tick = now => {
      let left = Math.floor(((now - start) / 1000) * cps)
      for (const item of nodes) {
        const take = Math.max(0, Math.min(item.text.length, left))
        item.node.textContent = item.text.slice(0, take)
        left -= item.text.length
      }
      if (Math.floor(((now - start) / 1000) * cps) >= total) {
        state.typing = 0
        lineShown()
      } else state.typing = requestAnimationFrame(tick)
    }
    state.typing = requestAnimationFrame(tick)
    state.typed = () => {
      for (const item of nodes) item.node.textContent = item.text
    }
  }

  /** 朗读 on: the line on screen is read once (not again when the page redraws). */
  function readStep() {
    const step = state.steps[state.index]
    if (!prefs.read || !deps.readBeat || step?.type !== 'line') return
    const id = `${state.key}#${state.index}`
    if (state.readId === id) return
    state.readId = id
    state.reading = true
    // Called once the line has been read, or the voice gave up on it (failed, refused, stopped).
    deps.readBeat(state.node?.id ?? 'vn-live', step.text, () => {
      if (state.readId !== id || !state.reading || !state.on) return
      state.reading = false
      // 自动 waits for the voice, then moves on (one timer: a line read at once must not leave one behind).
      clearTimeout(state.autoTimer)
      if (state.auto && state.phase === 'shown') state.autoTimer = setTimeout(() => state.auto && advance(), 450)
    }, step.speaker)
  }

  function lineShown() {
    state.typed?.()
    state.typed = null
    state.phase = 'shown'
    const last = state.index >= state.available - 1
    const ended = last && !state.streaming
    nextMark.className = `vn-next${last && state.streaming ? ' wait' : ''}${ended ? ' end' : ''}`
    if (ended) reachEnd()
    if (ended) showEnd()
    else if (state.auto && !state.reading) {
      const step = state.steps[state.index]
      state.autoTimer = setTimeout(() => {
        if (state.auto && state.phase === 'shown' && !state.reading && !document.hidden) advance()
      }, Math.min(9000, Math.max(1500, 800 + 55 * (step?.plain.length ?? 0))))
    }
  }

  /** The reply's choices: its <choices>, else its 1️⃣ options. */
  function currentChoices() {
    const listed = state.node ? display(getChat(), state.node, true).choices ?? [] : []
    return state.streaming ? [] : listed.length ? listed : state.options
  }

  /** The choices as a game's menu: number keys pick one, ✎ edits it first, 自己写 opens the input. */
  function showMenu() {
    const choices = currentChoices()
    if (!choices.length) return
    const busy = isGenerating()
    const rows = choices.map((text, i) => {
      const go = el('button', { type: 'button', class: 'vn-choice', disabled: busy, style: `--i: ${i}` }, [el('span', { class: 'vn-choice-n', text: String(i + 1) }), el('span', { class: 'vn-choice-text', text })])
      go.addEventListener('click', event => {
        event.stopPropagation()
        pick(text)
      })
      const edit = el('button', { type: 'button', class: 'vn-choice-edit', title: t`填进输入框改一改`, disabled: busy, text: '✎' })
      edit.addEventListener('click', event => {
        event.stopPropagation()
        fill(text)
        compose(true)
      })
      return el('div', { class: 'vn-choice-row', style: `--i: ${i}` }, [go, edit])
    })
    const own = el('button', { type: 'button', class: 'vn-menu-own', text: t`✎ 自己写行动` })
    own.addEventListener('click', event => {
      event.stopPropagation()
      compose(true)
    })
    menu.replaceChildren(
      el('div', { class: 'vn-menu-head' }, [el('b', { text: t`轮到你了` }), el('span', { text: t`选一个，或者自己写` })]),
      el('div', { class: 'vn-menu-list' }, rows),
      el('div', { class: 'vn-menu-foot' }, [own, control(t`收起`, t`先收起选项看看画面（右上角「选项」或 O 再打开）`, () => hideMenu())]),
    )
    placeLayers()
    menu.hidden = false
    root.classList.add('choosing')
    optionsButton.classList.add('on')
  }

  function hideMenu() {
    menu.hidden = true
    root.classList.remove('choosing')
    optionsButton.classList.remove('on')
  }

  function pick(text) {
    hideMenu()
    compose(false)
    send(text)
  }

  /** After the last line: the menu, and under the line the turn's tools and a word that it is the player's move. */
  function showEnd() {
    state.phase = 'ended'
    const node = state.node
    const busy = isGenerating()
    showMenu()
    const tools = [el('span', { class: 'vn-turn-hint', text: t`轮到你了` })]
    if (node && node.siblingCount > 1) {
      const swipe = (delta, label) => control(label, '', () => selectNode(node.siblingIds[node.siblingIndex + delta]))
      const back = swipe(-1, '‹')
      back.disabled = busy || node.siblingIndex === 0
      const forward = swipe(1, '›')
      forward.disabled = busy || node.siblingIndex === node.siblingCount - 1
      tools.push(back, el('span', { class: 'vn-swipe', text: `${node.siblingIndex + 1}/${node.siblingCount}` }), forward)
    }
    if (node && node.id !== 'root') {
      const again = control(t`重新生成`, '', () => regenerate(node.parent))
      again.disabled = busy
      tools.push(again)
    }
    tools.push(control(t`✎ 行动`, '', () => compose(true)))
    endRow.replaceChildren(...tools)
    endRow.hidden = false
  }

  // ─── Moving through the lines ──────────────────────────────────────
  function advance() {
    if (!state.on) return
    if (state.phase === 'typing') {
      cancelTyping()
      return lineShown()
    }
    if (state.index + 1 < state.available) {
      state.index++
      return showStep(true)
    }
    if (state.streaming) {
      state.pending = true
      nextMark.className = 'vn-next wait'
      return
    }
    if (state.phase === 'ended') {
      if (menu.hidden && currentChoices().length) return showMenu()
      return compose(true)
    }
    showEnd()
  }

  function back() {
    if (state.index <= 0) return
    state.index--
    setAuto(false)
    showStep(false)
  }

  function skip() {
    setAuto(false)
    if (state.streaming) state.follow = true
    if (!state.available) return
    state.index = state.available - 1
    showStep(false)
  }

  function setAuto(on) {
    const changed = state.auto !== on
    state.auto = on
    autoButton.classList.toggle('on', on)
    autoButton.setAttribute('aria-pressed', String(on))
    clearTimeout(state.autoTimer)
    if (changed && popKind === 'voice') renderPopOwn()
    if (on && state.phase === 'shown') lineShown()
  }

  // ─── The composer, the card's frames, the status bar, the turn's pictures ──
  /** The input box at the foot; opening it brings the turn's choices back too. */
  function compose(open) {
    stage.classList.toggle('vn-compose', open)
    // The text box moves up over the input, or back down: the menu above it follows.
    placeLayers()
    if (open) {
      // Filled while hidden, it has its height only now.
      fitInput?.()
      setAuto(false)
      if (state.phase === 'ended' && menu.hidden) showMenu()
      $('input')?.focus()
    }
  }

  /** A card's HTML in its frame, loaded at once (a lazy frame over the transcript never starts loading). */
  function frameOf(body, chat) {
    const frame = htmlFrame(body, state.node ? frameContext(chat, state.node) : null)
    frame.removeAttribute('loading')
    return frame
  }

  function showPanel(content, kind = 'step') {
    panel.dataset.kind = kind
    panel.replaceChildren(content)
    panel.hidden = false
  }

  function closePanel() {
    panel.hidden = true
    panel.replaceChildren()
  }

  function togglePanel(kind) {
    if (!panel.hidden && panel.dataset.kind === kind) return closePanel()
    const chat = getChat()
    const parts = [
      ...state.trailing.map(part => (part.kind === 'html' ? frameOf(part.body, chat) : el('pre', { class: 'code', text: part.body }))),
      state.node ? statusFor(chat, state.node) : null,
    ].filter(Boolean)
    if (!parts.length) return
    const close = control(t`收起`, '', () => closePanel())
    showPanel(el('div', { class: 'vn-status' }, [...parts, close]), kind)
  }

  /** The state before a reply: the assistant message before it on the path. */
  function stateBefore(chat, node) {
    const index = chat.path.findIndex(item => item.id === node.id)
    return chat.path.slice(0, Math.max(0, index)).reverse().find(item => item.role === 'assistant')?.state ?? null
  }

  /** The HUD: the state as the reply on screen left it once its end is reached, the one before until then. */
  function drawHud(chat) {
    // While a turn is written, the reply before it (its state is the one before).
    const node = state.node ?? latestReply(chat)
    const spec = node ? deps.hudSpec?.(chat, node) ?? null : null
    hudControl.hidden = !spec?.fields?.some(field => field.show !== 'hidden')
    const reached = Boolean(state.node) && state.reached === state.key
    hud.draw({ cardId: chat.cardId, spec, state: (state.node && !reached ? stateBefore(chat, state.node) : node?.state) ?? {} })
  }

  /** The reply read to its end: the HUD moves to its state, and what it changed pops up. */
  function reachEnd() {
    const chat = getChat()
    if (!chat || !state.node || state.reached === state.key) return
    state.reached = state.key
    drawHud(chat)
    hud.notify(changeNotes(deps.hudSpec?.(chat, state.node) ?? null, stateBefore(chat, state.node), state.node.state ?? null))
  }

  function drawStatus(chat) {
    statusButton.hidden = !(state.trailing.length || (state.node && statusFor(chat, state.node)))
  }

  /** The turn's illustrations (配图) as a CG: a small picture in the corner, opened full size. */
  function drawCg(chat) {
    const images = state.node?.media?.images ?? []
    const last = images.at(-1)
    cgButton.hidden = !last
    // Only the corner picture goes: a CG or the 回廊 open from an earlier turn stays until it is closed.
    if (!last) return void delete cgButton.dataset.src
    const src = `/api/media/${chat.id}/${last.file}`
    if (cgButton.dataset.src === src) return
    cgButton.dataset.src = src
    cgButton.replaceChildren(el('img', { src, alt: '' }), el('span', { text: images.length > 1 ? `CG ${images.length}` : 'CG' }))
  }

  /** Every illustration on the story's path so far, oldest first, with the turn it belongs to (0: the opening). */
  function allCgs(chat) {
    const out = []
    let turn = 0
    for (const node of chat?.path ?? []) {
      if (node.role === 'user') turn += 1
      if (node.role !== 'assistant') continue
      for (const image of node.media?.images ?? []) out.push({ src: `/api/media/${chat.id}/${image.file}`, nodeId: node.id, turn, prompt: image.prompt ?? '' })
    }
    return out
  }
  const cgLabel = cg => (cg.turn ? t`第 ${cg.turn} 轮` : t`开场`)

  /**
   * One picture full size, ‹ › through all of them (←/→). Without `start`, this
   * turn's newest; from the gallery, Esc goes back to it.
   */
  function openCg(start = null, fromGallery = false) {
    const chat = getChat()
    const all = allCgs(chat)
    if (!chat || !all.length) return
    setAuto(false)
    closePop()
    let at = start ?? Math.max(0, all.findLastIndex(cg => cg.nodeId === state.node?.id))
    const picture = el('img', { alt: '' })
    const count = el('span', { class: 'vn-cg-count' })
    const show = () => {
      picture.src = all[at].src
      picture.alt = all[at].prompt
      count.textContent = `${cgLabel(all[at])} · ${at + 1} / ${all.length}`
    }
    const step = by => {
      at = (at + by + all.length) % all.length
      show()
    }
    cgView.replaceChildren(picture, el('div', { class: 'vn-cg-tools' }, [
      count,
      ...(all.length > 1 ? [control('‹', t`上一张（←）`, () => step(-1)), control('›', t`下一张（→）`, () => step(1))] : []),
      control(t`回廊`, t`这条故事线上所有的 CG（G）`, () => openGallery()),
      control(t`关闭`, t`Esc`, () => closeCg()),
    ]))
    Object.assign(cgView.dataset, { mode: 'one', back: fromGallery ? '1' : '' })
    state.cgStep = step
    show()
    cgView.hidden = false
  }

  /** CG 回廊: every picture on the story's path as a wall of thumbnails, this turn's marked. */
  function openGallery() {
    const chat = getChat()
    if (!chat) return
    const all = allCgs(chat)
    setAuto(false)
    closePop()
    const grid = el('div', { class: 'vn-gallery-grid' }, all.map((cg, i) => {
      const item = el('button', { type: 'button', class: `vn-gallery-item${cg.nodeId === state.node?.id ? ' here' : ''}`, title: cg.prompt }, [el('img', { src: cg.src, alt: '', loading: 'lazy' }), el('span', { text: cgLabel(cg) })])
      item.addEventListener('click', event => {
        event.stopPropagation()
        openCg(i, true)
      })
      return item
    }))
    cgView.replaceChildren(el('section', { class: 'vn-gallery' }, [
      el('div', { class: 'vn-gallery-head' }, [
        el('b', { text: t`CG 回廊` }),
        el('span', { class: 'muted small', text: all.length ? t`这条故事线上的 ${all.length} 张配图` : '' }),
        control(t`关闭`, t`Esc`, () => closeCg()),
      ]),
      all.length ? grid : el('p', { class: 'vn-waiting', text: t`这条故事线上还没有配图。右上角「配图」开着时，新回复会自动配图。` }),
    ]))
    Object.assign(cgView.dataset, { mode: 'gallery', back: '' })
    state.cgStep = null
    cgView.hidden = false
    grid.querySelector('.here')?.scrollIntoView({ block: 'center' })
  }

  function closeCg() {
    cgView.hidden = true
    cgView.replaceChildren()
    state.cgStep = null
  }
  cgButton.addEventListener('click', event => {
    event.stopPropagation()
    openCg()
  })
  cgView.addEventListener('click', event => {
    event.stopPropagation()
    if (event.target === cgView || event.target.tagName === 'IMG') closeCg()
  })

  /**
   * Where the story is (the newest reply that says, or the one being written
   * once its first lines are complete): the sign, the tint for the time of day, the weather.
   */
  function drawScene(chat, writing) {
    // Where the line on screen happens (its reply's header lines), else where the newest reply says.
    let where = state.stepWhere ?? latestPlace(chat.path)
    if (writing && !state.stepWhere) {
      // Complete lines only: a header still being written would name half a place.
      const live = placeIn(writing.slice(0, writing.lastIndexOf('\n') + 1))
      if (live?.place) where = live
    }
    root.dataset.time = timeOfDay(where?.time) ?? ''
    root.dataset.weather = weatherOf(where?.weather) ?? ''
    const parts = where ? [where.time, where.place, where.weather].filter(Boolean) : []
    sign.replaceChildren(...(parts.length ? [timeBox(el, parts)] : []))
    sign.hidden = !parts.length
    // A later date: the day's title (which names the place too).
    let turned = false
    if (state.day && where?.time) {
      const next = advanceDay(state.day.at, where.time)
      state.day.at = { day: next.day, date: next.date }
      if (next.changed) turned = turnDay(next.day, where)
    }
    // A new place: its name fades in for a moment.
    if (where?.place && where.place !== state.place) {
      if (state.place !== undefined && !turned) {
        title.textContent = where.place
        title.hidden = false
        title.classList.remove('show')
        void title.offsetWidth
        title.classList.add('show')
      }
      state.place = where.place
    }
    showScene(chat, where, Boolean(writing))
  }

  /**
   * A later day: its title across the picture for a moment, once a reply (none for
   * the reply already there when the chat opens). → whether it showed.
   */
  function turnDay(day, where) {
    if (!state.day || state.day.quiet || state.day.shown) return false
    state.day.shown = true
    // The day count is the title; the date line says the rest.
    const time = String(where?.time ?? '').replace(/第\s*[\d零〇一二两三四五六七八九十百]+\s*[天日]|\bday\s*\d+\b/i, '').trim() // i18n-ignore: a day count
    const when = [time, where?.weather].filter(Boolean).join(' · ')
    chapter.replaceChildren(...[el('b', { text: t`第 ${day} 天` }), when ? el('span', { text: when }) : null, where?.place ? el('span', { text: where.place }) : null].filter(Boolean))
    chapter.classList.remove('show')
    void chapter.offsetWidth
    chapter.classList.add('show')
    return true
  }

  // ─── Pictures drawn for the card (server/scenes.mjs): one at a time per card ──
  // `tried`: 立绘 drawn by themselves once this session; one that still gives no picture (no plain background to cut
  // out) is offered again (画立绘), not drawn again and again.
  const art = { jobs: new Map(), queue: new Map(), failed: new Set(), tried: new Set(), error: null }
  // The same news in the library (场景 / 立绘): the window covers the chip under the time box.
  const libraryStatus = el('div', { class: 'vn-library-status', hidden: true, 'aria-live': 'polite' })
  let libraryClock = null

  /**
   * Draws a scene or a 立绘. One runs per card; the rest wait their turn.
   * @param job - { key, label, url, body, done(data) }.
   */
  function enqueue(cardId, job) {
    if (art.jobs.get(cardId)?.key === job.key || (art.queue.get(cardId) ?? []).some(other => other.key === job.key)) return
    if (art.error?.key === job.key) art.error = null
    if (!art.jobs.has(cardId)) return runJob(cardId, job)
    art.queue.set(cardId, [...(art.queue.get(cardId) ?? []), job])
    drawChip()
  }

  async function runJob(cardId, job) {
    const controller = new AbortController()
    art.jobs.set(cardId, { ...job, controller, started: Date.now() })
    drawChip()
    const tick = setInterval(drawChip, 1000)
    try {
      const res = await fetch(job.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' },
        body: JSON.stringify(job.body ?? {}),
        signal: controller.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t`请求失败（${res.status}）`)
      job.done(data)
      if (data.note) toast(data.note, 6000)
    } catch (error) {
      // Failed or cancelled (取消): not drawn again by itself; 画一张, 画立绘, 重试 and the library still can.
      art.failed.add(job.key)
      if (!controller.signal.aborted) art.error = { cardId, key: job.key, label: job.label, message: error.message, job }
    } finally {
      clearInterval(tick)
      art.jobs.delete(cardId)
      const chat = getChat()
      if (chat?.cardId === cardId && state.on) {
        drawScene(chat, null)
        // A new picture may bring someone onto the stage.
        cast.none.clear()
        drawStage()
      }
      if (library?.open) renderLibrary()
      const next = (art.queue.get(cardId) ?? []).shift()
      if (next) runJob(cardId, next)
      else drawChip()
    }
  }

  /** The small sign under the time box: what is being drawn, what failed, what (先问) could be. */
  function drawChip() {
    const cardId = state.cardId
    const job = cardId ? art.jobs.get(cardId) : null
    const waiting = cardId ? (art.queue.get(cardId) ?? []).length : 0
    const parts = []
    if (job) {
      parts.push(el('span', { text: t`正在画「${job.label}」· ${Math.round((Date.now() - job.started) / 1000)} 秒${waiting ? t`，还有 ${waiting} 张排着` : ''}` }))
      parts.push(control(t`取消`, '', () => job.controller.abort()))
    }
    const failed = art.error
    if (failed && failed.cardId === cardId) {
      parts.push(el('span', { class: 'bad', text: t`「${failed.label}」没画成：${failed.message}` }))
      parts.push(control(t`重试`, '', () => {
        art.failed.delete(failed.key)
        enqueue(cardId, failed.job)
      }))
      parts.push(control(t`关掉`, '', () => {
        art.error = null
        drawChip()
      }))
    }
    const now = scenes.current
    if (!job && now?.cardId === cardId && now.place && !now.scene && prefs.newScene === 'ask') {
      parts.push(el('span', { text: t`新地点「${now.place}」还没有背景` }))
      parts.push(control(t`画一张`, '', () => drawPlace(cardId, now.place)))
    }
    const missing = cast.missing
    const offered = missing && (prefs.newSprite === 'ask' || art.tried.has(`sprite:${missing.entry.id}`))
    if (offered && missing.cardId === cardId && !art.jobs.get(cardId)?.key.endsWith(missing.entry.id)) {
      const trouble = spriteTrouble(cardId, missing.entry.id)
      parts.push(el('span', { text: trouble ? t`「${missing.entry.name}」的立绘用不了：${trouble}` : t`「${missing.entry.name}」还没有立绘` }))
      parts.push(control(t`画立绘`, '', () => drawSprite(cardId, missing.entry)))
    }
    sceneChip.replaceChildren(...parts)
    sceneChip.hidden = !parts.length
    drawLibraryStatus()
  }

  /** What is being drawn (or failed) for the library's card. Built again only when that changes, so its buttons stay clickable while the seconds tick. */
  function drawLibraryStatus() {
    const cardId = getChat()?.cardId
    const job = cardId ? art.jobs.get(cardId) : null
    const waiting = cardId ? (art.queue.get(cardId) ?? []).length : 0
    const failed = art.error?.cardId === cardId ? art.error : null
    const line = job ? t`正在画「${job.label}」· ${Math.round((Date.now() - job.started) / 1000)} 秒${waiting ? t`，还有 ${waiting} 张排着` : ''}` : ''
    const shown = [job?.key, job?.started, waiting, failed?.key, failed?.message].join('|')
    if (shown === libraryStatus.dataset.shown) {
      if (libraryClock) libraryClock.textContent = line
      return
    }
    libraryStatus.dataset.shown = shown
    libraryClock = job ? el('span', { text: line }) : null
    const parts = []
    if (job) parts.push(el('span', { class: 'vn-library-spin', 'aria-hidden': 'true' }), libraryClock, act(t`取消`, () => job.controller.abort()))
    if (failed) {
      parts.push(el('span', { class: 'bad', text: t`「${failed.label}」没画成：${failed.message}` }))
      parts.push(act(t`重试`, () => {
        art.failed.delete(failed.key)
        enqueue(cardId, failed.job)
      }))
      parts.push(act(t`关掉`, () => {
        art.error = null
        drawChip()
      }))
    }
    libraryStatus.replaceChildren(...parts)
    libraryStatus.hidden = !parts.length
  }

  // ─── Scenes: a background per place, drawn once per card ──────────
  const scenes = { lists: new Map(), loading: new Map(), current: null }
  const pins = () => recall(PINS_KEY, {})

  async function scenesOf(cardId) {
    if (scenes.lists.has(cardId)) return scenes.lists.get(cardId)
    if (!scenes.loading.has(cardId)) {
      const loading = api(`/api/cards/${cardId}/scenes`)
        .then(view => view.scenes)
        .catch(() => [])
        .then(list => {
          scenes.lists.set(cardId, list)
          scenes.loading.delete(cardId)
          return list
        })
      scenes.loading.set(cardId, loading)
    }
    return scenes.loading.get(cardId)
  }

  function setBackground(cardId, scene) {
    const url = scene?.file ? `/api/scenes/${cardId}/${scene.file}` : ''
    if (bg.dataset.url === url) return
    bg.dataset.url = url
    bg.style.backgroundImage = url ? `url("${url}")` : ''
  }

  /** The place's picture (or the one drawn for this chat's turn there), or the fallback while it has none. */
  async function showScene(chat, where, writing) {
    const list = await scenesOf(chat.cardId)
    if (getChat()?.id !== chat.id || !state.on) return
    // A place with nothing to tell it by (???, ……) is none: no scene could ever match it, so each picture drawn
    // for it would start another.
    const place = normalizePlace(where?.place) ? where.place : ''
    let scene = place ? matchScene(place, list) : null
    const pin = pins()[chat.id]
    if (pin && pin.place === place) scene = list.find(item => item.id === pin.sceneId) ?? scene
    scenes.current = { cardId: chat.cardId, place, scene }
    setBackground(chat.cardId, scene)
    if (!scene && place && !writing && prefs.newScene === 'auto') autoDraw(chat.cardId, place)
    drawChip()
  }

  function toldOnce(key, text) {
    if (prefs[key]) return
    prefs[key] = true
    remember(PREFS_KEY, prefs)
    toast(text, 7000)
  }

  function autoDraw(cardId, place) {
    if (art.failed.has(`scene:${place}`)) return
    toldOnce('toldAuto', t`到了新地点，会自动画一张背景。不想自动画，可以在「场景」里改成「先问」或「不画」。`)
    drawPlace(cardId, place)
  }

  /** Draws a place's background (or a scene again: extra.sceneId). */
  function drawPlace(cardId, place, extra = {}) {
    enqueue(cardId, {
      key: extra.sceneId ? `scene-again:${extra.sceneId}` : `scene:${place}`,
      label: place,
      url: `/api/cards/${cardId}/scenes/draw`,
      body: { place, ...extra },
      done: data => scenes.lists.set(cardId, data.scenes),
    })
  }

  /** 画这一轮的场景: the helper reads the latest reply; the picture becomes this chat's background here. */
  function drawTurn(cardId) {
    const chat = getChat()
    const node = latestReply(chat)
    if (!chat || !node) return
    const passage = storyLines(chat, node, true).map(step => step.plain).join('\n').slice(0, 4000)
    if (!passage.trim()) return toast(t`这一轮没有能读的正文`)
    const place = scenes.current?.cardId === cardId ? scenes.current.place : ''
    enqueue(cardId, {
      key: `turn:${chat.id}:${node.id}`,
      label: place || t`这一轮的场景`,
      url: `/api/cards/${cardId}/scenes/draw`,
      body: { passage, place },
      done: data => {
        scenes.lists.set(cardId, data.scenes)
        remember(PINS_KEY, { ...pins(), [chat.id]: { place, sceneId: data.scene.id } })
      },
    })
  }

  // ─── 立绘: the ones in the scene, cut out of a plain background ──────
  // lists: { entryId: 立绘 }; faces: { entryId: { smile: … } } (表情差分); none: names with no picture at all;
  // why: a picture's address → why it could not be cut out (cutOut's why, or 'load').
  const cast = { lists: new Map(), faces: new Map(), loading: new Map(), cuts: new Map(), why: new Map(), token: 0, missing: null, none: new Map() }

  /** A sprites view from the server (GET, a drawing, an upload) becomes the lists. */
  function takeSprites(cardId, view) {
    cast.lists.set(cardId, view?.sprites ?? {})
    cast.faces.set(cardId, view?.expressions ?? {})
  }

  async function spritesOf(cardId) {
    if (cast.lists.has(cardId)) return cast.lists.get(cardId)
    if (!cast.loading.has(cardId)) {
      cast.loading.set(cardId, api(`/api/cards/${cardId}/sprites`)
        .catch(() => ({}))
        .then(view => {
          takeSprites(cardId, view)
          cast.loading.delete(cardId)
          return cast.lists.get(cardId)
        }))
    }
    return cast.loading.get(cardId)
  }

  const memberOf = (cardId, entry) => (entry?.id ? (state.roster.get(cardId) ?? []).find(member => member.id === entry.id) ?? null : null)

  /** Pictures that may stand for someone, best first: their 立绘, their reference picture, the card's picture (its own character). */
  function spriteSources(cardId, entry, list) {
    const out = []
    const drawn = entry.id ? list[entry.id] : null
    if (drawn) out.push({ url: `/api/sprites/${cardId}/${drawn.file}`, kind: 'sprite' })
    if (memberOf(cardId, entry)?.ref) out.push({ url: `/api/cards/${cardId}/roster/${entry.id}/ref`, kind: 'ref' })
    if (entry.char && cardOf(cardId)?.hasAvatar) out.push({ url: `/api/cards/${cardId}/avatar`, kind: 'avatar' })
    return out
  }

  /** A picture with its plain background cut out → an object URL, or null when its background is not plain. */
  function cutPicture(url) {
    if (!cast.cuts.has(url)) {
      cast.cuts.set(url, (async () => {
        const blob = await fetch(url).then(res => (res.ok ? res.blob() : null)).catch(() => null)
        if (!blob) return null
        const bitmap = await createImageBitmap(blob).catch(() => null)
        if (!bitmap) {
          cast.why.set(url, 'load')
          return null
        }
        const scale = Math.min(1, SPRITE_SIDE / bitmap.height)
        const width = Math.round(bitmap.width * scale)
        const height = Math.round(bitmap.height * scale)
        const canvas = Object.assign(document.createElement('canvas'), { width, height })
        const context = canvas.getContext('2d', { willReadFrequently: true })
        context.drawImage(bitmap, 0, 0, width, height)
        bitmap.close()
        const image = context.getImageData(0, 0, width, height)
        const result = cutOut(image)
        if (!result.ok) {
          cast.why.set(url, result.why)
          return null
        }
        context.putImageData(image, 0, 0)
        // Just the figure, so it stands on the bottom edge (a whole one from the thighs up, like the rest).
        const { x, y, width: w, height: h } = spriteFrame(image, result.box)
        const out = Object.assign(document.createElement('canvas'), { width: w, height: h })
        out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h)
        const png = await new Promise(resolve => out.toBlob(resolve, 'image/png'))
        return png ? URL.createObjectURL(png) : null
      })())
    }
    return cast.cuts.get(url)
  }

  /** Why someone's drawn or uploaded 立绘 is not used (cut out in cutPicture first), '' when it is or there is none. */
  function spriteTrouble(cardId, entryId) {
    const sprite = entryId ? cast.lists.get(cardId)?.[entryId] : null
    const why = sprite ? cast.why.get(`/api/sprites/${cardId}/${sprite.file}`) : ''
    return why ? WHY_UNUSABLE[why] ?? WHY_UNUSABLE.load : ''
  }

  /** The 立绘 that would show for someone: { src, kind } or null. */
  async function spriteFor(cardId, entry) {
    const list = await spritesOf(cardId)
    for (const source of spriteSources(cardId, entry, list)) {
      const src = await cutPicture(source.url)
      if (src) return { src, kind: source.kind }
    }
    return null
  }

  /** Someone's picture with an expression: that 表情 when it has been drawn, else their 立绘. → object URL or null. */
  async function actorPicture(cardId, entry, expression) {
    await spritesOf(cardId)
    const face = expression !== 'neutral' && entry.id ? cast.faces.get(cardId)?.[entry.id]?.[expression] : null
    if (face) {
      const src = await cutPicture(`/api/sprites/${cardId}/${face.file}`)
      if (src) return src
    }
    return (await spriteFor(cardId, entry))?.src ?? null
  }

  /** Who may stand on the stage: someone in the cast who is not the player, unless they turned out to have no picture. */
  function isActor(name) {
    const entry = state.names.find(item => item.name === name)
    return Boolean(entry && !entry.player && !cast.none.has(`${state.cardId}:${name}`))
  }

  // name → { box, src }: the ones standing there now.
  const onStage = new Map()

  /**
   * The stage for the line on screen (web/shared/stage.js): who stands where,
   * the speaker lit and the rest dimmed, each with their expression; with
   * `effects`, the line's shake, flash or hop plays (once, as the line arrives).
   */
  async function drawStage({ effects = false } = {}) {
    const token = ++cast.token
    const cardId = state.cardId
    const step = state.steps[state.index]
    if (!cardId || step?.type !== 'line') return clearStage()
    const narrow = matchMedia(NARROW).matches
    const layout = stageAt(state.steps, state.index, { names: state.names, max: narrow ? 2 : 3, isActor, labels: faceLabels.get(state.key) })
    const members = await Promise.all(layout.members.map(async member => {
      const entry = state.names.find(item => item.name === member.name)
      return { ...member, entry, src: entry ? await actorPicture(cardId, entry, member.expression) : null }
    }))
    if (token !== cast.token || !state.on) return
    // No picture at all: off the stage (a 立绘 drawn later brings them back); the speaker may get one drawn (自动 / 先问).
    const missing = members.filter(member => !member.src)
    if (missing.length) {
      for (const member of missing) cast.none.set(`${cardId}:${member.name}`, true)
      const speaker = missing.find(member => member.name === step.speaker && step.kind === 'dialogue')
      if (speaker?.entry) missingSprite(cardId, speaker.entry)
      return drawStage({ effects })
    }
    if (layout.speaker && cast.missing) {
      cast.missing = null
      drawChip()
    }
    const places = SLOTS[members.length] ?? []
    for (const [name, actor] of onStage) {
      if (members.some(member => member.name === name)) continue
      onStage.delete(name)
      actor.box.classList.remove('show')
      setTimeout(() => actor.box.remove(), 360)
    }
    members.forEach((member, i) => {
      let actor = onStage.get(member.name)
      if (!actor) {
        actor = { box: el('div', { class: 'vn-actor' }), src: '' }
        onStage.set(member.name, actor)
        actors.append(actor.box)
        // Laid out once where it starts, so it fades and rises in.
        void actor.box.offsetWidth
        actor.box.classList.add('show')
      }
      actor.box.style.setProperty('--x', `${places[i]}%`)
      actor.box.dataset.who = member.name
      actor.box.dataset.expression = member.expression
      actor.box.classList.toggle('speaking', member.name === layout.speaker)
      actor.box.classList.toggle('idle', Boolean(layout.speaker) && member.name !== layout.speaker)
      if (actor.src !== member.src) setPicture(actor, member.src)
    })
    actors.classList.toggle('narration', !layout.speaker)
    actors.dataset.count = String(members.length)
    if (effects) playEffects(layout)
  }

  /** A new picture for someone on stage (another expression): the new one fades in over the old. */
  function setPicture(actor, src) {
    actor.src = src
    const image = el('img', { alt: '' })
    image.onload = () => {
      if (actor.src !== src) return image.remove()
      for (const old of actor.box.querySelectorAll('img.show')) {
        old.classList.remove('show')
        setTimeout(() => old.remove(), 320)
      }
      image.classList.add('show')
    }
    actor.box.append(image)
    image.src = src
  }

  /** Once, as a line arrives: the picture shakes or flashes, the speaker hops or trembles. */
  function playEffects(layout) {
    if (prefs.effects === false || reducedMotion()) return
    const replay = (node, name) => {
      node.classList.remove(name)
      void node.offsetWidth
      node.classList.add(name)
      node.addEventListener('animationend', () => node.classList.remove(name), { once: true })
    }
    const { screen, actor } = layout.effects
    if (screen === 'shake') replay(root, 'vn-shake')
    if (screen === 'flash') replay(flash, 'on')
    const speaker = layout.speaker && onStage.get(layout.speaker)
    if (actor && speaker) replay(speaker.box, actor)
  }

  /** Nobody on stage (a card's panel, waiting for the first line, leaving the mode). */
  function clearStage(forgetMissing = true) {
    cast.token++
    for (const actor of onStage.values()) {
      actor.box.classList.remove('show')
      setTimeout(() => actor.box.remove(), 360)
    }
    onStage.clear()
    if (forgetMissing && cast.missing) {
      cast.missing = null
      drawChip()
    }
  }

  /** Someone speaking with no picture to cut out: draw a 立绘 (自动), offer to (先问), or nothing. */
  function missingSprite(cardId, entry) {
    const member = memberOf(cardId, entry)
    cast.missing = member?.looks ? { cardId, entry } : null
    const key = `sprite:${entry.id}`
    if (cast.missing && prefs.newSprite === 'auto' && !art.failed.has(key) && !art.tried.has(key)) {
      toldOnce('toldSprite', t`说话的角色没有能用的立绘时，会按名单里的长相画一张半身立绘。不想自动画，可以在「立绘」里改成「先问」或「不画」。`)
      art.tried.add(key)
      drawSprite(cardId, entry)
    }
    drawChip()
  }

  /**
   * @param choice - { backend, model } for this one (做成视觉小说 picks it first), {} = as the settings say.
   * @param after - run once it is drawn (its 表情 wait for it: one drawn without it fails).
   */
  function drawSprite(cardId, entry, choice = {}, after = null) {
    enqueue(cardId, {
      key: `sprite:${entry.id}`,
      label: t`${entry.name}的立绘`,
      url: `/api/cards/${cardId}/sprites/${entry.id}/draw`,
      body: choice,
      done: data => {
        takeSprites(cardId, data)
        after?.()
      },
    })
  }

  /** One 表情 of someone's 立绘, drawn from it (the queue takes them one at a time). */
  function drawFace(cardId, entry, face, choice = {}) {
    enqueue(cardId, {
      key: `face:${entry.id}:${face}`,
      label: t`${entry.name}·${FACE_LABEL[face]}`,
      url: `/api/cards/${cardId}/sprites/${entry.id}/expressions/${face}/draw`,
      body: choice,
      done: data => takeSprites(cardId, data),
    })
  }

  /**
   * 一键备齐 / 做成视觉小说, step by step:
   *   1. how to draw (deps.pickDraw: any 画图方式 set up, or set one up; for these pictures only);
   *   2. the 角色名册: with nobody in it with looks, the helper drafts it from the card and it is saved;
   *   3. a 立绘 for each cast member with looks and none drawn or uploaded;
   *   4. each one's missing 表情, queued once their 立绘 is there (left out when the method picked
   *      cannot draw from a picture: they would come out as someone else);
   *   5. a background for each of `places` with none yet.
   * Asks before drawing, with the count: every picture costs a drawing.
   * @param options.places - place names to give a background (创作角色卡's plan, the place the story is at).
   * @returns how many were queued.
   */
  async function prepare(cardId, { places = [] } = {}) {
    if (!cardId) return 0
    const picked = deps.pickDraw
      ? await deps.pickDraw({ title: t`用什么画立绘、表情和场景`, action: t`下一步`, batch: true, note: t`还没配置画图接口的话，点左下角「设置画图方式…」。` })
      : { body: {}, label: '' }
    if (!picked) return 0
    const choice = picked.body ?? {}
    await loadRoster(cardId, true)
    let roster = (state.roster.get(cardId) ?? []).filter(member => !member.player && member.looks)
    if (!roster.length) {
      if (!confirm(t`这张卡的角色名册里还没有写了长相的角色。让辅助模型读卡，列出角色和长相，存进角色名册（之后可以在「配图 → 角色名册」里改）？`)) return 0
      toast(t`辅助模型正在读卡列角色名册…`, 60000)
      const { roster: drafted } = await api(`/api/cards/${cardId}/roster/draft`, { method: 'POST', body: {} })
      const before = state.roster.get(cardId) ?? []
      const hasPlayer = before.some(member => member.player)
      const fresh = drafted.filter(entry => !before.some(member => member.name === entry.name)).map(entry => ({ ...entry, player: entry.player && !hasPlayer }))
      await api(`/api/cards/${cardId}/media`, { method: 'PUT', body: { roster: [...before, ...fresh] } })
      await loadRoster(cardId, true)
      roster = (state.roster.get(cardId) ?? []).filter(member => !member.player && member.looks)
      toast(roster.length ? t`角色名册列好了：${roster.map(member => member.name).join(t`、`)}` : t`辅助模型没列出写了长相的角色，先在「配图 → 角色名册」里补上`, 6000)
      if (!roster.length) return 0
    }
    const [list, sceneList] = await Promise.all([spritesOf(cardId), scenesOf(cardId)])
    const faces = cast.faces.get(cardId) ?? {}
    const chat = getChat()
    const names = speakerNames({ char: chat?.names?.char, user: chat?.names?.user, roster })
    const entryOf = member => names.find(item => item.id === member.id) ?? { name: member.name, id: member.id, keys: [] }
    const missingFaces = member => EXPRESSIONS.filter(name => name !== 'neutral' && !faces[member.id]?.[name])
    const sprites = roster.filter(member => !list[member.id])
    const fromPicture = (await api('/api/media/draws-from-picture', { method: 'POST', body: choice }).catch(() => null))?.drawsFromPicture !== false
    const faceCount = fromPicture ? roster.reduce((n, member) => n + missingFaces(member).length, 0) : 0
    const backgrounds = [...new Set(places.map(place => String(place ?? '').trim()).filter(Boolean))].filter(place => !matchScene(place, sceneList))
    const total = sprites.length + faceCount + backgrounds.length
    const noFaces = fromPicture ? '' : t`选的画图方式不能照着立绘改表情（重画出来会像另一个人），表情先不画：可以换成能参考图片的画图方式，或者导入表情包。`
    if (!total) {
      toast(noFaces || t`立绘、表情和场景都已经齐了`, noFaces ? 8000 : undefined)
      return 0
    }
    const counts = [sprites.length ? t`${sprites.length} 张立绘` : '', faceCount ? t`${faceCount} 个表情` : '', backgrounds.length ? t`${backgrounds.length} 张场景` : ''].filter(Boolean).join(t`、`)
    const how = picked.label ? t`用「${picked.label}」` : t`用设置里的画图方式`
    if (!confirm([t`${how}画 ${counts}：先画立绘，某个人的立绘画好了才画他的表情；一张一张来，进度显示在「立绘」窗口顶部，可以随时取消。用付费接口时每张都会计费。开始？`, noFaces].filter(Boolean).join('\n\n'))) return 0
    const queueFaces = member => {
      if (fromPicture) for (const name of missingFaces(member)) drawFace(cardId, entryOf(member), name, choice)
    }
    for (const member of roster) {
      if (list[member.id]) queueFaces(member)
      else drawSprite(cardId, entryOf(member), choice, () => queueFaces(member))
    }
    for (const place of backgrounds) drawPlace(cardId, place, choice)
    if (library?.open) renderLibrary()
    return total
  }

  // ─── The library (场景 / 立绘) ───────────────────────────────────────
  let library = null
  let libraryTab = 'scenes'

  function openLibrary(tab = libraryTab) {
    setAuto(false)
    libraryTab = tab
    // The 角色名册 may have changed since (another window, another device): read it again.
    loadRoster(getChat()?.cardId, true)
    if (!library) {
      library = el('dialog', { class: 'dialog vn-library' })
      document.body.append(library)
    }
    renderLibrary()
    if (!library.open) library.showModal()
  }

  async function sceneCall(cardId, url, method, body) {
    const view = await api(url, { method, body })
    scenes.lists.set(cardId, view.scenes)
    const chat = getChat()
    if (chat?.cardId === cardId && state.on) drawScene(chat, null)
    renderLibrary()
    return view
  }

  /** A picture file from the player. */
  const pickPicture = () => new Promise(resolve => {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' })
    input.addEventListener('change', () => resolve(input.files[0] ?? null))
    input.click()
  })

  const act = (label, fn, extra = {}) => {
    const b = el('button', { type: 'button', class: `btn small${extra.danger ? ' danger' : ''}`, text: label, disabled: extra.disabled, title: extra.title })
    b.addEventListener('click', guard(fn))
    return b
  }

  /** A picture in the library that opens full size (web/media.js's image viewer); `cutout` shows it on a checkerboard. */
  const zoomable = (img, caption, cutout = true) => {
    if (!deps.viewPicture) return img
    img.classList.add('zoomable')
    img.title = t`点击放大`
    img.addEventListener('click', () => deps.viewPicture(img.src, caption, '', { cutout }))
    return img
  }

  /** 到了新地点 / 没有立绘的角色说话时: 自动画, 先问, 不画. */
  function artMode(key, label, after = renderLibrary) {
    const seg = el('div', { class: 'seg' }, Object.entries(NEW_ART).map(([value, text]) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(prefs[key] === value), text })
      b.addEventListener('click', () => {
        prefs[key] = value
        remember(PREFS_KEY, prefs)
        after()
        drawChip()
      })
      return b
    }))
    return el('div', { class: 'row vn-library-mode' }, [el('span', { class: 'muted small', text: label }), seg])
  }

  async function renderLibrary() {
    const chat = getChat()
    const cardId = chat?.cardId
    if (!library || !cardId) return
    const tabs = el('div', { class: 'seg vn-library-tabs' }, [['scenes', t`场景`], ['sprites', t`立绘`]].map(([value, text]) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(libraryTab === value), text })
      b.addEventListener('click', () => {
        libraryTab = value
        renderLibrary()
      })
      return b
    }))
    // 抽图历史 (server/draw-history.mjs): each place's old pictures, under it (a server without them: none).
    const kept = (await api(`/api/cards/${cardId}/history`).catch(() => null))?.slots ?? {}
    const body = libraryTab === 'sprites' ? await spriteTab(chat, cardId, kept) : await sceneTab(chat, cardId, kept)
    if (!library) return
    drawLibraryStatus()
    library.replaceChildren(
      el('div', { class: 'vn-library-top' }, [el('h2', { text: libraryTab === 'sprites' ? t`立绘` : t`场景` }), tabs]),
      libraryStatus,
      ...body,
      el('form', { method: 'dialog', class: 'row end' }, [el('button', { class: 'btn', text: t`关闭` })]),
    )
  }

  /** A place's old pictures: one taken back takes its place (`taken` gets the server's view), × deletes one. */
  function oldRow(cardId, items, title, taken) {
    return el('div', { class: 'vn-old' }, [historyStrip(el, items, {
      title,
      onPick: guard(async item => taken(await api(`/api/cards/${cardId}/history/${item.file}/use`, { method: 'POST' }))),
      onRemove: guard(async item => {
        await api(`/api/cards/${cardId}/history/${item.file}`, { method: 'DELETE' })
        renderLibrary()
      }),
    })])
  }

  /** A 立绘 or expression taken back: the lists, the stage and the library follow. */
  function spriteTaken(cardId, view) {
    takeSprites(cardId, view)
    cast.none.clear()
    if (getChat()?.cardId === cardId && state.on) drawStage()
    renderLibrary()
  }

  async function sceneTab(chat, cardId, kept = {}) {
    const list = await scenesOf(cardId)
    const place = scenes.current?.cardId === cardId ? scenes.current.place : ''
    const shown = scenes.current?.cardId === cardId ? scenes.current.scene : null
    const matched = place ? matchScene(place, list) : null
    const head = el('div', { class: 'vn-library-head' }, [
      el('p', {
        text: place
          ? shown ? t`现在在「${place}」，用的是「${shown.name}」。` : t`现在在「${place}」，还没有背景。`
          : t`回复里还没出现地点（时间框、回复开头写日期时间和地点的一行、或者变量里的「当前地点」都算）。`,
      }),
      el('div', { class: 'row' }, [
        act(t`画这一轮的场景`, () => drawTurn(cardId), { title: t`辅助模型读最新一轮回复，画出当时的地点（不带人物），作为这个对话这里的背景` }),
        place && !matched ? act(t`给这里画一张`, () => drawPlace(cardId, place)) : null,
        place && matched && matched.name !== place ? act(t`这不是这里，另画一张`, () => drawPlace(cardId, place)) : null,
        act(t`上传一张`, async () => {
          const file = await pickPicture()
          if (!file) return
          const name = place || prompt(t`这张图是哪个地点？`, '')?.trim()
          if (!name) return
          await sceneCall(cardId, `/api/cards/${cardId}/scenes`, 'POST', { name, image: await shrink(file) })
        }),
      ]),
      artMode('newScene', t`到了新地点：`),
    ])
    const grid = el('div', { class: 'vn-library-grid' }, list.length ? list.map(scene => {
      const thumb = scene.file ? zoomable(el('img', { src: `/api/scenes/${cardId}/${scene.file}`, alt: '', loading: 'lazy' }), scene.name, false) : el('div', { class: 'vn-library-empty', text: t`没有图` })
      const tools = [
        place && scene !== shown ? act(t`用在这里`, async () => {
          // A scene chosen here wins over a pinned turn's picture.
          const all = pins()
          delete all[chat.id]
          remember(PINS_KEY, all)
          await sceneCall(cardId, `/api/cards/${cardId}/scenes/${scene.id}`, 'PUT', { aliases: [...scene.aliases, place] })
        }) : null,
        act(t`重画`, () => drawPlace(cardId, scene.name, { sceneId: scene.id })),
        act(t`换提示词重画`, () => drawPlace(cardId, scene.name, { sceneId: scene.id, rewrite: true })),
        act(t`上传替换`, async () => {
          const file = await pickPicture()
          if (file) await sceneCall(cardId, `/api/cards/${cardId}/scenes/${scene.id}/image`, 'PUT', { image: await shrink(file) })
        }),
        act(t`改名和别名`, async () => {
          const name = prompt(t`场景名字`, scene.name)?.trim()
          if (!name) return
          const aliases = prompt(t`别名（也算这个场景的地点），用逗号分开`, scene.aliases.join(t`，`))
          if (aliases === null) return
          await sceneCall(cardId, `/api/cards/${cardId}/scenes/${scene.id}`, 'PUT', { name, aliases: aliases.split(/[,，、]/).map(a => a.trim()).filter(Boolean) })
        }),
        act(t`删除`, async () => {
          if (confirm(t`删除场景「${scene.name}」？`)) await sceneCall(cardId, `/api/cards/${cardId}/scenes/${scene.id}`, 'DELETE')
        }, { danger: true }),
      ]
      return el('figure', { class: `vn-library-item${scene === shown ? ' current' : ''}` }, [
        thumb,
        el('figcaption', {}, [el('b', { text: scene.name }), scene.aliases.length ? el('span', { class: 'muted small', text: scene.aliases.join(t`、`) }) : null]),
        el('div', { class: 'row' }, tools),
        oldRow(cardId, keptItems(cardId, kept[`scene:${scene.id}`]), t`旧图`, view => {
          scenes.lists.set(cardId, view.scenes)
          if (getChat()?.cardId === cardId && state.on) drawScene(getChat(), null)
          renderLibrary()
        }),
      ])
    }) : [el('p', { class: 'muted small', text: t`还没有场景。到了新地点会画一张，也可以在上面上传。` })])
    return [head, grid]
  }

  async function spriteTab(chat, cardId, kept = {}) {
    const roster = state.roster.get(cardId) ?? []
    const list = await spritesOf(cardId)
    const toggleRow = (text, hint, on, onChange) => {
      const input = el('input', { type: 'checkbox', class: 'switch', checked: on })
      input.addEventListener('change', () => onChange(input.checked))
      return el('label', { class: 'vn-pop-switch' }, [el('span', {}, [text, el('small', { text: hint })]), input])
    }
    const head = el('div', { class: 'vn-library-head' }, [
      el('p', { text: t`场景里说话的人站在台上（电脑最多三个，手机两个），说话的亮、其余的暗下去，换地点时退场。名单里白底的人设图会自动抠出来用；背景不是纯色的（或者没有人设图），可以按名单里的长相画一张半身立绘。` }),
      el('p', { class: 'muted small', text: formatOn(chat)
        ? t`表情：按模型在每句对白前标的【名字|表情】换；没标的按引号前后的叙述换（笑了笑→微笑、红了脸→害羞……），认不出就保持上一个。下面每个人可以画一套表情，在立绘上只改脸。`
        : t`表情：每句按引号前后的叙述换（笑了笑→微笑、红了脸→害羞、皱眉→生气……），认不出就保持上一个。下面每个人可以画一套表情，在立绘上只改脸。` }),
      artMode('newSprite', t`没有立绘的角色说话时：`),
      el('div', { class: 'row' }, [act(t`一键备齐`, () => prepare(cardId, { places: scenes.current?.cardId === cardId && scenes.current.place ? [scenes.current.place] : [] }), { title: t`名单里还没有立绘的人画立绘，再给每个人画齐表情；现在的地点没有背景的话也画一张` })]),
      // Speakers are told apart by the 名册's names and aliases: one the story calls otherwise has no 立绘.
      deps.openMedia ? el('div', { class: 'vn-library-tip' }, [
        el('span', { class: 'muted small', text: t`有角色的立绘显示不出来，或者故事里给角色起了外号、别名：打开角色名册，点「从对话里补充」，按最近的对话更新名册。` }),
        act(t`打开角色名册`, () => {
          library.close()
          deps.openMedia('roster')
        }),
      ]) : null,
      toggleRow(t`对白标注`, builtinPreset(chat)
        ? t`让模型给每句对白标上说话人和表情，再加上震屏、闪白这类效果，比按叙述猜准。只加在每轮的消息里，开关不影响缓存。`
        : t`让模型给每句对白标上说话人和表情，比按叙述猜准。这个对话用的是导入的预设，默认不开：两套输出格式可能冲突，打开后看几轮再决定。只加在每轮的消息里，开关不影响缓存。`, formatOn(chat), on => {
        setFormat(cardId, on)
        renderLibrary()
      }),
      toggleRow(t`演出效果`, t`闪电、巨响时画面闪白、震动，吓一跳时立绘跳一下，回忆的段落泛黄`, prefs.effects !== false, on => {
        prefs.effects = on
        remember(PREFS_KEY, prefs)
      }),
      toggleRow(t`用辅助模型判断表情`, t`每轮写完后，辅助模型逐句标一次表情，比看叙述准；每轮多一次小请求，发给主模型的内容不变`, Boolean(prefs.faceHelper), on => {
        prefs.faceHelper = on
        remember(PREFS_KEY, prefs)
        if (on) labelFaces()
      }),
    ])
    if (!roster.some(member => !member.player)) {
      return [head, el('div', { class: 'vn-library-head' }, [
        el('p', { text: t`这张卡还没有角色名单。在「配图 → 角色名单」里列出角色和长相（可以让辅助模型从卡里列），每个角色就能有立绘；没有名单时，卡的头像是白底的也能直接用。` }),
        deps.openMedia ? el('div', { class: 'row' }, [act(t`打开角色名单`, () => {
          library.close()
          deps.openMedia('roster')
        })]) : null,
      ])]
    }
    const members = [...roster.filter(member => !member.player), ...roster.filter(member => member.player)]
    const names = speakerNames({ char: chat.names?.char, user: chat.names?.user, roster })
    const grid = el('div', { class: 'vn-library-grid sprites' }, members.map(member => {
      const entry = names.find(item => item.id === member.id) ?? { name: member.name, id: member.id, keys: [] }
      const thumb = el('div', { class: 'vn-library-sprite' }, [el('span', { class: 'muted small', text: '…' })])
      const kindLabel = el('span', { class: 'muted small' })
      const drawn = list[member.id]
      const drawnLabel = drawn?.source === 'upload' ? t`上传的立绘` : t`画的立绘`
      // A 立绘 there that cannot be cut out says why (the picture shown is then the 人设图, or none).
      const troubleLine = el('span', { class: 'muted small', hidden: true })
      spriteFor(cardId, entry).then(found => {
        kindLabel.textContent = found ? { sprite: drawnLabel, ref: t`人设图抠出`, avatar: t`头像抠出` }[found.kind] : ''
        thumb.replaceChildren(found ? zoomable(el('img', { src: found.src, alt: '' }), t`${entry.name} · ${kindLabel.textContent}`) : el('span', { class: 'muted small', text: t`没有能用的图` }))
        const trouble = found?.kind === 'sprite' ? '' : spriteTrouble(cardId, member.id)
        troubleLine.textContent = trouble ? t`${drawnLabel}用不了：${trouble}` : ''
        troubleLine.hidden = !trouble
      })
      // Drawn from the looks the 名册 had then (scenes.mjs keeps them): they have changed since.
      const changed = drawn?.source === 'drawn' && typeof drawn.looks === 'string' && (drawn.looks !== (member.looks ?? '') || drawn.outfit !== (member.outfit ?? ''))
      const busy = art.jobs.get(cardId)?.key === `sprite:${member.id}`
      const tools = [
        act(drawn ? t`重画` : t`画立绘`, () => drawSprite(cardId, entry), { disabled: !member.looks || busy, title: member.looks ? '' : t`先在「配图 → 角色名单」里写长相` }),
        act(t`上传`, async () => {
          const file = await pickPicture()
          if (!file) return
          takeSprites(cardId, await api(`/api/cards/${cardId}/sprites/${member.id}`, { method: 'PUT', body: { image: await asPng(file) } }))
          cast.none.clear()
          renderLibrary()
        }),
        drawn ? act(t`删除`, async () => {
          if (!confirm(t`删除${member.name}的立绘？（人设图不受影响）`)) return
          takeSprites(cardId, await api(`/api/cards/${cardId}/sprites/${member.id}`, { method: 'DELETE' }))
          renderLibrary()
        }, { danger: true }) : null,
      ]
      return el('figure', { class: 'vn-library-item' }, [
        thumb,
        el('figcaption', {}, [el('b', { text: member.player ? t`${entry.name}（玩家）` : entry.name }), kindLabel, troubleLine, changed ? el('span', { class: 'muted small', text: t`名册里的长相改过了，重画会按现在的画` }) : null]),
        el('div', { class: 'row' }, tools),
        oldRow(cardId, keptItems(cardId, kept[`sprite:${member.id}`]), t`旧立绘`, view => spriteTaken(cardId, view)),
        member.player ? null : pack?.cardId === cardId && pack.memberId === member.id ? packView(cardId, entry, member) : faceRow(cardId, entry, member, Boolean(drawn || member.ref), kept),
      ])
    }))
    return [head, grid]
  }

  /** Someone's expressions: each drawn from their 立绘 (or uploaded), and 画一套 for the ones missing. */
  function faceRow(cardId, entry, member, canDraw, kept = {}) {
    const faces = cast.faces.get(cardId)?.[member.id] ?? {}
    const names = EXPRESSIONS.filter(name => name !== 'neutral')
    const queued = name => art.jobs.get(cardId)?.key === `face:${member.id}:${name}` || (art.queue.get(cardId) ?? []).some(job => job.key === `face:${member.id}:${name}`)
    const cells = names.map(name => {
      const face = faces[name]
      const picture = el('div', { class: 'vn-face-pic' }, [el('span', { class: 'muted small', text: queued(name) ? '…' : '—' })])
      if (face) cutPicture(`/api/sprites/${cardId}/${face.file}`).then(src => src && picture.replaceChildren(zoomable(el('img', { src, alt: '' }), t`${entry.name} · ${FACE_LABEL[name]}`)))
      const tools = el('div', { class: 'vn-face-tools' }, [
        act(face ? t`重画` : t`画`, () => drawFace(cardId, entry, name), { disabled: !canDraw || queued(name), title: canDraw ? '' : t`先画或上传立绘（或在名单里放人设图）` }),
        act(t`传`, async () => {
          const file = await pickPicture()
          if (!file) return
          takeSprites(cardId, await api(`/api/cards/${cardId}/sprites/${member.id}/expressions/${name}`, { method: 'PUT', body: { image: await asPng(file) } }))
          renderLibrary()
        }, { title: t`上传这个表情` }),
        face ? act('×', async () => {
          takeSprites(cardId, await api(`/api/cards/${cardId}/sprites/${member.id}/expressions/${name}`, { method: 'DELETE' }))
          renderLibrary()
        }, { title: t`删除这个表情`, danger: true }) : null,
      ])
      return el('div', { class: 'vn-face' }, [picture, el('span', { class: 'small', text: FACE_LABEL[name] }), tools])
    })
    const missing = names.filter(name => !faces[name] && !queued(name))
    return el('div', { class: 'vn-faces' }, [
      el('div', { class: 'row vn-faces-head' }, [
        el('span', { class: 'muted small', text: t`表情 ${names.length - names.filter(name => !faces[name]).length}/${names.length}` }),
        el('span', { class: 'row' }, [
          act(t`导入表情包`, () => importPack(cardId, entry, member), { title: t`SillyTavern 的表情包：一个 zip，或者一组按情绪命名的图片（joy.png、anger.png……）` }),
          act(t`画一套表情`, () => {
            for (const name of missing) drawFace(cardId, entry, name)
            renderLibrary()
          }, { disabled: !canDraw || !missing.length, title: t`用现在的画图方式，在立绘上只改表情，缺的 ${missing.length} 个一个一个画` }),
        ]),
      ]),
      el('div', { class: 'vn-face-grid' }, cells),
      // Each expression's old pictures, named, in one row.
      oldRow(cardId, names.flatMap(name => keptItems(cardId, kept[`face:${member.id}:${name}`], FACE_LABEL[name])), t`旧表情`, view => spriteTaken(cardId, view)),
    ])
  }

  // ─── 导入表情包: a SillyTavern expression pack, read in the page ──────────
  // The pack being looked at before 导入: { cardId, memberId, packs, choice, load, replace, urls, busy }.
  let pack = null

  /** Files from the player: pictures, or a zip of them. */
  const pickFiles = () => new Promise(resolve => {
    const input = el('input', { type: 'file', multiple: true, accept: '.zip,application/zip,application/x-zip-compressed,image/png,image/jpeg,image/webp,image/gif' })
    input.addEventListener('change', () => resolve([...input.files]))
    input.click()
  })
  const inflateRaw = async data => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
  const PICTURE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

  /** Reads the pack the player picks and shows it against the expressions; nothing is kept until 导入. */
  async function importPack(cardId, entry, member) {
    const files = await pickFiles()
    if (!files.length) return
    // Each picture's path in the pack → its bytes, read when shown or taken.
    const load = new Map()
    for (const file of files) {
      if (/\.zip$/i.test(file.name)) {
        // The zip reader loads when a pack is first read.
        const { zipData, zipEntries } = await import('/shared/zip.js')
        const bytes = new Uint8Array(await file.arrayBuffer())
        let entries
        try {
          entries = zipEntries(bytes)
        } catch {
          throw new Error(t`读不出「${file.name}」：不是 zip 文件，或者是分卷、zip64 的`)
        }
        for (const item of entries) {
          const type = PICTURE_TYPES[item.name.split('.').pop().toLowerCase()]
          if (type) load.set(item.name, async () => new Blob([await zipData(bytes, item, inflateRaw)], { type }))
        }
      } else if (PACK_PICTURE.test(file.name)) load.set(file.name, async () => file)
    }
    const packs = packFaces([...load.keys()])
    if (!packs.length) return toast(t`没认出表情：图片要按情绪命名，比如 joy.png、anger.png（SillyTavern 的表情包），或者 微笑.png、生气.png`, 7000)
    // A pack of several people: the folder named after this one, else the fullest.
    const keys = new Set([entry.name, ...(entry.keys ?? [])].map(normalizePlace).filter(Boolean))
    const choice = Math.max(0, packs.findIndex(item => keys.has(normalizePlace(item.folder.split('/').pop()))))
    closePack()
    pack = { cardId, memberId: member.id, packs, choice, load, replace: true, urls: new Map(), busy: '' }
    renderLibrary()
  }

  function closePack() {
    for (const url of pack?.urls.values() ?? []) url.then(src => src && URL.revokeObjectURL(src))
    pack = null
  }

  /** A picture of the pack to show: its object URL (made once), or null when it cannot be read. */
  function packUrl(path) {
    if (!pack.urls.has(path)) pack.urls.set(path, pack.load.get(path)().then(blob => URL.createObjectURL(blob)).catch(() => null))
    return pack.urls.get(path)
  }

  /** The pack against someone's expressions: which picture each takes, 导入 to keep them. */
  function packView(cardId, entry, member) {
    const current = pack.packs[pack.choice]
    const cells = EXPRESSIONS.map(name => {
      const path = current.faces[name]
      const picture = el('div', { class: 'vn-face-pic' }, [el('span', { class: 'muted small', text: path ? '…' : '—' })])
      if (path) packUrl(path).then(src => src && picture.replaceChildren(el('img', { src, alt: '' })))
      const off = !path || (name === 'neutral' && !pack.replace)
      return el('div', { class: `vn-face${off ? ' off' : ''}` }, [
        picture,
        el('span', { class: 'small', text: name === 'neutral' ? t`立绘` : FACE_LABEL[name] }),
        el('span', { class: 'muted small vn-pack-file', text: path ? path.split('/').pop() : t`包里没有`, title: path ?? '' }),
      ])
    })
    const taken = Object.keys(current.faces).filter(name => name !== 'neutral' || pack.replace)
    const go = act(pack.busy || t`导入 ${taken.length} 张`, () => takePack(cardId, entry, member), { disabled: Boolean(pack.busy) || !taken.length })
    go.classList.add('primary')
    pack.go = go
    const folders = pack.packs.length > 1
      ? el('select', { 'aria-label': t`用包里哪个文件夹`, onchange: event => {
        pack.choice = Number(event.target.value)
        renderLibrary()
      } }, pack.packs.map((item, i) => el('option', { value: String(i), selected: i === pack.choice, text: t`${item.folder || t`最外层`}（${Object.keys(item.faces).length} 个表情）` })))
      : null
    const replace = el('input', { type: 'checkbox', checked: pack.replace })
    replace.addEventListener('change', () => {
      pack.replace = replace.checked
      renderLibrary()
    })
    const unused = current.unused.map(file => file.split('/').pop())
    return el('div', { class: 'vn-faces vn-pack' }, [
      el('div', { class: 'row vn-faces-head' }, [el('b', { class: 'small', text: t`从表情包导入` }), folders]),
      el('div', { class: 'vn-face-grid' }, cells),
      current.faces.neutral
        ? el('label', { class: 'vn-pack-replace small' }, [replace, el('span', { text: t`包里的 neutral 当立绘（换掉现在的；表情和立绘出自同一套，换表情时才不跳）` })])
        : el('p', { class: 'muted small', text: t`包里没有 neutral：平静时还用现在的立绘。` }),
      unused.length ? el('p', { class: 'muted small', text: t`没对上的 ${unused.length} 张：${unused.slice(0, 6).join(t`、`)}${unused.length > 6 ? '…' : ''}` }) : null,
      el('div', { class: 'row' }, [go, act(t`取消`, () => {
        closePack()
        renderLibrary()
      })]),
    ])
  }

  /** 导入: the pack's pictures become this one's 立绘 and expressions, one at a time. */
  async function takePack(cardId, entry, member) {
    const mine = pack
    const current = mine.packs[mine.choice]
    const jobs = Object.entries(current.faces).filter(([name]) => name !== 'neutral' || mine.replace)
    try {
      for (const [i, [name, path]] of jobs.entries()) {
        mine.busy = t`导入中 ${i + 1}/${jobs.length}`
        if (mine.go) Object.assign(mine.go, { textContent: mine.busy, disabled: true })
        const image = await asPng(await mine.load.get(path)())
        const url = name === 'neutral' ? `/api/cards/${cardId}/sprites/${member.id}` : `/api/cards/${cardId}/sprites/${member.id}/expressions/${name}`
        takeSprites(cardId, await api(url, { method: 'PUT', body: { image } }))
      }
    } finally {
      mine.busy = ''
    }
    if (pack === mine) closePack()
    cast.none.clear()
    renderLibrary()
    toast(t`${entry.name}：导入了 ${jobs.length} 张`)
  }

  // ─── 用辅助模型判断表情: one small request per finished reply ──────────
  // reply key → expression (or null) per step.
  const faceLabels = new Map()
  const labelling = new Set()

  /** The latest reply's lines labelled by the helper (when switched on), once; the stage redraws with them. */
  async function labelFaces() {
    const key = state.key
    if (!prefs.faceHelper || !state.on || state.streaming || !state.node || !key || faceLabels.has(key) || labelling.has(key)) return
    // Lines the model marked (【名字|表情】) already say.
    const lines = state.steps.map(step => (step.type === 'line' && step.kind === 'dialogue' && step.speaker && !step.expression && isActor(step.speaker) ? { speaker: step.speaker, text: step.plain } : null))
    if (!lines.some(Boolean)) return
    labelling.add(key)
    try {
      const { labels } = await api('/api/vn/expressions', { method: 'POST', body: { lines } })
      faceLabels.set(key, Array.isArray(labels) ? labels : [])
      if (faceLabels.size > 40) faceLabels.delete(faceLabels.keys().next().value)
      if (state.key === key) drawStage()
    } catch (error) {
      toldOnce('toldFaceHelper', t`辅助模型没能标表情（${error.message}），这一轮按叙述判断。`)
      faceLabels.set(key, [])
    } finally {
      labelling.delete(key)
    }
  }

  // ─── Backlog ───────────────────────────────────────────────────────
  /** One line as the text box shows it (its quotes and 【】 coloured), the speaker's name before it. */
  function logRow(step, extra = {}) {
    const speaker = step.speaker
    const row = el('div', { class: ['vn-log-line', `vn-log-${step.kind}`, extra.class].filter(Boolean).join(' '), html: renderStory(step.text) })
    markSpeech(row)
    const name = speaker ? el('b', { 'data-who': whoIs(speaker), style: `--who: ${hueOf(speaker)}`, text: t`${shownName(speaker)}：` }) : null
    if (name) (row.querySelector('p') ?? row).prepend(name)
    return row
  }

  /** Earlier turns (story only) and every line of this reply seen so far; the one on screen marked. */
  function openLog() {
    setAuto(false)
    // The input box would cover its foot.
    compose(false)
    const chat = getChat()
    const rows = []
    const path = chat?.path ?? []
    const latestId = state.node?.id ?? latestReply(chat)?.id
    const userName = shownName(chat?.names?.user || '你') // i18n-ignore: the default player name
    for (const node of path.slice(-LOG_REPLIES * 2)) {
      if (node.id === latestId && !state.streaming) break
      if (node.role === 'user') {
        rows.push(el('p', { class: 'vn-log-user' }, [el('b', { text: t`${userName}：` }), node.text]))
        continue
      }
      let place = null
      for (const step of storyLines(chat, node)) {
        if (step.where?.place && step.where.place !== place) rows.push(el('p', { class: 'vn-log-scene', text: (place = step.where.place) }))
        rows.push(logRow(step))
      }
    }
    const last = Math.max(state.seen, state.index)
    let place = null
    state.steps.slice(0, last + 1).forEach((step, i) => {
      if (step.type !== 'line') return
      if (step.where?.place && step.where.place !== place) rows.push(el('p', { class: 'vn-log-scene', text: (place = step.where.place) }))
      const row = logRow(step, { class: `vn-log-current${i === state.index ? ' here' : ''}` })
      row.addEventListener('click', () => {
        closeLog()
        state.index = i
        showStep(false)
      })
      rows.push(row)
    })
    logBox.replaceChildren(
      el('div', { class: 'vn-log-head' }, [el('b', { text: t`回看` }), control(t`关闭`, t`Esc`, () => closeLog())]),
      el('div', { class: 'vn-log-body' }, rows.length ? rows : [el('p', { class: 'vn-waiting', text: t`还没有内容` })]),
    )
    logBox.hidden = false
    root.classList.add('reading-log')
    const body = logBox.querySelector('.vn-log-body')
    const here = body.querySelector('.here')
    if (here) here.scrollIntoView({ block: 'center' })
    else body.scrollTop = body.scrollHeight
  }

  function closeLog() {
    logBox.hidden = true
    root.classList.remove('reading-log')
  }

  // ─── Input ─────────────────────────────────────────────────────────
  root.addEventListener('click', event => {
    if (root.classList.contains('bare')) {
      root.classList.remove('bare')
      return
    }
    if (event.target.closest('button, a, input, select, textarea, details, iframe, .vn-log, .vn-panel, .vn-pop, .vn-menu, .vn-controls, .vn-end, .vn-corner, .vn-cg')) return
    if (String(getSelection?.() ?? '').trim()) return
    // A click beside the settings menu closes it, without reading on.
    if (!pop.hidden) return closePop()
    advance()
  })
  root.addEventListener('wheel', event => {
    if (event.deltaY < 0 && logBox.hidden && cgView.hidden && !event.target.closest('.vn-panel, .vn-pop, .vn-log')) openLog()
  }, { passive: true })
  lineBox.addEventListener('click', event => {
    const option = event.target.closest('.choice')
    if (!option) return
    event.stopPropagation()
    fill(option.dataset.choice)
    compose(true)
  })

  document.addEventListener('keydown', event => {
    if (!state.on || root.hidden) return
    const target = event.target
    if (event.key === 'Escape') {
      if (!pop.hidden) return closePop()
      // A picture opened from the gallery goes back to it.
      if (!cgView.hidden) return cgView.dataset.back ? openGallery() : closeCg()
      if (!logBox.hidden) return closeLog()
      if (!menu.hidden && target?.id !== 'input') return hideMenu()
      if (stage.classList.contains('vn-full') && target?.id !== 'input') return setFull(false)
      if (root.classList.contains('bare')) return root.classList.remove('bare')
      if (stage.classList.contains('vn-compose') && target?.id === 'input') return compose(false)
      return
    }
    if (target?.closest?.('input, textarea, select, [contenteditable="true"]') || event.isComposing) return
    if (event.ctrlKey || event.metaKey || event.altKey) {
      // Ctrl+K: the backlog here, not the chat history behind.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (logBox.hidden) openLog()
        else closeLog()
      }
      return
    }
    if (document.querySelector('dialog[open], .pop-menu')) return
    if ((event.key === ' ' || event.key === 'Enter') && target?.closest?.('button, a, summary, [role="button"]')) return
    const key = event.key
    // Over the pictures: ←/→ go through them, G is the gallery; nothing reads on underneath.
    if (!cgView.hidden) {
      if ((key === 'ArrowLeft' || key === 'ArrowRight') && state.cgStep) {
        event.preventDefault()
        state.cgStep(key === 'ArrowLeft' ? -1 : 1)
      } else if (key === 'g' || key === 'G') openGallery()
      return
    }
    if (key === 'g' || key === 'G') return openGallery()
    if (key === 'F5' || key === 'F9') {
      event.preventDefault()
      return key === 'F5' ? saves.quickSave() : saves.quickLoad()
    }
    if (key === ' ' || key === 'Enter' || key === 'ArrowRight' || key === 'PageDown') {
      event.preventDefault()
      if (!logBox.hidden || !cgView.hidden) return
      if (root.classList.contains('bare')) root.classList.remove('bare')
      advance()
    } else if (key === 'ArrowLeft' || key === 'PageUp') {
      event.preventDefault()
      back()
    } else if (!menu.hidden && /^[1-9]$/.test(key)) {
      // The menu's numbers pick a choice.
      const choice = currentChoices()[Number(key) - 1]
      if (choice && !isGenerating()) pick(choice)
    } else if (key === 'a' || key === 'A') setAuto(!state.auto)
    else if (key === 'h' || key === 'H') root.classList.toggle('bare')
    else if (key === 'l' || key === 'L') (logBox.hidden ? openLog() : closeLog())
    else if (key === 'o' || key === 'O') (menu.hidden ? showMenu() : hideMenu())
    else if (key === 'f' || key === 'F') toggleFullscreen()
  }, { capture: true })

  /** Leaving the mode: nothing keeps running. */
  function leave() {
    cancelTyping()
    setAuto(false)
    compose(false)
    hideMenu()
    voice.hidden = true
    if (stage.classList.contains('vn-full')) setFull(false)
    closePanel()
    closePop()
    closeLog()
    closeCg()
    clearStage()
    if (state.reading) deps.stopReading?.()
    state.reading = false
    root.classList.remove('bare', 'memory')
    chapter.classList.remove('show')
    hud.clear()
    state.key = null
    state.place = undefined
    state.day = null
  }

  /**
   * What a finished turn does in this mode (read line by line here; 配图 as
   * switched here), or null when it is off. Called once per finished turn on
   * screen, so the turn's auto save is made here too.
   */
  function turnFlags(cardId) {
    if (!isOn(cardId)) return null
    saves.autoSave()
    return { read: false, image: Boolean(prefs.image) }
  }

  // ─── 视觉小说格式: the model marks who says each line and how they look ──
  // Asked for in each turn's message while this mode is on (server/prompt.mjs dialogueFormat),
  // so switching costs no cache. On by default with the built-in preset; an imported preset
  // has its own output format, which the two could fight over, so there it waits to be switched on.

  const builtinPreset = chat => !chat?.presetId || isBuiltinPreset(chat.presetId)
  const formatSaved = cardId => recall(FORMAT_KEY, {})[cardId]

  /** Whether the chat's next turn asks for the format. */
  function formatOn(chat) {
    const saved = formatSaved(chat?.cardId)
    return typeof saved === 'boolean' ? saved : builtinPreset(chat)
  }

  function setFormat(cardId, on) {
    remember(FORMAT_KEY, { ...recall(FORMAT_KEY, {}), [cardId]: on })
    toast(on ? t`下一轮起，模型会给每句对白标上说话人和表情` : t`下一轮起不再要求标注，说话人和表情按叙述判断`)
  }

  /** For a turn about to be sent: ask for the format? (Said once, the first time either way.) */
  function marks(chat) {
    if (!chat || !isOn(chat.cardId)) return false
    const on = formatOn(chat)
    if (typeof formatSaved(chat.cardId) !== 'boolean') {
      if (on) toldOnce('toldFormat', t`视觉小说里，模型会给每句对白标上说话人和表情（【名字|表情】，标记本身不显示），认人、换表情更准。不想要可以在「立绘」里关掉「对白标注」。`)
      else toldOnce('toldFormatPreset', t`用导入的预设时，不要求模型标说话人和表情，免得和预设自己的格式冲突。想要更准的认人和表情，可以在「立绘」里打开「对白标注」。`)
    }
    return on
  }

  /** 做成视觉小说 (创作角色卡): this card in the mode, the 立绘 window open, and 一键备齐 with the plan's places. */
  async function makeReady(cardId, places = []) {
    if (!isOn(cardId)) setOn(cardId, true)
    await offerPreset(getChat())
    openLibrary('sprites')
    return prepare(cardId, { places })
  }

  return { render, streamed, isOn, turnFlags, marks, makeReady }
}
