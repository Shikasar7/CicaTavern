// 对话修改 for regex scripts (正则 → 对话修改): the global ones, a card's or a
// preset's. The user says what they want done to the replies, or why a script
// does nothing, and the model writes each changed script out (blocks.mjs);
// every pattern is tried on the chat's latest reply (regex-trial.mjs) so the
// page can show what it matches and what that becomes before anything is kept.
import { PLACEMENT, regexFromString } from '../../web/shared/regex.js'
import { LONG_TOKENS } from './prompts.mjs'
import { attr, historyLines, readBlocks } from './blocks.mjs'
import { ENTRY_BUDGET } from './edit.mjs'
import { tryScript } from './regex-trial.mjs'

const NEW_MAX = 12
const SAMPLE_MAX = 8000

// Where a script works and what it changes, in the words the model writes.
const ON = { ai: [PLACEMENT.AI_OUTPUT], user: [PLACEMENT.USER_INPUT], both: [PLACEMENT.USER_INPUT, PLACEMENT.AI_OUTPUT], none: [] }
const EFFECTS = ['display', 'prompt', 'both']

export const onOf = script => {
  const ai = script.placement.includes(PLACEMENT.AI_OUTPUT)
  const user = script.placement.includes(PLACEMENT.USER_INPUT)
  return ai && user ? 'both' : ai ? 'ai' : user ? 'user' : 'none'
}
export const effectOf = script => (script.markdownOnly ? 'display' : script.promptOnly ? 'prompt' : 'both')
/** Whether a script changes what the model reads (so the next turn writes the cache once more). */
export const touchesPrompt = script => Boolean(script) && !script.disabled && !script.markdownOnly && onOf(script) !== 'none'

/** The ids sent in full: the one asked about, those the request names, then in order within the budget. */
function shownScripts(scripts, words, target) {
  const first = target.startsWith('regex:') ? target.slice(6) : null
  const rank = s => (s.id === first ? 2 : s.scriptName.length >= 2 && words.includes(s.scriptName) ? 1 : 0)
  const ranked = scripts.map((s, index) => ({ s, index })).sort((a, b) => rank(b.s) - rank(a.s) || a.index - b.index)
  const shown = new Set()
  let used = 0
  for (const { s } of ranked) {
    const size = s.findRegex.length + s.replaceString.length
    if (shown.size && used + size > ENTRY_BUDGET) continue
    used += size
    shown.add(s.id)
  }
  return shown
}

function scriptBlock(scripts, shown) {
  if (!scripts.length) return '（这里还没有正则）'
  return scripts
    .map(s => {
      const head = `<regex id="${attr(s.id)}" name="${attr(s.scriptName)}" on="${onOf(s)}" effect="${effectOf(s)}"${s.disabled ? ' enabled="false"' : ''}>`
      return shown.has(s.id)
        ? `${head}\n<find>${s.findRegex}</find>\n<replace>${s.replaceString}</replace>\n</regex>`
        : `${head}\n<find>${s.findRegex}</find>\n（替换内容 ${s.replaceString.length} 字，这次没有附上，不能改）\n</regex>`
    })
    .join('\n\n')
}

