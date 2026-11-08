// 外观: the page's colour style and an optional picture behind it, shared by
// the server (settings.appearance, checked here) and the page (web/theme.js).
// Light or dark (跟随系统 / 浅色 / 深色) stays with each browser, as before
// (localStorage 'theme'); each style has both.

export const STYLES = ['lamp', 'sakura', 'bamboo', 'paper', 'night']

export const APPEARANCE_DEFAULTS = Object.freeze({ style: 'lamp', backdrop: '', backdropOpacity: 0.5, custom: null })

// 自定义配色 (主题 → 配色 → 自定义, and 对话修改 server/forge/theme-edit.mjs): the
// twelve colours a style sets (style.css), for light and for dark, by their CSS
// custom property's name. The style 'custom' is these, written into a <style>
// the page adds (paletteCss).
export const PALETTE_KEYS = ['bg', 'pane', 'surface', 'raised', 'line', 'line-soft', 'ink', 'muted', 'faint', 'accent', 'accent-ink', 'lamp']
const HEX = /^#[0-9a-f]{6}$/

/** A colour as `#rrggbb` (also from `#rgb` or upper case), or ''. */
export function cleanColor(value) {
  const text = String(value ?? '').trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text)
  const full = short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : text
  return HEX.test(full) ? full : ''
}

/** Twelve colours, each from `value` or else from `fallback`; null when one is missing from both. */
export function cleanPalette(value, fallback = null) {
  const out = {}
  for (const key of PALETTE_KEYS) {
    out[key] = cleanColor(value?.[key]) || cleanColor(fallback?.[key])
    if (!out[key]) return null
  }
  return out
}

/** { light, dark } with both complete, or null. */
export function cleanCustom(value) {
  const light = cleanPalette(value?.light)
  const dark = cleanPalette(value?.dark)
  return light && dark ? { light, dark } : null
}

/** The custom style as CSS, laid out as style.css lays out the others: light, then dark both ways it can be asked for. */
export function paletteCss(custom) {
  const clean = cleanCustom(custom)
  if (!clean) return ''
  const vars = palette => PALETTE_KEYS.map(key => `--${key}: ${palette[key]};`).join(' ')
  return [
    `:root[data-style="custom"] { ${vars(clean.light)} }`,
    `@media (prefers-color-scheme: dark) { :root[data-style="custom"]:not([data-theme="light"]) { ${vars(clean.dark)} } }`,
    `:root[data-style="custom"][data-theme="dark"] { ${vars(clean.dark)} }`,
  ].join('\n')
}

