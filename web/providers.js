// Model providers: external APIs (OpenAI-compatible, OpenAI Responses,
// Anthropic Messages). Keys are sent to the
// server once and never come back; the form only shows their last characters.

const PLACEHOLDER = {
  'openai-completions': 'https://api.deepseek.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
}
const URL_HINT = {
  'openai-completions': '写到 /v1 为止（DeepSeek、Kimi、智谱、OpenRouter、本机中转都是这种）。请求发到 …/chat/completions。',
  'openai-responses': '写到 /v1 为止。请求发到 …/responses，不在对方服务器保存对话。',
  'anthropic-messages': '可以省略 /v1。请求发到 …/v1/messages，自动加缓存断点。',
}

// Starting points for a new provider. Model ids change often: the note asks to
// check them with 「从接口获取模型列表」 once the key is in.
const TEMPLATES = [
  {
    name: 'Anthropic', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', proxy: 'global', cacheTtl: '1h',
    models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }, { id: 'claude-fable-5-1', label: 'Fable 5.1' }],
    note: '官方 API，按量计费，密钥在 console.anthropic.com 创建。和「Claude 订阅」是两回事：订阅额度不能当 API Key 用。',
  },
  {
    name: 'OpenAI', api: 'openai-responses', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', proxy: 'global',
    models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-astra' }],
    note: 'ChatGPT 的官方 API，密钥在 platform.openai.com 创建；ChatGPT 会员不含 API 额度。缓存由 OpenAI 自动处理。',
  },
  {
    name: 'DeepSeek', api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', proxy: 'direct',
    models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
    note: '密钥在 platform.deepseek.com 创建，国内直连。前缀不变时自动命中缓存，很便宜。',
  },
  {
    name: 'Gemini', api: 'openai-completions', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY', proxy: 'global',
    models: [{ id: 'gemini-3.1-pro-preview' }, { id: 'gemini-3-flash-preview' }],
    note: 'Google 的 OpenAI 兼容接口，密钥在 aistudio.google.com 创建，需要走代理。',
  },
  {
    name: 'OpenRouter', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', proxy: 'global',
    headers: { 'HTTP-Referer': 'http://localhost', 'X-Title': 'Agent Tavern' },
    models: [{ id: 'anthropic/claude-sonnet-5.5' }, { id: 'google/gemini-3.1-pro-preview' }, { id: 'deepseek/deepseek-v4-flash' }],
    note: '一个密钥用各家模型，模型 ID 写成「厂商/模型」。主要跑 Claude 的话，用「OpenRouter · Claude」模板：Anthropic 接口能打缓存断点，长对话便宜很多。',
  },
  {
    name: 'OpenRouter · Claude', api: 'anthropic-messages', baseURL: 'https://openrouter.ai/api', apiKeyEnv: 'OPENROUTER_API_KEY', proxy: 'global', cacheTtl: '1h',
    models: [{ id: 'anthropic/claude-opus-5.5' }, { id: 'anthropic/claude-sonnet-5.5' }],
    note: '走 OpenRouter 的 Anthropic 接口，酒馆会打缓存断点。',
  },
  {
    name: 'Kimi', api: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY', proxy: 'direct',
    models: [{ id: 'kimi-k3' }],
    note: '月之暗面，密钥在 platform.moonshot.cn 创建。国际站的密钥要把地址换成 https://api.moonshot.ai/v1，两边的密钥不通用。',
  },
  {
    name: '智谱 GLM', api: 'openai-completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY', proxy: 'direct',
    models: [{ id: 'glm-5.1' }],
    note: '密钥在 bigmodel.cn 创建。国际站（z.ai）把地址换成 https://api.z.ai/api/paas/v4。',
  },
  {
    name: '通义千问', api: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY', proxy: 'direct',
    models: [{ id: 'qwen-max' }, { id: 'qwen-plus' }],
    note: '阿里云百炼，密钥在 bailian.console.aliyun.com 创建。qwen-max / qwen-plus 自动指向当前版本。',
  },
  {
    name: '火山方舟', api: 'openai-completions', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', apiKeyEnv: 'ARK_API_KEY', proxy: 'direct',
    models: [{ id: 'deepseek-v4.1-flash' }],
    note: '字节火山引擎（豆包、DeepSeek、GLM 等），模型要先在方舟控制台开通。买了 Agent / Coding 套餐的，地址换成 https://ark.cn-beijing.volces.com/api/plan/v3。',
  },
  {
    name: 'xAI Grok', api: 'openai-completions', baseURL: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY', proxy: 'global',
    models: [{ id: 'grok-4.7' }],
    note: '密钥在 console.x.ai 创建，需要走代理。',
  },
  {
    name: '本机 Ollama', api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: '', proxy: 'direct',
    models: [{ id: 'qwen3:8b' }],
    note: '本机跑的开源模型，不用密钥。直接点「从接口获取模型列表」，选你已经 pull 下来的模型。LM Studio 把端口换成 1234。',
  },
]
const TEMPLATE_CHECK = '模型 ID 更新得很快，填好 Key 后点「从接口获取模型列表」核对一遍。'

