// 定制外观 (状态栏 → 定制外观): a look for one card's status bar, written by a model as CSS. The program still draws
// the bar and fills in the variables (web/status.js); the model only dresses it, with three colors and the rules. What
// it writes is kept only as far as it may dress the bar (web/shared/status.js cleanSkinCss), and the page draws it
// before the user sees it, to say what overflows or cannot be read (web/card-check.js); those go back here to be put
// right. Nothing is in the card until the user saves the bar.
import { EFFECTS, MAX_SKIN, cleanEffect, cleanPalette, cleanSkinCss, phoneApps, skinCut, statusGroups, statusPages, onPage } from '../../web/shared/status.js'
import { attr } from './blocks.mjs'
import { looseJson, section } from './prompts.mjs'

// The answer, thinking included: the rules are a few thousand tokens, a model that thinks first as much again.
export const SKIN_TOKENS = 20000
/** What an answer comes to, for the estimate before anything is sent (real ones: 7 000 with a cover to dress). */
export const SKIN_OUTPUT = 7500
const MAX_WISH = 600
const MAX_PROBLEMS = 12
const MAX_ROWS = 60
const FIRST_COLORS = { bg: '#f7f8f5', ink: '#1c2427', accent: '#2b5869' }

const clip = (text, max) => {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim()
  return words.length > max ? `${words.slice(0, max)}…` : words
}

const skinSystem = reply => `你给一张角色卡的状态栏设计外观。状态栏显示在每条回复下面，结构和里面的数据由程序画好，你只写 CSS，给它换一身和这张卡的气氛相称的样子：要像这张卡自己的界面，不是哪张卡都能用的面板。

状态栏的结构（类名固定，元素不能加也不能减）：
.status-bar                          整个状态栏，折叠时带 .collapsed
  .status-head                       顶上一行
    .status-title                    标题
    .status-toggle                   「收起 / 展开」按钮
  .status-pages > .status-page       分页的页签，选中的带 [aria-selected="true"]（分了页才有）
  .status-body                       内容；几组并排时带 .multi
    .status-tabs > .status-tab       组很多时切换看哪一组，选中的带 [aria-pressed="true"]
    .status-group[data-name="组名"]   一个人或一组
      .status-group-name             这一组的名字
      .status-rows                   这一组的各行（行多时带 .wide，排成几列）
        .status-section              组里的小标题
        .status-row[data-show="显示方式"][data-label="短名"]   一行；这一轮变了的带 .changed，整行占满的带 .block
          .status-label              这一项的名字
          后面的内容按显示方式不同：
          meter  → .status-meter > i（i 的宽度是百分比，由程序定），再一个 .status-value（数字，里面可能有 .status-delta.up 或 .down）
          number、text → .status-text
          rating → .status-stars（★☆ 这样的文字）
          badge  → .status-tags > .status-badge
          tags   → .status-tags > .status-tag（这一轮新加的带 .new）
          flag   → .status-flag（是的时候带 .on）
          long   → .status-long
          list   → ul.status-list > li
          stats  → .status-stats > .status-stat（里面是 .status-label 和 .status-value）
          table  → .status-table-wrap > table.status-table（thead th、tbody th、td）
.status-none 是「无」这类占位的字。
有的卡还有下面几块（没有就不用写）：
.status-art                          顶上的一条图：.status-portrait（立绘）、.status-art-name（名字）、.status-art-place（地名），不要盖住它
.status-dock > .status-app           「小手机」的一排图标：里面是 .status-app-icon 和 .status-app-name，点开的带 [aria-expanded="true"]
.status-phone > .status-phone-frame  点开的小手机：.status-phone-head（.status-phone-back、.status-phone-name）、.status-phone-screen（里面还是 .status-group 和各行）、.status-phone-home

颜色：先定三个颜色（背景、文字、强调），写在 <palette> 里。程序由它们算出下面这些变量放在 .status-bar 上，CSS 里尽量用它们，不要在 .status-bar 上重新定义它们：
--surface 背景，--ink 文字，--accent 强调，--muted 次要的字，--faint 更淡的字，--line-soft 细线，--meter-track 进度条的底，--accent-soft 强调色的淡底，--ok 和 --bad 是「是」和增减用的绿和红。
另外要用的颜色可以直接写，但每一处的字和它的底色要分得清。

能用的：边框、圆角、阴影、渐变背景、字体（只用系统里常见的字体族，写上后备）、字距、间距、分隔线、::before 和 ::after 里用 content 加的符号和纹饰、进度条、标签、徽章、表格的样子、按 [data-label="…"] 给某一项单独的颜色、hover 和过渡、克制的 @keyframes 动画、@media (max-width: 480px) 里给窄屏的调整。

写了会被程序去掉的：url() 和一切要加载的图片、字体，@import，@font-face，position: fixed 和 sticky，!important，规则里再套规则，html、body、:root 和状态栏以外的东西。

要守住的：
- 不改 .status-meter > i 的 width；不把内容藏起来（display: none、visibility: hidden、小于 11px 的字、淡到看不清的字都不行）。
- 手机上状态栏只有 320 到 400 像素宽：不写死宽度，不能横向撑出去，长的文字要能换行。
- ::before、::after 的纹饰用 position: absolute 时要留在状态栏里面，不盖住字，并写 pointer-events: none。
- 这张卡用到的每一种显示方式都要照顾到，没用到的不用写。
- 一共不超过 ${MAX_SKIN} 字，不写注释。

动效：程序能在状态栏上画一层飘动的东西，从 ${EFFECTS.join('、')} 里挑一个最合这张卡气氛的写在 <effect> 里（依次是雨、雪、花瓣、火星、萤火、星光、浮尘）；都不合适就写 none。它很淡，在所有内容的下面，你的 CSS 不用管它，但 .status-bar 的背景不要用 z-index 压到负数。

回答只写这五段，标签外不写别的：
<reply>对用户说的话，用${reply}，一两句：这套外观是什么感觉，取了这张卡的什么。</reply>
<name>外观的名字，两到六个字</name>
<palette>{"bg": "#101820", "ink": "#f2f2f2", "accent": "#e0a030"}</palette>
<effect>rain</effect>
<css>
全部 CSS
</css>`

