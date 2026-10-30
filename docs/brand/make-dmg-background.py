"""The DMG window's background (scripts/mac-build.sh dmg): drag CicaTavern into
Applications. The light palette of web/style.css, Noto Sans SC (SIL OFL).
Writes dmg-background.png (660x400) and dmg-background@2x.png next to this
file, for a notarized app; and dmg-background-not-notarized(@2x).png, which also
says how the first open goes on an app that is not notarized. The build joins
a pair into one HiDPI TIFF (tiffutil -cathidpicheck).

    python make-dmg-background.py <NotoSansSC variable font .ttf>
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 660, 400
SCALE = 2
# Where the build puts the two icons (their centres), matching mac-build.sh.
APP_X, APPS_X, ICON_Y = 170, 490, 196

BG = (236, 238, 234)       # --bg
SURFACE = (247, 248, 245)  # --surface
LINE = (211, 217, 212)     # --line
INK = (28, 36, 39)         # --ink
MUTED = (93, 106, 109)     # --muted
ACCENT = (43, 88, 105)     # --accent
LAMP = (142, 85, 18)       # --lamp

font_path = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))


def font(size, weight):
    f = ImageFont.truetype(font_path, size * SCALE)
    try:
        f.set_variation_by_axes([weight])
    except (OSError, AttributeError):
        pass
    return f


def centred(draw, y, text, f, fill):
    width = draw.textlength(text, font=f)
    draw.text(((W * SCALE - width) / 2, y * SCALE), text, font=f, fill=fill)


def background(not_notarized):
    img = Image.new('RGB', (W * SCALE, H * SCALE), BG)
    d = ImageDraw.Draw(img)
    s = SCALE

    centred(d, 30, '把 CicaTavern 拖进「应用程序」', font(21, 600), INK)
    centred(d, 62, 'Drag CicaTavern into Applications', font(12, 400), MUTED)

    # The arrow between the two icons.
    x0, x1, y = APP_X + 86, APPS_X - 86, ICON_Y
    d.line([(x0 * s, y * s), ((x1 - 4) * s, y * s)], fill=ACCENT, width=4 * s)
    d.polygon([((x1 + 6) * s, y * s), ((x1 - 12) * s, (y - 10) * s), ((x1 - 12) * s, (y + 10) * s)], fill=ACCENT)
    d.ellipse([((x0 - 4) * s, (y - 4) * s), ((x0 + 4) * s, (y + 4) * s)], fill=ACCENT)

    if not_notarized:
        # How the first open goes, in a panel at the bottom.
        top, bottom = 306, 378
        d.rounded_rectangle([(24 * s, top * s), ((W - 24) * s, bottom * s)], radius=12 * s, fill=SURFACE, outline=LINE, width=1 * s)
        label = font(12, 600)
        d.text((42 * s, (top + 13) * s), '第一次打开', font=label, fill=LAMP)
        body = font(12, 400)
        d.text((122 * s, (top + 13) * s), '弹窗里点「完成」，再到 系统设置 › 隐私与安全性 点「仍要打开」', font=body, fill=INK)
        d.text((42 * s, (top + 41) * s), 'First open: click Done, then System Settings › Privacy & Security › Open Anyway', font=font(11, 400), fill=MUTED)
    return img


for name, not_notarized in (('dmg-background', False), ('dmg-background-not-notarized', True)):
    img = background(not_notarized)
    img.save(os.path.join(here, f'{name}@2x.png'), optimize=True)
    img.resize((W, H), Image.LANCZOS).save(os.path.join(here, f'{name}.png'), optimize=True)
    print(f'wrote {name}.png and {name}@2x.png')
