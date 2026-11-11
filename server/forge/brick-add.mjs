// 给已有的卡加玩法积木 (检查这张卡 → 加玩法积木): a brick 创作角色卡 can give a new card, added to a card that is
// already there, imported ones too. As there, the code writes the works (the rule entry, the regex) with bricks.mjs,
// and a model only fills in what is this card's own, from the card as it reads. What comes of it is a suggestion in
// 检查这张卡's list, taken in and back like any other.
//
// Only the bricks that keep nothing in variables: a card's variables can be laid out in ways the code cannot write
// into safely (a schema of its own, rules that name every path), and those bricks stay with 创作角色卡.
import { getPath } from '../../web/shared/vars.js'
import { msg } from '../i18n.mjs'
import { greetingList } from '../../web/shared/card-edit.js'
import { isInitvar } from '../worldbook.mjs'
import { attr } from './blocks.mjs'
import { brickContent, brickCost, brickEntries, brickPlanLines, brickScripts, cleanEvents, cleanJudge } from './bricks.mjs'
import { englishCard, newScript } from './check.mjs'
import { looseJson, section } from './prompts.mjs'
import { variableLines } from './status.mjs'

/** The bricks a card that is already there can be given, in the order they are offered. */
export const CARD_BRICKS = ['selfcheck', 'events', 'judge']
// The answer with its thinking: a list, a few groups, a ladder.
export const BRICK_TOKENS = 12000
/** What an answer comes to, for the estimate before anything is sent. */
export const BRICK_OUTPUT = 3000
const MAX_WISH = 400
const MAX_FIELD = 3000
const MAX_RULES = 6000
const MAX_VARIABLES = 40
const MAX_CHECKS = 6
const FIELD = { selfcheck: 'selfcheck', events: 'random_events', judge: 'judge' }

const clip = (text, max) => {
  const words = String(text ?? '').trim()
  return words.length > max ? `${words.slice(0, max)}…` : words
}

export const brickName = brick => ({ selfcheck: msg`写前自查`, events: msg`随机事件`, judge: msg`裁判表` })[brick] ?? brick
export const cleanBrickWish = wish => clip(typeof wish === 'string' ? wish.replace(/\s+/g, ' ') : '', MAX_WISH)

const brickSystem = (brick, english) => {
  const [format] = brickPlanLines([brick], { root: english ? 'Protagonist' : '主角' })
  return `你给一张已经写好的角色卡加一块玩法。规则怎么写、正则和格式都由程序负责，你只按这张卡填内容。读 <card>，输出一个 JSON 对象，里面只有下面说的这一个字段，JSON 外不写别的。

${format.replace(/^(?:tracking[^。]*。)?方案里多写一个/, 'JSON 里写一个').replace(/tracking\.enabled 为 true[\s\S]*$/, '')}${brick === 'judge' ? `
这张卡已经写好，不新加变量：rank_path 只能写 <variables> 里已有的、记 <user> 等级的那个变量；没有合适的就写空字符串，并在 judge 里多写一个 "user_rank"：<user> 开局的等级，要是 ranks 里的一个。known 写卡里出现过的人物和他们的等级。` : ''}

内容贴着这张卡写：用卡里的人物、地方和规矩，不写哪张卡都能用的空话。用${english ? '英文' : '中文'}写，和这张卡一样。`
}

/**
 * The card as far as a brick's content needs it: who and where, the rules that are always there, the variables.
 * 角色采访 reads it too, with more of the opening (how the card is written) and no variables.
 */
