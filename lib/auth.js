// Accounts without identity: a username, a password and a one-time recovery code. Nothing here is an e-mail, a phone
// number or a real name. Passwords and recovery codes are stored only as scrypt hashes (N=2^15, r=8, p=1, 16-byte salt,
// 64-byte key, the parameters kept with each hash) and compared in constant time. Sign-in failures are throttled per
// connection and per account with growing delays; sign-up needs a proof of work the browser computes itself
// (SubtleCrypto SHA-256), so no third party is ever contacted.
import crypto from 'node:crypto';
import { bad } from './http.js';
import { COMMON_PASSWORDS } from './common-passwords.js';
import { checkName, normalize } from './rules.js';

export const SCRYPT = { N: 2 ** 15, r: 8, p: 1, saltBytes: 16, keyBytes: 64 };
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
export const USERNAME_RULE = 'Usernames are 3 to 20 characters: letters, numbers and underscores.';

// A gate: at most `max` jobs run at once, up to `queue` wait their turn (first come, first served), anything past that
// is refused at once with a 429. Used around scrypt so a flood of sign-in attempts can never pin the CPU or the thread
// pool: the work that is let through is bounded, the rest costs nothing.
export function makeGate({ max = 2, queue = 20 } = {}) {
  let running = 0; const waiting = [];
  const next = () => { if (running < max && waiting.length) { running++; waiting.shift()(); } };
  return {
    max, queue, get running() { return running; }, get waiting() { return waiting.length; },
    async run(job) {
      if (running >= max) {
        if (waiting.length >= queue) throw bad('Slow down a little.', 429);
        await new Promise((resolve) => waiting.push(resolve));
      } else running++;
      try { return await job(); } finally { running--; next(); }
    },
  };
}
export const scryptGate = makeGate({ max: 2, queue: 20 });

const scrypt = (secret, salt, { N, r, p, keyBytes }) => scryptGate.run(() => new Promise((resolve, reject) =>
  crypto.scrypt(Buffer.from(String(secret).normalize('NFKC'), 'utf8'), salt, keyBytes, { N, r, p, maxmem: 256 * N * r }, (e, k) => (e ? reject(e) : resolve(k)))));

