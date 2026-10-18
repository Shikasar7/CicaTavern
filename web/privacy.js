// 隐私与网络: the connections nobody configured, and their switches. The public
// builds (features.privacyNotice) list them once at the first start, before
// any of them is made: until then the page loads no web font, no card library
// and the update check waits (server/http.mjs). Settings → 更多 →「隐私与网络」
// changes them later.

/** What CicaTavern connects to, for the notice and the settings page. */
export function connectionList(el, { updates }) {
  return el('ul', { class: 'privacy-list' }, [
    el('li', { text: '你自己添加的模型供应商、画图和朗读服务：只在你配置之后才连，发过去的是对话内容和相关设置。' }),
    updates ? el('li', { text: '检查更新：每天最多一次访问 GitHub（api.github.com），只发送版本号（对方能看到你的 IP 地址）。' }) : null,
    el('li', { text: '正文字体：从 Google Fonts 加载思源宋体。关掉后用系统自带的字体。' }),
    el('li', { text: '酒馆助手脚本库：为酒馆助手做的角色卡界面（状态栏等）用到 jQuery、Vue、Tailwind 等时，从 jsDelivr 等公共 CDN 加载。关掉后这类界面可能显示不全。' }),
    el('li', { text: '角色卡和预设里的网页内容，可能从卡片作者写的网址加载图片或字体。' }),
    el('li', { text: '不收集使用数据，也不发给开发者。数据只存在你的设备上。' }),
  ])
}

/**
 * The notice: shown once, before the first connection. → resolves when confirmed.
 * @param save - ({ webFonts, cdnLibraries, autoCheck }) → stores them and marks the notice seen.
 */
export function showPrivacyNotice({ el, features, settings, autoCheck, save }) {
  return new Promise(resolve => {
    const box = (label, checked) => {
      const input = el('input', { type: 'checkbox', checked })
      return { input, row: el('label', { class: 'check-row' }, [input, label]) }
    }
    const updates = features.updates ? box('每天检查一次更新（GitHub）', autoCheck !== false) : null
    const fonts = box('加载网络字体（Google Fonts）', settings.webFonts !== false)
    const libraries = box('加载酒馆助手脚本库（jsDelivr 等）', settings.cdnLibraries !== false)
    const dialog = el('dialog', { class: 'dialog privacy-notice' })
    const ok = el('button', { type: 'button', class: 'btn primary', text: '好的，开始用' })
    dialog.append(
      el('h2', { text: '开始之前：CicaTavern 会连哪些地方' }),
      connectionList(el, { updates: Boolean(features.updates) }),
      el('p', { class: 'hint', text: '不用配置也会连的这几项，可以现在关掉：' }),
      ...[updates, fonts, libraries].filter(Boolean).map(b => b.row),
      el('p', { class: 'hint', text: '以后在 设置 → 更多 →「隐私与网络」里随时能改。' }),
      el('div', { class: 'row privacy-actions' }, [ok]),
    )
    // Esc does not skip it: the choice has to be made once.
    dialog.addEventListener('cancel', event => event.preventDefault())
    ok.addEventListener('click', async () => {
      ok.disabled = true
      try {
        await save({ webFonts: fonts.input.checked, cdnLibraries: libraries.input.checked, autoCheck: updates ? updates.input.checked : undefined })
        dialog.close()
        dialog.remove()
        resolve()
      } catch (error) {
        ok.disabled = false
        ok.textContent = `没保存成功：${error.message}，再点一次`
      }
    })
    document.body.append(dialog)
    dialog.showModal()
  })
}
