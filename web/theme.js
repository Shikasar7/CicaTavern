// 主题 (the button at the foot of the card list): light or dark, a colour
// style, the story's font and size, and a picture behind the page with its opacity.
// - Light or dark stays with this browser (localStorage 'theme'), as before.
// - So do the story's font and size (localStorage 'reading'): a phone wants
//   other sizes than a computer. They change the replies, the player's lines,
//   the input box and the visual novel's text, not the buttons and menus.
// - The style and the picture are settings (settings.appearance,
//   web/shared/appearance.js), mirrored to localStorage 'appearance' so the
//   next start draws them before the page appears (index.html).
// - A picture is shrunk here before it is sent: at most 2560 px on its long
//   side, as JPEG (server/appearance.mjs keeps one file).
// - 自定义 is twelve colours for light and twelve for dark (settings.appearance.custom),
//   written into a <style> of their own (paletteCss); 细调颜色 changes them one by
//   one, 对话修改 (talk-dialog.js) has them written from a few words, previewed first.
import { t } from '/i18n.js'
import { APPEARANCE_DEFAULTS, PALETTE_KEYS, READING_DEFAULTS, STORY_FONTS, STORY_SCALE, STYLES, cleanAppearance, cleanColor, cleanCustom, cleanFontName, cleanPalette, cleanReading, paletteCss, paletteIssues, storyFontOf } from '/shared/appearance.js'

const MODES = ['auto', 'light', 'dark']
const MODE_LABEL = { auto: t`跟随系统`, light: t`浅色`, dark: t`深色` }
const STYLE_LABEL = { lamp: t`灯下`, sakura: t`樱粉`, bamboo: t`竹青`, paper: t`旧纸`, night: t`星夜`, custom: t`自定义` }
// What each of the twelve colours paints (细调颜色, and what is hard to read).
const KEY_LABEL = {
  bg: t`页面底色`, pane: t`侧栏`, surface: t`纸面和卡片`, raised: t`浮起的面板`, line: t`分隔线`, 'line-soft': t`淡分隔线`,
  ink: t`正文文字`, muted: t`次要文字`, faint: t`提示文字`, accent: t`强调色`, 'accent-ink': t`强调色上的字`, lamp: t`对白高亮`,
}
// The custom style's CSS, kept for index.html to put on the page before it appears.
const PALETTE_KEY = 'appearance-palette'
const FONT_LABEL = { song: t`宋体`, hei: t`黑体`, kai: t`楷体`, fang: t`仿宋`, custom: t`自选` }
const READING_KEY = 'reading'
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

/** A <style> of the page's own by its id; empty CSS takes it away. */
function styleTag(id, css) {
  let tag = document.getElementById(id)
  if (!css) return tag?.remove()
  if (!tag) {
    tag = document.createElement('style')
    tag.id = id
    document.head.append(tag)
  }
  tag.textContent = css
}

/** The twelve colours the page shows in light or dark, read off the page as it is styled now. */
export function readPalette(mode) {
  const root = document.documentElement
  const before = root.dataset.theme
  root.dataset.theme = mode
  const style = getComputedStyle(root)
  const palette = Object.fromEntries(PALETTE_KEYS.map(key => [key, cleanColor(style.getPropertyValue(`--${key}`))]))
  if (before) root.dataset.theme = before
  else delete root.dataset.theme
  return cleanPalette(palette)
}

/** Whether the page shows dark now (chosen, or the system's when following it). */
const showsDark = () => currentMode() === 'dark' || (currentMode() === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)

let previewing = null // { style, key }: what the page had before a palette was previewed, and which one shows
/** Shows a palette (both modes) on the page without saving it; null puts back what it had. `key` names it. */
export function previewPalette(custom, key = '') {
  const root = document.documentElement
  if (!custom) {
    if (!previewing) return
    if (previewing.style) root.dataset.style = previewing.style
    else delete root.dataset.style
    styleTag('palette-preview', '')
    previewing = null
    syncThemeColor()
    return
  }
  previewing ??= { style: root.dataset.style ?? '' }
  previewing.key = key
  styleTag('palette-preview', paletteCss(custom).replaceAll('data-style="custom"', 'data-style="preview"'))
  root.dataset.style = 'preview'
  syncThemeColor()
}

