// 导出角色卡 → 带上图片和设置 (the card's ⋯, and 创作角色卡 → 状态栏与门面): tick what goes with the card
// (server/card-pack.mjs says what it has), and take the zip. web/app.js loads this file when the window is first
// opened, so a server started before the file existed still serves the page.
import { t } from '/i18n.js'

const PART_TEXT = () => ({
  roster: [t`角色名册和人设图`, t`名册里的角色、长相和衣着的描述，和各自的人设图`],
  sprites: [t`立绘和表情`, t`每个角色的立绘和表情图。它们跟着名册里的角色走，所以名册会一起带上`],
  scenes: [t`场景图`, t`各个地点的场景图：视觉小说的背景、状态栏顶上和开场页用的`],
  cover: [t`开场页的图`, t`开场页自己选的那张背景图`],
  look: [t`外观的图`, t`定制外观用的装饰图，和它用到的场景、立绘的小图`],
  rules: [t`游戏规则设置`, t`这张卡的游戏规则：档位、属性、技能、物品、敌人、成长和战斗设置。不勾的话，导出的卡里不带规则`],
  foes: [t`敌人图`, t`游戏规则里敌人的立绘。它们跟着规则里的敌人走，所以规则会一起带上`],
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
    // 立绘和表情 belong to the cast, 敌人图 to the rules: ticking them ticks those, which stay ticked while they are.
    if (picked.has('sprites')) picked.add('roster')
    if (picked.has('foes')) picked.add('rules')
    for (const [key, box] of boxes) {
      box.checked = picked.has(key)
      box.disabled = (key === 'roster' && picked.has('sprites')) || (key === 'rules' && picked.has('foes'))
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
 * A zip picked in 导入角色卡: sent as it is, then imported as a card file is.
 * @param ask - (previous { id, name }) → the id to update in place, or '' for a new card.
 * → the imported card ({ name, updated?, inherited?, arrived }).
 */
export async function importCardPack({ api }, file, ask) {
  const res = await fetch('/api/card-packs', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-agent-tavern': '1' }, body: file })
  const sent = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(sent.error || t`请求失败（${res.status}）`), { status: res.status })
  const replace = sent.previous ? ask(sent.previous) : ''
  return api('/api/cards/import', { method: 'POST', body: { pack: sent.pack, ...(replace ? { replace } : {}) } })
}

/** What a pack brought, as the 已导入 line says it: "立绘和表情 12 张、场景图 3 张…"; '' when it brought nothing. */
export function arrivedText(arrived) {
  if (!arrived) return ''
  return [
    arrived.roster ? t`角色名册 ${arrived.roster} 人` : '',
    arrived.sprites ? t`立绘和表情 ${arrived.sprites} 张` : '',
    arrived.scenes ? t`场景图 ${arrived.scenes} 张` : '',
    arrived.cover ? t`开场页的图` : '',
    arrived.look ? t`外观的图 ${arrived.look} 张` : '',
    arrived.rules ? t`游戏规则设置` : '',
    arrived.foes ? t`敌人图 ${arrived.foes} 张` : '',
    arrived.regexSets ? t`正则集 ${arrived.regexSets} 个` : '',
    arrived.settings ? t`画风和朗读设置` : '',
  ].filter(Boolean).join(t`、`)
}
