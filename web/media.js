// Pictures and voice for replies: the 配图 / 朗读 buttons, the picture strip
// under a reply, the reading bar above the input box and the settings window.
// Nothing here changes what the model sees.
import { speechChunks } from '/shared/speech.js'

const SHAPES = [['square', '方图'], ['portrait', '竖图'], ['landscape', '横图']]
const NAI_MODELS = [
  ['nai-diffusion-5-full', 'V5 Full（能画成人内容）'],
  ['nai-diffusion-5-curated', 'V5 Curated（筛过的数据，不出成人内容）'],
  ['nai-diffusion-4-5-full', 'V4.5 Full'],
  ['nai-diffusion-4-5-curated', 'V4.5 Curated'],
]
const IMAGE_MODEL = /image|imagine|dall|flux|sdxl|stable|seedream|gpt-image|kolors|wanx|cogview|midjourney|recraft|ideogram/i

// Browser voices (Web Speech API): spoken by the page itself, free, nothing
// goes to the server. A card names one as `browser:<voice name>`; a device
// without that voice reads with its first Chinese voice instead. With no voice
// service set up, a card without a voice reads with the browser too.
const BROWSER = 'browser:'
const DELIVERY_TAG = /\[[^\]\n]{1,40}\]\s*/g
const speech = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined' ? speechSynthesis : null
speech?.getVoices()

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
 * @param deps - { api, el, toast, guard, getChat, getModels, openProviders, saveFile }
 */
