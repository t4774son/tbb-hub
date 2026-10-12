// Static assets: content-hashed names, rewritten references, precompression, cache headers, 304s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { buildAssets, serveAsset } from '../../lib/assets.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbbassets-'));
fs.mkdirSync(path.join(dir, 'js')); fs.mkdirSync(path.join(dir, 'css')); fs.mkdirSync(path.join(dir, 'img')); fs.mkdirSync(path.join(dir, 'fonts'));
fs.writeFileSync(path.join(dir, 'img', 'pic.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
fs.writeFileSync(path.join(dir, 'fonts', 'f.woff'), Buffer.from('wOFFfont'));
fs.writeFileSync(path.join(dir, 'css', 'app.css'), "@font-face{src:url('/fonts/f.woff')} body{background:url(\"/img/pic.png\")} .x{background:url('https://other.example/img/pic.png')}\n".repeat(20));
fs.writeFileSync(path.join(dir, 'js', 'a.js'), "import { b } from './b.js';\nimport * as c from \"./c.js\";\nexport const a = 1; const notRef = 'https://x.example/js/b.js'; // comments are stripped\n".repeat(20));
fs.writeFileSync(path.join(dir, 'js', 'b.js'), "import { a } from './a.js'; export const b = 2;\n".repeat(20));
fs.writeFileSync(path.join(dir, 'js', 'c.js'), 'export const c = 3;');
fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><link rel="stylesheet" href="/css/app.css"><script type="module" src="/js/a.js"></script><link rel="modulepreload" href="/js/b.js"><picture><source srcset="/img/pic.png 640w, /img/pic.png 1280w" type="image/png"><img src="/img/pic.png" width="1" height="1"></picture><a href="/api/state">api</a>' + ' '.repeat(600));

const A = buildAssets(dir);

test('every file gets a hashed name; html, css and js references point at the hashed names', () => {
  const html = A.get('/index.html').buf.toString();
  const css = A.hashedFor('/css/app.css'); const js = A.hashedFor('/js/a.js'); const img = A.hashedFor('/img/pic.png');
  assert.match(css, /^\/css\/app\.[0-9a-f]{10}\.css$/); assert.match(js, /^\/js\/a\.[0-9a-f]{10}\.js$/); assert.match(img, /^\/img\/pic\.[0-9a-f]{10}\.png$/);
  assert.ok(html.includes(`href="${css}"`) && html.includes(`src="${js}"`) && html.includes(`href="${A.hashedFor('/js/b.js')}"`), 'html rewritten');
  assert.ok(html.includes(`srcset="${img} 640w, ${img} 1280w"`) && html.includes(`src="${img}"`), 'srcset + img rewritten');
  assert.ok(html.includes('href="/api/state"'), 'non-asset links untouched');
  const cssText = A.get('/css/app.css').buf.toString();
  assert.ok(cssText.includes(`url('${A.hashedFor('/fonts/f.woff')}')`) && cssText.includes(`url("${img}")`), 'css urls rewritten');
  assert.ok(cssText.includes("url('https://other.example/img/pic.png')"), 'absolute outside urls untouched');
});

test('js modules share one version so circular imports resolve to names that exist', () => {
  const a = A.get('/js/a.js'); const b = A.get('/js/b.js'); const c = A.get('/js/c.js');
  const v = /\.([0-9a-f]{10})\.js$/.exec(a.hashed)[1];
  assert.equal(b.hashed, `/js/b.${v}.js`); assert.equal(c.hashed, `/js/c.${v}.js`);
  assert.ok(a.buf.toString().includes(`from './b.${v}.js'`) && a.buf.toString().includes(`from "./c.${v}.js"`), 'imports rewritten');
  assert.ok(b.buf.toString().includes(`from './a.${v}.js'`), 'circular import rewritten');
  assert.ok(a.buf.toString().includes("'https://x.example/js/b.js'"), 'outside urls untouched');
  assert.equal(A.get(a.hashed), a); assert.equal(A.get('/js/a.js'), a); assert.ok(A.isHashed(a.hashed) && !A.isHashed('/js/a.js'));
  assert.equal(A.get('/js/nope.js'), null);
});

// Gzip is made at build time (fast); brotli at quality 11 is made right after, off the main thread, so a start
// (or a dev rebuild) never blocks requests on it. Until it lands a browser that asks for br gets gzip.
test('buildAssets returns before any brotli exists; api.ready resolves once every text entry has it; serving falls back to gzip meanwhile', async () => {
  const B = buildAssets(dir);
  const css = B.get('/css/app.css');
  assert.ok(css.gz && !css.br, 'gzip at once, brotli pending');
  assert.ok(B.ready instanceof Promise, 'api.ready');
  const fake = () => { const r = { headers: null, status: 0, body: null }; r.writeHead = (st, h) => { r.status = st; r.headers = h; }; r.end = (b) => { r.body = b; }; return r; };
  let res = fake(); serveAsset({ method: 'GET', headers: { 'accept-encoding': 'br, gzip' } }, res, css);
  assert.equal(res.headers['Content-Encoding'], 'gzip', 'gzip while brotli is pending'); assert.equal(res.body, css.gz);
  await B.ready;
  for (const e of [css, B.get('/js/a.js'), B.get('/index.html')]) assert.ok(e.br && zlib.brotliDecompressSync(e.br).equals(e.buf), e.url + ' brotli landed');
  res = fake(); serveAsset({ method: 'GET', headers: { 'accept-encoding': 'br, gzip' } }, res, css);
  assert.equal(res.headers['Content-Encoding'], 'br'); assert.equal(res.body, css.br);
  assert.ok(!B.get('/js/c.js').br && !B.get('/img/pic.png').br, 'tiny and binary files still get none');
});

test('text is precompressed (br + gzip) and decompresses to the served content; images are not', async () => {
  await A.ready;
  const css = A.get('/css/app.css');
  assert.ok(css.br && css.gz, 'precompressed');
  assert.equal(zlib.brotliDecompressSync(css.br).toString(), css.buf.toString());
  assert.equal(zlib.gunzipSync(css.gz).toString(), css.buf.toString());
  assert.ok(!A.get('/img/pic.png').br && !A.get('/fonts/f.woff').br);
  assert.ok(!A.get('/js/c.js').br, 'tiny files are not worth compressing');
});

test('serving: immutable for hashed names, short cache for plain names, no-cache for html, 304 on ETag, right encoding, HEAD', async () => {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const e = A.get(p === '/' ? '/index.html' : p); if (!e) { res.writeHead(404); return res.end(); }
    serveAsset(req, res, e, { immutable: A.isHashed(p) });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, h = {}, method = 'GET') => fetch(base + p, { headers: h, method });
  const hashed = await get(A.hashedFor('/css/app.css'), { 'accept-encoding': 'br' });
  assert.equal(hashed.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(hashed.headers.get('content-encoding'), 'br'); assert.equal(hashed.headers.get('vary'), 'Accept-Encoding');
  assert.equal(hashed.headers.get('content-type'), 'text/css; charset=utf-8'); assert.ok(hashed.headers.get('etag'));
  assert.ok((await hashed.text()).includes('@font-face'), 'fetch transparently decoded brotli');
  const plain = await get('/css/app.css', { 'accept-encoding': 'gzip' });
  assert.equal(plain.headers.get('cache-control'), 'public, max-age=300'); assert.equal(plain.headers.get('content-encoding'), 'gzip');
  const identity = await get('/css/app.css', { 'accept-encoding': 'identity' });
  assert.equal(identity.headers.get('content-encoding'), null); assert.equal(Number(identity.headers.get('content-length')), A.get('/css/app.css').size);
  const html = await get('/'); assert.equal(html.headers.get('cache-control'), 'no-cache'); assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
  const r304 = await get('/', { 'if-none-match': html.headers.get('etag') }); assert.equal(r304.status, 304);
  const head = await get('/', {}, 'HEAD'); assert.equal(head.status, 200); assert.equal((await head.text()).length, 0);
  const img = await get(A.hashedFor('/img/pic.png'), { 'accept-encoding': 'br' }); assert.equal(img.headers.get('content-encoding'), null); assert.equal(img.headers.get('content-type'), 'image/png');
  server.close();
});

test('changed() notices edits on disk (local dev rebuilds)', () => {
  assert.equal(A.changed(), false);
  const f = path.join(dir, 'js', 'c.js'); const st = fs.statSync(f); fs.utimesSync(f, st.atime, new Date(st.mtimeMs + 2000));
  assert.equal(A.changed(), true);
  const B = buildAssets(dir); assert.equal(B.changed(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Comments are stripped from what the server serves (HTML <!-- -->, CSS /* */, JS line and block comments) with a
// small tokenizer that respects strings, template literals (and the expressions inside them), regex literals and URLs.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../lib/assets.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('stripComments: JS comments go, but strings, template literals, regex literals and division stay byte for byte', () => {
  const src = [
    "// a line comment", "const url = 'https://a.example/x'; // trailing", 'const b = "/* not a comment */";', "/* block\n   comment */ const c = 1;",
    "const re = /https?:\\/\\/[^/]+\\/*/g; const re2 = /[/*]/; const d = 8 / 2 / 2; const e = c /* inline */ / 2;",
    "const t = `a ${url}/path // not a comment ${'}'} ${`inner ${1 + 1}`} /* nor this */`;", "return /re/.test(t) ? x / y : null;",
    "const f = (a) => a / 2 // half", "const g = { a: 1 } // obj", "const h = [1, 2] /* arr */ .length", "const i = '\\'' // escaped quote",
    "const j = '<!-- not html -->';", "label: /re/ // after a colon",
  ].join('\n');
  const out = stripComments(src, '.js');
  assert.ok(!/\/\/ (a line comment|trailing|half|obj|escaped quote|after a colon)/.test(out) && !out.includes('block\n') && !out.includes('inline') && !out.includes('arr'), out);
  for (const keep of ["'https://a.example/x'", '"/* not a comment */"', '/https?:\\/\\/[^/]+\\/*/g', '/[/*]/', '8 / 2 / 2', 'c   / 2', '`a ${url}/path // not a comment ${\'}\'} ${`inner ${1 + 1}`} /* nor this */`', '/re/.test(t) ? x / y', "'<!-- not html -->'", "'\\''"]) assert.ok(out.includes(keep), 'kept: ' + keep);
  assert.equal(stripComments('const x = 1;', '.js'), 'const x = 1;', 'nothing to strip: unchanged');
  assert.equal(stripComments("const s = 'unterminated // comment", '.js'), "const s = 'unterminated // comment", 'an unterminated string: left alone rather than guessed at');
});

test('stripComments: HTML and CSS comments go; CSS strings and urls stay', () => {
  assert.equal(stripComments('<!doctype html>\n<!-- bull:start -->\n<svg></svg>\n<!-- bull:end -->\n<p title="<!-- x -->">a</p>', '.html'), '<!doctype html>\n\n<svg></svg>\n\n<p title="<!-- x -->">a</p>');
  assert.equal(stripComments('/* bull:start */\n.a{content:"/*"; background:url(/img/x.png) /* img */}\n/* bull:end */\n', '.css'), '\n.a{content:"/*"; background:url(/img/x.png) }\n\n');
  assert.equal(stripComments('/* keep */', '.svg'), '/* keep */', 'other types untouched');
});

test('the real site and admin panel: every served script still parses (node --check on the served bytes); no comment survives in html, css or js', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tbbcheck-'));
  for (const [root, opts] of [[path.join(ROOT, 'public'), {}], [path.join(ROOT, 'admin'), { hash: false }]]) {
    const A = buildAssets(root, opts);
    for (const f of A.files) {
      const e = A.get(f.url); const text = e.buf.toString('utf8'); const ext = path.posix.extname(f.url);
      if (ext === '.js') {
        const file = path.join(tmp, 'check-' + f.url.replace(/[^a-z0-9.]/gi, '_')); fs.writeFileSync(file, e.buf);
        const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); assert.equal(r.status, 0, `${f.url}: ${r.stderr}`);
        assert.ok(!/^\s*\/\//m.test(text) && !/^\s*\/\*/m.test(text), `${f.url}: a comment line survived`);
        assert.ok(e.size < fs.statSync(f.file).size, `${f.url}: smaller than the source`);
      }
      if (ext === '.html') assert.ok(!text.includes('<!--'), f.url);
      if (ext === '.css') assert.ok(!text.includes('/*'), f.url);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
