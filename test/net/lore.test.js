// Network test (opt-in: npm run test:net). Scans real Bitcoin blocks through mempool.space and checks the filter on live data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../lib/db.js';
import { makeFeeds, GENESIS } from '../../lib/feeds.js';
import { cleanLore } from '../../lib/rules.js';

test('real blocks: genesis decodes, scanner finds only clean text', { timeout: 240_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbnet-'));
  const db = openDb(path.join(dir, 'n.db'));
  const feeds = makeFeeds({ db, rpc: null, config: { mempoolBase: 'https://mempool.space/api', mempoolGapMs: 1200 }, log: (...a) => console.log(...a) });
  // Genesis block straight from the chain.
  await feeds.lore.scanBlock(0, { pages: 1 });
  const g = db.all('SELECT * FROM lore WHERE height=0');
  assert.ok(g.some((r) => r.text === GENESIS.text), 'genesis coinbase text decoded from the real block');
  await feeds.lore.landmarks();
  await feeds.lore.tick();
  assert.ok(db.all("SELECT 1 FROM lore WHERE text LIKE '%will you marry me%'").length, 'proposal found at 416236');
  assert.ok(db.all("SELECT 1 FROM lore WHERE text LIKE '%Hal Finney%'").length, 'Hal Finney note found at 717008');
  assert.ok(db.all("SELECT 1 FROM lore WHERE text LIKE 'Benedictus%'").length, 'Eligius blessing found');
  const rows = db.all('SELECT height, kind, text FROM lore ORDER BY height');
  console.log(`found ${rows.length} messages:`); for (const r of rows) console.log(`  #${r.height} ${r.kind}: ${r.text}`);
  for (const r of rows) assert.equal(cleanLore(r.text), r.text, 'every stored entry passes the filter');
  assert.ok(feeds.lore.tip > 800000, 'live tip height read');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
