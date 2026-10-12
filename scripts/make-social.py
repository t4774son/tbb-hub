#!/usr/bin/env python3
"""The share preview and the app icons, made from the summit art already in the repo. Needs Pillow only.

  public/img/og.jpg        1200x630 JPEG for Open Graph / X cards: the wide painting, a darker band at the foot and the
                           wordmark set in the site's own serif (read from public/fonts; the font files are not touched)
  public/img/icon-192.png  a square crop around the bull's head, for the web app manifest and home-screen pins
  public/img/icon-512.png

Nothing but pixels is written: no EXIF, XMP, ICC profile or text chunk (the privacy scan refuses image metadata).
Usage: python3 scripts/make-social.py
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
SRC = os.path.join(ROOT, 'img', 'summit-wide.jpg')
TITLE = 'The Bitcoin Bull'
SUB = '$TBB community dashboard · read-only · not financial advice'

def clean(im):
    im = im.convert('RGB'); im.info.clear(); return im

def font(path, size):
    try: return ImageFont.truetype(path, size)
    except Exception: return None

def og(im):
    w, h = im.size                      # 1280x720 → 1200x630 keeps 1280x672 of the painting
    ch = round(w * 630 / 1200); top = (h - ch) // 2
    out = im.crop((0, top, w, top + ch)).resize((1200, 630), Image.LANCZOS)
    band = Image.new('RGB', out.size, (0, 0, 0)); mask = Image.new('L', out.size, 0)
    d = ImageDraw.Draw(mask)
    for y in range(390, 630): d.line([(0, y), (1200, y)], fill=min(200, int((y - 390) / 240 * 230)))
    out = Image.composite(band, out, mask)
    d = ImageDraw.Draw(out)
    serif = font(os.path.join(ROOT, 'fonts', 'cormorant-italic.woff'), 110); mono = font(os.path.join(ROOT, 'fonts', 'jbmono.woff'), 30)
    if serif and mono:
        d.text((58, 452), TITLE, font=serif, fill=(224, 192, 138))
        d.text((62, 572), SUB, font=mono, fill=(240, 228, 204))
        made = 'with the wordmark'
    else:
        made = 'as a plain crop (no font could be read)'
    path = os.path.join(ROOT, 'img', 'og.jpg')
    out.save(path, 'JPEG', quality=82, optimize=True, progressive=True, exif=b'', icc_profile=None)  # no metadata, ever
    print(f'og.jpg {os.path.getsize(path) // 1024} KB 1200x630, {made}')

def icons(im):
    # the bull's head sits around x 800..1020, y 80..320 of the 1280x720 painting (see .bull-wide in app.css)
    box = (760, 50, 1060, 350)
    for size in (192, 512):
        out = im.crop(box).resize((size, size), Image.LANCZOS)
        path = os.path.join(ROOT, 'img', f'icon-{size}.png')
        out.save(path, 'PNG', optimize=True, exif=b'', icc_profile=None)  # no text, time or profile chunks
        print(f'icon-{size}.png {os.path.getsize(path) // 1024} KB')

def main():
    if not os.path.exists(SRC): print('missing', SRC); return 1
    im = clean(Image.open(SRC))
    og(im); icons(im)
    return 0

sys.exit(main())
