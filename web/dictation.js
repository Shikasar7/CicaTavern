// 语音输入: the microphone button beside the input box. app.js loads this file
// on the first press, so a server started before it existed still serves the
// page. What is said goes into the box at the cursor and is never sent by
// itself: the player reads it first. Where the audio goes is picked in
// 配图与朗读 → 语音输入 (media.js); nothing is recorded before that.
//   provider / local: the microphone (MediaRecorder) → a 16 kHz mono WAV →
//     POST /api/media/transcribe → the provider or the whisper server
//   browser: the browser's own recognition (Web Speech API), from the page to
//     the browser maker's service; where there is none (the phone app's WebView,
//     a page on plain http), the provider picked beside it writes the recording out
// Both need nothing installed. A whisper server is the player's own, at an address.
// Where the page may not use the microphone (a phone on the LAN over plain
// http), the phone's own recorder is asked for a recording instead.
import { locale, t } from '/i18n.js'

export const MAX_SECONDS = 180
// The loudest 50 ms below this: nothing was heard. Whisper writes a made-up line for silence.
const SILENCE = 0.006
const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null
const BROWSER_LANG = { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' }
const RECORD_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']

/** The phone app (Android WebView): no speech recognition there, whatever the page sees. */
export const inApp = () => document.documentElement.dataset.edition === 'android'
/** Whether the browser's own recognition can work here (it needs the microphone, so a secure page). */
export const browserRecognition = () => Boolean(Recognition) && !inApp() && globalThis.isSecureContext !== false
/** Whether this page may record from the microphone (https, this machine's own address, the phone app). */
export const canRecord = () => Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined'

const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

function micTrouble(error) {
  const name = error?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return inApp()
      ? t`没有麦克风权限：在手机的「设置 → 应用 → CicaTavern → 权限」里允许麦克风，再点一次`
      : t`浏览器没有允许用麦克风：点地址栏左边的图标，把麦克风改成「允许」，再点一次`
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return t`没有找到麦克风：接上或打开麦克风再试`
  if (name === 'NotReadableError' || name === 'AbortError') return t`麦克风被别的程序占着，或者系统不让用：关掉占用它的程序再试`
  return t`打不开麦克风：${error?.message || name}`
}

function recognitionTrouble(code) {
  if (code === 'not-allowed' || code === 'service-not-allowed') return t`浏览器没有允许用麦克风或语音识别：点地址栏左边的图标，把麦克风改成「允许」`
  if (code === 'audio-capture') return t`没有找到麦克风：接上或打开麦克风再试`
  if (code === 'network') return t`连不上浏览器的语音识别服务（Chrome 用 Google 的，Edge 用微软的）：检查网络，或者在「语音输入」里改用别的方式`
  if (code === 'no-speech') return t`没听到声音：检查麦克风，再说一次`
  if (code === 'language-not-supported') return t`浏览器的语音识别不支持这个语言：在「语音输入」里换一个`
  return code === 'aborted' ? '' : t`浏览器的语音识别出错了：${code}`
}

/** The microphone, or an Error that says what to do. */
async function openMicrophone() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
  } catch (error) {
    throw new Error(micTrouble(error))
  }
}

/** How loud the microphone is now (0…1), for the dot that moves while listening. */
function levelMeter(stream) {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext
  if (!Context) return { read: () => 0, close() {} }
  const context = new Context()
  context.resume?.().catch(() => {})
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  context.createMediaStreamSource(stream).connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  return {
    read() {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += sample * sample
      return Math.sqrt(sum / samples.length)
    },
    close: () => context.close().catch(() => {}),
  }
}

/** 16-bit PCM WAV of mono float samples. */
export function wavBlob(samples, rate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const ascii = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Blob([view.buffer], { type: 'audio/wav' })
}

