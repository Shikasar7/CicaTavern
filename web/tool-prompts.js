// 内置功能的附加提示词 (设置 → 写作): the player's own words for the app's model calls outside the story,
// a text per group (server/context.mjs toolNote): 压缩与长期记忆, 检查这张卡, 创作向导与对话修改, 其他辅助.
// Each can take entries picked from a preset (a 破限, say), copied in as text: the preset itself is not
// sent, since its rules on the story's output (choices, status bars, staying in character) would break the
// formats these calls are read by. The task's own format wins over what is written here.
// web/app.js loads this file when the window is first opened, so a server started before the file existed
// still serves the page.
import { t } from '/i18n.js'
import { VN_ID } from '/shared/basic.js'
import { ownEntryName } from '/basic-options.js'

const ICON_CLOSE = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>'
const MAX = 8000

const GROUPS = [
  {
    id: 'memory',
    title: t`压缩与长期记忆`,
    covers: t`压缩上下文时写剧情存档、长期记忆记下和整理记忆条目。这几项借着对话本身问模型，对话的预设已经在里面了；这里写的附在提问的最后。`,
    placeholder: t`比如：剧情存档里保留每个人物的口头禅；记忆条目用第三人称写`,
  },
  {
    id: 'check',
    title: t`检查这张卡`,
    covers: t`「检查这张卡」让模型读卡、提修改建议的那一步。`,
    placeholder: t`比如：建议用简体中文写；不要建议删减成人内容`,
  },
  {
    id: 'forge',
    title: t`创作向导与对话修改`,
    covers: t`创作向导的每一步（找灵感、共创、方案、写条目和开场白、审稿、试玩），以及世界书、预设、正则、外观、角色卡的「对话修改」。`,
    placeholder: t`比如：这是成人向作品，题材不设限，照我的要求写`,
  },
  {
    id: 'helper',
    title: t`其他辅助`,
    covers: t`游戏规则的建议、物品归类和敌人图鉴，角色名册的起草和补充，视觉小说的判断表情，场景背景的提示词。配图提示词在「配图」设置里有自己的「额外要求」。`,
    placeholder: t`比如：角色名用卡里的写法，不要翻译`,
  },
]

let dialog = null

/**
 * @param deps - { api, el, toast, guard, onSaved(settings) }
 * @param group - the group to scroll to and put the cursor in, or none
 */
