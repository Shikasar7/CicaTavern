// 世界书 / 预设 → 对话修改: the talk (talk.js) in a window of its own, over the
// worldbook or preset window it was opened from. That window says what is being
// changed and how its changes read (books.js, presets.js) and takes in what was
// applied or undone.
import { t } from '/i18n.js'
import { createTalk } from '/talk.js'

const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'

/** @param deps - { api, el, guard, openProviders } */
export function initTalkDialog({ api, el, guard, openProviders }) {
  const dialog = document.getElementById('talk-dialog')
  const view = {}
  // What open() was given: the session's url, the window's words, the change words, onApplied, onUndone.
  let subject = null
  const ask = name => (...args) => subject[name](...args)
  const maybe = name => (...args) => subject[name]?.(...args)
  const talk = createTalk({ api, el, guard, openProviders }, {
    url: () => subject.url,
    isOpen: () => dialog.open,
    intro: ask('intro'),
    ideas: ask('ideas'),
    placeholder: ask('placeholder'),
    busy: ask('busy'),
    changeTitle: ask('changeTitle'),
    changeWhere: ask('changeWhere'),
    changeNotes: ask('changeNotes'),
    targetLabel: ask('targetLabel'),
    changeBody: maybe('changeBody'),
    canTake: maybe('canTake'),
    context: maybe('context'),
    onApplied: ask('onApplied'),
    onUndone: ask('onUndone'),
    undo: true,
  })

  function layout() {
    view.title = el('h2')
    view.sub = el('span', { class: 'forge-sub' })
    // 清空对话 sits by the send button: the head keeps room for the title on a phone.
    talk.compose.querySelector('.forge-actions').prepend(talk.clear)
    dialog.replaceChildren(
      el('div', { class: 'forge talk' }, [
        el('header', { class: 'forge-head' }, [
          el('div', { class: 'forge-titles' }, [view.title, view.sub]),
          el('div', { class: 'forge-tools' }, [talk.model, el('button', { type: 'button', class: 'btn ghost icon', title: t`关闭`, 'aria-label': t`关闭`, html: ICON_CLOSE, onclick: () => dialog.close() })]),
        ]),
        el('div', { class: 'talk-body' }, [talk.thread, talk.compose]),
      ]),
    )
  }

  /**
   * @param options - { url, title, name, intro(), ideas(), placeholder(target), busy(job),
   *   changeTitle(change), changeWhere(change), changeNotes(change), targetLabel(id),
   *   changeBody?, canTake?, context? (talk.js), onApplied(result), onUndone(result),
   *   onClose? (the window closed: a preview put back), aim: { id, label } (the request kept to one piece) }
   */
  async function open(options) {
    if (!view.title) layout()
    const switching = subject?.url !== options.url
    subject = options
    view.title.textContent = options.title
    view.sub.textContent = options.name
    const [session] = await Promise.all([api(options.url), talk.loadModels()])
    if (switching) talk.reset()
    talk.load(session)
    if (!dialog.open) dialog.showModal()
    if (options.aim) talk.aim(options.aim.id, options.aim.label)
    // The talk opens at its latest turn (it has no size until the window shows).
    talk.scroll()
  }

  dialog.addEventListener('close', () => {
    talk.stop()
    subject?.onClose?.()
  })
  return { open: guard(open) }
}
