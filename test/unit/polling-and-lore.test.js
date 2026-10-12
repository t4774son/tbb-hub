// The Ideas "coming soon" button and card, the page's lighter polling (batched lore,
// no state poll while the stream is open, timers paused while hidden), the lore table (index, cached count, rowid probing,
// pruning), feed backoff (1 min → 30 min, no paging on 429), the lore worker's slow backfill, async brotli at startup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../lib/app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbp13-'));
let app; let base;
before(async () => {
  app = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', PUBLIC_ORIGIN: 'http://localhost:3000', CLIENT_IP_HEADER: 'x-test-ip', DB_FILE: path.join(dir, 'p13.db') },
    rpc: async () => { throw new Error('offline'); }, fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), log: () => {} });
  const port = (await app.listen(0)).port; base = `http://127.0.0.1:${port}`;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('Ideas is a dock tab hidden while closed; #/build typed in opens the card; the home notes and the Build lead promise nothing about a schedule or how it opens', async () => {
  const html = await (await fetch(base + '/')).text();
  const dock = /<nav class="dock"[\s\S]*?<\/nav>/.exec(html)[0];
  const tabs = [...dock.matchAll(/<a class="dk([^"]*)" href="#\/(\w+)" data-dk="\w+"([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => [m[2], /\bhidden\b/.test(m[3]), /<span class="dk-label">([^<]*)</.exec(m[4])[1]]);
  assert.deepEqual(tabs, [['story', false, 'Story'], ['links', false, 'Links'], ['season', false, 'Season 1'], ['learn', false, 'Learn'], ['build', true, 'Build'], ['live', true, 'Chat']], 'dock: ' + JSON.stringify(tabs));
  assert.ok(!/Opens with|opens with accounts|sign-in/.test(html), 'the home says nothing about how Ideas open');
  assert.ok(/<strong>Ideas are coming soon<\/strong>/.test(html) && /<strong>Chat and Ideas are coming soon<\/strong>/.test(html), 'the two home notes read Ideas');
  assert.ok(!/Ideas &amp; Votes|Ideas &amp; votes/.test(html), 'no "Ideas & Votes" left in the shell');
  const js = src('public/js/app.js'); const views = src('public/js/views.js');
  assert.ok(!/\['#\/build', \(\) =>/.test(js), '#/build is not a toast any more: the tab opens the card');
  assert.ok(/soonMark\(\$\('\.dk\[data-dk="build"\]'\), !ideas\)/.test(js), 'the tab follows the switches like the other Soon buttons');
  assert.ok(!/Ideas & votes|Ideas & Votes/.test(js + views), 'no "Ideas & votes" wording in the scripts');
  assert.ok(views.includes("title: 'Ideas are coming soon'") && views.includes("text: 'Post ideas for TBB and vote on the best ones. Details will be posted here before it opens.'")
    && views.includes("points: ['Post an idea', 'Vote on ideas']"), 'the card');
  for (const w of [/paid in TBB/, /every week/i, /paid jobs/, /one account, one vote/i, /reward/i]) assert.ok(!w.test(/async function build\([\s\S]*?\n}\n/.exec(views)[0] + /const IDEAS_SOON[\s\S]*?\n\n/.exec(views)[0]), 'no promise ' + w + ' in the Build lead or the card');
});

// ---- lore: batch endpoint, index, cached count, rowid probing, pruning ----
const addLore = (height, text, status = 'approved', foundAt = Date.now()) => app.db.run('INSERT OR IGNORE INTO lore(height,block_hash,txid,kind,text,found_at,status) VALUES(?,?,?,?,?,?,?)', height, 'h'.repeat(64), 'tx' + height + text.length, 'coinbase', text, foundAt, status);

test('GET /api/lore?n= returns a batch of distinct approved lines, capped at 30; a reply a few blocks later follows its line; without n the old shape stays', async () => {
  for (let i = 1; i <= 40; i++) addLore(1000 + i * 100, 'Line number ' + i);
  addLore(5005, 'The reply five blocks after line 40'); // a reply within 20 blocks of height 5000
  app.feeds.lore.invalidate?.();
  const big = await (await fetch(base + '/api/lore?n=50')).json();
  assert.ok(Array.isArray(big.lines) && big.lines.length === 30, 'capped at 30: ' + big.lines?.length);
  assert.equal(new Set(big.lines.map((l) => l.txid + l.text)).size, 30, 'distinct lines');
  for (const l of big.lines) assert.deepEqual(Object.keys(l).sort(), ['hash', 'height', 'kind', 'text', 'txid'], 'line shape');
  assert.equal(big.count, 42, 'the approved count (genesis + 41)');
  const three = await (await fetch(base + '/api/lore?n=3')).json(); assert.equal(three.lines.length, 3);
  const one = await (await fetch(base + '/api/lore?n=0')).json(); assert.equal(one.lines.length, 1, 'n below 1 is 1');
  const batch = app.feeds.lore.batch(60);
  const i = batch.findIndex((l) => l.height === 5000);
  assert.ok(i >= 0 && batch[i + 1]?.height === 5005, 'the reply follows its line in the batch: ' + JSON.stringify(batch.slice(i, i + 2)));
  const old = await (await fetch(base + '/api/lore')).json();
  assert.ok(old.lore && typeof old.lore.text === 'string' && !old.lines && old.count === 42, 'no n: one line and the count, as before');
  const follow = await (await fetch(base + '/api/lore?follow=5000')).json(); assert.equal(follow.lore.height, 5005, 'follow still works');
});

test('lore table: an index on (status, height); the approved count is cached and refreshed on insert/approve; pick() probes rowids instead of ORDER BY RANDOM()', async () => {
  const idx = app.db.all("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='lore'").map((r) => r.sql || '').join('\n');
  assert.ok(/lore\s*\(\s*status\s*,\s*height\s*\)/.test(idx), 'index lore(status,height): ' + idx);
  const lore = app.feeds.lore;
  const n = lore.count();
  assert.equal(n, app.db.get("SELECT COUNT(*) n FROM lore WHERE status='approved'").n);
  app.db.run("INSERT INTO lore(height,block_hash,txid,kind,text,found_at,status) VALUES(777,'h','tx-direct','coinbase','Written behind the cache',?,'approved')", Date.now());
  assert.equal(lore.count(), n, 'a direct insert is not seen: the count is cached');
  lore.invalidate(); assert.equal(lore.count(), n + 1, 'invalidate() rereads');
  lore.addCandidates(778, 'h'.repeat(64), 'tx-add', 'coinbase', ['Added through the worker, approved'], 'approved');
  assert.equal(lore.count(), n + 2, 'addCandidates refreshes the count');
  lore.addCandidates(779, 'h'.repeat(64), 'tx-pending', 'coinbase', ['Added through the worker, pending']);
  assert.equal(lore.count(), n + 2, 'a pending candidate does not count');
  assert.ok(!/RANDOM\(\)/.test(src('lib/feeds.js')), 'no ORDER BY RANDOM()');
  const seen = new Set(); for (let i = 0; i < 300; i++) seen.add(lore.pick().text);
  assert.ok(seen.size >= 15, 'picks are spread over the table: ' + seen.size);
  assert.ok(!seen.has('Added through the worker, pending'), 'pending lines are never picked');
  assert.equal(lore.batch(5).length, 5);
});

test('lore prune(): pending rows older than 30 days go, approved rows are capped at config.loreCap newest (genesis and the landmarks stay), and the app runs it on a timer', async () => {
  const lore = app.feeds.lore; const day = 86400_000;
  addLore(1, 'Old pending line', 'pending', Date.now() - 31 * day);
  addLore(2, 'Fresh pending line', 'pending', Date.now() - 2 * day);
  addLore(139792, 'A landmark line', 'approved');
  app.config.loreCap = 10;
  lore.prune();
  assert.equal(app.db.get("SELECT COUNT(*) n FROM lore WHERE status='pending' AND text='Old pending line'").n, 0, 'old pending gone');
  assert.equal(app.db.get("SELECT COUNT(*) n FROM lore WHERE status='pending' AND text='Fresh pending line'").n, 1, 'fresh pending kept');
  const approved = app.db.all("SELECT id, height FROM lore WHERE status='approved' ORDER BY id DESC");
  assert.ok(approved.some((r) => r.height === 0) && approved.some((r) => r.height === 139792), 'genesis and the landmark survive the cap');
  assert.equal(approved.length, 12, '10 newest + genesis + landmark: ' + approved.length);
  assert.equal(lore.count(), 12, 'the cached count follows');
  assert.ok(/const housekeeping = \(\) => \{[^\n]*feeds\.lore\.prune\(\)/.test(src('lib/app.js')) && /setInterval\(housekeeping, 6 \* 3600_000\)/.test(src('lib/app.js')) && /housekeeping\(\); resolve\(server\.address\(\)\)/.test(src('lib/app.js')), 'the app prunes at start and on a timer');
  delete app.config.loreCap;
});

// ---- feeds: the public Solana RPC and mempool back off too; the lore worker slows down once the table is full enough ----
import { makeRpc } from '../../lib/solana.js';
import { makeFeeds } from '../../lib/feeds.js';

test('makeRpc: a 429 is not retried and starts a backoff (1 min → 30 min) during which calls fail at once without a request; a success resets it', async () => {
  let calls = 0; let status = 429;
  const fetchImpl = async () => { calls++; return new Response(status === 200 ? '{"jsonrpc":"2.0","id":1,"result":7}' : 'slow down', { status }); };
  const rpc = makeRpc('https://api.mainnet-beta.solana.com', { fetchImpl, minGapMs: 0 });
  const realNow = Date.now; let t = realNow(); Date.now = () => t;
  try {
    await assert.rejects(rpc('getSlot'), (e) => e.status === 429); assert.equal(calls, 1, 'no retry on 429');
    await assert.rejects(rpc('getSlot'), /backing off/); assert.equal(calls, 1, 'no request during the backoff');
    t += 61_000; await assert.rejects(rpc('getSlot'), (e) => e.status === 429); assert.equal(calls, 2, 'tried again after 1 min');
    t += 61_000; await assert.rejects(rpc('getSlot'), /backing off/); assert.equal(calls, 2, 'the second wait is 2 min');
    t += 61_000; status = 200; assert.equal(await rpc('getSlot'), 7); assert.equal(calls, 3);
    assert.equal(await rpc('getSlot'), 7); assert.equal(calls, 4, 'a success resets the schedule');
  } finally { Date.now = realNow; }
});

test('lore worker: mempool stops at the first 429; backfill runs every 10 min once 500 lines are approved (the tip check stays at 60 s); the loop backs off 1 → 30 min on failures', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('slow down', { status: 429 }); };
  const rows = [];
  const db = { kvGet: (k, d) => d, kvSet() {}, get: (sql) => (/COUNT\(\*\)/.test(sql) ? { n: rows.length, lo: 1, hi: rows.length } : null), all: () => [], run() { rows.push(1); return { changes: 1 }; } };
  const f = makeFeeds({ db, rpc: null, config: { mempoolBase: 'https://mempool.space/api', mempoolGapMs: 0, backfillGapMs: 30_000 }, fetchImpl, log: () => {} });
  await assert.rejects(f.lore.mempool('/blocks/tip/height'), (e) => e.status === 429); assert.equal(calls, 1, 'one request, no retries on 429');
  assert.equal(f.lore.fillGap(), 30_000, 'backfill gap below 500 lines');
  rows.length = 600; f.lore.invalidate(); assert.equal(f.lore.fillGap(), 600_000, 'every 10 min at 500+ approved lines');
  assert.equal(f.lore.tickGap, 60_000, 'the tip check stays at 60 s');
  assert.deepEqual([1, 2, 3, 6, 9].map((n) => f.lore.backoffMs(n)), [60_000, 120_000, 240_000, 1_800_000, 1_800_000], '1 → 2 → 4 … → 30 min cap');
  // the loop: seven landmark lookups fail quietly, the first tip check fails → one failure, then nothing until the backoff ends
  calls = 0; f.lore.start();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(calls, 8, '7 landmarks + 1 tip check: ' + calls); assert.equal(f.lore.fails, 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls, 8, 'backing off: no more requests');
  f.lore.stop();
  assert.ok(f.status().lore.error.includes('429'));
});

