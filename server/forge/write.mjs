// Writing a planned card: the entries and openings asked of the model in a few
// grouped calls, a check for stock phrases (local patterns, then a review by
// the model), the state-tracking entries built in code, and the finished card
// as SillyTavern's V3 shape.
import YAML from 'yaml'
import { toBookEntry } from './configure.mjs'
import { DEFAULT_LANGUAGE, LONG_TOKENS, TALK_TOKENS, conditionValue, englishCard, eventConditions, looseJson, ownWords, plainWriting, planLanguage, playerRoot, section, stagesOf, typedValue } from './prompts.mjs'
import { msg } from '../i18n.mjs'
import { WRITE_REFERENCE_RULES, referenceBlock, userMessage, writingMaterial } from './references.mjs'
import { creditText } from './structure.mjs'
import { creationOpening, creationReady } from './creation.mjs'
import { mvuHelper, statusScripts, statusSpecOf } from './status.mjs'
import { EVENTS_DONE, LIST_GROWS } from '../../web/shared/status.js'
import { cleanCover } from '../../web/shared/cover.js'
import { brickContent, brickScripts } from './bricks.mjs'
import { writablePath } from '../../web/shared/vars.js'
import { cleanRulebook, kitBook, kitWorld } from '../../web/shared/game/sheet.js'

const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

// ─── What each kind of entry looks like ───────────────────────────────────
// Keyed by `type` or `type.part`. Entries are lore for the model, not prose for
// people: terse, structured, only what the model would otherwise get wrong.
const FORMATS = {
  世界观: `世界设定：真实世界写「时代」和「与常识不同」的列表；架空世界写「世界框架」「社会结构」「核心规则」三组列表。常识和套路一句带过。300 到 800 字。`,
  扮演准则: `扮演准则：写「互动规则」列表（可执行的指令，例如不替 <user> 说话、角色有自己的目标）和「文风」（视角、语言、氛围、要点列表）。写怎么演，不写设定。200 字以内。`,
  '时间线.history': `往事：列出会影响眼下局势的事件，每条写「事件」和「影响」。删掉之后角色行为和局势都不变的，不写。`,
  '地理.region': `地点：写「概况」（样子、氛围）、「场所」列表、在这里常发生什么、有哪些人出没。150 到 400 字。`,
  '地理.faction': `势力：写「概况」「据点」「主要成员」「对 <user> 的态度」。150 到 400 字。`,
  '角色.basic': `角色档案（不写性格）：
基本信息: {姓名, 年龄, 性别, 身份, 与<user>的关系}
外貌特征: {体型, 发型, 瞳色, 穿着, 特征}（只写遮住名字也认得出她的特征）
背景设定: {家庭背景, 关键经历: [...], 社交关系}（只写删掉后角色会变的经历）
关系设定: {与<user>的关系: {定位, 认识过程, 互动方式}}
说话: {风格, 口头禅}（照方案的 voice 写）
200 到 500 字。`,
  '角色.personality': `性格调色盘：第一行写「性格调色盘：人的性格像调色盘，<底色>是底色，<主色调>是主色调，多种性格衍生组合起来，才是活生生的人」。
然后写「主色调」（1 到 2 个）、「底色」、「点缀」。
接着每个性格点写 2 到 3 条衍生，形如「温柔衍生一：……」，每条落到具体场景和行为（她会做什么、说什么），可以彼此矛盾，可以牵涉别的角色。不贴标签。
400 到 1000 字。`,
  '角色.facets': `三面性：角色在不同压力下判若两人的几副面孔。每一面写：触发条件、状态（精力和情绪的样子）、语料（5 到 10 句纯对白，不夹动作和心理）、身体习惯、这一面替她做到了什么。面与面之间写两组以上的过渡细节。不解释原因：不用「因为」「本质上」「其实」「内心」。`,
  '角色.rephrase': `二次解释：纠正模型对这个角色的刻板理解。第一行「对<角色名>的理解：」，然后每个性格点一段「关于<性格点>：」，写清它真正的意思、必要时写它不是什么、什么时候出现什么时候收起、和其他性格怎么相处。
最后一段总结：她在任何时候都由多种性格、行为、回忆一起驱动，不是一个颜色、一个标签。300 到 800 字。`,
  '角色.catalog': `角色速览：列出每个人的姓名、性别、年龄、身份，顺序是 <user>、核心角色、配角。`,
  事件: `事件：写「触发」（什么时候、什么情形下发生）、「经过」（会出现的场面，谁会怎么做、说什么，留出 <user> 回应的余地）、「之后」（这件事改变了什么）。不写死结果，不替 <user> 做决定。150 到 400 字。`,
  NPC: `配角：
基本信息: {姓名, 年龄, 性别, 身份}
外貌: {整体印象, 关键特征（1 到 2 个）, 穿着}
性格核心: {核心特质（2 到 3 个，写成行为）, 行为模式: [...]}
与<user>的关系: {关系, 态度（写具体画面）, 互动方式}
说话: {风格, 口头禅, 参考语料（5 到 10 句纯对白）}
150 到 400 字。`,
}

const formatOf = entry => FORMATS[`${entry.type}.${entry.rephrase ? 'rephrase' : entry.part}`] ?? FORMATS[entry.type] ?? ''

// The prompts are in Chinese; what they ask for is written in the plan's language (写作语言).
const writeSystem = language => `你是角色卡写手，按创作方案写 SillyTavern 世界书的条目。条目是写给模型看的设定，不是写给人看的小说：
- 用 YAML 风格${language === DEFAULT_LANGUAGE ? '的中文' : ''}：键值对和列表，缩进两个空格，不写成散文段落。
- 只写模型不知道、或者会弄错的东西；常识不写，主观评价不写。
- 每条只装一类信息，独立可读：不提别的条目（不写「详见」「见上文」），不写给作者看的话（「写作要点」「本卡」「戏剧作用」）。
- 方案里的名字、设定一律照用，不新造专有名词；用户的原话（verbatim）原样保留。
- 独占一行的「【阶段：……】」是分阶段的分段标记，原样保留，改写时也不动。
- 玩家写作 <user>；方案没写 <user> 是男是女，就不用「他」「她」指代 <user>。
${plainWriting(language)}`

// The player's gender when the plan has one (创作角色卡 你的性别): the writers are told outright, so a pronoun or a way of
// addressing <user> is not guessed. None = nothing more, and the rule against 他/她 above stands.
const PLAYER_GENDER = { female: ['女性', '她'], male: ['男性', '他'] }
const genderRule = plan => {
  const said = PLAYER_GENDER[plan.user_role?.gender]
  return said ? `\n- 方案里 <user> 是${said[0]}：指代 <user> 用「${said[1]}」（别的语言用对应的代词），称呼和关系的叫法也按${said[0]}来。` : ''
}

// Without the player's name: the card says <user>, whatever the player is called.
const SAMPLE_PLAN = plan => {
  const { entries, warnings, user_role: { name, ...role } = {}, ...rest } = plan
  return JSON.stringify({ ...rest, user_role: role })
}

/**
 * Written text with the player's name (one the player chose) put back as <user>,
 * should a writer have used it. A name inside another name is left alone.
 */
export function userTagged(text, plan) {
  const name = plan?.user_role?.name ?? ''
  const taken = (plan?.characters ?? []).flatMap(c => [c.name, ...(c.aliases ?? [])])
  const tidy = chineseText(text, planLanguage(plan ?? {}))
  if (name.length < 2 || taken.some(word => word.includes(name))) return tidy
  return tidy.replaceAll(name, '<user>')
}

const HAN = /[一-鿿]/

/**
 * Chinese text set right where a writer slipped into English punctuation
 * ("你来了。" → “你来了。”, 松了,珠子 → 松了，珠子), and the seam a cut leaves
 * (声音很轻，。 after the review took out a simile). Lines with no Chinese, and
 * text in other languages, as they are.
 */
