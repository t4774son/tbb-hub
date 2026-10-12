#!/usr/bin/env python3
"""The bull's head, rebuilt as a low-poly mesh so it can turn to the viewer.

Two poses per vertex: P0 = the profile as painted in the wide picture (wide pixel coordinates), P1 = a 3/4 view traced
from the painter's own 3/4 head in the tall picture, mirrored and scaled so it sits on the wide bull's neck. Every facet
has two colours as well: c0 is the wide painting under the profile facet, c1 is the tall painting under the 3/4 facet
(neck facets take c1 from the wide painting under their final position, so they run into the painted shoulders). The
page morphs points and colours together, so the first frame is the painting and the last frame is the painter's 3/4 head.

Writes the inline SVGs into public/index.html (between the bull markers) and the placement into public/css/app.css. Phones use the tall painting, whose bull already faces the viewer: there only the eyes
are drawn, plus a warm light layer that lifts the painted bull out of the page's vignette. Run after editing:
python3 scripts/make-bull.py"""
import json, os, re
from PIL import Image, ImageDraw, ImageFilter
APP = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
ROOT = os.path.join(APP, 'public', 'img') + os.sep
WIDE = Image.open(ROOT + 'summit-wide.jpg').convert('RGB'); TALL = Image.open(ROOT + 'summit-tall.jpg').convert('RGB')

