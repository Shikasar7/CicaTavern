// 主题 (the button at the foot of the card list): light or dark, a colour
// style, and a picture behind the page with its opacity.
// - Light or dark stays with this browser (localStorage 'theme'), as before.
// - The style and the picture are settings (settings.appearance,
//   web/shared/appearance.js), mirrored to localStorage 'appearance' so the
//   next start draws them before the page appears (index.html).
// - A picture is shrunk here before it is sent: at most 2560 px on its long
//   side, as JPEG (server/appearance.mjs keeps one file).
import { t } from '/i18n.js'
import { APPEARANCE_DEFAULTS, STYLES, cleanAppearance } from '/shared/appearance.js'

const MODES = ['auto', 'light', 'dark']
const MODE_LABEL = { auto: t`跟随系统`, light: t`浅色`, dark: t`深色` }
const STYLE_LABEL = { lamp: t`灯下`, sakura: t`樱粉`, bamboo: t`竹青`, paper: t`旧纸`, night: t`星夜` }
// Each style's page and accent colours, light then dark (style.css has the full sets).
const SWATCH = {
  lamp: [['#eceeea', '#2b5869'], ['#0f1417', '#8dbfcb']],
  sakura: [['#f6efef', '#b04a68'], ['#171214', '#e89ab0']],
  bamboo: [['#edf1e9', '#3f7a4a'], ['#101511', '#8fcf9b']],
  paper: [['#f1eadc', '#8a4b23'], ['#16120d', '#e0a874']],
  night: [['#eeeef5', '#5148a8'], ['#111120', '#a9a2f0']],
}
const CACHE_KEY = 'appearance'
const MAX_SIDE = 2560

function remember(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode: the look is just not remembered for the next start.
  }
}

export function currentMode() {
  return document.documentElement.dataset.theme || 'auto'
}

/** The browser bar takes the page colour (phones). */
function syncThemeColor() {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
}

/** Puts an appearance on the page and remembers it for the next start. */
export function applyAppearance(value) {
  const look = cleanAppearance(value)
  const root = document.documentElement
  if (look.style === APPEARANCE_DEFAULTS.style) delete root.dataset.style
  else root.dataset.style = look.style
  if (look.backdrop) {
    root.dataset.backdrop = ''
    root.style.setProperty('--backdrop-image', `url("/api/appearance/${look.backdrop}")`)
    root.style.setProperty('--backdrop-opacity', String(look.backdropOpacity))
  } else {
    delete root.dataset.backdrop
    root.style.removeProperty('--backdrop-image')
    root.style.removeProperty('--backdrop-opacity')
  }
  remember(CACHE_KEY, JSON.stringify(look))
  syncThemeColor()
}

/** A picture file → a JPEG data URL no larger than MAX_SIDE on its long side. */
export async function shrink(file) {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(t`读不出这张图片，换一张 PNG、JPG 或 WebP 试试`)
  })
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) })
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.88)
}

/**
 * @param getSettings / setSettings - the page's copy of the settings.
 */