export function cardBrief(card, state, { opening = 1200, variables: listed = true } = {}) {
  const rules = (card.book?.entries ?? []).filter(entry => entry.enabled !== false && entry.constant && !isInitvar(entry))
  let room = MAX_RULES
  const kept = []
  for (const entry of rules) {
    const text = clip(entry.content, Math.min(1500, room))
    if (room <= 200) break
    kept.push(`<entry name="${attr(entry.comment)}">\n${text}\n</entry>`)
    room -= text.length
  }
  const variables = listed ? variableLines(state ?? {}).slice(0, MAX_VARIABLES) : []
  return [
    `<card name="${attr(card.name)}">`,
    clip(card.description, MAX_FIELD),
    card.personality ? `性格：${clip(card.personality, 1000)}` : '',
    card.scenario ? `场景：${clip(card.scenario, 1000)}` : '',
    greetingList(card)[0] ? `开场白：${clip(greetingList(card)[0].replace(/<[^>]{0,200}>/g, ' '), opening)}` : '',
    ...kept,
    !listed ? '' : variables.length ? `<variables>\n${variables.join('\n')}\n</variables>` : '（这张卡没有变量）',
    '</card>',
  ].filter(Boolean).join('\n\n')
}

/** The request for a brick's content. */
export function brickRequest(card, brick, { wish = '', state = {} } = {}) {
  const english = englishCard(card)
  const content = [cardBrief(card, state), wish ? `用户对这块玩法的想法：${wish}` : '用户没有说具体要什么，按这张卡定。'].join('\n\n')
  return { system: brickSystem(brick, english), messages: [{ role: 'user', content }], maxTokens: BRICK_TOKENS, softCap: true }
}

/** What the model filled in, as a plan keeps it ({ selfcheck } / { random_events } / { judge }); null when there is nothing to use. */
export function readBrick(text, brick, { state = {} } = {}) {
  const raw = looseJson(section(text, 'json') || text)
  if (!raw || typeof raw !== 'object') return null
  const value = raw[FIELD[brick]] ?? (brick === 'selfcheck' && Array.isArray(raw) ? raw : null)
  if (brick === 'selfcheck') {
    const checks = [...new Set((Array.isArray(value) ? value : []).map(item => clip(typeof item === 'string' ? item.replace(/\s+/g, ' ') : '', 120)).filter(Boolean))].slice(0, MAX_CHECKS)
    return checks.length ? { selfcheck: checks } : null
  }
  if (brick === 'events') {
    const events = cleanEvents(value)
    return events?.groups.length ? { random_events: events } : null
  }
  if (brick === 'judge') {
    const judge = cleanJudge(value)
    if (!judge) return null
    // Only a variable the card has can hold the rank: none is made here. Without one the rule says where <user> starts,
    // first among what is known; from there the story is what tells.
    const held = judge.rank_path && getPath(state, judge.rank_path) !== undefined ? judge.rank_path : ''
    const start = clip(value?.user_rank, 16)
    const known = !held && judge.ranks.includes(start) ? [{ name: '<user>', rank: start }, ...judge.known.filter(item => item.name !== '<user>')] : judge.known
    const plan = { judge: { ...judge, rank_path: held, known } }
    return brickEntries(plan, false).length ? plan : null
  }
  return null
}

/**
 * A brick's content as a suggestion for 检查这张卡: the rule entry (sent late every turn, as 创作角色卡 places it) and
 * the regex the brick runs on. null when the content makes no brick.
 */
export function brickFinding(card, brick, plan) {
  const english = englishCard(card)
  const [entry] = brickEntries(plan, english)
  if (!entry) return null
  const cost = brickCost(plan, english)
  const why = {
    selfcheck: msg`模型每次写之前，先照这几条过一遍这张卡最容易写崩的地方；这段玩家看不到。`,
    events: msg`程序每轮抽一次，抽中了这件事就发生；场合不对或上一件事还没完，这一轮就不发生。`,
    judge: msg`要较量或做超出等级的事时，模型照这张表判定，不放水；回复里多一行判定。开着游戏规则的卡不要加：两样只能留一个。`,
  }[brick]
  return {
    id: `brick-add:${brick}`,
    rule: 'brick-add',
    level: 'tip',
    from: 'model',
    brick,
    title: msg`加上「${brickName(brick)}」`,
    why: `${why}${msg`规则每轮都发，约 ${cost.always} 字；模型每轮大约多写 ${cost.reply} 字。`}`,
    changes: [
      { id: `new:brick-${brick}`, kind: 'newEntry', name: entry.name, keys: [], constant: true, late: true, after: brickContent(entry.part, plan, english) },
      ...brickScripts(plan, english).map(script => newScript(script)),
    ],
  }
}