# ---- the 3/4 head, traced in tall-picture coordinates (720x1280). The tall bull looks to the viewer's right; the wide bull
# faces left, so the head is mirrored: M() flips it and scales it 1.5x onto the wide bull's neck.
def M(x, y): return (880 - 1.62 * (x - 420), 157 + 1.62 * (y - 300))
T1 = {  # name: (tall xy)
 # left horn (viewer-left in the tall picture; after mirroring it is the back horn)
 'hl_tip': (396, 266), 'hl_o1': (386, 276), 'hl_o2': (383, 288), 'hl_o3': (388, 297), 'hl_i1': (397, 278), 'hl_i2': (395, 289),
 # right horn (the front horn after mirroring)
 'hr_tip': (455, 275), 'hr_o1': (460, 285), 'hr_o2': (457, 296), 'hr_o3': (450, 303), 'hr_i1': (449, 284), 'hr_i2': (446, 293),
 # skull
 'sk1': (404, 297), 'sk2': (412, 293), 'sk3': (421, 292), 'sk4': (430, 294), 'sk5': (438, 301), 'fh': (419, 302),
 # ears
 'eL_tip': (383, 308), 'eL_top': (395, 302), 'eL_bot': (397, 312), 'eR_tip': (447, 314), 'eR_top': (440, 308), 'eR_bot': (441, 316),
 # brow and eyes (L = the near eye once mirrored)
 'bL': (405, 306), 'eyeL': (415, 311), 'bC': (424, 305), 'eyeR': (432, 310), 'bR': (438, 308),
 # cheeks and the bridge of the nose
 'cL1': (402, 316), 'cL2': (406, 324), 'cL3': (412, 330), 'br1': (422, 314), 'br2': (426, 320), 'cR1': (439, 316), 'cR2': (443, 322),
 # muzzle
 'mzL': (418, 327), 'mzR': (440, 322), 'nos': (431, 326), 'tip': (447, 327), 'tipLo': (446, 333), 'chin': (432, 339), 'chinL': (422, 336), 'jaw': (413, 334),
 # neck, down into the shoulder
 'n1': (399, 330), 'n2': (398, 342), 'n3': (406, 350), 'n4': (420, 352), 'n5': (431, 345), 'nb1': (388, 318), 'nb2': (380, 334),
}
# ---- the same vertices on the painted profile (wide coordinates). Hidden-side features collapse behind the near side.
P0 = {
 'hl_tip': (889, 110), 'hl_o1': (897, 120), 'hl_o2': (905, 128), 'hl_o3': (912, 140), 'hl_i1': (893, 124), 'hl_i2': (899, 134),
 'hr_tip': (826, 126), 'hr_o1': (831, 135), 'hr_o2': (838, 143), 'hr_o3': (846, 150), 'hr_i1': (833, 130), 'hr_i2': (840, 138),
 'sk1': (902, 146), 'sk2': (890, 143), 'sk3': (877, 143), 'sk4': (864, 145), 'sk5': (852, 148), 'fh': (880, 152),
 'eL_tip': (934, 160), 'eL_top': (918, 152), 'eL_bot': (920, 162), 'eR_tip': (910, 156), 'eR_top': (906, 152), 'eR_bot': (908, 158),
 'bL': (866, 160), 'eyeL': (876, 164), 'bC': (858, 158), 'eyeR': (854, 160), 'bR': (850, 156),
 'cL1': (888, 176), 'cL2': (880, 186), 'cL3': (870, 196), 'br1': (850, 172), 'br2': (845, 180), 'cR1': (846, 168), 'cR2': (840, 178),
 'mzL': (848, 188), 'mzR': (835, 182), 'nos': (840, 194), 'tip': (831, 190), 'tipLo': (833, 200), 'chin': (842, 205), 'chinL': (852, 203), 'jaw': (862, 204),
 'n1': (900, 196), 'n2': (906, 214), 'n3': (900, 224), 'n4': (885, 222), 'n5': (870, 214), 'nb1': (924, 172), 'nb2': (930, 198),
}
# how far each vertex is from the head into the painted body (0 = the 3/4 head from the tall painting, 1 = the wide painting
# under the vertex's final position). A facet's 3/4 colour is the mix of the two by the mean of its vertices, so the throat
# runs from the lit face into the painted neck and shoulders with no row of dark facets at the join.
NECK_W = {'eL_bot': .1, 'cL1': .12, 'cL2': .22, 'cL3': .38, 'jaw': .45, 'chinL': .38, 'chin': .4, 'n1': .72, 'n5': .72, 'n2': 1, 'n3': 1, 'n4': 1, 'nb1': 1, 'nb2': 1}
T = [
 # horns (back, front)
 ('hl_tip', 'hl_o1', 'hl_i1'), ('hl_o1', 'hl_o2', 'hl_i1'), ('hl_i1', 'hl_o2', 'hl_i2'), ('hl_o2', 'hl_o3', 'hl_i2'), ('hl_i2', 'hl_o3', 'sk1'), ('hl_o3', 'eL_top', 'sk1'),
 ('hr_tip', 'hr_o1', 'hr_i1'), ('hr_o1', 'hr_o2', 'hr_i1'), ('hr_i1', 'hr_o2', 'hr_i2'), ('hr_o2', 'hr_o3', 'hr_i2'), ('hr_i2', 'hr_o3', 'sk5'), ('hr_o3', 'eR_top', 'sk5'),
 # skull and brow
 ('sk1', 'sk2', 'fh'), ('sk2', 'sk3', 'fh'), ('sk3', 'sk4', 'fh'), ('sk4', 'sk5', 'fh'),
 ('sk1', 'fh', 'bL'), ('fh', 'eyeL', 'bL'), ('fh', 'bC', 'eyeL'), ('fh', 'sk5', 'bC'), ('bC', 'sk5', 'bR'), ('bC', 'bR', 'eyeR'),
 # ears
 ('eL_tip', 'eL_top', 'eL_bot'), ('sk1', 'bL', 'eL_top'), ('eL_top', 'bL', 'eL_bot'), ('eL_bot', 'bL', 'cL1'),
 ('eR_tip', 'eR_top', 'eR_bot'), ('sk5', 'eR_top', 'bR'), ('eR_top', 'eR_bot', 'bR'), ('eR_bot', 'cR1', 'bR'),
 # cheeks and bridge
 ('bL', 'eyeL', 'cL1'), ('eyeL', 'cL2', 'cL1'), ('eyeL', 'br1', 'cL2'), ('eyeL', 'bC', 'br1'), ('bC', 'eyeR', 'br1'), ('eyeR', 'br2', 'br1'),
 ('eyeR', 'bR', 'cR1'), ('eyeR', 'cR1', 'br2'), ('cR1', 'cR2', 'br2'),
 ('br1', 'br2', 'mzL'), ('cL2', 'br1', 'mzL'), ('cL2', 'mzL', 'cL3'), ('br2', 'mzR', 'mzL'), ('br2', 'cR2', 'mzR'), ('cR2', 'tip', 'mzR'),
 # muzzle
 ('mzL', 'mzR', 'nos'), ('mzR', 'tip', 'nos'), ('nos', 'tip', 'tipLo'), ('nos', 'tipLo', 'chin'), ('mzL', 'nos', 'chinL'), ('nos', 'chin', 'chinL'), ('cL3', 'mzL', 'chinL'), ('cL3', 'chinL', 'jaw'),
 # jaw and neck (the neck runs into the painted shoulder)
 ('cL1', 'cL2', 'n1'), ('cL2', 'cL3', 'n1'), ('cL3', 'jaw', 'n1'), ('n1', 'jaw', 'n2'), ('jaw', 'n3', 'n2'), ('jaw', 'chinL', 'n3'), ('chinL', 'n4', 'n3'), ('chinL', 'chin', 'n4'), ('chin', 'n5', 'n4'),
 ('nb1', 'cL1', 'n1'), ('nb1', 'n1', 'nb2'), ('nb2', 'n1', 'n2'), ('eL_bot', 'nb1', 'cL1'),
]
P1 = {k: M(*v) for k, v in T1.items()}

