import AppKit
import WebKit

final class ScribeAppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let urlString = ProcessInfo.processInfo.environment["SCRIBE_UI_URL"] ?? "http://127.0.0.1:47921/"
        let rect = NSRect(x: 0, y: 0, width: 1180, height: 780)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Scribe"
        window.titlebarAppearsTransparent = true
        window.center()

        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: rect, configuration: config)
        webView.autoresizingMask = [.width, .height]
        if let url = URL(string: urlString) {
            webView.load(URLRequest(url: url))
        }
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

if CommandLine.arguments.contains("--self-test") {
    print("scribe-macos-shell ok")
    exit(0)
}

let app = NSApplication.shared
let delegate = ScribeAppDelegate()
app.delegate = delegate
app.run()
