// Static files, built once at startup and served from memory. No bundler, no build step.
//   - every file gets a content hash in its name (/js/app.1a2b3c4d.js) and is served for a year as immutable;
//   - references inside HTML, CSS and JS (stylesheets, scripts, module imports, fonts, images) are rewritten to the hashed names;
//   - the plain names (/js/app.js) still work with a short cache + ETag, and index.html is always revalidated (no-cache + ETag);
//   - text files are compressed once (gzip at build time, brotli q11 right after off the main thread) and the right one
//     is sent for the browser's Accept-Encoding (gzip until the brotli copy has landed).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { SECURITY_HEADERS } from './http.js';

export const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.avif': 'image/avif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const TEXTY = new Set(['.html', '.js', '.css', '.svg', '.txt', '.json', '.webmanifest']);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hashedName = (p, hash) => { const ext = path.posix.extname(p); return `${p.slice(0, -ext.length)}.${hash.slice(0, 10)}${ext}`; };

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name); const st = fs.statSync(f);
    if (st.isDirectory()) walk(f, base, out);
    else if (st.isFile() && TYPES[path.extname(name).toLowerCase()] && !name.startsWith('.')) out.push({ file: f, url: '/' + path.relative(base, f).split(path.sep).join('/'), mtime: st.mtimeMs, size: st.size });
  }
  return out;
}

// Replace every reference to a known plain path with its hashed path. Absolute (/img/x.png) and, for JS modules,
// relative imports ('./ui.js') are both handled. Only whole references are touched: the character before and after
// must be a quote, bracket or whitespace, so '/img/x.png' inside a longer path is left alone.
function rewrite(text, fromUrl, lookup) {
  const dir = path.posix.dirname(fromUrl);
  return text.replace(/(["'(=\s])(\.{0,2}\/[A-Za-z0-9_./-]+\.(?:css|js|woff2?|ttf|png|jpe?g|webp|avif|svg|ico|json|webmanifest))(?=["')\s>?#,])/g, (m, pre, ref) => {
    const abs = ref.startsWith('/') ? ref : path.posix.normalize(path.posix.join(dir, ref));
    const hashed = lookup(abs);
    if (!hashed) return m;
    return pre + (ref.startsWith('/') ? hashed : './' + path.posix.relative(dir, hashed));
  });
}

// ---- comments out of what is served ----
// Comments are for the people who read the source; the served copy carries none (smaller, and nothing in a comment can
// leak). The JS pass is a small tokenizer: strings, template literals (with the expressions inside them), regex literals
// and division are told apart, so a '//' inside a URL string or a regex is never touched. Anything it cannot read with
// certainty (an unterminated string, regex or block comment) leaves the whole file as it is.
const IDENT = /[A-Za-z0-9_$ -￿]/;
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
function stripJs(src) {
  let out = ''; let i = 0; const n = src.length; const tpl = []; // tpl: brace depth of each open `${ … }` expression
  // Is a '/' here the start of a regex literal (true) or a division (false)? Decided from what was emitted before it.
  const regexNext = () => {
    let j = out.length - 1; while (j >= 0 && /\s/.test(out[j])) j--;
    if (j < 0) return true;
    const c = out[j];
    if (c === ')' || c === ']') return false;
    if (IDENT.test(c)) { let k = j; while (k >= 0 && IDENT.test(out[k])) k--; return REGEX_AFTER_WORD.has(out.slice(k + 1, j + 1)); }
    if ((c === '+' || c === '-') && out[j - 1] === c) return false; // a++ / 2
    return true;
  };
  const readString = (q) => { let j = i + 1; while (j < n) { const c = src[j]; if (c === '\\') { j += 2; continue; } if (c === '\n') return -1; if (c === q) return j + 1; j++; } return -1; };
  const readRegex = () => { let j = i + 1; let cls = false; while (j < n) { const c = src[j]; if (c === '\\') { j += 2; continue; } if (c === '\n') return -1; if (cls) { if (c === ']') cls = false; } else if (c === '[') cls = true; else if (c === '/') { j++; while (j < n && /[a-z]/i.test(src[j])) j++; return j; } j++; } return -1; };
  // Inside a template literal: copy up to the closing backtick or the next '${' (which opens a code expression).
  const readTemplate = () => { let j = i; while (j < n) { const c = src[j]; if (c === '\\') { j += 2; continue; } if (c === '`') { out += src.slice(i, j + 1); i = j + 1; return true; } if (c === '$' && src[j + 1] === '{') { out += src.slice(i, j + 2); i = j + 2; tpl.push(0); return true; } j++; } return false; };
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (c === "'" || c === '"') { const e = readString(c); if (e < 0) return null; out += src.slice(i, e); i = e; continue; }
    if (c === '`') { out += c; i++; if (!readTemplate()) return null; continue; }
    if (c === '/' && d === '/') { let e = src.indexOf('\n', i); if (e < 0) e = n; i = e; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) return null; out += ' '; i = e + 2; continue; }
    if (c === '/' && regexNext()) { const e = readRegex(); if (e < 0) return null; out += src.slice(i, e); i = e; continue; }
    if (tpl.length) {
      if (c === '{') tpl[tpl.length - 1]++;
      else if (c === '}') { if (tpl[tpl.length - 1] === 0) { tpl.pop(); out += c; i++; if (!readTemplate()) return null; continue; } tpl[tpl.length - 1]--; }
    }
    out += c; i++;
  }
  return tpl.length ? null : out;
}
function stripCss(src) {
  let out = ''; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; } out += src.slice(i, j + 1); i = j + 1; continue; }
    if (src.startsWith('url(', i)) { // unquoted url(...) is copied whole; a quoted one is read as the string it is
      if (src[i + 4] === '"' || src[i + 4] === "'") { out += 'url('; i += 4; continue; }
      const e = src.indexOf(')', i); if (e < 0) return null; out += src.slice(i, e + 1); i = e + 1; continue;
    }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) return null; i = e + 2; continue; }
    out += c; i++;
  }
  return out;
}
function stripHtml(src) {
  let out = ''; let i = 0; const n = src.length;
  while (i < n) {
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); if (e < 0) return null; i = e + 3; continue; }
    if (src[i] === '<' && /[A-Za-z/!?]/.test(src[i + 1] || '')) { // a tag: copy it whole, so '<!--' inside an attribute value is left alone
      let j = i + 1; let q = null;
      while (j < n) { const c = src[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += src[i]; i++;
  }
  return out;
}
export function stripComments(text, ext) {
  const f = ext === '.js' ? stripJs : ext === '.css' ? stripCss : ext === '.html' ? stripHtml : null;
  if (!f) return text;
  const out = f(text);
  return out === null ? text : out;
}

// gzip now (a few ms for the whole site); brotli at quality 11 later, in the thread pool, one file after another, so a
// start or a dev rebuild never holds a request. Returns the promise that resolves when the brotli copy is on the entry.
export function precompress(e, after = Promise.resolve()) {
  e.gz = zlib.gzipSync(e.buf, { level: 9 });
  return after.then(() => new Promise((resolve) => zlib.brotliCompress(e.buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: e.buf.length } }, (err, out) => { if (!err) e.br = out; resolve(); })));
}

