<!-- The Windows release workflow (.github/workflows/windows-release.yml) fills in NODE_VERSION,
VERSION, ZIP_SHA256 and SIGNED; write the new content and the APK lines by hand
before publishing. The in-app updater checks the zip against the SHA-256 below. -->
（一两句话说这一版的重点。）

## 下载

**CicaTavern-{{VERSION}}-win-x64.zip**：Windows 64 位，解压即用，自带 Node.js {{NODE_VERSION}}（官方版本）。

1. 解压到任意位置（路径里有中文也可以）。
2. 双击 **CicaTavern.exe**：在后台启动服务，并用 Edge 或 Chrome 的应用窗口打开。想要桌面图标：设置 → 更多 →「桌面快捷方式」。
3. 第一次打开时，Windows 可能提示「已保护你的电脑」：点「更多信息 → 仍要运行」。

**CicaTavern-{{VERSION}}-android-arm64.apk**：安卓版，Android 10 以上的 64 位手机，覆盖安装保留数据。

## 从上一版升级

- 1.4.0 及以后：设置 → 更多 →「更新」→「下载更新」→「重启并更新」。旧版本的文件夹留着，可以回到上一版。
- 更早的版本：解压新版到新文件夹，双击里面的 CicaTavern.exe，在 设置 → 更多 →「桌面快捷方式」重新放一个图标。旧文件夹可以删掉。
- 数据都在 `%USERPROFILE%\.cicatavern\`，不受影响。

## 新内容

- （逐条写）

完整列表见 [CHANGELOG.md](https://github.com/Shikasar7/CicaTavern/blob/v{{VERSION}}/CHANGELOG.md)。

## 校验

```
SHA-256  {{ZIP_SHA256}}  CicaTavern-{{VERSION}}-win-x64.zip
SHA-256  （APK 的 SHA-256）  CicaTavern-{{VERSION}}-android-arm64.apk
```

Windows 包由 GitHub Actions 从本仓库源码自动构建（构建记录在 Actions 页）。本版 CicaTavern.exe：{{SIGNED}}。

安卓版的签名证书和之前的版本相同（CN=Shikasar7, O=CicaTavern）：

```
SHA-256  45:84:66:61:33:a8:b9:9a:6a:d3:a1:4e:5e:d0:5e:d5:ec:2f:b9:23:87:30:68:6b:9b:5d:8b:eb:a3:e3:d5:9d
```

## 第三方组件

- Windows 包：Node.js（许可证在 `runtime/LICENSE`），其余见包里的 `THIRD_PARTY_NOTICES.md`。
- 安卓包：[nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile)（Node.js 许可证）、yaml（ISC）、quickjs-emscripten（MIT）。

---

MIT 许可证，作者 Shikasar7。
