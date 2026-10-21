#!/bin/bash
# Build "Khmer Voice AI.app".
#
#   ./build_mac_app.sh                     for THIS computer: runs the backend from this project
#                                          folder (backend/.venv) — set up the backend first (README)
#   ./build_mac_app.sh --install           …and copy it to /Applications
#   ./build_mac_app.sh --release           for anyone: the app carries the backend and the web page,
#                                          sets itself up on first launch, and is zipped for download
#                                          (desktop/build/Khmer-Voice-AI-<version>-<arm64|x64>.zip and .dmg)
#   ARCH=x86_64 ./build_mac_app.sh --release   the Intel version (on an Intel Mac, or cross-built)
#   KEYS_FILE=~/path/keys.json ./build_mac_app.sh --install
#       optional: a JSON file of API keys ({"GEMINI_API_KEY": "…"}) the app reads at start-up
#       (only read, never copied; keys in backend/.env win).
#
# Needs the Xcode command-line tools (swiftc).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$HERE/build/Khmer Voice AI.app"
VERSION="${VERSION:-1.0.0}"
MODE="${1:-}"
ARCH="${ARCH:-$(uname -m)}"                         # arm64 (Apple silicon) or x86_64 (Intel)
LABEL="$([ "$ARCH" = arm64 ] && echo arm64 || echo x64)"  # as in the download names

echo "→ Building the web app"
if [ -d "$ROOT/frontend/node_modules" ]; then
  (cd "$ROOT/frontend" && npm run build --silent)
elif [ ! -f "$ROOT/frontend/dist/index.html" ]; then
  echo "frontend/dist is missing: run 'npm install' in frontend/ first." >&2
  exit 1
fi
if [ "$MODE" != "--release" ]; then
  [ -x "$ROOT/backend/.venv/bin/python" ] || { echo "backend/.venv is missing: set up the backend first (README)." >&2; exit 1; }
fi

echo "→ Compiling the Mac app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 -target "$ARCH-apple-macos13.0" \
  -framework AppKit -framework WebKit \
  "$HERE/KhmerVoiceAI.swift" -o "$APP/Contents/MacOS/KhmerVoiceAI"

echo "→ Making the icon"   # from desktop/AppIcon.png — redraw it with make_icon.py after changing the logo
TMP="$(mktemp -d)"
mkdir "$TMP/AppIcon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$HERE/AppIcon.png" --out "$TMP/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$HERE/AppIcon.png" --out "$TMP/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$TMP"

if [ "$MODE" = "--release" ]; then
  echo "→ Bundling the backend and the web page"
  rsync -a --exclude '.venv' --exclude 'data' --exclude '__pycache__' --exclude '*.pyc' --exclude '.env' --exclude 'separate_work' \
    "$ROOT/backend/" "$APP/Contents/Resources/backend/"
  mkdir -p "$APP/Contents/Resources/frontend"
  cp -R "$ROOT/frontend/dist" "$APP/Contents/Resources/frontend/dist"
  cp "$ROOT/THIRD_PARTY_NOTICES.txt" "$APP/Contents/Resources/"
  # uv: installs Python and the packages on first launch, so users need nothing installed first.
  if [ -z "${UV_BIN:-}" ]; then
    UV_TMP="$(mktemp -d)"
    curl -fsSL "https://github.com/astral-sh/uv/releases/latest/download/uv-$(echo "$ARCH" | sed 's/arm64/aarch64/')-apple-darwin.tar.gz" | tar -xz -C "$UV_TMP"
    UV_BIN="$(find "$UV_TMP" -type f -name uv | head -1)"
  fi
  install -m 755 "$UV_BIN" "$APP/Contents/Resources/uv"
  # FFmpeg (optional): FFMPEG_DIR=<folder with ffmpeg and ffprobe>. Without it the app uses the Mac's own (brew install ffmpeg).
  if [ -n "${FFMPEG_DIR:-}" ] && [ -x "$FFMPEG_DIR/ffmpeg" ] && [ -x "$FFMPEG_DIR/ffprobe" ]; then
    mkdir -p "$APP/Contents/Resources/ffmpeg"
    install -m 755 "$FFMPEG_DIR/ffmpeg" "$FFMPEG_DIR/ffprobe" "$APP/Contents/Resources/ffmpeg/"
    echo "  (FFmpeg bundled)"
  fi
  BACKEND_PATH=""   # bundled: the app finds everything inside itself
  KEYS_PATH=""
else
  BACKEND_PATH="$ROOT/backend"
  KEYS_PATH="${KEYS_FILE:-}"
fi

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Khmer Voice AI</string>
  <key>CFBundleDisplayName</key><string>Khmer Voice AI</string>
  <key>CFBundleIdentifier</key><string>local.khmervoiceai.app</string>
  <key>CFBundleExecutable</key><string>KhmerVoiceAI</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.video</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Khmer Voice AI — runs on this computer.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>KVABackend</key><string>$(xml "$BACKEND_PATH")</string>
  <key>KVAKeysFile</key><string>$(xml "$KEYS_PATH")</string>
</dict>
</plist>
PLIST

# Ad-hoc signature, so macOS runs it without complaints on this computer.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "✓ Built: $APP"

if [ "$MODE" = "--release" ]; then
  ZIP="$HERE/build/Khmer-Voice-AI-$VERSION-$LABEL.zip"
  DMG="$HERE/build/Khmer-Voice-AI-$VERSION-$LABEL.dmg"
  rm -f "$ZIP" "$DMG"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
  # The .dmg opens a window with the app and a shortcut to Applications: drag one onto the other.
  STAGE="$(mktemp -d)"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -quiet -volname "Khmer Voice AI" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
  rm -rf "$STAGE"
  echo "✓ Release: $ZIP ($(du -h "$ZIP" | cut -f1)), $DMG ($(du -h "$DMG" | cut -f1))"
fi

if [ "$MODE" = "--install" ]; then
  DEST="/Applications"
  [ -w "$DEST" ] || DEST="$HOME/Applications"
  mkdir -p "$DEST"
  rm -rf "$DEST/Khmer Voice AI.app"
  cp -R "$APP" "$DEST/"
  touch "$DEST/Khmer Voice AI.app" # make Finder and the Dock pick up the icon
  echo "✓ Installed: $DEST/Khmer Voice AI.app"
fi
