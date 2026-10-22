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
5. When the voice is ready, the **editor** opens (below): a timeline to cut, add, skip, write text and regenerate. Your first export is already there to download.

Projects stay in **My projects** until you delete them (set `PROJECT_TTL_HOURS` to remove old ones automatically).

## The editor: a video timeline

Edit the video freely after the Khmer voice is made: cut parts out, add clips, pictures, music and text, skip parts, and regenerate any voice. You see and hear every change at once; only the export renders the final video. Only what you change is voiced again.

On a computer the editor is one screen:
- **left:** the **Sentences** (every Khmer line) and the **Media** (your files);
- **middle:** the preview;
- **right:** **Clip** (the selected clip's settings), **Export**, **Subtitles** and **Audio**;
- **bottom:** the timeline.

On a phone the panels come one under another. A single strip under the preview scrolls past a fixed playhead, with **Split**, **Delete**, **Skip**, **Text** and **Regenerate** buttons.

**Nothing changes your files.** The project is a list of edits (see *Data model*), and the upload and every added file stay as they are. Projects made with earlier versions are upgraded the first time the app opens them; a copy of the old `project.json` is kept (`project.v2.json`, `project.v3.json`).

### The preview

- It plays the edits as the export will:
  - cuts and skipped parts are jumped over;
  - added clips, pictures and text show in their place;
  - the voice, the background and the music play at exactly the export's levels (volumes, volume lines, fades, lowering under the voice), and a change is heard while the slider still moves.
- It uses a small copy of each video (a *proxy*), made in the background the first time, so seeking and stepping frame by frame are instant. Until the copy is ready, it plays the original.
- **◀| |▶** step one frame, and **⏮ ⏭** jump to the previous or next sentence. The time reads `minutes:seconds.frame`.
- The frame has the export's shape (16:9, 9:16 or 1:1, under *Export*).

### The timeline

| Track | What's on it |
|---|---|
| **Video** | The video clips and pictures. Empty space is black in the export. |
| **Khmer voice** | One block per sentence. A red strip means its voice is longer than its time. |
| **Text** | Top row: each sentence's subtitle. Below it: the text you add. |
| **Watermark** | Your logos and text over everything (see *Watermarks*); ones shown at the same time get a row each. |
| **Background** | The video's own sound: the original audio, or the music without the voice. It moves with its video clip. |
| **Music & sound** | Music and sound effects you add, with volume, fades and a volume line. |

- **The playhead** is the red line: click or drag on the ruler to move it.
- **Zoom** with the slider, **−** / **+**, or **Ctrl+mouse wheel** (zooms around the mouse). **Fit** shows everything.
- **Snap** makes the playhead and dragged clips stick to clip edges. Otherwise they land on a whole frame.
- **Each track** can be locked 🔒 (no edit changes it) and hidden 👁 (video, text) or muted 🔈 (sound tracks), in the preview and the export. A sound track's name shows its volume (↓: lowered under the voice); click it for the Audio tab.
- **Selecting:** click a clip; Shift- or ⌘-click adds to the selection. Its settings open in **Clip** (start, end, duration, volume, speed, fades, text, voice). Right-click a clip for all its actions.

### Cutting, removing and skipping

- **✂ Split (S):** splits the selected clip at the playhead (or, with nothing selected, the video there). A sentence splits at the Khmer word nearest the playhead.
- **Delete:** a video clip asks how:
  - **Close the gap:** its time is removed from every unlocked track, and what follows moves up (Shift+Delete).
  - **Leave a gap:** black and silent there, and nothing else moves (Alt+Delete).

  Click an empty part of the video track, then press Delete to close that gap.
- **In / Out (I / O):** these mark a part, shaded on every track. Then choose:
  - **Remove:** taken out of every unlocked track; what follows moves up.
  - **Skip:** left out of the export, but kept on the timeline.
  - **Bring back:** undoes a skip.
  - **Volume:** one volume for that part of a track: choose Background, Khmer voice or Music & sound, type the percent and press **Set** (🔇 silences it, 100% brings it back). The background and music are split at In and Out; the sentences in the part all get it (a sentence is never cut).
- **⤼ Skip:** leaves the selected clips out of the export, and they stay on the timeline, hatched. Press it again to bring them back.
  - A skipped *video* clip takes everything during it out of the export: the voice, the text and the sound.
  - A skipped sentence, text or sound clip is just silent or hidden.
- **Trim:** drag a clip's edge. A video clip can't go past its neighbours or the ends of its file. Making it longer again brings its sound back.

**Edits that move what follows** move every *unlocked* track. That covers Close the gap, Remove, inserting a clip, Duplicate, Paste and changing a clip's speed. To keep music playing where it is while you cut the video, lock the **Music & sound** track.

### Volume

Every volume is a whole percent, from 0% to 200% (100% = as it is; above 100% is louder than the file).

- **Changing a volume:** drag the slider, type the number in its box, press **−** / **+** (1%; hold to keep going; Shift: 10%), or use the arrow keys on the slider or the box (1%; Shift: 10%). The value shows next to it, for example *Background: 37%*.
- **🔊 Mute** makes it silent and keeps the volume, so **Unmute** brings it back as it was.
- **Where:**
  - **Audio tab:** the **Background**, **Khmer voice** and **Music & sound** tracks, each as a whole.
  - **Clip tab:** the selected clip (a background part, a music clip or a sentence), with its **fade in** and **fade out** in 0.1 s steps.
  - **The Sentences list:** each sentence's own volume.
  - **In / Out:** one volume for that part of a track (see above).
- **How they add up:** a clip plays at its track's volume times its own. The Background track's volume is the upload's own sound (the original quietly, or the music without the voice); an added video's sound plays at its clip's volume, and a part that keeps the original voice plays at that part's volume.
- **Lower under the Khmer voice** (Audio tab, for the background and the music): the level while a sentence speaks (for example 30% normally, 5% under the voice) and how long it takes to go down and back up (0.1–2 s). It's already down when the voice starts. Pauses shorter than the two fades and a quarter of a second stay down, so it doesn't pump between sentences.
- **Volume lines** (〰 **Volume lines** above the timeline): every sound clip shows its volume over time, from 0% at the bottom of the clip to 200% at the top (100% dashed).
  - Click on a clip to add a point on its line, and keep the button down to drag it at once. Drag a point to change its time and volume; the value shows as it moves.
  - **↑ / ↓** on a point (Tab to it): 1% (Shift: 10%). Double-click a point, or press Delete, to remove it.
  - The Clip tab lists the points (type their values), adds one at the playhead, moves the whole line up or down, or removes it. A clip with a line follows the line instead of its volume.
  - The line belongs to the clip's sound: it moves, splits and trims with it.
- **Waveforms** on the timeline are drawn at the level the sound plays at, over a faint full-size copy, so you can see every change of volume. Above 100% they turn green.

### Watermarks

Put your logo (or a line of text, or a faint repeated logo) on the video: **Watermark** above the timeline, or the **Watermark** tab.

- **Logos:** upload a PNG (best with a transparent background), JPG, WebP or SVG, at most 10 MB; an SVG becomes a PNG in the browser. Each logo is kept in the **Brand Kit** too, for every project, unless you untick it.
  - **✂ Remove background** makes a plain (white or one-colour) background transparent; white inside the logo stays. *How close to the background colour* sets how much goes. It's done once and kept.
- **Position:** nine buttons (corners, edges, centre), or drag it on the preview (pause first): it snaps to the edges at its margin and to the middle, with guide lines.
  - **Margin from the edge** is in % of the picture's shorter side, in 1% steps, so it stays in the same place at any size.
  - **9:16 safe area:** on a 9:16 video a dashed box shows the part TikTok, Reels and Shorts leave clear; the watermark stays inside it unless you untick it.
  - **⚠ It covers the subtitles:** a note says so, with **Move it away**.
- **Size and look:** size in % of the picture's width (1% steps), 🔒 keep its shape (or unlock it and set the height), opacity 0–100% (70–80% looks like a watermark), rotation −180° to 180°.
  - **Effects:** drop shadow, glow, outline, all white or all black, rounded corners (50% makes a circle), *soft* (a lighter look).
- **Animation:** none, fade in and out, a gentle pulse, or **corner switch** (it moves round the four corners every few seconds, so it's harder to crop out).
- **When:** the whole video (it follows every cut), or only the In/Out part. On the Watermark track it can be trimmed, split (S), moved, duplicated or deleted like any clip. **Hide it during** ads (clips from the Ad Library), the intro (added clips before your video) or the outro (after it).
- **More than one:** a logo, a text watermark (Khmer or English; Kantumruy Pro, Noto Sans Khmer, Battambang or Moul; size, colour, bold) and a **tiled** logo (repeated faintly across the picture, with its spacing and angle) can be on at the same time.
- **Presets:** **Save as preset** keeps every watermark of the video (logos, place, size, opacity, animation). Then:
  - **Use on this video** in one click; **Apply to all projects** (each project can undo it); applying a preset again replaces what it put there before.
  - **The default preset** can be added to every new video (and new ads): choose it on the upload page, or *No watermark*. The ad wizard has a watermark choice too. Presets are also on the Brand Kit page.
- **Preview and export:** the preview draws each watermark exactly as the export will: the browser draws it at the exported size, and FFmpeg lays it over the picture with its timing and animation. At 16:9, 9:16 or 1:1 it keeps its place and size relative to the picture. The Export tab has **With watermark / Without**.

### Adding clips, sound and voice

- **Media tab:** add videos, pictures (PNG, JPG, WebP), music and sound effects (MP3, WAV, M4A, OGG, FLAC). Drop them on the list or on the timeline.
  - **+** puts a file at the playhead. A video or picture is inserted there (what follows moves later), and sound goes on the Music & sound track.
  - Drag a file from the list to the spot on the timeline you want.
  - An added video keeps its own sound, on the Background track.
- **+ Voice line:** type a new Khmer line, choose its voice and press **Generate**. It becomes a sentence like the others.
- **Duplicate (⌘D / Ctrl+D):** puts a copy right after the clip. A video clip's copy brings its sentences, text and sound.
- **Copy and paste (⌘C / ⌘V):** pastes at the playhead.
- **Rearrange:** drag a video clip.
  - Where there's room, it simply moves there.
  - Over other clips, a line shows where it will go in between them, and what's there moves later.
  - Its sentences, text and sound go with it. Text and sound clips can be dragged anywhere.
- **Speed (Clip tab):** 0.25× to 4×. The clip gets shorter or longer, and its sentences keep their place in the picture.

### Text and subtitles

- **+ Text (T):** adds text at the playhead, ready to type.
  - **Clip** tab: the font (Kantumruy Pro, Noto Sans Khmer, Battambang, Hanuman, Koulen, Moul), size, colour, outline, box, shadow, line width and alignment.
  - **Comes in / goes out:** fade, pop or slide.
- **Placing it:** drag text on the preview (pause first), or use the sliders. Drag its block on the timeline to change when it shows, and its edges to change for how long.
- **Subtitles:**
  - Double-click a subtitle on the preview or on the timeline to type it.
  - While a subtitle is **linked** (Clip tab), editing it changes the voice text too, which then needs voicing. Unlink it to give the subtitle its own text.
  - Drag a subtitle on the Text track to show it at its own time. It still moves with its sentence.

### Regenerating

**↻ Regenerate…** asks two things:

1. **Which sentences:** the selected ones, the In/Out part, **from the playhead to the end** ("recreate from here", also on the right-click menu), or the whole video.
2. **What to do:**
   - **voice them again**;
   - **translate them again** in a style: *natural*, *shorter*, *formal* or *casual*;
   - **change their voice**;
   - **fit them to their time.**

It runs in the background with its progress in the top bar, and you can keep editing. Undo brings back the old text.

After a cut, a trim or a move, sentences follow their video. If any no longer fits its time, a note says so, with **⚡ Fix all automatically**.

### Each sentence (the Sentences list)

- **Each sentence:**
  - start/end time, the original text (gray) and the Khmer text
  - an optional separate subtitle (by default the subtitle follows the Khmer text)
  - voice, speed (0.8–1.3×), and volume (0–200%, 1% steps) with mute
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
- **Audio tab:**
  - the background mode for the whole video
  - the volumes of the Background, Khmer voice and Music & sound tracks, and lowering the background and the music under the voice (see *Volume*)
  - voice, speed or volume for all sentences at once
- **Subtitles tab:**
  - The preview shows the subtitles live, drawn exactly as they'll be burned into the video.
  - You can set the font, size, colour, outline, box, position and distance from the edge; drag the subtitle on the preview to place it.
  - **Bilingual** adds the original line, smaller, under the Khmer one, in the video and in the `.srt`.
  - **Apply** saves the style; it's undoable. **Apply & export** also burns it into a new MP4 right away.
  - A **title** can sit at the top for the whole video.
- **Cover the original subtitles** (Subtitles tab): if the video already has subtitles burned in (for example Chinese), the app can hide them under a **blur** or a **dark box**, so the Khmer subtitles don't sit on top of them.
  - **Find them automatically** compares frames taken while people talk with frames from the pauses. It takes a few seconds and also works for long videos.
  - Or drag and resize the area on the video, or use the sliders.

### Keyboard

These keys work outside text boxes.

| Key | Does |
|---|---|
| Space | play / pause |
| ← / → | one frame back / forward (Shift: one second) |
| ↑ / ↓ | previous / next sentence |
| S | split at the playhead |
| Delete / Backspace | delete (Shift: close the gap, Alt: leave it) |
| I / O | set the In / Out point |
| T | add text |
| ⌘D / Ctrl+D | duplicate |
| ⌘C, ⌘V / Ctrl+C, Ctrl+V | copy, paste at the playhead |
| ⌘Z / Ctrl+Z, ⌘⇧Z / Ctrl+Y | undo, redo |
| Esc | clear the In/Out points, then the selection |

Undo has no fixed limit. Each step stores only what it changed, and only when a project's history passes 100 MB are its oldest steps dropped.

### Export

- **Picture:**
  - **shape:** original, 16:9 (YouTube), 9:16 (TikTok, Reels) or 1:1;
  - **size:** original, 720p or 1080p;
  - **a picture of another shape:** shown whole with black bars, or filling the frame;
  - **quality:** high, medium or small file.
- **Files:**
  - MP4 with the Khmer voice
  - MP4 with burned-in subtitles
  - `.srt` subtitles (times match the exported video)
  - Khmer audio only (`.mp3` or `.wav`)
- **What it renders:** every track, in full quality from the original files:
  - cuts and skipped parts left out;
  - added clips and pictures;
  - text with its animation;
  - the voice, background and music mixed at the preview's levels: each sound is multiplied by its volume envelope (its volumes, line, fades and lowering, a thousand values a second), and a mono sound plays on both sides at its full level, as in the browser.

  A video with no changes to its picture is copied as it is, so it exports fast.
- **Progress** comes straight from FFmpeg.
- **Versions:** each export is saved as a version you can download again. "Restore these edits" brings back that version's edits; Undo brings your later edits back. The newest 5 exports keep their files (`KEEP_VERSIONS`).

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


## Making ads (in progress)

**Ad Library** (header → Ad Library) keeps what every ad can reuse:
- **Files:** logos, product photos and clips, finished ad clips, pictures and music. Drop them in, rename them, change their kind, or delete them; a project that used one keeps its own copy.
- **Brand kits:** a logo, five colours, a title font and a text font (Kantumruy Pro, Noto Sans Khmer, Battambang, Hanuman, Koulen, Moul), contact details, a call to action and the "Sponsored" label (ផ្សាយពាណិជ្ជកម្ម). The default kit fills in every new ad.
- **Colours:** saved colours to pick from.

**New ad** (header → New ad) is a wizard that saves itself as you go:
1. **Product:** name, description, price, promotion, contact details and call to action (filled in from the brand kit).
2. **Pictures:** product photos and clips, in the order you like, from the Ad Library or uploaded (they're saved there too), and the logo.
3. **Style:** product showcase, sale, restaurant / food, shop intro, service or real estate, and a **look** (template): fonts, captions, how the shots move and change, the end screen and the music, in your brand colours.
4. **Format:** 9:16, 1:1 or 16:9; 15, 30 or 60 seconds; 720p or 1080p; the voice; the music mood (upbeat, calm, luxury, fun: press ▶ Listen) or your own music.
5. **Script:** the AI writes three scripts (friendly, energetic, professional) in natural spoken Khmer, sized to the length (about 11 characters a second): a hook in the first 3 seconds, the benefits, the price and offer, and a call to action with your contact details. Each one is checked before you see it (Khmer letters only, numbers written as words for the voice, the phone number said in its groups, short enough for the time); one that isn't right is sent back to the AI once. Pick one and change any shot, caption or picture. **Download script + captions (.txt)** gives the voiceover, the captions and a ready-to-post text.
6. **Build:** coming next. It puts the video together (Khmer voice, pictures with motion, captions, music that gets quieter under the voice, logo and end screen) and opens it in the timeline editor. Ads in existing videos (intro, mid-roll, outro and overlays), saving your own templates and exporting all three sizes at once come with it.

**Music** that comes with the app is made from code by `services/music.py` (8 pieces, 2 per mood): nobody else owns it, so there is nothing to license.

Where it's kept: `data/library/` (`library.json`, `assets/`, `thumbs/`, `templates/`), `data/adverts/<id>.json` (wizard drafts), `data/music/` (the built-in music, made the first time it's played). Built-in templates are `backend/ad_templates/*.json` (`adtemplates.py` checks them and places captions inside each format's safe area).

API: `GET /api/library` · `POST /api/library/assets` (multipart `file`, `kind`) · `PATCH|DELETE /api/library/assets/{id}` · `PUT /api/library/colors` · `POST /api/library/brands` · `PATCH|DELETE /api/library/brands/{id}` · `POST /api/library/brands/{id}/default` · `GET /api/library/music/{id}.m4a` · `GET|POST /api/adverts` · `GET|PATCH|DELETE /api/adverts/{id}` · `POST /api/adverts/{id}/scripts` · `POST /api/adverts/{id}/brand` · `GET /api/adverts/{id}/script.txt`.

Tests: `cd backend && .venv/bin/python -m unittest discover -s tests -t .`
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
│   ├── api_projects.py      upload, My Projects, generate, export, versions, media files, proxies
│   ├── api_editor.py        sentence edits, timeline edits, many sentences at once, settings, undo/redo
│   ├── config.py            settings from .env
│   ├── store.py             project folders, project.json, upgrade of old projects
│   ├── timeline.py          the edit list: tracks of clips, and every edit (split, trim, ripple, insert…)
│   ├── render.py            from the edit list to what the export draws and plays, in output time, and how loud
│   ├── watermarks.py        watermark settings, logos (background removal), presets, the default for new videos
│   ├── api_watermarks.py    logos, background removal, presets
│   ├── history.py           undo/redo steps (only what changed) and export versions
│   ├── sentences.py         the sentence (voice clip) record and its rules (no overlaps, split points…)
│   ├── jobs.py              background worker (one job at a time), side tasks, preview copies
│   ├── pipeline.py          prepare · generate · export · many sentences at once · preview copies
│   ├── tests/               python -m unittest discover -s tests -t .
│   └── services/
│       ├── media.py         FFmpeg helpers, probing, proxies, thumbnails, filmstrip, waveform
│       ├── transcribe.py    Whisper (local or OpenAI)
│       ├── translate.py     Khmer translation, shorter lines, suggestions, styles · Claude / Gemini / OpenAI
│       ├── tts/             edge · azure · google · mms
│       ├── clips.py         voice-clip cache
│       ├── fit.py           "Fix automatically"
│       ├── voicetrack.py    places every voice clip (start, volume or volume line, fades, cut at the end)
│       ├── separate.py      Demucs vocal removal
│       ├── subtitles.py     .srt and burned-in subtitles
│       └── merge.py         renders a plan with FFmpeg: picture, text, sound mix (volume envelopes), MP4
└── frontend/                React + Vite + Tailwind (Kantumruy Pro font) · npm test
    └── src/
        ├── App.jsx, api.js
        ├── lib/             timeline (the edit list and its volumes, as the backend), playback (the preview),
        │                    useEditor, previewAudio, peaks (voice waveforms), khmer, subtitleImages (drawn text),
        │                    watermark (placing, drawing and animating watermarks), watermarkApi
        └── components/      upload, progress, review, My Projects
            └── editor/      EditorPage, Player, ClipPanel, MediaBin, SentenceRow, RegenerateDialog,
                             VoiceLineDialog, SuggestDialog, ExportPanel, SubtitlePanel, SettingsPanel,
                             VolumeControl (a volume in 1% steps; seconds in 0.1 s steps), WatermarkPanel, WatermarkPresets…
                └── timeline/    Timeline, lanes, tools (split, delete, skip…), VolumeLines, ContextMenu, MobileTimeline
```

### Data model

Each project is a folder in `backend/data/projects/<id>/`:

| File | What it holds |
|---|---|
| `project.json` | The project: status, `video` (the upload), `media`, `timeline` (the edit list), `settings`, `versions` |
| `history/` | Undo/redo steps: `index.json` and one small file per step |
| `clips/*.wav` | Voice clips (see above) |
| `media/` | Files added in the editor (and their thumbnails and sound peaks) |
| `proxy/` | Small copies of the videos, for the preview |
| `versions/vN/` | The files of export N, plus `snapshot.json` (its edits) |
| `source.*`, `thumb.jpg`, `filmstrip.jpg`, `waveform.json` | The upload, plus pictures and sound peaks for the editor |

The **edit list** is six tracks of clips, always in this order:

```jsonc
{
  "media": {
    "source": { "kind": "video", "file": "source.mp4", "duration": 354.0, "width": 576, "height": 1022, "fps": 30, "audio": true, "proxy": "proxy/source.mp4" },
    "m2": { "kind": "audio", "file": "media/m2.mp3", "name": "music.mp3", "duration": 182.4 }
  },
  "timeline": { "tracks": [
    { "id": "video", "locked": false, "hidden": false, "muted": false, "clips": [
      { "id": "v1", "type": "video", "media": "source", "start": 0, "end": 40, "source_in": 0, "source_out": 40, "speed": 1, "skipped": false },
      { "id": "v3", "type": "image", "media": "m1", "start": 40, "end": 43, "skipped": false } ] },
    { "id": "voice", "volume": 100, "clips": [ { "id": "s1", "type": "voice", "start": 10.32, "end": 13.24, "khmer_text": "…", "subtitle_text": null,
      "subtitle_timing": null, "voice": "female", "speed": 1, "volume": 100, "muted": false, "audio_file_path": "clips/…", "status": "ok", "skipped": false, "…": "…" } ] },
    { "id": "text", "clips": [ { "id": "t1", "type": "text", "start": 0, "end": 4, "text": "ភាគ ១", "style": { "font": "Koulen", "size": 9, "color": "#fde047", "…": "…" },
      "x": 50, "y": 15, "animation": { "in": "pop", "out": "fade" }, "skipped": false } ] },
    { "id": "background", "volume": 30, "duck": { "on": true, "level": 5, "fade": 0.5 }, "clips": [ { "id": "b1", "type": "audio", "media": "source", "link": "v1",
      "start": 0, "end": 40, "source_in": 0, "source_out": 40, "volume": 100, "muted": false, "fade_in": 0, "fade_out": 0, "keep_voice": false, "skipped": false } ] },
    { "id": "audio", "volume": 100, "duck": { "on": false, "level": 10, "fade": 0.3 }, "clips": [ { "id": "a1", "type": "audio", "media": "m2", "start": 0, "end": 60,
      "source_in": 0, "source_out": 60, "volume": 50, "muted": false, "fade_in": 1, "fade_out": 3, "skipped": false,
      "keys": [ { "at": 20, "v": 50 }, { "at": 22.5, "v": 12 } ] } ] }
  ] },
  "…": "the watermark track comes after text: see below",
  "settings": { "…": "voice, background, subtitle_style, cover, title",
                "export": { "resolution": "original", "aspect": "original", "fit": "fit", "quality": "high" } }
}
```

- **Times:** `start` / `end` are seconds on the timeline (a clip lasts `end − start`). A media clip also has `source_in` / `source_out`, seconds in its file: `(out − in) = (end − start) × speed`.
- **Video clips** never overlap, and empty space is black.
- **Background pieces** are a video clip's own sound. Each is `link`ed to its video clip and always placed under it. A piece can be split to change the volume of part of it; `keep_voice` plays the original audio, with its voice, there (at the piece's volume).
- **Volumes** are whole percents, 0–200 (100 = as it is). Each sound track has one (`volume`), and so does each sound clip; they multiply. `muted` (track or clip) silences it and keeps the volume. `keys` is a clip's volume line, points `{at, v}`: `v` percent at `at` seconds of the clip's own sound (its file for media clips, from its start for a sentence); before the first point and after the last it stays level, and it takes the place of the clip's `volume`. `duck` on the background and music tracks lowers them while the Khmer voice speaks: to `level` percent, over `fade` seconds. The export turns percents into gains (1% = 0.01).
- **Voice clips** are the sentences, below. They never overlap.
- **Subtitles:** a sentence's subtitle is `subtitle_text`, or its Khmer text when that is `null`, shown during the sentence or at `subtitle_timing` (`{from, to}`, seconds after its start).
- **`skipped`:**
  - a skipped video clip's time is left out of the export, with everything during it;
  - any other skipped clip is just silent or hidden.

A sentence (a voice clip) looks like this:

```json
{
  "id": "s12", "type": "voice", "start": 31.2, "end": 34.0, "skipped": false,
  "original_text": "…", "khmer_text": "…", "subtitle_text": null, "subtitle_timing": null,
  "voice": "female", "speed": 1.0, "volume": 100, "muted": false,
  "audio_file_path": "clips/3f9a….wav", "audio_key": "3f9a…", "audio_duration": 2.71,
  "status": "ok", "shortened": false, "voice_warning": null, "error": null
}
```

`status` is one of:
- `ok`
- `too_long`: the clip is longer than its slot
- `edited`: the text, voice or speed changed, so it needs a new clip
- `regenerating`
- `failed`
- `empty`: no Khmer text yet

**Watermarks** are the clips of the `watermark` track (between `text` and `background`; `watermarks.py` describes them):

```jsonc
{ "id": "w1", "type": "watermark", "kind": "image",        // image | text | tiled
  "start": 0, "end": 354, "skipped": false, "whole": true,  // whole: it follows the video's length after every edit
  "media": "m4",                                            // the logo, copied into the project's media (image, tiled)
  "anchor": "bottom-right", "x": 50, "y": 50, "margin": 4,  // a position, or "free" with its middle at x %, y %; margin: % of the shorter side
  "width": 12, "height": null,                              // % of the picture's width; height % of its height, or null to keep the logo's shape
  "text": "", "font": "Kantumruy Pro", "size": 4, "color": "#ffffff", "bold": true,  // a text watermark
  "opacity": 75, "rotation": 0,
  "effects": { "shadow": false, "glow": false, "outline": false, "color": "original", "radius": 0, "soft": false },
  "animation": { "type": "none", "fade": 0.5, "period": 3, "every": 10 },  // none | fade | pulse | corners
  "tile": { "spacing": 30, "angle": -30 },
  "hide_during": [], "safe_area": true, "remove_bg": false, "preset": null }
```

Everything is in percent, so it fits any size. A watermark never makes the video longer. Presets and the default for new videos are in `DATA_DIR/library/watermarks.json`; logos are Brand Kit assets (`library/`), and each project keeps its own copy.

**Older projects** are upgraded automatically the first time the app opens them:
- Version 2 kept sentences in the upload's time, and cuts, background parts and "original audio" gaps as lists of times. They become clips: removed parts are skipped video clips, and background parts become pieces with their volume and fades.
- Version 5 added the watermark track (an empty one; nothing else changes, and undo goes on as before). The old file is kept as `project.v4.json`.
- Version 3 (the first edit list) kept volumes as fractions (1.0 = normal) and the background's level in the settings; version 4 keeps whole percents on every track and clip. The old file is kept as `project.v3.json` and its undo history as `history.v3/` (undo starts again from the upgrade).
- The old file is kept as `project.v2.json`, and the old undo history as `history.v2.json`.
- Projects made before the editor existed become version 1 of the new format first.

### API

All under `/api/projects`. Errors come back as `{"error": {"message", "hint", "detail"}}`.

| Method & path | Does |
|---|---|
| `GET /` · `POST /` | My Projects · upload a video |
| `GET /{id}` · `DELETE /{id}` | the project (the voice track's clips come as `sentences`) · delete it |
| `POST /{id}/generate` | first voice generation (from the review page) |
| `PATCH /{id}/sentences/{sid}` | edit text, subtitle, voice, speed, volume (a whole percent, 0–200), muted, start, end |
| `PATCH /{id}/sentences` | voice / speed / volume for all (or `ids`) |
| `POST /{id}/sentences/{sid}/regenerate` · `POST /{id}/sentences/regenerate` | voice one · every changed one |
| `POST /{id}/sentences/batch` | many at once, in the background: `kind` `voice` · `restyle` (+ `style`) · `fit`, for `ids` (or all) |
| `POST /{id}/sentences/{sid}/split` · `/merge` · `/fix` · `/suggest` | split · merge with next · fix timing · 3 alternatives |
| `POST /{id}/sentences` · `DELETE /{id}/sentences/{sid}?fill=silence\|original` | add (with `khmer_text`, `voice`) · delete |
| `POST /{id}/timeline/edit` | one timeline edit, `{"edit": {"op": …}}`: `split` · `trim` · `delete` (`ripple`) · `remove_range` · `skip_range` · `unskip_range` · `skip` · `close_gap` · `set` (clip settings: `volume`, `muted`, `keys`, `fade_in`, `fade_out`, `keep_voice`, text…) · `volume` (one volume for a part of a track: `track`, `start`, `end`, `volume`) · `background` (the same, on the background track) · `add_text` · `move` · `subtitle_timing` · `insert` (a media file) · `duplicate` · `paste` · `move_video` · `speed` · `add_watermark` (`fields`, and `start` / `end` for only a part) · `set_watermark` (`clip`, `fields`: any watermark setting, or `start` / `end`) |
| `PATCH /{id}/timeline/tracks/{track}` | lock, mute or hide a track; a sound track's `volume` (0–200); `duck` (`{on, level, fade}`, fade 0.1–2 s) on the background and music tracks |
| `POST /{id}/media` · `DELETE /{id}/media/{mid}` | add a file · remove it from the list |
| `POST /{id}/watermark-logo` (file, `save_to_kit`) · `POST /{id}/watermark-logo/from-kit` (`asset`) | a logo for watermarks: uploaded (also kept in the Brand Kit), or from the Brand Kit |
| `POST /{id}/media/{mid}/remove-background` (`tolerance`) · `GET /{id}/media/{mid}/nobg.png` | the logo without its plain background |
| `POST /{id}/watermarks/preset` (`preset`) | put a preset's watermarks on the video (replacing what that preset put there before) |
| `GET /api/watermarks` · `POST /api/watermarks/presets` (`name`, `project`) · `PATCH`/`DELETE /api/watermarks/presets/{wid}` | the presets · save a project's watermarks as one · rename, delete |
| `POST /api/watermarks/default` (`preset`, `auto`) · `POST /api/watermarks/presets/{wid}/apply-all` | the default for new videos · put a preset on every project |
| `GET /{id}/media/{mid}/file` · `/proxy.mp4` · `/poster.jpg` · `/waveform.json` | a media file, its preview copy, thumbnail and sound peaks |
| `PATCH /{id}/settings` | background (a new mode sets the background track to its usual volume; `background_volume` sets it), subtitle style, cover, title, `export` (picture) |
| `POST /{id}/undo` · `POST /{id}/redo` | undo / redo |
| `POST /{id}/export` | export `formats`: `mp4`, `mp4_subs`, `srt`, `audio` (+ `audio_format`); `watermark` (false: without), `watermark_images` (drawn by the browser) |
| `GET /{id}/versions/{n}/{kind}` · `POST /{id}/versions/{n}/restore` | download an export · restore its edits |

`POST /api/projects` (upload) also takes `watermark_preset`: empty for the default (when it's on), `none`, or a preset.

Burned-in subtitles, the title, the text and the watermarks are drawn by the browser, which shapes Khmer script correctly. FFmpeg then overlays them, so you don't need a special FFmpeg build or fonts on the server.

### Tests

- Backend, from the `backend` folder: `.venv/bin/python -m unittest discover -s tests -t .`
  These cover the edit list, the upgrade of old projects, undo, volumes, watermarks and the export. Some tests render short videos with FFmpeg and measure their frames and sound (1% levels, lowering under the voice and when it happens; a watermark's opacity, fade, pulse, corner switch and hiding during an intro, at 16:9 and 9:16).
- Frontend, from the `frontend` folder: `npm test`
  These check that the preview's maths match the export's: `backend/tests/fixtures/volume_parity.json` holds levels the backend worked out for projects with every kind of volume, and the browser's must be the same. After changing that maths (on both sides), write the file again: `UPDATE_FIXTURES=1 .venv/bin/python -m unittest tests.test_volume`. `watermark_parity.json` does the same for the watermarks' animation and hidden parts (`tests.test_watermarks`).

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
