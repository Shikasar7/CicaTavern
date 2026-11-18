// 设置 → 更多 → 备份与换设备 (server/backup.mjs): tick what goes into one zip and take it; on the other device, pick
// that zip, see what it holds, tick what to take and whether what is here already stays. web/app.js loads this file
// when the window is first opened, so a server started before the file existed still serves the page.
import { t } from '/i18n.js'

const KIND_TEXT = () => ({
  cards: [t`角色卡及其图片`, t`每张卡和它的头像、角色名册、立绘、场景图、CG、存档、配乐、游戏规则，还有创作中的卡`],
  chats: [t`对话和配图`, t`所有对话的每一轮、每个分支，和回复里的配图`],
  history: [t`抽图历史`, t`重画、换图之前的旧图。占地方，一般不用带`],
  books: [t`世界书`, t`导入的独立世界书，和哪些是全局世界书`],
  presets: [t`预设和预设脚本`, t`导入的预设、预设带的脚本，和内置预设的改动；新对话默认用哪个预设`],
  lists: [t`正则、人设、文风、提示词库`, t`全局正则和正则集、你的角色、文风、屏蔽词，和配图的提示词库`],
  settings: [t`外观和其余设置`, t`外观和背景图、界面语言、写作语言、快捷回复、阅读、上下文与压缩、长期记忆等。网络代理和手机访问是这台设备自己的，不带`],
  providers: [t`供应商、配图和朗读设置`, t`供应商的地址、模型和参数，默认模型，配图和朗读的设置，ComfyUI 工作流。本机的 ComfyUI、SD、语音桥接地址不带`],
  keys: [t`密钥`, t`供应商的 API Key 和请求头里的密钥，朗读和 NovelAI 的密钥`],
  usage: [t`用量记录`, t`每轮用了多少 token、花了多少钱的记录`],
})

