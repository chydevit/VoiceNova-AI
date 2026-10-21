#!/bin/bash
# Build "Khmer Voice AI.app" — a Mac app for THIS computer: it runs the backend from this
# project folder (backend/.venv), so set up the backend first (see the README).
#
#   ./build_mac_app.sh                     build into desktop/build/
#   ./build_mac_app.sh --install           …and copy it to /Applications
#   KEYS_FILE=~/path/keys.json ./build_mac_app.sh --install
#       optional: a JSON file of API keys ({"GEMINI_API_KEY": "…"}) the app reads at start-up
#       (only read, never copied; keys in backend/.env win).
#
# Needs the Xcode command-line tools (swiftc). Pillow (pip3 install pillow) makes the icon.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$HERE/build/Khmer Voice AI.app"
VERSION="1.0"

echo "→ Building the web app"
if [ -d "$ROOT/frontend/node_modules" ]; then
  (cd "$ROOT/frontend" && npm run build --silent)
elif [ ! -f "$ROOT/frontend/dist/index.html" ]; then
  echo "frontend/dist is missing: run 'npm install' in frontend/ first." >&2
  exit 1
fi
[ -x "$ROOT/backend/.venv/bin/python" ] || { echo "backend/.venv is missing: set up the backend first (README)." >&2; exit 1; }

echo "→ Compiling the Mac app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" \
  -framework AppKit -framework WebKit \
  "$HERE/KhmerVoiceAI.swift" -o "$APP/Contents/MacOS/KhmerVoiceAI"

echo "→ Making the icon"
if python3 -c "import PIL" 2>/dev/null; then
  TMP="$(mktemp -d)"
  python3 "$HERE/make_icon.py" "$TMP/icon.png"
  mkdir "$TMP/AppIcon.iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$TMP/icon.png" --out "$TMP/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$TMP/icon.png" --out "$TMP/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$TMP/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$TMP"
else
  echo "  (Pillow not found — the app gets the default icon. pip3 install pillow, then build again.)"
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
  <key>KVABackend</key><string>$(xml "$ROOT/backend")</string>
  <key>KVAKeysFile</key><string>$(xml "${KEYS_FILE:-}")</string>
</dict>
</plist>
PLIST

# Ad-hoc signature, so macOS runs it without complaints on this computer.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "✓ Built: $APP"

if [ "${1:-}" = "--install" ]; then
  DEST="/Applications"
  [ -w "$DEST" ] || DEST="$HOME/Applications"
  mkdir -p "$DEST"
  rm -rf "$DEST/Khmer Voice AI.app"
  cp -R "$APP" "$DEST/"
  touch "$DEST/Khmer Voice AI.app" # make Finder and the Dock pick up the icon
  echo "✓ Installed: $DEST/Khmer Voice AI.app"
fi
