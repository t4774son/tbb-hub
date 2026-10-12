// Security regressions, on a real server: the production-like start, moderation gates on every public write,
// edit/delete limits and broadcasts, the anonymous-report cap, file permissions, the sign-in lock-out parity for
// made-up usernames, outbound User-Agents, the export's allow-list and the admin panel's href filter.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../lib/app.js';
import { makeRpc } from '../../lib/solana.js';
import { makeAccessVerifier } from '../../lib/access.js';
import { seed } from '../../scripts/seed.js';
import { newUid, plantUser, sessionFor } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const kp = () => newUid('s');
const rpc = async (method) => { throw new Error('unexpected rpc ' + method); };
const fakeFetch = async () => new Response(JSON.stringify({ pairs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });

let app; let base; let port;
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbsec-'));
before(async () => {
  app = createApp({ env: { CHAT_OPEN: '1', ACCOUNTS_OPEN: '1', PORT: '0', LORE_WORKER: 'off', POW_BITS: '6', DB_FILE: path.join(dir, 'a.db'), PUBLIC_ORIGIN: 'http://localhost:3000', CLIENT_IP_HEADER: 'x-test-ip' }, rpc, fetchImpl: fakeFetch, log: () => {} });
  seed(app.db);
  app.settings.set('areas', { chat: true, accounts: true });
  const a = await app.listen(0); port = a.port; base = `http://127.0.0.1:${port}`;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let ipN = 0;
function client({ ip = `10.2.${Math.floor(++ipN / 250)}.${ipN % 250}` } = {}) {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000', cookie, 'x-test-ip': ip, ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await res.json().catch(() => ({}));
    return { ...j, status: res.status, body: j };
  };
  const c = { call, ip, get cookie() { return cookie; }, set cookie(v) { cookie = v; },
    async signIn(uid, name, { adult = true, ageMs } = {}) {
      plantUser(app.db, uid, ageMs === undefined ? { adult } : { adult, ageMs }); cookie = sessionFor(app.db, uid);
      if (name) { const r = await call('POST', '/api/me/name', { name }); assert.equal(r.status, 200, JSON.stringify(r)); }
    },
    async pow() { const ch = await call('GET', '/api/auth/pow'); return { id: ch.id, nonce: app.pow.solve(ch) }; },
    async signup(username, password = 'fog on the ridge 2026') { return call('POST', '/api/auth/signup', { username, password, adult: true, pow: await c.pow() }); },
    login: (username, password) => call('POST', '/api/auth/login', { username, password }),
  };
  return c;
}
function stream(cookie = '') {
  const events = []; let req;
  const ready = new Promise((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { cookie, 'x-test-ip': `10.9.${ipN % 250}.1` } }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (.+)$/m.exec(chunk)?.[1]; const data = /^data: (.+)$/m.exec(chunk)?.[1]; if (ev) events.push({ ev, data: data ? JSON.parse(data) : null }); } });
      res.on('error', () => {}); resolve();
    }); req.on('error', reject);
  });
  return { events, ready, close: () => req.destroy() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (c, room, body) => c.call('POST', `/api/rooms/${room}/messages`, { body });

test('the documented production settings start (CLIENT_IP_HEADER satisfies the admin-host proxy check); without either the server refuses', async () => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbprod-'));
  const env = { PUBLIC_ORIGIN: 'https://example.org', ADMIN_HOST: 'admin.example.org', PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: path.join(d, 'a.db') };
  const a = createApp({ env: { ...env, CLIENT_IP_HEADER: 'cf-connecting-ip', TRUST_PROXY: '' }, rpc, fetchImpl: fakeFetch, log: () => {} });
  assert.equal(a.config.clientIpHeader, 'cf-connecting-ip'); await a.close();
  assert.throws(() => createApp({ env: { ...env, DB_FILE: path.join(d, 'b.db'), TRUST_PROXY: '' }, rpc, fetchImpl: fakeFetch, log: () => {} }), /CLIENT_IP_HEADER|TRUST_PROXY/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('a muted account cannot post ideas or vote; a brand-new account reads first; an unconfirmed one confirms 18+ first', async () => {
  const author = kp(); const a = client(); await a.signIn(author, 'ideamaker');
  const other = kp(); const o = client(); await o.signIn(other, 'voter');
  const idea = await a.call('POST', '/api/ideas', { title: 'Before the mute', body: 'fine' }); assert.equal(idea.status, 200);
  // mute both: every public write answers 403 with the mute message, reading still works
  app.mod.mute(author, 60, { actor: 'panel', reason: 'test' }); app.mod.mute(other, 60, { actor: 'panel', reason: 'test' });
  for (const [who, method, p, body] of [[a, 'POST', '/api/ideas', { title: 'While muted', body: 'should not land' }], [o, 'POST', `/api/ideas/${idea.idea.id}/vote`, {}], [a, 'POST', '/api/rooms/general/messages', { body: 'muted chat' }]]) {
    const r = await who.call(method, p, body); assert.equal(r.status, 403, `${p} ${JSON.stringify(r)}`); assert.match(r.error, /muted/, p);
  }
  assert.equal((await a.call('GET', '/api/ideas')).status, 200, 'reading is fine');
  assert.ok(!app.db.get("SELECT 1 FROM ideas WHERE title='While muted'"));
  app.mod.unmute(author, { actor: 'panel' }); app.mod.unmute(other, { actor: 'panel' });
  // a brand-new account reads for ten minutes before its first idea or vote
  const fresh = kp(); const f = client(); await f.signIn(fresh, 'newcomer', { ageMs: 1000 });
  const r1 = await f.call('POST', '/api/ideas', { title: 'Too soon', body: 'x' }); assert.equal(r1.status, 403); assert.equal(r1.code, 'new');
  const r2 = await f.call('POST', `/api/ideas/${idea.idea.id}/vote`); assert.equal(r2.status, 403); assert.equal(r2.code, 'new');
  // the 18+ confirmation is needed for ideas too, not only chat
  const quiet = kp(); const q = client(); await q.signIn(quiet, 'unconfirmed', { adult: false });
  const r3 = await q.call('POST', '/api/ideas', { title: 'No tick', body: 'x' }); assert.equal(r3.status, 403); assert.equal(r3.code, 'adult');
});

test('edits and deletes are paced per account; deleting twice broadcasts once; nobody deletes another person’s message from the public host', async () => {
  const w = kp(); const c = client(); await c.signIn(w, 'editor');
  const m = await post(c, 'general', 'first draft'); assert.equal(m.status, 200, JSON.stringify(m));
  let last;
  for (let i = 0; i < 6; i++) last = await c.call('PATCH', `/api/messages/${m.message.id}`, { body: `draft ${i}` });
  assert.equal(last.status, 429, 'the sixth edit in a row is paced: ' + JSON.stringify(last));
  const viewer = stream(); await viewer.ready;
  assert.equal((await c.call('DELETE', `/api/messages/${m.message.id}`)).status, 200);
  assert.equal((await c.call('DELETE', `/api/messages/${m.message.id}`)).status, 200, 'deleting again is fine');
  await sleep(300);
  assert.equal(viewer.events.filter((e) => e.ev === 'message:update' && e.data.id === m.message.id).length, 1, 'one broadcast, not one per call');
  viewer.close();
  // nobody deletes someone else's message from the public host: that is moderation, in the panel, with a reason and an undo
  const v = kp(); const vc = client(); await vc.signIn(v, 'victim'); const m3 = await post(vc, 'general', 'to be removed'); assert.equal(m3.status, 200, JSON.stringify(m3));
  const other = client(); await other.signIn(kp(), 'notamod');
  assert.equal((await other.call('DELETE', `/api/messages/${m3.message.id}`)).status, 403);
  assert.equal(app.db.get('SELECT deleted, hidden FROM messages WHERE id=?', m3.message.id).deleted, 0);
});

test('anonymous "problem" notes stop at 500 open (a new one is refused, nothing older is dropped); signed-in members can still write', async () => {
  const anon = client();
  assert.equal((await anon.call('POST', '/api/report', { kind: 'problem', target: 'help', reason: 'the page is slow' })).status, 200);
  const t = Date.now();
  app.db.raw.exec(`INSERT INTO reports(kind,target,uid,reason,created_at) ${Array.from({ length: 500 }, (_, i) => `SELECT 'problem','help',NULL,'flood ${i}',${t}`).join(' UNION ALL ')}`);
  const before = app.db.get("SELECT COUNT(*) n FROM reports WHERE kind='problem' AND resolved=0").n;
  const full = await client().call('POST', '/api/report', { kind: 'problem', target: 'help', reason: 'one more' });
  assert.equal(full.status, 429, 'refused: a full inbox keeps what it has (test/unit/hardening.test.js)');
  assert.equal(app.db.get("SELECT COUNT(*) n FROM reports WHERE kind='problem' AND resolved=0").n, before, 'the inbox did not change');
  const m = kp(); const mc = client(); await mc.signIn(m, 'member');
  assert.equal((await mc.call('POST', '/api/report', { kind: 'problem', target: 'help', reason: 'signed in' })).status, 200);
  app.db.run("DELETE FROM reports WHERE reason LIKE 'flood %'");
});

test('refused-message hits older than 30 days are purged', async () => {
  const w = plantUser(app.db, kp());
  app.db.run('INSERT INTO mod_hits(uid,kind,at) VALUES(?,?,?)', w, 'link', Date.now() - 31 * 86400_000);
  app.mod.recordHit(w, 'link');
  const rows = app.db.all('SELECT at FROM mod_hits WHERE uid=?', w);
  assert.equal(rows.length, 1); assert.ok(rows[0].at > Date.now() - 60_000);
});

test('the database and its WAL are readable by the service user only', async () => {
  if (process.platform === 'win32') return;
  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(mode(path.join(dir, 'a.db')), 0o600, 'database');
  for (const f of ['a.db-wal', 'a.db-shm']) if (fs.existsSync(path.join(dir, f))) assert.equal(mode(path.join(dir, f)), 0o600, f);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'); assert.ok(/process\.umask\(0o077\)/.test(src), 'server.js sets a private umask');
});

test('a made-up username cools down for 15 minutes after ten failures, exactly like a real account', async () => {
  const c = client(); assert.equal((await c.signup('realperson')).status, 200); c.cookie = '';
  // skip the doubling waits (the throttle keeps its count): the eleventh attempt on each name is what matters
  const run = async (username) => {
    let r;
    for (let i = 0; i < 10; i++) { app.throttle.release('acct:' + username); r = await client().login(username, 'wrong password here'); assert.equal(r.status, 401, `${username} ${i} ${JSON.stringify(r)}`); }
    return client().login(username, 'wrong password here');
  };
  app.db.run("UPDATE users SET fail_count=0 WHERE username='realperson'");
  const real = await run('realperson'); const fake = await run('nobody_by_that_name');
  assert.equal(real.status, 429); assert.equal(fake.status, 429, JSON.stringify(fake));
  assert.equal(real.error, fake.error, 'same message, same wait');
  assert.match(fake.error, /15 min/);
});

test('outbound RPC and Access-certificate requests carry a plain browser User-Agent, not the Node version', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init?.headers?.['user-agent']); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  assert.equal(await makeRpc('https://rpc.example', { fetchImpl, minGapMs: 0 })('getSlot'), 1);
  const v = makeAccessVerifier({ team: 'example-team', aud: 'a'.repeat(64), emailSha256: 'b'.repeat(64), fetchImpl });
  await v.verify(`${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.x`);
  assert.ok(seen.length >= 2 && seen.every((ua) => ua === 'Mozilla/5.0'), JSON.stringify(seen));
});

test('the published tree is the allow-list and nothing else (the export script, where present, lists what ships); the admin panel refuses protocol-relative links', async () => {
  const DOCS = ['README.md', 'SECURITY.md', 'DECISIONS.md'];
  // the export script is private and unnamed here: in the working tree it is the shell script in scripts/ that runs git archive
  const exporter = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.sh')).map((f) => path.join(ROOT, 'scripts', f))
    .find((f) => /git archive --format=tar HEAD/.test(fs.readFileSync(f, 'utf8'))) || '';
  if (exporter && fs.existsSync(exporter)) { // the working tree: the export is an explicit allow-list of committed paths
    const src = fs.readFileSync(exporter, 'utf8');
    assert.match(src, /git archive --format=tar HEAD/, 'built from the committed tree');
    const allow = /ALLOW=\(([^)]*)\)/.exec(src)?.[1].split(/\s+/).filter(Boolean); assert.ok(allow?.length, 'allow-list found');
    for (const f of ['public', 'lib', 'admin', 'test/unit', 'test/e2e', 'server.js', 'package.json', 'LICENSE', '.env.example', '.gitignore', '.github/workflows/verify-live.yml', 'scripts/privacy-scan.py', 'scripts/verify-live.js', ...DOCS]) assert.ok(allow.includes(f), `${f} ships`);
    for (const f of allow) assert.ok(!/\.md$/.test(f) || DOCS.includes(f), `${f}: no other document ships`);
    for (const f of allow) assert.ok(!/^test\/private|^\.privacy-|^scripts$|^test$/.test(f) && f !== path.relative(ROOT, exporter), `${f}: no private path, no whole scripts/ or test/ folder`);
    assert.ok(allow.every((f) => fs.existsSync(path.join(ROOT, f))), 'every listed path exists');
  } else { // the published tree: only the allow-listed shapes are there
    const top = fs.readdirSync(ROOT);
    assert.deepEqual(top.filter((f) => /\.md$/i.test(f)).sort(), [...DOCS].sort(), 'the three documents and no other');
    assert.ok(!top.some((f) => f.startsWith('.privacy-') || /notes|todo|brief|audit/i.test(f)), 'no working file: ' + top.join(','));
    assert.ok(!fs.existsSync(path.join(ROOT, 'test/private')) && !fs.existsSync(path.join(ROOT, 'docs')), 'no private test folder, no docs folder');
  }
  // the panel carries the public page's URL filter, literal for literal (behaviour: test/unit/hardening.test.js)
  const literal = (f) => /^const SAFE_URL = (.*);$/m.exec(fs.readFileSync(path.join(ROOT, f), 'utf8'))?.[1];
  assert.ok(literal('admin/admin.js'), 'href filter present in admin.js'); assert.equal(literal('admin/admin.js'), literal('public/js/ui.js'), 'same literal as ui.js');
  const hrefRe = new Function(`return ${literal('admin/admin.js')}`)();
  for (const bad of ['//evil.example', '/\\evil.example', 'http://x', 'javascript:alert(1)', 'data:text/html,x']) assert.ok(!hrefRe.test(bad), bad);
  for (const ok of ['https://example.com', '/api/x', '#queue']) assert.ok(hrefRe.test(ok), ok);
});

