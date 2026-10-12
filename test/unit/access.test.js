// Cloudflare Access JWT verification with a locally generated RSA key and a fake certs endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeAccessVerifier } from '../../lib/access.js';

const TEAM = 'example-team'; const AUD = 'a'.repeat(64); const EMAIL = 'Admin@Example.com';
const EMAIL_SHA = crypto.createHash('sha256').update(EMAIL.toLowerCase()).digest('hex');
const rsa = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const K1 = rsa(); const K2 = rsa();
const b64u = (b) => Buffer.from(b).toString('base64url');
function jwt(claims, { key = K1.privateKey, kid = 'kid-1', alg = 'RS256', now = Math.floor(Date.now() / 1000) } = {}) {
  const payload = { iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], email: EMAIL, iat: now, nbf: now, exp: now + 600, ...claims };
  const head = b64u(JSON.stringify({ alg, kid, typ: 'JWT' })); const body = b64u(JSON.stringify(payload));
  const sig = alg === 'none' ? '' : alg === 'HS256' ? b64u(crypto.createHmac('sha256', 'x').update(`${head}.${body}`).digest()) : b64u(crypto.sign('sha256', Buffer.from(`${head}.${body}`), key));
  return `${head}.${body}.${sig}`;
}
const jwk = (kp, kid) => ({ kid, kty: 'RSA', alg: 'RS256', use: 'sig', ...kp.publicKey.export({ format: 'jwk' }) });
function certs(keysList, { status = 200 } = {}) {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ keys: keysList(), public_certs: [] }), { status, headers: { 'content-type': 'application/json' } }); };
  return { fetchImpl, get calls() { return calls; } };
}
const make = (c, extra = {}) => makeAccessVerifier({ team: TEAM, aud: AUD, emailSha256: EMAIL_SHA, fetchImpl: c.fetchImpl, ...extra });

test('a token signed by the team key, for our audience and the admin e-mail, passes; keys are fetched once and cached', async () => {
  const c = certs(() => [jwk(K1, 'kid-1')]); const v = make(c);
  assert.equal(v.configured, true);
  assert.deepEqual(await v.verify(jwt({})), { ok: true });
  assert.deepEqual(await v.verify(jwt({ email: 'admin@example.com' })), { ok: true }, 'e-mail compared case-insensitively');
  assert.deepEqual(await v.verify(jwt({ aud: AUD })), { ok: true }, 'aud as a string');
  assert.equal(c.calls, 1, 'one certs fetch for three verifications');
});

test('every wrong thing fails closed: audience, issuer, expiry, nbf, e-mail, signature, algorithm, shape', async () => {
  const c = certs(() => [jwk(K1, 'kid-1')]); const v = make(c);
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    [jwt({ aud: ['b'.repeat(64)] }), 'audience'],
    [jwt({ iss: 'https://other-team.cloudflareaccess.com' }), 'issuer'],
    [jwt({ exp: now - 120 }), 'expired'],
    [jwt({ nbf: now + 300 }), 'not yet valid'],
    [jwt({ iat: now + 300 }), 'issued in the future'],
    [jwt({ email: 'someone-else@example.com' }), 'not the admin'],
    [jwt({ email: '' }), 'no email'],
    [jwt({}, { key: K2.privateKey }), 'signature'],
    [jwt({}, { alg: 'none' }), 'malformed'], // an empty signature segment is refused before the header is even read
    [jwt({}, { alg: 'HS256' }), 'alg'],
    [jwt({}).replace(/\.[^.]+$/, '.AAAA'), 'signature'],
    ['', 'no token'], [null, 'no token'], ['a.b', 'malformed'], ['x.y.z', 'malformed'], ['x'.repeat(9000), 'no token'],
  ];
  for (const [tok, reason] of cases) assert.equal((await v.verify(tok)).reason, reason, reason);
  assert.deepEqual(await v.verify(jwt({ exp: now - 30 })), { ok: true }, 'a little clock skew is fine');
});

test('unknown key id refetches the certs once (key rotation), then throttles', async () => {
  let current = [jwk(K1, 'kid-1')];
  const c = certs(() => current); const v = make(c);
  assert.deepEqual(await v.verify(jwt({})), { ok: true }); assert.equal(c.calls, 1);
  current = [jwk(K2, 'kid-2')];
  assert.deepEqual(await v.verify(jwt({}, { key: K2.privateKey, kid: 'kid-2' })), { ok: true }, 'rotated key found after a refetch'); assert.equal(c.calls, 2);
  assert.equal((await v.verify(jwt({}))).reason, 'unknown key', 'old key is gone now');
  assert.equal((await v.verify(jwt({}, { kid: 'kid-9' }))).reason, 'unknown key');
  assert.equal(c.calls, 2, 'no refetch storm: one refetch per 30 s for unknown key ids');
});

