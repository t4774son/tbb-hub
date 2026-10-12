// Launch defaults: the seed writes no chat messages; chat and the ideas board are "coming soon" with the default
// settings; the room blurbs and empty states are plain; no apples.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, loadConfig, ROOMS } from '../../lib/app.js';
import { seed } from '../../scripts/seed.js';

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbdefaults-'));
let app; let base;
before(async () => {
  // default settings: no CHAT_OPEN / ACCOUNTS_OPEN; a stray SWAP_OPEN must mean nothing (there is no swap)
  app = createApp({ env: { PORT: '0', LORE_WORKER: 'off', SWAP_OPEN: '1', DB_FILE: path.join(dir, 'p7.db') }, rpc: async () => { throw new Error('no rpc'); }, fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), log: () => {} });
  seed(app.db, { demo: true });
  const a = await app.listen(0); base = `http://127.0.0.1:${a.port}`;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('the seed writes no chat messages, plain or demo (the welcome and example lines are gone)', () => {
  assert.equal(app.db.get('SELECT COUNT(*) n FROM messages').n, 0, 'demo data has accounts and ideas but no chat');
  seed(app.db); // the plain seed, run again, adds none either
  assert.equal(app.db.get("SELECT COUNT(*) n FROM messages").n, 0);
  const src = fs.readFileSync(new URL('../../scripts/seed.js', import.meta.url), 'utf8');
  assert.ok(!/WELCOME|'herd'|Running bitcoin|stays here|fog on the ridge/.test(src), 'no welcome block or chat examples left in the seed');
});

test('default settings: chat and the ideas board are closed (503 reads and writes); there is no swap at all', async () => {
  const st = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(st.features, { chat: false, accounts: false, ideas: false }); assert.ok(!('swap' in st.features), 'no swap flag');
  for (const p of ['/api/rooms/general/messages', '/api/rooms/builds/messages', '/api/ideas']) assert.equal((await fetch(base + p)).status, 503, p);
  for (const p of ['/api/rooms/general/messages', '/api/ideas']) assert.equal((await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: base }, body: '{}' })).status, 503, 'POST ' + p);
  assert.equal(app.db.get('SELECT COUNT(*) n FROM messages').n, 0, 'nothing written');
  assert.ok(!('swapOpen' in app.config) && !('swapOpen' in loadConfig({ SWAP_OPEN: '1' })), 'no swap setting exists');
});

test('room descriptions and empty states are plain; no apples', () => {
  for (const r of ROOMS) assert.ok(!/herd|memes|quiet room/i.test(r.blurb), r.id + ': ' + r.blurb);
  const ui = ['public/js/views.js', 'public/js/app.js', 'public/index.html', 'public/css/app.css'].map((f) => fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8')).join('\n');
  assert.ok(!/Quiet on the (ridge|summit)|Say the first word|Say something to the herd|The shelves are waiting|The quiet room/.test(ui), 'no voice-y chat lines');
  assert.ok(ui.includes('No messages yet.'), 'the plain empty state');
  assert.ok(!/apple/i.test(ui.replace(/-apple-system|apple-touch-icon/g, '')), 'no apples in the page');
  assert.ok(!fs.existsSync(new URL('../../scripts/make-apples.py', import.meta.url)), 'generator gone');
});
