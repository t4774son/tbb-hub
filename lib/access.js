// Cloudflare Access, checked again inside the app (defense in depth: the tunnel and Cloudflare already enforce it).
// Every request to the admin host must carry Cf-Access-Jwt-Assertion: an RS256 JWT signed by the team's Access keys.
// We fetch those public keys ourselves, cache them for an hour, refetch once on an unknown key id, and fail closed on
// anything odd. A fetch that fails or brings no usable key is remembered too (30 s, doubling to 10 min), so a stream of
// tokens never turns into a stream of fetches. The admin's e-mail is never stored: only sha256(lowercase e-mail) is
// compared, in constant time.
import crypto from 'node:crypto';
import { readCapped } from './net.js';

const b64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function makeAccessVerifier({ team, aud, emailSha256, fetchImpl = fetch, now = Date.now, log = () => {}, keyTtlMs = 3600_000, skewMs = 60_000 } = {}) {
  const configured = !!(team && aud && emailSha256) && /^[a-z0-9-]{1,63}$/i.test(team) && /^[a-f0-9]{64}$/i.test(emailSha256) && /^[a-f0-9]{16,128}$/i.test(aud);
  const issuer = `https://${team}.cloudflareaccess.com`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  const wantEmail = configured ? Buffer.from(emailSha256, 'hex') : null;
  let keys = new Map(); let fetchedAt = 0; let inflight = null; let lastMiss = 0; let fetches = 0; let fails = 0; let lastTry = 0;
  const retryWait = () => Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, fails - 1));

  async function loadKeys(force) {
    if (!force && keys.size && now() - fetchedAt < keyTtlMs) return keys;
    if (force && now() - lastMiss < 30_000) return keys; // an unknown kid refetches at most every 30 s (no refetch storms)
    if (fails && now() - lastTry < retryWait()) return keys; // the last fetch failed: not again before the wait is over
    if (force) lastMiss = now();
    if (!inflight) {
      inflight = (async () => {
        try {
          fetches++; lastTry = now();
          const res = await fetchImpl(certsUrl, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
          if (!res.ok) throw new Error(`certs ${res.status}`);
          const j = JSON.parse(await readCapped(res, 200_000));
          const next = new Map();
          for (const k of Array.isArray(j?.keys) ? j.keys : []) {
            if (k?.kty !== 'RSA' || typeof k.kid !== 'string' || typeof k.n !== 'string' || typeof k.e !== 'string' || (k.alg && k.alg !== 'RS256')) continue;
            try { next.set(k.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' })); } catch { /* skip a bad key */ }
          }
          if (!next.size) throw new Error('no RSA keys in certs');
          keys = next; fetchedAt = now(); fails = 0;
        } catch (e) { fails++; log('access certs', e.message); }
        finally { inflight = null; }
      })();
    }
    await inflight;
    return keys;
  }

  async function verify(token) {
    if (!configured) return { ok: false, reason: 'not configured' };
    if (typeof token !== 'string' || !token || token.length > 8192) return { ok: false, reason: 'no token' };
    const parts = token.split('.'); if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' }; // base64url only, before any decoding
    let header; let payload;
    try { header = JSON.parse(b64u(parts[0]).toString('utf8')); payload = JSON.parse(b64u(parts[1]).toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
    if (!header || typeof header !== 'object' || header.alg !== 'RS256' || typeof header.kid !== 'string' || !payload || typeof payload !== 'object') return { ok: false, reason: 'alg' };
    let key = (await loadKeys(false)).get(header.kid);
    if (!key) key = (await loadKeys(true)).get(header.kid);
    if (!key) return { ok: false, reason: 'unknown key' };
    let good = false;
    try { good = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64u(parts[2])); } catch { good = false; }
    if (!good) return { ok: false, reason: 'signature' };
    const t = now() / 1000; const skew = skewMs / 1000;
    if (payload.iss !== issuer) return { ok: false, reason: 'issuer' };
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return { ok: false, reason: 'audience' };
    if (!(typeof payload.exp === 'number' && payload.exp + skew > t)) return { ok: false, reason: 'expired' };
    if (typeof payload.nbf === 'number' && payload.nbf - skew > t) return { ok: false, reason: 'not yet valid' };
    if (typeof payload.iat === 'number' && payload.iat - skew > t) return { ok: false, reason: 'issued in the future' };
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!email) return { ok: false, reason: 'no email' };
    if (!crypto.timingSafeEqual(crypto.createHash('sha256').update(email).digest(), wantEmail)) return { ok: false, reason: 'not the admin' };
    return { ok: true };
  }

  return { verify, configured, issuer, certsUrl, get fetches() { return fetches; } };
}
