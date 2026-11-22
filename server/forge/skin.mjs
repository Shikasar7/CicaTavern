// 定制外观 (状态栏 → 定制外观): a look for one card's status bar, written by a model as CSS. The program still draws
// the bar and fills in the variables (web/status.js); the model only dresses it, with three colors and the rules. What
// it writes is kept only as far as it may dress the bar (web/shared/status.js cleanSkinCss), and the page draws it
// before the user sees it, to say what overflows or cannot be read (web/card-check.js); those go back here to be put
// right. Nothing is in the card until the user saves the bar.
import { EFFECTS, MAX_SKIN, cleanDecor, cleanEffect, cleanPalette, cleanSkinCss, phoneApps, skinCut, statusGroups, statusPages, onPage } from '../../web/shared/status.js'
import { attr } from './blocks.mjs'
import { looseJson, section } from './prompts.mjs'
import { cleanStyle, styleBlock, styleName } from './skin-styles.mjs'
import { themeRules } from './status-frame.mjs'

// The answer, thinking included: the rules and the pictures drawn in them are many thousand tokens, a model that thinks
// first as much again.
export const SKIN_TOKENS = 32000
/** What an answer comes to, for the estimate before anything is sent (real ones: 7 000 with a cover to dress, more with pictures). */
export const SKIN_OUTPUT = 11000
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
.status-phone > .status-phone-frame  点开的小手机：.status-phone-top（顶上的听筒条）、.status-phone-head（.status-phone-back、.status-phone-name）、.status-phone-screen（里面还是 .status-group 和各行）、.status-phone-home（底下的小横条）

程序已经排好的（你看不到程序的样式表，这些照着用，不要另排）：
- .status-bar 里的各块（.status-head、.status-pages、.status-art、.status-body、.status-dock、.status-phone）从上到下一块接一块，顺序固定。不要用 position、float、order、transform、负的 margin 去挪它们，也不要把 .status-bar 改成 grid 或 flex 来重排：写了不生效。图标那一排始终在内容下面，小手机始终在图标下面，左边和图标对齐。
- .status-bar 默认的内边距是 14px 16px 16px。要让哪一块（比如标题那一行）贴到状态栏的边，先自己把 .status-bar 的 padding 写成明确的数，再用同样的数做左右对称的负 margin；左右两边的数必须一样。
- .status-body.multi（几组并排）和 .status-rows.wide（一组里行多）是自己会折行的网格：宽的时候几列，窄的时候一列。要改列数，写 grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)) 这种自己会折行的，不要写死 1fr 1fr 再用 @media 改回来：状态栏在电脑上也可能只有三百多像素宽（放在侧栏里），@media 看的是窗口的宽度，不是状态栏的。
- .status-row 是三列的网格：名字、内容、数值（没有数值的行内容占满后两列）。可以改列宽和间距，不要改成别的排法。
- .status-app 的图标 44px 见方，名字在图标下面一行，第一个图标的左边和上面的字对齐；选中的图标程序用一圈描边（box-shadow）标出来，选中和没选中的大小要一样（不要只给选中的加 padding 或边框，会把旁边的挤歪）。
- .status-phone-frame 最宽 360px，自己没有内边距，超出圆角的部分会被裁掉；里面四块上下排列，.status-phone-head 和 .status-phone-screen 左右各有 16px 内边距，所以文字是对齐的。给 .status-phone-head 加底色就是一条贴边的标题条，不需要负 margin；要给整块屏幕留边，改 .status-phone-frame 的 padding，四块会一起缩进。.status-phone-home 是居中的一条，只改它的宽、高、颜色和圆角。
- 同一层的东西用同一个缩进：标题、各行、图标、小手机里的字，左边都从同一条线起；圆角里面套圆角时，里面的要小一些（外圆角减去间距）。

