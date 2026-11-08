// 游戏规则: a card's rule book, cards/<id>/game.json. How far the rules go and how the player starts
// (web/shared/game/sheet.js); every chat with the card shares it. Off until the player turns it on.
// And what a turn tells the model of them: never the frozen prefix, so turning them on or off costs no
// cache. Each turn's message stays in the history as sent, so the rules go only when the turns the
// model will read no longer hold a copy, and the sheet only when it has changed.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { imageKind } from './appearance.mjs'
import { replyMarks } from '../web/shared/game/marks.js'
import { AID_BONUS, ATTRIBUTES, ATTRIBUTE_POINTS, AVERAGE, DEFAULT_WORDS, EFFECTS, STRENGTHS, WORD_KEYS, applyOps, attributeNames, cleanKit, cleanRulebook, fieldedOf, keptSheet, kitBook, rulesOn, sanityWord, settleReply, sheetOf, sheetOnPath, wordFor } from '../web/shared/game/sheet.js'
import { SKILLS } from '../web/shared/game/battle.js'
import { BINDABLE, fitsField } from '../web/shared/game/bindings.js'
import { randomFrom, seedOf } from '../web/shared/game/dice.js'
import { stateTime, storyDay } from '../web/shared/vn.js'
import { httpError, readJsonFile, writeJson } from './store.mjs'
import { msg } from './i18n.mjs'

const RULES_EVERY = 8
// Turns without a fight before the next set of choices must offer one, by the card's 战斗频率.
const FIGHT_EVERY = { rare: 8, normal: 4, often: 2 }
const FIGHT_REMINDER = {
  rare: '只在剧情确实需要时放行尾带 【战斗|…】 的选项；',
  normal: '有敌人或冲突时放一个行尾带 【战斗|…】 的选项；',
  often: '这个故事打斗多，多制造冲突，放一个行尾带 【战斗|…】 的选项；',
}
const MAX_FOES_TOLD = 12
const CARD_READ = 6000
const LORE_READ = 2000
const THEMES = ['plain', 'wuxia', 'xianxia', 'fantasy', 'modern', 'scifi', 'horror', 'monster', 'netgame', 'apocalypse', 'daily']
// What each is, for the helper: it picks the nearest, and the card's own words go in `words`.
const THEME_WORDS = '通用、武侠、修仙、奇幻、现代、科幻、克苏鲁或恐怖、怪兽养成（宠物、数码兽、契约兽这类伙伴替你打、会进化）、网游或系统流、末日求生、日常（几乎不打架）'
const FOE_PICTURE = /^[\w-]{1,64}\.(png|jpg|webp)$/
const PICTURE_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
const MAX_PICTURE = 12 * 1024 * 1024
const RULES_OPEN = '<游戏规则>'
const SHEET_LINE = /<游戏状态>[\s\S]*?<\/游戏状态>/g
const FIGHT_WORDS = /战斗|开战|开打|打起来|动手|迎战|应战|决一死战/
// Words that may be a blow and may be something else: the model is asked to tell which. No 砍 or 劈 alone: firewood.
const BLOW_WORDS = /[杀斩捅揍宰]|一[剑刀拳掌脚枪箭]|[砍劈刺砸撞轰]向|[砍劈刺砸撞轰]过去|[砍劈刺]了|轰[它他她]|打死|打倒|打晕|打爆|攻击|袭击|偷袭|出手|拔刀|拔剑|拔枪|开枪|开火|了一枪|扣动扳机|扣下扳机|射击|射杀|放箭|射箭|施放|施法|咏唱|念咒|挥动|挥舞|冲上去|冲向|挑战|挑衅|单挑|决斗/
// The rule that says so: a copy from before it was there has to be sent again.
const OWN_ACTIONS = '自己写的行动'
// How life reads in the story, from the most to the least of it.
const LIFE_WORDS = [[0.8, '状态好'], [0.5, '带伤'], [0.25, '伤得不轻'], [0, '快撑不住了']]
// Where a card's lore says how strong people are: read first, it may be far down the book.
const RANK_LORE = /境界|等级|段位|军衔|阶位|位阶/
const MID_RANK = 0.5
const TIER_RESULT = {
  crit: '大成功，超出预期',
  success: '成功',
  close: '险胜：做到了，但付出代价',
  fail: '失败：没做到，局面变了',
}
const TIER_PAYOFF = {
  crit: '这是玩家冒险换来的，给一个远超预期的好处，得到东西就记下来。',
  success: '这是玩家冒险换来的，给一个稳妥做法拿不到的实际好处（线索、物品、先手、信任），得到东西就记下来。',
  close: '写出实实在在的代价。',
  fail: '写出实际的损失：受伤、丢东西，或者局面变糟。伤到会拖累后面的行动就写 【异常】。',
}
const FIGHTS_TOLD = '战斗选项'
// What the model is told of the party, and how a copy of the rules from before there was one is told apart.
const PARTY_TOLD = '【同伴|加入|'
const PARTY_RULE = `- 和玩家同行、会一起打架的角色组成队伍。有人入队写 ${PARTY_TOLD}名字】，离队写 【同伴|离开|名字】，在故事里受了重伤暂时不能上场写 【同伴|负伤|名字】，养好了写 【同伴|归队|名字】；同伴学到新本事写 【学会|名字|同伴名】。战斗时队伍里的人跟玩家一起上场，由应用决定，不用写谁上场。`
const FIGHT_RULES = [
  '- 战斗有两种进入方式，都写 【战斗|敌人×数量:档位】，比如 【战斗|灰狼×2:杂兵|狼王:精英】。档位：杂兵、普通、精英、首领，最多四个敌人。怎么打、谁赢由应用决定，不要写打斗的结果。',
  '  1. 选项：有敌人、对峙、拦路，或者气氛紧张到能动手时，在行动选项里放一个战斗选项，行尾加这个标记，比如 C. 拔刀迎战【战斗|灰狼×2:杂兵】。这种不用结束回复，玩家选了才开打。',
  '  2. 强制：敌人先动手、玩家躲不掉，或者玩家这一轮明确要动手时，先写一两句开打的场面，再写这个标记，然后结束回复，标记后面什么都不写。',
]
const AS_THE_STORY_HAS_IT = '按它在故事里的实力写，不要为了让玩家打得过就压低：打不过的敌人也可以出现，玩家可以逃或者想别的办法。'

