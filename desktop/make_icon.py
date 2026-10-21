"""Draw the app icon (1024×1024 PNG): the app's gradient tile with the Khmer letter ក and a sound wave.
Usage: python3 make_icon.py out.png   (needs Pillow: pip install pillow)"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = 1024
TILE = 824  # Apple's icon grid: the tile is 824 px with transparent space around it
RADIUS = 186
TOP, BOTTOM = (99, 102, 241), (217, 70, 239)  # indigo-500 → fuchsia-500, as in the app's logo
FONTS = [
    "/System/Library/Fonts/Supplemental/NotoSansKhmer-VF.ttf",
    "/System/Library/Fonts/Supplemental/Khmer Sangam MN.ttf",
]


def gradient(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))  # diagonal, top-left → bottom-right
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
    return img


def font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONTS:
        if Path(path).exists():
            f = ImageFont.truetype(path, size)
            try:
                f.set_variation_by_name("Bold")
            except (OSError, ValueError, AttributeError):
                pass
            return f
    return ImageFont.load_default(size)


def main(out: str) -> None:
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    offset = (SIZE - TILE) // 2

    # soft shadow under the tile
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((offset, offset + 18, offset + TILE, offset + TILE + 18), RADIUS, fill=(20, 10, 60, 110))
    icon.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(22)))

    mask = Image.new("L", (TILE, TILE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, TILE - 1, TILE - 1), RADIUS, fill=255)
    tile = gradient(TILE).convert("RGBA")
    tile.putalpha(mask)
    # a light sheen on the top half
    sheen = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).ellipse((-TILE * 0.3, -TILE * 0.9, TILE * 1.3, TILE * 0.45), fill=(255, 255, 255, 34))
    sheen.putalpha(Image.composite(sheen.getchannel("A"), Image.new("L", (TILE, TILE), 0), mask))
    tile.alpha_composite(sheen)

    draw = ImageDraw.Draw(tile)
    # the Khmer letter ក, a little above the middle
    glyph = font(520)
    box = draw.textbbox((0, 0), "ក", font=glyph)
    w, h = box[2] - box[0], box[3] - box[1]
    draw.text(((TILE - w) / 2 - box[0], TILE * 0.40 - h / 2 - box[1]), "ក", font=glyph, fill=(255, 255, 255, 255))
    # a sound wave under it
    bars = [0.35, 0.6, 1.0, 0.75, 0.45, 0.85, 0.55, 0.3]
    bar_w, gap, max_h = 34, 26, 150
    total = len(bars) * bar_w + (len(bars) - 1) * gap
    x = (TILE - total) / 2
    mid = TILE * 0.78
    for b in bars:
        bh = max_h * b
        draw.rounded_rectangle((x, mid - bh / 2, x + bar_w, mid + bh / 2), bar_w / 2, fill=(255, 255, 255, 225))
        x += bar_w + gap

    icon.alpha_composite(tile, (offset, offset))
    icon.save(out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "icon.png")
