// SQLite storage (node:sqlite). One file, WAL mode, secure_delete (a deleted row's bytes are overwritten, not left in
// a free page for anyone with the file or a backup to read).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Accounts: `uid` is the account id ("u_…"). Passwords and recovery codes are hashes; there is no e-mail, phone or name.
const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA secure_delete=ON;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  uid TEXT PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL,
  banned INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER NOT NULL DEFAULT 0, adult_confirmed_at INTEGER, report_weight REAL NOT NULL DEFAULT 1,
  username TEXT, pass_hash TEXT, recovery_hash TEXT, pass_changed_at INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0, lock_until INTEGER NOT NULL DEFAULT 0,
  x_id TEXT, x_handle TEXT, ban_until INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL DEFAULT 'password');
CREATE UNIQUE INDEX IF NOT EXISTS users_name ON users(lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_x_id ON users(x_id);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, uid TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, room TEXT NOT NULL, uid TEXT NOT NULL, body TEXT NOT NULL,
  reply_to INTEGER, created_at INTEGER NOT NULL, edited_at INTEGER, hidden INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
  held INTEGER NOT NULL DEFAULT 0, mod_reason TEXT, mod_by TEXT);
CREATE INDEX IF NOT EXISTS messages_room ON messages(room, id);
CREATE TABLE IF NOT EXISTS reactions(message_id INTEGER NOT NULL, uid TEXT NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY(message_id, uid, emoji));
CREATE TABLE IF NOT EXISTS ideas(
  id INTEGER PRIMARY KEY, uid TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  created_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS votes(idea_id INTEGER NOT NULL, uid TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(idea_id, uid));
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, uid TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY, uid TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, link TEXT, created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS inbox_uid ON inbox(uid, id);
CREATE TABLE IF NOT EXISTS allies(id INTEGER PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, blurb TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS lore(
  id INTEGER PRIMARY KEY, height INTEGER NOT NULL, block_hash TEXT NOT NULL, txid TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, found_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'approved', UNIQUE(txid, text));
CREATE INDEX IF NOT EXISTS lore_status_height ON lore(status, height);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, link TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staked_hist(at INTEGER PRIMARY KEY, amount REAL NOT NULL);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admin_audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, before TEXT, after TEXT, actor TEXT NOT NULL DEFAULT 'panel');
-- moderation: every action (panel, automatic rule, community) with what it did, so it can be undone in one click
CREATE TABLE IF NOT EXISTS mod_actions(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, uid TEXT, message_id INTEGER, reason TEXT NOT NULL DEFAULT '', meta TEXT, undone_at INTEGER);
CREATE INDEX IF NOT EXISTS mod_actions_uid ON mod_actions(uid, id);
-- rule hits (a refused link / address / scam phrase) per account, for the automatic escalation
CREATE TABLE IF NOT EXISTS mod_hits(id INTEGER PRIMARY KEY, uid TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS mod_hits_uid ON mod_hits(uid, at);
-- the admin's queue, beyond user reports and held messages: automatic mutes, community hides
CREATE TABLE IF NOT EXISTS mod_queue(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, target TEXT, uid TEXT, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, resolution TEXT);
CREATE INDEX IF NOT EXISTS reports_target ON reports(kind, target);
-- Keyed hashes of visitor IPs (never the IP) for the last 7 days of sign-ins / posts, max 10 per account;
-- IP bans are timed (24 h / 7 d / 30 d), never permanent
CREATE TABLE IF NOT EXISTS ip_log(id INTEGER PRIMARY KEY, uid TEXT NOT NULL, ip_hash TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ip_log_uid ON ip_log(uid, at);
CREATE INDEX IF NOT EXISTS ip_log_hash ON ip_log(ip_hash, at);
CREATE TABLE IF NOT EXISTS ip_bans(ip_hash TEXT PRIMARY KEY, until INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', uid TEXT, created_at INTEGER NOT NULL);
`;

// Dashboard rev 1 (one time): the project became a read-only dashboard. A database from before carries the tables of
// the former paid features and names its account-id column after what the first accounts were made with. Those tables
// go, the column is renamed everywhere, the rows that belonged to the former features go, and the accounts, messages,
// ideas, votes, Help notes and settings stay. Runs before the schema, because the schema's indexes name the new column.
function toDashboard(db) {
  const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!tables().includes('users') || !cols('users').includes('wallet')) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of ['nonces', 'bounties', 'listings', 'orders', 'used_sigs', 'reviews']) db.exec(`DROP TABLE IF EXISTS ${t}`);
    for (const i of ['users_wallet_addr', 'orders_buyer', 'inbox_wallet', 'mod_actions_wallet', 'mod_hits_wallet']) db.exec(`DROP INDEX IF EXISTS ${i}`);
    for (const t of ['users', 'sessions', 'messages', 'reactions', 'ideas', 'votes', 'reports', 'inbox', 'mod_actions', 'mod_hits', 'mod_queue']) if (tables().includes(t) && cols(t).includes('wallet')) db.exec(`ALTER TABLE ${t} RENAME COLUMN wallet TO uid`);
    for (const c of ['wallet_addr', 'seller', 'mc', 'mc_checked_at', 'bal_base']) if (cols('users').includes(c)) db.exec(`ALTER TABLE users DROP COLUMN ${c}`);
    if (tables().includes('ideas') && cols('ideas').includes('bounty_id')) db.exec('ALTER TABLE ideas DROP COLUMN bounty_id');
    db.exec("UPDATE users SET via='legacy' WHERE via='wallet'");
    if (tables().includes('reports')) db.exec("DELETE FROM reports WHERE kind IN ('listing','bounty')");
    if (tables().includes('inbox')) db.exec("DELETE FROM inbox WHERE kind IN ('sale','purchase','seller','review','bounty')");
    if (tables().includes('events')) db.exec("DELETE FROM events WHERE kind IN ('item','bounty','done','club')");
    if (tables().includes('mod_queue')) db.exec("DELETE FROM mod_queue WHERE kind='image'");
    if (tables().includes('settings')) {
      db.exec("DELETE FROM settings WHERE k='post_min_tbb'");
      const row = db.prepare("SELECT v FROM settings WHERE k='areas'").get();
      if (row) { let v = {}; try { v = JSON.parse(row.v) || {}; } catch { /* unreadable: the default (closed) applies */ } db.prepare("UPDATE settings SET v=? WHERE k='areas'").run(JSON.stringify({ chat: v.chat === true, accounts: v.wallet === true })); }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return true;
}

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  const moved = toDashboard(db);
  db.exec(SCHEMA);
  // The database holds password hashes, hashed IPs, sessions and the per-install secret: nobody else on the box reads it.
  if (file !== ':memory:') for (const f of [file, file + '-wal', file + '-shm']) { try { fs.chmodSync(f, 0o600); } catch { /* not there yet (WAL files appear on first write) or not ours to change */ } }
  const add = (table, cols) => { for (const col of cols) { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* already there */ } } };
  // Columns added over time to databases made before them
  add('users', ['muted_until INTEGER NOT NULL DEFAULT 0', 'adult_confirmed_at INTEGER', 'report_weight REAL NOT NULL DEFAULT 1']);
  add('messages', ['held INTEGER NOT NULL DEFAULT 0', 'mod_reason TEXT', 'mod_by TEXT']);
  add('users', ['username TEXT', 'pass_hash TEXT', 'recovery_hash TEXT', 'pass_changed_at INTEGER NOT NULL DEFAULT 0', 'fail_count INTEGER NOT NULL DEFAULT 0', 'lock_until INTEGER NOT NULL DEFAULT 0',
    'x_id TEXT', 'x_handle TEXT', 'ban_until INTEGER NOT NULL DEFAULT 0', 'via TEXT NOT NULL DEFAULT \'password\'']);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(lower(username)); CREATE UNIQUE INDEX IF NOT EXISTS users_x_id ON users(x_id)');
  // Once: rows deleted before secure_delete was on left their bytes in free pages. Rebuild the file and truncate the log.
  const checkpoint = () => db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  if (!db.prepare("SELECT 1 FROM kv WHERE k='vacuum_rev' AND v='1'").get()) { db.exec('VACUUM'); checkpoint(); db.prepare("INSERT OR REPLACE INTO kv(k,v) VALUES('vacuum_rev','1')").run(); }
  if (moved || !db.prepare("SELECT 1 FROM kv WHERE k='dashboard_rev' AND v='1'").get()) { if (moved) { db.exec('VACUUM'); checkpoint(); } db.prepare("INSERT OR REPLACE INTO kv(k,v) VALUES('dashboard_rev','1')").run(); }
  const cache = new Map();
  const prep = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    raw: db,
    all: (sql, ...p) => prep(sql).all(...p),
    get: (sql, ...p) => prep(sql).get(...p),
    run: (sql, ...p) => prep(sql).run(...p),
    tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    kvGet(k, d = null) { const r = prep('SELECT v FROM kv WHERE k=?').get(k); return r ? JSON.parse(r.v) : d; },
    kvSet(k, v) { prep('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v)); },
    checkpoint, // moves the log into the file and truncates it: after a delete, nothing of the row stays in the -wal file
    close: () => db.close(),
  };
}