# ---- colours: the mean of the painting under the facet, nudged like the page nudges the painting (contrast 1.05)
def adjust(c): return tuple(int(max(0, min(255, (v - 128) * 1.05 + 128))) for v in c)
def mean_under(im, pts, min_r=2.5):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    x0, y0, x1, y1 = int(min(xs)) - 1, int(min(ys)) - 1, int(max(xs)) + 2, int(max(ys)) + 2
    mask = Image.new('L', im.size, 0); ImageDraw.Draw(mask).polygon([(round(x), round(y)) for x, y in pts], fill=255)
    px = [im.getpixel((x, y)) for x in range(max(0, x0), min(im.size[0], x1)) for y in range(max(0, y0), min(im.size[1], y1)) if mask.getpixel((x, y))]
    if len(px) < 6:  # a sliver: sample a small disc around the centroid instead
        cx = sum(xs) / 3; cy = sum(ys) / 3
        px = [im.getpixel((int(cx) + i, int(cy) + j)) for i in range(-2, 3) for j in range(-2, 3)]
    return adjust(tuple(sum(p[k] for p in px) / len(px) for k in range(3)))
hexc = lambda c: '#%02x%02x%02x' % c
def mix(a, b, w): return tuple(int(round(a[i] * (1 - w) + b[i] * w)) for i in range(3))
tris = []
for a, b, c in T:
    c0 = mean_under(WIDE, [P0[a], P0[b], P0[c]])
    w = sum(NECK_W.get(v, 0) for v in (a, b, c)) / 3
    c1 = mix(mean_under(TALL, [T1[a], T1[b], T1[c]]), mean_under(WIDE, [P1[a], P1[b], P1[c]]), w) if w else mean_under(TALL, [T1[a], T1[b], T1[c]])
    tris.append(((a, b, c), c0, c1))

# ---- extras drawn over the mesh: the near nostril, the eye almonds (two poses each; the far eye collapses in profile)
def almond(cx, cy, w, h, tilt=0.0):
    import math
    pts = [(-w, 0), (-w * .45, -h), (w * .35, -h * .9), (w, 0), (w * .35, h * .85), (-w * .45, h)]
    ct, st = math.cos(tilt), math.sin(tilt)
    return [(cx + x * ct - y * st, cy + x * st + y * ct) for x, y in pts]
EXTRA = [  # name, fill, P0 polygon (wide), P1 polygon (wide)
 ('nose', '#2a0f07', almond(836.5, 193, 2.2, 1.6, 0.3), almond(*M(431.5, 326), 3.2, 2.1, 0.55)),
 ('noseFar', '#2a0f07', almond(835, 191, 0.6, 0.4), almond(*M(443.5, 324.5), 1.6, 1.0, 0.4)),
 ('eyeL', '#120402', almond(876, 164, 5, 2.4, -0.18), almond(*M(415, 311), 6.6, 3.0, 0.22)),
 ('eyeR', '#120402', almond(854, 160, 1.2, 0.8), almond(*M(432, 310), 4.4, 2.2, -0.1)),
 ('irisL', '#5a1208', almond(876, 164, 3.0, 1.5, -0.18), almond(*M(415, 311), 4.2, 1.9, 0.22)),
 ('irisR', '#4a0f07', almond(854, 160, 0.8, 0.5), almond(*M(432, 310), 2.8, 1.3, -0.1)),
]
EYES = [(M(415, 311), 1.0), (M(432, 310), 0.62)]  # centre, glow strength

