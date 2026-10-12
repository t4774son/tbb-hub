// Nothing of the former pricing, store and wallet surface is left: no price route or SOL feed, no `follow` query, no
// unread counts in the state, no curve maths (the staking pool's address is one constant, proven here by the derivation
// it replaced), no unused icons or address shortener, no redirect for an old address, no stylesheet rules nothing
// names, and no stale wording in the docs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, loadConfig } from '../../lib/app.js';
import { TBB_MINT, STAKING_PROGRAM, STAKING_POOL } from '../../lib/solana.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('no price route, no SOL feed: the timer fetches the mint pairs, BTC, chart and board, never the SOL token', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); return new Response(JSON.stringify({ pairs: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbleft-'));
  const app = createApp({ env: { PORT: '0', LORE_WORKER: 'off', PUBLIC_ORIGIN: 'http://localhost:3000', DB_FILE: path.join(dir, 'l.db') }, rpc: async () => { throw new Error('offline'); }, fetchImpl, log: () => {} });
  try {
    const a = await app.listen(0); const base = `http://127.0.0.1:${a.port}`;
    await app.feeds.tick();
    assert.ok(urls.length >= 3, 'feeds ran: ' + urls.length);
    assert.ok(!urls.some((u) => /So1111/.test(u)), 'no SOL price request: ' + urls.filter((u) => /So1111/.test(u)));
    assert.ok(!app.routes.some((r) => r.pattern === '/api/prices'), 'no price route');
    assert.equal((await fetch(base + '/api/prices')).status, 404);
    assert.ok(!('solUsd' in app.feeds) && !Object.hasOwn(app.feeds.status(), 'sol'), 'no sol feed');
    // /api/lore has the batch (?n=) and the single line; a `follow` query is just ignored
    const one = await (await fetch(base + '/api/lore?follow=5000')).json();
    assert.deepEqual(Object.keys(one).sort(), ['count', 'lore']);
    assert.ok(!/follow/.test(read('lib/app.js')), 'no follow branch in the routes');
    const st = await (await fetch(base + '/api/state')).json();
    assert.deepEqual(Object.keys(st).sort(), ['alerts', 'banner', 'features', 'genesis', 'lore', 'me', 'operator', 'rooms', 'sections', 'stats', 'story', 'x']);
    assert.ok(!/\bcounts\b|voteCloses/.test(read('public/js/app.js')), 'the page keeps no counts or vote-close time it never reads');
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the one derived address, proven: program-derived address = first off-curve sha256(seed ‖ bump ‖ program ‖ marker)
const P = 2n ** 255n - 19n;
const mod = (a) => { const r = a % P; return r >= 0n ? r : r + P; };
const modPow = (b, e) => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
const modInv = (a) => modPow(mod(a), P - 2n);
const D = mod(-121665n * modInv(121666n));
function isOnCurve(b) {
  const yb = Uint8Array.from(b); yb[31] &= 0x7f; let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(yb[i]);
  if (y >= P) return false;
  const y2 = mod(y * y); const x2 = mod(mod(y2 - 1n) * modInv(mod(D * y2 + 1n)));
  if (x2 === 0n) return (b[31] & 0x80) === 0;
  return modPow(x2, (P - 1n) / 2n) === 1n;
}
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) { let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b); let out = ''; while (n > 0n) { out = ALPHA[Number(n % 58n)] + out; n /= 58n; } for (const b of bytes) { if (b === 0) out = '1' + out; else break; } return out; }
function b58decode(str) { let n = 0n; for (const c of str) { const v = ALPHA.indexOf(c); if (v < 0) throw new Error('bad base58'); n = n * 58n + BigInt(v); } const bytes = []; while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; } for (const c of str) { if (c === '1') bytes.unshift(0); else break; } return Uint8Array.from(bytes); }
function findProgramAddress(seeds, programId) {
  const pid = b58decode(programId); const marker = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256'); for (const s of seeds) h.update(s); h.update(Uint8Array.of(bump)); h.update(pid); h.update(marker);
    const d = new Uint8Array(h.digest()); if (!isOnCurve(d)) return [b58encode(d), bump];
  }
  throw new Error('no program address');
}

