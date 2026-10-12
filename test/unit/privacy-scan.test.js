// The privacy scanner's image and binary checks: every image is parsed chunk by chunk against an allow-list (PNG
// chunks, JPEG segments, WebP RIFF chunks, AVIF/HEIF boxes and items), a date inside a binary fails, and the commit mode
// can walk every commit reachable from HEAD. Samples are built here byte by byte; nothing is read from the repo's images.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNER = path.join(ROOT, 'scripts', 'privacy-scan.py');
let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbbscan-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// a scan of a fresh directory holding `files` ({ name: Buffer|string }), with a word list that matches nothing
function scan(files, env = {}) {
  const d = fs.mkdtempSync(path.join(dir, 's-'));
  fs.writeFileSync(path.join(d, '.privacy-words'), 'zzqqnevermatch\n');
  for (const [name, data] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, name)), { recursive: true }); fs.writeFileSync(path.join(d, name), data); }
  const r = spawnSync('python3', [SCANNER, d], { env: { ...process.env, PRIVACY_WORDS: path.join(d, '.privacy-words'), ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr, dir: d };
}

// ---- sample builders
const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return (~c) >>> 0; };
const pngChunk = (type, data) => Buffer.concat([be32(data.length), Buffer.from(type, 'latin1'), data, be32(crc(Buffer.concat([Buffer.from(type, 'latin1'), data])))]);
function png(extra = [], { trailing = Buffer.alloc(0) } = {}) {
  const ihdr = Buffer.concat([be32(1), be32(1), Buffer.from([8, 2, 0, 0, 0])]); // 1×1 RGB
  const idat = zlib.deflateSync(Buffer.from([0, 10, 20, 30]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), ...extra.map(([t, d]) => pngChunk(t, d)), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0)), trailing]);
}
const jpegSeg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), be32(payload.length + 2).subarray(2), payload]);
function jpeg(extra = [], { trailing = Buffer.alloc(0), jfif = true } = {}) {
  const app0 = jpegSeg(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]));
  const dqt = jpegSeg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));
  const sof = jpegSeg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
  const dht = jpegSeg(0xc4, Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 0), Buffer.alloc(0)]));
  const sos = Buffer.concat([jpegSeg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])]); // entropy data with a stuffed FF00 and an RST marker
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...(jfif ? [app0] : []), ...extra, dqt, sof, dht, sos, Buffer.from([0xff, 0xd9]), trailing]);
}
const riffChunk = (fourcc, data) => Buffer.concat([Buffer.from(fourcc, 'latin1'), le32(data.length), data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
function webp(chunks, { trailing = Buffer.alloc(0) } = {}) {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks.map(([f, d]) => riffChunk(f, d))]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), le32(body.length), body, trailing]);
}
const vp8 = ['VP8 ', Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0])];
const vp8x = (flags) => ['VP8X', Buffer.from([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0])];
const box = (type, ...parts) => { const body = Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p))); return Buffer.concat([be32(body.length + 8), Buffer.from(type, 'latin1'), body]); };
const fullBox = (type, ...parts) => box(type, Buffer.alloc(4), ...parts);
function avif({ items = [], props = [], hdlrName = '', extra = [] } = {}) {
  // version-2 infe: fullbox(version=2) + item_ID(2) + protection(2) + item_type(4) + name\0
  const infe2 = (id, type, name = '') => box('infe', Buffer.from([2, 0, 0, 0]), Buffer.from([0, id, 0, 0]), type, name + '\0');
  const allItems = [infe2(1, 'av01', 'Color'), ...items];
  const iinf = box('iinf', Buffer.from([0, 0, 0, 0]), Buffer.from([0, allItems.length]), ...allItems);
  const allProps = [box('ispe', Buffer.alloc(4), be32(1), be32(1)), box('colr', 'nclx', Buffer.from([0, 1, 0, 13, 0, 6, 0x80])), ...props];
  const ipco = box('ipco', ...allProps);
  const meta = fullBox('meta', box('hdlr', Buffer.alloc(4), Buffer.alloc(4), 'pict', Buffer.alloc(12), hdlrName + '\0'), box('pitm', Buffer.alloc(4), Buffer.from([0, 1])), iinf, box('iprp', ipco, box('ipma', Buffer.alloc(4), be32(1), Buffer.from([0, 1, 2, 0x81, 0x82]))));
  return Buffer.concat([box('ftyp', 'avif', be32(0), 'avifmif1miaf'), meta, box('mdat', Buffer.from([1, 2, 3, 4])), ...extra]);
}
const clean = { 'public/img/a.png': png([['PLTE', Buffer.alloc(3)], ['tRNS', Buffer.from([0])]]), 'public/img/b.jpg': jpeg(), 'public/img/c.webp': webp([vp8]), 'public/img/d.webp': webp([vp8x(0x10), ['ALPH', Buffer.from([0])], vp8]), 'public/img/e.avif': avif(), 'public/img/f.png': png([['sRGB', Buffer.from([0])], ['gAMA', be32(45455)]]) };