/** How a foe's strength is written: by the card's ranks, or a word beside the player. */
function strengthRule(ranks) {
  if (ranks.length) return `- 这个世界的等级从低到高是：${ranks.join('、')}。敌人的等级写在档位后面，比如 【战斗|黑衣头目:精英:${ranks[Math.floor(ranks.length * MID_RANK)]}】。${AS_THE_STORY_HAS_IT}`
  return `- 敌人明显比玩家强或弱时，在档位后面写强弱，比如 【战斗|黑衣头目:精英:远强】，从远弱、稍弱、相当、稍强、强、远强里选，不写算相当。${AS_THE_STORY_HAS_IT}`
}

/** What a story that counts 理智 asks: the marks, unless the card keeps it in a variable of its own. */
function sanityRule(bound) {
  const marks = bound.includes('sanity') ? '' : '玩家目睹超出常理的恐怖、读到禁忌的知识、直面不可名状之物时写 【理智|轻】（轻、中、重），真正平复下来写 【理智|回复|轻】。'
  return `- 这个故事有理智。${marks}理智动摇时把幻觉和不可靠的感知写进故事；玩家有「疯狂」异常时写他失控的言行。`
}

/** The attributes as this card calls them, in a line: what the rules tell the model, and how a copy of them from before a rename is told apart. */
const attributesLine = words => `属性：${ATTRIBUTES.map(item => wordFor({ words }, item.id)).join('、')}`