做得精致靠的是这几样：
- 间距只用一套数（4、8、12、16、24 像素里挑），同一种东西之间的间距处处一样，不要这里 7 那里 9。
- 字的大小最多三四档（标题、正文、次要的小字），靠大小、粗细和深浅分层级，不靠五颜六色；数字用等宽数字（font-variant-numeric: tabular-nums），上下几行才对得齐。
- 强调色只用在少数几处：标题、进度条、这一轮变了的、选中的。大片的底色、每一行的边框都用它，就哪里都不突出了。
- 圆角定一个基数，状态栏、里面的框、标签和徽章按大小递减；同一种东西圆角一样。
- 阴影只用淡的、不带颜色的，表示「浮在上面」；不用发光的彩色阴影，也不要每一层都加边框再加阴影，线和框越少越干净。
- 框里不要再套框：组和组之间用留白或一条细线分开就够了。

颜色：先定三个颜色（背景、文字、强调），写在 <palette> 里。程序由它们算出下面这些变量放在 .status-bar 上，CSS 里尽量用它们，不要在 .status-bar 上重新定义它们：
--surface 背景，--ink 文字，--accent 强调，--muted 次要的字，--faint 更淡的字，--line-soft 细线，--meter-track 进度条的底，--accent-soft 强调色的淡底，--ok 和 --bad 是「是」和增减用的绿和红。
另外要用的颜色可以直接写，但每一处的字和它的底色要分得清。

能用的：边框、圆角、阴影、渐变背景、字体（只用系统里常见的字体族，写上后备）、字距、间距、分隔线、::before 和 ::after 里用 content 加的符号和纹饰、进度条、标签、徽章、表格的样子、按 [data-label="…"] 给某一项单独的颜色、hover 和过渡、克制的 @keyframes 动画、mask-image、mix-blend-mode、clip-path、@media (max-width: 480px) 里给窄屏的小调整（字号、间距；列数不要靠它），还有下面说的画图和鼠标。

画图：CSS 里可以直接写 SVG 小图，渐变拼不出来的东西靠它画：远山、太阳、笔触、仪表、城市剪影、像素小人、花草、印章、角花。一套好看的外观通常有一幅招牌画面（标题区或状态栏一角的一幅小画）加两三样小纹饰。
- 写法：url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>…</svg>")。整段在双引号里，SVG 里的属性用单引号；# 一律写成 %23（颜色 %23e1111c，引用 url(%23g)）。可以和渐变叠在同一个 background 里，也能用在 mask-image、border-image-source、list-style-image 和 ::before、::after 上。
- 能用的元素：svg、g、defs、symbol、use（只引用这张图里的 #id）、path、rect、circle、ellipse、line、polyline、polygon、text、tspan、linearGradient、radialGradient、stop、pattern、clipPath、mask、marker、filter，滤镜 feTurbulence、feDisplacementMap、feGaussianBlur、feColorMatrix、feComponentTransfer（feFuncR、feFuncG、feFuncB、feFuncA）、feComposite、feBlend、feMerge、feMergeNode、feOffset、feFlood、feMorphology、feDropShadow、feSpecularLighting、feDiffuseLighting 和光源。feTurbulence 加 feDisplacementMap 能做纸纹、墨晕、毛边、手抖的线、拉丝金属；feGaussianBlur 加 feMerge 能做辉光。
- 写了整张图会被去掉的：image、foreignObject、script、a、style 元素、动画元素、CDATA 和 DOCTYPE；style 属性和 on 开头的属性会被删掉，颜色和描边都用属性写（fill='…' stroke='…'）。每张图不超过 8000 字。
- 图会缩放：写好 viewBox，用 preserveAspectRatio 和 background-size、background-position 控制怎么摆。图里的字只写装饰性的（印章、招牌上的一两个字），数据一律留给程序画的元素。图在字的下面或旁边，不挡字。

鼠标：.status-bar 上有 --px、--py（鼠标在状态栏里的位置，像素）和 --pfx、--pfy（0 到 1），鼠标在状态栏上时它带 .pointing。可以用来做跟着鼠标的光、几层画面错开的视差、十字线；用的时候写默认值（var(--pfx, .5)），鼠标不在、手机上没有鼠标时也要好看。

写了会被程序去掉的：url() 里除了上面的 SVG 小图以外的一切（网上的图片、字体、别的格式的图），@import，@font-face，position: fixed 和 sticky，!important，规则里再套规则，html、body、:root 和状态栏以外的东西。

