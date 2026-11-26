// 直连对话's file tools on the page (server/tools/index.mjs): the panel where they are turned on and the chat is given
// folders, and the card above the input box where a change waits for the player's yes. The card is the server's to say,
// not this page's: it is there after a reload, and on a phone.
import { t } from '/i18n.js'

const OPS = () => ({ create: t`新建文件`, write: t`重写文件`, edit: t`修改文件`, move: t`移动文件`, delete: t`删除文件`, read: t`读取文件` })
const RUN_OPS = () => ({ create: t`新建`, write: t`修改`, edit: t`修改`, move: t`移动`, delete: t`删除` })

/**
 * @param deps - { api, el, guard, toast, getChat, canUse(chat): its model can use tools, undo(run): 撤销 a turn's changes,
 *   onChange(): the chat's folders changed, setSearchOff(): 联网 was turned off with the first folder }
 */
export function initTools({ api, el, guard, toast, getChat, canUse, undo, onChange = () => {}, setSearchOff = () => {} }) {
  const state = { chatId: null, view: null, dialog: null, browse: null, adding: false }
  const box = el('div', { class: 'tools-ask', role: 'region', 'aria-label': t`等你确认`, hidden: true })
  document.querySelector('#composer .composer-box')?.before(box)

  const folderName = folder => (folder.id === 'workspace' ? t`工作文件夹` : folder.label)

  /** What the chat has, read again. */
  async function load() {
    const chat = getChat()
    if (!chat) return
    const view = await api(`/api/chats/${chat.id}/tools`)
    if (getChat()?.id === chat.id) take(chat.id, view)
  }
  function take(chatId, view) {
    const before = JSON.stringify([state.chatId, state.view?.on, state.view?.folders])
    state.chatId = chatId
    state.view = view
    drawAsk()
    if (state.dialog) drawPanel()
    if (JSON.stringify([chatId, view.on, view.folders]) !== before) onChange()
  }

  /** After each drawing of the chat: its own folders and what waits in it. */
  function sync(chat) {
    if (!chat) {
      state.chatId = null
      state.view = null
      return drawAsk()
    }
    if (chat.id !== state.chatId) {
      state.chatId = chat.id
      state.view = null
      drawAsk()
      load().catch(() => {})
    }
  }

  const folders = () => state.view?.folders ?? []

  // ─── Waiting for a yes ─────────────────────────────────────────────────

  function diffTable(diff) {
    const marks = { add: '+', del: '−', same: ' ' }
    return el('div', { class: 'tools-diff', tabindex: '0', role: 'group', 'aria-label': t`改动` }, [
      ...diff.rows.map(row => (row.kind === 'gap'
        ? el('div', { class: 'gap', text: t`…… ${row.lines} 行没有变` })
        : el('div', { class: row.kind }, [el('span', { class: 'mark', 'aria-hidden': 'true', text: marks[row.kind] }), el('span', { text: row.text || ' ' })]))),
      diff.clipped ? el('div', { class: 'gap', text: t`…… 还有 ${diff.clipped} 行没有列出` }) : null,
    ].filter(Boolean))
  }

  function askCard(item) {
    const answer = body => guard(async () => {
      for (const button of box.querySelectorAll('button')) button.disabled = true
      const chatId = state.chatId
      try {
        take(chatId, await api(`/api/chats/${chatId}/tools/answer`, { method: 'POST', body: { id: item.id, ...body() } }))
      } catch (error) {
        // Answered elsewhere, or the turn ended: what waits now.
        await load()
        throw error
      }
    })
    if (item.kind === 'tokens') {
      return el('div', { class: 'tools-card' }, [
        el('b', { text: t`这一轮用得比较多，要接着做吗？` }),
        el('p', { class: 'muted small', text: t`用工具的这几步合计已经发了约 ${Math.round(item.tokens / 1000)} 千 token。` }),
        el('div', { class: 'tools-actions' }, [
          el('button', { type: 'button', class: 'btn small', text: t`先停在这里`, onclick: answer(() => ({ ok: false })) }),
          el('button', { type: 'button', class: 'btn small primary', text: t`接着做`, onclick: answer(() => ({ ok: true })) }),
        ]),
      ])
    }
    const free = el('input', { type: 'checkbox' })
    const reason = el('input', { type: 'text', maxlength: '500', placeholder: t`不同意的话，想告诉它什么（可空）`, 'aria-label': t`不同意的原因` })
    // It is in the chat's own form: Enter here must not send, or stop, the chat.
    reason.addEventListener('keydown', event => {
      if (event.key === 'Enter') event.preventDefault()
    })
    const danger = item.op === 'delete' || item.op === 'read'
    return el('div', { class: `tools-card${item.runs || danger ? ' risky' : ''}` }, [
      el('div', { class: 'tools-card-head' }, [
        el('b', { text: OPS()[item.op] ?? item.name }),
        el('span', { class: 'tools-path', text: item.to ? `${item.path} → ${item.to}` : item.path }),
        item.diff ? el('span', { class: 'tools-count', text: `+${item.diff.added} −${item.diff.removed}` }) : null,
      ].filter(Boolean)),
      item.said ? el('p', { class: 'muted small', text: item.said }) : null,
      item.runs ? el('p', { class: 'bad small', text: t`这种文件能被当成程序运行。看清楚内容再同意。` }) : null,
      item.op === 'read' ? el('p', { class: 'bad small', text: t`这个文件名像是存密钥或密码的。同意后，内容会发给你选的模型供应商。` }) : null,
      item.op === 'delete' ? el('p', { class: 'muted small', text: t`旧版会留 30 天，可以撤销。` }) : null,
      item.diff ? diffTable(item.diff) : null,
      item.canFree ? el('label', { class: 'plot-check small' }, [free, el('span', { text: t`这段对话里，这个文件夹的改动不用再问（删除，和能运行的文件还是会问）` })]) : null,
      reason,
      el('div', { class: 'tools-actions' }, [
        el('button', { type: 'button', class: 'btn small', text: t`不同意`, onclick: answer(() => ({ ok: false, reason: reason.value })) }),
        el('button', { type: 'button', class: `btn small ${danger ? 'danger' : 'primary'}`, text: t`同意`, onclick: answer(() => ({ ok: true, free: free.checked })) }),
      ]),
    ].filter(Boolean))
  }

  let drawn = ''
  function drawAsk() {
    const pending = state.view?.pending ?? []
    const key = JSON.stringify([state.chatId, pending.map(item => item.id)])
    // Not drawn over what the player is typing in it.
    if (key === drawn) return
    drawn = key
    box.hidden = !pending.length
    box.replaceChildren(...pending.slice(0, 1).map(askCard))
  }

  // ─── The panel ─────────────────────────────────────────────────────────

  const put = guard(async list => {
    const chatId = state.chatId
    const view = await api(`/api/chats/${chatId}/tools`, { method: 'PUT', body: { folders: list } })
    take(chatId, view)
    if (view.searchOff) {
      setSearchOff()
      toast(t`这段对话的联网搜索关掉了：搜索词由供应商直接发出去，拦不住文件里的内容跟着出去。需要的话可以再打开。`, 8000)
    }
  })
  const current = () => folders().map(({ id, mode, free }) => ({ id, mode, free }))

  function folderRow(folder) {
    const mode = el('select', { 'aria-label': t`能不能改` }, [['read', t`只读`], ['write', t`可以改`]].map(([id, name]) => el('option', { value: id, text: name, selected: folder.mode === id })))
    mode.addEventListener('change', () => put(current().map(item => (item.id === folder.id ? { ...item, mode: mode.value, free: false } : item))))
    const free = el('input', { type: 'checkbox', checked: folder.free })
    free.addEventListener('change', () => put(current().map(item => (item.id === folder.id ? { ...item, free: free.checked } : item))))
    return el('li', { class: 'tools-folder' }, [
      el('div', { class: 'tools-folder-name' }, [el('b', { text: folderName(folder) }), folder.path ? el('small', { class: 'muted', text: folder.path }) : null].filter(Boolean)),
      mode,
      el('button', { type: 'button', class: 'btn small ghost', text: t`移除`, title: t`这段对话不再用这个文件夹，里面的文件不动`, onclick: () => put(current().filter(item => item.id !== folder.id)) }),
      folder.mode === 'write' ? el('label', { class: 'plot-check small' }, [free, el('span', { text: t`改动不用再问（删除，和能运行的文件还是会问）` })]) : null,
    ].filter(Boolean))
  }

  const addPath = guard(async path => {
    await put([...current(), { path, mode: 'read' }])
    state.browse = null
    state.adding = false
    drawPanel()
  })
  const openBrowse = guard(async path => {
    state.browse = await api(`/api/tools/browse?path=${encodeURIComponent(path)}`)
    drawPanel()
  })

  function browser() {
    const at = state.browse
    const typed = el('input', { type: 'text', placeholder: t`或者粘贴文件夹的完整路径`, 'aria-label': t`文件夹路径`, value: at.path })
    return el('div', { class: 'tools-browse' }, [
      el('div', { class: 'tools-browse-head' }, [
        at.parent !== null ? el('button', { type: 'button', class: 'btn small ghost', text: t`上一层`, onclick: () => openBrowse(at.parent) }) : null,
        typed,
        el('button', { type: 'button', class: 'btn small', text: t`打开`, onclick: () => openBrowse(typed.value) }),
      ].filter(Boolean)),
      el('ul', { class: 'tools-dirs' }, at.dirs.length
        ? at.dirs.map(dir => el('li', {}, [el('button', { type: 'button', class: 'tools-dir', text: dir.name, onclick: () => openBrowse(dir.path) })]))
        : [el('li', { class: 'muted small', text: t`里面没有文件夹` })]),
      at.path && at.why ? el('p', { class: 'bad small', text: at.why }) : null,
      el('div', { class: 'tools-actions' }, [
        el('button', { type: 'button', class: 'btn small', text: t`取消`, onclick: () => {
          state.browse = null
          drawPanel()
        } }),
        el('button', { type: 'button', class: 'btn small primary', text: t`加这个文件夹`, disabled: !at.path || Boolean(at.why), onclick: () => addPath(at.path) }),
      ]),
    ].filter(Boolean))
  }

  function drawPanel() {
    const body = state.dialog?.querySelector('.tools-body')
    const view = state.view
    if (!body || !view) return
    const turn = on => guard(async () => {
      await api('/api/tools', { method: 'PUT', body: { on } })
      await load()
    })
    if (!view.on) {
      body.replaceChildren(
        el('p', { text: t`打开后，可以给直连对话指定文件夹，让助手读里面的文件，需要的话也能改。` }),
        el('ul', { class: 'tools-notes small' }, [
          t`只能用你加进这段对话的文件夹，别的地方碰不到；存密钥的、系统的和 CicaTavern 自己的文件夹加不了。`,
          t`助手读过的内容会发给你选的模型供应商。`,
          t`改文件之前会给你看改动，同意了才写；删除每次都问。改之前的旧版留 30 天，回复下面可以撤销。`,
          t`文件只有一份：重新生成、换分支、删消息都不会把文件改回去。`,
          t`每用一次工具，整段对话要再发给模型一次，费用会比普通聊天多。`,
          t`不能运行命令，角色卡的对话里没有这些工具。`,
        ].map(text => el('li', { text }))),
        view.local ? '' : el('p', { class: 'bad small', text: t`要在运行 CicaTavern 的这台电脑上打开，手机上不能开。` }),
        el('div', { class: 'tools-actions' }, [el('button', { type: 'button', class: 'btn primary', text: t`打开文件工具`, disabled: !view.local, onclick: turn(true) })]),
      )
      return
    }
    const list = folders()
    const unused = view.known.filter(item => !list.some(folder => folder.id === item.id))
    body.replaceChildren(...[
      canUse(getChat()) ? null : el('p', { class: 'bad small', text: t`这段对话现在的模型用不了文件工具：在顶栏换成供应商的模型。` }),
      el('h3', { text: t`这段对话能用的文件夹` }),
      list.length ? el('ul', { class: 'tools-folders' }, list.map(folderRow)) : el('p', { class: 'muted small', text: t`还没有。加一个，助手就能用了。` }),
      state.browse ? browser() : el('div', { class: 'tools-add' }, [
        view.anyFolder && view.local ? el('button', { type: 'button', class: 'btn small primary', text: t`加文件夹…`, onclick: () => openBrowse('') }) : null,
        list.some(folder => folder.id === 'workspace') ? null : el('button', { type: 'button', class: 'btn small', text: t`用工作文件夹`, title: view.workspace ? t`CicaTavern 自己的一个空文件夹：${view.workspace}` : t`CicaTavern 自己的一个空文件夹`, onclick: () => put([...current(), { id: 'workspace', mode: 'write' }]) }),
        ...unused.map(item => el('span', { class: 'tools-known' }, [
          el('button', { type: 'button', class: 'btn small', text: item.label, title: item.path ? t`以前加过：${item.path}` : t`以前加过的文件夹`, onclick: () => put([...current(), { id: item.id, mode: 'read' }]) }),
          el('button', { type: 'button', class: 'btn small ghost', text: '✕', title: t`从列表里去掉（所有对话都不再用它，文件不动）`, 'aria-label': t`从列表里去掉「${item.label}」`, onclick: guard(async () => {
            if (!confirm(t`把「${item.label}」从列表里去掉？所有对话都不再能用它，里面的文件不动。`)) return
            await api(`/api/tools/known/${item.id}`, { method: 'DELETE' })
            await load()
          }) }),
        ])),
      ].filter(Boolean)),
      !view.anyFolder || view.local ? null : el('p', { class: 'muted small', text: t`新的文件夹要在运行 CicaTavern 的这台电脑上加。` }),
      view.runs.length ? el('details', { class: 'tools-runs' }, [
        el('summary', { text: t`这段对话改过的文件` }),
        el('ul', {}, view.runs.map(run => el('li', {}, [
          el('span', { class: 'muted small', text: new Date(run.at).toLocaleString() }),
          el('span', { text: run.files.map(file => `${RUN_OPS()[file.op] ?? ''} ${file.to ? `${file.path} → ${file.to}` : file.path}`).join(t`；`) }),
          run.undone ? el('span', { class: 'muted small', text: t`已撤销` }) : el('button', { type: 'button', class: 'btn small ghost', text: t`撤销`, onclick: guard(async () => {
            await undo(run.run)
            await load()
          }) }),
        ]))),
      ]) : null,
      el('p', { class: 'muted small', text: t`助手读过的内容会发给你选的模型供应商。重新生成、换分支不会把文件改回去，要用「撤销」。` }),
      el('div', { class: 'tools-foot' }, [el('button', { type: 'button', class: 'btn small ghost', text: t`关掉文件工具`, title: t`所有对话都不能用文件了；加过的文件夹还记着`, onclick: turn(false) })]),
    ].filter(Boolean))
  }

  async function open() {
    const dialog = el('dialog', { class: 'dialog wide tools-dialog', 'aria-label': t`文件工具` }, [
      el('div', { class: 'plot-dialog-head' }, [
        el('h2', { text: t`文件工具` }), el('span', { class: 'plot-badge', text: 'Beta' }), el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`关闭`, onclick: () => dialog.close() }),
      ]),
      el('div', { class: 'tools-body' }, [el('p', { class: 'muted', text: t`读取中……` })]),
    ])
    dialog.addEventListener('close', () => {
      dialog.remove()
      state.dialog = null
      state.browse = null
    })
    document.body.append(dialog)
    state.dialog = dialog
    dialog.showModal()
    await load()
    drawPanel()
  }

  return { sync, load: guard(load), open: guard(open), folders }
}
