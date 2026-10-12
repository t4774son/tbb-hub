#!/usr/bin/env node
// Checks that a live site serves exactly this checkout. The public folder is built here the way the server builds it
// (lib/assets.js: comments stripped, content-hashed names, references rewritten), then the live page and every public
// file are downloaded and compared byte for byte. Node built-ins only; nothing is written anywhere.
//   node scripts/verify-live.js                       → https://thebitcoinbull.club
//   node scripts/verify-live.js http://127.0.0.1:3000 → a local server
// Prints "MATCH: live site = this commit" (exit 0) or one line per difference (exit 1).
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildAssets } from '../lib/assets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ORIGIN = 'https://thebitcoinbull.club';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Every public file as the server would serve it: its plain and hashed URL and the exact bytes.
export function expectedFiles(publicDir = path.join(ROOT, 'public')) {
  const assets = buildAssets(publicDir);
  return assets.files.map((f) => { const e = assets.get(f.url); return { url: e.url, hashed: e.hashed, buf: e.buf, sha256: sha(e.buf) }; })
    .sort((a, b) => a.url.localeCompare(b.url));
}

// The assets a page or stylesheet refers to (absolute paths on this site only).
export function referenced(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:href|src)="(\/[^"]+)"/g)) out.add(m[1]);
  for (const m of text.matchAll(/srcset="([^"]+)"/g)) for (const part of m[1].split(',')) { const u = part.trim().split(/\s+/)[0]; if (u.startsWith('/')) out.add(u); }
  for (const m of text.matchAll(/url\(['"]?(\/[^'")]+)['"]?\)/g)) out.add(m[1]);
  for (const m of text.matchAll(/from\s*['"](\/[^'"]+)['"]/g)) out.add(m[1]);
  for (const m of text.matchAll(/import\(\s*['"](\/[^'"]+)['"]\s*\)/g)) out.add(m[1]);
  return [...out];
}

async function download(fetchImpl, url, timeoutMs) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ctl.signal, redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' } });
    return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  } finally { clearTimeout(t); }
}

// Compares a live site with the files of this checkout. Returns { ok, lines, checked }: lines are the differences
// (empty when everything matched), checked is the number of files compared.
export async function verifyLive(origin = DEFAULT_ORIGIN, { publicDir, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const base = origin.replace(/\/+$/, '');
  const files = expectedFiles(publicDir);
  const byUrl = new Map(files.map((f) => [f.url, f])); const byHashed = new Map(files.map((f) => [f.hashed, f]));
  const lines = []; let checked = 0;
  // 1. the page itself
  const shell = byUrl.get('/index.html');
  const home = await download(fetchImpl, base + '/', timeoutMs).catch((e) => ({ status: 0, buf: Buffer.alloc(0), err: e }));
  checked++;
  if (home.status !== 200) lines.push(`/ : HTTP ${home.status}${home.status === 503 ? ' (the site is in maintenance mode)' : ''}${home.err ? ' ' + home.err.message : ''}`);
  else {
    const got = home.buf.toString('utf8'); const want = shell.buf.toString('utf8');
    if (got !== want) lines.push(`/ : DIFFERENT (live sha256 ${sha(home.buf).slice(0, 16)}…, expected ${shell.sha256.slice(0, 16)}… for public/index.html)`);
    // 2. what the live page points at must be this commit's hashed names
    for (const ref of referenced(got)) if (!byHashed.has(ref) && !byUrl.has(ref)) lines.push(`/ : references ${ref}, which is not a file of this commit`);
  }
  // 3. every public file, by the hashed name this commit gives it (index.html is only ever served as the page)
  for (const f of files) {
    if (f.url === '/index.html') continue;
    const r = await download(fetchImpl, base + f.hashed, timeoutMs).catch((e) => ({ status: 0, buf: Buffer.alloc(0), err: e }));
    checked++;
    if (r.status === 404) lines.push(`${f.hashed} : MISSING (404) — expected public${f.url} with sha256 ${f.sha256.slice(0, 16)}…`);
    else if (r.status !== 200) lines.push(`${f.hashed} : HTTP ${r.status}${r.err ? ' ' + r.err.message : ''}`);
    else if (!r.buf.equals(f.buf)) lines.push(`${f.hashed} : DIFFERENT (live sha256 ${sha(r.buf).slice(0, 16)}…, expected ${f.sha256.slice(0, 16)}… for public${f.url}, ${r.buf.length} vs ${f.buf.length} bytes)`);
  }
  return { ok: lines.length === 0, lines, checked };
}

export function report(origin, { ok, lines, checked }) {
  if (ok) return `MATCH: live site = this commit (${origin}, ${checked} files compared byte for byte)`;
  return `MISMATCH: ${lines.length} difference${lines.length === 1 ? '' : 's'} between ${origin} and this commit (${checked} files compared)\n` + lines.map((l) => '  ' + l).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.argv[2] || DEFAULT_ORIGIN;
  const result = await verifyLive(origin);
  console.log(report(origin, result));
  process.exit(result.ok ? 0 : 1);
}
