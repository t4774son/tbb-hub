// Sign in with X (OAuth 2.0 authorization code + PKCE S256, confidential client). Built now, OFF until X_CLIENT_ID,
// X_CLIENT_SECRET and X_REDIRECT_URI are all set: with any missing there is no X button anywhere and these routes 404.
// Scopes are exactly `users.read tweet.read` (the minimum for GET /2/users/me); no write, no DM, no offline.access.
// Exactly ONE paid call per sign-in (GET /2/users/me: id + username), then the access token is dropped — never stored.
// We keep only the X user id (to match the account) and the handle (shown as plain text "𝕏 @handle", never a link).
// A daily cap (X_LOGIN_DAILY_CAP, default 500) keeps the paid API from running up a bill.
import crypto from 'node:crypto';
import { send, parseCookies, makeLimiter, readBody, bad, HttpError } from './http.js';
import { readCapped } from './net.js';
import { isStaffUsername } from './auth.js';

const STATE_TTL = 10 * 60_000; const PENDING_TTL = 10 * 60_000;
const SCOPES = 'users.read tweet.read';
const sha256b64u = (s) => crypto.createHash('sha256').update(s).digest('base64url');

export function makeX({ config, db, log = () => {}, fetchImpl = fetch, isLocal = false, secureCookie = false, now = Date.now,
  open = () => true, ipBanned = () => false, signupsFrom = () => 0, logIp = () => {}, startSession, isBanned = () => false, userRow, randomId, checkUsername, session = () => null }) {
  const c = config.x || {};
  const redirectOk = /^https:\/\/[a-z0-9.-]+\/auth\/x\/callback$/i.test(c.redirectUri) || (isLocal && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/auth\/x\/callback$/.test(c.redirectUri));
  const configured = !!(c.clientId && c.clientSecret && redirectOk);
  if ((c.clientId || c.clientSecret || c.redirectUri) && !configured) log('Sign in with X stays off: X_CLIENT_ID, X_CLIENT_SECRET and X_REDIRECT_URI (https://<host>/auth/x/callback) must all be set.');
  // the real X endpoints; a local test server may stand in only when the site itself is local
  const apiBase = isLocal && c.apiBase ? c.apiBase.replace(/\/$/, '') : 'https://api.x.com';
  const authUrl = isLocal && c.authUrl ? c.authUrl : 'https://x.com/i/oauth2/authorize';
  const allow = makeLimiter();
  const states = new Map();   // state → { verifier, cookieHash, exp, link }
  const pending = new Map();  // sha256(cookie token) → { xId, handle, exp }
  const purge = () => { const t = now(); for (const [k, v] of states) if (v.exp < t) states.delete(k); for (const [k, v] of pending) if (v.exp < t) pending.delete(k); while (states.size > 5000) states.delete(states.keys().next().value); while (pending.size > 5000) pending.delete(pending.keys().next().value); };
  const dayKey = () => 'x_logins:' + new Date(now()).toISOString().slice(0, 10);
  const today = () => db.kvGet(dayKey(), 0);
  const capped = () => c.dailyCap > 0 && today() >= c.dailyCap;
  const enabled = () => configured && open() && !capped();
  const cookie = (name, value, maxAge, path) => `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const back = (res, q, extra = []) => { res.writeHead(302, { Location: `/#/?x=${q}`, 'Cache-Control': 'no-store', 'Set-Cookie': [cookie('tbb_x', '', 0, '/auth/x'), ...extra] }); res.end(); };
  const byXId = (id) => db.get('SELECT * FROM users WHERE x_id=?', String(id));

  async function xFetch(path, init) {
    const res = await fetchImpl(apiBase + path, { ...init, headers: { 'user-agent': 'Mozilla/5.0', ...(init?.headers || {}) }, signal: AbortSignal.timeout(8000), redirect: 'error' });
    const text = await readCapped(res, 64 * 1024);
    let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    if (!res.ok || !j) throw new Error(`x ${path} ${res.status}`);
    return j;
  }
  // The one paid call per sign-in, after the code exchange. Returns { id, username }; the token is a local variable that dies here.
  async function whoami(code, verifier) {
    const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: c.redirectUri, code_verifier: verifier, client_id: c.clientId }).toString();
    const tok = await xFetch('/2/oauth2/token', { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
    if (typeof tok.access_token !== 'string' || !tok.access_token) throw new Error('x token missing');
    const me = await xFetch('/2/users/me', { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/json' } });
    const id = String(me?.data?.id || ''); const username = String(me?.data?.username || '');
    if (!/^\d{1,30}$/.test(id) || !/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new Error('x user shape');
    return { id, username };
  }

  async function handle(req, res, ip, p, url) {
    if (!configured) return send(res, 404, 'Not found');
    try {
      if (req.method !== 'GET') throw bad('GET only', 405);
      if (!allow('x:' + ip, 20, 10)) throw bad('Slow down a little.', 429);
      purge();
      if (p === '/auth/x/start') {
        if (!open()) return back(res, 'closed');
        if (ipBanned(ip)) return back(res, 'banned');
        if (capped()) return back(res, 'busy');
        const link = url.searchParams.get('link') === '1' ? session(req)?.uid || null : null;
        if (url.searchParams.get('link') === '1' && !link) return back(res, 'signin');
        const state = crypto.randomBytes(24).toString('base64url'); const verifier = crypto.randomBytes(48).toString('base64url'); const tok = crypto.randomBytes(24).toString('base64url');
        states.set(state, { verifier, cookieHash: sha256b64u(tok), exp: now() + STATE_TTL, link });
        const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri, scope: SCOPES, state, code_challenge: sha256b64u(verifier), code_challenge_method: 'S256' });
        res.writeHead(302, { Location: `${authUrl}?${q}`, 'Cache-Control': 'no-store', 'Set-Cookie': cookie('tbb_x', tok, STATE_TTL / 1000, '/auth/x') });
        return res.end();
      }
      if (p === '/auth/x/callback') {
        const state = String(url.searchParams.get('state') || ''); const code = String(url.searchParams.get('code') || '');
        const rec = states.get(state); states.delete(state); // single use, whatever happens next
        const tok = parseCookies(req.headers.cookie).tbb_x || '';
        if (!rec || rec.exp < now() || !tok || sha256b64u(tok) !== rec.cookieHash) return back(res, 'error');
        if (url.searchParams.get('error') || !/^[A-Za-z0-9_.~-]{10,512}$/.test(code)) return back(res, 'error');
        if (ipBanned(ip)) return back(res, 'banned');
        if (capped()) return back(res, 'busy');
        let who;
        try { who = await whoami(code, rec.verifier); } catch (e) { log('x sign-in failed', e.message); return back(res, 'error'); }
        db.kvSet(dayKey(), today() + 1); // the paid call happened
        if (isStaffUsername(who.username)) return back(res, 'handle');
        if (rec.link) {
          const u = userRow(rec.link); if (!u) return back(res, 'signin');
          const other = byXId(who.id); if (other && other.uid !== u.uid) return back(res, 'taken');
          db.run('UPDATE users SET x_id=?, x_handle=? WHERE uid=?', who.id, who.username, u.uid);
          return back(res, 'linked');
        }
        const user = byXId(who.id);
        if (user) {
          if (isBanned(user)) return back(res, 'account');
          if (user.x_handle !== who.username) db.run('UPDATE users SET x_handle=? WHERE uid=?', who.username, user.uid);
          startSession(req, res, user.uid); logIp(user.uid, ip, 'signin');
          res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store', 'Set-Cookie': [cookie('tbb_x', '', 0, '/auth/x'), res.getHeader('Set-Cookie')].flat() });
          return res.end();
        }
        if (signupsFrom(ip) >= 3) return back(res, 'toomany');
        const ptok = crypto.randomBytes(24).toString('base64url');
        pending.set(sha256b64u(ptok), { xId: who.id, handle: who.username, exp: now() + PENDING_TTL });
        return back(res, 'new', [cookie('tbb_xp', ptok, PENDING_TTL / 1000, '/')]);
      }
      throw bad('Not found', 404);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      log('x error', e.message); return send(res, 500, { error: 'Something broke on our side. Try again in a moment.' });
    }
  }

  // JSON routes (registered by lib/app.js under its CSRF checks): finishing a first X sign-in, unlinking.
  const pendingOf = (req) => { purge(); const t = parseCookies(req.headers.cookie).tbb_xp; const rec = t ? pending.get(sha256b64u(t)) : null; return rec && rec.exp > now() ? { key: sha256b64u(t), ...rec } : null; };
  const api = {
    // what the welcome card needs: the handle, and whether it can be the username
    pending(req) {
      if (!configured) throw bad('Not found', 404);
      if (!open()) throw bad('Sign-in is coming soon.', 503);
      const rec = pendingOf(req); if (!rec) throw bad('That sign-in expired. Start again.', 410);
      const free = !checkUsername(rec.handle) && !db.get('SELECT 1 FROM users WHERE lower(username)=lower(?) OR lower(name)=lower(?)', rec.handle, rec.handle);
      return { handle: rec.handle, suggested: free ? rec.handle : null };
    },
    // the account: username (the handle when free and allowed, else the one picked) + the 18+ confirmation. No password yet
    // (X is the way in); one can be set later from the account menu, which also issues the recovery code.
    finish(req, res, body, ip) {
      if (!configured) throw bad('Not found', 404);
      if (!open()) throw bad('Sign-in is coming soon.', 503);
      const rec = pendingOf(req); if (!rec) throw bad('That sign-in expired. Start again.', 410);
      if (body.adult !== true) throw bad('Confirm that you are 18 or older.', 422);
      const username = String(body.username || rec.handle).trim();
      const err = checkUsername(username); if (err) throw bad(err, 422);
      if (db.get('SELECT 1 FROM users WHERE lower(username)=lower(?) OR lower(name)=lower(?)', username, username)) throw bad('Someone already has that username.', 409);
      if (byXId(rec.xId)) throw bad('This X account is already signed up. Sign in with X again.', 409);
      if (signupsFrom(ip) >= 3) throw bad('Too many new accounts from this connection today. Try again tomorrow.', 429);
      const uid = 'u_' + randomId(15).replace(/[^A-Za-z0-9]/g, 'x');
      db.run("INSERT INTO users(uid,name,username,x_id,x_handle,created_at,adult_confirmed_at,via) VALUES(?,?,?,?,?,?,?,'x')", uid, username, username, rec.xId, rec.handle, now(), now());
      pending.delete(rec.key);
      logIp(uid, ip, 'signup'); logIp(uid, ip, 'signin');
      startSession(req, res, uid);
      res.setHeader('Set-Cookie', [res.getHeader('Set-Cookie'), cookie('tbb_xp', '', 0, '/')].flat());
      return { ok: true, username };
    },
    unlink(u) {
      if (!u) throw bad('Sign in first.', 401);
      if (!u.x_id) return { ok: true };
      if (!u.pass_hash) throw bad('Set a password first, so you can still sign in without X.', 400);
      db.run('UPDATE users SET x_id=NULL, x_handle=NULL WHERE uid=?', u.uid);
      return { ok: true };
    },
  };
  return { configured, enabled, capped, today, handle, api, cap: c.dailyCap, _states: states, _pending: pending };
}