function rulesBlock(pausing, bound, fights, foes, ranks, sanity, party, words = {}) {
  const grace = wordFor({ words }, 'grace')
  const mind = wordFor({ words }, 'mind')
  const stop = pausing
    ? ['- 玩家的行动结果不确定、失败有后果时才要检定：写到 【检定|属性|DC数字】 就结束回复，标记后面什么都不写，包括状态和选项；这一条的变量更新留到下一条一起写。']
    : []
  return [
    RULES_OPEN,
    '这个故事带规则，数值由应用计算，你只写故事。',
    ...stop,
    ...(fights ? [...FIGHT_RULES, strengthRule(ranks)] : []),
    ...(fights && foes.length ? [`- 这个世界常见的敌人：${foes.slice(0, MAX_FOES_TOLD).join('、')}。`] : []),
    ...(fights && party ? [PARTY_RULE] : []),
    `- 行动选项：每组挑 1 到 2 个有风险的，在那一行末尾加 【检定|属性|DC数字】，比如 B. 翻过断崖【检定|${grace}|DC12】。这种不用结束回复，其余的不加，不要每个都加。`,
    `- 检定可以带上物品，写背包里的名字：帮得上忙的写在后面，比如 B. 用绳索翻过断崖【检定|${grace}|DC12|绳索】，有它加 ${AID_BONUS} 点；非它不可的写需要，比如 【检定|${mind}|DC12|需要:铜钥匙】，没有就做不到。`,
    '- 带检定的选项是冒险：成功要比不带检定的明显拿到更多（线索、物品、先手、信任），失败要付出代价。不带检定的一定做得到，但只推进一小步，没有额外好处。写选项时让这个差别看得出来。',
    `- ${attributesLine(words)}。DC：8 容易，12 一般，16 困难，20 极难。`,
    `- ${OWN_ACTIONS}：玩家可以不选选项，自己写。他用到游戏状态里没有的东西（打火、纸笔这类随身小物不算），或者要做超出本事的事（一句话秒杀强敌、凭空得到宝物、跳过过程直接成功），不要照做：写他摸了个空或者没成，局面照样往前走，再在行动选项里给能走的路。合理的行动照常写。`,
    '- 贵重的东西（稀有的装备、秘传的本事、大笔钱财）不白给：要经过检定、战斗，或者付出代价才能得到。',
    '- 这些规则里的例子只是格式，名字换成这个故事里的东西。',
    '- 游戏状态是写给你看的：故事里不写这些数字，角色也不知道玩家的数值和背包里有什么，除非亲眼看见。玩家伤重时把伤势写进动作里。',
    ...(sanity ? [sanityRule(bound)] : []),
    `- ${marksLine(bound, ranks, grace)}。这些标记玩家看不到。`,
    '- 收到 <本轮操作> 时，那些变化已经算过了，不用再写标记。',
    `- 收到 <检定结果>${fights ? ' 或 <战斗结果>' : ''} 时按它写，不要改写成败。失败也要让故事往前走：受伤、暴露、错过机会，不要写成什么都没发生。`,
    '</游戏规则>',
  ].join('\n')
}

/** The marks the model is asked for: a field the card keeps itself has its own rules. */
function marksLine(bound, ranks, grace = wordFor({}, 'grace')) {
  return [
    bound.includes('things') ? '' : '玩家得到或失去东西时写 【获得|物品×数量】 【失去|物品×数量】，玩家自己写了用掉东西时也用 【失去】 记下',
    bound.includes('quests') ? '' : '玩家答应别人的事、接下的委托都算任务，用 【任务|新|标题|一句话】 【任务|完成|标题】 【任务|失败|标题】',
    bound.includes('life') ? '' : '故事里受伤或恢复用 【受伤|轻】 【恢复|轻】（轻、中、重）',
    '学到新本事用 【学会|名字】',
    `玩家受了会拖累后面行动的伤或异常时写 【异常|名字|属性|轻】（轻、中、重），比如 【异常|扭伤左脚|${grace}|中】，影响所有行动就不写属性；好了写 【异常|解除|名字】`,
    ranks.length && !bound.includes('level') && !bound.includes('rank') ? '玩家在故事里确实升到更高的等级时写 【晋升|等级】，一次只升一阶，不要随便给' : '',
  ].filter(Boolean).join('；')
}

/** What is holding the player back, for the model, in the card's words: 扭伤左脚（灵巧，还有 3 天）. */
function ailsLine(sheet, words = {}) {
  const statName = id => (ATTRIBUTES.some(item => item.id === id) ? wordFor({ words }, id) : '所有行动')
  return (sheet.conditions ?? []).map(item => `${item.name}（${statName(item.stat)}，还有 ${item.days} 天）`).join('、')
}

/** The party, for the model: who fights beside the player, and who is with them but not in it. */
function partyLine(sheet, words) {
  const fielded = fieldedOf(sheet)
  return (sheet.party ?? []).map(member => {
    if (member.hurt) return `${member.name}（负伤）`
    if (!fielded.includes(member)) return `${member.name}（待命）`
    return `${member.name}（${wordFor({ words }, 'life')} ${member.life}/${member.maxLife}）`
  }).join('、')
}

function sheetLine(sheet, rank, words = {}) {
  const things = sheet.things.map(thing => (thing.count > 1 ? `${thing.name}×${thing.count}` : thing.name)).join('、')
  const party = partyLine(sheet, words)
  const quests = sheet.quests.filter(quest => quest.status === 'new').map(quest => quest.title).join('、')
  const ails = ailsLine(sheet, words)
  const parts = [
    `${wordFor({ words }, 'life')} ${sheet.life}/${sheet.maxLife}（${LIFE_WORDS.find(([share]) => sheet.life >= sheet.maxLife * share)[1]}）`,
    sheet.sanity === undefined ? '' : `理智 ${sheet.sanity}/${sheet.maxSanity}（${sanityWord(sheet)}）`,
    rank ? `等级：${rank}` : '',
    ATTRIBUTES.map(item => `${wordFor({ words }, item.id)} ${sheet.attributes[item.id]}`).join('、'),
    ails ? `异常：${ails}` : '',
    things ? `物品：${things}` : '',
    party ? `${wordFor({ words }, 'party')}：${party}` : '',
    quests ? `进行中的任务：${quests}` : '',
  ]
  return `<游戏状态>${parts.filter(Boolean).join('；')}</游戏状态>`
}

