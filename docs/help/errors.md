# 报错

CicaTavern 会弹出的报错：原文（中文和英文界面各一行）、什么时候出现、为什么、怎么办。按 启动与安装、模型与供应商、网络与代理、角色卡/世界书/预设导入、对话与生成、配图与朗读、手机访问、更新、其他 排列。

## 打开时提示找不到 runtime\node.exe 或 Node.js {#err-launch-node-missing}

- 平台：Windows
- 原文：找不到 runtime\node.exe。
- 原文：可能被杀毒软件隔离了：从隔离区恢复它，或者把安装包重新解压一遍。
- 原文：找不到 Node.js：安装 Node 24 以上，或者用发布包里的 CicaTavern.exe。
- 原文：找不到 bin\launch.mjs：安装文件夹不完整，把安装包重新解压一遍。
- 出现在：双击 CicaTavern.exe 之后弹出的窗口
- 原因：CicaTavern.exe 只是个启动器，真正运行的是旁边 runtime 文件夹里自带的 node.exe 和 bin 文件夹里的程序。它们被杀毒软件隔离、没解压完整，或者直接在压缩包里双击了 exe（只解出了 exe 本身），就会这样。
- 解决：把整个压缩包解压到一个普通文件夹再运行；被隔离的话从杀毒软件的隔离区恢复，并把这个文件夹加进信任。

1. 不要在压缩软件的窗口里直接双击 CicaTavern.exe，先「全部解压」。
2. 解压出来的文件夹里应该有 runtime、bin、server、web 等文件夹，缺了就重新解压一遍。
3. 杀毒软件（包括 Windows 安全中心）报了 node.exe 的，从隔离区恢复。runtime\node.exe 是 Node.js 官方签名的原版。

## 双击没反应或提示没能启动 {#err-launch-failed}

- 也叫：打不开、闪退、启动失败、点了没反应
- 平台：Windows
- 原文：CicaTavern没能启动。日志：{0}
- 原文：CicaTavern 没能启动（退出代码 {0}）。
- 原文：运行不了 {0}（错误 {1}）。
- 原文：没能启动：建立管道失败。
- 出现在：双击 CicaTavern.exe 之后
- 原因：后台服务没起来。弹窗里「日志」后面的几行就是服务自己说的原因，常见的是端口被占用、数据文件夹没有写入权限、文件被杀毒软件拦了。
- 解决：先看弹窗最后几行写了什么；看不懂就运行文件夹里的「排查问题（带控制台）.cmd」，在黑色窗口里看报错。

1. 弹窗里提到「端口 … 已被占用」的，见「端口 8790 被占用」一节。
2. 第一次打开时 Windows 弹「Windows 已保护你的电脑」的，见对应一节。
3. 服务的日志在 `%USERPROFILE%\.cicatavern\logs\server.log`。把日志或截图发到群里时，确认里面没有 API Key。
4. 应用窗口用 Edge 或 Chrome 打开（没有地址栏）。两个都没装时会用默认浏览器打开 http://127.0.0.1:8790/ 。

## 端口 8790 被占用 {#err-port-in-use}

- 也叫：端口占用、EADDRINUSE、另一个版本的酒馆
- 平台：Windows
- 原文：[CicaTavern] 端口 {0} 已被占用：可能已经在运行，直接打开 http://127.0.0.1:{0}/
- 原文：端口 {0} 上开着另一个版本的酒馆。关掉它，或者用 --port 换一个端口。
- 出现在：双击 CicaTavern.exe、运行「排查问题（带控制台）.cmd」时
- 原因：8790 端口已经有程序在用。多数时候是 CicaTavern 已经在后台开着（关掉窗口后服务还会再等一分钟才退出）；也可能是另一个版本的 CicaTavern，或者别的软件占了这个端口。
- 解决：先在浏览器里打开 http://127.0.0.1:8790/ 看看是不是已经能用。提示「另一个版本」时，在那个版本的「设置 → 更多 → 退出应用并停止后台服务」（旧版本叫「停止后台服务」）里停掉它，或者关掉所有窗口等一分钟再打开。

## Windows 已保护你的电脑 {#err-smartscreen}

- 也叫：SmartScreen、蓝色弹窗、无法识别的应用、报毒
- 平台：Windows
- 原文：Windows 已保护你的电脑
- 英文：Windows protected your PC
- 出现在：第一次双击 CicaTavern.exe 时
- 原因：CicaTavern.exe 目前没有数字签名，Windows 对没见过的程序都会这样提示，不是病毒。
- 解决：点「更多信息」→「仍要运行」，之后不会再问。应用内更新下载的新版本也不会再问。

## 桌面快捷方式没建成 {#err-shortcut-failed}

- 平台：Windows
- 原文：快捷方式没建成：{0}
- 原文：找不到要放快捷方式的文件夹。
- 原文：建不了快捷方式（IShellLink 不可用）。
- 原文：快捷方式保存不了：{0}
- 英文：Couldn't create the shortcut: {0}
- 出现在：设置 → 更多 → 桌面快捷方式
- 原因：桌面文件夹找不到或没有写入权限（比如桌面被同步盘、公司策略接管），或者 Windows 的快捷方式组件不可用。
- 解决：可以手动建：在程序文件夹里右键 CicaTavern.exe（Windows 11 先点「显示更多选项」）→「发送到」→「桌面快捷方式」。

## 供应商拒绝了请求：API Key 无效或没有权限 {#err-provider-key-rejected}

- 也叫：401、403、Unauthorized、Forbidden、invalid api key、密钥不对、key 失效
- 原文：{0} 拒绝了请求：API Key 无效或没有权限。（{1}）
- 英文：{0} rejected the request: the API key is invalid or lacks permission. ({1})
- 出现在：发出一轮对话、「从接口获取模型列表」、配图、朗读时
- 原因：供应商返回了 401 或 403：密钥填错、复制少了几位、已经删除或过期、这个密钥没有开通这个模型，或者密钥和 Base URL 不是同一家（比如国内站的密钥填了国际站地址）。括号里是供应商自己的原话。
- 解决：到供应商网站重新复制一份密钥，在「管理模型供应商…」里粘贴后点「从接口获取模型列表」检查。不要把 API Key 发到群里，截图前也遮住。

1. 打开顶栏模型选择最下面的「管理模型供应商…」（或 设置 → 模型 → 模型供应商），选这个供应商。
2. 粘贴新的 API Key（只要密钥本身，不要带前后的空格或「Bearer」）。
3. 点「从接口获取模型列表」：能列出模型就说明密钥和地址都对了。
4. 中转站的密钥只能配它自己的地址；Kimi、智谱等国内站和国际站的密钥不通用。

## 供应商返回 404 {#err-provider-404}

- 也叫：404 Not Found、model not found、模型不存在
- 原文：{0} 返回 404：检查 Base URL 和接口类型，或者模型 ID 是否写对。（{1}）
- 英文：{0} returned 404: check the Base URL and API type, and that the model ID is spelled correctly. ({1})
- 出现在：发出一轮对话、「从接口获取模型列表」时
- 原因：请求的地址不存在。多半是 Base URL 少了或多了一段（比如 /v1），接口类型选错（Anthropic 接口和 OpenAI 兼容接口地址不一样），或者模型 ID 拼错、这个供应商没有这个模型。
- 解决：照供应商文档核对 Base URL；从模板新建一个供应商最省事。模型 ID 用「从接口获取模型列表」列出来的，不要手打。

## 限流或额度用完了 {#err-provider-rate-limit}

- 也叫：429、Too Many Requests、rate limit、quota、insufficient_quota、RESOURCE_EXHAUSTED、额度不足、每天的额度、免费层、Free Tier、太挤了
- 原文：{0} 这个 Key 今天的额度用完了（429），约 {1}后恢复。换一个 Key，或者给它开通付费。（{2}）
- 原文：{0} 这个 Key 今天的额度用完了（429）。换一个 Key，或者给它开通付费。（{1}）
- 原文：{0} 一分钟内用得太多，被限流了（429），约 {1}后可以再发。别连着重试；每轮发得太长（上下文很大）也容易撞上，可以先压缩上下文。（{2}）
- 原文：{0} 一分钟内用得太多，被限流了（429），稍等一下再发。别连着重试；每轮发得太长（上下文很大）也容易撞上，可以先压缩上下文。（{1}）
- 原文：{0} 的额度或余额用完了（429）。去供应商那里充值，或者换一个 Key。（{1}）
- 原文：{0} 现在请求太频繁，被限流了（429）。稍后再试，或者先换个模型。（{1}）
- 原文：（已经自动重试了 {0} 次：这个模型这会儿比较挤，过一会再试，或者先换个模型。）
- 英文：{0}: this key's quota for today has run out (429); it comes back in about {1}. Use another key, or turn on billing for it. ({2})
- 英文：{0}: this key's quota for today has run out (429). Use another key, or turn on billing for it. ({1})
- 英文：{0} is limiting requests: too much in one minute (429). You can send again in about {1}. Don't retry over and over; very long turns (a large context) hit this limit too, so compacting the context helps. ({2})
- 英文：{0}: the quota or balance has run out (429). Top up with the provider, or use another key. ({1})
- 英文：{0} is limiting requests: too many right now (429). Try again later, or switch to another model for now. ({1})
- 英文：(Already retried {0} times automatically: this model is busy right now. Try again in a while, or switch to another model for now.)
- 出现在：发出一轮对话、配图时
- 原因：供应商返回了 429，不是你的网络问题。2.3.2 起按供应商的原话分开说：「今天的额度用完了」是这个 Key 当天能用的次数到了上限（Gemini 免费层每个模型每天只有很少几十次），会写多久后恢复；「一分钟内用得太多」是每分钟的请求次数或输入 token 到了上限，上下文很大时（几万 token 一轮）连着重试两三次就会撞上；「额度或余额用完了」是账户没钱或额度用尽；「请求太频繁」是供应商没说是哪种。
- 解决：今天的额度用完了就换一个 Key 或等它恢复，常用的话给 Key 所在的项目开通付费；一分钟的限流就等括号前写的时间再发，别连着点重试，上下文很大时先「压缩」；余额用完就去供应商网站充值。

## 供应商服务出错或太忙 {#err-provider-server-error}

- 也叫：500、502、503、504、529、Internal Server Error、Bad Gateway、overloaded、high demand、UNAVAILABLE、模型繁忙
- 原文：{0} 那边的模型现在太忙了（{1}，对方服务器繁忙，不是你的网络或设置的问题）。过几分钟再试，或者先换个模型。（{2}）
- 原文：{0} 的服务器出错了（{1}，是对方的问题，不是你的设置）。稍后重试，或者先换个模型。（{2}）
- 英文：{0}'s model is too busy right now ({1}: their servers are overloaded; it isn't your network or settings). Try again in a few minutes, or switch to another model for now. ({2})
- 英文：{0} had a server error ({1}: a problem on their side, not your settings). Try again in a moment, or switch to another model for now. ({2})
- 出现在：发出一轮对话、配图、朗读时
- 原因：供应商那边出了问题（返回 5xx）。「太忙了」是 503、529 或原话里写着 high demand、overloaded：这个模型这会儿用的人太多，Gemini 免费层高峰时经常这样。其余是服务出错、维护，或者中转站自己的上游出错。都不是你的网络或设置问题。
- 解决：过几分钟重试，或者先换一个模型、换一家供应商。中转站经常这样的，可以问问中转站的群。

## 中转站和 Responses 接口对不上 {#err-provider-responses}