/** WCAG contrast ratio of two `#rrggbb` colours (1 to 21). */
export function contrast(a, b) {
  const lum = hex => {
    const [r, g, b2] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

// The pairs text is read on, and how far apart they must be.
const READABLE = [['ink', 'surface', 4.5], ['ink', 'bg', 4.5], ['muted', 'surface', 3], ['accent', 'surface', 3], ['accent-ink', 'accent', 4.5], ['lamp', 'surface', 3]]

/** Where a palette's text is hard to read: [{ key, on, ratio, need }]. */
export function paletteIssues(palette) {
  const clean = cleanPalette(palette)
  if (!clean) return []
  return READABLE.map(([key, on, need]) => ({ key, on, ratio: contrast(clean[key], clean[on]), need })).filter(issue => issue.ratio < issue.need)
}

/** The picture's file in the data folder's ui/: its name changes with each upload, so the page never sees a stale one. */
export const BACKDROP_FILE = /^backdrop-[a-z0-9]{4,16}\.(jpg|png|webp)$/

// 字体与字号 (主题 → 字体, 字号): the story's font and size, kept by each browser
// (localStorage 'reading') because a phone and a computer want different sizes;
// index.html applies the same before the page appears. Song is the story's
// font as it always was (--serif); the others are stacks in style.css
// (--font-hei and so on), each falling back to Song where the device has none.
export const STORY_FONTS = ['song', 'hei', 'kai', 'fang', 'custom']

// width 0 is the page's own (style.css --read).
// 出字效果: how a reply being written comes onto the page (淡入, 墨晕, 打字机, 逐句, 直接显示; web/stream-reveal.js).
// Here, not in shared/reveal.js, so the server's copy of this file needs nothing beside it.
export const REVEAL_MODES = ['fade', 'ink', 'type', 'sentence', 'none']
export const REVEAL_DEFAULT = 'fade'

export const READING_DEFAULTS = Object.freeze({ font: 'song', custom: '', scale: 1, leading: 1, ui: 1, width: 0, reveal: REVEAL_DEFAULT })

export const STORY_SCALE = Object.freeze({ min: 0.8, max: 1.6, step: 0.05 })

// 行距: the story's line height as a share of its usual one (each place keeps its own, 2 for a reply).
export const STORY_LEADING = Object.freeze({ min: 0.8, max: 1.4, step: 0.05 })

// 界面大小: the whole page on a touch screen (theme.js fitInterface).
export const UI_SCALE = Object.freeze({ min: 0.85, max: 1.3, step: 0.05 })

// 正文宽度: the story's column, in pixels (theme.js).
export const READ_WIDTH = Object.freeze({ min: 480, usual: 640, max: 1600, step: 8 })

/** A font name as typed: no quotes or CSS punctuation, at most 60 characters. */
export function cleanFontName(name) {
  return String(name ?? '').replace(/["'\\;{}<>\r\n\t]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
}

/** Any value → a valid { font, custom, scale, ui, width }. */
export function cleanReading(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const scale = Number(raw.scale)
  const leading = Number(raw.leading)
  const ui = Number(raw.ui)
  const width = Number(raw.width)
  return {
    font: STORY_FONTS.includes(raw.font) ? raw.font : READING_DEFAULTS.font,
    custom: cleanFontName(raw.custom),
    ui: raw.ui !== undefined && Number.isFinite(ui) ? Math.min(UI_SCALE.max, Math.max(UI_SCALE.min, Math.round(ui * 100) / 100)) : READING_DEFAULTS.ui,
    scale: Number.isFinite(scale) ? Math.min(STORY_SCALE.max, Math.max(STORY_SCALE.min, Math.round(scale * 100) / 100)) : READING_DEFAULTS.scale,
    leading: raw.leading !== undefined && Number.isFinite(leading) ? Math.min(STORY_LEADING.max, Math.max(STORY_LEADING.min, Math.round(leading * 100) / 100)) : READING_DEFAULTS.leading,
    width: width > 0 ? Math.min(READ_WIDTH.max, Math.max(READ_WIDTH.min, Math.round(width))) : READING_DEFAULTS.width,
    // 出字效果: how a reply being written comes onto the page (shared/reveal.js).
    reveal: REVEAL_MODES.indexOf(raw.reveal) >= 0 ? raw.reveal : READING_DEFAULTS.reveal,
  }
}

/** The CSS font-family for the story, or '' for the usual Song (also for a custom font with no name yet). */
export function storyFontOf(reading) {
  const { font, custom } = cleanReading(reading)
  if (font === 'custom') return custom ? `"${custom}", var(--serif)` : ''
  return font === 'song' ? '' : `var(--font-${font})`
}

/** Any value → a valid appearance; what is unknown falls back to the defaults. */
export function cleanAppearance(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const opacity = Number(raw.backdropOpacity)
  const custom = cleanCustom(raw.custom)
  return {
    style: STYLES.includes(raw.style) || (raw.style === 'custom' && custom) ? raw.style : APPEARANCE_DEFAULTS.style,
    backdrop: typeof raw.backdrop === 'string' && BACKDROP_FILE.test(raw.backdrop) ? raw.backdrop : '',
    backdropOpacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0.05, Math.round(opacity * 100) / 100)) : APPEARANCE_DEFAULTS.backdropOpacity,
    custom,
  }
}
