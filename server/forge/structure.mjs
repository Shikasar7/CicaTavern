// 从已有卡学结构: what a card is built from, read by the program: how big it is, what it keeps track of, which of the
// wizard's bricks it uses. Nothing here carries the card's writing. Its names, characters and story stay out, so a
// model given this can learn how the card works without being able to copy it.
import { greetingList } from '../../web/shared/card-edit.js'
import { msg } from '../i18n.mjs'
import { usesMvu } from '../mvu.mjs'
import { replyBlocks } from '../prompt.mjs'
import { constantEntries, lateEntries, markedInitialState } from '../worldbook.mjs'

const NOTES = 300
// Sizes at which a card reads as 标准 and 大作: the entries a card of that scale ends up with.
const STANDARD_ENTRIES = 40
const EPIC_ENTRIES = 100
const CHECK_TAG = /check|review|verify|自查|审查|反思/i
const JUDGE_TITLE = /裁判|判定|检定|战力|等级差|judge|ruling/i
const WORLD_TITLE = /世界动[向态]|势力动向|世界进程|world\s*(move|event|progress)/i
const CREATION_PAGE = /<CreationPage\s*\/>|<(form|select)\b|<input\b/i
const CREATION_TITLE = /建角|创角|角色创建|捏人|character creation/i

const textOf = entry => String(entry.content ?? '')

/** How many of each kind of value the initial state keeps. */
function countValues(state) {
  const counts = { number: 0, text: 0, list: 0, book: 0 }
  const walk = value => {
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('$')) continue
      if (Array.isArray(item)) counts.list++
      else if (item && typeof item === 'object') {
        if (item.$meta?.extensible || item.$meta?.recursiveExtensible) counts.book++
        else walk(item)
      } else if (typeof item === 'number') counts.number++
      else counts.text++
    }
  }
  walk(state ?? {})
  return counts
}

/** The bricks a card's own works amount to. A guess from what it has, which is why the player gets to say. */
function bricksOf(card, { counts, blocks, scripts, entries, greetings }) {
  const words = [...entries.map(textOf), ...scripts.map(script => String(script.replaceString ?? ''))].join('\n')
  const titles = entries.map(entry => String(entry.comment ?? ''))
  const drawn = scripts.some(script => script.placement?.includes(5) && /\{\{(random|pick)\b/.test(script.replaceString ?? ''))
  const found = []
  if (counts.book > 0) found.push('books')
  if (blocks.some(tag => CHECK_TAG.test(tag))) found.push('selfcheck')
  if (drawn || entries.some(entry => /\{\{random\b/.test(textOf(entry)))) found.push('events')
  if (/\{\{roll\b/.test(words) || titles.some(title => JUDGE_TITLE.test(title))) found.push('judge')
  if (titles.some(title => WORLD_TITLE.test(title))) found.push('world')
  if (greetings.some(text => CREATION_PAGE.test(text)) || titles.some(title => CREATION_TITLE.test(title))) found.push('creation')
  return found
}

/**
 * @returns { title, author, notes, entries: { total, always, keyword }, greetings, regex, values, format, scale, bricks, blocks }
 *   `author` and `notes` are for the player, to see whose it is and what they asked; they never go to the model.
 */
export function cardStructure(card) {
  const book = card.book ? [card.book] : []
  const entries = (card.book?.entries ?? []).filter(entry => entry.enabled !== false)
  const scripts = (card.regexScripts ?? []).filter(script => !script.disabled)
  const greetings = greetingList(card).filter(text => text.trim())
  const blocks = replyBlocks([...constantEntries(book), ...lateEntries(book)], scripts)
  const values = countValues(markedInitialState(book))
  const drawsBar = Boolean(card.statusBar) || scripts.some(script => /```html|<body|<div\b/i.test(script.replaceString ?? ''))
  const always = entries.filter(entry => entry.constant).length
  return {
    title: String(card.name ?? ''),
    author: String(card.creator ?? '').trim(),
    notes: String(card.creatorNotes ?? '').trim().slice(0, NOTES),
    entries: { total: entries.length, always, keyword: entries.length - always },
    greetings: greetings.length,
    regex: scripts.length,
    values,
    format: usesMvu(card, book) ? (drawsBar ? 'mvu-ui' : 'mvu') : 'text',
    scale: entries.length >= EPIC_ENTRIES ? 'epic' : entries.length >= STANDARD_ENTRIES ? 'standard' : '',
    bricks: bricksOf(card, { counts: values, blocks, scripts, entries, greetings }),
    blocks,
  }
}

const BRICK_TEXT = { books: '能增能减的册子', selfcheck: '写前自查', events: '随机事件', judge: '等级判定', world: '世界自己在动', creation: '开局建角页' }

/** What the model reads of a card it may only learn from: shape, no words of the card's. */
export function structureText(structure) {
  const { entries, values, greetings, regex, format, bricks, blocks } = structure
  const kept = [['数字', values.number], ['文字', values.text], ['列表', values.list], ['册子', values.book]].filter(([, count]) => count).map(([label, count]) => `${label} ${count}`)
  return [
    '这里只有这张卡的结构，没有它的内容。',
    `世界书 ${entries.total} 条：常驻 ${entries.always} 条，按关键词 ${entries.keyword} 条。`,
    `开场白 ${greetings} 段。`,
    format === 'text' ? '不记录变量。' : `记录变量${kept.length ? `：${kept.join('、')}` : ''}${format === 'mvu-ui' ? '，有美化的状态栏' : ''}。`,
    bricks.length ? `用到的玩法：${bricks.map(brick => BRICK_TEXT[brick]).join('、')}。` : '',
    blocks.length ? `回复里要写的块有 ${blocks.length} 种。` : '',
    regex ? `有 ${regex} 条正则。` : '',
  ].filter(Boolean).join('\n')
}

/**
 * What a card built on another's says about it, at the end of its notes.
 * @param credits - [{ title, author }]
 */
export function creditText(credits, english) {
  const works = credits.map(({ title, author }) => (english ? `"${title}" by ${author || 'an author not named on the card'}` : `《${title}》，原作者：${author || '原卡未注明'}`))
  return english
    ? [`Based on: ${works.join('; ')}.`, 'This card uses content from the work above, and the rights to it stay with its author. Check what the author allows before sharing or reworking this card. Whoever shares it answers for that.'].join('\n')
    : [`参考作品：${works.join('；')}。`, '本卡使用了上述作品的内容，相关权利归原作者所有。转发或再创作前请确认原作者的要求，由此产生的责任由发布者承担。'].join('\n')
}

export const COPY_REFUSED = () => msg`要先确认原作者允许使用，才能读这张卡的内容`
