// Deleted rows leave no bytes behind: secure_delete is on, and a database written before that is vacuumed once at open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../lib/db.js';

const bytes = (file) => Buffer.concat([file, file + '-wal'].map((f) => { try { return fs.readFileSync(f); } catch { return Buffer.alloc(0); } }));

test('secure_delete is on, and a deleted Help note is not in the file or the log after the checkpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbbsd-')); const file = path.join(dir, 'h.db');
  const db = openDb(file);
  try {
    assert.equal(db.get('PRAGMA secure_delete').secure_delete, 1);
    db.run("INSERT INTO reports(kind,target,uid,reason,created_at) VALUES('problem','help',NULL,'canary-note-one-of-a-kind',?)", Date.now());
    db.run("DELETE FROM reports WHERE reason='canary-note-one-of-a-kind'");
    db.checkpoint();
    assert.ok(!bytes(file).includes('canary-note-one-of-a-kind'), 'the text survives on disk');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a database written without secure_delete is vacuumed once at open: old residue goes, and the step is not repeated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbbsd-')); const file = path.join(dir, 'old.db');
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode=WAL; CREATE TABLE reports(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, uid TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0); CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  for (let i = 0; i < 5; i++) raw.exec(`INSERT INTO reports(kind,target,reason,created_at) VALUES('problem','help','residue-canary-${i} ${'x'.repeat(200)}',1)`);
  raw.exec('DELETE FROM reports'); raw.close();
  assert.ok(fs.readFileSync(file).includes('residue-canary-'), 'the old file keeps deleted text (what the migration is for)');
  let db = openDb(file);
  try {
    assert.ok(!bytes(file).includes('residue-canary-'), 'vacuumed at open');
    assert.equal(db.kvGet('vacuum_rev'), 1);
    db.run("INSERT INTO reports(kind,target,uid,reason,created_at) VALUES('problem','help',NULL,'kept-note',?)", Date.now());
  } finally { db.close(); }
  db = openDb(file);
  try { assert.equal(db.get("SELECT COUNT(*) n FROM reports WHERE reason='kept-note'").n, 1, 'a second open keeps the data and does not vacuum again'); }
  finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
