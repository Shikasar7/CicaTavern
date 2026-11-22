// A card creator card's status bar. The card carries its layout
// (extensions.cicatavern.status_bar), which this app draws itself (web/status.js),
// and a SillyTavern copy: a display regex that turns MVU's <StatusPlaceHolderImpl/>
// into the same bar in an HTML block, plus the MVU script that keeps the
// variables there. This app leaves that regex out (web/render.js withoutOwnStatus)
// and runs no helper scripts.
import YAML from 'yaml'
import { SHOWS, STATUS_THEMES, cleanStatusSpec, paletteColors, phoneApps, planMap, rangeOf, skinClass } from '../../web/shared/status.js'
import { msg } from '../i18n.mjs'
import { skinnedFrame } from './status-frame.mjs'

export const OWN_STATUS_SCRIPT = 'cicatavern-status-bar'

/** How a variable shows when the plan did not say: gauges for numbers with a range. */
export function defaultShow(variable) {
  if (variable.type === 'number') return rangeOf(variable.range).max !== undefined ? 'meter' : 'number'
  if (variable.type === 'list') return 'tags'
  if (variable.type === 'book') return 'table'
  if (variable.type === 'boolean') return 'flag'
  return 'text'
}

/** The plan's status bar layout, or null when it tracks nothing (or shows nothing). */
export function statusSpecOf(plan) {
  // A plain MVU card (创作角色卡's 格式) keeps its variables but no bar of its own.
  if (!plan?.tracking?.enabled || plan.status?.ui === false) return null
  return cleanStatusSpec({
    title: plan.tracking.title,
    theme: plan.status?.theme,
    palette: plan.status?.palette,
    skin: plan.status?.skin,
    // 立绘, 场景图 and 动效 (方案页 → 状态栏 → 门面): the pictures are the app's, found where the bar is drawn.
    portrait: plan.status?.portrait === true,
    scene: plan.status?.scene === true,
    effect: plan.status?.effect,
    phone: plan.status?.phone === true,
    layout: plan.status?.layout,
    // 地图: the world's places, for a book of them shown as a map.
    map: planMap(plan),
    fields: plan.tracking.variables.map(v => ({ path: v.path, label: v.label, show: v.show || defaultShow(v), ...rangeOf(v.range), ...(plan.status?.pages && v.page ? { page: v.page } : {}) })),
  })
}

