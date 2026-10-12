// A dead feed is not refetched on every /api/state; repeated failures back off exponentially,
// 1 min → 2 → 4 … → 30 min cap, for every outside feed; a success resets the schedule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFeeds } from '../../lib/feeds.js';

const fakeDb = { kvGet: (k, d) => d, kvSet() {}, get: () => null, all: () => [], run() {} };
const MIN = 60_000;

test('cached(): failures back off 1 → 2 → 4 min …, capped at 30 min; a success resets to the normal refresh', async () => {
  let calls = 0; let fail = true;
  const fetchImpl = async () => { calls++; if (fail) throw new Error('connect ECONNREFUSED'); return new Response(JSON.stringify({ USD: 100000 }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const feeds = makeFeeds({ db: fakeDb, rpc: null, config: {}, fetchImpl, log: () => {} });
  // with a remembered value (even a remembered failure) a read answers at once and refreshes in the background: let that land
  const f = { btc: async () => { const v = await feeds.btc(); await new Promise((r) => setImmediate(r)); return v; }, status: feeds.status };
  const realNow = Date.now; let t = realNow(); Date.now = () => t;
  try {
    assert.equal(await f.btc(), null); assert.equal(await f.btc(), null); assert.equal(calls, 1, 'one outside request while the feed is down');
    t += 21_000; await f.btc(); assert.equal(calls, 1, 'not retried after 20 s any more');
    t += 40_000; await f.btc(); assert.equal(calls, 2, 'retried after 1 min (failure 1)');
    t += MIN + 59_000; await f.btc(); assert.equal(calls, 2, 'the second wait is 2 min');
    t += 2_000; await f.btc(); assert.equal(calls, 3, 'retried after 2 min (failure 2)');
    t += 4 * MIN + 1000; await f.btc(); assert.equal(calls, 4, 'then 4 min');
    for (let i = 0; i < 8; i++) { t += 31 * MIN; await f.btc(); } // 8 → 16 → 30 → 30 … minutes
    assert.equal(calls, 12);
    t += 29 * MIN; await f.btc(); assert.equal(calls, 12, 'capped: not before 30 min');
    t += 2 * MIN; await f.btc(); assert.equal(calls, 13, 'capped at 30 min');
    assert.equal(f.status().btc.error, 'connect ECONNREFUSED'); assert.equal(f.status().btc.fails, 13);
    fail = false; t += 31 * MIN; assert.equal(await f.btc(), null, 'the remembered answer once more while the refresh runs'); assert.equal(calls, 14);
    assert.deepEqual(await f.btc(), { usd: 100000 }); assert.equal(calls, 14);
    assert.equal(f.status().btc.fails, 0, 'a success resets the schedule');
    t += 121_000; await f.btc(); assert.equal(calls, 15, 'back to the normal 2 min refresh');
    fail = true; t += 121_000; assert.deepEqual(await f.btc(), { usd: 100000 }, 'stale value served while refreshing in the background');
    assert.equal(calls, 16);
    t += 59_000; await f.btc(); assert.equal(calls, 16, 'with an old value the retry waits 1 min too (was 15 s)');
    t += 2_000; assert.deepEqual(await f.btc(), { usd: 100000 }, 'the old value stays'); assert.equal(calls, 17);
  } finally { Date.now = realNow; }
});
