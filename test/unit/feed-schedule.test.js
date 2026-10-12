// Outside data refreshes on the server's own timer, never because someone visited: a request only reads the cache, so
// nothing in /api/state (or on the stream) says when anyone else loaded the page. Exposed refresh times are quantised.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../lib/app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MINT = '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump';
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbfeed-'));
let app; let base; let fetches = 0;
const fakeFetch = async (url) => {
  fetches++; const u = String(url);
  const body = u.includes('geckoterminal') ? { data: { attributes: { ohlcv_list: Array.from({ length: 24 }, (_, i) => [1791460000 + i * 3600, 0, 0, 0, 0.008 + i / 10000, 1]) } }, meta: { base: { address: MINT } } }
    : u.includes('dexscreener') ? { pairs: [{ baseToken: { address: MINT }, priceUsd: '0.008', priceChange: { h24: 1.5 }, liquidity: { usd: 1 }, marketCap: 8_000_000, pairAddress: '6unnG2hL8udPjDpu3TchvAtptu3dq8AS7tymrWDN2LLC' }] }
    : u.includes('prices') ? { USD: 98_000 } : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
before(async () => {
  app = createApp({ env: { PORT: '0', LORE_WORKER: 'off', PUBLIC_ORIGIN: 'http://localhost:3000', CLIENT_IP_HEADER: 'x-test-ip', DB_FILE: path.join(dir, 'f.db'), SEASON_BOARD_URL: '' },
    rpc: async () => { throw new Error('offline'); }, fetchImpl: fakeFetch, log: () => {} });
  const port = (await app.listen(0)).port; base = `http://127.0.0.1:${port}`;
  await app.feeds.tick(); // the timer's first pass, awaited so the numbers are there
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const get = (p, ip) => fetch(base + p, { headers: { 'x-test-ip': ip } }).then((r) => r.json());

test('an observer polling /api/state sees exactly the same feed times before and after another connection loads the page (chart, state, links): requests never refresh a feed', async () => {
  const before = await get('/api/state', '203.0.113.1');
  assert.equal(before.stats.price, 0.008, 'the numbers are there');
  assert.ok(before.stats.feeds.market.at > 0 && before.stats.feeds.chart.at > 0, 'every feed was refreshed by the timer: ' + JSON.stringify(before.stats.feeds));
  const n = fetches;
  app.feeds._cache.clear(); // everything stale at once: a visitor-driven refresh would show here
  const visitor = '203.0.113.2';
  await get('/api/chart', visitor); await get('/api/state', visitor); await get('/api/allies', visitor); await get('/api/chart', visitor);
  assert.equal(fetches, n, 'no outside request was made because somebody visited');
  const after = await get('/api/state', '203.0.113.1');
  assert.deepEqual(after.stats.feeds, before.stats.feeds, 'the observer learns nothing from the feed times');
  assert.equal(after.stats.price, null, 'with the cache empty the answer is empty, never a fetch');
  await app.feeds.tick();
  assert.ok(fetches > n, 'the timer refreshes');
  assert.equal((await get('/api/state', '203.0.113.1')).stats.price, 0.008);
});

test('exposed refresh times are quantised to ten seconds', async () => {
  const s = await get('/api/state', '203.0.113.3');
  for (const [k, v] of Object.entries(s.stats.feeds)) if (v.at) assert.equal(v.at % 10_000, 0, k + '.at is a multiple of 10 s: ' + v.at);
  assert.equal(s.stats.at % 10_000, 0, 'stats.at too');
});

test('no route calls a feed: the request path reads the cache only (lib/app.js), and the timer is the only caller', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/app.js'), 'utf8');
  assert.ok(!/feeds\.(market|chart|btc|holders|staked|season)\(\)/.test(src), 'no feeds.x() call in app.js');
  assert.ok(/feeds\.start\(\)/.test(src) && /feeds\.stop\(\)/.test(src), 'the timer starts with the server and stops with it');
});