/** The loudest 50 ms of a recording (RMS), to tell speech from silence. */
export function loudest(samples, rate) {
  const window = Math.max(1, Math.round(rate / 20))
  let best = 0
  for (let start = 0; start < samples.length; start += window) {
    let sum = 0
    const end = Math.min(samples.length, start + window)
    for (let i = start; i < end; i++) sum += samples[i] * samples[i]
    best = Math.max(best, Math.sqrt(sum / (end - start)))
  }
  return best
}

/**
 * A recording as 16 kHz mono WAV (every service takes it, whisper.cpp nothing
 * else) → { blob, seconds, loud }; when the browser cannot decode it, the
 * recording as it is, with loud unknown (null).
 */
export async function prepareAudio(blob) {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext
  if (!Context || typeof OfflineAudioContext === 'undefined') return { blob, seconds: null, loud: null }
  let decoded
  const context = new Context()
  try {
    decoded = await context.decodeAudioData(await blob.arrayBuffer())
  } catch {
    return { blob, seconds: null, loud: null }
  } finally {
    context.close().catch(() => {})
  }
  const rate = 16000
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const samples = (await offline.startRendering()).getChannelData(0)
  return { blob: wavBlob(samples, rate), seconds: decoded.duration, loud: loudest(samples, rate) }
}

const base64 = blob => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(blob)
})

/**
 * A recording → { text, by } from the server. `media`: the settings form's
 * values (试一试), else the saved ones; `names`: how the chat spells its people.
 */
export async function transcribe(blob, { names = [], media, signal } = {}) {
  const res = await fetch('/api/media/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' },
    body: JSON.stringify({ audio: await base64(blob), type: blob.type, names, ...(media ? { media } : {}) }),
    signal,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || t`转写失败（${res.status}）`)
  return body
}

/**
 * One take from the microphone: start() asks for it and records; stop() →
 * the recording (a Blob), cancel() drops it. onTick(seconds, level) about ten
 * times a second; at MAX_SECONDS it stops by itself (onLimit).
 */
export function microphoneTake({ onTick = () => {}, onLimit = () => {} } = {}) {
  let stream = null
  let meter = null
  let recorder = null
  let timer = 0
  let done = null
  let dropped = false
  const release = () => {
    clearInterval(timer)
    meter?.close()
    for (const track of stream?.getTracks() ?? []) track.stop()
  }
  return {
    async start() {
      stream = await openMicrophone()
      if (dropped) return release()
      meter = levelMeter(stream)
      const type = RECORD_TYPES.find(type => MediaRecorder.isTypeSupported?.(type)) ?? ''
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : {})
      const chunks = []
      recorder.ondataavailable = event => {
        if (event.data.size) chunks.push(event.data)
      }
      done = new Promise(resolve => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: (recorder.mimeType || type || 'audio/webm').split(';')[0] }))
      })
      recorder.start(1000)
      const started = Date.now()
      timer = setInterval(() => {
        const seconds = (Date.now() - started) / 1000
        onTick(seconds, meter.read())
        if (seconds >= MAX_SECONDS) onLimit()
      }, 100)
    },
    async stop() {
      if (!recorder) return null
      if (recorder.state !== 'inactive') recorder.stop()
      const blob = await done
      release()
      return blob
    },
    cancel() {
      dropped = true
      if (recorder && recorder.state !== 'inactive') recorder.stop()
      release()
    },
  }
}

/**
 * The browser's own recognition: what it hears as it hears it (onText), the
 * whole of it when it ends → finished(text); a failure → finished('', message).
 */
export function browserTake({ language = '', onText = () => {}, finished }) {
  const recognition = new Recognition()
  recognition.lang = BROWSER_LANG[language] ?? (locale === 'en-US' ? 'en-US' : 'zh-CN')
  recognition.continuous = true
  recognition.interimResults = true
  let heard = ''
  let pending = ''
  let failure = ''
  let dropped = false
  recognition.onresult = event => {
    pending = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      if (result.isFinal) heard += result[0].transcript
      else pending += result[0].transcript
    }
    onText(heard + pending)
  }
  recognition.onerror = event => {
    failure = recognitionTrouble(event.error)
  }
  recognition.onend = () => {
    if (!dropped) finished(failure ? '' : (heard + pending).trim(), failure)
  }
  recognition.start()
  return {
    stop: () => recognition.stop(),
    cancel() {
      dropped = true
      recognition.abort()
    },
  }
}