const regexSystem = reply => `你是 SillyTavern 正则编辑。正则脚本在回复显示之前、或者发给模型之前改写文字。查找是 JavaScript 正则，写成 /表达式/标志；替换里 $1、$<名字> 是捕获组，{{match}} 是整段匹配，替换留空就是删掉匹配到的部分。
- on：作用于 AI 回复（ai）、用户输入（user），或者两者（both）。
- effect：display 只改显示（发给模型的不变，不影响缓存）；prompt 只改发给模型的；both 两边都改。美化、藏起变量块这类只改显示；只有用户想省 token、不让模型再看到某些内容时才改发给模型的。

做法：
- 先看 <latest_reply>：照回复里真实的写法写表达式（标签名、括号、换行、全角半角），不凭空猜格式。
- 表达式要稳：跨行的内容用 [\\s\\S]*? 非贪婪匹配；不要嵌套的量词（像 (a+)+、(.*)*），会卡住；一般加 g 标志。
- 替换成要有样式的 HTML 时，用 <div style="…">…</div> 这样的块级元素：这个应用把含 div、table、details、style 的段落放进单独的框里显示，样式都留着；夹在一行文字中间的 <span style="…"> 会被去掉样式，只剩文字。不写 <script>；颜色选在浅色和深色背景上都看得清的。
- 只动需要动的脚本；用户没提到、也不冲突的一字不动。
- 用户只是问问题、要你解释某条在做什么、或者问为什么不生效，就在 <reply> 里回答；能修好就给出改好的脚本。要求含糊时，按最可能的意思做，在 <reply> 里说你是怎么理解的。
- 要改的脚本这次没有附上替换内容，就不能改它的替换：在 <reply> 里说。新脚本一次最多 ${NEW_MAX} 条。

回答先写一段 <reply>，再写每一处改动；标签外不写别的：
<reply>
对用户说的话，用${reply}，两到四句：改了哪里、为什么这样改；回答问题可以写长一些。
</reply>
<regex id="已有脚本的 id">
<find>/改好的表达式/g</find>
<replace>改好的替换内容</replace>
</regex>
<regex id="另一条的 id" enabled="false"></regex>
<new_regex name="名字" on="ai" effect="display">
<find>/表达式/g</find>
<replace>替换内容</replace>
</new_regex>
<remove_regex id="不要了的那条的 id"></remove_regex>

- regex 改已有脚本：写 id；要改名字、作用于、效果或开关，再加 name="…"、on="…"、effect="…"、enabled="true" 或 "false"。查找和替换哪个没改就不写哪个。
- 替换内容写完整，不写省略号，不写「其余不变」。没改的脚本不要输出。`

/**
 * The request for one edit of a scope's scripts. `context.sample`: the chat's
 * latest reply, to write the patterns against. Returns { request, shown }.
 */
export function regexEditRequest(subject, { text, target = '', turns = [], reply = '简体中文', name = '', context = null } = {}) {
  const shown = shownScripts(subject.scripts, `${text}\n${target}`, target)
  const history = historyLines(turns)
  const sample = context?.sample ? context.sample.slice(-SAMPLE_MAX) : ''
  const content = [
    `<regexes scope="${attr(name)}">\n${scriptBlock(subject.scripts, shown)}\n</regexes>`,
    sample ? `<latest_reply>\n${sample}\n</latest_reply>` : '（这个对话还没有回复可以对照）',
    history.length ? `之前的几次修改（上面的脚本已经是处理之后的样子）：\n${history.join('\n')}` : '',
    `这次的要求：\n${text}`,
    target.startsWith('regex:') ? `只改 <regex id="${target.slice(6)}"> 这一条，别的不动。` : '',
  ].filter(Boolean).join('\n\n')
  return { request: { system: regexSystem(reply), messages: [{ role: 'user', content }], maxTokens: LONG_TOKENS, softCap: true }, shown: [...shown] }
}

