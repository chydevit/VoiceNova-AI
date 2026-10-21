#!/bin/bash
# Build the Linux downloads (x86_64): an AppImage and a .deb. Run on Linux (GitHub's ubuntu runner).
#   VERSION=1.2.0 ./linux/build_linux.sh          (frontend/dist must be built first)
# Writes build/linux/Khmer-Voice-AI-<version>-x86_64.AppImage and build/linux/khmer-voice-ai_<version>_amd64.deb.
# The app sets itself up on first launch with the bundled uv (which downloads Python), like the Mac and
# Windows apps; FFmpeg is bundled (BtbN static builds, GPL).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VERSION:-1.2.0}"
OUT="$ROOT/build/linux"
APPDIR="$OUT/AppDir"
rm -rf "$OUT" && mkdir -p "$APPDIR/frontend" "$APPDIR/ffmpeg"

echo "→ The app folder"
rsync -a --exclude .venv --exclude data --exclude __pycache__ --exclude '*.pyc' --exclude .env --exclude separate_work \
  "$ROOT/backend/" "$APPDIR/backend/"
cp -R "$ROOT/frontend/dist" "$APPDIR/frontend/dist"
cp "$ROOT/linux/launcher.py" "$ROOT/THIRD_PARTY_NOTICES.txt" "$APPDIR/"
python3 - "$ROOT/windows/Launcher/app-icon.png" "$APPDIR" <<'EOF'
import sys
from PIL import Image
icon = Image.open(sys.argv[1])
icon.resize((256, 256), Image.LANCZOS).save(f"{sys.argv[2]}/khmer-voice-ai.png")
icon.resize((256, 256), Image.LANCZOS).save(f"{sys.argv[2]}/logo.png")
EOF
cp "$APPDIR/khmer-voice-ai.png" "$APPDIR/.DirIcon"

echo "→ uv and FFmpeg"
curl -fsSL https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz | tar -xz -C "$OUT"
install -m 755 "$(find "$OUT" -type f -name uv | head -1)" "$APPDIR/uv"
curl -fsSL -o "$OUT/ffmpeg.tar.xz" https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz
tar -xJf "$OUT/ffmpeg.tar.xz" -C "$OUT"
install -m 755 "$(find "$OUT" -path '*bin/ffmpeg' -type f | head -1)" "$(find "$OUT" -path '*bin/ffprobe' -type f | head -1)" "$APPDIR/ffmpeg/"
for need in libx264 libmp3lame " aac "; do "$APPDIR/ffmpeg/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q -- "$need" || { echo "FFmpeg lacks $need" >&2; exit 1; }; done

cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
# Start Khmer Voice AI: uv runs the launcher with its own Python (downloaded on first use).
HERE="$(dirname "$(readlink -f "$0")")"
export APPDIR="${APPDIR:-$HERE}"
exec "$HERE/uv" run --quiet --no-project --python 3.12 "$HERE/launcher.py" "$@"
EOF
chmod 755 "$APPDIR/AppRun"

cat > "$APPDIR/khmer-voice-ai.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Khmer Voice AI
Comment=Give any video a Khmer voice
Exec=AppRun
Icon=khmer-voice-ai
Categories=AudioVideo;Video;
Terminal=false
X-AppImage-Version=$VERSION
EOF

echo "→ AppImage"
curl -fsSL -o "$OUT/appimagetool" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
chmod +x "$OUT/appimagetool"
ARCH=x86_64 "$OUT/appimagetool" --appimage-extract-and-run --no-appstream "$APPDIR" "$OUT/Khmer-Voice-AI-$VERSION-x86_64.AppImage"

echo "→ .deb"
PKG="$OUT/deb"
mkdir -p "$PKG/DEBIAN" "$PKG/opt" "$PKG/usr/bin" "$PKG/usr/share/applications" "$PKG/usr/share/icons/hicolor/256x256/apps"
cp -R "$APPDIR" "$PKG/opt/khmer-voice-ai"
ln -s /opt/khmer-voice-ai/AppRun "$PKG/usr/bin/khmer-voice-ai"
sed 's|^Exec=AppRun|Exec=/opt/khmer-voice-ai/AppRun|' "$APPDIR/khmer-voice-ai.desktop" > "$PKG/usr/share/applications/khmer-voice-ai.desktop"
cp "$APPDIR/khmer-voice-ai.png" "$PKG/usr/share/icons/hicolor/256x256/apps/"
cat > "$PKG/DEBIAN/control" <<EOF
Package: khmer-voice-ai
Version: $VERSION
Architecture: amd64
Maintainer: VoiceNova AI <https://github.com/chydevit/VoiceNova-AI>
Depends: xdg-utils, libx11-6
Recommends: chromium | google-chrome-stable | microsoft-edge-stable
Section: video
Priority: optional
Homepage: https://github.com/chydevit/VoiceNova-AI
Description: Give any video a Khmer voice
 Transcribes a video, translates it into natural spoken Khmer and voices it, timed to
 the original, with an editor to change anything. Sets itself up on first launch.
EOF
dpkg-deb --build --root-owner-group "$PKG" "$OUT/khmer-voice-ai_${VERSION}_amd64.deb"
ls -la "$OUT"/*.AppImage "$OUT"/*.deb