- 也叫：param_override_invalid、operation append failed、operation not supported for type、参数覆盖、new_api_error、酒馆能用这里不能用、gemini 一直报错、中转站没有返回正文
- 原文：{0} 的中转站设置和 Responses 接口对不上：在「模型供应商」里把接口类型改成「OpenAI 兼容（Chat Completions）」再试。（{1}）
- 原文：{0} 的回复读不出来：这个中转站可能不支持 Responses 接口。在「模型供应商」里把接口类型改成「OpenAI 兼容（Chat Completions）」再试。
- 英文：{0}'s relay setup doesn't fit the Responses API: in Model providers, change its API type to "OpenAI-compatible (Chat Completions)" and try again. ({1})
- 英文：Couldn't read {0}'s reply: this relay may not support the Responses API. In Model providers, change its API type to "OpenAI-compatible (Chat Completions)" and try again.
- 出现在：发出一轮对话、配图写提示词、画场景时
- 原因：这个供应商的接口类型是「OpenAI Responses」，请求发到 …/responses，但中转站不是按这个接口配的。常见的有两种：中转站的渠道配了「参数覆盖」，要改的字段在这种请求里没有；或者中转站回的不是 Responses 的格式，读不出内容。用「OpenAI」模板建供应商再换成中转站地址时，接口类型就是 Responses。
- 解决：设置 → 模型 → 模型供应商，打开这个供应商，把「接口类型」改成「OpenAI 兼容（Chat Completions）」，Base URL 不用动，保存后再发一条。还是报 param_override_invalid 的话，是中转站渠道本身的设置问题，把报错里的 request id 发给站长。

## 供应商返回了别的错误（余额不足、参数不对） {#err-provider-other}

- 也叫：402、余额不足、Insufficient Balance、400、Bad Request、invalid parameter
- 原文：{0}：{1}
- 原文：生成失败
- 英文：{0}: {1}
- 英文：Generation failed
- 出现在：发出一轮对话、配图、朗读时
- 原因：供应商返回了上面几节以外的错误，冒号后面是它的原话。常见的：402 或「Insufficient Balance」「余额不足」是账户没钱了；400 多是请求参数这个模型不接受（温度、额外请求参数、思考设置）；「生成失败」是供应商中途报错但没说原因。
- 解决：余额不足去供应商网站充值；400 的话检查这个供应商「高级」里填的温度、额外请求参数、额外请求头，清空再试；还不行换个模型。看不懂原话可以截图问群（遮住 API Key）。

## 供应商还没有填 API Key {#err-provider-no-key}

- 原文：供应商「{0}」还没有填 API Key
- 英文：Provider "{0}" has no API key yet
- 出现在：发出一轮对话时
- 原因：选的模型属于一个没填 API Key 的供应商。本机或局域网里的模型服务（LM Studio、Ollama）不用密钥，别的都要。
- 解决：在「管理模型供应商…」里给它粘贴 API Key。安卓版和电脑版的数据不通，手机上要再填一次。

## 保存供应商时提示填写不对 {#err-provider-form}

- 原文：API Key 里不能有空格或换行
- 原文：Base URL 不是有效的地址
- 原文：Base URL 只能是 http 或 https
- 原文：Base URL 里不要带账号密码，密钥填在 API Key 里
- 原文：至少填一个模型 ID
- 原文：把 Base URL 里的 PROJECT_ID 换成你的 Google Cloud 项目 ID（控制台顶部项目选择器里的「ID」）
- 英文：The API key can't contain spaces or line breaks
- 英文：The Base URL isn't a valid address
- 英文：The Base URL must be http or https
- 英文：Don't put a username or password in the Base URL. The key goes in the API Key field
- 英文：Add at least one model ID
- 英文：Replace PROJECT_ID in the Base URL with your Google Cloud project ID (the ID in the project picker at the top of the console)
- 出现在：管理模型供应商 → 保存
- 原因：填的内容格式不对。最常见的是复制密钥时带上了空格、换行，或者把整句「Authorization: Bearer …」都粘了进来。
- 解决：只粘贴密钥本身；Base URL 写成 https://… 开头的完整地址；模型至少留一个（可以点「从接口获取模型列表」填）。Gemini Agent Platform 的地址里要把 PROJECT_ID 换成自己的项目 ID。

## 不支持的接口类型 {#err-provider-api-type}

- 原文：不支持的接口类型
- 原文：不支持的接口类型：{0}
- 英文：Unsupported API type
- 英文：Unsupported API type: {0}
- 出现在：导入别人分享的供应商文件、发出一轮对话时
- 原因：供应商的「接口类型」是这个版本不认识的，多半是文件来自更新的版本，或者文件被手动改过。
- 解决：把 CicaTavern 更新到最新版再导入；或者从模板新建这个供应商，重新粘贴密钥。

## 模型后面显示「（不可用）」 {#err-model-unavailable}

- 也叫：模型不见了、模型没了、不可用
- 原文：{0}（不可用）
- 原文：供应商「{0}」已经删除，换一个模型再试
- 英文：{0} (unavailable)
- 英文：Provider "{0}" has been deleted. Pick another model and try again
- 出现在：顶栏模型选择、创作角色卡和对话修改的模型选择
- 原因：这个对话（或这个窗口）记着的模型已经找不到了：供应商被删了，或者供应商的模型列表里删掉了这个模型。
- 解决：在顶栏的模型选择里换一个现在有的模型，或者选「默认」。

## Google 没有发令牌 {#err-google-token}

- 也叫：Vertex AI、Agent Platform、JSON 凭据、gcloud、invalid_grant
- 原文：Google 没有发令牌（{0} {1}）：gcloud 的登录可能过期了，重新运行 gcloud auth application-default login，再把新生成的文件选进来
- 原文：Google 没有给服务账号发令牌（{0} {1}）：密钥可能被删了或停用了，重新下载一份 JSON 密钥再试
- 英文：Google didn't give a token ({0} {1}): gcloud's login may have expired; run gcloud auth application-default login again and pick the new file
- 英文：Google didn't give the service account a token ({0} {1}): the key may have been deleted or disabled; download a new JSON key and try again
- 出现在：用「Gemini Agent Platform」供应商的 JSON 凭据发出对话、获取模型列表时
- 原因：用 JSON 凭据时，CicaTavern 先拿它向 Google 换一个临时令牌。gcloud 登录生成的凭据会过期；服务账号的密钥可能在 Google Cloud 控制台里被删掉或停用了。
- 解决：gcloud 凭据：重新运行 `gcloud auth application-default login`，在供应商里点「选择 JSON 凭据文件」选新生成的文件。服务账号：在控制台重新下载一份 JSON 密钥再选进来。JSON 凭据和密钥一样，不要发给别人。

## Google 不认地址里的项目 {#err-google-project}

- 原文：{0} 不认地址里的项目：Base URL 里要填 Google Cloud 项目 ID（控制台顶部项目选择器里的「ID」，不是项目名称），并且 API Key 属于这个项目。（{1}）
- 英文：{0} does not accept the project in the address: the Base URL needs the Google Cloud project ID (the "ID" in the project picker at the top of the console, not the project name), and the API key must belong to that project. ({1})
- 出现在：用「Gemini Agent Platform」供应商时
- 原因：Base URL 里写的是项目名称而不是项目 ID，或者 API Key 属于另一个项目。
- 解决：在 Google Cloud 控制台顶部的项目选择器里复制「ID」那一列，替换 Base URL 里的项目部分；确认 API Key 是在这个项目里建的。

## 连不上模型供应商 {#err-provider-unreachable}

- 也叫：连接超时、timeout、ETIMEDOUT、ECONNRESET、ECONNREFUSED、ENOTFOUND、socket hang up、aborted、海外接口连不上
- 平台：Windows、Mac、安卓
- 原文：连不上 {0}：检查 Base URL、网络和代理设置。（{1}）
- 原文：{0} 连上了，但一直没开始回答（请求超时）：多半是对方太忙、在排队，或者模型思考得太久。稍后再试、调低「努力程度」，或者先换个模型。
- 原文：请求超时
- 英文：{0} can't be reached: check the Base URL, your network and the proxy settings. ({1})
- 英文：{0} was reached but never started answering (request timed out): most likely it is too busy or queueing, or the model is thinking for too long. Try again later, lower the effort, or switch to another model for now.
- 英文：Request timed out
- 出现在：发出一轮对话、「从接口获取模型列表」、配图时
- 原因：请求没到达供应商，或者等了很久没回应。括号里是具体情况：「请求超时」是一直没回应，ECONNREFUSED 是地址那头没有服务，ENOTFOUND 是域名查不到（地址写错或网络不通），ECONNRESET、socket hang up 多是被网络或代理掐断。OpenAI、Anthropic、Gemini、OpenRouter 等海外服务在国内通常要走代理。
- 解决：先确认 Base URL 没写错，再看网络和代理。写着「连上了，但一直没开始回答」的不是网络问题（2.3.2 起分开说）：请求已经到了供应商，它太久（对话 10 分钟、获取模型列表 20 秒）没有开始回答，多半是太忙、在排队，或者思考设得太深，稍后再试、调低「努力程度」或者换个模型。

1. 电脑版：设置 → 连接 → 网络代理，选「跟随系统代理」或「指定代理地址」，并确认代理软件开着。下面会显示「现在走 …」，看是不是你的代理。
2. 供应商「网络」一栏设成「直连」的不走代理：国内服务（DeepSeek、Kimi、智谱等）用直连，海外服务要选「跟随酒馆的代理设置」。
3. 安卓版没有代理设置：海外服务要开手机上的加速器（全局模式，或者把 CicaTavern 加进分流）。
4. 本机的模型服务（Ollama、LM Studio）报 ECONNREFUSED：先把它开起来。

## 回复写到中途断开了 {#err-reply-cut-upstream}

- 也叫：流式中断、输出到一半断了、文字消失、回复没了、上游中断、aborted、ECONNRESET、没写完
- 平台：Windows、Mac、安卓
- 原文：{0} 的回复写到中途，连接被上游（对方服务器，或中间的代理、网络）断开了。这不是 Base URL 或 Key 的问题，再试一次；总是这样就换个代理节点或模型。
- 原文：{0} 写到中途报错了，这是上游返回的错误：{1}
- 原文：这一轮没写完，写好的部分留下了。{0}
- 原文：⚠ 上游中断，没写完
- 原文：回复写到中途被上游断开了（连接被对方服务器、代理或网络切断，或者对方返回了错误），写好的部分留下了。可以重新生成。具体原因在 设置 → 更多 → 错误日志。
- 英文：{0}'s reply was cut off partway: the connection was closed upstream (by its server, or a proxy or the network in between). This isn't a Base URL or key problem. Try again, and if it keeps happening, switch proxy node or model.
- 英文：{0} failed partway through its reply. The error came from upstream: {1}
- 英文：This turn didn't finish. What was written has been kept. {0}
- 英文：⚠ Cut off upstream, not finished
- 英文：The reply was cut off upstream partway: its server, a proxy or the network closed the connection, or the provider returned an error. What was written has been kept. You can regenerate. The cause is in Settings → More → Error log.
- 出现在：回复已经开始输出之后
- 原因：问题出在上游，不是你点了停止，也不是 Base URL 或 Key 配错了：请求已经成功，回复写到一半，连接被对方服务器或中间的代理、网络切断，或者对方在中途返回了错误。
- 解决：已经写出的文字会留下来，回复下方标「⚠ 上游中断，没写完」，可以重新生成。这一轮写到一半的变量更新块、选项不算数，已经写完整的变量更新照常生效；这条回复不会自动配图、朗读或补写变量，也没有用量数字。总是断就换个代理节点、换个模型，或者调低最大回复长度。

还没写出文字就断开的，这一轮不保存，你写的话放回输入框，提示写的是同一句「连接被上游断开」。

## Codex 画不了 {#err-codex}

