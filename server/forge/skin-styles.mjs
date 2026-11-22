// 定制外观的风格 (状态栏 → 定制外观 → 风格): a way a look can go, picked by a chip (web/card-check.js SKIN_STYLES).
// Each is built round one picture the look is known by (招牌画面), drawn as SVG in the CSS, with a worked example to
// go from; then the stuff it is made of, each part of the bar, how it moves, what it is not. The page sends only the
// key; these words go with the request (skin.mjs skinRequest), under anything the user wrote.

const STYLES = {
  fresh: ['日系清新', `招牌画面：窗边的光。标题那一行的右半边和状态栏的右上角，是一扇看不见的窗投下的光：几道斜着的、边缘柔和的浅色光斑（半透明的平行四边形，白到透明的渐变），光里浮着几颗失焦的圆斑；角上探进一枝细线描的植物（薄荷、尤加利、一枝小花，取这张卡里有的东西），叶子是淡色填充加一根细线。整幅画很淡，像早上九点的房间。写法示例（照这个思路，画面换成这张卡的，叶子和光斑要比示例多、层次更细）：
.status-head { position: relative; isolation: isolate; min-height: 120px }
.status-head::before { content: ""; position: absolute; z-index: -1; pointer-events: none; right: 0; top: 0; bottom: 0; width: min(62%, 400px); background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 120'><defs><linearGradient id='l' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%23ffffff' stop-opacity='.85'/><stop offset='1' stop-color='%23ffffff' stop-opacity='0'/></linearGradient></defs><g fill='url(%23l)'><polygon points='120,0 160,0 90,120 50,120'/><polygon points='172,0 188,0 118,120 102,120'/></g><g stroke='%237fb8a4' stroke-width='1.2' stroke-linecap='round'><path d='M200 118 C205 84 215 62 236 40' fill='none'/><path d='M206 94 c-12 -4 -18 -14 -16 -24 c10 2 17 10 16 24z' fill='%23d6ece3'/><path d='M214 74 c12 -6 22 -4 26 4 c-9 6 -19 6 -26 -4z' fill='%23d6ece3'/></g><g fill='%23ffd9e0' opacity='.55'><circle cx='40' cy='34' r='12'/><circle cx='74' cy='18' r='6'/></g></svg>") right bottom / contain no-repeat; mask-image: linear-gradient(90deg, transparent, #000 28%) }
质感：近白带一点暖或冷的底（不用纯白），低饱和的粉、雾蓝、薄荷、奶油黄、藤紫里按卡挑一个做强调；文字是带灰的深色。大圆角（状态栏 20px 上下，里面的块 12 到 14px，标签全圆），边框极淡或没有，一层很淡的阴影托起来。圆体或细黑体（"Hiragino Maru Gothic ProN", "Yuanti SC", "PingFang SC", "Microsoft YaHei UI", sans-serif），字重轻，小标题小号加宽字距。
各部分：
- 标题旁一个线描的小图标（SVG，和招牌画面一个画法）；下面一道 2px 的圆头短线；「收起」是一粒浅色药丸。
- 分组像几张叠放的薄卡片，组名前一个小圆点；组和组之间靠留白。
- 进度条细（6 到 8px）全圆，填充是柔和的渐变，末端一个白色小圆点；不同的项按 [data-label] 给不同的糖果色。
- 标签和徽章是淡色药丸；开关「是」像一枚打勾的小贴纸；星级用强调色，空星很淡。
- 表格只有横向细线；长文放在一张淡底的圆角便签里，行距 1.8。
动起来：光斑跟着鼠标轻轻挪一点（background-position 里用 calc((var(--pfx, .5) - .5) * 12px)）；这一轮变了的淡底亮一下再退；悬停的一行底色浮出一点。动效：花瓣或浮尘。
不要：深色的底、重阴影、金属和发光、粗边框、密集的线。`],

  metal: ['金属光泽', `招牌画面：标题那一行是一块铆在状态栏上的金属铭牌，右边嵌着一只仪表。铭牌的面是拉丝金属（SVG 里 feTurbulence 横向拉长的噪声，叠在竖向的明暗渐变上），四角四颗带高光的螺丝，边缘一道倒角；仪表是一圈刻度、一根指针、玻璃上一道弧形反光。深色的钢还是黄铜、紫铜按卡定：机甲、科幻用冷钢，蒸汽、炼金、古董用黄铜。写法示例（拉丝纹做成能平铺的底（feTurbulence 写 stitchTiles='stitch'，filter 的 x、y 写 0、宽高写 100%，平铺才没有接缝），仪表放在标题行右边；刻度要比示例密，可以加数字和红区）：
.status-bar { background-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='f' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='.015 .9' numOctaves='2' seed='4' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .62 0 0 0 0 .65 0 0 0 0 .7 0 0 0 .32 0'/></filter><rect width='240' height='240' filter='url(%23f)'/></svg>"), linear-gradient(180deg, #4a5059, #23272d 55%, #30353c) }
.status-head::after { content: ""; position: absolute; right: 56px; top: 8px; width: 44px; height: 44px; pointer-events: none; background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><defs><radialGradient id='b' cx='.35' cy='.3'><stop offset='0' stop-color='%23f2f4f6'/><stop offset='.6' stop-color='%23a9b0b8'/><stop offset='1' stop-color='%23555c66'/></radialGradient></defs><circle cx='60' cy='60' r='57' fill='url(%23b)'/><circle cx='60' cy='60' r='46' fill='%23181b20'/><g stroke='%23d9dde2' stroke-width='3'><line x1='60' y1='18' x2='60' y2='27' transform='rotate(-120 60 60)'/><line x1='60' y1='18' x2='60' y2='27' transform='rotate(-60 60 60)'/><line x1='60' y1='18' x2='60' y2='27'/><line x1='60' y1='18' x2='60' y2='27' transform='rotate(60 60 60)'/><line x1='60' y1='18' x2='60' y2='27' stroke='%23ff7a3a' transform='rotate(120 60 60)'/></g><path d='M57 62 L60 24 L63 62z' fill='%23ff9b2f' transform='rotate(35 60 60)'/><circle cx='60' cy='60' r='6' fill='%23c9ced4'/><path d='M22 48 A40 40 0 0 1 70 18' stroke='%23ffffff' stroke-opacity='.35' stroke-width='4' fill='none'/></svg>") center / contain no-repeat }
质感：金属本色占大头，强调色只有一个，像仪表上的指示灯（琥珀、冰蓝、警示红、荧光绿）。每一块都有倒角：上、左一道 1px 亮线，下、右一道暗线（四边不同色的 border，或两层 inset 的 box-shadow），圆角 4 到 8px。窄而硬的无衬线字（"DIN Alternate", Bahnschrift, "Arial Narrow", "PingFang SC", "Microsoft YaHei UI", sans-serif），标签小号加宽字距，数字等宽、稍大；标题像蚀刻或压印（比底略深的字加一道 0 1px 0 的亮色投影），但字和铭牌的明暗差要够大，一眼读得清：亮铭牌配深色字，暗铭牌配浅色字。
各部分：
- 分组是嵌进去的面板（inset 的暗影）或铆上去的小铭牌，全场只用一种；面板角上可以有小螺丝（SVG 或径向渐变）。
- 进度条是凹槽里一根抛光的金属条或一管发光的指示液：上亮、中间一道高光、下暗，槽上用 repeating-linear-gradient 刻刻度。
- 标签是小铭牌，徽章是一颗带光晕的指示灯加字；开关就是灯的亮和灭；星级用金属色，空的是凹下去的暗色。
- 表头是一条更暗的金属带，行和行之间一亮一暗双线；长文像刻在面板上的说明，用窄体或等宽字；「收起」是凸起的金属按键，:active 时亮边和暗边对调。
动起来：铭牌上一道斜的高光跟着鼠标走（linear-gradient 的位置用 var(--pfx, .5) 算），或者每隔几秒自己扫过一次；仪表指针可以用 @keyframes 轻轻摆；这一轮变了的指示灯亮一下。动效：火星、浮尘，或 none。
不要：柔和的粉彩、大圆角、手写体、模糊的大阴影；高光要有主次，不要处处最亮。`],

  journal: ['日记手帐', `招牌画面：标题区是一页拼贴。一张歪着贴上去的拍立得或剪报（白边方块里一幅小画，画这张卡的地方或物件：雨夜的窗、山门、一杯咖啡、一封信），一枚回形针夹着它，一段半透明的和纸胶带压在角上，旁边一枚圆形邮戳或日期章，几笔手画的箭头、星星或圈。纸的边缘可以是撕开的毛边（SVG 里 feTurbulence 加 feDisplacementMap）。写法示例（这几样放在标题行右边或状态栏右上角，画面换成这张卡的，比示例多几样小东西）：
.status-head::after { content: ""; position: absolute; right: 64px; top: -6px; width: 120px; height: 84px; pointer-events: none; transform: rotate(4deg); background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 84'><defs><filter id='r'><feTurbulence baseFrequency='.08' numOctaves='2' seed='2'/><feDisplacementMap in='SourceGraphic' scale='3'/></filter></defs><rect x='14' y='8' width='76' height='70' fill='%23fffdf6' filter='url(%23r)'/><rect x='20' y='14' width='64' height='46' fill='%2334495e'/><circle cx='68' cy='26' r='7' fill='%23f3d98b'/><path d='M20 60 L40 40 L54 52 L66 44 L84 60z' fill='%2322313f'/><rect x='4' y='10' width='38' height='12' fill='%23f2a7a0' opacity='.7' transform='rotate(-22 23 16)'/><path d='M96 6 v44 a6 6 0 0 0 12 0 v-38 a4 4 0 0 0 -8 0 v34' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round'/></svg>") center / contain no-repeat }
质感：米白或奶油色的纸，横格、方格或点阵三选一（repeating-linear-gradient 或 radial-gradient 的小点），左边可以有一道淡红的页边线，一侧一列活页孔（SVG 或 radial-gradient）。纸色加一种墨水色（蓝黑、棕黑、铅笔灰）写字，强调色是荧光笔或胶带的颜色（芥末黄、珊瑚粉、薄荷、淡紫）。手写感的字（"Kaiti SC", STKaiti, KaiTi, "Bradley Hand", "Segoe Print", cursive），数字和小标签用打字机式的等宽字（"Courier New", monospace）。
各部分：
- 标题下面一道荧光笔（linear-gradient 只铺在字的下半截）；「收起」像一枚小标签贴。
- 分组像贴上去的便签，顶上压一段胶带（::before，半透明色条加斜纹或圆点，两端用 clip-path 剪出撕口，歪一点）；装内容的块不歪。
- 进度条像彩色笔涂出来的：底是虚线框，填充压一层斜纹，或切成一排涂满的小方格。
- 标签是索引贴（一头平一头尖）；徽章是盖上去的印章（粗一点的边框、略歪、颜色不太匀）；开关是手画的方框，「是」打勾；星级像手画的星。
- 表格线是虚线，表头下面一道双线；长文是一张淡黄便签，右下角一个折角。
动起来：拍立得跟着鼠标轻轻转一两度（rotate 里用 var(--pfx, .5)）；这一轮变了的像刚划过荧光笔（荧光底从左到右铺开）；悬停时便签抬起一点。动效：浮尘、花瓣，或 none。
不要：金属、霓虹、深色的底、冰冷整齐的界面感；装饰歪不超过 4 度，字不歪。`],

  pixel: ['像素风', `招牌画面：标题区站着一个像素小场景，32×16 或 48×24 格，放大到 72 到 120 像素高（image-rendering: pixelated，放大倍数取整），放在标题行的右半边或整条标题区的底下，用 SVG 的 rect 或 path 一格一格拼出来（shape-rendering='crispEdges'），画这张卡里的东西：主角的小人、一把剑、宝箱、山门、雨夜的路灯、一只猫；再加一两朵像素云或几颗闪烁的星。状态栏的边框也像老游戏的窗口：缺一格的角、内侧一圈亮线。写法示例（一把 16 格的剑，只示范一格一格怎么写；你的场景要大得多，东西至少三四样，还要有地面或背景）：
.status-head { position: relative; isolation: isolate; min-height: 120px }
.status-head::before { content: ""; position: absolute; z-index: -1; right: 56px; bottom: 8px; width: 104px; height: 104px; pointer-events: none; image-rendering: pixelated; background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' shape-rendering='crispEdges'><path fill='%23e8e8f0' d='M7 1h2v8H7z'/><path fill='%23a0a0b8' d='M8 2h1v7H8z'/><path fill='%23f2c14e' d='M4 9h8v1H4z'/><path fill='%238b5a2b' d='M7 10h2v3H7z'/><path fill='%23f2c14e' d='M6 13h4v1H6z'/></svg>") center / contain no-repeat }
质感：纯色的平底，深色像老游戏的菜单窗口（藏青、墨绿、深紫），浅色像掌机屏幕（灰绿、米黄），可以铺一层很淡的棋盘格（repeating-conic-gradient）。整套不超过六种实色，不用半透明叠出中间色；强调色鲜明，再留一个「危险、偏低」的颜色。全场 border-radius: 0，box-shadow 不带模糊，不用渐变做光泽；尺寸、间距、边框都是 4px 的倍数。粗的像素框：几层没有模糊的 box-shadow 叠出缺一格的角（0 -4px 0 0、0 4px 0 0、-4px 0 0 0、4px 0 0 0 各一层同色），外面一层暗色当投影。等宽字（"Cascadia Mono", Consolas, "Courier New", "PingFang SC", "Microsoft YaHei UI", monospace），中文加粗，英文和数字大写，text-shadow 只用 1 到 2px 的硬投影。
各部分：
- 分组是一个个小窗口，组名压在窗口的上边框上；「收起」是带硬投影的按钮，:active 时往右下移 2px、投影消失。
- 进度条一格一格：外面 2px 的框，填充用 repeating-linear-gradient 切成每 8px 里 6px 实色；生命、体力按 [data-label] 给各自的颜色，名字前用 content 加「♥」「★」「◆」。
- 标签是反白的方块；开关是「■」「□」；星级用实心和空心的方块。
- 表格是 2px 实线的格子，表头反白；列表符号是「▸」；长文是一个对话框，右下角一个闪动的「▼」。
动起来：一律用 steps()：标题前一个闪烁的「▶」；一个像素小光标（几格方块拼的箭头或手）跟着鼠标走（::after 上写 transform: translate(var(--px, 0), var(--py, 0))，只在 .status-bar.pointing 时显出来）；小场景里的星星或火光两帧交替；这一轮变了的闪两三下；悬停的一行前面出现「▶」或整行反白。动效：星光，或 none。
不要：圆角、模糊、渐变光泽、半透明、细于 2px 的线、平滑的过渡。`],

  cel: ['赛璐璐平涂', `招牌画面：标题区上方一条横幅风景，像漫画里一格远景：远处的地平线，两三层平涂的山、沙丘或楼群（越远越淡），一轮带描边的太阳或月亮，几朵平涂的云；每一块都有一样粗细的描边，背光的一面用一片细排线（SVG 的 pattern）代替阴影。画面取这张卡的地方。写法示例（放在 .status-head 的背景或 ::before 里，高度 60 到 90px；层次和细节要比示例多：加一座塔、一棵树、一群鸟）：
.status-head { position: relative; isolation: isolate; min-height: 120px }
.status-head::before { content: ""; position: absolute; z-index: -1; pointer-events: none; left: 0; right: 0; bottom: 0; height: 96px; background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 80' preserveAspectRatio='xMidYMax slice'><defs><pattern id='h' width='4' height='4' patternUnits='userSpaceOnUse' patternTransform='rotate(45)'><line x1='0' y1='0' x2='0' y2='4' stroke='%233a3550' stroke-width='.8'/></pattern></defs><g stroke='%233a3550' stroke-width='1.2' stroke-linejoin='round'><circle cx='232' cy='44' r='13' fill='%23f6c76b'/><path d='M0 60 L40 38 L80 52 L130 28 L180 50 L230 40 L300 56 V80 H0z' fill='%23b9c8e0'/><path d='M130 28 L180 50 L130 50z' fill='url(%23h)' stroke='none'/><path d='M0 70 Q60 56 120 66 T240 62 T300 66 V80 H0z' fill='%23e9d3a6'/></g></svg>") center bottom / 100% 100% no-repeat }
质感：平涂的浅色底，像漫画里的天空或沙地（沙黄、淡天青、淡紫、浅玫瑰），可以分成两三条硬边的色带。四五种明度接近、饱和度偏低的颜色，开阔、干燥、有阳光；阴影不用黑，用同色系更深一档或淡紫。描边只有一种颜色（深褐或墨蓝），粗细处处一样（1 到 1.5px）；投影是一块不带模糊、朝右下错开 3 到 4px 的平涂色块。圆角小而一致或直角。干净的细无衬线字（"Avenir Next", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif），标题加宽字距；字色就是描边色。
各部分：
- 标题左边一个带描边的平涂小图形；下面一道和描边一样粗的线，一头一个小圆点；「收起」是描边的小方框。
- 分组像漫画分格，格间留白一样宽；一两处角上压一片细排线（mask-image 让它朝一边疏下去）。
- 进度条是描边的长格子，平涂填充，填过的和没填的之间一道硬边，下缘一条更深的平涂阴影带。
- 标签是描边加平涂的小块；徽章像拟声词牌子（字稍大、带错开的色块投影）；开关是描边的圆，「是」涂满；星级是描边的星。
- 表头涂成一条色带；长文像旁白框：淡黄平涂、描边，左上角一个小色块。
动起来：远景几层跟着鼠标错开一点做视差（各层 background-position 用不同倍数的 var(--pfx, .5)）；这一轮变了的底色换成强调色的淡色再退回；悬停时色块投影错开得远一点。动效：浮尘、星光，或 none。
不要：渐变光泽、模糊阴影、发光、粗细不一的线、纯黑和高饱和的原色。`],

  ink: ['水墨留白', `招牌画面：标题区右边是一幅小小的水墨山水，占状态栏宽度的四成上下：两三层远山，越远越淡、越模糊，山脊的墨边被纸吃得毛起来（SVG 里 feTurbulence 加 feDisplacementMap，再一点 feGaussianBlur），山脚洇进留白；近处一棵松、一叶小舟、一座亭子或几只飞鸟，取这张卡的地方。画旁一方朱印，刻这张卡的一两个字。写法示例（你的山水层次要更多，加近景的一样东西）：
.status-head { position: relative; isolation: isolate; min-height: 120px }
.status-head::before { content: ""; position: absolute; z-index: -1; pointer-events: none; right: 0; top: 0; bottom: 0; width: min(62%, 400px); background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 120'><defs><filter id='m'><feTurbulence type='fractalNoise' baseFrequency='.03' numOctaves='3' seed='3'/><feDisplacementMap in='SourceGraphic' scale='9'/><feGaussianBlur stdDeviation='.6'/></filter><linearGradient id='f' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='%23222222' stop-opacity='.6'/><stop offset='1' stop-color='%23222222' stop-opacity='0'/></linearGradient></defs><g filter='url(%23m)'><path d='M60 120 L120 40 L150 70 L190 20 L240 80 L300 60 V120z' fill='url(%23f)' opacity='.45'/><path d='M0 120 L50 70 L90 90 L140 55 L200 100 L300 90 V120z' fill='url(%23f)'/></g><rect x='264' y='10' width='22' height='22' rx='2' fill='%23b5382a'/><text x='275' y='26' font-size='13' text-anchor='middle' fill='%23f4f0e6' font-family='KaiTi,STKaiti,serif'>梧</text></svg>") right bottom / contain no-repeat; mask-image: linear-gradient(90deg, transparent, #000 28%) }
质感：宣纸：暖白或很淡的米灰（#f4f0e6 上下），几层很淡的大 radial-gradient 做出纸面不匀的水渍，也可以用 SVG 的 feTurbulence 铺一层极淡的纸纤维。只有墨的浓淡（焦墨到清墨五档灰，带一点暖或青），另加一处朱红，全场只出现一两处。夜里的故事可以反过来：墨黑的底、灰白的字。宋体（"Songti SC", STSong, "Noto Serif CJK SC", SimSun, serif），标题用楷体（"Kaiti SC", STKaiti, KaiTi, serif），字距拉开到 0.3em 上下。小标签用中等的墨色：最淡的两档墨只给线和墨晕，字都要读得清。
各部分：
- 尽量不用框：状态栏没有边框，或只有上下两道墨线，墨线一头浓一头淡、可以断开；分组之间是大片留白加一道短的淡墨线，内边距比平常大一档。
- 标题下面一道由浓到淡拖出去的墨线；「收起」只是一行小字。
- 进度条是一笔墨：细（3 到 5px），左浓右淡越写越干，末端一个朱红小点或一小截飞白。
- 标签是墨色的字加一道淡的短线，或字两边各一个「·」；徽章是一枚小朱文印或墨色反白小方块，只选一种；开关用「○」「●」；星级用「◇」「◆」。
- 表格只留表头下一道线；列表符号是墨点；长文像题在画上的一段字。
动起来：鼠标移过时远山和近景错开一点做视差（各层用不同倍数的 var(--pfx, .5)）；这一轮变了的字从淡到浓洇出来（opacity 和 filter: blur 一次的 @keyframes）；悬停的一行底下浮出一道淡墨线。动效：浮尘、雪或花瓣，看季节。
不要：朱红以外的彩色、粗框和大圆角、发光、金属、满铺的纹样。留白是主角。`],

  neon: ['赛博霓虹', `招牌画面：标题后面是一排深夜的城市剪影，占满标题区的宽度：高低错落的楼，远处一层更暗更矮的楼，楼顶线是霓虹色的细描边带辉光（SVG 里 feGaussianBlur 加 feMerge：一层清楚的线加一层模糊的光），零星几扇亮着的窗，一块竖的霓虹招牌（写这张卡的一两个字）；地面一道反光。写法示例（你的天际线要更密、更有层次：加天线、水塔、一架飞过的灯）：
.status-head { position: relative; isolation: isolate; min-height: 120px }
.status-head::before { content: ""; position: absolute; z-index: -1; pointer-events: none; left: 0; right: 0; bottom: 0; height: 96px; background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 90' preserveAspectRatio='xMidYMax slice'><defs><filter id='g' x='-20%' y='-20%' width='140%' height='140%'><feGaussianBlur stdDeviation='2.5' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter></defs><path d='M0 90 V64 h20 v-12 h14 v20 h12 v-30 h20 v36 h12 v-18 h16 v26 h14 v-42 h10 v-8 h8 v50 h18 v-24 h22 v32 h12 v-16 h16 v24 h24 v-10 h18 v-22 h20 v14 h22 v10 h22 V90z' fill='%230c1020' stroke='%2300f0b5' stroke-width='1.2' filter='url(%23g)'/><g fill='%23ff2a85'><rect x='72' y='48' width='3' height='3'/><rect x='80' y='56' width='3' height='3'/><rect x='184' y='44' width='3' height='3'/></g><rect x='150' y='28' width='10' height='26' fill='none' stroke='%23ff2a85' stroke-width='1.2' filter='url(%23g)'/></svg>") center bottom / 100% 100% no-repeat }
质感：近黑带一点蓝或紫的底（#0a0b14 上下），叠细扫描线（每 3px 一道 1px、透明度 0.04 的亮线）、很淡的网格，角上一两处霓虹色的大光晕。两种霓虹对着用（青和品红，或按卡换成酸绿和紫、橙和电蓝），一个做主（边线、进度条），一个做辅（变化、警告、选中）；字是带冷色的近白。等宽字（"Cascadia Code", "SF Mono", Consolas, Menlo, "PingFang SC", "Microsoft YaHei UI", monospace），标签大写加宽字距，前面用 content 加「//」「>」「[ ]」；标题带同色两层的霓虹 text-shadow，正文不发光。
切角：状态栏和分组用 clip-path: polygon(…) 切掉对角的两个角（8 到 12px），小块切得小一些。切了角的块把 border-radius 写成 0：程序给的圆角还在，不写就成了一角圆、一角切。border 和 box-shadow（inset 的也一样）在斜边上画不出来：直边的线用 inset 的 box-shadow，斜边在 background 里那个角补一层，比如右上角切 8px，就在背景最上面叠 linear-gradient(225deg, transparent 50%, 边线色 50%, 边线色 calc(50% + 1.5px), transparent calc(50% + 1.5px)) top right / 8px 8px no-repeat（左下角换成 45deg 和 bottom left）。实心的小块（徽章）不用补线。要外发光的块就不切角，用两层 box-shadow（0 0 4px 和透明度低的 0 0 14px）。
各部分：
- 标题下一道一头亮一头暗的线，线上一个小亮块来回走；「收起」是描边的小键，悬停时填满霓虹色、字变黑。
- 角上「┌ ┐ └ ┘」式的角标（::before、::after 各画两条边）。
- 进度条是发光的管或一格一格的能量格，末端一道白热的亮线；危险的项按 [data-label] 换另一种霓虹。
- 标签是切角的描边小块；徽章是实心霓虹色块配黑字；开关是亮灭的指示灯；星级是发光的星或「▮」「▯」。
- 表头是暗色带加霓虹下划线；长文像终端输出，左边一道霓虹竖线，末尾一个闪动的「▌」。
动起来：鼠标处一团霓虹色的光跟着走（radial-gradient 的圆心写 var(--px, 50%) var(--py, 0)，只在 .status-bar.pointing 时显出来）；这一轮变了的故障一闪（text-shadow 青和品红左右错开再归位）；标题偶尔像接触不良的灯管暗一下。动效：雨或星光。
不要：浅色的底、柔和的粉彩、大圆角、手写体；辉光只给标题、天际线、边线、进度条和选中的，正文不要霓虹色铺满。`],

  storybook: ['童话绘本', `招牌画面：标题区底下是一条故事书的小风景，横贯状态栏：圆滚滚的小山坡，一座小房子、一棵棒棒糖树或一座小城堡，几朵胖云，几颗星星或一弯月亮；线是粗而不匀的深棕描边，像蜡笔画的（SVG 里 feTurbulence 加小幅的 feDisplacementMap 让线有一点抖），颜色明快暖亮。取这张卡的地方和东西（修仙就是小山门和仙鹤，都市就是小街和路灯）。写法示例（你的画要更满：加一条小路、一只小动物、花）：
.status-head { position: relative; isolation: isolate; min-height: 120px }
.status-head::before { content: ""; position: absolute; z-index: -1; pointer-events: none; left: 0; right: 0; bottom: 0; height: 96px; background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 80' preserveAspectRatio='xMidYMax slice'><defs><filter id='w'><feTurbulence baseFrequency='.04' numOctaves='2' seed='5'/><feDisplacementMap in='SourceGraphic' scale='3'/></filter></defs><g filter='url(%23w)' stroke='%235a3b2e' stroke-width='2.5' stroke-linejoin='round'><path d='M0 80 Q50 40 110 62 Q170 30 230 58 Q270 46 300 54 V80z' fill='%23a8d89a'/><path d='M200 60 v-16 h22 v16' fill='%23ffe3a3'/><path d='M196 46 L211 32 L226 46z' fill='%23f08a6c'/><circle cx='70' cy='42' r='10' fill='%2379c26b'/><path d='M70 52 v12' fill='none'/></g><path d='M260 14 l3 7 7 1 -5 5 1 7 -6 -3 -6 3 1 -7 -5 -5 7 -1z' fill='%23ffd34d'/></svg>") center bottom / 100% 100% no-repeat }
质感：暖色的画纸（奶油、淡杏、浅麦色），几片很淡的水彩晕（大的 radial-gradient，桃粉、嫩绿、天蓝）；夜晚的童话可以用深蓝的底，颜色仍然暖而亮。番茄红、蛋黄、草绿、天蓝、莓紫里挑三四种，都掺一点奶白；字用深棕或墨蓝。手画感：四个角的圆角写得不一样（border-radius: 18px 22px 16px 24px / 20px 16px 24px 18px），边框 2 到 3px 深棕，有的地方 dashed 像针脚；投影是一块不带模糊、错开的暖色色块。圆润带手写的字（"Yuanti SC", "Hiragino Maru Gothic ProN", "Comic Sans MS", "Chalkboard SE", "Segoe Print", "Microsoft YaHei UI", sans-serif），标题大而胖。
各部分：
- 标题两边用 content 放小装饰（★ ✿ ☘ ♪ ☾），下面一道彩色波浪线；「收起」是一颗圆纽扣。
- 分组像剪下来的书页，上边伸出一个颜色不同的书签或小旗子；组名前一个小图形。
- 进度条胖（12 到 16px）全圆、深棕描边，填充平色上压一道斜的糖果条纹，末端一颗小星星或小爱心。
- 标签像贴纸（白色粗描边加投影）或小旗子、小叶子；徽章是圆圆的奖章；开关「是」是一颗亮起来的星；星级用大一点的彩色星。注意贴纸上的字和底色要分得清，黄色星星不要放在浅色底上。
- 表格的线是点线，表头一条彩色带子；列表符号是星星、叶子或小圆点，用 :nth-child 轮换颜色；长文第一个字放大（::first-letter）。
动起来：云跟着鼠标慢慢挪一点（background-position 用 var(--pfx, .5)）；星星一闪一闪；这一轮变了的轻轻弹一下；悬停时卡片投影错开得远一点，像被拿起来。动效：星光、萤火或花瓣。
不要：冷灰、金属、锐利的直角、细密的线、压抑的暗色。`],
}

