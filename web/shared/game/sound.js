// 游戏规则的声音: what is on and how loud. The sounds themselves are made in the page (web/game-sound.js). Pure, so
// Node can test it. Three layers: 音效 for what happens, 环境音 for the weather, 音乐 the player's own.

export const LAYERS = ['effects', 'ambience', 'music']
// Music waits to be asked for: it is the player's to bring.
export const SOUND_DEFAULTS = { on: true, effects: 0.7, ambience: 0.5, music: 0, off: [] }
// What the voice reading a line leaves of everything else.
const UNDER_VOICE = 0.35

const level = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null)

/** The settings as kept: what is missing is the default. */
export function cleanSound(value) {
  const stored = value && typeof value === 'object' ? value : {}
  const out = { on: stored.on !== false }
  for (const layer of LAYERS) out[layer] = level(stored[layer]) ?? SOUND_DEFAULTS[layer]
  // A layer switched off keeps its volume for when it comes back.
  out.off = LAYERS.filter(layer => Array.isArray(stored.off) && stored.off.includes(layer))
  return out
}

/** How loud a layer plays. Under a voice, what goes on all the time steps back; a blow still lands. */
export function layerLevel(prefs, layer, reading = false) {
  if (!prefs.on || prefs.off?.includes(layer)) return 0
  return prefs[layer] * (reading && layer !== 'effects' ? UNDER_VOICE : 1)
}

/** What a weather sounds like: rain, wind, thunder now and then. Sunshine has no sound of its own. */
export function ambienceFor(weather) {
  if (weather === 'rain') return ['rain']
  if (weather === 'storm') return ['rain', 'wind', 'thunder']
  if (weather === 'snow' || weather === 'fog') return ['wind']
  return []
}

/** The track to play: for a fight, for the place, else the story's. A track is { id, use: 'story'|'battle'|place name }. */
export function trackFor(tracks, { place = '', fighting = false, same = (a, b) => a === b } = {}) {
  if (fighting) {
    const fight = tracks.find(track => track.use === 'battle')
    if (fight) return fight
  }
  return tracks.find(track => track.use !== 'story' && track.use !== 'battle' && place && same(track.use, place)) ?? tracks.find(track => track.use === 'story') ?? null
}
