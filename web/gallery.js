// 图库 (角色卡 list → 图库): every picture of every card and chat (server/gallery.mjs), to look through, pick and
// export as a zip, or delete. Also the picker for a reply's picture (选图, web/media.js): one picture, or one of the player's
// own files. web/app.js loads this file when the window is first opened, so a server started before the file
// existed still serves the page.
import { t } from '/i18n.js'
import { shrink } from '/theme.js'

const KIND_NAMES = () => ({ reply: t`配图和CG`, scene: t`背景`, sprite: t`立绘`, cg: t`卡的 CG` })
// 立绘: each character's 立绘 first, then the expressions in this order.
const FACES = ['neutral', 'smile', 'happy', 'shy', 'angry', 'sad', 'surprised', 'thinking']
const FACE_NAMES = () => ({ neutral: t`立绘`, smile: t`微笑`, happy: t`开心`, shy: t`害羞`, angry: t`生气`, sad: t`难过`, surprised: t`惊讶`, thinking: t`思考` })
const ICON_ZOOM = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5"/><path d="m12.2 12.2 4.3 4.3M8.5 6.3v4.4M6.3 8.5h4.4"/></svg>'
// Shown at first, then more on asking: a few thousand pictures would be a slow page.
const PAGE = 240

let dialog = null

/**
 * @param deps - { api, el, toast, guard, download(path, name, mime), viewPicture(src, caption, meta, options): the image
 *   viewer (web/media.js), for a picture's 看大图 }
 * @param options.cardId - the card to show at first ('' = all).
 * @param options.pick - 选图: one picture is picked, or a file of the player's own uploaded; resolves to
 *   { gallery: its id } or { image: a data URL } once the window closes, or null when nothing was chosen.
 */
