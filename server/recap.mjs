// Manual context compaction. The model that wrote the story (its cache still
// warm) summarises it from a throwaway fork of the session; the next turn then
// starts a new session on the same frozen prefix, carrying that summary plus the
// last few turns verbatim. Nothing in the tree is deleted: turns before the
// compaction still fork from the old session.
import { replaceMacros } from './prompt.mjs'

/** `format` of an exported story archive (see chats.mjs exportStory). */
export const STORY_FORMAT = 'agent-tavern-story'

/** Turns copied verbatim after the summary, so the voice carries over. */
export const RECENT_TURNS = 2
/** Fewer turns than this since the last compaction: not worth a summary call. */
export const MIN_TURNS = 2

export function summaryInstruction(names) {
  return replaceMacros(
    `【暂停扮演：剧情存档】
这一条不是剧情，是系统请求，请不要续写故事。
故事要换到新的上下文里继续，之前的对话记录会被这份存档代替。请为接着写的作者写一份剧情存档，包括：

1. 人物：出场过的重要人物——身份，性格和说话方式的要点，与{{user}}的关系及其变化，当前处境。
2. 经过：按时间顺序列出关键事件。保留具体细节：地点、物品、数字、约定，以及值得记住的台词原话。
3. 未完的线：伏笔、悬念、承诺、还没解决的冲突。
4. 当前场景：时间、地点、在场人物、正在发生什么、气氛。
5. 文风：叙述的人称、节奏和惯用手法，以及{{char}}一方说话的腔调，方便保持一致。

不要写变量、数值和状态栏（另有记录），不要评论，不要续写。用简体中文。篇幅和剧情量相称：只有几轮时几百字就够，长篇剧情一般不超过 4000 字。
只输出存档本身，放在 <剧情存档> 和 </剧情存档> 之间。`,
    names,
  )
}

/** The archive between the tags; tolerates a missing closing tag or none at all. */
export function extractSummary(reply) {
  let text = String(reply ?? '')
  const open = text.indexOf('<剧情存档>')
  if (open >= 0) {
    text = text.slice(open + '<剧情存档>'.length)
    const close = text.indexOf('</剧情存档>')
    if (close >= 0) text = text.slice(0, close)
  }
  return text
    .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '')
    .replace(/<StatusPlaceHolderImpl\s*\/>/gi, '')
    .trim()
}

/**
 * `path` with the turns an imported story archive brought along put back in
 * front of the root (the root of an imported chat is the archive's last reply).
 */
export function storyPath(path) {
  const recent = path[0]?.compaction?.recent
  if (!Array.isArray(recent) || !recent.length) return path
  return [{ id: 'opening', role: 'assistant', text: '' }, ...recent.map(({ role, text }) => ({ role, text })), ...path]
}

/** User turns the story on `path` has had, counting those before an import. */
export function storyTurns(path) {
  const before = path[0]?.compaction?.imported ? Number(path[0].compaction.turns) || 0 : 0
  return before + path.filter(node => node.role === 'user').length
}

/** User turns on `path` after its last compaction point. */
export function turnsSinceCompaction(path) {
  let start = 0
  path.forEach((node, index) => {
    if (node.compaction) start = index + 1
  })
  return path.slice(start).filter(node => node.role === 'user').length
}

/**
 * The last `turns` exchanges ending at `path`'s tip, as prompt text.
 * @param transform - ({ role, text, depth }) => text, the card's prompt-side regex.
 */
export function recentExchanges(path, names, transform = ({ text }) => text, turns = RECENT_TURNS) {
  // The path alternates opening, user, assistant, …; skip the opening (the summary covers it).
  const tail = path.slice(1).slice(-turns * 2)
  if (tail[0]?.role === 'assistant') tail.shift()
  return tail
    .map((node, index) => {
      const text = String(transform({ role: node.role, text: node.text, depth: tail.length - 1 - index }) ?? '').trim()
      return text ? `【${node.role === 'user' ? names.user : names.char}】\n${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

/** The block the first turn after a compaction opens with. */
export function recapBlock(summary, recent) {
  const parts = [
    '<前情提要>',
    '故事已经进行了一段时间，之前的对话记录已收起。下面是剧情存档和最近几轮的原文，请从最近一轮之后自然接续，不要复述。',
    `<剧情存档>\n${String(summary).trim()}\n</剧情存档>`,
  ]
  if (recent) parts.push(`<最近原文>\n${recent}\n</最近原文>`)
  parts.push('</前情提要>')
  return parts.join('\n')
}
