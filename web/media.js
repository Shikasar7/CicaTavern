// Pictures and voice for replies: the 配图 / 朗读 buttons, the picture strip
// under a reply, the reading bar above the input box and the settings window.
// Nothing here changes what the model sees.
import { speechChunks } from '/shared/speech.js'
import { speakerNames, splitLines } from '/shared/vn.js'
import { createMenu, MENU_ICONS, whoLine } from '/menu.js'
import { locale, t, zh } from '/i18n.js'
import { NAI_MODELS } from '/draw-choice.js'
import { GEMINI_IMAGE_MODELS, IMAGE_MODEL } from '/shared/draw.js'

const SHAPES = [['square', t`方图`], ['portrait', t`竖图`], ['landscape', t`横图`]]
const IMAGE_BACKEND_TEXT = { openai: t`图片接口`, gemini: 'Gemini', comfy: 'ComfyUI', sdwebui: 'SD WebUI', novelai: 'NovelAI' }
// The image backends as offered, the usual first.
const imageBackends = () => [
  ['openai', t`OpenAI 兼容图片接口（gpt-image 等）`],
  ['gemini', t`Gemini 原生生图（Nano Banana，能照人设图画）`],
  ['novelai', t`NovelAI（二次元推荐）`],
  ['comfy', t`ComfyUI 工作流（本地）`],
  ['sdwebui', t`SD WebUI / Forge（本地）`],
]
const GEMINI_TTS_MODELS = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts']
const SD_SAMPLERS = ['Euler a', 'Euler', 'DPM++ 2M', 'DPM++ 2M Karras', 'DPM++ SDE Karras', 'DPM++ 2M SDE', 'DDIM', 'UniPC']
/** A provider holding Google's key (the Gemini template), offered first for Gemini's own models. */
const isGoogle = p => /generativelanguage\.googleapis\.com|\/v1beta\/openai\/?$/i.test(p?.baseURL ?? '')
// A voice service on this machine or the LAN (小雅, or the tavern on a PC):
// local TTS models, as against the cloud services.
const BRIDGE_NAME = t`本地语音桥接`

// Browser voices (Web Speech API): spoken by the page itself, free, nothing
// goes to the server. A card names one as `browser:<voice name>`; a device
// without that voice reads with its first Chinese voice instead. With no voice
// service set up, a card without a voice reads with the browser too.
const BROWSER = 'browser:'
const DELIVERY_TAG = /\[[^\]\n]{1,40}\]\s*/g
const speech = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined' ? speechSynthesis : null
speech?.getVoices()

// Voice sources on the server (server/voice/): a card names a voice as `<source>:<id>`.
const VOICE_SOURCES = ['openai', 'fish', 'minimax', 'gemini']
const VOICE_FIELDS = ['ttsProvider', 'ttsModel', 'ttsVoices', 'fishModel', 'fishVoices', 'minimaxModel', 'minimaxRegion', 'minimaxVoices', 'geminiTtsProvider', 'geminiTtsModel', 'geminiTtsVoices']
const TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd', 'FunAudioLLM/CosyVoice2-0.5B']
const FISH_MODELS = [['drama-3', t`drama-3（情绪最足，按用量计费）`], ['s2.1-pro', 's2.1-pro'], ['s2.1-pro-free', t`s2.1-pro-free（免费，合理使用）`], ['s2-pro', 's2-pro']]
const MINIMAX_MODELS = ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd']
// Read in the story's language, which the voices are for.
const PREVIEW_LINE = zh`你好呀，很高兴见到你。今天想听我讲点什么呢？`
// Characters per chunk: the bridge's Qwen3 voices keep their intonation over ~100;
// cloud voices bill per request, so longer; Chrome stops a long utterance after ~15 s.
const CHUNK_MAX = { bridge: 100, browser: 150, openai: 250, fish: 250, minimax: 300, gemini: 300 }

const browserVoiceList = () => (speech ? speech.getVoices() : [])

/** The voices once the browser has them (Chrome's list starts empty). */
async function loadBrowserVoices() {
  if (!speech || browserVoiceList().length) return browserVoiceList()
  await new Promise(resolve => {
    speech.addEventListener('voiceschanged', resolve, { once: true })
    setTimeout(resolve, 1500)
  })
  return browserVoiceList()
}

/** The voice a `browser:` reference names, else the first Chinese one. */
function browserVoice(ref) {
  const name = String(ref ?? '').startsWith(BROWSER) ? ref.slice(BROWSER.length) : ''
  const list = browserVoiceList()
  return list.find(v => v.name === name) ?? list.find(v => /^zh/i.test(v.lang)) ?? null
}

/**
 * @param deps - { api, el, toast, guard, getChat, getModels, openProviders, saveFile,
 *   pickDraw(options) (web/draw-choice.js: the 画图方式 and model for one picture) }
 */
