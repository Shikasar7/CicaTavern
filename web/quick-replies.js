// 快捷回复 (设置 → 写作 → 快捷回复, the ⚙ at the end of the row over the input box): buttons the player makes, as
// SillyTavern's Quick Reply. Each has a label and what it does: a line starting with a command (`/hide 1-20`) runs
// as STscript in this chat, other words are sent as the player's message, or (`fill`) put in the input box to edit.
// Saved in the settings (server/store.mjs cleanQuickReplies), so the phone and the computer share them.
// web/app.js loads this file when the window is first opened, so a server started before the file existed still
// serves the page.
import { t } from '/i18n.js'

const ICON_CLOSE = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>'

/** What a player who never set any up starts from: hiding old floors after a summary written by hand. */
export const DEFAULT_QUICK_REPLIES = () => [
  { label: t`写总结`, fill: true, text: t`（暂停角色扮演，这一条不要续写剧情。）请按时间顺序总结到目前为止的剧情：发生了哪些事，人物的关系和状态有什么变化，还有哪些没解决的线索。只写总结，五百字以内。` },
  { label: t`隐藏旧楼层`, fill: false, text: t`/input default=10 只留最近几层不隐藏？（开场白不算，更早的都不再发给模型） | /hideold {{pipe}}` },
  { label: t`全部取消隐藏`, fill: false, text: '/unhide 0-{{lastMessageId}}' },
]

let dialog = null

/**
 * @param deps - { api, el, toast, guard, onSaved(settings) }
 */
export async function openQuickReplies({ api, el, toast, guard, onSaved }) {
  dialog = dialog ?? (document.body.appendChild(el('dialog', { class: 'dialog quick-replies', 'aria-label': t`快捷回复` })))
  const saved = (await api('/api/settings')).quickReplies
  let items = (saved ? saved.items : DEFAULT_QUICK_REPLIES()).map(item => ({ ...item }))
  const show = el('input', { type: 'checkbox', class: 'switch', checked: saved ? saved.show : true })
  const list = el('div', { class: 'qr-edit-list' })

  function draw() {
    list.replaceChildren(...(items.length
      ? items.map((item, i) => {
          const label = el('input', { value: item.label, maxlength: '24', placeholder: t`按钮上的字`, 'aria-label': t`按钮上的字`, oninput: () => { item.label = label.value } })
          const text = el('textarea', { rows: 2, maxlength: '4000', spellcheck: 'false', placeholder: t`要发的话，或者 / 开头的命令`, 'aria-label': t`点了做什么`, oninput: () => { item.text = text.value } })
          text.value = item.text
          const fill = el('input', { type: 'checkbox', checked: item.fill, onchange: () => { item.fill = fill.checked } })
          const move = (step, text) => el('button', {
            type: 'button', class: 'btn small ghost', text, disabled: i + step < 0 || i + step >= items.length,
            onclick: () => { [items[i], items[i + step]] = [items[i + step], items[i]]; draw() },
          })
          return el('div', { class: 'qr-edit' }, [
            el('div', { class: 'qr-edit-head' }, [
              label,
              move(-1, '↑'),
              move(1, '↓'),
              el('button', { type: 'button', class: 'btn small ghost', text: t`删除`, onclick: () => { items.splice(i, 1); draw() } }),
            ]),
            text,
            el('label', { class: 'check-row' }, [fill, el('span', { text: t`填进输入框，不直接发（改一改再发）` })]),
          ])
        })
      : [el('p', { class: 'hint', text: t`还没有按钮。` })]))
  }
  draw()

  const save = guard(async () => {
    const kept = items.map(item => ({ ...item, label: item.label.trim(), text: item.text.trim() })).filter(item => item.label && item.text)
    const settings = await api('/api/settings', { method: 'PUT', body: { quickReplies: { show: show.checked, items: kept } } })
    onSaved?.(settings)
    toast(t`已保存`)
    dialog.close()
  })

  dialog.replaceChildren(
    el('form', { method: 'dialog', class: 'preset-close' }, [el('button', { class: 'btn ghost icon', 'aria-label': t`关闭`, html: ICON_CLOSE })]),
    el('h2', { text: t`快捷回复` }),
    el('p', { class: 'hint', text: t`输入框上方的一排按钮，点一下发一句常用的话，或者跑一串命令。/ 开头的是命令，别的字直接当你的发言发出去（勾了「填进输入框」就只填进去）。所有对话共用，手机和电脑一样。` }),
    el('label', { class: 'switch-row' }, [show, el('span', { text: t`在输入框上方显示` })]),
    list,
    el('div', { class: 'row' }, [
      el('button', { type: 'button', class: 'btn small', text: t`＋ 加一个`, onclick: () => { items.push({ label: '', text: '', fill: false }); draw(); list.lastElementChild?.querySelector('input')?.focus() } }),
      el('button', { type: 'button', class: 'btn small ghost', text: t`加回默认的三个`, onclick: () => { items.push(...DEFAULT_QUICK_REPLIES()); draw() } }),
    ]),
    el('details', { class: 'qr-help' }, [
      el('summary', { text: t`能用的命令` }),
      el('p', { class: 'hint', text: t`楼层从 0 数起，0 是开场白，你的一句话和一条回复各算一层。隐藏的回合留在对话里、变淡显示，不再发给模型，和回复下面的「隐藏这一轮」一样；压缩之前的回合模型只读剧情存档，隐藏它们不起作用，会跳过。` }),
      el('ul', { class: 'qr-help-list' }, [
        ['/hide 1-20', t`隐藏第 1 到 20 层`],
        ['/unhide 1-20', t`取消隐藏`],
        ['/hideold 10', t`只留最近 10 层，更早的都隐藏`],
        ['/unhide 0-{{lastMessageId}}', t`全部取消隐藏（{{lastMessageId}} 是最新一层的编号）`],
        [t`/send 文字 | /trigger`, t`把文字当你的发言发出去`],
        [t`/setinput 文字`, t`把文字填进输入框`],
        [t`/input 问题 | /echo {{pipe}}`, t`弹框问一句，把回答接着用`],
      ].map(([code, what]) => el('li', {}, [el('code', { text: code }), el('span', { text: what })]))),
      el('p', { class: 'hint', text: t`这些命令也能直接在输入框里打，回车就执行，不会发给模型。用 | 把几条连起来，前一条的结果在 {{pipe}} 里。SillyTavern 的 STscript 大多能用，用不了的会提示跳过。` }),
    ]),
    el('div', { class: 'row end' }, [
      el('button', { type: 'button', class: 'btn ghost', text: t`取消`, onclick: () => dialog.close() }),
      el('button', { type: 'button', class: 'btn primary', text: t`保存`, onclick: save }),
    ]),
  )
  if (!dialog.open) dialog.showModal()
}