/** "id" or "id = 显示名" per line. */
function parseModels(text) {
  return String(text)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const cut = line.indexOf(' = ')
      return cut < 0 ? { id: line } : { id: line.slice(0, cut).trim(), label: line.slice(cut + 3).trim() }
    })
}

const formatModels = models => models.map(m => (m.label ? `${m.id} = ${m.label}` : m.id)).join('\n')

function parseJsonField(text, label) {
  const value = String(text ?? '').trim()
  if (!value) return null
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${label}不是合法的 JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象，例如 {"key": "value"}`)
  return parsed
}

/**
 * @param deps - { api, el, toast, guard, saveFile, onChanged() } — onChanged reloads the model lists.
 */
// How a list tag looks: something to fix, something switched off (style.css .tag.warn / .off).
const TAG_LOOK = { 缺密钥: 'warn', 已关闭: 'off' }

export function initProviders({ api, el, toast, guard, saveFile, onChanged }) {
  const $ = id => document.getElementById(id)
  // locked: no subscription backend on this server (CicaTavern, the phone app): no subscription entry.
  // page: the subscription's parts of the page (/subscription.js), loaded where there is one.
  const state = { list: [], apis: {}, subscription: 'on', locked: false, page: null, selected: null, remote: null, filter: '' }

  async function load() {
    const data = await api('/api/providers')
    state.list = data.providers
    state.apis = data.apis
    state.subscription = data.subscription
    state.locked = data.subscriptionLocked === true
    if (!state.locked && !state.page) state.page = await import('/subscription.js').catch(() => null)
    if (!state.page) state.locked = true
  }

  async function open(selectId) {
    await load()
    const fallback = state.locked ? state.list[0]?.id ?? 'new' : 'subscription'
    state.selected = selectId ?? state.selected ?? state.list[0]?.id ?? fallback
    if (state.selected === 'subscription' && state.locked) state.selected = fallback
    if (state.selected !== 'subscription' && state.selected !== 'new' && !state.list.some(p => p.id === state.selected)) state.selected = fallback
    state.remote = null
    render()
    if (!$('provider-dialog').open) $('provider-dialog').showModal()
  }

  function select(id) {
    state.selected = id
    state.remote = null
    state.filter = ''
    render()
  }

  function render() {
    renderNav()
    renderMain()
  }

  function renderNav() {
    const item = (id, title, tag, sub) =>
      el('li', { class: state.selected === id ? 'active' : '', onclick: () => select(id) }, [
        el('div', { class: 'item-title' }, [el('span', { text: title }), tag ? el('span', { class: `tag ${TAG_LOOK[tag] ?? ''}`, text: tag }) : null]),
        sub ? el('div', { class: 'muted small', text: sub }) : null,
      ])
    $('provider-list').replaceChildren(...[
      state.locked ? null : item('subscription', state.page.NAV.title, state.subscription === 'off' ? '已关闭' : '', state.page.NAV.sub),
      ...state.list.map(p => item(p.id, p.name, p.hasKey || p.envKeySet ? '' : '缺密钥', `${state.apis[p.api] ?? p.api} · ${p.models.length} 个模型`)),
      state.selected === 'new' ? item('new', '新供应商', '未保存', '') : null,
    ].filter(Boolean))
  }

  function renderMain() {
    const main = $('provider-main')
    if (state.selected === 'subscription') return main.replaceChildren(state.page.subscriptionPane({ state, el, api, guard, toast, render, onChanged }))
    const provider = state.selected === 'new' ? null : state.list.find(p => p.id === state.selected)
    main.replaceChildren(providerForm(provider))
  }

  function providerForm(provider) {
    const isNew = !provider
    const p = provider ?? { name: '', api: 'openai-completions', baseURL: '', apiKeyEnv: '', proxy: 'global', headers: {}, models: [], maxTokens: 0, temperature: null, extraBody: null }
    const form = el('form', { class: 'provider-form', novalidate: true })
    const field = (label, control, hint) => el('label', {}, [label, control, hint ? el('span', { class: 'hint', text: hint }) : null])
    const name = el('input', { name: 'name', value: p.name, placeholder: '例如 DeepSeek', required: true, maxlength: 40 })
    const apiSelect = el('select', { name: 'api' }, Object.entries(state.apis).map(([value, text]) => el('option', { value, text, selected: value === p.api })))
    const baseURL = el('input', { name: 'baseURL', value: p.baseURL, placeholder: PLACEHOLDER[p.api], spellcheck: 'false', autocomplete: 'off' })
    const urlHint = el('span', { class: 'hint', text: URL_HINT[p.api] })
    const cacheTtl = el('select', { name: 'cacheTtl' }, [
      el('option', { value: '5m', text: '5 分钟（默认）', selected: p.cacheTtl !== '1h' }),
      el('option', { value: '1h', text: '1 小时', selected: p.cacheTtl === '1h' }),
    ])
    const cacheField = el('label', {}, [
      '缓存保留时长（Anthropic 接口）',
      cacheTtl,
      el('span', { class: 'hint', text: '两轮之间常隔 5 分钟以上（看完再打字、生成本身也要几分钟）就选 1 小时：写缓存贵一点（2 倍 vs 1.25 倍），但隔久了也能命中。中转不认这个字段时自动按 5 分钟重发。' }),
    ])
    const syncCache = () => { cacheField.hidden = apiSelect.value !== 'anthropic-messages' }
    apiSelect.addEventListener('change', () => {
      baseURL.placeholder = PLACEHOLDER[apiSelect.value]
      urlHint.textContent = URL_HINT[apiSelect.value]
      syncCache()
    })
    syncCache()
    const keyNote = p.hasKey ? `已保存（${p.keyHint}），留空不改` : '粘贴 API Key'
    const apiKey = el('input', { name: 'apiKey', type: 'password', placeholder: keyNote, autocomplete: 'new-password', spellcheck: 'false' })
    const clearKey = el('input', { type: 'checkbox', name: 'clearKey' })
    const keyEnv = el('input', { name: 'apiKeyEnv', value: p.apiKeyEnv, placeholder: '例如 DEEPSEEK_API_KEY', spellcheck: 'false' })
    const proxy = el('select', { name: 'proxy' }, [
      el('option', { value: 'global', text: '跟随酒馆的代理设置', selected: p.proxy !== 'direct' }),
      el('option', { value: 'direct', text: '直连（国内服务、本机中转）', selected: p.proxy === 'direct' }),
    ])
    const models = el('textarea', { name: 'models', rows: 5, spellcheck: 'false', placeholder: 'deepseek-chat\ndeepseek-reasoner = 推理版' })
    models.value = formatModels(p.models)
    const remoteBox = el('div', { class: 'remote-models' })
    const fetchButton = el('button', { type: 'button', class: 'btn small', text: '从接口获取模型列表' })
    const maxTokens = el('input', { name: 'maxTokens', type: 'number', min: 0, max: 1000000, step: 256, value: p.maxTokens || '', placeholder: '用预设的' })
    const temperature = el('input', { name: 'temperature', type: 'number', min: 0, max: 2, step: 0.05, value: p.temperature ?? '', placeholder: '服务默认' })
    const extraBody = el('textarea', { name: 'extraBody', rows: 3, spellcheck: 'false', placeholder: '{"thinking": {"type": "disabled"}}' })
    extraBody.value = p.extraBody ? JSON.stringify(p.extraBody, null, 2) : ''
    const headers = el('textarea', { name: 'headers', rows: 2, spellcheck: 'false', placeholder: '{"HTTP-Referer": "http://localhost"}' })
    headers.value = Object.keys(p.headers ?? {}).length ? JSON.stringify(p.headers, null, 2) : ''

    const draft = () => ({
      id: provider?.id,
      name: name.value.trim(),
      api: apiSelect.value,
      baseURL: baseURL.value.trim(),
      apiKey: apiKey.value.trim(),
      clearKey: clearKey.checked,
      apiKeyEnv: keyEnv.value.trim(),
      proxy: proxy.value,
      models: parseModels(models.value),
      maxTokens: Number(maxTokens.value) || 0,
      temperature: temperature.value === '' ? null : Number(temperature.value),
      cacheTtl: cacheTtl.value,
      extraBody: parseJsonField(extraBody.value, '额外请求参数'),
      headers: parseJsonField(headers.value, '额外请求头') ?? {},
    })

    const renderRemote = () => {
      if (!state.remote) return remoteBox.replaceChildren()
      const chosen = new Set(parseModels(models.value).map(m => m.id))
      const query = state.filter.toLowerCase()
      const shown = state.remote.filter(id => !query || id.toLowerCase().includes(query))
      const filter = el('input', { type: 'search', placeholder: `在 ${state.remote.length} 个模型里筛选`, value: state.filter })
      filter.addEventListener('input', () => {
        state.filter = filter.value
        const at = filter.selectionStart
        renderRemote()
        const next = remoteBox.querySelector('input[type="search"]')
        next.focus()
        next.setSelectionRange(at, at)
      })
      remoteBox.replaceChildren(...[
        filter,
        el('div', { class: 'remote-chips' }, shown.slice(0, 300).map(id =>
          el('button', {
            type: 'button',
            class: chosen.has(id) ? 'chip on' : 'chip',
            'aria-pressed': String(chosen.has(id)),
            text: id,
            onclick: () => {
              const list = parseModels(models.value)
              models.value = formatModels(chosen.has(id) ? list.filter(m => m.id !== id) : [...list, { id }])
              renderRemote()
            },
          }),
        )),
        shown.length > 300 ? el('p', { class: 'muted small', text: '只显示前 300 个，筛选一下能看到其余的。' }) : null,
      ].filter(Boolean))
    }
    models.addEventListener('input', renderRemote)
    fetchButton.addEventListener('click', guard(async () => {
      fetchButton.disabled = true
      fetchButton.textContent = '获取中…'
      try {
        const body = draft()
        const { models: list } = await api('/api/providers/models', { method: 'POST', body })
        state.remote = list
        renderRemote()
        toast(list.length ? `连接正常，拿到 ${list.length} 个模型，点一下加入或移出` : '连接正常，但对方没有列出模型，手动填写 ID 吧')
      } finally {
        fetchButton.disabled = false
        fetchButton.textContent = '从接口获取模型列表'
      }
    }))

    // A new provider can start from a template: fills everything but the key.
    const templateNote = el('p', { class: 'hint template-note', hidden: true })
    const templateChips = el('div', { class: 'remote-chips provider-templates' })
    const useTemplate = (template, chip) => {
      if (!name.value.trim() || TEMPLATES.some(t => t.name === name.value.trim())) name.value = template.name
      apiSelect.value = template.api
      apiSelect.dispatchEvent(new Event('change'))
      baseURL.value = template.baseURL
      keyEnv.value = template.apiKeyEnv
      proxy.value = template.proxy
      cacheTtl.value = template.cacheTtl ?? '5m'
      models.value = formatModels(template.models)
      headers.value = template.headers ? JSON.stringify(template.headers, null, 2) : ''
      extraBody.value = ''
      state.remote = null
      renderRemote()
      for (const other of templateChips.children) {
        other.classList.toggle('on', other === chip)
        other.setAttribute('aria-pressed', String(other === chip))
      }
      templateNote.textContent = `${template.note} ${TEMPLATE_CHECK}`
      templateNote.hidden = false
      apiKey.focus()
    }
    templateChips.append(...TEMPLATES.map(template => {
      const chip = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', text: template.name })
      chip.addEventListener('click', () => useTemplate(template, chip))
      return chip
    }))

    const save = el('button', { type: 'submit', class: 'btn primary', text: isNew ? '添加' : '保存' })
    const remove = isNew ? null : el('button', { type: 'button', class: 'btn danger', text: '删除' })
    remove?.addEventListener('click', guard(async () => {
      if (!confirm(`删除「${provider.name}」？用它的对话会提示换模型，已经写好的剧情不受影响。`)) return
      await api(`/api/providers/${provider.id}`, { method: 'DELETE' })
      await load()
      select(state.list[0]?.id ?? (state.locked ? 'new' : 'subscription'))
      await onChanged()
      toast('已删除')
    }))
    form.addEventListener('submit', guard(async event => {
      event.preventDefault()
      const body = draft()
      const saved = isNew
        ? await api('/api/providers', { method: 'POST', body })
        : await api(`/api/providers/${provider.id}`, { method: 'PUT', body })
      await load()
      state.selected = saved.id
      render()
      await onChanged()
      toast(isNew ? `已添加，模型选择里出现了「${saved.name}」这一组` : '已保存')
    }))

    form.append(
      ...(isNew ? [el('div', { class: 'template-row' }, [el('span', { text: '从模板开始（填好地址和模型，只差 API Key）' }), templateChips, templateNote])] : []),
      el('div', { class: 'grid' }, [field('名称', name), field('接口类型', apiSelect)]),
      el('label', {}, ['Base URL', baseURL, urlHint]),
      el('div', { class: 'grid' }, [
        field('API Key', apiKey),
        field('或者读取环境变量', keyEnv, p.apiKeyEnv && !p.envKeySet ? '酒馆的进程里没有这个变量' : ''),
      ]),
      ...(p.hasKey ? [el('label', { class: 'check-row' }, [clearKey, el('span', { text: '清除已保存的密钥' })])] : []),
      field('网络', proxy),
      cacheField,
      el('div', { class: 'models-head' }, [el('span', { text: '模型（每行一个 ID，要换显示名写成「ID = 显示名」）' }), fetchButton]),
      models,
      remoteBox,
      el('details', { class: 'provider-advanced', open: Boolean(p.maxTokens || p.temperature !== null || p.extraBody || Object.keys(p.headers ?? {}).length) }, [
        el('summary', { text: '高级' }),
        el('div', { class: 'grid' }, [field('最大输出 token', maxTokens), field('温度', temperature)]),
        field('额外请求参数（JSON，合并进请求体）', extraBody, '例如关掉思考、指定 reasoning_effort，写法看服务商文档'),
        field('额外请求头（JSON）', headers),
      ]),
      el('div', { class: 'row between provider-actions' }, [el('div', { class: 'row' }, [remove]), el('div', { class: 'row' }, [save])]),
    )
    return el('div', { class: 'provider-pane' }, [
      el('div', { class: 'preset-head' }, [
        el('h3', { class: 'preset-title', text: isNew ? '新供应商' : p.name }),
        el('p', {
          class: 'preset-meta',
          text: '每轮把固定前缀和整段对话记录按原样发过去，前缀不变，支持缓存的服务（DeepSeek、OpenAI、Anthropic 等）会命中缓存。采样参数只用这里填的，预设里的温度等不生效。',
        }),
      ]),
      el('div', { class: 'provider-body' }, [form]),
    ])
  }

  async function importDsh() {
    const report = await api('/api/providers/import-dsh', { method: 'POST', body: {} })
    await load()
    const firstNew = state.list.find(p => report.added.includes(p.name))
    select(firstNew?.id ?? state.selected)
    await onChanged()
    const parts = []
    if (report.added.length) parts.push(`新增 ${report.added.length} 个`)
    if (report.updated.length) parts.push(`更新 ${report.updated.length} 个（密钥保留）`)
    if (report.skipped.length) parts.push(`跳过：${report.skipped.join('、')}`)
    toast(`${parts.join('，') || '没有变化'}。DSH 的密钥不在配置文件里，标着「缺密钥」的逐个粘贴 API Key。`, 9000)
  }

  // Moving providers to another device (the phone app): a file with the keys in it.
  async function exportAll() {
    if (!confirm('导出的文件里有明文 API Key。只在自己的设备之间传，导入后删掉，不要发给别人。继续吗？')) return
    const { archive, skipped } = await api('/api/providers/export', { method: 'POST', body: {} })
    const note = skipped.length ? `跳过了指向本机的：${skipped.join('、')}。` : ''
    saveFile(`Agent酒馆-供应商-含密钥-${archive.exportedAt.slice(0, 10)}.json`, JSON.stringify(archive, null, 2), `导出了 ${archive.providers.length} 个供应商。${note}`)
  }

  async function importFile(file) {
    let archive
    try {
      archive = JSON.parse(await file.text())
    } catch {
      throw new Error('这个文件不是 JSON')
    }
    const report = await api('/api/providers/import', { method: 'POST', body: { archive } })
    await load()
    const firstNew = state.list.find(p => report.added.includes(p.name))
    select(firstNew?.id ?? state.list[0]?.id ?? state.selected)
    await onChanged()
    const parts = []
    if (report.added.length) parts.push(`新增 ${report.added.length} 个`)
    if (report.updated.length) parts.push(`更新 ${report.updated.length} 个`)
    if (report.defaultModel) parts.push(`默认模型设为 ${report.defaultModel}`)
    if (report.failed.length) parts.push(`没导入：${report.failed.join('；')}`)
    toast(`${parts.join('，') || '没有变化'}。导入完可以删掉这个文件，里面有明文密钥。`, 9000)
  }

  return {
    open,
    add: () => open('new'),
    importDsh: guard(importDsh),
    exportAll: guard(exportAll),
    importFile: guard(importFile),
  }
}
