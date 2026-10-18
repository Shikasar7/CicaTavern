// 设置 → 更多 → 更新 (server/update/): the version in use, a newer one with its
// release notes, and on Windows 下载更新 → 重启并更新, 回到上一版 and the old
// version folders. The phone app's button opens the APK in the browser.
// Release notes come from GitHub: they are drawn as text, never as HTML.

const MB = 1024 * 1024
const mb = bytes => `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)} MB`
const SEEN_KEY = 'cicatavern.update.seen'
const RESULT_KEY = 'cicatavern.update.result'

function remember(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode: the toast may show again.
  }
}

function recall(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Markdown release notes as plain DOM: headings, lists, code blocks, paragraphs; links become their text. */
function notesView(el, markdown) {
  const box = el('div', { class: 'upd-notes' })
  let list = null
  let code = null
  const inline = text => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '')
  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      if (code) {
        box.append(el('pre', { text: code.join('\n') }))
        code = null
      } else code = []
      list = null
      continue
    }
    if (code) {
      code.push(raw)
      continue
    }
    const line = raw.trim()
    if (!line) {
      list = null
      continue
    }
    if (/^-{3,}$/.test(line)) {
      box.append(el('hr'))
      list = null
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      box.append(el('h4', { text: inline(heading[1]) }))
      list = null
      continue
    }
    const item = /^(?:[-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (item) {
      if (!list) box.append((list = el('ul')))
      list.append(el('li', { text: inline(item[1]) }))
      continue
    }
    list = null
    box.append(el('p', { text: inline(line) }))
  }
  if (code) box.append(el('pre', { text: code.join('\n') }))
  return box
}

/**
 * @param onChange - after the state changes (the settings menu redraws its row).
 * @param isGenerating - true while the open chat is writing.
 */
