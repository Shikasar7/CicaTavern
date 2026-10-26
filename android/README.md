# CicaTavern 安卓版

装在手机上独立运行，不需要电脑。用的是**第三方供应商**的模型（DeepSeek、OpenAI 兼容接口、OpenRouter、Anthropic API 等），和电脑版一样填自己的 API Key。

## 它是怎么跑的

- APK 里内嵌了 Node（[nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) 18.20.4，只有 arm64），运行的是和电脑版同一份 `server/`、`web/`，入口是 `bin/android.mjs`。
- 服务只监听 `127.0.0.1` 的随机端口，每次启动生成一个新口令，由应用写进 WebView 的 Cookie。手机上的其他应用就算找到这个端口，没有口令也用不了。
- 打开应用后，通知栏会有一条「CicaTavern 在运行」（前台服务）。有它在，切到别的应用时正在写的回复会继续生成；在最近任务里把应用划掉，服务就停了。
- 数据存在应用的私有目录里，卸载应用会一起删掉。要换手机或重装，先在对话里「导出存档」或打包对话，文件会存到「下载」文件夹。
- 不参与系统备份（`providers.json` 里有 API Key）。

## 和电脑版的差别

- 设置里没有「手机访问」和「停止后台服务」。
- 代理：应用本身不走代理。需要翻墙的接口，用手机上的代理应用开 VPN 模式。
- 朗读：应用里的网页视图（WebView）一般读不出浏览器音色，请用「配图与朗读 → 朗读来源」里的云端服务（Fish Audio、MiniMax、供应商的朗读接口），密钥存在手机上的应用里。也可以把「本地语音桥接」填成电脑上 CicaTavern「设置 → 手机访问」里的链接，借电脑朗读。
- 配图的 ComfyUI 地址要填电脑的局域网地址。
- 语音输入：WebView 里没有浏览器的语音识别，请在「配图与朗读 → 语音输入」里选供应商的转写接口，或填电脑上 whisper 服务的局域网地址。页面用 getUserMedia 录音，第一次点麦克风时应用向系统要 `RECORD_AUDIO` 权限（`MainActivity` 的 `onPermissionRequest` 只给应用自己的页面开麦克风，卡片界面的 iframe 要不到）。

## 构建

需要：JDK 17、Android SDK（platform 35、build-tools 35.0.1、NDK 28.1.13356709、CMake 3.22.1）、Node 20 以上（打包时用来复制文件）。

1. 下载 nodejs-mobile 的安卓预编译包，解压到 `android/vendor/nodejs-mobile/`（解压后应该有 `bin/arm64-v8a/libnode.so` 和 `include/node/`）：
   https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip
2. 在 `android/local.properties` 里写上 SDK 路径，例如 `sdk.dir=C:/Users/<你>/AppData/Local/Android/Sdk`。
3. 在仓库根目录执行过 `npm install`（需要里面的 `yaml` 和 `quickjs-emscripten`）。
4. 在 `android/` 目录下：

   ```bash
   ./gradlew assembleRelease
   ```

   构建前会自动执行 `scripts/stage-node.mjs`，把服务端、界面和运行时依赖复制到 `app/src/main/assets/nodejs-project/`。
   需要代理的话，在命令后面加 `-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7890`（换成你的代理端口）。

产物在 `app/build/outputs/apk/release/app-release.apk`。版本号取自仓库根目录的 `package.json`（1.1.0 → versionCode 10100）。手机上要允许「安装未知应用」。

### 签名

- 自己构建时，没有签名文件就用本机的调试密钥签名，可以直接装在自己手机上。
- 调试密钥签的包和 Release 页面上的官方 APK 签名不同，不能直接覆盖安装（要先卸载，数据会一起删掉）。
- 要用自己的正式密钥，在 `~/.android/cicatavern-release.properties`（或用 `-PcicaSigning=<文件>` 指定）里写 `storeFile`、`storePassword`、`keyAlias`、`keyPassword`。这个文件和密钥库不要放进仓库。

## 出问题时

- 启动失败时，应用会显示原因和服务日志的最后一段，可以一键复制。
- 服务的输出写在应用私有目录的 `server.log`（上一次启动的是 `server.prev.log`）。用 USB 连上电脑后可以用 `adb shell run-as app.cicatavern cat files/server.log` 查看（需要调试版）。
- 调试版（`assembleDebug`）可以在电脑的 Chrome 里打开 `chrome://inspect` 调试页面。