- 也叫：Codex 没登录、没装 Codex、Codex 画图失败、Codex 用量上限、codex login
- 平台：Windows、Mac
- 原文：没装 Codex
- 原文：Codex 没登录
- 原文：还不能用
- 原文：没找到 Codex：先装好 Codex CLI（npm i -g @openai/codex），再在终端运行 codex login 登录。
- 原文：Codex 没登录或登录过期了：在终端运行 codex login 再试。
- 原文：Codex 的用量到上限了，等额度恢复再画。
- 原文：Codex 十分钟还没画完，停下了。
- 英文：Codex not installed
- 英文：Codex not signed in
- 英文：Not ready yet
- 英文：Codex not found: install the Codex CLI (npm i -g @openai/codex), then run codex login in a terminal.
- 英文：Codex isn't signed in, or the sign-in has expired: run codex login in a terminal and try again.
- 英文：Codex has reached its usage limit. Draw again once it resets.
- 英文：Codex hadn't finished after ten minutes, so it was stopped.
- 出现在：画图方式选了「Codex（本机）」时，设置里和画图时
- 原因：这台电脑上没装 Codex CLI、没登录或登录过期了，或者 ChatGPT 账号的用量到了上限。
- 解决：按「设置 → 配图与朗读 → 配图 → 画图方式」里 Codex 下面的「使用说明」装好、登录，再点「重新检查」。用量到上限就等额度恢复，或者先换别的画图方式。见「用 Codex 画图」。

## 代理地址格式不对 {#err-proxy-address}

- 在哪：设置 → 连接 → 网络代理
- 平台：Windows、Mac
- 原文：代理地址要写成 http://127.0.0.1:7890 这样（只支持 HTTP 代理）
- 英文：Write the proxy address like http://127.0.0.1:7890 (HTTP proxies only)
- 出现在：「指定代理地址」保存时
- 原因：只支持 HTTP 代理，地址要写全 http://、IP 和端口。socks5:// 开头的不行。
- 解决：填代理软件里显示的 HTTP 端口或混合端口，比如 Clash 常见的 http://127.0.0.1:7890 （以你软件里显示的为准）。也可以直接选「跟随系统代理」。安卓版没有这个设置。

## 页面提示 Failed to fetch {#err-failed-to-fetch}

- 也叫：Load failed、NetworkError、页面没反应、点什么都报错
- 原文：Failed to fetch
- 原文：Load failed
- 出现在：页面上点任何按钮时
- 原因：页面连不上后台服务。最常见的是所有窗口关掉约一分钟后服务自动退出了，或者在「退出应用并停止后台服务」之后还开着旧页面；手机访问时，电脑上的酒馆关了或者电脑睡眠了。
- 解决：从桌面图标（或 CicaTavern.exe）重新打开，页面会重新连上。手机访问的话，先确认电脑上的 CicaTavern 开着。

## 请求失败（数字） {#err-request-failed}

- 也叫：请求失败（500）、请求失败（502）、请求失败（404）
- 原文：请求失败（{0}）
- 英文：Request failed ({0})
- 出现在：页面上的各种操作
- 原因：后台服务回了一个错误，但没说原因。500 多半是程序自己出错；404 常见于刚更新、页面和后台不是同一个版本；502、504 常见于中间隔着代理或网关。
- 解决：先刷新页面再试一次。还出现的话，打开 设置 → 更多 → 错误日志，复制后连同操作步骤发给开发者。

## 卡片界面替连接没连上 {#err-card-relay}

- 也叫：卡片自带 API、状态栏联网、经 CicaTavern 连接
- 原文：替卡片界面连接 {0} 没有连上：{1}
- 原文：{0} 是这台电脑或局域网里的地址，要先允许这张卡连接它
- 原文：查不到 {0} 实际指向哪里（网络代理或 TUN 模式接管了域名解析），要先允许这张卡连接它
- 原文：没有允许这张卡经 CicaTavern 连接 {0}
- 原文：不能转发到 CicaTavern 自己
- 原文：不支持的请求方法：{0}
- 原文：要转发的内容太大
- 英文：Couldn't reach {0} for the card's UI: {1}
- 英文：{0} is on this computer or your local network: allow this card to connect to it first
- 英文：Can't tell where {0} really leads (a network proxy or TUN mode handles name lookups): allow this card to connect to it first
- 英文：This card isn't allowed to connect to {0} through CicaTavern
- 英文：Can't relay to CicaTavern itself
- 英文：Unsupported request method: {0}
- 英文：Too much to relay
- 出现在：角色卡自带的网页界面（状态栏、面板）自己去连某个网址时
- 原因：有的卡的界面带自己的 API 设置，浏览器直连不上时会改由 CicaTavern 代为连接。地址连不上、你没允许，或者它要连的是 CicaTavern 自己的地址、发的内容超过 10 MB，都会这样。
- 解决：在角色卡菜单「⋯ → 卡片界面权限…」里允许这个地址；海外地址要开好代理。卡要连 CicaTavern 自己的，这张卡的界面在这里用不了，不影响正常对话。

## 导入的文件太大 {#err-import-too-large}

- 原文：文件太大
- 原文：图片太大
- 英文：File is too large
- 英文：Image is too large
- 出现在：导入角色卡、世界书、预设，导入存档时
- 原因：角色卡、世界书、预设文件超过约 110 MB（以前是约 30 MB），存档超过 40 MB，或者 PNG 角色卡里藏的数据解压后太大。
- 解决：确认选的是角色卡本身，不是整个文件夹打成的包。特别大的卡可以先在 SillyTavern 里导出成 JSON 再导入。

## 角色卡导入失败 {#err-import-card}

- 也叫：导入不了、读不出角色卡、不是角色卡
- 原文：无法解析角色卡 JSON
- 原文：角色卡缺少 name 字段
- 原文：这张 PNG 里没有角色卡数据
- 英文：Couldn't parse the character card JSON
- 英文：The character card has no name field
- 英文：This PNG has no character card data
- 出现在：导入角色卡时
- 原因：文件不是 SillyTavern 格式的角色卡：PNG 是普通图片（被网站、聊天软件压缩或转存过之后，藏在图里的卡数据会丢），JSON 损坏或者不是角色卡，或者卡里没有名字。
- 解决：去原作者发布的地方重新下载原图（不要用 QQ、微信里转发后的图，那会被压缩）；JSON 文件可以先用记事本打开看看是不是完整的。

## 世界书导入失败 {#err-import-worldbook}

- 原文：无法解析世界书 JSON
- 原文：世界书格式无效
- 英文：Couldn't parse the lorebook JSON
- 英文：Invalid lorebook format
- 出现在：导入世界书时
- 原因：文件不是 JSON，或者 JSON 里没有世界书的内容。常见的是选错了文件（选成了角色卡、预设或正则）。
- 解决：确认是 SillyTavern 导出的世界书 .json；角色卡自带的世界书不用单独导入，导入卡时会一起进来。

## 预设导入失败 {#err-import-preset}

- 原文：无法解析预设 JSON
- 英文：Couldn't parse the preset JSON
- 出现在：导入预设时
- 原因：文件不是有效的 JSON，比如下载不完整、被改坏了，或者其实是别的格式。
- 解决：重新下载预设文件再导入。

## 导入剧情存档失败 {#err-import-story-archive}

- 原文：存档里缺少最后一轮叙述
- 原文：这不是酒馆的剧情存档
- 原文：存档里没有剧情摘要
- 英文：The archive is missing the last reply
- 英文：This isn't a CicaTavern story archive
- 英文：The archive has no story summary
- 出现在：角色卡下「导入存档」时
- 原因：选的文件不是 CicaTavern 导出的剧情存档，或者存档被改过、缺了内容（最后一轮要是模型的叙述）。
- 解决：在原来的设备上重新导出一次；整段对话要搬到另一台设备的，用对话的「打包」导出再导入。

## 附不上资料 {#err-reference}

- 也叫：附文件失败、读对话失败、参考文件传不上
- 原文：资料太多了：已经有 {0} 字，这份 {1} 字，加起来不能超过 {2} 字。先去掉一份，或者少读几轮
- 原文：「{0}」太大了，附的文件不能超过 16 MB
- 原文：「{0}」读不了。能读 txt、md、json 这类文本文件和带角色卡的 PNG，Word 和 PDF 先另存成 txt
- 原文：这个文件是空的
- 原文：最多附 {0} 份资料，先去掉一份
- 原文：这张 PNG 里的角色卡数据损坏了，读不出来。换一份完好的文件再附
- 原文：「{0}」看起来是角色卡，但文件损坏了，读不出来。创作角色卡时不会把它当普通文本读，修好或换一份完好的文件再附
- 英文：Too much to read: {0} characters already, {1} in this one, and they can be {2} at most together. Remove one, or read fewer turns
- 英文：“{0}” is too large: an attached file can be 16 MB at most
- 英文：“{0}” cannot be read. Text files like txt, md and json can, and a PNG with a card in it; save a Word file or PDF as txt first
- 英文：This file is empty
- 英文：At most {0} references can be attached: remove one first
- 英文：The card data in this PNG is damaged and cannot be read. Attach an intact copy instead
- 英文：“{0}” looks like a character card, but the file is damaged and cannot be read. Creating a card won't read it as plain text: fix it or attach an intact copy
- 出现在：修改角色卡 → 对话修改的「附文件」「读对话」；创作角色卡的「附文件」；直连对话的「附文件」
- 原因：资料每次发送都要带上，所以有上限：最多 6 份，加起来 10 万字，文件不超过 16 MB。能读文本文件、带角色卡的 PNG，其他图片和 Word、PDF 读不了。创作角色卡时默认只学结构，所以看起来是角色卡、却读不出来的文件不会当普通文本读，不然向导就读到了原文。
- 解决：点资料旁的 × 去掉一份，或者读对话时选少一点的轮数、只看提到某几个名字的轮次。Word、PDF 先另存成 txt。卡文件坏了就修好它，或者换一份完好的。如果这个文件其实是讲怎么写卡的笔记，删掉里面的卡字段示例（比如 first_mes、character_book）再附。自己写的 JSON 设定文件开头只有 name、description、personality、scenario 这几个字段时，也会被当成角色卡，把内容存成普通文字再附。

## 名字不能空着 {#err-name-empty}

- 原文：名字不能空着
- 英文：The name can't be empty
- 出现在：修改角色卡、世界书、正则集时保存
- 原因：名字一栏是空的。
- 解决：填一个名字再保存。

## 正则或屏蔽词太长、太多 {#err-regex-too-long}

- 原文：「{0}」太长了
- 原文：正则太多（最多 {0} 条）
- 原文：屏蔽词太多（最多 {0} 个）
- 英文："{0}" is too long
- 英文：Too many regex scripts ({0} at most)
- 英文：Too many blocked words ({0} at most)
- 出现在：保存或导入正则、屏蔽词时
- 原因：一组正则最多 200 条、每条的查找和替换各最多 40 万字；屏蔽词最多 500 个，每个词、替换词和例外最多 200 字。「」里是超出的那一条。
- 解决：把这一条拆短，或者删掉用不上的。

## 正则表达式写得不对 {#err-regex-invalid}

- 原文：这个表达式写得不对，浏览器读不出来
- 原文：这个表达式写得不对，读不出来，不能采用。
- 原文：试跑超时：这个表达式在最新回复上卡住了，不建议采用。
- 原文：没能试跑。
- 英文：This pattern isn't valid; the browser can't read it
- 英文：This pattern isn't valid and can't be read, so it can't be applied.
- 英文：The trial timed out: this pattern gets stuck on the latest reply. Better not to apply it.
- 英文：Couldn't try it.
- 出现在：编辑正则、「对话修改」提出的正则修改
- 原因：查找表达式的语法有错（括号没配对、写法是别的语言的），或者写法会让匹配卡死。
- 解决：照提示改表达式；可以写成 /表达式/标志 的形式。对话修改给的表达式不能采用时，不要勾它，换个说法再让它改一次。

## 对话修改采用之后撤销不了 {#err-talk-undo}

- 原文：采用之后又在别处改过，不能撤销了
- 英文：It was changed elsewhere after the change went in, so it can't be undone
- 出现在：修改角色卡、世界书、预设、正则、主题的「对话修改」里点撤销
- 原因：采用修改之后，你又在别处手动改过同一个东西，撤销会把那些改动也冲掉，所以不让撤。
- 解决：照原来的样子手动改回去，或者在「对话修改」里说一句让它改回来。

## 定制外观画出来有地方不对 {#err-status-skin}