test('a signed-in member can send more than one Help note (the per-thing dedupe is for reports on things)', async () => {
  const m = kp(); const mc = client(); await mc.signIn(m, 'helpful');
  assert.equal((await mc.call('POST', '/api/report', { kind: 'problem', target: 'help', reason: 'first note' })).status, 200);
  assert.equal((await mc.call('POST', '/api/report', { kind: 'problem', target: 'help', reason: 'second note' })).status, 200);
  assert.equal(app.db.get("SELECT COUNT(*) n FROM reports WHERE kind='problem' AND uid=?", m).n, 2, 'both kept');
  // a report on a message is still one per person
  const w = kp(); const wc = client(); await wc.signIn(w, 'poster'); const msg = await post(wc, 'general', 'hello there'); assert.equal(msg.status, 200, JSON.stringify(msg));
  for (let i = 0; i < 2; i++) assert.equal((await mc.call('POST', '/api/report', { kind: 'message', target: String(msg.message.id), reason: 'spam ' + i })).status, 200);
  assert.equal(app.db.get("SELECT COUNT(*) n FROM reports WHERE kind='message' AND target=? AND uid=?", String(msg.message.id), m).n, 1);
});

test('signing up makes nobody an admin, and a report on a thing that no longer exists is refused', async () => {
  const c = client(); assert.equal((await c.signup('plainaccount')).status, 200);
  const st = await c.call('GET', '/api/state'); assert.ok(st.me && !('admin' in st.me), 'no admin flag in the state');
  app.db.run('UPDATE users SET created_at=? WHERE username=?', Date.now() - 3 * 86400_000, 'plainaccount');
  for (const kind of ['item', 'order', 'reward', 'payment']) { const r = await c.call('POST', '/api/report', { kind, target: '1', reason: 'x' }); assert.equal(r.status, 400, kind); assert.equal(r.error, 'Unknown report.'); }
});