// The SillyTavern bar: the layout as data plus a small renderer, reading the
// message's variables through MVU (Tavern Helper). Light and dark follow the system.
export const BAR_STYLE = `
:root{--bg:#f7f8f5;--line:#dfe4df;--ink:#1c2427;--muted:#5d6a6d;--faint:#8b9698;--accent:#2b5869;--soft:rgba(43,88,105,.11);--track:#dde3de;--ok:#2f7a55;--bad:#b0413a}
@media (prefers-color-scheme:dark){:root{--bg:#182025;--line:#273238;--ink:#dde3e0;--muted:#919da0;--faint:#67747a;--accent:#8dbfcb;--soft:rgba(141,191,203,.12);--track:#263137;--ok:#6fbf93;--bad:#e57b70}}
body{margin:0;background:transparent}
.bar{margin:8px 0;padding:14px 16px 16px;background:var(--bg);border:1px solid var(--line);border-radius:16px;font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:var(--ink)}
.title{font-weight:600;font-size:14px;letter-spacing:.08em;color:var(--accent);margin-bottom:12px}
.group+.group{margin-top:12px;padding-top:12px;border-top:1px dashed var(--line)}
.gname{font-size:12px;color:var(--faint);letter-spacing:.08em;margin-bottom:4px}
.row{display:grid;grid-template-columns:minmax(3.6em,max-content) minmax(0,1fr) auto;align-items:center;gap:12px;min-height:28px}
.row>.wide{grid-column:2/-1}
.label{color:var(--muted);font-size:12.5px;white-space:nowrap}
.meter{height:8px;border-radius:999px;background:var(--track);overflow:hidden}
.meter>i{display:block;height:100%;border-radius:999px;background:var(--accent)}
.value{text-align:right;min-width:3.4em;font-weight:600;font-variant-numeric:tabular-nums}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{font-size:12px;padding:0 8px;border-radius:8px;background:var(--soft);line-height:22px}
.stars{color:var(--accent);letter-spacing:1px}
.line{padding:2px 0;border-top:1px dashed var(--line)}.line:first-child{border-top:0}.trow{display:flex;gap:8px;align-items:baseline;padding:2px 0;border-top:1px dashed var(--line)}.trow:first-child{border-top:0}.trow>b{font-weight:500}.trow>span{color:var(--muted);font-size:12px}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}.tab{padding:2px 12px;border:1px solid var(--line);border-radius:999px;background:none;color:var(--muted);font:inherit;font-size:12.5px;cursor:pointer}.tab.on{background:var(--soft);border-color:var(--accent);color:var(--ink)}
.faint{color:var(--faint)}.on{color:var(--ok)}
.theme-editorial{--bg:#f8fafb;--line:rgba(95,143,165,.2);--ink:#28323a;--muted:#62707a;--faint:#8b98a1;--ok:#56907a;--bad:#b26c76;--accent:#4c7f96;--soft:rgba(226,184,189,.14);--track:rgba(95,143,165,.16);padding:24px 26px 26px;border-radius:32px;border-color:rgba(95,143,165,.14);background:radial-gradient(90% 90% at 100% 100%,rgba(150,204,224,.2),transparent 62%),radial-gradient(120% 80% at 0 0,rgba(226,184,189,.1),transparent 55%),linear-gradient(135deg,#fff,#fafcfd 36%,#eaf4f7);box-shadow:inset 0 1px 0 #fff,0 18px 40px -32px rgba(38,84,104,.3);font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",STSong,SimSun,serif}
.theme-editorial .title{font:300 26px/1.25 "Cormorant Garamond","Bodoni Moda","Playfair Display",Didot,Georgia,"Noto Serif SC","Songti SC",STSong,serif;letter-spacing:.1em;color:#5f8fa5;margin-bottom:18px}
.theme-editorial .title::before{content:"STATUS PANEL";display:block;margin-bottom:6px;font:500 10px/1.4 Georgia,serif;letter-spacing:.42em;color:#a3b2bb}
.theme-editorial .gname{letter-spacing:.36em;color:#a3b2bb}.theme-editorial .gname::before{content:"";display:inline-block;width:5px;height:5px;margin-right:9px;border-radius:50%;background:#e2b8bd;vertical-align:middle}
.theme-editorial .group+.group{border-top:0;background:linear-gradient(90deg,transparent,rgba(95,143,165,.26) 18%,rgba(226,184,189,.32) 72%,transparent) top/100% 1px no-repeat}
.theme-editorial .label{letter-spacing:.16em}.theme-editorial .value{font:400 15px/1.4 Georgia,serif}
.theme-editorial .meter{height:2px;border-radius:0;overflow:visible}.theme-editorial .meter>i{border-radius:0;background:linear-gradient(90deg,rgba(95,143,165,.35),#5f8fa5)}
.theme-editorial .tag{border:1px solid rgba(95,143,165,.26);border-radius:999px;background:rgba(255,255,255,.42);padding:0 10px}.theme-editorial .stars{color:#cd9aa0}
.theme-meadow{--bg:#fffdf7;--line:rgba(34,35,38,.16);--ink:#222326;--muted:#5d5f63;--faint:#8b8d90;--ok:#2f8a3e;--bad:#d4553f;--accent:#2f8a3e;--soft:#eaf6df;--track:#fff;padding:20px 22px 22px;border:2.5px solid #222326;border-radius:28px 22px 30px 20px/22px 30px 20px 28px;background:#fffdf7;box-shadow:5px 6px 0 #222326;font-family:Nunito,Quicksand,"Varela Round","Arial Rounded MT Bold","PingFang SC","Microsoft YaHei UI",sans-serif}
.theme-meadow .title{font-size:22px;font-weight:800;letter-spacing:.06em;color:#222326}.theme-meadow .gname{font-weight:800;color:#222326;text-decoration:underline 3px #9fd47c;text-underline-offset:5px}
.theme-meadow .group+.group{border-top:2px dashed var(--line)}.theme-meadow .label{font-weight:700}.theme-meadow .value{font-weight:800}
.theme-meadow .meter{height:12px;border:2px solid #222326;background:#fff}.theme-meadow .meter>i{background:linear-gradient(180deg,#b8e39a 0 45%,#8cc96a 45% 100%)}
.theme-meadow .tag{border:2px solid #222326;border-radius:999px;background:#fff;font-weight:700}.theme-meadow .stars{color:#f5b82e}
.theme-meadow .tab{border:2px solid #222326;color:#222326;font-weight:800}.theme-meadow .tab.on{background:#222326;color:#fffdf7}
.theme-sigil{--bg:#110e14;--line:rgba(236,228,212,.12);--ink:#ece4d4;--muted:#b3a998;--faint:#8a8174;--ok:#86c79a;--bad:#e8798b;--accent:#c9a45c;--soft:rgba(201,164,92,.1);--track:rgba(0,0,0,.5);border:1px solid rgba(201,164,92,.42);border-radius:6px;background:radial-gradient(120% 70% at 50% 0,rgba(176,28,52,.16),transparent 62%),linear-gradient(180deg,#131017,#0d0b10);box-shadow:inset 0 0 0 3px #0d0b10,inset 0 0 0 4px rgba(201,164,92,.16);font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",STSong,SimSun,serif}
.theme-sigil .title{letter-spacing:.32em;text-shadow:0 0 14px rgba(201,164,92,.28)}.theme-sigil .title::before{content:"❖";margin-right:10px;font-size:12px;color:#c2203c}
.theme-sigil .gname{color:#c9a45c;font-weight:700;letter-spacing:.24em}.theme-sigil .gname::before{content:"◆";margin-right:8px;font-size:8px;vertical-align:2px;color:#c2203c}
.theme-sigil .group+.group{border-top:1px solid rgba(201,164,92,.3)}.theme-sigil .value{font-family:Georgia,serif}
.theme-sigil .meter{border:1px solid rgba(236,228,212,.14)}.theme-sigil .meter>i{background:linear-gradient(90deg,#7d1226,#c2203c 70%,#ec5a72);box-shadow:0 0 8px rgba(194,32,60,.55)}
.theme-sigil .tag{background:rgba(201,164,92,.08);color:#c9a45c;border:1px solid rgba(201,164,92,.45);border-radius:2px}.theme-sigil .stars{color:#c9a45c}
.theme-sigil .tab{border:0;border-bottom:2px solid transparent;border-radius:0}.theme-sigil .tab.on{background:none;color:#c9a45c;border-bottom-color:#c2203c}
.theme-editorial .tab{border:0;letter-spacing:.24em;color:var(--faint)}.theme-editorial .tab.on{background:none;color:var(--ink);text-decoration:underline 1px #e2b8bd;text-underline-offset:6px}
.theme-daybreak{--bg:#f9f8f5;--line:rgba(116,132,150,.2);--ink:#2c3036;--muted:#687482;--faint:#959fab;--ok:#5b8c78;--bad:#ae6c77;--accent:#6b87a6;--soft:rgba(107,135,166,.12);--track:rgba(107,135,166,.16);position:relative;overflow:hidden;padding:22px 24px 22px 62px;border-radius:28px;border-color:rgba(116,132,150,.14);background:radial-gradient(circle at calc(100% - 30px) 30px,rgba(255,255,255,.95) 0 18px,rgba(255,234,216,.8) 36px,rgba(247,210,190,.34) 58px,transparent 76px),radial-gradient(78% 62% at 100% 0,rgba(172,200,228,.5),transparent 66%),radial-gradient(64% 46% at 0 100%,rgba(240,212,198,.42),transparent 64%),linear-gradient(165deg,#fdfcfa,#f8f7f4 50%,#eef2f6);box-shadow:0 18px 40px -32px rgba(44,54,68,.36);font-family:"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei UI",sans-serif}
.theme-daybreak::before{content:"DAYBREAK";position:absolute;top:22px;left:14px;writing-mode:vertical-rl;transform:rotate(180deg);font:600 26px/1 "Cormorant Garamond",Didot,Georgia,serif;letter-spacing:.05em;color:#30343a}
.theme-daybreak .title{font:400 30px/1.1 "Cormorant Garamond","Bodoni Moda",Didot,Georgia,"Noto Serif SC","Songti SC",serif;letter-spacing:.07em;text-transform:uppercase;color:#8aa1ba;margin-bottom:16px}.theme-daybreak .title::after{content:"daily notes";display:block;margin:-6px 0 0 1.1em;font:400 30px/1 "Snell Roundhand","Segoe Script",cursive;text-transform:none;letter-spacing:0;color:#2b2e33;transform:rotate(-4deg);transform-origin:0 100%}
.theme-daybreak .gname{font-weight:600;font-size:10.5px;letter-spacing:.2em;color:#6b87a6}.theme-daybreak .gname::after{content:" /";color:#959fab}
.theme-daybreak .group+.group{border-top:0;background:linear-gradient(rgba(116,132,150,.2),rgba(116,132,150,.2)) top/100% 1px no-repeat}.theme-daybreak .label{font-size:11.5px;letter-spacing:.12em}.theme-daybreak .value{font:500 18px/1.3 "Cormorant Garamond","Bodoni Moda",Didot,"Bodoni MT",Georgia,"Noto Serif SC","Songti SC",serif}
.theme-daybreak .meter{height:2px;border-radius:999px}.theme-daybreak .meter>i{border-radius:999px;background:linear-gradient(90deg,#8aa1ba,#6b87a6 45%,#c9a592)}
.theme-daybreak .tag{border:1px solid rgba(116,132,150,.2);border-radius:999px;background:rgba(255,255,255,.6);padding:0 10px}.theme-daybreak .stars{color:#c29f86}
.theme-daybreak .tab{border:0;letter-spacing:.18em;color:var(--faint)}.theme-daybreak .tab.on{background:none;color:var(--ink);text-decoration:underline 1px #6b87a6;text-underline-offset:6px}
.theme-aquarelle{--bg:#fcfaf4;--line:rgba(52,46,38,.18);--ink:#2b2925;--muted:#67615a;--faint:#958e84;--ok:#4f8a5c;--bad:#b4584c;--accent:#3d7cc4;--soft:rgba(96,150,214,.16);--track:rgba(52,46,38,.12);position:relative;padding:22px 26px 24px;border:0;border-radius:5px;background:radial-gradient(ellipse 60% 70% at 85% 0,rgba(110,168,230,.22),transparent 70%),radial-gradient(120% 90% at 50% 0,#fffefb,#faf6ee 80%);box-shadow:0 0 0 1px rgba(52,46,38,.08),0 14px 30px -24px rgba(70,56,34,.42);font-family:"LXGW WenKai","Kaiti SC",STKaiti,KaiTi,"Noto Serif SC",serif}
.theme-aquarelle::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(rgba(43,41,37,.5),rgba(43,41,37,.5)) 5px 10px/calc(100% - 10px) 1px no-repeat,linear-gradient(rgba(43,41,37,.5),rgba(43,41,37,.5)) 3px calc(100% - 11px)/calc(100% - 7px) 1px no-repeat,linear-gradient(rgba(43,41,37,.5),rgba(43,41,37,.5)) 11px 4px/1px calc(100% - 9px) no-repeat,linear-gradient(rgba(43,41,37,.5),rgba(43,41,37,.5)) calc(100% - 10px) 6px/1px calc(100% - 10px) no-repeat}
.theme-aquarelle .title{font-weight:400;font-size:22px;letter-spacing:.14em;color:#2b2925;margin-bottom:14px}.theme-aquarelle .title::after{content:"Clouds drift slowly through the blue.";display:block;font:italic 400 14px/1.5 "Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;letter-spacing:.03em;color:#67615a}
.theme-aquarelle .gname{font-size:15px;letter-spacing:.14em;color:#2b2925}.theme-aquarelle .gname::before{content:"";display:inline-block;width:14px;height:10px;margin-right:8px;border-radius:52% 48% 60% 40%;background:radial-gradient(ellipse,rgba(61,124,196,.55),transparent 78%);vertical-align:middle}
.theme-aquarelle .group+.group{border-top:1px solid rgba(43,41,37,.28)}.theme-aquarelle .label{letter-spacing:.1em}.theme-aquarelle .value{font-family:"Palatino Linotype",Palatino,"Book Antiqua",Georgia,"Kaiti SC",STKaiti,KaiTi,serif;font-size:16px}
.theme-aquarelle .meter{height:8px;background:linear-gradient(rgba(52,46,38,.28),rgba(52,46,38,.28)) center/100% 1px no-repeat}.theme-aquarelle .meter>i{border-radius:60% 100% 100% 50%/90% 100% 100% 80%;background:linear-gradient(90deg,rgba(61,124,196,.46),#3d7cc4);opacity:.82}
.theme-aquarelle .tag{border:0;border-radius:52% 48% 56% 44%;background:radial-gradient(ellipse,rgba(96,150,214,.26) 0 44%,transparent 76%);padding:0 12px}.theme-aquarelle .stars{color:#3d7cc4}
.theme-aquarelle .tab{border:0;letter-spacing:.14em;color:var(--faint)}.theme-aquarelle .tab.on{background:radial-gradient(ellipse,rgba(96,150,214,.28) 0 44%,transparent 76%);color:var(--ink)}
.theme-cobalt{--bg:#e8e5de;--line:rgba(29,58,224,.3);--ink:#1b34c9;--muted:#3550d6;--faint:#6f80d8;--ok:#1d3ae0;--bad:#1d3ae0;--accent:#1d3ae0;--soft:rgba(29,58,224,.1);--track:rgba(29,58,224,.14);position:relative;overflow:hidden;padding:26px 20px 20px;border:0;border-radius:2px;background:linear-gradient(112deg,transparent calc(50% - .5px),rgba(29,58,224,.24) calc(50% - .5px),rgba(29,58,224,.24) calc(50% + .5px),transparent calc(50% + .5px)),linear-gradient(170deg,#ece9e2,#e5e2da);box-shadow:0 0 0 1px rgba(40,36,28,.08),0 14px 28px -22px rgba(30,30,40,.45);font-family:Bahnschrift,"DIN Alternate","Arial Narrow","Noto Serif SC","Songti SC",serif}
.theme-cobalt::before{content:"";position:absolute;right:-60px;bottom:-70px;width:240px;height:240px;border-radius:50%;background:radial-gradient(circle,#1d3ae0 1.1px,transparent 1.6px) 0 0/7px 7px;opacity:.35;pointer-events:none}
.theme-cobalt::after{content:"";position:absolute;right:26px;top:16px;width:104px;height:104px;border-radius:50%;background:linear-gradient(#e8e5de,#e8e5de) 0 40%/100% 3px no-repeat,linear-gradient(#e8e5de,#e8e5de) 0 64%/100% 2px no-repeat,linear-gradient(#e8e5de,#e8e5de) 0 82%/100% 4px no-repeat,#1d3ae0;pointer-events:none}.theme-cobalt .title{position:relative;z-index:1;display:table;margin:14px 0 26px;padding:8px 16px 10px;background:#1d3ae0;box-shadow:8px 8px 0 -1.5px #e8e5de,8px 8px 0 0 #1d3ae0;color:#fff;font-weight:900;font-size:26px;letter-spacing:.06em}.theme-cobalt .title::after{content:"STATUS · RECORD";display:block;margin-top:4px;font:600 10px/1.3 Consolas,monospace;letter-spacing:.3em;color:rgba(255,255,255,.7)}
.theme-cobalt .gname{font-weight:900;font-size:16px;letter-spacing:.08em;color:#1b34c9;border-bottom:1.5px solid #1d3ae0;padding-bottom:4px}.theme-cobalt .group+.group{border-top:0}
.theme-cobalt .label{font-weight:700;letter-spacing:.12em;color:#3550d6}.theme-cobalt .value{font-weight:700;font-size:16px}
.theme-cobalt .meter{height:8px;border-radius:0;background:radial-gradient(circle,rgba(29,58,224,.32) 1px,transparent 1.4px) 0 50%/5px 5px}.theme-cobalt .meter>i{border-radius:0;background:#1d3ae0}
.theme-cobalt .tag{border:1.5px solid #1d3ae0;border-radius:0;background:none;padding:0 8px;font-weight:700}.theme-cobalt .stars{color:#1b34c9}
.theme-cobalt .tab{border:0;border-bottom:2px solid transparent;border-radius:0;font-weight:700;letter-spacing:.14em;color:var(--faint)}.theme-cobalt .tab.on{background:none;color:var(--ink);border-bottom-color:#1d3ae0}
.theme-afterschool{--bg:#1d2f6e;--line:rgba(253,246,220,.2);--ink:#fdf6dc;--muted:#bcc9f2;--faint:#8898d0;--ok:#86e9a6;--bad:#ff9080;--accent:#ffd23e;--soft:rgba(255,210,62,.16);--track:rgba(8,12,36,.5);position:relative;overflow:hidden;padding:0 18px 18px;border:3px solid #f8f2df;border-radius:14px;background:repeating-linear-gradient(180deg,rgba(8,12,36,.08) 0 1px,transparent 1px 3px),repeating-linear-gradient(135deg,rgba(255,255,255,.035) 0 16px,transparent 16px 32px),linear-gradient(180deg,#2c4aa6,#1e3278 46%,#131d4c);box-shadow:0 0 0 3px #10183a,6px 6px 0 3px #10183a;font-family:"Hiragino Maru Gothic ProN","Yu Gothic UI","PingFang SC","Microsoft YaHei UI",sans-serif}
.theme-afterschool .title{margin:0 -18px 16px;padding:20px 18px 34px;border-bottom:3px solid #10183a;background:radial-gradient(circle at 50% 100%,#f5ecd5 0 7px,transparent 7.6px) 0 100%/22px 7px repeat-x,radial-gradient(circle at 50% 100%,#1f2a44 0 9.4px,transparent 10px) 0 100%/22px 10px repeat-x,repeating-linear-gradient(90deg,#d8402f 0 22px,#f4ecd6 22px 44px,#6d8fb3 44px 66px,#f4ecd6 66px 88px) 0 100%/100% 22px no-repeat,linear-gradient(#1f2a44,#1f2a44) 0 calc(100% - 22px)/100% 2.5px no-repeat,#f8f2df;color:#d8402f;font:900 30px/1.15 Bahnschrift,"DIN Condensed","Arial Narrow","PingFang SC","Microsoft YaHei UI",sans-serif;letter-spacing:.08em;text-shadow:1.6px 0 0 rgba(47,160,175,.5),-1.2px 0 0 rgba(244,197,49,.6)}.theme-afterschool .title::after{content:"'99 10 24   PM 4:30";display:block;margin-top:6px;font:700 10px/1.3 Consolas,Menlo,monospace;letter-spacing:.22em;color:#e8731c;text-shadow:none;white-space:pre}
.theme-afterschool .group{margin-top:12px;padding:10px 14px;border:2px solid #f8f2df;border-radius:9px;background:linear-gradient(180deg,rgba(104,150,246,.5),rgba(34,58,146,.52) 55%,rgba(16,26,78,.6));box-shadow:inset 0 0 0 2px rgba(16,24,58,.55),4px 4px 0 #10183a}.theme-afterschool .group+.group{border-top:2px solid #f8f2df}
.theme-afterschool .gname{display:inline-block;margin-bottom:6px;padding:1px 14px 1px 10px;border:2px solid #10183a;border-radius:3px 10px 3px 3px;background:#ffd23e;box-shadow:3px 3px 0 #10183a;font-weight:900;font-size:14px;letter-spacing:.18em;color:#10183a}.theme-afterschool .gname::before{content:"✦ ";color:#d8402f}
.theme-afterschool .label{font-weight:700;letter-spacing:.14em;color:#bcc9f2}.theme-afterschool .value{font:700 18px/1.3 Bahnschrift,"DIN Alternate","Arial Narrow",Arial,"PingFang SC","Microsoft YaHei UI",sans-serif;text-shadow:1.5px 1.5px 0 #10183a}
.theme-afterschool .meter{height:14px;border:2px solid #10183a;border-radius:3px;background:#0b1232;box-shadow:0 0 0 1.5px rgba(253,246,220,.8);overflow:hidden}.theme-afterschool .meter>i{border-radius:0;background:repeating-linear-gradient(90deg,transparent 0 8px,#0b1232 8px 10px),linear-gradient(180deg,#c9ff8f,#48d86e 50%,#1f9a55)}
.theme-afterschool .tag{border:1.5px solid #10183a;border-radius:999px;background:#f6b9bd;padding:0 10px;font-weight:700;color:#10183a}.theme-afterschool .stars{color:#ffd23e;-webkit-text-stroke:.9px #10183a}
.theme-afterschool .tab{border:2px solid rgba(253,246,220,.35);border-radius:4px;background:rgba(8,12,36,.28);font-weight:700;letter-spacing:.14em;color:#bcc9f2}.theme-afterschool .tab.on{border-color:#10183a;background:#f8f2df;box-shadow:0 0 0 2px #f8f2df,3px 3px 0 2px #10183a;color:#10183a}
.theme-lineart{--bg:#d9d5ce;--line:rgba(38,36,34,.22);--ink:#262422;--muted:#55514b;--faint:#88837b;--ok:#3a6a50;--bad:#d5382c;--accent:#d5382c;--soft:rgba(213,56,44,.1);--track:rgba(38,36,34,.16);position:relative;padding:24px 24px 22px;border:0;border-radius:4px;background:linear-gradient(rgba(38,36,34,.62),rgba(38,36,34,.62)) 10px 10px/calc(100% - 20px) 1px no-repeat,linear-gradient(rgba(38,36,34,.62),rgba(38,36,34,.62)) 10px calc(100% - 10px)/calc(100% - 20px) 1px no-repeat,linear-gradient(rgba(38,36,34,.62),rgba(38,36,34,.62)) 10px 10px/1px calc(100% - 20px) no-repeat,linear-gradient(rgba(38,36,34,.62),rgba(38,36,34,.62)) calc(100% - 10px) 10px/1px calc(100% - 20px) no-repeat,linear-gradient(rgba(38,36,34,.045) 1px,transparent 1px) 0 10px/24px 24px,linear-gradient(90deg,rgba(38,36,34,.045) 1px,transparent 1px) 10px 0/24px 24px,#d9d5ce;box-shadow:0 0 0 1px rgba(38,36,34,.16),0 16px 30px -24px rgba(30,28,24,.55);font-family:Bahnschrift,"Avenir Next","Helvetica Neue","Segoe UI",Arial,"PingFang SC","Microsoft YaHei UI",sans-serif}
.theme-lineart .title{font-weight:700;font-size:28px;line-height:1.1;color:#262422;margin-bottom:16px}.theme-lineart .title::after{content:"FIG. 01 / STATUS RECORD";display:block;width:fit-content;margin-top:10px;padding-top:6px;border-top:1px solid rgba(38,36,34,.55);font:500 9px/1.2 Consolas,Menlo,monospace;letter-spacing:.16em;color:#55514b}
.theme-lineart .gname{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px;color:#262422}.theme-lineart .gname::after{content:"";flex:1;height:7px;background:radial-gradient(circle,transparent 0 1.9px,#262422 2px 2.9px,transparent 3.1px) right center/7px 7px no-repeat,linear-gradient(rgba(38,36,34,.55),rgba(38,36,34,.55)) left center/calc(100% - 8px) 1px no-repeat}
.theme-lineart .group+.group{border-top:0}
.theme-lineart .label{font:500 11.5px/1.7 Consolas,Menlo,"PingFang SC","Microsoft YaHei UI",monospace;letter-spacing:.06em;color:#55514b}.theme-lineart .value{font-weight:700;font-size:16px}
.theme-lineart .meter{height:11px;border-radius:0;background:repeating-linear-gradient(90deg,rgba(38,36,34,.3) 0 1px,transparent 1px 6px) 0 100%/100% 6px no-repeat,linear-gradient(rgba(38,36,34,.55),rgba(38,36,34,.55)) 0 100%/100% 1px no-repeat}.theme-lineart .meter>i{border-radius:0;border-right:2px solid #d5382c;background:repeating-linear-gradient(90deg,#262422 0 1px,transparent 1px 6px) 0 100%/auto 9px no-repeat,linear-gradient(#262422,#262422) 0 100%/100% 2px no-repeat}
.theme-lineart .tag{border:1px solid rgba(38,36,34,.55);border-radius:4px;background:none;padding:0 9px}.theme-lineart .stars{color:#262422}
.theme-lineart .tab{border:0;border-radius:0;font-family:Consolas,Menlo,"PingFang SC","Microsoft YaHei UI",monospace;letter-spacing:.08em;color:var(--faint)}.theme-lineart .tab.on{background:linear-gradient(#d5382c,#d5382c) 50% 100%/2px 7px no-repeat;color:var(--ink)}
.theme-signal{--bg:#0a0c0c;--line:rgba(196,210,206,.16);--ink:#d9e8e3;--muted:#93a8a2;--faint:#63756f;--ok:#9fe8d2;--bad:#e79a8e;--accent:#9fe8d2;--soft:rgba(159,232,210,.1);--track:rgba(159,232,210,.14);position:relative;overflow:hidden;padding:20px 22px;border:1px solid rgba(196,210,206,.18);border-radius:12px;background:radial-gradient(ellipse 46% 120px at 78% 0,rgba(159,232,210,.2),transparent 100%),linear-gradient(90deg,#0a0c0c 3px,transparent 3px) 0 0/8px 8px,linear-gradient(#0a0c0c 3px,transparent 3px) 0 0/8px 8px,#151d1b;box-shadow:0 14px 30px -22px #000;color:#d9e8e3;font-family:"Cascadia Mono","SF Mono",Menlo,Consolas,"PingFang SC","Microsoft YaHei UI",sans-serif}
.theme-signal .title{margin-bottom:16px;font-weight:600;font-size:23px;letter-spacing:.14em;color:#effffa;text-shadow:0 0 16px rgba(159,232,210,.5)}.theme-signal .title::before{content:"LIVE TRACE  ·  07 NODES";display:table;margin-bottom:10px;padding:3px 8px;border:1px solid rgba(196,210,206,.3);background:#0a0c0c;font:600 9.5px/1.3 Consolas,Menlo,monospace;letter-spacing:.22em;color:#d9e8e3;text-shadow:none}
.theme-signal .gname{font-weight:600;font-size:13.5px;letter-spacing:.16em;color:#effffa;padding-bottom:5px;border-bottom:1px solid rgba(196,210,206,.16)}.theme-signal .gname::before{content:"SECTOR";margin-right:10px;padding:2px 7px;border:1px solid rgba(196,210,206,.3);font:600 9.5px/1.4 Consolas,Menlo,monospace;letter-spacing:.2em;color:#d9e8e3;vertical-align:middle}
.theme-signal .group+.group{border-top:0}
.theme-signal .label{font-size:11.5px;letter-spacing:.16em;color:#93a8a2}.theme-signal .value{font-weight:600;font-size:15px;color:#effffa;text-shadow:0 0 10px rgba(159,232,210,.4)}
.theme-signal .meter{height:9px;border-radius:0;background:linear-gradient(90deg,rgba(159,232,210,.16) 5px,transparent 5px) 0 0/8px 100%}.theme-signal .meter>i{border-radius:0;background:linear-gradient(90deg,rgba(159,232,210,.82) 5px,transparent 5px) 0 0/8px 100%;box-shadow:2px 0 0 #effffa,4px 0 10px rgba(159,232,210,.9)}
.theme-signal .tag{border:1px solid rgba(196,210,206,.3);border-radius:0;background:linear-gradient(135deg,#9fe8d2 4px,transparent 4.5px) 0 0/8px 8px no-repeat;padding:0 9px}.theme-signal .stars{color:#9fe8d2;text-shadow:0 0 8px rgba(159,232,210,.5)}
.theme-signal .tab{border:1px solid rgba(196,210,206,.16);border-radius:0;letter-spacing:.18em;color:var(--muted)}.theme-signal .tab.on{border-color:#9fe8d2;background:linear-gradient(135deg,#9fe8d2 4px,transparent 4.5px) 0 0/8px 8px no-repeat,rgba(159,232,210,.1);color:#9fe8d2}
.theme-mercury{--bg:#0b0b0d;--line:rgba(255,255,255,.12);--ink:#eef1f4;--muted:#a8aeb7;--faint:#747a84;--ok:#f4f6f8;--bad:#8f959e;--accent:#f4f6f8;--soft:rgba(255,255,255,.09);--track:rgba(255,255,255,.1);position:relative;overflow:hidden;padding:22px 22px 20px;border:0;border-radius:18px;background:radial-gradient(circle at 92% -30px,#fff 0 3px,#3a3d43 22px,#c9ced5 30px,#16171a 44px,#9aa0a9 58px,#fff 62px,#2b2d32 78px,#8d939c 96px,#0b0b0d 118px,#6d727b 134px,#e6e9ed 139px,#0b0b0d 158px,transparent 160px),radial-gradient(120% 70% at 50% 0,#17181b,transparent 70%),linear-gradient(180deg,#0d0d0f,#070708);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),inset 0 0 0 1px rgba(255,255,255,.08),0 18px 36px -24px #000;font-family:"Helvetica Neue","Segoe UI",Arial,"PingFang SC","Microsoft YaHei UI",sans-serif}
.theme-mercury .title{display:table;margin-bottom:16px;font-weight:800;font-size:28px;letter-spacing:.08em;color:#eef1f4;background:linear-gradient(180deg,#fff 0,#fff 36%,#aeb4bd 49%,#3a3d43 54%,#bfc5cd 63%,#fff 86%,#c3c8cf);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;filter:drop-shadow(0 2px 1px #000)}
.theme-mercury .gname{font-weight:700;font-size:12px;letter-spacing:.3em;color:#d9dde2}.theme-mercury .gname::before{content:"";display:inline-block;width:9px;height:9px;margin-right:10px;border-radius:50%;background:radial-gradient(circle at 34% 28%,#fff 0 14%,#c9ced5 30%,#3a3d43 62%,#9aa0a9);vertical-align:middle}
.theme-mercury .group+.group{border-top:1px solid rgba(255,255,255,.12)}.theme-mercury .label{letter-spacing:.14em;color:#a8aeb7}.theme-mercury .value{font-weight:600;font-size:16px;color:#fff}
.theme-mercury .meter{height:10px;border-radius:999px;background:linear-gradient(180deg,#020203,#1b1c20);box-shadow:inset 0 1px 2px #000,0 1px 0 rgba(255,255,255,.14)}.theme-mercury .meter>i{border-radius:999px;background:linear-gradient(180deg,#fdfefe 0,#d5d9df 20%,#7e848d 46%,#26282c 56%,#8f959e 76%,#e4e7eb);box-shadow:0 0 10px rgba(255,255,255,.22)}
.theme-mercury .tag{border:0;border-radius:999px;background:linear-gradient(162deg,rgba(255,255,255,.1),rgba(255,255,255,.03) 38%,rgba(0,0,0,.25));box-shadow:inset 0 1px 0 rgba(255,255,255,.28),inset 0 0 0 1px rgba(255,255,255,.09);padding:0 12px;color:#dfe3e8}.theme-mercury .stars{color:#f4f6f8}
.theme-mercury .tab{border:0;border-radius:999px;background:rgba(255,255,255,.06);box-shadow:inset 0 1px 0 rgba(255,255,255,.28),inset 0 0 0 1px rgba(255,255,255,.09);font-weight:600;letter-spacing:.14em;color:var(--muted)}.theme-mercury .tab.on{background:linear-gradient(180deg,#fff 0,#f1f3f5 34%,#cdd2d8 58%,#a2a8b1 80%,#d9dde2);box-shadow:inset 0 1px 0 #fff;color:#050506}
.theme-redink{--bg:#f1efea;--line:rgba(13,13,13,.16);--ink:#0d0d0d;--muted:#33312e;--faint:#7a7772;--ok:#0d0d0d;--bad:#e1111c;--accent:#e1111c;--soft:rgba(225,17,28,.1);--track:rgba(13,13,13,.22);position:relative;overflow:hidden;padding:26px 20px 20px;border:1px solid rgba(13,13,13,.5);border-radius:0;background:radial-gradient(circle at calc(100% - 70px) 26px,#e1111c 0 40px,transparent 41px),linear-gradient(175deg,#f5f3ee,#eceae4);font-family:"PingFang SC","Microsoft YaHei UI","Microsoft YaHei",sans-serif}
.theme-redink::before{content:"";position:absolute;left:0;right:0;top:26px;height:74px;background:linear-gradient(90deg,#0d0d0d 0 4.5%,transparent 4.5% 6%,#0d0d0d 6% 60%,transparent 60% 61.5%,#0d0d0d 61.5% 88%,transparent 88% 90%,#0d0d0d 90% 100%);pointer-events:none}
.theme-redink .title{position:relative;z-index:1;display:table;margin:10px 0 34px 6%;padding:6px 16px 8px 0;background:#0d0d0d;color:#f3f1ec;font:400 30px/1.2 STXingkai,"Xingkai SC","Kaiti SC",KaiTi,serif;letter-spacing:.08em}
.theme-redink .gname{font-weight:900;font-size:18px;letter-spacing:.1em;color:#0d0d0d;border-bottom:3px solid #0d0d0d;padding-bottom:4px}.theme-redink .group+.group{border-top:0}
.theme-redink .label{display:inline-block;padding:0 7px;background:#0d0d0d;color:#f3f1ec;font-weight:700;font-size:11.5px;letter-spacing:.16em}.theme-redink .value{font:700 17px/1.3 Bahnschrift,"DIN Alternate","Arial Narrow","PingFang SC","Microsoft YaHei UI",sans-serif}
.theme-redink .meter{height:9px;border-radius:0;background:linear-gradient(rgba(13,13,13,.22),rgba(13,13,13,.22)) center/100% 1px no-repeat}.theme-redink .meter>i{border-radius:0;background:#0d0d0d;border-right:3px solid #e1111c}
.theme-redink .tag{border:0;border-radius:0;background:#0d0d0d;color:#f3f1ec;padding:0 9px;font-weight:700}.theme-redink .stars{color:#e1111c}
.theme-redink .tab{border:1.5px solid #0d0d0d;border-radius:0;font-weight:700;letter-spacing:.16em;color:#0d0d0d}.theme-redink .tab.on{background:#0d0d0d;color:#f3f1ec;box-shadow:4px 4px 0 #e1111c}
.theme-kaleido{--bg:#0b0b0f;--line:rgba(255,255,255,.14);--ink:#f6f4f1;--muted:#c2bece;--faint:#8f8b9d;--ok:#c6f03c;--bad:#ff5c86;--accent:#ff5a24;--soft:rgba(255,90,36,.16);--track:rgba(255,255,255,.1);position:relative;overflow:hidden;padding:22px 22px 20px;border:0;border-radius:10px;background:radial-gradient(70% 90px at 100% 0,rgba(255,61,180,.55),transparent 70%),radial-gradient(60% 80px at 70% 0,rgba(111,123,255,.5),transparent 72%),radial-gradient(50% 70px at 40% 0,rgba(255,90,36,.45),transparent 74%),radial-gradient(40% 60px at 88% 26px,rgba(198,240,60,.35),transparent 70%),#0b0b0f;box-shadow:0 0 0 1px rgba(255,255,255,.09),0 18px 36px -24px rgba(0,0,0,.85);font-family:"Helvetica Neue","Segoe UI",Arial,"PingFang SC","Microsoft YaHei UI",sans-serif}
.theme-kaleido .title{margin:36px 0 18px;font-weight:900;font-size:28px;letter-spacing:.04em;color:#fff;text-shadow:-1.5px 0 0 rgba(255,42,85,.9),1.5px 0 0 rgba(42,212,255,.9),0 2px 14px #000}
.theme-kaleido .gname{font-weight:800;font-size:16px;letter-spacing:.08em;color:#fff;border-bottom:1px solid;border-image:linear-gradient(90deg,#ff5a24,#ff4f9e 36%,transparent) 1;padding-bottom:4px}.theme-kaleido .group:nth-of-type(even) .gname{border-image:linear-gradient(90deg,#8f9bff,#2fd9ff 36%,transparent) 1}
.theme-kaleido .group+.group{border-top:0}.theme-kaleido .label{font-weight:600;letter-spacing:.1em;color:#c2bece}.theme-kaleido .value{font-weight:700;font-size:16px;color:#fff}
.theme-kaleido .meter{height:8px;border-radius:999px}.theme-kaleido .meter>i{border-radius:999px;background:linear-gradient(90deg,#8a3216,#ff5a24 42%,#ff4f9e);box-shadow:0 0 14px -3px #ff5a24}.theme-kaleido .group:nth-of-type(even) .meter>i{background:linear-gradient(90deg,#48508a,#8f9bff 42%,#2fd9ff);box-shadow:0 0 14px -3px #8f9bff}
.theme-kaleido .tag{border:1px solid rgba(255,255,255,.36);border-radius:2px;background:rgba(255,255,255,.04);padding:0 9px;font-weight:600;color:#fff;box-shadow:-1.5px 0 0 #ff2a55,1.5px 0 0 #2ad4ff}.theme-kaleido .stars{color:#c6f03c}
.theme-kaleido .tab{border:0;border-radius:0;font-weight:700;letter-spacing:.14em;color:var(--faint)}.theme-kaleido .tab.on{background:linear-gradient(90deg,#ff5a24,#ff4f9e,#b86bff,#8f9bff,#2fd9ff,#c6f03c) left bottom/100% 2px no-repeat;color:#fff}`