- 原文：画出来有这些地方不对：
- 英文：Drawn, these are wrong:
- 原文：让模型改过一次，画出来还有这些地方不对：
- 英文：The model fixed it once, and drawn again these are still wrong:
- 原文：模型写了不能用的东西，已经去掉：{0}。
- 英文：The model wrote things that cannot be used, and they were taken out: {0}.
- 原文：{0} 没有写出能用的样式，再试一次，或者换个模型
- 英文：{0} wrote no styles that can be used. Try again, or use another model
- 出现在：修改角色卡或检查这张卡 → 调整状态栏 → 定制外观，模型写完一套外观之后
- 原因：模型写的样式画出来有问题：有东西伸出了状态栏、被藏起来、字太小，或者字和底色太接近；或者写了不允许的东西（要加载的图片和字体、固定在屏幕上的层），这些已经自动去掉；或者回答里没有能用的样式。
- 解决：见下。

1. 列出问题时，预览还是照样显示。问题不大可以直接点「用这套外观」；想改好就点「让模型修这几处」，每点一次发一次请求。
2. 改过还是不对，在输入框里写清楚想要的样子，点「另设计一套」，或者在「检查这张卡」里换一个更强的模型再试。
3. 写着「没有写出能用的样式」时什么都没有保存，上一版草稿还在，再点一次或换个模型。
4. 去掉的东西不用管：状态栏的定制外观不能加载图片和网络字体，想要图案可以让模型用渐变和符号来画。

## 检查这张卡采用之后撤销不了 {#err-check-undo}

- 原文：采用之后「{0}」又改过，不能撤销了
- 英文："{0}" has changed since, so this can't be undone
- 出现在：检查这张卡的「已采用」里点撤销
- 原因：采用之后，这一段又被改过（手动改的，或者又采用了别的建议）。撤销会把后来的改动也冲掉，所以不让撤。
- 解决：先撤销后面采用的那几条，再撤销这一条；或者到修改角色卡里手动改回去。

## 试玩报告里没有这些问题了 {#err-trial-fix-gone}

- 原文：试玩报告里没有这些问题了，刷新一下再看
- 英文：The trial report no longer has these problems. Refresh and look again
- 出现在：检查这张卡的「试玩发现」里点「让模型出改法」
- 原因：窗口打开以后又试玩了一次，报告换掉了，或者这条问题已经被采用的改法解决了。没有发送给模型。
- 解决：关掉「检查这张卡」再打开，按现在的报告重新选。

## 默认的不能删 {#err-persona-default}

- 在哪：设置 → 写作 → 你的角色；设置 → 写作 → 文风
- 原文：默认的不能删：先把另一个设为默认
- 英文：The default can't be deleted: make another one the default first
- 出现在：删除你的角色或文风时
- 原因：默认的那个是新对话没指定时用的，必须有一个。
- 解决：先把另一个设为默认，再删这个。

## 创作角色卡时读不出内容 {#err-forge-unreadable}

- 原文：这次回复的格式不完整，问题或草图没能读出来。可以点「换一组问题」重来。
- 原文：找不到要改的那一段，或者它还是空的
- 英文：This reply came back incomplete, so the questions or the sketch couldn't be read. Click "New questions" to try again.
- 英文：Couldn't find the part to change, or it's still empty
- 出现在：创作角色卡的「聊想法」「打磨」
- 原因：模型这次的回复格式不对（常见于小模型、被截断的回复），或者要重写的那一段还没写出来。
- 解决：点「换一组问题」重来；还不行换个更强的模型。空着的段落先写上内容再让它改。

