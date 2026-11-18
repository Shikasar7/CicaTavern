// 导出角色卡 → 带上图片和设置 (the card's ⋯, and 创作角色卡 → 状态栏与门面): tick what goes with the card
// (server/card-pack.mjs says what it has), and take the zip. web/app.js loads this file when the window is first
// opened, so a server started before the file existed still serves the page.
import { t } from '/i18n.js'

const PART_TEXT = () => ({
  roster: [t`角色名册和人设图`, t`名册里的角色、长相和衣着的描述，和各自的人设图`],
  sprites: [t`立绘和表情`, t`每个角色的立绘和表情图。它们跟着名册里的角色走，所以名册会一起带上`],
  scenes: [t`场景图`, t`各个地点的场景图：视觉小说的背景、状态栏顶上和开场页用的`],
  cgs: [t`卡的 CG`, t`视觉小说里按剧情全屏放的 CG，一组一幕`],
  cover: [t`开场页的图`, t`开场页自己选的那张背景图`],
  look: [t`外观的图`, t`定制外观用的装饰图，和它用到的场景、立绘的小图`],
  rules: [t`游戏规则设置`, t`这张卡的游戏规则：档位、属性、技能、物品、敌人、成长和战斗设置。不勾的话，导出的卡里不带规则`],
  foes: [t`敌人图`, t`游戏规则里敌人的立绘。它们跟着规则里的敌人走，所以规则会一起带上`],
  skills: [t`技能图`, t`游戏规则里技能的配图，战斗里放技能时全屏特写用。它们跟着规则里的技能走，所以规则会一起带上`],
  regex: [t`附加的正则集`, t`挂在这张卡上的正则集：对方导入后会建出同样的正则集并挂上`],
  settings: [t`画风和朗读设置`, t`画风、LoRA 的名字和强度、对白和旁白的音色。LoRA 文件和音色本身不在里面，对方要自己有`],
})

/** 1.2 MB, 340 KB: a size as a person reads it. */
export function sizeText(bytes) {
  if (bytes >= 1024 * 1024) return t`${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`
  return t`${Math.max(1, Math.round(bytes / 1024))} KB`
}

let dialog = null

/**
 * @param deps - { api, el, toast, guard, download(path, name, mime) }
 * @param card - { id, name }
 */
export async function openCardPack({ api, el, toast, guard, download }, card) {
  dialog = dialog ?? document.body.appendChild(el('dialog', { class: 'dialog card-pack', 'aria-label': t`导出角色卡` }))
  const { parts, max } = await api(`/api/cards/${card.id}/pack`)
  const names = PART_TEXT()
  const picked = new Set(parts.map(part => part.key))
  const boxes = new Map()
  const total = el('span', { class: 'card-pack-total' })
  const go = el('button', { type: 'button', class: 'btn primary', text: t`导出` })

  const settle = () => {
    // 立绘和表情 belong to the cast, 敌人图 and 技能图 to the rules: ticking them ticks those, which stay ticked while they are.
    if (picked.has('sprites')) picked.add('roster')
    if (picked.has('foes') || picked.has('skills')) picked.add('rules')
    for (const [key, box] of boxes) {
      box.checked = picked.has(key)
      box.disabled = (key === 'roster' && picked.has('sprites')) || (key === 'rules' && (picked.has('foes') || picked.has('skills')))
    }
    const bytes = parts.filter(part => picked.has(part.key)).reduce((sum, part) => sum + part.bytes, 0)
    const over = bytes > max
    total.textContent = over ? t`图片合计 ${sizeText(bytes)}，超过了 ${sizeText(max)}：去掉几项` : bytes ? t`图片合计 ${sizeText(bytes)}（另加卡本身）` : t`只有卡本身`
    total.classList.toggle('over', over)
    go.disabled = over
  }

  const rows = parts.map(part => {
    const [label, hint] = names[part.key] ?? [part.key, '']
    const box = el('input', { type: 'checkbox', onchange: () => {
      if (box.checked) picked.add(part.key)
      else picked.delete(part.key)
      settle()
    } })
    boxes.set(part.key, box)
    const amount = part.key === 'roster' ? t`${part.count} 个角色` : part.key === 'regex' ? t`${part.count} 个` : part.key === 'settings' || part.key === 'rules' ? '' : t`${part.count} 张`
    return el('label', { class: 'card-pack-row' }, [
      box,
      el('span', { class: 'card-pack-name' }, [el('b', { text: label }), el('small', { class: 'hint', text: hint })]),
      el('span', { class: 'card-pack-size', text: [amount, part.bytes ? sizeText(part.bytes) : ''].filter(Boolean).join(t` · `) }),
    ])
  })

  go.onclick = guard(async () => {
    go.disabled = true
    try {
      const made = await api(`/api/cards/${card.id}/pack`, { method: 'POST', body: { include: [...picked] } })
      download(made.path, made.name, 'application/zip')
      toast(t`已导出「${card.name}」：${sizeText(made.size)} 的压缩包。在 CicaTavern 里用「导入角色卡」选它，图片和设置会一起装回去。`, 7000)
      dialog.close()
    } finally {
      settle()
    }
  })

  dialog.replaceChildren(el('form', { method: 'dialog' }, [
    el('h2', { text: t`导出「${card.name}」` }),
    el('p', { class: 'muted small', text: t`导出成一个压缩包（zip）：里面是这张卡，加上下面勾选的内容。发给别人或换设备时，在 CicaTavern 里用「导入角色卡」选这个压缩包，就都装回卡上。给 SillyTavern 用：解压后导入里面的 card.png（没有头像的卡是 card.json），和平常导出的一样。` }),
    rows.length
      ? el('div', { class: 'card-pack-rows' }, rows)
      : el('p', { class: 'hint', text: t`这张卡还没有图片、正则集和配图设置可带：导出的压缩包里只有卡本身。` }),
    el('p', { class: 'hint', text: t`不会带上的：配乐、对话记录（在对话的「导出剧情存档」里）、抽图历史、视觉小说存档、你的人设。` }),
    el('div', { class: 'row between' }, [total, el('div', { class: 'row' }, [el('button', { class: 'btn', value: 'cancel', text: t`取消` }), go])]),
  ]))
  settle()
  if (!dialog.open) dialog.showModal()
}