// An extension that renders the block in a frame of its own (小白X) leaves out what Tavern Helper puts there: `mvu` and `floor`
// fall back on the page around it, or the bar shows only its title.
export const BAR_LOAD = `const mvu=()=>{try{return typeof Mvu!=='undefined'?Mvu:parent.Mvu}catch(e){return null}};
function floor(){
  if(typeof getCurrentMessageId==='function')return getCurrentMessageId();
  const mes=frameElement&&frameElement.closest('.mes');
  return mes?Number(mes.getAttribute('mesid')):'latest';
}
async function load(){
  try{if(typeof waitGlobalInitialized==='function')await waitGlobalInitialized('Mvu')}catch(e){}
  for(let i=0;i<40&&!mvu();i++)await new Promise(done=>setTimeout(done,250));
  try{const data=mvu().getMvuData({type:'message',message_id:floor()});draw((data&&data.stat_data)||{})}catch(e){draw({})}
}`

const BAR_SCRIPT = `
const unwrap=v=>Array.isArray(v)&&v.length===2&&typeof v[1]==='string'&&(typeof v[0]==='number'||typeof v[0]==='boolean')?v[0]:v;
const get=(o,p)=>p.split('.').reduce((a,k)=>a==null?undefined:a[k],o);
const text=v=>{v=unwrap(v);if(v==null)return'';if(typeof v!=='object')return String(v);if(Array.isArray(v))return v.map(text).join('、');return Object.entries(v).map(([k,x])=>k+'：'+text(x)).join('；')};
const tags=v=>{v=unwrap(v);if(v==null||v==='')return[];if(Array.isArray(v))return v.map(text);if(typeof v==='object')return Object.entries(v).map(([k,x])=>typeof unwrap(x)==='number'?k+' ×'+unwrap(x):k);return String(v).split(/[、，,;；]/).map(s=>s.trim()).filter(Boolean)};
const lines=v=>{v=unwrap(v);if(v==null||v==='')return[];if(Array.isArray(v))return v.map(text).filter(Boolean);if(typeof v==='object')return Object.entries(v).map(([k,x])=>k+'：'+text(x));return String(v).split(/\\n+/).map(s=>s.trim()).filter(Boolean)};
const h=(tag,cls,content)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(content!=null)e.textContent=content;return e};
function draw(stat,page){
  const bar=document.getElementById('bar');bar.replaceChildren();
  const pages=[...new Set(SPEC.fields.filter(f=>f.show!=='hidden'&&f.page).map(f=>f.page))];
  page=pages.length<2?null:page||pages[0];
  const groups=[];
  for(const f of SPEC.fields){
    if(f.show==='hidden')continue;
    if(page&&(f.page||pages[0])!==page)continue;
    const value=unwrap(get(stat,f.path));if(value===undefined)continue;
    const keys=f.path.split('.');const name=keys.length>1?keys[keys.length-2]:'';
    let g=groups.find(x=>x.name===name);if(!g)groups.push(g={name,rows:[]});
    const row=h('div','row');row.append(h('span','label',f.label||keys[keys.length-1]));
    const ratio=/^\\s*(-?[\\d.]+)\\s*\\/\\s*([\\d.]+)\\s*$/.exec(String(value));
    const n=Number(ratio?ratio[1]:value),low=ratio?0:f.min,high=ratio?Number(ratio[2]):f.max;
    if(f.show==='meter'&&Number.isFinite(n)&&high>low){const m=h('span','meter'),i=h('i');i.style.width=Math.max(0,Math.min(100,(n-low)/(high-low)*100))+'%';m.append(i);row.append(m,h('span','value',ratio?String(value).trim():String(n)))}
    else if(f.show==='rating'&&Number.isFinite(n)){const top=f.max||5,on=Math.max(0,Math.min(top,Math.round(n)));row.append(h('span','wide stars','★'.repeat(on)+'☆'.repeat(top-on)))}
    else if(f.show==='list'){const t=h('div','wide');const list=lines(value);if(!list.length)t.append(h('span','faint','—'));for(const x of list)t.append(h('div','line',x));row.append(t)}
    else if(f.show==='tags'||f.show==='stats'||f.show==='badge'){const t=h('span','tags wide');const list=tags(value);if(!list.length)t.append(h('span','faint','—'));for(const x of list)t.append(h('span','tag',x));row.append(t)}
    else if(f.show==='table'||f.show==='map'||f.show==='forms'){const t=h('div','wide');const rows=value&&typeof value==='object'?Object.entries(value).filter(([k])=>!k.startsWith('$')):[];if(!rows.length)t.append(h('span','faint','—'));for(const[k,x]of rows){const r=h('div','trow');r.append(h('b','',Array.isArray(value)?text(x):k));if(!Array.isArray(value))r.append(h('span','',text(x)));t.append(r)}row.append(t)}
    else if(f.show==='flag'){const on=Boolean(value)&&value!=='false'&&value!=='否';row.append(h('span','wide '+(on?'on':'faint'),on?'✓':'—'))}
    else row.append(h('span','wide',text(value)||'—'));
    g.rows.push(row);
  }
  const title=SPEC.title||(groups.length===1&&groups[0].name)||'';
  if(title)bar.append(h('div','title',title));
  if(page){const tabs=h('div','tabs');for(const p of pages){const b=h('button','tab'+(p===page?' on':''),p);b.type='button';b.onclick=()=>draw(stat,p);tabs.append(b)}bar.append(tabs)}
  for(const g of groups){const box=h('div','group');if(g.name&&g.name!==title)box.append(h('div','gname',g.name));box.append(...g.rows);bar.append(box)}
}
${BAR_LOAD}
load();`