聊想法、出方案、写卡、按意见改报错停下时，报错下面可以「换个模型…」选另一个模型，看过估出的花费再点「换这个模型重写」，只这一次用它，草稿的模型不变，见[创作用哪个模型、花多少](features.md#forge-model)。

## 对话太长，超出模型的上下文 {#err-context-full}

- 也叫：上下文超长、context length exceeded、prompt is too long、maximum context、token 超了
- 原文：（这段对话太长，超出了模型一次能读的上下文。点顶栏「压缩上下文」把前面的剧情压成存档，再接着写。）
- 英文：(This chat is longer than the model can read at once. Click "Compact context" in the top bar to compact the story so far into an archive, then continue.)
- 出现在：发出一轮对话时，跟在供应商的报错后面
- 原因：角色卡、世界书、预设和聊天记录加起来超过了这个模型一次能读的长度。
- 解决：点报错旁的「压缩后重试」，或者顶栏的「压缩上下文」，把前面的剧情压成一份存档再接着写；也可以换一个上下文更长的模型。设置 → 模型 → 上下文压缩 里可以打开自动压缩。

## 压缩上下文时故事太长读不下 {#err-compaction-too-long}

- 原文：故事太长，{0} · {1} 分段也读不下：换一个上下文更大的模型来压缩，或者只保留最近两轮
- 英文：The story is too long for {0} · {1} even in parts: compact with a model that has a longer context, or keep only the last two turns
- 出现在：压缩上下文时
- 原因：写存档的模型连分段读都读不下（多半是角色卡和世界书的常驻部分本身就很长）。
- 解决：在弹出的「压缩没有成功」窗口里选一个上下文更大的模型，点「用它压缩」；实在压不了就点「只保留最近两轮」（不调用模型），之后在存档的「查看 / 修改」里补几句要记住的剧情。

## 剧情存档改不了 {#err-compaction-edit}

- 原文：压缩之后已经接着写了，摘要不能再改；可以回滚到更早的地方重新压缩
- 原文：摘要不能为空
- 英文：The story has continued since this compaction, so its summary can't be changed anymore. You can roll back to an earlier point and compact again
- 英文：The summary can't be empty
- 出现在：压缩记录的「查看 / 修改」里保存时
- 原因：压缩之后已经写了新的回合，存档已经用进去了，不能再改；或者把存档内容清空了。
- 解决：想换一份存档，在压缩点「回滚到这里」再压缩一次。存档不能是空的。

## 这条消息不能删除 {#err-delete-message}

- 也叫：删不了、删除失败、不能删除
- 原文：开场不能删除
- 原文：压缩点所在的这一条不能删除：之后接着写的都从这里开始
- 原文：这条消息在上次压缩之前，模型现在只读剧情存档，删除它不起作用；要去掉内容，可以修改存档
- 原文：这条消息的内容已经清掉了，不能恢复：删除之后又写了新的一轮
- 原文：这条消息已经删除，不能从它重新生成
- 英文：The opening can't be deleted
- 英文：The message at the compaction point can't be deleted: everything written since starts from it
- 英文：This message is from before the last compaction: the model only reads the story archive now, so deleting it does nothing. To remove something, edit the archive
- 英文：This message's words are gone and it can't come back: a new turn was written after it was deleted
- 英文：This message was deleted, so nothing can be written from it again
- 出现在：聊天页 → 消息下方 → 删除
- 原因：开场是对话的起点。压缩过的部分，模型现在只读剧情存档，删掉原文也改不了模型知道的内容。删除之后写了新的一轮，这条消息的文字就真的清掉了，撤销不回来，也不能从它重新生成。
- 解决：要去掉压缩前的内容，在压缩点点「查看 / 修改」改存档；想整段重来，用「回滚到这里」。

## 这一轮不能隐藏 {#err-hide-round}

- 也叫：隐藏不了、隐藏失败、不能隐藏
- 原文：这一轮在上次压缩之前，模型现在只读剧情存档，隐藏它不起作用；要去掉内容，可以修改存档
- 原文：压缩点所在的这一轮不能隐藏：之后接着写的都从这里开始
- 原文：开场不能隐藏，只能隐藏之后的回合
- 原文：这一轮不在当前对话里
- 原文：最后一轮已隐藏：先取消隐藏，或接着写一轮再压缩
- 英文：This round is from before the last compaction: the model only reads the story archive now, so hiding it does nothing. To take something out, edit the archive
- 英文：The round the context was compacted at can't be hidden: everything after it continues from there
- 英文：The opening can't be hidden, only the rounds after it
- 英文：That round isn't in this chat
- 英文：The last round is hidden: unhide it, or write one more turn, then compact
- 出现在：点「隐藏这一轮」时；最后一轮隐藏着时压缩上下文
- 原因：压缩之前的回合模型已经只读剧情存档，压缩点和开场白是后面的剧情接着写的起点；最后一轮隐藏着时，压缩会把它算进来。
- 解决：压缩之前的内容在存档里改（「查看 / 修改」）；压缩前先取消最后一轮的隐藏，或者接着写一轮。

## 整理记忆没成功 {#err-memory-tidy}

- 也叫：整理记忆失败、记忆簿没更新、边玩边整理失败、没有写出记忆条目
- 原文：边玩边整理要用供应商的模型：在「配图与朗读」里选一个辅助模型，或在顶栏选一个供应商的模型
- 原文：{0} · {1} 没有写出记忆条目，下次到了间隔再试
- 原文：还没有可以整理的剧情
- 原文：正在整理记忆
- 英文：Tidying memory needs a provider's model: pick a helper model under Pictures & voice, or a provider's model in the top bar
- 英文：{0} · {1} wrote no memory entries; it tries again at the next interval
- 英文：There's no story to tidy yet
- 英文：Already tidying memory
- 出现在：边玩边整理之后（最新回复下的「⚠ 整理记忆没成功」，记忆簿里写着原因）；记忆簿里点「现在整理」时
- 原因：没有能用的供应商模型；模型没按格式写出记忆条目（推理型模型可能把输出额度花在了思考上）；对话里还没有剧情；上一次整理还没完。
- 解决：在「配图与朗读」里选一个辅助模型（不带推理的快模型最合适）；到下一个间隔会自动再试，也可以在记忆簿里点「现在整理」。

## 打开了联网时报错 {#err-web-search}

- 也叫：联网搜索、web search、地球图标
- 原文：（这个对话打开了「联网」：这个供应商或模型可能不支持联网搜索，点输入框左边的地球图标关掉再试。）
- 英文：(Web search is on for this chat: this provider or model may not support it. Click the globe left of the input box to turn it off and try again.)
- 出现在：发出一轮对话时，跟在供应商的报错后面
- 原因：这个对话开着「联网」，而不少供应商、中转站或模型不支持联网搜索的参数，会直接拒绝整个请求。
- 解决：点输入框左边的地球图标关掉联网再发；要联网的话换一个支持搜索的供应商或模型。

## 模型没有返回正文、被审查拦下 {#err-no-text}

- 也叫：空回复、没反应、content_filter、PROHIBITED_CONTENT、SAFETY、RECITATION、审核、破限
- 原文：{0} 没有返回正文{1}
- 原文：{0} 的内容审查拦下了这次请求（{1}）。这是 Gemini 服务端的审查，设置里关不掉，换 API Key 或中转也一样。可以换用别的模型；或者回滚最近几轮、改掉角色卡和预设里可能触发它的内容再试（最常见的是露骨内容里出现了年龄小或看起来年幼的角色）。
- 原文：{0} 的安全过滤拦下了这次回复（{1}）。可以重试、改写最近的输入，或者换用别的模型。
- 原文：{0} 认为回复和已有的受版权保护的文字太像，没有给出（{1}）。重试一次，或者换个说法。
- 英文：{0} returned no text{1}
- 英文：{0}'s content check blocked this request ({1}). This is Gemini's own check on Google's servers: no setting turns it off, and another API key or relay gets the same answer. Use another model, or roll back the last few turns and change what in the card or preset may trigger it (most often, explicit content with a young or young-looking character).
- 英文：{0}'s safety filter blocked this reply ({1}). Try again, rephrase the last input, or use another model.
- 英文：{0} held the reply back as too close to existing copyrighted text ({1}). Try again, or put it another way.
- 出现在：发出一轮对话时
- 原因：模型回了空内容。括号里写着 PROHIBITED_CONTENT、SAFETY、content_filter 的，是供应商自己的内容审查拦下了，不是 CicaTavern 的问题，在 CicaTavern 里关不掉；RECITATION 是模型觉得和受版权保护的文字太像。
- 解决：重试一次；不行就换个模型，或者回滚最近几轮、改掉可能触发审查的内容。Gemini 的 PROHIBITED_CONTENT 换密钥、换中转都一样。

## 回复写到输出上限被截断 {#err-truncated}

- 也叫：回复不完整、话没说完、截断、max_tokens、length、变量块没了、选项没了
- 原文：⚠ 写到输出上限，被截断
- 原文：回复写到了输出上限，后面被截断（末尾的选项、变量块可能缺了）
- 原文：⚠ 联网搜索中途停了，没写完
- 英文：⚠ Cut off at the output limit
- 英文：The reply hit the output limit and was cut off (choices or variable blocks at the end may be missing)
- 英文：⚠ Paused mid-search, unfinished
- 出现在：回复下方的提示、错误日志里
- 原因：模型写到了单次输出的上限，后半段没写出来。上限取预设的「最大回复长度」；供应商「高级」里填了「最大输出 token」时以那个为准。会思考的模型把一部分额度花在思考上，更容易碰到。联网搜索搜了太多次时也会中途停下。
- 解决：点回复下方的「继续生成」让模型从断开的地方接着写（或在输入框里输入 /continue）；也可以重新生成，或者调大上限：在这个供应商的「高级」里填「最大输出 token」（比如 8000 以上），或者调大预设的最大回复长度。

## 继续生成用不了 {#err-continue}

- 也叫：continue 失败、接着写不了
- 原文：没有可以继续生成的回复
- 原文：开场白不能继续生成，可以直接修改它
- 原文：要继续生成的回复不存在
- 英文：There is no reply to continue
- 英文：An opening can't be continued; you can edit it instead
- 英文：The reply to continue doesn't exist
- 出现在：点「继续生成」或输入 /continue 时
- 原因：最新一条不是模型的回复（比如对话还只有开场白，或者最后一条是你说的话），或者那条回复已经删掉了。
- 解决：开场白用「修改」直接改；最后一条是你的话时直接发送或重新生成。

## 改消息时内容不能为空 {#err-edit-message}

- 原文：内容不能为空；整轮不要了可以用「回滚到这里」
- 原文：开场和剧情存档不能在这里改；存档用「查看 / 修改」
- 英文：The text can't be empty. To drop the whole turn, use "Roll back to here"
- 英文：The greeting and story archives can't be edited here. For an archive, use "View / edit"
- 出现在：修改一条消息后保存时
- 原因：把消息清空了，或者要改的是开场白、剧情存档。
- 解决：整轮不要了，用那条消息下面的「回滚到这里」；剧情存档点「查看 / 修改」去改。

## EJS 模板出错 {#err-ejs}

- 也叫：EJS、模板报错、楼层渲染
- 原文：⚠ {0} 条 EJS 模板出错
- 原文：回复里的 EJS 模板出错：{0}
- 英文：⚠ {0} EJS template errors
- 英文：An EJS template in the reply failed: {0}
- 出现在：回复下方的提示、错误日志里
- 原因：角色卡、世界书或正则里写的 EJS 模板（<% %> 这类）运行出错，多是卡作者的模板用到了这里没有的函数或变量。出错的那段不显示，其他照常。
- 解决：把鼠标放在提示上能看到具体哪里出错。一般不影响剧情；想修的话把报错发给卡作者。

## 卡片界面里的报错 {#err-card-ui}

- 也叫：状态栏报错、前端报错、酒馆助手、卡的界面弹红框
- 原文：卡片界面用了 /{0}，CicaTavern 没有这个命令，跳过了这一步（其余照常执行）
- 原文：界面保存的变量太大
- 原文：不支持修改条目的「{0}」
- 原文：要渲染的内容太长
- 原文：要检查的模板太长
- 原文：对话已经开始，不能再换开场白
- 原文：地址不对
- 英文：The card interface used /{0}, which CicaTavern does not have: that step was skipped (the rest ran as usual)
- 英文：The variables the card's UI saved are too large
- 英文：Changing an entry's “{0}” is not supported
- 英文：The texts to render are too long
- 英文：The template to check is too long
- 英文：The chat has already started; its opening can't be switched now
- 英文：That address isn't valid
- 出现在：角色卡自带的网页界面（状态栏、开场页、面板）
- 原因：卡的界面脚本请 CicaTavern 做了一件它不支持或不允许的事：用了这里没有的斜杠命令（这一步跳过，其余照常执行）、存的变量超过 20 万字、改世界书条目的某个字段、对话开始后还要换开场白，或者给了一个写错的网址。
- 解决：这是卡的界面和 CicaTavern 的兼容问题，正文对话一般不受影响。开场白要在发出第一句之前换；其他的可以把报错发给卡作者或开发者。

## 视觉小说里不能存档 {#err-vn-save}

- 原文：这里还不能存档：等这一轮写完再存
- 英文：Can't save here yet: wait for this turn to finish
- 出现在：视觉小说模式点存档时
- 原因：这一轮还在生成，或者还没有可存的画面。
- 解决：等这一轮写完再存。

## 辅助模型没能标表情 {#err-vn-face-helper}

- 原文：辅助模型没能标表情（{0}），这一轮按叙述判断。
- 英文：The helper model couldn't label expressions ({0}); this turn goes by the narration.
- 出现在：视觉小说模式
- 原因：给立绘挑表情要用辅助模型读台词，这次调用失败了（括号里是原因，多是辅助模型的供应商连不上或密钥不对）。
- 解决：这一轮表情按叙述猜，不影响剧情。经常出现的话，在 设置 → 配图与朗读 的「画面提示词」里检查辅助模型能不能用。

## 画图被拒绝：没过内容审核 {#err-image-refused}

- 也叫：生图失败、画不出来、moderation、content policy、nsfw、flagged
- 原文：{0} 拒绝画这张：多半是提示词或参考图没过它的内容审核。改掉敏感的描述再画，或者在「配图与朗读」里关掉参考图试试。（{1}）
- 英文：{0} refused to draw this one: the prompt or reference image most likely failed its content moderation. Remove anything sensitive and draw again, or try turning off the reference image in "Pictures & voice". ({1})
- 出现在：配图、画头像、画人设图时
- 原因：生图服务自己的内容审核拦下了提示词或参考图（角色头像）。
- 解决：点「配图」后弹出的提示词确认框里，改掉敏感的描述再画；或者在 设置 → 配图与朗读 的「画图方式」里关掉参考图再画；也可以换一种画图方式。

## Gemini 画图或朗读返回 404 {#err-gemini-404}

- 原文：（模型名不对，或者这个供应商不是 Google 的地址）
- 原文：（模型名不对，或者「{0}」不是 Google 的地址{1}）
- 英文：(a wrong model name, or this provider isn't Google's address)
- 英文：(a wrong model name, or "{0}" isn't Google's address{1})
- 出现在：用 Gemini 画图、Gemini 朗读时，跟在供应商的报错后面
- 原因：Gemini 的画图和朗读只能走 Google 自己的接口：模型名写错，或者选的供应商不是用「Gemini API」或「Gemini Agent Platform」模板建的（普通中转站多半没有这个接口）。
- 解决：在 设置 → 配图与朗读 里，给 Gemini 画图或朗读选用「Gemini API」或「Gemini Agent Platform」模板建的供应商，模型名从下拉提示里选。

## 连不上 ComfyUI {#err-comfy-unreachable}

- 平台：Windows、Mac
- 原文：连不上 ComfyUI：先打开 ComfyUI，再确认地址（默认 http://127.0.0.1:8188）
- 原文：连不上 ComfyUI（{0}）：先把它开起来，地址对了再读取。（{1}）
- 英文：Can't connect to ComfyUI: start ComfyUI, then check the URL (default http://127.0.0.1:8188)
- 英文：Can't reach ComfyUI ({0}): start it, check the address, then read again. ({1})
- 出现在：用 ComfyUI 画图、点「读取模型」时
- 原因：ComfyUI 没开，或者填的地址、端口不对。
- 解决：先启动 ComfyUI，等它的网页能打开，再把那个地址（默认 http://127.0.0.1:8188 ）填到「画图方式」里。手机访问时，ComfyUI 也是由电脑去连的，地址照样填电脑上的。

## ComfyUI 执行出错 {#err-comfy-exec}

- 原文：ComfyUI 执行出错：{0} 节点 {1}：{2}{3}
- 原文：ComfyUI 执行出错，去 ComfyUI 界面看看是哪个节点
- 原文：（显存不够：画幅小一点，或者先关掉别的占显存的程序）
- 英文：ComfyUI failed while running: {0} node {1}: {2}{3}
- 英文：ComfyUI hit an error. Check the ComfyUI interface to see which node failed
- 英文：(out of video memory: use a smaller picture size, or close other programs using the GPU first)
- 出现在：用 ComfyUI 画图时
- 原因：工作流在 ComfyUI 里运行时出错：某个节点的模型文件没有、节点没装，或者显存不够（out of memory）。
- 解决：到 ComfyUI 的网页里看出错的节点；缺节点的用 ComfyUI Manager 装上；显存不够就选小一点的画幅，或关掉别的占显存的程序。

## ComfyUI 画出来的尺寸不对 {#err-comfy-size}

- 原文：ComfyUI 画出来是 {0}×{1}，不是{2}：工作流里找不到酒馆能改的宽高。在 ComfyUI 里把 Empty Latent Image 的宽高改成 %width% 和 %height%，再导出（API）导入。
- 原文：ComfyUI 画出来是 {0}×{1}，不是{2}：工作流里 {3} 也定了尺寸，酒馆不改它。在 ComfyUI 里去掉它，或把它的宽高改成 %width% 和 %height%，再导出（API）导入。
- 原文：找不到酒馆能改的宽高，选的画幅不会生效：把 Empty Latent Image 的宽高改成 %width% 和 %height%，再导出（API）导入
- 英文：ComfyUI drew {0}×{1}, not {2}: the workflow has no width and height the tavern can change. Set Empty Latent Image's width and height to %width% and %height% in ComfyUI, then export (API) and import again.
- 英文：ComfyUI drew {0}×{1}, not {2}: {3} in the workflow also sets a size, which the tavern leaves alone. Remove it in ComfyUI, or set its width and height to %width% and %height%, then export (API) and import again.
- 英文：No width and height the tavern can change, so the picture size you pick won't take effect: set Empty Latent Image's width and height to %width% and %height%, then export (API) and import again
- 出现在：导入 ComfyUI 工作流后、用它画图时
- 原因：导入的工作流里宽高写死了，酒馆改不了，所以选的横图、竖图不生效。
- 解决：在 ComfyUI 里把 Empty Latent Image（或决定尺寸的节点）的宽、高改成 %width% 和 %height%，用「导出（API）」导出，再到「画图方式」里重新导入。

## ComfyUI 加不了 LoRA {#err-comfy-lora}

- 原文：工作流里找不到采样器用的模型，加不了 LoRA
- 英文：No sampler in the workflow takes a model, so a LoRA can't be added
- 出现在：用导入的 ComfyUI 工作流、并且这张卡设了 LoRA 时
- 原因：酒馆要把 LoRA 接在采样器用的模型上，这个工作流里找不到这样的节点（用了少见的自定义节点）。
- 解决：换一个用标准采样器（KSampler 等）的工作流，或者把 LoRA 直接做进工作流里，卡的「画风与 LoRA」里不再选。

## 连不上 SD WebUI {#err-sd-unreachable}

- 平台：Windows、Mac
- 原文：连不上 SD WebUI：先打开 WebUI（启动参数加 --api），再确认地址（默认 http://127.0.0.1:7860）
- 英文：Can't reach SD WebUI: start the WebUI (with --api), then check the address (default http://127.0.0.1:7860)
- 出现在：用 SD WebUI 画图时
- 原因：WebUI 没开、地址不对，或者启动时没加 --api，酒馆调不了它。
- 解决：在 WebUI 的启动参数里加上 --api 再启动（用整合包启动器的，在启动器的设置里打开 API），等网页能打开后，把地址（默认 http://127.0.0.1:7860 ）填到「画图方式」里。

## NovelAI 令牌不对或付费问题 {#err-novelai}

- 也叫：NAI、Anlas、Opus、pst 令牌
- 原文：NovelAI 令牌格式不对：在 NovelAI 网页「设置 → Account → Get Persistent API Token」复制（pst- 开头）
- 原文：NovelAI 不认这个令牌：在 NovelAI 网页重新生成持久令牌，再到「配图与朗读」里粘贴。（{0}）
- 原文：NovelAI 要求付费：订阅没生效，或者这张超出了 Opus 的免费范围而 Anlas 不够。（{0}）
- 原文：NovelAI 一个账号同时只画一张，上一张还没画完，稍等再画。
- 原文：（已过期）
- 英文：The NovelAI token doesn't look right: copy it from "Settings → Account → Get Persistent API Token" on the NovelAI website (it starts with pst-)
- 英文：NovelAI didn't accept this token: generate a new persistent token on the NovelAI website and paste it in "Pictures & voice". ({0})
- 英文：NovelAI asks for payment: your subscription isn't active, or this picture is outside Opus's free range and you don't have enough Anlas. ({0})
- 英文：NovelAI draws only one picture at a time per account, and the last one isn't done yet. Wait a moment and try again.
- 英文：(expired)
- 出现在：保存 NovelAI 令牌、用 NovelAI 画图、看账户状态时
- 原因：令牌要用「持久令牌」（pst- 开头），不是登录密码；令牌重新生成过之后旧的就失效；订阅过期（账户状态后面显示「（已过期）」）或 Anlas 不够时 NovelAI 不给画。
- 解决：在 NovelAI 网页「设置 → Account → Get Persistent API Token」复制令牌，粘贴到「画图方式」里的 NovelAI。付费问题去 NovelAI 续订或买 Anlas。令牌和密钥一样，不要发到群里。

## 配图与朗读的设置保存不了 {#err-media-settings}

- 原文：{0}地址不对
- 原文：模型名不对：{0}
- 原文：Gemini 模型名不对（例如 {0}）
- 原文：朗读模型名不对（例如 gpt-4o-mini-tts）
- 原文：模型文件名不对：{0}
- 原文：ComfyUI 的选项名不对：{0}
- 原文：转写模型名不对（例如 whisper-1）
- 原文：本地转写服务地址不对：要以 http:// 或 https:// 开头
- 英文：{0} URL isn't valid
- 英文：That model name isn't valid: {0}
- 英文：That isn't a Gemini model name (for example {0})
- 英文：Invalid voice model name (e.g. gpt-4o-mini-tts)
- 英文：Model file name not valid: {0}
- 英文：ComfyUI option name not valid: {0}
- 英文：The transcription model name isn't valid (for example whisper-1)
- 英文：The local transcription server's address isn't valid: it must start with http:// or https://
- 出现在：设置 → 配图与朗读、语音输入里保存，或者画图前选模型时
- 原因：填的地址或名字格式不对：地址要以 http:// 或 https:// 开头、中间不能有空格；模型名只能有字母、数字和 . _ - : / @ + 这些符号，不能有空格和中文。「ComfyUI地址不对」「SD WebUI地址不对」「本地语音桥接地址不对」都是这一类。
- 解决：照括号里的例子改。模型名最好从下拉提示里选，或者点「读取模型」「从接口获取」让它填。

## 上传的图片太大 {#err-image-too-large}

- 原文：图片太大了（15 MB 以内）
- 原文：人设图太大（最多 15MB）
- 原文：场景图太大（最多 12MB）
- 原文：背景图太大（最多 12MB）
- 英文：Image is too large (15 MB max)
- 英文：The reference image is too large (15MB max)
- 英文：The scene picture is too large (12 MB at most)
- 英文：The background picture is too large (12 MB at most)
- 出现在：换角色卡头像、上传人设图、场景图、主题背景图时
- 原因：图片文件超过了上限：头像和人设图 15 MB，场景图和背景图 12 MB。
- 解决：用看图软件把图片缩小或另存为 JPG 再上传。

## 表情和立绘不太像，或表情先不画 {#err-sprite-faces}

- 原文：这种画图方式不能照着立绘改，表情是按长相重新画的，可能和立绘不太一样。
- 原文：选的画图方式不能照着立绘改表情（重画出来会像另一个人），表情先不画：可以换成能参考图片的画图方式，或者导入表情包。
- 英文：This image backend can't edit the sprite, so the expression was drawn anew from the looks and may not quite match the sprite.
- 英文：The way of drawing picked can't edit expressions from the sprite (drawn anew they look like someone else), so expressions are left out: pick a way of drawing that takes a reference picture, or import an expression pack.
- 出现在：视觉小说模式画立绘和表情时
- 原因：选的画图方式不支持参考图片，只能按长相描述重画，所以画出来的表情和立绘可能像两个人。
- 解决：换成能参考图片的画图方式（支持改图的 OpenAI 兼容接口、Gemini、带参考图的 NovelAI 等），或者自己导入表情包。

## 生图服务返回的东西不对 {#err-image-response}

- 原文：响应太大
- 原文：跳转到了不支持的地址：{0}
- 英文：Response too large
- 英文：Redirected to an address that isn't supported: {0}
- 出现在：配图时
- 原因：生图服务返回的内容超过 64 MB，或者给的图片链接跳到了不是网页地址的地方。多见于不太规范的中转站。
- 解决：重试一次；经常出现就换一个生图服务或模型。

## 这个浏览器不能朗读 {#err-browser-tts}

- 也叫：没声音、读不出来、浏览器音色
- 平台：安卓、手机浏览器、Windows、Mac
- 原文：这个浏览器不能朗读：换 Edge 或 Chrome 打开，或者在「配图与朗读 → 朗读来源」里设一个本地语音桥接或云端服务
- 原文：这个浏览器不能朗读：设一个云端服务或本地语音桥接，或者换 Edge / Chrome 打开。
- 原文：这个浏览器不能朗读
- 原文：浏览器朗读出错：{0}
- 英文：This browser can't read aloud: open the app in Edge or Chrome, or set up a local voice bridge or a cloud service in "Pictures & voice → Voice sources"
- 英文：This browser can't read aloud: set up a cloud service or a local voice bridge, or open this in Edge / Chrome.
- 英文：This browser can't read aloud
- 英文：Browser speech error: {0}
- 出现在：点朗读、试听时
- 原因：选的是浏览器自带的音色，但这个浏览器（或安卓应用里的系统网页组件）没有朗读功能，或者朗读时出错。安卓版里一般没有浏览器音色。
- 解决：在 设置 → 配图与朗读 的「朗读来源」里设一个云端服务（Fish Audio、MiniMax、MOSS、Gemini 或供应商的朗读接口）；电脑上可以换 Edge 或 Chrome 打开。

## 朗读失败、试听失败 {#err-tts-failed}

- 原文：朗读失败（{0}）
- 原文：试听失败（{0}）
- 原文：（这个供应商可能没有 /audio/speech 朗读接口，或者模型名不对）
- 英文：Couldn't read aloud ({0})
- 英文：Preview failed ({0})
- 英文：(this provider may not have an /audio/speech endpoint, or the model name is wrong)
- 出现在：点朗读、试听时
- 原因：朗读服务回了错误但没说原因（括号里是状态码），或者选的供应商没有朗读接口。大多数中转站和国内模型服务没有 /audio/speech。
- 解决：换一个有朗读接口的供应商（比如 OpenAI 官方），或者改用 Fish Audio、MiniMax、MOSS、Gemini 朗读。

## 云端朗读服务报错 {#err-cloud-voice}

- 也叫：Fish Audio、MiniMax、MOSS、HTTP 401、HTTP 402、额度不足
- 原文：{0} HTTP {1}：{2}{3}
- 原文：密钥无效或已过期
- 原文：额度不足
- 原文：没有权限
- 原文：模型或音色不存在
- 原文：请求参数或音色不匹配
- 原文：限流或额度不足
- 原文：服务暂时异常
- 英文：{0} HTTP {1}: {2}{3}
- 英文：Key invalid or expired
- 英文：Not enough quota
- 英文：Permission denied
- 英文：Model or voice not found
- 英文：Invalid request parameters or mismatched voice
- 英文：Rate limited or out of quota
- 英文：Service temporarily unavailable
- 出现在：朗读、试听、「从账户读取音色」时
- 原因：云端朗读服务返回了错误，比如「Fish Audio HTTP 401：密钥无效或已过期」。401 是密钥不对，402 是余额不够，404 是音色 ID 或模型不存在，429 是太频繁或额度用完，5xx 是服务那边的问题。
- 解决：按冒号后的说明处理：重新粘贴密钥、充值、检查音色 ID。密钥不要发到群里。

## 连不上云端朗读服务 {#err-cloud-voice-unreachable}

- 平台：Windows、Mac、安卓
- 原文：连不上 {0}：等了 {1} 秒没有回应。{2}
- 原文：连不上 {0}：{1}
- 原文：检查网络，以及「设置 → 网络代理」里的代理是否在运行。
- 原文：现在没走代理：要开代理才能上这个网站的话，去「设置 → 网络代理」选「跟随系统代理」或填代理地址。
- 原文：手机应用不经过代理设置：这个网站在国内多半要开手机上的加速器才能连（全局模式，或把它加进代理规则；能按应用分流的，要把 CicaTavern 勾上），也可以改用国内能直连的 MiniMax 国内站或 MOSS。
- 英文：Can't connect to {0}: no response after {1} seconds. {2}
- 英文：Can't connect to {0}: {1}
- 英文：Check your network, and whether the proxy in "Settings → Network proxy" is running.
- 英文：No proxy is in use right now: if this site needs a proxy, go to "Settings → Network proxy" and choose "Use system proxy" or enter a proxy address.
- 英文：The phone app does not go through a proxy setting: in mainland China this site usually needs a VPN app on the phone (global mode, or with the site added to its proxy rules; one that routes per app needs CicaTavern ticked), or use MiniMax's China site or MOSS, which connect directly.
- 出现在：朗读、试听时
- 原因：Fish Audio、MiniMax 国际站、Gemini 等在国内通常要走代理，没开代理或代理没在运行就连不上。
- 解决：电脑版在 设置 → 连接 → 网络代理 里设好代理；安卓版开手机上的加速器；或者改用国内能直连的 MiniMax 国内站或 MOSS。

## MiniMax 朗读报错 {#err-minimax}

- 原文：MiniMax 错误 {0}：{1}
- 原文：密钥不对，或者和站点（国内站 / 国际站）不一致
- 原文：参数不对：检查模型和音色 ID
- 原文：余额不足
- 原文：限流，稍后再试
- 英文：MiniMax error {0}: {1}
- 英文：Wrong key, or it doesn't match the site (China site / international site)
- 英文：Invalid parameters: check the model and voice ID
- 英文：Insufficient balance
- 英文：Rate limited. Try again later
- 出现在：用 MiniMax 朗读、试听时
- 原因：MiniMax 返回了错误码。1004 是密钥不对，或者国内站的密钥选了国际站（反过来也一样）；1008 是余额不足；2013 是模型或音色 ID 不对；1002、1039 是太频繁。
- 解决：在「朗读来源」的 MiniMax 里，站点选和密钥同一个（国内站 minimaxi.com，国际站 minimax.io），检查音色 ID，余额不足去 MiniMax 充值。

## 朗读的密钥或音色 ID 格式不对 {#err-voice-format}

- 原文：密钥格式不对：只粘贴密钥本身，不要带空格或换行
- 原文：音色 ID「{0}」不对：每行写一个音色，ID 在前，后面可以空一格写名字
- 英文：Invalid key format: paste just the key, with no spaces or line breaks
- 英文：Invalid voice ID "{0}": write one voice per line, ID first, optionally followed by a space and a name
- 出现在：朗读来源里保存密钥、音色列表时
- 原因：密钥里夹了空格或换行；音色列表的某一行开头不是音色 ID。
- 解决：只粘贴密钥本身。音色每行一个，ID 在前，比如「male-qn-qingse 青涩青年」。Fish Audio 可以直接粘贴音色页面的链接。

## 本地语音桥接连不上 {#err-voice-bridge}

- 也叫：借电脑朗读、桥接地址
- 原文：连不上 {0}：电脑上的酒馆开着吗？手机和电脑在同一个 Wi-Fi 吗？
- 原文：访问口令不对：把电脑上酒馆「设置 → 手机访问」里的链接整条粘贴过来
- 原文：电脑上的酒馆不让访问：把它「手机访问」里的链接整条粘贴到「桥接地址」（链接里带着口令）
- 原文：{0}连不上：{1}
- 原文：本地语音桥接（{0}）没开
- 原文：连不上
- 英文：Can't connect to {0}: is CicaTavern running on your computer? Are your phone and computer on the same Wi-Fi?
- 英文：Invalid access code: paste the whole link from "Settings → Phone access" in CicaTavern on your computer
- 英文：CicaTavern on your computer refused access: paste the whole link from its "Phone access" into "Bridge URL" (the link carries the access code)
- 英文：{0} can't be reached: {1}
- 英文：The local voice bridge ({0}) isn't running
- 英文：Can't connect
- 出现在：设置 → 配图与朗读 的「朗读来源」→ 本地语音桥接（标题旁显示「连不上」）
- 原因：「桥接地址」填的服务没开，或者借另一台电脑上的酒馆朗读时，那台电脑没开、不在同一个 Wi-Fi，或者链接里的口令不对。提示里说的「局域网访问」就是现在的「手机访问」。
- 解决：借电脑朗读：在电脑上打开 设置 → 连接 → 手机访问，把显示的链接整条（带 # 后面的口令）复制，粘贴到手机上的「桥接地址」；确认电脑开着酒馆、两边在同一个 Wi-Fi。用不上这个功能的话，把「桥接地址」清空。

## 浏览器语音识别出错 {#err-dictation-browser}

- 也叫：语音输入、麦克风、说话转文字
- 原文：连不上浏览器的语音识别服务（Chrome 用 Google 的，Edge 用微软的）：检查网络，或者在「语音输入」里改用别的方式
- 原文：浏览器的语音识别不支持这个语言：在「语音输入」里换一个
- 原文：浏览器的语音识别出错了：{0}
- 英文：Couldn't reach the browser's speech recognition service (Chrome uses Google's, Edge uses Microsoft's): check the network, or pick another way under Voice input
- 英文：The browser's speech recognition doesn't support this language: pick another under Voice input
- 英文：The browser's speech recognition failed: {0}
- 出现在：点输入框旁的麦克风说话时
- 原因：选的是浏览器自带的语音识别，它要把录音发给 Google（Chrome）或微软（Edge）。在国内 Chrome 的识别服务通常连不上。
- 解决：在 设置 → 配图与朗读 → 语音输入 里改用供应商的转写接口或本地 whisper 服务；或者电脑上换 Edge。

## 网页不能用麦克风（要 https） {#err-dictation-https}

- 平台：手机浏览器
- 原文：这个地址的网页不能直接用麦克风（要 https 或本机地址），改用手机的录音机：录完点确定
- 原文：这个地址的网页不能用麦克风（要 https 或本机地址），试不了；输入框旁的麦克风会改用手机的录音机
- 英文：A page at this address can't use the microphone itself (that needs https or this machine's own address), so the phone's recorder is used: confirm when you've recorded
- 英文：A page at this address can't use the microphone (that needs https or this machine's own address), so this test can't run; the microphone beside the input box uses the phone's recorder instead
- 出现在：手机浏览器通过「手机访问」打开时点麦克风
- 原因：浏览器只让 https 网页或本机地址用麦克风，手机访问电脑用的是 http 局域网地址。
- 解决：照提示用手机自带的录音机录一段，录完点确定，会自动转成文字。这不是故障。