function checkBlock(result) {
  const sign = result.modifier < 0 ? '−' : '+'
  const bag = result.lacks ? `，缺${result.lacks}，做不到` : result.aid ? `，用上了${result.aid.name}` : ''
  return `<检定结果>\n${result.stat || '这次'}检定（DC${result.dc}）：掷出 ${result.roll}，修正 ${sign}${Math.abs(result.modifier)}，合计 ${result.total}${bag}，${TIER_RESULT[result.tier]}。按这个结果写下去，${TIER_PAYOFF[result.tier]}\n</检定结果>`
}

const BATTLE_ENDS = {
  won: '胜利',
  fled: '玩家逃脱了',
  // 生命 goes in the card's word for it (battleBlock).
  lost: '战败，玩家没有死，生命只剩一点',
}

function battleBlock(battle, words = {}) {
  const life = wordFor({ words }, 'life')
  if (battle.over === 'story') return `<战斗结果>\n玩家不走战斗（${battle.foes}），这一段由你按剧情写，怎么收场你决定。\n</战斗结果>`
  const used = Object.entries(battle.used).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join('、')
  const lines = [
    `${BATTLE_ENDS[battle.over].replace('生命', life)}，${battle.rounds} 回合。敌人：${battle.foes}${battle.downed ? `，击败了 ${battle.downed}` : ''}。`,
    `玩家：${life} ${battle.life}/${battle.maxLife}${used ? `，用掉 ${used}` : ''}${battle.skills.length ? `，用过 ${battle.skills.join('、')}` : ''}。`,
    battle.party?.length ? `同伴：${battle.party.map(member => `${member.name} ${life} ${member.life}/${member.maxLife}${member.skills.length ? `，用过 ${member.skills.join('、')}` : ''}${member.fell ? '，被打倒过' : ''}`).join('；')}。` : '',
    battle.party?.some(member => member.fell) ? '被打倒过的同伴受了伤，后文要写到。' : '',
    battle.rallied ? '玩家被打倒后硬撑着站了起来，透支了身体，接下来几天都虚弱。' : '',
    battle.shock ? '这样的敌人超出了玩家的理解，理智已经扣过了，不用再写 【理智】。' : '',
    battle.over === 'lost' ? '写战败的后果：受伤、被俘、被救、失去东西都可以，故事接着走，不算结束。' : '可以写一件合理的战利品。',
    '数值已结算，不要再改这些数值，不要改写胜负。从战斗结束这一刻接着写，不用逐回合复述。',
  ]
  return `<战斗结果>\n${lines.filter(Boolean).join('\n')}\n</战斗结果>`
}

/** How many turns the story has gone without a fight, of those the model will read. */
function turnsSinceFight(turns) {
  const own = turns.filter(node => node.role === 'user')
  const last = own.findLastIndex(node => node.battle)
  return own.length - 1 - last
}

/** A foe for the story to bring on: drawn here, as a model left to itself brings the same one every time. Not the ones it has just fought. */
function foeToBring(foes, turns, spot) {
  const fought = turns.findLast(node => node.battle)?.battle.foes ?? ''
  const fresh = foes.filter(name => !fought.includes(name))
  const list = fresh.length ? fresh : foes
  return list.length ? list[Math.floor(randomFrom(seedOf('foe', spot))() * list.length)] : ''
}