/**
 * A zip picked in 导入角色卡: sent as it is, then imported as a card file is. One that is no card pack of this app's
 * nor a CharX (an 整合包 someone put together) comes back as `{ bundle }` instead, for openBundle.
 * @param ask - async (previous { id, name }) → the id to update in place, '' for a new card, or null for none at all.
 * → the imported card ({ name, updated?, inherited?, arrived }), { bundle: what the server found in it }, or { skipped: true }.
 */
export async function importCardPack({ api }, file, ask) {
  const res = await fetch('/api/card-packs', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-agent-tavern': '1' }, body: file })
  const sent = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(sent.error || t`请求失败（${res.status}）`), { status: res.status })
  if (sent.kind === 'bundle') return { bundle: sent }
  const replace = sent.previous ? await ask(sent.previous) : ''
  if (replace === null) return { skipped: true }
  return api('/api/cards/import', { method: 'POST', body: { pack: sent.pack, ...(replace ? { replace } : {}) } })
}

/**
 * A CharX whose picture is no PNG (WebP, JPG): the page reads it from the file it still has, makes it a PNG and sets
 * it as the card's picture (the server keeps cards as PNGs and has nothing to turn pictures into one). → whether it did.
 */
export async function iconFromZip({ api }, file, cardId, iconPath) {
  const { zipData, zipEntries } = await import('/shared/zip.js')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const entry = zipEntries(bytes).find(item => item.name === iconPath)
  if (!entry) return false
  const inflateRaw = async data => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
  const bitmap = await createImageBitmap(new Blob([await zipData(bytes, entry, inflateRaw)]))
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) })
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  await api(`/api/cards/${cardId}/avatar`, { method: 'PUT', body: { image: canvas.toDataURL('image/png') } })
  return true
}

let bundleDialog = null

/**
 * 压缩包里有这些: an 整合包's cards, worldbooks, regex, presets, people's pictures, CG and folders of pictures, each
 * to tick (or say where it goes) before anything is kept (server/card-bundle.mjs).
 * @param deps - { api, el, guard }
 * @param bundle - the server's { pack, survey }.
 * @param here - { cards: [{ id, name }] already in the app, current: the card selected now }.
 * → what came in (the server's answer), or null when the window was closed.
 */