要守住的：
- 不改 .status-meter > i 的 width；不把内容藏起来（display: none、visibility: hidden、小于 11px 的字、淡到看不清的字都不行）。
- 手机上状态栏只有 320 到 400 像素宽：不写死宽度，不能横向撑出去，长的文字要能换行。
- ::before、::after 的纹饰用 position: absolute 时要留在状态栏里面，不盖住字，并写 pointer-events: none。用 content 写出来的一行字（编号、印章、英文小字）不要放在标题那一行里：窄的时候它会和标题、「收起」按钮叠在一起；放在角上别的空处，或者只用符号。
- 这张卡用到的每一种显示方式都要照顾到，没用到的不用写。
- 一共不超过 ${MAX_SKIN} 字，不写注释。

动效：程序能在状态栏上画一层飘动的东西，从 ${EFFECTS.join('、')} 里挑一个最合这张卡气氛的写在 <effect> 里（依次是雨、雪、花瓣、火星、萤火、星光、浮尘）；都不合适就写 none。它很淡，在所有内容的下面，你的 CSS 不用管它，但 .status-bar 的背景不要用 z-index 压到负数。

回答写这五段（下面另说的 <decor> 可以加在最后），标签外不写别的：
<reply>对用户说的话，用${reply}，一两句：这套外观是什么感觉，取了这张卡的什么。</reply>
<name>外观的名字，两到六个字</name>
<palette>{"bg": "#101820", "ink": "#f2f2f2", "accent": "#e0a030"}</palette>
<effect>rain</effect>
<css>
全部 CSS
</css>
<decor>{"corner": "英文的一句画图描述"}</decor>

<decor> 是可选的第六段：这套外观想用、要另外画的装饰图，每种一句英文画图描述（材料、颜色、纹样，和外观的配色一致），只写用得上的几种，用不上就不写这一段。能画的四种：texture（能平铺的方形底纹）、corner（透明底的角花，花在左上角）、divider（透明底的横向分隔线，长条）、emblem（透明底的小徽记）。画好以后在 CSS 里用 var(--pic-decor-corner, none) 这样的变量；画好以前它是空的，所以一定要写 none 作后备。`

// 外观的图: what each kind is, for the list the model is given.
const DECOR_WORDS = { texture: '底纹，能平铺的方形', corner: '角花，透明底，花在左上角', divider: '分隔纹，透明底的横长条', emblem: '徽记，透明底的小方块' }

/**
 * The <pictures> block: the card's own pictures a look may name (look-pictures.mjs offered), and how to use them; ''
 * with none. drawn: the decorations there are pictures for.
 */
export function picturesBlock(pictures = [], drawn = []) {
  if (!pictures.length) return ''
  const has = new Set(drawn)
  const line = item => {
    if (item.kind === 'decor') return `- ${item.token}：装饰图「${DECOR_WORDS[item.label] ?? item.label}」${has.has(item.token) ? '，已经画好' : '，还没画，画好以前是空的'}`
    if (item.kind === 'scene') return `- ${item.token}：场景「${item.label}」，横图`
    if (item.kind === 'sprite') return `- ${item.token}：「${item.label}」的立绘，竖图，背景透明`
    if (item.kind === 'cover') return `- ${item.token}：开场页的图，横图`
    return `- ${item.token}：这张卡的头像，竖图`
  }
  return `<pictures>
