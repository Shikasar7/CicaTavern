<!-- The release workflows fill this in: windows-release.yml NODE_VERSION, VERSION,
ZIP_SHA256 and SIGNED; mac-release.yml NODE_VERSION, VERSION, MAC_ARM64_SHA256, MAC_X64_SHA256,
MAC_ARM64_DMG_SHA256 and MAC_X64_DMG_SHA256. Whichever runs first creates the draft from this file, the other
fills its own lines into the draft. Write the new content and the APK lines by hand
before publishing. The in-app updater checks the zip against the SHA-256 below. -->
（一两句话说这一版的重点。）

## 下载

**CicaTavern-{{VERSION}}-win-x64.zip**：Windows 64 位，解压即用，自带 Node.js {{NODE_VERSION}}（官方版本）。

1. 解压到任意位置（路径里有中文也可以）。
2. 双击 **CicaTavern.exe**：在后台启动服务，并用 Edge 或 Chrome 的应用窗口打开。想要桌面图标：设置 → 更多 →「桌面快捷方式」。
3. 第一次打开时，Windows 可能提示「已保护你的电脑」：点「更多信息 → 仍要运行」。

**CicaTavern-{{VERSION}}-mac-arm64.dmg**：Apple 芯片（M1 及以后）的 Mac；**CicaTavern-{{VERSION}}-mac-x64.dmg**：Intel 芯片的 Mac。都要 macOS 13.5 以上，自带 Node.js {{NODE_VERSION}}（官方版本）。不知道是哪种：苹果菜单 → 关于本机，「芯片」写着 Apple M… 的就是 Apple 芯片。

1. 双击下载的 dmg，在打开的窗口里**把 CicaTavern 拖到「应用程序」**。
2. 到「应用程序」里双击 **CicaTavern**。第一次会提示「Apple 无法验证……是否包含恶意软件」：点「完成」，不要点「移到废纸篓」。
3. 打开 系统设置 → 隐私与安全性，往下找到关于 CicaTavern 被阻止的那一行，点「仍要打开」，输入密码确认后再点「打开」。以后直接双击就行。

Mac 版还没有经过 Apple 公证（作者还没有 Apple 开发者账号），所以第一次要多这一步；dmg 的窗口里也写着。同一版本也有 zip（CicaTavern-{{VERSION}}-mac-arm64.zip、-mac-x64.zip），解压后同样拖进「应用程序」再打开。

**CicaTavern-{{VERSION}}-android-arm64.apk**：安卓版，Android 10 以上的 64 位手机，覆盖安装保留数据。

## 从上一版升级

- 1.4.0 及以后：设置 → 更多 →「更新」→「下载更新」→「重启并更新」。旧版本的文件夹留着，可以回到上一版。
- 更早的版本：解压新版到新文件夹，双击里面的 CicaTavern.exe，在 设置 → 更多 →「桌面快捷方式」重新放一个图标。旧文件夹可以删掉。
- Mac：设置 → 更多 →「更新」→「下载更新」→「重启并更新」（从 {{VERSION}} 起）。新版本放在 ~/Library/Application Support/CicaTavern，不用再点「仍要打开」，也能回到上一版。更早的 Mac 版本：先在设置里「停止后台服务」并关掉窗口，再打开新版本的 dmg，把 CicaTavern 拖到「应用程序」替换旧的，第一次打开时再点一次「仍要打开」。
- 数据都在 `%USERPROFILE%\.cicatavern\`（Mac：`~/.cicatavern`），不受影响。

## 新内容

- （逐条写）

完整列表见 [CHANGELOG.md](https://github.com/Shikasar7/CicaTavern/blob/v{{VERSION}}/CHANGELOG.md)。

## 校验

```
SHA-256  {{ZIP_SHA256}}  CicaTavern-{{VERSION}}-win-x64.zip
SHA-256  {{MAC_ARM64_DMG_SHA256}}  CicaTavern-{{VERSION}}-mac-arm64.dmg
SHA-256  {{MAC_X64_DMG_SHA256}}  CicaTavern-{{VERSION}}-mac-x64.dmg
SHA-256  {{MAC_ARM64_SHA256}}  CicaTavern-{{VERSION}}-mac-arm64.zip
SHA-256  {{MAC_X64_SHA256}}  CicaTavern-{{VERSION}}-mac-x64.zip
SHA-256  （APK 的 SHA-256）  CicaTavern-{{VERSION}}-android-arm64.apk
```

Windows 包和 Mac 包都由 GitHub Actions 从本仓库源码自动构建（构建记录在 Actions 页）。本版 CicaTavern.exe：{{SIGNED}}。Mac 的 CicaTavern.app 只做了 ad hoc 签名，没有 Apple 公证；里面的 Node.js 保留 Node.js 官方的签名。

安卓版的签名证书和之前的版本相同（CN=Shikasar7, O=CicaTavern）：

```
SHA-256  45:84:66:61:33:a8:b9:9a:6a:d3:a1:4e:5e:d0:5e:d5:ec:2f:b9:23:87:30:68:6b:9b:5d:8b:eb:a3:e3:d5:9d
```

## 第三方组件

- Windows 包：Node.js（许可证在 `runtime/LICENSE`），其余见包里的 `THIRD_PARTY_NOTICES.md`。
- Mac 包：Node.js（许可证在 `CicaTavern.app/Contents/Resources/app/runtime/LICENSE`），其余见同一文件夹的 `THIRD_PARTY_NOTICES.md`。
- 安卓包：[nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile)（Node.js 许可证）、yaml（ISC）、quickjs-emscripten（MIT）。

---

MIT 许可证，作者 Shikasar7。
