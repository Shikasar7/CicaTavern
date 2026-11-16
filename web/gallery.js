// 图库 (角色卡 list → 图库): every picture of every card and chat (server/gallery.mjs), to look through, pick and
// export as a zip. web/app.js loads this file when the window is first opened, so a server started before the file
// existed still serves the page.
import { t } from '/i18n.js'

const KIND_NAMES = () => ({ reply: t`配图和CG`, scene: t`背景`, sprite: t`立绘` })
// Shown at first, then more on asking: a few thousand pictures would be a slow page.
const PAGE = 240

let dialog = null

/**
 * @param deps - { api, el, toast, guard, download(path, name, mime) }
 * @param options.cardId - the card to show at first ('' = all).
 */
export async function openGallery({ api, el, toast, guard, download }, { cardId = '' } = {}) {
  dialog = dialog ?? document.body.appendChild(el('dialog', { class: 'dialog wide gallery', 'aria-label': t`图库` }))
  const { items } = await api('/api/gallery')
  const picked = new Set()
  const filter = { card: items.some(item => item.cardId === cardId) ? cardId : '', kind: '', query: '' }
  let shown = PAGE

  const cards = [...new Map(items.map(item => [item.cardId, item.cardName || t`（已删除的卡）`])).entries()]
  const cardPick = el('select', { 'aria-label': t`角色卡` }, [el('option', { value: '', text: t`全部卡（${items.length} 张）` }), ...cards.map(([id, name]) => el('option', { value: id, text: t`${name}（${items.filter(item => item.cardId === id).length}）` }))])
  cardPick.value = filter.card
  const query = el('input', { type: 'search', placeholder: t`搜索提示词、对话名、角色名`, autocomplete: 'off', spellcheck: 'false' })
  const kindButtons = [['', t`全部`], ...Object.entries(KIND_NAMES())].map(([kind, text]) => el('button', { type: 'button', text, 'aria-pressed': String(kind === filter.kind), onclick: () => {
    filter.kind = kind
    for (const button of kindButtons) button.setAttribute('aria-pressed', String(button === kindButtons.find(b => b.dataset.kind === kind)))
    shown = PAGE
    draw()
  }, 'data-kind': kind }))
  const grid = el('div', { class: 'gallery-grid' })
  const count = el('span', { class: 'muted small' })
  const more = el('button', { type: 'button', class: 'btn small', text: t`显示更多`, onclick: () => {
    shown += PAGE
    draw()
  } })
  const exportButton = el('button', { type: 'button', class: 'btn primary', text: t`导出所选` })
  const selectAll = el('button', { type: 'button', class: 'btn ghost', text: t`全选` })
  const clear = el('button', { type: 'button', class: 'btn ghost', text: t`取消选择` })

  const matching = () => {
    const words = filter.query.trim().toLowerCase()
    return items.filter(item => (!filter.card || item.cardId === filter.card) && (!filter.kind || item.kind === filter.kind)
      && (!words || [item.prompt, item.chatTitle, item.name, item.cardName].some(text => String(text ?? '').toLowerCase().includes(words))))
  }

  const label = item => [KIND_NAMES()[item.kind], item.name || item.chatTitle, item.at ? new Date(item.at).toLocaleDateString() : ''].filter(Boolean).join(' · ')

  function draw() {
    const list = matching()
    grid.replaceChildren(...(list.length
      ? list.slice(0, shown).map(item => {
          const box = el('button', { type: 'button', class: `gallery-item${picked.has(item.id) ? ' picked' : ''}`, title: [label(item), item.prompt].filter(Boolean).join('\n'), 'aria-pressed': String(picked.has(item.id)) }, [
            el('img', { src: item.src, alt: '', loading: 'lazy', decoding: 'async' }),
            el('span', { class: 'gallery-check', 'aria-hidden': 'true' }),
            el('span', { class: 'gallery-label', text: label(item) }),
          ])
          box.addEventListener('click', () => {
            if (picked.has(item.id)) picked.delete(item.id)
            else picked.add(item.id)
            box.classList.toggle('picked', picked.has(item.id))
            box.setAttribute('aria-pressed', String(picked.has(item.id)))
            drawCount(list)
          })
          return box
        })
      : [el('p', { class: 'muted gallery-empty', text: items.length ? t`没有符合的图` : t`还没有画过图。给回复配图、画 CG、画背景和立绘之后都会出现在这里。` })]))
    more.hidden = list.length <= shown
    drawCount(list)
  }
  function drawCount(list = matching()) {
    count.textContent = t`列出 ${list.length} 张，已选 ${picked.size} 张`
    exportButton.disabled = !picked.size
    exportButton.textContent = picked.size ? t`导出所选（${picked.size}）` : t`导出所选`
  }

  cardPick.onchange = () => {
    filter.card = cardPick.value
    shown = PAGE
    draw()
  }
  query.addEventListener('input', () => {
    filter.query = query.value
    shown = PAGE
    draw()
  })
  selectAll.onclick = () => {
    for (const item of matching()) picked.add(item.id)
    draw()
  }
  clear.onclick = () => {
    picked.clear()
    draw()
  }
  exportButton.onclick = guard(async () => {
    if (!picked.size) return
    exportButton.disabled = true
    try {
      const { path, count: done, missing } = await api('/api/gallery/export', { method: 'POST', body: { ids: [...picked] } })
      const name = filter.card ? cards.find(([id]) => id === filter.card)?.[1] ?? t`图库` : t`图库`
      download(path, `${name}-${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip')
      toast(missing ? t`导出了 ${done} 张，${missing} 张已经不在了` : t`导出了 ${done} 张`, 5000)
    } finally {
      drawCount()
    }
  })

  dialog.replaceChildren(el('form', { method: 'dialog' }, [
    el('div', { class: 'library-head' }, [el('h2', { text: t`图库` }), el('p', { class: 'muted small', text: t`所有卡和对话里画过、传过的图：每轮的配图和 CG、背景、立绘和表情。点图选中，选好后导出成一个压缩包，按卡和种类分好文件夹。` })]),
    el('div', { class: 'library-tools gallery-tools' }, [cardPick, query, el('div', { class: 'seg', role: 'group', 'aria-label': t`种类` }, kindButtons)]),
    grid,
    el('div', { class: 'row', style: 'justify-content: center' }, [more]),
    el('div', { class: 'row between' }, [count, el('div', { class: 'row' }, [selectAll, clear, exportButton, el('button', { class: 'btn', value: 'cancel', text: t`关闭` })])]),
  ]))
  draw()
  if (!dialog.open) dialog.showModal()
}