/** What this one turn asks of the model beyond the rules. */
function turnAsks({ fights, fightRate, foes, wantsFight, mayFight, own, safe, battle, spot }, turns) {
  const asks = []
  if (wantsFight) asks.push('玩家这一轮要动手：先写一两句开打的场面，再写 【战斗|敌人×数量:档位】 结束回复，不要自己写打斗的过程和结果。')
  else if (mayFight) asks.push('如果玩家这一轮是在对人动手：先写一两句开打的场面，再写 【战斗|敌人×数量:档位】 结束回复，不要自己写打斗的过程和结果。不是的话这条作废，也不要为此安排敌人。')
  else if (fights && !battle && turnsSinceFight(turns) >= FIGHT_EVERY[fightRate]) {
    const foe = foeToBring(foes, turns, spot)
    asks.push(`已经好几轮没有打斗了，这一轮的行动选项里放一个战斗选项，行尾加 【战斗|敌人×数量:档位】${foe ? `，敌人可以是${foe}` : ''}。如果现在在室内、安全的地方，或者是亲密、平静的场面，这条作废：不放战斗选项，也不要安排敌人或动静打断。`)
  }
  if (own) asks.push(`这一轮是玩家${OWN_ACTIONS}：他写的是想做什么，结果由你定。手上没有的东西拿不出来（打火、纸笔这类随身小物不算），做不到的事做不到，他写的收获不算数。合理的照常写。`)
  if (safe) asks.push('玩家选了不用掷骰的稳妥做法：顺利做到，但不要给线索、物品这类额外好处，那是冒险才有的。')
  return asks.length ? `<本轮要求>${asks.join('')}</本轮要求>` : ''
}

/** What a model forgets to write down: the questions it answers before it stops. A field the card keeps itself is the card's. */
function lookBack(bound, sheet) {
  const asks = [bound.includes('things') ? '' : '玩家得到或失去了什么', bound.includes('life') ? '' : '受伤没有', sheet.sanity === undefined || bound.includes('sanity') ? '' : '理智受到冲击没有', bound.includes('quests') ? '' : '答应或办成了什么事', sheet.conditions?.length ? '身上的异常好了没有' : ''].filter(Boolean)
  return asks.length ? `写完正文看一眼：${asks.join('、')}。有就在选项前单独一行写标记，比如 【获得|钱袋】。` : ''
}

/**
 * What this turn's message says of the rules. → { text, reminder }
 * @param rules - { sheet, rank, ranks, pausing, fights, fightRate, foes, check, battle, lines, bound, wantsFight, mayFight, own, safe, spot } (engine.mjs gameTurn).
 * @param turns - the turns the model will read: from the latest compaction, hidden ones left out.
 */
export function gamePrompt({ sheet, rank = '', ranks = [], pausing, fights = false, fightRate = 'normal', foes = [], check, battle = null, lines = [], bound = [], wantsFight = false, mayFight = false, own = false, safe = false, spot = '', companions = false, words = {} }, turns) {
  // A party is told of where there are fights for it: the card has companions, or someone has joined.
  const sent = turns.filter(node => node.role === 'user').map(node => node.prompt ?? '')
  // A copy from before fights were on, or before they could be on a choice, says nothing of them.
  const party = fights && (companions || (sheet.party?.length ?? 0) > 0)
  const haveRules = sent.slice(-RULES_EVERY).some(prompt => prompt.includes(RULES_OPEN) && prompt.includes(OWN_ACTIONS) && (!fights || prompt.includes(FIGHTS_TOLD)) && (!party || prompt.includes(PARTY_TOLD)) && (!Object.keys(attributeNames({ words })).length || prompt.includes(attributesLine(words))))
  const line = sheetLine(sheet, rank, words)
  const lastLine = sent.flatMap(prompt => prompt.match(SHEET_LINE) ?? []).at(-1)
  const parts = [haveRules ? '' : rulesBlock(pausing, bound, fights, foes, ranks, sheet.sanity !== undefined, party, words), lastLine === line ? '' : line, lines.length ? `<本轮操作>${lines.join('；')}</本轮操作>` : '', check ? checkBlock(check) : '', battle ? battleBlock(battle, words) : '', turnAsks({ fights, fightRate, foes, wantsFight, mayFight, own, safe, battle, spot }, turns)]
  return {
    text: parts.filter(Boolean).join('\n\n'),
    reminder: !haveRules ? lookBack(bound, sheet) : `${pausing ? `行动结果不确定时写 【检定】 标记并结束回复；${fights ? '躲不掉的打斗写 【战斗】 标记并结束回复；' : ''}` : ''}行动选项里挑 1 到 2 个有风险的，行尾加 【检定|属性|DC数字】，成功的收获要比其余选项多；${fights ? FIGHT_REMINDER[fightRate] : ''}${bound.includes('things') ? '' : '得失写 【获得】【失去】，'}见之前的游戏规则。${lookBack(bound, sheet)}`,
  }
}

/**
 * The sheet a reply leaves the story with: the turn's operations, what the reply settles, a night's rest when it
 * opened a new day, and the card's own variables as they ended up.
 * @param path - the story up to the reply before.
 */
