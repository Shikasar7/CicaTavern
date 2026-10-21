// CicaTavern.app's executable (Contents/MacOS/CicaTavern): the Mac counterpart
// of CicaTavern.exe (launcher/CicaTavern.cpp) and of the phone app's
// MainActivity (android/).
//
//   1. Runs Contents/Resources/app/runtime/node bin/launch.mjs --no-window
//      --port 8790 in Contents/Resources/app (the tree scripts/stage-release.mjs
//      --platform mac writes). launch.mjs starts the server detached, so it
//      outlives this app and quits by itself about a minute after the last page
//      closes (or at 设置 → 停止后台服务), and exits 0 once the page answers, or
//      non-zero with the reason on stderr.
//   2. Exit 0: a window with a WKWebView on http://127.0.0.1:8790/. Otherwise
//      an alert with the end of what launch.mjs printed.
//
// In the window: alert(), confirm() and prompt() as Mac alerts; <input type=file>
// through an open panel; downloads (<a download>, blob: and attachment
// responses) through a save panel; target=_blank and anything that leaves the
// local server go to the default browser, while the cards' sandboxed frames
// (about:srcdoc) load in place. Closing the window quits the app, after leaving
// the page so its /api/presence stream ends and the server's idle countdown starts.
//
// Built by .github/workflows/mac-release.yml with the Command Line Tools alone:
//   swiftc -O -swift-version 5 -target arm64-apple-macos13.5 -framework Cocoa -framework WebKit -o CicaTavern main.swift
// macOS 13.5 is Node 24's own minimum (Node's BUILDING.md); Info.plist says the same.
import Cocoa
import WebKit

let serverPort = 8790
let home = URL(string: "http://127.0.0.1:\(serverPort)/")!

/// The app's own words in the user's first language: Chinese or English.
let chinese = Locale.preferredLanguages.first.map { $0.hasPrefix("zh") } ?? true
func L(_ zh: String, _ en: String) -> String { chinese ? zh : en }

/// A plain page for starting and for errors, light or dark like the system.
func messagePage(_ title: String, _ detail: String = "") -> String {
    func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
    return """
    <!doctype html><meta charset="utf-8"><title>CicaTavern</title>
    <style>
    body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;color:#ddd;background:#14161a}
    @media (prefers-color-scheme: light){body{color:#222;background:#f6f6f4}}
    main{max-width:640px;padding:32px}
    pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Menlo,monospace;opacity:.8;user-select:text}
    </style>
    <main><h3>\(escape(title))</h3><pre>\(escape(detail))</pre></main>
    """
}

/// What launch.mjs writes to stderr, gathered on the pipe's own thread.
final class Output: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func append(_ chunk: Data) {
        lock.lock()
        data.append(chunk)
        lock.unlock()
    }

    /// The end of it, about as much as an alert can show.
    func tail() -> String {
        lock.lock()
        let text = String(decoding: data, as: UTF8.self)
        lock.unlock()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count > 1500 ? "…" + String(trimmed.suffix(1500)) : trimmed
    }
}