# ---- the sky patch that hides the painted profile head: colours read from the sky around it, never on it
def sky_at(im, pts, samples, dim=0.9):
    cx = sum(p[0] for p in pts) / len(pts); cy = sum(p[1] for p in pts) / len(pts)
    acc = [0, 0, 0]; wsum = 0
    for (sx, sy) in samples:
        px = [im.getpixel((int(sx) + i, int(sy) + j)) for i in (-2, 0, 2) for j in (-2, 0, 2)]; c = [sum(q[k] for q in px) / 9 for k in range(3)]
        w = 1 / ((cx - sx) ** 2 + (cy - sy) ** 2 + 30) ** 1.4
        acc = [acc[i] + c[i] * w for i in range(3)]; wsum += w
    return hexc(tuple(int(max(0, min(255, ((a / wsum) * dim - 128) * 1.05 + 128))) for a in acc))
def fan(poly, c): return [(c, poly[i], poly[(i + 1) % len(poly)]) for i in range(len(poly))]
SKY_W = [(820, 100), (846, 100), (872, 118), (892, 98), (914, 116), (930, 140), (942, 152), (938, 172), (906, 184), (872, 226), (846, 228), (822, 212), (814, 186)]
SAMP_W = [(812, 104), (812, 140), (812, 176), (808, 206), (832, 92), (866, 92), (900, 90), (926, 100), (946, 112), (950, 140), (946, 166), (812, 232), (806, 220)]
sky_w = [(t, sky_at(WIDE, t, SAMP_W, dim=0.95)) for t in fan(SKY_W, (872, 156))]

P = lambda pts: ' '.join(f'{x:.1f},{y:.1f}' for x, y in pts)
# the eyes: an ember, not a sticker. A wide soft glow (its gradient fades early) and a small, slightly blurred (CSS) hot centre.
def glow(cx, cy, k):
    return (f'<ellipse class="bh-glow" cx="{cx:.1f}" cy="{cy:.1f}" rx="{15 * k:.1f}" ry="{9.5 * k:.1f}" fill="url(#eyeGlow)" opacity="{0.78 * k:.2f}"/>'
            f'<ellipse class="bh-eye" cx="{cx:.1f}" cy="{cy:.1f}" rx="{2.7 * k:.1f}" ry="{1.45 * k:.1f}" fill="#ff5a30" opacity="{1 if k >= 1 else 0.95 * k:.2f}"/>')
GLOW = '<radialGradient id="eyeGlow"><stop offset="0" stop-color="#ff6a3a" stop-opacity=".72"/><stop offset=".3" stop-color="#e8220e" stop-opacity=".4"/><stop offset=".7" stop-color="#c01008" stop-opacity=".08"/><stop offset="1" stop-color="#c01008" stop-opacity="0"/></radialGradient>'
# the join: a luminance mask fades the last few pixels of the neck facets into the painting along the throat and the back of
# the neck (a blurred dark band just outside the 3/4 edge; those facets already carry the painting's own colours)
BAND = [(927, 190), (939, 212), (913, 223), (901, 235), (880, 238), (864, 228), (852, 236), (846, 262), (900, 272), (975, 250), (984, 206), (962, 176)]
NECK_MASK = (f'<filter id="neckBlur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>'
             f'<mask id="neckFade" maskUnits="userSpaceOnUse" x="800" y="80" width="220" height="240"><rect x="800" y="80" width="220" height="240" fill="#fff"/>'
             f'<polygon fill="#000" filter="url(#neckBlur)" points="{" ".join(f"{x},{y}" for x, y in BAND)}"/></mask>')
DEFS = '<defs>' + GLOW + NECK_MASK + '</defs>'
head = ['<g class="bh-sky">' + ''.join(f'<polygon fill="{c}" points="{P(t)}"/>' for t, c in sky_w) + '</g>', '<g class="bh-head" mask="url(#neckFade)">']
for k, ((a, b, c), c0, c1) in enumerate(tris): head.append(f'<polygon data-k="{k}" fill="{hexc(c1)}" points="{P([P1[a], P1[b], P1[c]])}"/>')
for n, col, p0, p1 in EXTRA: head.append(f'<polygon data-x="{n}" fill="{col}" points="{P(p1)}"/>')
head.append('<g class="bh-eyes">' + ''.join(glow(x, y, k) for (x, y), k in EYES) + '</g></g>')
svg_wide = f'<svg class="bull-head bull-wide" viewBox="800 80 220 240" aria-hidden="true" focusable="false">\n{DEFS}\n' + '\n'.join(head) + '\n</svg>'
# phones: the tall painting's bull already faces the viewer; only its eyes light up (viewBox = the head, in tall pixels)
TB = (380, 260, 100, 100)
# (its gradient gets its own id: two inline SVGs on one page share the document's id space)
svg_tall = (f'<svg class="bull-head bull-tall" viewBox="{TB[0]} {TB[1]} {TB[2]} {TB[3]}" aria-hidden="true" focusable="false">\n<defs>{GLOW}</defs>\n'
            f'<g class="bh-head"><g class="bh-eyes">{glow(415, 311, 0.78)}{glow(432, 310, 0.5)}</g></g>\n</svg>').replace('id="eyeGlow"', 'id="eyeGlowTall"').replace('url(#eyeGlow)', 'url(#eyeGlowTall)')