export function chineseText(text, language = DEFAULT_LANGUAGE) {
  if (!/中文|chinese/i.test(language)) return String(text ?? '')
  return String(text ?? '').split('\n').map(line => {
    if (!HAN.test(line)) return line
    return line
      .replace(/"([^"\n]*)"/g, (all, inside) => (HAN.test(inside) ? `“${inside}”` : all))
      .replace(/(?<=[一-鿿”」』）])\s*,\s*(?=[^\d\s])/g, '，')
      .replace(/(?<=[一-鿿])\?/g, '？')
      .replace(/(?<=[一-鿿])!(?!\[)/g, '！')
      .replace(/(?<=[一-鿿])\s*;\s*(?=[一-鿿])/g, '；')
      .replace(/(?<=[一-鿿])\s*:\s*(?=[一-鿿“「])/g, '：')
      .replace(/(?<=[一-鿿])\.{3,}|\.{3,}(?=[一-鿿])/g, '……')
      .replace(/[，、；]\s*(?=[。！？」”』])/g, '')
      .replace(/([，、；])\s*[，、；]/g, '$1')
      // 「<user> 推开门」: no space beside the player in Chinese (it shows once the name is 你).
      .replace(/(?<=[一-鿿，。！？、；：“”「」『』（）])[ \t]*(<user>|\{\{user\}\})[ \t]*(?=[一-鿿，。！？、；：“”「」『』（）])/g, '$1')
      .replace(/^[ \t]*(<user>|\{\{user\}\})[ \t]+(?=[一-鿿])/, '$1')
  }).join('\n')
}

/** Entries already written, as context for the next call (trimmed). */
function writtenBlock(entries, budget = 6000) {
  let used = 0
  const parts = []
  for (const entry of entries) {
    if (!entry.content || used > budget) continue
    const text = entry.content.slice(0, Math.max(400, budget - used))
    used += text.length
    parts.push(`<entry name="${entry.name}">\n${text}\n</entry>`)
  }
  return parts.length ? `<written>\n以下是已经写好的条目，写新的条目时与它们保持一致，不要重复它们的内容：\n${parts.join('\n')}\n</written>` : ''
}

// A staged entry is written as one text with a line 【阶段：name】 before each stage's part; wrapped() turns those into EJS.
const STAGE_MARK = /^[ \t]*【阶段[:：]\s*(.+?)】[ \t]*$/

/** How to write an entry whose character changes by stage, for its writer. */
function stagedNote(plan, entry) {
  const staged = stagesOf(plan, plan.characters.find(c => c.name === entry.owner))
  if (!staged) return ''
  const label = staged.variable.label || staged.variable.path
  const ranges = staged.stages.map((s, i) => {
    const from = i ? `${label} ≥ ${staged.stages[i - 1].below}` : ''
    const to = s.below === null ? '' : `${label} < ${s.below}`
    return `「${s.name}」（${[from, to].filter(Boolean).join('，')}${s.main.length ? `；主色调${s.main.join('、')}` : ''}${s.accent.length ? `；点缀${s.accent.join('、')}` : ''}${s.shift ? `；${s.shift}` : ''}）`
  })
  return `\n  分阶段：先写所有阶段都一样的部分（底色，以及各阶段通用的衍生或解释），然后每个阶段一段，每段以独占一行的「【阶段：阶段名】」开头，只写这个阶段新出现或不同的东西。阶段依次是：${ranges.join('、')}。`
}

/** What an event entry is about, from the plan's events. */
function eventNote(plan, entry) {
  const event = plan.events?.[entry.event]
  return event ? `\n  事件内容：${[event.when, event.content].filter(Boolean).join('；')}` : ''
}

/**
 * What a batch of a bigger card is told of the plan: the world, the core cast, and in full only the people, places
 * and events being written. The rest stay as names: the whole plan with every batch costs more than the writing.
 */
function batchPlan(plan, targets) {
  if (!plan.scale) return plan
  const named = new Set(targets.flatMap(target => [target.name, target.owner].filter(Boolean)))
  const short = place => (named.has(place.name) ? place : { name: place.name })
  return {
    ...plan,
    characters: plan.characters.map(c => (c.kind === 'core' || named.has(c.name) ? c : { name: c.name, kind: c.kind, identity: c.identity })),
    world: { ...plan.world, places: plan.world.places.map(short), factions: plan.world.factions.map(short) },
    events: plan.events.filter((_, index) => targets.some(target => target.event === index)),
  }
}

export function entriesRequest(plan, targets, written, references = []) {
  const material = referenceBlock(writingMaterial(references))
  const asked = targets.map(e => `- ${e.name}：${e.purpose}\n  写法：${formatOf(e)}${e.staged ? stagedNote(plan, e) : ''}${e.type === '事件' ? eventNote(plan, e) : ''}`).join('\n')
  const content = [
    `<plan>\n${SAMPLE_PLAN(batchPlan(plan, targets))}\n</plan>`,
    writtenBlock(written),
    `这次要写下面这些条目：\n${asked}`,
    '每个条目的正文放在 <entry name="条目名"> 和 </entry> 之间，名字和上面一字不差；只写正文，标签外不写别的。',
  ].filter(Boolean).join('\n\n')
  return { system: writeSystem(planLanguage(plan)) + genderRule(plan) + (material ? WRITE_REFERENCE_RULES : ''), messages: [userMessage(material, content)], maxTokens: LONG_TOKENS, softCap: true }
}

const greetingSystem = language => `你是角色卡的开场白作者。开场白是玩家进入故事读到的第一段正文，它决定玩家想不想开口。
- 头三行就要有抓人的东西：悬念、反常的细节、情绪的拉扯，或者一个悬而未决的问题；不要平淡地交代天气和环境。
- 让玩家知道 <user> 是谁、为什么在这里。
- 角色靠动作、物件、对白出场，不写人物介绍式的罗列。
- 场景里要有看得见的空间、时间、物件、动作，和此刻的压力。
- 结尾给 <user> 一个明确可以接的话头或可以做的事；不要用「接下来会怎样呢」敷衍。
- 不替 <user> 说话、想事、做动作或做决定。
- 节奏：连着三句一样长就打破它；相邻两段不要用同一种方式收尾。
- 按方案的文风写（视角、语言、氛围）；叙述里的时间、地点、关系、数值与初始状态一致。
- 玩家写作 <user>。方案没写 <user> 是男是女，就不用「他」「她」指代 <user>。
${plainWriting(language)}`

/** An opening's own starting values, as a line for its writer ('' when it starts from the defaults). */
function stateLine(plan, greeting) {
  const own = Object.entries(greeting.state ?? {})
  if (!own.length) return ''
  const label = path => plan.tracking.variables.find(v => v.path === path)?.label || path
  return `\n  这个开场的开局数值和默认不同：${own.map(([path, value]) => `${label(path)}（${path}）= ${value}`).join('；')}。叙述要和它们一致。`
}

export function greetingsRequest(plan, targets, written, initial, references = []) {
  const material = referenceBlock(writingMaterial(references))
  const asked = targets.map(g => `- 开场 ${g.index + 1}「${g.title}」：${[g.start, g.scene, g.situation].filter(Boolean).join('；')}。${g.length} 字。${plan.tracking.enabled ? stateLine(plan, g) : ''}`).join('\n')
  const content = [
    `<plan>\n${SAMPLE_PLAN(plan)}\n</plan>`,
    writtenBlock(written, 5000),
    initial ? `<initial_state>\n${initial}\n</initial_state>` : '',
    `这次要写下面这些开场白：\n${asked}`,
    '每段开场白放在 <greeting index="序号"> 和 </greeting> 之间，序号和上面一致；只写正文，标签外不写别的。',
  ].filter(Boolean).join('\n\n')
  return { system: greetingSystem(planLanguage(plan)) + genderRule(plan) + (material ? WRITE_REFERENCE_RULES : ''), messages: [userMessage(material, content)], maxTokens: LONG_TOKENS, softCap: true }
}

