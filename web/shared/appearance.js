// 外观: the page's colour style and an optional picture behind it, shared by
// the server (settings.appearance, checked here) and the page (web/theme.js).
// Light or dark (跟随系统 / 浅色 / 深色) stays with each browser, as before
// (localStorage 'theme'); each style has both.

export const STYLES = ['lamp', 'sakura', 'bamboo', 'paper', 'night']

export const APPEARANCE_DEFAULTS = Object.freeze({ style: 'lamp', backdrop: '', backdropOpacity: 0.5 })

/** The picture's file in the data folder's ui/: its name changes with each upload, so the page never sees a stale one. */
export const BACKDROP_FILE = /^backdrop-[a-z0-9]{4,16}\.(jpg|png|webp)$/

/** Any value → a valid appearance; what is unknown falls back to the defaults. */
export function cleanAppearance(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const opacity = Number(raw.backdropOpacity)
  return {
    style: STYLES.includes(raw.style) ? raw.style : APPEARANCE_DEFAULTS.style,
    backdrop: typeof raw.backdrop === 'string' && BACKDROP_FILE.test(raw.backdrop) ? raw.backdrop : '',
    backdropOpacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0.05, Math.round(opacity * 100) / 100)) : APPEARANCE_DEFAULTS.backdropOpacity,
  }
}
