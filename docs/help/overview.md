# CicaTavern 简介

这几节是 CicaTavern 最基本的情况。功能、报错、常见问题和版本见同一文件夹里的 features.md、errors.md、faq.md、versions.md。

## CicaTavern 是什么 {#overview-what}

- 也叫：酒馆、Cica 酒馆、CT、cicatavern

CicaTavern 是 Agent 式的 SillyTavern 角色卡酒馆：导入 SillyTavern 的角色卡、世界书和预设，用**你自己的模型 API**（DeepSeek、OpenRouter、Anthropic、OpenAI、Gemini、Kimi、智谱、通义、火山方舟、本机 Ollama 等）跑剧情。特点：提示词按缓存设计，长对话便宜、出字快；兼容酒馆的角色卡、世界书、预设、正则、MVU 变量和卡片里的状态栏界面；自带一键配图和朗读；能把剧情变成视觉小说；每个角色的长相和音色固定；有创作向导帮你写角色卡。界面有简体中文和英文，数据全部存在你自己的设备上。

## 支持哪些平台 {#overview-platforms}

- 也叫：电脑版、手机版、安卓版、苹果、iPhone、iPad、iOS、TestFlight、Mac 版、系统要求

- **Windows**：下载 zip，解压后双击「CicaTavern.exe」，自带运行环境，不用另外安装。
- **Mac（测试版）**：dmg 安装包，分 Apple 芯片（arm64）和 Intel（x64）两种，要求 macOS 13.5 以上，已签名并经过 Apple 公证。
- **安卓**：apk 安装包，要求 Android 10 以上的 64 位手机，在手机上独立运行，不用开电脑。
- **iPhone 和 iPad（测试版）**：通过 TestFlight 安装，要求 iOS 16 以上，在设备上独立运行，不用开电脑。
- **手机浏览器**：电脑上开着 CicaTavern 时，在「设置 → 连接 → 手机访问」打开局域网访问，手机（包括 iPhone）用浏览器打开带口令的链接就能玩，用的是电脑上的模型和数据。iPhone 没有单独的应用。

## 最新版本和下载 {#overview-download}

- 也叫：下载地址、安装包、最新版、更新、国内下载、镜像

最新版本是 **2.4.0**（2026-11-07）。下载：

- GitHub 发布页：https://github.com/Shikasar7/CicaTavern/releases/latest
- 国内镜像（同样的文件）：https://cnb.cool/cicatavern/CicaTavern/-/releases
- iPhone 和 iPad（TestFlight 测试版）：https://testflight.apple.com/join/wsT7kT4b

1.4.0 以后的版本可以在应用里直接更新：设置 → 更多 → 更新。每个版本改了什么见 versions.md。

## 数据存在哪 {#overview-data}

- 也叫：存档位置、数据文件夹、备份、换电脑、API Key 存在哪

- **Windows**：`%USERPROFILE%\.cicatavern\`；**Mac**：用户主目录下的 `.cicatavern` 文件夹。角色卡、世界书、预设、对话、配图和供应商设置（含 API Key，明文）都在里面，换电脑时整个文件夹拷过去即可。更新、回到上一版都不会动它。
- **安卓**：存在应用自己的空间里，卸载应用时一起删除。

手机和电脑的数据互不相通，要搬对话用「导出存档」再在另一边导入。因为 API Key 是明文存的，不要把这个文件夹或里面的文件发给别人。

## 收费和隐私 {#overview-cost-privacy}

- 也叫：要钱吗、免费吗、收费、开源、会不会上传我的对话、隐私

CicaTavern 本身免费、开源（AGPL-3.0 许可证，2.2.4 及以前的版本是 MIT）。模型、画图、朗读用的是你自己添加的服务，费用按你自己的账号计。CicaTavern 不收集使用数据，也不往开发者那里发任何东西；只连你自己配置的服务，以及检查更新、字体、卡片界面用到的公共库这几处（第一次打开时会列出来，可以关掉）。

## 遇到问题怎么反馈 {#overview-help}

- 也叫：反馈、报 bug、找作者、问作者、提 issue

先打开 设置 → 更多 → 错误日志，复制或保存下来，连同问题描述（用的版本、平台、做了什么）发到 GitHub Issue 或交流群。错误日志里没有对话和角色卡内容，API Key 已经去掉。截图时不要露出 API Key。
