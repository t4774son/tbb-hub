// Honest numbers: a missing 24 h change is "—", not 0.0%; a market cap that is really the fully diluted value is labelled
// so; compact() picks its unit after rounding (999,999 is 1.00M, never 1000.0K); pct() prints no sign on a zero; feed
// ages are measured against the server's clock, not the visitor's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFeeds } from '../../lib/feeds.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MINT = '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump';
const fakeDb = { kvGet: (k, d) => d, kvSet() {}, get: () => null, all: () => [], run() { return { changes: 0 }; } };
const feedsFor = (pair) => makeFeeds({ db: fakeDb, rpc: null, config: {}, fetchImpl: async () => new Response(JSON.stringify({ pairs: [pair] }), { status: 200, headers: { 'content-type': 'application/json' } }), log: () => {} });

test('market: no 24 h change from the source → null (the page shows —); market cap and FDV are kept apart', async () => {
  const base = { baseToken: { address: MINT }, priceUsd: '0.0004', liquidity: { usd: 1 }, pairAddress: 'p' };
  const a = await feedsFor({ ...base, marketCap: 400_000, fdv: 400_500, priceChange: { h24: '1.5' } }).market();
  assert.equal(a.change24h, 1.5); assert.equal(a.marketCap, 400_000); assert.equal(a.fdv, 400_500);
  const b = await feedsFor({ ...base, fdv: 400_500 }).market();
  assert.equal(b.change24h, null, 'nothing invented'); assert.equal(b.marketCap, null, 'no market cap means none, not the FDV'); assert.equal(b.fdv, 400_500);
  const c = await feedsFor({ ...base, priceChange: {} }).market();
  assert.equal(c.change24h, null); assert.equal(c.fdv, null);
});

// the page's formatters, loaded with a stand-in document
class Node { constructor(tag) { this.tag = tag; this.attrs = {}; this.kids = []; this.style = {}; this.dataset = {}; } setAttribute(k, v) { this.attrs[k] = v; } addEventListener() {} append(...k) { this.kids.push(...k); } replaceChildren() { this.kids = []; } }
globalThis.document = { createElement: (t) => new Node(t), createElementNS: (ns, t) => new Node(t), createTextNode: (t) => Object.assign(new Node('#text'), { text: String(t) }), createDocumentFragment: () => new Node('#frag') };
globalThis.Node = Node;
const ui = await import('../../public/js/ui.js');

test('compact(): the unit is chosen after rounding; pct(): no sign on a value that rounds to zero', () => {
  assert.deepEqual([999_999, 999_996_000, 999_950_000, 999_949, 52_714_377, 12_345, 9_999.6, 9_999.4, 999, 0, -1_234_567].map(ui.compact), ['1.00M', '1.00B', '999.95M', '999.9K', '52.71M', '12.3K', '10,000', '9,999', '999', '0', '-1.23M']);
  assert.equal(ui.compact(NaN), '—');
  assert.deepEqual([0.04, -0.04, 0, 0.06, -2.34, 12, null, NaN].map(ui.pct), ['0.0%', '0.0%', '0.0%', '+0.1%', '−2.3%', '+12.0%', '—', '—']);
});

test('ageLabel(): measured against the clock it is given, so a visitor five minutes fast does not see "delayed"', () => {
  const T = 1_800_000_000_000; const f = { at: T - 30_000, ttl: 60_000 };
  assert.deepEqual(ui.ageLabel(f, T), { text: 'just now', stale: false, title: 'Last updated just now; refreshes about every 1 min.' });
  const fast = ui.ageLabel(f, T + 5 * 60_000); assert.equal(fast.stale, true, 'the naive reading');
  const corrected = ui.ageLabel(f, T + 5 * 60_000 - 5 * 60_000); assert.equal(corrected.stale, false, 'after the skew is taken out');
  assert.deepEqual(ui.ageLabel({ at: T - 7 * 60_000, ttl: 60_000 }, T), { text: 'delayed · 7m ago', stale: true, title: 'Delayed: the source has not answered lately. Last updated 7m ago; refreshes about every 1 min.' });
  assert.deepEqual(ui.ageLabel(null, T), { text: '', stale: false, title: '' });
  const app = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  assert.ok(!/function ageLabel/.test(app) && /ageLabel\(/.test(app), 'the page imports the formatter');
  assert.ok(/skew/.test(app) && /stats\.at|s\.at/.test(app), 'the page measures its clock against stats.at');
  assert.ok(/FDV/.test(app), 'the page labels the fully diluted value as such');
});