export function settledSheet(book, path, userNode, replyText, state) {
  const { sheet, spent } = applyOps(sheetOf(book, sheetOnPath(path), path.at(-1).state), book, userNode.gameOps ?? [])
  const told = path.filter(node => node.role === 'assistant').map(node => ({ text: node.text, time: stateTime(node.state) }))
  const before = storyDay(told)
  const newDay = storyDay([{ text: replyText, time: stateTime(state) }], before).day > before.day
  const fought = Boolean(userNode.battle) && userNode.battle.over !== 'story'
  return keptSheet(sheetOf(book, settleReply(sheet, replyMarks(replyText), { bound: Object.keys(book.bindings), spent, newDay, fought, ranks: book.ranks, book }), state))
}

/** Whether the player's own words start a fight. */
export const asksForFight = input => FIGHT_WORDS.test(String(input ?? ''))

/** Whether they might: 砍 may be a foe or firewood. */
export const mayAskForFight = input => BLOW_WORDS.test(String(input ?? ''))

/** The helper's question: what each of these things does. */
export function thingsRequest(things) {
  const list = things.map(thing => `- ${thing.name}${thing.note ? `（${thing.note}）` : ''}`).join('\n')
  const content = `给这些物品归类，只输出一个 JSON 数组，不要别的文字。每项 {"name":名字,"type":类型,"size":强度}。
类型：heal 回复生命，energy 回复气力或法力，calm 安定心神、恢复理智，damage 战斗中用来打敌人，cure 解除中毒之类的异常，boost 暂时变强，none 只有剧情用途（钥匙、信件、材料）。
强度：small、medium、large，看物品听起来有多珍贵；none、cure、boost 不用写。

${list}`
  return { system: '你是游戏的物品整理员，只输出 JSON。', messages: [{ role: 'user', content }] }
}

/** What the helper reads of a card to lay out its rules: the card, and the variables it could stand on. */
export function suggestRequest(card, paths) {
  const entries = (card.book?.entries ?? []).filter(entry => entry.enabled !== false)
  const ranksFirst = [...entries.filter(entry => RANK_LORE.test(entry.comment ?? entry.name ?? '')), ...entries.filter(entry => !RANK_LORE.test(entry.comment ?? entry.name ?? ''))]
  const lore = ranksFirst.map(entry => entry.content).join('\n').slice(0, LORE_READ)
  const story = [card.description, card.personality, card.scenario, card.firstMes, lore].filter(Boolean).join('\n\n').slice(0, CARD_READ)
  const variables = paths.map(item => `- ${item.path}（${item.kind === 'number' ? '数字' : '文字或列表'}）`).join('\n')
  const content = `读这张角色卡，给它配上游戏规则。只输出一个 JSON 对象，不要别的文字：
{"theme":"题材","energy":"气力的叫法","words":{"life":"生命的叫法"},"attributes":{"body":12,"grace":10,"mind":11,"charm":10},"skills":[{"name":"技能名","kind":"strike"}],"things":[{"name":"物品名","count":2,"type":"heal","size":"medium"}],"foes":[{"name":"敌人名","looks":"English tags for its picture","moves":["招数名"]}],"companions":[{"name":"同伴名","keys":["别称"],"attributes":{"body":10,"grace":14,"mind":12,"charm":10},"skills":[{"name":"技能名","kind":"strike"}],"start":true}],"ranks":["等级名"],"rankSpan":"wide","bindings":{"life":"变量路径"}}
theme 从 ${THEMES.join('、')} 选最接近的一个（${THEME_WORDS}），不要因为例子就往武侠上靠。energy 是这个世界对气力的叫法，两三个字。
words 是这个世界对这些东西的叫法，和默认一样就不写，每个最多 ${8} 个字：${WORD_KEYS.map(key => `${key}（默认${DEFAULT_WORDS[key]}）`).join('、')}。四个属性只改名字，意思不变：body 管力气、耐力、硬抗，grace 管速度、身手、潜行，mind 管智力、感知、意志，charm 管交涉、说服、羁绊。minion、normal、elite、boss 是四档敌人。比如怪兽养成的卡可以是 {"body":"力量","grace":"速度","mind":"智力","charm":"羁绊","life":"HP","skill":"必杀技","party":"伙伴","minion":"野生"}。
attributes 是${ATTRIBUTES.map(item => `${item.id}（${item.name}）`).join('、')}，常人 ${AVERAGE}，比 ${AVERAGE} 多出来的加起来不超过 ${ATTRIBUTE_POINTS} 点，贴合玩家的身份。
skills 2 到 4 个，名字贴合题材，kind 从 ${Object.keys(SKILLS).join('、')} 选（重击、群攻、连击、中毒、眩晕、治疗、增益）。
things 是开局带的 0 到 5 样东西，type 从 ${EFFECTS.join('、')} 选，size 是 ${STRENGTHS.join('、')}。foes 写这个世界常见的 2 到 6 种敌人。
companions 是会和玩家一起打架的固定同伴（宠物、伙伴怪兽也算），从卡里的主要角色选 0 到 3 个，属性同样按常人 ${AVERAGE}、多出来的不超过 ${ATTRIBUTE_POINTS} 点，按人设分（身手快的灵巧高，会治疗的带 heal 技能），技能 1 到 3 个；start 写开局是否已经同行。玩家独自行动的卡写 []。
ranks 是这个世界明确的等级，从低到高，比如炼气、筑基、金丹，铜牌、银牌、金牌，或者成长期、成熟期、完全体，只写大的等级，不写初期中期后期；没有明确等级就写 []。rankSpan：差一级就打不过的写 wide（境界），差几级才打不过的写 narrow（段位、军衔）。
bindings 把这张卡已有的变量对到规则字段，字段有 ${BINDABLE.join('、')}（things 背包，quests 任务，rank 是写成文字的等级，其余是数字）。只对玩家自己的变量，没把握就不写。${variables ? `\n\n这张卡的变量：\n${variables}` : '这张卡没有变量，bindings 写 {}。'}

角色卡：
${story}`
  return { system: '你是跑团规则的配置员，只输出 JSON。', messages: [{ role: 'user', content }] }
}