这张卡有自己的图，外观可以用。写法是 var(--名字, none)，比如 background-image: linear-gradient(rgba(16, 24, 32, 0.82), rgba(16, 24, 32, 0.82)), var(--pic-scene-15d494, none)。程序只给下面这些名字填图，别的名字没有图，url() 也会被去掉：
${pictures.map(line).join('\n')}
怎么用：
- 图只写在 background-image 里：状态栏、标题那一行、各块的底，或者 ::before、::after 的纹饰。
- 有字的地方，图上面先压一层不透明度至少 0.75 的渐变或底色，字才看得清；整张场景图当底时尤其要压暗或压淡。
- 立绘只放在不挡字的角上，用 opacity 调淡，background-size: contain，不要重复。
- 每个 var() 都写上 none 作后备：去掉所有的图，这套外观也要好看。
- 一套外观最多用四张图，不用也行。
</pictures>`
}

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
  // 版式: the bar is laid out another way, with blocks the list above does not have.
  if (spec.layout) lines.push(LAYOUT_NOTES[spec.layout])
  return lines.join('\n')
}

const LAYOUT_COMMON = '它的结构和上面的清单不同（类名固定）：.status-head 下面是 .status-rail（人和数值）和 .status-main（.status-pages 页签和 .status-body 内容），没有 .status-dock 和 .status-phone。.status-rail 里每个人是一个 .status-g（第一个带 .lead，有立绘时带 .has-pic，里面是 .status-pic 和 .status-g-main）；.status-g-main 里依次是 .status-who（.status-who-name 名字、.status-badge 心情这类短词）、.status-quote（一句内心）、.status-gauges > .status-gauge（一个数值：.status-label、.status-value、.status-meter > i）、.status-facts > .status-fact（.status-label 和 .status-fact-value）。页签是 .status-page，里面有 .status-page-icon。这些块怎么排由程序定，只改它们的颜色、边框、圆角、字体和间距，不要改 display、列数和顺序。'
const LAYOUT_NOTES = {
  card: `这张状态栏用的是「卡片式」版式：人在最前面（立绘、名字、心情、一句内心、数值条），没有立绘的人的数值是一张张小卡（.status-gauge 带底色和圆角），页签在最底下一排、带图标。${LAYOUT_COMMON}`,
  rail: `这张状态栏用的是「侧栏式」版式：.status-rail 在左边一条窄栏里（第一个人和他的数值一直在），.status-main 在右边（页签在上，内容在下）；窄的时候左栏折到上面。${LAYOUT_COMMON}`,
  scroll: `这张状态栏用的是「卷轴式」版式：.status-head 是一条横幅，有场景图时里面有 img.status-banner 和一层渐变（不要盖住、不要藏），标题用毛笔字，「收起」是右上角一枚印章；.status-facts 是横排的一行，没有立绘的人的每个 .status-gauge 是一块方牌，页签是一排方格。圆角都很小。${LAYOUT_COMMON}`,
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
开场页自己有背景图层（.cover-back、.cover-veil）和飘动的一层，不要盖住、不要藏；整页怎么排（.cover 的 display、列）由程序定，不要改，字从左边起；每一处的字和它后面的底色要分得清；手机上它只有 320 到 400 像素宽。给开场页的规则控制在全部的四分之一以内。
</cover_page>`

