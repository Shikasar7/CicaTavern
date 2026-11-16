// 从小说抽取 as it is shown: a novel read a stretch at a time (server/forge/novel.mjs), in the two places that read one:
// 世界书 → 从小说抽取 (web/books.js), where it ends as a worldbook, and 创作角色卡 → 从小说开始 (web/forge.js), where
// it ends as a card. Each keeps the novel and asks again while it is read; here is what both draw of it: the file to
// pick, how far it is and what the rest comes to, and its 梗概.
import { t } from '/i18n.js'
import { decodeTextFile } from '/shared/card-edit.js'

export const NOVEL_TYPES = { 人物: t`人物`, 地点: t`地点`, 势力: t`势力`, 物品: t`物品`, 设定: t`设定`, 事件: t`事件` } // i18n-ignore: the kinds as the server names them
export const count = n => Number(n ?? 0).toLocaleString()

/** A picked file as what the server takes: { name, text }, every encoding read here. */
export const novelFile = async file => ({ name: file.name, text: decodeTextFile(await file.arrayBuffer()) })

export function novelStepText(job) {
  const [, kind, at, total] = /^(read|merge|digest):(\d+):(\d+)$/.exec(job.step ?? '') ?? []
  if (kind === 'read') return t`正在读第 ${at} / ${total} 段…可以关掉窗口，回来再看。`
  if (kind === 'merge') return t`都读完了，正在把同一个名字的几段笔记合成一条：第 ${at} / ${total} 批…`
  if (kind === 'digest') return t`正在写全书的梗概…`
  return t`正在发给模型…`
}

/** The button a file is picked with. @param pick - (file) once one is chosen */
export function novelPick(el, guard, pick) {
  const file = el('input', { type: 'file', accept: '.txt,.md,.text,text/plain,text/markdown', hidden: true, onchange: guard(async event => {
    const [picked] = event.target.files
    event.target.value = ''
    if (picked) await pick(picked)
  }) })
  return el('label', { class: 'btn primary small' }, [t`选文件…`, file])
}

/**
 * How far a novel is: its name and size, what was noted, how many stretches to read and what that comes to, and the
 * buttons that read on, stop and drop it.
 * @param on - { limit(n), parallel(n), run(), runAll(), stop(), drop(), model?(ref) }
 * @param models - [{ id, label }] to read with, for a place that lets one be picked ('' is the default model)
 */