// ─── Reading written text back ────────────────────────────────────────────

const squash = name => String(name).replace(/[\s「」"'【】]/g, '')

/** Blocks <tag name="…">…</tag> (or index="…") → Map of name → text; tolerant of a missing close tag. */
export function readTagged(text, tag, attr = 'name') {
  const out = new Map()
  const re = new RegExp(`<${tag}\\s+${attr}\\s*=\\s*"([^"]+)"\\s*>([\\s\\S]*?)(?=</${tag}>|<${tag}\\s+${attr}\\s*=|$)`, 'gi')
  for (const [, key, body] of String(text ?? '').matchAll(re)) {
    const value = body.replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim()
    if (value) out.set(squash(key), value)
  }
  return out
}

/** The text written for each target, matched by name; one target takes a lone block whatever its name. */
export function matchWritten(blocks, names) {
  const found = new Map()
  for (const name of names) {
    // Also a name with what the entry is for after it (角色速览：谁是谁), when no other target is named so.
    const key = squash(name)
    const after = [...blocks.keys()].find(k => /^[：:（(—\-]/.test(k.slice(key.length)) && k.startsWith(key) && !names.some(other => other !== name && squash(other) === k))
    const text = blocks.get(key) ?? (after ? blocks.get(after) : undefined)
    if (text) found.set(name, text)
  }
  if (names.length === 1 && !found.size && blocks.size === 1) found.set(names[0], [...blocks.values()][0])
  return found
}

// ─── The check ────────────────────────────────────────────────────────────
// Patterns of stock phrasing; a hit is a candidate, the review decides.
const LINT = [
  ['破折号', /——/g],
  ['模糊词', /似乎|仿佛|宛如|如同/g],
  ['表情套话', /嘴角.{0,4}(上扬|勾起)|闪过一丝/g],
  ['声线套话', /带着.{1,8}的(口吻|语气)|用.{1,8}的语气/g],
  ['陈旧比喻', /心湖|泛起涟漪|投石入湖|像.{0,2}小兽/g],
  ['夸张情绪', /万念俱灰|陷入(了)?极大的/g],
  ['否定转折', /不是.{1,10}[，,]\s*(只是|而是)/g],
  ['名称不具体', /某(城市|学校|组织|公司|地方|小镇)|那个地方/g],
  ['写给作者的话', /本卡|写作要点|戏剧(用途|作用)|详见|见上文/g],
  ['隔着讲情绪', /[她他](感到|意识到)|对自己说|并不知道，/g],
  ['假主语', /一股.{0,8}(涌|蔓延)|被一种.{0,10}包裹|念头在.{0,4}(心里|心中)成形/g],
]
const FACET_LINT = ['解释原因', /因为|本质上|其实|内心/g]

/** Candidate stock phrases in one text: [{ label, excerpt }]. The user's own words are left alone. */
export function lintText(text, { facets = false, verbatim = [] } = {}) {
  let body = String(text ?? '')
  for (const said of verbatim) if (said) body = body.split(said).join(' ')
  const hits = []
  for (const [label, re] of facets ? [...LINT, FACET_LINT] : LINT) {
    for (const match of body.matchAll(re)) {
      const at = match.index
      hits.push({ label, excerpt: body.slice(Math.max(0, at - 12), at + match[0].length + 12).replace(/\s+/g, ' ') })
      if (hits.length > 40) return hits
    }
  }
  return hits
}

/** Every written piece as review targets: entries (the state entries are code) and openings. */
export function reviewTargets(card) {
  return [
    ...card.entries.filter(e => e.content && e.type !== '状态').map(e => ({ target: e.name, text: e.content, facets: e.part === 'facets' })),
    ...card.greetings.map((g, i) => ({ target: `开场白${i + 1}`, text: g.text })).filter(t => t.text),
  ]
}

export function lintCard(card, verbatim = []) {
  return reviewTargets(card).flatMap(t => lintText(t.text, { facets: t.facets, verbatim }).map(hit => ({ target: t.target, ...hit })))
}

const reviewSystem = (facts = '') => `你是角色卡的审稿人，眼光严格，宁可多挑也不放过。逐段检查下面的条目和开场白，找出这些毛病：
- 套话：陈旧比喻、「仿佛/似乎」一类模糊词、细小表情的固定写法、「带着……的语气」、夸张的情绪词、破折号。
- 贴标签：用「温柔善良」「关系很好」这种词代替具体的画面和行为。
- 隔着讲情绪：「她感到」「她意识到」「一股暖意涌上心头」这类，应当写成看得见的动作和细节。
- 翻译腔：「她是拘谨的」「对这件事她是回避的」「被她感受到了」。
- 名称不具体：「某城市」「那个地方」。
- 写给作者看的话、引用别的条目（「详见」「本卡」「戏剧作用」）。
- 前后矛盾：同一个角色在不同段落里外貌、性格、关系对不上；两个角色共用同样的标签；几段反复用同一个比喻或句式。
开场白按文风写，可以有修辞，但上面的毛病照样要挑。用户的原话不挑。${facts}

只输出一段 <issues> 包着的 JSON 数组，没有毛病就输出 []：
<issues>
[{"target": "条目名或「开场白1」", "type": "毛病的类别", "original": "原文里一字不差的一小段", "suggestion": "改成什么；要删掉就写空字符串"}]
</issues>
original 必须能在原文里原样找到，而且在那一段里只出现一次（会重复就带上前后几个字），此外尽量短；suggestion 只写替换 original 的那一小段，不要把 original 前后的原文再写一遍（原文「她盯着你，像要看穿什么，眨眼变少」，要删比喻就写 original「像要看穿什么，」、suggestion 空字符串）；最多 30 条。`

// Said only when the facts come along: without them the review cannot tell a wrong name from a right one.
const REVIEW_FACTS = `
<plan_facts> 是创作方案里定下的事实。条目或开场白和它对不上的，也算前后矛盾，type 写「和方案不符」：名字写错、外号张冠李戴、年龄性别身份或和 <user> 的关系变了、地点和势力说错、违背了设定、开场的处境和开局数值对不上。以方案为准，suggestion 照方案改。方案里没列出的内容不算矛盾。同一个错出现几处就每处各报一条；名字常是别的名字的一部分（「小雨」在「林小雨」里），original 要带上前后的字。`

// The facts' share of the review. Lines are cut to what a wrong name, a changed
// relationship or a moved place shows up against, so a small plan fits whole in
// about 1000 characters even with every field written to its limit (about a tenth
// of its review); a large one keeps what the card mentions most.
const FACTS_BUDGET = 1200
const short = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * What the plan settled that a review can hold the written card to: names,
 * relationships, places, rules, the openings and their starting values. Lines
 * only, no prose (what a character is for in the story, a place's scenes and
 * the events, which the card writes up under their own names, are left out);
 * each field is cut short. With a large plan the parts the card
 * mentions least are left out, and a closing line says what was.
 * @param texts - the card's written pieces, to rank by mentions when not everything fits.
 */
export function planFacts(plan, texts = [], budget = FACTS_BUDGET) {
  if (!plan?.characters?.length) return ''
  const said = PLAYER_GENDER[plan.user_role?.gender]
  const named = (name, aliases) => `${name}${aliases?.length ? `（又名 ${aliases.join('、')}）` : ''}`
  // A side character is checked by name and who they are; a core one also by how they stand with <user> and look.
  const character = c => `- ${[
    named(c.name, c.aliases),
    c.kind === 'npc' ? '配角' : '',
    c.gender, c.age, short(c.identity, c.kind === 'npc' ? 16 : 24),
    c.kind !== 'npc' && c.relationship && `和 <user>：${short(c.relationship, 30)}`,
    c.kind !== 'npc' && c.appearance?.length && `外貌：${short(c.appearance.join('、'), 24)}`,
    c.kind !== 'npc' && c.personality?.base && `底色 ${short(c.personality.base, 8)}`,
  ].filter(Boolean).join('｜')}`
  const opening = (g, i) => {
    const state = Object.entries(g.state ?? {}).map(([path, value]) => `${path}=${short(value, 16)}`).join('，')
    const detail = [short(g.scene, 16), short(g.start, 30), state && `开局数值不同：${state}`].filter(Boolean).join('；')
    return `- 开场白${i + 1}「${g.title}」${detail ? `：${detail}` : ''}`
  }
  // Each section: a heading, its items as [line, the name the card would mention it by].
  const sections = [
    { title: '<user>', items: [[`- ${[said?.[0], short(plan.user_role?.identity, 30), ...(plan.user_role?.constraints ?? []).slice(0, 3).map(c => short(c, 16))].filter(Boolean).join('｜')}`, '']].filter(([line]) => line !== '- ') },
    { title: '核心角色', items: plan.characters.filter(c => c.kind === 'core').map(c => [character(c), c.name]) },
    { title: '世界', items: [plan.world?.overview && [`- ${plan.world.kind === '真实' ? '真实世界' : '架空世界'}：${short(plan.world.overview, 40)}`, ''], ...(plan.world?.rules ?? []).map(r => [`- ${short(r, 30)}`, ''])].filter(Boolean) },
    { title: '开场', items: (plan.greetings ?? []).map((g, i) => [opening(g, i), '']) },
    { title: '开局数值', items: plan.tracking?.enabled ? plan.tracking.variables.map(v => [`- ${v.path}=${short(v.initial, 16)}${v.range ? `（${v.range}）` : ''}`, v.path.split('.').at(-1)]) : [] },
    { title: '配角', items: plan.characters.filter(c => c.kind === 'npc').map(c => [character(c), c.name]) },
    { title: '地点', items: (plan.world?.places ?? []).map(p => [`- ${named(p.name, p.aliases)}${p.description ? `：${short(p.description, 16)}` : ''}`, p.name]) },
    { title: '势力', items: (plan.world?.factions ?? []).map(f => [`- ${f.name}${f.members?.length ? `：成员 ${f.members.join('、')}` : ''}${f.description ? `｜${short(f.description, 16)}` : ''}`, f.name]) },
    { title: '往事', items: (plan.world?.history ?? []).map(h => [`- ${short(h.event, 30)}${h.impact ? ` → ${short(h.impact, 16)}` : ''}`, '']) },
  ].filter(s => s.items.length)
  const whole = sections.map(s => `${s.title}：\n${s.items.map(([line]) => line).join('\n')}`).join('\n')
  if (whole.length <= budget) return whole
  // Too much: in each section, what the card names most first; sections in the order above.
  const text = texts.join('\n')
  const mentions = name => (name ? text.split(name).length - 1 : 0)
  let left = budget
  const kept = []
  const dropped = []
  for (const section of sections) {
    const items = section.items.map((item, at) => ({ line: item[0], score: mentions(item[1]), at })).sort((a, b) => b.score - a.score || a.at - b.at)
    const lines = []
    for (const item of items) {
      const cost = item.line.length + 1 + (lines.length ? 0 : section.title.length + 2)
      if (cost > left) continue
      lines.push(item)
      left -= cost
    }
    if (lines.length) kept.push(`${section.title}：\n${lines.sort((a, b) => a.at - b.at).map(item => item.line).join('\n')}`)
    if (lines.length < items.length) dropped.push(`${section.title} ${items.length - lines.length} 条`)
  }
  return `${kept.join('\n')}\n（方案较大，只列了卡里提得多的部分，省了：${dropped.join('、')}。没列出的照常检查前后是否一致。）`
}

/**
 * @param language - the plan's (planLanguage).
 * @param plan - its facts go along, so the review can hold the card to them; without one, the card is checked against itself.
 */
export function reviewRequest(card, hits, language = DEFAULT_LANGUAGE, plan = null) {
  const targets = reviewTargets(card)
  const blocks = targets.map(t => (t.target.startsWith('开场白') ? `<greeting index="${t.target.slice(3)}">\n${t.text}\n</greeting>` : `<entry name="${t.target}">\n${t.text}\n</entry>`))
  const facts = plan ? planFacts(plan, targets.map(t => t.text)) : ''
  const flagged = hits.length ? `程序先扫出的可疑处（只是候选，你来判断）：\n${hits.slice(0, 40).map(h => `- ${h.target}：${h.label}「${h.excerpt}」`).join('\n')}` : ''
  const content = [facts && `<plan_facts>\n${facts}\n</plan_facts>`, blocks.join('\n\n'), flagged].filter(Boolean).join('\n\n')
  const base = reviewSystem(facts ? REVIEW_FACTS : '')
  const system = language === DEFAULT_LANGUAGE ? base : `${base}\n这些条目和开场白是用${language}写的${facts ? '，<plan_facts> 里的名字和设定也是' : ''}：按${language}的写法挑这些毛病，suggestion 也用${language}写。`
  return { system, messages: [{ role: 'user', content }], maxTokens: TALK_TOKENS, softCap: true }
}

export function readIssues(text) {
  const raw = looseJson(section(text, 'issues') || text)
  return (Array.isArray(raw) ? raw : [])
    .filter(i => i && typeof i === 'object' && clip(i.target, 60))
    .slice(0, 30)
    .map(i => ({ target: clip(i.target, 60).replace(/[「」]/g, ''), type: clip(i.type, 30), original: typeof i.original === 'string' ? i.original.trim().slice(0, 300) : '', suggestion: typeof i.suggestion === 'string' ? i.suggestion.trim().slice(0, 600) : '' }))
}

/**
 * Apply what can be applied in place: an issue whose original text is found,
 * once, gets its suggestion. Returns the issues left for a rewrite, by target.
 */
export function applyIssues(card, issues, language = DEFAULT_LANGUAGE) {
  const left = new Map()
  for (const issue of issues) {
    const greeting = /^开场白(\d+)$/.exec(issue.target)
    const holder = greeting ? card.greetings[Number(greeting[1]) - 1] : card.entries.find(e => squash(e.name) === squash(issue.target))
    if (!holder) continue
    const key = greeting ? 'text' : 'content'
    const at = issue.original ? holder[key].indexOf(issue.original) : -1
    // Found more than once, which one was meant cannot be told (a wrong name said three times,
    // 小雨 inside 林小雨): changing the first could leave the rest or break a right one, so the rewrite takes it.
    if (at >= 0 && holder[key].indexOf(issue.original, at + 1) < 0) {
      // Only the sentence the change is in is looked at for an echo: elsewhere a repeat may be meant.
      const before = holder[key].slice(0, at)
      const after = holder[key].slice(at + issue.original.length)
      const start = Math.max(...['。', '！', '？', '\n'].map(mark => before.lastIndexOf(mark))) + 1
      const end = after.search(/[。！？\n]/) < 0 ? after.length : after.search(/[。！？\n]/)
      const sentence = withoutEcho(before.slice(start) + issue.suggestion + after.slice(0, end))
      holder[key] = chineseText(before.slice(0, start) + sentence + after.slice(end), language)
      continue
    }
    const name = greeting ? issue.target : holder.name
    left.set(name, [...(left.get(name) ?? []), issue])
  }
  return left
}

/**
 * A clause said twice in a row taken back to once: what a suggestion that repeats
 * the text around its original leaves (盯着你的眼睛，盯着你的眼睛，眨眼变少).
 */
export const withoutEcho = text => text.replace(/([^。！？!?\n]{3,}?)[，,]\1(?=[，,。！？!?\n]|$)/g, '$1')

/** Rewrite whole pieces: by review issues, or by the user's note on one piece. */
export function rewriteRequest(plan, card, pieces, references = []) {
  const material = referenceBlock(writingMaterial(references))
  const asked = pieces
    .map(p => {
      const notes = p.issues?.length ? p.issues.map(i => `  - ${i.type ? `${i.type}：` : ''}${i.original ? `「${i.original}」` : ''}${i.suggestion ? ` → ${i.suggestion}` : ''}`).join('\n') : `  - ${p.note}`
      const tag = p.greeting ? `<greeting index="${p.index + 1}">` : `<entry name="${p.name}">`
      return `${tag}\n${p.text}\n${p.greeting ? '</greeting>' : '</entry>'}\n要改的地方：\n${notes}`
    })
    .join('\n\n')
  const others = card.entries.filter(e => e.content && !pieces.some(p => p.name === e.name))
  const content = [
    `<plan>\n${SAMPLE_PLAN(plan)}\n</plan>`,
    writtenBlock(others, 4000),
    `按要求改写下面这些内容，输出改好之后的完整正文：\n\n${asked}`,
    '条目放在 <entry name="条目名"> 和 </entry> 之间，开场白放在 <greeting index="序号"> 和 </greeting> 之间，名字和序号与上面一致；标签外不写别的。',
  ].filter(Boolean).join('\n\n')
  const greetingsOnly = pieces.every(p => p.greeting)
  const language = planLanguage(plan)
  const system = greetingsOnly ? greetingSystem(language) : `${writeSystem(language)}\n开场白另按开场白的写法：头三行抓人，结尾给 <user> 话头，不替 <user> 说话做决定。`
  return { system: system + genderRule(plan) + (material ? WRITE_REFERENCE_RULES : ''), messages: [userMessage(material, content)], maxTokens: LONG_TOKENS, softCap: true }
}

// ─── State tracking, built in code ────────────────────────────────────────

function nested(variables, leaf) {
  const root = {}
  for (const variable of variables) {
    const keys = variable.path.split('.').map(k => k.trim()).filter(Boolean)
    if (!keys.length || !writablePath(keys)) continue
    let at = root
    for (const key of keys.slice(0, -1)) at = at[key] = at[key] && typeof at[key] === 'object' ? at[key] : {}
    at[keys.at(-1)] = leaf(variable)
  }
  return root
}

/** A variable as a card starts it: a list carries MVU's mark, or nothing can be added to it in SillyTavern. */
const startingValue = variable => (variable.type === 'list' ? [...typedValue(variable), LIST_GROWS] : typedValue(variable))

export const initialState = plan => withEventsDone(plan, nested(plan.tracking.variables, startingValue))

/**
 * The state an opening starts from: the defaults with its own values over them,
 * or null when it has none of its own (it starts from [InitVar] as it is).
 */
export function greetingState(plan, greeting) {
  const own = greeting?.state ?? {}
  if (!plan.tracking.enabled || !Object.keys(own).length) return null
  return withEventsDone(plan, nested(plan.tracking.variables, v => startingValue(Object.hasOwn(own, v.path) ? { ...v, initial: own[v.path] } : v)))
}

// ─── Events that happen once ──────────────────────────────────────────────
// A card with variables keeps the events that happened in a list of their names (EVENTS_DONE): an event's entry
// goes out only while its name is not there, and the model adds it in the turn the event comes in. A reminder in
// words alone was not enough to keep one from coming again. Without variables the reminder is all there is.

/** Whether a plan's events are kept to once by the list. */
const marksEvents = plan => Boolean(plan?.tracking?.enabled)

/** The list of events that happened, by a card's language. */
export const eventsDone = language => EVENTS_DONE[englishCard(language) ? 'en' : 'zh']

/** An event as the list keeps it: its entry's name without 事件_. */
export const eventItem = name => String(name ?? '').replace(/^(?:事件_|Event_)/, '')

/**
 * The EJS test that an event has not happened yet: its name, quoted, is nowhere in the list as JSON. That still holds
 * when the list was written back some other way: as one string, or as {"-": name} by an add where no list was
 * (state.mjs now starts a list there, but a chat may hold one from before).
 */
export const notHappened = (language, item) => `!JSON.stringify(getvar(${JSON.stringify(`stat_data.${eventsDone(language)}`)}, { defaults: [] })).includes(${JSON.stringify(JSON.stringify(item))})`

/** The line an event opens with when the list keeps it: the update that puts it there, written out. */
export const onceMarked = (language, item) => ownWords(language).eventOnceMarked(`{ "op": "add", "path": ${JSON.stringify(`/${eventsDone(language)}/-`)}, "value": ${JSON.stringify(item)} }`)

/** A starting state with the list, empty, on a card that has events to keep to once. */
function withEventsDone(plan, state) {
  if (!marksEvents(plan) || !plan.entries?.some(entry => entry.type === '事件')) return state
  return { ...state, [eventsDone(planLanguage(plan))]: [LIST_GROWS] }
}

/**
 * The starting values or the update rules as a draft keeps them, with the list added where the card's events use it
 * and the text has none: a draft written before events were kept by the list still has those two from then (they
 * are filled when writing starts), while its events are wrapped as they are now. Anything else is left as it is.
 */
function withListedEvents(entry, plan) {
  if (entry.part !== 'initvar' && entry.part !== 'rules') return entry
  const done = eventsDone(planLanguage(plan))
  if (!Object.hasOwn(initialState(plan), done)) return entry
  const words = stateWords(plan)
  const path = entry.part === 'rules' ? [words.rulesKey, done] : [done]
  const doc = YAML.parseDocument(entry.content)
  if (doc.errors.length || !YAML.isMap(doc.contents) || doc.hasIn(path) || (path.length > 1 && !YAML.isMap(doc.getIn(path.slice(0, -1))))) return entry
  doc.setIn(path, doc.createNode(entry.part === 'rules' ? { type: 'list', check: [words.eventsDone] } : [LIST_GROWS]))
  return { ...entry, content: doc.toString({ lineWidth: 0 }).trim() }
}

/**
 * An opening as the card keeps it: one with values of its own ends with them as
 * MVU reads them, <UpdateVariable><initvar>, the whole state, which the
 * update-hiding scripts keep out of sight (server/chats.mjs reads it the same way).
 */
function greetingText(plan, card, index) {
  const text = card.greetings[index]?.text ?? ''
  const state = text && greetingState(plan, plan.greetings[index])
  return state ? `${text}\n\n<UpdateVariable>\n<initvar>\n${YAML.stringify(state, { lineWidth: 0 }).trim()}\n</initvar>\n</UpdateVariable>` : text
}

const VARIABLES_ENTRY = '<status_current_variable>\n{{format_message_variable::stat_data}}\n</status_current_variable>'

// The card's own text for its state entries and scripts, in Chinese or English (the plan's language).
const STATE_WORDS = {
  zh: {
    formatLead: '每次回复的最后，写出这一轮变量的变化，格式如下：',
    formatRules: [
      '- 只用三种操作：replace 改已有的值；add 给对象加新键、给数组加新项；remove 删除。',
      '- JSONPatch 里必须是合法的 JSON 数组；这一轮没有变化就写 []。',
      '- 数值按「怎么变」的规则小步变化，只有剧情出现重大转折时才大幅变化。',
    ],
    bookRule: names => `- 册子（${names}）一行一个键：加一行用 add，路径写到这一行的名字；删一行用 remove；改一项用 replace，路径写到那一项。`,
    bookRow: '这一行的名字', rowKey: '每行记',
    rulesKey: '变量更新规则', anyChange: '按剧情更新', readOnly: '只读：故事里不会变，不要写进更新', eventsDone: '事件条目里的事真正写进故事的那一轮，把事件名加进来；加过的不删',
    hideFromModel: '对模型隐藏变量更新', hideFromPlayer: '对玩家隐藏变量更新',
    hidePlaceholder: '对模型隐藏状态栏', statusBar: '状态栏',
    mvuInfo: 'MVU 变量框架：在 SillyTavern 里按回复末尾的变量更新改变量、显示状态栏（需要酒馆助手）。CicaTavern 不运行它，自带同样的功能。',
    with: '与<user>：', colon: '：', separator: '；',
    gender: { female: '女性', male: '男性' },
    creator: '由 CicaTavern「创作角色卡」生成。',
    playerName: name => `主角名：${name}。在 CicaTavern 里用这张卡开的对话会自动用这个名字；在 SillyTavern 里，把用户名（Persona）设成「${name}」。`,
    ejsInfo: '这张卡用了 EJS（随数值分阶段的性格、到了某个程度才触发或只发生一次的事件）：在 SillyTavern 里需要装「提示词模板」扩展（ST-Prompt-Template），否则这几条会原样发出去。CicaTavern 自带，不用装。',
  },
  en: {
    formatLead: 'At the end of every reply, write how the variables changed this turn, like this:',
    formatRules: [
      '- Use only three operations: replace changes an existing value; add adds a key to an object or an item to an array; remove deletes.',
      '- The JSONPatch must be a valid JSON array; with no change this turn, write [].',
      '- Numbers move in small steps by their check; only a major turn in the story moves them far.',
    ],
    bookRule: names => `- Books (${names}) keep a key per row: add a row with add, its path ending in the row's name; take one out with remove; change one item with replace, its path ending in that item.`,
    bookRow: 'name of the row', rowKey: 'each row keeps',
    rulesKey: 'Variable update rules', anyChange: 'changes with the story', readOnly: 'read-only: the story never changes it; never write it in an update', eventsDone: "add an event entry's name in the turn the story really shows it; never take one out",
    hideFromModel: 'Hide variable updates from the model', hideFromPlayer: 'Hide variable updates from the player',
    hidePlaceholder: 'Hide the status bar from the model', statusBar: 'Status bar', english: true,
    mvuInfo: 'MVU variable framework: in SillyTavern it applies the variable updates at the end of each reply and shows the status bar (needs Tavern Helper). CicaTavern does not run it; it has the same built in.',
    with: 'with <user>: ', colon: ': ', separator: '; ',
    gender: { female: 'female', male: 'male' },
    creator: "Made with CicaTavern's card creator.",
    playerName: name => `The player's name: ${name}. Chats on this card in CicaTavern use it; in SillyTavern, set your persona's name to "${name}".`,
    ejsInfo: 'This card uses EJS (a personality in stages by a tracked value, events that wait for a value or happen once): SillyTavern needs the ST-Prompt-Template extension for them, or those entries go out as written. CicaTavern runs them itself.',
  },
}
const stateWords = plan => STATE_WORDS[englishCard(planLanguage(plan)) ? 'en' : 'zh']

function formatEntry(plan) {
  const words = stateWords(plan)
  // What the example changes is something that may change.
  const open = plan.tracking.variables.filter(v => !v.locked)
  const example = open.find(v => v.type === 'number') ?? open.find(v => v.type !== 'book')
  const books = plan.tracking.variables.filter(v => v.type === 'book')
  const change = example && `{ "op": "replace", "path": "/${example.path.split('.').join('/')}", "value": ${example.type === 'number' ? typedValue(example) + 2 : JSON.stringify(typedValue(example))} }`
  const added = books[0] && `{ "op": "add", "path": "/${books[0].path.split('.').join('/')}/${words.bookRow}", "value": ${JSON.stringify(Object.fromEntries(books[0].columns.map(column => [column, '…'])))} }`
  return [
    '<update_variable_rules>',
    words.formatLead,
    '<UpdateVariable>',
    '<Analysis>(in English, no more than 80 words) go through each variable by its check, based only on this reply; for numbers write old + change = new</Analysis>',
    '<JSONPatch>',
    `[${[change, added].filter(Boolean).join(', ')}]`,
    '</JSONPatch>',
    '</UpdateVariable>',
    ...words.formatRules,
    ...(books.length ? [words.bookRule(books.map(v => v.label || v.path).join(words.separator))] : []),
    '</update_variable_rules>',
  ].join('\n')
}

function rulesEntry(plan) {
  const words = stateWords(plan)
  const rule = variable => {
    // 只读: said in place of how it changes, and kept by the app whatever a reply writes (cardJson's read_only).
    if (variable.locked) return words.readOnly
    const out = {}
    if (variable.type !== 'string') out.type = variable.type
    if (variable.type === 'book') out[words.rowKey] = variable.columns
    if (variable.range) out.range = variable.range
    if (variable.check) out.check = [variable.check]
    return Object.keys(out).length ? out : words.anyChange
  }
  const done = eventsDone(planLanguage(plan))
  const events = Object.hasOwn(initialState(plan), done) ? { [done]: { type: 'list', check: [words.eventsDone] } } : {}
  return YAML.stringify({ [words.rulesKey]: { ...nested(plan.tracking.variables, rule), ...events } }, { lineWidth: 0 }).trim()
}

/** The four state entries' text, filled in when writing starts. */
export function stateContent(entry, plan) {
  if (entry.part === 'initvar') return YAML.stringify(initialState(plan), { lineWidth: 0 }).trim()
  if (entry.part === 'variables') return VARIABLES_ENTRY
  if (entry.part === 'rules') return rulesEntry(plan)
  if (entry.part === 'format') return formatEntry(plan)
  return chineseText(brickContent(entry.part, plan, englishCard(planLanguage(plan)), playerRoot(planLanguage(plan))), planLanguage(plan))
}

// ─── The steps ────────────────────────────────────────────────────────────

const WORLD_TYPES = new Set(['世界观', '扮演准则', '时间线', '地理'])
// A bigger card goes out in batches: too much at once and an answer gets cut off, or comes back with half of it.
const BATCH = 8

/** Steps for a run of entries: one, or a batch at a time for a card of a bigger scale. */
function batched(plan, id, label, entries) {
  if (!entries.length) return []
  if (!plan.scale || entries.length <= BATCH) return [{ id, label, names: entries.map(e => e.name) }]
  const count = Math.ceil(entries.length / BATCH)
  return Array.from({ length: count }, (_, i) => ({ id: `${id}:${i + 1}`, label: msg`${label}（${i + 1}/${count}）`, names: entries.slice(i * BATCH, (i + 1) * BATCH).map(e => e.name) }))
}

/** The writing steps for a card, each with the entries or openings it fills. */
export function writeSteps(plan, card) {
  const steps = []
  const world = card.entries.filter(e => WORLD_TYPES.has(e.type))
  steps.push(...batched(plan, 'world', msg`世界观、规则和地点`, world))
  for (const c of plan.characters.filter(c => c.kind === 'core')) {
    const own = card.entries.filter(e => e.type === '角色' && e.owner === c.name)
    if (own.length) steps.push({ id: `character:${c.name}`, label: msg`${c.name}的档案与性格`, names: own.map(e => e.name) })
  }
  const rest = card.entries.filter(e => e.type === 'NPC' || e.part === 'catalog')
  steps.push(...batched(plan, 'cast', msg`配角`, rest))
  const events = card.entries.filter(e => e.type === '事件')
  steps.push(...batched(plan, 'events', msg`事件`, events))
  steps.push({ id: 'greetings', label: msg`开场白`, greetings: true })
  steps.push({ id: 'review', label: msg`检查套话和前后矛盾` })
  steps.push({ id: 'fix', label: msg`按检查结果修改` })
  return steps
}

/** Whether a step has nothing left to do. */
export function stepDone(step, card) {
  if (step.names) return step.names.every(name => card.entries.find(e => e.name === name)?.content)
  if (step.greetings) return card.greetings.every(g => g.text)
  if (step.id === 'review') return card.reviewed === true
  if (step.id === 'fix') return card.fixed === true
  return true
}

/** A card to write from a plan: the plan's entries (state ones filled), its openings empty. */
export function newCard(plan) {
  return {
    entries: plan.entries.map(entry => ({ ...entry, content: entry.type === '状态' ? stateContent(entry, plan) : '' })),
    greetings: plan.greetings.map(g => ({ title: g.title, text: '' })),
    description: describe(plan),
    // Part of the card, so in the card's language.
    creatorNotes: [plan.summary, stateWords(plan).creator].filter(Boolean).join('\n\n'),
    checks: [],
    reviewed: false,
    fixed: false,
    pending: {},
    avatar: null,
    savedCardId: null,
  }
}

/**
 * A card kept from an earlier plan, in line with the plan as it is now (接着写
 * after the plan was revised): the plan's entries and openings, each keeping
 * what was written for it (an entry by name, an opening by place), the ones the
 * plan no longer has gone, the state entries made again. With anything added or
 * gone, the check runs again.
 */
export function alignCard(card, plan) {
  const written = new Map(card.entries.filter(e => e.type !== '状态').map(e => [e.name, e.content]))
  const entries = plan.entries.map(entry => ({ ...entry, content: entry.type === '状态' ? stateContent(entry, plan) : written.get(entry.name) ?? '' }))
  const greetings = plan.greetings.map((g, i) => ({ title: g.title, text: card.greetings[i]?.text ?? '' }))
  const kept = list => list.filter(e => e.type !== '状态').map(e => e.name).sort().join('\n')
  const same = kept(entries) === kept(card.entries) && greetings.length === card.greetings.length
  return { ...card, entries, greetings, ...(same ? {} : { reviewed: false, fixed: false, pending: {}, checks: [] }) }
}

/**
 * A written card after the plan's variables were edited: its state entries made
 * again from the plan (they are built in code), everything else kept.
 */
export function retrack(card, plan) {
  const state = plan.entries.filter(entry => entry.type === '状态').map(entry => ({ ...entry, content: stateContent(entry, plan) }))
  return { ...card, entries: [...card.entries.filter(entry => entry.type !== '状态'), ...state] }
}

/** A short card description for the character definition: who is who, three lines at most. */
function describe(plan) {
  const words = stateWords(plan)
  const lines = plan.characters
    .filter(c => c.kind === 'core')
    .slice(0, 2)
    .map(c => `${c.name}${words.colon}${[c.identity, c.relationship && `${words.with}${c.relationship}`].filter(Boolean).join(words.separator)}`)
  const player = playerLine(plan)
  if (player) lines.push(player)
  return lines.slice(0, 3).join('\n')
}

/** The description's line for <user>: the gender up front, for the model playing the card as much as for the ones writing it. */
function playerLine(plan, identity = plan.user_role.identity) {
  const words = stateWords(plan)
  const player = [words.gender[plan.user_role.gender], identity].filter(Boolean)
  return player.length ? `<user>${words.colon}${player.join(words.separator)}` : ''
}

/**
 * What a description line the code wrote for <user> says after the gender, or null for any other line. Found
 * by its form, not by the whole line: the card may have been written from an earlier plan (revised since, or
 * another of three versions) with another identity, and the description is not rewritten for that.
 */
function playerRest(line, plan) {
  const words = stateWords(plan)
  const head = `<user>${words.colon}`
  if (!line.startsWith(head)) return null
  const rest = line.slice(head.length)
  for (const gender of Object.values(words.gender)) {
    if (rest === gender) return ''
    if (rest.startsWith(gender + words.separator)) return rest.slice(gender.length + words.separator.length)
  }
  // No gender up front: the code wrote it so only when the plan had none.
  return plan.user_role.gender ? null : rest
}

/**
 * A written card after the player's gender changed on the plan: the description is built in code and written
 * nowhere else, so its <user> line gets the new gender, the identity as the card has it. A description edited
 * by hand keeps the rest, and keeps a <user> line whose gender up front was taken out by hand.
 */
export function redescribe(card, before, plan) {
  if (playerLine(before) === playerLine(plan)) return card
  if (card.description === describe(before)) return { ...card, description: describe(plan) }
  const lines = card.description.split('\n')
  const at = lines.findIndex(line => playerRest(line, before) !== null)
  if (at < 0) return card
  const now = playerLine(plan, playerRest(lines[at], before))
  if (now === lines[at]) return card
  // Not with() or toSpliced(): the phone's Node 18 has neither.
  const changed = lines.map((line, i) => (i === at ? now : line)).filter((line, i) => i !== at || now)
  return { ...card, description: changed.join('\n') }
}

// ─── The card ─────────────────────────────────────────────────────────────

const WRAP = {
  世界观: () => ['<world_setting>', '</world_setting>'],
  扮演准则: () => ['<roleplay_rules>', '</roleplay_rules>'],
  时间线: () => ['<history>', '</history>'],
  地理: e => (e.part === 'faction' ? [`<faction name="${e.name}">`, '</faction>'] : [`<place name="${e.name}">`, '</place>']),
  NPC: e => [`<npc name="${e.name}">`, '</npc>'],
  事件: e => [`<event name="${e.name}">`, '</event>'],
  角色: e => {
    if (e.part === 'catalog') return ['<character_catalog>', '</character_catalog>']
    const tag = e.rephrase ? 'character_notes' : { basic: 'character_basic', personality: 'character_palette', facets: 'character_facets' }[e.part] ?? 'character'
    return [`<${tag} character="${e.owner}">`, `</${tag}>`]
  },
}

// ─── EJS, built in code ───────────────────────────────────────────────────
// Stages and event conditions read the tracked values with getvar, as
// ST-Prompt-Template has it (and server/template.mjs runs it): the path under
// stat_data, a default so a value not there yet reads as its starting one.

const readVariable = variable => `getvar(${JSON.stringify(`stat_data.${variable.path}`)}, { defaults: ${JSON.stringify(typedValue(variable))} })`

/** An event's condition as a JS expression. */
export function conditionExpression(condition) {
  const { variable, op, value } = condition
  const read = readVariable(variable)
  if (op === 'has') return variable.type === 'book' ? `(${JSON.stringify(value)} in ${read})` : `${read}.includes(${JSON.stringify(value)})`
  return `${read} ${{ '==': '===', '!=': '!==' }[op] ?? op} ${JSON.stringify(conditionValue(condition))}`
}

/**
 * A staged entry's text with its 【阶段：…】 parts under EJS conditions: the part
 * before the first mark always, each stage's only while the value is in its
 * range. Parts are matched to stages by name, else in order. Without marks, or
 * when the stages no longer hold up, the text as it is (marks taken out).
 */
export function stagedText(text, plan, owner) {
  const staged = stagesOf(plan, plan.characters.find(c => c.name === owner))
  const lines = String(text ?? '').split('\n')
  const parts = []
  let common = []
  for (const line of lines) {
    const mark = STAGE_MARK.exec(line)
    if (mark) parts.push({ name: mark[1].trim(), lines: [] })
    else (parts.at(-1)?.lines ?? common).push(line)
  }
  const body = part => part.lines.join('\n').trim()
  if (!staged || !parts.length) return [common.join('\n').trim(), ...parts.map(body)].filter(Boolean).join('\n\n')
  const read = readVariable(staged.variable)
  const used = new Set()
  const branches = staged.stages.map((stage, i) => {
    const part = parts.find(p => p.name === stage.name && !used.has(p)) ?? parts.find((p, j) => j === i && !used.has(p))
    if (part) used.add(part)
    return { stage, text: part ? body(part) : '' }
  })
  const out = []
  if (common.join('').trim()) out.push(common.join('\n').trim(), '')
  branches.forEach(({ stage, text: part }, i) => {
    const test = stage.below === null ? null : `${read} < ${stage.below}`
    out.push(i === 0 ? `<%_ if (${test}) { _%>` : test ? `<%_ } else if (${test}) { _%>` : '<%_ } else { _%>', part)
  })
  out.push('<%_ } _%>')
  return out.join('\n')
}

/**
 * An entry's text in the card: wrapped in a tag naming what it is (state entries
 * as they are). A staged entry's stages go under EJS; an event with a condition
 * on a tracked value gets it as `@@if`, which has to be the first line.
 */
export function wrapped(entry, plan = null) {
  let content = entry.staged && plan ? stagedText(entry.content, plan, entry.owner) : entry.content.trim()
  const event = entry.type === '事件' && plan
  const once = event && marksEvents(plan)
  const language = planLanguage(plan)
  // An event stays in while its condition holds and, with variables, until it is on the list of what happened.
  if (event) content = `${once ? onceMarked(language, eventItem(entry.name)) : ownWords(language).eventOnce}\n${content}`
  const wrap = WRAP[entry.type]?.(entry)
  const text = wrap ? `${wrap[0]}\n${content}\n${wrap[1]}` : content
  const tests = [
    ...((event ? eventConditions(plan, plan.events?.[entry.event]) : null) ?? []).map(conditionExpression),
    ...(once ? [notHappened(language, eventItem(entry.name))] : []),
  ]
  return tests.length ? `@@if ${tests.join(' && ')}\n${text}` : text
}

/**
 * 数值预览: what the card gives the model at some values, for the polish page's sliders.
 * The staged and the conditional entries are rendered as SillyTavern would render
 * them (`render`: template.mjs renderTemplate), so the page shows what the model reads.
 * @param values - path → value (as typed in, a string or a number); the rest at their starting values.
 * @returns {{ characters: { name, stage, main, accent }[], events: { name, on, keywords }[], entries: { name, text }[] }}
 */
export function previewDynamics(plan, card, values, render) {
  const own = values && typeof values === 'object' ? values : {}
  const variables = plan.tracking.enabled ? plan.tracking.variables : []
  const state = nested(variables, v => typedValue(Object.hasOwn(own, v.path) ? { ...v, initial: String(own[v.path]) } : v))
  const shown = entry => render(wrapped(entry, plan), { variables: { stat_data: state } }).text.trim()
  const read = variable => typedValue(Object.hasOwn(own, variable.path) ? { ...variable, initial: String(own[variable.path]) } : variable)
  const characters = plan.characters.flatMap(c => {
    const staged = stagesOf(plan, c)
    if (!staged) return []
    const value = read(staged.variable)
    const stage = staged.stages.find(s => s.below === null || value < s.below)
    return [{ name: c.name, stage: stage.name, main: stage.main ?? [], accent: stage.accent ?? [] }]
  })
  const events = card.entries
    .filter(entry => entry.type === '事件')
    .map(entry => ({ name: plan.events?.[entry.event]?.name ?? entry.name, keywords: entry.keywords ?? [], conditional: Boolean(eventConditions(plan, plan.events?.[entry.event])), on: Boolean(entry.content) && shown(entry) !== '' }))
  const entries = card.entries.filter(entry => entry.staged && entry.content).map(entry => ({ name: entry.name, text: shown(entry) }))
  return { characters, events, entries }
}

/** Whether the card's entries use EJS (stages, conditions): SillyTavern needs ST-Prompt-Template for them. */
export const usesEjs = (plan, card) => card.entries.some(entry => /<%|^@@if /m.test(wrapped(entry, plan)))

// Variable updates: kept out of what the model reads back (it gets the current
// values each turn) and out of what the player sees.
const UPDATE_BLOCK = '/<(update(?:variable)?)>[\\s\\S]*?<\\/\\1>/gi'
const regexScript = (name, options) => ({ id: name, scriptName: name, findRegex: UPDATE_BLOCK, replaceString: '', trimStrings: [], placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null, ...options })

/** 战斗与成长 as the card carries it: rules at full, from the first turn. */
const planRulebook = game => cleanRulebook({ level: 'full', ...kitBook(game), ...kitWorld(game) })

/**
 * The finished card as SillyTavern's V3 JSON.
 * @param options.author - the player's name in settings (你的角色): the card's author is it + CicaTavern; the
 *   default name (你) is no one's, and leaves CicaTavern alone.
 * @param options.credits - cards whose content this one uses, [{ title, author }]: the player answers for it, so the
 *   card is theirs alone, and its notes end by saying where it came from.
 */
export function cardJson(plan, card, { author = '', credits = [] } = {}) {
  const entries = [...card.entries].sort((a, b) => a.order - b.order).map((entry, i) => toBookEntry({ ...entry, content: wrapped(withListedEvents(entry, plan), plan) }, i))
  const greetings = card.greetings.map((_, i) => greetingText(plan, card, i)).filter(Boolean)
  const words = stateWords(plan)
  const status = statusSpecOf(plan)
  // A name of the card's own for the player (创作角色卡 asked); none = the one in settings.
  const userName = plan.user_role.name ?? ''
  const readOnly = plan.tracking.enabled ? plan.tracking.variables.filter(v => v.locked).map(v => v.path) : []
  // 开场页 (方案页 → 门面): drawn by the app above the opening; another app does not show it.
  const cover = cleanCover(plan.cover)
  const own = { ...(status ? { status_bar: status } : {}), ...(cover ? { cover } : {}), ...(userName ? { user_name: userName } : {}), ...(readOnly.length ? { read_only: readOnly } : {}), ...(plan.game ? { game: planRulebook(plan.game) } : {}) }
  const scripts = plan.tracking.enabled ? [regexScript(words.hideFromModel, { promptOnly: true }), regexScript(words.hideFromPlayer, { markdownOnly: true })] : []
  scripts.push(...brickScripts(plan, englishCard(planLanguage(plan))))
  if (status) scripts.push(...statusScripts(status, words))
  // 建角页: the card opens on the form; the written openings stay, for a start without it.
  const form = creationReady(plan) ? creationOpening(plan.creation, englishCard(planLanguage(plan))) : null
  const data = {
    name: plan.name,
    description: card.description,
    personality: '',
    scenario: '',
    first_mes: form ?? greetings[0] ?? '',
    mes_example: '',
    creator_notes: [credits.length ? card.creatorNotes.replace(words.creator, '').trim() : card.creatorNotes, userName && words.playerName(userName), usesEjs(plan, card) && words.ejsInfo, credits.length && creditText(credits, englishCard(planLanguage(plan)))].filter(Boolean).join('\n\n'),
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: form ? greetings : greetings.slice(1),
    tags: credits.length ? [] : ['CicaTavern'],
    creator: credits.length ? (author === '你' ? '' : author) : author && author !== '你' ? `${author} + CicaTavern` : 'CicaTavern', // i18n-ignore: the default name as saved
    character_version: '1.0',
    extensions: {
      talkativeness: '0.5',
      fav: false,
      world: plan.name,
      depth_prompt: { prompt: '', depth: 4, role: 'system' },
      regex_scripts: scripts,
      // SillyTavern needs MVU (a Tavern Helper script) to apply the updates and show the bar.
      ...(plan.tracking.enabled ? { tavern_helper: mvuHelper(words) } : {}),
      ...(Object.keys(own).length ? { cicatavern: own } : {}),
    },
    character_book: { name: plan.name, entries },
  }
  return { spec: 'chara_card_v3', spec_version: '3.0', data }
}