test('fails closed when the certs endpoint is down, wrong, or oversized; recovers later', async () => {
  for (const bad of [
    async () => { throw new Error('ECONNREFUSED'); },
    async () => new Response('nope', { status: 503 }),
    async () => new Response('{"keys":[]}', { status: 200 }),
    async () => new Response('{"keys":[{"kty":"oct","kid":"kid-1","k":"x"}]}', { status: 200 }),
    async () => new Response('[' + '1,'.repeat(150_000) + '1]', { status: 200, headers: { 'content-length': String(300_003) } }),
  ]) {
    const v = makeAccessVerifier({ team: TEAM, aud: AUD, emailSha256: EMAIL_SHA, fetchImpl: bad });
    assert.equal((await v.verify(jwt({}))).ok, false);
  }
  let t = Date.now(); let fail = true; const c = certs(() => { if (fail) throw new Error('down'); return [jwk(K1, 'kid-1')]; }); const v = make(c, { now: () => t });
  assert.equal((await v.verify(jwt({}))).ok, false); fail = false;
  t += 31_000; // a failed fetch is remembered for 30 s (see below): the next attempt is after that
  assert.deepEqual(await v.verify(jwt({})), { ok: true }, 'recovers once the endpoint answers');
});

test('a failed or empty certs fetch is remembered: tokens cannot trigger a fetch each (30 s, doubling to 10 min, reset by a success)', async () => {
  let t = Date.now(); let fail = true;
  const c = certs(() => { if (fail) return []; return [jwk(K1, 'kid-1')]; }); const v = make(c, { now: () => t });
  const tok = () => jwt({ iat: Math.floor(t / 1000), nbf: Math.floor(t / 1000), exp: Math.floor(t / 1000) + 600 });
  for (let i = 0; i < 7; i++) assert.equal((await v.verify(tok())).ok, false);
  assert.equal(c.calls, 1, 'seven tokens, one fetch');
  t += 29_000; await v.verify(tok()); assert.equal(c.calls, 1, 'not before 30 s');
  t += 2_000; await v.verify(tok()); assert.equal(c.calls, 2, 'the second attempt after 30 s');
  t += 45_000; await v.verify(tok()); assert.equal(c.calls, 2, 'the wait doubled to 60 s');
  t += 20_000; await v.verify(tok()); assert.equal(c.calls, 3);
  for (let i = 0; i < 8; i++) { t += 11 * 60_000; await v.verify(tok()); } // 2, 4, 8, 10, 10 … minutes
  assert.equal(c.calls, 11);
  t += 9 * 60_000; await v.verify(tok()); assert.equal(c.calls, 11, 'capped at 10 min: not before');
  t += 2 * 60_000; fail = false; assert.deepEqual(await v.verify(tok()), { ok: true }); assert.equal(c.calls, 12, 'fetched once the wait is over, and it worked');
  for (let i = 0; i < 5; i++) assert.deepEqual(await v.verify(tok()), { ok: true });
  assert.equal(c.calls, 12, 'cached again');
  fail = true; t += 61 * 60_000; await v.verify(tok()); assert.equal(c.calls, 13, 'after the hour: a refresh (which failed)');
  t += 10_000; await v.verify(tok()); assert.equal(c.calls, 13, 'a failed refresh is remembered too: the old keys serve meanwhile, no fetch per token');
});

test('cached keys expire after an hour', async () => {
  let t = Date.now(); const c = certs(() => [jwk(K1, 'kid-1')]); const v = make(c, { now: () => t });
  assert.deepEqual(await v.verify(jwt({})), { ok: true }); assert.equal(c.calls, 1);
  t += 30 * 60_000; await v.verify(jwt({})); assert.equal(c.calls, 1);
  t += 31 * 60_000; await v.verify(jwt({ iat: Math.floor(t / 1000), nbf: Math.floor(t / 1000), exp: Math.floor(t / 1000) + 600 })); assert.equal(c.calls, 2, 'refetched after the hour');
});

test('missing or malformed configuration = never open', async () => {
  const c = certs(() => [jwk(K1, 'kid-1')]);
  for (const cfg of [{}, { team: TEAM }, { team: TEAM, aud: AUD }, { team: TEAM, aud: AUD, emailSha256: 'not-a-hash' }, { team: 'bad team/..', aud: AUD, emailSha256: EMAIL_SHA }, { team: TEAM, aud: 'short', emailSha256: EMAIL_SHA }]) {
    const v = makeAccessVerifier({ ...cfg, fetchImpl: c.fetchImpl });
    assert.equal(v.configured, false); assert.deepEqual(await v.verify(jwt({})), { ok: false, reason: 'not configured' });
  }
  assert.equal(c.calls, 0, 'never even fetches');
});

// A segment is base64url or nothing — no decoding of '+', '/', '=' or other characters.
test('a token whose segments carry anything outside [A-Za-z0-9_-] is malformed before any decoding', async () => {
  const c = certs(() => [jwk(K1, 'kid-1')]); const v = make(c);
  const good = jwt({}); assert.deepEqual(await v.verify(good), { ok: true });
  const [h, b, s] = good.split('.');
  assert.ok(/[-_]/.test(s), 'the signature has a url-safe character to replace');
  const std = s.replace(/-/g, '+').replace(/_/g, '/'); // standard base64 alphabet: same bytes once decoded, but not a JWT segment
  for (const tok of [`${h}.${b}.${std}`, `${h}.${b}.${s}=`, `${h}.${b}.${s}%20`, `${h}.${b}.`, `.${b}.${s}`, `${h}.${b}.${s}\n`]) assert.deepEqual(await v.verify(tok), { ok: false, reason: 'malformed' }, tok.slice(-12));
});
