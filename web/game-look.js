// 界面主题: the look of the visual novel, the fights and the rolls, on this device. The choice sits on <html> as data-look and
// data-look-palette, with data-look-tone for the app's light or dark; web/look.css does the rest. The moves that want more than a
// style sheet (a fight opening, the banner across the screen) are here.
import { lang, t, zh } from '/i18n.js'
import { PALETTES, cleanLook, faceOf, headCrop } from '/shared/look.js'

const KEY = 'cicatavern.look'
const root = document.documentElement

/** What holds the player back, as named: the two the rules give have words of their own. */
export const ailName = name => ({ 重伤: t`重伤`, 透支: t`透支`, 疯狂: t`疯狂`, 动摇: t`动摇`, 濒临崩溃: t`濒临崩溃` })[name] ?? name

export const lookNames = () => ({ plain: t`简约`, ink: t`古风`, console: t`怀旧游戏机`, bold: t`酷炫` })
export const lookHints = () => ({
  plain: t`安静克制，跟随应用的浅色和深色`,
  ink: t`水墨和宣纸，竹简、罗盘和朱印`,
  console: t`老游戏机的窗口，动作一格一格跳`,
  bold: t`纯色切割和技能横幅，动作夸张`,
})
export const paletteNames = () => ({ ink: t`水墨`, qing: t`青绿山水`, blue: t`午夜蓝`, teal: t`青绿`, plum: t`葡萄紫`, gold: t`金红`, ice: t`冰蓝`, night: t`紫金` })

function recall() {
  try {
    return JSON.parse(localStorage.getItem(KEY))
  } catch {
    return null
  }
}

let current = cleanLook(recall())

export const currentLook = () => current
export const palettesOf = look => PALETTES[look]
export const quiet = () => matchMedia('(prefers-reduced-motion: reduce)').matches

const isDark = () => root.dataset.theme === 'dark' || (root.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)

function applyTone() {
  root.dataset.lookTone = isDark() ? 'dark' : 'light'
}

/** The choice onto the page. */
function applyLook() {
  if (current.look === 'ink') import('/look-ink.js').then(ink => ink.paintTextures(root))
  // Asked for now, so that the first banner does not wait for its letters.
  document.fonts?.load(current.look === 'bold' ? '16px "Look Display"' : current.look === 'ink' ? '16px "Look Brush"' : '16px serif').catch(() => {})
  root.dataset.look = current.look
  root.dataset.lookPalette = current.palette
  root.style.setProperty('--look-strength', String(current.strength / 100))
  applyTone()
}

export function setLook(patch) {
  // Another look starts from its own first palette.
  const palette = patch.look && patch.look !== current.look ? undefined : current.palette
  current = cleanLook({ ...current, palette, ...patch })
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // Private mode: for this visit only.
  }
  applyLook()
}

const NUMERALS = zh`一二三四五六七八九`

/** 十二 for 12: a number as the page writes it where it reads as words. */
export function countWord(n) {
  if (lang === 'en' || n > 99) return String(n)
  const [tens, ones] = [Math.floor(n / 10), n % 10]
  return `${tens > 1 ? NUMERALS[tens - 1] : ''}${tens ? zh`十` : ''}${ones ? NUMERALS[ones - 1] : ''}`
}

/**
 * A fight opening. The page's own way of leaving the screen, then the fight there; 简约 has its veil in the style sheet.
 * → a promise, when it can be played.
 */