// 起点: a look can start from one of the themes and go over it. What each is, for the model (and its name, as the
// page says it). The theme's own rules go with it: the model writes only what it changes.
const THEME_WORDS = {
  editorial: ['文艺杂志', '日系杂志式的极简：近白透一点清水蓝的纸，大圆角，西文用高对比的衬线字、中文用细宋体，宽字距的小标题和小圆点，数值条是一根细线加一个小圆点；背景右上角一组淡淡的星图细线慢慢漂，左下角一道点线波纹'],
  meadow: ['晴野', '手绘绘本风：粗黑的手绘描边和卡通式的投影，圆圆胖胖的字（站酷快乐体和 Nunito，主题自带），黑色胶囊按钮、黄色徽章，心里话是对话气泡；云和太阳在右上角飘，底边是一条草地，有小花、蜗牛和打盹的小麻雀（这几张图是主题自带的）'],
  sigil: ['夜曜纹章', '西幻暗黑：黑曜石的底，鎏金细线和绯红魔纹，宋体，标题前的纹章会轻轻呼吸，数值条是绯红的，组名前一枚菱形'],
  daybreak: ['晨笺', '晨间手账：暖白的纸透一点晨曦的蓝和暖粉，左边竖排一个大衬线字，标题是雾蓝的大衬线字压着一行花体（花体是主题自带的字），右上角一轮刚升起的太阳和几圈细环，数值收在磨砂面板里，分组有斜体编号和带圆点的细线，数值条从雾蓝渐到暖粉'],
  aquarelle: ['天光云影', '水彩写生本：米白的水彩纸，手绘的墨线框四角交叉出头，顶上一幅跟着故事时间换的水彩天空（清晨、白天、黄昏、深夜四幅，是主题自带的图，强调色跟着变），楷体标题下一行斜体英文小句，数值条是一笔水彩，短词垫着一团水彩晕，角落一枝嫩叶'],
  cobalt: ['钴蓝', '单色孔版印刷：再生纸上只印一种钴蓝，标题反白压在一块蓝色标签上、后面一个错位的线框，旁边一个横切错开的蓝色圆盘和白色四角星、灰色块、细线，页和组自动编号，粗体窄字，实心蓝印章，数值条末端散成网点，立绘印成蓝白双色'],
  afterschool: ['放课后', '老招牌底下的一台千禧年游戏机菜单：标题是一块奶油色搪瓷招牌（边缘有点锈，番茄红的大字带一点录像带的色边，字用主题自带的站酷庆科黄油体），带条纹雨棚、录像带计数和橙色的相机日期；招牌以下整块是深蓝渐变的菜单底，奶油色加藏青的粗边框，每个分组是一个白边蓝玻璃窗、名字写在明黄的小牌子上，鼠标所在的一行有一个光标，数值条是绿和橙的像素格，心里话是带名牌和「▼」的视觉小说对话框，分页是 L / R 肩键页签，卡片式的数值卡是灰蓝色的存档格，底边一条按键提示；整体有扫描线和一条慢慢移动的录像带噪带，鼠标处有显像管反光和小星星'],
  lineart: ['线稿', '一整张工程图纸：暖灰的方格纸，四周一圈图框和分区号，底部有标题栏；标题区右边用近黑的均匀细线画着一台沿斜轴拆开的机器人（天线、带护目镜和一只红眼的头、波纹颈、肩梁、掀开的胸甲和带肋的核心、线缆、腰环、髋部齿轮、双腿、一条落到三指手的手臂），细引线拉到等宽小字上，鼠标移过时头和手臂沿轴线滑开，红色十字线和坐标读数跟着鼠标；标题是粗黑的无衬线字，标签是等宽字，页签是图纸标签，分组是带字母的引出圈加一条引线，数值条是两端带箭头的尺寸线（读数一端是红的），数值卡是写着 DETAIL 的局部详图，标签是打了孔的零件牌，收起按钮是带一根红线的深色刻度条'],
  signal: ['信号', '深夜的追踪屏：近黑的底只用一种薄荷绿和灰线，标题后面一片聚成云的小格子点阵、几格亮着错开闪动，方框带坐标读数、细线汇到「收起」旁的目标点，小标签是等宽大写加方框，分组写成 SECTOR 01 这样的扇区，数值条是一排格子、末端一道亮光标，数字是等宽字带一点辉光，短词装在左上角带切角的方框里。整条状态栏都是这块屏：四角有角标、两边有刻度，分组是带四角框的「[ SECTOR 01 ]」，每行前有小序号，页签是 CH01、CH02，底下一行链路状态；鼠标移到哪里，那里的小格亮起、十字线和准星跟着走（主题自己用 --px、--py 这些变量做的，改的时候留着）。'],
  mercury: ['流银', '液态金属：整条状态栏底下是一片实时流动的镀铬（程序画的，在 canvas.status-fx 里，标题区、两条边和底边露得最亮，面板之间调暗）；每个分组是一块浮在金属上的烟色玻璃面板，带一道亮边；标题和数字是抛光金属字，数值条是一管带高光的水银，徽章和选中的页签是镀铬胶囊，组名前一颗水银珠；只有银白灰黑。'],
  redink: ['赤墨', '暗黑撞色：只有黑、纸白和一种正红。粗颗粒的白纸，标题区是一排宽窄不一的黑色块，标题用毛笔字（马善政，主题自带）反白写在上面，一轮红日沉在色块后面，一道带飞白的红色笔触横扫过去，细圆圈、虚线和墨点压到黑块上就变成白的；左边一根黑柱从标题贯到底，上面竖排一行打字机小字，底边是干笔拖出的毛边；分组一白一黑交替（黑的是整块黑底白字、带红色错位影），每组背后压着巨大的淡红编号；标签是黑底白字的小块，数值条是一笔末端枯散的墨、停处一根红针，心情是斜盖的红印章，数值卡一黑一白反着来，立绘印成高反差黑白再压一道红斜杠'],
  kaleido: ['万华', '黑底撞色，贯穿整条状态栏：边框是一圈会随鼠标转动的虹彩；标题区是近黑的夜色，一道带颗粒的全色喷流从标题旁喷向远角，上面是红绿蓝错开的圆环、玻璃碎片和白色细弧线，底边还有第二道喷流涌向一个大圆环；每个分组是一块镶着自己颜色的黑玻璃（朱红、长春花蓝、紫、荧光绿、粉轮流），右上角切一片碎片，组名反黑压在斜切的色块上；数值条是粗的带颗粒渐变色条加白热的端头，短词是歪一点的套印色块，页签是色块、选中的是整条光谱；鼠标移过有一团棱镜光跟着走'],
}

