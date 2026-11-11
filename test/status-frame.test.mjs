// The SillyTavern copy of a bar that wears 定制外观 (server/forge/status-frame.mjs): the page's own drawing code in
// a frame. Run here against a stand-in for the page it gets there, and held to what the page itself works out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { statusBarHtml, statusScripts } from '../server/forge/status.mjs'
import { cleanStatusSpec, skinClass, statusGroups } from '../web/shared/status.js'

const CSS = `.status-bar { border-radius: 4px }
.status-title::before { content: "◆ " }
.status-row[data-show="meter"] .status-meter > i { background: linear-gradient(90deg, #e0a030, #fff) }`
const SPEC = cleanStatusSpec({
  title: '青梧山',
  palette: { bg: '#101820', ink: '#f2f2f2', accent: '#e0a030' },
  skin: { name: '玉简', css: CSS },
  fields: [
    { path: '主角.灵力', label: '灵力', show: 'meter', min: 0, max: 200 },
    { path: '主角.境界', label: '境界', show: 'badge' },
    { path: '主角.法宝', label: '法宝', show: 'tags' },
    { path: '主角.同门[0]', label: '师兄', show: 'text' },
    { path: '主角.已入门', label: '入门', show: 'flag' },
    { path: '主角.没有的', label: '没有', show: 'text' },
  ],
})
// As MVU keeps them: a value may come with its description.
const STATE = { 主角: { 灵力: [50, '打坐时回复'], 境界: '炼气三层', 法宝: ['青锋', '避水珠'], 同门: ['陆衡'], 已入门: true } }

// ─── A page to draw in ────────────────────────────────────────────────────

class Node {
  constructor(tag) {
    Object.assign(this, { tag, className: '', attrs: {}, children: [], vars: {}, text: '', hidden: false, isConnected: false, dataset: {} })
    const node = this
    this.style = { setProperty: (name, value) => { node.vars[name] = value } }
    this.classList = {
      add: (...names) => { node.className = [...new Set([...node.className.split(' ').filter(Boolean), ...names])].join(' ') },
      contains: name => node.className.split(' ').includes(name),
      toggle: (name, on = !node.classList.contains(name)) => {
        node.className = [...node.className.split(' ').filter(item => item && item !== name), ...(on ? [name] : [])].join(' ')
        return on
      },
    }
  }

  set textContent(value) { this.text = String(value) }

  get textContent() { return this.text + this.children.map(child => child.textContent).join('') }

  setAttribute(name, value) { this.attrs[name] = String(value) }

  addEventListener() {}

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'object') node.isConnected = true
      this.children.push(typeof node === 'object' ? node : Object.assign(new Node('#text'), { text: String(node) }))
    }
  }

  prepend(...nodes) { this.children.unshift(...nodes) }

  replaceChildren(...nodes) {
    this.children = []
    this.append(...nodes)
  }

  all(name) { return [...(this.className.split(' ').includes(name) ? [this] : []), ...this.children.flatMap(child => child.all(name))] }
}

/** The frame's script run with what Tavern Helper puts there → the page's body, once the bar is drawn. */
async function drawn(html, state) {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1]
  const document = { head: new Node('head'), body: new Node('body'), createElement: tag => new Node(tag) }
  const context = vm.createContext({
    document,
    Mvu: { getMvuData: asked => (asked.message_id === 7 ? { stat_data: state } : null) },
    getCurrentMessageId: () => 7,
    waitGlobalInitialized: async () => {},
    setTimeout,
  })
  // What Tavern Helper leaves in the body beside the page's script: the page's own styles. They must stay.
  const styles = new Node('style')
  document.body.append(styles)
  vm.runInContext(script, context)
  // The bar goes into a place of its own, after what was there.
  const [kept, root] = document.body.children
  assert.equal(kept, styles, 'what was in the body is left there')
  for (let i = 0; i < 50 && !root.children.length; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(document.body.children[0], styles)
  return { ...document, body: root }
}

// What SillyTavern does to a regex's replacement before it is put in the reply: groups filled in, {{match}} too.
const asReplaced = text => text.replace(/\{\{match\}\}/gi, '').replace(/\$(\d+)|\$<([^>]+)>/g, '')

