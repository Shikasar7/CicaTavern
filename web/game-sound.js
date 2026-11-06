// 游戏规则的声音, made here and now with Web Audio: no sound files in the app, nothing to license. Every recipe takes a
// context and where to play, so the same code plays in the page and renders to a file for listening to it.
import { LAYERS, ambienceFor, cleanSound, layerLevel, trackFor } from '/shared/game/sound.js'

const KEY = 'cicatavern.sound'
const FADE = 0.25
const LOOP_SECONDS = 8
const THUNDER_EVERY = [18, 42]
const QUIET = 0.0001

function noiseBuffer(ctx, seconds, brown = false) {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  let last = 0
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1
    if (brown) {
      last = (last + 0.02 * white) / 1.02
      data[i] = last * 3.5
    } else data[i] = white
  }
  return buffer
}

/** The start of a loop's sound laid over its end, so it goes round without a seam. */
function seamless(buffer, seconds) {
  const fade = Math.floor(buffer.sampleRate * seconds)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    const end = data.length - fade
    for (let i = 0; i < fade; i++) {
      const mix = i / fade
      data[i] = data[i] * mix + data[end + i] * (1 - mix)
    }
  }
  const out = new AudioBuffer({ length: buffer.length - fade, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate })
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) out.copyToChannel(buffer.getChannelData(channel).subarray(0, buffer.length - fade), channel)
  return out
}

function envelope(param, at, peak, attack, decay) {
  param.setValueAtTime(QUIET, at)
  param.exponentialRampToValueAtTime(peak, at + attack)
  param.exponentialRampToValueAtTime(QUIET, at + attack + decay)
}

function tone(ctx, out, at, { type = 'sine', from, to = from, peak, attack = 0.005, decay }) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(from, at)
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + attack + decay)
  envelope(gain.gain, at, peak, attack, decay)
  osc.connect(gain).connect(out)
  osc.start(at)
  osc.stop(at + attack + decay + 0.05)
}

function burst(ctx, out, at, { buffer, filter, freq, q = 1, peak, attack = 0.002, decay, offset = 0 }) {
  const source = ctx.createBufferSource()
  const shape = ctx.createBiquadFilter()
  const gain = ctx.createGain()
  source.buffer = buffer
  shape.type = filter
  shape.frequency.value = freq
  shape.Q.value = q
  envelope(gain.gain, at, peak, attack, decay)
  source.connect(shape).connect(gain).connect(out)
  source.start(at, offset, attack + decay + 0.05)
}

const noises = new WeakMap()

/** A context's own second of white noise and four of brown, made once. */
function noiseOf(ctx) {
  if (!noises.has(ctx)) noises.set(ctx, { white: noiseBuffer(ctx, 1), brown: noiseBuffer(ctx, 5, true) })
  return noises.get(ctx)
}

const NOTE = { D4: 293.66, F4: 349.23, A4: 440, C5: 523.25, E5: 659.25, G5: 783.99, C6: 1046.5 }

