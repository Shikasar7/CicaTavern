// 定制外观的图 in the page (server/look-pictures.mjs): what a look may name on a saved card, the small copies of the
// card's own pictures a look uses (made here, where there is a canvas), and 画装饰图 (drawn on the server with the
// player's image setup, the white cut away and made small here, then kept).
import { t } from '/i18n.js'
import { DECOR_SLOTS, lookTokensUsed } from '/shared/status.js'
import { cutOut } from '/shared/cutout.js'

// A copy of the card's own picture: long side at most this, as WebP (the browser's PNG where it has no WebP).
const COPY_SIDE = 800
const DECOR_NAMES = () => ({ texture: t`底纹`, corner: t`角花`, divider: t`分隔纹`, emblem: t`徽记` })

/** The pictures of one card for a look panel: { cardId, data: { pictures, offered } | null, art, history }. */
export function lookPictures(api, cardId) {
  const state = { cardId, data: null, art: null, history: {}, busy: '', error: '' }

  /** Asked again: what there is, what may be named; `art` becomes what a bar is drawn with. */
  state.load = async () => {
    if (!cardId) return state
    const [data, history] = await Promise.all([api(`/api/cards/${cardId}/look-pictures`).catch(() => null), api(`/api/cards/${cardId}/history`).catch(() => null)])
    state.data = data
    state.history = history?.slots ?? {}
    state.art = data ? { lookPictures: Object.fromEntries(data.pictures.map(item => [item.token, item.url])), lookTokens: new Set(data.offered.map(item => item.token)) } : null
    return state
  }

  /**
   * The card's own pictures `css` names, copied small where there is no copy yet or the picture has changed since
   * (a scene drawn again). → whether any was made.
   */
  state.copyFor = async css => {
    if (!state.data) return false
    const have = new Map(state.data.pictures.map(item => [item.token, item]))
    const wanted = lookTokensUsed(css).map(token => state.data.offered.find(item => item.token === token)).filter(item => item && item.kind !== 'decor' && item.source && have.get(item.token)?.from !== item.from)
    for (const item of wanted) {
      const image = await smaller(item.source, { side: COPY_SIDE, clear: item.clear }).catch(() => '')
      if (image) await api(`/api/cards/${cardId}/look-pictures`, { method: 'PUT', body: { token: item.token, image, from: item.from } }).catch(() => null)
    }
    if (wanted.length) await state.load()
    return wanted.length > 0
  }

  return state
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('load'))
    image.src = src
  })
}

/**
 * A picture made small (its long side at most `side`), its plain background cut away when `clear` (and the empty
 * edges trimmed), as a data URL.
 */
