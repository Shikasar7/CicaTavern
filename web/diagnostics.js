// 错误日志 (设置 → 更多 → 错误日志, or 错误日志 on an error's toast): the report
// server/diagnostics.mjs writes, shown whole before it goes anywhere, to copy or
// save and send to the developer by hand. The open chat's last turn only when
// ticked. web/app.js loads this file when the window is first opened, so a
// server started before the file existed still serves the page.
import { t } from '/i18n.js'

let dialog = null

/** What the page knows about where it runs, for the report's head. */
function pageInfo() {
  const standalone = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches
  return {
    userAgent: navigator.userAgent,
    screen: `${screen.width}×${screen.height} @${Math.round(devicePixelRatio * 100) / 100}x · ${innerWidth}×${innerHeight}`,
    standalone: standalone || Boolean(window.AgentTavernAndroid),
  }
}

/** Copies through the clipboard API, or (a phone on the LAN: no secure page) the old way. */
async function copy(text, area) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    area.focus()
    area.select()
    return document.execCommand('copy')
  }
}

/**
 * @param deps - { api, el, toast, saveFile(name, text, message), getChat() → the open chat or null }
 */
export function openDiagnostics({ api, el, toast, saveFile, getChat }) {
  dialog ??= document.body.appendChild(el('dialog', { class: 'dialog diagnostics', 'aria-label': t`错误日志` }))
  const chat = getChat()
  let text = ''
  const area = el('textarea', { class: 'diag-text', readonly: true, rows: 16, spellcheck: 'false', 'aria-label': t`要发出去的内容`, text: t`正在整理……` })
  const count = el('span', { class: 'hint diag-count' })
  const withTurn = el('input', { type: 'checkbox', disabled: !chat })
  const buttons = []
  const button = (label, onclick, primary = false) => {
    const node = el('button', { type: 'button', class: `btn${primary ? ' primary' : ' ghost'}`, text: label, onclick })
    buttons.push(node)
    return node
  }

  // Only the latest report is shown: ticking 附带… on and off again quickly must not leave the story in it.
  let loads = 0
  async function load() {
    const mine = ++loads
    for (const node of buttons) node.disabled = true
    try {
      const report = await api('/api/diagnostics/report', { method: 'POST', body: { page: pageInfo(), chatId: chat?.id ?? '', lastTurn: withTurn.checked } })
      if (mine !== loads) return
      text = report.text
      area.value = text
      count.textContent = report.count ? t`记录了 ${report.count} 条错误` : t`还没有记录到错误`
      for (const node of buttons) node.disabled = false
    } catch (error) {
      if (mine !== loads) return
      text = ''
      // A server started before the log existed has no such route.
      area.value = error.status === 404 ? t`要重启后台服务后才能用：关掉所有窗口等一分钟，再从桌面图标打开。` : error.message
      buttons.at(-1).disabled = false
    }
  }
  withTurn.addEventListener('change', load)

  // The file's name says when, in local time as the report does: 2026-10-25 2103.
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`
  dialog.replaceChildren(
    el('h2', { text: t`错误日志` }),
    el('p', { class: 'hint', text: t`出了问题时，把下面这份日志发给开发者（QQ 群、GitHub 或私信），能更快找到原因。日志只存在这台设备上，应用不会自己发出去；下面就是要发的全部内容，可以先看一遍。里面没有对话和角色卡的内容，密钥、令牌和电脑的用户名已经去掉。` }),
    el('label', { class: 'check-row' }, [withTurn, el('span', { text: chat ? t`附带当前对话的最后一轮（你的输入和模型的原始输出）：回复的格式、视觉小说里认错人这类问题用得上` : t`附带当前对话的最后一轮（先打开一个对话）` })]),
    area,
    el('div', { class: 'row end diag-actions' }, [
      button(t`清空记录`, async () => {
        if (!confirm(t`清空这台设备上记录的错误？清空后，之前的错误就导不出来了。`)) return
        await api('/api/diagnostics', { method: 'DELETE' }).catch(error => toast(error.message))
        load()
      }),
      count,
      el('span', { class: 'grow' }),
      button(t`复制`, async () => toast((await copy(text, area)) ? t`已复制，可以直接粘贴发送` : t`没能复制：在上面的框里全选后手动复制`)),
      button(t`保存为文件`, () => saveFile(t`CicaTavern 错误日志 ${stamp}.txt`, text, t`已保存，把这个文件发给开发者就行`)),
      button(t`关闭`, () => dialog.close(), true),
    ]),
  )
  dialog.showModal()
  load()
}