export function initTheme({ api, el, toast, guard, getSettings, setSettings }) {
  const button = document.getElementById('toggle-theme')
  const look = () => cleanAppearance(getSettings()?.appearance)
  let dialog = null

  function renderButton() {
    const mode = currentMode()
    button.textContent = t`主题：${MODE_LABEL[mode]}`
    button.title = t`主题：${STYLE_LABEL[look().style]} · ${MODE_LABEL[mode]}（明暗、配色、背景图）`
  }

  function setMode(mode) {
    if (mode === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = mode
    remember('theme', mode)
    syncThemeColor()
    renderButton()
  }

  /** Saves part of the appearance; the page shows it before the answer comes. */
  async function save(patch) {
    applyAppearance({ ...look(), ...patch })
    const saved = await api('/api/settings', { method: 'PUT', body: { appearance: { ...look(), ...patch } } })
    setSettings(saved)
    applyAppearance(saved.appearance)
    renderButton()
  }

  function render() {
    const current = look()
    const mode = currentMode()
    const seg = el('div', { class: 'seg' }, MODES.map(value => {
      const b = el('button', { type: 'button', 'aria-pressed': String(value === mode), text: MODE_LABEL[value] })
      b.addEventListener('click', () => {
        setMode(value)
        render()
      })
      return b
    }))

    const styles = el('div', { class: 'theme-styles' }, STYLES.map(style => {
      const half = ([page, accent]) => el('span', { style: `background:${page}` }, [el('i', { style: `background:${accent}` })])
      const b = el('button', { type: 'button', class: 'theme-style', 'aria-pressed': String(style === current.style) }, [
        el('span', { class: 'theme-swatch' }, SWATCH[style].map(half)),
        el('span', { text: STYLE_LABEL[style] }),
      ])
      b.addEventListener('click', guard(async () => {
        await save({ style })
        render()
      }))
      return b
    }))

    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true })
    const upload = el('button', { type: 'button', class: 'btn small', text: current.backdrop ? t`换一张` : t`上传图片` })
    upload.addEventListener('click', () => file.click())
    file.addEventListener('change', guard(async () => {
      const [picked] = file.files
      file.value = ''
      if (!picked) return
      upload.disabled = true
      upload.textContent = t`上传中…`
      try {
        const saved = await api('/api/appearance/backdrop', { method: 'PUT', body: { image: await shrink(picked) } })
        setSettings(saved)
        applyAppearance(saved.appearance)
        toast(t`背景图已换上`)
      } finally {
        render()
      }
    }))
    const remove = current.backdrop ? el('button', { type: 'button', class: 'btn small ghost', text: t`移除` }) : null
    remove?.addEventListener('click', guard(async () => {
      const saved = await api('/api/appearance/backdrop', { method: 'DELETE' })
      setSettings(saved)
      applyAppearance(saved.appearance)
      render()
    }))

    const percent = value => `${Math.round(value * 100)}%`
    const opacity = el('input', { type: 'range', min: '5', max: '100', step: '5', value: String(Math.round(current.backdropOpacity * 100)), disabled: !current.backdrop })
    const opacityValue = el('span', { class: 'theme-opacity-value', text: percent(current.backdropOpacity) })
    // Dragging shows it at once; letting go saves it.
    opacity.addEventListener('input', () => {
      document.documentElement.style.setProperty('--backdrop-opacity', String(opacity.value / 100))
      opacityValue.textContent = percent(opacity.value / 100)
    })
    opacity.addEventListener('change', guard(() => save({ backdropOpacity: opacity.value / 100 })))

    dialog.replaceChildren(
      el('h2', { text: t`主题` }),
      el('div', { class: 'theme-row' }, [el('span', { class: 'theme-label', text: t`明暗` }), seg]),
      el('div', { class: 'theme-row top' }, [el('span', { class: 'theme-label', text: t`配色` }), styles]),
      el('div', { class: 'theme-row top' }, [
        el('span', { class: 'theme-label', text: t`背景图` }),
        el('div', { class: 'theme-backdrop' }, [
          current.backdrop ? el('img', { class: 'theme-preview', src: `/api/appearance/${current.backdrop}`, alt: '' }) : null,
          el('div', { class: 'row' }, [upload, remove, file]),
          el('label', { class: 'theme-opacity' }, [t`透明度`, opacity, opacityValue]),
          el('p', { class: 'hint', text: current.backdrop ? t`透明度越低，图越淡，字越好认。` : t`选一张图放在界面后面，存在酒馆的数据文件夹里。` }),
        ]),
      ]),
      el('div', { class: 'row end' }, [el('button', { type: 'submit', class: 'btn', value: 'close', text: t`关闭` })]),
    )
  }

  button.addEventListener('click', () => {
    if (!dialog) {
      dialog = el('form', { method: 'dialog' })
      const shell = el('dialog', { class: 'dialog theme-dialog' }, [dialog])
      document.body.append(shell)
    }
    render()
    dialog.parentElement.showModal()
  })
  // Following the system: the bar colour follows it too.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor)
  renderButton()
  return { renderButton, apply: () => { applyAppearance(getSettings()?.appearance); renderButton() } }
}
