#!/usr/bin/env python3
"""Responsive copies of the summit art: AVIF + WebP at a few widths, no metadata. Needs Pillow with AVIF support.

Usage: python3 scripts/make-images.py        (reads public/img/summit-*.jpg, writes next to them)
"""
import os, sys
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'img')
PLAN = {  # source → widths (the source's own width is always kept)
    'summit-wide.jpg': [640, 960],
    'summit-tall.jpg': [480],
}

def save(im, path, fmt):
    kw = {'avif': dict(quality=50, speed=4), 'webp': dict(quality=78, method=6)}[fmt]
    im.save(path, fmt.upper(), exif=b'', xmp=b'', icc_profile=None, **kw) if fmt == 'webp' else im.save(path, fmt.upper(), **kw)
    print(f'{os.path.basename(path):26} {os.path.getsize(path) // 1024:4} KB  {im.size[0]}x{im.size[1]}')

def main():
    for src, widths in PLAN.items():
        p = os.path.join(ROOT, src)
        if not os.path.exists(p): print('missing', p); return 1
        im = Image.open(p).convert('RGB'); im.info.pop('exif', None); im.info.pop('icc_profile', None)
        stem = src.rsplit('.', 1)[0]
        for w in widths + [im.size[0]]:
            out = im if w == im.size[0] else im.resize((w, round(im.size[1] * w / im.size[0])), Image.LANCZOS)
            suffix = '' if w == im.size[0] else f'-{w}'
            for fmt in ('avif', 'webp'): save(out, os.path.join(ROOT, f'{stem}{suffix}.{fmt}'), fmt)
    return 0

sys.exit(main())