export function initMedia({ api, el, toast, guard, getChat, getModels, openProviders, saveFile, pickDraw }) {
  const $ = id => document.getElementById(id)
  // The settings window (配图与朗读) as a menu of parts (web/menu.js).
  const settingsMenu = createMenu({ dialog: $('media-dialog'), form: $('media-form'), el, title: t`配图与朗读` })
  const state = {
    settings: null,
    cardId: null,
    cardMedia: { voice: '', narratorVoice: '', style: '', styleNegative: '', lora: '', loraTrigger: '', loraStrength: 0.8 },
    jobs: new Map(), // nodeId → { stage, chatId, controller, started, backend } of a picture in the works
    failures: new Map(), // nodeId → { stage, chatId, prompt, message } shown in place of the picture
    fresh: new Set(), // files just drawn: they come into focus once loaded
    // This install's own image backends, as /api/media/settings describes them ({ id, name, ready, need, hint, models, model }).
    ownBackends: [],
  }
  const ownBackend = id => state.ownBackends.find(own => own.id === id) ?? null

  async function loadSettings() {
    try {
      const view = await api('/api/media/settings')
      state.settings = view.media
      state.ownBackends = view.ownBackends ?? []
    } catch {
      state.settings = null
    }
    // How long a piece each voice takes; until it arrives, the voice's prefix says.
    api('/api/media/voices').then(info => { state.voiceInfo = info }, () => {})
  }

  /** The card's settings just saved: the visual novel mode's cast (web/vn.js) follows its 角色名册. */
  function announceCardMedia() {
    document.dispatchEvent(new CustomEvent('cicatavern:card-media', { detail: { cardId: state.cardId, media: state.cardMedia } }))
  }

  async function setCard(cardId) {
    state.cardId = cardId
    state.cardMedia = cardId ? await api(`/api/cards/${cardId}/media`).catch(() => state.cardMedia) : { voice: '', narratorVoice: '', style: '', styleNegative: '', lora: '', loraTrigger: '', loraStrength: 0.8 }
  }

  const article = nodeId => document.querySelector(`.msg[data-id="${CSS.escape(nodeId)}"]`)

  /** The prose as shown (status bars and card HTML are in iframes, not in .story). */
  function shownText(node) {
    const box = article(node.id)
    // A line's emotion (from its 小白X voice tag) goes back after it as a voice tag for
    // speechChunks, just while the text is read off the page.
    const marks = box ? [...box.querySelectorAll('.msg-body .story .q[data-emotion]')].map(q => {
      const mark = document.createTextNode(voiceTagFor(q))
      q.after(mark)
      return mark
    }) : []
    try {
      // Folded reasoning is not part of the story.
      const storyText = s => [...s.children].filter(c => !c.matches('details.fold')).map(c => c.innerText.trim()).filter(Boolean).join('\n\n')
      const stories = box ? [...box.querySelectorAll('.msg-body .story')].map(storyText).filter(Boolean) : []
      return stories.length ? stories.join('\n\n') : node.text ?? ''
    } finally {
      for (const mark of marks) mark.remove()
    }
  }

  const voiceTagFor = q => (q.dataset.emotion ? `[voice:${q.dataset.emotion.replace(/[\]:]/g, ' ')}:]` : '')

  // ─── Reply tools ──────────────────────────────────────────────────────

  function toolsFor(node) {
    const reading = player.nodeId === node.id
    const job = state.jobs.get(node.id)
    const label = job?.stage === 'prompt' ? t`写提示词…` : job ? t`配图中…` : t`配图`
    return [
      el('button', { text: label, disabled: Boolean(job), title: t`辅助模型在后台描述这一幕，写好了弹出来让你确认，再交给生图模型`, onclick: () => writePrompt(node) }),
      el('button', { text: t`提示词库`, disabled: Boolean(job), title: t`用以前画过或存下的提示词给这段配图，可以先改再画`, onclick: () => openLibrary({ node, chatId: getChat()?.id }) }),
      el('button', { class: reading ? 'on' : '', text: reading ? t`停止朗读` : t`朗读`, title: t`对白用角色音色，旁白用旁白音色。只想听某一句：直接点那句对白`, onclick: () => (reading ? player.stop() : readNode(node)) }),
    ]
  }

  // ─── Pictures ─────────────────────────────────────────────────────────
  // Both steps run in the background: the prompt is written while you keep
  // reading or typing, a dialog asks once it is ready, the picture is drawn
  // under the reply. Jobs remember their chat, so switching chats is fine.

  function gallery(chat, node) {
    const images = node.media?.images ?? []
    const job = state.jobs.get(node.id)
    const failure = state.failures.get(node.id)
    const failed = failure?.chatId === chat.id ? failure : null
    if (!images.length && !job && !failed) return el('div', { class: 'reply-images', 'data-gallery': node.id, hidden: true })
    return el('div', { class: 'reply-images', 'data-gallery': node.id }, [
      ...images.map(image => {
        const fresh = state.fresh.delete(image.file)
        const img = el('img', { src: `/api/media/${chat.id}/${image.file}`, alt: image.prompt, loading: fresh ? 'eager' : 'lazy', class: fresh ? 'fresh' : null, style: fresh ? `--ratio: ${ratioOf()}` : null, onclick: () => viewImage(chat, node, image) })
        // A new picture develops out of the blurred frame it replaced.
        if (fresh) {
          // Timers, not animation frames: those pause while the window is in the background.
          img.addEventListener('load', () => {
            setTimeout(() => img.classList.add('loaded'), 30)
            setTimeout(() => img.classList.remove('fresh', 'loaded'), 1400)
          }, { once: true })
        }
        return el('figure', { class: 'reply-image' }, [
          img,
          el('figcaption', {}, [
            el('button', { type: 'button', text: t`重画`, title: t`同一段提示词再画一张，可以先选画图方式和模型`, disabled: Boolean(job), onclick: () => redraw(node, image.prompt, chat.id) }),
            el('button', { type: 'button', text: t`改提示词`, disabled: Boolean(job), onclick: () => openImageDialog(node, image.prompt, { chatId: chat.id, note: t`这张图的提示词，改完点「画」。` }) }),
            el('button', { type: 'button', text: t`删除`, onclick: () => removeImage(node, image) }),
          ]),
        ])
      }),
      job ? pendingFigure(job) : failed ? failedFigure(node, failed) : null,
    ].filter(Boolean))
  }

  const SHAPE_RATIO = { square: '1 / 1', portrait: '832 / 1216', landscape: '1216 / 832' }
  const ratioOf = () => SHAPE_RATIO[state.settings?.imageShape] ?? SHAPE_RATIO.square

  function backendName() {
    const media = state.settings
    if (!media) return ''
    const own = ownBackend(media.imageBackend)
    if (own) return `${own.name} · ${own.models.find(m => m.id === own.model)?.label ?? own.model}`
    if (media.imageBackend === 'novelai') return `NovelAI ${media.naiModel.replace(/^nai-diffusion-(\d)-(\d)-/, 'V$1.$2 ').replace(/^nai-diffusion-(\d)-/, 'V$1 ')}`
    if (media.imageBackend === 'comfy') return 'ComfyUI'
    if (media.imageBackend === 'sdwebui') return 'SD WebUI'
    if (media.imageBackend === 'gemini') return media.geminiImageModel
    return media.imageModel
  }

  const elapsed = started => t`${Math.max(0, Math.round((Date.now() - started) / 1000))} 秒`

  /** A blurred frame the size of the picture to come, with what is happening and for how long. */
  function pendingFigure(job) {
    const drawing = job.stage === 'draw'
    return el('figure', { class: `reply-image pending${drawing ? ' drawing' : ''}`, style: `--ratio: ${ratioOf()}`, 'aria-busy': 'true' }, [
      el('div', { class: 'pending-art' }, [
        el('div', { class: 'pending-mist' }),
        el('div', { class: 'pending-label', role: 'status' }, [
          el('span', { class: 'pending-dot' }),
          el('strong', { text: drawing ? t`正在画` : t`正在构思画面` }),
          el('span', { class: 'pending-meta' }, [
            drawing ? (job.backend ? `${job.backend} · ` : '') : t`写提示词 · `,
            el('span', { class: 'pending-time', 'data-started': String(job.started), text: elapsed(job.started) }),
          ]),
        ]),
      ]),
      el('figcaption', {}, [el('button', { type: 'button', text: t`取消`, onclick: () => job.controller.abort() })]),
    ])
  }

  /** Why the picture did not come, where it would have been, with the ways forward. */
  function failedFigure(node, failure) {
    const dismiss = () => {
      state.failures.delete(node.id)
      refreshNode(node.id)
    }
    const drawing = failure.stage === 'draw'
    return el('figure', { class: 'reply-image failed', role: 'alert' }, [
      el('div', { class: 'failed-art' }, [
        el('strong', { text: drawing ? t`没画出来` : t`画面提示词没写出来` }),
        el('p', { text: failure.message }),
        el('div', { class: 'failed-actions' }, [
          el('button', { type: 'button', class: 'btn small', text: t`重试`, onclick: () => (drawing ? draw(node, failure.prompt, failure.chatId) : writePrompt(node)) }),
          drawing ? el('button', { type: 'button', class: 'btn small ghost', text: t`改提示词`, onclick: () => openImageDialog(node, failure.prompt, { chatId: failure.chatId, note: t`没画出来：${failure.message}`, error: true }) }) : null,
          el('button', { type: 'button', class: 'btn small ghost', text: t`关掉`, onclick: dismiss }),
        ]),
      ]),
    ])
  }

  // One clock for every frame in the works.
  setInterval(() => {
    if (!state.jobs.size) return
    for (const span of document.querySelectorAll('.pending-time[data-started]')) span.textContent = elapsed(Number(span.dataset.started))
  }, 1000)

  function refreshNode(nodeId) {
    const chat = getChat()
    const node = chat?.path.find(n => n.id === nodeId)
    const box = article(nodeId)
    if (!node || !box) return
    box.querySelector(`[data-gallery="${CSS.escape(nodeId)}"]`)?.replaceWith(gallery(chat, node))
    box.querySelector('.msg-tools [data-media]')?.replaceWith(mediaTools(node))
  }

  function mediaTools(node) {
    return el('span', { class: 'media-tools', 'data-media': '' }, toolsFor(node))
  }

  /** Copy a node's pictures from a fresh chat view into the one on screen. */
  function adopt(view, nodeId) {
    const chat = getChat()
    if (!chat || chat.id !== view.id) return
    const fresh = view.path.find(n => n.id === nodeId)
    const local = chat.path.find(n => n.id === nodeId)
    if (local) local.media = fresh?.media
  }

  async function postJson(url, body, signal) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' },
      body: JSON.stringify(body),
      signal,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || t`请求失败（${res.status}）`)
    return data
  }

  /**
   * Run one background step for a reply; the frame and button follow it. A
   * failure stays where the picture would have been, with its reason
   * (`prompt` is what a retry draws).
   */
  async function runJob(node, chatId, stage, work, { prompt = '', reveal = false, backend = '' } = {}) {
    if (state.jobs.has(node.id)) return null
    const job = { stage, chatId, controller: new AbortController(), started: Date.now(), backend: backend || backendName() }
    state.jobs.set(node.id, job)
    state.failures.delete(node.id)
    refreshNode(node.id)
    // Bring the frame into view when it was asked for, without yanking the page otherwise.
    if (reveal) article(node.id)?.querySelector('.reply-image.pending')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    try {
      return await work(job.controller.signal)
    } catch (error) {
      if (error.name !== 'AbortError') state.failures.set(node.id, { stage, chatId, prompt, message: error.message })
      return null
    } finally {
      state.jobs.delete(node.id)
      refreshNode(node.id)
    }
  }

  /**
   * 配图: the helper writes the prompt in the background; when it is done the
   * dialog opens (after any dialog already open closes). `auto` draws at once.
   */
  async function writePrompt(node, { auto = false } = {}) {
    const chat = getChat()
    if (!chat) return
    const chatId = chat.id
    const reply = shownText(node)
    const data = await runJob(node, chatId, 'prompt', signal => postJson(`/api/chats/${chatId}/nodes/${node.id}/image-prompt`, { reply }, signal), { reveal: !auto })
    if (!data) return
    if (auto) return draw(node, data.prompt, chatId)
    const how = data.inContext ? t`${data.model} 接着对话写的${data.cache !== null ? t`（缓存命中 ${data.cache}%）` : ''}` : t`${data.model} 写的`
    whenNoDialog(() => openImageDialog(node, data.prompt, { chatId, note: t`${data.note ? `${data.note}` : ''}${how}，可以改，也可以「重写」。` }))
  }

  /** @param picked - { body, label } from pickDraw: the 画图方式 and model for this one; none = the settings'. */
  async function draw(node, prompt, chatId = getChat()?.id, picked = null) {
    if (!chatId) return
    // The picture joins the reply before the frame is taken down, so it takes the frame's place.
    const work = async signal => {
      const data = await postJson(`/api/chats/${chatId}/nodes/${node.id}/image`, { prompt, ...(picked?.body ?? {}) }, signal)
      if (data.image?.file) state.fresh.add(data.image.file)
      adopt(data.chat, node.id)
      return data
    }
    const data = await runJob(node, chatId, 'draw', work, { prompt, reveal: true, backend: picked?.label })
    if (data?.image?.note) toast(data.image.note, 12000)
  }

  /** 重画: the same prompt again, with the 画图方式 and model picked for it. */
  const redraw = guard(async (node, prompt, chatId) => {
    const picked = await pickDraw({ title: t`重画这张图`, note: t`同一段提示词再画一张。` })
    if (picked) await draw(node, prompt, chatId, picked)
  })

  /** Show `open` once no other dialog is up, so a finished prompt never covers one. */
  function whenNoDialog(open) {
    // Polled rather than waiting for `close`: that event is not always delivered (hidden windows).
    if (!document.querySelector('dialog[open]')) return open()
    setTimeout(() => whenNoDialog(open), 400)
  }

  const removeImage = guard(async (node, image) => {
    if (!confirm(t`删除这张图？`)) return
    const chat = getChat()
    adopt(await api(`/api/chats/${chat.id}/nodes/${node.id}/image?file=${encodeURIComponent(image.file)}`, { method: 'DELETE' }), node.id)
    refreshNode(node.id)
  })

  function viewImage(chat, node, image) {
    viewPicture(`/api/media/${chat.id}/${image.file}`, image.prompt, `${image.backend ?? ''} · ${new Date(image.at).toLocaleString()}`)
  }

  function viewPicture(src, caption, meta) {
    const dialog = $('image-view')
    dialog.querySelector('img').src = src
    dialog.querySelector('.image-view-prompt').textContent = caption
    dialog.querySelector('.image-view-meta').textContent = meta
    dialog.showModal()
  }

  /** The prompt is ready: draw it as is, edit it, or have it rewritten (in the background again). */
  function openImageDialog(node, prompt, { chatId, note, error = false }) {
    const dialog = $('image-dialog')
    const box = $('image-prompt')
    const drawButton = $('image-draw')
    $('image-status').textContent = note
    $('image-status').classList.toggle('error', error)
    box.value = prompt
    box.scrollTop = 0
    const pickButton = $('image-pick')
    drawButton.disabled = pickButton.disabled = !prompt.trim()
    box.oninput = () => { drawButton.disabled = pickButton.disabled = !box.value.trim() }
    drawButton.onclick = () => {
      const text = box.value.trim()
      if (!text) return
      dialog.close()
      draw(node, text, chatId)
    }
    // This one with another 画图方式 or model; the picker opens over this window.
    pickButton.onclick = guard(async () => {
      const text = box.value.trim()
      if (!text) return
      const picked = await pickDraw({ title: t`这张图用什么画` })
      if (!picked) return
      dialog.close()
      draw(node, text, chatId, picked)
    })
    // The library and the settings open on top of this window: closing them comes back here.
    $('image-library').onclick = () => openLibrary({ node, chatId })
    $('image-keep').onclick = guard(async () => {
      const text = box.value.trim()
      if (!text) return
      await api('/api/prompts', { method: 'POST', body: { cardId: getChat()?.cardId, prompt: text } })
      toast(t`已存进提示词库（收藏在最前面）`)
    })
    $('image-rewrite').onclick = () => {
      dialog.close()
      writePrompt(node)
    }
    $('image-settings').onclick = () => openSettings('image')
    if (!dialog.open) dialog.showModal()
  }

  // ─── Prompt library (server/prompts.mjs) ──────────────────────────────
  // Every drawn picture leaves its prompt here; pick one to draw on another
  // reply (it opens in the 配图 dialog first, to edit), star, delete, export.

  const library = { entries: [], scope: 'card', target: null }

  const openLibrary = guard(async (target = null) => {
    library.target = target?.node ? target : null
    if (!getChat()) return
    library.entries = await api('/api/prompts')
    $('library-note').textContent = library.target
      ? t`选一条给这段剧情配图：会先放进配图框，可以改了再画。`
      : t`画过的图都会把提示词留在这里，删了对话也还在。`
    $('library-query').value = ''
    renderLibrary()
    $('library-dialog').showModal()
    $('library-query').focus()
  })

  function libraryShown() {
    const cardId = getChat()?.cardId
    const terms = $('library-query').value.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return library.entries.filter(entry => {
      if (library.scope === 'card' && entry.cardId !== cardId) return false
      const hay = `${entry.title} ${entry.prompt} ${entry.chatTitle} ${entry.cardName}`.toLowerCase()
      return terms.every(term => hay.includes(term))
    })
  }

  function renderLibrary() {
    const shown = libraryShown()
    const total = library.entries.filter(e => library.scope === 'all' || e.cardId === getChat()?.cardId).length
    $('library-count').textContent = shown.length === total ? t`${total} 条` : t`${shown.length} / ${total} 条`
    for (const b of document.querySelectorAll('#library-dialog .seg button')) b.setAttribute('aria-pressed', String(b.dataset.scope === library.scope))
    const list = $('library-list')
    if (!shown.length) {
      list.replaceChildren(el('li', { class: 'library-empty', text: total ? t`没有找到，换个词试试` : t`还没有提示词。给剧情配过图之后，提示词会自动留在这里。` }))
      return
    }
    list.replaceChildren(...shown.map(entry => libraryRow(entry)))
  }

  function libraryRow(entry) {
    const when = entry.at ? new Date(entry.at).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) : ''
    const meta = [
      library.scope === 'all' ? entry.cardName : '',
      entry.chatTitle,
      when,
      entry.drawn > 1 ? t`画过 ${entry.drawn} 次` : entry.drawn === 0 ? t`手动存的` : '',
    ].filter(Boolean)
    const text = el('p', { class: 'library-prompt', text: entry.prompt, title: t`点开看全文` })
    text.addEventListener('click', () => text.classList.toggle('open'))
    const star = el('button', {
      type: 'button',
      class: `library-star${entry.starred ? ' on' : ''}`,
      'aria-pressed': String(entry.starred),
      'aria-label': t`收藏`,
      title: entry.starred ? t`取消收藏` : t`收藏（排在最前面）`,
      text: entry.starred ? '★' : '☆',
      onclick: guard(async () => {
        Object.assign(entry, await api(`/api/prompts/${entry.id}`, { method: 'PUT', body: { starred: !entry.starred } }))
        renderLibrary()
      }),
    })
    return el('li', { class: 'library-row' }, [
      entry.hasImage
        ? el('img', { class: 'library-thumb', src: `/api/prompts/${entry.id}/image`, alt: '', loading: 'lazy', decoding: 'async' })
        : el('span', { class: 'library-thumb none', 'aria-hidden': 'true', text: t`无图` }),
      el('div', { class: 'library-main' }, [
        text,
        el('p', { class: 'library-meta', text: meta.join(t`　`) }),
      ]),
      el('div', { class: 'library-actions' }, [
        star,
        library.target
          ? el('button', { type: 'button', class: 'btn small primary', text: t`用这条`, onclick: () => useEntry(entry) })
          : el('button', { type: 'button', class: 'btn small', text: t`复制`, onclick: () => copyEntry(entry) }),
        el('button', {
          type: 'button',
          class: 'btn small ghost danger',
          text: t`删除`,
          title: t`从提示词库删掉（对话里的图不受影响）`,
          onclick: guard(async () => {
            if (!confirm(t`从提示词库删掉这条？对话里的图不受影响。`)) return
            await api(`/api/prompts/${entry.id}`, { method: 'DELETE' })
            library.entries = library.entries.filter(e => e.id !== entry.id)
            renderLibrary()
          }),
        }),
      ]),
    ])
  }

  function useEntry(entry) {
    const { node, chatId } = library.target
    $('library-dialog').close()
    openImageDialog(node, entry.prompt, { chatId, note: t`来自提示词库${entry.chatTitle ? t`（${entry.chatTitle}）` : ''}，可以改了再画。` })
  }

  async function copyEntry(entry) {
    try {
      await navigator.clipboard.writeText(entry.prompt)
      toast(t`已复制`)
    } catch {
      toast(t`复制不了，点开全文手动选中复制`)
    }
  }

  $('library-query').addEventListener('input', renderLibrary)
  $('library-dialog').querySelector('.seg').addEventListener('click', event => {
    const button = event.target.closest('button[data-scope]')
    if (!button) return
    library.scope = button.dataset.scope
    renderLibrary()
  })
  $('library-export').addEventListener('click', () => {
    const shown = libraryShown()
    if (!shown.length) return toast(t`没有可导出的提示词`)
    const text = shown.map(e => `## ${e.title || e.chatTitle || e.cardName}${e.at ? t`（${new Date(e.at).toLocaleString(locale)}）` : ''}\n${e.prompt}`).join('\n\n')
    const name = library.scope === 'card' ? shown[0].cardName : t`全部`
    saveFile(t`提示词库-${name}.txt`, `${text}\n`, t`导出了 ${shown.length} 条`)
  })

  // ─── Voice ────────────────────────────────────────────────────────────

  /** Read in the page: a browser voice, or no voice on a tavern without a voice service. */
  const spokenHere = chunk => Boolean(chunk?.voice?.startsWith(BROWSER) || (chunk && !chunk.voice && !state.settings?.ttsUrl))

  /** Characters per chunk for a voice: as its source says (the voice service may say per voice), else by its prefix. */
  function chunkMaxFor(value) {
    const voice = String(value ?? '')
    if (spokenHere({ voice })) return CHUNK_MAX.browser
    const [external, ...own] = state.voiceInfo?.sources ?? []
    // The voice service's names win, as on the server.
    const listed = external?.cloud?.find(v => v.name === voice)?.chunkMax ?? (external?.voices?.includes(voice) ? external.chunkMax : null)
    if (listed) return listed
    const source = own.find(s => s.voices?.some(v => v.ref === voice))
    if (source) return source.chunkMax
    const prefix = voice.includes(':') ? voice.slice(0, voice.indexOf(':')) : 'bridge'
    return CHUNK_MAX[prefix] ?? CHUNK_MAX.bridge
  }

  const player = {
    nodeId: null,
    queue: [],
    index: 0,
    audio: null,
    utterance: null, // the browser voice's current block
    mode: null, // 'audio' (from the server) or 'browser' for the current block
    controller: null,
    paused: false,
    fetched: new Map(), // index → Promise<objectURL>
    line: null, // the dialogue span being read on its own
    fresh: false, // skip the server's cached audio (after 重新合成)
    onDone: null, // called once the whole queue has been read (not when stopped or replaced)

    start(nodeId, queue, line = null, onDone = null) {
      this.stop()
      this.nodeId = nodeId
      this.onDone = onDone
      this.line = line
      this.fresh = false
      line?.classList.add('reading')
      this.queue = queue
      this.index = 0
      this.paused = false
      this.controller = new AbortController()
      article(nodeId)?.classList.add('speaking')
      refreshNode(nodeId)
      this.play()
    },

    fetchChunk(i) {
      if (!this.fetched.has(i)) {
        const chunk = this.queue[i]
        const promise = fetch('/api/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' },
          body: JSON.stringify({ text: chunk.text, voice: chunk.voice, stable: chunk.stable, fresh: this.fresh }),
          signal: this.controller.signal,
        }).then(async res => {
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t`朗读失败（${res.status}）`)
          return URL.createObjectURL(await res.blob())
        })
        promise.catch(() => {})
        this.fetched.set(i, promise)
      }
      return this.fetched.get(i)
    },

    async play() {
      const i = this.index
      if (i >= this.queue.length) {
        const done = this.onDone
        this.onDone = null
        this.stop()
        return done?.()
      }
      const signal = this.controller.signal
      if (spokenHere(this.queue[i])) return this.speakHere(i, signal)
      this.mode = 'audio'
      this.render(true)
      let url
      try {
        url = await this.fetchChunk(i)
      } catch (error) {
        if (error.name !== 'AbortError' && !signal.aborted) toast(error.message, 8000)
        return this.stop()
      }
      if (signal.aborted || i !== this.index) return
      // Synthesise the next block while this one plays.
      if (i + 1 < this.queue.length && !spokenHere(this.queue[i + 1])) this.fetchChunk(i + 1)
      this.audio = new Audio(url)
      this.audio.onended = () => {
        URL.revokeObjectURL(url)
        this.fetched.delete(i)
        if (signal.aborted) return
        this.index += 1
        this.play()
      }
      this.render(false)
      if (!this.paused) this.audio.play().catch(error => {
        toast(t`浏览器没让播放：${error.message}`)
        this.stop()
      })
    },

    /** One block in a browser voice; the next one starts when it ends. */
    speakHere(i, signal) {
      this.mode = 'browser'
      if (!speech) {
        toast(t`这个浏览器不能朗读：换 Edge 或 Chrome 打开，或者在「配图与朗读 → 朗读来源」里设一个本地语音桥接或云端服务`, 8000)
        return this.stop()
      }
      const chunk = this.queue[i]
      // Bracketed delivery tags are for voices that act on them; a browser would read them out.
      const utterance = new SpeechSynthesisUtterance(chunk.text.replace(DELIVERY_TAG, ''))
      const voice = browserVoice(chunk.voice)
      utterance.lang = voice?.lang ?? 'zh-CN'
      if (voice) utterance.voice = voice
      utterance.onend = () => {
        // A paused, stopped or replaced block ends too: only the current one moves on.
        if (this.utterance !== utterance) return
        this.utterance = null
        if (signal.aborted) return
        this.index += 1
        this.play()
      }
      utterance.onerror = event => {
        if (this.utterance !== utterance || event.error === 'interrupted' || event.error === 'canceled') return
        toast(t`浏览器朗读出错：${event.error}`)
        this.stop()
      }
      this.utterance = utterance
      this.render(false)
      if (!this.paused) speech.speak(utterance)
    },

    /** Synthesise the current block again (and the rest of this reading), replacing the cached takes. */
    redo() {
      if (!this.nodeId) return
      if (this.mode === 'browser') {
        this.utterance = null
        speech?.cancel()
      }
      this.controller.abort()
      this.audio?.pause()
      this.audio = null
      for (const promise of this.fetched.values()) promise.then(url => URL.revokeObjectURL(url), () => {})
      this.fetched.clear()
      this.controller = new AbortController()
      this.fresh = true
      this.paused = false
      this.play()
    },

    toggle() {
      if (this.mode === 'browser') {
        // Pausing speech mid-sentence is unreliable across browsers: stop, and resume from the block's start.
        this.paused = !this.paused
        if (this.paused) {
          this.utterance = null
          speech?.cancel()
        } else this.play()
        return this.render(false)
      }
      if (!this.audio) return
      this.paused = !this.paused
      if (this.paused) this.audio.pause()
      else this.audio.play().catch(() => {})
      this.render(false)
    },

    stop() {
      this.onDone = null
      this.controller?.abort()
      this.audio?.pause()
      if (this.mode === 'browser') {
        this.utterance = null
        speech?.cancel()
      }
      this.mode = null
      for (const promise of this.fetched.values()) promise.then(url => URL.revokeObjectURL(url), () => {})
      this.fetched.clear()
      const was = this.nodeId
      this.line?.classList.remove('reading')
      this.line = null
      this.audio = null
      this.nodeId = null
      this.queue = []
      if (was) {
        article(was)?.classList.remove('speaking')
        refreshNode(was)
      }
      this.render(false)
    },

    render(loading) {
      const bar = $('player')
      // The visual novel mode shows its own small sign for the line being read.
      const announce = state => document.dispatchEvent(new CustomEvent('cicatavern:reading', { detail: { state, nodeId: this.nodeId } }))
      if (!this.nodeId) {
        bar.hidden = true
        bar.dataset.state = ''
        return announce('')
      }
      bar.hidden = false
      bar.dataset.state = loading ? 'loading' : this.paused ? 'paused' : 'playing'
      announce(bar.dataset.state)
      const chunk = this.queue[this.index]
      $('player-toggle').textContent = this.paused ? '▶' : '❚❚'
      $('player-toggle').title = this.paused ? t`继续` : t`暂停`
      $('player-toggle').disabled = loading
      $('player-redo').disabled = loading
      $('player-count').textContent = `${Math.min(this.index + 1, this.queue.length)}/${this.queue.length}`
      $('player-text').textContent = loading ? t`合成中…` : chunk ? t`${chunk.kind === 'dialogue' ? t`对白` : t`旁白`}：${chunk.text}` : ''
    },
  }

  // ─── Who speaks: a cast member's lines in their own voice ───────────────
  // The speaker of a line is the visual novel mode's guess (web/shared/vn.js);
  // one it cannot tell, or nobody in the cast, takes the card's dialogue voice.

  const cast = () => state.cardMedia?.roster ?? []
  /** Anyone in the cast with a voice of their own: only then are speakers told apart. */
  const castVoiced = () => cast().some(entry => entry.voice)

  function castNames() {
    const chat = getChat()
    return speakerNames({ char: chat?.names?.char, user: chat?.names?.user, roster: cast() })
  }

  /** A speaker's voice: their cast entry's own, else the card's dialogue voice. */
  function voiceOf(speaker, names = castNames()) {
    const id = speaker ? names.find(entry => entry.name === speaker)?.id : null
    return (id && cast().find(entry => entry.id === id)?.voice) || state.cardMedia?.voice || ''
  }

  /** Characters per dialogue chunk: the shortest any voice in use takes. */
  const dialogueMax = () => Math.min(chunkMaxFor(state.cardMedia?.voice), ...cast().filter(entry => entry.voice).map(entry => chunkMaxFor(entry.voice)))

  /**
   * (quote text) → who says it, for a reply's quotes in reading order: found in
   * the beats the visual novel mode cuts the same text into.
   */
  function quoteSpeakers(text, names) {
    const key = s => String(s ?? '').replace(/[\s“”「」『』"]/g, '')
    const beats = splitLines(String(text ?? '').replace(/\[voice:[^\]\n]*\]/gi, ''), { names }).map(beat => ({ plain: key(beat.plain), speaker: beat.speaker }))
    let at = 0
    return quote => {
      const want = key(quote).slice(0, 12)
      if (!want) return null
      const found = beats.findIndex((beat, i) => i >= at && beat.plain.includes(want))
      if (found < 0) return null
      at = found
      return beats[found].speaker
    }
  }

  function readNode(node) {
    const { narratorVoice } = state.cardMedia
    const text = shownText(node)
    const names = castNames()
    const speakerOf = castVoiced() ? quoteSpeakers(text, names) : null
    // Emotions go before their lines as [tags]; the server keeps them only for voices that act on them (Fish).
    const chunks = speechChunks(text, { narration: Boolean(narratorVoice), tags: true, speakerOf, max: { dialogue: dialogueMax(), narration: chunkMaxFor(narratorVoice) } })
    if (!chunks.length) return toast(t`这一段没有能读的文字`)
    if (!narratorVoice && !state.warnedNarrator) {
      state.warnedNarrator = true
      toast(t`旁白还没选音色，这次只读对白。在「配图与朗读」里给这张卡选旁白音色。`, 6000)
    }
    player.start(node.id, chunks.map(chunk => ({
      ...chunk,
      voice: chunk.kind === 'dialogue' ? voiceOf(chunk.speaker, names) : narratorVoice,
      // Narration is long and even: the bridge's steady mode keeps one voice across blocks.
      stable: chunk.kind === 'narration',
    })))
  }

  /**
   * One line of the visual novel's text box (web/vn.js), read as it shows: the
   * quotes in the speaker's voice, the rest in the narrator's. done() once it
   * has been read; a line with nothing to read is done at once.
   * @param speaker - who says it, as the text box's name plate has it.
   */
  function readBeat(nodeId, text, done, speaker = null) {
    const { narratorVoice } = state.cardMedia ?? {}
    const plain = String(text ?? '').replace(/<[^<>]*>/g, '')
    const voice = voiceOf(speaker)
    const chunks = speechChunks(plain, { narration: Boolean(narratorVoice), tags: true, max: { dialogue: chunkMaxFor(voice), narration: chunkMaxFor(narratorVoice) } })
    if (!chunks.length) return done?.()
    player.start(nodeId, chunks.map(chunk => ({
      ...chunk,
      voice: chunk.kind === 'dialogue' ? voice : narratorVoice,
      stable: chunk.kind === 'narration',
    })), null, done)
  }

  /** One line of dialogue, clicked in the reply: read on its own in its speaker's voice. */
  function readLine(span) {
    const nodeId = span.closest('.msg[data-id]')?.dataset.id
    if (!nodeId) return
    if (player.line === span) return player.stop()
    const node = getChat()?.path.find(n => n.id === nodeId)
    const names = castNames()
    const voice = castVoiced() && node ? voiceOf(quoteSpeakers(shownText(node), names)(span.innerText), names) : state.cardMedia.voice
    const chunks = speechChunks(span.innerText + voiceTagFor(span), { narration: false, tags: true, max: chunkMaxFor(voice) })
    if (!chunks.length) return toast(t`这句没有能读的文字`)
    player.start(nodeId, chunks.map(chunk => ({ ...chunk, voice, stable: false })), span)
  }

  document.addEventListener('click', event => {
    const span = event.target.closest?.('#transcript .msg[data-id] .story .q')
    // Selecting text or picking an option is not a request to hear it.
    if (!span || span.closest('.choice') || String(getSelection?.() ?? '').trim()) return
    readLine(span)
  })

  /**
   * After a new reply: read it and/or draw it, if switched on.
   * @param override - { read, image } in place of the settings (the visual novel mode keeps its own).
   */
  async function afterTurn(nodeId, override = null) {
    const node = getChat()?.path.find(n => n.id === nodeId)
    if (!node || !state.settings) return
    if (override ? override.read : state.settings.autoRead) readNode(node)
    if (override ? override.image : state.settings.autoImage) writePrompt(node, { auto: true })
  }

  /** 新回复自动朗读 / 自动配图 as set, or null before the settings load. */
  const flags = () => (state.settings ? { read: Boolean(state.settings.autoRead), image: Boolean(state.settings.autoImage) } : null)

  // ─── Settings ─────────────────────────────────────────────────────────

  /**
   * @param section - open straight into one part ('image', 'voice', 'card',
   *   'roster'); without it a fresh opening shows the menu, and a re-render
   *   (after 保存) stays where it was.
   */
  const openSettings = guard(async section => {
    if (!$('media-dialog').open || typeof section === 'string') settingsMenu.start(typeof section === 'string' ? section : null)
    const [{ media, workflow, novelai, voiceKey, voiceKeys, ownBackends = [] }, providers, voiceInfo, loraInfo, browserVoices] = await Promise.all([
      api('/api/media/settings'),
      api('/api/providers'),
      api('/api/media/voices'),
      api('/api/media/loras'),
      loadBrowserVoices(),
    ])
    state.settings = media
    state.ownBackends = ownBackends
    state.voiceInfo = voiceInfo
    const card = state.cardId ? await api(`/api/cards/${state.cardId}/media`) : null
    renderSettings({ media, workflow, novelai, voiceKey, voiceKeys, providers: providers.providers, voiceInfo, loraInfo, card, browserVoices })
    if (!$('media-dialog').open) $('media-dialog').showModal()
  })

  function renderSettings({ media, workflow, novelai, voiceKey, voiceKeys, providers, voiceInfo, loraInfo, card, browserVoices = [] }) {
    const form = $('media-form')
    const option = (value, text, selected) => el('option', { value, text, selected: value === selected })
    const field = (label, control, hint) => el('label', {}, [label, control, hint ? el('span', { class: 'hint', text: hint }) : null])

    // Pictures
    const backend = el('select', { name: 'imageBackend' }, [...imageBackends(), ...state.ownBackends.map(own => [own.id, own.name])].map(([value, text]) => option(value, text, media.imageBackend)))
    const imageProviders = providers.filter(p => p.api !== 'anthropic-messages')
    const provider = el('select', { name: 'imageProvider' }, [option('', imageProviders.length ? t`选一个供应商` : t`先在「供应商」里添加`, media.imageProvider), ...imageProviders.map(p => option(p.id, p.name, media.imageProvider))])
    const modelList = el('datalist', { id: 'image-models' })
    const model = el('input', { name: 'imageModel', value: media.imageModel, list: 'image-models', placeholder: t`例如 grok-imagine-image-2.0`, spellcheck: 'false' })
    const fetchModels = el('button', { type: 'button', class: 'btn small', text: t`获取` })
    fetchModels.onclick = guard(async () => {
      if (!provider.value) throw new Error(t`先选供应商`)
      const { models } = await api('/api/providers/models', { method: 'POST', body: { id: provider.value } })
      const images = models.filter(id => IMAGE_MODEL.test(id))
      modelList.replaceChildren(...(images.length ? images : models).map(id => el('option', { value: id })))
      toast(images.length ? t`找到 ${images.length} 个生图模型，点输入框选` : t`没认出生图模型，列出了全部 ${models.length} 个`)
      model.focus()
    })
    const size = el('select', { name: 'imageShape' }, SHAPES.map(([value, text]) => option(value, text, media.imageShape)))
    const reference = el('input', { type: 'checkbox', name: 'imageReference', checked: media.imageReference })
    const editModel = el('input', { name: 'imageEditModel', value: media.imageEditModel, list: 'image-models', placeholder: t`同上（和生图模型一样）`, spellcheck: 'false' })
    const comfyUrl = el('input', { name: 'comfyUrl', value: media.comfyUrl, spellcheck: 'false' })
    const workflowInfo = el('span', { class: 'hint', text: workflowText(workflow), 'data-imported': workflow ? '1' : undefined })
    const workflowInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true })
    workflowInput.onchange = guard(async () => {
      const file = workflowInput.files[0]
      workflowInput.value = ''
      if (!file) return
      let json
      try {
        json = JSON.parse(await file.text())
      } catch {
        throw new Error(t`工作流文件不是 JSON`)
      }
      const { workflow: info } = await api('/api/media/workflow', { method: 'PUT', body: { workflow: json } })
      workflowInfo.textContent = workflowText(info)
      workflowInfo.dataset.imported = info ? '1' : ''
      toast(t`工作流已导入`)
    })
    const helperChoices = getModels().filter(m => m.id.includes('/'))
    const helper = el('select', { name: 'helperModel' }, [
      option('', t`跟随对话的模型（要是供应商的模型）`, media.helperModel),
      ...helperChoices.map(m => option(m.id, `${m.group} · ${m.label}`, media.helperModel)),
    ])
    const promptSource = el('select', { name: 'promptSource' }, [
      option('helper', t`辅助模型单独写（快、便宜）`, media.promptSource),
      option('chat', t`接着对话写（同一个模型，命中缓存，更贴合剧情）`, media.promptSource),
    ])
    const promptStyle = el('select', { name: 'promptStyle' }, [option('natural', t`自然语言（grok、gpt-image、Flux、NovelAI V5）`, media.promptStyle), option('tags', t`标签（SD / SDXL 工作流、NovelAI）`, media.promptStyle)])
    const autoImage = el('input', { type: 'checkbox', name: 'autoImage', checked: media.autoImage })

    const openaiBox = el('div', { class: 'grid' }, [
      field(t`供应商`, provider),
      el('label', {}, [t`生图模型`, el('span', { class: 'select-with-action' }, [model, fetchModels]), modelList]),
    ])
    const comfyBox = el('div', {}, [
      field(t`ComfyUI 地址`, comfyUrl),
      el('div', { class: 'workflow-row' }, [
        el('button', { type: 'button', class: 'btn small', text: t`导入工作流`, onclick: () => workflowInput.click() }),
        workflowInput,
        workflowInfo,
      ]),
      el('p', { class: 'hint', text: t`在 ComfyUI 里把正向提示词写成 {{prompt}}，种子、宽、高写成 {{seed}} {{width}} {{height}}，要参考图就在 LoadImage 里写 {{reference}}（会上传这张卡的头像），然后「导出（API）」。` }),
    ])
    const naiTokenHint = el('span', { class: 'hint nai-token-hint' })
    const showNaiToken = info => naiTokenText(naiTokenHint, info)
    showNaiToken(novelai)
    const naiToken = el('input', { name: 'naiToken', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: novelai?.hasToken ? t`留空不改` : 'pst-…' })
    const checkNai = el('button', { type: 'button', class: 'btn small', text: t`检查` })
    const naiAllowance = el('span', { class: 'hint nai-allowance' })
    const showAllowance = info => {
      const text = naiAccountText(info)
      naiAllowance.textContent = text
      naiAllowance.classList.toggle('warn', Boolean(info?.v5 && (info.v5.empty || info.v5.percent <= 10)))
      return text
    }
    checkNai.onclick = guard(async () => {
      const info = await api('/api/media/novelai/check', { method: 'POST', body: { token: naiToken.value.trim() } })
      toast(showAllowance(info), 8000)
    })
    // The V5 allowance changes by the hour: read it whenever this section is shown.
    let allowanceRead = false
    const readAllowance = () => {
      if (allowanceRead || !novelai?.hasToken || naiBox.hidden) return
      allowanceRead = true
      naiAllowance.textContent = t`正在查 V5 额度…`
      api('/api/media/novelai/check', { method: 'POST', body: { token: '' } }).then(showAllowance, error => { naiAllowance.textContent = t`查不到额度：${error.message}` })
    }
    const clearNai = el('button', { type: 'button', class: 'btn small ghost', text: t`删除令牌` })
    clearNai.onclick = guard(async () => {
      const { novelai: info } = await api('/api/media/settings', { method: 'PUT', body: { naiClearToken: true } })
      showNaiToken(info)
      toast(t`已删除 NovelAI 令牌`)
    })
    const naiModel = el('select', { name: 'naiModel' }, [
      ...NAI_MODELS.map(([value, text]) => option(value, text, media.naiModel)),
      NAI_MODELS.some(([value]) => value === media.naiModel) ? null : option(media.naiModel, media.naiModel, media.naiModel),
    ].filter(Boolean))
    const naiBox = el('div', {}, [
      el('label', {}, [t`NovelAI 持久令牌`, el('span', { class: 'select-with-action' }, [naiToken, checkNai, clearNai]), naiTokenHint]),
      el('p', { class: 'hint', text: t`在 NovelAI 网页点左下角齿轮 →「Account」→「Get Persistent API Token」，复制后粘贴到这里再保存。「检查」只查订阅、V5 额度和 Anlas，不画图。` }),
      el('label', {}, [t`模型`, naiModel, naiAllowance]),
      field(t`V5 额度用完时`, el('select', { name: 'naiV5Empty' }, [
        option('v45', t`改用 V4.5 画（Opus 不扣 Anlas）`, media.naiV5Empty ?? 'v45'),
        option('anlas', t`继续用 V5，扣 Anlas`, media.naiV5Empty ?? 'v45'),
      ]), t`Opus 的 V5 有一份额度，每小时回一点，用完后 NovelAI 改扣 Anlas。每次画 V5 前先查一下：剩 10% 以下时图下面会提醒，用完时按这里处理。`),
      el('label', { class: 'check-row' }, [
        el('input', { type: 'checkbox', name: 'naiReference', checked: media.naiReference }),
        el('span', { text: t`画面里只有一个名册角色（或者除了主角只有一个）、而且她有人设图时，照人设图画（自动改用 V4.5，每张多扣 5 Anlas，不够时这张不带；V5 还不支持人设图）` }),
      ]),
      el('div', { class: 'grid' }, [
        field(t`人设图还原度`, el('input', { name: 'naiRefFidelity', type: 'range', min: '0', max: '1', step: '0.05', value: String(media.naiRefFidelity) }), t`越高越像人设图，越低越听提示词`),
        el('label', { class: 'check-row' }, [el('input', { type: 'checkbox', name: 'naiRefStyle', checked: media.naiRefStyle }), el('span', { text: t`连画风一起参考` })]),
      ]),
      field(t`质量词（加在每张提示词后面）`, el('input', { name: 'naiQuality', value: media.naiQuality, spellcheck: 'false' })),
      field(t`负面提示词`, el('textarea', { name: 'naiNegative', rows: 3, spellcheck: 'false', text: media.naiNegative })),
      el('p', { class: 'hint', text: t`尺寸和步数都在 Opus 的免费范围内（不超过 1024×1024 像素、23 步）：V4.5 不限量，V5 用上面那份额度，都不扣 Anlas。走「设置」里的代理。` }),
    ])
    // Gemini's own image models: a provider with Google's key, the first such one until another is picked.
    const googleProviders = imageProviders.filter(isGoogle)
    const geminiPick = media.geminiImageProvider || googleProviders[0]?.id || ''
    const geminiProvider = el('select', { name: 'geminiImageProvider' }, [
      option('', imageProviders.length ? t`选一个供应商` : t`先在「供应商」里添加`, geminiPick),
      ...[...googleProviders, ...imageProviders.filter(p => !isGoogle(p))].map(p => option(p.id, p.name, geminiPick)),
    ])
    const geminiModels = el('datalist', { id: 'gemini-image-models' }, GEMINI_IMAGE_MODELS.map(id => el('option', { value: id })))
    const geminiModel = el('input', { name: 'geminiImageModel', value: media.geminiImageModel, list: 'gemini-image-models', spellcheck: 'false' })
    const fetchGemini = el('button', { type: 'button', class: 'btn small', text: t`获取` })
    fetchGemini.onclick = guard(async () => {
      if (!geminiProvider.value) throw new Error(t`先选供应商`)
      const { models } = await api('/api/providers/models', { method: 'POST', body: { id: geminiProvider.value } })
      const images = models.filter(id => /image/i.test(id) && !/imagen/i.test(id))
      geminiModels.replaceChildren(...(images.length ? images : GEMINI_IMAGE_MODELS).map(id => el('option', { value: id })))
      toast(images.length ? t`找到 ${images.length} 个生图模型，点输入框选` : t`这个供应商没列出 Gemini 生图模型，列的是常用的`)
      geminiModel.focus()
    })
    const geminiBox = el('div', {}, [
      el('div', { class: 'grid' }, [
        field(t`供应商`, geminiProvider, googleProviders.length ? '' : t`先用「Gemini」模板建一个供应商（密钥在 aistudio.google.com 创建）`),
        el('label', {}, [t`生图模型`, el('span', { class: 'select-with-action' }, [geminiModel, fetchGemini]), geminiModels]),
      ]),
      el('label', { class: 'check-row' }, [
        el('input', { type: 'checkbox', name: 'geminiReference', checked: media.geminiReference }),
        el('span', { text: t`画面里的名册角色有人设图时，一起发过去照着画（最多三个人，长相更稳）` }),
      ]),
      el('p', { class: 'hint', text: t`走 Google 自己的接口，和对话共用「Gemini」供应商的密钥和代理。gemini-2.5-flash-image 快、便宜；gemini-3-pro-image-preview 画得更细。提示词写法选「自然语言」。` }),
    ])
    // Stable Diffusion WebUI / Forge: the model loaded there draws.
    const sdSamplers = el('datalist', { id: 'sd-samplers' }, SD_SAMPLERS.map(id => el('option', { value: id })))
    const sdBox = el('div', {}, [
      field(t`WebUI 地址`, el('input', { name: 'sdUrl', value: media.sdUrl, spellcheck: 'false' }), t`AUTOMATIC1111、Forge、reForge 都行，启动参数要加 --api。用 WebUI 里当前加载的模型画。`),
      el('div', { class: 'grid three' }, [
        el('label', {}, [t`采样器`, el('input', { name: 'sdSampler', value: media.sdSampler, list: 'sd-samplers', spellcheck: 'false' }), sdSamplers]),
        field(t`步数`, el('input', { name: 'sdSteps', type: 'number', min: '1', max: '80', step: '1', value: String(media.sdSteps) })),
        field('CFG', el('input', { name: 'sdCfg', type: 'number', min: '1', max: '20', step: '0.5', value: String(media.sdCfg) })),
      ]),
      field(t`负面提示词`, el('textarea', { name: 'sdNegative', rows: 2, spellcheck: 'false', text: media.sdNegative })),
      el('p', { class: 'hint', text: t`名册角色或这张卡设了 LoRA 时，写成 <lora:文件名:强度> 加进提示词（文件要在 WebUI 的 Lora 文件夹里）。提示词写法选「标签」。` }),
    ])
    // This install's own backends: the model to draw with, and what the server says about them.
    const ownBoxes = state.ownBackends.map(own => el('div', { 'data-own': own.id }, [
      own.models.length ? field(t`模型`, el('select', { name: `localModel:${own.id}` }, own.models.map(m => option(m.id, m.label, own.model)))) : null,
      own.ready ? null : el('p', { class: 'hint warn', text: own.need }),
      own.hint ? el('p', { class: 'hint', text: own.hint }) : null,
    ].filter(Boolean)))
    const syncBackend = () => {
      for (const box of ownBoxes) box.hidden = backend.value !== box.dataset.own
      openaiBox.hidden = backend.value !== 'openai'
      referenceRow.hidden = backend.value !== 'openai'
      geminiBox.hidden = backend.value !== 'gemini'
      comfyBox.hidden = backend.value !== 'comfy'
      sdBox.hidden = backend.value !== 'sdwebui'
      naiBox.hidden = backend.value !== 'novelai'
      readAllowance()
    }
    /** What keeps pictures from being drawn as the form stands, or ''. */
    const imageNeed = () => {
      if (backend.value === 'openai' && !provider.value) return t`没选供应商`
      if (backend.value === 'openai' && !model.value.trim()) return t`没填生图模型`
      if (backend.value === 'gemini' && !geminiProvider.value) return t`没选供应商`
      if (backend.value === 'novelai' && !novelai?.hasToken && !naiToken.value.trim()) return t`没填令牌`
      if (backend.value === 'comfy' && !workflowInfo.dataset.imported) return t`没导入工作流`
      const own = ownBackend(backend.value)
      if (own && !own.ready) return own.need
      return ''
    }
    backend.onchange = syncBackend
    const referenceRow = el('div', {}, [
      el('label', { class: 'check-row' }, [reference, el('span', { text: t`用这张卡的头像当参考图（走 /images/edits，长相更稳定）` })]),
      field(t`参考图用的模型`, editModel, t`有的网关生图和改图是两个模型：grok2api 只有 Web 账号时，2.0 只能生图，改图要用 grok-imagine-image-edit。改图失败时这张会自动不带参考图再画。`),
    ])
    const syncReference = () => { editModel.closest('label').hidden = !reference.checked }
    reference.onchange = syncReference

    // Voice. Three kinds of source, kept apart in every label: the browser's own
    // voices (this device, free), a local voice bridge (TTS models on this
    // machine or the LAN, such as 小雅, or the tavern on a PC), and cloud
    // services (keys, billed per character).
    // Only this machine's own install assumes the xiaoya bridge; elsewhere the browser reads unless a source is set up.
    const xiaoya = document.documentElement.dataset.featureXiaoya !== 'false'
    const choices = voiceChoices({ voiceInfo, browserVoices, media, providers })
    const { sources, external, service, voices, cloud, chinese, groups, known, dialogueDefault } = choices
    const ttsUrl = el('input', { name: 'ttsUrl', value: media.ttsUrl, spellcheck: 'false', placeholder: xiaoya ? '' : t`不用就留空` })
    const ttsStatus = el('span', {
      class: external.ok ? 'hint' : 'hint warn',
      hidden: !service,
      text: external.ok ? t`已连上${external.remote ? t`（经电脑上的酒馆）` : ''}，${voices.length + (external.cloud?.length ?? 0)} 个音色` : external.error,
    })
    const ttsKeyHint = el('span', { class: 'hint tts-key-hint' })
    voiceKeyText(ttsKeyHint, voiceKey)
    const autoRead = el('input', { type: 'checkbox', name: 'autoRead', checked: media.autoRead })
    const voicePicker = (name, value, empty) => voicePickerFrom(choices, { name, value, empty, form, silent: name === 'narratorVoice' })
    const anyCloud = cloud.length || VOICE_SOURCES.some(id => sources[id]?.voices?.length)
    const narratorHint = anyCloud
      ? xiaoya && cloud.length
        ? t`经小雅转发的云端音色用小雅「云端 API 设置」里的密钥和模型。云端音色都按字数计费，旁白字多，用本地模型或浏览器音色更省`
        : t`云端音色按字数计费；旁白字多，用本地模型或浏览器音色更省`
      : chinese.length ? t`浏览器音色是这台设备自带的，免费；换一台设备可能没有同一个，会改用它的默认中文音色。` : undefined
    const tagHint = cloud.some(v => v.tags) || sources.fish?.voices?.length || sources.openai?.emotion === 'instruction'
      ? t`回复里 [voice:情绪:台词] 的情绪：Fish 放在台词前当语气标签，gpt-4o-mini-tts 当语气说明，其余音色不读`
      : undefined
    const ttsHint = xiaoya
      ? t`本机填小雅的地址（http://127.0.0.1:8765），用它跑的本地 TTS 模型，或它转发的云端音色。手机上没有小雅：把电脑上酒馆「设置 → 手机访问」里的链接整条粘贴进来，同一个 Wi-Fi 下借电脑朗读（电脑上的云端密钥留在电脑上）。`
      : t`本机或局域网里跑 TTS 模型的服务（兼容 POST /api/tts 和 GET /api/persona/list）。也可以把另一台电脑上酒馆「设置 → 手机访问」里的链接整条粘贴进来，借那台电脑设好的音色（密钥留在那台电脑上）。`
    const sourceBoxes = voiceSourceBoxes({ media, voiceKeys, providers, sources, form })
    const externalBox = el('details', { class: 'voice-source', open: xiaoya || service }, [
      el('summary', {}, [el('span', { text: xiaoya ? t`${BRIDGE_NAME}（小雅 / 电脑上的酒馆）` : t`${BRIDGE_NAME}（高级）` }), sourceState(service ? (external.ok ? 'ok' : 'warn') : 'off', service ? (external.ok ? t`已连上` : t`连不上`) : t`没填`)]),
      field(t`桥接地址`, ttsUrl, ttsHint),
      ttsStatus,
      ttsKeyHint,
    ])
    const browserLine = el('p', {
      class: 'hint',
      text: speech
        ? t`免费、不用设置：这台设备有 ${chinese.length} 个中文音色。`
        : t`这个浏览器不能朗读：设一个云端服务或本地语音桥接，或者换 Edge / Chrome 打开。`,
    })
    // The 朗读来源 page: cloud services first (the most natural voices), this device's own, then a local bridge.
    const sourceGroup = (title, note, boxes) =>
      el('section', { class: 'voice-group' }, [el('h4', { class: 'voice-group-title' }, [title, el('span', { text: note })]), ...boxes])
    const voiceSourceSections = [
      sourceGroup(t`云端服务`, t`要密钥，按字数计费`, sourceBoxes),
      sourceGroup(t`浏览器`, t`这台设备自带，免费`, [browserLine]),
      sourceGroup(BRIDGE_NAME, t`本机或局域网里的 TTS 模型，不经过云端`, [externalBox]),
    ]
    /** Nothing but the browser to read with, as saved: the 朗读来源 row asks to be opened. */
    const voiceNeed = () => {
      const bridgeSet = Boolean(form.elements.ttsUrl?.value.trim())
      if (VOICE_SOURCES.some(id => sources[id]?.configured) || (bridgeSet && external.ok)) return ''
      return bridgeSet ? t`${BRIDGE_NAME}没开` : t`还没设朗读服务`
    }

    // The dialog as a menu (web/menu.js): 配图 and 朗读, each with what every card
    // shares first (how pictures are drawn, where voices come from), then this
    // card's own settings.
    const charName = getChat()?.names?.char ?? ''
    const voiceText = new Map(groups.flatMap(([, list]) => list))
    const voiceName = (value, empty) => (value ? voiceText.get(value) ?? value.replace(BROWSER, '') : empty)
    const roster = card ? rosterEditor(card, loraInfo, getChat()?.names?.user ?? '') : null
    if (roster) roster.open = true
    const shared = (feature, rest) => ({ look: 'shared', tag: t`所有卡通用`, crumb: t`${feature} · 所有卡通用`, ...rest })
    const own = (feature, rest) => ({ look: 'own', crumb: `${feature} · ${charName || t`这张卡`}`, ...rest })
    const sections = [
      shared(t`配图`, {
        id: 'image',
        title: t`画图方式`,
        summary: () => {
          if (imageNeed()) return t`还没设好，现在画不了图：点这里选画图方式，填好供应商或令牌`
          const ownModel = form.elements[`localModel:${backend.value}`]?.selectedOptions[0]?.text
          const modelText = { novelai: naiModel.selectedOptions[0]?.text.split(t`（`)[0], openai: model.value, gemini: geminiModel.value }[backend.value] ?? ownModel
          return [IMAGE_BACKEND_TEXT[backend.value] ?? ownBackend(backend.value)?.name, modelText, SHAPES.find(([value]) => value === size.value)?.[1]].filter(Boolean).join(' · ')
        },
        status: () => {
          const need = imageNeed()
          return need ? ['need', need] : null
        },
        body: [
          el('div', { class: 'grid' }, [field(t`画图用`, backend), field(t`画幅`, size, t`图片接口：1024×1024 / 1024×1536 / 1536×1024；Gemini：1:1 / 2:3 / 3:2；ComfyUI、SD WebUI 和 NovelAI：1024×1024 / 832×1216 / 1216×832`)]),
          openaiBox,
          referenceRow,
          geminiBox,
          comfyBox,
          sdBox,
          naiBox,
          ...ownBoxes,
          field(t`画面提示词怎么写`, promptSource, t`「接着对话写」把固定前缀和这段对话原样发给写这段剧情的模型，再追加一句要提示词：几乎全部命中缓存，人物现在穿什么、在哪都对得上，但用的是对话模型的价格和速度。订阅模型写的剧情借不了，会自动改用辅助模型。`),
          el('div', { class: 'grid' }, [
            field(t`辅助模型`, helper, helperChoices.length ? '' : t`还没有供应商的模型`),
            field(t`提示词写法`, promptStyle),
          ]),
        ],
      }),
      card && own(t`配图`, {
        id: 'card-style',
        title: t`画风与 LoRA`,
        summary: () => {
          const style = form.elements.style?.value.trim() ?? ''
          const lora = form.elements.lora?.value ?? ''
          return [style ? t`画风：${style.length > 28 ? `${style.slice(0, 28)}…` : style}` : t`还没写画风`, lora ? t`LoRA：${lora}` : ''].filter(Boolean).join(' · ')
        },
        body: [
          field(t`画风（写进画面提示词；NovelAI 每张都加，人设图也是）`, el('textarea', { name: 'style', rows: 2, text: card.style ?? '', placeholder: t`例如 anime style, delicate lineart, soft cel shading, soft lighting` })),
          field(t`画风负面（只用于 NovelAI，加在负面提示词后面）`, el('input', { name: 'styleNegative', value: card.styleNegative ?? '', placeholder: t`例如 realistic, 3d, chibi` })),
          field(
            t`整卡 LoRA（只用于 ComfyUI；名册认出人物时改用她自己的）`,
            el('select', { name: 'lora' }, [
              option('', t`不用`, card.lora),
              ...loraInfo.loras.map(name => option(name, name, card.lora)),
              card.lora && !loraInfo.loras.includes(card.lora) ? option(card.lora, t`${card.lora}（ComfyUI 里现在没有）`, card.lora) : null,
            ].filter(Boolean)),
            loraInfo.ok ? t`画这张卡时自动在工作流的 Load Checkpoint 后面接上它，并把触发词放在提示词最前面。` : t`ComfyUI 没开，列不出 LoRA 文件；开着 ComfyUI 再打开这里。`,
          ),
          el('div', { class: 'grid' }, [
            field(t`触发词`, el('input', { name: 'loraTrigger', value: card.loraTrigger, placeholder: t`例如 linxue`, spellcheck: 'false' })),
            field(t`强度`, el('input', { name: 'loraStrength', type: 'number', min: '0', max: '2', step: '0.05', value: String(card.loraStrength) })),
          ]),
        ],
      }),
      card && own(t`配图`, {
        id: 'roster',
        title: t`角色名册`,
        summary: () => {
          const names = [...form.querySelectorAll('.roster-entry [data-field="name"]')].map(input => input.value.trim()).filter(Boolean)
          if (!names.length) return t`还没建：多角色卡画图时，每个人的长相固定、不串脸`
          return t`${names.length} 人：${names.slice(0, 4).join(t`、`)}${names.length > 4 ? '…' : ''}`
        },
        body: [roster],
      }),
      shared(t`朗读`, {
        id: 'voice',
        title: t`朗读来源`,
        summary: () => {
          if (voiceNeed()) return speech ? t`现在只能用浏览器音色：设一个云端服务（Fish Audio、MiniMax、Gemini 或供应商的朗读接口），声音自然得多` : t`还没有能用的音色：点这里设一个云端服务`
          const parts = []
          for (const id of VOICE_SOURCES) if (sources[id]?.configured) parts.push(t`${sources[id].label} ${sources[id].voices.length} 个音色`)
          if (speech) parts.push(t`浏览器 ${chinese.length} 个音色`)
          if (form.elements.ttsUrl?.value.trim() && external.ok) parts.push(t`${BRIDGE_NAME} ${voices.length + cloud.length} 个音色`)
          return parts.join(' · ')
        },
        status: () => {
          const need = voiceNeed()
          if (need) return ['need', need]
          return form.elements.ttsUrl?.value.trim() && !external.ok ? ['warn', t`${BRIDGE_NAME}没开`] : null
        },
        body: voiceSourceSections,
      }),
      card && own(t`朗读`, {
        id: 'card-voice',
        title: t`音色`,
        summary: () => {
          const own = card.roster.filter(entry => form.elements[`castVoice:${entry.id}`]?.value).length
          return t`对白：${voiceName(form.elements.voice?.value, dialogueDefault)} · 旁白：${voiceName(form.elements.narratorVoice?.value, t`不读`)}${own ? t` · ${own} 个角色有自己的音色` : ''}`
        },
        status: () => {
          const voice = form.elements.voice?.value ?? ''
          // A card without a voice reads with the local bridge's current one.
          if (!voice && service && !external.ok) return ['warn', t`默认走${BRIDGE_NAME}，没开`]
          if (voice && !known.has(voice)) return ['warn', t`音色不在了`]
          return null
        },
        body: [
          el('div', { class: 'grid' }, [
            field(t`对白音色`, voicePicker('voice', card.voice, dialogueDefault), tagHint),
            field(t`旁白音色`, voicePicker('narratorVoice', card.narratorVoice, t`不读旁白`), narratorHint),
          ]),
          el('p', { class: 'hint', text: t`没选对白音色时，用${service ? t`${BRIDGE_NAME}当前的音色` : t`浏览器默认的中文音色`}读。选了哪个来源的音色，就只用那个来源，别的来源开没开都不影响。` }),
          ...castVoiceBlock(card.roster, choices, form, () => settingsMenu.show('roster', 'forward')),
        ],
      }),
    ].filter(Boolean)

    const who = () => (card ? whoLine(el, { cardId: state.cardId, name: charName, note: t`这张卡自己的` }) : el('p', { class: 'menu-who none', text: t`选一张角色卡后，这里可以给它单独设置。` }))
    const switchRow = (input, text, hint) => {
      input.classList.add('switch')
      return el('label', { class: 'menu-switch', title: hint }, [el('span', { text }), input])
    }
    settingsMenu.mount({
      panels: [
        { id: 'image', title: t`配图`, icon: MENU_ICONS.picture, aside: switchRow(autoImage, t`新回复自动配图`, t`每轮多一次辅助模型调用和一次生图`), rows: ['image', who(), 'card-style', 'roster'] },
        { id: 'voice', title: t`朗读`, icon: MENU_ICONS.voice, aside: switchRow(autoRead, t`新回复自动朗读`), rows: ['voice', who(), 'card-voice'] },
      ],
      sections,
      note: t`配图和朗读都是点了才做，不进模型的上下文，也不影响缓存。`,
      footStart: [el('button', { type: 'button', class: 'btn ghost', text: t`管理供应商`, onclick: () => openProviders() })],
      save: { text: t`保存`, onClick: () => save(form, Boolean(card)) },
    })
    syncBackend()
    syncReference()
  }

  // ─── Voice choices: what a card or a cast member can be read in ────────

  /**
   * The voices to pick from, grouped: the local bridge's model voices, cloud
   * voices it relays by name, this tavern's own cloud services, then this
   * device's browser voices.
   */
  function voiceChoices({ voiceInfo, browserVoices = [], media, providers = [] }) {
    const sources = Object.fromEntries((voiceInfo?.sources ?? []).map(s => [s.id, s]))
    const external = sources.bridge ?? { ok: true, configured: false, voices: [], cloud: [], current: null }
    const service = Boolean(media?.ttsUrl)
    const voices = external.voices ?? []
    const cloud = external.cloud ?? []
    const chinese = browserVoices.filter(v => /^zh/i.test(v.lang))
    const browserLabel = v => `${v.name.replace(/^Microsoft /, '')}${v.localService ? '' : t`（在线）`}`
    const ownGroup = id => {
      const source = sources[id]
      if (!source?.voices?.length) return null
      const provider = id === 'openai' ? providers.find(p => p.id === media?.ttsProvider)?.name ?? '' : ''
      return [t`云端服务 · ${provider || source.label} · ${source.model}（按字数计费）`, source.voices.map(v => [v.ref, v.label])]
    }
    // As 朗读来源 lists them: cloud services, this device's browser voices, then the local bridge.
    const groups = [
      ...VOICE_SOURCES.map(ownGroup),
      chinese.length ? [t`浏览器 · 这台设备自带的音色（免费）`, chinese.map(v => [`${BROWSER}${v.name}`, browserLabel(v)])] : null,
      voices.length ? [t`${BRIDGE_NAME} · 本地模型音色`, voices.map(v => [v, v])] : null,
      cloud.length ? [t`${BRIDGE_NAME} · 经它转发的云端音色（按字数计费）`, cloud.map(v => [v.name, t`${v.label}（${v.provider.replace(/ · 云端$/, '')} · ${v.model}）`])] : null,
    ].filter(Boolean)
    const known = new Set(groups.flatMap(([, list]) => list.map(([value]) => value)))
    const dialogueDefault = service ? t`${BRIDGE_NAME}当前的音色${external.current ? t`（${external.current}）` : ''}` : t`浏览器默认中文音色`
    return { sources, external, service, voices, cloud, chinese, groups, known, dialogueDefault }
  }

  function voiceSelectFrom({ groups, known }, { name, value, empty }) {
    const option = (v, text) => el('option', { value: v, text, selected: v === value })
    const missing = v => (v.startsWith(BROWSER) ? t`${v.slice(BROWSER.length)}（这台设备没有，用默认中文音色）` : t`${v}（现在没有）`)
    return el('select', { name }, [
      option('', empty),
      ...(groups.length > 1
        ? groups.map(([label, list]) => el('optgroup', { label }, list.map(([v, text]) => option(v, text))))
        : groups.flatMap(([, list]) => list.map(([v, text]) => option(v, text)))),
      value && !known.has(value) ? option(value, missing(value)) : null,
    ].filter(Boolean))
  }

  /** A voice picker with its own 试听; onChange(value) once one is picked. */
  function voicePickerFrom(choices, { name, value, empty, form, silent = false, onChange = null }) {
    const select = voiceSelectFrom(choices, { name, value, empty })
    if (onChange) select.addEventListener('change', () => onChange(select.value))
    const listen = el('button', { type: 'button', class: 'btn small', text: t`试听`, title: t`用这个音色读一句示例（没保存的设置也算）` })
    listen.onclick = () => previewVoice(listen, { voice: select.value, form, silent })
    return el('span', { class: 'select-with-action' }, [select, listen])
  }

  /**
   * 角色各自的音色: a picker for each one in the cast ('' = the card's dialogue voice).
   * @param toRoster - opens 角色名册, for a card without a cast.
   * @param onChange - (entry, voice) once one is picked.
   */
  function castVoiceBlock(roster, choices, form, toRoster, onChange = null) {
    const rows = roster.map(entry => el('label', { class: 'cast-voice' }, [
      el('span', { class: 'cast-voice-name', text: entry.player ? t`${entry.name}（主角）` : entry.name }),
      voicePickerFrom(choices, { name: `castVoice:${entry.id}`, value: entry.voice ?? '', empty: t`同对白音色`, form, onChange: onChange && (value => onChange(entry, value)) }),
    ]))
    return [
      el('h4', { class: 'cast-voice-title', text: t`角色各自的音色` }),
      ...(rows.length
        ? [el('div', { class: 'cast-voices' }, rows), el('p', { class: 'hint', text: t`说话的人在角色名册里，就用自己的音色；没选的、猜不出是谁的，用对白音色。视觉小说模式按每句的说话人读，普通模式点「朗读」或点一句对白也一样。` })]
        : [el('p', { class: 'hint', text: t`先在角色名册里添加角色（「让辅助模型起草」最快），保存后就能给每个人选音色。` }), toRoster ? el('button', { type: 'button', class: 'btn small', 'data-settings': '', text: t`去角色名册`, onclick: toRoster }) : null]),
    ].filter(Boolean)
  }

  // ─── Quick settings (the visual novel mode's 朗读 / 配图 menus) ─────────

  /**
   * The few settings that matter while playing, into `box`: saved as soon as
   * one changes. 更多 opens the settings window on that page.
   * @param kind - 'voice' (this card's voices, the cast's, the voice models) or
   *   'image' (how pictures are drawn, the model, the shape).
   */
  async function fillQuick(box, kind) {
    const option = (value, text, selected) => el('option', { value, text, selected: value === selected })
    const row = (label, control, hint) => el('label', { class: 'quick-row' }, [el('span', { class: 'quick-label', text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null])
    // data-settings: the menu it sits in closes as the window opens.
    const more = (text, section) => el('button', { type: 'button', class: 'btn small ghost', 'data-settings': '', text, onclick: () => openSettings(section) })
    const redraw = () => fillQuick(box, kind)
    // A model changes what there is to pick: draw the menu again.
    const saveMedia = (patch, again = false) => guard(async () => {
      const view = await api('/api/media/settings', { method: 'PUT', body: patch })
      state.settings = view.media
      state.ownBackends = view.ownBackends ?? state.ownBackends
      toast(t`已保存`, 1500)
      if (again) redraw()
    })()
    box.replaceChildren(el('p', { class: 'hint', text: t`读取中…` }))
    if (!state.settings) await loadSettings()
    const media = state.settings ?? {}

    if (kind === 'image') {
      const backend = el('select', { onchange: () => saveMedia({ imageBackend: backend.value }, true) }, [...imageBackends(), ...state.ownBackends.map(own => [own.id, own.name])].map(([id, text]) => option(id, text, media.imageBackend)))
      const own = ownBackend(media.imageBackend)
      const ownModel = own?.models.length ? el('select', { onchange: () => saveMedia({ localModels: { [own.id]: ownModel.value } }) }, own.models.map(m => option(m.id, m.label, own.model))) : null
      const geminiModel = el('input', { value: media.geminiImageModel ?? '', list: 'quick-gemini-models', spellcheck: 'false', onchange: () => saveMedia({ geminiImageModel: geminiModel.value.trim() }) })
      const nai = el('select', { onchange: () => saveMedia({ naiModel: nai.value }) }, [
        ...NAI_MODELS.map(([value, text]) => option(value, text, media.naiModel)),
        NAI_MODELS.some(([value]) => value === media.naiModel) ? null : option(media.naiModel, media.naiModel, media.naiModel),
      ].filter(Boolean))
      const model = el('input', { value: media.imageModel ?? '', spellcheck: 'false', placeholder: t`例如 grok-imagine-image-2.0`, onchange: () => saveMedia({ imageModel: model.value.trim() }) })
      const unset = text => el('p', { class: 'hint warn', text })
      const modelRow = {
        openai: media.imageProvider ? row(t`生图模型`, model) : unset(t`还没选供应商：在「更多配图设置」里选`),
        gemini: media.geminiImageProvider
          ? row(t`Gemini 生图模型`, el('span', {}, [geminiModel, el('datalist', { id: 'quick-gemini-models' }, GEMINI_IMAGE_MODELS.map(id => el('option', { value: id })))]))
          : unset(t`还没选 Gemini 的供应商：在「更多配图设置」里选`),
        novelai: row(t`NovelAI 模型`, nai),
        comfy: el('p', { class: 'hint', text: t`用导入的 ComfyUI 工作流画，在「更多配图设置」里换。` }),
        sdwebui: el('p', { class: 'hint', text: t`用 SD WebUI 里当前加载的模型画（${media.sdUrl}）。` }),
      }[media.imageBackend] ?? (own ? (own.ready ? (ownModel ? row(t`模型`, ownModel) : null) : unset(own.need)) : null)
      const shape = el('select', { onchange: () => saveMedia({ imageShape: shape.value }) }, SHAPES.map(([value, text]) => option(value, text, media.imageShape)))
      // replaceChildren prints a null as text: leave the empty ones out.
      box.replaceChildren(...[
        row(t`画图用`, backend),
        modelRow,
        row(t`画幅`, shape),
        el('div', { class: 'quick-more' }, [more(t`更多配图设置…`, 'image'), state.cardId ? more(t`角色名册…`, 'roster') : null].filter(Boolean)),
      ].filter(Boolean))
      return
    }

    const [voiceInfo, browserVoices, providers] = await Promise.all([
      api('/api/media/voices'),
      loadBrowserVoices(),
      api('/api/providers').then(info => info.providers, () => []),
    ])
    state.voiceInfo = voiceInfo
    const choices = voiceChoices({ voiceInfo, browserVoices, media, providers })
    // 试听 reads with the saved settings: a form holding only the bridge's address.
    const form = el('form', {}, [el('input', { type: 'hidden', name: 'ttsUrl', value: media.ttsUrl ?? '' })])
    const saveCard = guard(async patch => {
      if (!state.cardId) return
      state.cardMedia = await api(`/api/cards/${state.cardId}/media`, { method: 'PUT', body: patch })
      announceCardMedia()
      toast(t`已保存`, 1500)
    })
    const card = state.cardMedia ?? {}
    const { sources } = choices
    const models = []
    if (sources.openai?.configured) {
      const input = el('input', { value: media.ttsModel ?? '', list: 'quick-tts-models', spellcheck: 'false', onchange: () => saveMedia({ ttsModel: input.value.trim() }, true) })
      models.push(row(t`朗读模型（供应商）`, el('span', {}, [input, el('datalist', { id: 'quick-tts-models' }, TTS_MODELS.map(id => el('option', { value: id })))])))
    }
    if (sources.fish?.configured) {
      const select = el('select', { onchange: () => saveMedia({ fishModel: select.value }, true) }, FISH_MODELS.map(([value, text]) => option(value, text, media.fishModel)))
      models.push(row(t`朗读模型（Fish Audio）`, select))
    }
    if (sources.minimax?.configured) {
      const list = MINIMAX_MODELS.includes(media.minimaxModel) ? MINIMAX_MODELS : [...MINIMAX_MODELS, media.minimaxModel]
      const select = el('select', { onchange: () => saveMedia({ minimaxModel: select.value }, true) }, list.map(id => option(id, id, media.minimaxModel)))
      models.push(row(t`朗读模型（MiniMax）`, select))
    }
    if (sources.gemini?.configured) {
      const input = el('input', { value: media.geminiTtsModel ?? '', list: 'quick-gemini-tts', spellcheck: 'false', onchange: () => saveMedia({ geminiTtsModel: input.value.trim() }, true) })
      models.push(row(t`朗读模型（Gemini）`, el('span', {}, [input, el('datalist', { id: 'quick-gemini-tts' }, GEMINI_TTS_MODELS.map(id => el('option', { value: id })))])))
    }
    box.replaceChildren(...[
      ...(state.cardId
        ? [
            row(t`对白音色`, voicePickerFrom(choices, { name: 'voice', value: card.voice ?? '', empty: choices.dialogueDefault, form, onChange: value => saveCard({ voice: value }) })),
            row(t`旁白音色`, voicePickerFrom(choices, { name: 'narratorVoice', value: card.narratorVoice ?? '', empty: t`不读旁白`, form, silent: true, onChange: value => saveCard({ narratorVoice: value }) })),
            ...castVoiceBlock(cast(), choices, form, () => openSettings('roster'), (entry, value) => saveCard({ roster: cast().map(e => (e.id === entry.id ? { ...e, voice: value } : e)) })),
          ]
        : [el('p', { class: 'hint', text: t`选一张角色卡后，这里可以给它选音色。` })]),
      choices.service && !choices.external.ok ? el('p', { class: 'hint warn', text: t`${BRIDGE_NAME}连不上：${choices.external.error ?? ''}` }) : null,
      ...models,
      el('div', { class: 'quick-more' }, [more(t`更多朗读设置…`, state.cardId ? 'card-voice' : 'voice')]),
    ].filter(Boolean))
  }

  // ─── Cast (角色名册) ────────────────────────────────────────────────
  // Who can appear in this card's pictures: fixed looks, an optional reference
  // picture each, one entry may be the player. Saved with the card settings;
  // reference pictures upload at once.

  const KIND_TEXT = [['girl', t`女`], ['boy', t`男`], ['other', t`其他`]]
  const newEntryId = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), b => b.toString(16).padStart(2, '0')).join('')
  const refUrl = (cardId, id) => `/api/cards/${cardId}/roster/${id}/ref?v=${Date.now()}`

  /** NovelAI takes reference pictures on three canvases only: letterbox onto the closest, in black. */
  async function padForReference(blob) {
    const bitmap = await createImageBitmap(blob)
    const sizes = [[1024, 1536], [1536, 1024], [1472, 1472]]
    const aspect = bitmap.width / bitmap.height
    const [w, h] = sizes.reduce((best, size) => (Math.abs(size[0] / size[1] - aspect) < Math.abs(best[0] / best[1] - aspect) ? size : best))
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h })
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
    const scale = Math.min(w / bitmap.width, h / bitmap.height)
    const dw = Math.round(bitmap.width * scale)
    const dh = Math.round(bitmap.height * scale)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, Math.round((w - dw) / 2), Math.round((h - dh) / 2), dw, dh)
    return canvas.toDataURL('image/png')
  }

  /** The roster as the form shows it now; each one's voice from 朗读 → 音色 (one added since has none yet). */
  function collectRoster(form) {
    return [...form.querySelectorAll('.roster-entry')].map(box => ({ ...readEntry(box), voice: form.elements[`castVoice:${box.dataset.id}`]?.value ?? box.dataset.voice ?? '' }))
  }

  /** One roster entry as its box shows it now. */
  function readEntry(box) {
    const get = name => box.querySelector(`[data-field="${name}"]`)
    return {
      id: box.dataset.id,
      name: get('name').value,
      aliases: get('aliases').value,
      kind: get('kind').value,
      player: get('player').checked,
      looks: get('looks').value,
      outfit: get('outfit').value,
      lora: get('lora').value,
      loraTrigger: get('loraTrigger').value,
      loraStrength: Number(get('loraStrength').value || 0.8),
      ref: box.dataset.ref === '1',
    }
  }

  function rosterEditor(card, loraInfo, userName) {
    const cardId = state.cardId
    const list = el('div', { class: 'roster-list' })
    const summary = el('summary')
    const status = el('span', { class: 'hint' })
    const box = el('details', { class: 'roster', open: card.roster.length > 0 }, [
      summary,
      el('p', { class: 'hint', text: t`名册里的人，长相按这里写的固定 tag 画，辅助模型只写谁在画面里、穿什么、在做什么。多人同框时每人单独成段，不会串。外貌和衣着用英文 tag。` }),
      list,
    ])
    const option = (value, text, selected) => el('option', { value, text, selected: value === selected })

    function entryBox(entry) {
      const thumb = el('div', { class: 'roster-thumb', title: t`点击放大` }, entry.ref ? [el('img', { src: refUrl(cardId, entry.id), alt: '' })] : [el('span', { text: t`没有人设图` })])
      thumb.onclick = () => {
        const img = thumb.querySelector('img')
        if (!img) return
        const current = readEntry(node)
        viewPicture(img.src, t`${current.name}：${current.looks}${current.outfit ? t`；${current.outfit}` : ''}`, t`人设图`)
      }
      const node = el('fieldset', { class: 'roster-entry', 'data-id': entry.id, 'data-ref': entry.ref ? '1' : '', 'data-voice': entry.voice ?? '' })
      const setRef = has => {
        node.dataset.ref = has ? '1' : ''
        thumb.replaceChildren(has ? el('img', { src: refUrl(cardId, entry.id), alt: '' }) : el('span', { text: t`没有人设图` }))
        removeRef.hidden = !has
      }
      const upload = guard(async blob => {
        thumb.replaceChildren(el('span', { text: t`处理中…` }))
        try {
          await api(`/api/cards/${cardId}/roster/${entry.id}/ref`, { method: 'PUT', body: { image: await padForReference(blob) } })
        } catch (error) {
          setRef(node.dataset.ref === '1')
          throw error
        }
        setRef(true)
        toast(t`人设图已上传，保存后生效`)
      })
      const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true })
      file.onchange = () => {
        const chosen = file.files[0]
        file.value = ''
        if (chosen) upload(chosen)
      }
      const fromAvatar = guard(async () => {
        const res = await fetch(`/api/cards/${cardId}/avatar`)
        if (!res.ok) throw new Error(t`这张卡没有头像`)
        await upload(await res.blob())
      })
      const portrait = el('button', { type: 'button', class: 'btn small ghost', text: t`画一张`, title: t`按长相和平时衣着画一张半身像当人设图，可以先选画图方式和模型（NovelAI 在 Opus 免费范围内）` })
      portrait.onclick = () => drawPortrait()
      const drawPortrait = guard(async () => {
        const current = readEntry(node)
        const picked = await pickDraw({ title: t`画「${current.name || t`这个角色`}」的人设图`, note: t`按长相和平时衣着画一张半身像。` })
        if (!picked) return
        portrait.disabled = true
        thumb.replaceChildren(el('span', { text: t`正在画…` }))
        try {
          const { image } = await api(`/api/cards/${cardId}/roster/portrait`, { method: 'POST', body: { entry: current, ...picked.body } })
          await upload(await (await fetch(image)).blob())
        } catch (error) {
          setRef(node.dataset.ref === '1')
          throw error
        } finally {
          portrait.disabled = false
        }
      })
      const removeRef = el('button', { type: 'button', class: 'btn small ghost', text: t`删人设图`, hidden: !entry.ref })
      removeRef.onclick = guard(async () => {
        await api(`/api/cards/${cardId}/roster/${entry.id}/ref`, { method: 'DELETE' })
        setRef(false)
      })
      const player = el('input', { type: 'checkbox', 'data-field': 'player', checked: entry.player })
      player.onchange = () => {
        // Only one player entry.
        if (player.checked) for (const other of list.querySelectorAll('[data-field="player"]')) if (other !== player) other.checked = false
        syncSummary()
      }
      const name = el('input', { 'data-field': 'name', value: entry.name, placeholder: entry.player ? t`主角` : t`名字`, maxlength: '40' })
      name.oninput = syncSummary
      const loras = loraInfo.loras ?? []
      node.append(
        el('div', { class: 'roster-head' }, [
          thumb,
          el('div', { class: 'roster-main' }, [
            el('div', { class: 'roster-row' }, [
              name,
              el('select', { 'data-field': 'kind' }, KIND_TEXT.map(([value, text]) => option(value, text, entry.kind))),
              el('label', { class: 'check-row', title: t`玩家扮演的角色；剧情里叫「${userName || t`玩家`}」时也认得` }, [player, el('span', { text: t`主角` })]),
              el('button', { type: 'button', class: 'btn small ghost danger', text: t`移除`, onclick: () => { node.remove(); syncSummary() } }),
            ]),
            el('input', { 'data-field': 'aliases', value: entry.aliases, placeholder: t`别称，用逗号分开（例如 念念, 小师妹）` }),
            el('div', { class: 'roster-row' }, [
              el('button', { type: 'button', class: 'btn small', text: t`上传人设图`, onclick: () => file.click() }),
              el('button', { type: 'button', class: 'btn small ghost', text: t`用卡头像`, onclick: fromAvatar }),
              portrait,
              removeRef,
              file,
            ]),
          ]),
        ]),
        el('label', {}, [t`长相（固定不变的：发型发色、眼睛、身形、记号）`, el('textarea', { 'data-field': 'looks', rows: 2, spellcheck: 'false', placeholder: 'black hair, hair bun, white ribbon, dark eyes, dimples, petite', text: entry.looks })]),
        el('label', {}, [t`平时的衣着（辅助模型据此写当下穿什么）`, el('input', { 'data-field': 'outfit', value: entry.outfit, spellcheck: 'false', placeholder: 'white and pale blue wudang robe, wide sleeves' })]),
        el('div', { class: 'grid three' }, [
          el('label', {}, [
            t`LoRA（ComfyUI，单人画面用）`,
            el('select', { 'data-field': 'lora' }, [
              option('', t`不用`, entry.lora),
              ...loras.map(n => option(n, n, entry.lora)),
              entry.lora && !loras.includes(entry.lora) ? option(entry.lora, t`${entry.lora}（现在没有）`, entry.lora) : null,
            ].filter(Boolean)),
          ]),
          el('label', {}, [t`触发词`, el('input', { 'data-field': 'loraTrigger', value: entry.loraTrigger, spellcheck: 'false' })]),
          el('label', {}, [t`强度`, el('input', { 'data-field': 'loraStrength', type: 'number', min: '0', max: '2', step: '0.05', value: String(entry.loraStrength ?? 0.8) })]),
        ]),
      )
      return node
    }

    function syncSummary() {
      const entries = list.querySelectorAll('.roster-entry')
      const hasPlayer = [...list.querySelectorAll('[data-field="player"]')].some(input => input.checked)
      summary.textContent = t`角色名册（${entries.length} 人${entries.length && !hasPlayer ? t`，还没有主角` : ''}）`
    }

    const blank = extra => ({ id: newEntryId(), name: '', aliases: '', kind: 'girl', player: false, looks: '', outfit: '', lora: '', loraTrigger: '', loraStrength: 0.8, ref: false, ...extra })
    const add = entry => {
      list.append(entryBox(entry))
      syncSummary()
    }
    const draft = guard(async () => {
      draftButton.disabled = true
      status.textContent = t`辅助模型在读卡和世界书，可能要一两分钟…`
      try {
        const { roster, model } = await api(`/api/cards/${cardId}/roster/draft`, { method: 'POST', body: {} })
        const have = new Set(collectRoster($('media-form')).map(e => e.name.trim()))
        const hasPlayer = collectRoster($('media-form')).some(e => e.player)
        const fresh = roster.filter(e => !have.has(e.name.trim())).map(e => ({ ...e, player: e.player && !hasPlayer, ref: false }))
        fresh.forEach(add)
        box.open = true
        status.textContent = fresh.length ? t`${model} 起草了 ${fresh.length} 个角色，看过、改好再保存。` : t`${model} 列出的角色名册里都有了。`
      } catch (error) {
        status.textContent = ''
        throw error
      } finally {
        draftButton.disabled = false
      }
    })
    const draftButton = el('button', { type: 'button', class: 'btn small', text: t`让辅助模型起草`, title: t`读这张卡的描述和世界书，列出主要角色和主角的长相、衣着`, onclick: draft })
    // 从对话里补充: whoever joined the story in the open chat's recent turns and is not in the list yet.
    const chat = getChat()
    const ownChat = chat?.cardId === cardId ? chat : null
    const fromChat = guard(async () => {
      chatButton.disabled = true
      status.textContent = t`辅助模型在读最近几轮对话，可能要一两分钟…`
      try {
        const names = collectRoster($('media-form')).flatMap(e => [e.name, e.aliases]).filter(Boolean)
        const { roster, model } = await api(`/api/cards/${cardId}/roster/draft-chat`, { method: 'POST', body: { chatId: ownChat.id, names } })
        const have = new Set(collectRoster($('media-form')).map(e => e.name.trim()))
        const fresh = roster.filter(e => !have.has(e.name.trim())).map(e => ({ ...e, player: false, ref: false }))
        fresh.forEach(add)
        box.open = true
        status.textContent = fresh.length ? t`${model} 从对话里找到 ${fresh.length} 个新角色，看过、改好再保存。` : t`${model} 没在最近几轮里找到名册之外的角色。`
      } catch (error) {
        status.textContent = ''
        throw error
      } finally {
        chatButton.disabled = !ownChat
      }
    })
    const chatButton = el('button', {
      type: 'button', class: 'btn small', text: t`从对话里补充`, disabled: !ownChat, onclick: fromChat,
      title: ownChat ? t`读正在打开的对话最近几轮，列出后来出场、名册里还没有的角色` : t`先打开这张卡的一个对话`,
    })
    box.append(
      el('div', { class: 'roster-actions' }, [
        el('button', { type: 'button', class: 'btn small', text: t`添加角色`, onclick: () => add(blank()) }),
        el('button', { type: 'button', class: 'btn small', text: t`添加主角`, onclick: () => add(blank({ player: !collectRoster($('media-form')).some(e => e.player), name: t`主角`, kind: 'boy' })) }),
        draftButton,
        chatButton,
        status,
      ]),
    )
    for (const entry of card.roster) list.append(entryBox(entry))
    syncSummary()
    return box
  }

