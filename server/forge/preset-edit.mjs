// 对话修改 for a SillyTavern preset (预设 → 对话修改): the user says what to
// change, or asks what an entry does, and the model writes each changed prompt
// out in full (blocks.mjs); the page shows them as before and after, and the
// ones the user keeps go into the preset (presets.mjs editPreset). A preset too
// long to send whole is first shown as a list of its prompts: the model names
// the ones it needs to read (presetPickRequest), and those go in full.
import { editPreset, placementsOf, sectionsOf } from '../presets.mjs'
import { LONG_TOKENS } from './prompts.mjs'
import { attr, bodyFor, historyLines, readBlocks } from './blocks.mjs'
import { ENTRY_BUDGET } from './edit.mjs'

const PICK_MAX = 40
const NEW_MAX = 20
const ROLES = new Set(['system', 'user', 'assistant'])

// What the markers stand for, in the words the model is told.
const MARKER_TEXT = {
  chatHistory: '聊天记录',
  charDescription: '角色描述',
  charPersonality: '角色性格',
  scenario: '场景',
  personaDescription: '玩家的角色设定',
  worldInfoBefore: '世界书（角色之前）',
  worldInfoAfter: '世界书（角色之后）',
  dialogueExamples: '对话示例',
}

const promptsOf = preset => preset.prompts.filter(p => !p.marker)

/** Whether a preset is too long to send whole: its edit starts with a look at the list. */
export const presetTooLong = preset => promptsOf(preset).reduce((sum, p) => sum + p.content.length, 0) > ENTRY_BUDGET

/** Where a prompt goes, as the model is told. */
function placeOf(prompt, section) {
  if (prompt.absolute) return `插入聊天记录第 ${prompt.depth} 层`
  return section === 'post' ? '聊天记录之后' : '聊天记录之前'
}

/** The ids sent in full: the one asked about, those picked, those the request names, then in order within the budget. */
export function shownPrompts(preset, words, target = '', { picked = [], budget = ENTRY_BUDGET } = {}) {
  const first = target.startsWith('prompt:') ? target.slice(7) : null
  const named = p => [p.name, p.id].some(name => name && name.length >= 2 && words.includes(name))
  const rank = p => (p.id === first ? 3 : picked.includes(p.id) ? 2 : named(p) ? 1 : 0)
  const ranked = promptsOf(preset).map((p, index) => ({ p, index })).sort((a, b) => rank(b.p) - rank(a.p) || a.index - b.index)
  const shown = new Set()
  let used = 0
  for (const { p } of ranked) {
    if (shown.size && used + p.content.length > budget) continue
    used += p.content.length
    shown.add(p.id)
  }
  return shown
}

function presetBlock(preset, shown) {
  const sections = sectionsOf(preset)
  return preset.prompts
    .map((p, i) => {
      if (p.marker) return `<marker id="${attr(p.id)}" name="${attr(MARKER_TEXT[p.id] ?? p.name)}"${p.enabled ? '' : ' enabled="false"'}/>`
      const head = `<prompt id="${attr(p.id)}" name="${attr(p.name)}" role="${p.role}" place="${placeOf(p, sections[i])}"${p.enabled ? '' : ' enabled="false"'}>`
      return shown.has(p.id) ? `${head}\n${p.content}\n</prompt>` : `${head}（正文 ${p.content.length} 字，这次没有附上，不能改）</prompt>`
    })
    .join('\n\n')
}

/** The first look at a long preset: its prompts by name and the request; the answer names the ones to read. */
export function presetPickRequest(preset, { text, target = '', turns = [] } = {}) {
  const sections = sectionsOf(preset)
  const list = preset.prompts
    .map((p, i) => (p.marker ? null : `- id=${p.id}「${p.name}」${placeOf(p, sections[i])}${p.enabled ? '' : '，停用'}（${p.content.length} 字）`))
    .filter(Boolean)
    .join('\n')
  const history = historyLines(turns)
  const content = [
    `<preset name="${attr(preset.name)}">\n条目（按顺序）：\n${list}\n</preset>`,
    history.length ? `之前的几次修改：\n${history.join('\n')}` : '',
    `这次的要求：\n${text}`,
    target.startsWith('prompt:') ? `这次只改 id=${target.slice(7)} 这一条。` : '',
    `先挑出完成这次要求要读全文的条目，最多 ${PICK_MAX} 条。只回答 <read>id, id, …</read>；只是新增条目、不用读旧条目时回答 <read></read>。`,
  ].filter(Boolean).join('\n\n')
  return {
    system: '你在帮用户修改一个 SillyTavern 预设。预设太长，不能一次全部附上，先看条目列表挑出要读的条目。只回答 <read> 标签，不写别的。',
    messages: [{ role: 'user', content }],
    maxTokens: 800,
  }
}