const valueOf = row => {
  if (row.show === 'meter' || row.show === 'number') return row.words ?? String(row.value ?? '')
  if (row.show === 'rating') return `${row.value}/${row.max}`
  if (row.show === 'tags') return row.tags.slice(0, 6).join('、') || '无'
  if (row.show === 'list') return `${row.items.length} 条`
  if (row.show === 'stats') return row.stats.slice(0, 6).map(stat => `${stat.label} ${stat.value}`).join('、')
  if (row.show === 'table') return `${row.table.rows.length} 行${row.table.columns.length ? `，列：${row.table.columns.slice(0, 6).join('、')}` : ''}`
  if (row.show === 'flag') return row.on ? '是' : '否'
  return clip(row.text, 40) || '（空）'
}

/** The bar as it shows at the start, in lines: what there is to dress. */
export function barOutline(spec, state) {
  const pages = statusPages(spec)
  const lines = [spec.title ? `标题：${spec.title}` : '', pages.length ? `分页：${pages.join('、')}` : ''].filter(Boolean)
  let rows = 0
  const outline = (shown, indent) => {
    for (const group of statusGroups(shown, state)) {
      if (rows >= MAX_ROWS) break
      lines.push(`${indent}${group.name || '（不分组）'}`)
      for (const row of group.rows) {
        if ((rows += 1) > MAX_ROWS) break
        lines.push(`${indent}  ${row.label} · ${row.show} · ${valueOf(row)}`)
      }
    }
  }
  if (pages.length) {
    for (const page of pages) {
      lines.push(`[${page}]`)
      outline(onPage(spec, page, pages), '  ')
    }
  } else outline(spec, '')
  if (rows > MAX_ROWS) lines.push('（还有更多行，样子同上）')
  // 小手机: which of the above are not on the bar's face. Said, so that the icons and the phone get dressed too
  // (five looks asked without it left them as they come).
  const apps = spec.phone ? phoneApps(spec).apps.map(app => app.name) : []
  if (apps.length) lines.push(`这张状态栏开了「小手机」：${apps.join('、')} 不直接摆在状态栏上，各是一个图标（.status-dock 里的 .status-app），点开在小手机（.status-phone-frame）里看。图标和小手机也要写样式，和状态栏是一套。`)
  return lines.join('\n')
}

function cardLines(card) {
  const first = String(card.firstMes ?? '')
  return [
    `<card name="${attr(card.name)}">`,
    Array.isArray(card.tags) && card.tags.length ? `标签：${card.tags.slice(0, 12).join('、')}` : '',
    clip(card.description, 1200),
    card.scenario ? `场景：${clip(card.scenario, 400)}` : '',
    first ? `开场白的开头：${clip(first.replace(/<[^>]{0,200}>/g, ' '), 500)}` : '',
    '</card>',
  ].filter(Boolean).join('\n')
}

