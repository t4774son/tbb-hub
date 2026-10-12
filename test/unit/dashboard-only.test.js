// The project is a read-only dashboard: it carries no wallet code and no commerce code, closed or not. This test keeps
// it that way: the modules are gone, the published tree names none of them (no route, no setting, no hash address, no
// identifier), the former routes are the plain 404 of a path that was never there whatever the settings say, the
// state and the configuration have no trace of them, and an older database is brought over cleanly (its former tables
// dropped, its account-id column renamed, its rows kept).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp, loadConfig, ROOMS } from '../../lib/app.js';
import { SETTINGS, AREAS } from '../../lib/settings.js';
import { openDb } from '../../lib/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fakeFetch = async () => new Response(JSON.stringify({ pairs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
const rpc = async () => { throw new Error('no rpc'); };
// the names are spelled in pieces here so that this file is not itself a mention of them (the tree scan below)
const j = (...p) => p.join('');
const FORMER_ENV = [j('WALLET', '_OPEN'), j('STORE', '_OPEN'), j('BOUNTIES', '_OPEN'), j('CLUB', '_OPEN'), j('TREASURY', '_WALLET'), j('UPLOAD', '_DIR')];
const FORMER_CONFIG = [j('wallet', 'Open'), j('store', 'Open'), j('bounties', 'Open'), j('club', 'Open'), j('treas', 'ury'), j('upload', 'Dir')];
const FORMER_ROUTES = [j('/api/', 'listings'), j('/api/', 'listings/1'), j('/api/', 'listings/1/review'), j('/api/', 'orders'), j('/api/', 'orders/1/confirm'), j('/api/', 'tx/send'), j('/api/', 'purchases'),
  j('/api/', 'seller/apply'), j('/api/', 'seller/dashboard'), j('/api/', 'bounties'), j('/api/', 'bounties/1/claim'), j('/api/', 'shipped'),
  j('/api/auth/', 'nonce'), j('/api/auth/', 'verify'), j('/api/me/', 'wallet/verify'), j('/api/me/', 'wallet/unlink'), j('/api/rooms/', 'million/messages'), j('/upl', 'oads/abcdefghijkl.png')];
const FORMER_PANEL = [j('/api/panel/', 'build'), j('/api/panel/', 'seller'), j('/api/panel/', 'bounty'), j('/api/panel/', 'bounty/paid'), j('/api/panel/', 'bounty/reopen')];
const FORMER_FILES = ['lib/siws.js', j('lib/pa', 'y.js'), j('public/js/wal', 'let.js'), j('public/js/txch', 'eck.js'), j('test/unit/', 'pay.test.js'), j('test/unit/', 'txcheck.test.js'), j('test/net/', 'checkout.test.js'), 'test/fixtures'];

function client(base) {
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, text, json, type: res.headers.get('content-type'), cache: res.headers.get('cache-control') };
  };
  return { call };
}

test('the modules are gone, and the server, the settings and the configuration know nothing of them', () => {
  for (const f of FORMER_FILES) assert.ok(!fs.existsSync(path.join(ROOT, f)), f + ' still exists');
  const cfg = loadConfig(Object.fromEntries(FORMER_ENV.map((k) => [k, '1'])));
  for (const k of FORMER_CONFIG) assert.ok(!(k in cfg), 'config still has ' + k);
  assert.equal(cfg.accountsOpen, false); assert.equal(cfg.chatOpen, false);
  assert.deepEqual(AREAS, ['chat', 'accounts'], 'two launch areas: chat and accounts');
  assert.ok(!(j('post_min', '_tbb') in SETTINGS), 'no on-chain posting gate');
  assert.deepEqual(ROOMS.map((r) => r.id), ['general', 'builds'], 'two rooms, none gated');
  assert.ok(ROOMS.every((r) => !('gated' in r)));
});