/** The theme a look goes over, as the model is told it; '' for a look from nothing. */
function baseBlock(base) {
  const [name, words] = THEME_WORDS[base] ?? []
  if (!name) return ''
  return `<base_theme name="${name}">
这次不是从零设计：状态栏先穿着程序自带的主题「${name}」（${words}），你的 CSS 叠在它上面，做出这张卡自己的一版。
- 主题的样式表在下面，已经生效，不用重写。选择器里去掉了主题自己的类名，写法和你的一样；url(…) 是主题的图和画出来的纹饰，你看不到它们的内容；要换掉就写 background-image: none、别的渐变，或者你自己画的 SVG 小图。
- 只写要改和要加的：配色、纹饰、字体、边框、进度条、某几项的样子。想保留的就不写，不要把主题的规则抄一遍。你写的规则会盖过主题里同一处的规则。
- <palette> 可以不写：不写就用主题自己的颜色。写了，程序用它算出的颜色变量会盖过主题的，主题里用变量的地方跟着变；主题里写死的颜色（渐变、阴影、描边）要换的话自己再写。
- 主题自己定义的变量（--ed-latin、--mw-round 这样的）可以直接用。
- 主题在 ::before、::after 上的纹饰和动画，要去掉就写 content: none 或 animation: none。
- 留住主题的底子和好看的地方，再加上这张卡自己的气氛：要看得出是从「${name}」长出来的，又不是原样。
${themeRules(base)}
</base_theme>`
}

/** 起点 as a look keeps it: a theme it goes over, or '' (from nothing). */
export const cleanBase = base => (Object.hasOwn(THEME_WORDS, base) ? base : '')

export { cleanStyle }

/** What the user asked for, as the model is told it. */
export const cleanWish = wish => clip(typeof wish === 'string' ? wish : '', MAX_WISH)

/** What the page found when it drew a look, as lines to put right. */
export const cleanProblems = problems => (Array.isArray(problems) ? problems : []).filter(item => typeof item === 'string' && item.trim()).slice(0, MAX_PROBLEMS).map(item => clip(item, 200))

/**
 * The request for a look.
 * @param spec - the bar it is for (what the editor shows now), cleaned
 * @param state - the variables as they start
 * @param options - { wish, previous: a look to work from ({ name, palette, css }), problems: what drawing it showed, reply,
 *   pictures: the card's own pictures it may name (look-pictures.mjs offered), drawn: the decorations already drawn,
 *   base: the theme the look goes over ('' = from nothing), style: 风格, a way for it to go (skin-styles.mjs; '' = none) }
 */