/** What happens. Each: (ctx, out, at). */
export const EFFECTS = {
  tap(ctx, out, at) {
    tone(ctx, out, at, { from: 900, to: 620, peak: 0.1, attack: 0.002, decay: 0.05 })
  },
  // The die on a table: quick knocks, slowing, the last ones softer. As long as its animation.
  dice(ctx, out, at) {
    const { white } = noiseOf(ctx)
    const gaps = [0, 0.055, 0.12, 0.2, 0.3, 0.42, 0.58, 0.78, 1.02]
    gaps.forEach((gap, i) => {
      const force = 1 - i / (gaps.length + 3)
      burst(ctx, out, at + gap, { buffer: white, filter: 'bandpass', freq: 1900 + Math.random() * 1900, q: 5, peak: 0.55 * force, decay: 0.03, offset: Math.random() * 0.8 })
      tone(ctx, out, at + gap, { from: 230 + Math.random() * 110, peak: 0.2 * force, attack: 0.001, decay: 0.045 })
    })
  },
  hit(ctx, out, at) {
    tone(ctx, out, at, { from: 150, to: 52, peak: 0.7, decay: 0.16 })
    burst(ctx, out, at, { buffer: noiseOf(ctx).white, filter: 'lowpass', freq: 1400, peak: 0.34, decay: 0.07 })
  },
  crit(ctx, out, at) {
    EFFECTS.hit(ctx, out, at)
    burst(ctx, out, at, { buffer: noiseOf(ctx).white, filter: 'highpass', freq: 3000, peak: 0.2, decay: 0.05 })
    tone(ctx, out, at + 0.01, { type: 'triangle', from: 1760, to: 1320, peak: 0.2, decay: 0.3 })
    tone(ctx, out, at + 0.01, { from: 2637, peak: 0.08, decay: 0.34 })
  },
  heal(ctx, out, at) {
    [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6].forEach((note, i) => {
      tone(ctx, out, at + i * 0.09, { from: note, peak: 0.15, attack: 0.02, decay: 0.6 })
      tone(ctx, out, at + i * 0.09, { type: 'triangle', from: note / 2, peak: 0.04, attack: 0.02, decay: 0.45 })
    })
  },
  win(ctx, out, at) {
    [[NOTE.C5, 0, 0.3], [NOTE.E5, 0.13, 0.3], [NOTE.G5, 0.26, 0.3], [NOTE.C6, 0.42, 1]].forEach(([note, wait, decay]) => {
      tone(ctx, out, at + wait, { type: 'triangle', from: note, peak: 0.2, attack: 0.01, decay })
      tone(ctx, out, at + wait, { from: note * 2, peak: 0.05, attack: 0.01, decay: decay * 0.7 })
    })
  },
  lose(ctx, out, at) {
    const soft = ctx.createBiquadFilter()
    soft.type = 'lowpass'
    soft.frequency.value = 1100
    soft.connect(out)
    ;[[NOTE.A4, 0, 0.45], [NOTE.F4, 0.24, 0.45], [NOTE.D4, 0.48, 1.1]].forEach(([note, wait, decay]) => {
      tone(ctx, soft, at + wait, { type: 'triangle', from: note, peak: 0.26, attack: 0.03, decay })
    })
  },
  // A crack, then the long roll behind it.
  thunder(ctx, out, at) {
    const { white, brown } = noiseOf(ctx)
    burst(ctx, out, at, { buffer: white, filter: 'highpass', freq: 1500, peak: 0.28, decay: 0.09 })
    burst(ctx, out, at + 0.11, { buffer: white, filter: 'bandpass', freq: 900, q: 0.7, peak: 0.22, decay: 0.14 })
    burst(ctx, out, at + 0.05, { buffer: brown, filter: 'lowpass', freq: 190, q: 0.7, peak: 1.1, attack: 0.12, decay: 3.4 })
    burst(ctx, out, at + 0.8, { buffer: brown, filter: 'lowpass', freq: 110, q: 0.7, peak: 0.8, attack: 0.3, decay: 2.8, offset: 1.5 })
  },
}

/** Rain as a loop: a steady hiss, with drops in it, a little different in each ear. */
function rainBuffer(ctx) {
  const rate = ctx.sampleRate
  const fade = 0.6
  const buffer = ctx.createBuffer(2, Math.ceil(rate * (LOOP_SECONDS + fade)), rate)
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel)
    let low = 0
    let lower = 0
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1
      low += 0.42 * (white - low)
      lower += 0.02 * (white - lower)
      data[i] = (low - lower) * 0.55 + lower * 1.6
    }
    const drops = Math.round((LOOP_SECONDS + fade) * 34)
    for (let n = 0; n < drops; n++) {
      const start = Math.floor(Math.random() * (data.length - rate * 0.03))
      const pitch = (1400 + Math.random() * 3600) / rate
      const length = Math.floor(rate * (0.006 + Math.random() * 0.016))
      const force = 0.06 + Math.random() * 0.16
      for (let i = 0; i < length; i++) data[start + i] += Math.sin(2 * Math.PI * pitch * i) * force * (1 - i / length) ** 2
    }
  }
  return seamless(buffer, fade)
}

/** What goes on all the time. Each: (ctx, out) → stop(). */
export const AMBIENCE = {
  rain(ctx, out) {
    const source = ctx.createBufferSource()
    const gain = ctx.createGain()
    source.buffer = rainBuffer(ctx)
    source.loop = true
    gain.gain.value = 0.55
    source.connect(gain).connect(out)
    source.start()
    return () => source.stop()
  },
  wind(ctx, out) {
    const source = ctx.createBufferSource()
    const shape = ctx.createBiquadFilter()
    const gain = ctx.createGain()
    const sway = ctx.createOscillator()
    const swayBy = ctx.createGain()
    const gust = ctx.createOscillator()
    const gustBy = ctx.createGain()
    source.buffer = seamless(noiseBuffer(ctx, LOOP_SECONDS, true), 0.8)
    source.loop = true
    shape.type = 'bandpass'
    shape.frequency.value = 430
    shape.Q.value = 0.8
    gain.gain.value = 0.75
    sway.frequency.value = 0.09
    swayBy.gain.value = 190
    sway.connect(swayBy).connect(shape.frequency)
    gust.frequency.value = 0.17
    gustBy.gain.value = 0.3
    gust.connect(gustBy).connect(gain.gain)
    source.connect(shape).connect(gain).connect(out)
    for (const node of [source, sway, gust]) node.start()
    return () => [source, sway, gust].forEach(node => node.stop())
  },
}

