// 这一张怎么画: the 画图方式 and model for one drawing (修改角色卡 → 生成头像,
// 角色名册 → 画一张, 创作角色卡's avatar, 重画 under a reply's picture), in a small
// window that opens on the saved ones. Methods not set up are greyed out with
// what they still need. Nothing is saved (web/shared/draw.js, server/media.mjs
// withDrawChoice).
import { t } from '/i18n.js'
import { IMAGE_MODEL, choiceBody, drawChoices, startingChoice } from '/shared/draw.js'

export const NAI_MODELS = [
  ['nai-diffusion-5-full', t`V5 Full（能画成人内容）`],
  ['nai-diffusion-5-curated', t`V5 Curated（筛过的数据，不出成人内容）`],
  ['nai-diffusion-4-5-full', 'V4.5 Full'],
  ['nai-diffusion-4-5-curated', 'V4.5 Curated'],
]
const METHOD_TEXT = { openai: t`OpenAI 兼容图片接口（gpt-image 等）`, gemini: t`Gemini 原生生图`, novelai: 'NovelAI', comfy: t`ComfyUI 工作流`, sdwebui: 'SD WebUI / Forge' }
const NEED_TEXT = { provider: t`还没选供应商`, token: t`还没填令牌`, workflow: t`还没导入工作流`, address: t`还没设地址` }
const naiName = id => NAI_MODELS.find(([value]) => value === id)?.[1] ?? id

/** "NovelAI · V5 Full", "gpt-image-1": how a picked drawing is named while it runs. */
function labelOf(method, model) {
  if (!method) return ''
  if (method.labels) return `${method.name} · ${method.labels[model || method.model] ?? (model || method.model)}`
  if (method.id === 'novelai') return `NovelAI · ${naiName(model || method.model).replace(/（.*$/, '')}`
  if (method.id === 'comfy') return 'ComfyUI'
  if (method.id === 'sdwebui') return 'SD WebUI'
  return model || method.model
}

/**
 * @param deps - { api, el, guard, openSettings(section) } (配图与朗读, where methods are set up).
 */
export function initDrawChoice({ api, el, guard, openSettings }) {
  let dialog = null

  async function load() {
    const [settings, providers] = await Promise.all([api('/api/media/settings'), api('/api/providers').then(info => info.providers, () => [])])
    return drawChoices({ media: settings.media, providers, workflow: settings.workflow, novelai: settings.novelai, own: settings.ownBackends ?? [] })
  }

  /**
   * Ask how to draw one picture. `title` names what is drawn. Resolves to
   * { body, label } (body {} = as the settings say; label for the waiting
   * frame), or null when closed without drawing.
   */
  async function pick({ title, action = t`画`, note = '' } = {}) {
    const choices = await load()
    dialog ??= document.body.appendChild(el('dialog', { class: 'dialog draw-choice', 'aria-label': t`这一张怎么画` }))
    const chosen = startingChoice(choices)
    return new Promise(resolve => {
      let done = null
      const methodOf = () => choices.find(c => c.id === chosen.backend)
      const modelBox = el('div', { class: 'dc-model' })
      const go = el('button', { type: 'submit', class: 'btn primary', text: action })

      function renderModel() {
        const method = methodOf()
        go.disabled = !method?.ready
        if (!method) return modelBox.replaceChildren()
        if (!method.ready) return modelBox.replaceChildren(el('p', { class: 'hint warn', text: t`设置里用的${METHOD_TEXT[method.id] ?? method.name}${NEED_TEXT[method.need] ?? method.needText}：换一种画法，或者先去设置。` }))
        // This install's own backends: their models by name, and what the server says about them.
        if (method.labels) {
          const select = el('select', { 'aria-label': t`模型`, onchange: () => (chosen.model = select.value) }, method.models.map(id => el('option', { value: id, text: id === method.model ? t`${method.labels[id]}（设置里的）` : method.labels[id], selected: id === chosen.model })))
          // replaceChildren prints a null as text: leave the empty ones out.
          return modelBox.replaceChildren(...[method.models.length ? el('label', { class: 'dc-field' }, [el('span', { text: t`模型` }), select]) : null, method.hint ? el('p', { class: 'hint', text: method.hint }) : null].filter(Boolean))
        }
        if (method.id === 'comfy') return modelBox.replaceChildren(el('p', { class: 'hint', text: t`用导入的 ComfyUI 工作流画，模型在工作流里。` }))
        if (method.id === 'sdwebui') return modelBox.replaceChildren(el('p', { class: 'hint', text: t`用 SD WebUI 里当前加载的模型画。` }))
        if (method.id === 'novelai') {
          const select = el('select', { 'aria-label': t`模型`, onchange: () => (chosen.model = select.value) }, method.models.map(id => el('option', { value: id, text: id === method.model ? t`${naiName(id)}（设置里的）` : naiName(id), selected: id === chosen.model })))
          return modelBox.replaceChildren(el('label', { class: 'dc-field' }, [el('span', { text: t`模型` }), select]))
        }
        // OpenAI-compatible and Gemini: any model name, with the known ones to pick from.
        const list = el('datalist', { id: 'draw-choice-models' }, method.models.map(id => el('option', { value: id })))
        const input = el('input', { value: chosen.model, list: 'draw-choice-models', spellcheck: 'false', placeholder: t`例如 gpt-image-1`, 'aria-label': t`模型`, oninput: () => (chosen.model = input.value.trim()) })
        const fetchAll = el('button', { type: 'button', class: 'btn small ghost', text: t`获取`, title: t`问供应商要它的模型列表` })
        fetchAll.onclick = guard(async () => {
          const { models } = await api('/api/providers/models', { method: 'POST', body: { id: method.providerId } })
          const images = models.filter(id => IMAGE_MODEL.test(id))
          list.replaceChildren(...[...new Set([...method.models, ...(images.length ? images : models)])].map(id => el('option', { value: id })))
          input.focus()
        })
        modelBox.replaceChildren(
          el('label', { class: 'dc-field' }, [el('span', { text: t`模型` }), el('span', { class: 'dc-model-row' }, [input, method.providerId ? fetchAll : null]), list]),
          el('p', { class: 'hint', text: method.provider ? t`${method.provider} 的模型；空着就用设置里的 ${method.model || t`（还没填）`}。` : '' }),
        )
      }

      const methods = choices.map(method => {
        const radio = el('input', { type: 'radio', name: 'draw-method', value: method.id, checked: method.id === chosen.backend, disabled: !method.ready })
        radio.addEventListener('change', () => {
          chosen.backend = method.id
          chosen.model = method.model
          renderModel()
        })
        const tag = method.saved ? t`设置里用的` : method.ready ? method.provider : NEED_TEXT[method.need] ?? method.needText
        return el('label', { class: `dc-method${method.ready ? '' : ' off'}` }, [radio, el('span', { class: 'dc-name', text: METHOD_TEXT[method.id] ?? method.name }), tag ? el('span', { class: `dc-tag${method.ready ? '' : ' need'}`, text: tag }) : null])
      })

      const finish = value => {
        done = value
        dialog.close()
      }
      const form = el('form', { method: 'dialog', class: 'dc-form' }, [
        el('h3', { text: title || t`这一张怎么画` }),
        note ? el('p', { class: 'hint', text: note }) : null,
        el('fieldset', { class: 'dc-methods' }, [el('legend', { text: t`画图方式` }), ...methods]),
        modelBox,
        el('p', { class: 'hint', text: t`只用于这一张，不改「配图与朗读」里的设置。` }),
        el('div', { class: 'row end' }, [
          el('button', { type: 'button', class: 'btn ghost small dc-setup', text: t`设置画图方式…`, onclick: () => { finish(null); openSettings?.('image') } }),
          el('span', { class: 'grow' }),
          el('button', { type: 'button', class: 'btn ghost', text: t`取消`, onclick: () => finish(null) }),
          go,
        ]),
      ])
      form.addEventListener('submit', event => {
        event.preventDefault()
        const method = methodOf()
        if (!method?.ready) return
        finish({ body: choiceBody(chosen, choices), label: labelOf(method, chosen.model) })
      })
      dialog.replaceChildren(form)
      dialog.addEventListener('close', () => resolve(done), { once: true })
      renderModel()
      dialog.showModal()
      go.focus()
    })
  }

  return { pick }
}

