// The live-site verifier: builds the public files the way the server does and compares them byte for byte with what a
// site serves. Against a local server from this checkout it matches; against a tampered
// copy of the public folder it names the file; the GitHub workflow that runs it hourly is read-only and pinned.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../lib/app.js';
import { verifyLive, expectedFiles, referenced, report, DEFAULT_ORIGIN } from '../../scripts/verify-live.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbverify-'));
let app; let base;
before(async () => {
  app = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: path.join(dir, 'v.db') }, rpc: async () => { throw new Error('no rpc'); }, fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), log: () => {} });
  const a = await app.listen(0); base = `http://127.0.0.1:${a.port}`;
  await app.assets.ready;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a server running this checkout matches: every public file by its hashed name, the page as served', async () => {
  const files = expectedFiles();
  assert.ok(files.some((f) => f.url === '/.well-known/security.txt'), 'security.txt is one of the public files the verifier checks');
  assert.ok(files.length > 20 && files.every((f) => /^\/.+\.[0-9a-f]{10}\.[a-z0-9]+$/.test(f.hashed) && f.sha256.length === 64), 'hashed names and digests');
  const r = await verifyLive(base);
  assert.deepEqual(r.lines, [], 'no differences'); assert.ok(r.ok && r.checked === files.length, `checked ${r.checked} of ${files.length}`);
  assert.match(report(base, r), /^MATCH: live site = this commit/);
  assert.equal(DEFAULT_ORIGIN, 'https://thebitcoinbull.club');
  // the page's references are the hashed names of this build, and nothing else
  const html = await (await fetch(base + '/')).text(); const hashed = new Set(files.map((f) => f.hashed));
  const refs = referenced(html); assert.ok(refs.length >= 10 && refs.every((u) => hashed.has(u)), 'references: ' + refs.join(' '));
});

test('a tampered copy is caught and named: a changed stylesheet makes the page differ and the expected hashed files missing', async () => {
  const copy = path.join(dir, 'public'); fs.cpSync(path.join(ROOT, 'public'), copy, { recursive: true });
  fs.appendFileSync(path.join(copy, 'css', 'app.css'), '\n.tampered{color:red}\n');
  const r = await verifyLive(base, { publicDir: copy });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith('/ : DIFFERENT')), 'the page differs (it points at another stylesheet hash): ' + r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /^\/css\/app\.[0-9a-f]{10}\.css : MISSING \(404\)/.test(l)), 'the tampered stylesheet is not on the server: ' + r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /^\/ : references \/css\/app\.[0-9a-f]{10}\.css, which is not a file of this commit/.test(l)), 'the live page references a name this build does not have');
  assert.ok(r.lines.some((l) => /^\/back-soon\.[0-9a-f]{10}\.html : MISSING \(404\)/.test(l)), 'the maintenance page references the stylesheet, so its hash moved too');
  assert.equal(r.lines.length, 4, r.lines.join('\n')); // everything else (fonts, images, scripts) still matches
  assert.match(report(base, r), /^MISMATCH: 4 differences/);
  // a server that is down or in maintenance is a mismatch too, never a false MATCH
  const down = await verifyLive('http://127.0.0.1:9', { timeoutMs: 2000 });
  assert.ok(!down.ok && down.lines.length === expectedFiles().length, 'every file reported');
  app.settings.set('maintenance', { on: true, text: '' });
  const maint = await verifyLive(base); assert.ok(!maint.ok && maint.lines[0].includes('HTTP 503') && maint.lines[0].includes('maintenance'), maint.lines[0]);
  app.settings.set('maintenance', { on: false, text: '' });
});

test('the hourly GitHub workflow is read-only, pinned by commit, has no secrets and only runs the verifier', () => {
  const y = fs.readFileSync(path.join(ROOT, '.github/workflows/verify-live.yml'), 'utf8');
  assert.match(y, /^permissions:\n  contents: read\n/m, 'contents: read only');
  assert.match(y, /schedule:\n\s+- cron: '\d+ \* \* \* \*'/, 'hourly');
  assert.match(y, /workflow_dispatch:/, 'manual trigger');
  const uses = [...y.matchAll(/uses: ([^\s@]+)@([0-9a-f]+)/g)];
  assert.ok(uses.length >= 2 && uses.every((m) => m[2].length === 40), 'every action pinned by a full commit SHA: ' + uses.map((m) => m[0]).join(', '));
  assert.ok(!/secrets\.|\$\{\{\s*secrets/.test(y), 'no secrets');
  assert.ok(!/write/.test(y), 'nothing writes');
  assert.match(y, /run: node scripts\/verify-live\.js\s*$/m, 'runs the verifier and nothing else');
  assert.equal((y.match(/run:/g) || []).length, 1);
});
