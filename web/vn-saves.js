// 存档 / 读档 in the visual novel mode (server/saves.mjs): eighteen slots on
// three pages, a quick save (F5, F9 to load it) and an auto save each turn, all
// per card. A slot shows a small picture of the stage, where and when, the line
// and a note. Loading opens the saved reply at its line; later turns are rolled
// back and kept as a branch.
import { locale, t } from '/i18n.js'

const PAGE = 6

/**
 * @param deps.current - () → what a save keeps now ({ cardId, chatId, chatTitle, nodeId, line, place, time, text }), or null.
 * @param deps.snapshot - () → a JPEG data URL of the stage.
 * @param deps.cardId - () → the card the mode shows.
 * @param deps.busy - () → true while a turn is being written (no loading then).
 * @param deps.open - (save, chatView) shows that chat at the save's line.
 */
export function initVnSaves({ api, el, toast, guard, current, snapshot, cardId, busy, open }) {
  let dialog = null
  let mode = 'save'
  let page = 0
  let view = null

  const when = save => new Date(save.savedAt).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  async function load() {
    const id = cardId()
    view = id ? await api(`/api/cards/${id}/saves`).catch(() => ({ saves: [], slots: 18 })) : { saves: [], slots: 18 }
    return view
  }

  /** Into a slot ('1' … '18', 'quick'). */
  async function saveTo(slot) {
    const now = current()
    if (!now) return toast(t`这里还不能存档：等这一轮写完再存`)
    view = await api(`/api/cards/${now.cardId}/saves/slot/${slot}`, { method: 'PUT', body: { ...now, image: await snapshot().catch(() => '') } })
    return view
  }

  async function loadSave(save) {
    if (busy()) return toast(t`正在生成，等这一轮写完再读档`)
    if (save.gone) return toast(t`这个存档的那一轮已经删掉了`)
    const result = await api(`/api/cards/${cardId()}/saves/${save.id}/load`, { method: 'POST' })
    dialog?.close()
    await open(result.save, result.chat)
    toast(t`读档：${[save.place, save.time].filter(Boolean).join(' · ') || save.chatTitle || t`存档`}`)
  }

  /** One slot: its picture and words; a click saves here ('save') or loads it ('load'). */
  function slotCard(slot, save, action = mode === 'save' ? 'save' : 'load') {
    const label = slot === 'quick' ? t`快速存档` : slot === 'auto' ? t`自动存档` : t`存档 ${slot}`
    const picture = save?.picture
      ? el('img', { src: `/api/saves/${cardId()}/${save.picture}`, alt: '', loading: 'lazy' })
      : el('div', { class: 'vn-save-empty', text: save ? t`没有画面` : t`空` })
    const meta = save
      ? [
          el('b', { text: [save.place, save.time].filter(Boolean).join(' · ') || save.chatTitle || t`（没有地点）` }),
          el('span', { class: 'vn-save-line', text: save.text }),
          save.note ? el('span', { class: 'vn-save-note', text: save.note }) : null,
          el('span', { class: 'muted small', text: `${when(save)}${save.chatTitle ? ` · ${save.chatTitle}` : ''}${save.gone ? t` · 那一轮已删掉` : ''}` }),
        ]
      : [el('span', { class: 'muted small', text: action === 'save' ? t`点一下存到这里` : t`空` })]
    const usable = action === 'save' ? slot !== 'auto' : Boolean(save) && !save.gone
    const main = el('button', { type: 'button', class: 'vn-save-main', disabled: !usable }, [picture, el('div', { class: 'vn-save-meta' }, [el('small', { class: 'vn-save-label', text: label }), ...meta])])
    main.addEventListener('click', guard(async () => {
      if (action === 'save') {
        if (save && !confirm(t`覆盖「${label}」？`)) return
        await saveTo(slot)
        toast(t`已存到「${label}」`)
      } else await loadSave(save)
      if (dialog?.open) render()
    }))
    const tools = save
      ? el('div', { class: 'vn-save-tools' }, [
          el('button', { type: 'button', class: 'btn ghost small', title: t`写一句备注`, text: '✎', onclick: guard(async () => {
            const note = prompt(t`备注（比如：选了留下）`, save.note ?? '')
            if (note === null) return
            view = await api(`/api/cards/${cardId()}/saves/${save.id}/note`, { method: 'PUT', body: { note } })
            render()
          }) }),
          el('button', { type: 'button', class: 'btn ghost small danger', title: t`删除这个存档`, text: '×', onclick: guard(async () => {
            if (!confirm(t`删除「${label}」？`)) return
            view = await api(`/api/cards/${cardId()}/saves/${save.id}`, { method: 'DELETE' })
            render()
          }) }),
        ])
      : null
    return el('div', { class: `vn-save${save ? '' : ' vacant'}${save?.gone ? ' gone' : ''}` }, [main, tools])
  }

  function render() {
    if (!dialog || !view) return
    const bySlot = slot => view.saves.find(save => save.slot === slot) ?? null
    const tabs = el('div', { class: 'seg' }, [['save', t`存档`], ['load', t`读档`], ['auto', t`自动存档`]].map(([value, text]) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(mode === value), text })
      b.addEventListener('click', () => {
        mode = value
        render()
      })
      return b
    }))
    let body
    if (mode === 'auto') {
      const autos = view.saves.filter(save => save.slot === 'auto')
      body = autos.length
        ? el('div', { class: 'vn-save-grid' }, autos.map(save => slotCard('auto', save, 'load')))
        : el('p', { class: 'muted small', text: t`还没有自动存档：视觉小说模式里每写完一轮存一个，留最近十个。` })
    } else {
      const pages = Math.ceil(view.slots / PAGE)
      const first = page * PAGE + 1
      const slots = Array.from({ length: Math.min(PAGE, view.slots - first + 1) }, (_, i) => String(first + i))
      const quick = bySlot('quick')
      body = el('div', {}, [
        mode === 'load' && quick ? el('div', { class: 'vn-save-grid one' }, [slotCard('quick', quick)]) : null,
        el('div', { class: 'vn-save-grid' }, slots.map(slot => slotCard(slot, bySlot(slot)))),
        el('div', { class: 'seg vn-save-pages' }, Array.from({ length: pages }, (_, i) => {
          const b = el('button', { type: 'button', 'aria-pressed': String(i === page), text: String(i + 1) })
          b.addEventListener('click', () => {
            page = i
            render()
          })
          return b
        })),
      ])
    }
    dialog.replaceChildren(
      el('div', { class: 'vn-library-top' }, [el('h2', { text: mode === 'save' ? t`存档` : t`读档` }), tabs]),
      el('p', { class: 'muted small', text: mode === 'save' ? t`存下这一句：之后从这里读档，会回到这一轮这一句接着玩（后面写过的保留成一个分支）。F5 快速存档。` : t`读档会回到存档的那一轮那一句；之后写过的会收起来保留成分支，不会删掉。F9 读快速存档。` }),
      body,
      el('form', { method: 'dialog', class: 'row end' }, [el('button', { class: 'btn', text: t`关闭` })]),
    )
  }

  return {
    /** The window, on 存档 or 读档. */
    open: guard(async which => {
      mode = which
      if (!dialog) {
        dialog = el('dialog', { class: 'dialog vn-saves' })
        document.body.append(dialog)
      }
      await load()
      render()
      if (!dialog.open) dialog.showModal()
    }),
    quickSave: guard(async () => {
      if (await saveTo('quick')) toast(t`已快速存档（F9 读档）`)
    }),
    quickLoad: guard(async () => {
      const quick = (await load()).saves.find(save => save.slot === 'quick')
      if (!quick) return toast(t`还没有快速存档：按 F5 存一个`)
      await loadSave(quick)
    }),
    /** A turn just finished: an auto save, quietly. */
    async autoSave() {
      const now = current()
      if (!now) return
      try {
        view = await api(`/api/cards/${now.cardId}/saves/auto`, { method: 'POST', body: { ...now, image: await snapshot().catch(() => '') } })
      } catch {
        // An auto save is not worth a message.
      }
    },
  }
}