export function initMedia({ api, el, toast, guard, getChat, getModels, openProviders, saveFile }) {
  const $ = id => document.getElementById(id)
  const state = {
    settings: null,
    cardId: null,
    cardMedia: { voice: '', narratorVoice: '', style: '', styleNegative: '', lora: '', loraTrigger: '', loraStrength: 0.8 },
    jobs: new Map(), // nodeId → { stage, chatId, controller, started, backend } of a picture in the works
    failures: new Map(), // nodeId → { stage, chatId, prompt, message } shown in place of the picture
    fresh: new Set(), // files just drawn: they come into focus once loaded
  }

  async function loadSettings() {
    try {
      state.settings = (await api('/api/media/settings')).media
    } catch {
      state.settings = null
    }
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
    const label = job?.stage === 'prompt' ? '写提示词…' : job ? '配图中…' : '配图'
    return [
      el('button', { text: label, disabled: Boolean(job), title: '辅助模型在后台描述这一幕，写好了弹出来让你确认，再交给生图模型', onclick: () => writePrompt(node) }),
      el('button', { text: '提示词库', disabled: Boolean(job), title: '用以前画过或存下的提示词给这段配图，可以先改再画', onclick: () => openLibrary({ node, chatId: getChat()?.id }) }),
      el('button', { class: reading ? 'on' : '', text: reading ? '停止朗读' : '朗读', title: '对白用角色音色，旁白用旁白音色。只想听某一句：直接点那句对白', onclick: () => (reading ? player.stop() : readNode(node)) }),
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
            el('button', { type: 'button', text: '重画', title: '同一段提示词再画一张（NovelAI 可以先选模型）', disabled: Boolean(job), onclick: event => withModel(event.currentTarget, model => draw(node, image.prompt, chat.id, model)) }),
            el('button', { type: 'button', text: '改提示词', disabled: Boolean(job), onclick: () => openImageDialog(node, image.prompt, { chatId: chat.id, note: '这张图的提示词，改完点「画」。' }) }),
            el('button', { type: 'button', text: '删除', onclick: () => removeImage(node, image) }),
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
    if (media.imageBackend === 'novelai') return `NovelAI ${media.naiModel.replace(/^nai-diffusion-(\d)-(\d)-/, 'V$1.$2 ').replace(/^nai-diffusion-(\d)-/, 'V$1 ')}`
    if (media.imageBackend === 'comfy') return 'ComfyUI'
    return media.imageModel
  }

  const elapsed = started => `${Math.max(0, Math.round((Date.now() - started) / 1000))} 秒`

  /** A blurred frame the size of the picture to come, with what is happening and for how long. */
  function pendingFigure(job) {
    const drawing = job.stage === 'draw'
    return el('figure', { class: `reply-image pending${drawing ? ' drawing' : ''}`, style: `--ratio: ${ratioOf()}`, 'aria-busy': 'true' }, [
      el('div', { class: 'pending-art' }, [
        el('div', { class: 'pending-mist' }),
        el('div', { class: 'pending-label', role: 'status' }, [
          el('span', { class: 'pending-dot' }),
          el('strong', { text: drawing ? '正在画' : '正在构思画面' }),
          el('span', { class: 'pending-meta' }, [
            drawing ? (job.backend ? `${job.backend} · ` : '') : '写提示词 · ',
            el('span', { class: 'pending-time', 'data-started': String(job.started), text: elapsed(job.started) }),
          ]),
        ]),
      ]),
      el('figcaption', {}, [el('button', { type: 'button', text: '取消', onclick: () => job.controller.abort() })]),
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
        el('strong', { text: drawing ? '没画出来' : '画面提示词没写出来' }),
        el('p', { text: failure.message }),
        el('div', { class: 'failed-actions' }, [
          el('button', { type: 'button', class: 'btn small', text: '重试', onclick: () => (drawing ? draw(node, failure.prompt, failure.chatId) : writePrompt(node)) }),
          drawing ? el('button', { type: 'button', class: 'btn small ghost', text: '改提示词', onclick: () => openImageDialog(node, failure.prompt, { chatId: failure.chatId, note: `没画出来：${failure.message}`, error: true }) }) : null,
          el('button', { type: 'button', class: 'btn small ghost', text: '关掉', onclick: dismiss }),
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
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`)
    return data
  }

  /**
   * Run one background step for a reply; the frame and button follow it. A
   * failure stays where the picture would have been, with its reason
   * (`prompt` is what a retry draws).
   */
  async function runJob(node, chatId, stage, work, { prompt = '', reveal = false } = {}) {
    if (state.jobs.has(node.id)) return null
    const job = { stage, chatId, controller: new AbortController(), started: Date.now(), backend: backendName() }
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
    const how = data.inContext ? `${data.model} 接着对话写的${data.cache !== null ? `（缓存命中 ${data.cache}%）` : ''}` : `${data.model} 写的`
    whenNoDialog(() => openImageDialog(node, data.prompt, { chatId, note: `${data.note ? `${data.note}` : ''}${how}，可以改，也可以「重写」。` }))
  }

  async function draw(node, prompt, chatId = getChat()?.id, model = '') {
    if (!chatId) return
    // The picture joins the reply before the frame is taken down, so it takes the frame's place.
    const work = async signal => {
      const data = await postJson(`/api/chats/${chatId}/nodes/${node.id}/image`, { prompt, ...(model ? { model } : {}) }, signal)
      if (data.image?.file) state.fresh.add(data.image.file)
      adopt(data.chat, node.id)
      return data
    }
    const data = await runJob(node, chatId, 'draw', work, { prompt, reveal: true })
    if (data?.image?.note) toast(data.image.note, 12000)
  }

  /** Show `open` once no other dialog is up, so a finished prompt never covers one. */
  function whenNoDialog(open) {
    // Polled rather than waiting for `close`: that event is not always delivered (hidden windows).
    if (!document.querySelector('dialog[open]')) return open()
    setTimeout(() => whenNoDialog(open), 400)
  }

  const removeImage = guard(async (node, image) => {
    if (!confirm('删除这张图？')) return
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

  // ─── Model for one picture (NovelAI) ─────────────────────────────────

  const isNovelAI = () => state.settings?.imageBackend === 'novelai'

  /** [value, label] with '' = the model in the settings. */
  function modelChoices() {
    const current = state.settings?.naiModel
    const name = NAI_MODELS.find(([value]) => value === current)?.[1] ?? current
    return [['', `默认：${name}`], ...NAI_MODELS.filter(([value]) => value !== current)]
  }

  /**
   * With NovelAI, a small menu under the button asks which model to draw this
   * one with; other backends go straight on.
   */
  function withModel(anchor, go) {
    if (!isNovelAI()) return go('')
    const open = anchor.parentElement.querySelector('.model-menu')
    if (open) return open.remove()
    const menu = el('div', { class: 'model-menu', role: 'menu' }, modelChoices().map(([value, text]) =>
      el('button', { type: 'button', role: 'menuitem', text, onclick: () => { close(); go(value) } })))
    const close = () => {
      menu.remove()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
    const outside = event => { if (!menu.contains(event.target) && event.target !== anchor) close() }
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); close() } }
    anchor.parentElement.classList.add('has-model-menu')
    anchor.after(menu)
    menu.style.left = `${anchor.offsetLeft}px`
    // Open upward when the scrolling area (or the window) ends below the button.
    let box = anchor.parentElement
    while (box && box !== document.body && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement
    const area = box && box !== document.body ? box.getBoundingClientRect() : null
    const floor = Math.min(window.innerHeight, area?.bottom ?? Infinity)
    if (menu.getBoundingClientRect().bottom > floor - 8) menu.classList.add('up')
    // Slide left when it would run past the right edge (a button near the right on a phone).
    const overflow = menu.getBoundingClientRect().right - (Math.min(window.innerWidth, area?.right ?? Infinity) - 8)
    if (overflow > 0) menu.style.left = `${anchor.offsetLeft - overflow}px`
    menu.querySelector('button').focus({ preventScroll: true })
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
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
    drawButton.disabled = !prompt.trim()
    box.oninput = () => { drawButton.disabled = !box.value.trim() }
    const modelSelect = $('image-model')
    modelSelect.hidden = !isNovelAI()
    if (isNovelAI()) modelSelect.replaceChildren(...modelChoices().map(([value, text]) => el('option', { value, text })))
    drawButton.onclick = () => {
      const text = box.value.trim()
      if (!text) return
      dialog.close()
      draw(node, text, chatId, modelSelect.hidden ? '' : modelSelect.value)
    }
    $('image-library').onclick = () => {
      dialog.close()
      openLibrary({ node, chatId })
    }
    $('image-keep').onclick = guard(async () => {
      const text = box.value.trim()
      if (!text) return
      await api('/api/prompts', { method: 'POST', body: { cardId: getChat()?.cardId, prompt: text } })
      toast('已存进提示词库（收藏在最前面）')
    })
    $('image-rewrite').onclick = () => {
      dialog.close()
      writePrompt(node)
    }
    $('image-settings').onclick = () => {
      dialog.close()
      openSettings()
    }
    dialog.showModal()
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
      ? '选一条给这段剧情配图：会先放进配图框，可以改了再画。'
      : '画过的图都会把提示词留在这里，删了对话也还在。'
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
    $('library-count').textContent = shown.length === total ? `${total} 条` : `${shown.length} / ${total} 条`
    for (const b of document.querySelectorAll('#library-dialog .seg button')) b.setAttribute('aria-pressed', String(b.dataset.scope === library.scope))
    const list = $('library-list')
    if (!shown.length) {
      list.replaceChildren(el('li', { class: 'library-empty', text: total ? '没有找到，换个词试试' : '还没有提示词。给剧情配过图之后，提示词会自动留在这里。' }))
      return
    }
    list.replaceChildren(...shown.map(entry => libraryRow(entry)))
  }

  function libraryRow(entry) {
    const when = entry.at ? new Date(entry.at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''
    const meta = [
      library.scope === 'all' ? entry.cardName : '',
      entry.chatTitle,
      when,
      entry.drawn > 1 ? `画过 ${entry.drawn} 次` : entry.drawn === 0 ? '手动存的' : '',
    ].filter(Boolean)
    const text = el('p', { class: 'library-prompt', text: entry.prompt, title: '点开看全文' })
    text.addEventListener('click', () => text.classList.toggle('open'))
    const star = el('button', {
      type: 'button',
      class: `library-star${entry.starred ? ' on' : ''}`,
      'aria-pressed': String(entry.starred),
      'aria-label': '收藏',
      title: entry.starred ? '取消收藏' : '收藏（排在最前面）',
      text: entry.starred ? '★' : '☆',
      onclick: guard(async () => {
        Object.assign(entry, await api(`/api/prompts/${entry.id}`, { method: 'PUT', body: { starred: !entry.starred } }))
        renderLibrary()
      }),
    })
    return el('li', { class: 'library-row' }, [
      entry.hasImage
        ? el('img', { class: 'library-thumb', src: `/api/prompts/${entry.id}/image`, alt: '', loading: 'lazy', decoding: 'async' })
        : el('span', { class: 'library-thumb none', 'aria-hidden': 'true', text: '无图' }),
      el('div', { class: 'library-main' }, [
        text,
        el('p', { class: 'library-meta', text: meta.join('　') }),
      ]),
      el('div', { class: 'library-actions' }, [
        star,
        library.target
          ? el('button', { type: 'button', class: 'btn small primary', text: '用这条', onclick: () => useEntry(entry) })
          : el('button', { type: 'button', class: 'btn small', text: '复制', onclick: () => copyEntry(entry) }),
        el('button', {
          type: 'button',
          class: 'btn small ghost danger',
          text: '删除',
          title: '从提示词库删掉（对话里的图不受影响）',
          onclick: guard(async () => {
            if (!confirm('从提示词库删掉这条？对话里的图不受影响。')) return
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
    openImageDialog(node, entry.prompt, { chatId, note: `来自提示词库${entry.chatTitle ? `（${entry.chatTitle}）` : ''}，可以改了再画。` })
  }

  async function copyEntry(entry) {
    try {
      await navigator.clipboard.writeText(entry.prompt)
      toast('已复制')
    } catch {
      toast('复制不了，点开全文手动选中复制')
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
    if (!shown.length) return toast('没有可导出的提示词')
    const text = shown.map(e => `## ${e.title || e.chatTitle || e.cardName}${e.at ? `（${new Date(e.at).toLocaleString('zh-CN')}）` : ''}\n${e.prompt}`).join('\n\n')
    const name = library.scope === 'card' ? shown[0].cardName : '全部'
    saveFile(`提示词库-${name}.txt`, `${text}\n`, `导出了 ${shown.length} 条`)
  })

  // ─── Voice ────────────────────────────────────────────────────────────

  /** Read in the page: a browser voice, or no voice on a tavern without a voice service. */
  const spokenHere = chunk => Boolean(chunk?.voice?.startsWith(BROWSER) || (chunk && !chunk.voice && !state.settings?.ttsUrl))

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

    start(nodeId, queue, line = null) {
      this.stop()
      this.nodeId = nodeId
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
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `朗读失败（${res.status}）`)
          return URL.createObjectURL(await res.blob())
        })
        promise.catch(() => {})
        this.fetched.set(i, promise)
      }
      return this.fetched.get(i)
    },

    async play() {
      const i = this.index
      if (i >= this.queue.length) return this.stop()
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
        toast(`浏览器没让播放：${error.message}`)
        this.stop()
      })
    },

    /** One block in a browser voice; the next one starts when it ends. */
    speakHere(i, signal) {
      this.mode = 'browser'
      if (!speech) {
        toast('这个浏览器不能朗读：换 Edge 或 Chrome 打开，或者在「配图与朗读」里填一个语音服务', 8000)
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
        toast(`浏览器朗读出错：${event.error}`)
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
      if (!this.nodeId) {
        bar.hidden = true
        return
      }
      bar.hidden = false
      const chunk = this.queue[this.index]
      $('player-toggle').textContent = this.paused ? '继续' : '暂停'
      $('player-toggle').disabled = loading
      $('player-redo').disabled = loading
      $('player-count').textContent = `${Math.min(this.index + 1, this.queue.length)}/${this.queue.length}`
      $('player-text').textContent = loading ? '合成中…' : chunk ? `${chunk.kind === 'dialogue' ? '对白' : '旁白'}：${chunk.text}` : ''
    },
  }

  function readNode(node) {
    const { voice, narratorVoice } = state.cardMedia
    // Emotions go before their lines as [tags]; the server keeps them only for voices that act on them (Fish).
    const chunks = speechChunks(shownText(node), { narration: Boolean(narratorVoice), tags: true })
    if (!chunks.length) return toast('这一段没有能读的文字')
    if (!narratorVoice && !state.warnedNarrator) {
      state.warnedNarrator = true
      toast('旁白还没选音色，这次只读对白。在「配图与朗读」里给这张卡选旁白音色。', 6000)
    }
    player.start(node.id, chunks.map(chunk => ({
      ...chunk,
      voice: chunk.kind === 'dialogue' ? voice : narratorVoice,
      // Narration is long and even: the bridge's steady mode keeps one voice across blocks.
      stable: chunk.kind === 'narration',
    })))
  }

  /** One line of dialogue, clicked in the reply: read on its own in the character's voice. */
  function readLine(span) {
    const nodeId = span.closest('.msg[data-id]')?.dataset.id
    if (!nodeId) return
    if (player.line === span) return player.stop()
    const chunks = speechChunks(span.innerText + voiceTagFor(span), { narration: false, tags: true })
    if (!chunks.length) return toast('这句没有能读的文字')
    player.start(nodeId, chunks.map(chunk => ({ ...chunk, voice: state.cardMedia.voice, stable: false })), span)
  }

  document.addEventListener('click', event => {
    const span = event.target.closest?.('#transcript .msg[data-id] .story .q')
    // Selecting text or picking an option is not a request to hear it.
    if (!span || span.closest('.choice') || String(getSelection?.() ?? '').trim()) return
    readLine(span)
  })

  /** After a new reply: read it and/or draw it, if switched on. */
  async function afterTurn(nodeId) {
    const node = getChat()?.path.find(n => n.id === nodeId)
    if (!node || !state.settings) return
    if (state.settings.autoRead) readNode(node)
    if (state.settings.autoImage) writePrompt(node, { auto: true })
  }

  // ─── Settings ─────────────────────────────────────────────────────────

  const openSettings = guard(async () => {
    const [{ media, workflow, novelai, voiceKey }, providers, voiceInfo, loraInfo, browserVoices] = await Promise.all([
      api('/api/media/settings'),
      api('/api/providers'),
      api('/api/media/voices'),
      api('/api/media/loras'),
      loadBrowserVoices(),
    ])
    state.settings = media
    const card = state.cardId ? await api(`/api/cards/${state.cardId}/media`) : null
    renderSettings({ media, workflow, novelai, voiceKey, providers: providers.providers, voiceInfo, loraInfo, card, browserVoices })
    if (!$('media-dialog').open) $('media-dialog').showModal()
  })

  function renderSettings({ media, workflow, novelai, voiceKey, providers, voiceInfo, loraInfo, card, browserVoices = [] }) {
    const form = $('media-form')
    const option = (value, text, selected) => el('option', { value, text, selected: value === selected })
    const field = (label, control, hint) => el('label', {}, [label, control, hint ? el('span', { class: 'hint', text: hint }) : null])

    // Pictures
    const backend = el('select', { name: 'imageBackend' }, [
      option('openai', 'OpenAI 兼容图片接口（grok2api 等）', media.imageBackend),
      option('comfy', 'ComfyUI 工作流', media.imageBackend),
      option('novelai', 'NovelAI', media.imageBackend),
    ])
    const imageProviders = providers.filter(p => p.api !== 'anthropic-messages')
    const provider = el('select', { name: 'imageProvider' }, [option('', imageProviders.length ? '选一个供应商' : '先在「供应商」里添加', media.imageProvider), ...imageProviders.map(p => option(p.id, p.name, media.imageProvider))])
    const modelList = el('datalist', { id: 'image-models' })
    const model = el('input', { name: 'imageModel', value: media.imageModel, list: 'image-models', placeholder: '例如 grok-imagine-image-2.0', spellcheck: 'false' })
    const fetchModels = el('button', { type: 'button', class: 'btn small', text: '获取' })
    fetchModels.onclick = guard(async () => {
      if (!provider.value) throw new Error('先选供应商')
      const { models } = await api('/api/providers/models', { method: 'POST', body: { id: provider.value } })
      const images = models.filter(id => IMAGE_MODEL.test(id))
      modelList.replaceChildren(...(images.length ? images : models).map(id => el('option', { value: id })))
      toast(images.length ? `找到 ${images.length} 个生图模型，点输入框选` : `没认出生图模型，列出了全部 ${models.length} 个`)
      model.focus()
    })
    const size = el('select', { name: 'imageShape' }, SHAPES.map(([value, text]) => option(value, text, media.imageShape)))
    const reference = el('input', { type: 'checkbox', name: 'imageReference', checked: media.imageReference })
    const editModel = el('input', { name: 'imageEditModel', value: media.imageEditModel, list: 'image-models', placeholder: '同上（和生图模型一样）', spellcheck: 'false' })
    const comfyUrl = el('input', { name: 'comfyUrl', value: media.comfyUrl, spellcheck: 'false' })
    const workflowInfo = el('span', { class: 'hint', text: workflowText(workflow) })
    const workflowInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true })
    workflowInput.onchange = guard(async () => {
      const file = workflowInput.files[0]
      workflowInput.value = ''
      if (!file) return
      let json
      try {
        json = JSON.parse(await file.text())
      } catch {
        throw new Error('工作流文件不是 JSON')
      }
      const { workflow: info } = await api('/api/media/workflow', { method: 'PUT', body: { workflow: json } })
      workflowInfo.textContent = workflowText(info)
      toast('工作流已导入')
    })
    const helperChoices = getModels().filter(m => m.id.includes('/'))
    const helper = el('select', { name: 'helperModel' }, [
      option('', '跟随对话的模型（要是供应商的模型）', media.helperModel),
      ...helperChoices.map(m => option(m.id, `${m.group} · ${m.label}`, media.helperModel)),
    ])
    const promptSource = el('select', { name: 'promptSource' }, [
      option('helper', '辅助模型单独写（快、便宜）', media.promptSource),
      option('chat', '接着对话写（同一个模型，命中缓存，更贴合剧情）', media.promptSource),
    ])
    const promptStyle = el('select', { name: 'promptStyle' }, [option('natural', '自然语言（grok、gpt-image、Flux、NovelAI V5）', media.promptStyle), option('tags', '标签（SD / SDXL 工作流、NovelAI）', media.promptStyle)])
    const autoImage = el('input', { type: 'checkbox', name: 'autoImage', checked: media.autoImage })

    const openaiBox = el('div', { class: 'grid' }, [
      field('供应商', provider),
      el('label', {}, ['生图模型', el('span', { class: 'select-with-action' }, [model, fetchModels]), modelList]),
    ])
    const comfyBox = el('div', {}, [
      field('ComfyUI 地址', comfyUrl),
      el('div', { class: 'workflow-row' }, [
        el('button', { type: 'button', class: 'btn small', text: '导入工作流', onclick: () => workflowInput.click() }),
        workflowInput,
        workflowInfo,
      ]),
      el('p', { class: 'hint', text: '在 ComfyUI 里把正向提示词写成 {{prompt}}，种子、宽、高写成 {{seed}} {{width}} {{height}}，要参考图就在 LoadImage 里写 {{reference}}（会上传这张卡的头像），然后「导出（API）」。' }),
    ])
    const naiTokenHint = el('span', { class: 'hint nai-token-hint' })
    const showNaiToken = info => naiTokenText(naiTokenHint, info)
    showNaiToken(novelai)
    const naiToken = el('input', { name: 'naiToken', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: novelai?.hasToken ? '留空不改' : 'pst-…' })
    const checkNai = el('button', { type: 'button', class: 'btn small', text: '检查' })
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
      naiAllowance.textContent = '正在查 V5 额度…'
      api('/api/media/novelai/check', { method: 'POST', body: { token: '' } }).then(showAllowance, error => { naiAllowance.textContent = `查不到额度：${error.message}` })
    }
    const clearNai = el('button', { type: 'button', class: 'btn small ghost', text: '删除令牌' })
    clearNai.onclick = guard(async () => {
      const { novelai: info } = await api('/api/media/settings', { method: 'PUT', body: { naiClearToken: true } })
      showNaiToken(info)
      toast('已删除 NovelAI 令牌')
    })
    const naiModel = el('select', { name: 'naiModel' }, [
      ...NAI_MODELS.map(([value, text]) => option(value, text, media.naiModel)),
      NAI_MODELS.some(([value]) => value === media.naiModel) ? null : option(media.naiModel, media.naiModel, media.naiModel),
    ].filter(Boolean))
    const naiBox = el('div', {}, [
      el('label', {}, ['NovelAI 持久令牌', el('span', { class: 'select-with-action' }, [naiToken, checkNai, clearNai]), naiTokenHint]),
      el('p', { class: 'hint', text: '在 NovelAI 网页点左下角齿轮 →「Account」→「Get Persistent API Token」，复制后粘贴到这里再保存。「检查」只查订阅、V5 额度和 Anlas，不画图。' }),
      el('label', {}, ['模型', naiModel, naiAllowance]),
      field('V5 额度用完时', el('select', { name: 'naiV5Empty' }, [
        option('v45', '改用 V4.5 画（Opus 不扣 Anlas）', media.naiV5Empty ?? 'v45'),
        option('anlas', '继续用 V5，扣 Anlas', media.naiV5Empty ?? 'v45'),
      ]), 'Opus 的 V5 有一份额度，每小时回一点，用完后 NovelAI 改扣 Anlas。每次画 V5 前先查一下：剩 10% 以下时图下面会提醒，用完时按这里处理。'),
      el('label', { class: 'check-row' }, [
        el('input', { type: 'checkbox', name: 'naiReference', checked: media.naiReference }),
        el('span', { text: '画面里只有一个名册角色（或者除了主角只有一个）、而且她有人设图时，照人设图画（自动改用 V4.5，每张多扣 5 Anlas，不够时这张不带；V5 还不支持人设图）' }),
      ]),
      el('div', { class: 'grid' }, [
        field('人设图还原度', el('input', { name: 'naiRefFidelity', type: 'range', min: '0', max: '1', step: '0.05', value: String(media.naiRefFidelity) }), '越高越像人设图，越低越听提示词'),
        el('label', { class: 'check-row' }, [el('input', { type: 'checkbox', name: 'naiRefStyle', checked: media.naiRefStyle }), el('span', { text: '连画风一起参考' })]),
      ]),
      field('质量词（加在每张提示词后面）', el('input', { name: 'naiQuality', value: media.naiQuality, spellcheck: 'false' })),
      field('负面提示词', el('textarea', { name: 'naiNegative', rows: 3, spellcheck: 'false', text: media.naiNegative })),
      el('p', { class: 'hint', text: '尺寸和步数都在 Opus 的免费范围内（不超过 1024×1024 像素、23 步）：V4.5 不限量，V5 用上面那份额度，都不扣 Anlas。走「设置」里的代理。' }),
    ])
    const syncBackend = () => {
      openaiBox.hidden = backend.value !== 'openai'
      referenceRow.hidden = backend.value !== 'openai'
      comfyBox.hidden = backend.value !== 'comfy'
      naiBox.hidden = backend.value !== 'novelai'
      readAllowance()
    }
    backend.onchange = syncBackend
    const referenceRow = el('div', {}, [
      el('label', { class: 'check-row' }, [reference, el('span', { text: '用这张卡的头像当参考图（走 /images/edits，长相更稳定）' })]),
      field('参考图用的模型', editModel, '有的网关生图和改图是两个模型：grok2api 只有 Web 账号时，2.0 只能生图，改图要用 grok-imagine-image-edit。改图失败时这张会自动不带参考图再画。'),
    ])
    const syncReference = () => { editModel.closest('label').hidden = !reference.checked }
    reference.onchange = syncReference

    // Voice
    // Only this machine's own install assumes the xiaoya bridge; elsewhere the browser reads unless a service is set up.
    const xiaoya = document.documentElement.dataset.featureXiaoya !== 'false'
    const service = Boolean(media.ttsUrl)
    const voices = voiceInfo.voices ?? []
    const chinese = browserVoices.filter(v => /^zh/i.test(v.lang))
    const ttsUrl = el('input', { name: 'ttsUrl', value: media.ttsUrl, spellcheck: 'false', placeholder: xiaoya ? '' : '不填就用浏览器朗读' })
    const ttsStatus = el('span', {
      class: voiceInfo.ok || !service ? 'hint' : 'hint warn',
      text: !service
        ? speech ? `没填语音服务：用浏览器自带的音色朗读（这台设备有 ${chinese.length} 个中文音色）` : '没填语音服务，这个浏览器也不能朗读'
        : voiceInfo.ok ? `已连上${voiceInfo.remote ? '（经电脑上的酒馆）' : ''}，${voices.length} 个音色` : voiceInfo.error,
    })
    const ttsKeyHint = el('span', { class: 'hint tts-key-hint' })
    voiceKeyText(ttsKeyHint, voiceKey)
    const autoRead = el('input', { type: 'checkbox', name: 'autoRead', checked: media.autoRead })
    // The service's own voices, cloud voices it can call by name (billed per character), then this device's browser voices.
    const cloud = voiceInfo.cloud ?? []
    const browserLabel = v => `${v.name.replace(/^Microsoft /, '')}${v.localService ? '' : '（在线）'}`
    const groups = [
      voices.length ? [xiaoya ? '本机音色' : '语音服务的音色', voices.map(v => [v, v])] : null,
      cloud.length ? ['云端音色（按字数计费）', cloud.map(v => [v.name, `${v.label}（${v.provider.replace(/ · 云端$/, '')} · ${v.model}）`])] : null,
      chinese.length ? ['浏览器音色（这台设备自带，免费）', chinese.map(v => [`${BROWSER}${v.name}`, browserLabel(v)])] : null,
    ].filter(Boolean)
    const known = new Set(groups.flatMap(([, list]) => list.map(([value]) => value)))
    const missing = value => (value.startsWith(BROWSER) ? `${value.slice(BROWSER.length)}（这台设备没有，用默认中文音色）` : `${value}（现在没有）`)
    const voiceSelect = (name, value, empty) =>
      el('select', { name }, [
        option('', empty, value),
        ...(groups.length > 1
          ? groups.map(([label, list]) => el('optgroup', { label }, list.map(([v, text]) => option(v, text, value))))
          : groups.flatMap(([, list]) => list.map(([v, text]) => option(v, text, value)))),
        value && !known.has(value) ? option(value, missing(value), value) : null,
      ].filter(Boolean))
    const dialogueDefault = service ? `语音服务当前的音色${voiceInfo.current ? `（${voiceInfo.current}）` : ''}` : '浏览器默认中文音色'
    const narratorHint = cloud.length
      ? xiaoya ? '云端音色用小雅「云端 API 设置」里的密钥和模型，按字数计费；旁白字多，留本机音色更省' : '云端音色按字数计费；旁白字多，用本机或浏览器音色更省'
      : chinese.length ? '浏览器音色是这台设备自带的，免费；换一台设备可能没有同一个，会改用它的默认中文音色。' : undefined
    const ttsHint = xiaoya
      ? '电脑上填小雅语音桥接（http://127.0.0.1:8765）。手机上没有语音服务：把电脑上酒馆「设置 → 局域网访问」里的链接整条粘贴进来，手机和电脑在同一个 Wi-Fi 时借电脑的小雅读（电脑要开着酒馆和小雅）。'
      : '可选。不填就用浏览器自带的音色读（Edge 里的「Xiaoxiao Online (Natural)」这类在线音色效果最好）。填了就用这个语音服务：兼容 /api/tts 和 /api/persona/list 的服务都行；也可以把另一台电脑上酒馆「设置 → 手机访问」里的链接整条粘贴进来，借那台电脑的语音服务。'

    const cardSection = card
      ? el('fieldset', { class: 'media-group' }, [
          el('legend', { text: `当前角色卡：${getChat()?.names?.char ?? ''}` }),
          el('div', { class: 'grid' }, [
            field('对白音色', voiceSelect('voice', card.voice, dialogueDefault), cloud.some(v => v.tags) ? '回复里 [voice:情绪:台词] 的情绪，用 Fish 读时会放在台词前当语气提示' : undefined),
            field('旁白音色', voiceSelect('narratorVoice', card.narratorVoice, '不读旁白'), narratorHint),
          ]),
          field('画风（写进画面提示词；NovelAI 每张都加，人设图也是）', el('textarea', { name: 'style', rows: 2, text: card.style ?? '', placeholder: '例如 anime style, delicate lineart, soft cel shading, soft lighting' })),
          field('画风负面（只用于 NovelAI，加在负面提示词后面）', el('input', { name: 'styleNegative', value: card.styleNegative ?? '', placeholder: '例如 realistic, 3d, chibi' })),
          field(
            '整卡 LoRA（只用于 ComfyUI；名册认出人物时改用她自己的）',
            el('select', { name: 'lora' }, [
              option('', '不用', card.lora),
              ...loraInfo.loras.map(name => option(name, name, card.lora)),
              card.lora && !loraInfo.loras.includes(card.lora) ? option(card.lora, `${card.lora}（ComfyUI 里现在没有）`, card.lora) : null,
            ].filter(Boolean)),
            loraInfo.ok ? '画这张卡时自动在工作流的 Load Checkpoint 后面接上它，并把触发词放在提示词最前面。' : 'ComfyUI 没开，列不出 LoRA 文件；开着 ComfyUI 再打开这里。',
          ),
          el('div', { class: 'grid' }, [
            field('触发词', el('input', { name: 'loraTrigger', value: card.loraTrigger, placeholder: '例如 linxue', spellcheck: 'false' })),
            field('强度', el('input', { name: 'loraStrength', type: 'number', min: '0', max: '2', step: '0.05', value: String(card.loraStrength) })),
          ]),
          rosterEditor(card, loraInfo, getChat()?.names?.user ?? ''),
        ])
      : el('p', { class: 'muted small', text: '选一张角色卡后，可以给它单独设音色和画风。' })

    form.replaceChildren(
      el('h2', { text: '配图与朗读' }),
      el('p', { class: 'muted small', text: '都是点了才做，不进模型的上下文，也不影响缓存。' }),
      el('fieldset', { class: 'media-group' }, [
        el('legend', { text: '配图' }),
        el('div', { class: 'grid' }, [field('画图用', backend), field('画幅', size, '图片接口：1024×1024 / 1024×1536 / 1536×1024；ComfyUI 和 NovelAI：1024×1024 / 832×1216 / 1216×832')]),
        openaiBox,
        referenceRow,
        comfyBox,
        naiBox,
        field('画面提示词怎么写', promptSource, '「接着对话写」把固定前缀和这段对话原样发给写这段剧情的模型，再追加一句要提示词：几乎全部命中缓存，人物现在穿什么、在哪都对得上，但用的是对话模型的价格和速度。订阅模型写的剧情借不了，会自动改用辅助模型。'),
        el('div', { class: 'grid' }, [
          field('辅助模型', helper, helperChoices.length ? '' : '还没有供应商的模型'),
          field('提示词写法', promptStyle),
        ]),
        el('label', { class: 'check-row' }, [autoImage, el('span', { text: '新回复自动配图（每轮多一次辅助模型调用和一次生图）' })]),
      ]),
      el('fieldset', { class: 'media-group' }, [
        el('legend', { text: '朗读' }),
        field('语音服务地址', ttsUrl, ttsHint),
        ttsStatus,
        ttsKeyHint,
        el('label', { class: 'check-row' }, [autoRead, el('span', { text: '新回复自动朗读' })]),
      ]),
      cardSection,
      el('div', { class: 'row between' }, [
        el('button', { type: 'button', class: 'btn ghost', text: '管理供应商', onclick: () => openProviders() }),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn', value: 'cancel', text: '关闭' }),
          el('button', { type: 'button', class: 'btn primary', text: '保存', onclick: () => save(form, Boolean(card)) }),
        ]),
      ]),
    )
    syncBackend()
    syncReference()
  }

  // ─── Cast (角色名册) ────────────────────────────────────────────────
  // Who can appear in this card's pictures: fixed looks, an optional reference
  // picture each, one entry may be the player. Saved with the card settings;
  // reference pictures upload at once.

  const KIND_TEXT = [['girl', '女'], ['boy', '男'], ['other', '其他']]
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

  /** The roster as the form shows it now. */
  function collectRoster(form) {
    return [...form.querySelectorAll('.roster-entry')].map(readEntry)
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
      el('p', { class: 'hint', text: '名册里的人，长相按这里写的固定 tag 画，辅助模型只写谁在画面里、穿什么、在做什么。多人同框时每人单独成段，不会串。外貌和衣着用英文 tag。' }),
      list,
    ])
    const option = (value, text, selected) => el('option', { value, text, selected: value === selected })

    function entryBox(entry) {
      const thumb = el('div', { class: 'roster-thumb', title: '点击放大' }, entry.ref ? [el('img', { src: refUrl(cardId, entry.id), alt: '' })] : [el('span', { text: '没有人设图' })])
      thumb.onclick = () => {
        const img = thumb.querySelector('img')
        if (!img) return
        const current = readEntry(node)
        viewPicture(img.src, `${current.name}：${current.looks}${current.outfit ? `；${current.outfit}` : ''}`, '人设图')
      }
      const node = el('fieldset', { class: 'roster-entry', 'data-id': entry.id, 'data-ref': entry.ref ? '1' : '' })
      const setRef = has => {
        node.dataset.ref = has ? '1' : ''
        thumb.replaceChildren(has ? el('img', { src: refUrl(cardId, entry.id), alt: '' }) : el('span', { text: '没有人设图' }))
        removeRef.hidden = !has
      }
      const upload = guard(async blob => {
        thumb.replaceChildren(el('span', { text: '处理中…' }))
        try {
          await api(`/api/cards/${cardId}/roster/${entry.id}/ref`, { method: 'PUT', body: { image: await padForReference(blob) } })
        } catch (error) {
          setRef(node.dataset.ref === '1')
          throw error
        }
        setRef(true)
        toast('人设图已上传，保存后生效')
      })
      const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true })
      file.onchange = () => {
        const chosen = file.files[0]
        file.value = ''
        if (chosen) upload(chosen)
      }
      const fromAvatar = guard(async () => {
        const res = await fetch(`/api/cards/${cardId}/avatar`)
        if (!res.ok) throw new Error('这张卡没有头像')
        await upload(await res.blob())
      })
      const portrait = el('button', { type: 'button', class: 'btn small ghost', text: '画一张', title: '用现在的生图后端，按长相和平时衣着画一张半身像当人设图（NovelAI 在 Opus 免费范围内）' })
      portrait.onclick = event => withModel(event.currentTarget, model => drawPortrait(model))
      const drawPortrait = guard(async model => {
        const current = readEntry(node)
        portrait.disabled = true
        thumb.replaceChildren(el('span', { text: '正在画…' }))
        try {
          const { image } = await api(`/api/cards/${cardId}/roster/portrait`, { method: 'POST', body: { entry: current, ...(model ? { model } : {}) } })
          await upload(await (await fetch(image)).blob())
        } catch (error) {
          setRef(node.dataset.ref === '1')
          throw error
        } finally {
          portrait.disabled = false
        }
      })
      const removeRef = el('button', { type: 'button', class: 'btn small ghost', text: '删人设图', hidden: !entry.ref })
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
      const name = el('input', { 'data-field': 'name', value: entry.name, placeholder: entry.player ? '主角' : '名字', maxlength: '40' })
      name.oninput = syncSummary
      const loras = loraInfo.loras ?? []
      node.append(
        el('div', { class: 'roster-head' }, [
          thumb,
          el('div', { class: 'roster-main' }, [
            el('div', { class: 'roster-row' }, [
              name,
              el('select', { 'data-field': 'kind' }, KIND_TEXT.map(([value, text]) => option(value, text, entry.kind))),
              el('label', { class: 'check-row', title: `玩家扮演的角色；剧情里叫「${userName || '玩家'}」时也认得` }, [player, el('span', { text: '主角' })]),
              el('button', { type: 'button', class: 'btn small ghost danger', text: '移除', onclick: () => { node.remove(); syncSummary() } }),
            ]),
            el('input', { 'data-field': 'aliases', value: entry.aliases, placeholder: '别称，用逗号分开（例如 念念, 小师妹）' }),
            el('div', { class: 'roster-row' }, [
              el('button', { type: 'button', class: 'btn small', text: '上传人设图', onclick: () => file.click() }),
              el('button', { type: 'button', class: 'btn small ghost', text: '用卡头像', onclick: fromAvatar }),
              portrait,
              removeRef,
              file,
            ]),
          ]),
        ]),
        el('label', {}, ['长相（固定不变的：发型发色、眼睛、身形、记号）', el('textarea', { 'data-field': 'looks', rows: 2, spellcheck: 'false', placeholder: 'black hair, hair bun, white ribbon, dark eyes, dimples, petite', text: entry.looks })]),
        el('label', {}, ['平时的衣着（辅助模型据此写当下穿什么）', el('input', { 'data-field': 'outfit', value: entry.outfit, spellcheck: 'false', placeholder: 'white and pale blue wudang robe, wide sleeves' })]),
        el('div', { class: 'grid three' }, [
          el('label', {}, [
            'LoRA（ComfyUI，单人画面用）',
            el('select', { 'data-field': 'lora' }, [
              option('', '不用', entry.lora),
              ...loras.map(n => option(n, n, entry.lora)),
              entry.lora && !loras.includes(entry.lora) ? option(entry.lora, `${entry.lora}（现在没有）`, entry.lora) : null,
            ].filter(Boolean)),
          ]),
          el('label', {}, ['触发词', el('input', { 'data-field': 'loraTrigger', value: entry.loraTrigger, spellcheck: 'false' })]),
          el('label', {}, ['强度', el('input', { 'data-field': 'loraStrength', type: 'number', min: '0', max: '2', step: '0.05', value: String(entry.loraStrength ?? 0.8) })]),
        ]),
      )
      return node
    }

    function syncSummary() {
      const entries = list.querySelectorAll('.roster-entry')
      const hasPlayer = [...list.querySelectorAll('[data-field="player"]')].some(input => input.checked)
      summary.textContent = `角色名册（${entries.length} 人${entries.length && !hasPlayer ? '，还没有主角' : ''}）`
    }

    const blank = extra => ({ id: newEntryId(), name: '', aliases: '', kind: 'girl', player: false, looks: '', outfit: '', lora: '', loraTrigger: '', loraStrength: 0.8, ref: false, ...extra })
    const add = entry => {
      list.append(entryBox(entry))
      syncSummary()
    }
    const draft = guard(async () => {
      draftButton.disabled = true
      status.textContent = '辅助模型在读卡和世界书，可能要一两分钟…'
      try {
        const { roster, model } = await api(`/api/cards/${cardId}/roster/draft`, { method: 'POST', body: {} })
        const have = new Set(collectRoster($('media-form')).map(e => e.name.trim()))
        const hasPlayer = collectRoster($('media-form')).some(e => e.player)
        const fresh = roster.filter(e => !have.has(e.name.trim())).map(e => ({ ...e, player: e.player && !hasPlayer, ref: false }))
        fresh.forEach(add)
        box.open = true
        status.textContent = fresh.length ? `${model} 起草了 ${fresh.length} 个角色，看过、改好再保存。` : `${model} 列出的角色名册里都有了。`
      } catch (error) {
        status.textContent = ''
        throw error
      } finally {
        draftButton.disabled = false
      }
    })
    const draftButton = el('button', { type: 'button', class: 'btn small', text: '让辅助模型起草', title: '读这张卡的描述和世界书，列出主要角色和主角的长相、衣着', onclick: draft })
    box.append(
      el('div', { class: 'roster-actions' }, [
        el('button', { type: 'button', class: 'btn small', text: '添加角色', onclick: () => add(blank()) }),
        el('button', { type: 'button', class: 'btn small', text: '添加主角', onclick: () => add(blank({ player: !collectRoster($('media-form')).some(e => e.player), name: '主角', kind: 'boy' })) }),
        draftButton,
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
    const parts = [`${info.tier}${info.active ? '' : '（已过期）'}`]
    if (info.v5) {
      const v5 = info.v5
      const next = v5.nextPercentMinutes ? `，${v5.nextPercentMinutes >= 60 ? `${Math.round(v5.nextPercentMinutes / 6) / 10} 小时` : `${v5.nextPercentMinutes} 分钟`}后回 1%` : ''
      parts.push(v5.empty ? `V5 额度用完了${next}` : `V5 额度 ${v5.percent}%${v5.purchasedPercent ? ` + 买的 ${v5.purchasedPercent}%` : ''}${next}`)
    }
    parts.push(`${info.anlas} Anlas`)
    if (info.renewsAt) {
      const at = new Date(info.renewsAt)
      parts.push(`${at.getMonth() + 1}月${at.getDate()}日 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} 续期（Anlas 补满）`)
    }
    if (info.tier !== 'Opus') parts.push('不是 Opus，每张都扣 Anlas')
    return parts.join(' · ')
  }

  function voiceKeyText(hint, info) {
    hint.hidden = !info?.hasKey
    hint.textContent = info?.hasKey ? `已保存电脑上酒馆的访问口令（${info.keyHint}），只存在本机服务端；换地址时一起清掉。` : ''
  }

  function naiTokenText(hint, info) {
    hint.classList.toggle('warn', !info?.hasToken)
    hint.textContent = info?.hasToken ? `已保存（${info.tokenHint}）。只存在本机服务端，留空就不改。` : '还没填令牌'
  }

  function workflowText(info) {
    if (!info) return '还没导入工作流'
    return `已导入：${info.nodes} 个节点，占位符 ${info.placeholders.map(p => `{{${p}}}`).join(' ')}`
  }

  const save = guard(async (form, hasCard) => {
    const value = name => form.elements[name]?.value ?? ''
    const checked = name => Boolean(form.elements[name]?.checked)
    const before = state.settings?.ttsUrl
    const pastedKey = /#k=/.test(value('ttsUrl'))
    const { media, novelai, voiceKey } = await api('/api/media/settings', {
      method: 'PUT',
      body: {
        imageBackend: value('imageBackend'),
        imageProvider: value('imageProvider'),
        imageModel: value('imageModel'),
        imageShape: value('imageShape'),
        imageReference: checked('imageReference'),
        imageEditModel: value('imageEditModel'),
        comfyUrl: value('comfyUrl'),
        naiModel: value('naiModel'),
        naiQuality: value('naiQuality'),
        naiReference: checked('naiReference'),
        naiRefFidelity: Number(value('naiRefFidelity') || 0.8),
        naiRefStyle: checked('naiRefStyle'),
        naiV5Empty: value('naiV5Empty'),
        naiNegative: value('naiNegative'),
        naiToken: value('naiToken').trim(),
        helperModel: value('helperModel'),
        promptStyle: value('promptStyle'),
        promptSource: value('promptSource'),
        autoImage: checked('autoImage'),
        ttsUrl: value('ttsUrl'),
        autoRead: checked('autoRead'),
      },
    })
    state.settings = media
    const keyHint = form.querySelector('.tts-key-hint')
    if (keyHint) voiceKeyText(keyHint, voiceKey)
    if (form.elements.ttsUrl) form.elements.ttsUrl.value = media.ttsUrl
    if (form.elements.naiToken) form.elements.naiToken.value = ''
    if (novelai?.hasToken && form.elements.naiToken) form.elements.naiToken.placeholder = '留空不改'
    const hint = form.querySelector('.nai-token-hint')
    if (hint) naiTokenText(hint, novelai)
    if (hasCard && state.cardId) {
      state.cardMedia = await api(`/api/cards/${state.cardId}/media`, {
        method: 'PUT',
        body: { voice: value('voice'), narratorVoice: value('narratorVoice'), style: value('style'), styleNegative: value('styleNegative'), lora: value('lora'), loraTrigger: value('loraTrigger'), loraStrength: Number(value('loraStrength') || 0.8), roster: collectRoster(form) },
      })
    }
    toast('已保存')
    // A new voice service has its own voices: show them.
    if (media.ttsUrl !== before || pastedKey) openSettings()
  })

  $('player-redo').addEventListener('click', () => player.redo())
  $('player-toggle').addEventListener('click', () => player.toggle())
  $('player-stop').addEventListener('click', () => player.stop())
  loadSettings()

  return { openLibrary, toolsFor: mediaTools, gallery, openSettings, setCard, afterTurn, stopReading: () => player.stop() }
}
