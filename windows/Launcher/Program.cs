// Khmer Voice AI for Windows.
//
// A small launcher: on first launch it makes a Python environment with the bundled uv (which
// downloads Python itself) and installs the backend's packages; then it starts the server and
// opens the app in a Microsoft Edge app window (no tabs, its own taskbar icon). Closing that
// window stops the server — or, if a video is still being processed, waits for it.
//
// Folder layout (next to this .exe):   app\backend   app\frontend\dist   app\uv.exe   app\ffmpeg\
// Everything the user makes lives in %LOCALAPPDATA%\Khmer Voice AI.
//
//   "Khmer Voice AI.exe" --smoke-test   set up, start, check the server answers, stop (for CI)
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        var smoke = args.Contains("--smoke-test");
        using (var single = new Mutex(true, "KhmerVoiceAI-" + Environment.UserName, out var first))
        {
            if (!first && !smoke)
            {
                Launcher.OpenRunningInstance(); // already running: just show its window
                return 0;
            }
            var launcher = new Launcher(smoke);
            Application.Run(launcher);
            return launcher.ExitCode;
        }
    }
}

sealed class Launcher : Form
{
    public int ExitCode { get; private set; }

    static readonly string AppDir = Path.GetDirectoryName(Application.ExecutablePath);
    static readonly string Res = Path.Combine(AppDir, "app");
    static readonly string Backend = Path.Combine(Res, "backend");
    static readonly string Support = Environment.GetEnvironmentVariable("KVA_SUPPORT_DIR") is string d && d.Length > 0
        ? d : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Khmer Voice AI");
    static readonly string Venv = Path.Combine(Support, "venv");
    static readonly string Python = Path.Combine(Venv, "Scripts", "python.exe");
    static readonly string Marker = Path.Combine(Venv, ".installed-requirements");
    static readonly string Requirements = Path.Combine(Backend, "requirements.txt");
    static readonly string LogFile = Path.Combine(Support, "logs", "server.log");
    static readonly string PortFile = Path.Combine(Support, "server.port");
    static readonly object LogLock = new object();

    readonly bool smoke;
    readonly PictureBox logo = new PictureBox();
    readonly Label title = new Label();
    readonly Label detail = new Label();
    readonly ProgressBar bar = new ProgressBar();
    readonly Button primary = new Button();
    readonly Button secondary = new Button();
    Process server;
    Process browser;
    IntPtr job;
    int port;
    StreamWriter log;

    public Launcher(bool smoke)
    {
        this.smoke = smoke;
        Text = "Khmer Voice AI";
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        ClientSize = new Size(520, 190);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.White;
        Font = new Font("Segoe UI", 9.5f);

        logo.SetBounds(24, 24, 48, 48);
        logo.SizeMode = PictureBoxSizeMode.Zoom;
        try { logo.Image = Image.FromFile(Path.Combine(Res, "logo.png")); } catch { }
        title.SetBounds(88, 22, 408, 28);
        title.Font = new Font("Segoe UI Semibold", 12f);
        title.Text = "Starting Khmer Voice AI…";
        detail.SetBounds(88, 54, 408, 56);
        detail.ForeColor = Color.DimGray;
        bar.SetBounds(24, 116, 472, 10);
        bar.Style = ProgressBarStyle.Marquee;
        bar.MarqueeAnimationSpeed = 30;
        primary.SetBounds(356, 140, 140, 32);
        secondary.SetBounds(206, 140, 140, 32);
        primary.Visible = secondary.Visible = false;
        Controls.AddRange(new Control[] { logo, title, detail, bar, primary, secondary });
        if (smoke) { ShowInTaskbar = false; WindowState = FormWindowState.Minimized; }
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        new Thread(Start) { IsBackground = true }.Start();
    }

    // ---------- the steps ----------

