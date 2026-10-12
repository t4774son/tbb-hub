// Username + password accounts on a real server: sign-up with the browser proof of work, the rules, sign-in that never
// says whether a username exists, throttling and the account cool-down, recovery codes, change password (other sessions
// end), sign out everywhere, the new-account slow start, and what still works for accounts from an older install.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../lib/app.js';
import { seed } from '../../scripts/seed.js';
import { newUid, plantUser, sessionFor } from './helpers.js';

const rpc = async (method) => { throw new Error('unexpected rpc ' + method); };
const fakeFetch = async () => new Response(JSON.stringify({ pairs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });

let app; let base;
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbacct-'));
before(async () => {
  app = createApp({ env: { CHAT_OPEN: '1', ACCOUNTS_OPEN: '1', PORT: '0', LORE_WORKER: 'off', POW_BITS: '6', DB_FILE: path.join(dir, 'a.db'), PUBLIC_ORIGIN: 'http://localhost:3000', CLIENT_IP_HEADER: 'x-test-ip' }, rpc, fetchImpl: fakeFetch, log: () => {} });
  seed(app.db);
  app.settings.set('areas', { chat: true, accounts: true });
  const a = await app.listen(0); base = `http://127.0.0.1:${a.port}`;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let ipN = 0;
function client({ ip = `10.1.${Math.floor(++ipN / 250)}.${ipN % 250}` } = {}) {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000', cookie, 'x-test-ip': ip, ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await res.json().catch(() => ({}));
    return { ...j, status: res.status, body: j, _h: res.headers };
  };
  const c = { call, ip, get cookie() { return cookie; }, set cookie(v) { cookie = v; },
    async pow() { const ch = await call('GET', '/api/auth/pow'); return { id: ch.id, nonce: app.pow.solve(ch) }; },
    async signup(username, password = 'fog on the ridge 2026', extra = {}) { return call('POST', '/api/auth/signup', { username, password, adult: true, pow: await c.pow(), ...extra }); },
    async login(username, password) { return call('POST', '/api/auth/login', { username, password }); },
  };
  return c;
}
const age = (username, ms) => app.db.run('UPDATE users SET created_at=? WHERE lower(username)=lower(?)', Date.now() - ms, username);

test('sign-up: username + password + 18+ + a solved proof of work; no e-mail, phone, name or address anywhere; a recovery code shown once', async () => {
  const c = client();
  const r = await c.signup('ridgerunner');
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.username, 'ridgerunner'); assert.match(r.recovery, /^[23456789A-HJKMNP-Z]{5}(-[23456789A-HJKMNP-Z]{5}){4}$/); assert.ok(r.newUntil > Date.now());
  assert.ok(c.cookie.startsWith('tbb_s='), 'signed in at once');
  const st = await c.call('GET', '/api/state');
  assert.equal(st.me.username, 'ridgerunner'); assert.equal(st.me.name, 'ridgerunner'); assert.equal(st.me.hasPassword, true); assert.equal(st.me.adult, true); assert.ok(st.me.newUntil > Date.now());
  assert.deepEqual(Object.keys(st.me).sort(), ['adult', 'hasPassword', 'muted', 'name', 'newUntil', 'unread', 'username', 'x'], 'the account carries nothing else: ' + JSON.stringify(st.me));
  const row = { ...app.db.get('SELECT * FROM users WHERE username=?', 'ridgerunner') };
  assert.match(row.uid, /^u_[A-Za-z0-9]{16,}$/); assert.match(row.pass_hash, /^scrypt\$32768\$8\$1\$/); assert.match(row.recovery_hash, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!Object.values(row).some((v) => typeof v === 'string' && (v.includes('fog on the ridge') || v.includes(r.recovery.replace(/-/g, '')))), 'nothing secret stored in clear');
  assert.ok(!Object.keys(row).some((k) => /mail|phone|real|addr|balance/i.test(k)), 'no identity or address columns: ' + Object.keys(row).join(','));
  // the proof of work: wrong nonce, replay, missing → refused; every failure spends the challenge
  const d = client();
  const ch = await d.call('GET', '/api/auth/pow'); assert.equal(ch.bits, 6); assert.match(ch.challenge, /^[0-9a-f]{32}$/);
  let x = await d.call('POST', '/api/auth/signup', { username: 'powless', password: 'fog on the ridge 2026', adult: true, pow: { id: ch.id, nonce: 'nope' } }); assert.equal(x.status, 422); assert.match(x.error, /browser check/);
  x = await d.call('POST', '/api/auth/signup', { username: 'powless', password: 'fog on the ridge 2026', adult: true, pow: { id: ch.id, nonce: app.pow.solve(ch) } }); assert.equal(x.status, 422, 'spent');
  x = await d.call('POST', '/api/auth/signup', { username: 'powless', password: 'fog on the ridge 2026', adult: true }); assert.equal(x.status, 422);
  const good = await d.pow();
  x = await d.call('POST', '/api/auth/signup', { username: 'powless', password: 'fog on the ridge 2026', adult: true, pow: good }); assert.equal(x.status, 200);
  x = await client().call('POST', '/api/auth/signup', { username: 'powless2', password: 'fog on the ridge 2026', adult: true, pow: good }); assert.equal(x.status, 422, 'a solved challenge works once');
});

test('sign-up rules: reserved and look-alike usernames, taken names (case-insensitive, display names too), weak passwords, no 18+', async () => {
  const c = client();
  for (const u of ['admin', 'TBB_support', 'm0derator', 'ab', 'ridge runner', 'satoshi']) { const r = await c.signup(u); assert.equal(r.status, 422, u); }
  assert.equal((await c.signup('RidgeRunner')).status, 409, 'taken, case-insensitive');
  app.db.run("INSERT INTO users(uid,name,created_at) VALUES('u_displayonly','Emberhoof',?)", Date.now());
  assert.equal((await c.signup('emberhoof')).status, 409, 'a display name counts as taken');
  for (const p of ['short1', 'qwertyuiop', 'basketball123', 'newbull_pass']) { const r = await c.signup('newbull', p); assert.equal(r.status, 422, p); }
  const noAdult = await c.call('POST', '/api/auth/signup', { username: 'kid', password: 'fog on the ridge 2026', adult: false, pow: await c.pow() }); assert.equal(noAdult.status, 422); assert.match(noAdult.error, /18/);
});

test('sign-up: at most 3 accounts per connection per day (IPv6 counted by /48, like every other cap)', async () => {
  const c = client({ ip: '2001:db8:1:200::10' });
  for (const u of ['six1', 'six2', 'six3']) assert.equal((await c.signup(u)).status, 200, u);
  const d = client({ ip: '2001:db8:1:ffff:ffff::9' }); // another /56 inside the same /48
  const r = await d.signup('six4'); assert.equal(r.status, 429); assert.match(r.error, /new accounts/);
  assert.equal((await client({ ip: '2001:db8:2:300::1' }).signup('six4')).status, 200, 'another /48 is another visitor');
});

test('sign-in: one message for a wrong password and an unknown username, similar timing; sessions rotate; sign out everywhere', async () => {
  const c = client(); await c.signup('cliffside');
  const first = c.cookie; c.cookie = '';
  const t0 = process.hrtime.bigint(); const wrong = await c.login('cliffside', 'not the password'); const t1 = process.hrtime.bigint();
  const unknown = await c.login('nobody_here', 'not the password'); const t2 = process.hrtime.bigint();
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401); assert.equal(wrong.error, unknown.error);
  const ms = (a, b) => Number(b - a) / 1e6;
  const d1 = ms(t0, t1); const d2 = ms(t1, t2); // both do a full scrypt; neither answers instantly, and they are of one order
  assert.ok(d1 > 15 && d2 > 15 && Math.abs(d1 - d2) < Math.max(200, 2 * Math.min(d1, d2)), `similar timing: ${d1.toFixed(0)} vs ${d2.toFixed(0)} ms`);
  assert.equal((await c.login('CLIFFSIDE', 'fog on the ridge 2026')).status, 200, 'username is case-insensitive');
  assert.notEqual(c.cookie, first, 'a new session token');
  assert.equal((await c.call('GET', '/api/state')).me.username, 'cliffside');
  // the earlier session still exists (two browsers); "sign out everywhere" ends it
  const other = client(); other.cookie = first; assert.equal((await other.call('GET', '/api/state')).me?.username, 'cliffside');
  assert.equal((await c.call('POST', '/api/auth/logout', { everywhere: true })).status, 200);
  assert.equal((await other.call('GET', '/api/state')).me, null); assert.equal((await c.call('GET', '/api/state')).me, null);
});