export function openBundle({ api, el, guard }, bundle, here) {
  const { survey } = bundle
  bundleDialog = bundleDialog ?? document.body.appendChild(el('dialog', { class: 'dialog card-pack card-bundle', 'aria-label': t`导入压缩包` }))
  const dialog = bundleDialog
  return new Promise(resolve => {
    let result = null
    const tick = (on, text, hint = '', extra = null) => {
      const box = el('input', { type: 'checkbox', checked: on })
      const row = el('label', { class: 'card-pack-row' }, [box, el('span', { class: 'card-pack-name' }, [el('b', { text }), hint ? el('small', { class: 'hint', text: hint }) : null]), extra ?? el('span')])
      return { box, row }
    }
    const pick = (options, value) => {
      const select = el('select', {}, options.map(([v, text]) => el('option', { value: v, text, selected: v === value })))
      select.addEventListener('click', event => event.preventDefault())
      return select
    }
    const section = (title, rows) => (rows.length ? [el('h3', { class: 'card-bundle-head', text: title }), el('div', { class: 'card-pack-rows' }, rows)] : [])

    // Cards: each its own; one already here may be updated in place (its chats stay).
    const cards = survey.cards.map(card => {
      const how = card.previous ? pick([[card.previous.id, t`更新「${card.previous.name}」`], ['', t`另存为新卡`]], card.previous.id) : null
      const { box, row } = tick(true, card.name, card.path, how)
      return { card, box, how, row }
    })
    // Without a card of its own, the pictures go onto one already here.
    const target = survey.cards.length ? null : pick([['', t`选一张卡…`], ...here.cards.map(card => [card.id, card.name])], here.current ?? '')
    const books = survey.books.map(book => ({ book, ...tick(true, book.name, t`世界书，${book.entries} 条`) }))
    const link = tick(true, t`把这些世界书挂到卡上`)
    const regex = survey.regex.map(item => ({ item, ...tick(true, item.name, t`正则 ${item.count} 条，加到卡自己的正则里`) }))
    const presets = survey.presets.map(item => ({ item, ...tick(false, item.name, t`预设，导入到预设列表（不跟卡走）`) }))
    const faceNames = { neutral: t`立绘`, smile: t`微笑`, happy: t`开心`, shy: t`害羞`, angry: t`生气`, sad: t`难过`, surprised: t`惊讶`, thinking: t`思考` }
    const people = survey.people.map(person => {
      const has = [person.portrait ? t`人设图` : '', ...Object.keys(person.faces).map(face => faceNames[face] ?? face)].filter(Boolean).join(t`、`)
      const left = person.left?.length ? t`；没对上的：${person.left.join(t`、`)}` : ''
      return { person, ...tick(true, person.name, `${has}${left}`) }
    })
    const groupCount = survey.groups.length
    const cgPictures = survey.groups.reduce((n, group) => n + group.pictures.length, 0)
    const cgs = groupCount ? tick(true, t`CG ${groupCount} 组，共 ${cgPictures} 张`, survey.groups.slice(0, 6).map(group => group.name).join(t`、`) + (groupCount > 6 ? t` 等` : '')) : null
    const folders = survey.folders.map(folder => {
      const as = pick([['scenes', t`当场景图（按文件名）`], ['cgs', t`当一组 CG`], ['', t`不带`]], folder.suggest === 'skip' ? '' : folder.suggest)
      const row = el('div', { class: 'card-pack-row card-bundle-folder' }, [el('span'), el('span', { class: 'card-pack-name' }, [el('b', { text: folder.folder || t`最外层` }), el('small', { class: 'hint', text: t`${folder.pictures.length} 张图` })]), as])
      return { folder, as, row }
    })
    const go = el('button', { type: 'button', class: 'btn primary', text: t`导入` })
    const note = el('p', { class: 'hint warn', hidden: true })
    const pictures = people.length || groupCount || folders.length

    go.onclick = guard(async () => {
      const chosen = cards.filter(item => item.box.checked)
      const onto = chosen.length ? '' : target?.value ?? ''
      if (pictures && !chosen.length && !onto && (people.some(item => item.box.checked) || cgs?.box.checked || folders.some(item => item.as.value))) {
        note.textContent = t`图要放到一张卡上：先在上面选一张`
        note.hidden = false
        return
      }
      go.disabled = true
      go.textContent = t`导入中…（图多的话要一会儿）`
      try {
        result = await api('/api/card-bundles/import', { method: 'POST', body: {
          pack: bundle.pack,
          choices: {
            cards: chosen.map(item => ({ path: item.card.path, replace: item.how?.value ?? '' })),
            target: onto,
            books: books.filter(item => item.box.checked).map(item => item.book.path),
            link: link.box.checked,
            regex: regex.filter(item => item.box.checked).map(item => item.item.path),
            presets: presets.filter(item => item.box.checked).map(item => item.item.path),
            people: Object.fromEntries(people.map(item => [item.person.key, item.box.checked ? 'new' : ''])),
            cgs: Boolean(cgs?.box.checked),
            folders: Object.fromEntries(folders.map(item => [item.folder.folder, item.as.value])),
          },
        } })
        dialog.close()
      } finally {
        go.disabled = false
        go.textContent = t`导入`
      }
    })

    const nothing = !cards.length && !books.length && !regex.length && !presets.length && !pictures
    dialog.replaceChildren(el('form', { method: 'dialog' }, [
      el('h2', { text: t`压缩包里有这些` }),
      el('p', { class: 'muted small', text: nothing
        ? t`这个压缩包里没认出角色卡、世界书、正则、预设或图片。`
        : t`勾上要导入的。按文件内容认的，没认出来的文件不会导入。` }),
      ...section(t`角色卡`, cards.map(item => item.row)),
      target ? el('div', { class: 'card-bundle-target' }, [el('span', { text: t`里面没有角色卡。图放到哪张卡上：` }), target]) : null,
      ...section(t`世界书`, [...books.map(item => item.row), ...(books.length ? [link.row] : [])]),
      ...section(t`正则`, regex.map(item => item.row)),
      ...section(t`预设`, presets.map(item => item.row)),
      ...section(t`角色的图`, people.map(item => item.row)),
      people.length ? el('p', { class: 'hint', text: t`按名字放进卡的角色名册（名册里有同名的就用那个）：头像当人设图，表情当表情差分。` }) : null,
      ...section(t`CG`, cgs ? [cgs.row] : []),
      cgs ? el('p', { class: 'hint', text: t`放进卡的 CG：视觉小说里剧情写到那一幕时全屏放。` }) : null,
      ...section(t`其他图片`, folders.map(item => item.row)),
      survey.others.length ? el('details', { class: 'hint' }, [el('summary', { text: t`不导入的文件 ${survey.others.length} 个` }), el('p', { text: survey.others.slice(0, 40).join('\n') + (survey.others.length > 40 ? '\n…' : '') })]) : null,
      note,
      el('div', { class: 'row between' }, [el('span'), el('div', { class: 'row' }, [el('button', { class: 'btn', value: 'cancel', text: t`取消` }), nothing ? null : go])]),
    ]))
    dialog.onclose = () => resolve(result)
    dialog.showModal()
  })
}