export function skinRequest(card, spec, state, { wish = '', previous = null, problems = [], reply = '简体中文', pictures = [], drawn = [], base = '', style = '' } = {}) {
  const over = cleanBase(base)
  // A look being put right keeps the way it went: the style is not said again.
  const styled = problems.length ? '' : styleName(style)
  // Over a theme, a look without colors of its own has none to show: the theme's are used.
  const colors = previous?.palette ?? (over ? null : spec.palette ?? FIRST_COLORS)
  const current = previous?.css
    ? `<current name="${attr(previous.name ?? '')}">\n${colors ? `<palette>${JSON.stringify(colors)}</palette>\n` : ''}<css>\n${previous.css}\n</css>\n</current>`
    : ''
  const ask = problems.length
    ? `<current> 是你上一次写的外观。程序把它画出来后查出下面这些问题，把它们改掉，其余的保持原样，再把四段完整写一遍：\n${problems.map(item => `- ${item}`).join('\n')}`
    : current
      ? `<current> 是现在的外观。${wish ? `用户想在它的基础上改：${wish}${styled ? `\n风格照 <style> 里的「${styled}」。` : ''}` : styled ? `用户想把它改成 <style> 里的「${styled}」风格：取自这张卡的东西和排得好的地方留着，质感、配色和手法换过去。` : '用户想要再设计一版，和它明显不同。'}`
      : wish
        ? `用户想要的样子：${wish}${styled ? `\n风格照 <style> 里的「${styled}」。` : ''}`
        : styled
          ? `用户没有另外写要求：照 <style> 里的「${styled}」风格，按这张卡的气氛定。`
          : '用户没有说想要什么样子，按这张卡的气氛定。'
  const content = [cardLines(card), `<status_bar>\n这张卡的状态栏开局时是这样的（每行：短名 · 显示方式 · 现在的值）：\n${barOutline(spec, state)}\n</status_bar>`, baseBlock(over), card.cover ? COVER_PART : '', picturesBlock(pictures, drawn), styled ? styleBlock(style, { over: Boolean(over) }) : '', current, ask].filter(Boolean).join('\n\n')
  return { system: skinSystem(reply), messages: [{ role: 'user', content }], maxTokens: SKIN_TOKENS, softCap: true }
}

/** How many SVG pictures a stretch of CSS has. */
const pictureCount = text => (String(text).match(/data:image\/svg\+xml/gi) ?? []).length

const unfenced = text => String(text ?? '').replace(/^\s*```[\w-]*[ \t]*\n?/, '').replace(/\n?```\s*$/, '').trim()

/**
 * An answer as a look: { reply, name, palette, css, cut, base? } with the CSS as a card may keep it; null when there is
 * no CSS left to use. `cut`: what the model wrote that was taken out (it was told not to), for the page to say so.
 * `base`: the theme it was asked to go over; then a look that names no colors has none (palette null: the theme's).
 */
export function readSkin(text, { palette: fallback = null, base = '' } = {}) {
  const over = cleanBase(base)
  const source = String(text ?? '')
  const written = unfenced(section(source, 'css') || /```css\s*\n([\s\S]*?)(?:```|$)/i.exec(source)?.[1] || '')
  const css = cleanSkinCss(written)
  if (!css) return null
  const cut = [
    // A picture from elsewhere, or one of its own drawn with what a picture may not have.
    /url\s*\(\s*(?!["']?(?:data:image\/svg\+xml|#|%23))|image-set\s*\(/i.test(written) || pictureCount(written) > pictureCount(css) ? 'url' : '',
    /@import|@font-face/i.test(written) ? 'import' : '',
    /position\s*:\s*(?:fixed|sticky)/i.test(written) ? 'fixed' : '',
    // Longer than a look may be: the rules past the limit are not in it (the page says so, and it can be asked again shorter).
    skinCut(written) ? 'long' : '',
  ].filter(Boolean)
  return {
    reply: clip(section(source, 'reply'), 600),
    name: clip(section(source, 'name'), 24).replace(/^[「『"“]|[」』"”]$/g, ''),
    palette: cleanPalette(looseJson(section(source, 'palette'))) ?? cleanPalette(fallback) ?? (over ? null : FIRST_COLORS),
    // 动效 picked with the look ('' = none, or none said).
    effect: cleanEffect(section(source, 'effect').trim().toLowerCase()),
    // 画装饰图: the decorations this look would have drawn, a prompt each.
    ...(cleanDecor(looseJson(section(source, 'decor'))) ? { decor: cleanDecor(looseJson(section(source, 'decor'))) } : {}),
    css,
    cut,
    ...(over ? { base: over } : {}),
  }
}