## 语音转写失败 {#err-dictation-transcribe}

- 原文：转写失败（{0}）
- 原文：录音太大了：一次最多 25 MB
- 原文：（这个供应商可能没有 /audio/transcriptions 语音转写接口，或者模型名 {0} 不对）
- 原文：本地转写服务出错：{0}
- 原文：连不上本地转写服务 {0}：确认它开着、地址和端口没写错（{1}）
- 原文：本地转写服务没有 {0} 这个接口：OpenAI 兼容的服务填到 /v1，whisper.cpp 填到 /inference
- 英文：Transcription failed ({0})
- 英文：The recording is too large: 25 MB at most
- 英文：(this provider may have no /audio/transcriptions endpoint, or the model name {0} is wrong)
- 英文：The local transcription server failed: {0}
- 英文：Couldn't reach the local transcription server {0}: check that it is running and the address and port are right ({1})
- 英文：The local transcription server has no {0}: give an OpenAI-compatible server's address up to /v1, whisper.cpp's up to /inference
- 出现在：语音输入、语音输入设置里的测试
- 原因：转写服务出错：选的供应商没有语音转写接口（很多中转站和国内模型服务没有），模型名不对，本地 whisper 服务没开或地址不对，或者一次录得太长。
- 解决：换一个有转写接口的供应商（OpenAI 的 whisper-1、硅基流动等），或者检查本地服务的地址；录音分几段说。