export function novelTop(el, novel, on, { models = null } = {}) {
  const { job, estimate, stage } = novel
  const busy = Boolean(job)
  const limit = el('input', { type: 'number', min: 1, max: novel.stretches.length, value: novel.limit, disabled: busy, 'aria-label': t`读前几段`, onchange: () => on.limit(Number(limit.value) || 0) })
  // Output as a range: a model that thinks a lot writes about twice as much (server/forge/novel.mjs novelEstimate).
  const costs = part => (part.cost == null ? '' : t`，大约 $${part.cost.toFixed(2)}–$${(part.costMost ?? part.cost).toFixed(2)}`)
  const outputs = part => (part.outputMost ? `${count(part.output)}–${count(part.outputMost)}` : count(part.output))
  // The part asked for is read and there is more of the text: it can go on to the end.
  const more = stage === 'ready' && novel.rest?.stretches > 0 ? novel.rest : null
  const left = !estimate.ready
    ? stage === 'ready' && !more ? '' : t`还没有可用的模型：先在「设置 → 模型」里添加供应商，选一个默认模型。`
    : stage === 'reading'
      ? t`还要读 ${estimate.stretches} 段：发给 ${estimate.model}，大约 ${count(estimate.input)} 输入、${outputs(estimate)} 输出 token${costs(estimate)}。输出多少看模型想得多不多，思考多的接近上限；读完后合并同名的条目还要再花一两成。`
      : stage === 'merging'
        ? t`都读完了，还有 ${novel.toMerge} 批同名的笔记要让模型合成一条。`
        : more ? t`后面还有 ${more.stretches} 段没读：都读完大约 ${count(more.input)} 输入、${outputs(more)} 输出 token${costs(more)}。` : ''
  const found = Object.entries(novel.counts).filter(([, n]) => n).map(([type, n]) => t`${NOVEL_TYPES[type] ?? type} ${n}`).join(t` · `)
  // Reading is many requests: the model for it can be a cheaper one than the card is written with.
  const picker = models && on.model && stage !== 'ready' && !busy
    ? el('label', { class: 'book-novel-limit' }, [
        el('span', { text: t`用哪个模型读` }),
        el('select', { 'aria-label': t`用哪个模型读`, onchange: event => on.model(event.target.value) }, [
          el('option', { value: '', text: t`默认模型`, selected: !novel.model }),
          ...models.map(model => el('option', { value: model.id, text: model.label, selected: novel.model === model.id })),
        ]),
        el('span', { text: t`（读书的请求多，可以挑个便宜的）` }),
      ])
    : null
  // Stretches read at once: faster, at the price of more requests a minute than some providers let through.
  const width = !busy && (stage !== 'ready' || more)
    ? el('label', { class: 'book-novel-limit' }, [
        el('span', { text: t`同时读` }),
        el('select', { 'aria-label': t`同时读几段`, onchange: event => on.parallel(Number(event.target.value)) }, [...new Set([1, 2, 3, 4, 6, 8, novel.parallel])].sort((a, b) => a - b).map(n => el('option', { value: n, text: String(n), selected: novel.parallel === n }))),
        el('span', { text: t`段（越多读得越快；供应商报限流或请求太多，就调小）` }),
      ])
    : null
  return el('div', { class: 'book-novel' }, [
    el('p', {}, [el('b', { text: novel.name }), el('span', { class: 'hint', text: t` · ${count(novel.chars)} 字 · 切成 ${novel.stretches.length} 段` })]),
    el('p', { class: 'hint', text: t`已经读了 ${novel.done} 段${found ? t`，记下：${found}` : ''}。` }),
    novel.failed.length ? el('p', { class: 'ce-outcome warn', text: t`第 ${novel.failed.join(t`、`)} 段模型没有按格式回答，跳过了；里面的内容没有记下。` }) : null,
    stage === 'reading' && !busy ? el('label', { class: 'book-novel-limit' }, [el('span', { text: t`只读前` }), limit, el('span', { text: t`段（共 ${novel.stretches.length} 段；想先试试，填个小的数）` })]) : null,
    picker,
    width,
    left ? el('p', { class: 'hint', text: left }) : null,
    novel.error && !busy ? el('p', { class: 'ce-outcome warn', text: novel.error }) : null,
    el('div', { class: 'row book-novel-actions' }, [
      busy
        ? el('span', { class: 'forge-working' }, [el('span', { class: 'dots' }), el('span', { text: novelStepText(job) })])
        : stage !== 'ready'
          ? el('button', { type: 'button', class: 'btn primary small', disabled: !estimate.ready, text: novel.done ? t`接着抽` : t`开始抽取`, onclick: () => on.run() })
          : more
            ? el('button', { type: 'button', class: 'btn small', disabled: !estimate.ready, text: t`把剩下的 ${more.stretches} 段也读完`, onclick: () => on.runAll() })
            : null,
      busy ? el('button', { type: 'button', class: 'btn small', text: t`停下`, title: t`读完的几段都留着，之后可以接着抽`, onclick: () => on.stop() }) : null,
      el('span', { class: 'grow' }),
      busy ? null : el('button', { type: 'button', class: 'btn ghost small', text: t`不要了`, title: t`丢掉这部小说和已经记下的内容`, onclick: () => { if (confirm(t`丢掉「${novel.name}」和已经记下的 ${novel.entries.length} 条？`)) on.drop() } }),
    ]),
  ].filter(Boolean))
}

/**
 * 梗概: the whole book in a few thousand characters, written from what was noted. Asked for with a button (one
 * request), then the player's to change. null till the novel is read and put together.
 * @param on - { write(), keep(text) }
 * @param why - what it is for, in the place that shows it
 */
export function novelDigest(el, novel, on, why) {
  if (novel.stage !== 'ready' || !novel.entries.length) return null
  const busy = Boolean(novel.job)
  const box = el('textarea', { class: 'book-novel-digest', rows: 10, 'aria-label': t`全书梗概`, disabled: busy, onchange: () => on.keep(box.value) })
  box.value = novel.digest ?? ''
  return el('div', { class: 'book-novel' }, [
    el('p', {}, [el('b', { text: t`全书梗概` }), el('span', { class: 'hint', text: t` · ${why}` })]),
    novel.digest
      ? box
      : el('p', { class: 'hint', text: t`还没有写。让模型从上面记下的条目里写一份（一次请求，不再读原文）：世界和基调、主线、主要人物、主要势力。写出来可以自己改。` }),
    novel.digestStale ? el('p', { class: 'ce-outcome warn', text: t`写完梗概以后又读了新的段落，这份梗概没有包括后面的内容。可以重写一份。` }) : null,
    el('div', { class: 'row book-novel-actions' }, [
      el('button', { type: 'button', class: novel.digest ? 'btn small' : 'btn primary small', disabled: busy || !novel.estimate.ready, text: novel.digest ? t`重写梗概` : t`写梗概`, onclick: () => { if (!novel.digest || confirm(t`重写会盖掉现在这份梗概，包括你改过的地方。继续？`)) on.write() } }),
      novel.digest ? el('span', { class: 'hint', text: t`改完点一下别处就保存了。` }) : null,
    ]),
  ].filter(Boolean))
}