function recall() {
  try {
    return cleanSound(JSON.parse(localStorage.getItem(KEY)))
  } catch {
    return cleanSound(null)
  }
}

/**
 * The page's sound. Browsers keep audio shut until a tap: it starts on the first one, and everything asked for
 * before that begins then.
 */
export function createSound() {
  let prefs = recall()
  let ctx = null
  const layers = {}
  let reading = false
  let weather = null
  let stops = []
  let thunderTimer = 0
  let tracks = []
  let place = ''
  let fighting = false
  // Music is for the visual novel and for fights: the chat stays quiet.
  let staged = false
  let same = (a, b) => a === b
  let playing = null
  const audio = typeof Audio === 'undefined' ? null : new Audio()
  if (audio) audio.loop = true

  function start() {
    if (!ctx) {
      const Context = window.AudioContext ?? window.webkitAudioContext
      if (!Context) return false
      ctx = new Context()
      for (const layer of LAYERS) {
        layers[layer] = ctx.createGain()
        layers[layer].gain.value = layerLevel(prefs, layer, reading)
        layers[layer].connect(ctx.destination)
      }
      if (audio) ctx.createMediaElementSource(audio).connect(layers.music)
      setWeather(weather)
      pickTrack()
    }
    if (ctx.state === 'suspended') ctx.resume()
    return true
  }

  const unlock = () => {
    start()
    if (ctx?.state === 'running') document.removeEventListener('pointerdown', unlock, true)
  }
  document.addEventListener('pointerdown', unlock, true)

  function applyLevels() {
    if (!ctx) return
    for (const layer of LAYERS) layers[layer].gain.setTargetAtTime(layerLevel(prefs, layer, reading), ctx.currentTime, FADE / 3)
  }

  function play(name) {
    if (!layerLevel(prefs, 'effects') || !start()) return
    EFFECTS[name]?.(ctx, layers.effects, ctx.currentTime + 0.01)
  }

  function nextThunder() {
    const [least, most] = THUNDER_EVERY
    thunderTimer = setTimeout(() => {
      if (ctx && layerLevel(prefs, 'ambience')) EFFECTS.thunder(ctx, layers.ambience, ctx.currentTime + 0.01)
      nextThunder()
    }, (least + Math.random() * (most - least)) * 1000)
  }

  function setWeather(next) {
    const changed = next !== weather
    weather = next
    if (!ctx || (!changed && stops.length)) return
    stops.forEach(stop => stop())
    stops = []
    clearTimeout(thunderTimer)
    for (const kind of ambienceFor(next)) {
      if (kind === 'thunder') nextThunder()
      else stops.push(AMBIENCE[kind](ctx, layers.ambience))
    }
  }

  /** The right track for now, playing if it can: asked again when audio opens up, or the settings change. */
  function pickTrack() {
    if (!audio) return
    const track = staged || fighting ? trackFor(tracks, { place, fighting, same }) : null
    if (track?.id !== playing?.id) {
      playing = track
      if (track) audio.src = track.url
    }
    if (!track || !layerLevel(prefs, 'music')) audio.pause()
    else if (ctx && audio.paused) audio.play().catch(() => {})
  }

  return {
    prefs: () => prefs,
    play,
    setPrefs(next) {
      prefs = cleanSound({ ...prefs, ...next })
      try {
        localStorage.setItem(KEY, JSON.stringify(prefs))
      } catch {
        // Private mode: for this visit.
      }
      applyLevels()
      pickTrack()
    },
    setWeather,
    setReading(on) {
      reading = on
      applyLevels()
    },
    setTracks(list, compare) {
      tracks = list
      if (compare) same = compare
      pickTrack()
    },
    setPlace(next) {
      staged = true
      place = next ?? ''
      pickTrack()
    },
    setFighting(on) {
      fighting = on
      pickTrack()
    },
    /** Leaving the visual novel: what goes on all the time stops. */
    quiet() {
      setWeather(null)
      place = ''
      staged = false
      pickTrack()
    },
    state: () => ({ context: ctx?.state ?? 'none', weather, loops: stops.length, reading, levels: ctx ? Object.fromEntries(LAYERS.map(layer => [layer, layerLevel(prefs, layer, reading)])) : null, track: playing?.id ?? null }),
  }
}