## 手机打开链接要口令 {#err-lan-token}

- 平台：手机浏览器
- 原文：口令不对
- 英文：Wrong access code
- 出现在：手机浏览器打开电脑上酒馆的链接时
- 原因：链接没带口令或口令不对。手机访问的链接 # 后面带着口令，复制时少了一截，或者手动输入的地址没有口令，就会要你填。
- 解决：在电脑上打开 设置 → 连接 → 手机访问，把链接整条复制到手机上打开，或者整条粘贴到口令框里。不要把这个链接发到群里：拿到链接的人能用你的模型额度。

## 手机打不开电脑上的链接 {#err-lan-unreachable}

- 也叫：手机访问打不开、局域网打不开、一直转圈
- 平台：手机浏览器
- 原文：无法访问此网站
- 英文：This site can’t be reached
- 出现在：手机浏览器打开「手机访问」的链接时
- 原因：手机连不到电脑：「谁可以打开」还是「仅这台电脑」或改完没重启服务；两边不在同一个 Wi-Fi；最常见的是 Windows 把这个 Wi-Fi 标成了「公用网络」，或者防火墙拦了 Node.js。
- 解决：按下面几步排查。

1. 电脑上 设置 → 连接 → 手机访问，「谁可以打开」选「同一 WiFi 或 Tailscale」，然后关掉所有窗口等一分钟，再从桌面图标打开。
2. 手机和电脑连同一个 Wi-Fi（访客网络通常互相隔离）。
3. Windows：把这个 Wi-Fi 改成「专用网络」，在防火墙里允许 Node.js 入站；Mac：系统设置 › 网络 › 防火墙 里允许 CicaTavern 传入连接。
4. 出门在外用 Tailscale，不要把端口映射到公网。安卓版应用自己就能玩，不需要这个。

## 复制手机链接失败 {#err-lan-copy}

- 原文：复制失败，请长按链接选择
- 英文：Couldn't copy. Long-press the link to select it
- 出现在：设置 → 连接 → 手机访问 里点「复制」
- 原因：浏览器不让这个页面写剪贴板。
- 解决：长按或用鼠标选中链接文字，手动复制。

## 复制消息失败 {#err-message-copy}

- 原文：复制失败，请长按文字选择
- 英文：Couldn't copy. Long-press the text to select it
- 出现在：聊天页消息下方点「复制」
- 原因：浏览器不让这个页面写剪贴板（手机浏览器通过局域网打开电脑上的酒馆时偶尔会这样）。
- 解决：长按消息文字手动选取复制；选取时名字、按钮和输入框不会被选进去。

## 检查更新连不上 GitHub {#err-update-github}

- 也叫：检查更新失败、更新连不上、GitHub 超时
- 平台：Windows、安卓
- 原文：连不上 GitHub（{0}）。在国内通常要在 设置 → 连接 → 网络代理 里设代理。
- 原文：连 GitHub 超时。在国内通常要在 设置 → 连接 → 网络代理 里设代理。
- 原文：网络超时
- 原文：{0}；国内镜像也没读到（{1}）
- 原文：上次检查没成功：{0}
- 英文：Can't reach GitHub ({0}). In mainland China you usually need a proxy: Settings → Network proxy.
- 英文：GitHub timed out. In mainland China you usually need a proxy: Settings → Network proxy.
- 英文：Network timeout
- 英文：{0}; the mirror in China couldn't be read either ({1})
- 英文：Last check failed: {0}
- 出现在：设置 → 更多 → 更新、打开时的自动检查
- 原因：国内网络常常连不上 GitHub。GitHub 几秒内没回应时会自动改问国内镜像 cnb.cool，两边都读不到才报错。
- 解决：过一会儿再点「检查更新」；电脑版可以在 设置 → 连接 → 网络代理 里设代理（安卓版没有这个设置，提示里说的代理要开手机上的加速器）；也可以到发布页（GitHub Releases 或 cnb.cool）手动下载新版本。

## GitHub 拒绝了检查更新 {#err-update-github-refused}

- 也叫：403、查询次数用完、rate limit
- 原文：GitHub 拒绝了这次查询（{0}）
- 原文：GitHub 的查询次数用完了：没登录时每个网络地址每小时只能查 60 次，手机网络、公司或学校的网络常常很多人共用一个地址。大约 {0} 分钟后恢复
- 原文：{0}。备用的 latest.json 也没读到（{1}），过一会儿再试，或者打开发布页看看
- 原文：超时
- 原文：回复太长
- 英文：GitHub refused this check ({0})
- 英文：GitHub's query limit is used up: without signing in, each network address gets 60 checks an hour, and phone networks, offices and schools often put many people behind one address. It resets in about {0} min
- 英文：{0}. The backup latest.json couldn't be read either ({1}); try again in a while, or open the release page
- 英文：timed out
- 英文：The reply is too long
- 出现在：设置 → 更多 → 更新 里检查更新
- 原因：GitHub 限制了查询次数（同一个网络地址每小时 60 次，共用网络很容易用完），备用的版本文件也没读到（括号里是原因，「超时」就是没等到回应）。
- 解决：等提示的时间过去再查；或者直接打开发布页看有没有新版本。

## 下载更新失败 {#err-update-download}

- 平台：Windows
- 原文：下载失败：{0} 回复 {1}
- 原文：连不上国内镜像（{0}）
- 原文：下载中断了
- 原文：下载不完整（{0} / {1} 字节），再试一次
- 原文：SHA-256 对不上，已丢弃下载的文件。应为 {0}，实际 {1}
- 英文：Download failed: {0} answered {1}
- 英文：Can't reach the mirror in China ({0})
- 英文：The download was interrupted
- 英文：The download is incomplete ({0} / {1} bytes). Try again
- 英文：The SHA-256 doesn't match, so the download was discarded. Expected {0}, got {1}
- 出现在：设置 → 更多 → 更新 →「下载更新」
- 原因：下载途中断网、被代理掐断，或者下载来源（GitHub 或国内镜像）出错；下载的文件和发布页公布的校验值对不上时，为了安全直接丢弃。
- 解决：点「重新下载」，或者换个下载来源（「改从 GitHub 下载」「从国内镜像下载」）；都不行就到发布页手动下载，解压到新文件夹运行。数据不在程序文件夹里，不受影响。

## 这个版本不能自动更新 {#err-update-sha}

- 原文：发布页上写的 SHA-256 和 GitHub 算的对不上，不能自动更新。到发布页确认后手动下载。
- 原文：这个版本没有公布 SHA-256，不能自动更新。到发布页手动下载。
- 原文：应用内更新只支持 Windows 发布包
- 原文：这份 CicaTavern 不是从发布包运行的（比如从源码运行），用 git pull 或到发布页下载更新
- 英文：The SHA-256 on the Releases page doesn't match the one GitHub computed, so the app won't update itself. Check the Releases page and download it by hand.
- 英文：This version has no published SHA-256, so the app won't update itself. Download it by hand from the Releases page.
- 英文：In-app updates only work for the Windows release package
- 英文：This CicaTavern isn't running from a release package (from source, for example). Update with git pull, or download the update from the Releases page
- 出现在：设置 → 更多 → 更新
- 原因：应用内更新要核对发布页公布的 SHA-256，核对不了就不自动装；从源码运行的、或者不是 Windows 发布包的，不在应用里装更新。
- 解决：到发布页手动下载新版本。Windows：解压到新文件夹，双击里面的 CicaTavern.exe，再在 设置 → 更多 →「桌面快捷方式」重新放一个图标；数据不在程序文件夹里，不受影响。从源码运行的用 git pull。

