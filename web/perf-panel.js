// 性能记录 (设置 → 更多 → 性能记录): turns the page's timing on (render.js perf) and shows what it recorded, one row per
// action (切换角色卡, 打开对话, 一次回复), with where its time went on the page and on the server; to copy or save and
// send when a long chat feels slow. web/app.js loads this file when the window is first opened, so a server started
// before the file existed still serves the page.
import { t } from '/i18n.js'

let dialog = null

const KINDS = () => ({ switch: t`切换角色卡`, open: t`打开对话`, reply: t`一次回复` })

// What each span is, in the words of the table. Names the page or the server (server/perf.mjs) times.
const SPANS = () => ({
  render: t`整段重画`,
  messages: t`生成消息`,
  regex: t`正则（显示）`,
  markdown: t`Markdown 排版`,
  status: t`状态栏`,
  frames: t`卡片界面（iframe）`,
  slots: t`卡片界面占位`,
  dom: t`放进页面`,
  history: t`轮次导航`,
  vn: t`视觉小说`,
  live: t`逐字刷新`,
  fetch: t`请求（下载和解析，同时发的会叠加）`,
  longtask: t`主线程长任务`,
  'turn.shown': t`点发送到显示出这一轮`,
  'turn.first': t`等到第一个字`,
  'turn.streamed': t`写完最后一个字`,
  'chat.read': t`读对话文件`,
  'chat.write': t`写对话文件`,
  'chat.view': t`整理对话`,
  'chat.list': t`对话列表`,
  json: t`序列化`,
  prompt: t`组装提示词`,
  'prompt.history': t`组装对话历史`,
  'model.first': t`等模型第一个字`,
  model: t`模型生成`,
  settle: t`存回复和变量`,
})

// The phases of a reply: stretches from its start, not time spent; shown apart from the rest.
const PHASES = new Set(['turn.shown', 'turn.first', 'turn.streamed'])

const ms = value => `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ms`
const clock = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
// Which chat or card: its id is not worth sending.
const pathOf = path => path.replace(/\b[0-9a-f]{16}\b/g, ':id')

function spanText(item, labels) {
  const label = labels[item.name] ?? item.name
  const extras = []
  if (item.count > 1) extras.push(`×${item.count}`)
  if (item.messages != null) extras.push(t`${item.messages} 条`)
  if (item.reused) extras.push(t`复用 ${item.reused} 条`)
  if (item.nodes != null) extras.push(t`${item.nodes} 个节点`)
  if (item.bytes != null) extras.push(`${Math.round(item.bytes / 1024)} KB`)
  if (item.files != null) extras.push(t`${item.files} 个文件，读了 ${item.read ?? 0} 个`)
  return `${label} ${ms(item.ms)}${extras.length ? t`（${extras.join(t`，`)}）` : ''}`
}

/** The spans of an action, biggest first, phases apart. */
function sorted(action) {
  const spans = action.spans.filter(item => !PHASES.has(item.name)).sort((a, b) => b.ms - a.ms)
  const phases = action.spans.filter(item => PHASES.has(item.name)).sort((a, b) => a.ms - b.ms)
  return { spans, phases }
}

/** One action as lines of text, the way the table's details show it and 复制 copies it. */
export function actionLines(action) {
  const labels = SPANS()
  const { spans, phases } = sorted(action)
  const what = KINDS()[action.kind] ?? action.kind
  const lines = [action.messages ? t`[${clock(action.at)}] ${what}「${action.label}」 共 ${ms(action.total)}（${action.messages} 条消息）` : t`[${clock(action.at)}] ${what}「${action.label}」 共 ${ms(action.total)}`]
  if (phases.length) lines.push(`  ${t`过程：${phases.map(item => `${labels[item.name] ?? item.name} ${ms(item.ms)}`).join(' → ')}`}`)
  if (spans.length) lines.push(`  ${t`页面：${spans.map(item => spanText(item, labels)).join(' · ')}`}`)
  for (const request of action.server) {
    const parts = [...request.spans].sort((a, b) => b.ms - a.ms).map(item => spanText(item, labels)).join(' · ')
    lines.push(`  ${parts ? t`服务端 ${pathOf(request.path)} ${ms(request.total)}：${parts}` : t`服务端 ${pathOf(request.path)} ${ms(request.total)}`}`)
  }
  if (action.frames) {
    const f = action.frames
    lines.push(`  ${t`流畅度：${f.count} 帧，中位 ${ms(f.p50)}，95% 在 ${ms(f.p95)} 以内，最长 ${ms(f.max)}，超过 50 ms 的 ${f.over50} 次，超过 100 ms 的 ${f.over100} 次`}`)
  }
  return lines
}

/**
 * @param deps - { el, toast, perf (render.js), perfReport, saveFile(name, text, message), about() → version and the like }
 */