/// The web view's delegates: what stays in the window, the panels, downloads.
final class Page: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    weak var window: NSWindow?
    /// Called once about:blank has loaded (quitting).
    var onBlank: (() -> Void)?

    private func isLocal(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "http" && (url.host == "127.0.0.1" || url.host == "localhost")
    }

    /// Only web and mail links leave the app: to the default browser or mail app.
    private func openOutside(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let frame = navigationAction.targetFrame else {
            // target=_blank or window.open(): the default browser.
            openOutside(url)
            decisionHandler(.cancel)
            return
        }
        // The server's pages, the start and error pages (about:blank) and the
        // cards' sandboxed frames (about:srcdoc).
        if isLocal(url) || url.scheme?.lowercased() == "about" {
            decisionHandler(.allow)
            return
        }
        // The window never leaves the local server, nor does a link clicked inside a frame.
        if frame.isMainFrame || navigationAction.navigationType == .linkActivated {
            openOutside(url)
            decisionHandler(.cancel)
            return
        }
        // What a card's frame loads in place (blob:, data:, an embedded page).
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if disposition.lowercased().hasPrefix("attachment") || !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView.url?.absoluteString == "about:blank", let done = onBlank {
            onBlank = nil
            done()
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let error = error as NSError
        // Cancelled, or turned into a download.
        if error.code == NSURLErrorCancelled || (error.domain == "WebKitErrorDomain" && error.code == 102) { return }
        webView.loadHTMLString(messagePage(L("连不上 CicaTavern 的服务", "Can't reach the CicaTavern server"), error.localizedDescription + "\n\n" + L("按 ⌘R 重新启动服务。", "Press ⌘R to start it again.")), baseURL: nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: Windows and panels

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { openOutside(url) }
        return nil
    }

    private func alert(_ message: String) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = "CicaTavern"
        alert.informativeText = message
        return alert
    }

    /// A sheet on the window when it is open, else a modal alert.
    private func present(_ alert: NSAlert, _ done: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window = window, window.isVisible {
            alert.beginSheetModal(for: window, completionHandler: done)
        } else {
            done(alert.runModal())
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let panel = alert(message)
        panel.addButton(withTitle: L("好", "OK"))
        present(panel) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let panel = alert(message)
        panel.addButton(withTitle: L("好", "OK"))
        panel.addButton(withTitle: L("取消", "Cancel"))
        present(panel) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let panel = alert(prompt)
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
        panel.accessoryView = field
        panel.addButton(withTitle: L("好", "OK"))
        panel.addButton(withTitle: L("取消", "Cancel"))
        panel.window.initialFirstResponder = field
        present(panel) { response in completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let chooser = NSOpenPanel()
        chooser.canChooseFiles = true
        chooser.canChooseDirectories = parameters.allowsDirectories
        chooser.allowsMultipleSelection = parameters.allowsMultipleSelection
        if let window = window {
            chooser.beginSheetModal(for: window) { response in completionHandler(response == .OK ? chooser.urls : nil) }
        } else {
            completionHandler(chooser.runModal() == .OK ? chooser.urls : nil)
        }
    }

    // MARK: Downloads

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let save = NSSavePanel()
        save.nameFieldStringValue = suggestedFilename
        save.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        save.canCreateDirectories = true
        let chosen: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .OK, let url = save.url else {
                completionHandler(nil)
                return
            }
            // The panel has already asked about replacing; WebKit does not write over a file.
            try? FileManager.default.removeItem(at: url)
            completionHandler(url)
        }
        if let window = window {
            save.beginSheetModal(for: window, completionHandler: chosen)
        } else {
            chosen(save.runModal())
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let panel = alert(L("下载没成功：", "The download failed: ") + error.localizedDescription)
        panel.addButton(withTitle: L("好", "OK"))
        present(panel) { _ in }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var web: WKWebView!
    private let page = Page()
    private var titleWatch: NSKeyValueObservation?
    private var starting = false
    private var quitting = false
    private var quitReplied = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = mainMenu()
        makeWindow()
        start()
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// Leave the page first, so the server sees it go; then quit (at most 1.5 s later).
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !quitting, let web = web, web.url?.host == "127.0.0.1" else { return .terminateNow }
        quitting = true
        page.onBlank = { [weak self] in self?.finishQuitting() }
        web.load(URLRequest(url: URL(string: "about:blank")!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.finishQuitting() }
        return .terminateLater
    }

    private func finishQuitting() {
        guard quitting, !quitReplied else { return }
        quitReplied = true
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    private func makeWindow() {
        let config = WKWebViewConfiguration()
        // The page plays voices and music when a turn arrives, not only after a click.
        config.mediaTypesRequiringUserActionForPlayback = []
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = page
        web.uiDelegate = page
        // Safari → 设置 → 高级 →「显示网页开发者功能」, then 开发 → this Mac → CicaTavern.
        web.isInspectable = true

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "CicaTavern"
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.minSize = NSSize(width: 420, height: 480)
        window.contentView = web
        window.center()
        // Where the window was last time, if anywhere.
        window.setFrameAutosaveName("CicaTavern")
        page.window = window
        titleWatch = web.observe(\.title, options: [.new]) { [weak self] view, _ in
            let title = view.title ?? ""
            self?.window?.title = title.isEmpty ? "CicaTavern" : title
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Runs launch.mjs; then the page, or an alert with what went wrong.
    private func start() {
        if starting { return }
        starting = true
        web.loadHTMLString(messagePage(L("正在启动 CicaTavern…", "Starting CicaTavern…")), baseURL: nil)
        let folder = Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true)
        let node = folder.appendingPathComponent("runtime").appendingPathComponent("node")
        let process = Process()
        process.executableURL = node
        process.arguments = ["bin/launch.mjs", "--no-window", "--port", String(serverPort)]
        process.currentDirectoryURL = folder
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        let errors = Pipe()
        process.standardError = errors
        let output = Output()
        errors.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
            } else {
                output.append(chunk)
            }
        }
        process.terminationHandler = { finished in
            let status = finished.terminationStatus
            let signaled = finished.terminationReason == .uncaughtSignal
            // The last of stderr can come just after the exit.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                errors.fileHandleForReading.readabilityHandler = nil
                self?.started(status: status, signaled: signaled, output: output.tail())
            }
        }
        do {
            try process.run()
        } catch {
            starting = false
            failed(L("运行不了内置的 Node：", "Could not run the bundled Node: ") + error.localizedDescription + "\n\n" + node.path)
        }
    }

    private func started(status: Int32, signaled: Bool, output: String) {
        starting = false
        if status == 0 && !signaled {
            web.load(URLRequest(url: home))
            return
        }
        var text = output.isEmpty ? L("（launch.mjs 没有输出，退出代码 \(status)）", "(launch.mjs printed nothing; exit code \(status))") : output
        if signaled {
            // macOS stops a program it will not run (a broken signature, a blocked download) with SIGKILL.
            text = L("内置的 Node 被系统终止了（信号 \(status)）。", "The bundled Node was stopped by the system (signal \(status)).") + "\n\n" + text
        }
        failed(text)
    }

    private func failed(_ detail: String) {
        let title = L("CicaTavern 没能启动", "CicaTavern did not start")
        web.loadHTMLString(messagePage(title, detail), baseURL: nil)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: L("重试", "Try Again"))
        alert.addButton(withTitle: L("退出", "Quit"))
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertFirstButtonReturn {
                self?.start()
            } else {
                NSApp.terminate(nil)
            }
        }
    }

    // MARK: Menu actions (the menu items target this object)

    /// ⌘R: start the server again if it has stopped (launch.mjs returns at once when it runs), then the page.
    @objc func restartPage(_ sender: Any?) { start() }
    @objc func zoomPageIn(_ sender: Any?) { web.pageZoom = min(web.pageZoom + 0.1, 3) }
    @objc func zoomPageOut(_ sender: Any?) { web.pageZoom = max(web.pageZoom - 0.1, 0.5) }
    @objc func zoomPageReset(_ sender: Any?) { web.pageZoom = 1 }

    /// The app, Edit (so ⌘C, ⌘V, ⌘A and ⌘Z reach the page), View and Window menus.
    private func mainMenu() -> NSMenu {
        let bar = NSMenu()
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command, mine: Bool = false) -> NSMenuItem {
            let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
            entry.keyEquivalentModifierMask = modifiers
            if mine { entry.target = self }
            return entry
        }
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let menu = NSMenu(title: title)
            for entry in items { menu.addItem(entry) }
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            holder.submenu = menu
            bar.addItem(holder)
            return menu
        }
        _ = submenu("CicaTavern", [
            item(L("关于 CicaTavern", "About CicaTavern"), #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            NSMenuItem.separator(),
            item(L("隐藏 CicaTavern", "Hide CicaTavern"), #selector(NSApplication.hide(_:)), "h"),
            item(L("隐藏其他", "Hide Others"), #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item(L("全部显示", "Show All"), #selector(NSApplication.unhideAllApplications(_:))),
            NSMenuItem.separator(),
            item(L("退出 CicaTavern", "Quit CicaTavern"), #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = submenu(L("编辑", "Edit"), [
            item(L("撤销", "Undo"), Selector(("undo:")), "z"),
            item(L("重做", "Redo"), Selector(("redo:")), "z", [.command, .shift]),
            NSMenuItem.separator(),
            item(L("剪切", "Cut"), #selector(NSText.cut(_:)), "x"),
            item(L("拷贝", "Copy"), #selector(NSText.copy(_:)), "c"),
            item(L("粘贴", "Paste"), #selector(NSText.paste(_:)), "v"),
            item(L("粘贴并匹配样式", "Paste and Match Style"), #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            item(L("删除", "Delete"), #selector(NSText.delete(_:))),
            item(L("全选", "Select All"), #selector(NSText.selectAll(_:)), "a"),
        ])
        _ = submenu(L("显示", "View"), [
            item(L("重新载入", "Reload"), #selector(AppDelegate.restartPage(_:)), "r", mine: true),
            NSMenuItem.separator(),
            item(L("实际大小", "Actual Size"), #selector(AppDelegate.zoomPageReset(_:)), "0", mine: true),
            item(L("放大", "Zoom In"), #selector(AppDelegate.zoomPageIn(_:)), "=", mine: true),
            item(L("缩小", "Zoom Out"), #selector(AppDelegate.zoomPageOut(_:)), "-", mine: true),
            NSMenuItem.separator(),
            item(L("进入全屏幕", "Enter Full Screen"), #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        NSApp.windowsMenu = submenu(L("窗口", "Window"), [
            item(L("最小化", "Minimize"), #selector(NSWindow.performMiniaturize(_:)), "m"),
            item(L("缩放", "Zoom"), #selector(NSWindow.performZoom(_:))),
            NSMenuItem.separator(),
            item(L("关闭", "Close"), #selector(NSWindow.performClose(_:)), "w"),
        ])
        return bar
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