// ---- the cost of a lore read: rowid probes (no scan, no sort), one shared batch per minute, a budget per connection ----
test('lore probes use the rowid, never a scan with a temporary sort; the ?n= batch is shared for a minute and refilled after; the batch route has its own per-connection budget', async () => {
  const probes = [...src('lib/feeds.js').matchAll(/`(SELECT \$\{cols\} FROM lore WHERE id [<>]=? \? AND [^`]*LIMIT 1)`/g)].map((m) => m[1].replace('${cols}', 'id,height,block_hash,txid,kind,text'));
  assert.equal(probes.length, 2, 'the two rowid probes: ' + JSON.stringify(probes));
  for (const q of probes) {
    const plan = app.db.all('EXPLAIN QUERY PLAN ' + q, 5).map((r) => r.detail).join(' | ');
    assert.ok(/USING INTEGER PRIMARY KEY/.test(plan) && !/TEMP B-TREE/.test(plan), q + ' → ' + plan);
  }
  const ip = { 'x-test-ip': '203.0.113.60' };
  const a = await (await fetch(base + '/api/lore?n=30', { headers: ip })).json();
  const b = await (await fetch(base + '/api/lore?n=30', { headers: ip })).json();
  assert.deepEqual(a, b, 'the same batch within the minute (built once, read many times)');
  const three = await (await fetch(base + '/api/lore?n=3', { headers: ip })).json();
  assert.deepEqual(three.lines, a.lines.slice(0, 3), 'a smaller n is the head of the same batch');
  const realNow = Date.now; const t0 = realNow();
  try {
    Date.now = () => t0 + 61_000;
    const c = await (await fetch(base + '/api/lore?n=30', { headers: ip })).json();
    assert.notDeepEqual(c.lines, a.lines, 'a minute later the batch is sampled again');
  } finally { Date.now = realNow; for (const k of ['ip:', 'lore:']) app.limiter.forget(k + ip['x-test-ip']); } // the fake clock left the buckets in the future
  let refused = 0; let n = 0;
  for (; n < 60 && !refused; n++) { const r = await fetch(base + '/api/lore?n=30', { headers: ip }); if (r.status === 429) refused = n; else assert.equal(r.status, 200); }
  assert.ok(refused > 0 && refused <= 40, 'the batch route has a budget of its own, well under the general 120: refused at ' + (refused || 'never'));
  assert.equal((await fetch(base + '/api/state', { headers: ip })).status, 200, 'the rest of the API is untouched by the batch budget');
  assert.equal((await fetch(base + '/api/lore', { headers: ip })).status, 200, 'and so is the single-line read');
});
