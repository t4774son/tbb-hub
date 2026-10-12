// Shared test helpers: a member planted straight into the database (past the new-account slow start: read-only 10 min,
// then one post per 10 s for a day), and a session cookie for it. Tests that must exercise the real sign-up or sign-in
// go through /api/auth/* themselves; everything else needs a member, not a sign-in.
import crypto from 'node:crypto';
import { hashToken } from '../../lib/http.js';

const DAY = 86400_000;
export const newUid = (tag = 't') => 'u_' + tag + crypto.randomBytes(8).toString('hex');
// `name` is the display name (null = the account must still pick one, like /api/me/name asks)
export function plantUser(db, uid, { name = null, ageMs = 2 * DAY, adult = true } = {}) {
  db.run("INSERT OR IGNORE INTO users(uid,name,created_at,adult_confirmed_at,via) VALUES(?,?,?,?,'legacy')", uid, name, Date.now() - ageMs, adult ? Date.now() : null);
  return uid;
}
// A fresh session for an existing account; returns the cookie value a browser would carry.
export function sessionFor(db, uid) {
  const tok = crypto.randomBytes(32).toString('base64url');
  db.run('INSERT INTO sessions(id,uid,created_at,expires_at) VALUES(?,?,?,?)', hashToken(tok), uid, Date.now(), Date.now() + 7 * DAY);
  return 'tbb_s=' + tok;
}