test('privacy scan: images with only picture data pass', () => {
  const r = scan(clean);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /privacy scan: clean/);
});

test('privacy scan: a PNG with any chunk beyond picture data fails, naming the chunk (tIME, tEXt, iTXt, zTXt, eXIf, iCCP, pHYs), as do bytes after IEND', () => {
  const chunks = { tIME: Buffer.from([7, 233, 3, 14, 21, 7, 0]), tEXt: Buffer.from('Software\0some editor', 'latin1'), iTXt: Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x/>', 'latin1'), zTXt: Buffer.concat([Buffer.from('Comment\0\0', 'latin1'), zlib.deflateSync(Buffer.from('hi'))]), eXIf: Buffer.from('MM\0*\0\0\0\x08', 'latin1'), iCCP: Buffer.concat([Buffer.from('Display\0\0', 'latin1'), zlib.deflateSync(Buffer.alloc(8))]), pHYs: Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]) };
  for (const [type, data] of Object.entries(chunks)) {
    const r = scan({ 'public/img/x.png': png([[type, data]]) });
    assert.equal(r.code, 1, type + ': ' + r.out); assert.ok(new RegExp(`IMAGE METADATA: public/img/x\\.png .*${type}`).test(r.out), type + ': ' + r.out);
  }
  const r = scan({ 'public/img/x.png': png([], { trailing: Buffer.from('trailing bytes') }) });
  assert.equal(r.code, 1); assert.match(r.out, /IMAGE METADATA: public\/img\/x\.png .*after IEND/);
});

test('privacy scan: a JPEG with COM, APP1 (EXIF/XMP), APP2 (ICC), APP13 (IPTC) or APP14 fails; so do bytes after EOI; no APP0 at all is fine', () => {
  const segs = { COM: jpegSeg(0xfe, Buffer.from('calibrated last spring', 'latin1')), APP1: jpegSeg(0xe1, Buffer.from('Exif\0\0MM\0*', 'latin1')), 'APP1 XMP': jpegSeg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x/>', 'latin1')),
    APP2: jpegSeg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1')), APP13: jpegSeg(0xed, Buffer.from('Photoshop 3.0\0', 'latin1')), APP14: jpegSeg(0xee, Buffer.from('Adobe\0', 'latin1')) };
  for (const [name, seg] of Object.entries(segs)) {
    const r = scan({ 'public/img/x.jpg': jpeg([seg]) });
    assert.equal(r.code, 1, name + ': ' + r.out); assert.ok(new RegExp(`IMAGE METADATA: public/img/x\\.jpg .*${name.split(' ')[0]}`).test(r.out), name + ': ' + r.out);
  }
  let r = scan({ 'public/img/x.jpg': jpeg([], { trailing: Buffer.from('after the end') }) });
  assert.equal(r.code, 1); assert.match(r.out, /IMAGE METADATA: public\/img\/x\.jpg .*after EOI/);
  r = scan({ 'public/img/x.jpg': jpeg([], { jfif: false }) });
  assert.equal(r.code, 0, 'no APP0 at all is fine (nothing to hide in): ' + r.out);
});

test('privacy scan: a WebP with EXIF, XMP or ICCP chunks, or a VP8X header announcing them, fails; so do bytes after the RIFF', () => {
  for (const [f, d] of [['EXIF', Buffer.from('MM\0*', 'latin1')], ['XMP ', Buffer.from('<x/>')], ['ICCP', Buffer.alloc(8)]]) {
    const r = scan({ 'public/img/x.webp': webp([vp8x(0x10), [f, d], vp8]) });
    assert.equal(r.code, 1, f + ': ' + r.out); assert.ok(new RegExp(`IMAGE METADATA: public/img/x\\.webp .*${f.trim()}`).test(r.out), f + ': ' + r.out);
  }
  for (const flag of [0x20, 0x08, 0x04]) {
    const r = scan({ 'public/img/x.webp': webp([vp8x(flag), vp8]) });
    assert.equal(r.code, 1, 'flag ' + flag + ': ' + r.out); assert.match(r.out, /IMAGE METADATA: public\/img\/x\.webp .*VP8X/);
  }
  const r = scan({ 'public/img/x.webp': webp([vp8], { trailing: Buffer.from('tail') }) });
  assert.equal(r.code, 1); assert.match(r.out, /IMAGE METADATA: public\/img\/x\.webp .*after RIFF/);
});

test('privacy scan: an AVIF with an Exif or mime (XMP) item, an ICC colr, a named handler or a stray box fails', () => {
  const infe2 = (id, type) => box('infe', Buffer.from([2, 0, 0, 0]), Buffer.from([0, id, 0, 0]), type, '\0');
  const cases = { Exif: avif({ items: [infe2(2, 'Exif')] }), mime: avif({ items: [infe2(2, 'mime')] }), prof: avif({ props: [box('colr', 'prof', Buffer.alloc(16))] }), rICC: avif({ props: [box('colr', 'rICC', Buffer.alloc(16))] }), hdlr: avif({ hdlrName: 'libavif on a workstation' }), uuid: avif({ extra: [box('uuid', Buffer.alloc(16), 'xmp here')] }) };
  for (const [name, data] of Object.entries(cases)) {
    const r = scan({ 'public/img/x.avif': data });
    assert.equal(r.code, 1, name + ': ' + r.out); assert.ok(new RegExp(`IMAGE METADATA: public/img/x\\.avif .*${name}`).test(r.out), name + ': ' + r.out);
  }
});

test('privacy scan: the parsers go by the bytes, not the file name; a truncated or unparseable image fails rather than passing', () => {
  let r = scan({ 'public/img/x.webp': png([['tEXt', Buffer.from('Author\0me', 'latin1')]]) });
  assert.equal(r.code, 1); assert.match(r.out, /IMAGE METADATA: public\/img\/x\.webp .*tEXt/);
  r = scan({ 'public/img/x.png': png().subarray(0, 30) });
  assert.equal(r.code, 1); assert.match(r.out, /IMAGE METADATA: public\/img\/x\.png .*truncated/);
});

test('privacy scan: a date inside a binary file fails (fonts, images, anything with readable runs) in a published file', () => {
  const date = ['2025', '03', '14'].join('-');
  const r = scan({ 'public/fonts/x.bin': Buffer.concat([Buffer.from([0, 1, 2, 3, 0xff, 0xfe]), Buffer.from('calibrated ' + date), Buffer.from([0, 0, 0xff])]) });
  assert.equal(r.code, 1, r.out); assert.match(r.out, /VOICE\? public\/fonts\/x\.bin: dated note/);
  assert.equal(scan({ 'public/fonts/y.bin': Buffer.concat([Buffer.from([0, 1, 2, 3, 0xff]), Buffer.from('version 2.011'), Buffer.from([0, 0xff])]) }).code, 0, 'a plain version string is fine');
});

test('privacy scan: SCAN_COMMIT=1 checks the latest commit; SCAN_COMMIT=all walks every commit reachable from HEAD and refuses tags', () => {
  const d = fs.mkdtempSync(path.join(dir, 'g-'));
  const git = (...a) => { const r = spawnSync('git', ['-C', d, '-c', 'user.name=Pen Name', '-c', 'user.email=pen@example.com', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, a.join(' ') + ': ' + r.stderr); return r.stdout; };
  git('init', '-q'); fs.writeFileSync(path.join(d, '.privacy-words'), 'zzqqnevermatch\nsecretword\n'); fs.writeFileSync(path.join(d, '.gitignore'), '.privacy-words\n'); fs.writeFileSync(path.join(d, 'a.txt'), 'hello\n');
  git('add', '.'); git('commit', '-q', '-m', 'first: the secretword slipped in');
  fs.writeFileSync(path.join(d, 'a.txt'), 'hello again\n'); git('commit', '-q', '-am', 'second: fine');
  const run = (mode) => { const r = spawnSync('python3', [SCANNER, d], { env: { ...process.env, PRIVACY_WORDS: path.join(d, '.privacy-words'), SCAN_COMMIT: mode }, encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
  assert.equal(run('1').code, 0, 'HEAD alone is clean: ' + run('1').out);
  const all = run('all');
  assert.equal(all.code, 1, all.out); assert.match(all.out, /LEAK\? commit [0-9a-f]{7,}: private word #2/);
  assert.match(all.out, /2 commits? reachable/);
  git('tag', 'v1');
  assert.match(run('all').out, /tag/i, 'a tag is a name someone chose: refused in the all-commits mode');
});

test('privacy scan: the repo\'s own images and fonts pass the parsers (what ships today is clean)', () => {
  const files = {};
  for (const sub of ['public/img', 'public/fonts']) for (const f of fs.readdirSync(path.join(ROOT, sub))) if (/\.(png|jpe?g|webp|avif|woff2?)$/.test(f)) files[`${sub}/${f}`] = fs.readFileSync(path.join(ROOT, sub, f));
  assert.ok(Object.keys(files).length >= 5);
  const r = scan(files);
  assert.equal(r.code, 0, r.out);
});

test('privacy scan: the Expires line of a security.txt is not a dated note (RFC 9116 wants a date); the same date in any other text is', () => {
  const expires = new Date(Date.now() + 300 * 86400_000).toISOString(); // a date ahead, built here so this file carries none
  const ok = scan({ '.well-known/security.txt': `Contact: mailto:report@x.example\nExpires: ${expires}\nPreferred-Languages: en\n` });
  assert.equal(ok.code, 0, ok.out);
  const no = scan({ 'notes.txt': `Expires: ${expires}\n` });
  assert.equal(no.code, 1); assert.match(no.out, /VOICE\? notes\.txt: dated note/);
});

// ---- the private words in disguise: every decoded form is checked against the word list ----
const WORD = 'zorblax'; // a made-up private word; the list below is written for each scan
function scanWord(files) {
  const d = fs.mkdtempSync(path.join(dir, 'w-'));
  fs.writeFileSync(path.join(d, '.privacy-words'), WORD + '\n');
  for (const [name, data] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, name)), { recursive: true }); fs.writeFileSync(path.join(d, name), data); }
  const r = spawnSync('python3', [SCANNER, d], { env: { ...process.env, PRIVACY_WORDS: path.join(d, '.privacy-words'), PRIVACY_RULES: '' }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const hex = (s) => Buffer.from(s).toString('hex');

test('privacy scan: a private word is caught base64-encoded (alone, inside a longer run, url-safe), hex-encoded, URL-encoded, JS/Unicode-escaped, as HTML entities and reversed', () => {
  const cases = {
    'a.js': `const k = '${b64(WORD)}';`, 'b.js': `const k = '${b64('hello ' + WORD + ' world, how are you')}';`, 'c.txt': b64('x'.repeat(5) + WORD).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    'd.js': `const h = '${hex('the word ' + WORD)}';`, 'e.js': `const u = 'q=%7A%6Frbl%61x';`, 'f.js': `const s = "\\u007a\\u006frbl\\u0061x";`, 'g.js': `const s = "\\x7a\\x6frblax";`, 'h.js': `const s = "\\u{7a}orblax";`,
    'i.html': `<p>&#122;orbl&#x61;x</p>`, 'j.md': 'the word is ' + [...WORD].reverse().join('') + ' spelled backwards',
  };
  for (const [name, data] of Object.entries(cases)) { const r = scanWord({ [name]: data }); assert.equal(r.code, 1, name + ': ' + r.out); assert.match(r.out, new RegExp(`LEAK\\? ${name.replace('.', '\\.')}: private word #1`), name); }
  const clean = scanWord({ 'ok.js': `const k = '${b64('nothing to see here at all')}'; const h = '${hex('plain data only')}'; const s = "\\u00e9t\\u00e9"; const r = 'drowssap';` });
  assert.equal(clean.code, 0, clean.out);
});

test('privacy scan: a timestamp with a time-zone offset fails anywhere in a published text file (code included); a Z time or a bare clock time does not', () => {
  const t = 'T08:45:00'; const plus = '+' + '02:00'; const minus = '-' + '0700';
  const bad = { 'a.js': `const when = Date.parse('2030-01-03${t}${plus}');`, 'b.md': `Posted ${'2030-01-03'}${t}${minus}.`, 'c.js': `const w = '10:30:00${plus}';` };
  for (const [name, data] of Object.entries(bad)) { const r = scanWord({ [name]: data }); assert.equal(r.code, 1, name + ': ' + r.out); assert.match(r.out, new RegExp(`VOICE\\? ${name.replace('.', '\\.')}: time-zone offset`), name); }
  const ok = scanWord({ 'ok.js': `const t = Date.parse('2030-01-03${t}Z'); const span = '09:00-17:00'; const m = '08:45'; const v = [1, -0.5];` });
  assert.equal(ok.code, 0, ok.out);
});

test('privacy scan: gzip and zlib streams are unpacked whatever the file is called; a WOFF font\'s metadata and private blocks are read', () => {
  const gz = scanWord({ 'notes.json.gzip': zlib.gzipSync(Buffer.from('{"who":"' + WORD + '"}')) });
  assert.equal(gz.code, 1, gz.out); assert.match(gz.out, /LEAK\? notes\.json\.gzip: private word #1/);
  const z = scanWord({ 'blob.bin': zlib.deflateSync(Buffer.from('about ' + WORD + ' again')) });
  assert.equal(z.code, 1, z.out); assert.match(z.out, /LEAK\? blob\.bin: private word #1/);
  // a WOFF with no tables and an extended-metadata block (zlib) naming the word, then one with the word in the private block
  const woff = (meta, priv) => {
    const h = Buffer.alloc(44); h.write('wOFF', 0, 'latin1'); h.writeUInt32BE(0x00010000, 4); h.writeUInt16BE(0, 12);
    const m = meta ? zlib.deflateSync(meta) : Buffer.alloc(0); const p = priv || Buffer.alloc(0);
    h.writeUInt32BE(44 + m.length + p.length, 8);
    if (m.length) { h.writeUInt32BE(44, 24); h.writeUInt32BE(m.length, 28); h.writeUInt32BE(meta.length, 32); }
    if (p.length) { h.writeUInt32BE(44 + m.length, 36); h.writeUInt32BE(p.length, 40); }
    return Buffer.concat([h, m, p]);
  };
  const meta = scanWord({ 'public/fonts/x.woff': woff(Buffer.from('<?xml version="1.0"?><metadata><credit name="' + WORD + ' foundry"/></metadata>'), null) });
  assert.equal(meta.code, 1, meta.out); assert.match(meta.out, /LEAK\? public\/fonts\/x\.woff: private word #1/);
  const priv = scanWord({ 'public/fonts/y.woff': woff(null, Buffer.from('private block made by ' + WORD + ' tools')) });
  assert.equal(priv.code, 1, priv.out); assert.match(priv.out, /LEAK\? public\/fonts\/y\.woff: private word #1/);
  const fine = scanWord({ 'public/fonts/z.woff': woff(Buffer.from('<metadata><credit name="Nobody"/></metadata>'), null) });
  assert.equal(fine.code, 0, fine.out);
});