export async function openToolPrompts({ api, el, toast, guard, onSaved }, group = '') {
  dialog ??= document.body.appendChild(el('dialog', { class: 'dialog tool-prompts', 'aria-label': t`内置功能的附加提示词` }))
  let saved = (await api('/api/settings')).toolPrompts ?? {}

  async function save(id, text) {
    const settings = await api('/api/settings', { method: 'PUT', body: { toolPrompts: { ...saved, [id]: text } } })
    saved = settings.toolPrompts ?? {}
    onSaved?.(settings)
    toast(text.trim() ? t`已保存，下次调用时生效` : t`已清空`)
  }

  /** 从预设里挑: the presets, then the chosen one's entries to tick; ticked ones go after what is written. */
  async function picker(area, commit) {
    const box = el('div', { class: 'tp-pick' })
    const list = await api('/api/presets').catch(() => [])
    const presets = [['basic', t`基础预设`], [VN_ID, t`视觉小说预设`], ...list.map(p => [p.id, p.name])]
    const select = el('select', { 'aria-label': t`预设` }, presets.map(([id, name]) => el('option', { value: id, text: name })))
    const entries = el('ul', { class: 'tp-entries' })
    const take = el('button', { type: 'button', class: 'btn small primary', text: t`抄进去`, disabled: true })
    let shown = []
    const ticks = () => [...entries.querySelectorAll('input:checked')].map(input => shown[Number(input.value)])
    const load = guard(async () => {
      const detail = await api(`/api/presets/${select.value}`)
      const nameOf = p => p.name || (p.slot ? ownEntryName(select.value, p) : t`条目`)
      // Imported: every entry with text; built-in: its paragraphs and the player's own (a marker has no text).
      shown = detail.prompts.filter(p => !p.marker && p.kind !== 'marker' && p.content?.trim())
      entries.replaceChildren(...(shown.length
        ? shown.map((p, i) => el('li', {}, el('label', { class: 'check-row' }, [
            el('input', { type: 'checkbox', value: String(i), onchange: () => { take.disabled = !ticks().length } }),
            el('span', { class: 'tp-entry' }, [
              el('b', { text: nameOf(p) }),
              el('span', { class: 'tp-entry-text', text: p.content.replace(/\s+/g, ' ').slice(0, 120) }),
            ]),
          ])))
        : [el('li', { class: 'muted', text: t`这个预设没有带文字的条目` })]))
      take.disabled = true
    })
    select.addEventListener('change', load)
    take.addEventListener('click', guard(async () => {
      const picked = ticks().map(p => p.content.trim()).filter(Boolean)
      if (!picked.length) return
      area.value = [area.value.trim(), ...picked].filter(Boolean).join('\n\n').slice(0, MAX)
      await commit()
      box.remove()
    }))
    box.append(
      el('p', { class: 'hint', text: t`勾上想用的条目，抄成文字放进上面的框里，之后可以改。只抄这一次：以后改预设，这里不会跟着变。一般只抄破限、写作要求这类；要求每轮输出选项、状态栏或「以角色身份回复」的条目别抄，内置功能的回答要按固定格式写，会被带偏。` }),
      el('div', { class: 'tp-pick-row' }, [select, take, el('button', { type: 'button', class: 'btn small ghost', text: t`取消`, onclick: () => box.remove() })]),
      entries,
    )
    await load()
    return box
  }

  const blocks = GROUPS.map(g => {
    const area = el('textarea', { rows: 4, spellcheck: 'false', maxlength: String(MAX), placeholder: g.placeholder, 'data-group': g.id })
    area.value = saved[g.id] ?? ''
    const count = el('span', { class: 'tp-count' })
    const counted = () => { count.textContent = area.value.trim() ? t`${area.value.length.toLocaleString()} 字` : t`没写` }
    counted()
    const commit = () => save(g.id, area.value)
    area.addEventListener('input', counted)
    area.addEventListener('change', guard(async () => {
      if (area.value === (saved[g.id] ?? '')) return
      await commit()
    }))
    const block = el('section', { class: 'tp-group' }, [
      el('div', { class: 'tp-head' }, [el('h3', { text: g.title }), count]),
      el('p', { class: 'hint', text: g.covers }),
      area,
    ])
    const pick = el('button', {
      type: 'button', class: 'btn small', text: t`从预设里挑`,
      onclick: guard(async () => {
        block.querySelector('.tp-pick')?.remove()
        block.append(await picker(area, async () => { counted(); await commit() }))
      }),
    })
    block.insertBefore(el('div', { class: 'tp-actions' }, [pick]), null)
    return block
  })

  dialog.replaceChildren(
    el('form', { method: 'dialog', class: 'preset-close' }, [el('button', { class: 'btn ghost icon', 'aria-label': t`关闭`, html: ICON_CLOSE })]),
    el('h2', { text: t`内置功能的附加提示词` }),
    el('p', { class: 'hint', text: t`预设只管故事正文。压缩、长期记忆、检查这张卡、创作向导这些内置功能有自己的提示词，回答要按固定格式（JSON、标签）写给应用读，所以不套整个预设。想让它们也照你的要求来（比如破限），写在下面对应的框里，或者从预设里挑几条抄进来。写的内容放在功能自己的说明后面；和功能要求的输出格式冲突时，以格式为准。{{user}} 和 {{char}} 只在压缩和长期记忆里换成名字。` }),
    ...blocks,
  )
  if (!dialog.open) dialog.showModal()
  const target = group && dialog.querySelector(`textarea[data-group="${CSS.escape(group)}"]`)
  if (target) {
    target.scrollIntoView({ block: 'center' })
    target.focus()
  }
}