/** 1.8 GB, 340 KB: a size as a person reads it. */
export function sizeText(bytes) {
  if (bytes >= 1024 ** 3) return t`${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return t`${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`
  return t`${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** "12 张卡", "3 段对话": a kind's count as its row says it ('' where a count says nothing). */
function countText(key, n) {
  if (!n) return ''
  return {
    cards: t`${n} 张卡`,
    chats: t`${n} 段对话`,
    history: t`${n} 张图`,
    books: t`${n} 本`,
    presets: t`${n} 个`,
    providers: t`${n} 个供应商`,
    keys: t`${n} 个`,
  }[key] ?? ''
}

const KIND_NAME = () => ({
  cards: t`角色卡`, drafts: t`创作中的卡`, chats: t`对话`, books: t`世界书`, presets: t`预设`, providers: t`供应商`, keys: t`密钥文件`,
  regex: t`正则`, regexSets: t`正则集`, personas: t`你的角色`, styles: t`文风`, blockwords: t`屏蔽词`, prompts: t`提示词库条目`,
  settings: t`项设置`, usage: t`条用量记录`, history: t`抽图历史`, lists: t`列表`,
})

const KEY_WARNING = () => t`勾上后，备份里会有你的 API Key 和其他密钥：拿到这个文件的人能用你的额度。只在自己的设备之间用，导入后把文件删掉，不要发给别人。`

let dialog = null

/**
 * @param deps - { api, el, toast, guard, download(path, name, mime), canSave: false where this app cannot save a file
 *   (an old phone app) }
 */
export async function openBackup(deps) {
  const { el } = deps
  dialog = dialog ?? document.body.appendChild(el('dialog', { class: 'dialog card-pack backup', 'aria-label': t`备份与换设备` }))
  home(deps)
  if (!dialog.open) dialog.showModal()
}

function home(deps) {
  const { el } = deps
  const picker = el('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: () => {
    const file = picker.files?.[0]
    picker.value = ''
    if (file) upload(deps, file)
  } })
  dialog.replaceChildren(el('form', { method: 'dialog' }, [
    el('h2', { text: t`备份与换设备` }),
    el('p', { class: 'muted small', text: t`把角色卡、对话、配图、世界书、预设和设置打包成一个压缩包（zip），在另一台设备的 CicaTavern 里从这里导入。电脑、Mac、安卓之间都行。可以只勾一部分。` }),
    el('div', { class: 'backup-actions' }, [
      el('button', { type: 'button', class: 'btn primary', text: t`导出备份…`, onclick: deps.guard(async event => {
        // Counting a few gigabytes takes a moment.
        event.currentTarget.disabled = true
        event.currentTarget.textContent = t`正在统计…`
        await exportView(deps).catch(error => {
          home(deps)
          throw error
        })
      }) }),
      el('button', { type: 'button', class: 'btn', text: t`从备份导入…`, onclick: () => picker.click() }),
      picker,
    ]),
    el('p', { class: 'hint', text: t`导入是合并：这边没有的加进来，这边已有的（同一张卡、同一段对话）问你一次保留哪边。导入前会先列出压缩包里有什么。` }),
    el('p', { class: 'hint', text: t`密钥默认不带。不带的话，到新设备上在「供应商」里把 Key 再填一次。` }),
    el('div', { class: 'row between' }, [el('span'), el('button', { class: 'btn', value: 'cancel', text: t`关闭` })]),
  ]))
}

/** One row to tick: { box, row }. */
function tickRow(el, { on, label, hint, size, disabled = false, onchange }) {
  const box = el('input', { type: 'checkbox', checked: on, disabled, onchange })
  const row = el('label', { class: 'card-pack-row' }, [
    box,
    el('span', { class: 'card-pack-name' }, [el('b', { text: label }), hint ? el('small', { class: 'hint', text: hint }) : null]),
    el('span', { class: 'card-pack-size', text: size }),
  ])
  return { box, row }
}

async function exportView(deps) {
  const { api, el, guard, toast, download, canSave = true } = deps
  const { kinds, skippedProviders, defaultOff } = await api('/api/backup')
  const names = KIND_TEXT()
  const picked = new Set(kinds.filter(kind => !defaultOff.includes(kind.key) && (kind.files || kind.key === 'settings' || kind.key === 'providers')).map(kind => kind.key))
  const boxes = new Map()
  const total = el('span', { class: 'card-pack-total' })
  const warning = el('p', { class: 'hint warn backup-keys', text: KEY_WARNING(), hidden: true })
  const go = el('button', { type: 'button', class: 'btn primary', text: t`导出` })

  const settle = () => {
    // The keys are the providers': ticking them ticks those, which stay ticked while they are.
    if (picked.has('keys')) picked.add('providers')
    for (const [key, box] of boxes) {
      box.checked = picked.has(key)
      box.disabled = key === 'providers' && picked.has('keys')
    }
    warning.hidden = !picked.has('keys')
    // Old pictures go only with their cards or chats.
    const bytes = kinds.filter(kind => picked.has(kind.key)).reduce((sum, kind) => sum + kind.bytes, 0)
    total.textContent = picked.size ? t`合计约 ${sizeText(bytes)}（对话会压缩，实际更小）` : t`什么都没勾`
    go.disabled = !picked.size || !canSave
  }

  // Nothing of a kind to take (no keys saved, no usage yet): no row for it.
  const rows = kinds.filter(kind => kind.files || kind.count || kind.key === 'settings' || kind.key === 'providers').map(kind => {
    const [label, hint] = names[kind.key] ?? [kind.key, '']
    const { box, row } = tickRow(el, {
      on: picked.has(kind.key),
      label,
      hint,
      size: [countText(kind.key, kind.count), kind.bytes ? sizeText(kind.bytes) : ''].filter(Boolean).join(t` · `),
      onchange: () => {
        if (box.checked) picked.add(kind.key)
        else picked.delete(kind.key)
        settle()
      },
    })
    boxes.set(kind.key, box)
    return row
  })

  go.onclick = guard(async () => {
    go.disabled = true
    try {
      const made = await api('/api/backup/export', { method: 'POST', body: { include: [...picked] } })
      download(made.path, made.name, 'application/zip')
      toast(picked.has('keys')
        ? t`开始导出「${made.name}」：东西多的话要几分钟，下载完成就好了。里面有密钥，用完记得删掉。`
        : t`开始导出「${made.name}」：东西多的话要几分钟，下载完成就好了。`, 9000)
      dialog.close()
    } finally {
      settle()
    }
  })

  dialog.replaceChildren(el('form', { method: 'dialog' }, [
    el('h2', { text: t`导出备份` }),
    el('p', { class: 'muted small', text: t`勾上要带的。边打包边下载，不用等，也不会占这台设备的空间。` }),
    el('div', { class: 'card-pack-rows' }, rows),
    warning,
    skippedProviders.length ? el('p', { class: 'hint', text: t`这台设备本机地址上的供应商不带（换了设备连不上）：${skippedProviders.join(t`、`)}` }) : null,
    canSave ? null : el('p', { class: 'hint warn', text: t`这个版本的安卓应用存不了文件：先在「更新」里更新应用。` }),
    el('p', { class: 'hint', text: t`不会带上的：这台设备的访问令牌、日志、朗读缓存，网络代理和手机访问的设置。` }),
    el('div', { class: 'row between' }, [total, el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn', text: t`返回`, onclick: () => home(deps) }), go])]),
  ]))
  settle()
}

/** The zip sent as it is, with the share sent shown: a backup runs to gigabytes. → the server's answer. */
function send(file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', '/api/backup/upload')
    request.setRequestHeader('content-type', 'application/zip')
    request.setRequestHeader('x-agent-tavern', '1')
    request.upload.onprogress = event => onProgress(event.loaded, event.lengthComputable ? event.total : file.size)
    request.onload = () => {
      let body = {}
      try {
        body = JSON.parse(request.responseText)
      } catch {
        // Not JSON: the status says it.
      }
      if (request.status >= 200 && request.status < 300) resolve(body)
      else reject(new Error(body.error || t`请求失败（${request.status}）`))
    }
    request.onerror = () => reject(new Error(t`上传中断了，再试一次`))
    request.send(file)
  })
}

async function upload(deps, file) {
  const { el } = deps
  const line = el('p', { class: 'muted', text: t`正在读取「${file.name}」…` })
  const bar = el('progress', { class: 'backup-progress', max: 100, value: 0 })
  dialog.replaceChildren(el('form', { method: 'dialog' }, [el('h2', { text: t`从备份导入` }), line, bar]))
  try {
    const found = await send(file, (sent, size) => {
      const share = size ? Math.min(100, Math.round((sent / size) * 100)) : 0
      bar.value = share
      line.textContent = sent >= size ? t`已收到，正在看里面有什么…` : t`正在读取「${file.name}」：${sizeText(sent)} / ${sizeText(size)}`
    })
    importView(deps, found)
  } catch (error) {
    dialog.replaceChildren(el('form', { method: 'dialog' }, [
      el('h2', { text: t`从备份导入` }),
      el('p', { class: 'hint warn', text: error.message }),
      el('div', { class: 'row between' }, [el('span'), el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn', text: t`返回`, onclick: () => home(deps) })])]),
    ]))
  }
}

const PLATFORM = () => ({ win32: 'Windows', darwin: 'Mac', linux: 'Linux', android: t`安卓` })

function importView(deps, found) {
  const { api, el, guard } = deps
  const names = KIND_TEXT()
  // Keys come only when ticked here too, whatever the file has.
  const picked = new Set(found.kinds.filter(kind => kind.key !== 'keys').map(kind => kind.key))
  const boxes = new Map()
  const warning = el('p', { class: 'hint warn backup-keys', text: t`会把文件里的密钥存到这台设备上。只导入自己导出的备份。`, hidden: true })
  const keep = el('input', { type: 'radio', name: 'backup-conflict', value: 'keep', checked: true })
  const replace = el('input', { type: 'radio', name: 'backup-conflict', value: 'replace' })
  const conflict = el('div', { class: 'backup-conflict' }, [
    el('p', { class: 'small', text: t`这边已有的（同一张卡、同一段对话、同一个预设…）：` }),
    el('label', { class: 'check-row' }, [keep, el('span', { text: t`保留这边的（只加进这边没有的）` })]),
    el('label', { class: 'check-row' }, [replace, el('span', { text: t`用文件里的（这边的那份会被换掉）` })]),
  ])
  const go = el('button', { type: 'button', class: 'btn primary', text: t`导入` })

  const settle = () => {
    if (picked.has('keys')) picked.add('providers')
    for (const [key, box] of boxes) {
      box.checked = picked.has(key)
      box.disabled = key === 'providers' && picked.has('keys')
    }
    warning.hidden = !picked.has('keys')
    conflict.hidden = !found.kinds.some(kind => picked.has(kind.key) && kind.here)
    go.disabled = !picked.size
  }

  const rows = found.kinds.map(kind => {
    const [label, hint] = names[kind.key] ?? [kind.key, '']
    const keyNames = kind.key === 'keys' ? [...found.keys.providers, ...found.keys.files].join(t`、`) : ''
    const { box, row } = tickRow(el, {
      on: picked.has(kind.key),
      label,
      hint: [kind.here ? t`其中 ${kind.here} 项这边已有` : '', keyNames ? t`含：${keyNames}` : hint].filter(Boolean).join(t`；`),
      size: [countText(kind.key, kind.count), kind.bytes ? sizeText(kind.bytes) : ''].filter(Boolean).join(t` · `),
      onchange: () => {
        if (box.checked) picked.add(kind.key)
        else picked.delete(kind.key)
        settle()
      },
    })
    boxes.set(kind.key, box)
    return row
  })

  const cancel = async () => {
    await api('/api/backup/upload', { method: 'DELETE' }).catch(() => {})
    home(deps)
  }

  go.onclick = guard(async () => {
    go.disabled = true
    const body = { upload: found.upload, include: [...picked], conflict: replace.checked ? 'replace' : 'keep' }
    await api('/api/backup/import', { method: 'POST', body })
    await progressView(deps)
  })

  const { from } = found
  const when = from.exportedAt ? new Date(from.exportedAt).toLocaleString() : ''
  // A Latin name (Windows, Mac) keeps a space before the Chinese that follows it; 安卓 does not.
  const where = PLATFORM()[from.edition === 'android' ? 'android' : from.platform] ?? from.platform
  const spaced = /[A-Za-z0-9]$/.test(where) ? `${where} ` : where
  dialog.replaceChildren(el('form', { method: 'dialog' }, [
    el('h2', { text: t`压缩包里有这些` }),
    el('p', { class: 'muted small', text: t`${spaced}上的 CicaTavern ${from.app} 导出，${when}。勾上要导入的。` }),
    el('div', { class: 'card-pack-rows' }, rows),
    warning,
    conflict,
    found.unknown ? el('p', { class: 'hint', text: t`另有 ${found.unknown} 个文件认不出来，不会导入。` }) : null,
    el('p', { class: 'hint', text: t`对话要有它的角色卡：卡不在这边、也没一起导入的对话会跳过。对话用的世界书和预设不在的话，对话照常导入，不再用它们。` }),
    el('div', { class: 'row between' }, [el('span'), el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn', text: t`取消`, onclick: guard(cancel) }), go])]),
  ]))
  settle()
}

async function progressView(deps) {
  const { api, el } = deps
  const line = el('p', { class: 'muted', text: t`正在导入…` })
  const bar = el('progress', { class: 'backup-progress', max: 100, value: 0 })
  dialog.replaceChildren(el('form', { method: 'dialog' }, [
    el('h2', { text: t`正在导入` }),
    line,
    bar,
    el('p', { class: 'hint', text: t`图多的话要几分钟。导入时先别关这个窗口，也别开始新的回复。` }),
  ]))
  // Closing the window does not stop the import: the server goes on. Escape is held while it runs.
  const hold = event => event.preventDefault()
  dialog.addEventListener('cancel', hold)
  try {
    for (;;) {
      const state = await api('/api/backup/import')
      if (state.state === 'done') return doneView(deps, state.report)
      if (state.state === 'failed') throw new Error(state.code === 'NOT_BACKUP' ? t`这不是 CicaTavern 的备份包` : state.error || t`导入失败`)
      if (state.total) bar.value = Math.round((state.done / state.total) * 100)
      line.textContent = state.total ? t`正在导入… ${state.done} / ${state.total}` : t`正在导入…`
      await new Promise(resolve => setTimeout(resolve, 600))
    }
  } catch (error) {
    dialog.replaceChildren(el('form', { method: 'dialog' }, [
      el('h2', { text: t`导入没有完成` }),
      el('p', { class: 'hint warn', text: error.message }),
      el('p', { class: 'hint', text: t`已经导入的部分留在这边。可以再导入一次：已有的会按你选的保留或替换。` }),
      el('div', { class: 'row between' }, [el('span'), el('button', { type: 'button', class: 'btn primary', text: t`重新载入页面`, onclick: () => location.reload() })]),
    ]))
  } finally {
    dialog.removeEventListener('cancel', hold)
  }
}

/** "角色卡 12、对话 40": a report bucket as a line. */
function bucketText(bucket) {
  const names = KIND_NAME()
  return Object.entries(bucket ?? {}).filter(([, n]) => n).map(([kind, n]) => t`${names[kind] ?? kind} ${n}`).join(t`、`)
}

function doneView(deps, report) {
  const { el } = deps
  const lines = [
    [t`新加的`, bucketText(report.added)],
    [t`换成文件里的`, bucketText(report.replaced)],
    [t`保留这边的`, bucketText(report.kept)],
  ].filter(([, text]) => text)
  const skipped = report.skipped ?? []
  const failed = report.failed ?? []
  dialog.replaceChildren(el('form', { method: 'dialog' }, [
    el('h2', { text: t`导入完成` }),
    lines.length ? el('ul', { class: 'backup-report' }, lines.map(([what, text]) => el('li', {}, [el('b', { text: t`${what}：` }), text]))) : el('p', { class: 'muted', text: t`没有要导入的东西。` }),
    report.keyless?.length ? el('p', { class: 'hint warn', text: t`这些供应商的地址变了，这边原来的 Key 没有沿用，要重新填：${report.keyless.join(t`、`)}` }) : null,
    skipped.length ? el('details', { class: 'hint' }, [
      el('summary', { text: t`跳过了 ${skipped.length} 段对话：它们的角色卡不在这边` }),
      el('p', { text: skipped.slice(0, 40).map(item => item.what).join('\n') + (skipped.length > 40 ? '\n…' : '') }),
    ]) : null,
    failed.length ? el('details', { class: 'hint warn', open: true }, [
      el('summary', { text: t`${failed.length} 项没导入成功（其余的照常导入了）` }),
      el('p', { text: failed.slice(0, 40).map(item => (item.error ? t`${KIND_NAME()[item.kind] ?? item.kind} ${item.what}：${item.error}` : `${KIND_NAME()[item.kind] ?? item.kind} ${item.what}`)).join('\n') }),
    ]) : null,
    el('p', { class: 'hint', text: t`重新载入页面后，导入的卡、对话和设置就都能看到了。` }),
    el('div', { class: 'row between' }, [el('span'), el('button', { type: 'button', class: 'btn primary', text: t`重新载入页面`, onclick: () => location.reload() })]),
  ]))
}
