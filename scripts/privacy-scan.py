#!/usr/bin/env python3
"""Fails if anything that could point to a real person, or a secret, is about to be published.

Usage: scripts/privacy-scan.py [dir]      (word list: $PRIVACY_WORDS, default .privacy-words;
                                           rules: $PRIVACY_RULES, default .privacy-rules, optional)
Every file is checked (any name, any type): the raw bytes, a UTF-16 reading, the unpacked contents of
compressed data (gzip and zlib streams by their magic bytes, zip, the tables and the metadata and private
blocks of a WOFF font), and the private words are also looked for base64-, hex- and URL-encoded,
JS/Unicode-escaped, as HTML entities and spelled backwards. Images are parsed container by container and
anything beyond picture data (text, time, colour profile, EXIF/XMP, trailing bytes) is refused.
Your private words (real name, town, e-mail, usernames, timezone...) go in .privacy-words, one regular
expression per line. That file is never published.

Files that get published are also held to a neutral technical voice: no dated notes in comments or
docs, no timestamps with a time-zone offset anywhere, no numbered build rounds in text or file names,
and no "owner" (the role word that working notes attach decisions and quotes to). The token-account
sense of "owner" in Solana data (`x.owner`, `"owner":`, a quoted bare word in a name list) is allowed.
In a binary the readable byte runs are what is checked, so a date or an offset in them counts too.

The rules file (never published either) adds what is particular to one project, one `key: value` per line:
  private-file: <regex>   a path that stays with the operator (exempt from the voice rules)
  round-word: <word>      a word that numbers a build round ("<word> 13"), beside the generic build/round
  warn: <regex>           a word that only warns (printed, the scan still passes)
Set SCAN_COMMIT=1 to check the latest commit too, SCAN_COMMIT=all for every commit reachable from HEAD.
"""
import base64, datetime, io, os, re, subprocess, sys, zipfile, zlib, gzip
from urllib.parse import unquote_to_bytes

GENERIC = [r'/home/', r'/Users/(?!me\b)', r'C:\\Users', r'/root/', r'/mnt/c/Users', r'@(gmail|icloud|outlook|hotmail|yahoo|proton(mail)?)\.(com|me)',
           r'BEGIN [A-Z ]*PRIVATE KEY', r'ghp_[A-Za-z0-9]{20,}', r'github_pat_', r'nfp_[A-Za-z0-9]{20,}',
           r'sk-[A-Za-z0-9]{20,}', r'xox[bp]-', r'AKIA[0-9A-Z]{16}',
           # private networks: 10/8, 192.168/16, 172.16/12, carrier-grade NAT 100.64/10, IPv6 unique local fd00::/8
           r'\b(10\.\d+|192\.168)\.\d+\.\d+\b', r'\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\b',
           r'\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b', r'\bfd[0-9a-f]{2}:[0-9a-f:]*:[0-9a-f]*',
           # host names that point at one machine, private network or account (the patterns say which; hosts in
           # ALLOW_HOSTS are fine — keep that list explicit)
           r'\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b', r'\b[a-z0-9-]+\.local\b', r'\b[a-z0-9-]+\.cloudflareaccess\.com\b',
           r'\b[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b']
# Case-sensitive: a time zone narrows down where the author lives. (Written so this file's own bytes never spell a
# zone name: the script is published, and a zone may also be one of the private words.)
GENERIC_CS = [r'\b(?:America|Europe|Asia|Africa|Australia|Atlantic|Indian|Antarctica|Pacif[i]c)/[A-Z][A-Za-z_]+',
              r'\bPacif[i]c\b', r'\b[ECMP][DS]T\b', r'\bCES?T\b', r'\bAE[DS]T\b', r'\bBST\b', r'\b(?:GMT|UTC)\s?[+-]\s?\d{1,2}\b']