/** Puts an appearance on the page and remembers it for the next start. */
export function applyAppearance(value) {
  const look = cleanAppearance(value)
  const root = document.documentElement
  previewPalette(null)
  const css = paletteCss(look.custom)
  styleTag('custom-palette', css)
  remember(PALETTE_KEY, css)
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

/** The story's font and size on this device, as index.html put them on the page at start. */
export function currentReading() {
  try {
    return cleanReading(JSON.parse(localStorage.getItem(READING_KEY)))
  } catch {
    return { ...READING_DEFAULTS }
  }
}

/** Puts the story's font and size on the page and remembers them on this device. */
export function applyReading(value) {
  const reading = cleanReading(value)
  const root = document.documentElement
  const family = storyFontOf(reading)
  if (family) root.style.setProperty('--story-font', family)
  else root.style.removeProperty('--story-font')
  if (reading.scale === READING_DEFAULTS.scale) root.style.removeProperty('--story-scale')
  else root.style.setProperty('--story-scale', String(reading.scale))
  remember(READING_KEY, JSON.stringify(reading))
  return reading
}

let probe = null
/** Whether this device has a font: a sample measures differently with it than with a generic family alone. */
function hasFont(name) {
  probe ??= document.createElement('canvas').getContext('2d')
  const sample = 'mmmmmmmmmmlli 0123456789 AaBbQqWw'
  return ['monospace', 'serif', 'sans-serif'].some(base => {
    probe.font = `40px ${base}`
    const plain = probe.measureText(sample).width
    probe.font = `40px "${name}", ${base}`
    return probe.measureText(sample).width !== plain
  })
}

/** The fonts a stack in style.css (--font-kai…) names before Song's, which it falls back to. */
function namesIn(property) {
  const style = getComputedStyle(document.documentElement)
  const names = value => value.split(',').map(name => name.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  const song = new Set(names(style.getPropertyValue('--serif')))
  return names(style.getPropertyValue(property)).filter(name => !song.has(name) && !/^(sans-)?serif$/.test(name))
}

/** Song is always there (or the page's own), and Hei ends in the device's sans-serif; Kai and FangSong may not be. */
const fontHere = font => font === 'song' || font === 'hei' || font === 'custom' || namesIn(`--font-${font}`).some(hasFont)

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
 * @param onReading - after the story's font or size changed (the input box fits its text again).
 * @param openTalk - talk-dialog.js: 对话修改 on the look.
 */
export function initTheme({ api, el, toast, guard, getSettings, setSettings, onReading, openTalk }) {
  const button = document.getElementById('toggle-theme')
  const look = () => cleanAppearance(getSettings()?.appearance)
  let dialog = null
  let tuning = false // 细调颜色 is open

  function renderButton() {
    const mode = currentMode()
    button.textContent = t`主题：${MODE_LABEL[mode]}`
    button.title = t`主题：${STYLE_LABEL[look().style]} · ${MODE_LABEL[mode]}（明暗、配色、字体字号、背景图）`
  }

  function setReading(patch) {
    applyReading({ ...currentReading(), ...patch })
    onReading?.()
  }

  /** 字体: each choice written in its own font, one this device lacks dimmed; 本机字体 takes a name. */
  function fontRow(reading) {
    const sampleOf = font => {
      const family = font === 'custom' ? storyFontOf({ font, custom: reading.custom }) : storyFontOf({ font })
      return el('span', { class: 'theme-font-sample', style: family ? `font-family:${family}` : '', text: font === 'custom' && !reading.custom ? '…' : t`永` })
    }
    const choices = el('div', { class: 'theme-styles' }, STORY_FONTS.map(font => {
      const here = fontHere(font)
      const b = el('button', { type: 'button', class: `theme-style theme-font${here ? '' : ' missing'}`, 'aria-pressed': String(font === reading.font), title: here ? '' : t`这台设备没有${FONT_LABEL[font]}，会用宋体显示` }, [
        sampleOf(font),
        el('span', { text: FONT_LABEL[font] }),
      ])
      b.addEventListener('click', () => {
        setReading({ font })
        render()
        if (font === 'custom') dialog.querySelector('.theme-font-name')?.focus()
      })
      return b
    }))
    const parts = [choices]
    if (reading.font === 'custom') {
      const name = el('input', { type: 'text', class: 'theme-font-name', value: reading.custom, maxlength: '60', placeholder: t`字体的名字，比如 霞鹜文楷`, spellcheck: 'false', autocomplete: 'off', 'aria-label': t`本机字体的名字` })
      const note = el('p', { class: 'hint' })
      const tell = () => {
        const typed = cleanFontName(name.value)
        note.textContent = !typed
          ? t`填这台设备上装的字体，名字要和系统里显示的一致。`
          : hasFont(typed) ? t`找到了「${typed}」，正文已经换上。` : t`这台设备上找不到「${typed}」，正文用宋体显示。`
      }
      // Each letter shows at once; the chip above shows the font too.
      name.addEventListener('input', () => {
        setReading({ custom: name.value })
        reading = currentReading()
        choices.lastElementChild.firstElementChild.replaceWith(sampleOf('custom'))
        tell()
      })
      tell()
      parts.push(name, note)
    } else if (!fontHere(reading.font)) {
      parts.push(el('p', { class: 'hint', text: t`这台设备没有${FONT_LABEL[reading.font]}，正文用宋体显示。手机上一般只有宋体和黑体。` }))
    }
    return el('div', { class: 'theme-row top' }, [el('span', { class: 'theme-label', text: t`字体` }), el('div', { class: 'theme-reading' }, parts)])
  }

  /** 字号: a slider from small to large, with a line of story in the chosen font and size. */
  function sizeRow(reading) {
    const percent = value => `${Math.round(value * 100)}%`
    const size = el('input', { type: 'range', min: String(STORY_SCALE.min * 100), max: String(STORY_SCALE.max * 100), step: String(STORY_SCALE.step * 100), value: String(Math.round(reading.scale * 100)), 'aria-label': t`字号` })
    const shown = el('span', { class: 'theme-opacity-value', text: percent(reading.scale) })
    const usual = el('button', { type: 'button', class: 'btn small ghost', text: t`默认大小`, disabled: reading.scale === READING_DEFAULTS.scale })
    size.addEventListener('input', () => {
      setReading({ scale: size.value / 100 })
      shown.textContent = percent(size.value / 100)
      usual.disabled = currentReading().scale === READING_DEFAULTS.scale
    })
    usual.addEventListener('click', () => {
      setReading({ scale: READING_DEFAULTS.scale })
      render()
    })
    return el('div', { class: 'theme-row top' }, [
      el('span', { class: 'theme-label', text: t`字号` }),
      el('div', { class: 'theme-reading' }, [
        el('label', { class: 'theme-opacity' }, [el('span', { class: 'theme-size-a', 'aria-hidden': 'true', text: 'A' }), size, el('span', { class: 'theme-size-a big', 'aria-hidden': 'true', text: 'A' }), shown]),
        el('p', { class: 'theme-reading-sample', text: t`雨下得正紧，她把伞往你这边偏了偏：「今晚怕是回不去了。」` }),
        el('div', { class: 'row between' }, [el('p', { class: 'hint', text: t`字体和字号只改故事正文：回复、你的输入和视觉小说的文本框。只记在这台设备上，电脑和手机可以各用各的。` }), usual]),
      ]),
    ])
  }

  function setMode(mode) {
    if (mode === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = mode
    remember('theme', mode)
    syncThemeColor()
    renderButton()
  }

  // ─── 自定义配色 ─────────────────────────────────────────────────────────
  /** 细调颜色: opening it makes the colours on screen the custom style, to change from there. */
  async function toggleTuning() {
    tuning = !tuning
    if (tuning && look().style !== 'custom') {
      const custom = cleanCustom({ light: readPalette('light'), dark: readPalette('dark') })
      if (custom) await save({ style: 'custom', custom })
    }
    render()
  }

  /** Where a palette is hard to read, said in words. */
  const issueText = issue => t`${KEY_LABEL[issue.key]}在${KEY_LABEL[issue.on]}上对比度 ${issue.ratio}，要 ${issue.need} 以上才好认`

  /** The twelve colours of the mode the page shows, each with a picker; a change shows at once and saves when let go. */
  function tuner(current) {
    const mode = showsDark() ? 'dark' : 'light'
    const live = { ...current.custom[mode] }
    const issues = el('ul', { class: 'theme-issues' })
    const tell = () => issues.replaceChildren(...paletteIssues(live).map(issue => el('li', { text: issueText(issue) })))
    const pickers = PALETTE_KEYS.map(key => {
      const input = el('input', { type: 'color', value: live[key], 'aria-label': KEY_LABEL[key] })
      input.addEventListener('input', () => {
        live[key] = input.value
        styleTag('custom-palette', paletteCss({ ...current.custom, [mode]: live }))
        tell()
      })
      input.addEventListener('change', guard(() => save({ custom: { ...look().custom, [mode]: { ...live } } })))
      return el('label', { class: 'theme-tune' }, [input, el('span', { text: KEY_LABEL[key] })])
    })
    tell()
    return el('div', { class: 'theme-tuner' }, [
      el('p', { class: 'hint', text: mode === 'dark' ? t`调的是深色的一套；把上面的明暗换成浅色，就调浅色的一套。` : t`调的是浅色的一套；把上面的明暗换成深色，就调深色的一套。` }),
      el('div', { class: 'theme-tunes' }, pickers),
      issues,
    ])
  }

  // ─── 对话修改 (talk-dialog.js) ─────────────────────────────────────────
  function swatchRow(label, palette) {
    return el('div', { class: 'talk-swatches' }, [
      el('span', { text: label }),
      ...PALETTE_KEYS.map(key => el('i', { style: `background:${palette[key]}`, title: `${KEY_LABEL[key]} ${palette[key]}` })),
    ])
  }

  /** A few lines in the palette: page, a card on it, story text, a line of dialogue, a button. */
  function sample(p) {
    return el('div', { class: 'talk-mock', style: `background:${p.bg};border-color:${p.line}` }, [
      el('div', { class: 'talk-mock-card', style: `background:${p.surface};border-color:${p['line-soft']}` }, [
        el('p', { style: `color:${p.ink}`, text: t`雨下得正紧，她把伞往你这边偏了偏：` }),
        el('p', { style: `color:${p.lamp}`, text: t`「今晚怕是回不去了。」` }),
        el('p', { style: `color:${p.muted}`, text: t`次要文字 · 三分钟前` }),
        el('span', { class: 'talk-mock-btn', style: `background:${p.accent};color:${p['accent-ink']}`, text: t`发送` }),
      ]),
    ])
  }

  function paletteBody(change) {
    const key = `${change.mode}:${change.after.bg}:${change.after.accent}`
    const preview = el('button', { type: 'button', class: 'btn small ghost talk-preview', 'data-key': key, text: previewing?.key === key ? t`停止预览` : t`在界面上预览` })
    preview.addEventListener('click', () => {
      // One preview at a time: this one goes off, or takes the place of another.
      previewPalette(previewing?.key === key ? null : { ...change.base, [change.mode]: change.after }, key)
      for (const button of document.querySelectorAll('.talk-preview')) button.textContent = previewing?.key === button.dataset.key ? t`停止预览` : t`在界面上预览`
    })
    return [
      change.before ? swatchRow(t`原来`, change.before) : null,
      swatchRow(t`改成`, change.after),
      sample(change.after),
      change.issues.length ? el('ul', { class: 'theme-issues' }, change.issues.map(issue => el('li', { text: issueText(issue) }))) : null,
      el('div', { class: 'row' }, [preview, el('span', { class: 'hint', text: change.mode === 'dark' ? t`预览深色要把明暗切到深色` : t`预览浅色要把明暗切到浅色` })]),
    ]
  }

  function talkAbout() {
    openTalk?.({
      url: '/api/talk/theme/appearance',
      title: t`对话修改主题`,
      name: '',
      intro: () => t`说说想要什么样的界面：一种心情、一个地方、一部作品的感觉，或者只改一处（比如「强调色换成红的」）。向导配好浅色和深色两套，标出不好认的地方，可以先在界面上预览，勾上的才会换上。想要背景图也可以说，会用现在的画图方式画一张。`,
      ideas: () => [t`水墨风，淡一点`, t`赛博朋克的夜晚`, t`秋天的旧书店，再画一张背景图`],
      placeholder: () => t`说说想要什么样的界面，比如：雨夜的茶馆`,
      busy: job => (job.chars ? t`正在配色，已经写了 ${job.chars.toLocaleString()} 字…` : t`正在想配色…`),
      changeTitle: change => (change.kind === 'backdrop' ? t`背景图` : change.mode === 'dark' ? t`深色的一套` : t`浅色的一套`),
      changeWhere: change => {
        if (change.kind === 'backdrop') return [t`要画一会儿`, 'key', t`采用时用现在的画图方式画`]
        return change.issues.length ? [t`${change.issues.length} 处不好认`, 'off', ''] : [t`都好认`, 'on', '']
      },
      changeNotes: () => [],
      changeBody: change => (change.kind === 'backdrop'
        ? [el('p', { class: 'ce-change-note', text: t`采用时用现在的画图方式画一张横图，铺在界面后面，要等一会儿。` }), el('pre', { class: 'talk-prompt', text: change.prompt })]
        : paletteBody(change)),
      context: () => ({ palette: { light: readPalette('light'), dark: readPalette('dark') } }),
      targetLabel: () => '',
      onApplied: result => themed(result, t`已换上新的样子`),
      onUndone: result => themed(result, t`已改回原来的样子`),
      onClose: () => previewPalette(null),
    })
  }

  /** What the talk took in or undid: the page wears it, the window shows it. */
  function themed(result, said) {
    setSettings(result.settings)
    applyAppearance(result.settings.appearance)
    renderButton()
    if (dialog?.parentElement.open) render()
    toast(said)
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

    const styleButton = (style, swatch) => {
      const half = ([page, accent]) => el('span', { style: `background:${page}` }, [el('i', { style: `background:${accent}` })])
      const b = el('button', { type: 'button', class: 'theme-style', 'aria-pressed': String(style === current.style) }, [
        el('span', { class: 'theme-swatch' }, swatch.map(half)),
        el('span', { text: STYLE_LABEL[style] }),
      ])
      b.addEventListener('click', guard(async () => {
        await save({ style })
        render()
      }))
      return b
    }
    const custom = current.custom
    const styles = el('div', { class: 'theme-styles' }, [
      ...STYLES.map(style => styleButton(style, SWATCH[style])),
      custom ? styleButton('custom', [[custom.light.bg, custom.light.accent], [custom.dark.bg, custom.dark.accent]]) : null,
    ])
    const colorTools = el('div', { class: 'row theme-color-tools' }, [
      el('button', { type: 'button', class: 'btn small', text: t`对话修改`, title: t`说说想要什么样的界面，向导配好浅色和深色两套，可以先预览`, onclick: () => talkAbout() }),
      el('button', { type: 'button', class: 'btn small ghost', 'aria-expanded': String(tuning), text: tuning ? t`收起细调` : t`细调颜色`, onclick: guard(toggleTuning) }),
    ])

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
      el('div', { class: 'theme-row top' }, [el('span', { class: 'theme-label', text: t`配色` }), el('div', { class: 'theme-colors' }, [styles, colorTools, tuning && current.custom ? tuner(current) : null])]),
      fontRow(currentReading()),
      sizeRow(currentReading()),
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
  applyReading(currentReading())
  renderButton()
  return { renderButton, apply: () => { applyAppearance(getSettings()?.appearance); renderButton() } }
}