// ─── 抽图历史 (server/draw-history.mjs) ──────────────────────────────────
// What a place had before it was drawn or uploaded again: a row of small
// pictures under it, newest first. A click takes one back (the one there now
// joins the row), × deletes one. 设置 → 配图 says how many each place keeps.

const SOURCE_TEXT = { drawn: t`画的`, upload: t`上传的`, avatar: t`当过头像` }

/** A card's kept pictures of one place (GET /api/cards/:id/history → slots[slot]) as historyStrip items. */
export const keptItems = (cardId, entries, label = '') => (entries ?? []).map(entry => ({ ...entry, label, src: `/api/cards/${cardId}/history/${entry.file}` }))

/**
 * The row, or null when there is nothing kept.
 * @param items - [{ src, file, at, backend, source, prompt, label }], newest first.
 * @param options - { onPick(item), onRemove(item) } (each guarded by the caller), `title`.
 */
export function historyStrip(el, items, { onPick, onRemove, title = t`旧图` } = {}) {
  if (!items?.length) return null
  const when = at => {
    const date = new Date(at)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
  }
  return el('div', { class: 'draw-history' }, [
    el('div', { class: 'draw-history-head' }, [
      el('span', { class: 'draw-history-title', text: `${title} · ${items.length}` }),
      el('span', { class: 'draw-history-hint', text: t`点一张换回来，× 删掉` }),
    ]),
    el('div', { class: 'draw-history-list' }, items.map(item => {
      const about = [item.label, SOURCE_TEXT[item.source], item.backend, when(item.at)].filter(Boolean).join(' · ')
      return el('figure', { class: 'draw-history-item' }, [
        el('button', { type: 'button', class: 'draw-history-pick', title: about ? t`换回这张：${about}` : t`换回这张`, 'aria-label': item.label ? t`换回这张（${item.label}）` : t`换回这张`, onclick: () => onPick(item) }, [
          el('img', { src: item.src, alt: '', loading: 'lazy' }),
          item.label ? el('span', { class: 'draw-history-tag', text: item.label }) : null,
        ]),
        el('button', { type: 'button', class: 'draw-history-remove', text: '×', title: t`删掉这张旧图`, 'aria-label': t`删掉这张旧图`, onclick: () => onRemove(item) }),
      ])
    })),
  ])
}