export async function openGallery({ api, el, toast, guard, download, viewPicture = null }, { cardId = '', pick = false } = {}) {
  dialog = dialog ?? document.body.appendChild(el('dialog', { class: 'dialog wide gallery', 'aria-label': t`图库` }))
  let { items } = await api('/api/gallery')
  const picked = new Set()
  const filter = { card: items.some(item => item.cardId === cardId) ? cardId : '', kind: '', query: '' }
  let shown = PAGE
  // 立绘: the characters whose list is open (kept while the window is).
  const opened = new Set()

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
  // 立绘 picked: one folding list per character instead of the grid.
  const spriteList = el('div', { class: 'gallery-sprites', hidden: true })
  const openAll = el('button', { type: 'button', class: 'btn ghost small', text: t`全部展开`, hidden: true })
  const closeAll = el('button', { type: 'button', class: 'btn ghost small', text: t`全部收起`, hidden: true })
  const count = el('span', { class: 'muted small' })
  const more = el('button', { type: 'button', class: 'btn small', text: t`显示更多`, onclick: () => {
    shown += PAGE
    draw()
  } })
  const exportButton = el('button', { type: 'button', class: 'btn primary', text: t`导出所选` })
  const deleteButton = el('button', { type: 'button', class: 'btn danger', text: t`删除所选` })
  const selectAll = el('button', { type: 'button', class: 'btn ghost', text: t`全选` })
  const clear = el('button', { type: 'button', class: 'btn ghost', text: t`取消选择` })

  const matching = () => {
    const words = filter.query.trim().toLowerCase()
    return items.filter(item => (!filter.card || item.cardId === filter.card) && (!filter.kind || item.kind === filter.kind)
      && (!words || [item.prompt, item.chatTitle, item.name, item.cardName].some(text => String(text ?? '').toLowerCase().includes(words))))
  }

  const label = item => [KIND_NAMES()[item.kind], item.name || item.chatTitle, item.at ? new Date(item.at).toLocaleDateString() : ''].filter(Boolean).join(' · ')

  /** One picture to pick: a click picks it or lets it go; its magnifier (top left) shows it full size. */
  function tile(item, list, text = label(item)) {
    const box = el('button', { type: 'button', class: `gallery-item${picked.has(item.id) ? ' picked' : ''}`, title: [label(item), item.prompt].filter(Boolean).join('\n'), 'aria-pressed': String(picked.has(item.id)) }, [
      el('img', { src: item.src, alt: '', loading: 'lazy', decoding: 'async' }),
      el('span', { class: 'gallery-check', 'aria-hidden': 'true' }),
      el('span', { class: 'gallery-label', text }),
    ])
    box.addEventListener('click', () => {
      // 选图: one at a time.
      if (pick) {
        const was = picked.has(item.id)
        picked.clear()
        if (!was) picked.add(item.id)
        return draw()
      }
      if (picked.has(item.id)) picked.delete(item.id)
      else picked.add(item.id)
      box.classList.toggle('picked', picked.has(item.id))
      box.setAttribute('aria-pressed', String(picked.has(item.id)))
      drawCount(list)
    })
    if (!viewPicture) return box
    const zoom = el('button', { type: 'button', class: 'gallery-zoom', title: t`看大图`, 'aria-label': t`看「${text}」的大图`, html: ICON_ZOOM })
    zoom.addEventListener('click', () => viewPicture(item.src, item.prompt || [item.cardName, item.name || item.chatTitle].filter(Boolean).join(' · '), label(item), { cutout: item.kind === 'sprite' }))
    return el('div', { class: 'gallery-cell' }, [box, zoom])
  }

  /** The 立绘 and expressions by character: [{ key, cardName, who, items }], by card, then name. */
  function spriteGroups(list) {
    const groups = new Map()
    for (const item of list) {
      if (item.kind !== 'sprite') continue
      const key = `${item.cardId}:${item.entryId ?? item.name}`
      if (!groups.has(key)) groups.set(key, { key, cardName: item.cardName || t`（已删除的卡）`, who: item.who || item.name || t`（不在名册里了）`, items: [] })
      groups.get(key).items.push(item)
    }
    const at = face => (FACES.includes(face) ? FACES.indexOf(face) : FACES.length)
    for (const group of groups.values()) group.items.sort((a, b) => at(a.face) - at(b.face))
    return [...groups.values()].sort((a, b) => a.cardName.localeCompare(b.cardName, 'zh-CN') || a.who.localeCompare(b.who, 'zh-CN'))
  }

  /** A zip of these pictures, downloaded under this name. */
  async function exportIds(ids, name) {
    const { path, count: done, missing } = await api('/api/gallery/export', { method: 'POST', body: { ids } })
    download(path, `${name}-${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip')
    toast(missing ? t`导出了 ${done} 张，${missing} 张已经不在了` : t`导出了 ${done} 张`, 5000)
  }

  /** 立绘: a folding list per character, its 立绘 and expressions inside, each list with its own 选这组 and 导出. */
  function drawSprites(list) {
    const groups = spriteGroups(list)
    const faces = FACE_NAMES()
    // A button in a list's head does its own thing, not open or close the list.
    const own = fn => event => {
      event.preventDefault()
      event.stopPropagation()
      fn()
    }
    spriteList.replaceChildren(...(groups.length ? groups.map(group => {
      const ids = group.items.map(item => item.id)
      const pickAll = el('button', { type: 'button', class: 'btn ghost small', text: t`选这组`, onclick: own(() => {
        const all = ids.every(id => picked.has(id))
        for (const id of ids) {
          if (all) picked.delete(id)
          else picked.add(id)
        }
        draw()
      }) })
      const save = el('button', { type: 'button', class: 'btn small', text: t`导出`, title: t`把这个角色的立绘和表情导出成一个压缩包`, onclick: own(guard(async () => {
        save.disabled = true
        try {
          await exportIds(ids, t`${group.cardName}-${group.who}-立绘`)
        } finally {
          save.disabled = false
        }
      })) })
      const details = el('details', { class: 'gallery-sprite', open: opened.has(group.key) }, [
        el('summary', {}, [
          el('b', { text: group.who }),
          filter.card ? null : el('span', { class: 'muted small', text: group.cardName }),
          el('span', { class: 'muted small', text: t`${group.items.length} 张` }),
          el('span', { class: 'gallery-sprite-tools' }, [pickAll, save]),
        ]),
        el('div', { class: 'gallery-grid' }, group.items.map(item => tile(item, list, faces[item.face] ?? item.name))),
      ])
      details.addEventListener('toggle', () => {
        if (details.open) opened.add(group.key)
        else opened.delete(group.key)
      })
      return details
    }) : [el('p', { class: 'muted gallery-empty', text: t`没有符合的立绘` })]))
  }

  function draw() {
    const list = matching()
    const sprites = filter.kind === 'sprite'
    grid.hidden = sprites
    spriteList.hidden = !sprites
    openAll.hidden = !sprites
    closeAll.hidden = !sprites
    if (sprites) {
      drawSprites(list)
      more.hidden = true
      return drawCount(list)
    }
    grid.replaceChildren(...(list.length
      ? list.slice(0, shown).map(item => tile(item, list))
      : [el('p', { class: 'muted gallery-empty', text: items.length ? t`没有符合的图` : t`还没有画过图。给回复配图、画 CG、画背景和立绘之后都会出现在这里。` })]))
    more.hidden = list.length <= shown
    drawCount(list)
  }
  openAll.onclick = () => {
    for (const group of spriteGroups(matching())) opened.add(group.key)
    draw()
  }
  closeAll.onclick = () => {
    opened.clear()
    draw()
  }
  function drawCount(list = matching()) {
    if (pick) {
      count.textContent = t`列出 ${list.length} 张`
      use.disabled = !picked.size
      return
    }
    count.textContent = t`列出 ${list.length} 张，已选 ${picked.size} 张`
    exportButton.disabled = !picked.size
    exportButton.textContent = picked.size ? t`导出所选（${picked.size}）` : t`导出所选`
    deleteButton.disabled = !picked.size
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
      await exportIds([...picked], filter.card ? cards.find(([id]) => id === filter.card)?.[1] ?? t`图库` : t`图库`)
    } finally {
      drawCount()
    }
  })

  // 删除所选: gone from where each lives (the reply, the card's backgrounds, 立绘, CG), asked once.
  deleteButton.onclick = guard(async () => {
    if (!picked.size) return
    const chosenItems = items.filter(item => picked.has(item.id))
    const kinds = [...new Set(chosenItems.map(item => KIND_NAMES()[item.kind]))].join(t`、`)
    const base = chosenItems.some(item => item.kind === 'sprite' && item.face === 'neutral') ? t`删掉立绘本身后，表情还在，要的话一起选上。` : ''
    if (!confirm(t`删除选中的 ${picked.size} 张图（${kinds}）？删了找不回来：对话里的配图、卡的背景、立绘和 CG 都会跟着没了。${base}`)) return
    deleteButton.disabled = true
    try {
      const { removed, missing } = await api('/api/gallery/delete', { method: 'POST', body: { ids: [...picked] } })
      toast(missing ? t`删了 ${removed} 张，${missing} 张已经不在了` : t`删了 ${removed} 张`, 5000)
      picked.clear()
      ;({ items } = await api('/api/gallery'))
      // The counts in the card list follow.
      for (const option of cardPick.options) {
        const many = option.value ? items.filter(item => item.cardId === option.value).length : items.length
        const name = option.value ? cards.find(([id]) => id === option.value)?.[1] ?? '' : ''
        option.textContent = option.value ? t`${name}（${many}）` : t`全部卡（${many} 张）`
      }
      draw()
    } finally {
      drawCount()
    }
  })

  // 选图: what was chosen, handed back as the window closes.
  let chosen = null
  const use = el('button', { type: 'button', class: 'btn primary', text: t`用这张`, disabled: true, onclick: () => {
    if (!picked.size) return
    chosen = { gallery: [...picked][0] }
    dialog.close()
  } })
  const upload = el('button', { type: 'button', class: 'btn', text: t`上传本地图片…`, onclick: guard(async () => {
    const file = await new Promise(resolve => {
      const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' })
      input.addEventListener('change', () => resolve(input.files[0] ?? null))
      input.click()
    })
    if (!file) return
    chosen = { image: await shrink(file) }
    dialog.close()
  }) })
  const buttons = pick
    ? [upload, el('button', { class: 'btn', value: 'cancel', text: t`取消` }), use]
    : [selectAll, clear, deleteButton, exportButton, el('button', { class: 'btn', value: 'cancel', text: t`关闭` })]

  dialog.replaceChildren(el('form', { method: 'dialog' }, [
    el('div', { class: 'library-head' }, pick
      ? [el('h2', { text: t`选一张配图` }), el('p', { class: 'muted small', text: t`从画过、传过的图里选一张当这段的配图（每轮的配图、背景、立绘、卡的 CG），也可以上传本地图片。点一张选中，再点「用这张」。` })]
      : [el('h2', { text: t`图库` }), el('p', { class: 'muted small', text: t`所有卡和对话里画过、传过的图：每轮的配图和 CG、背景、立绘和表情、卡的 CG。点图选中，选好后导出成一个压缩包（按卡和种类分好文件夹），或者删掉。` })]),
    el('div', { class: 'library-tools gallery-tools' }, [cardPick, query, el('div', { class: 'seg', role: 'group', 'aria-label': t`种类` }, kindButtons), el('span', { class: 'row gallery-fold' }, [openAll, closeAll])]),
    grid,
    spriteList,
    el('div', { class: 'row', style: 'justify-content: center' }, [more]),
    el('div', { class: 'row between' }, [count, el('div', { class: 'row' }, buttons)]),
  ]))
  dialog.classList.toggle('picking', pick)
  draw()
  const closed = new Promise(resolve => {
    dialog.onclose = () => {
      dialog.onclose = null
      resolve(chosen)
    }
  })
  if (!dialog.open) dialog.showModal()
  return pick ? closed : undefined
}