# Hosts the patterns above may name: the token creator's own Season board, and the example teams in the tests.
ALLOW_HOSTS = {'tbb-buyer-board.garden-equity-field-0042.workers.dev', 'example-team.cloudflareaccess.com', 'other-team.cloudflareaccess.com'}
SECRET_FILES = re.compile(r'(^|/)(\.env|.*\.(db|sqlite|pem|key)|id_rsa.*|id_ed25519.*)$')
SKIP_PREFIX = '.privacy-'  # the word list and the rules file: read, never scanned, never published
SELF = 'scripts/privacy-scan.py'
WORD_LISTS = {'lib/bip39words.js'}  # an English word list: every word in it is just a word
WARN_EXT = ('.md', '.txt')  # the docs; code comments are stripped from what the server serves (lib/assets.js)

# ---- the publication voice (files that get published only; the files the rules keep private are exempt) ----
DATE = re.compile(rb'\b20[2-9]\d-[01]\d-[0-3]\d(?!\d)')                                # an ISO date from 2020 on, with or without a time after it
TZ_OFFSET = re.compile(rb'\d\d:\d\d(?::\d\d(?:\.\d+)?)?[+-](?:0\d|1[0-4]):?[0-5]\d(?!\d)')  # a clock time with an offset: 08:45:00+00:00, 10:30-0000
OWNER = re.compile(rb'\b[Oo]wners?\b')
ROUND_WORDS = ['build', 'round']  # generic; the rules file adds a project's own


def load_rules(path):
    """The rules file: private files, round words, warn words. Without one, the generic defaults."""
    private, rounds, warns = [r'^\.privacy-'], list(ROUND_WORDS), []
    if path and os.path.isfile(path):
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if not line or line.startswith('#') or ':' not in line: continue
            k, v = (x.strip() for x in line.split(':', 1))
            if k == 'private-file': private.append(v)
            elif k == 'round-word': rounds.append(re.escape(v))
            elif k == 'warn': warns.append(v)
    words = '|'.join(rounds)
    return {'private': re.compile('|'.join(f'(?:{p})' for p in private)),
            'round': re.compile(rb'\b(?:' + words.encode() + rb')\s*#?\d+[a-z]?\b', re.I),      # "build 4b", "<word> 13"
            'round_name': re.compile(r'(?i)(?:^|/)(?:' + words + r')\d+[^/]*$'),                # a file named after a round
            'warn': [re.compile(w.encode()) for w in warns]}


RULES = load_rules(None)  # replaced in main() once the root is known
PROSE_EXT = ('.md', '.txt', '.yml', '.yaml')                                           # whole text counts as a comment
COMMENT = {'.js': rb'//[^\n]*|/\*.*?\*/', '.mjs': rb'//[^\n]*|/\*.*?\*/', '.css': rb'/\*.*?\*/', '.html': rb'<!--.*?-->',
           '.py': rb'#[^\n]*', '.sh': rb'#[^\n]*', '.example': rb'#[^\n]*', '.gitignore': rb'#[^\n]*'}


def comments(name, data):
    """The comment text of a code file, or the whole file for docs. Binary and unknown files: nothing."""
    low = name.lower()
    if low.endswith('security.txt'): return re.sub(rb'(?m)^Expires:[^\n]*', b'', data)  # RFC 9116 wants a date there
    if low.endswith(PROSE_EXT): return data
    ext = os.path.splitext(low)[1] or os.path.basename(low)
    rx = COMMENT.get(ext)
    if not rx: return b''
    return b'\n'.join(m.group(0) for m in re.finditer(rx, data, re.S))


def owner_hits(data):
    """The matches of the role word that are not the token-account field: `x.owner`, `owner:`, `"owner"`, `'owner'`,
    or `|owner|` inside a pattern of names."""
    out = []
    for m in OWNER.finditer(data):
        a, b = m.start(), m.end(); pre = data[a - 1:a]; post = data[b:b + 1]
        if pre == b'.' or post == b':' or (pre == b"'" and post == b"'") or (pre == b'"' and post == b'"') or (pre == b'|' and post == b'|'): continue
        out.append(m.group(0).decode())
    return out


def is_text(data):
    try: data.decode('utf-8'); return True
    except UnicodeDecodeError: return False


