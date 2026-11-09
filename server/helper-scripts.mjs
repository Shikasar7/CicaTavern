// What a card's Tavern Helper scripts are, read from their text. MVU is built in and schema.mjs keeps to a schema among
// them; a script that only follows the story's variables runs in a sandbox on the server (card-scripts.mjs, kind
// 'hooks'), and every other one on the page while the chat is open (web/card-scripts.js, kind 'custom'). 检查这张卡
// says what of each one does not work here (the Tavern Helper functions it calls that the stand-in lacks, SillyTavern's
// own page), and 修改角色卡's talk can make up for one with the things it can write. A script loaded from an address is
// never fetched here: its name, its address and what its author wrote about it are all there is to go on.
import { missingCalls } from '../web/shared/th-api.js'

const MAX_LIST = 40
const NAME_CHARS = 60
const ABOUT_CHARS = 160
const SHOWN_BUTTONS = 6
const SHOWN_MISSING = 12
// A script this long with an address in it is a loader, however many mirrors it tries.
const LOADER_CHARS = 1500
// What the talk reads of the scripts asked about.
const CODE_CHARS = 6000
const ALL_CODE_CHARS = 16000

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const KINDS = new Set(['mvu', 'schema', 'schema-remote', 'upkeep', 'updater', 'hooks', 'custom'])
// MVU's events: what a script that follows the story's variables listens to.
const HOOKS = /\bMvu\.events\b|\bmag_(?:variable_|command_parsed|before_message_update)/
// SillyTavern's own page: what no sandbox on the server has. Reading its chat (SillyTavern.chat, getContext().chat) is not this.
const HOST_PAGE = /\b(?:parent|top)\.document\b|\bwindow\.(?:parent|top)\b(?!\s*\.\s*(?:SillyTavern|TavernHelper|Mvu)\b)|\bdocument\s*\.\s*(?:querySelector|getElementBy|getElementsBy|createElement|body|head|documentElement|addEventListener)|\.showModal\s*\(|\$\(\s*['"`]|\bjQuery\s*\(\s*['"`]/

/** Whether a script runs in the server's sandbox: it follows MVU's events and leaves SillyTavern's page alone. */
export function runsOnServer(code) {
  const text = String(code ?? '')
  return HOOKS.test(text) && !HOST_PAGE.test(text)
}
// SillyTavern's own page, by the parts of it a script reaches for (its message list, its menus and panels): a card
// frame has its own page instead, with only the input box standing in for SillyTavern's.
const ST_PAGE = /['"`](?:#chat\b|\.mes(?:_text|_block)?\b|#sheld\b|#form_sheld|#send_form|#leftSendForm|#rightSendForm|#extensionsMenu|#extensions_settings2?\b|#top-settings-holder|#top-bar|#movingDivs|#options\b|#character_popup|#WorldInfo|#rm_[a-z_]+|#left-nav-panel|#right-nav-panel)/

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
  if (!remote && runsOnServer(code)) return 'hooks'
  return 'custom'
}

/** Its own buttons, in either shape cards keep them; the ones it hides are left out. */
function buttonsOf(script) {
  const list = Array.isArray(script.button?.buttons) ? script.button.buttons : Array.isArray(script.buttons) ? script.buttons : []
  return list.filter(button => button?.visible !== false).map(button => clip(button?.name, 30)).filter(Boolean).slice(0, SHOWN_BUTTONS)
}

/**
 * One script as a page and a model can be told about it.
 * @returns {{ name, on, kind, remote, hosts: string[], buttons: string[], uses: string[], missing: string[], stPage: boolean,
 *   about, effect: 'none'|'some'|'lost' }}
 *   missing: the Tavern Helper functions it calls that are not where it runs (web/shared/th-api.js MISSING).
 *   stPage: it reaches for SillyTavern's own page (its message list, its menus), which a card frame does not have.
 *   effect: what is lost of it here. Something the author left off, or that this app does itself, is none.
 */
function describe(script) {
  const name = clip(script.name, NAME_CHARS)
  const code = String(script.content ?? '')
  const urls = addresses(code)
  const remote = code.length <= LOADER_CHARS && urls.some(url => /\.m?js(?:$|[?#])/.test(url))
  const buttons = buttonsOf(script)
  const kind = kindOf(name, code, urls, remote, buttons)
  const on = script.enabled !== false
  const uses = remote ? [] : USES.filter(([, pattern]) => pattern.test(code)).map(([use]) => use)
  const runs = kind === 'hooks' || (kind === 'custom' && !remote)
  const missing = runs ? missingCalls(code, kind === 'hooks' ? 'server' : 'page').slice(0, SHOWN_MISSING) : []
  const stPage = kind === 'custom' && !remote && ST_PAGE.test(code)
  // A script that runs here loses what the stand-in lacks; one loaded from an address runs too (with the network
  // library switch on), but what it does cannot be told.
  const effect = !on || ['mvu', 'schema', 'upkeep'].includes(kind) ? 'none'
    : runs ? (missing.length || stPage ? 'some' : 'none')
    : 'some'
  return {
    name,
    on,
    kind,
    remote,
    hosts: [...new Set(urls.map(hostOf).filter(Boolean))].slice(0, 3),
    buttons: kind === 'custom' || kind === 'hooks' ? buttons : [],
    uses,
    missing,
    stPage,
    // The tools everyone knows come with a whole readme: what they are is said here already.
    about: kind === 'custom' || kind === 'hooks' ? clip(String(script.info ?? '').replace(/[#*]/g, ' '), ABOUT_CHARS) : '',
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
    missing: strings(item.missing, 40).filter(name => /^[A-Za-z]+$/.test(name)).slice(0, SHOWN_MISSING),
    stPage: item.stPage === true,
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
  hooks: '跟着变量更新执行的脚本，这个应用在服务器的沙盒里照样运行',
  custom: '打开对话时在页面上运行，在它自己的隔离框架里',
}

function scriptLine(item) {
  const what = !item.on ? '作者关着，没在用'
    : item.kind !== 'custom' && item.kind !== 'hooks' ? KIND_WORDS[item.kind]
    : item.kind === 'hooks' ? `${KIND_WORDS.hooks}${item.uses.includes('model') ? '（自己调用模型要玩家允许）' : ''}`
    : item.remote ? `从网址加载（${item.hosts.join('、')}），内容不在卡里；联网时在页面上运行`
    : `${KIND_WORDS.custom}${item.uses.length ? `，会${item.uses.map(use => USE_WORDS[use]).join('、')}` : ''}${item.stPage ? '；改 SillyTavern 自己页面（消息列表、菜单）的部分不起作用' : ''}`
  const lacking = item.missing?.length ? `；这些函数这里没有：${item.missing.join('、')}` : ''
  return `- 「${item.name}」：${what}${lacking}${item.buttons.length ? `；按钮：${item.buttons.join('、')}` : ''}${item.about ? `；作者说明：${item.about}` : ''}`
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
    '这张卡带的酒馆助手脚本，每条后面说了它在这个应用里怎么运行、缺什么。脚本本身不能改，也不要输出脚本。用户想要的效果是脚本在这里缺的那部分时，读懂它做什么，用你能写的东西（世界书条目、初始变量和更新规则、开场白、卡的字段）做出尽量接近的效果，在 <reply> 里说清哪些做到了、哪些差一点。',
    '你也做不到的（改 SillyTavern 自己的页面、装扩展、换预设）不要假装做到，在 <reply> 里直说。给回复换显示效果可以提正则的「对话修改」，常用开关可以提「快捷开关」，检定、战斗和数值规则可以提「游戏规则」。内容不在卡里的，只能按名字和作者说明猜，猜的要说明。',
    ...list.map(scriptLine),
    ...code,
    '</helper_scripts>',
  ].join('\n')
}