## Mac 版在应用里更新不了 {#err-update-mac}

- 也叫：Mac 更新失败、Mac 不能更新、dmg 更新
- 平台：Mac
- 原文：这个版本没有这台 Mac 能在应用里安装的更新包，到发布页下载 dmg
- 原文：这份 CicaTavern 不是从 CicaTavern.app 运行的（比如从源码运行），用 git pull 或到发布页下载更新
- 原文：更新包里缺文件，或者不是 Mac 发布版
- 原文：新版本的 node 运行不了（{0}）
- 原文：这是 CicaTavern.app 自带的版本，要删就把 CicaTavern 从「应用程序」移到废纸篓
- 原文：应用内更新只支持 Mac 上的 CicaTavern
- 英文：This version has no update package this Mac can install in the app: download the dmg from the release page
- 英文：This CicaTavern isn't running from CicaTavern.app (from source, for example): use git pull, or download the update from the release page
- 英文：The update package is missing files, or isn't the Mac release
- 英文：The new version's node doesn't run ({0})
- 英文：This is the version inside CicaTavern.app: to delete it, move CicaTavern from Applications to the Trash
- 英文：In-app updates only work for CicaTavern on a Mac
- 出现在：设置 → 更多 → 更新
- 原因：发布页上没有给这台 Mac（这种芯片）的更新包，或者下载的包不完整、里面的 Node 在这台 Mac 上跑不起来；从源码运行的不在应用里更新。最后一条是在清理旧版本时想删 App 自带的那个版本：它在 CicaTavern.app 里面，不能从应用里删。
- 解决：到发布页下载对应芯片的 dmg（Apple 芯片用 mac-arm64，Intel 用 mac-x64），先在设置里「退出应用并停止后台服务」并关掉窗口，再把 CicaTavern 拖进「应用程序」替换旧的。数据在 ~/.cicatavern，不受影响。

## Mac 版打不开或连不上服务 {#err-mac-launch}

- 也叫：Mac 打不开、Mac 闪退、Mac 白屏、Mac 启动失败
- 平台：Mac
- 原文：CicaTavern 没能启动
- 原文：连不上 CicaTavern 的服务
- 原文：运行不了内置的 Node：
- 原文：内置的 Node 被系统终止了（信号 {0}）。
- 原文：没能移到「应用程序」
- 原文：下载没成功：
- 英文：CicaTavern did not start
- 英文：Can't reach the CicaTavern server
- 英文：Could not run the bundled Node:
- 英文：The bundled Node was stopped by the system (signal {0}).
- 英文：Could not move it to Applications
- 英文：The download failed:
- 出现在：打开 CicaTavern.app、窗口里、保存文件时
- 原因：「没能启动」时下面附着后台服务的输出，常见的是端口 8790 被占用（已经开着一个，或者别的程序在用）、App 不完整。「连不上服务」是后台服务退出了。「没能移到应用程序」多是权限或旧版本还开着。「下载没成功」是保存文件时出错。
- 解决：

1. 「CicaTavern 没能启动」：看提示里的输出，点「重试」；还不行，退出后重新从发布页下载 dmg 安装。
2. 「连不上 CicaTavern 的服务」：按 ⌘R 重新启动服务。
3. 「没能移到「应用程序」」：自己把 CicaTavern 拖进「应用程序」文件夹，再从那里打开。
4. 都不行时，把提示里的文字（不含 API Key）连同版本号发到群里或 GitHub Issue。

## 重启更新没成功 {#err-update-restart}

- 平台：Windows
- 原文：重启没能开始：{0}
- 原文：缺少 bin/update-apply.mjs
- 原文：更新没成功：{0}
- 原文：服务没有回应：从桌面图标重新打开 CicaTavern
- 英文：Couldn't start the restart: {0}
- 英文：bin/update-apply.mjs is missing
- 英文：Update failed: {0}
- 英文：The service isn't responding: reopen CicaTavern from its desktop icon
- 出现在：点「重启并更新」「回到上一版」之后
- 原因：切换版本的程序没能启动（程序文件夹不完整，常见于被杀毒软件删了文件），或者新版本没能启动。新版本起不来时会自动回到原来的版本。
- 解决：从桌面图标重新打开 CicaTavern 看现在是哪个版本；还不行就到发布页手动下载新版本解压运行。

## 安卓更新下载没成功 {#err-update-android}

- 平台：安卓
- 原文：下载没成功：{0}。检查网络后再试，或者换个下载来源（国内网络常常连不上 GitHub），也可以到发布页手动下载。
- 原文：还没允许 CicaTavern「安装未知应用」，所以没装上。再点一次「下载并安装」，在打开的设置里打开开关后返回。
- 英文：The download failed: {0}. Check the network and try again, or try the other source (GitHub is often unreachable from mainland China), or download it from the release page.
- 英文：CicaTavern isn't allowed to install unknown apps yet, so nothing was installed. Tap Download and install again, turn the switch on in the settings that open, then come back.
- 出现在：安卓版 设置 → 更多 → 更新
- 原因：下载安装包时网络断了或连不上 GitHub；或者第一次更新时还没允许 CicaTavern 安装应用。
- 解决：换个下载来源再试；第一次更新时在弹出的系统设置里打开「安装未知应用」开关再返回。也可以用浏览器到发布页下载 APK 覆盖安装，数据都保留。

## 手机上不能替电脑更新 {#err-update-phone-browser}

- 平台：手机浏览器
- 原文：在电脑上打开 CicaTavern 更新：手机上不能替电脑装新版本。
- 英文：Open CicaTavern on the computer to update: a phone can't install a new version for the computer.
- 出现在：用手机浏览器访问电脑上的酒馆，打开 设置 → 更多 → 更新
- 原因：更新要在运行酒馆的那台电脑上做。
- 解决：在电脑上打开 CicaTavern，设置 → 更多 → 更新。

## 要重启后台服务后才能用 {#err-restart-needed}

- 也叫：更新后功能用不了
- 原文：错误日志要重启后台服务后才能用：关掉所有窗口等一分钟，再从桌面图标打开。
- 原文：屏蔽词要重启后台服务后才能用：关掉所有窗口等一分钟，再从桌面图标打开。
- 原文：你的角色和文风要重启后台服务后才能用：关掉所有窗口等一分钟，再从桌面图标打开。
- 原文：语音输入要重启后台服务后才能用：关掉所有窗口等一分钟，再从桌面图标打开。
- 原文：性能记录要重启后台服务后才能用：关掉所有窗口等一分钟，再从桌面图标打开。
- 原文：要重启后台服务后才能用：关掉所有窗口等一分钟，再从桌面图标打开。
- 英文：The error log works once the background server restarts: close every window, wait a minute, then open it from the desktop icon.
- 英文：Blocked words work once the background server restarts: close every window, wait a minute, then open it from the desktop icon.
- 英文：Personas and styles work after the background service restarts: close every window, wait a minute, then open it from the desktop icon again.
- 英文：Voice input works once the background server restarts: close every window, wait a minute, then open it from the desktop icon.
- 英文：The performance log needs the background service restarted: close all windows, wait a minute, then open the app from its desktop icon again.
- 英文：This works once the background server restarts: close every window, wait a minute, then open it from the desktop icon.
- 出现在：手动更新之后打开新功能时
- 原因：页面已经是新版本，后台还在跑旧版本的服务。
- 解决：关掉所有 CicaTavern 窗口（包括手机上打开的），等一分钟让服务退出，再从桌面图标打开；或者在 设置 → 更多 →「退出应用并停止后台服务」后重新打开。

## 打开对话时整个页面没反应 {#err-chat-froze}

- 也叫：卡死、点什么都没反应、界面不动、打开就卡住、重启也没用
- 原文：之前打开「{0}」时页面没有反应，正在检查原因…
- 原文：正则「{0}」在这段对话上跑不完，卡住了页面，这台设备上显示时先跳过它。可以在 设置 → 写作 → 正则 里关掉或修改。
- 原文：之前打开「{0}」时页面没有反应，这次没有自动打开它。可能是这张卡的界面脚本卡住了：可以先导出或删掉这段对话，或者再试一次。
- 英文：The page stopped responding when "{0}" was opened before. Checking why…
- 英文：The regex "{0}" never finishes on this chat and froze the page, so this device skips it when showing the chat. You can turn it off or change it in Settings → Writing → Regex.
- 英文：The page stopped responding when "{0}" was opened before, so it wasn't opened this time. A script in the card's interface may be stuck: you can export or delete this chat first, or try again.
- 出现在：上次打开某段对话时页面卡死、被强行关掉之后，再次打开应用时
- 原因：角色卡或预设的显示正则在这段对话的文字上一直算不完，或者角色卡界面里的脚本陷入死循环。页面在这时停住，点什么都没反应；而应用每次启动都会打开最近的对话，所以重启后还是卡住。手机和平板上更容易遇到：应用里的网页视图让卡片界面和页面共用一个线程。
- 解决：更新到最新版再打开应用，卡住的那段对话不会再自动打开，应用会自己找原因，见下面。

卡住的那段对话下次启动时不会自动打开，应用会先在后台逐条试这段对话的显示正则：

1. 找到跑不完的正则：这台设备显示时跳过它，然后照常打开对话。之后可以在「设置 → 写作 → 正则」里关掉或修改它，改过的正则会重新启用。
2. 正则都没问题：多半是卡片界面的脚本卡住了。这段对话先不打开，其他卡和对话照常能用。可以先导出或删掉它，也可以点「仍然打开」再试。
3. 卡住和找到的正则都记在「设置 → 更多 → 错误日志」里，反馈问题时附上日志和卡，方便查原因。

## 错误日志复制不了 {#err-error-log-copy}

- 在哪：设置 → 更多 → 错误日志
- 原文：没能复制：在上面的框里全选后手动复制
- 英文：Couldn't copy: select everything in the box above and copy it by hand
- 出现在：错误日志里点「复制」
- 原因：浏览器不让这个页面写剪贴板。
- 解决：在日志框里全选（Ctrl+A）后手动复制，或者点「保存为文件」把文件发出去。日志里的密钥、令牌和电脑用户名已经去掉，发之前可以先看一遍。

## 安卓上保存失败 {#err-android-save}

- 平台：安卓
- 原文：保存失败
- 英文：Couldn't save
- 出现在：安卓版导出角色卡、存档、错误日志等文件时
- 原因：应用没能把文件写进手机的「下载」文件夹（存储空间满了，或者系统不让写）。
- 解决：清出一些空间再试；错误日志可以改用「复制」。

## 找不到填的字体 {#err-font-missing}

- 原文：这台设备上找不到「{0}」，正文用宋体显示。
- 英文：“{0}” isn't on this device: the story shows in Serif.
- 出现在：主题里填本机字体时
- 原因：这台设备上没装这个字体，或者名字和系统里显示的不一样。手机上一般没有电脑装的字体。
- 解决：照系统字体列表里的名字填（比如「霞鹜文楷」），或者先安装这个字体。

## 文件太长只读入了一部分 {#err-file-too-long}

- 原文：文件太长，只读入了前 {0} 个字，保存后生效
- 英文：The file is too long; only its first {0} characters were read. Takes effect when you save
- 出现在：设置 → 配图与朗读 的「画面提示词」里「从文件读入」
- 原因：读入的生图规则文件超过了这一栏的长度上限，后面的部分没读进来。
- 解决：把文件里用不上的部分删掉再读入，或者读入后手动精简。