/** The styles there are (the page's chips send one of these). */
export const SKIN_STYLE_KEYS = Object.keys(STYLES)

/** A style as a request keeps it: one of the keys, or '' (none picked). */
export const cleanStyle = style => (Object.hasOwn(STYLES, style) ? style : '')

/** A style's name, as the page and the model say it; '' for none. */
export const styleName = style => STYLES[cleanStyle(style)]?.[0] ?? ''

/** The worked example of a style's 招牌画面: the CSS lines in it, as written (for the tests to draw). */
export const styleExample = style => (STYLES[cleanStyle(style)]?.[1] ?? '').split('\n').filter(line => /^\.status-[\w-]+(?:::?[\w-]+)? \{.*url\("data:image\/svg\+xml,/.test(line)).join('\n')

/** The <style> block of a request: what the picked style is made of and how far it goes; '' with none. `over`: the look goes over a theme. */
export function styleBlock(style, { over = false } = {}) {
  const [name, words] = STYLES[cleanStyle(style)] ?? []
  if (!name) return ''
  return `<style name="${name}">
用户选了「${name}」这种风格。下面是它的做法：
${words}
怎么用这份说明：
- 先做招牌画面，这是这套外观第一眼看到的东西，也是它和普通面板的区别：要大、要有细节，是几十个形状、渐变和滤镜叠出来的一幅小画，不是一个图标。示例只是写法，画面要换成这张卡自己的（它的地点、物件、季节、人物），并且画得比示例更丰富。画面要有地方才大得起来：标题那一行只有一行字高，画面跟着它的高度就只剩一个小图标。照示例的放法：.status-head 写 position: relative、isolation: isolate 和 min-height（宽屏 110 到 140px，@media (max-width: 480px) 里小一些），画面放在它自己的 ::before 里（position: absolute、z-index: -1，写明 right、bottom 和宽高），铺满标题区的右半边或整条底部；不要把画面当成 .status-head 的背景再用 auto 100% 去缩，那样它只有一行字高，还会躲到标题后面。画的边缘要自然淡出（渐变到透明，或用 mask-image），不要露出一个方方正正的图框。画面放在不挡字的地方，有字压在上面时把画调淡或压一层底色。
- 招牌画面以外，可以再用 SVG 画两三样小纹饰（角花、分隔线、图标），和招牌画面同一个画法。
- 其余各部分照说明做，一处只挑一种做法；这张卡没有的显示方式和没有的块（小手机、开场页）跳过。
- 说明和前面「做得精致靠的是这几样」有出入的地方，照这份说明：招牌画面和纹饰可以大胆、可以浓，克制只管放数据的地方。「程序已经排好的」「写了会被程序去掉的」「要守住的」照旧：字和底始终分得清，窄的时候不撑出去。${over ? '\n- 这次有 <base_theme>：在主题的底子上往这种风格靠，取说明里和主题合得来的手法；主题已有的画面可以换成这种风格的招牌画面。' : ''}
- 用户另外写了要求的，和这份说明不一样的地方照用户写的。
</style>`
}
