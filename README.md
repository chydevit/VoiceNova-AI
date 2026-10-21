<p align="center"><img src="frontend/public/logo.svg" width="112" alt="Khmer Voice AI logo"></p>

# Khmer Voice AI · បញ្ចូលសំឡេងខ្មែរដោយ AI

Upload a video in any language and get it back with a **Khmer AI voiceover**, timed to the original speech.

1. **Extracting**: pulls the audio out of the video (FFmpeg)
2. **Transcribing**: speech → text with timestamps (Whisper)
3. **Translating**: into natural, spoken Khmer, not word-for-word (an LLM: Claude, Gemini or GPT)
4. **Review**: you check and fix every Khmer sentence
5. **Generating voice**: one Khmer voice clip per sentence, fitted into its time slot
6. **Merging**: mixes the voice with the background you chose and writes an MP4

You can then preview it, download the MP4, and download a Khmer `.srt` subtitle file. Subtitles can also be burned into the video.

## Download

**[⬇ Download the latest release](https://github.com/chydevit/VoiceNova-AI/releases/latest)**. Choose the file for your computer:

| Computer | File | How to install |
|---|---|---|
| **Mac with Apple silicon** (M1–M4) | `Khmer-Voice-AI-…-arm64.dmg` | Open it and drag **Khmer Voice AI** to **Applications** |
| **Mac with Intel** | `Khmer-Voice-AI-…-x64.dmg` | The same |
| **Windows 10 / 11** | `Khmer-Voice-AI-Setup-…-x64.exe` | Run it (no administrator needed). Or unzip `…-win-x64-portable.zip` and run **Khmer Voice AI.exe** |
| **Linux** (Ubuntu, Debian…) | `Khmer-Voice-AI-…-x86_64.AppImage` | Make it executable (`chmod +x`), then double-click it. Or install `khmer-voice-ai_…_amd64.deb`: `sudo apt install ./khmer-voice-ai_…_amd64.deb` |

The `.zip` files for Mac contain the same app as the `.dmg`.

**On the first launch:**
1. **The app sets itself up.** It downloads its own Python and components: about 400 MB, a few minutes, one time only. Nothing has to be installed first, except FFmpeg on a Mac (see below).
2. **Add your key:** click **⚙ Settings** and paste an AI key for translation. A [Google Gemini key](https://aistudio.google.com/apikey) is free to start with. Then drop in a video.

**Good to know:**
- **Mac:** the app isn't signed by Apple, so the first time **right-click it → Open → Open**. If macOS still refuses, go to System Settings → Privacy & Security → **Open Anyway**. The app also needs FFmpeg: install [Homebrew](https://brew.sh), then run `brew install ffmpeg`.
- **Windows:** SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**. The app opens in a Microsoft Edge app window.
- **Linux:** the app opens in Chrome, Chromium, Edge or Brave if you have one, or otherwise in your default browser.
- **Your projects and settings stay on your computer:**
  - Mac: `~/Library/Application Support/Khmer Voice AI`
  - Windows: `%LOCALAPPDATA%\Khmer Voice AI`
  - Linux: `~/.local/share/khmer-voice-ai`
- **Removing the original voice (keeping the music)** is an optional extra download of about 1 GB. On a Mac, run this, then reopen the app:
  ```bash
  ~/Library/"Application Support"/"Khmer Voice AI"/venv/bin/pip install torch torchaudio demucs
  ```

To change the code, run it from source as described below.

---

## What you need

| Tool | Why | Check it's installed |
|---|---|---|
| **FFmpeg** | reads, cuts and writes audio/video | `ffmpeg -version` |
| **Python 3.10 or newer** | runs the backend | `python3 --version` (Windows: `python --version`) |
| **Node.js 20 or newer** | builds the web page | `node --version` |
| **One translation API key** | Claude, Gemini (has a free tier) or OpenAI | — |

### Step 1: Install FFmpeg

- **Windows**: open *PowerShell* and run `winget install Gyan.FFmpeg`. Close and reopen PowerShell, then run `ffmpeg -version`.
  (No winget? Download the "release full" build from <https://www.gyan.dev/ffmpeg/builds/>, unzip it to `C:\ffmpeg`, and add `C:\ffmpeg\bin` to your *Path* environment variable.)
- **macOS**: install [Homebrew](https://brew.sh), then run `brew install ffmpeg`.
- **Ubuntu / Debian**: `sudo apt update && sudo apt install ffmpeg`

If `ffmpeg -version` prints a version number, you're done.

### Step 2: Install Python and Node.js

- Python: <https://www.python.org/downloads/>. On Windows, tick **"Add python.exe to PATH"** in the installer.
- Node.js: <https://nodejs.org> (the LTS version).

### Step 3: Get an API key for translation (pick one)

- **Google Gemini** (free tier): <https://aistudio.google.com/apikey>
- **Anthropic Claude**: <https://console.anthropic.com>
- **OpenAI**: <https://platform.openai.com/api-keys>

---

## Setup

Open a terminal in the `khmer-voice-ai` folder.

### Backend (Python)

```bash
cd backend
python3 -m venv .venv                 # Windows: python -m venv .venv
source .venv/bin/activate             # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                  # Windows: copy .env.example .env
```

Open `backend/.env` in a text editor and paste your key, for example:

```
GEMINI_API_KEY=your-key-here
```

Start the server:

```bash
python main.py
```

It runs at <http://127.0.0.1:8000>. Leave this terminal open.

> The first video takes longer: Whisper downloads its speech model (about 500 MB for `small`) on first use.

### Frontend (web page)

Open a **second** terminal in the `khmer-voice-ai` folder:

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173> in your browser.

**Optional: one server instead of two.** Run `npm run build` once in `frontend`. From then on, `python main.py` also serves the web page at <http://127.0.0.1:8000>, and you don't need `npm run dev`.

### Optional extras (large downloads, about 1–2 GB, PyTorch)

```bash
cd backend && source .venv/bin/activate
pip install -r requirements-extra.txt
```

This enables:
- the **"Remove the original voice"** background option (Demucs cuts out the original speech, keeps music & sounds)
- the **offline Meta MMS** Khmer voice (`TTS_PROVIDER=mms`)

---

## Mac app (optional)

You can run Khmer Voice AI as a normal Mac app: an icon in Applications and the Dock, its own window, and no terminal.

```bash
cd desktop
./build_mac_app.sh --install
```

This builds **Khmer Voice AI.app** and puts it in /Applications. It needs the Xcode command-line tools (`xcode-select --install`); Pillow (`pip3 install pillow`) is used for the icon.

- **The app uses this project folder.** It runs `backend/.venv` and the built web page, so set up the backend first, and keep the folder where it is. After changing the code, run the script again.
- **Opening the app starts the server**, and quitting stops it. If a video is still being processed, the app asks before quitting. If the app crashes, the server stops by itself too.
- **Downloads** open a normal "Save as…" dialog. You can also drag a video from Finder onto the window.
- **Menus:**
  - File: New Video (⌘N), My Projects (⇧⌘P), Open in Browser, Show Projects Folder.
  - View: Zoom (⌘+ / ⌘−) and Full Screen.
  - Help: Show Server Log. The log is at `~/Library/Logs/Khmer Voice AI/server.log`.
- **API keys** come from `backend/.env` as usual. If you already keep them in another JSON file, you can point the app at it instead; the file is only read and nothing is copied: `KEYS_FILE=/path/to/keys.json ./build_mac_app.sh --install`.
- **It's built for this computer.** To give it to someone else, they need the project and its setup too.

## Using it

1. Drag a video onto the page (MP4, MOV, MKV or WebM, up to 500 MB).
2. Watch the progress bar: **Extracting → Transcribing → Translating**.
3. Read the Khmer lines. Press ▶ on a line to hear the original at that point, and fix anything you like. Your edits save automatically.
4. Choose a **voice** (male or female), a **speed** (0.8×–1.3×), a **background** option and **subtitles**, then press **Generate Voice**.
5. When the voice is ready, the **editor** opens (below). Your first export is already there to download.

Projects stay in **My projects** until you delete them (set `PROJECT_TTL_HOURS` to remove old ones automatically).

## The editor: change anything after generating

Only what you change is generated again. Every other voice clip is reused.

- **Preview player:** plays the video with the Khmer clips live over it, so you hear an edit straight away, before exporting.
- **Timeline** (desktop): the video, the Khmer voice clips and the background waveform.
  - Drag a clip to move it, or drag its edges to change its time.
  - Double-click a gap to add a sentence there.
  - A red strip means the clip is longer than its time.
  - On a phone, the timeline is hidden; set times in the sentence list instead.
- **Each sentence:**
  - start/end time, the original text (gray) and the Khmer text
  - an optional separate subtitle (by default the subtitle follows the Khmer text)
  - voice, speed (0.8–1.3×) and volume (0–200%)
- **Buttons on each sentence:**
  - ▶ **Play:** plays just this sentence.
  - 🔄 **Regenerate:** makes the voice for this sentence only.
  - ✂ **Split:** splits at the Khmer word nearest your cursor in the text.
  - 🔗 **Merge:** joins it with the next sentence.
  - 🗑 **Delete:** leave silence there, or keep the original audio there.
- **⚠ Too long → Fix automatically:**
  1. uses the pause after the sentence,
  2. then speeds it up (at most 1.3×),
  3. then asks the AI for a shorter line.
- **✨ Improve translation:** three AI alternatives (more natural, shorter, more formal). Pick one and it's voiced right away.
- **Project settings:**
  - the background mode and background volume for the whole video
  - voice, speed or volume for all sentences at once
- **Subtitles** (under the preview video):
  - The preview shows the subtitles live, drawn exactly as they'll be burned into the video.
  - You can set text size, colour, black outline, dark box, top or bottom, and distance from the edge.
  - **Bilingual** adds the original line, smaller, under the Khmer one, in the video and in the `.srt`.
  - **Apply** saves the style; it's undoable. **Apply & export** also burns it into a new MP4 right away.
  - Only the subtitle strip is sent for burning in, not whole frames, so long videos stay light.
- **Cover the original subtitles** (Subtitles tab): if the video already has subtitles burned in (for example Chinese), the app can hide them under a **blur** or a **dark box**, so the Khmer subtitles don't sit on top of them.
  - **Find them automatically** compares frames taken while people talk with frames from the pauses. It takes a few seconds and also works for long videos.
  - Or drag and resize the area on the video, or use the sliders.
  - The cover goes into every exported video, under the Khmer subtitles. The video is re-encoded, so the export takes a little longer.
- **Undo / Redo:** the buttons, or **Ctrl+Z / Ctrl+Y** (⌘Z / ⌘⇧Z on Mac) outside text boxes. Space plays and pauses.
- **Export:** choose any of the following, and watch the progress.
  - MP4 with the Khmer voice
  - MP4 with burned-in subtitles
  - `.srt` subtitles
  - Khmer audio only (`.mp3` or `.wav`)

  Each export is saved as a **version** that you can download again. "Restore these edits" brings back that version's sentences; Undo brings your later edits back. The newest 5 exports keep their files (`KEEP_VERSIONS`).

### Background options

| Option | What you hear |
|---|---|
| Replace the original audio | Only the Khmer voice |
| Remove the original voice | Music and sound effects, with the original speech cut out (Demucs AI, optional extra — see below) |
| Keep original quietly | The original audio under the Khmer voice, at 15% by default (change it in the editor) |

### Removing the original voice

Pick **Remove the original voice** (on the review page, or in the editor under *Background audio*).
- **It runs in the background, so you can keep editing.** On a Mac with Apple silicon it uses the GPU; 13 minutes of video takes about 1½ minutes.
- **When it's done, the preview plays the music & sounds without the voice**, and the timeline's background track shows its waveform ("no voice").
- **It's made once per video** and reused by every export. *Background volume* sets how loud the music is.

It needs the optional extra: `pip install torch torchaudio demucs`, or the whole `requirements-extra.txt`. The first run downloads the Demucs model (about 80 MB). `DEMUCS_DEVICE` in `.env` can force `cpu`, `mps` or `cuda`.

### How the timing works

Each sentence has a time slot, from its **start** to its **end**. Its clip starts at the start; anything past the end is cut with a short fade. Sentences never overlap.

When you first press **Generate Voice**, every line is fitted automatically, the same way as "Fix automatically":
1. **Fits:** the clip is placed as is.
2. **Too long:** the slot grows into the pause after the sentence, if there is one.
3. **Still too long:** the clip is sped up with FFmpeg `atempo`, at most **1.3×** (pitch stays the same).
4. **Much too long:** the translator writes a shorter Khmer line, and it's voiced again (up to 2 tries). Shortened lines are marked.
5. **Last resort:** the end is cut, and the sentence shows ⚠ in the editor.

The counter under each line (for example `23/26 characters`) compares its length with what comfortably fits in its slot.

### Voice clips and the cache

The voice engine speaks each Khmer line once, at normal speed. Other speeds are made from that clip with `atempo`, so changing speed is instant and works offline. Clips live in `data/projects/<id>/clips/`. Each file is named by a hash of (voice engine, voice, speed, text), so identical lines are never generated twice, and Undo can bring back an old clip at once.

---

## Switching the Khmer voice (TTS provider)

Set `TTS_PROVIDER` in `backend/.env`, then restart `python main.py`.

| `TTS_PROVIDER` | Voices | Cost | Setup |
|---|---|---|---|
| `edge` *(default)* | Piseth ♂, Sreymom ♀ (Microsoft neural) | Free | Nothing, but needs internet |
| `azure` | Piseth ♂, Sreymom ♀ (same voices, official) | Paid, with a free tier | `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` from the Azure portal (Speech service) |
| `google` | Whatever km-KH voices Google offers | Paid, with a free tier | `GOOGLE_TTS_API_KEY`, with the Text-to-Speech API enabled |
| `mms` | One voice (Meta MMS-TTS, open source) | Free, works offline | `pip install -r requirements-extra.txt` |

Notes:
- **edge** uses the voice service behind Microsoft Edge's "Read aloud" feature. It's great for trying things out, but it's unofficial and has no uptime promise. For commercial work, use **azure**, which has the same voices.
- **google**: at the time of writing, Google's docs don't clearly list a Khmer voice. The app asks Google for km-KH voices when it starts voicing and tells you plainly if there are none.
- **mms** sounds more robotic and has a single voice, so the male/female choice is hidden.

**Adding your own provider:** create `backend/services/tts/myvoice.py` with a class that extends `TTSProvider` (see `base.py`). It needs a `synthesize(text, gender, speed, out)` method that writes an audio file and returns its path. Register it in `PROVIDERS` in `backend/services/tts/__init__.py`. The timing, mixing and subtitles work the same for every provider.

### Switching translation or speech-to-text

- `TRANSLATE_PROVIDER=auto` uses the first key it finds (Anthropic → Gemini → OpenAI). You can also set `anthropic`, `gemini` or `openai`, and choose the model with `ANTHROPIC_MODEL` / `GEMINI_MODEL` / `OPENAI_MODEL`.
- `TRANSCRIBE_PROVIDER=local` (free, runs on your computer) or `openai` (Whisper API, uses `OPENAI_API_KEY`). For better accuracy on a strong computer, set `WHISPER_MODEL=large-v3-turbo`.

---

## Project structure

```
khmer-voice-ai/
├── backend/
│   ├── main.py              app setup, errors, serves the built web page
│   ├── api_projects.py      upload, My Projects, generate, export, versions, media files
│   ├── api_editor.py        sentence edits, regenerate, split/merge/add/delete, fix, suggest, undo/redo
│   ├── config.py            settings from .env
│   ├── store.py             project folders, project.json, upgrade of old projects
│   ├── history.py           undo/redo snapshots and export versions
│   ├── sentences.py         the sentence record and the editing rules (no overlaps, split points…)
│   ├── jobs.py              background worker (one job at a time)
│   ├── pipeline.py          prepare · generate (all clips + export 1) · export (only changed clips)
│   └── services/
│       ├── media.py         FFmpeg helpers, thumbnail, filmstrip, waveform
│       ├── transcribe.py    Whisper (local or OpenAI)
│       ├── translate.py     Khmer translation, shorter lines, 3 suggestions · Claude / Gemini / OpenAI
│       ├── tts/             edge · azure · google · mms
│       ├── clips.py         voice-clip cache
│       ├── fit.py           "Fix automatically"
│       ├── voicetrack.py    places every clip (start, volume, cut at the end)
│       ├── separate.py      Demucs vocal removal
│       ├── subtitles.py     .srt and burned-in subtitles
│       └── merge.py         background mix, volume, "keep original" gaps, MP4
└── frontend/                React + Vite + Tailwind (Kantumruy Pro font)
    └── src/
        ├── App.jsx, api.js
        ├── lib/                     useEditor (state, autosave, undo), previewAudio, khmer, subtitleImages
        └── components/              upload, progress, review, My Projects
            └── editor/              EditorPage, Player, Timeline, SentenceRow, SuggestDialog, SettingsPanel, ExportPanel
```

### Data model

Each project is a folder in `backend/data/projects/<id>/`:

| File | What it holds |
|---|---|
| `project.json` | The project: status, video info, `settings` (voice, speed, background, background_volume), `original_gaps`, `sentences`, `versions` |
| `history.json` | Up to 40 undo/redo snapshots (typing in one field counts as one step) |
| `clips/*.wav` | Voice clips (see above) |
| `versions/vN/` | The files of export N, plus `snapshot.json` (its edits) |
| `source.*`, `thumb.jpg`, `filmstrip.jpg`, `waveform.json` | The upload, plus pictures and sound peaks for the editor |

A sentence looks like this:

```json
{
  "id": "s12", "start": 31.2, "end": 34.0,
  "original_text": "…", "khmer_text": "…", "subtitle_text": null,
  "voice": "female", "speed": 1.0, "volume": 1.0,
  "audio_file_path": "clips/3f9a….wav", "audio_key": "3f9a…", "audio_duration": 2.71,
  "status": "ok", "shortened": false, "error": null
}
```

`status` is one of:
- `ok`
- `too_long`: the clip is longer than its slot
- `edited`: the text, voice or speed changed, so it needs a new clip
- `regenerating`
- `failed`
- `empty`: no Khmer text yet

Projects made before the editor existed are upgraded automatically the first time they're opened. Their finished video becomes version 1.

### API

All under `/api/projects`. Errors come back as `{"error": {"message", "hint", "detail"}}`.

| Method & path | Does |
|---|---|
| `GET /` · `POST /` | My Projects · upload a video |
| `GET /{id}` · `DELETE /{id}` | the project with its sentences · delete it |
| `POST /{id}/generate` | first voice generation (from the review page) |
| `PATCH /{id}/sentences/{sid}` | edit text, subtitle, voice, speed, volume, start, end |
| `PATCH /{id}/sentences` | voice / speed / volume for all (or `ids`) |
| `POST /{id}/sentences/{sid}/regenerate` · `POST /{id}/sentences/regenerate` | voice one · every changed one |
| `POST /{id}/sentences/{sid}/split` · `/merge` · `/fix` · `/suggest` | split · merge with next · fix timing · 3 alternatives |
| `POST /{id}/sentences` · `DELETE /{id}/sentences/{sid}?fill=silence\|original` | add · delete |
| `PATCH /{id}/settings` | background mode and volume |
| `POST /{id}/undo` · `POST /{id}/redo` | undo / redo |
| `POST /{id}/export` | export `formats`: `mp4`, `mp4_subs`, `srt`, `audio` (+ `audio_format`) |
| `GET /{id}/versions/{n}/{kind}` · `POST /{id}/versions/{n}/restore` | download an export · restore its edits |

Burned-in subtitles are drawn by the browser, which shapes Khmer script correctly. FFmpeg then overlays them, so you don't need a special FFmpeg build or fonts on the server.

## Troubleshooting

| Problem | Fix |
|---|---|
| "FFmpeg is not installed" | Do Step 1, then **restart** the terminal and the server. |
| "No translation service is set up" | Put a key in `backend/.env` and restart `python main.py`. |
| "No speech was found" | The video has no talking, or it's very quiet or music only. |
| Stuck on Transcribing the first time | The Whisper model is downloading; give it a few minutes. |
| "Couldn't reach the Microsoft Edge voice service" | Check your internet, or switch `TTS_PROVIDER`. |
| A line sounds rushed | Shorten it in the editor (or use ✨ Improve translation → Shorter), then press 🔄. |
| "Your free Gemini quota … is used up for today" | Free Gemini keys have daily limits per model. It resets the next day. The app switches to `GEMINI_FALLBACK_MODEL` on its own; you can also use a paid key or another provider. |
| MKV preview doesn't play in the browser | Normal for some browsers. The final MP4 plays everywhere. |