test('the staking pool address is one constant, equal to the program-derived address it replaced; the curve and base58 modules are gone', () => {
  assert.equal(STAKING_PROGRAM, '4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT');
  assert.deepEqual(findProgramAddress([new TextEncoder().encode('pool')], STAKING_PROGRAM), [STAKING_POOL, 254]);
  assert.equal(b58decode(STAKING_POOL).length, 32); assert.equal(b58decode(TBB_MINT).length, 32);
  for (const f of ['lib/ed.js', 'lib/base58.js']) assert.ok(!fs.existsSync(path.join(ROOT, f)), f + ' still exists');
  assert.ok(!/findProgramAddress|isOnCurve|STAKING_PROGRAM=|stakingProgram/.test(read('lib/solana.js') + read('lib/feeds.js') + read('lib/app.js') + read('.env.example') + read('README.md')), 'no derivation, no override setting');
  assert.ok(!('stakingProgram' in loadConfig({ STAKING_PROGRAM: '11111111111111111111111111111111' })), 'the setting is not read');
  assert.ok(read('lib/feeds.js').includes('STAKING_POOL') && read('lib/feeds.js').includes('STAKING_PROGRAM'), 'the feed reads the constant and checks which program the account belongs to');
});

test('the icon set holds only icons something draws; no address shortener; no redirect for the old swap address', () => {
  const ui = read('public/js/ui.js');
  const paths = [...ui.matchAll(/^\s{2}([a-z]+): 'M/gm)].map((m) => m[1]);
  // an icon is drawn when some page code names it (a literal, a data-i attribute, or a key in a kind → icon map)
  const code = ['public/index.html', 'public/js/app.js', 'public/js/views.js', 'public/js/views-closed.js', 'public/js/account.js'].map(read).join('\n');
  for (const p of paths) assert.ok(new RegExp(`['"]${p}['"]`).test(code), `icon ${p} is drawn nowhere`);
  for (const gone of ['buy', 'stake', 'calc', 'image', 'home', 'more', 'allies', 'ext']) assert.ok(!paths.includes(gone), 'icon still there: ' + gone);
  assert.ok(!/shortAddr/.test(ui + read('public/js/views.js') + read('public/js/app.js')), 'no address shortener');
  assert.ok(!/swap/i.test(read('public/js/app.js')), 'no special case for an old address: an unknown address is Not found like any other');
});

test('the stylesheet names no class that nothing in the markup or scripts uses', () => {
  const css = read('public/css/app.css');
  const code = ['public/index.html', 'public/back-soon.html', 'public/js/app.js', 'public/js/ui.js', 'public/js/views.js', 'public/js/views-closed.js', 'public/js/account.js', 'admin/admin.js', 'admin/index.html'].map(read).join('\n');
  for (const c of ['foot-btn', 'board-room', 'col', 't-ext', 't-badge', 't-lock', 'foot', 'fine-sep', 'badge-builder', 'divider', 'modal-x', 'btn98', 'cards', 'tb', 'soon-tag', 'is-extra', 'links-more', 'links-sub', 'places-tiles', 'ext-inline', 'age-title']) {
    assert.ok(!new RegExp(`\\b${c}\\b`).test(code.replace(/--col\b/g, '')), `${c} is used after all`);
    assert.ok(!new RegExp(`\\.${c}(?![\\w-])`).test(css), `app.css still styles .${c}`);
  }
});

test('docs say what the code does: no sign-in message binding, no company placeholder, the IPv6 grouping is /48 everywhere, no drifting test count', () => {
  assert.ok(!/sign-in messages/.test(read('.env.example')), '.env.example: the origin is for CSRF, not sign-in messages');
  for (const f of ['.env.example', 'README.md', 'lib/app.js']) assert.ok(!/LLC coming soon/.test(read(f)), f + ' names a placeholder the page no longer shows');
  assert.ok(!/\/56/.test(read('SECURITY.md')), 'SECURITY.md says /48 everywhere');
  assert.ok(!/\d+ link\/obfuscation cases/.test(read('README.md')), 'README carries no test count that drifts');
  assert.ok(!/base58/.test(read('DECISIONS.md')), 'DECISIONS names the Solana code that exists');
});
