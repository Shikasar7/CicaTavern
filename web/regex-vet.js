// 正则限时 (web/app.js vetDisplay): a chat's display regex run off the page, in a worker, so that one which never
// finishes on this chat's text can be found and left out, instead of holding the whole page (a phone's app view has
// one thread for the page and every card frame). Before each script on each message it says which one it starts:
// the page stops the worker when one takes too long, and knows which it was.
import { applyScripts } from './shared/regex.js'

onmessage = ({ data: { scripts, items, names = {}, skip = [] } }) => {
  const macros = text => String(text ?? '').replace(/\{\{char\}\}/gi, names.char ?? '').replace(/\{\{user\}\}/gi, names.user ?? '')
  for (const [at, item] of items.entries()) {
    let text = item.text
    for (const [index, script] of scripts.entries()) {
      if (skip.includes(index)) continue
      postMessage({ at, index })
      text = applyScripts(text, [script], { placement: item.placement, target: 'display', depth: item.depth, macros })
    }
  }
  postMessage({ done: true })
}
