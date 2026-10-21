"""Khmer Voice AI for Linux.

Started by the AppImage / .deb through the bundled uv (`uv run --python 3.12 launcher.py`), so
Python itself is downloaded on first use. On first launch it makes a Python environment and
installs the backend's packages, showing a small window; then it starts the server and opens the
app in a Chrome / Chromium / Edge / Brave app window (or the default browser). Closing that window
stops the server — unless a video is still being processed, then it waits.

Folder layout (APPDIR):   backend/   frontend/dist/   uv   ffmpeg/ffmpeg   ffmpeg/ffprobe   logo.png
Everything the user makes lives in ~/.local/share/khmer-voice-ai (or $XDG_DATA_HOME).

    launcher.py --smoke-test     set up, start, check the server answers, stop (for CI; no window)
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

APPDIR = Path(os.environ.get("APPDIR") or Path(__file__).resolve().parent)
BACKEND = APPDIR / "backend"
SUPPORT = Path(os.environ.get("KVA_SUPPORT_DIR") or Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "khmer-voice-ai")
VENV = SUPPORT / "venv"
PYTHON = VENV / "bin" / "python"
MARKER = VENV / ".installed-requirements"
REQUIREMENTS = BACKEND / "requirements.txt"
LOG = SUPPORT / "logs" / "server.log"
SMOKE = "--smoke-test" in sys.argv
BROWSERS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser", "vivaldi"]


class Window:
    """A small Tk window for progress and messages (nothing at all in smoke-test mode)."""

    def __init__(self):
        self.root = None
        if SMOKE:
            return
        try:
            import tkinter as tk
            from tkinter import ttk
        except ImportError:
            return
        try:
            self.root = tk.Tk()
        except Exception:  # noqa: BLE001 - no display
            return
        self.tk = tk
        self.root.title("Khmer Voice AI")
        self.root.geometry("520x200")
        self.root.resizable(False, False)
        try:
            self.icon = tk.PhotoImage(file=str(APPDIR / "logo.png")).subsample(16, 16)
            self.root.iconphoto(True, tk.PhotoImage(file=str(APPDIR / "logo.png")))
            tk.Label(self.root, image=self.icon).place(x=24, y=24)
        except Exception:  # noqa: BLE001 - no icon is fine
            pass
        self.title = tk.Label(self.root, text="Starting Khmer Voice AI…", font=("Sans", 12, "bold"), anchor="w")
        self.title.place(x=96, y=24, width=400)
        self.detail = tk.Label(self.root, text="", fg="#555", anchor="nw", justify="left", wraplength=400)
        self.detail.place(x=96, y=56, width=400, height=60)
        self.bar = ttk.Progressbar(self.root, mode="indeterminate")
        self.bar.place(x=24, y=128, width=472)
        self.bar.start(12)
        self.button = None

    def status(self, title, detail=""):
        print(f"{title} {detail}".strip(), flush=True)
        if self.root:
            self.root.after(0, lambda: (self.title.config(text=title), self.detail.config(text=detail)))

    def message(self, title, detail, button=None, action=None):
        """Stop the progress bar and show a message, with an optional button."""
        print(f"{title}: {detail}", flush=True)
        if not self.root:
            return

        def show():
            self.bar.stop()
            self.bar.place_forget()
            self.title.config(text=title)
            self.detail.config(text=detail)
            if button and not self.button:
                self.button = self.tk.Button(self.root, text=button, command=action)
                self.button.place(x=356, y=150, width=140)
            self.root.deiconify()
        self.root.after(0, show)

    def hide(self):
        if self.root:
            self.root.after(0, self.root.withdraw)

    def close(self):
        if self.root:
            self.root.after(0, self.root.destroy)

    def run(self, work):
        """Run `work` in the background while the window stays responsive."""
        thread = threading.Thread(target=work, daemon=True)
        thread.start()
        if self.root:
            self.root.mainloop()
        thread.join()


window = Window()
log = None
server = None
exit_code = 0


def write_log(line: str) -> None:
    if log:
        log.write(line if line.endswith("\n") else line + "\n")
        log.flush()


def ready() -> bool:
    return PYTHON.exists() and MARKER.exists() and MARKER.read_text() == REQUIREMENTS.read_text()


def step(title: str, args: list[str], env: dict) -> None:
    window.status("Setting up Khmer Voice AI — first launch only", title)
    write_log(f"— setup: {title} —")
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env={**os.environ, **env})
    for line in proc.stdout:
        write_log(line)
        if line.strip():
            window.status("Setting up Khmer Voice AI — first launch only", f"{title}\n{line.strip()[:80]}")
    if proc.wait() != 0:
        raise RuntimeError("Setting up didn't finish. Check your internet connection and open Khmer Voice AI again.")


def set_up() -> None:
    uv = str(APPDIR / "uv")
    if VENV.exists():
        shutil.rmtree(VENV)
    SUPPORT.mkdir(parents=True, exist_ok=True)
    env = {"UV_PYTHON_INSTALL_DIR": str(SUPPORT / "python"), "UV_PYTHON_PREFERENCE": "only-managed"}
    step("Preparing Python…", [uv, "venv", str(VENV), "--python", "3.12"], env)
    step("Installing Khmer Voice AI's components…", [uv, "pip", "install", "--python", str(PYTHON), "-r", str(REQUIREMENTS)], env)
    shutil.copyfile(REQUIREMENTS, MARKER)


def free_port(start: int) -> int:
    for port in range(start, start + 50):
        with socket.socket() as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return start


def get(url: str, timeout: float = 2) -> str:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read().decode("utf-8")


def start_server() -> int:
    global server
    window.status("Starting Khmer Voice AI…")
    port = int(os.environ.get("KVA_PORT") or free_port(8000))
    env = {
        **os.environ, "PORT": str(port), "HOST": "127.0.0.1", "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1",
        "EXIT_WITH_PARENT": "1", "DATA_DIR": str(SUPPORT / "data"), "ENV_FILE": str(SUPPORT / "settings.env"),
    }
    if (APPDIR / "ffmpeg" / "ffmpeg").exists():
        env["FFMPEG_PATH"] = str(APPDIR / "ffmpeg" / "ffmpeg")
        env["FFPROBE_PATH"] = str(APPDIR / "ffmpeg" / "ffprobe")
    server = subprocess.Popen([str(PYTHON), "main.py"], cwd=BACKEND, env=env, stdout=log, stderr=subprocess.STDOUT)
    deadline = time.time() + 120
    while True:
        try:
            if '"tts"' in get(f"http://127.0.0.1:{port}/api/health"):
                return port
        except OSError:
            pass
        if server.poll() is not None:
            raise RuntimeError(f"The server stopped (code {server.returncode}). Details are in {LOG}")
        if time.time() > deadline:
            raise RuntimeError(f"The server didn't start in time. Details are in {LOG}")
        time.sleep(0.3)


def stop_server() -> None:
    if server and server.poll() is None:
        server.terminate()
        try:
            server.wait(5)
        except subprocess.TimeoutExpired:
            server.kill()


def busy(port: int) -> list[str]:
    try:
        projects = json.loads(get(f"http://127.0.0.1:{port}/api/projects"))["projects"]
        return [p["name"] for p in projects if p["status"] in ("processing", "generating", "exporting")]
    except (OSError, ValueError, KeyError):
        return []


def open_window(port: int) -> None:
    url = f"http://127.0.0.1:{port}/"
    browser = next((shutil.which(b) for b in BROWSERS if shutil.which(b)), None)
    if not browser:
        subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        window.message("Khmer Voice AI is open in your browser.", "Keep this window open while you work — closing it stops Khmer Voice AI.")
        return  # the Tk window is now the "running" sign; the main loop ends when it's closed
    window.hide()
    profile = SUPPORT / "window"
    app = subprocess.Popen([browser, f"--app={url}", f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check", "--window-size=1440,900"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    app.wait()  # a separate profile: the browser exits when the app window closes
    while names := busy(port):  # still processing: wait for it, then quit
        window.message("Still processing " + ", ".join(names), "Khmer Voice AI closes by itself when it's done.")
        time.sleep(3)
    window.close()


def main() -> None:
    global log, exit_code
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        log = LOG.open("w", encoding="utf-8")
        write_log(f"— Khmer Voice AI started {time.ctime()} —")
        if not ready():
            set_up()
        port = start_server()
        if SMOKE:
            health = get(f"http://127.0.0.1:{port}/api/health")
            page = get(f"http://127.0.0.1:{port}/")
            (SUPPORT / "smoke.json").write_text(health)
            ok = '"ffmpeg":true' in health and '<div id="root">' in page
            print("SMOKE health:", health, "\nSMOKE", "passed" if ok else "FAILED", flush=True)
            exit_code = 0 if ok else 2
            return
        open_window(port)
    except Exception as err:  # noqa: BLE001 - show it to the user
        write_log(f"ERROR: {err!r}")
        if SMOKE:
            print("SMOKE FAILED:", err, flush=True)
            exit_code = 1
            return
        window.message("Khmer Voice AI couldn't start", str(err), "Show log", lambda: subprocess.Popen(["xdg-open", str(LOG)]))


if __name__ == "__main__":
    try:
        window.run(main)
    finally:
        stop_server()
    sys.exit(exit_code)