const inner = (body, tag) => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`, 'i').exec(body)
  return match ? match[1].replace(/^\n|\n$/g, '') : null
}
const flag = value => (value === 'true' ? true : value === 'false' ? false : null)

/**
 * An answer → { reply, changes }. A change is
 *   { id, kind: 'regex', sid, title, on, effect, findBefore, findAfter, replaceBefore, replaceAfter, name?, newOn?, newEffect?, enabled?, invalid? }
 *   { id, kind: 'newRegex', name, on, effect, find, replace, invalid? }
 *   { id, kind: 'removeRegex', sid, title, find, replace }
 * `invalid`: the pattern does not compile (it cannot be taken). Scripts not
 * sent in full keep their replacement; with a `target` only that one is read.
 */
export function readRegexEdit(text, subject, { shown = null, target = '' } = {}) {
  const { reply, blocks } = readBlocks(text, ['regex', 'new_regex', 'remove_regex'])
  const changes = new Map()
  let fresh = 0
  for (const { tag, attrs, body } of blocks) {
    if (tag === 'new_regex') {
      const find = inner(body, 'find')?.trim()
      if (!find || fresh >= NEW_MAX) continue
      const id = `new:${fresh++}`
      changes.set(id, {
        id,
        kind: 'newRegex',
        name: String(attrs.name ?? '').trim().slice(0, 80),
        on: Object.hasOwn(ON, attrs.on) ? attrs.on : 'ai',
        effect: EFFECTS.includes(attrs.effect) ? attrs.effect : 'display',
        find,
        replace: inner(body, 'replace') ?? '',
        ...(regexFromString(find) ? {} : { invalid: true }),
      })
      continue
    }
    const script = subject.scripts.find(s => s.id === String(attrs.id ?? '').trim())
    if (!script) continue
    if (tag === 'remove_regex') {
      changes.set(`remove:${script.id}`, { id: `remove:${script.id}`, kind: 'removeRegex', sid: script.id, title: script.scriptName || script.findRegex, find: script.findRegex, replace: script.replaceString })
      continue
    }
    const find = inner(body, 'find')?.trim()
    const replace = shown && !shown.includes(script.id) ? null : inner(body, 'replace')
    const change = {
      id: `regex:${script.id}`,
      kind: 'regex',
      sid: script.id,
      title: script.scriptName || script.findRegex,
      on: onOf(script),
      effect: effectOf(script),
      findBefore: script.findRegex,
      findAfter: find || script.findRegex,
      replaceBefore: script.replaceString,
      replaceAfter: replace ?? script.replaceString,
    }
    const name = String(attrs.name ?? '').trim().slice(0, 80)
    if (name && name !== script.scriptName) change.name = name
    if (Object.hasOwn(ON, attrs.on) && attrs.on !== change.on) change.newOn = attrs.on
    if (EFFECTS.includes(attrs.effect) && attrs.effect !== change.effect) change.newEffect = attrs.effect
    const enabled = flag(String(attrs.enabled ?? '').trim().toLowerCase())
    if (enabled !== null && enabled === script.disabled) change.enabled = enabled
    if (!regexFromString(change.findAfter)) change.invalid = true
    const moved = change.findAfter !== change.findBefore || change.replaceAfter !== change.replaceBefore
    if (moved || change.name || change.newOn || change.newEffect || change.enabled !== undefined) changes.set(change.id, change)
  }
  const list = [...changes.values()]
  return { reply, changes: target ? list.filter(change => change.id === target) : list }
}

/** A proposed script as it would be kept (a changed one over the one it replaces). */
export function scriptOf(change, current = null) {
  const on = change.newOn ?? change.on
  const effect = change.newEffect ?? change.effect
  return {
    ...(current ?? { id: '', trimStrings: [], substituteRegex: 0, minDepth: null, maxDepth: null }),
    scriptName: change.name ?? current?.scriptName ?? '',
    findRegex: change.findAfter ?? change.find,
    replaceString: change.replaceAfter ?? change.replace,
    placement: [...ON[on], ...(current?.placement ?? []).filter(p => p !== PLACEMENT.AI_OUTPUT && p !== PLACEMENT.USER_INPUT)],
    markdownOnly: effect === 'display',
    promptOnly: effect === 'prompt',
    disabled: change.enabled === undefined ? current?.disabled === true : !change.enabled,
  }
}

/** Each proposed pattern tried on the latest reply (`context.sample`): what it matches and what that becomes. */
export async function tryChanges(changes, context, signal) {
  const sample = context?.sample ?? ''
  if (!sample) return changes
  const out = []
  for (const change of changes) {
    if ((change.kind !== 'regex' && change.kind !== 'newRegex') || change.invalid) {
      out.push(change)
      continue
    }
    out.push({ ...change, trial: await tryScript({ ...scriptOf(change), disabled: false }, sample, { signal }) })
  }
  return out
}

/**
 * The chosen changes (by id) into the scope's scripts, in place; one whose
 * pattern does not compile is skipped. Returns how many went in and whether any
 * changes what the model reads (`prefix`: the next turn writes the cache again).
 */
export function applyRegexChanges(subject, changes, ids) {
  const chosen = changes.filter(change => ids.includes(change.id) && !change.invalid)
  let prefix = false
  let applied = 0
  subject.scripts = subject.scripts.flatMap(script => {
    const change = chosen.find(c => c.sid === script.id)
    if (!change) return [script]
    applied++
    prefix ||= touchesPrompt(script)
    if (change.kind === 'removeRegex') return []
    const next = scriptOf(change, script)
    prefix ||= touchesPrompt(next)
    return [next]
  })
  for (const change of chosen.filter(c => c.kind === 'newRegex')) {
    const script = scriptOf(change)
    subject.scripts.push(script)
    prefix ||= touchesPrompt(script)
    applied++
  }
  return { applied, prefix }
}