    void Start()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogFile));
            log = new StreamWriter(LogFile, false, new UTF8Encoding(false)) { AutoFlush = true };
            log.WriteLine("— Khmer Voice AI started " + DateTime.Now + " —");
            if (!Ready()) SetUp();
            StartServer();
            if (smoke) { SmokeTest(); return; }
            OpenWindow();
        }
        catch (Exception ex)
        {
            Log("ERROR: " + ex);
            if (smoke) { ExitCode = 1; Ui(Close); return; }
            Ui(() => Fail(ex.Message));
        }
    }

    static bool Ready() =>
        File.Exists(Python) && File.Exists(Marker) && File.ReadAllText(Marker) == File.ReadAllText(Requirements);

    void SetUp()
    {
        Status("Setting up Khmer Voice AI — first launch only", "This downloads about 400 MB and takes a few minutes.");
        var uv = Path.Combine(Res, "uv.exe");
        if (!File.Exists(uv)) throw new Exception("The app is incomplete (app\\uv.exe is missing). Download it again.");
        if (Directory.Exists(Venv)) Directory.Delete(Venv, true); // start clean
        Directory.CreateDirectory(Support);
        var env = new System.Collections.Generic.Dictionary<string, string>
        {
            ["UV_PYTHON_INSTALL_DIR"] = Path.Combine(Support, "python"),
            ["UV_PYTHON_PREFERENCE"] = "only-managed", // our own Python, whatever else is installed
        };
        Run("Preparing Python…", uv, $"venv \"{Venv}\" --python 3.12", env);
        Run("Installing Khmer Voice AI's components…", uv, $"pip install --python \"{Python}\" -r \"{Requirements}\"", env);
        File.Copy(Requirements, Marker, true);
    }

    void StartServer()
    {
        Status("Starting Khmer Voice AI…", "");
        port = int.TryParse(Environment.GetEnvironmentVariable("KVA_PORT"), out var forced) ? forced : FreePort(8000);
        var info = new ProcessStartInfo(Python, "main.py")
        {
            WorkingDirectory = Backend,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        var env = info.EnvironmentVariables;
        env["PORT"] = port.ToString();
        env["HOST"] = "127.0.0.1";
        env["PYTHONUNBUFFERED"] = "1";
        env["PYTHONIOENCODING"] = "utf-8";
        env["PYTHONDONTWRITEBYTECODE"] = "1";
        env["EXIT_WITH_PARENT"] = "1";
        env["PARENT_PID"] = Process.GetCurrentProcess().Id.ToString();
        env["DATA_DIR"] = Path.Combine(Support, "data");
        env["ENV_FILE"] = Path.Combine(Support, "settings.env");
        var ffmpeg = Path.Combine(Res, "ffmpeg", "ffmpeg.exe");
        if (File.Exists(ffmpeg))
        {
            env["FFMPEG_PATH"] = ffmpeg;
            env["FFPROBE_PATH"] = Path.Combine(Res, "ffmpeg", "ffprobe.exe");
        }
        server = new Process { StartInfo = info, EnableRaisingEvents = true };
        server.OutputDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
        server.ErrorDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
        server.Start();
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
        job = Job.KillOnClose(server); // if this launcher dies, Windows stops the server too
        File.WriteAllText(PortFile, port.ToString());

        var deadline = DateTime.Now.AddMinutes(2);
        while (!Healthy(port))
        {
            if (server.HasExited) throw new Exception($"The server stopped (code {server.ExitCode}). Details are in {LogFile}");
            if (DateTime.Now > deadline) throw new Exception("The server didn't start in time. Details are in " + LogFile);
            Thread.Sleep(300);
        }
    }

    void SmokeTest()
    {
        var health = Get($"http://127.0.0.1:{port}/api/health");
        var settings = Get($"http://127.0.0.1:{port}/api/settings");
        var page = Get($"http://127.0.0.1:{port}/");
        File.WriteAllText(Path.Combine(Support, "smoke.json"), health);
        Log("SMOKE health: " + health);
        var ok = health.Contains("\"ffmpeg\":true") && settings.Contains("\"secrets\"") && page.Contains("<div id=\"root\">");
        Log("SMOKE " + (ok ? "passed" : "FAILED"));
        StopServer();
        ExitCode = ok ? 0 : 2;
        Ui(Close);
    }

    void OpenWindow()
    {
        var url = $"http://127.0.0.1:{port}/";
        var edge = FindEdge();
        if (edge == null)
        {
            Process.Start(url); // no Edge: use the default browser and keep this window as the "running" sign
            Ui(() => ShowRunning("Khmer Voice AI is open in your browser.", "Keep this window open while you work. Closing it stops Khmer Voice AI."));
            return;
        }
        browser = Process.Start(new ProcessStartInfo(edge, EdgeArgs(url)) { UseShellExecute = false });
        Ui(Hide);
        // When the app window closes, stop — unless a video is still being processed.
        var sawWindow = false;
        while (true)
        {
            Thread.Sleep(1500);
            browser.Refresh();
            var open = !browser.HasExited && browser.MainWindowHandle != IntPtr.Zero;
            sawWindow |= open;
            if (!open && (sawWindow || browser.HasExited)) break;
        }
        if (!browser.HasExited) { try { browser.Kill(); } catch { } } // Edge kept running in the background
        WaitForJobsThenQuit();
    }

    void WaitForJobsThenQuit()
    {
        while (true)
        {
            var busy = BusyProjects();
            if (busy.Length == 0) break;
            Ui(() => ShowRunning("Still processing " + string.Join(", ", busy), "Khmer Voice AI closes by itself when it's done.", waiting: true));
            Thread.Sleep(3000);
        }
        StopServer();
        Ui(Close);
    }

    // ---------- the window ----------

    void ShowRunning(string heading, string text, bool waiting = false)
    {
        title.Text = heading;
        detail.Text = text;
        bar.Visible = waiting;
        primary.Text = "Open the app";
        secondary.Text = waiting ? "Stop now" : "Quit";
        primary.Visible = secondary.Visible = true;
        primary.Click -= OnOpen; primary.Click += OnOpen;
        secondary.Click -= OnQuit; secondary.Click += OnQuit;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    void OnOpen(object sender, EventArgs e)
    {
        Hide();
        new Thread(OpenWindow) { IsBackground = true }.Start();
    }

    void OnQuit(object sender, EventArgs e)
    {
        StopServer();
        Close();
    }

    void Fail(string message)
    {
        bar.Visible = false;
        title.Text = "Khmer Voice AI couldn't start";
        detail.Text = message;
        primary.Text = "Show log";
        secondary.Text = "Close";
        primary.Visible = secondary.Visible = true;
        primary.Click += (s, e) => { try { Process.Start("notepad.exe", "\"" + LogFile + "\""); } catch { } };
        secondary.Click += (s, e) => Close();
        Show();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        StopServer();
        base.OnFormClosing(e);
    }

    void Status(string heading, string text) => Ui(() => { title.Text = heading; detail.Text = text; });

    void Ui(Action action)
    {
        if (IsDisposed) return;
        if (InvokeRequired) { try { BeginInvoke(action); } catch (ObjectDisposedException) { } }
        else action();
    }

    // ---------- helpers ----------

    void Run(string step, string exe, string args, System.Collections.Generic.Dictionary<string, string> env)
    {
        Status("Setting up Khmer Voice AI — first launch only", step);
        Log("— setup: " + step + " —");
        var info = new ProcessStartInfo(exe, args)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (var kv in env) info.EnvironmentVariables[kv.Key] = kv.Value;
        using (var p = new Process { StartInfo = info })
        {
            DataReceivedEventHandler show = (s, e) =>
            {
                if (string.IsNullOrWhiteSpace(e.Data)) return;
                Log(e.Data);
                var line = e.Data.Trim();
                Status("Setting up Khmer Voice AI — first launch only", step + "\n" + (line.Length > 80 ? line.Substring(0, 80) + "…" : line));
            };
            p.OutputDataReceived += show;
            p.ErrorDataReceived += show;
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            if (p.ExitCode != 0) throw new Exception("Setting up didn't finish. Check your internet connection and open Khmer Voice AI again.");
        }
    }

    void StopServer()
    {
        try { if (server != null && !server.HasExited) { server.Kill(); server.WaitForExit(4000); } } catch { }
        try { File.Delete(PortFile); } catch { }
        if (job != IntPtr.Zero) { Job.Close(job); job = IntPtr.Zero; }
    }

    void Log(string line)
    {
        try { lock (LogLock) log?.WriteLine(line); } catch { }
    }

    static string[] BusyProjects()
    {
        try
        {
            var json = Get($"http://127.0.0.1:{File.ReadAllText(PortFile).Trim()}/api/projects");
            // Minimal parsing: "name": "…", … "status": "processing|generating|exporting"
            return json.Split(new[] { "{\"id\"" }, StringSplitOptions.None)
                .Where(p => p.Contains("\"status\":\"processing\"") || p.Contains("\"status\":\"generating\"") || p.Contains("\"status\":\"exporting\""))
                .Select(p => { var i = p.IndexOf("\"name\":\""); return i < 0 ? "a video" : p.Substring(i + 8, Math.Max(0, p.IndexOf('"', i + 8) - i - 8)); })
                .ToArray();
        }
        catch { return new string[0]; }
    }

    static string Get(string url)
    {
        using (var web = new WebClient { Encoding = Encoding.UTF8 }) return web.DownloadString(url);
    }

    static bool Healthy(int port)
    {
        try { return Get($"http://127.0.0.1:{port}/api/health").Contains("\"tts\""); } catch { return false; }
    }

    static int FreePort(int start)
    {
        for (var p = start; p < start + 50; p++)
        {
            try { var l = new TcpListener(IPAddress.Loopback, p); l.Start(); l.Stop(); return p; } catch (SocketException) { }
        }
        return start;
    }

    static string FindEdge()
    {
        foreach (var root in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using (var key = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"))
            {
                if (key?.GetValue("") is string path && File.Exists(path)) return path;
            }
        }
        foreach (var dir in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) })
        {
            var path = Path.Combine(dir, "Microsoft", "Edge", "Application", "msedge.exe");
            if (File.Exists(path)) return path;
        }
        return null;
    }

    static string EdgeArgs(string url) =>
        $"--app={url} --user-data-dir=\"{Path.Combine(Support, "window")}\" --no-first-run --no-default-browser-check --window-size=1440,900";

    // A second launch opens another window on the server that is already running.
    public static void OpenRunningInstance()
    {
        try
        {
            var port = File.ReadAllText(PortFile).Trim();
            var edge = FindEdge();
            var url = $"http://127.0.0.1:{port}/";
            if (edge != null) Process.Start(new ProcessStartInfo(edge, EdgeArgs(url)) { UseShellExecute = false });
            else Process.Start(url);
        }
        catch { MessageBox.Show("Khmer Voice AI is already starting — give it a moment.", "Khmer Voice AI"); }
    }
}

// A Windows job object that ends the server (and anything it started) when the launcher exits.
static class Job
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong a, b, c, d, e, f; }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    public static IntPtr KillOnClose(Process process)
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        var limits = new ExtendedLimits { Basic = new BasicLimits { LimitFlags = 0x2000 } }; // KILL_ON_JOB_CLOSE
        var size = Marshal.SizeOf(typeof(ExtendedLimits));
        var ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, ptr, false);
            SetInformationJobObject(job, 9, ptr, (uint)size); // JobObjectExtendedLimitInformation
            AssignProcessToJobObject(job, process.Handle);
        }
        finally { Marshal.FreeHGlobal(ptr); }
        return job;
    }

    public static void Close(IntPtr job) => CloseHandle(job);
}