export function openPerf({ el, toast, perf, perfReport, saveFile, about = () => ({}) }) {
  dialog ??= document.body.appendChild(el('dialog', { class: 'dialog perf-log', 'aria-label': t`性能记录` }))
  const recording = el('input', { type: 'checkbox', checked: perf.on })
  const body = el('tbody')
  const details = el('pre', { class: 'perf-detail', hidden: true })
  const empty = el('p', { class: 'hint perf-empty' })
  let picked = null

  const textOf = () => {
    const actions = perf.actions().filter(action => action.done)
    const head = `CicaTavern ${t`性能记录`} · ${new Date().toLocaleString()} · ${navigator.userAgent}`
    return [head, '', ...actions.flatMap(action => [...actionLines(action), ''])].join('\n')
  }

  function draw() {
    const actions = perf.actions().filter(action => action.done)
    const labels = SPANS()
    empty.hidden = actions.length > 0
    empty.textContent = perf.on ? t`正在记录：切换一下角色卡、打开对话或发一轮，这里就会多一行。` : t`还没开始记录。勾上「记录」，再像平时一样玩一会儿。`
    body.replaceChildren(...actions.map(action => {
      const { spans } = sorted(action)
      const main = spans.filter(item => item.name !== 'longtask').slice(0, 3).map(item => `${labels[item.name] ?? item.name} ${ms(item.ms)}`).join(t`、`)
      const long = action.spans.find(item => item.name === 'longtask')
      const row = el('tr', { class: action === picked ? 'picked' : '', tabindex: '0', onclick: () => pick(action) }, [
        el('td', { text: clock(action.at) }),
        el('td', { text: KINDS()[action.kind] ?? action.kind }),
        el('td', { class: 'num', text: ms(action.total) }),
        el('td', { class: 'num', text: long ? ms(long.ms) : '—' }),
        el('td', { class: 'perf-what', text: action.label, title: action.label }),
        el('td', { class: 'perf-main', text: main || '—' }),
      ])
      row.addEventListener('keydown', event => { if (event.key === 'Enter') pick(action) })
      return row
    }))
    if (picked && !actions.includes(picked)) picked = null
    details.hidden = !picked
    details.textContent = picked ? actionLines(picked).join('\n') : ''
  }

  function pick(action) {
    picked = picked === action ? null : action
    draw()
  }

  recording.addEventListener('change', () => {
    perf.setOn(recording.checked)
    picked = null
    draw()
  })
  const stop = perf.onChange(() => { if (dialog.open) draw() })
  dialog.addEventListener('close', stop, { once: true })

  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`
  dialog.replaceChildren(
    el('h2', { text: t`性能记录` }),
    el('p', { class: 'hint', text: t`聊得很长以后切换角色卡、打开对话或者回复逐字写出时变卡，可以在这里记下每一步花了多久，再发给开发者。勾上「记录」后像平时一样操作，每次切换角色卡、打开对话、回复都会多一行；点一行看细节。只记耗时、消息条数和角色卡名、对话标题，不记对话内容。不勾的时候什么也不记，不影响速度；关掉窗口也会接着记，刷新页面就停了。` }),
    el('label', { class: 'check-row' }, [recording, el('span', { text: t`记录` })]),
    el('div', { class: 'perf-table-wrap' }, el('table', { class: 'perf-table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', { text: t`时间` }),
        el('th', { text: t`操作` }),
        el('th', { class: 'num', text: t`共` }),
        el('th', { class: 'num', text: t`卡住`, title: t`主线程长任务（超过 50 ms、页面不响应的时间）加起来` }),
        el('th', { text: t`对象` }),
        el('th', { text: t`主要花在` }),
      ])),
      body,
    ])),
    empty,
    details,
    el('div', { class: 'row end diag-actions' }, [
      el('button', { type: 'button', class: 'btn ghost', text: t`清空`, onclick: () => { perf.clear(); picked = null; draw() } }),
      el('span', { class: 'grow' }),
      el('button', { type: 'button', class: 'btn ghost', text: t`复制文字`, onclick: async () => {
        try {
          await navigator.clipboard.writeText(textOf())
          toast(t`已复制，可以直接粘贴发送`)
        } catch {
          saveFile(t`CicaTavern 性能记录 ${stamp}.txt`, textOf(), t`没能复制，已保存成文件`)
        }
      } }),
      el('button', { type: 'button', class: 'btn ghost', text: t`保存为 JSON`, onclick: () => saveFile(t`CicaTavern 性能记录 ${stamp}.json`, JSON.stringify(perfReport(about()), null, 1), t`已保存，把这个文件发给开发者就行`) }),
      el('button', { type: 'button', class: 'btn primary', text: t`关闭`, onclick: () => dialog.close() }),
    ]),
  )
  draw()
  dialog.showModal()
}