export function buildAssets(root, { extra = null, hash: hashNames = true } = {}) {
  const files = walk(root);
  const byUrl = new Map();      // plain url → entry
  const byHashed = new Map();   // hashed url → entry
  const lookup = (abs) => byUrl.get(abs)?.hashed || extra?.hashedFor(abs) || null;
  let chain = Promise.resolve();
  const add = (f, buf, hash, nameHash = hash) => {
    const ext = path.posix.extname(f.url).toLowerCase();
    const e = { url: f.url, hashed: hashNames ? hashedName(f.url, nameHash) : f.url, type: TYPES[ext], etag: `"${hash.slice(0, 22)}"`, buf, size: buf.length, mtime: f.mtime, text: TEXTY.has(ext) };
    if (e.text && buf.length > 512) chain = precompress(e, chain);
    byUrl.set(e.url, e); byHashed.set(e.hashed, e);
    return e;
  };
  const ext = (f) => path.posix.extname(f.url).toLowerCase();
  // 1. leaves (fonts, images, text that references nothing)
  for (const f of files) if (!['.css', '.js', '.html', '.webmanifest'].includes(ext(f))) { const buf = fs.readFileSync(f.file); add(f, buf, sha(buf)); }
  // 2. css and the web app manifest (both reference images; the manifest's icons get the immutable copies too)
  for (const f of files) if (ext(f) === '.css' || ext(f) === '.webmanifest') { const buf = Buffer.from(rewrite(stripComments(fs.readFileSync(f.file, 'utf8'), ext(f)), f.url, lookup)); add(f, buf, sha(buf)); }
  // 3. js: modules import each other (even in a circle), so they share one version: the hash of all sources together
  const js = files.filter((f) => ext(f) === '.js').sort((a, b) => a.url.localeCompare(b.url));
  if (js.length) {
    const sources = js.map((f) => stripComments(fs.readFileSync(f.file, 'utf8'), '.js'));
    const version = sha(Buffer.from(sources.join('\n')));
    const pending = js.map((f, i) => { const e = { url: f.url, hashed: hashNames ? hashedName(f.url, version) : f.url }; byUrl.set(f.url, e); return [f, sources[i]]; });
    for (const [f, src] of pending) { const buf = Buffer.from(rewrite(src, f.url, lookup)); add(f, buf, sha(buf), version); }
  }
  // 4. html (references everything)
  for (const f of files) if (ext(f) === '.html') { const buf = Buffer.from(rewrite(stripComments(fs.readFileSync(f.file, 'utf8'), '.html'), f.url, lookup)); add(f, buf, sha(buf)); }

  const api = {
    root, files,
    ready: chain, // resolves once every text entry has its brotli copy
    get: (url) => byHashed.get(url) || byUrl.get(url) || null,
    isHashed: (url) => byHashed.has(url) && byHashed.get(url).hashed === url && url !== byHashed.get(url).url,
    hashedFor: (url) => byUrl.get(url)?.hashed || null,
    // Dev helper: true when any file on disk changed since the build.
    changed() { try { const now = walk(root); return now.length !== files.length || now.some((f) => byUrl.get(f.url)?.mtime !== f.mtime); } catch { return true; } },
  };
  return api;
}

function encodingFor(req) { const ae = String(req?.headers?.['accept-encoding'] || ''); return /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null; }

// Send one built asset. Cache policy: hashed name → immutable for a year; html → always revalidate; plain name → 5 minutes.
export function serveAsset(req, res, entry, { immutable = false, noStore = false, status = 200, extraHeaders = {} } = {}) {
  const h = { ...SECURITY_HEADERS, 'Content-Type': entry.type, ETag: entry.etag, Vary: 'Accept-Encoding', ...extraHeaders,
    'Cache-Control': noStore ? 'no-store' : immutable ? 'public, max-age=31536000, immutable' : entry.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300' };
  if (status === 200 && req.headers['if-none-match'] === entry.etag) { res.writeHead(304, h); res.end(); return; }
  const enc = encodingFor(req);
  const body = enc === 'br' && entry.br ? entry.br : enc && entry.gz ? entry.gz : entry.buf;
  if (body !== entry.buf) h['Content-Encoding'] = enc === 'br' && entry.br ? 'br' : 'gzip';
  h['Content-Length'] = body.length;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : body);
}
