// 对话修改 for the page's colours (主题 → 对话修改): the user names a mood or a
// look (水墨, 赛博朋克, 「强调色换成红的」), the model writes a palette for light
// and one for dark — the twelve colours a style sets (web/shared/appearance.js) —
// and, when asked, a prompt for a picture behind the page, drawn with the 画图方式
// set up. The page shows each palette with what is hard to read in it and can
// preview it; the ones kept become the custom style.
import { PALETTE_KEYS, cleanColor, cleanCustom, cleanPalette, paletteIssues } from '../../web/shared/appearance.js'
import { historyLines, readBlocks } from './blocks.mjs'

const MODES = ['light', 'dark']

const paletteText = palette => PALETTE_KEYS.map(key => `${key}: ${palette[key]}`).join('\n')

/** The colours on screen as the page sent them (both modes), or none. */
export function cleanThemeContext(value) {
  const palette = cleanCustom(value?.palette)
  return palette ? { palette } : null
}

const themeSystem = reply => `你是界面配色师。CicaTavern 是一个读故事、和角色聊天的应用，界面像一本在灯下读的书。一套配色是十二个颜色，浅色和深色各一套：
- bg 页面底色；pane 侧栏底色（和 bg 只差一点）；surface 正文纸面、卡片、对话框；raised 浮起的面板（比 surface 亮一点）；
- line 分隔线；line-soft 更淡的分隔线；
- ink 正文文字；muted 次要文字；faint 最淡的提示文字；
- accent 按钮、链接、选中的颜色；accent-ink 写在 accent 上的文字；lamp 对白的高亮（像灯光的暖色）。

要求：
- 浅色和深色是同一个调子；深色不用纯黑，浅色不用纯白。
- 字要好认：ink 对 surface、对 bg 至少 4.5:1；muted 对 surface 至少 3:1；accent 对 surface 至少 3:1；accent-ink 对 accent 至少 4.5:1；lamp 对 surface 至少 3:1。
- 大面积的颜色（bg、pane、surface、raised、line）要安静、饱和度低，看久了不累；个性放在 accent 和 lamp 上。
- 用户只想改一部分（比如「强调色换成红的」），只动那几个颜色，其余照抄现在的。
- 用户要背景图时才写 <backdrop>：一段英文的画图提示词，画面安静、没有人、没有文字、不抢正文，适合铺在界面后面。
- 用户只是问问题，就在 <reply> 里回答，不输出配色。

回答先写一段 <reply>，再写配色；标签外不写别的：
<reply>
对用户说的话，用${reply}，两三句：这套配色是什么意思、哪里对上了用户说的。
</reply>
<palette mode="light">
${PALETTE_KEYS.map(key => `${key}: #rrggbb`).join('\n')}
</palette>
<palette mode="dark">
（同样十二行）
</palette>
<backdrop>English prompt for the picture</backdrop>`

/** The request: the colours on screen (`context.palette`) and what the user wants. */
export function themeEditRequest(subject, { text, turns = [], reply = '简体中文', context = null } = {}) {
  const current = context?.palette ?? cleanCustom(subject.custom)
  const history = historyLines(turns)
  const content = [
    current ? `现在的配色：\n<palette mode="light">\n${paletteText(current.light)}\n</palette>\n<palette mode="dark">\n${paletteText(current.dark)}\n</palette>` : '',
    subject.backdrop ? '现在界面后面有一张背景图。' : '',
    history.length ? `之前的几次修改（上面已经是处理之后的样子）：\n${history.join('\n')}` : '',
    `这次的要求：\n${text}`,
  ].filter(Boolean).join('\n\n')
  return { request: { system: themeSystem(reply), messages: [{ role: 'user', content }], maxTokens: 2000 }, shown: [] }
}

/**
 * An answer → { reply, changes }. A change is
 *   { id: 'palette:light' | 'palette:dark', kind: 'palette', mode, before, after, base, issues }
 *   { id: 'backdrop', kind: 'backdrop', prompt }
 * A colour the answer leaves out keeps the one on screen; `base` is both
 * palettes on screen, for the mode not taken.
 */
export function readThemeEdit(text, subject, { context = null } = {}) {
  const { reply, blocks } = readBlocks(text, ['palette', 'backdrop'])
  const base = context?.palette ?? cleanCustom(subject.custom)
  const changes = []
  for (const { tag, attrs, body } of blocks) {
    if (tag === 'backdrop') {
      const prompt = body.replace(/\s+/g, ' ').trim().slice(0, 1200)
      if (prompt && !changes.some(c => c.kind === 'backdrop')) changes.push({ id: 'backdrop', kind: 'backdrop', prompt })
      continue
    }
    const mode = String(attrs.mode ?? '').trim().toLowerCase()
    if (!MODES.includes(mode) || changes.some(c => c.id === `palette:${mode}`)) continue
    const written = Object.fromEntries([...body.matchAll(/^\s*([a-z-]+)\s*[:：=]\s*(#[0-9a-f]{3,6})\b/gim)].map(([, key, color]) => [key.toLowerCase(), cleanColor(color)]))
    const after = cleanPalette(written, base?.[mode])
    if (!after) continue
    const before = base?.[mode] ?? null
    if (before && PALETTE_KEYS.every(key => before[key] === after[key])) continue
    changes.push({ id: `palette:${mode}`, kind: 'palette', mode, before, after, base, issues: paletteIssues(after) })
  }
  return { reply, changes }
}

/**
 * @param deps - { drawBackdrop(prompt, signal) → { buffer }, storeBackdrop(buffer) → file name }
 * → apply(subject, changes, ids): the chosen palettes become the custom style (a
 * mode not chosen keeps what is on screen), a chosen picture is drawn and put
 * behind the page. Nothing a chat sends changes.
 */
export function themeApplier({ drawBackdrop, storeBackdrop }) {
  return async function applyThemeChanges(subject, changes, ids) {
    const chosen = changes.filter(change => ids.includes(change.id))
    let applied = 0
    const palettes = chosen.filter(c => c.kind === 'palette')
    if (palettes.length) {
      const base = palettes[0].base ?? cleanCustom(subject.custom) ?? {}
      const custom = { light: base.light, dark: base.dark }
      for (const change of palettes) custom[change.mode] = change.after
      if (cleanCustom(custom)) {
        subject.custom = custom
        subject.style = 'custom'
        applied += palettes.length
      }
    }
    const picture = chosen.find(c => c.kind === 'backdrop')
    if (picture) {
      const { buffer } = await drawBackdrop(picture.prompt, AbortSignal.timeout(600000))
      subject.backdrop = await storeBackdrop(buffer)
      applied++
    }
    return { applied, prefix: false }
  }
}