test('every former route is the plain 404 of a path that was never there: settings closed or every one open, for a stranger and a signed-in member; the state carries no trace', async () => {
  for (const [label, env] of [['closed', {}], ['open', { CHAT_OPEN: '1', ACCOUNTS_OPEN: '1', ...Object.fromEntries(FORMER_ENV.map((k) => [k, '1'])) }]]) {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbdash-'));
    const app = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', POW_BITS: '6', DB_FILE: path.join(dir, 'a.db'), PUBLIC_ORIGIN: 'http://localhost:3000', ...env }, rpc, fetchImpl: fakeFetch, log: () => {} });
    try {
      if (label === 'open') app.settings.set('areas', { chat: true, accounts: true });
      assert.throws(() => app.settings.set('areas', { chat: true, accounts: true, store: true }), /Unknown area/);
      const a = await app.listen(0); const base = `http://127.0.0.1:${a.port}`;
      const prefixes = [j('/api/', 'listings'), j('/api/', 'orders'), j('/api/', 'tx/'), j('/api/', 'purchases'), j('/api/', 'seller'), j('/api/', 'bounties'), j('/api/', 'shipped'), j('/api/auth/', 'nonce'), j('/api/auth/', 'verify'), j('/api/me/', 'wallet')];
      for (const r of app.routes) assert.ok(!prefixes.some((x) => r.pattern.startsWith(x)), label + ': route table still has ' + r.pattern);
      assert.ok(!app.routes.some((r) => j('wallet', 'Only') in r), 'no route is gated on anything but the area switches');
      const callers = [['a stranger', client(base)]];
      if (label === 'open') {
        const c = client(base);
        const ch = await c.call('GET', '/api/auth/pow'); assert.equal(ch.status, 200, ch.text);
        const s = await c.call('POST', '/api/auth/signup', { username: 'dashmember', password: 'fog on the ridge 2026', adult: true, pow: { id: ch.json.id, nonce: app.pow.solve(ch.json) } }); assert.equal(s.status, 200, s.text);
        const st = await c.call('GET', '/api/state');
        assert.deepEqual(Object.keys(st.json.me).sort(), ['adult', 'hasPassword', 'muted', 'name', 'newUntil', 'unread', 'username', 'x'], 'me: ' + st.text);
        callers.push(['a signed-in member', c]);
      }
      for (const [who, c] of callers) {
        const nope = await c.call('GET', '/api/nope');
        for (const p of [...FORMER_ROUTES, ...FORMER_PANEL]) for (const method of ['GET', 'POST']) {
          const r = await c.call(method, p, method === 'POST' ? { id: 1, title: 'x', body: 'y', address: '4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT', message: 'x', signature: 'y' } : undefined);
          assert.equal(r.status, 404, `${label}, ${who}: ${method} ${p} answered ${r.status} ${r.text.slice(0, 80)}`);
          assert.equal(r.text, p.startsWith('/api/') ? '{"error":"Not found"}' : 'This page has moved on to other things.', `${label}, ${who}: ${method} ${p} is the plain 404`);
          if (p.startsWith('/api/')) assert.deepEqual([r.type, r.cache], [nope.type, nope.cache], `${label}, ${who}: ${method} ${p} is indistinguishable from an unknown path`);
        }
      }
      const st = (await client(base).call('GET', '/api/state')).json;
      assert.deepEqual(Object.keys(st).sort(), ['alerts', 'banner', 'features', 'genesis', 'lore', 'me', 'operator', 'rooms', 'sections', 'stats', 'story', 'x'].sort());
      assert.deepEqual(st.features, label === 'open' ? { chat: true, accounts: true, ideas: true } : { chat: false, accounts: false, ideas: false });
      assert.deepEqual(st.rooms.map((r) => Object.keys(r).sort()), [['blurb', 'id', 'name', 'short'], ['blurb', 'id', 'name', 'short']]);
      const tables = app.db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
      for (const t of ['nonces', j('bount', 'ies'), j('list', 'ings'), 'orders', 'used_sigs', 'reviews']) assert.ok(!tables.includes(t), 'table still there: ' + t);
      const cols = (t) => app.db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      for (const col of [j('wallet', '_addr'), 'seller', 'mc', 'mc_checked_at', 'bal_base']) assert.ok(!cols('users').includes(col), 'users still has ' + col);
      for (const t of ['users', 'sessions', 'messages', 'reactions', 'ideas', 'votes', 'reports', 'inbox', 'mod_actions', 'mod_hits', 'mod_queue']) { assert.ok(cols(t).includes('uid'), t + ' has uid'); assert.ok(!cols(t).includes('wallet'), t + ' still has the old column'); }
      assert.ok(!cols('ideas').includes(j('bount', 'y_id')));
      const csp = (await fetch(base + '/api/state')).headers.get('content-security-policy');
      assert.ok(/connect-src 'self'/.test(csp) && !/solana|rpc|helius/i.test(csp), 'the browser talks only to this site: ' + csp);
    } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('an older database is brought over cleanly: the former tables dropped, the account-id column renamed, rows and settings kept, once', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbdashmig-'));
  const file = path.join(dir, 'old.db');
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE users(wallet TEXT PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0, seller TEXT NOT NULL DEFAULT 'none', mc INTEGER NOT NULL DEFAULT 0, mc_checked_at INTEGER NOT NULL DEFAULT 0,
      muted_until INTEGER NOT NULL DEFAULT 0, adult_confirmed_at INTEGER, report_weight REAL NOT NULL DEFAULT 1, bal_base TEXT, username TEXT, pass_hash TEXT, recovery_hash TEXT, pass_changed_at INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0, lock_until INTEGER NOT NULL DEFAULT 0, ${j('wallet', '_addr')} TEXT, x_id TEXT, x_handle TEXT, ban_until INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL DEFAULT 'wallet');
    CREATE UNIQUE INDEX users_name ON users(lower(name)); CREATE UNIQUE INDEX users_username ON users(lower(username)); CREATE UNIQUE INDEX users_${j('wallet', '_addr')} ON users(${j('wallet', '_addr')}); CREATE UNIQUE INDEX users_x_id ON users(x_id);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, wallet TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE nonces(nonce TEXT PRIMARY KEY, message TEXT NOT NULL, address TEXT NOT NULL, created_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, room TEXT NOT NULL, wallet TEXT NOT NULL, body TEXT NOT NULL, reply_to INTEGER, created_at INTEGER NOT NULL, edited_at INTEGER, hidden INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0, mod_reason TEXT, mod_by TEXT);
    CREATE INDEX messages_room ON messages(room, id);
    CREATE TABLE reactions(message_id INTEGER NOT NULL, wallet TEXT NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY(message_id, wallet, emoji));
    CREATE TABLE ideas(id INTEGER PRIMARY KEY, wallet TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, ${j('bount', 'y_id')} INTEGER);
    CREATE TABLE votes(idea_id INTEGER NOT NULL, wallet TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(idea_id, wallet));
    CREATE TABLE ${j('bount', 'ies')}(id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
    CREATE TABLE ${j('list', 'ings')}(id INTEGER PRIMARY KEY, seller TEXT NOT NULL, title TEXT NOT NULL, image TEXT, image_status TEXT NOT NULL DEFAULT 'approved');
    CREATE TABLE orders(id TEXT PRIMARY KEY, buyer TEXT NOT NULL, msg TEXT, relayed INTEGER NOT NULL DEFAULT 0, payer TEXT, payee TEXT);
    CREATE INDEX orders_buyer ON orders(buyer);
    CREATE TABLE used_sigs(sig TEXT PRIMARY KEY, purpose TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE reviews(listing_id INTEGER NOT NULL, buyer TEXT NOT NULL, stars INTEGER NOT NULL, PRIMARY KEY(listing_id, buyer));
    CREATE TABLE reports(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, wallet TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE inbox(id INTEGER PRIMARY KEY, wallet TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, link TEXT, created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX inbox_wallet ON inbox(wallet, id);
    CREATE TABLE events(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, link TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE mod_actions(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, wallet TEXT, message_id INTEGER, reason TEXT NOT NULL DEFAULT '', meta TEXT, undone_at INTEGER);
    CREATE INDEX mod_actions_wallet ON mod_actions(wallet, id);
    CREATE TABLE mod_hits(id INTEGER PRIMARY KEY, wallet TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX mod_hits_wallet ON mod_hits(wallet, at);
    CREATE TABLE mod_queue(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, target TEXT, wallet TEXT, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, resolution TEXT);
    INSERT INTO users(wallet,name,username,pass_hash,created_at,via) VALUES('u_keep1','keeper','keeper','scrypt$x',1,'password');
    INSERT INTO users(wallet,name,created_at,via,${j('wallet', '_addr')}) VALUES('4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT','oldtimer',1,'wallet','4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT');
    INSERT INTO messages(room,wallet,body,created_at) VALUES('general','u_keep1','still here',1);
    INSERT INTO messages(room,wallet,body,created_at) VALUES('million','u_keep1','in the old room',1);
    INSERT INTO messages(room,wallet,body,created_at) VALUES('general','4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT','by the old account',1);
    INSERT INTO votes(idea_id,wallet,created_at) VALUES(1,'4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT',1);
    INSERT INTO sessions(id,wallet,created_at,expires_at) VALUES('s-old','4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT',1,9999999999999);
    INSERT INTO mod_hits(wallet,kind,at) VALUES('4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT','link',1);
    INSERT INTO ideas(wallet,title,body,created_at,${j('bount', 'y_id')}) VALUES('u_keep1','an idea','kept',1,7);
    INSERT INTO votes(idea_id,wallet,created_at) VALUES(1,'u_keep1',1);
    INSERT INTO reports(kind,target,wallet,reason,created_at) VALUES('problem','help',NULL,'a note',1);
    INSERT INTO reports(kind,target,wallet,reason,created_at) VALUES('${j('list', 'ing')}','1','u_keep1','stolen',1);
    INSERT INTO inbox(wallet,kind,text,created_at) VALUES('u_keep1','reply','someone replied',1);
    INSERT INTO inbox(wallet,kind,text,created_at) VALUES('u_keep1','sale','sold',1);
    INSERT INTO events(kind,text,created_at) VALUES('idea','New idea',1);
    INSERT INTO events(kind,text,created_at) VALUES('item','New item',1);
    INSERT INTO mod_queue(kind,target,wallet,created_at) VALUES('image','1','u_keep1',1);
    INSERT INTO mod_queue(kind,target,wallet,created_at) VALUES('held','1','u_keep1',1);
    INSERT INTO mod_actions(at,actor,action,wallet) VALUES(1,'panel','mute','u_keep1');
    INSERT INTO settings(k,v,updated_at) VALUES('areas','{"chat":true,"club":true,"store":false,"${j('bount', 'ies')}":false,"wallet":true}',1);
    INSERT INTO settings(k,v,updated_at) VALUES('${j('post_min', '_tbb')}','1000',1);
    INSERT INTO settings(k,v,updated_at) VALUES('story_title','"Kept"',1);
    INSERT INTO kv(k,v) VALUES('allies_rev','6'); INSERT INTO kv(k,v) VALUES('audit_rev','1'); INSERT INTO kv(k,v) VALUES('vacuum_rev','1');`);
  raw.close();
  for (let pass = 0; pass < 2; pass++) {
    const db = openDb(file);
    try {
      const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
      for (const t of ['nonces', j('bount', 'ies'), j('list', 'ings'), 'orders', 'used_sigs', 'reviews']) assert.ok(!tables.includes(t), `pass ${pass}: ${t} still there`);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      for (const t of ['users', 'sessions', 'messages', 'reactions', 'ideas', 'votes', 'reports', 'inbox', 'mod_actions', 'mod_hits', 'mod_queue']) assert.ok(cols(t).includes('uid') && !cols(t).includes('wallet'), `pass ${pass}: ${t} renamed`);
      for (const col of [j('wallet', '_addr'), 'seller', 'mc', 'mc_checked_at', 'bal_base']) assert.ok(!cols('users').includes(col), col);
      assert.ok(!cols('ideas').includes(j('bount', 'y_id')));
      assert.deepEqual(db.all('SELECT uid, name, username, via FROM users ORDER BY uid').map((r) => ({ ...r })), [{ uid: 'u_keep1', name: 'keeper', username: 'keeper', via: 'password' }], 'the password account kept; the former-sign-in account, which nobody could ever sign into again and whose id was a public address, is gone with its rows');
      for (const t of ['sessions', 'messages', 'reactions', 'ideas', 'votes', 'reports', 'inbox', 'mod_actions', 'mod_hits', 'mod_queue', 'ip_log']) assert.equal(db.get(`SELECT COUNT(*) n FROM ${t} WHERE uid LIKE '4Kgv%'`).n, 0, `pass ${pass}: ${t} keeps nothing of the deleted account`);
      assert.ok(db.all('SELECT uid FROM users').every((r) => /^u_/.test(r.uid) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.uid)), 'no account id looks like an address');
      assert.deepEqual(db.all('SELECT uid, body FROM messages ORDER BY id').map((r) => ({ ...r })), [{ uid: 'u_keep1', body: 'still here' }, { uid: 'u_keep1', body: 'in the old room' }], 'messages kept, the old room’s rows included');
      assert.deepEqual({ ...db.get('SELECT uid, title FROM ideas') }, { uid: 'u_keep1', title: 'an idea' }); assert.equal(db.get('SELECT COUNT(*) n FROM votes WHERE uid=?', 'u_keep1').n, 1);
      assert.deepEqual(db.all('SELECT kind FROM reports ORDER BY id').map((r) => r.kind), ['problem'], 'reports on former things are gone, Help notes stay');
      assert.deepEqual(db.all('SELECT kind FROM inbox ORDER BY id').map((r) => r.kind), ['reply']);
      assert.deepEqual(db.all('SELECT kind FROM events ORDER BY id').map((r) => r.kind), ['idea']);
      assert.deepEqual(db.all('SELECT kind FROM mod_queue ORDER BY id').map((r) => r.kind), ['held']);
      assert.equal(db.get('SELECT uid FROM mod_actions').uid, 'u_keep1');
      assert.deepEqual(JSON.parse(db.get("SELECT v FROM settings WHERE k='areas'").v), { chat: false, accounts: false }, 'the panel switches are closed after the move: opening is a fresh panel action, whatever the former switches said');
      assert.equal(db.get("SELECT v FROM settings WHERE k=?", j('post_min', '_tbb')), undefined);
      assert.equal(db.get("SELECT v FROM settings WHERE k='story_title'").v, '"Kept"');
      assert.equal(db.get("SELECT v FROM kv WHERE k='dashboard_rev'").v, '2');
      // the indexes follow the new column, and nothing of the old names stays
      const idx = db.all("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").map((r) => r.name + ' ' + r.sql);
      assert.ok(!idx.some((s) => /wallet/.test(s)), 'no index names the old column: ' + idx.filter((s) => /wallet/.test(s)).join(' | '));
    } finally { db.close(); }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the published tree never names a wallet module, a commerce route, a former setting or address; the word wallet stays only where visitors are warned', () => {
  const exporter = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.sh')).map((f) => path.join(ROOT, 'scripts', f)).find((f) => /git archive --format=tar HEAD/.test(fs.readFileSync(f, 'utf8')));
  let files;
  if (exporter) { // the working tree: what the export script ships, committed or not
    const allow = /ALLOW=\(([^)]*)\)/.exec(fs.readFileSync(exporter, 'utf8'))[1].split(/\s+/).filter(Boolean);
    const walk = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((f) => walk(path.join(p, f))) : [p]);
    files = allow.filter((f) => fs.existsSync(path.join(ROOT, f))).flatMap((f) => walk(path.join(ROOT, f)));
    try { files.push(...execFileSync('git', ['ls-files', '--', ...allow], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => path.join(ROOT, f))); } catch { /* not a git repository */ }
  } else { // the published tree: everything in it
    const walk = (p) => (fs.statSync(p).isDirectory() ? (['.git', 'node_modules', 'data'].includes(path.basename(p)) ? [] : fs.readdirSync(p).flatMap((f) => walk(path.join(p, f)))) : [p]);
    files = walk(ROOT);
  }
  const TEXT = /\.(js|mjs|cjs|html|css|md|json|yml|yaml|txt|py|sh|example|gitignore)$/;
  const needles = [...FORMER_ENV, ...FORMER_CONFIG.filter((k) => k !== j('treas', 'ury')), j('/api/', 'listings'), j('/api/', 'orders'), j('/api/', 'bounties'), j('/api/', 'shipped'), j('/api/', 'seller'), j('/api/', 'tx/'), j('/api/', 'purchases'),
    j('/api/auth/', 'nonce'), j('/api/auth/', 'verify'), j('/api/me/', 'wallet'), j('/api/panel/', 'build'), j('/api/panel/', 'seller'), j('/api/panel/', 'bounty'), j('/upl', 'oads/'), j('check', 'out('),
    j('#/', 'store'), j('#/', 'club'), j('#/build/', 'bounty'), j('#/build/', 'shipped'), j('wallet', '.js'), j('txcheck', '.js'), j('pay', '.js'), j('sign', 'Message'), j('signAnd', 'Send'), j('wallet-', 'standard'),
    j('verifyEd', '25519'), j('buildTrans', 'action'), j('tokenBalance', 'Of'), j('getTokenAccounts', 'ByOwner'), j('verify', 'Payment'), j('wallet', '_addr'), j('need', 'Wallet'), j('refresh', 'Mc'), j('tbb', 'Balance'), j('post_min', '_tbb'),
    j('image', 'Pending'), j('approve', '_image'), j('remove', '_listing'), j('set', 'Seller'), j('mark', 'Paid'), j('legacy', 'User'), j('wallet', 'Only'), j('WALLET', '_ONLY')];
  const words = [/\bbount(y|ies)\b/i, /millionaire/i, /\bCheckout\b/, /treasur/i, /\blistings?\b/i, /\bsellers?\b/i, /\bStore\b/, /\bthe store\b/i, /sign.?in with solana/i, /\bsiws\b/i];
  // the one word the site keeps saying, on purpose, where it warns visitors (and where the chat rules refuse addresses, the
  // Season board's own JSON is read, and the screenshot script fakes that board): never in the server routes, the panel or the data
  const WALLET_OK = new Set(['public/index.html', 'public/back-soon.html', 'public/js/views.js', 'lib/rules.js', 'lib/modrules.js', 'lib/common-passwords.js', 'lib/feeds.js', 'scripts/shots.js', 'README.md', 'SECURITY.md', 'DECISIONS.md']);
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f) || !fs.existsSync(f) || !TEXT.test(f) || fs.statSync(f).isDirectory()) continue; seen.add(f);
    const rel = path.relative(ROOT, f); const src = fs.readFileSync(f, 'utf8');
    // lib/db.js names the former tables, columns and row kinds once, in the migration that drops them (checked above to do exactly that)
    const text = rel === 'lib/db.js' ? src.replace(/function toDashboard\(db\) \{[\s\S]*?\n\}\n/, '') : /^lib\/(common-passwords|bip39words)\.js$/.test(rel) ? '' : src; // the two word lists are words, not features
    for (const n of needles) assert.ok(!text.includes(n), `${rel} mentions ${JSON.stringify(n)}`);
    if (rel === 'test/unit/dashboard-only.test.js') continue; // this file spells the words it looks for
    for (const w of words) assert.ok(!w.test(text), `${rel} matches ${w}: ${JSON.stringify(w.exec(text)?.[0])}`);
    if (!rel.startsWith('test/') && !WALLET_OK.has(rel)) assert.ok(!/wallet/i.test(text), `${rel} says wallet: ${JSON.stringify(/.{0,40}wallet.{0,40}/i.exec(text)?.[0])}`);
  }
  assert.ok(seen.size > 50, 'the tree was scanned: ' + seen.size);
});
