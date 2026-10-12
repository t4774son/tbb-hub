// Outbound requests (feeds, RPC, block explorer, Access certs, X) never follow a redirect: an upstream that answers 302
// cannot make the server fetch an address of its choosing (loopback, a metadata service). And every block hash or txid
// that goes into an explorer URL is checked to be 64 hex characters first, wherever it came from.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFeeds } from '../../lib/feeds.js';
import { makeRpc } from '../../lib/solana.js';
import { makeAccessVerifier } from '../../lib/access.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fakeDb = { kvGet: (k, d) => d, kvSet() {}, get: () => null, all: () => [], run() { return { changes: 0 }; } };
// an upstream that redirects everything to /internal on the same server, and counts who gets there
let server; let base; const internal = [];
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/internal')) { internal.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    res.writeHead(302, { Location: `${base}/internal?from=${encodeURIComponent(req.url)}` }); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

test('a 302 from the Season board, the block explorer or the RPC is a failure, never a request to where it points', async () => {
  const feeds = makeFeeds({ db: fakeDb, rpc: null, config: { seasonBoard: base + '/', mempoolBase: base, mempoolGapMs: 0 }, fetchImpl: fetch, log: () => {} });
  assert.equal(await feeds.season(), null, 'the board answer is dropped');
  await assert.rejects(feeds.lore.mempool('/blocks/tip/height'));
  const rpc = makeRpc(base + '/rpc', { fetchImpl: fetch, minGapMs: 0 });
  await assert.rejects(rpc('getSlot'));
  assert.deepEqual(internal, [], 'nothing reached the redirect target');
  assert.match(feeds.status().season.error || '', /redirect|fetch failed/i);
});

test('the Access certs fetch and every other outbound call refuse redirects', async () => {
  const seen = [];
  const rec = async (url, init) => { seen.push({ url: String(url), init }); return new Response('{"keys":[]}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  const v = makeAccessVerifier({ team: 'example-team', aud: 'a'.repeat(64), emailSha256: 'b'.repeat(64), fetchImpl: rec });
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  await v.verify(`${b64u({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' })}.${b64u({ iss: 'https://example-team.cloudflareaccess.com' })}.AAAA`);
  assert.ok(seen.length >= 1 && seen.every((s) => s.init?.redirect === 'error'), 'certs: ' + JSON.stringify(seen.map((s) => s.init?.redirect)));
  // every fetchImpl( call in lib/ names the option in the same call
  for (const f of fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8');
    for (const m of src.matchAll(/fetchImpl\(/g)) {
      const call = src.slice(m.index, m.index + 400);
      assert.ok(/redirect: 'error'/.test(call), `lib/${f} at ${m.index}: an outbound call without redirect: 'error' — ${call.slice(0, 120)}`);
    }
  }
});

test('landmarks() and backfill() put a block hash into a URL only when it is 64 hex characters, like scanBlock()', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url).replace(/^https?:\/\/[^/]+/, '')); return new Response('deadbeef-not-a-hash', { status: 200, headers: { 'content-type': 'text/plain' } }); };
  const feeds = makeFeeds({ db: fakeDb, rpc: null, config: { mempoolBase: 'https://mempool.example/api', mempoolGapMs: 0 }, fetchImpl, log: () => {} });
  await feeds.lore.landmarks();
  const realRandom = Math.random;
  try {
    Math.random = () => 0.1; await assert.rejects(feeds.lore.backfill(), /hash/, 'the single-request branch reports the junk');
    Math.random = () => 0.5; assert.equal(await feeds.lore.backfill(), undefined, 'the block scan skips it');
  } finally { Math.random = realRandom; }
  assert.ok(urls.length > 0, 'the heights were asked for');
  assert.ok(urls.every((u) => u.startsWith('/api/block-height/')), 'no junk went into a /block/ URL: ' + urls.filter((u) => !u.startsWith('/api/block-height/')).join(' '));
});