/**
 * BAR_STYLE with the rules of one theme only (`theme`: its name, or its class as barLook gives it): each theme's are
 * long, and a copy of the page goes into every reply.
 */
export function barStyle(theme = '') {
  const own = String(theme).trim().replace(/^theme-/, '')
  return BAR_STYLE.split('\n').filter(line => !/\.theme-[a-z]/.test(line) || (own && line.includes(`.theme-${own}`))).join('\n')
}

/** The class and the colors of a bar, for anything drawn to go with it. */
export function barLook(spec) {
  const theme = spec.theme && spec.theme !== 'plain' ? ` theme-${spec.theme}` : ''
  const colors = spec.palette ? paletteColors(spec.palette) : null
  // A card's own colors, set on the bar so they stand in both light and dark.
  const style = colors ? ` style="--bg:${colors.surface};--ink:${colors.ink};--accent:${colors.accent};--muted:${colors.muted};--faint:${colors.faint};--line:${colors.line};--track:${colors.track};--soft:${colors.soft}"` : ''
  return { theme, style }
}

/**
 * The status bar as one HTML block for a SillyTavern regex replacement.
 * @param english - the card's language, for the few words a bar says itself.
 */
// A bar drawn by this app's own code in SillyTavern (it wears a look, has 动效, or a 小手机 with something in it) is a
// whole page of tens of thousands of characters, made anew for every reply that has one. Only the latest replies get
// it there (a regex's 最大深度): a long chat would otherwise open with a hundred of them.
export const wholeFrame = spec => Boolean(spec?.skin || spec?.effect || spec?.layout || (spec?.phone && phoneApps(spec).apps.length))
export const STATUS_DEPTH = 2