export async function enterFight(dialog) {
  if (current.look === 'plain' || quiet()) return
  dialog.classList.add('entering')
  if (current.look === 'ink') {
    const { bleed } = await import('/look-ink.js')
    const cover = Object.assign(document.createElement('canvas'), { className: 'look-cover' })
    const tall = innerHeight > innerWidth
    cover.width = tall ? 180 : 320
    cover.height = tall ? 390 : 180
    dialog.append(cover)
    await bleed(cover, 0, 1, 900)
    dialog.classList.remove('entering')
    await bleed(cover, 1, 0, 1000)
    cover.remove()
  }
  if (current.look === 'console') {
    const cover = Object.assign(document.createElement('canvas'), { className: 'look-cover', width: innerWidth, height: innerHeight })
    dialog.append(cover)
    await turnTiles(cover, 0, 1, 620)
    dialog.classList.remove('entering')
    await turnTiles(cover, 1, 0, 620)
    cover.remove()
  }
  if (current.look === 'bold') {
    await sweep(dialog, () => dialog.classList.remove('entering'), t`遭遇战`)
    return
  }
  dialog.classList.remove('entering')
}

const nap = ms => new Promise(done => setTimeout(done, ms))
const BAND_HEAD = 1.12
const BAND_FACE_AT = 0.72

/** Two panels cross the screen; what `swap` changes is behind them, with a word over them if there is one. */
export async function sweep(host, swap, word = '') {
  const panels = document.createElement('div')
  panels.className = 'look-sweep in'
  panels.innerHTML = '<i class="one"></i><i class="two"></i>'
  host.append(panels)
  await nap(560)
  swap()
  if (word) {
    const title = document.createElement('div')
    title.className = 'look-sweep-word'
    title.append(...[...word].map((letter, i) => {
      const box = document.createElement('span')
      box.className = 'look-letter'
      box.style.cssText = `--i: ${i}; --r: ${[-4, 3, -2, 5, -3][i % 5]}deg`
      box.textContent = letter
      return box
    }))
    host.append(title)
    await nap(780)
    title.remove()
  }
  panels.className = 'look-sweep out'
  await nap(620)
  panels.remove()
}

/**
 * The banner across the screen: a figure's eyes, the words. Without a figure, the words alone.
 * @param options - { text, small, picture, ms }. → a promise, when it has gone.
 */
export async function banner(el, host, { text, small = '', picture = '', ms = 1250 }) {
  const face = el('div', { class: 'look-band-face' })
  const band = el('div', { class: 'look-band' }, [el('i', { class: 'look-lines' }), picture ? face : null, el('div', { class: 'look-band-text' }, [el('b', { text }), small ? el('small', { text: small }) : null])])
  const box = el('div', { class: 'look-band-box', style: `--ms: ${ms}ms` }, [el('i', { class: 'look-dim' }), band])
  host.append(box)
  const place = picture ? await headIn(picture) : null
  if (place) {
    // The whole face in the band, whatever the picture's shape: the head a little taller than the band, on the right of the screen.
    const tall = (band.clientHeight * BAND_HEAD) / place.face.side
    const wide = tall / place.ratio
    const across = host.clientWidth * BAND_FACE_AT - band.offsetLeft - face.offsetLeft
    face.style.backgroundImage = `url("${picture}")`
    face.style.backgroundSize = `${wide}px ${tall}px`
    face.style.backgroundPosition = `${across - place.face.x * wide}px ${band.clientHeight * 0.5 - place.face.y * tall}px`
  }
  await nap(ms)
  box.remove()
}

/** The fields under the 酷炫 look, for a page to put behind what it shows. */
export function lookFields(el) {
  const washed = () => el('i', { class: 'look-wash-picture' })
  return el('div', { class: 'look-fields', 'aria-hidden': 'true' }, [
    el('div', { class: 'look-wash' }, [washed(), el('div', { class: 'look-red' }, [washed(), el('i', { class: 'look-rays' })])]),
    el('i', { class: 'look-stripe' }),
    el('i', { class: 'look-dots' }),
  ])
}

