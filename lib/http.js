import zlib from 'node:zlib';
// HTTP plumbing: security headers, cookies, bodies, rate limits.
import crypto from 'node:crypto';

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
};

export function enableHsts() { SECURITY_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'; }
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const bad = (msg, status = 400) => new HttpError(status, msg);

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) { const i = part.indexOf('='); if (i <= 0) continue; try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip a malformed cookie */ } }
  return out;
}

export function sessionCookie(value, { secure, maxAge }) {
  return `tbb_s=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export async function readBody(req, limit) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > limit) throw bad('Too large', 413);
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw bad('Too large', 413); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw bad('JSON only', 415);
  // Refuse keys that turn String()/Number() on a field into a crash (e.g. {"address":{"toString":1}}).
  const NOPE = new Set(['toString', 'valueOf', '__proto__', 'constructor', 'toJSON']);
  try { const v = JSON.parse(raw, (k, x) => { if (NOPE.has(k)) throw 0; return x; }); if (typeof v !== 'object' || v === null || Array.isArray(v)) throw 0; return v; } catch { throw bad('Bad JSON'); }
}

// Pick br > gzip from Accept-Encoding (no q-value games; every modern browser sends both).
function encodingFor(req) { const ae = String(req?.headers?.['accept-encoding'] || ''); return /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null; }
function compress(buf, enc, level) {
  return enc === 'br' ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }) : zlib.gzipSync(buf, { level: Math.min(9, level) });
}

export function send(res, status, body, headers = {}) {
  const { etag: wantTag, ...rest } = headers;
  let data = Buffer.from(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  const h = { ...SECURITY_HEADERS, 'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...rest };
  // Public, impersonal JSON (links, chart): a content ETag lets the browser revalidate for free (304) instead of re-downloading.
  if (wantTag && status === 200) {
    const tag = '"' + crypto.createHash('sha256').update(data).digest('base64url').slice(0, 22) + '"';
    h.ETag = tag; h['Cache-Control'] = 'no-cache';
    if (res.req?.headers['if-none-match'] === tag) { res.writeHead(304, h); res.end(); return; }
  }
  const enc = data.length > 1024 ? encodingFor(res.req) : null;
  if (enc) { data = compress(data, enc, 4); h['Content-Encoding'] = enc; h.Vary = 'Accept-Encoding'; }
  h['Content-Length'] = data.length;
  res.writeHead(status, h);
  res.end(data);
}

// Token bucket per key. limit(key, ratePerMin, burst) → boolean
export function makeLimiter() {
  const buckets = new Map();
  setInterval(() => { const cut = Date.now() - 3600_000; for (const [k, b] of buckets) if (b.at < cut) buckets.delete(k); }, 600_000).unref();
  function allow(key, perMin, burst = perMin) {
    const now = Date.now();
    // Hard ceiling on remembered visitors, so a flood of fake addresses can't grow memory without end.
    if (!buckets.has(key) && buckets.size >= 100_000) buckets.delete(buckets.keys().next().value);
    const b = buckets.get(key) || { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 60000) * perMin); b.at = now;
    if (b.tokens < 1) { buckets.set(key, b); return false; }
    b.tokens -= 1; buckets.set(key, b); return true;
  }
  allow.forget = (key) => buckets.delete(key); // tests: a full bucket again without waiting for the refill
  return allow;
}




export const randomId = (n = 16) => crypto.randomBytes(n).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