test('brute force: growing delays per connection and per account; ten failures put the account in a cool-down', async () => {
  const c = client(); await c.signup('fortress'); c.cookie = '';
  let r;
  for (let i = 0; i < 2; i++) { r = await c.login('fortress', 'wrong'); assert.equal(r.status, 401, i + ' ' + JSON.stringify(r) + ' ip=' + c.ip); }
  r = await c.login('fortress', 'wrong'); assert.equal(r.status, 401, JSON.stringify(r));
  r = await c.login('fortress', 'wrong'); assert.equal(r.status, 429, 'throttled after three failures'); assert.match(r.error, /Try again in/);
  // another connection hammering the same account is throttled by the account key as well
  const d = client(); r = await d.login('fortress', 'wrong'); assert.equal(r.status, 429, 'per-account throttle');
  // the right password from a fresh connection after the wait works and clears the account's count
  await new Promise((res) => setTimeout(res, 1100));
  const e = client(); r = await e.login('fortress', 'fog on the ridge 2026'); assert.equal(r.status, 200, JSON.stringify(r));
  // ten failures → the account cools down even for a new connection, and the stored count resets
  const t = Date.now(); app.db.run('UPDATE users SET fail_count=9 WHERE username=?', 'fortress');
  const f = client(); r = await f.login('fortress', 'wrong'); assert.equal(r.status, 401);
  const row = app.db.get('SELECT fail_count, lock_until FROM users WHERE username=?', 'fortress'); assert.equal(row.fail_count, 0); assert.ok(row.lock_until > t + 10 * 60_000);
  r = await client().login('fortress', 'fog on the ridge 2026'); assert.equal(r.status, 429); assert.match(r.error, /min/);
  app.db.run('UPDATE users SET lock_until=0 WHERE username=?', 'fortress');
});