/** What an 整合包 brought, as the 已导入 line says it. */
export function bundleText(result) {
  const cards = result.cards.map(card => (card.updated ? t`角色卡「${card.updated}」更新为「${card.name}」` : t`角色卡「${card.name}」`))
  return [
    ...cards,
    result.books ? t`世界书 ${result.books} 本` : '',
    result.regex ? t`正则 ${result.regex} 条` : '',
    result.presets ? t`预设 ${result.presets} 个` : '',
    result.people ? t`${result.people} 个角色的图 ${result.pictures} 张` : '',
    result.cgs.groups ? t`CG ${result.cgs.groups} 组 ${result.cgs.pictures} 张` : '',
    result.scenes ? t`场景图 ${result.scenes} 张` : '',
  ].filter(Boolean).join(t`、`)
}

/** What a pack brought, as the 已导入 line says it: "立绘和表情 12 张、场景图 3 张…"; '' when it brought nothing. */
export function arrivedText(arrived) {
  if (!arrived) return ''
  return [
    arrived.roster ? t`角色名册 ${arrived.roster} 人` : '',
    arrived.sprites ? t`立绘和表情 ${arrived.sprites} 张` : '',
    arrived.scenes ? t`场景图 ${arrived.scenes} 张` : '',
    arrived.cgs ? t`CG ${arrived.cgs} 张` : '',
    arrived.cover ? t`开场页的图` : '',
    arrived.look ? t`外观的图 ${arrived.look} 张` : '',
    arrived.rules ? t`游戏规则设置` : '',
    arrived.foes ? t`敌人图 ${arrived.foes} 张` : '',
    arrived.skills ? t`技能图 ${arrived.skills} 张` : '',
    arrived.regexSets ? t`正则集 ${arrived.regexSets} 个` : '',
    arrived.settings ? t`画风和朗读设置` : '',
  ].filter(Boolean).join(t`、`)
}