/** Put text into the box at its cursor (or over its selection), with a space between Latin words. */
export function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? start
  const before = input.value.slice(0, start)
  const after = input.value.slice(end)
  const lead = /[A-Za-z0-9,.!?;:]$/.test(before) && /^[A-Za-z0-9]/.test(text) ? ' ' : ''
  const trail = /[A-Za-z0-9.,!?]$/.test(text) && /^[A-Za-z0-9]/.test(after) ? ' ' : ''
  input.setRangeText(`${lead}${text}${trail}`, start, end, 'end')
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * The microphone button and the strip above the input box while it listens
 * or the words are being written out.
 * @param deps - { el, toast, input, button, composer (the form; the strip goes
 *   above the box), settings() → the media settings, names() → the chat's names,
 *   openSettings(section) }
 */
export function createDictation({ el, toast, input, button, composer, settings, names, openSettings }) {
  const dot = el('span', { class: 'dictation-dot', 'aria-hidden': 'true' })
  const time = el('span', { class: 'dictation-time' })
  const said = el('span', { class: 'dictation-text' })
  const cancelButton = el('button', { type: 'button', class: 'btn small ghost', text: t`取消`, onclick: () => cancel() })
  const doneButton = el('button', { type: 'button', class: 'btn small', text: t`完成`, onclick: () => finish() })
  const bar = el('div', { class: 'dictation', role: 'status', hidden: true }, [dot, time, said, cancelButton, doneButton])
  composer.querySelector('.composer-box').before(bar)
  // A phone's own recorder, where the page may not use the microphone itself.
  const picker = el('input', { type: 'file', accept: 'audio/*', capture: '', hidden: true })
  let pickWith = null // the settings to write the picked recording out with (press)
  picker.addEventListener('change', () => {
    const [file] = picker.files
    picker.value = ''
    if (file) writeOut(file, pickWith)
  })
  composer.append(picker)

  // { stage: 'starting' | 'listening' | 'writing', stop(), cancel() } while one is on.
  let take = null
  const touch = matchMedia('(hover: none) and (pointer: coarse)')

  function show(stage, text = '') {
    if (take) take.stage = stage
    button.classList.toggle('listening', stage === 'listening')
    button.classList.toggle('working', stage === 'starting' || stage === 'writing')
    button.setAttribute('aria-pressed', String(stage === 'listening'))
    button.title = stage === 'listening' ? t`说完了：点一下转成文字` : stage === 'writing' ? t`正在转成文字，点一下取消` : t`语音输入：说话转成文字，填进输入框（不会自动发送）`
    bar.hidden = !stage
    bar.dataset.stage = stage || ''
    doneButton.hidden = stage !== 'listening'
    said.textContent = text
    if (!stage) time.textContent = ''
  }

  const onKey = event => {
    if (event.key === 'Escape' && take) {
      event.stopPropagation()
      cancel()
    }
  }

  function begin(stop, drop) {
    take = { stage: 'starting', stop, cancel: drop }
    document.addEventListener('keydown', onKey, true)
    show('starting', t`正在打开麦克风…`)
  }

  function end() {
    take = null
    document.removeEventListener('keydown', onKey, true)
    show('')
  }

  function cancel() {
    if (!take) return
    const current = take
    end()
    current.cancel()
  }

  function finish() {
    if (take?.stage === 'listening') take.stop()
  }

  function put(text) {
    if (!text) return toast(t`没听清，再说一次`)
    insertAtCursor(input, text)
    // A phone's keyboard would cover the story: the text is there to read first.
    if (!touch.matches) input.focus()
  }

  /** A recording → the server → the box; `media` over the saved settings (the provider in place of the browser). */
  async function writeOut(blob, media = null) {
    const controller = new AbortController()
    begin(() => {}, () => controller.abort())
    show('writing', t`正在转成文字…`)
    try {
      const audio = await prepareAudio(blob)
      if (controller.signal.aborted) return
      if (audio.seconds !== null && audio.seconds < 0.4) return toast(t`录音太短了：点一下麦克风开始说，说完再点一下`)
      if (audio.loud !== null && audio.loud < SILENCE) return toast(t`没听到声音：检查麦克风有没有静音、选对没有`, 6000)
      const { text } = await transcribe(audio.blob, { names: names(), media, signal: controller.signal })
      if (!controller.signal.aborted) put(text)
    } catch (error) {
      if (!controller.signal.aborted) toast(error.message, 8000)
    } finally {
      if (!controller.signal.aborted) end()
    }
  }

  async function listen(media = null) {
    let stopping = false
    const mic = microphoneTake({
      onTick(seconds, level) {
        time.textContent = `${clock(seconds)} / ${clock(MAX_SECONDS)}`
        dot.style.setProperty('--level', String(Math.min(1, level * 12)))
      },
      onLimit: () => stop(),
    })
    const stop = async () => {
      if (stopping) return
      stopping = true
      const blob = await mic.stop()
      end()
      if (blob) writeOut(blob, media)
    }
    begin(stop, () => mic.cancel())
    try {
      await mic.start()
    } catch (error) {
      end()
      return toast(error.message, 8000)
    }
    if (take?.stop !== stop) return
    show('listening', media ? t`在听…（这里没有浏览器识别，改用供应商转写）` : t`在听…说完点「完成」或再点一下麦克风`)
  }

  function listenInBrowser(language) {
    let current = null
    const started = Date.now()
    let timer = 0
    const stop = () => current?.stop()
    begin(stop, () => {
      clearInterval(timer)
      current?.cancel()
    })
    try {
      current = browserTake({
        language,
        onText: text => { said.textContent = text },
        finished(text, failure) {
          clearInterval(timer)
          if (take?.stop !== stop) return
          end()
          if (failure) toast(failure, 8000)
          else put(text)
        },
      })
    } catch (error) {
      end()
      return toast(t`浏览器的语音识别开不了：${error.message}`, 8000)
    }
    show('listening', t`在听…（浏览器识别）`)
    timer = setInterval(() => {
      const seconds = (Date.now() - started) / 1000
      time.textContent = `${clock(seconds)} / ${clock(MAX_SECONDS)}`
      if (seconds >= MAX_SECONDS) stop()
    }, 250)
  }

  /** The button: start, finish (while listening) or cancel (while writing out). */
  function press() {
    if (take) return take.stage === 'listening' ? finish() : cancel()
    const media = settings() ?? {}
    const source = media.sttSource ?? ''
    if (source === 'off') return
    if (!source) {
      toast(t`先选录音交给谁转成文字：供应商、浏览器自带的识别，或者本机的 whisper 服务`, 6000)
      return openSettings('stt')
    }
    // Where the browser has no recognition (the phone app, a phone on plain http), the provider picked beside it writes it out.
    let instead = null
    if (source === 'browser') {
      if (browserRecognition()) return listenInBrowser(media.sttLanguage)
      if (!media.sttProvider) {
        toast(inApp() ? t`手机应用里没有浏览器识别：在「语音输入」里选一个供应商，这里就改用它转写` : t`这里用不了浏览器识别（要 Edge、Chrome 或 Safari，用 https 或本机地址打开）：在「语音输入」里选一个供应商，这里就改用它转写`, 8000)
        return openSettings('stt')
      }
      instead = { sttSource: 'provider' }
    }
    if (canRecord()) return listen(instead)
    // Plain http on another device: the page may not open the microphone, a recorder app may.
    toast(t`这个地址的网页不能直接用麦克风（要 https 或本机地址），改用手机的录音机：录完点确定`, 8000)
    pickWith = instead
    picker.click()
  }

  return { press, cancel, busy: () => Boolean(take) }
}