test('recovery: code + new password resets the account, ends every session, issues a new code; the old code is dead; nothing else resets', async () => {
  const c = client(); const s = await c.signup('lostkeys', 'first password here');
  const d = client(); await d.login('lostkeys', 'first password here'); assert.ok((await d.call('GET', '/api/state')).me);
  let r = await client().call('POST', '/api/auth/recover', { username: 'lostkeys', code: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', password: 'second password here' }); assert.equal(r.status, 401);
  r = await client().call('POST', '/api/auth/recover', { username: 'nobody', code: s.recovery, password: 'second password here' }); assert.equal(r.status, 401);
  r = await client().call('POST', '/api/auth/recover', { username: 'lostkeys', code: s.recovery, password: 'short' }); assert.equal(r.status, 422, 'a weak new password is refused before anything changes');
  assert.equal((await d.call('GET', '/api/state')).me?.username, 'lostkeys', 'untouched so far');
  const e = client(); r = await e.call('POST', '/api/auth/recover', { username: 'LostKeys', code: s.recovery.toLowerCase().replace(/-/g, ' '), password: 'second password here' });
  assert.equal(r.status, 200, JSON.stringify(r) + ' ' + e.ip); assert.notEqual(r.recovery, s.recovery); assert.ok(e.cookie.startsWith('tbb_s='));
  assert.equal((await d.call('GET', '/api/state')).me, null, 'other sessions ended');
  assert.equal((await client().login('lostkeys', 'first password here')).status, 401);
  assert.equal((await client().login('lostkeys', 'second password here')).status, 200);
  r = await client().call('POST', '/api/auth/recover', { username: 'lostkeys', code: s.recovery, password: 'third password here' }); assert.equal(r.status, 401, 'the old code is dead');
});

test('change password: needs the current one; other sessions end, this one stays', async () => {
  const c = client(); await c.signup('keychanger'); age('keychanger', 3 * 86400_000);
  const d = client(); await d.login('keychanger', 'fog on the ridge 2026');
  let r = await c.call('POST', '/api/me/password', { current: 'wrong one here', password: 'a brand new passphrase' }); assert.equal(r.status, 401);
  r = await c.call('POST', '/api/me/password', { current: 'fog on the ridge 2026', password: 'short' }); assert.equal(r.status, 422);
  r = await c.call('POST', '/api/me/password', { current: 'fog on the ridge 2026', password: 'a brand new passphrase' }); assert.equal(r.status, 200);
  assert.equal((await c.call('GET', '/api/state')).me.username, 'keychanger', 'this session stays');
  assert.equal((await d.call('GET', '/api/state')).me, null, 'the other one ended');
  assert.equal((await client().login('keychanger', 'a brand new passphrase')).status, 200);
  assert.equal((await client().call('POST', '/api/me/password', { current: 'x', password: 'y'.repeat(12) })).status, 401, 'signed out: 401');
});

test('slow start: a new account reads for 10 minutes, then posts at most once per 10 s for a day', async () => {
  const c = client(); await c.signup('newcomer');
  let r = await c.call('POST', '/api/rooms/general/messages', { body: 'first words' }); assert.equal(r.status, 403); assert.equal(r.code, 'new'); assert.match(r.error, /10 minutes/);
  assert.equal((await c.call('GET', '/api/rooms/general/messages')).status, 200, 'reading is fine');
  age('newcomer', 11 * 60_000);
  r = await c.call('POST', '/api/rooms/general/messages', { body: 'first words' }); assert.equal(r.status, 200, JSON.stringify(r));
  await new Promise((res) => setTimeout(res, 2100));
  r = await c.call('POST', '/api/rooms/general/messages', { body: 'second words too soon' }); assert.equal(r.status, 429, 'one per 10 s on the first day: ' + JSON.stringify(r));
  age('newcomer', 2 * 86400_000);
  await new Promise((res) => setTimeout(res, 2100)); // the ordinary one-per-2-s chat limit still applies
  r = await c.call('POST', '/api/rooms/general/messages', { body: 'second words, a day later' }); assert.equal(r.status, 200, JSON.stringify(r));
});

test('an account from an older install (no password yet) is told to set a username and password, gets a recovery code, and then signs in the ordinary way', async () => {
  const uid = plantUser(app.db, newUid('old'), { name: 'oldtimer' }); const c = client(); c.cookie = sessionFor(app.db, uid);
  let st = await c.call('GET', '/api/state'); assert.equal(st.me.name, 'oldtimer'); assert.equal(st.me.username, null); assert.equal(st.me.hasPassword, false);
  let r = await c.call('POST', '/api/me/credentials', { username: 'admin', password: 'old timer new pass' }); assert.equal(r.status, 422);
  r = await c.call('POST', '/api/me/credentials', { username: 'oldtimer_x', password: 'old timer new pass' }); assert.equal(r.status, 200); assert.match(r.recovery, /^[A-Z2-9-]{29}$/);
  st = await c.call('GET', '/api/state'); assert.equal(st.me.username, 'oldtimer_x'); assert.equal(st.me.name, 'oldtimer'); assert.equal(st.me.hasPassword, true);
  r = await c.call('POST', '/api/me/credentials', { username: 'again', password: 'old timer new pass' }); assert.equal(r.status, 400, 'only once');
  assert.equal((await client().login('oldtimer_x', 'old timer new pass')).status, 200, 'the ordinary way in works');
  assert.ok(!('admin' in (await c.call('GET', '/api/state')).me), 'the state carries no admin flag');
  // chat payloads never carry the account id or the username as an id
  age('oldtimer_x', 3 * 86400_000);
  assert.equal((await c.call('POST', '/api/rooms/builds/messages', { body: 'still here after all these years' })).status, 200);
  const list = await client().call('GET', '/api/rooms/builds/messages');
  assert.ok(!JSON.stringify(list).includes(uid) && !JSON.stringify(list).includes('u_'), 'no ids in chat');
});