/** One slab under a list, going to the row in hand. Only 酷炫 shows it; what it marks works by the keys and the mouse alike. */
export function slideSlab(el, list, rows) {
  const slab = el('i', { class: 'look-slab', 'aria-hidden': 'true' })
  list.prepend(slab)
  const move = row => {
    if (!row) return
    const box = list.getBoundingClientRect()
    const at = row.getBoundingClientRect()
    const scale = box.height && list.offsetHeight ? list.offsetHeight / box.height : 1
    slab.style.transform = `translateY(${(at.top - box.top) * scale - list.clientTop + list.scrollTop}px)`
    slab.style.height = `${at.height * scale}px`
    for (const other of list.querySelectorAll(rows)) other.classList.toggle('look-on', other === row)
  }
  const pointed = event => move(event.target.closest?.(rows))
  list.addEventListener('pointerover', pointed)
  list.addEventListener('focusin', pointed)
  requestAnimationFrame(() => move(list.querySelector(`${rows}:not(:disabled)`)))
}

let hero = ''

/**
 * Who stands for the player where a look wants a figure: a picture, or a function that finds it when asked (the
 * visual novel's: one of the player's side, never this round's foe). → the picture's URL, or ''.
 */
export const heroNow = () => (typeof hero === 'function' ? hero() || '' : hero)
export const setHero = url => {
  hero = url || ''
}

/** Squares turn over corner to corner until the canvas is covered, or the other way. → a promise, when they have. */
function turnTiles(canvas, from, to, ms) {
  const context = canvas.getContext('2d')
  const { width, height } = canvas
  const size = 44
  const style = getComputedStyle(root)
  const [one, two] = [style.getPropertyValue('--win-deep').trim(), style.getPropertyValue('--win').trim()]
  const [cols, rows] = [Math.ceil(width / size), Math.ceil(height / size)]
  const paint = share => {
    context.clearRect(0, 0, width, height)
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const turned = Math.round(Math.min(1, Math.max(0, (share * (cols + rows + 6) - (x + y)) / 6)) * 4) / 4
      if (!turned) continue
      context.fillStyle = (x + y) % 2 ? one : two
      context.fillRect(x * size + (size * (1 - turned)) / 2, y * size, size * turned, size)
    }
  }
  const began = performance.now()
  return new Promise(done => {
    const frame = now => {
      const share = Math.min(1, (now - began) / ms)
      paint(from + (to - from) * share)
      if (share < 1) requestAnimationFrame(frame)
      else done()
    }
    paint(from)
    requestAnimationFrame(frame)
  })
}

const heads = new Map()
const FACE_SAMPLE = 256

/** A figure in a look's style sheet (--at-x, --at-y say where its head goes): where the head is in this picture. */
export async function fitFigure(node, url) {
  const place = await headIn(url)
  if (!place) return
  node.style.setProperty('--face-x', String(place.face.x))
  node.style.setProperty('--face-y', String(place.face.y))
  node.style.setProperty('--face-side', String(place.face.side))
}

/** Where the head is in a picture, for a frame to show it: { size, x, y } in percent, or null. Worked out once per picture. */
export function headIn(url) {
  if (!heads.has(url)) {
    heads.set(url, new Promise(done => {
      const image = new Image()
      image.onload = () => {
        const width = FACE_SAMPLE
        const height = Math.max(1, Math.round((image.naturalHeight / image.naturalWidth) * width))
        const canvas = Object.assign(document.createElement('canvas'), { width, height })
        const context = canvas.getContext('2d', { willReadFrequently: true })
        context.drawImage(image, 0, 0, width, height)
        const face = faceOf(context.getImageData(0, 0, width, height))
        done(face ? { ...headCrop(face, width, height), face, ratio: image.naturalHeight / image.naturalWidth } : null)
      }
      image.onerror = () => done(null)
      image.src = url
    }))
  }
  return heads.get(url)
}

/** One letter to a box, for the looks that set a title in cut-out letters. */
export function letters(el, text) {
  return [...text].map((letter, i) => el('span', { class: 'look-letter', style: `--i: ${i}; --r: ${[-4, 3, -2, 5, -3][i % 5]}deg`, text: letter }))
}

applyLook()
new MutationObserver(applyTone).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTone)