export function statusBarHtml(spec, { english = false } = {}) {
  // A whole page: Tavern Helper leaves a code block as code unless it has html>, <head> or <body in it.
  const page = (style, body) => ['```html', '<!DOCTYPE html>', '<html><head><meta charset="utf-8">', `<style>${style}</style>`, '</head><body>', body, '</body></html>', '```'].join('\n')
  // 定制外观 is written for the bar this app draws: that bar's own drawing code goes into the frame (status-frame.mjs),
  // a good deal longer than the plain one below.
  if (wholeFrame(spec)) {
    const frame = skinnedFrame(spec, { english, load: BAR_LOAD })
    return page(frame.style, `<script>${frame.script}</script>`)
  }
  const data = JSON.stringify(spec).replace(/</g, '\\u003c')
  const { theme, style } = barLook(spec)
  return page(barStyle(theme), `<div class="bar${theme}" id="bar"${style}></div>\n<script>const SPEC=${data};${BAR_SCRIPT}</script>`)
}

/** A regex script as a card keeps it. */
export const regexEntry = (id, scriptName, findRegex, replaceString, options) => ({
  id, scriptName, findRegex, replaceString, trimStrings: [], placement: [2], disabled: false,
  markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null, ...options,
})

/** The SillyTavern side: the bar's display regex and the one that keeps its placeholder from the model. */
export function statusScripts(spec, words) {
  return [
    regexEntry(`${OWN_STATUS_SCRIPT}-hide`, words.hidePlaceholder, '<StatusPlaceHolderImpl/>', '', { promptOnly: true }),
    regexEntry(OWN_STATUS_SCRIPT, words.statusBar, '<StatusPlaceHolderImpl/>', statusBarHtml(spec, { english: words.english === true }), { markdownOnly: true, ...(wholeFrame(spec) ? { maxDepth: STATUS_DEPTH } : {}) }),
  ]
}

