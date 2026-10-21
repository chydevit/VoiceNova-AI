// Khmer Voice AI — the Mac app.
//
// Starts the Python server (backend/main.py) in the background and shows the app in a native
// window (WebKit). Quitting the app stops the server. Built by desktop/build_mac_app.sh.
//
// Two ways to run:
//   project – Info.plist names a project folder (KVABackend): runs its backend/.venv (for development)
//   bundled – the app carries the backend itself (release builds). The first launch makes a Python
//             environment in ~/Library/Application Support/Khmer Voice AI, where projects and
//             settings (API keys) live too.
import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var spinner: NSProgressIndicator!
    private var status: NSTextField!
    private var logo: NSImageView! // shown only while starting
    private var server: Process?
    private var port = 8000
    private var quitting = false
    private var quitConfirmed = false
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var justSetUp = false

    private let info = Bundle.main.infoDictionary ?? [:]
    private let env = ProcessInfo.processInfo.environment
    private var base: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    /// The project folder's backend, when this build points at one that exists.
    private var projectBackend: URL? {
        guard let path = info["KVABackend"] as? String, !path.isEmpty,
              FileManager.default.fileExists(atPath: path + "/main.py") else { return nil }
        return URL(fileURLWithPath: path)
    }
    private var backend: URL { projectBackend ?? Bundle.main.resourceURL!.appendingPathComponent("backend") }
    /// Bundled mode keeps its Python environment, projects and settings here.
    private var support: URL {
        if let dir = env["KVA_SUPPORT_DIR"], !dir.isEmpty { return URL(fileURLWithPath: dir) } // for testing
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Khmer Voice AI")
    }
    private var python: URL {
        projectBackend.map { $0.appendingPathComponent(".venv/bin/python") } ?? support.appendingPathComponent("venv/bin/python")
    }
    private var dataFolder: URL { projectBackend.map { $0.appendingPathComponent("data/projects") } ?? support.appendingPathComponent("data/projects") }
    private let logURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/Khmer Voice AI/server.log")

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: - Window

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.setValue(true, forKey: "developerExtrasEnabled") // right-click → Inspect Element, for troubleshooting
        config.mediaTypesRequiringUserActionForPlayback = []
        config.applicationNameForUserAgent = "KhmerVoiceAI/1.0"

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground") // no white flash before the page paints
        webView.isHidden = true
        webView.translatesAutoresizingMaskIntoConstraints = false

        spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimation(nil)

        status = NSTextField(labelWithString: "Starting Khmer Voice AI…")
        status.alignment = .center
        status.textColor = .secondaryLabelColor
        status.font = .systemFont(ofSize: 13)
        status.lineBreakMode = .byWordWrapping
        status.maximumNumberOfLines = 0
        status.translatesAutoresizingMaskIntoConstraints = false

        logo = NSImageView(image: NSApp.applicationIconImage)
        logo.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        for view in [webView!, logo!, spinner!, status!] { content.addSubview(view) }
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            logo.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            logo.bottomAnchor.constraint(equalTo: spinner.topAnchor, constant: -18),
            logo.widthAnchor.constraint(equalToConstant: 112),
            logo.heightAnchor.constraint(equalToConstant: 112),
            spinner.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: content.centerYAnchor, constant: -16),
            status.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            status.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 14),
            status.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
        ])

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Khmer Voice AI"
        window.minSize = NSSize(width: 960, height: 640)
        window.contentView = content
        window.tabbingMode = .disallowed
        if !window.setFrameUsingName("KhmerVoiceAIMain") { window.center() }
        window.setFrameAutosaveName("KhmerVoiceAIMain") // reopens at the same size and place
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// KVA_SMOKE_TEST=1 (for CI): set up, start the server, check it answers, write smoke.json, quit.
    private var smoke: Bool { env["KVA_SMOKE_TEST"] == "1" }
    private var bundled: URL { Bundle.main.resourceURL! }

    private func show(_ message: String, busy: Bool) {
        if smoke && !busy {
            FileHandle.standardError.write(Data("SMOKE FAILED: \(message)\n".utf8))
            exit(1)
        }
        status.stringValue = message
        status.textColor = busy ? .secondaryLabelColor : .systemRed
        spinner.isHidden = !busy
        logo.isHidden = false
        webView.isHidden = true
    }

    // MARK: - Server

    private func startServer() {
        if let forced = env["KVA_PORT"].flatMap(Int.init) { // for testing: always start our own, on this port
            port = forced
            return prepareThenLaunch()
        }
        // A Khmer Voice AI server already running on 8000 (started by hand)? Use it.
        isOurServer(URL(string: "http://127.0.0.1:8000/api/health")!) { running in
            if running {
                self.port = 8000
                self.waitForServer(deadline: Date().addingTimeInterval(5))
            } else {
                self.port = Self.freePort(from: 8000)
                self.prepareThenLaunch()
            }
        }
    }

    private func prepareThenLaunch() {
        if projectBackend != nil || environmentIsReady() { return launchServer() }
        setUpEnvironment()
    }

    private func launchServer() {
        guard FileManager.default.isExecutableFile(atPath: python.path) else {
            show("The Python environment wasn't found at\n\(python.path)\n\nSet up the backend as the README explains, then build the app again.", busy: false)
            return
        }
        let process = Process()
        process.executableURL = python
        process.arguments = ["main.py"]
        process.currentDirectoryURL = backend
        var env = self.env
        env["PORT"] = String(port)
        env["HOST"] = "127.0.0.1"
        env["PYTHONUNBUFFERED"] = "1"
        env["EXIT_WITH_PARENT"] = "1" // if this app crashes or is force-quit, the server stops by itself
        // Apps opened from Finder get a minimal PATH; add Homebrew's so FFmpeg is found.
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        if let keys = info["KVAKeysFile"] as? String, !keys.isEmpty, env["KEYS_FILE"] == nil {
            env["KEYS_FILE"] = keys
        }
        let ffmpeg = bundled.appendingPathComponent("ffmpeg/ffmpeg")
        if FileManager.default.isExecutableFile(atPath: ffmpeg.path) { // a release may carry FFmpeg
            env["FFMPEG_PATH"] = ffmpeg.path
            env["FFPROBE_PATH"] = bundled.appendingPathComponent("ffmpeg/ffprobe").path
        }
        if projectBackend == nil { // bundled: everything the user makes lives in Application Support
            env["DATA_DIR"] = support.appendingPathComponent("data").path
            env["ENV_FILE"] = support.appendingPathComponent("settings.env").path
            env["PYTHONDONTWRITEBYTECODE"] = "1" // never write into the app bundle
        }
        process.environment = env

        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Start a fresh log each launch, but keep it when first-launch setup just wrote to it.
        if projectBackend != nil || !FileManager.default.fileExists(atPath: logURL.path) || environmentIsReady() && !justSetUp {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let log = try? FileHandle(forWritingTo: logURL) {
            log.seekToEndOfFile()
            log.write(Data("— Khmer Voice AI started \(Date()) on port \(port) —\n".utf8))
            process.standardOutput = log
            process.standardError = log
        }
        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, !self.quitting else { return }
                self.show("The Khmer Voice AI server stopped (code \(proc.terminationStatus)).\n\nDetails are in the server log: Help → Show Server Log.", busy: false)
            }
        }
        do {
            try process.run()
            server = process
            waitForServer(deadline: Date().addingTimeInterval(120)) // the first start can take a while
        } catch {
            show("Couldn't start the server: \(error.localizedDescription)", busy: false)
        }
    }

    // MARK: - First launch (bundled mode): a Python environment with the backend's packages

    private var requirements: URL { backend.appendingPathComponent("requirements.txt") }
    private var marker: URL { support.appendingPathComponent("venv/.installed-requirements") }

    /// Ready when the environment exists and was made for these exact requirements.
    private func environmentIsReady() -> Bool {
        FileManager.default.isExecutableFile(atPath: python.path)
            && (try? String(contentsOf: marker, encoding: .utf8)) == (try? String(contentsOf: requirements, encoding: .utf8))
    }

    /// The newest Python 3.10+ on this Mac (python.org, Homebrew or the Xcode tools).
    private func findPython() -> URL? {
        let candidates = ["3.14", "3.13", "3.12", "3.11", "3.10"].flatMap { v in
            ["/Library/Frameworks/Python.framework/Versions/\(v)/bin/python\(v)", "/opt/homebrew/bin/python\(v)", "/usr/local/bin/python\(v)"]
        } + ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            let check = Process()
            check.executableURL = URL(fileURLWithPath: path)
            check.arguments = ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"]
            check.standardOutput = FileHandle.nullDevice
            check.standardError = FileHandle.nullDevice
            if (try? check.run()) != nil {
                check.waitUntilExit()
                if check.terminationStatus == 0 { return URL(fileURLWithPath: path) }
            }
        }
        return nil
    }

    private func finishSmokeTest() {
        let health = (try? Data(contentsOf: base.appendingPathComponent("api/health"))) ?? Data()
        let page = (try? String(contentsOf: base, encoding: .utf8)) ?? ""
        try? health.write(to: support.appendingPathComponent("smoke.json"))
        let text = String(decoding: health, as: UTF8.self)
        let ok = text.contains("\"ffmpeg\":true") && page.contains("<div id=\"root\">")
        print("SMOKE health: \(text)")
        print("SMOKE \(ok ? "passed" : "FAILED")")
        quitConfirmed = true
        server?.terminate()
        exit(ok ? 0 : 2)
    }

    private func setUpEnvironment() {
        let uv = bundled.appendingPathComponent("uv")
        if FileManager.default.isExecutableFile(atPath: uv.path) { return setUpWithUV(uv) }
        guard let system = findPython() else {
            show("Khmer Voice AI needs Python 3.10 or newer.\n\nInstall it from python.org/downloads (or run: brew install python), then open Khmer Voice AI again.", busy: false)
            return
        }
        let venv = support.appendingPathComponent("venv")
        try? FileManager.default.removeItem(at: venv) // start clean (an old or half-made environment)
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let steps: [(String, URL, [String])] = [
            ("Preparing Python…", system, ["-m", "venv", venv.path]),
            ("Updating the installer…", venv.appendingPathComponent("bin/python"), ["-m", "pip", "install", "--upgrade", "pip"]),
            ("Installing Khmer Voice AI's components…", venv.appendingPathComponent("bin/python"), ["-m", "pip", "install", "-r", requirements.path]),
        ]
        run(steps[...]) { ok in
            if ok {
                try? FileManager.default.copyItem(at: self.requirements, to: self.marker)
                self.justSetUp = true
                self.launchServer()
            } else {
                self.show("Setting up didn't finish.\nCheck your internet connection, then open Khmer Voice AI again.\n\nDetails: Help → Show Server Log.", busy: false)
            }
        }
    }

    /// Release builds carry uv, which downloads its own Python: nothing has to be installed first.
    private func setUpWithUV(_ uv: URL) {
        let venv = support.appendingPathComponent("venv")
        try? FileManager.default.removeItem(at: venv)
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let steps: [(String, URL, [String])] = [
            ("Preparing Python…", uv, ["venv", venv.path, "--python", "3.12"]),
            ("Installing Khmer Voice AI's components…", uv, ["pip", "install", "--python", python.path, "-r", requirements.path]),
        ]
        uvEnvironment = [
            "UV_PYTHON_INSTALL_DIR": support.appendingPathComponent("python").path,
            "UV_PYTHON_PREFERENCE": "only-managed", // our own Python, whatever else is installed
        ]
        run(steps[...]) { ok in
            if ok {
                try? FileManager.default.copyItem(at: self.requirements, to: self.marker)
                self.justSetUp = true
                self.launchServer()
            } else {
                self.show("Setting up didn't finish.\nCheck your internet connection, then open Khmer Voice AI again.\n\nDetails: Help → Show Server Log.", busy: false)
            }
        }
    }

    private var uvEnvironment: [String: String] = [:]

    /// Run setup steps one after another, showing what's happening (the last line each step prints).
    private func run(_ steps: ArraySlice<(String, URL, [String])>, done: @escaping (Bool) -> Void) {
        guard let (title, executable, arguments) = steps.first else { return done(true) }
        let heading = "Setting up Khmer Voice AI — first launch only (a few minutes, about 400 MB to download)\n\n\(title)"
        show(heading, busy: true)
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        var env = self.env
        env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
        env.merge(uvEnvironment) { _, new in new }
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        process.environment = env
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        let log = try? FileHandle(forWritingTo: logURL)
        log?.seekToEndOfFile()
        log?.write(Data("— setup: \(title) —\n".utf8))
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            log?.write(data)
            let line = String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline).last.map(String.init) ?? ""
            let short = line.trimmingCharacters(in: .whitespaces).prefix(90)
            if !short.isEmpty { DispatchQueue.main.async { self.status.stringValue = "\(heading)\n\(short)" } }
        }
        process.terminationHandler = { proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                if proc.terminationStatus == 0 { self.run(steps.dropFirst(), done: done) } else { done(false) }
            }
        }
        do { try process.run() } catch { done(false) }
    }

    private func waitForServer(deadline: Date) {
        isOurServer(base.appendingPathComponent("api/health")) { ok in
            if ok && self.smoke {
                self.finishSmokeTest()
            } else if ok {
                self.status.stringValue = "Opening…"
                self.webView.load(URLRequest(url: self.base))
            } else if Date() > deadline {
                self.show("The server didn't start in time.\n\nDetails are in the server log: Help → Show Server Log.", busy: false)
            } else if let server = self.server, !server.isRunning {
                return // terminationHandler shows the error
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.waitForServer(deadline: deadline) }
            }
        }
    }

    /// Calls back (on the main thread) with true when a Khmer Voice AI server answers at `url`.
    private func isOurServer(_ url: URL, done: @escaping (Bool) -> Void) {
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
                && (try? JSONSerialization.jsonObject(with: data ?? Data()) as? [String: Any])?["tts"] != nil
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    private static func freePort(from start: Int) -> Int {
        for candidate in start..<(start + 50) where portIsFree(candidate) { return candidate }
        return start
    }

    private static func portIsFree(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var reuse: Int32 = 1 // like the server itself: a port that was just closed counts as free
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        return withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 }
        }
    }

    // MARK: - Quitting

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let server, server.isRunning, !quitConfirmed else { return .terminateNow }
        // Quitting stops the server: warn if a video is still being processed.
        var request = URLRequest(url: base.appendingPathComponent("api/projects"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let projects = ((try? JSONSerialization.jsonObject(with: data ?? Data()) as? [String: Any])?["projects"] as? [[String: Any]]) ?? []
            let busy = projects.filter { ["processing", "generating", "exporting"].contains($0["status"] as? String ?? "") }
                .compactMap { $0["name"] as? String }
            DispatchQueue.main.async {
                guard !busy.isEmpty else { return NSApp.reply(toApplicationShouldTerminate: true) }
                let alert = NSAlert()
                alert.messageText = "A video is still being processed"
                alert.informativeText = "\(busy.joined(separator: ", ")) will stop if you quit now. You can press “Try again” on it next time."
                alert.addButton(withTitle: "Keep Working")
                alert.addButton(withTitle: "Quit Anyway")
                let quit = alert.runModal() == .alertSecondButtonReturn
                self.quitConfirmed = quit
                NSApp.reply(toApplicationShouldTerminate: quit)
            }
        }.resume()
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        guard let server, server.isRunning else { return }
        server.terminate() // SIGTERM: the server shuts down cleanly
        let deadline = Date().addingTimeInterval(4)
        while server.isRunning && Date() < deadline { usleep(100_000) }
        if server.isRunning { kill(server.processIdentifier, SIGKILL) }
    }

    // MARK: - Web view

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        status.isHidden = true
        logo.isHidden = true // the page has its own logo
        webView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        show("Couldn't open the app: \(error.localizedDescription)", busy: false)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        // Links to other websites open in the normal browser.
        if let url = action.request.url, let host = url.host, !["127.0.0.1", "localhost"].contains(host) {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType {
            return decisionHandler(.download)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }

    // Downloads (exported videos, subtitles, audio) ask where to save, like any Mac app.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping @MainActor (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let url = panel.url else { return completionHandler(nil) }
            try? FileManager.default.removeItem(at: url) // the panel already asked about replacing it
            self.downloads[ObjectIdentifier(download)] = url
            completionHandler(url)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        let alert = NSAlert(error: error)
        alert.beginSheetModal(for: window)
    }

    // <input type="file"> (choosing a video to upload)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    // window.open / target=_blank: open in the normal browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    // MARK: - Menu

    private func buildMenu() {
        let main = NSMenu()
        let name = "Khmer Voice AI"

        let app = submenu(main, name)
        app.addItem(withTitle: "About \(name)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide \(name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let file = submenu(main, "File")
        item(file, "New Video", #selector(newVideo), "n")
        item(file, "My Projects", #selector(myProjects), "p", [.command, .shift])
        file.addItem(.separator())
        item(file, "Open in Browser", #selector(openInBrowser), "b", [.command, .option])
        item(file, "Show Projects Folder", #selector(showData), "")
        file.addItem(.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        // Undo/Redo go to text boxes; elsewhere the page handles ⌘Z / ⌘⇧Z itself (editor undo).
        let edit = submenu(main, "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let view = submenu(main, "View")
        item(view, "Reload", #selector(reload), "r")
        view.addItem(.separator())
        item(view, "Actual Size", #selector(zoomReset), "0")
        item(view, "Zoom In", #selector(zoomIn), "+")
        item(view, "Zoom Out", #selector(zoomOut), "-")
        view.addItem(.separator())
        let full = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]

        let windowMenu = submenu(main, "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        NSApp.windowsMenu = windowMenu

        let help = submenu(main, "Help")
        item(help, "Show Server Log", #selector(showLog), "")
        item(help, "Read the Guide (README)", #selector(openReadme), "")

        NSApp.mainMenu = main
    }

    private func submenu(_ main: NSMenu, _ title: String) -> NSMenu {
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let menu = NSMenu(title: title)
        holder.submenu = menu
        main.addItem(holder)
        return menu
    }

    @discardableResult
    private func item(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String, _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let entry = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
        entry.keyEquivalentModifierMask = mods
        entry.target = self
        return entry
    }

    private func go(_ hash: String) {
        window.makeKeyAndOrderFront(nil)
        webView.evaluateJavaScript("location.hash = '\(hash)'")
    }

    @objc private func newVideo() { go("#") }
    @objc private func myProjects() { go("#/projects") }
    @objc private func openInBrowser() { NSWorkspace.shared.open(base) }
    @objc private func showData() {
        try? FileManager.default.createDirectory(at: dataFolder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dataFolder)
    }
    @objc private func showLog() { NSWorkspace.shared.open(logURL) }
    @objc private func openReadme() {
        let local = backend.deletingLastPathComponent().appendingPathComponent("README.md")
        NSWorkspace.shared.open(FileManager.default.fileExists(atPath: local.path) ? local : URL(string: "https://github.com/chydevit/VoiceNova-AI#readme")!)
    }
    @objc private func reload() {
        if webView.isHidden { startServer() } else { webView.reload() }
    }
    @objc private func zoomReset() { webView.pageZoom = 1 }
    @objc private func zoomIn() { webView.pageZoom = min(2, webView.pageZoom + 0.1) }
    @objc private func zoomOut() { webView.pageZoom = max(0.6, webView.pageZoom - 0.1) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
