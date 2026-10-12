// Visitor IPs: the real one comes from CLIENT_IP_HEADER (validated, else the socket); only keyed hashes are ever kept
// (7 days, 10 per account); IP bans are timed, block sign-up / sign-in / posting but never reading; IPv6 by /64.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, v6prefix48 } from '../../lib/app.js';
import { seed } from '../../scripts/seed.js';

const fakeFetch = async () => new Response(JSON.stringify({ pairs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
const rpc = async () => { throw new Error('no rpc'); };
let app; let base;
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbip-'));
before(async () => {
  app = createApp({ env: { CHAT_OPEN: '1', ACCOUNTS_OPEN: '1', PORT: '0', LORE_WORKER: 'off', POW_BITS: '6', DB_FILE: path.join(dir, 'i.db'), PUBLIC_ORIGIN: 'http://localhost:3000', CLIENT_IP_HEADER: 'cf-connecting-ip' }, rpc, fetchImpl: fakeFetch, log: () => {} });
  seed(app.db); app.settings.set('areas', { chat: true, accounts: true });
  const a = await app.listen(0); base = `http://127.0.0.1:${a.port}`;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client(ip) {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000', cookie, ...(ip ? { 'cf-connecting-ip': ip } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await res.json().catch(() => ({})); return { ...j, status: res.status, body: j };
  };
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; },
    async signup(username) { const ch = await call('GET', '/api/auth/pow'); if (ch.status !== 200) console.log('POW', JSON.stringify(ch), ip); return call('POST', '/api/auth/signup', { username, password: 'fog on the ridge 2026', adult: true, pow: { id: ch.id, nonce: app.pow.solve(ch) } }); },
    login: (username) => call('POST', '/api/auth/login', { username, password: 'fog on the ridge 2026' }) };
}
const old = (username) => app.db.run('UPDATE users SET created_at=? WHERE username=?', Date.now() - 3 * 86400_000, username);
const uidOf = (username) => app.db.get('SELECT uid FROM users WHERE username=?', username).uid;

test('CLIENT_IP_HEADER: the header is the visitor when it parses as an IP, else the socket; X-Forwarded-For is ignored; the stored value is a keyed hash, never the IP', async () => {
  const a = client('203.0.113.7'); const s0 = await a.signup('viaheader'); assert.equal(s0.status, 200, JSON.stringify(s0));
  const rows = app.db.all('SELECT * FROM ip_log WHERE uid=?', uidOf('viaheader'));
  assert.equal(rows.length, 2, 'signup + signin'); // both with the same hash
  assert.ok(rows.every((r) => r.ip_hash === app.ipHash('203.0.113.7') && /^[0-9a-f]{64}$/.test(r.ip_hash) && !r.ip_hash.includes('203')), 'hash only');
  assert.notEqual(app.ipHash('203.0.113.7'), crypto.createHash('sha256').update('203.0.113.7').digest('hex'), 'keyed, not a plain hash');
  assert.ok(!JSON.stringify(app.db.all('SELECT * FROM ip_log')).includes('203.0.113'), 'the IP is nowhere in the database');
  // a junk header value falls back to the socket (127.0.0.1); X-Forwarded-For does nothing
  const b = client('not an ip'); assert.equal((await b.call('GET', '/api/auth/pow', null, { 'x-forwarded-for': '198.51.100.9' })).status, 200);
  assert.equal((await b.signup('viasocket')).status, 200);
  assert.equal(app.db.get('SELECT ip_hash FROM ip_log WHERE uid=?', uidOf('viasocket')).ip_hash, app.ipHash('127.0.0.1'));
  // IPv6 is grouped by /48 before hashing (one site's block, however many /56s or /64s it spreads over)
  const c = client('2001:db8:aa:bb00::1'); assert.equal((await c.signup('viasix')).status, 200);
  assert.equal(app.db.get('SELECT ip_hash FROM ip_log WHERE uid=?', uidOf('viasix')).ip_hash, app.ipHash(v6prefix48('2001:db8:aa:ccff:9:9:9:9')));
});

test('the log keeps 7 days and at most 10 entries per account', async () => {
  const c = client('203.0.113.50'); assert.equal((await c.signup('talker')).status, 200); old('talker');
  const uid = uidOf('talker');
  app.db.run('INSERT INTO ip_log(uid,ip_hash,kind,at) VALUES(?,?,?,?)', uid, app.ipHash('203.0.113.51'), 'post', Date.now() - 8 * 86400_000); // stale
  for (let i = 0; i < 3; i++) { const r = await c.call('POST', '/api/rooms/general/messages', { body: 'message number ' + i }); assert.equal(r.status, 200, JSON.stringify(r)); await new Promise((res) => setTimeout(res, 2100)); }
  for (let i = 0; i < 9; i++) app.logIp(uid, `203.0.113.${60 + i}`, 'post'); // what more posts would add
  const rows = app.db.all('SELECT * FROM ip_log WHERE uid=? ORDER BY id', uid);
  assert.equal(rows.length, 10, 'capped at 10'); assert.ok(rows.every((r) => r.at > Date.now() - 7 * 86400_000), 'stale ones purged');
  assert.ok(!rows.some((r) => r.ip_hash === app.ipHash('203.0.113.51')), 'the 8-day-old row is gone');
});

test('ban account + IP: the connection can read but not sign up, sign in or post; the account ban can be timed; other accounts on that connection are counted; expiry and lift', async () => {
  const ip = '203.0.113.99';
  const bad = client(ip); assert.equal((await bad.signup('spammer')).status, 200); old('spammer');
  const mate = client(ip); assert.equal((await mate.signup('roommate')).status, 200); old('roommate');
  const far = client('203.0.113.100'); assert.equal((await far.signup('farway')).status, 200); old('farway');
  const uid = uidOf('spammer');
  assert.equal((await bad.call('POST', '/api/rooms/general/messages', { body: 'buy my thing' })).status, 200);
  // ban for 7 days + IP for 24 h
  const actionId = app.mod.ban(uid, { actor: 'panel', reason: 'spam', days: 7, ip: true, ipDays: 1 });
  const u = app.db.get('SELECT banned, ban_until FROM users WHERE uid=?', uid); assert.equal(u.banned, 1); assert.ok(u.ban_until > Date.now() + 6 * 86400_000 && u.ban_until < Date.now() + 8 * 86400_000);
  const bans = app.mod.ipBans(); assert.equal(bans.length, 1); assert.equal(bans[0].hash, app.ipHash(ip)); assert.equal(bans[0].others, 1, 'one other account used this connection: ' + JSON.stringify(app.db.all('SELECT uid,kind FROM ip_log WHERE ip_hash=?', app.ipHash(ip)))); assert.equal(bans[0].user.name, 'spammer'); assert.match(bans[0].label, /^#[0-9a-f]{8}$/);
  assert.ok(bans[0].until > Date.now() + 23 * 3600_000 && bans[0].until < Date.now() + 25 * 3600_000, 'IP ban is 24 h');
  assert.ok(!JSON.stringify(bans).includes('203.0'), 'never the IP');
  assert.deepEqual(app.mod.users('', { ipHash: app.ipHash(ip) }).map((x) => x.username).sort(), ['roommate', 'spammer'], 'one-click review of the connection');
  // the banned connection: reading works, writing does not
  assert.equal((await bad.call('GET', '/api/state')).status, 200); assert.equal((await bad.call('GET', '/api/rooms/general/messages')).status, 200);
  let r = await mate.call('POST', '/api/rooms/general/messages', { body: 'hello' }); assert.equal(r.status, 403); assert.equal(r.error, 'You can’t post from this connection right now.');
  r = await client(ip).signup('another'); assert.equal(r.status, 403); assert.match(r.error, /this connection/);
  r = await client(ip).login('roommate'); assert.equal(r.status, 403);
  r = await client(ip).call('POST', '/api/auth/logout', {}); assert.equal(r.status, 200, 'signing out is always allowed');
  assert.equal((await far.call('POST', '/api/rooms/general/messages', { body: 'hello from far away' })).status, 200, 'other connections unaffected');
  assert.equal((await client('203.0.113.100').login('roommate')).status, 200, 'the roommate can sign in from elsewhere');
  // the banned account itself: no session, no sign-in
  assert.equal((await bad.call('GET', '/api/state')).me, null); assert.equal((await client('203.0.113.100').login('spammer')).status, 403);
  // IP ban expiry: time passes → posting works again; the account ban (7 days) is still on
  app.db.run('UPDATE ip_bans SET until=? WHERE ip_hash=?', Date.now() - 1, app.ipHash(ip));
  assert.equal((await client(ip).login('roommate')).status, 200); assert.equal(app.mod.ipBans().length, 0, 'expired bans vanish');
  assert.equal((await client('203.0.113.100').login('spammer')).status, 403);
  // a timed account ban that ran out lets the person back in
  app.db.run('UPDATE users SET ban_until=? WHERE uid=?', Date.now() - 1, uid);
  assert.equal((await client('203.0.113.100').login('spammer')).status, 200);
  // ban again (permanent + IP 7 days) and undo from the log: both go
  const id2 = app.mod.ban(uid, { actor: 'panel', reason: 'again', days: null, ip: true, ipDays: 7 });
  assert.equal(app.mod.ipBans().length, 2, 'both connections the spammer used lately (the second sign-in came from .100)'); assert.equal(app.db.get('SELECT ban_until FROM users WHERE uid=?', uid).ban_until, 0, 'permanent');
  assert.equal((await client('203.0.113.100').login('farway')).status, 403, 'the neighbour on .100 is blocked for now');
  app.mod.undo(id2, { actor: 'panel' });
  assert.equal(app.mod.ipBans().length, 0); assert.equal(app.db.get('SELECT banned FROM users WHERE uid=?', uid).banned, 0);
  assert.equal((await client('203.0.113.100').login('farway')).status, 200);
  // lift one IP ban on its own
  app.mod.ban(uid, { actor: 'panel', reason: 'third', days: 1, ip: true, ipDays: 30 });
  assert.equal(app.mod.ipBans().length, 2);
  const liftId = app.mod.liftIp(app.ipHash(ip), { actor: 'panel', reason: 'innocent cafe wifi' });
  assert.equal(app.mod.ipBans().length, 1); assert.equal((await client(ip).login('roommate')).status, 200);
  assert.equal((await client('203.0.113.100').login('farway')).status, 403, 'the other ban stays');
  app.mod.undo(liftId, { actor: 'panel' }); assert.equal(app.mod.ipBans().length, 2, 'undoing the lift puts it back');
  assert.throws(() => app.mod.ban(uid, { days: 2 }), /24 hours/); assert.throws(() => app.mod.ban(uid, { ip: true, ipDays: 365 }), /never for good/);
  void actionId;
});