/** A card's scripts with the bar's SillyTavern copy made again from `spec`: for a layout changed after they were written. */
export const withStatusCopy = (scripts, spec, english) => (Array.isArray(scripts) ? scripts : []).map(script => (script.id === OWN_STATUS_SCRIPT
  // How far back it is drawn follows what it is: a whole page for the latest replies only; a depth set by hand stays.
  ? { ...script, replaceString: statusBarHtml(spec, { english }), maxDepth: wholeFrame(spec) ? script.maxDepth ?? STATUS_DEPTH : script.maxDepth === STATUS_DEPTH ? null : script.maxDepth ?? null }
  : script))

// MagVarUpdate, the script SillyTavern cards use to apply <UpdateVariable> blocks and
// show the placeholder. Only Tavern Helper runs it; this app has the same built in.
export const MVU_HELPER_ID = '6d1f4c2a-8e3b-4f5a-9c7d-c1ca7a7e5b01'
const MVU_IMPORT = "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js'"

export function mvuHelper(words) {
  return {
    scripts: [{
      type: 'script',
      enabled: true,
      id: MVU_HELPER_ID,
      name: 'MVU',
      content: MVU_IMPORT,
      info: words.mvuInfo,
      button: { enabled: true, buttons: [{ name: '重新处理变量', visible: true }, { name: '重新读取初始变量', visible: true }] },
      data: {},
    }],
    variables: {},
  }
}