// 开场页: a card that has one gets it dressed with the bar (the same colors, the same sheet), so the two are one set.
const COVER_PART = `<cover_page>
这张卡还有一页「开场页」，显示在新对话的开场白上面，和状态栏用同一套颜色变量。也给它写样式，让它和状态栏是一套东西。它的结构（类名固定，元素不能加减）：
.cover                        整页（没有图片时带 .plain，有立绘时带 .has-figure）
  .cover-main                 左边的字：.cover-kicker（一行小字）、.cover-title（卡名，每个字一个 span）、.cover-rule（一道短线）、.cover-tagline（一句话）、.cover-lines > li（几行简介）
  .cover-figure               立绘的框，里面是 img
  .cover-doors > .cover-door  开场的卡片（是按钮）：.cover-door-no、.cover-door-title、.cover-door-brief；选中的带 .picked
  .cover-hint                 底下一行小字
开场页自己有背景图层（.cover-back、.cover-veil）和飘动的一层，不要盖住、不要藏；每一处的字和它后面的底色要分得清；手机上它只有 320 到 400 像素宽。给开场页的规则控制在全部的四分之一以内。
</cover_page>`

/** What the user asked for, as the model is told it. */
export const cleanWish = wish => clip(typeof wish === 'string' ? wish : '', MAX_WISH)

/** What the page found when it drew a look, as lines to put right. */
export const cleanProblems = problems => (Array.isArray(problems) ? problems : []).filter(item => typeof item === 'string' && item.trim()).slice(0, MAX_PROBLEMS).map(item => clip(item, 200))

/**
 * The request for a look.
 * @param spec - the bar it is for (what the editor shows now), cleaned
 * @param state - the variables as they start
 * @param options - { wish, previous: a look to work from ({ name, palette, css }), problems: what drawing it showed, reply }
 */
export function skinRequest(card, spec, state, { wish = '', previous = null, problems = [], reply = '简体中文' } = {}) {
  const current = previous?.css
    ? `<current name="${attr(previous.name ?? '')}">\n<palette>${JSON.stringify(previous.palette ?? spec.palette ?? FIRST_COLORS)}</palette>\n<css>\n${previous.css}\n</css>\n</current>`
    : ''
  const ask = problems.length
    ? `<current> 是你上一次写的外观。程序把它画出来后查出下面这些问题，把它们改掉，其余的保持原样，再把四段完整写一遍：\n${problems.map(item => `- ${item}`).join('\n')}`
    : current
      ? `<current> 是现在的外观。${wish ? `用户想在它的基础上改：${wish}` : '用户想要再设计一版，和它明显不同。'}`
      : wish
        ? `用户想要的样子：${wish}`
        : '用户没有说想要什么样子，按这张卡的气氛定。'
  const content = [cardLines(card), `<status_bar>\n这张卡的状态栏开局时是这样的（每行：短名 · 显示方式 · 现在的值）：\n${barOutline(spec, state)}\n</status_bar>`, card.cover ? COVER_PART : '', current, ask].filter(Boolean).join('\n\n')
  return { system: skinSystem(reply), messages: [{ role: 'user', content }], maxTokens: SKIN_TOKENS, softCap: true }
}

const unfenced = text => String(text ?? '').replace(/^\s*```[\w-]*[ \t]*\n?/, '').replace(/\n?```\s*$/, '').trim()

/**
 * An answer as a look: { reply, name, palette, css, cut } with the CSS as a card may keep it; null when there is no
 * CSS left to use. `cut`: what the model wrote that was taken out (it was told not to), for the page to say so.
 */
export function readSkin(text, { palette: fallback = null } = {}) {
  const source = String(text ?? '')
  const written = unfenced(section(source, 'css') || /```css\s*\n([\s\S]*?)(?:```|$)/i.exec(source)?.[1] || '')
  const css = cleanSkinCss(written)
  if (!css) return null
  const cut = [
    /url\s*\(|image-set\s*\(/i.test(written) ? 'url' : '',
    /@import|@font-face/i.test(written) ? 'import' : '',
    /position\s*:\s*(?:fixed|sticky)/i.test(written) ? 'fixed' : '',
    // Longer than a look may be: the rules past the limit are not in it (the page says so, and it can be asked again shorter).
    skinCut(written) ? 'long' : '',
  ].filter(Boolean)
  return {
    reply: clip(section(source, 'reply'), 600),
    name: clip(section(source, 'name'), 24).replace(/^[「『"“]|[」』"”]$/g, ''),
    palette: cleanPalette(looseJson(section(source, 'palette'))) ?? cleanPalette(fallback) ?? FIRST_COLORS,
    // 动效 picked with the look ('' = none, or none said).
    effect: cleanEffect(section(source, 'effect').trim().toLowerCase()),
    css,
    cut,
  }
}
