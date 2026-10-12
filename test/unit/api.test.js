// API integration test: real HTTP server, planted members, mocked Solana RPC + outside feeds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, LINK_WORDING, safeUrl } from '../../lib/app.js';
import { seed, ALLIES } from '../../scripts/seed.js';
import { TBB_MINT, findProgramAddress } from '../../lib/solana.js';
import { newUid, plantUser, sessionFor } from './helpers.js';

const OTHER = newUid('other'); const MAKER = newUid('maker'); const READER = newUid('reader'); const RICH = newUid('rich');

const rpc = async (method) => { throw new Error('unexpected rpc ' + method); };
const fakeFetch = async (url) => {
  const body = String(url).includes('dexscreener') ? { pairs: [{ baseToken: { address: TBB_MINT, symbol: 'TBB' }, quoteToken: { symbol: 'SOL' }, priceUsd: '0.0004', priceChange: { h24: 5.2 }, liquidity: { usd: 100 }, marketCap: 400000, pairAddress: 'x' }] } : { USD: 100000 };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

let app; let base;
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbtest-'));
before(async () => {
  app = createApp({ env: { CHAT_OPEN: '1', ACCOUNTS_OPEN: '1', PORT: '0', LORE_WORKER: 'off', DB_FILE: path.join(dir, 'h.db'), PUBLIC_ORIGIN: 'http://localhost:3000' }, rpc, fetchImpl: fakeFetch, log: () => {} });
  seed(app.db);
  app.settings.set('areas', { chat: true, accounts: true }); // the admin panel opens what the server allows
  const a = await app.listen(0); base = `http://127.0.0.1:${a.port}`;
  await app.feeds.tick(); // the feed timer's first pass, awaited: requests read the cache only
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client(at, db = app?.db) {
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch((at || base) + p, { method, headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000', host: 'localhost:3000', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await res.json().catch(() => ({}));
    return { ...j, status: res.status, body: j, _h: res.headers };
  };
  return { call, get cookie() { return cookie; }, async signIn(uid, name, { adult = true } = {}) {
    plantUser(db, uid, { adult }); cookie = sessionFor(db, uid);
    if (name) { const r = await call('POST', '/api/me/name', { name }); assert.equal(r.status, 200, JSON.stringify(r)); }
    return { status: 200 };
  } };
}

test('security headers and CSRF guard', async () => {
  const r = await fetch(base + '/api/state');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const noHeader = await fetch(base + '/api/ideas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const cross = await fetch(base + '/api/ideas', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(cross.status, 403);
  const trav = await fetch(base + '/..%2f..%2fpackage.json'); assert.notEqual(trav.status, 200, 'path traversal');
  const s = await (await fetch(base + '/api/state')).json();
  assert.equal(s.stats.price, 0.0004); assert.equal(s.stats.change24h, 5.2); assert.equal(s.me, null);
  assert.ok(s.rooms.find((r) => r.id === 'builds'));
});

test('public JSON that is the same for everyone carries an ETag and answers 304; personal JSON is no-store', async () => {
  const r = await fetch(base + '/api/allies');
  assert.equal(r.headers.get('cache-control'), 'no-cache'); const tag = r.headers.get('etag'); assert.match(tag, /^"[A-Za-z0-9_-]{22}"$/);
  const again = await fetch(base + '/api/allies', { headers: { 'if-none-match': tag } }); assert.equal(again.status, 304);
  const chart = await fetch(base + '/api/chart'); assert.ok(chart.headers.get('etag'));
  const state = await fetch(base + '/api/state'); assert.equal(state.headers.get('cache-control'), 'no-store'); assert.equal(state.headers.get('etag'), null);
  const st = await state.json();
  assert.ok(st.stats.feeds.market.at > 0 && st.stats.feeds.market.ttl === 60_000, 'market freshness: ' + JSON.stringify(st.stats.feeds.market));
  assert.equal(st.stats.feeds.holders.ttl, 15 * 60_000);
});

test('static site: hashed asset names are immutable, plain names short-cached, html revalidated, 404 for unknown', async () => {
  const html = await (await fetch(base + '/')).text();
  const js = /src="(\/js\/app\.[0-9a-f]{10}\.js)"/.exec(html)?.[1]; assert.ok(js, 'hashed script name in html');
  const css = /href="(\/css\/app\.[0-9a-f]{10}\.css)"/.exec(html)?.[1]; assert.ok(css, 'hashed stylesheet in html');
  assert.ok(/srcset="\/img\/summit-wide-640\.[0-9a-f]{10}\.avif 640w/.test(html), 'responsive hero sources hashed');
  await app.assets.ready; // brotli is made off the main thread right after the build (gzip is served until then)
  const r = await fetch(base + js, { headers: { 'accept-encoding': 'br' } });
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable'); assert.equal(r.headers.get('content-encoding'), 'br'); assert.equal(r.headers.get('vary'), 'Accept-Encoding');
  const src = await r.text(); assert.ok(/from '\.\/ui\.[0-9a-f]{10}\.js'/.test(src), 'module imports rewritten to hashed names');
  for (const m of src.matchAll(/from '(\.\/[a-z]+\.[0-9a-f]{10}\.js)'/g)) assert.equal((await fetch(base + '/js/' + m[1].slice(2))).status, 200, m[1]);
  const plain = await fetch(base + '/js/app.js'); assert.equal(plain.headers.get('cache-control'), 'public, max-age=300');
  const idx = await fetch(base + '/'); assert.equal(idx.headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(base + '/', { headers: { 'if-none-match': idx.headers.get('etag') } })).status, 304);
  assert.equal((await fetch(base + '/#/learn')).status, 200); assert.equal((await fetch(base + '/learn')).status, 404, 'the page lives at / only; every route is a hash route');
  assert.equal((await fetch(base + '/js/nope.js')).status, 404); assert.equal((await fetch(base + '/lib/app.js')).status, 404);
});

test('a session: the name rules, what the account sees of itself, what nobody else sees', async () => {
  const c = client(); await c.signIn(READER);
  const name = await c.call('POST', '/api/me/name', { name: 'Satoshi' });
  assert.equal(name.status, 422);
  assert.equal((await c.call('POST', '/api/me/name', { name: 'readerbull' })).status, 200);
  const st = await c.call('GET', '/api/state');
  assert.equal(st.me.name, 'readerbull');
  assert.deepEqual(Object.keys(st.me).sort(), ['adult', 'hasPassword', 'muted', 'name', 'newUntil', 'unread', 'username', 'x'], 'nothing else about the account: ' + JSON.stringify(st.me));
  const pub = await client().call('GET', '/api/state');
  assert.equal(pub.me, null); assert.ok(!JSON.stringify(pub).includes(READER), 'nobody else sees the account id');
});

test('chat: post, react, reply notifications, doxing blocked, builds room exists', async () => {
  const a = client(); await a.signIn(MAKER, 'emberhoof');
  const b = client(); await b.signIn(READER);
  const m = await a.call('POST', '/api/rooms/builds/messages', { body: 'Shipping a block-time bot tonight' });
  assert.equal(m.status, 200);
  const dox = await a.call('POST', '/api/rooms/general/messages', { body: 'he lives at 1234 N Elm Street' });
  assert.equal(dox.status, 422);
  await new Promise((r) => setTimeout(r, 2100));
  const reply = await b.call('POST', '/api/rooms/builds/messages', { body: 'nice, ship it', reply_to: m.message.id });
  assert.equal(reply.status, 200); assert.equal(reply.message.reply.name, 'emberhoof');
  const rx = await b.call('POST', `/api/messages/${m.message.id}/react`, { emoji: '🔥' });
  assert.equal(rx.message.reactions.find((x) => x.e === '🔥').n, 1);
  const inbox = await a.call('GET', '/api/inbox');
  assert.ok(inbox.items.some((i) => i.kind === 'reply'));
  const list = await client().call('GET', '/api/rooms/builds/messages');
  assert.ok(list.messages.some((x) => x.body.includes('block-time bot')));
  assert.ok(list.messages.every((x) => Object.keys(x.author).every((k) => ['name', 'avatar', 'x', 'herd'].includes(k))), 'no ids in chat payloads: ' + JSON.stringify(list.messages[0]?.author));
  assert.ok(!JSON.stringify(list).includes(MAKER) && !JSON.stringify(list).includes(READER), 'no account id anywhere in the room');
});

test('rooms: the two rooms exist; a room that does not is the plain 404 whatever the switches say', async () => {
  assert.equal((await client().call('GET', '/api/rooms/general/messages')).status, 200);
  assert.equal((await client().call('GET', '/api/rooms/builds/messages')).status, 200);
  for (const room of ['million', 'vip', 'nope']) { const r = await client().call('GET', `/api/rooms/${room}/messages`); assert.equal(r.status, 404, room); assert.deepEqual(r.body, { error: 'Not found' }); }
  const c = client(); await c.signIn(RICH, 'quietbull');
  assert.equal((await c.call('POST', '/api/rooms/million/messages', { body: 'hello?' })).status, 404);
});

test('build: ideas and votes', async () => {
  const s = client(); await s.signIn(MAKER);
  const b = client(); await b.signIn(READER);
  const idea = await s.call('POST', '/api/ideas', { title: 'Fog mode screensaver', body: 'A screensaver of the ridge.' });
  assert.equal(idea.status, 200);
  assert.deepEqual(Object.keys(idea.idea).sort(), ['at', 'author', 'body', 'id', 'mine', 'title', 'voted', 'votes'], 'an idea carries nothing about a reward: ' + JSON.stringify(idea.idea));
  assert.equal((await s.call('POST', `/api/ideas/${idea.idea.id}/vote`)).status, 400, 'no self-votes');
  const v = await b.call('POST', `/api/ideas/${idea.idea.id}/vote`); assert.equal(v.idea.votes, 1);
  const inbox = await s.call('GET', '/api/inbox'); assert.ok(inbox.items.some((i) => i.kind === 'vote'), 'the author is told once');
  const again = await b.call('POST', `/api/ideas/${idea.idea.id}/vote`); assert.equal(again.idea.votes, 0, 'toggles off');
  const st = await client().call('GET', '/api/state'); assert.ok(st.alerts.some((x) => /New idea/.test(x.text)));
  const top = await client().call('GET', '/api/ideas?sort=top'); assert.ok(top.ideas.some((i) => i.id === idea.idea.id) && top.closes > Date.now());
  app.ops.hideIdea(idea.idea.id); // from the panel's queue
  assert.ok(!(await client().call('GET', '/api/ideas')).ideas.some((i) => i.id === idea.idea.id), 'hidden from the board');
  assert.throws(() => app.ops.hideIdea('constructor'), /No such idea/);
});

test('launch default: everything but the dashboard is "coming soon" to the public', async () => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbsoon-'));
  const a = createApp({ env: { PORT: '0', LORE_WORKER: 'off', DB_FILE: path.join(d, 'h.db'), PUBLIC_ORIGIN: 'http://localhost:3000' }, rpc, fetchImpl: fakeFetch, log: () => {} });
  seed(a.db, { demo: true });
  const ad = await a.listen(0); const at = `http://127.0.0.1:${ad.port}`;
  try {
  const anon = client(at, a.db);
  const st = await anon.call('GET', '/api/state');
  assert.deepEqual(st.features, { chat: false, accounts: false, ideas: false });
  assert.ok(!('intro' in st)); assert.deepEqual(st.story, { title: '', body: '' });
  // the panel switches alone open nothing: the server setting is the ceiling
  a.settings.set('areas', { chat: true, accounts: true });
  assert.deepEqual((await anon.call('GET', '/api/state')).features, { chat: false, accounts: false, ideas: false });
  a.settings.set('areas', { chat: false, accounts: false });
  assert.deepEqual(st.rooms.map((r) => r.id), ['general', 'builds']);
  assert.equal(st.counts.ideas, 0);
  assert.ok(!st.alerts.some((x) => ['idea', 'vote', 'message'].includes(x.kind)), 'no alerts for closed areas: ' + JSON.stringify(st.alerts));
  for (const p of ['/api/rooms/general/messages', '/api/ideas', '/api/inbox']) assert.equal((await anon.call('GET', p)).status, 503, p);
  // dashboard data stays open
  for (const p of ['/api/state', '/api/chart', '/api/allies', '/api/lore']) assert.equal((await anon.call('GET', p)).status, 200, p);
  // accounts open (server flag + panel switch), chat still closed: a member signs in and the closed area stays closed to them too
  a.config.accountsOpen = true; a.settings.set('areas', { chat: false, accounts: true });
  const member = client(at, a.db); await member.signIn(OTHER, 'herdkeeper');
  assert.equal((await member.call('GET', '/api/rooms/general/messages')).status, 503);
  assert.equal((await member.call('GET', '/api/ideas')).status, 200, 'ideas come with accounts');
  const m = await member.call('POST', '/api/rooms/general/messages', { body: 'testing before launch' });
  assert.equal(m.status, 503, JSON.stringify(m));
  } finally { await a.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('links migration: an Instagram link from an older install is removed once, nothing else is touched', async () => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbmig-'));
  const file = path.join(d, 'h.db');
  const a0 = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: file }, rpc, fetchImpl: fakeFetch, log: () => {} });
  seed(a0.db);
  a0.db.run('INSERT INTO allies(title,url,blurb,sort) VALUES(?,?,?,?)', 'Instagram', 'https://www.Instagram.com/someone/', 'old', 4);
  a0.db.run("INSERT OR REPLACE INTO kv(k,v) VALUES('allies_rev','3')");
  const n0 = a0.db.get('SELECT COUNT(*) n FROM allies').n; a0.db.close();
  const a1 = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: file }, rpc, fetchImpl: fakeFetch, log: () => {} });
  try {
    assert.equal(a1.db.get("SELECT COUNT(*) n FROM allies WHERE url LIKE '%nstagram%'").n, 0, 'gone');
    assert.equal(a1.db.get('SELECT COUNT(*) n FROM allies').n, n0 - 1, 'only that row');
    assert.equal(a1.db.get("SELECT v FROM kv WHERE k='allies_rev'").v, '6', 'the chain runs on to the latest rev in one start ');
    assert.ok(!ALLIES.some(([, u]) => /instagram/i.test(u)) && !LINK_WORDING.some(([u]) => /instagram/i.test(u)), 'not seeded anymore');
  } finally { a1.db.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('staked: read from the stakethebull pool account; 24h and 7-day change from our own hourly snapshots', async () => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbstake-'));
  const PROG = '4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT';
  const [pool] = findProgramAddress([new TextEncoder().encode('pool')], PROG);
  let staked = 52_000_000_000_000n; let prog = PROG; let asked = null;
  const srpc = async (method, params) => {
    if (method === 'getAccountInfo') { asked = params[0]; const b = Buffer.alloc(237); b.writeBigUInt64LE(staked, 104); b.writeBigUInt64LE(169n, 120); return { value: { owner: prog, data: [b.toString('base64'), 'base64'] } }; }
    if (method === 'getTokenSupply') return { value: { uiAmount: 1_000_000_000 } };
    return rpc(method, params);
  };
  const a = createApp({ env: { PORT: '0', LORE_WORKER: 'off', DB_FILE: path.join(d, 'h.db') }, rpc: srpc, fetchImpl: fakeFetch, log: () => {} });
  try {
    a.db.run('INSERT INTO staked_hist(at,amount) VALUES(?,?)', Date.now() - 24 * 3600_000, 50_000_000);
    a.db.run('INSERT INTO staked_hist(at,amount) VALUES(?,?)', Date.now() - 7 * 86400_000 - 1800_000, 40_000_000); // a week ago (within the 8 days kept)
    const s = await a.feeds.staked();
    assert.equal(asked, pool, 'reads the pool account');
    assert.equal(s.amount, 52_000_000); assert.equal(s.stakes, 169); assert.equal(s.pct.toFixed(1), '5.2');
    assert.equal(s.change24h.toFixed(1), '4.0');
    assert.equal(s.change7d.toFixed(1), '30.0', 'the 7-day change from the snapshot nearest a week ago');
    a.feeds._cache.clear(); prog = '11111111111111111111111111111111';
    assert.equal(await a.feeds.staked(), null, 'refuses an account the staking program does not own');
  } finally { await a.close?.(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('chart: hourly closes oldest first, junk dropped, wrong token refused, empty when down', async () => {
  const mk = (mint, list) => async (url) => {
    const u = String(url);
    const body = u.includes('geckoterminal') ? (list === 'down' ? null : { data: { attributes: { ohlcv_list: list } }, meta: { base: { address: mint } } })
      : u.includes('dexscreener') ? { pairs: [{ baseToken: { address: TBB_MINT }, priceUsd: '0.008', priceChange: { h24: 1 }, liquidity: { usd: 1 }, pairAddress: '6unnG2hL8udPjDpu3TchvAtptu3dq8AS7tymrWDN2LLC' }] } : { USD: 1 };
    return body ? new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('no', { status: 502 });
  };
  const run = async (fetchImpl) => {
    const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbchart-'));
    const a = createApp({ env: { PORT: '0', LORE_WORKER: 'off', DB_FILE: path.join(d, 'h.db') }, rpc, fetchImpl, log: () => {} });
    const ad = await a.listen(0); await a.feeds.tick();
    try { return (await (await fetch(`http://127.0.0.1:${ad.port}/api/chart`)).json()).points; } finally { await a.close(); fs.rmSync(d, { recursive: true, force: true }); }
  };
  const good = await run(mk(TBB_MINT, [[300, 0, 0, 0, 0.03, 1], [100, 0, 0, 0, 0.01, 1], [200, 0, 0, 0, 'x', 1], [250, 0, 0, 0, 0.02, 1]]));
  assert.deepEqual(good, [[100, 0.01], [250, 0.02], [300, 0.03]]);
  assert.deepEqual(await run(mk('SomeOtherMint1111111111111111111111111111111', [[1, 0, 0, 0, 1, 1], [2, 0, 0, 0, 2, 1]])), [], 'other token refused');
  assert.deepEqual(await run(mk(TBB_MINT, 'down')), [], 'source down');
});

test('text responses are compressed; fonts are sent as-is', async () => {
  const js = await fetch(base + '/js/views.js', { headers: { 'accept-encoding': 'br, gzip' } });
  assert.equal(js.headers.get('content-encoding'), 'br');
  assert.ok((await js.text()).includes('export const VIEWS'));
  const font = await fetch(base + '/fonts/jbmono.woff', { headers: { 'accept-encoding': 'br, gzip' } });
  assert.equal(font.headers.get('content-encoding'), null);
});

test('review fixes: hardening against the findings of the server review', async () => {
  const ad = client(); await ad.signIn(OTHER, 'herdkeeper');
  // malformed cookie / path / origin → clean 4xx, never 500
  assert.equal((await fetch(base + '/api/state', { headers: { cookie: '_ga=%E0%A4%A' } })).status, 200);
  assert.equal((await fetch(base + '/api/rooms/%E0/messages')).status, 400);
  const nul = await fetch(base + '/api/report', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: 'null' }, body: '{"kind":"problem","reason":"x"}' });
  assert.equal(nul.status, 403);
  // foreign origin and foreign Host are refused
  const foreign = await fetch(base + '/api/report', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://attacker.invalid' }, body: '{"kind":"problem","reason":"x"}' });
  assert.equal(foreign.status, 403);
  // links must be https, no user@host tricks, no local addresses (the panel's link form and every stored link go through safeUrl)
  for (const url of ['http://example.com', 'https://dexscreener.com@evil.example/', 'https://127.0.0.1:3000/', 'javascript:alert(1)']) assert.throws(() => safeUrl(url), /https/, url);
  // avatars are keyed by a server secret, not a plain hash of the account id
  const plain = crypto.createHash('sha256').update('av:' + OTHER).digest('hex').slice(0, 16);
  const m = await ad.call('POST', '/api/rooms/general/messages', { body: 'hello herd' });
  assert.equal(m.status, 200, JSON.stringify(m)); assert.notEqual(m.message.author.avatar, plain);
  // a body larger than the one cap is refused before it is read: there is no route that takes more
  const big = await fetch(base + '/api/ideas', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000', cookie: ad.cookie }, body: JSON.stringify({ title: 'x', body: 'y'.repeat(70_000) }) });
  assert.equal(big.status, 413);
});

test('closed areas never leak over the live stream or the counts', async () => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbsse-'));
  const a = createApp({ env: { PORT: '0', LORE_WORKER: 'off', DB_FILE: path.join(d, 'h.db'), PUBLIC_ORIGIN: 'http://localhost:3000' }, rpc, fetchImpl: fakeFetch, log: () => {} });
  const ad0 = await a.listen(0); const at = `http://127.0.0.1:${ad0.port}`;
  const ctl = new AbortController(); const got = [];
  const es = await fetch(at + '/api/stream', { signal: ctl.signal });
  (async () => { try { for await (const c of es.body) got.push(Buffer.from(c).toString()); } catch { /* aborted */ } })();
  // accounts open, chat still closed: nobody can post there (no account is above a closed area), and a row the table
  // holds from before the area closed reaches neither the stream nor the public counts
  a.config.accountsOpen = true; a.settings.set('areas', { chat: false, accounts: true });
  const member = client(at, a.db); await member.signIn(OTHER, 'herdkeeper');
  const m = await member.call('POST', '/api/rooms/general/messages', { body: 'SECRET message, not public yet' }); assert.equal(m.status, 503, JSON.stringify(m));
  a.db.run('INSERT INTO messages(room,uid,body,created_at) VALUES(?,?,?,?)', 'general', OTHER, 'SECRET row from before', Date.now());
  await new Promise((r) => setTimeout(r, 300));
  ctl.abort();
  const all = got.join('');
  assert.ok(all.includes('event: hello'), 'stream connected');
  assert.ok(!all.includes('SECRET'), 'nothing from closed areas: ' + all);
  const st = await (await fetch(at + '/api/state')).json();
  assert.equal(st.counts.newToday, 0); assert.ok(!JSON.stringify(st).includes('SECRET'));
  assert.equal((await fetch(at + '/api/stream', { method: 'POST' })).status, 405);
  await a.close(); fs.rmSync(d, { recursive: true, force: true });
});

test('season: only totals from the creator\'s board; other tokens and junk refused; never a full address', async () => {
  const board = { mint: '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump', season: { start: 1791244200000, end: 1793836200000, overtimeHours: 0, prizeTbb: 4206900, stakeApr: 0.08 }, totals: { buyers: 308, buys: 789, volumeUsd: 187421.07 }, leaderboard: [{ wallet: 'TestWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAone', score: 10044.14, profile: { username: 'someone' } }, { wallet: 'not an address', score: 5 }] };
  const mk = (body) => async (url) => new Response(JSON.stringify(String(url).endsWith('/api/board') ? body : {}), { status: 200, headers: { 'content-type': 'application/json' } });
  const run = async (body, env = {}) => {
    const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbseason-'));
    const a = createApp({ env: { PORT: '0', LORE_WORKER: 'off', DB_FILE: path.join(d, 'h.db'), ...env }, rpc, fetchImpl: mk(body), log: () => {} });
    try { return await a.feeds.season(); } finally { await a.close?.(); fs.rmSync(d, { recursive: true, force: true }); }
  };
  const s = await run(board);
  assert.equal(s.buyers, 308); assert.equal(s.buys, 789); assert.equal(s.end, 1793836200000);
  assert.ok(!JSON.stringify(s).includes('TestWa11etAAAA') && !JSON.stringify(s).includes('someone'), 'no full addresses or names kept');
  assert.deepEqual(s.top, [{ rank: 1, label: 'Test…Aone', score: 10044.14 }], 'top: shortened, junk dropped');
  assert.equal(await run({ ...board, mint: 'SomeOtherMint1111111111111111111111111111111' }), null, 'other token refused');
  assert.equal(await run({ ...board, season: { start: 5, end: 1 } }), null, 'bad dates refused');
  const ev = await run(board, { SEASON_BOARD_URL: 'http://evil.example/' });
  assert.equal(ev.url, 'https://tbb-buyer-board.garden-equity-field-0042.workers.dev/', 'non-https override ignored');
  for (const bad of ['https://127.0.0.1/', 'https://169.254.169.254/', 'https://localhost:3000/', 'https://a\\b/', 'https://u:p@x.example/', 'https://x.example/path/'])
    assert.equal((await run(board, { SEASON_BOARD_URL: bad })).url, 'https://tbb-buyer-board.garden-equity-field-0042.workers.dev/', 'refused: ' + bad);
  // An address sent as an array/object/number must not slip a full value past the shortening.
  const full = 'TestWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAone';
  const odd = await run({ ...board, leaderboard: [{ wallet: [full], score: 9 }, { wallet: { toString: full }, score: 8 }, { wallet: full, score: 6 }] });
  assert.ok(!JSON.stringify(odd.top).includes(full), 'full address leaked: ' + JSON.stringify(odd.top));
  assert.deepEqual(odd.top.map((t) => t.label), ['Test…Aone']);
});

test('security review follow-ups: crash-free bodies, real IPv6 grouping, private inbox nudges, proxy setting required', async () => {
  const { v6prefix } = await import('../../lib/app.js');
  assert.equal(v6prefix('2001:db8::1'), v6prefix('2001:db8::2'), 'same /64 = same visitor');
  assert.equal(v6prefix('2001:db8::1'), v6prefix('2001:db8:0:0:9:9:9:9'));
  assert.notEqual(v6prefix('2001:db8:0:1::1'), v6prefix('2001:db8:0:2::1'));
  // {"toString":1} style bodies: a clean 400, never a 500
  for (const [p, body] of [['/api/report', { kind: 'problem', reason: 'hi', target: { valueOf: 1 } }], ['/api/report', { kind: { toString: 1 }, reason: 'hi' }]]) {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000', host: 'localhost:3000' }, body: JSON.stringify(body) });
    assert.equal(r.status, 400, p);
  }
  // a public site must say how many proxies are in front, or every visitor would share one rate limit
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbpx-'));
  const env = { PORT: '0', LORE_WORKER: 'off', DB_FILE: path.join(d, 'h.db'), PUBLIC_ORIGIN: 'https://hub.example' };
  assert.throws(() => createApp({ env, rpc, fetchImpl: fakeFetch, log: () => {} }), /TRUST_PROXY/);
  const ok = createApp({ env: { ...env, TRUST_PROXY: '1' }, rpc, fetchImpl: fakeFetch, log: () => {} }); await ok.close?.();
  fs.rmSync(d, { recursive: true, force: true });
  // inbox nudges go only to that account's own stream, never to anonymous visitors
  const ctl = new AbortController(); const got = [];
  const es = await fetch(base + '/api/stream', { signal: ctl.signal, headers: { host: 'localhost:3000' } });
  (async () => { try { for await (const c of es.body) got.push(Buffer.from(c).toString()); } catch { /* aborted */ } })();
  await new Promise((r) => setTimeout(r, 150));
  app.notify(MAKER, 'test', 'private thing', '#/inbox');
  await new Promise((r) => setTimeout(r, 200)); ctl.abort();
  assert.ok(got.join('').includes('event: hello') && !got.join('').includes('event: inbox'), 'anonymous stream got an inbox nudge');
});

test('RPC: an oversized answer is cut off early, not read into memory, and not retried', async () => {
  const { makeRpc } = await import('../../lib/solana.js');
  let pulled = 0; let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(new ReadableStream({ pull(c) { pulled += 65536; if (pulled > 64 * 1024 * 1024) return c.close(); c.enqueue(new Uint8Array(65536)); } }), { status: 200 }); };
  await assert.rejects(makeRpc('https://rpc.example', { fetchImpl, minGapMs: 0 })('getSlot'), /too large/);
  assert.equal(calls, 1, 'no retries'); assert.ok(pulled < 6 * 1024 * 1024, 'read ' + pulled);
});