// ─── A layout a model writes (检查这张卡, 对话修改) ─────────────────────────

/** How a model writes a layout: the <status_bar> block and what goes in it, for the format part of a system prompt. */
export const STATUS_FORMAT = () => `<status_bar>{"title": "标题，可空", "theme": "editorial", "fields": [{"path": "变量路径", "label": "短名", "show": "meter", "min": 0, "max": 100, "page": "页名，两三个字，可不写"}]}</status_bar>
  show 可选：${SHOWS.join('、')}。meter 要写 min 和 max，rating 要写 max。theme 可选：${STATUS_THEMES.join('、')}（editorial 是文艺杂志风：近白透一点清水蓝的纸、宋体和衬线字；meadow 是晴野：手绘线条、草地和小动物，明快可爱；sigil 是夜曜纹章：黑曜石、鎏金和绯红魔纹，西幻暗黑；daybreak 是晨笺：晨间手账风，暖白的纸，书脊竖排大字，雾蓝的衬线标题配花体字，磨砂面板，清爽雅致；aquarelle 是天光云影：水彩写生本，米白水彩纸、手绘墨线框，顶上的水彩天空随故事时间变化（状态栏里要有一个叫「时间」的变量才会变），楷体手写感，温柔通透；cobalt 是钴蓝：单色孔版印刷风，再生纸上一种钴蓝油墨，整块蓝底反白标题、网点、编号、粗体窄字，利落有冲击力；afterschool 是放课后：昭和招牌加千禧年游戏机菜单的感觉：奶油色搪瓷招牌和番茄红大字做标题，下面是深蓝的菜单底、白边蓝窗、明黄名牌、像素格数值条和视觉小说式对话框，带一点显像管扫描线，怀旧又俏皮；lineart 是线稿：工程图纸风，暖灰方格纸带图框和标题栏，近黑的均匀细线画一台拆开的机器人和引线标注，粗黑无衬线标题配等宽小字，尺寸线式数值条带红色箭头，冷静精致；signal 是信号：高科技追踪屏风，近黑的底只用一种薄荷绿，小格子点阵、方框和坐标读数、汇向目标的细线，等宽大写小标签，分组按扇区编号，数值条是一排格子，冷静利落；mercury 是流银：液态金属风，近黑的底，镀铬波纹和抛光金属字，暗色玻璃面板带一道亮边，水银管一样的数值条，只用银白灰黑，冷而有光泽；redink 是赤墨：暗黑撞色风，颗粒感白纸、大块纯黑、只用一种正红，毛笔字反白标题、黑底白字的小标签、红色印章，凌厉有冲击力；kaleido 是万华：黑底撞色，整条状态栏都是颜色：全色喷流、红绿蓝错开的圆环和碎片、虹彩边框，每组一块镶色黑玻璃加斜切色块组名，粗渐变数值条，张扬有冲击力）。写全所有要显示的变量。
  按这张卡配色时不写 theme，写 "palette": {"bg": "#101820", "ink": "#f2f2f2", "accent": "#e0a030"}，三个都是六位颜色，分别是背景、文字、强调。theme、palette 和 page 不改就不写，原样留着。`

