<p align="center"><img src="docs/brand/banner.jpg" alt="CicaTavern" width="720"></p>

# CicaTavern

在自己电脑上运行的 SillyTavern 角色卡游玩工具。导入角色卡、世界书和预设，用**你自己的模型 API**（DeepSeek、OpenRouter、Anthropic、OpenAI、Gemini、Kimi、智谱、通义、火山方舟、本机 Ollama 等）跑剧情。数据全部存在本机。

## 快速开始（Windows）

1. 解压到任意位置（路径里有中文也可以）。
2. 双击 **「启动 CicaTavern.vbs」**：后台启动服务，并打开一个应用窗口（用 Edge 或 Chrome，没有地址栏）。想要桌面图标，运行一次 **「创建桌面快捷方式.cmd」**。
3. 第一次用：顶栏模型选择最下面的「管理模型供应商…」→「添加」→「从模板开始」，选一家，粘贴 API Key，再点「从接口获取模型列表」检查连接。然后在 设置 里选默认模型。
4. 左上「导入角色卡、世界书或预设」，选 SillyTavern 的 PNG / JSON 角色卡，点「新对话」开始。

自带 Node 运行环境（`runtime/node.exe`），不用另外安装任何东西。所有页面关掉约一分钟后，后台服务会自动退出；也可以在 设置 →「停止后台服务」立刻停止。

Windows 可能提示「已保护你的电脑」（脚本没有数字签名）：点「更多信息 → 仍要运行」。不放心的话，可以先看一下两个启动脚本的内容，都只有几行。

## 网络代理

访问海外接口（OpenRouter、Anthropic、OpenAI、Gemini 等）需要代理时，在 设置 →「网络代理」里选：

- **不用代理**（默认）
- **跟随系统代理**：读 Windows 的代理设置。Clash、v2rayN 这类工具开了「系统代理」时就是它；每分钟更新一次，开关代理工具不用重启酒馆。
- **指定代理地址**：例如 `http://127.0.0.1:7890`。只支持 HTTP 代理，SOCKS 不行（多数代理工具的混合端口两种都认）。

供应商设成「直连」的不走代理：模板里的 DeepSeek、Kimi、智谱、通义、火山方舟等国内服务默认就是直连。

## 主要功能

- 角色卡：SillyTavern V2/V3 的 PNG 和 JSON，含内嵌世界书、正则脚本、开场白。
- 世界书、预设：导入 SillyTavern 的世界书和 Chat Completion 预设，可以在界面里开关、编辑条目。
- MVU 变量和状态栏：支持 `<UpdateVariable>` / JSONPatch、`[InitVar]`，EJS 模板在 QuickJS 沙箱里执行。卡里的 HTML 界面在隔离的 iframe 里渲染，常用的酒馆助手接口有兼容层（会从 jsDelivr 加载 jQuery、Vue 等库，离线时这类界面可能缺东西）。
- 缓存友好：系统提示在建对话时固定，之后每轮只追加；Anthropic 接口自动打缓存断点。长对话可以「压缩上下文」。
- 版本与分支：重新生成、切换版本、从任意一条分支、回滚、编辑任意消息。
- 配图（可选）：辅助模型写画面提示词，后端可选 OpenAI 兼容图片接口、ComfyUI 工作流或 NovelAI。`examples/comfy-illustrious-api.json` 是一个 ComfyUI 文生图工作流示例，里面的模型名换成你自己的。
- 朗读（可选）：见下一节。
- 用量面板：按天汇总 token、缓存命中率和按公开单价估算的成本。

## 朗读

默认用**浏览器自带的语音**，免费、不用设置。在「配图与朗读」里给每张卡选「对白音色」和「旁白音色」：引号里的对白用对白音色，其余用旁白音色（不选就不读旁白）。点正文里的某句对白可以单独听这一句。

- 音色多少取决于浏览器和系统。Edge 有「Xiaoxiao Online (Natural)」等在线神经网络音色，效果最好；Chrome 有「Google 普通话」。
- 浏览器音色是每台设备自己的：换了设备没有同一个音色时，会用那台设备的默认中文音色。
- 也可以接一个语音服务：在「语音服务地址」填它的地址。服务要提供 `POST /api/tts`（`{ "text", "voice" }` → 音频）和 `GET /api/persona/list`（`{ "voices": [{ "name" }] }`）。读过的音频缓存在本机。

## 手机访问

设置 →「手机访问」改成「同一 WiFi 或 Tailscale」，重启服务后，设置里会出现带口令的链接，在手机浏览器打开即可。

- 只有这台电脑自己的地址能访问，别的网页不能调用这个接口。
- **不要把端口映射到公网**：拿到链接的人能用你的模型额度。出门时用 Tailscale。
- 手机打不开时，多半是 Windows 把 WiFi 标成了「公用网络」，或者防火墙拦了 Node.js：改成专用网络，再只放行这个端口的局域网入站。

## 数据

全部存在 `%USERPROFILE%\.cicatavern\`：角色卡、世界书、预设、对话、配图、`providers.json`（含 API Key，明文）。换电脑时整个文件夹拷过去即可。启动时加 `--data <目录>` 可以换位置（例如放进 U 盘做成便携版）：

```
runtime\node.exe bin\start.mjs --data D:\酒馆数据 --open
```

后台服务的日志在 `%USERPROFILE%\.cicatavern\logs\server.log`。

## 常见问题

- **双击没反应 / 提示没能启动**：看上面的日志；或者运行「Start-CicaTavern.cmd」，在黑色窗口里看报错。
- **端口 8790 被占用**：可能已经开着一个，直接打开 http://127.0.0.1:8790/ 。
- **海外接口连不上**：检查「网络代理」那一栏显示的「现在走 …」是不是你的代理。
- **回复被截断**：在供应商的「高级」里填「最大输出 token」。

## 从源码运行

需要 Node 24 以上。

```
npm install
npm start          # 启动并打开 http://127.0.0.1:8790/
npm test
npm run package    # 打包 Windows 版到 dist/（带上当前的 node.exe）
```

## 说明

- 本项目与 Anthropic、OpenAI、Google 等模型服务商没有关联。使用各家 API 时，请遵守它们的服务条款和使用政策；费用按你自己的账号计费。
- 使用 Claude 模型：在供应商里添加 Anthropic（官方 API Key）或 OpenRouter。Claude.ai 的订阅（Pro/Max）不能当 API Key 用。
- 角色卡、世界书、预设的版权归原作者所有。
- 各版本的改动见 [CHANGELOG.md](CHANGELOG.md)。