export function initUpdate({ api, el, toast, guard, onChange = () => {}, isGenerating = () => false }) {
  let info = null
  let installs = null
  let poll = null
  let checking = false
  const pane = () => document.querySelector('#settings-form [data-section="update"]')

  function set(next) {
    info = next
    render()
    onChange()
    const step = info?.job?.step
    const working = ['downloading', 'verifying', 'unpacking'].includes(step)
    if (working && !poll) poll = setInterval(() => load().catch(() => {}), 700)
    if (!working && poll) {
      clearInterval(poll)
      poll = null
      if (step === 'ready') toast(`新版本 ${info.job.version ?? info.ready?.version} 已下载好：设置 → 更多 → 更新 →「重启并更新」`, 7000)
    }
  }

  async function load() {
    set(await api('/api/update'))
    return info
  }

  /** At page start: the daily check (server side), then a toast for a new version or the last switch's outcome. */
  async function boot() {
    try {
      set(await api('/api/update?auto=1'))
    } catch {
      return
    }
    if (!info?.enabled) return
    const result = info.result
    if (result?.at && recall(RESULT_KEY) !== result.at) {
      remember(RESULT_KEY, result.at)
      toast(result.ok ? `${result.mode === 'rollback' ? '已回到' : '已更新到'} ${result.to}` : `更新没成功：${result.error}`, 8000)
      return
    }
    const latest = info.latest
    if (info.newer && latest.version !== info.skipped && recall(SEEN_KEY) !== latest.version) {
      remember(SEEN_KEY, latest.version)
      toast(`有新版本 ${latest.version}：设置 → 更多 → 更新`, 8000)
    }
  }

  const act = (path, options = {}) => guard(async () => set(await api(path, { method: 'POST', body: {}, ...options })))

  const check = guard(async () => {
    checking = true
    render()
    try {
      set(await api('/api/update/check', { method: 'POST', body: {} }))
      toast(info.newer ? `有新版本 ${info.latest.version}` : '已经是最新版本')
    } finally {
      checking = false
      render()
    }
  })

  const restart = guard(async mode => {
    if (isGenerating()) throw new Error('正在生成，等它写完再重启')
    const target = mode === 'rollback' ? info.previous : info.ready
    const question = mode === 'rollback'
      ? `回到 ${target.version}？服务会重启，页面自动刷新。${info.version} 的文件夹留着，以后可以再切回来。`
      : `重启到 ${target.version}？服务会重启，页面自动刷新；手机上打开的页面也会断开一下。数据不受影响。`
    if (!confirm(question)) return
    const before = await fetch('/api/health', { cache: 'no-store' }).then(res => res.json()).catch(() => ({}))
    const reply = await api(`/api/update/${mode === 'rollback' ? 'rollback' : 'apply'}`, { method: 'POST', body: {} })
    set({ ...info, job: { step: 'restarting', version: reply.to } })
    waitForRestart(reply.to, before.instance)
  })

  /**
   * Reload once another server process answers (the new version, or the old
   * one started again when the new one failed: that can be back before the
   * first look) and the switch has written how it went, which comes just after
   * the server is up, when the shortcuts are done.
   */
  function waitForRestart(version, instance) {
    const started = Date.now()
    let wentDown = false
    let upAt = 0
    const tick = async () => {
      let health = null
      try {
        health = await (await fetch('/api/health', { cache: 'no-store' })).json()
      } catch {
        wentDown = true
      }
      const another = health && (instance ? health.instance !== instance : health.version === version || wentDown)
      if (another) {
        upAt ||= Date.now()
        const now = await fetch('/api/update', { cache: 'no-store' }).then(res => res.json()).catch(() => null)
        if (now?.result || Date.now() - upAt > 15_000) {
          location.reload()
          return
        }
      }
      if (Date.now() - started > 180_000) {
        toast('服务没有回应：从桌面图标重新打开 CicaTavern', 10000)
        return
      }
      setTimeout(tick, 1000)
    }
    setTimeout(tick, 1500)
  }

  const loadInstalls = guard(async () => {
    installs = (await api('/api/update/installs')).installs
    render()
  })

  const removeInstall = guard(async item => {
    if (!confirm(`删除旧版本 ${item.version} 的文件夹？\n${item.path}\n\n只删程序文件，数据目录不受影响。${item.path === info.previous?.path ? '删掉之后就不能「回到上一版」了。' : ''}`)) return
    const reply = await api('/api/update/remove', { method: 'POST', body: { path: item.path } })
    installs = reply.installs
    await load()
    toast('已删除')
  })

  const setAuto = guard(async on => set(await api('/api/update/settings', { method: 'PUT', body: { autoCheck: on } })))

  function progress(job) {
    const total = job.total || 0
    const ratio = total ? Math.min(1, job.received / total) : 0
    return el('div', { class: 'upd-progress' }, [
      el('div', { class: 'upd-bar' }, [el('span', { style: `width:${(ratio * 100).toFixed(1)}%` })]),
      el('span', { class: 'muted small', text: total ? `${mb(job.received)} / ${mb(total)}` : mb(job.received) }),
    ])
  }

  /** What can be done about the newer version here. */
  function actions() {
    const job = info.job ?? { step: 'idle' }
    const latest = info.latest
    const open = el('a', { class: 'btn small', href: latest.url, target: '_blank', rel: 'noopener', text: '打开发布页' })
    if (info.kind === 'apk') {
      const apk = latest.assets?.apk
      if (!apk) return [el('p', { class: 'hint', text: '这个版本没有安卓安装包。' }), open]
      return [
        el('div', { class: 'row' }, [
          // The app hands links that are not its own page to the browser, which downloads the APK.
          el('button', { type: 'button', class: 'btn primary', text: `下载安装包（${mb(apk.size)}）`, onclick: () => { location.href = apk.url } }),
          open,
        ]),
        el('p', { class: 'hint', text: '浏览器下载完成后点开安装，覆盖安装会保留所有数据。第一次可能要允许浏览器「安装未知应用」。安卓会核对新安装包和现在这个是同一个签名，不是的话装不上。' }),
      ]
    }
    if (!info.installable) return [el('p', { class: 'hint', text: info.reason }), open]
    if (!info.local) return [el('p', { class: 'hint', text: '在电脑上打开 CicaTavern 更新：手机上不能替电脑装新版本。' })]
    const zip = latest.assets?.zip
    if (!zip) return [el('p', { class: 'hint', text: '这个版本没有 Windows 安装包。' }), open]
    if (zip.hashError) return [el('p', { class: 'hint warn', text: zip.hashError }), open]
    switch (job.step) {
      case 'downloading':
        return [progress(job), el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn small', text: '取消', onclick: act('/api/update/cancel') })])]
      case 'verifying':
        return [el('p', { class: 'hint', text: '正在校验 SHA-256…' })]
      case 'unpacking':
        return [el('p', { class: 'hint', text: '校验通过，正在解压…' })]
      case 'ready':
        return [
          el('p', { class: 'hint', text: `已下载并校验（SHA-256 一致），放在 ${info.ready?.path ?? ''}。重启后用新版本，旧版本的文件夹留着，可以回到上一版。` }),
          el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn primary', text: `重启并更新到 ${info.ready?.version ?? latest.version}`, onclick: () => restart('update') })]),
        ]
      case 'restarting':
        return [el('p', { class: 'hint', text: `正在重启到 ${job.version}，页面会自动刷新…` })]
      default:
        return [
          job.step === 'error' ? el('p', { class: 'hint warn', text: job.error }) : null,
          el('div', { class: 'row' }, [
            el('button', { type: 'button', class: 'btn primary', text: `${job.step === 'error' ? '重新下载' : '下载更新'}（${mb(zip.size)}）`, onclick: act('/api/update/download') }),
            open,
          ]),
          el('p', { class: 'hint', text: `下载后核对发布页公布的 SHA-256，解压到 ${info.root ? info.root.replace(/[\\/][^\\/]+$/, '') : '现在的文件夹旁边'}，不碰数据目录。` }),
        ]
    }
  }

  function resultLine() {
    const result = info.result
    if (!result) return null
    const text = result.ok
      ? `已${result.mode === 'rollback' ? '回到' : '从 ' + result.from + ' 更新到'} ${result.to}${result.shortcuts ? `，改了 ${result.shortcuts} 个快捷方式` : ''}。${result.shortcutError ? `快捷方式没改成：${result.shortcutError}` : ''}`
      : result.error
    return el('div', { class: `upd-result${result.ok ? '' : ' failed'}` }, [
      el('p', { text }),
      result.log ? el('details', {}, [el('summary', { text: '新版本的启动日志' }), el('pre', { text: result.log })]) : null,
      el('button', { type: 'button', class: 'btn small', text: '知道了', onclick: act('/api/update/ack') }),
    ])
  }

  function render() {
    const box = pane()
    if (!box || !info?.enabled) return
    const latest = info.latest
    const parts = [
      el('div', { class: 'upd-head' }, [
        el('div', {}, [
          el('div', { class: 'upd-current', text: `现在的版本 ${info.version}` }),
          info.root ? el('div', { class: 'muted small upd-path', text: info.root }) : null,
        ]),
        el('button', { type: 'button', class: 'btn small upd-check', text: checking ? '正在检查…' : '检查更新', disabled: checking, onclick: check }),
      ]),
      el('label', { class: 'check-row upd-auto' }, [
        el('input', { type: 'checkbox', checked: info.autoCheck, onchange: event => setAuto(event.target.checked) }),
        '自动检查更新（打开时，每天最多一次，访问 GitHub）',
      ]),
      el('p', { class: 'hint', text: info.checkError ? `上次检查没成功：${info.checkError}` : info.checkedAt ? `上次检查：${new Date(info.checkedAt).toLocaleString('zh-CN')}` : '还没检查过' }),
      resultLine(),
    ]
    if (latest && info.newer) {
      parts.push(
        el('section', { class: 'upd-new' }, [
          el('div', { class: 'upd-new-head' }, [
            el('h3', { text: `有新版本 ${latest.version}` }),
            latest.publishedAt ? el('span', { class: 'muted small', text: `${new Date(latest.publishedAt).toLocaleDateString('zh-CN')} 发布` }) : null,
          ]),
          notesView(el, latest.notes),
          ...actions(),
          info.skipped !== latest.version
            ? el('button', { type: 'button', class: 'btn ghost small upd-skip', text: '跳过这个版本（不再自动提醒）', onclick: act('/api/update/skip', { body: { version: latest.version } }) })
            : el('p', { class: 'muted small', text: '已跳过这个版本：自动检查不再提醒，「检查更新」照样能看到。' }),
        ]),
      )
    } else if (latest) {
      parts.push(el('p', { class: 'upd-latest', text: `已经是最新版本（GitHub 上最新的是 ${latest.version}）。` }))
    }
    if (info.kind === 'zip' && info.installable && info.local) {
      if (info.previous) {
        parts.push(
          el('div', { class: 'upd-previous' }, [
            el('div', {}, [el('div', { text: `上一版 ${info.previous.version}` }), el('div', { class: 'muted small upd-path', text: info.previous.path })]),
            el('button', { type: 'button', class: 'btn small', text: '回到上一版', disabled: info.job?.step === 'restarting', onclick: () => restart('rollback') }),
          ]),
        )
      }
      const others = installs
        ? installs.length
          ? installs.map(item =>
            el('div', { class: 'upd-install' }, [
              el('div', {}, [
                el('div', { text: `${item.version}${item.staged ? '（已下载，还没用）' : item.path === info.previous?.path ? '（上一版）' : ''} · ${mb(item.bytes)}` }),
                el('div', { class: 'muted small upd-path', text: item.path }),
              ]),
              el('button', { type: 'button', class: 'btn small danger', text: '删除', onclick: () => removeInstall(item) }),
            ]))
          : [el('p', { class: 'muted small', text: '旁边没有别的版本。' })]
        : [el('button', { type: 'button', class: 'btn ghost small', text: '看看旁边的旧版本文件夹', onclick: loadInstalls })]
      parts.push(el('details', { class: 'upd-installs', open: Boolean(installs) }, [el('summary', { text: '旧版本文件夹' }), ...others]))
    }
    box.replaceChildren(...parts.filter(Boolean))
  }

  return {
    boot,
    load: () => load().catch(() => null),
    enabled: () => Boolean(info?.enabled),
    /** The menu row: the version, or what is waiting. */
    summary() {
      if (!info?.enabled) return ''
      const step = info.job?.step
      if (step === 'downloading') return `正在下载 ${info.job.version}`
      if (step === 'ready') return `${info.ready?.version ?? ''} 已下载，重启就能用`
      if (info.newer) return `现在 ${info.version} · 有新版本 ${info.latest.version}`
      return `现在 ${info.version}${info.latest ? ' · 已是最新' : ''}`
    },
    status() {
      if (!info?.enabled) return null
      if (info.result && !info.result.ok) return ['warn', '更新没成功']
      if (info.job?.step === 'ready') return ['warn', '待重启']
      return info.newer && info.latest.version !== info.skipped ? ['warn', `有新版本 ${info.latest.version}`] : null
    },
  }
}
