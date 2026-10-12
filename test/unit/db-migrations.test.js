// One-time database moves: the launch switches are reset to closed when a database is brought over (consent for one
// feature is not consent for another; opening again is a fresh, audited panel action), an older file without the
// account columns still opens, and housekeeping purges what the privacy text says is purged even while nothing is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../lib/db.js';
import { createApp } from '../../lib/app.js';

const tmp = (name) => path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbdbm-')), name);
const fakeFetch = async () => new Response(JSON.stringify({ pairs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
const rpc = async () => { throw new Error('no rpc'); };
const DAY = 86400_000;

test('a database already at the dashboard shape with the panel switches open: one start resets them to closed, once, with an audit row by the migration', () => {
  const file = tmp('rev1.db');
  let db = openDb(file);
  // what production looked like after the first move: at dashboard rev 1 with an open row carried over
  db.run("INSERT INTO settings(k,v,updated_at) VALUES('areas',?,1)", JSON.stringify({ chat: true, accounts: true }));
  db.run("INSERT OR REPLACE INTO kv(k,v) VALUES('dashboard_rev','1')");
  db.run('DELETE FROM admin_audit');
  db.close();
  db = openDb(file);
  try {
    assert.deepEqual(JSON.parse(db.get("SELECT v FROM settings WHERE k='areas'").v), { chat: false, accounts: false }, 'both closed');
    const rows = db.all('SELECT action, before, after, actor FROM admin_audit').map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ action: 'area:reset', before: JSON.stringify({ chat: true, accounts: true }), after: JSON.stringify({ chat: false, accounts: false }), actor: 'migration' }]);
    assert.equal(db.get("SELECT v FROM kv WHERE k='dashboard_rev'").v, '2');
    db.run("UPDATE settings SET v=? WHERE k='areas'", JSON.stringify({ chat: true, accounts: false })); // the panel opens chat again later
  } finally { db.close(); }
  db = openDb(file);
  try {
    assert.deepEqual(JSON.parse(db.get("SELECT v FROM settings WHERE k='areas'").v), { chat: true, accounts: false }, 'a later panel choice is not reset again');
    assert.equal(db.get('SELECT COUNT(*) n FROM admin_audit').n, 1, 'no second audit row');
  } finally { db.close(); }
});

test('no stored switches (production today): nothing to reset, no audit row, the rev is still recorded', () => {
  const file = tmp('norow.db');
  let db = openDb(file);
  db.run("INSERT OR REPLACE INTO kv(k,v) VALUES('dashboard_rev','1')"); db.run('DELETE FROM admin_audit'); db.close();
  db = openDb(file);
  try {
    assert.equal(db.get("SELECT v FROM settings WHERE k='areas'"), undefined);
    assert.equal(db.get('SELECT COUNT(*) n FROM admin_audit').n, 0);
    assert.equal(db.get("SELECT v FROM kv WHERE k='dashboard_rev'").v, '2');
  } finally { db.close(); }
});

test('a database from before the account columns (no username, no x_id) opens: the indexes on those columns wait for them', () => {
  const file = tmp('ancient.db');
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE users(uid TEXT PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX users_name ON users(lower(name));
    INSERT INTO users(uid,name,created_at) VALUES('u_old','elder',1);`);
  raw.close();
  const db = openDb(file);
  try {
    const cols = db.all('PRAGMA table_info(users)').map((c) => c.name);
    for (const c of ['username', 'pass_hash', 'x_id', 'via']) assert.ok(cols.includes(c), 'column added: ' + c);
    const idx = db.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='users'").map((r) => r.name);
    assert.ok(idx.includes('users_username') && idx.includes('users_x_id'), 'the unique indexes exist once the columns do: ' + idx.join(','));
    assert.equal(db.get("SELECT name FROM users WHERE uid='u_old'").name, 'elder');
  } finally { db.close(); }
});

test('old switches on + ACCOUNTS_OPEN=1 and CHAT_OPEN=1: nothing opens until a panel flip', async () => {
  const file = tmp('flags.db');
  const raw = new DatabaseSync(file);
  // the pre-move shape, reduced to what the move reads: the account-id column under its former name and the former switches
  raw.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE users(wallet TEXT PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL DEFAULT 'wallet');
    CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
    INSERT INTO settings(k,v,updated_at) VALUES('areas','{"chat":true,"wallet":true,"store":true}',1);`);
  raw.close();
  const app = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: file, PUBLIC_ORIGIN: 'http://localhost:3000', CHAT_OPEN: '1', ACCOUNTS_OPEN: '1' }, rpc, fetchImpl: fakeFetch, log: () => {} });
  try {
    const a = await app.listen(0); const base = `http://127.0.0.1:${a.port}`;
    const st = await (await fetch(base + '/api/state')).json();
    assert.deepEqual(st.features, { chat: false, accounts: false, ideas: false }, 'closed on a migrated database whatever .env says');
    assert.equal((await fetch(base + '/api/auth/pow')).status, 503);
    app.settings.set('areas', { chat: false, accounts: true }); // the panel flip
    assert.deepEqual((await (await fetch(base + '/api/state')).json()).features, { chat: false, accounts: true, ideas: true });
  } finally { await app.close(); }
});

test('housekeeping purges hashed IPs past 7 days, rule hits past 30 days and expired sessions, with nothing being written', async () => {
  const file = tmp('keep.db');
  const app = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: file, PUBLIC_ORIGIN: 'http://localhost:3000' }, rpc, fetchImpl: fakeFetch, log: () => {} });
  try {
    const t = Date.now(); const db = app.db;
    db.run("INSERT INTO users(uid,name,created_at) VALUES('u_a','a',1)");
    db.run("INSERT INTO ip_log(uid,ip_hash,kind,at) VALUES('u_a','h1','post',?)", t - 8 * DAY);
    db.run("INSERT INTO ip_log(uid,ip_hash,kind,at) VALUES('u_a','h2','post',?)", t - 6 * DAY);
    db.run("INSERT INTO mod_hits(uid,kind,at) VALUES('u_a','link',?)", t - 31 * DAY);
    db.run("INSERT INTO mod_hits(uid,kind,at) VALUES('u_a','link',?)", t - 29 * DAY);
    db.run("INSERT INTO sessions(id,uid,created_at,expires_at) VALUES('s1','u_a',?,?)", t - 10 * DAY, t - 3 * DAY);
    db.run("INSERT INTO sessions(id,uid,created_at,expires_at) VALUES('s2','u_a',?,?)", t, t + 3 * DAY);
    app.housekeeping();
    assert.deepEqual(db.all('SELECT ip_hash FROM ip_log').map((r) => r.ip_hash), ['h2']);
    assert.deepEqual(db.all('SELECT at FROM mod_hits').map((r) => r.at), [t - 29 * DAY]);
    assert.deepEqual(db.all('SELECT id FROM sessions').map((r) => r.id), ['s2']);
  } finally { await app.close(); }
});

test('the demo seed plants plain u_ ids: no account id anywhere looks like an address', async () => {
  const { seed, DEMO_IDS } = await import('../../scripts/seed.js');
  const db = openDb(':memory:');
  try {
    seed(db, { demo: true });
    const ids = db.all('SELECT uid FROM users').map((r) => r.uid);
    assert.ok(ids.length >= 4 && ids.every((u) => /^u_[a-z0-9]+$/i.test(u) && u.length < 32), ids.join(','));
    assert.ok(DEMO_IDS.every((u) => ids.includes(u)));
  } finally { db.close(); }
});