# phones: the page's vignette sits on the tall bull, so a warm light layer lifts the bull's own values and rims its
# outline. The silhouette is traced from the tall painting (tall pixels); the layer is screen-blended (CSS) so only the bull
# brightens and the painting around it stays as painted. Soft edges: the fill is blurred, the rim is a blurred stroke that
# fades toward the legs (the glow comes from the horizon behind the summit).
SIL = [(396, 266), (387, 279), (391, 297), (404, 295), (420, 292), (438, 295), (452, 300), (461, 290), (458, 276), (449, 289), (448, 306), (445, 318), (450, 326), (447, 336), (434, 341), (422, 339),
       (413, 346), (416, 360), (420, 380), (418, 405), (414, 428), (408, 446), (398, 448), (394, 428), (394, 405), (388, 398), (382, 424), (378, 447), (369, 449), (365, 424), (364, 400), (352, 404),
       (344, 436), (338, 452), (323, 452), (319, 436), (326, 406), (334, 392), (320, 392), (308, 412), (302, 436), (298, 450), (286, 450), (286, 428), (292, 404), (294, 388), (290, 380), (297, 364),
       (307, 352), (323, 341), (340, 332), (362, 325), (386, 318), (392, 308), (383, 309), (381, 303), (392, 299)]
LB = (262, 246, 230, 220)
svg_light = (f'<svg class="bull-head bull-light" viewBox="{LB[0]} {LB[1]} {LB[2]} {LB[3]}" aria-hidden="true" focusable="false">\n'
             f'<defs><filter id="blLift" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.4"/></filter>'
             f'<filter id="blRim" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.1"/></filter>'
             f'<linearGradient id="blRimGrad" gradientUnits="userSpaceOnUse" x1="0" y1="262" x2="0" y2="452"><stop offset="0" stop-color="#ffc48e" stop-opacity=".4"/><stop offset=".45" stop-color="#ffb070" stop-opacity=".2"/><stop offset="1" stop-color="#ff9a50" stop-opacity=".03"/></linearGradient></defs>\n'
             f'<polygon class="bl-lift" fill="#b98253" opacity=".27" filter="url(#blLift)" points="{P(SIL)}"/>\n'
             f'<polygon class="bl-rim" fill="none" stroke="url(#blRimGrad)" stroke-width="2" stroke-linejoin="round" filter="url(#blRim)" points="{P(SIL)}"/>\n</svg>')
def splice(path, start, end, body):
    text = open(path).read(); i = text.index(start) + len(start); j = text.index(end)
    open(path, 'w').write(text[:i] + '\n' + body + '\n' + text[j:])
splice(os.path.join(APP, 'public', 'index.html'), '<!-- bull:start -->', '<!-- bull:end -->', svg_wide + '\n' + svg_light + '\n' + svg_tall)
css = (f'.bull-wide {{ left: 62.5%; top: 11.111%; width: 17.1875%; height: 33.333%; }}\n'
       f'.bull-tall {{ left: {TB[0] / 720 * 100:.3f}%; top: {TB[1] / 1280 * 100:.3f}%; width: {TB[2] / 720 * 100:.3f}%; height: {TB[3] / 1280 * 100:.3f}%; }}\n'
       f'.bull-light {{ left: {LB[0] / 720 * 100:.3f}%; top: {LB[1] / 1280 * 100:.3f}%; width: {LB[2] / 720 * 100:.3f}%; height: {LB[3] / 1280 * 100:.3f}%; }}')
splice(os.path.join(APP, 'public', 'css', 'app.css'), '/* bull:start */', '/* bull:end */', css)
print('svg bytes', len(svg_wide), 'tris', len(tris)); print(css)