// "scrypt$N$r$p$salt$key" (salt and key base64url). The parameters travel with the hash so they can be raised later.
export async function hashSecret(secret, params = SCRYPT) {
  const salt = crypto.randomBytes(params.saltBytes);
  const key = await scrypt(secret, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export function parseHash(stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{16,})$/.exec(String(stored || ''));
  if (!m) return null;
  const N = Number(m[1]); const r = Number(m[2]); const p = Number(m[3]);
  if (!(N >= 2 ** 14 && N <= 2 ** 20 && (N & (N - 1)) === 0 && r >= 1 && r <= 32 && p >= 1 && p <= 8)) return null;
  return { N, r, p, salt: Buffer.from(m[4], 'base64url'), key: Buffer.from(m[5], 'base64url') };
}
// Constant-time compare; false (never a throw) for a malformed stored value.
export async function verifySecret(secret, stored) {
  const h = parseHash(stored);
  if (!h || typeof secret !== 'string' || secret.length > PASSWORD_MAX + 100) return false;
  const got = await scrypt(secret, h.salt, { N: h.N, r: h.r, p: h.p, keyBytes: h.key.length });
  return got.length === h.key.length && crypto.timingSafeEqual(got, h.key);
}
// A hash nobody knows the secret of: verified against when a username does not exist, so a failed sign-in takes the
// same time whether or not the account is real.
let dummy = null;
export async function dummyVerify(secret = 'x') {
  if (!dummy) dummy = await hashSecret(crypto.randomBytes(24).toString('base64url'));
  return verifySecret(String(secret), dummy);
}

// ---- usernames ----
// Whole words that read as staff (checked as tokens: "mod_squad" and "m0d" are out, "modest" is fine) ...
const STAFF_TOKENS = ['admin', 'admins', 'administrator', 'mod', 'mods', 'moderator', 'moderators', 'support', 'official', 'team', 'staff', 'tbb', 'owner', 'sysadmin', 'helpdesk', 'bitcoinbull', 'thebitcoinbull', 'bull_team', 'system'];
// ... and fragments that read as staff wherever they appear, after leet letters are mapped and separators dropped.
const STAFF_PARTS = ['admin', 'moderator', 'official', 'support', 'staff', 'helpdesk', 'bitcoinbull', 'tbbteam', 'teamtbb', 'tbbofficial', 'tbbsupport', 'tbbadmin', 'tbbmod', 'tbbstaff', 'tbbhelp', 'tbbowner', 'tbbdev', 'tbbbot', 'thebull', 'bullteam'];
const tokens = (s) => s.toLowerCase().split(/[^a-z]+/).filter(Boolean);
export function isStaffUsername(u) {
  const raw = String(u);
  const leet = raw.toLowerCase().replace(/[0@]/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5|\$/g, 's').replace(/7/g, 't');
  const toks = new Set([...tokens(raw), ...tokens(leet)]);
  if (STAFF_TOKENS.some((t) => toks.has(t))) return true;
  const squashed = normalize(raw).replace(/ /g, '');
  return STAFF_PARTS.some((p) => squashed.includes(p));
}
// null when fine, else the message to show.
export function checkUsername(u) {
  const s = String(u ?? '');
  if (!USERNAME_RE.test(s)) return USERNAME_RULE;
  if (/^_|_$|__/.test(s)) return 'Underscores go between letters, not at the ends.';
  if (!/[A-Za-z]/.test(s)) return 'A username needs at least one letter.';
  if (isStaffUsername(s)) return 'That username is reserved. Pick your own.';
  return checkName(s); // the display-name rules too: reserved people, slurs, nothing that looks like a web address
}

// ---- passwords ----
export function checkPassword(p, username = '') {
  if (typeof p !== 'string') return 'Enter a password.';
  if (p.length < PASSWORD_MIN) return `Passwords are at least ${PASSWORD_MIN} characters. A few words you will remember work well.`;
  if (p.length > PASSWORD_MAX) return `That password is too long (max ${PASSWORD_MAX}).`;
  if (/^(.)\1+$/.test(p)) return 'One character repeated is not a password.';
  const low = p.toLowerCase();
  const stem = low.replace(/[0-9!.?*#_-]{1,4}$/, '');
  if (COMMON_PASSWORDS.has(low) || (stem.length >= PASSWORD_MIN && COMMON_PASSWORDS.has(stem))) return 'That password is on the list of the most common ones. Pick something only you would think of.';
  const u = String(username || '').toLowerCase();
  if (u.length >= 3 && low.includes(u)) return 'The password must not contain your username.';
  return null;
}

// ---- recovery codes ----
// 25 characters from an alphabet without 0/O, 1/I/L (about 124 bits), shown once as five groups of five.
const CODE_ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function makeRecoveryCode() {
  let s = ''; for (let i = 0; i < 25; i++) s += CODE_ALPHA[crypto.randomInt(CODE_ALPHA.length)];
  return s.match(/.{5}/g).join('-');
}
// Whatever the person typed (spaces, dashes, lower case, O for 0) → the canonical 25 characters, or null.
export function normalizeRecoveryCode(v) {
  const s = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/0/g, 'O').replace(/[1I]/g, 'L').replace(/O/g, 'Q').replace(/L/g, 'J');
  // (the alphabet has no O/0/1/I/L: a typed O or 0 can only be a misread Q, a 1/I/l a misread J: cheap forgiveness, no ambiguity)
  return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{25}$/.test(s) ? s : null;
}
export const canonicalCode = (code) => String(code).replace(/-/g, '');

// ---- sign-in throttling ----
// Per key (a hashed connection, an account): the first failures are free, then every failure doubles the wait,
// up to five minutes. Success clears the key. Memory-capped; stale keys are dropped.
export function makeThrottle({ now = Date.now, free = 2, maxWaitMs = 300_000, max = 50_000 } = {}) {
  const m = new Map();
  const purge = () => { if (m.size < max) return; const cut = now() - 3600_000; for (const [k, e] of m) if (e.at < cut) m.delete(k); if (m.size >= max) m.delete(m.keys().next().value); };
  return {
    // seconds to wait before the next attempt (0 = go ahead)
    wait(key) { const e = m.get(key); if (!e || e.until <= now()) return 0; return Math.max(1, Math.ceil((e.until - now()) / 1000)); },
    fail(key) {
      purge();
      const e = m.get(key) || { fails: 0, until: 0, at: 0 };
      e.fails++; e.at = now();
      const delay = e.fails <= free ? 0 : Math.min(maxWaitMs, 1000 * 2 ** (e.fails - free - 1));
      e.until = now() + delay; m.set(key, e);
      return e.fails;
    },
    clear(key) { m.delete(key); },
    fails(key) { return m.get(key)?.fails || 0; },
    // an explicit cool-down (the same 15 minutes a real account gets after ten failures), so a made-up username behaves like a real one
    lock(key, ms) { purge(); const e = m.get(key) || { fails: 0, until: 0, at: 0 }; e.at = now(); e.until = Math.max(e.until, now() + ms); m.set(key, e); },
    // the wait is over, the count stays (tests use it to skip the doubling waits)
    release(key) { const e = m.get(key); if (e) e.until = 0; },
  };
}

// ---- proof of work (sign-up) ----
// The server hands out a random challenge; the browser finds a nonce such that sha256(challenge + ':' + nonce) starts with
// `bits` zero bits (about 1–2 s on a phone at 16 bits); the server checks it once, within 5 minutes.
export function leadingZeroBits(buf) {
  let n = 0;
  for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; }
  return n;
}
export const powHash = (challenge, nonce) => crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
export function makePow({ bits = 16, ttlMs = 5 * 60_000, now = Date.now, max = 20_000 } = {}) {
  const live = new Map();
  const purge = () => { const t = now(); for (const [k, c] of live) if (c.exp < t) live.delete(k); while (live.size >= max) live.delete(live.keys().next().value); };
  return {
    bits,
    issue() {
      purge();
      const id = crypto.randomBytes(12).toString('base64url'); const challenge = crypto.randomBytes(16).toString('hex');
      live.set(id, { challenge, exp: now() + ttlMs, used: false });
      return { id, challenge, bits, expires: now() + ttlMs };
    },
    // {ok} or {ok:false, reason}. A challenge is spent on the first verification attempt, right or wrong.
    verify(id, nonce) {
      const c = typeof id === 'string' ? live.get(id) : null;
      if (!c || c.exp < now()) return { ok: false, reason: 'expired' };
      if (c.used) return { ok: false, reason: 'used' };
      c.used = true;
      if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(nonce)) return { ok: false, reason: 'bad nonce' };
      if (leadingZeroBits(powHash(c.challenge, nonce)) < bits) return { ok: false, reason: 'wrong' };
      live.delete(id);
      return { ok: true };
    },
    // For tests and scripts: brute-force a nonce here in node.
    solve({ challenge, bits: b = bits }) { for (let n = 0; ; n++) { const nonce = n.toString(36); if (leadingZeroBits(powHash(challenge, nonce)) >= b) return nonce; } },
    size: () => live.size,
  };
}
