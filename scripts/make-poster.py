#!/usr/bin/env python3
"""The creator's $TBB white paper poster as a site asset: AVIF + WebP + PNG at the poster's own size, no metadata.

Usage: python3 scripts/make-poster.py <poster.png>      (writes public/art/tbb-whitepaper.{avif,webp,png})
Never resized (the source is 567x847 and upscaling would soften the small type); quality is set high enough that the
twelve points stay readable. Every output is checked for EXIF / XMP / ICC / text chunks before it is kept.
"""
import os, sys
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'art')
MARKS = [b'Exif', b'EXIF', b'XMP', b'xpacket', b'c2pa', b'jumb', b'caBX', b'tEXt', b'iTXt', b'zTXt', b'eXIf', b'iCCP', b'IPTC', b'Photoshop', b'colrprof', b'colrrICC']  # an AVIF 'colr' box of type nclx is only a colour-space tag, not a profile

def main(src):
    im = Image.open(src).convert('RGB')
    for k in ('exif', 'icc_profile', 'xmp', 'dpi', 'comment'): im.info.pop(k, None)
    clean = Image.frombytes('RGB', im.size, im.tobytes())  # a fresh image: nothing from the source but pixels
    os.makedirs(OUT, exist_ok=True)
    # PNG: compress_level 9 without optimize=True (one deterministic stream for the checks below).
    plan = [('png', dict(compress_level=9)), ('webp', dict(quality=88, method=6, exif=b'', xmp=b'', icc_profile=None)), ('avif', dict(quality=72, speed=4))]
    for fmt, kw in plan:
        path = os.path.join(OUT, f'tbb-whitepaper.{fmt}')
        clean.save(path, fmt.upper(), **kw)
        data = open(path, 'rb').read()
        found = [m.decode() for m in MARKS if m in data]
        if found: print(f'{fmt}: metadata left behind {found}'); return 1
        print(f'{os.path.basename(path):22} {len(data) // 1024:4} KB  {clean.size[0]}x{clean.size[1]}')
    return 0

if len(sys.argv) < 2: print(__doc__); sys.exit(2)
sys.exit(main(sys.argv[1]))