def voice(name, data, binary=False):
    """Problems with the publication voice of one file's bytes, as labels. For a binary (an image, a font) `data` is its
    readable runs, and a date in them counts: a build date in a font table or an image is as telling as one in a note."""
    found = []
    text = data if binary else comments(name, data)
    if DATE.search(text): found.append('dated note')
    if TZ_OFFSET.search(data): found.append('time-zone offset')
    if RULES['round'].search(data): found.append('build-round number')
    if name not in WORD_LISTS and owner_hits(data): found.append('the word "owner"')
    return found


def decoded(v):
    """The private words in disguise: every form a word could hide in, decoded back to bytes."""
    if b'%' in v: yield unquote_to_bytes(v)
    if b'\\u' in v or b'\\x' in v:
        yield re.sub(rb'\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})', lambda m: _chr(int(m.group(1) or m.group(2) or m.group(3), 16)), v)
    if b'&#' in v: yield re.sub(rb'&#x([0-9a-fA-F]{1,6});|&#(\d{1,7});', lambda m: _chr(int(m.group(1), 16) if m.group(1) else int(m.group(2))), v)
    out = []
    for m in re.finditer(rb'[A-Za-z0-9+/_-]{8,}', v):  # base64 and base64url runs (a short word is 8 characters), at every alignment
        run = m.group(0).replace(b'-', b'+').replace(b'_', b'/')
        for off in range(4):
            r = run[off:]; r += b'=' * (-len(r) % 4)
            try: out.append(base64.b64decode(r, validate=True))
            except Exception: pass
    for m in re.finditer(rb'(?:[0-9a-fA-F]{2}){8,}', v):  # hex runs, at both alignments
        run = m.group(0)
        for off in (0, 1):
            r = run[off:]; r = r[:len(r) - len(r) % 2]
            try: out.append(bytes.fromhex(r.decode()))
            except Exception: pass
    if out: yield b'\n'.join(out)
    yield v[::-1]


def font_time(b):
    """An OpenType LONGDATETIME (seconds since 1904-01-01, big-endian) as text."""
    try: return (datetime.datetime(1904, 1, 1) + datetime.timedelta(seconds=int.from_bytes(b, 'big'))).strftime('%Y-%m-%d %H:%M:%S').encode()
    except (OverflowError, ValueError): return b'?'


def _chr(n):
    try: return chr(n).encode('utf-8', 'ignore')
    except (ValueError, OverflowError): return b''