/** "Opus · V5 额度 53%（2.2 小时后回 1%）· 0 Anlas · 10月22日续期". */
  function naiAccountText(info) {
    if (!info) return ''
    const parts = [`${info.tier}${info.active ? '' : t`（已过期）`}`]
    if (info.v5) {
      const v5 = info.v5
      const next = v5.nextPercentMinutes ? t`，${v5.nextPercentMinutes >= 60 ? t`${Math.round(v5.nextPercentMinutes / 6) / 10} 小时` : t`${v5.nextPercentMinutes} 分钟`}后回 1%` : ''
      parts.push(v5.empty ? t`V5 额度用完了${next}` : t`V5 额度 ${v5.percent}%${v5.purchasedPercent ? t` + 买的 ${v5.purchasedPercent}%` : ''}${next}`)
    }
    parts.push(`${info.anlas} Anlas`)
    if (info.renewsAt) {
      const at = new Date(info.renewsAt)
      parts.push(t`${at.getMonth() + 1}月${at.getDate()}日 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} 续期（Anlas 补满）`)
    }
    if (info.tier !== 'Opus') parts.push(t`不是 Opus，每张都扣 Anlas`)
    return parts.join(' · ')
  }

  // ─── Voice sources (配图与朗读 → 朗读) ─────────────────────────────────
  // Each server-side source is set up once here; cards only pick voices.
  // Keys go to the server's voice-keys.json and come back as their last four characters.

  const voiceListText = list => (list ?? []).map(v => (v.name ? `${v.id} ${v.name}` : v.id)).join('\n')

  function sourceState(kind, text) {
    return el('span', { class: `source-state ${kind}`, text })
  }

  /**
   * A key field. A pasted key is saved as soon as you leave the field or press
   * Enter (not only with the dialog's 保存 at the bottom); 删除密钥 removes it at once.
   * @param onChange - called with the saved key's status, to update the source's badge.
   */
  function keyField(id, label, status, placeholder, onChange = () => {}) {
    const input = el('input', { name: `${id}Key`, type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: status?.hasKey ? t`留空不改` : placeholder })
    const hint = el('span', { class: 'hint' })
    const clear = el('button', { type: 'button', class: 'btn small ghost', text: t`删除密钥` })
    let saved = status
    const show = info => {
      saved = info
      hint.classList.toggle('warn', !info?.hasKey)
      hint.textContent = info?.hasKey ? t`已保存（${info.keyHint}）。只存在本机服务端，留空就不改。` : t`还没填密钥`
      input.placeholder = info?.hasKey ? t`留空不改` : placeholder
      clear.hidden = !info?.hasKey
      onChange(info)
    }
    show(status)
    const store = async body => (await api('/api/media/settings', { method: 'PUT', body })).voiceKeys?.[id]
    const saveKey = guard(async () => {
      const key = input.value.trim()
      if (!key) return show(saved)
      hint.classList.remove('warn')
      hint.textContent = t`保存中…`
      try {
        show(await store({ [`${id}Key`]: key }))
        input.value = ''
        toast(t`密钥已保存`)
      } catch (error) {
        show(saved)
        throw error
      }
    })
    input.addEventListener('change', saveKey)
    input.addEventListener('keydown', event => {
      // Enter would submit the dialog's form and close it.
      if (event.key !== 'Enter') return
      event.preventDefault()
      saveKey()
    })
    input.addEventListener('input', () => {
      if (!input.value.trim()) return show(saved)
      hint.classList.add('warn')
      hint.textContent = t`离开这一栏或按回车就保存`
    })
    clear.onclick = guard(async () => {
      show(await store({ [`${id}ClearKey`]: true }))
      toast(t`已删除密钥`)
    })
    return el('label', {}, [label, el('span', { class: 'select-with-action' }, [input, clear]), hint])
  }

  function voiceSourceBoxes({ media, voiceKeys = {}, providers, sources, form }) {
    const option = (value, text, selected) => el('option', { value, text, selected: value === selected })
    const field = (label, control, hint) => el('label', {}, [label, control, hint ? el('span', { class: 'hint', text: hint }) : null])
    const listen = source => {
      const button = el('button', { type: 'button', class: 'btn small', text: t`试听`, title: t`用这一栏现在填的设置读一句示例（不用先保存）` })
      button.onclick = () => previewVoice(button, { source, form })
      return button
    }
    // The account's own voices join the list below the ones written; their names stay.
    const fromAccount = source => {
      const button = el('button', { type: 'button', class: 'btn small', text: t`从账户读取音色`, title: t`把账户里自己克隆或设计的音色加进音色框（已写的名字不改），保存后生效` })
      button.onclick = guard(async () => {
        button.disabled = true
        button.textContent = t`读取中…`
        try {
          const { voices, found, added, changed, full } = await api('/api/media/voices/account', { method: 'POST', body: { source, ...voiceDraft(form) } })
          if (changed) form.elements[`${source}Voices`].value = voiceListText(voices)
          if (!found) toast(t`账户里还没有自己克隆或设计的音色`, 6000)
          else if (added) toast(t`账户里有 ${found} 个音色，新加了 ${added} 个${full ? t`（最多列 100 个，多的没加）` : ''}，保存后生效`, 6000)
          else if (full) toast(t`音色框已满 100 个，账户里的音色加不进去：先删掉不用的`, 6000)
          else toast(t`账户里的 ${found} 个音色都已在列表里${changed ? t`，补上了名字，保存后生效` : ''}`, 6000)
        } finally {
          button.disabled = false
          button.textContent = t`从账户读取音色`
        }
      })
      return button
    }
    const state = id => {
      const source = sources[id]
      return source?.configured ? sourceState('ok', t`${source.voices.length} 个音色`) : sourceState('off', t`没设置`)
    }
    // A keyed source's badge follows its key as it is saved or removed.
    const keyBadge = id => {
      const badge = sourceState('off', t`没设置`)
      const update = info => {
        const count = sources[id]?.voices?.length ?? 0
        badge.className = `source-state ${info?.hasKey ? 'ok' : 'off'}`
        badge.textContent = info?.hasKey ? (count ? t`${count} 个音色` : t`密钥已保存`) : t`没设置`
      }
      return { badge, update }
    }
    const fishBadge = keyBadge('fish')
    const minimaxBadge = keyBadge('minimax')

    const speakers = providers.filter(p => p.api !== 'anthropic-messages')
    const openai = el('details', { class: 'voice-source', open: Boolean(media.ttsProvider) }, [
      el('summary', {}, [el('span', { text: t`供应商的朗读接口（OpenAI 兼容 /audio/speech）` }), state('openai')]),
      el('div', { class: 'grid' }, [
        field(t`供应商`, el('select', { name: 'ttsProvider' }, [option('', speakers.length ? t`不用` : t`先在「供应商」里添加`, media.ttsProvider), ...speakers.map(p => option(p.id, p.name, media.ttsProvider))])),
        field(t`模型`, el('input', { name: 'ttsModel', value: media.ttsModel, list: 'tts-models', spellcheck: 'false', placeholder: 'gpt-4o-mini-tts' })),
      ]),
      el('datalist', { id: 'tts-models' }, TTS_MODELS.map(id => el('option', { value: id }))),
      field(t`音色（每行一个：ID，后面可以空一格写名字）`, el('textarea', { name: 'ttsVoices', rows: 3, spellcheck: 'false', placeholder: t`coral 温柔\nnova`, text: voiceListText(media.ttsVoices) }),
        t`留空就用模型常见的音色：OpenAI 的 alloy、coral、nova…；硅基流动 FunAudioLLM/CosyVoice2-0.5B 的 8 个预置音色。用供应商自己的地址、密钥和代理设置；gpt-4o-mini-tts 会把回复里的情绪当语气说明。`),
      el('div', { class: 'row voice-actions' }, [listen('openai')]),
    ])

    const fish = el('details', { class: 'voice-source', open: Boolean(voiceKeys.fish?.hasKey) }, [
      el('summary', {}, [el('span', { text: 'Fish Audio' }), fishBadge.badge]),
      keyField('fish', 'API Key', voiceKeys.fish, t`fish.audio → API Keys 里创建`, fishBadge.update),
      field(t`模型`, el('select', { name: 'fishModel' }, FISH_MODELS.map(([value, text]) => option(value, text, media.fishModel)))),
      field(t`音色（每行一个：音色页链接或 32 位 ID，后面可以空一格写名字）`, el('textarea', { name: 'fishVoices', rows: 3, spellcheck: 'false', placeholder: t`https://fish.audio/m/0123456789abcdef0123456789abcdef 南晚`, text: voiceListText(media.fishVoices) }),
        t`自己克隆的音色点「从账户读取音色」；别人的音色在 fish.audio 打开，复制地址栏的链接粘贴进来。回复里的情绪放在台词前当语气标签。除 s2.1-pro-free 外按字数计费，账户没余额时换成它；走「设置」里的代理。`),
      el('div', { class: 'row voice-actions' }, [listen('fish'), fromAccount('fish')]),
    ])

    const minimax = el('details', { class: 'voice-source', open: Boolean(voiceKeys.minimax?.hasKey) }, [
      el('summary', {}, [el('span', { text: 'MiniMax' }), minimaxBadge.badge]),
      keyField('minimax', 'API Key', voiceKeys.minimax, t`开放平台 → 接口密钥`, minimaxBadge.update),
      el('div', { class: 'grid' }, [
        field(t`站点`, el('select', { name: 'minimaxRegion' }, [option('cn', t`国内站（api.minimaxi.com，直连）`, media.minimaxRegion), option('intl', t`国际站（api.minimax.io，走代理）`, media.minimaxRegion)]), t`密钥只在创建它的站点能用`),
        field(t`模型`, el('select', { name: 'minimaxModel' }, [
          ...MINIMAX_MODELS.map(id => option(id, id, media.minimaxModel)),
          MINIMAX_MODELS.includes(media.minimaxModel) ? null : option(media.minimaxModel, media.minimaxModel, media.minimaxModel),
        ].filter(Boolean))),
      ]),
      field(t`音色（每行一个：voice_id，后面可以空一格写名字）`, el('textarea', { name: 'minimaxVoices', rows: 3, spellcheck: 'false', placeholder: t`留空用系统音色（少女、御姐、精英青年…）`, text: voiceListText(media.minimaxVoices) }),
        t`复刻或设计的音色点「从账户读取音色」，或者把 voice_id 写在这里。按字数计费。`),
      el('div', { class: 'row voice-actions' }, [listen('minimax'), fromAccount('minimax')]),
    ])

    // Gemini's speech models through a provider holding Google's key (the one chat uses).
    const googleSpeakers = speakers.filter(isGoogle)
    const geminiModelList = el('datalist', { id: 'gemini-tts-models' }, GEMINI_TTS_MODELS.map(id => el('option', { value: id })))
    const geminiProvider = el('select', { name: 'geminiTtsProvider' }, [
      option('', speakers.length ? t`不用` : t`先在「供应商」里添加`, media.geminiTtsProvider),
      ...[...googleSpeakers, ...speakers.filter(p => !isGoogle(p))].map(p => option(p.id, p.name, media.geminiTtsProvider)),
    ])
    const geminiModel = el('input', { name: 'geminiTtsModel', value: media.geminiTtsModel, list: 'gemini-tts-models', spellcheck: 'false' })
    const fetchModels = el('button', { type: 'button', class: 'btn small', text: t`获取` })
    fetchModels.onclick = guard(async () => {
      if (!geminiProvider.value) throw new Error(t`先选供应商`)
      const { models } = await api('/api/providers/models', { method: 'POST', body: { id: geminiProvider.value } })
      const found = models.filter(id => /tts/i.test(id))
      geminiModelList.replaceChildren(...(found.length ? found : GEMINI_TTS_MODELS).map(id => el('option', { value: id })))
      toast(found.length ? t`找到 ${found.length} 个朗读模型，点输入框选` : t`这个供应商没列出朗读模型，列的是常用的`)
      geminiModel.focus()
    })
    const gemini = el('details', { class: 'voice-source', open: Boolean(media.geminiTtsProvider) }, [
      el('summary', {}, [el('span', { text: t`Gemini 朗读（Google）` }), state('gemini')]),
      el('div', { class: 'grid' }, [
        field(t`供应商`, geminiProvider, googleSpeakers.length ? t`选用「Gemini」模板建的供应商，和对话共用密钥和代理` : t`先用「Gemini」模板建一个供应商（密钥在 aistudio.google.com 创建）`),
        el('label', {}, [t`模型`, el('span', { class: 'select-with-action' }, [geminiModel, fetchModels]), geminiModelList]),
      ]),
      field(t`音色（每行一个：音色名，后面可以空一格写说明）`, el('textarea', { name: 'geminiTtsVoices', rows: 3, spellcheck: 'false', placeholder: t`留空列出全部 30 个预置音色，例如\nKore 女主\nPuck 男主`, text: voiceListText(media.geminiTtsVoices) }),
        t`预置音色有 Kore、Leda、Aoede（女声）、Puck、Charon、Fenrir（男声）等 30 个，中文也能读。回复里的情绪会变成「用…的语气说」放在台词前。按用量计费，走「设置」里的代理。`),
      el('div', { class: 'row voice-actions' }, [listen('gemini')]),
    ])
    return [openai, fish, minimax, gemini]
  }

  /** The voice settings and typed keys as the form shows them, for 试听 and saving. */
  function voiceDraft(form) {
    const value = name => form.elements[name]?.value ?? ''
    const media = Object.fromEntries(VOICE_FIELDS.filter(name => form.elements[name]).map(name => [name, value(name)]))
    const keys = Object.fromEntries(VOICE_SOURCES.filter(id => value(`${id}Key`).trim()).map(id => [id, value(`${id}Key`).trim()]))
    return { media, keys }
  }

  let previewing = null // { audio, url } or 'browser'
  function stopPreview() {
    if (previewing === 'browser') speech?.cancel()
    else if (previewing) {
      previewing.audio.pause()
      URL.revokeObjectURL(previewing.url)
    }
    previewing = null
  }

  /**
   * 试听: one sample sentence in a voice (a card's pick) or a source's first
   * voice, with the form's unsaved settings. Browser voices are spoken here.
   */
  const previewVoice = guard(async (button, { voice = '', source = '', form, silent = false }) => {
    stopPreview()
    const draft = voiceDraft(form)
    const hereVoice = voice.startsWith(BROWSER) || (!voice && !source && !form.elements.ttsUrl?.value.trim())
    if (!voice && !source && silent) throw new Error(t`旁白没选音色：不读旁白`)
    if (hereVoice) {
      if (!speech) throw new Error(t`这个浏览器不能朗读`)
      await loadBrowserVoices()
      const utterance = new SpeechSynthesisUtterance(PREVIEW_LINE)
      const picked = browserVoice(voice)
      utterance.lang = picked?.lang ?? 'zh-CN'
      if (picked) utterance.voice = picked
      previewing = 'browser'
      speech.speak(utterance)
      return
    }
    const label = button.textContent
    button.disabled = true
    button.textContent = t`合成中…`
    try {
      const res = await fetch('/api/media/voices/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' },
        body: JSON.stringify({ voice, source, text: PREVIEW_LINE, ...draft }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t`试听失败（${res.status}）`)
      const url = URL.createObjectURL(await res.blob())
      const audio = new Audio(url)
      previewing = { audio, url }
      audio.onended = () => {
        if (previewing?.audio === audio) stopPreview()
      }
      await audio.play()
    } finally {
      button.disabled = false
      button.textContent = label
    }
  })

  function voiceKeyText(hint, info) {
    hint.hidden = !info?.hasKey
    hint.textContent = info?.hasKey ? t`已保存电脑上酒馆的访问口令（${info.keyHint}），只存在本机服务端；换地址时一起清掉。` : ''
  }

  function naiTokenText(hint, info) {
    hint.classList.toggle('warn', !info?.hasToken)
    hint.textContent = info?.hasToken ? t`已保存（${info.tokenHint}）。只存在本机服务端，留空就不改。` : t`还没填令牌`
  }

  function workflowText(info) {
    if (!info) return t`还没导入工作流`
    return t`已导入：${info.nodes} 个节点，占位符 ${info.placeholders.map(p => `{{${p}}}`).join(' ')}`
  }

  const save = guard(async (form, hasCard) => {
    const value = name => form.elements[name]?.value ?? ''
    const checked = name => Boolean(form.elements[name]?.checked)
    const before = state.settings?.ttsUrl
    const pastedKey = /#k=/.test(value('ttsUrl'))
    // A source set up or changed has other voices to pick from: show them.
    const voiceSettings = media => JSON.stringify(VOICE_FIELDS.map(name => media?.[name]))
    const voicesBefore = voiceSettings(state.settings)
    const { media: draftVoices, keys } = voiceDraft(form)
    const { media, novelai, voiceKey, ownBackends } = await api('/api/media/settings', {
      method: 'PUT',
      body: {
        imageBackend: value('imageBackend'),
        imageProvider: value('imageProvider'),
        imageModel: value('imageModel'),
        imageShape: value('imageShape'),
        imageReference: checked('imageReference'),
        imageEditModel: value('imageEditModel'),
        comfyUrl: value('comfyUrl'),
        geminiImageProvider: value('geminiImageProvider'),
        geminiImageModel: value('geminiImageModel'),
        geminiReference: checked('geminiReference'),
        sdUrl: value('sdUrl'),
        sdSampler: value('sdSampler'),
        sdSteps: Number(value('sdSteps') || 28),
        sdCfg: Number(value('sdCfg') || 6),
        sdNegative: value('sdNegative'),
        naiModel: value('naiModel'),
        naiQuality: value('naiQuality'),
        naiReference: checked('naiReference'),
        naiRefFidelity: Number(value('naiRefFidelity') || 0.8),
        naiRefStyle: checked('naiRefStyle'),
        naiV5Empty: value('naiV5Empty'),
        naiNegative: value('naiNegative'),
        naiToken: value('naiToken').trim(),
        ...(state.ownBackends.length ? { localModels: Object.fromEntries(state.ownBackends.filter(own => form.elements[`localModel:${own.id}`]).map(own => [own.id, value(`localModel:${own.id}`)])) } : {}),
        helperModel: value('helperModel'),
        promptStyle: value('promptStyle'),
        promptSource: value('promptSource'),
        autoImage: checked('autoImage'),
        ttsUrl: value('ttsUrl'),
        ...draftVoices,
        ...Object.fromEntries(Object.entries(keys).map(([id, key]) => [`${id}Key`, key])),
        autoRead: checked('autoRead'),
      },
    })
    for (const id of VOICE_SOURCES) if (form.elements[`${id}Key`]) form.elements[`${id}Key`].value = ''
    state.settings = media
    state.ownBackends = ownBackends ?? state.ownBackends
    const keyHint = form.querySelector('.tts-key-hint')
    if (keyHint) voiceKeyText(keyHint, voiceKey)
    if (form.elements.ttsUrl) form.elements.ttsUrl.value = media.ttsUrl
    if (form.elements.naiToken) form.elements.naiToken.value = ''
    if (novelai?.hasToken && form.elements.naiToken) form.elements.naiToken.placeholder = t`留空不改`
    const hint = form.querySelector('.nai-token-hint')
    if (hint) naiTokenText(hint, novelai)
    if (hasCard && state.cardId) {
      state.cardMedia = await api(`/api/cards/${state.cardId}/media`, {
        method: 'PUT',
        body: { voice: value('voice'), narratorVoice: value('narratorVoice'), style: value('style'), styleNegative: value('styleNegative'), lora: value('lora'), loraTrigger: value('loraTrigger'), loraStrength: Number(value('loraStrength') || 0.8), roster: collectRoster(form) },
      })
      announceCardMedia()
    }
    settingsMenu.markClean()
    toast(t`已保存`)
    // A new voice service or source has its own voices: show them.
    if (media.ttsUrl !== before || pastedKey || voiceSettings(media) !== voicesBefore || Object.keys(keys).length) openSettings()
  })

  $('media-dialog').addEventListener('close', stopPreview)
  $('player-redo').addEventListener('click', () => player.redo())
  $('player-toggle').addEventListener('click', () => player.toggle())
  $('player-stop').addEventListener('click', () => player.stop())
  loadSettings()

  return { openLibrary, toolsFor: mediaTools, gallery, openSettings, setCard, afterTurn, flags, readBeat, fillQuick, stopReading: () => player.stop(), toggleReading: () => player.toggle() }
}
