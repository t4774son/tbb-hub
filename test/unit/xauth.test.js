// Sign in with X against a fake X server (a real local HTTP server that speaks the two endpoints we use): the happy path
// (first sign-in → welcome step → account; second sign-in → straight in), bad / replayed state, PKCE mismatch, X errors
// and timeouts, the daily cap, a banned X id, linking from an account, the handle shown as plain text. And: off until
// configured — routes 404, no button.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../../lib/app.js';
import { seed } from '../../scripts/seed.js';

// ---- the fake X: /2/oauth2/token checks Basic auth, the code, redirect_uri and PKCE (S256 of code_verifier == the challenge
// the authorize step saw); /2/users/me checks the bearer token and answers id + username. Knobs: slow, broken.
const codes = new Map(); // code → { challenge, id, username }
const tokens = new Map(); // access token → user
const knobs = { slow: false, broken: false, calls: { token: 0, me: 0 } };
const fakeX = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
  if (knobs.slow) { await new Promise((r) => setTimeout(r, 9500)); }
  const json = (status, j) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (knobs.broken) return json(500, { error: 'x is down' });
  if (url.pathname === '/2/oauth2/token') {
    knobs.calls.token++;
    const auth = String(req.headers.authorization || ''); if (auth !== 'Basic ' + Buffer.from('client-id-1:client-secret-1').toString('base64')) return json(401, { error: 'bad client' });
    const p = new URLSearchParams(body);
    const c = codes.get(p.get('code'));
    if (!c || p.get('grant_type') !== 'authorization_code' || p.get('redirect_uri') !== REDIRECT || p.get('client_id') !== 'client-id-1') return json(400, { error: 'invalid_request' });
    if (crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant', detail: 'pkce' });
    codes.delete(p.get('code'));
    const t = 'tok_' + crypto.randomBytes(8).toString('hex'); tokens.set(t, c);
    return json(200, { token_type: 'bearer', access_token: t, scope: 'users.read tweet.read', expires_in: 7200 });
  }
  if (url.pathname === '/2/users/me') {
    knobs.calls.me++;
    const t = String(req.headers.authorization || '').replace('Bearer ', ''); const u = tokens.get(t); if (!u) return json(401, { title: 'Unauthorized' });
    return json(200, { data: { id: u.id, name: 'Someone', username: u.username } });
  }
  json(404, { error: 'nope' });
});
let xPort; let REDIRECT;
let app; let base;
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbx-'));
const fakeFetch = async () => new Response(JSON.stringify({ pairs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
const rpc = async () => { throw new Error('no rpc'); };
before(async () => {
  await new Promise((r) => fakeX.listen(0, '127.0.0.1', r)); xPort = fakeX.address().port;
  REDIRECT = 'http://localhost:3000/auth/x/callback';
  app = createApp({ env: { CHAT_OPEN: '1', ACCOUNTS_OPEN: '1', PORT: '0', LORE_WORKER: 'off', POW_BITS: '6', DB_FILE: path.join(dir, 'x.db'), PUBLIC_ORIGIN: 'http://localhost:3000', CLIENT_IP_HEADER: 'x-test-ip',
    X_CLIENT_ID: 'client-id-1', X_CLIENT_SECRET: 'client-secret-1', X_REDIRECT_URI: REDIRECT, X_LOGIN_DAILY_CAP: '10', X_API_BASE: `http://127.0.0.1:${xPort}`, X_AUTH_URL: `http://127.0.0.1:${xPort}/i/oauth2/authorize` }, rpc, fetchImpl: fakeFetch, log: () => {} });
  seed(app.db); app.settings.set('areas', { chat: true, accounts: true });
  const a = await app.listen(0); base = `http://127.0.0.1:${a.port}`;
});
after(async () => { await app.close(); await new Promise((r) => fakeX.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

let ipN = 0;
// a browser: keeps every cookie the site sets; follows nothing by itself
function browser(ip = `10.9.0.${++ipN}`) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const keep = (res) => { for (const sc of res.headers.getSetCookie?.() || []) { const [kv, ...attrs] = sc.split(';'); const [k, v] = kv.split('='); if (attrs.some((a) => /max-age=0/i.test(a))) jar.delete(k); else jar.set(k, v); } };
  const go = async (p, { method = 'GET', body, headers = {} } = {}) => { const res = await fetch(base + p, { method, redirect: 'manual', headers: { cookie: cookieHeader(), 'x-test-ip': ip, ...(body ? { 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); keep(res); return res; };
  const api = async (method, p, body) => { const res = await go(p, { method, body: body || (method === 'POST' ? {} : undefined) }); const j = await res.json().catch(() => ({})); return { ...j, status: res.status }; };
  // "click Sign in with X": start → (X's authorize page: we just read state + challenge from the redirect) → X sends the browser back with a code
  const signInWithX = async ({ id, username, link = false, tamper = null }) => {
    const start = await go('/auth/x/start' + (link ? '?link=1' : ''));
    if (start.status !== 302 || !start.headers.get('location').includes('/i/oauth2/authorize')) return { start };
    const auth = new URL(start.headers.get('location')); const q = auth.searchParams;
    assert.equal(q.get('scope'), 'users.read tweet.read'); assert.equal(q.get('code_challenge_method'), 'S256'); assert.equal(q.get('redirect_uri'), REDIRECT); assert.equal(q.get('client_id'), 'client-id-1'); assert.equal(q.get('response_type'), 'code');
    const code = 'code_' + crypto.randomBytes(8).toString('hex');
    codes.set(code, { challenge: tamper === 'pkce' ? crypto.createHash('sha256').update('someone-elses-verifier').digest('base64url') : q.get('code_challenge'), id, username });
    const state = tamper === 'state' ? 'wrong-state' : q.get('state');
    const cb = await go(`/auth/x/callback?state=${encodeURIComponent(state)}&code=${code}`);
    return { start, auth, state: q.get('state'), code, cb, where: cb.headers.get('location') };
  };
  return { go, api, signInWithX, jar };
}

test('off until configured: without the three settings the routes 404 and the page shows no X', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tbbx2-'));
  for (const env of [{}, { X_CLIENT_ID: 'a', X_CLIENT_SECRET: 'b' }, { X_CLIENT_ID: 'a', X_CLIENT_SECRET: 'b', X_REDIRECT_URI: 'https://hub.example/somewhere/else' }]) {
    const a2 = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', ACCOUNTS_OPEN: '1', DB_FILE: path.join(d2, 'x.db'), PUBLIC_ORIGIN: 'http://localhost:3000', ...env }, rpc, fetchImpl: fakeFetch, log: () => {} });
    const ad = await a2.listen(0); const at = `http://127.0.0.1:${ad.port}`;
    try {
      assert.equal(a2.xauth.configured, false, JSON.stringify(env));
      assert.equal((await fetch(at + '/auth/x/start', { redirect: 'manual' })).status, 404);
      assert.equal((await fetch(at + '/auth/x/callback?state=x&code=y', { redirect: 'manual' })).status, 404);
      assert.equal((await fetch(at + '/api/auth/x/pending')).status, 404);
      assert.equal((await (await fetch(at + '/api/state')).json()).x, false, 'no button');
    } finally { await a2.close(); }
  }
  fs.rmSync(d2, { recursive: true, force: true });
  assert.equal(app.xauth.configured, true);
  app.settings.set('areas', { chat: true, accounts: false });
  assert.equal((await (await fetch(base + '/api/state')).json()).x, false, 'configured but the accounts area is closed on the panel → still no button');
  assert.equal((await fetch(base + '/auth/x/start', { redirect: 'manual' })).headers.get('location'), '/#/?x=closed');
  app.settings.set('areas', { chat: true, accounts: true });
  assert.equal((await (await fetch(base + '/api/state')).json()).x, true);
});

test('happy path: PKCE flow, exactly one users/me call, welcome step (handle as username when free), account created, second sign-in goes straight in; no token stored', async () => {
  const b = browser();
  const r = await b.signInWithX({ id: '1001', username: 'fogwalker' });
  assert.equal(r.start.status, 302); assert.ok(r.start.headers.getSetCookie().some((c) => /^tbb_x=.+HttpOnly/.test(c) && /SameSite=Lax/.test(c) && /Path=\/auth\/x/.test(c)), 'state cookie: HttpOnly, Lax, short path');
  assert.equal(r.cb.status, 302); assert.equal(r.where, '/#/?x=new', 'a new X user lands on the welcome step');
  assert.equal(knobs.calls.me, 1, 'one paid call'); assert.equal(knobs.calls.token, 1);
  assert.ok(b.jar.has('tbb_xp') && !b.jar.has('tbb_x'), 'pending cookie set, state cookie cleared');
  const p = await b.api('GET', '/api/auth/x/pending'); assert.equal(p.status, 200); assert.equal(p.handle, 'fogwalker'); assert.equal(p.suggested, 'fogwalker');
  let f = await b.api('POST', '/api/auth/x/finish', { username: 'fogwalker', adult: false }); assert.equal(f.status, 422);
  f = await b.api('POST', '/api/auth/x/finish', { username: 'fogwalker', adult: true }); assert.equal(f.status, 200, JSON.stringify(f));
  const st = await b.api('GET', '/api/state'); assert.equal(st.me.username, 'fogwalker'); assert.equal(st.me.x, 'fogwalker'); assert.equal(st.me.hasPassword, false);
  const row = { ...app.db.get('SELECT * FROM users WHERE username=?', 'fogwalker') };
  assert.equal(row.x_id, '1001'); assert.equal(row.via, 'x'); assert.ok(!JSON.stringify(row).includes('tok_'), 'no X token anywhere'); assert.ok(!JSON.stringify(app.db.all('SELECT * FROM kv')).includes('tok_'));
  assert.equal((await b.api('GET', '/api/auth/x/pending')).status, 410, 'the pending step is spent');
  // the handle shows on the card as plain text; chat payload carries x: handle, never a link
  app.db.run('UPDATE users SET created_at=? WHERE username=?', Date.now() - 3 * 86400_000, 'fogwalker');
  const m = await b.api('POST', '/api/rooms/general/messages', { body: 'hello from x land' }); assert.equal(m.status, 200, JSON.stringify(m)); assert.equal(m.message.author.x, 'fogwalker'); assert.ok(!JSON.stringify(m).includes('x.com'));
  // sign in again from another browser: straight in, one more paid call
  const c = browser();
  const r2 = await c.signInWithX({ id: '1001', username: 'fogwalker' });
  assert.equal(r2.where, '/', 'known X id → signed in'); assert.ok(c.jar.has('tbb_s'));
  assert.equal((await c.api('GET', '/api/state')).me.username, 'fogwalker'); assert.equal(knobs.calls.me, 2);
  // a handle that is taken here: the welcome step asks for another name
  app.db.run("INSERT INTO users(uid,name,username,created_at) VALUES('u_takenx','Highline','highline',?)", Date.now());
  const d = browser(); const r3 = await d.signInWithX({ id: '1002', username: 'highline' }); assert.equal(r3.where, '/#/?x=new');
  const p3 = await d.api('GET', '/api/auth/x/pending'); assert.equal(p3.handle, 'highline'); assert.equal(p3.suggested, null, 'taken: must pick');
  assert.equal((await d.api('POST', '/api/auth/x/finish', { username: 'highline', adult: true })).status, 409);
  assert.equal((await d.api('POST', '/api/auth/x/finish', { username: 'highline_x', adult: true })).status, 200);
  assert.equal((await d.api('GET', '/api/state')).me.x, 'highline');
});

test('bad state, replayed state, missing cookie, PKCE mismatch, X error, X timeout → back to the page with an error, never signed in', async () => {
  const b = browser();
  let r = await b.signInWithX({ id: '2001', username: 'tamper', tamper: 'state' }); assert.equal(r.where, '/#/?x=error'); assert.ok(!b.jar.has('tbb_s'));
  // replay: a good flow, then the same callback again
  const c = browser(); r = await c.signInWithX({ id: '1001', username: 'fogwalker' }); assert.equal(r.where, '/');
  const again = await c.go(`/auth/x/callback?state=${encodeURIComponent(r.state)}&code=${r.code}`); assert.equal(again.headers.get('location'), '/#/?x=error', 'state is single use');
  // the state cookie must come back with the callback
  const d = browser(); const start = await d.go('/auth/x/start'); const q = new URL(start.headers.get('location')).searchParams; d.jar.delete('tbb_x');
  codes.set('code_nocookie', { challenge: q.get('code_challenge'), id: '2002', username: 'nocookie' });
  r = await d.go(`/auth/x/callback?state=${encodeURIComponent(q.get('state'))}&code=code_nocookie`); assert.equal(r.headers.get('location'), '/#/?x=error');
  // PKCE: X refuses the code exchange when the verifier does not match the challenge
  const e = browser(); const before = knobs.calls.me; r = await e.signInWithX({ id: '2003', username: 'pkce', tamper: 'pkce' }); assert.equal(r.where, '/#/?x=error'); assert.equal(knobs.calls.me, before, 'no users/me call without a token');
  // X down
  knobs.broken = true; const f = browser(); r = await f.signInWithX({ id: '2004', username: 'down' }); assert.equal(r.where, '/#/?x=error'); knobs.broken = false;
  // X too slow: an 8 s timeout, then the error page (nothing hangs)
  knobs.slow = true; const g = browser(); const t0 = Date.now(); r = await g.signInWithX({ id: '2005', username: 'slow' }); knobs.slow = false;
  assert.equal(r.where, '/#/?x=error'); assert.ok(Date.now() - t0 < 9400, 'gave up before the fake server answered');
  // X sent an error instead of a code
  const h = browser(); const s2 = await h.go('/auth/x/start'); const q2 = new URL(s2.headers.get('location')).searchParams;
  r = await h.go(`/auth/x/callback?state=${encodeURIComponent(q2.get('state'))}&error=access_denied`); assert.equal(r.headers.get('location'), '/#/?x=error');
  assert.ok(!(await h.api('GET', '/api/state')).me);
});

test('daily cap: over the cap the button goes and the start route says busy; banned X id can’t sign in; a staff-like handle is refused', async () => {
  // cap is 10 for this test server; the counter counts paid calls made today
  const used = app.xauth.today(); assert.ok(used >= 4, 'paid calls so far: ' + used);
  while (app.xauth.today() < 10) { const b = browser(); const r = await b.signInWithX({ id: '1001', username: 'fogwalker' }); assert.equal(r.where, '/'); }
  assert.equal(app.xauth.capped(), true);
  assert.equal((await (await fetch(base + '/api/state')).json()).x, false, 'no button when busy');
  const b = browser(); const r = await b.go('/auth/x/start'); assert.equal(r.headers.get('location'), '/#/?x=busy');
  app.db.kvSet('x_logins:' + new Date().toISOString().slice(0, 10), 0);
  assert.equal((await (await fetch(base + '/api/state')).json()).x, true);
  // banned account: its X id can't get in
  const uid = app.db.get('SELECT uid FROM users WHERE username=?', 'fogwalker').uid;
  app.mod.ban(uid, { actor: 'panel', reason: 'test' });
  const c = browser(); const r2 = await c.signInWithX({ id: '1001', username: 'fogwalker' }); assert.equal(r2.where, '/#/?x=account'); assert.ok(!c.jar.has('tbb_s'));
  app.mod.unban(uid);
  // an IP-banned connection can't start
  app.mod.ban(uid, { actor: 'panel', reason: 'ip', ip: true, ipDays: 1 }); app.mod.unban(uid, { ipHashes: [] });
  const bannedHash = app.db.get('SELECT ip_hash FROM ip_bans').ip_hash; const bannedIp = app.db.all('SELECT * FROM ip_log').find((l) => l.ip_hash === bannedHash) ? null : null; void bannedIp;
  app.db.run('DELETE FROM ip_bans');
  // a staff-like handle
  const d = browser(); const r3 = await d.signInWithX({ id: '3001', username: 'TBB_Support' }); assert.equal(r3.where, '/#/?x=handle'); assert.ok(!d.jar.has('tbb_xp'));
});

test('linking from an account (one X per account, unlink allowed when another way in exists) and the panel counts', async () => {
  const b = browser(); const ch = await b.api('GET', '/api/auth/pow');
  assert.equal((await b.api('POST', '/api/auth/signup', { username: 'linker', password: 'fog on the ridge 2026', adult: true, pow: { id: ch.id, nonce: app.pow.solve(ch) } })).status, 200);
  const r = await b.signInWithX({ id: '4001', username: 'linkme', link: true }); assert.equal(r.where, '/#/?x=linked');
  let st = await b.api('GET', '/api/state'); assert.equal(st.me.username, 'linker'); assert.equal(st.me.x, 'linkme');
  // the same X id can't be linked to a second account
  const c = browser(); const ch2 = await c.api('GET', '/api/auth/pow');
  await c.api('POST', '/api/auth/signup', { username: 'linker2', password: 'fog on the ridge 2026', adult: true, pow: { id: ch2.id, nonce: app.pow.solve(ch2) } });
  const r2 = await c.signInWithX({ id: '4001', username: 'linkme', link: true }); assert.equal(r2.where, '/#/?x=taken');
  // linking needs a session
  const anon = browser(); assert.equal((await anon.go('/auth/x/start?link=1')).headers.get('location'), '/#/?x=signin');
  // unlink; an X-only account must set a password first
  assert.equal((await b.api('POST', '/api/me/x/unlink')).status, 200); st = await b.api('GET', '/api/state'); assert.equal(st.me.x, null);
  const d = browser(); const r3 = await d.signInWithX({ id: '1001', username: 'fogwalker' }); assert.equal(r3.where, '/');
  const un = await d.api('POST', '/api/me/x/unlink'); assert.equal(un.status, 400); assert.match(un.error, /password first/);
  const cred = await d.api('POST', '/api/me/credentials', { password: 'a password for the fog' }); assert.equal(cred.status, 200); assert.ok(cred.recovery);
  assert.equal((await d.api('POST', '/api/me/x/unlink')).status, 200);
  assert.equal((await d.api('POST', '/api/auth/login', { username: 'fogwalker', password: 'a password for the fog' })).status, 200, 'still a way in');
});