const themeNames = () => ({ editorial: msg`文艺杂志`, meadow: msg`晴野`, sigil: msg`夜曜纹章`, daybreak: msg`晨笺`, aquarelle: msg`天光云影`, cobalt: msg`钴蓝`, afterschool: msg`放课后`, lineart: msg`线稿`, signal: msg`信号`, mercury: msg`流银`, redink: msg`赤墨`, kaleido: msg`万华` })

/** A layout in lines, as a change's before and after read: all of it, a change gone out of date is told by these. */
export function statusLines(spec) {
  if (!spec) return ''
  const { palette, skin } = spec
  const head = [
    spec.title ? `${msg`标题`}: ${spec.title}` : '',
    spec.theme ? `${msg`主题`}: ${themeNames()[spec.theme] ?? spec.theme}` : '',
    // Its rules are not for reading in a line: which look it is tells one from another.
    skin ? `${msg`定制外观`}: ${skin.name || msg`未命名`} (${skinClass(skin.css).slice(5)})${skin.base ? ` · ${msg`叠在 ${themeNames()[skin.base] ?? skin.base} 上`}` : ''}` : '',
    palette ? `${msg`配色`}: ${msg`背景`} ${palette.bg} · ${msg`文字`} ${palette.ink} · ${msg`强调`} ${palette.accent}` : '',
    spec.portrait || spec.scene ? `${msg`图片`}: ${[spec.portrait ? msg`立绘` : '', spec.scene ? msg`场景图` : ''].filter(Boolean).join(' · ')}` : '',
    spec.effect ? `${msg`动效`}: ${spec.effect}` : '',
    spec.phone ? msg`小手机` : '',
    spec.layout ? `${msg`版式`}: ${spec.layout}` : '',
    spec.map ? `${msg`地图`}: ${spec.map.places.map(place => (place.x === undefined ? place.name : `${place.name} (${place.x}, ${place.y})`)).join(' · ')}${spec.map.here ? ` · ${spec.map.here}` : ''}` : '',
  ].filter(Boolean)
  return [...head, ...spec.fields.map(field => `${field.label || field.path} (${field.path}): ${field.show}${field.page ? ` · ${msg`页`}: ${field.page}` : ''}`)].join('\n')
}

export const statusChange = (before, after, more = {}) => ({ id: 'statusBar', kind: 'statusBar', spec: after, before: statusLines(before), after: statusLines(after), ...more })

/** Whether a card shows a status bar of its own making: a regex or a script draws it, not a layout. */
export function drawsOwnBar(card) {
  const scripts = Array.isArray(card.regexScripts) ? card.regexScripts : []
  return scripts.some(script => !script.disabled && /StatusPlaceHolderImpl|状态栏|status/i.test(`${script.findRegex}${script.scriptName}`))
}

/** The card's layout as a model reads it, or why there is none to write. */
export function statusPart(card) {
  if (card.statusBar) {
    // A look of the card's own is long and not the model's to rewrite here: said in a line. The theme it goes over is
    // the look's, left out of the layout (written back as it is, it would read as a theme picked in its place).
    const { skin, ...layout } = card.statusBar
    if (skin?.base) delete layout.theme
    const kept = skin ? `\n（这张卡的状态栏有一套定制外观${skin.name ? `「${skin.name}」` : ''}${skin.base ? `，叠在主题 ${skin.base} 上` : ''}，改布局时程序会原样留着，不用写；写了 theme 就会换掉它。）` : ''
    return `<status_bar>${JSON.stringify(layout)}</status_bar>${kept}`
  }
  return drawsOwnBar(card) ? '（这张卡用自己的正则或脚本画状态栏，不要写 <status_bar>）' : '（这张卡还没有状态栏布局）'
}

/** A layout as written, over what it says nothing of: the look and the pages stay as the card has them. */
function withOwnLook(spec, written, before) {
  if (!before) return spec
  const look = written.theme === undefined && !spec.palette ? { ...(before.theme ? { theme: before.theme } : {}), ...(before.palette ? { palette: before.palette } : {}) } : {}
  // 定制外观 stays till a theme is written in its place (the one it goes over, written back, is no other).
  const skin = before.skin && (written.theme === undefined || written.theme === before.skin.base) ? { skin: before.skin } : {}
  const paged = written.fields.some(field => field?.page !== undefined)
  const pageOf = field => before.fields.find(item => item.path === field.path)?.page
  return { ...spec, ...look, ...skin, fields: paged ? spec.fields : spec.fields.map(field => (pageOf(field) ? { ...field, page: pageOf(field) } : field)) }
}

/** A model's <status_bar> in an answer as a change to the card's layout: [] when there is none, or it cannot be read. */
export function readStatus(body, card) {
  if (drawsOwnBar(card) && !card.statusBar) return []
  const text = /<status_bar\b[^>]*>([\s\S]*?)(?:<\/status_bar>|$)/i.exec(body)?.[1]?.trim().replace(/^```\w*\n?|\n?```$/g, '')
  if (!text) return []
  let written
  try {
    written = YAML.parse(text)
  } catch {
    return []
  }
  const spec = cleanStatusSpec(written)
  return spec ? [statusChange(card.statusBar ?? null, withOwnLook(spec, written, card.statusBar), card.statusBar ? {} : { scripts: true })] : []
}

/** Variables a line each, `path: value`, for a model to pick a layout's paths from. */
export function variableLines(value, keys = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return keys.length ? [`${keys.join('.')}: ${JSON.stringify(value)}`] : []
  return Object.entries(value).filter(([key]) => !key.startsWith('$')).flatMap(([key, item]) => variableLines(item, [...keys, key]))
}
