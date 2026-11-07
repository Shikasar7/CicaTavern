// What a card's Tavern Helper scripts are, read from their text. None of them run here (schema.mjs keeps to a schema
// among them, the rest of MVU is built in), so 检查这张卡 says what each one's absence means, and 修改角色卡's talk can
// make up for one with the things it can write. A script loaded from an address is never fetched: its name, its address
// and what its author wrote about it are all there is to go on.

const MAX_LIST = 40
const NAME_CHARS = 60
const ABOUT_CHARS = 160
const SHOWN_BUTTONS = 6
// A script this long with an address in it is a loader, however many mirrors it tries.
const LOADER_CHARS = 1500
// What the talk reads of the scripts asked about.
const CODE_CHARS = 6000
const ALL_CODE_CHARS = 16000

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const KINDS = new Set(['mvu', 'schema', 'schema-remote', 'upkeep', 'updater', 'custom'])
const USES = [
  ['buttons', /replaceScriptButtons|appendInexistentScriptButtons|getButtonEvent/],
  ['events', /\beventOn\b|\btavern_events\b/],
  ['book', /getWorldbook|replaceWorldbook|updateWorldbookWith|createWorldbook/],
  ['model', /\bgenerate(?:Raw)?\(/],
  ['vars', /insertOrAssignVariables|updateVariablesWith|replaceVariables/],
  ['messages', /setChatMessages?\b|createChatMessages|deleteChatMessages/],
  ['page', /\$\(\s*['"`]|\bcreateApp\b|\bdocument\.|\bparent\.document\b/],
]

function addresses(code) {
  return [...code.matchAll(/https?:\/\/[^\s'"`)\\]+/g)].map(match => {
    try {
      return decodeURI(match[0])
    } catch {
      return match[0]
    }
  })
}

const hostOf = url => /^https?:\/\/([^/?#]+)/.exec(url)?.[1] ?? ''

function kindOf(name, code, urls, remote, buttons) {
  // A copy of MVU kept at another address still has its buttons.
  if (urls.some(url => /MagVarUpdate/i.test(url)) || (remote && buttons.includes('重新处理变量'))) return 'mvu'
  if (code.includes('registerMvuSchema')) return 'schema'
  if (remote && [name, ...urls].some(text => /zod|schema|变量结构/i.test(text))) return 'schema-remote'
  if (remote && urls.some(url => /自动更新(?:角色卡|世界书)/.test(url))) return 'updater'
  if (remote && urls.some(url => /世界书强制|自动开启角色卡局部正则|删除角色卡时删除绑定/.test(url))) return 'upkeep'
  return 'custom'
}

/** Its own buttons, in either shape cards keep them; the ones it hides are left out. */
function buttonsOf(script) {
  const list = Array.isArray(script.button?.buttons) ? script.button.buttons : Array.isArray(script.buttons) ? script.buttons : []
  return list.filter(button => button?.visible !== false).map(button => clip(button?.name, 30)).filter(Boolean).slice(0, SHOWN_BUTTONS)
}

/**
 * One script as a page and a model can be told about it.
 * @returns {{ name, on, kind, remote, hosts: string[], buttons: string[], uses: string[], about, effect: 'none'|'some'|'lost' }}
 *   effect: what its absence comes to. Something the author left off, or that this app does itself, is none.
 */
function describe(script) {
  const name = clip(script.name, NAME_CHARS)
  const code = String(script.content ?? '')
  const urls = addresses(code)
  const remote = code.length <= LOADER_CHARS && urls.some(url => /\.m?js(?:$|[?#])/.test(url))
  const buttons = buttonsOf(script)
  const kind = kindOf(name, code, urls, remote, buttons)
  const on = script.enabled !== false
  const effect = !on || ['mvu', 'schema', 'upkeep'].includes(kind) ? 'none' : kind === 'custom' ? 'lost' : 'some'
  return {
    name,
    on,
    kind,
    remote,
    hosts: [...new Set(urls.map(hostOf).filter(Boolean))].slice(0, 3),
    buttons: kind === 'custom' ? buttons : [],
    uses: remote ? [] : USES.filter(([, pattern]) => pattern.test(code)).map(([use]) => use),
    // The tools everyone knows come with a whole readme: what they are is said here already.
    about: kind === 'custom' ? clip(String(script.info ?? '').replace(/[#*]/g, ' '), ABOUT_CHARS) : '',
    effect,
  }
}

/** The scripts in a card's file (helperScriptsOf) → what each one is. */
export function helperSummary(scripts) {
  return (scripts ?? []).slice(0, MAX_LIST).map(describe)
}

/** A list kept on a card: it came through a file, so only its shape is taken on trust. */
export function cleanHelperList(list) {
  if (!Array.isArray(list)) return null
  const strings = (value, max) => (Array.isArray(value) ? value.map(item => clip(item, max)).filter(Boolean) : [])
  return list.slice(0, MAX_LIST).filter(item => item && KINDS.has(item.kind)).map(item => ({
    name: clip(item.name, NAME_CHARS),
    on: item.on !== false,
    kind: item.kind,
    remote: item.remote === true,
    hosts: strings(item.hosts, 80).slice(0, 3),
    buttons: strings(item.buttons, 30).slice(0, SHOWN_BUTTONS),
    uses: strings(item.uses, 20).filter(use => USES.some(([known]) => known === use)),
    about: clip(item.about, ABOUT_CHARS),
    effect: ['none', 'some', 'lost'].includes(item.effect) ? item.effect : 'lost',
  }))
}

const USE_WORDS = { buttons: '脚本按钮', events: '跟着对话事件自动运行', book: '读写世界书', model: '自己调用模型', vars: '改变量', messages: '改聊天消息', page: '在页面上加界面' }
const KIND_WORDS = {
  mvu: 'MVU 框架，这个应用已内置',
  schema: '变量规则，这个应用已读进来照着用',
  'schema-remote': '变量规则，放在网上读不到：变量照常更新，范围和默认值不生效',
  upkeep: '管 SillyTavern 设置的小工具，这里用不上',
  updater: '检查作者更新的工具，这里不会自动更新',
}

function scriptLine(item) {
  const what = !item.on ? '作者关着，没在用'
    : item.kind !== 'custom' ? KIND_WORDS[item.kind]
    : item.remote ? `从网址加载（${item.hosts.join('、')}），内容不在卡里`
    : item.uses.length ? `会${item.uses.map(use => USE_WORDS[use]).join('、')}`
    : '自定义脚本'
  return `- 「${item.name}」：${what}${item.buttons.length ? `；按钮：${item.buttons.join('、')}` : ''}${item.about ? `；作者说明：${item.about}` : ''}`
}

/**
 * 对话修改's view of them, when the request is about them: what each is, and the text of the ones it can read (those named,
 * or every one when none is), so what they do can be written another way. Nothing when the request has nothing to do with them.
 * @param helpers - { list: helperSummary(), scripts: the same scripts with their text, or null when only the list was kept }
 */
export function helperBlock(helpers, text) {
  const list = helpers?.list ?? []
  if (!list.length) return ''
  const asked = String(text ?? '')
  const named = list.filter(item => item.name && asked.includes(item.name))
  if (!named.length && !/脚本|script|酒馆助手|悬浮|按钮/i.test(asked)) return ''
  const wanted = named.length ? named : list
  let room = ALL_CODE_CHARS
  const code = []
  wanted.forEach(item => {
    const script = helpers.scripts?.[list.indexOf(item)]
    if (!script || !item.on || item.kind !== 'custom' || item.remote || room <= 0) return
    const body = String(script.content ?? '').slice(0, Math.min(CODE_CHARS, room))
    room -= body.length
    code.push(`<helper_code name="${item.name.replace(/"/g, '')}">\n${body}\n</helper_code>`)
  })
  return [
    '<helper_scripts>',
    '这张卡带的酒馆助手脚本。这个应用不运行它们，脚本本身不能改，也不要输出脚本。用户想要它们的效果时，读懂它们做什么，用你能写的东西（世界书条目、初始变量和更新规则、开场白、卡的字段）做出尽量接近的效果，在 <reply> 里说清哪些做到了、哪些差一点。',
    '做不到的（按钮、弹窗、自动执行、调用模型）不要假装做到，在 <reply> 里直说。给回复换显示效果可以提正则的「对话修改」，常用开关可以提「快捷开关」，检定、战斗和数值规则可以提「游戏规则」。内容不在卡里的，只能按名字和作者说明猜，猜的要说明。',
    ...list.map(scriptLine),
    ...code,
    '</helper_scripts>',
  ].join('\n')
}