/** The ids a first look asked for, as the preset has them. */
export function readPickedPrompts(text, preset) {
  const match = /<read>([\s\S]*?)(?:<\/read>|$)/i.exec(String(text ?? ''))
  const asked = (match ? match[1] : String(text ?? '')).split(/[\s,，、]+/).map(id => id.trim()).filter(Boolean)
  const known = new Set(promptsOf(preset).map(p => p.id))
  return [...new Set(asked.filter(id => known.has(id)))].slice(0, PICK_MAX)
}

const presetSystem = reply => `你是 SillyTavern 预设编辑。预设是一组按顺序拼进发给模型的提示词的条目：聊天记录之前的条目组成开头的系统提示，聊天记录之后的条目跟在最新的消息后面，标了「插入第几层」的条目插在聊天记录里。marker 是占位，会换成角色描述、世界书、聊天记录这些内容，没有正文。enabled="false" 的条目现在不发送。

做法：
- 只动需要动的条目；用户没提到、也不冲突的条目一字不动。
- 照原预设的写法改：保留原来的格式、语言和标签结构。{{char}}、{{user}}、{{getvar::…}}、{{setvar::…}} 这类宏，<% %> 模板脚本，以及给模型或正则用的 <标签>，原样保留，除非用户要改的就是它们。
- 新条目写给模型看：直接、具体，一条讲一件事（文风、格式、规则……）。默认放在聊天记录之前；要紧跟在某一条后面时写 after="那一条的 id"。一次最多加 ${NEW_MAX} 条。
- 用户只是问问题，或者要你解释某一条在做什么，就在 <reply> 里回答，不输出改动。要求含糊时，按最可能的意思做，在 <reply> 里说你是怎么理解的。
- 要改的条目这次没有附上全文，就不能改：在 <reply> 里说，用户可以让你接着改。

回答先写一段 <reply>，再写每一处改动；标签外不写别的：
<reply>
对用户说的话，用${reply}。改了东西就用两到四句说改了哪里、为什么；回答问题可以写长一些。
</reply>
<prompt id="main">改好之后的完整正文</prompt>
<prompt id="cot" enabled="false"></prompt>
<new_prompt name="条目名" role="system" after="main">新条目的正文</new_prompt>
<remove_prompt id="old"></remove_prompt>

- prompt 改已有条目：写 id；要改名字、角色或开关，再加 name="…"、role="system"、"user" 或 "assistant"、enabled="true" 或 "false"。只改这些、不改正文时，标签中间空着。marker 只能开关。
- 每个正文都写改好之后的完整内容，不是片段，不写省略号，不写「其余不变」。没改的不要输出。`

/**
 * The request for one edit of a preset. `picked`: the ids a first look asked to
 * read. Returns { request, shown }, shown being the ids sent in full: only those
 * can change (a marker's switch always can).
 */
export function presetEditRequest(preset, { text, target = '', turns = [], reply = '简体中文', picked = [] } = {}) {
  const shown = shownPrompts(preset, `${text}\n${target}`, target, { picked })
  const history = historyLines(turns)
  const content = [
    `<preset name="${attr(preset.name)}">\n${presetBlock(preset, shown)}\n</preset>`,
    history.length ? `之前的几次修改（上面的预设已经是处理之后的样子）：\n${history.join('\n')}` : '',
    `这次的要求：\n${text}`,
    target.startsWith('prompt:') ? `只改 <prompt id="${target.slice(7)}"> 这一条，别的不动。` : '',
  ].filter(Boolean).join('\n\n')
  return { request: { system: presetSystem(reply), messages: [{ role: 'user', content }], maxTokens: LONG_TOKENS, softCap: true }, shown: [...shown] }
}

const flag = value => (value === 'true' ? true : value === 'false' ? false : null)

/**
 * An answer → { reply, changes }. A change is
 *   { id, kind: 'prompt', pid, title, marker, place, before, after, name?, role?, enabled? }
 *   { id, kind: 'newPrompt', name, role, afterId, afterTitle, after }
 *   { id, kind: 'removePrompt', pid, title, place, before }
 * `place` is where it goes ('prefix', 'turn', 'split'; presets.mjs placementsOf).
 * Prompts not sent in full (`shown`), and with a `target` anything else, are left out.
 */