/** The helper's layout as rule book fields; null for an answer that cannot be read. A variable it made up goes. */
export function parseSuggestion(text, paths) {
  const answer = String(text ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  if (start < 0 || end < start) return null
  let found
  try {
    found = JSON.parse(answer.slice(start, end + 1))
  } catch {
    return null
  }
  const kindOf = new Map(paths.map(item => [item.path, item.kind]))
  const fits = (field, path) => kindOf.has(path) && fitsField(field, kindOf.get(path))
  const bindings = Object.fromEntries(Object.entries(found?.bindings ?? {}).filter(([field, path]) => BINDABLE.includes(field) && fits(field, path)))
  const { ranks } = cleanRulebook({ ranks: found?.ranks })
  return {
    ...kitBook(cleanKit(found)),
    theme: THEMES.includes(found?.theme) ? found.theme : 'plain',
    ...(found?.theme === 'horror' ? { sanity: true } : {}),
    energyName: typeof found?.energy === 'string' ? found.energy.trim().slice(0, 6) : '',
    // None said is no change: a ladder the player wrote stays.
    ...(ranks.length ? { ranks, rankSpan: found?.rankSpan === 'narrow' ? 'narrow' : 'wide' } : {}),
    bindings,
  }
}

/** The helper's answer for the rule book: { name: { type, size } }; what it did not answer stays unset. */
export function parseThings(text, things) {
  const answer = String(text ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
  const start = answer.indexOf('[')
  const end = answer.lastIndexOf(']')
  if (start < 0 || end < start) return {}
  let list
  try {
    list = JSON.parse(answer.slice(start, end + 1))
  } catch {
    return {}
  }
  const asked = new Set(things.map(thing => thing.name))
  const out = {}
  for (const item of Array.isArray(list) ? list : []) {
    if (asked.has(item?.name) && EFFECTS.includes(item.type)) out[item.name] = { type: item.type, ...(STRENGTHS.includes(item.size) ? { size: item.size } : {}) }
  }
  return out
}

/** The helper's question: what these foes look like and do, for the story they are in. */
export function foesRequest(names, story) {
  const content = `这个故事里出现了这些敌人，为每个写外貌和招式，只输出一个 JSON 数组，不要别的文字。每项 {"name":名字,"looks":外貌,"moves":[招式名]}。
looks：用来画图的英文标签，逗号分隔，写清是人还是什么怪物、体型、衣着或皮毛、手里的东西，比如 grey wolf, large, snarling, bared fangs。
moves：两到三个招式名，中文，两到四个字，比如 撕咬、猛扑。

故事：
${story}

敌人：
${names.map(name => `- ${name}`).join('\n')}`
  return { system: '你是游戏的怪物图鉴编辑，只输出 JSON。', messages: [{ role: 'user', content }] }
}

/** The helper's answer: { name: { looks, moves } }; what it did not answer stays unknown. */
export function parseFoes(text, names) {
  const answer = String(text ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
  const start = answer.indexOf('[')
  const end = answer.lastIndexOf(']')
  if (start < 0 || end < start) return {}
  let list
  try {
    list = JSON.parse(answer.slice(start, end + 1))
  } catch {
    return {}
  }
  const out = {}
  for (const item of Array.isArray(list) ? list : []) {
    if (names.includes(item?.name)) out[item.name] = { looks: String(item.looks ?? ''), moves: Array.isArray(item.moves) ? item.moves : [] }
  }
  return out
}

/** A rule book as it goes with a card: the bestiary's pictures stay behind, like the rest of the card's media. */
function travelling(value) {
  const book = cleanRulebook(value)
  return { ...book, foes: Object.fromEntries(Object.entries(book.foes).map(([name, { file: _left, ...foe }]) => [name, foe])) }
}

export function createRulebooks(store) {
  const file = cardId => path.join(store.dirs.cards, cardId, 'game.json')
  const locks = new Map()

  async function read(cardId) {
    await store.getCard(cardId)
    return cleanRulebook(await readJsonFile(file(cardId), null))
  }

  /**
   * 裁判表 is the model judging by a table; the rules judge in code. Two judges would fight, so the card's table
   * is off while the rules are on (and back when they go off).
   */
  async function judgeTableOn(cardId, enabled) {
    const card = await store.getCard(cardId)
    const tables = (card.book?.entries ?? []).filter(entry => entry.content?.includes('<judge_rules>') && entry.enabled !== enabled)
    if (!tables.length) return
    for (const table of tables) table.enabled = enabled
    await store.saveCard(card)
  }

  /** What is sent replaces those parts (`patch` may be a function of the book); the rest stays. Alone for this card, written whole. */
  function change(cardId, patch) {
    const run = (locks.get(cardId) ?? Promise.resolve()).then(async () => {
      const current = await read(cardId)
      const book = cleanRulebook({ ...current, ...(typeof patch === 'function' ? await patch(current) : patch) })
      await writeJson(file(cardId), book)
      if (rulesOn(book) !== rulesOn(current)) await judgeTableOn(cardId, !rulesOn(book))
      return book
    })
    locks.set(cardId, run.catch(() => {}))
    return run
  }

  const foeDir = cardId => path.join(store.dirs.cards, cardId, 'foes')

  /** What the helper said of foes: what is there already stays, a picture above all. */
  const learnFoes = (cardId, foes) => change(cardId, book => ({ foes: { ...foes, ...book.foes } }))

  /** A foe's picture, kept for the next time it is met; `buffer` null takes it away. */
  function setFoePicture(cardId, name, buffer) {
    if (buffer && !imageKind(buffer)) throw httpError(400, msg`立绘要是 PNG、JPG 或 WebP`)
    if (buffer && buffer.length > MAX_PICTURE) throw httpError(400, msg`立绘太大（最多 12MB）`)
    return change(cardId, async book => {
      const foe = book.foes[name] ?? { looks: '', moves: [] }
      if (FOE_PICTURE.test(foe.file ?? '')) await rm(path.join(foeDir(cardId), foe.file), { force: true })
      const { file: _gone, ...rest } = foe
      if (!buffer) return { foes: { ...book.foes, [name]: rest } }
      const picture = `foe-${randomBytes(6).toString('hex')}.${imageKind(buffer)}`
      await mkdir(foeDir(cardId), { recursive: true })
      await writeFile(path.join(foeDir(cardId), picture), buffer)
      return { foes: { ...book.foes, [name]: { ...rest, file: picture } } }
    })
  }

  async function readFoePicture(cardId, picture) {
    if (!FOE_PICTURE.test(picture)) return null
    try {
      return { data: await readFile(path.join(foeDir(cardId), picture)), type: PICTURE_TYPES[picture.split('.').pop()] }
    } catch {
      return null
    }
  }

  /** A newer version of a card plays by the older one's rules. */
  async function inherit(fromId, toId) {
    const book = await readJsonFile(file(fromId), null)
    if (book) await writeJson(file(toId), cleanRulebook(book))
  }

  /** The book as it leaves with the card; null for a card that never had one, whose files stay as they were. */
  async function portable(cardId) {
    const book = await readJsonFile(file(cardId), null)
    return book ? travelling(book) : null
  }

  /** The book a card's file brought. One the card has already stays: those are the player's settings. */
  async function arrive(cardId, book) {
    if (book && !await readJsonFile(file(cardId), null)) await writeJson(file(cardId), travelling(book))
  }

  return { read, change, inherit, portable, arrive, learnFoes, setFoePicture, readFoePicture }
}
