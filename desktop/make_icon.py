"""Make every app icon from the one logo, frontend/public/logo.svg (macOS: uses Quick Look to draw it).

    python3 desktop/make_icon.py

writes (and these PNGs are committed, so builds don't need to draw anything):
    desktop/AppIcon.png                     Mac app icon: Apple's grid (824 px tile on 1024) with a soft shadow
    windows/Launcher/app-icon.png           Windows icon source: the full tile, rounded
    frontend/public/apple-touch-icon.png    iPhone / iPad home screen (square; iOS rounds it)
Needs Pillow (pip3 install pillow).
"""
import re
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "frontend/public/logo.svg"
SIZE = 1024
TILE = 824  # Apple's icon grid: the tile is 824 px with transparent space around it
CORNER = 0.23  # corner radius as a share of the tile (the logo's rx="23" on 100)


def render_square(size: int) -> Image.Image:
    """The logo drawn edge to edge (no rounded corners: those are cut here, smoothly)."""
    svg = re.sub(r'rx="[\d.]+"', 'rx="0"', LOGO.read_text("utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "logo.svg"
        src.write_text(svg, "utf-8")
        subprocess.run(["qlmanage", "-t", "-s", str(size), "-o", tmp, str(src)], check=True, capture_output=True)
        return Image.open(Path(tmp) / "logo.svg.png").convert("RGBA").resize((size, size), Image.LANCZOS)


def rounded(img: Image.Image) -> Image.Image:
    """Cut rounded corners, drawn 4× larger and scaled down so the edges are smooth."""
    size = img.width
    big = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(big).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), round(size * 4 * CORNER), fill=255)
    out = img.copy()
    out.putalpha(big.resize((size, size), Image.LANCZOS))
    return out


def mac_icon(tile: Image.Image) -> Image.Image:
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    offset = (SIZE - TILE) // 2
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((offset, offset + 16, offset + TILE, offset + TILE + 16), round(TILE * CORNER), fill=(30, 15, 70, 105))
    icon.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(22)))
    icon.alpha_composite(tile.resize((TILE, TILE), Image.LANCZOS), (offset, offset))
    return icon


def main() -> None:
    square = render_square(SIZE)
    tile = rounded(square)
    mac_icon(tile).save(ROOT / "desktop/AppIcon.png")
    tile.save(ROOT / "windows/Launcher/app-icon.png")
    square.convert("RGB").resize((180, 180), Image.LANCZOS).save(ROOT / "frontend/public/apple-touch-icon.png")
    print("Icons written: desktop/AppIcon.png, windows/Launcher/app-icon.png, frontend/public/apple-touch-icon.png")


if __name__ == "__main__":
    main()