export function readPresetEdit(text, preset, { shown = null, target = '' } = {}) {
  const { reply, blocks } = readBlocks(text, ['prompt', 'new_prompt', 'remove_prompt'])
  const placements = placementsOf(preset)
  const placeOfId = id => placements[preset.prompts.findIndex(p => p.id === id)]
  const changes = new Map()
  let fresh = 0
  for (const block of blocks) {
    const { tag, attrs } = block
    let { body } = block
    if (tag === 'new_prompt') {
      if (!body || fresh >= NEW_MAX) continue
      const after = preset.prompts.find(p => p.id === String(attrs.after ?? '').trim())
      const id = `new:${fresh++}`
      changes.set(id, {
        id,
        kind: 'newPrompt',
        name: String(attrs.name ?? '').trim().slice(0, 80) || body.replace(/\s+/g, ' ').slice(0, 24),
        role: ROLES.has(attrs.role) ? attrs.role : 'system',
        afterId: after?.id ?? '',
        afterTitle: after ? (after.marker ? MARKER_TEXT[after.id] ?? after.name : after.name) : '',
        after: body,
      })
      continue
    }
    const prompt = preset.prompts.find(p => p.id === String(attrs.id ?? '').trim())
    if (!prompt) continue
    if (tag === 'remove_prompt') {
      if (prompt.marker || (shown && !shown.includes(prompt.id))) continue
      changes.set(`remove:${prompt.id}`, { id: `remove:${prompt.id}`, kind: 'removePrompt', pid: prompt.id, title: prompt.name, place: placeOfId(prompt.id), before: prompt.content })
      continue
    }
    const enabled = flag(String(attrs.enabled ?? '').trim().toLowerCase())
    const change = { id: `prompt:${prompt.id}`, kind: 'prompt', pid: prompt.id, title: prompt.marker ? MARKER_TEXT[prompt.id] ?? prompt.name : prompt.name, marker: prompt.marker, place: placeOfId(prompt.id), before: prompt.content, after: prompt.content }
    if (enabled !== null && enabled !== prompt.enabled) change.enabled = enabled
    if (!prompt.marker && (!shown || shown.includes(prompt.id))) {
      body = bodyFor(block, prompt.content)
      if (body && body !== prompt.content.trim()) change.after = body
      const name = String(attrs.name ?? '').trim().slice(0, 80)
      if (name && name !== prompt.name) change.name = name
      if (ROLES.has(attrs.role) && attrs.role !== prompt.role) change.role = attrs.role
    }
    if (change.after !== prompt.content || change.name || change.role || change.enabled !== undefined) changes.set(change.id, change)
  }
  const list = [...changes.values()]
  return { reply, changes: target ? list.filter(change => change.id === target) : list }
}

/**
 * The chosen changes (by id) into the preset, in place; a prompt deleted since
 * is skipped. New prompts go before the chat history, or after the one named.
 * Returns how many went in and whether a chat's frozen prefix would differ (a
 * change to a prompt that is not sent each turn).
 */
export function applyPresetChanges(preset, changes, ids) {
  const chosen = changes.filter(change => ids.includes(change.id))
  const exists = id => preset.prompts.some(p => p.id === id)
  const placements = placementsOf(preset)
  const placeOf = new Map(preset.prompts.map((p, i) => [p.id, placements[i]]))
  let prefix = false
  let applied = 0
  const edits = chosen.filter(c => c.kind === 'prompt' && exists(c.pid))
  if (edits.length) {
    editPreset(preset, {
      prompts: edits.map(c => ({
        id: c.pid,
        ...(c.after !== c.before ? { content: c.after } : {}),
        ...(c.name ? { title: c.name } : {}),
        ...(c.role ? { role: c.role } : {}),
        ...(c.enabled !== undefined ? { enabled: c.enabled } : {}),
      })),
    })
    applied += edits.length
    prefix ||= edits.some(c => placeOf.get(c.pid) !== 'turn')
  }
  for (const change of chosen.filter(c => c.kind === 'newPrompt')) {
    const before = new Set(preset.prompts.map(p => p.id))
    editPreset(preset, { add: { name: change.name, role: change.role, content: change.after } })
    const added = preset.prompts.find(p => !before.has(p.id))
    if (added && change.afterId && exists(change.afterId)) {
      const order = preset.prompts.map(p => p.id).filter(id => id !== added.id)
      order.splice(order.indexOf(change.afterId) + 1, 0, added.id)
      editPreset(preset, { order })
    }
    applied++
    prefix ||= placementsOf(preset)[preset.prompts.findIndex(p => p.id === added?.id)] !== 'turn'
  }
  const removed = chosen.filter(c => c.kind === 'removePrompt' && exists(c.pid))
  if (removed.length) {
    prefix ||= removed.some(c => placeOf.get(c.pid) !== 'turn')
    editPreset(preset, { remove: removed.map(c => c.pid) })
    applied += removed.length
  }
  return { applied, prefix }
}