def files(root):
    if os.path.exists(os.path.join(root, ".git")):
        out = subprocess.run(['git', '-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], capture_output=True, check=True).stdout
        return [f for f in out.decode().split('\0') if f]
    return [os.path.relpath(os.path.join(d, f), root) for d, _, fs in os.walk(root) if '/.git' not in d + '/' for f in fs]


def views(name, data):
    """Every readable form of a file's bytes. Binary files: their readable text runs (like `strings`),
    so random image bytes don't look like words."""
    try: data.decode('utf-8'); text = True
    except UnicodeDecodeError: text = False
    yield data if text else b'\n'.join(re.findall(rb'[\x20-\x7e]{5,}', data))
    for enc in ('utf-16-le', 'utf-16-be'):
        if b'\0' in data[:4096]:
            yield data.decode(enc, 'ignore').encode('utf-8', 'ignore')
    low = name.lower()
    try:
        if data[:2] == b'\x1f\x8b': yield from views(name + '.unpacked', gzip.decompress(data))  # gzip, whatever the name
        elif data[:1] == b'\x78' and data[1:2] in (b'\x01', b'\x5e', b'\x9c', b'\xda'):  # a bare zlib stream (its magic can occur by chance: a miss is not an error)
            try: yield from views(name + '.unpacked', zlib.decompress(data))
            except zlib.error: pass
        if low.endswith('.zip') or data[:4] == b'PK\3\4':
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for n in z.namelist(): yield from views(n, z.read(n))
        if data[:4] == b'wOFF':  # WOFF tables are zlib-compressed one by one; then the extended-metadata (zlib) and private blocks
            num = int.from_bytes(data[12:14], 'big')
            for i in range(num):
                e = 44 + 20 * i
                off, clen, olen = (int.from_bytes(data[e + k:e + k + 4], 'big') for k in (4, 8, 12))
                t = data[off:off + clen]
                t = zlib.decompress(t) if clen < olen else t
                if data[e:e + 4] == b'head' and len(t) >= 36:  # the font's own build times, packed integers the text scan cannot see
                    yield b'FONT-TIME ' + b' '.join(k + b'=' + font_time(t[o:o + 8]) for k, o in ((b'head.created', 20), (b'head.modified', 28)))
                yield b'\n'.join(re.findall(rb'[\x20-\x7e]{4,}', t)); yield t.decode('utf-16-be', 'ignore').encode('utf-8', 'ignore')
            moff, mlen, poff, plen = (int.from_bytes(data[k:k + 4], 'big') for k in (24, 28, 36, 40))
            if mlen: yield zlib.decompress(data[moff:moff + mlen])
            if plen: yield b'\n'.join(re.findall(rb'[\x20-\x7e]{4,}', data[poff:poff + plen]))
        if data[:4] == b'wOF2': yield b'WOFF2-UNREADABLE'
    except Exception as e:  # unreadable compressed data is itself suspicious
        yield f'UNREADABLE {e}'.encode()


# ---- images: parsed container by container against an allow-list of what carries picture data and nothing else.
# Anything beyond that (text, time, physical size, colour profile, EXIF/XMP/IPTC, a maker's note, bytes after the end)
# fails and is named. The parsers go by the file's bytes, not its name.
PNG_OK = {b'IHDR', b'PLTE', b'tRNS', b'IDAT', b'IEND', b'sRGB', b'gAMA', b'sBIT', b'acTL', b'fcTL', b'fdAT'}
WEBP_OK = {b'VP8 ', b'VP8L', b'VP8X', b'ALPH', b'ANIM', b'ANMF'}
JPEG_NAMES = {0xfe: 'COM', 0xee: 'APP14', 0xed: 'APP13', 0xe2: 'APP2', 0xe1: 'APP1'}
ISO_CONTAINERS = {b'meta', b'iprp', b'ipco', b'iinf', b'dinf', b'iref', b'grpl'}
ISO_OK = {b'ftyp', b'meta', b'mdat', b'hdlr', b'pitm', b'iloc', b'iinf', b'infe', b'iprp', b'ipco', b'ipma', b'idat', b'iref', b'dinf', b'dref', b'grpl', b'auxl', b'thmb', b'cdsc', b'dimg', b'prem',
          b'ispe', b'pixi', b'av1C', b'colr', b'pasp', b'clap', b'irot', b'imir', b'auxC', b'lsel', b'a1op', b'a1lx', b'clli', b'mdcv', b'altr', b'ster'}
ISO_ITEMS_OK = {b'av01', b'grid', b'iovl', b'iden'}


def png_problems(d):
    out = []; i = 8
    while True:
        if i + 8 > len(d): return out + ['truncated']
        n = int.from_bytes(d[i:i + 4], 'big'); t = d[i + 4:i + 8]
        if t not in PNG_OK: out.append(t.decode('latin1', 'replace'))
        i += 12 + n
        if t == b'IEND': break
    if i < len(d): out.append('bytes after IEND')
    return out


def jpeg_problems(d):
    out = []; i = 2
    while True:
        if i + 2 > len(d): return out + ['truncated']
        if d[i] != 0xff: return out + ['not a marker at %d' % i]
        m = d[i + 1]
        if m == 0xd9: i += 2; break
        if 0xd0 <= m <= 0xd7 or m in (0x01, 0xff): i += 2; continue
        if i + 4 > len(d): return out + ['truncated']
        n = int.from_bytes(d[i + 2:i + 4], 'big'); seg = d[i + 4:i + 2 + n]
        if m == 0xe0 and seg[:5] == b'JFIF\0' and len(seg) <= 16: pass  # plain JFIF: version, units, density, no thumbnail
        elif m == 0xfe or 0xe0 <= m <= 0xef:
            tag = seg.split(b'\0')[0][:12].decode('latin1', 'replace')
            out.append('%s(%s)' % (JPEG_NAMES.get(m, 'APP%d' % (m - 0xe0)), tag))
        elif m in (0xdb, 0xc4, 0xdd) or (0xc0 <= m <= 0xcf and m not in (0xc4, 0xc8, 0xcc)): pass
        elif m == 0xda:
            i += 2 + n  # entropy-coded data up to the next real marker
            while True:
                j = d.find(b'\xff', i)
                if j < 0 or j + 1 >= len(d): return out + ['truncated']
                if d[j + 1] == 0 or 0xd0 <= d[j + 1] <= 0xd7: i = j + 2; continue
                i = j; break
            continue
        else: out.append('marker %02x' % m)
        i += 2 + n
    if i < len(d): out.append('bytes after EOI')
    return out


def webp_problems(d):
    out = []; size = int.from_bytes(d[4:8], 'little'); end = 8 + size; i = 12
    if end > len(d): return ['truncated']
    if end < len(d): out.append('bytes after RIFF')
    while i < end:
        if i + 8 > end: return out + ['truncated']
        t = d[i:i + 4]; n = int.from_bytes(d[i + 4:i + 8], 'little'); body = d[i + 8:i + 8 + n]
        if t not in WEBP_OK: out.append(t.decode('latin1', 'replace').strip())
        elif t == b'VP8X' and body[:1] and body[0] & 0x2c: out.append('VP8X flags announce ICC/EXIF/XMP')
        i += 8 + n + (n & 1)
    return out


def iso_problems(d):
    out = []

    def walk(start, end, depth):
        i = start
        while i < end:
            if i + 8 > end: out.append('truncated'); return
            n = int.from_bytes(d[i:i + 4], 'big'); t = d[i + 4:i + 8]; hdr = 8
            if n == 1: n = int.from_bytes(d[i + 8:i + 16], 'big'); hdr = 16
            if n == 0: n = end - i
            if n < hdr or i + n > end: out.append('truncated'); return
            body = d[i + hdr:i + n]; name = t.decode('latin1', 'replace')
            if t not in ISO_OK: out.append(name)
            elif t == b'hdlr' and body[24:].split(b'\0')[0]: out.append('hdlr name %r' % body[24:].split(b'\0')[0][:40].decode('latin1', 'replace'))
            elif t == b'colr' and body[:4] != b'nclx': out.append('colr ' + body[:4].decode('latin1', 'replace'))
            elif t == b'infe':
                ver = body[0]; item = body[8:12] if ver >= 2 else b'?'
                if item not in ISO_ITEMS_OK: out.append('item ' + item.decode('latin1', 'replace').strip())
            elif t in ISO_CONTAINERS:
                skip = 4 if t in (b'meta', b'dinf') else 0
                if t == b'iinf': skip = 4 + (2 if body[0] == 0 else 4)
                if t == b'iref': skip = 4
                walk(i + hdr + skip, i + n, depth + 1)
            i += n
    walk(0, len(d), 0)
    return out


def image_metadata(name, data):
    """Everything in an image that is not picture data, by parsing the container; [] when it is clean."""
    try:
        if data[:8] == b'\x89PNG\r\n\x1a\n': return png_problems(data)
        if data[:3] == b'\xff\xd8\xff': return jpeg_problems(data)
        if data[:4] == b'RIFF' and data[8:12] == b'WEBP': return webp_problems(data)
        if data[4:8] == b'ftyp': return iso_problems(data)
    except Exception as e:
        return ['unparseable: %s' % e]
    if not name.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.avif', '.heic')): return []
    if data[:6] in (b'GIF87a', b'GIF89a'):
        return ['GIF comment' if b'\x21\xfe' in data else ''] if b'\x21\xfe' in data or b'XMP DataXMP' in data else []
    return [m.decode() for m in (b'Exif', b'EXIF', b'XMP', b'xpacket', b'c2pa', b'jumb', b'caBX', b'tEXt', b'iTXt', b'zTXt', b'eXIf', b'iCCP', b'IPTC', b'Photoshop') if m in data] or ['unknown image format']


def main():
    global RULES
    root = sys.argv[1] if len(sys.argv) > 1 else '.'
    wf = os.environ.get('PRIVACY_WORDS', os.path.join(root, '.privacy-words'))
    if not os.path.isfile(wf):
        print(f"privacy scan: no word list at {wf}; refusing to say 'clean'"); return 1
    RULES = load_rules(os.environ.get('PRIVACY_RULES', os.path.join(root, '.privacy-rules')))
    private = [l.strip() for l in open(wf, encoding='utf-8') if l.strip() and not l.startswith('#')]
    pats = [(f'generic #{i + 1}', re.compile(p.encode(), re.I)) for i, p in enumerate(GENERIC)]
    pats += [(f'generic #{len(GENERIC) + i + 1}', re.compile(p.encode())) for i, p in enumerate(GENERIC_CS)]
    words = [(f'private word #{i + 1}', re.compile(p.encode(), re.I)) for i, p in enumerate(private)]
    pats += words
    warns = RULES['warn']
    allowed = {h.encode() for h in ALLOW_HOSTS}
    leak = lambda rx, v: any(m.group(0).lower() not in allowed for m in rx.finditer(v))
    fail = 0; n = 0
    for f in files(root):
        if os.path.basename(f).startswith(SKIP_PREFIX): continue
        path = os.path.join(root, f)
        if not os.path.isfile(path): continue
        n += 1
        if SECRET_FILES.search(f): print(f'SECRET-LIKE FILE: {f}'); fail = 1
        published = not RULES['private'].search(f)
        if published and RULES['round_name'].search(f): print(f'VOICE? {f}: file named after a build round'); fail = 1
        data = open(path, 'rb').read(); binary = not is_text(data)
        meta = image_metadata(f, data)
        if meta: print(f'IMAGE METADATA: {f} {meta}'); fail = 1
        for v in views(f, data):
            if v.startswith(b'UNREADABLE') or v == b'WOFF2-UNREADABLE': print(f'CAN NOT CHECK INSIDE: {f}'); fail = 1; continue
            if v.startswith(b'FONT-TIME '): print(f"FONT TIME? {f}: {v[10:].decode()} (upstream release times are expected; a time from this machine is not)"); continue
            for label, rx in pats:
                if f == SELF and label.startswith('generic'): continue  # its own pattern list
                if leak(rx, v): print(f'LEAK? {f}: {label}'); fail = 1
            for dv in decoded(v):  # the private words in disguise (encoded, escaped, reversed)
                for label, rx in words:
                    if rx.search(dv): print(f'LEAK? {f}: {label} (encoded)'); fail = 1
            if published and f != SELF:
                for what in voice(f, v, binary): print(f'VOICE? {f}: {what}'); fail = 1
            if f.lower().endswith(WARN_EXT):
                for rx in warns:
                    found = sorted({m.group(0).decode() for m in rx.finditer(v)})
                    if found: print(f"WARN? {f}: {', '.join(found)} (build-conversation word; read this file over before publishing)")
    # the publishing commit itself (author, committer, dates, message): SCAN_COMMIT=1 checks HEAD, SCAN_COMMIT=all every
    # commit reachable from HEAD (and refuses tags: a tag is a name someone chose, and the export has no history to keep)
    mode = os.environ.get('SCAN_COMMIT')
    if mode in ('1', 'all') and os.path.exists(os.path.join(root, '.git')):  # a file in a worktree
        git = lambda *a: subprocess.run(['git', '-C', root, *a], capture_output=True).stdout
        commits = git('rev-list', 'HEAD').split() if mode == 'all' else [b'HEAD']
        if mode == 'all':
            print(f'{len(commits)} commit{"s" if len(commits) != 1 else ""} reachable from HEAD')
            tags = git('tag').split()
            if tags: print(f'TAGS? {len(tags)} tag(s) in the repository'); fail = 1
        for c in commits:
            raw = git('cat-file', '-p', c.decode()); who = 'latest commit details' if c == b'HEAD' else f'commit {c.decode()[:12]}'
            for label, rx in pats:
                if rx.search(raw): print(f'LEAK? {who}: {label}'); fail = 1
            for what in voice('COMMIT.txt', raw): print(f'VOICE? {who}: {what}'); fail = 1
    if n == 0: print('privacy scan: found no files; refusing to say clean'); return 1
    print('privacy scan: clean' if not fail else 'privacy scan: FIX THE ABOVE BEFORE PUBLISHING')
    return fail


sys.exit(main())