export async function smaller(src, { side, clear = false, wide = 0 }) {
  const image = await loadImage(src)
  let [width, height] = [image.naturalWidth, image.naturalHeight]
  let canvas = document.createElement('canvas')
  Object.assign(canvas, { width, height })
  let context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(image, 0, 0)
  if (clear) {
    const pixels = context.getImageData(0, 0, width, height)
    const cut = cutOut(pixels)
    context.putImageData(pixels, 0, 0)
    const box = cut.box ?? { x: 0, y: 0, width, height }
    if (box.width > 0 && box.height > 0 && (box.width < width || box.height < height)) {
      const trimmed = document.createElement('canvas')
      Object.assign(trimmed, { width: box.width, height: box.height })
      trimmed.getContext('2d').drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height)
      canvas = trimmed
      ;[width, height] = [box.width, box.height]
    }
  }
  const scale = Math.min(1, (wide || side) / (wide ? width : Math.max(width, height)))
  const out = document.createElement('canvas')
  Object.assign(out, { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
  context = out.getContext('2d')
  context.imageSmoothingQuality = 'high'
  context.drawImage(canvas, 0, 0, out.width, out.height)
  return out.toDataURL('image/webp', 0.86)
}

/**
 * 装饰图 in the look panel: a row a slot (the picture, 重画, 删除, 换回上一张), and 画装饰图… for those ticked.
 * @param options - { pictures: lookPictures(), prompts(): the look's decor prompts ({ slot: prompt }), pickDraw,
 *   onChanged(): the pictures changed (draw the previews again) }
 */
export function decorBlock(el, { api, pictures, prompts, pickDraw, onChanged }) {
  const names = DECOR_NAMES()
  const ticked = (pictures.ticked = pictures.ticked ?? new Set())
  const box = el('div', { class: 'cc-decor' })

  const drawnOf = slot => pictures.data?.pictures.find(item => item.token === `--pic-decor-${slot}`) ?? null
  const keptOf = slot => pictures.history[`look:decor-${slot}`] ?? []

  async function draw(slots) {
    if (!slots.length) return
    const picked = await pickDraw({ title: t`用什么画装饰图`, action: t`下一步`, note: t`还没配置画图接口的话，点左下角「设置画图方式…」。` })
    if (!picked) return
    const how = picked.label ? t`用「${picked.label}」` : t`用设置里的画图方式`
    if (!confirm(t`${how}画 ${slots.length} 张装饰图（${slots.map(slot => names[slot]).join(t`、`)}）：一张一张来，透明底的会去掉白底。用付费接口时每张都会计费。开始？`)) return
    const asked = prompts()
    pictures.error = ''
    for (const [i, slot] of slots.entries()) {
      pictures.busy = t`正在画第 ${i + 1} / ${slots.length} 张：${names[slot]}…`
      render()
      try {
        const drawn = await api(`/api/cards/${pictures.cardId}/look-pictures/draw`, { method: 'POST', body: { slot, prompt: asked[slot] ?? '', ...(picked.body ?? {}) } })
        const { clear, size, shape } = DECOR_SLOTS[slot]
        const image = await smaller(drawn.image, { side: size, clear, wide: shape === 'landscape' ? size : 0 })
        await api(`/api/cards/${pictures.cardId}/look-pictures`, { method: 'PUT', body: { token: `--pic-decor-${slot}`, image, prompt: drawn.prompt, backend: drawn.backend } })
        ticked.delete(slot)
      } catch (error) {
        pictures.error = t`${names[slot]}没画成：${error.message}`
        break
      }
    }
    pictures.busy = ''
    await pictures.load()
    onChanged()
    render()
  }

  async function remove(slot) {
    if (!confirm(t`删掉「${names[slot]}」这张装饰图？删掉的会留在抽图历史里，可以换回来。`)) return
    await api(`/api/cards/${pictures.cardId}/look-pictures/decor-${slot}`, { method: 'DELETE' }).catch(error => { pictures.error = error.message })
    await pictures.load()
    onChanged()
    render()
  }

  async function takeBack(slot) {
    const [last] = keptOf(slot)
    if (!last) return
    await api(`/api/cards/${pictures.cardId}/history/${last.file}/use`, { method: 'POST' }).catch(error => { pictures.error = error.message })
    await pictures.load()
    onChanged()
    render()
  }

  function render() {
    const asked = prompts()
    const busy = Boolean(pictures.busy)
    const rows = Object.keys(DECOR_SLOTS).map(slot => {
      const drawn = drawnOf(slot)
      const box = el('input', { type: 'checkbox', disabled: busy, onchange: () => { if (box.checked) ticked.add(slot); else ticked.delete(slot); render() } })
      box.checked = ticked.has(slot)
      return el('div', { class: 'cc-decor-row' }, [
        el('label', { class: 'front-check', title: asked[slot] || t`这套外观没写这一种的画法，会照它的配色画一张` }, [box, el('span', { text: names[slot] })]),
        drawn ? el('img', { class: `cc-decor-pic${DECOR_SLOTS[slot].clear ? ' clear' : ''}`, src: drawn.url, alt: names[slot] }) : el('span', { class: 'hint', text: asked[slot] ? t`没画（这套外观想要）` : t`没画` }),
        el('span', { class: 'grow' }),
        drawn ? el('button', { type: 'button', class: 'btn ghost small', disabled: busy, text: t`删除`, onclick: () => remove(slot) }) : null,
        keptOf(slot).length ? el('button', { type: 'button', class: 'btn ghost small', disabled: busy, text: t`换回上一张`, title: t`抽图历史里还有 ${keptOf(slot).length} 张`, onclick: () => takeBack(slot) }) : null,
      ])
    })
    const wanted = Object.keys(DECOR_SLOTS).filter(slot => ticked.has(slot))
    box.replaceChildren(...[
      el('p', { class: 'cc-skin-head' }, [el('strong', { text: t`装饰图` }), el('small', { class: 'hint', text: t`给这套外观画几张底纹、角花、分隔纹、徽记，存在这张卡里，外观里用变量引用。画好以后让模型「照这个改」或「另设计一套」，它就会用上；这套外观本来就想要的，画好后马上能看到。` })]),
      ...rows,
      el('div', { class: 'cc-actions' }, [
        pictures.busy ? el('div', { class: 'forge-working' }, [el('span', { class: 'dots' }), el('span', { text: pictures.busy })]) : null,
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'btn small', disabled: busy || !wanted.length || !pickDraw, text: wanted.length ? t`画装饰图（${wanted.length} 张）…` : t`画装饰图…`, title: t`勾上要画的几种。开始前选画图方式，写明一共几张`, onclick: () => draw(wanted) }),
      ]),
      pictures.error ? el('div', { class: 'forge-error' }, [el('p', { text: pictures.error })]) : null,
    ].filter(Boolean))
  }

  // Ticked to start with: what the look itself asks for and has no picture for yet.
  if (!pictures.tickedOnce) {
    pictures.tickedOnce = true
    for (const slot of Object.keys(prompts())) if (!drawnOf(slot)) ticked.add(slot)
  }
  render()
  return box
}