test('a skinned bar\'s SillyTavern copy draws what the page draws, in the look\'s own class', async () => {
  const html = statusBarHtml(SPEC)
  assert.match(html, /^```html\n<!DOCTYPE html>\n<html><head>/)
  assert.match(html, /<\/body><\/html>\n```$/)
  const scope = skinClass(CSS)
  // The look's rules, reaching only the bar that wears them; and the styles the bar stands on, with the page's colors.
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1]
  assert.ok(style.includes(`.${scope}.status-bar { border-radius: 4px }`))
  assert.ok(style.includes(`.${scope} .status-row[data-show="meter"] .status-meter > i`))
  assert.match(style, /^\.status-row \{ display: grid;/m)
  assert.match(style, /^\.status-bar\.skinned \{/m)
  assert.match(style, /:root\{--surface:#f7f8f5;[^}]*--meter-track:/)
  assert.doesNotMatch(style, /status-editor|status-preview|cc-status/, 'the bar\'s rules only, not the editor\'s')

  const document = await drawn(html, STATE)
  const [bar] = document.body.children
  assert.equal(bar.tag, 'section')
  assert.deepEqual(bar.className.split(' ').sort(), ['skinned', scope, 'status-bar'].sort())
  assert.equal(bar.vars['--surface'], '#101820')
  assert.equal(bar.vars['--accent'], '#e0a030')
  assert.equal(bar.all('status-title')[0].text, '青梧山')
  assert.equal(bar.all('status-toggle').length, 0, 'nothing to fold in a frame')
  // The rows the page works out, one for one, told apart the way a look tells them.
  const rows = statusGroups(SPEC, STATE)[0].rows
  assert.deepEqual(bar.all('status-row').map(row => [row.attrs['data-show'], row.attrs['data-label']]), rows.map(row => [row.show, row.label]))
  assert.deepEqual(rows.map(row => row.label), ['灵力', '境界', '法宝', '师兄', '入门'], 'what has no value has no row')
  assert.equal(bar.all('status-meter')[0].children[0].attrs.style, 'width:25.0%')
  assert.equal(bar.all('status-badge')[0].text, '炼气三层')
  assert.deepEqual(bar.all('status-tag').map(tag => tag.text), ['青锋', '避水珠'])
  assert.equal(bar.all('status-text').at(-1).text, '陆衡', 'a path into a list')
  assert.equal(bar.all('status-flag')[0].text, '是')
  // Nothing of this bar in the state yet: the frame stays empty.
  assert.equal((await drawn(html, { 别的: 1 })).body.children.length, 0)
})

test('nothing in the copy is what SillyTavern reads as its own, and it survives being a replacement', async () => {
  const html = statusBarHtml(SPEC)
  assert.doesNotMatch(html, /\{\{/, 'no macro')
  assert.doesNotMatch(html, /\$(\d|<)/, 'no group')
  assert.equal(html.match(/```/g).length, 2, 'the code block is the page, whole')
  assert.equal(html.match(/<\/script>/g).length, 1)
  assert.equal(asReplaced(html), html)
  // A look that tries to close the sheet stays inside it.
  const sly = cleanStatusSpec({ ...SPEC, skin: { css: '.status-title::after { content: "</style><b>" }' } })
  assert.equal(statusBarHtml(sly).match(/<\/style>/g).length, 1)
})

test('a card in English gets the bar\'s own words in English; a plain bar keeps the small copy', async () => {
  const english = { hidePlaceholder: 'Hide', statusBar: 'Status bar', english: true }
  const [, script] = statusScripts(SPEC, english)
  assert.equal(script.findRegex, '<StatusPlaceHolderImpl/>')
  const bar = (await drawn(script.replaceString, STATE)).body.children[0]
  assert.equal(bar.all('status-flag')[0].text, 'Yes')
  const [, chinese] = statusScripts(SPEC, { hidePlaceholder: '隐藏', statusBar: '状态栏' })
  assert.equal((await drawn(chinese.replaceString, STATE)).body.children[0].all('status-flag')[0].text, '是')
  assert.ok(script.replaceString.length < 90000, `the page is ${script.replaceString.length} characters`)

  const { skin: _, ...plain } = SPEC
  const small = statusBarHtml(plain)
  assert.match(small, /<div class="bar" id="bar" style="--bg:#101820;/)
  assert.doesNotMatch(small, /status-row|skinned/)
  assert.ok(small.length < 12000)
})
