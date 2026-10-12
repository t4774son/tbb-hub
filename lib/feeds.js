// Outside data, fetched server-side only and cached. Visitors' browsers never talk to these services.
import { TBB_MINT, findProgramAddress } from './solana.js';
import { coinbaseCandidates, opReturnCandidates, cleanLore } from './rules.js';

export const GENESIS = {
  height: 0,
  hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  txid: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
  text: 'The Times 03/Jan/2009 Chancellor on brink of second bailout for banks',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How long to leave an outside service alone after n failures in a row: 1 min, 2, 4, 8, 16, then 30 min.
export const backoffMs = (fails) => Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, fails - 1));

// Never put a full URL in an error: RPC/API URLs can carry keys (?api-key=…), and errors get logged.
const where = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return '?'; } };
// Upstream bodies are capped so a broken or hostile source can't fill memory.
import { readCapped } from './net.js';
export { readCapped };
async function getJson(fetchImpl, url, opts = {}) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000), ...opts });
  if (!res.ok) { const e = new Error(`${res.status} ${where(url)}`); e.status = res.status; throw e; }
  return JSON.parse(await readCapped(res));
}

// Famous on-chain messages, located by height (coinbase) or height + txid prefix (OP_RETURN).
// Only locations live here; the text itself is fetched from the chain and decoded on first run.
export const LANDMARKS = [
  { height: 139792 }, { height: 139977 },            // Eligius' Latin blessings, Aug 2011
  { height: 416236 }, { height: 416253 },            // a proposal in one block, the answer 17 blocks later
  { height: 420000 },                                 // the 2016 halving block
  { height: 629999 },                                 // F2Pool's headline, the last block before the 2020 halving
  { height: 717008, tx: 'c69de2f0' },                 // a note for Hal Finney, 3 Jan 2022
];

export function makeFeeds({ db, rpc, config, fetchImpl = fetch, log = () => {}, emit = () => {} }) {
  const cache = new Map(); const inflight = new Map();
  // Per feed: when it last succeeded, how often it refreshes, and the last error (shown in the admin panel, never to visitors).
  const meta = new Map();
  const note = (key, ttl, patch) => meta.set(key, { okAt: null, ttl, error: null, errorAt: null, fails: 0, ...meta.get(key), ...patch });
  // Fresh → cached value. Stale → cached value now, refresh in the background. Nothing yet → wait for it.
  // Concurrent callers share one outside request. A failure is remembered (null when nothing was cached yet, else the old
  // value) and the feed is not asked again before a wait that doubles with every failure in a row: 1 min, 2, 4 … 30 min
  // (was a flat 20 s / 15 s). A success resets the wait.
  function cached(key, ttlMs, fn) {
    const c = cache.get(key);
    if (c && Date.now() - c.at < ttlMs) return Promise.resolve(c.value);
    let job = inflight.get(key);
    if (!job) {
      job = (async () => {
        try { const value = await fn(); cache.set(key, { at: Date.now(), value }); note(key, ttlMs, { okAt: Date.now(), error: null, errorAt: null, fails: 0 }); return value; }
        catch (e) { const fails = (meta.get(key)?.fails || 0) + 1; log('feed', key, e.message); note(key, ttlMs, { error: String(e.message || e).slice(0, 160), errorAt: Date.now(), fails }); cache.set(key, { at: Date.now() - ttlMs + backoffMs(fails), value: c ? c.value : null }); return c ? c.value : null; }
        finally { inflight.delete(key); }
      })();
      inflight.set(key, job);
    }
    return c ? Promise.resolve(c.value) : job;
  }
  // Freshness of every feed: { market: { okAt, ttl, error, errorAt }, ... }. okAt is the last successful refresh.
  const status = () => ({ ...Object.fromEntries([...meta].map(([k, v]) => [k, { ...v }])), lore: { okAt: lore.okAt, ttl: 60_000, error: lore.error, errorAt: lore.errorAt } });

  const market = () => cached('market', 60_000, async () => {
    const j = await getJson(fetchImpl, `https://api.dexscreener.com/latest/dex/tokens/${TBB_MINT}`);
    const pairs = (j.pairs || []).filter((p) => p.baseToken?.address === TBB_MINT);
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    return { priceUsd: Number(p.priceUsd), change24h: Number(p.priceChange?.h24 ?? 0), marketCap: Number(p.marketCap || p.fdv || 0), pair: p.pairAddress, at: Date.now() };
  });

  // Hourly closes for the last 24h from GeckoTerminal (free, no key). Oldest first: [[unixSeconds, usd], ...]
  const chart = () => cached('chart', 10 * 60_000, async () => {
    const pool = (await market())?.pair || '6unnG2hL8udPjDpu3TchvAtptu3dq8AS7tymrWDN2LLC';
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool)) return null;
    const j = await getJson(fetchImpl, `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/hour?aggregate=1&limit=24&currency=usd`);
    if (j?.meta?.base?.address && j.meta.base.address !== TBB_MINT) return null;
    const list = j?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return null;
    const pts = list.map((r) => [Number(r[0]), Number(r[4])]).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v) && v > 0).sort((a, b) => a[0] - b[0]);
    return pts.length >= 2 ? pts : null;
  });

  const btc = () => cached('btc', 120_000, async () => {
    const j = await getJson(fetchImpl, 'https://mempool.space/api/v1/prices');
    return { usd: Number(j.USD) };
  });

  const solUsd = () => cached('sol', 120_000, async () => {
    const j = await getJson(fetchImpl, 'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
    const p = (j.pairs || []).filter((x) => x.quoteToken?.symbol === 'USDC' && x.baseToken?.symbol === 'SOL').sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return p ? { usd: Number(p.priceUsd) } : null;
  });

  const holders = () => cached('holders', 15 * 60_000, async () => {
    if (!config.heliusKey) return null;
    let page = 1; const holders = new Set();
    for (;;) {
      const j = await getJson(fetchImpl, `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(config.heliusKey)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccounts', params: { mint: TBB_MINT, page, limit: 1000 } }) });
      const list = j.result?.token_accounts || [];
      for (const a of list) if (BigInt(a.amount || 0) > 0n) holders.add(a.owner);
      if (list.length < 1000 || page > 200) break;
      page++; await sleep(150);
    }
    return { count: holders.size };
  });

  // Total staked on stakethebull.xyz, read from the program's public 'pool' account (same number that site shows).
  // We keep one snapshot an hour (8 days) so the 24h change is ours, not anyone's API.
  const staked = () => cached('staked', 5 * 60_000, async () => {
    if (!config.stakingProgram) return null;
    const [pool] = findProgramAddress([new TextEncoder().encode('pool')], config.stakingProgram);
    const r = await rpc('getAccountInfo', [pool, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!r?.value || r.value.owner !== config.stakingProgram) return null;
    const d = Buffer.from(r.value.data[0], 'base64');
    if (d.length < 128) return null;
    const amount = Number(d.readBigUInt64LE(104)) / 1e6; const stakes = Number(d.readBigUInt64LE(120));
    if (!Number.isFinite(amount) || amount < 0) return null;
    const sup = await rpc('getTokenSupply', [TBB_MINT]);
    const total = Number(sup?.value?.uiAmount);
    const t = Date.now();
    if (db) {
      const last = db.get('SELECT at FROM staked_hist ORDER BY at DESC LIMIT 1');
      if (!last || t - last.at >= 55 * 60_000) db.run('INSERT OR REPLACE INTO staked_hist(at,amount) VALUES(?,?)', t, amount);
      db.run('DELETE FROM staked_hist WHERE at < ?', t - 8 * 86400_000);
    }
    const then = db?.get('SELECT at,amount FROM staked_hist WHERE at <= ? AND at >= ? ORDER BY at DESC LIMIT 1', t - 23 * 3600_000, t - 30 * 3600_000);
    const change24h = then && then.amount > 0 ? ((amount - then.amount) / then.amount) * 100 : null;
    // the 7-day change from the same snapshots (the table keeps 8 days): the one nearest to a week ago
    const week = db?.get('SELECT at,amount FROM staked_hist WHERE at <= ? AND at >= ? ORDER BY at DESC LIMIT 1', t - (7 * 24 - 1) * 3600_000, t - 8 * 86400_000);
    const change7d = week && week.amount > 0 ? ((amount - week.amount) / week.amount) * 100 : null;
    return { amount, stakes, pct: total ? (amount / total) * 100 : null, change24h, change7d };
  });

  // ---- block chain message worker ----
  const lore = {
    tip: db.kvGet('btc_tip', null),
    running: false,
    seed() {
      db.run('INSERT OR IGNORE INTO lore(height,block_hash,txid,kind,text,found_at,status) VALUES(?,?,?,?,?,?,?)',
        GENESIS.height, GENESIS.hash, GENESIS.txid, 'coinbase', GENESIS.text, Date.now(), 'approved');
      lore.invalidate();
    },
    // The approved count and the id range are read once and kept in memory: every /api/state and /api/lore used
    // to COUNT(*) the table. Inserts and approvals here call invalidate(); the admin panel does too; a 5-minute TTL covers
    // anything else.
    _shape: null, _shapeAt: 0,
    shape() {
      if (!lore._shape || Date.now() - lore._shapeAt > 300_000) {
        const r = db.get("SELECT COUNT(*) n, MIN(id) lo, MAX(id) hi FROM lore WHERE status='approved'");
        lore._shape = { n: r?.n || 0, lo: r?.lo ?? 0, hi: r?.hi ?? 0 }; lore._shapeAt = Date.now();
      }
      return lore._shape;
    },
    count() { return lore.shape().n; },
    invalidate() { lore._shape = null; lore._batch = null; },
    // Up to k distinct approved rows by probing random rowids (the primary key) instead of a random sort of the whole
    // table on every call. A small table is read whole and shuffled.
    sample(k) {
      const { n, lo, hi } = lore.shape();
      if (!n) return [];
      const cols = 'id,height,block_hash,txid,kind,text';
      if (n <= k) { const all = db.all(`SELECT ${cols} FROM lore WHERE status='approved'`); for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; } return all; }
      const out = new Map();
      for (let tries = 0; tries < k * 4 && out.size < k; tries++) {
        const id = lo + Math.floor(Math.random() * (hi - lo + 1));
        // '+status' keeps the planner on the rowid (one page read) instead of the status index plus a temporary sort of
        // every approved row: a probe costs a microsecond, not a scan of the table.
        const r = db.get(`SELECT ${cols} FROM lore WHERE id >= ? AND +status='approved' ORDER BY id LIMIT 1`, id) || db.get(`SELECT ${cols} FROM lore WHERE id < ? AND +status='approved' ORDER BY id DESC LIMIT 1`, id);
        if (r && !out.has(r.id)) out.set(r.id, r);
      }
      return [...out.values()];
    },
    // A batch for the page to rotate through locally: up to n lines; when a line has a reply a few blocks later
    // (a proposal, then the answer) the reply follows it.
    batch(n) {
      const rows = lore.sample(n); const out = [];
      const push = (r) => { const at = out.findIndex((x) => x.id === r.id); if (at >= 0) out.splice(at, 1); out.push({ id: r.id, height: r.height, hash: r.block_hash, txid: r.txid, kind: r.kind, text: r.text }); };
      for (const r of rows) {
        if (out.some((x) => x.id === r.id)) continue; // already placed as a reply
        push(r);
        const reply = db.get("SELECT id,height,block_hash,txid,kind,text FROM lore WHERE status='approved' AND height > ? AND height <= ? ORDER BY height LIMIT 1", r.height, r.height + 20);
        if (reply) push(reply); // moved here if it was sampled on its own earlier
      }
      for (const x of out) delete x.id;
      if (!out.length) out.push({ ...GENESIS, kind: 'coinbase' });
      return out.slice(0, n);
    },
    // The batch the page asks for (/api/lore?n=): built once and shared by every request for a minute, so a read costs
    // a slice and nothing of the table. invalidate() (an insert, an approval, the panel) starts a fresh one.
    _batch: null, _batchAt: 0,
    shared(n) {
      if (!lore._batch || Date.now() - lore._batchAt > 60_000) { lore._batch = lore.batch(30); lore._batchAt = Date.now(); }
      return lore._batch.slice(0, n);
    },
    // Housekeeping, run by the app at start and every few hours: pending candidates nobody looked at in 30 days
    // go; approved rows are capped at the newest config.loreCap (5,000) — genesis and the landmarks always stay.
    prune() {
      const cap = Math.max(1, Number(config.loreCap) || 5000);
      const keep = [GENESIS.height, ...LANDMARKS.map((l) => l.height)]; const ph = keep.map(() => '?').join(',');
      db.run("DELETE FROM lore WHERE status='pending' AND found_at < ?", Date.now() - 30 * 86400_000);
      db.run(`DELETE FROM lore WHERE status='approved' AND height NOT IN (${ph}) AND id NOT IN (SELECT id FROM lore WHERE status='approved' AND height NOT IN (${ph}) ORDER BY id DESC LIMIT ?)`, ...keep, ...keep, cap);
      lore.invalidate();
    },
    async mempool(path) {
      await sleep(config.mempoolGapMs ?? 1100);
      for (let a = 0; a < 4; a++) {
        try {
          const res = await fetchImpl(`${config.mempoolBase}${path}`, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'Mozilla/5.0' } });
          // 429: stop at once (no retry, no next page); the worker loop backs off
          if (res.status === 429) throw Object.assign(new Error('429'), { status: 429, final: true });
          if (!res.ok) throw new Error(`${res.status}`);
          const ct = res.headers.get('content-type') || '';
          const body = await readCapped(res, 4_000_000);
          return ct.includes('json') ? JSON.parse(body) : body;
        } catch (e) { if (a === 3 || e.final) throw e; await sleep(2000 * (a + 1)); }
      }
      throw new Error('mempool unavailable');
    },
    addCandidates(height, hash, txid, kind, texts, status = 'pending') {
      let added = 0;
      // coinbaseCandidates appends the joined sentence last; when it reads cleanly, keep only that.
      if (kind === 'coinbase' && texts.length > 1) { const j = texts[texts.length - 1]; texts = cleanLore(j) ? [j] : texts.slice(0, -1); }
      for (const raw of texts) {
        const t = cleanLore(raw);
        if (!t) continue;
        const r = db.run('INSERT OR IGNORE INTO lore(height,block_hash,txid,kind,text,found_at,status) VALUES(?,?,?,?,?,?,?)', height, hash, txid, kind, t, Date.now(), status);
        if (r.changes) { added++; if (status === 'approved') lore.invalidate(); }
      }
      return added;
    },
    async scanBlock(height, { pages = 2 } = {}) {
      const hash = String(await lore.mempool(`/block-height/${height}`)).trim();
      if (!/^[0-9a-f]{64}$/.test(hash)) return 0;
      let added = 0;
      for (let p = 0; p < pages; p++) {
        const txs = await lore.mempool(`/block/${hash}/txs/${p * 25}`);
        if (!Array.isArray(txs) || !txs.length) break;
        for (const tx of txs) {
          if (tx.vin?.[0]?.is_coinbase) added += lore.addCandidates(height, hash, tx.txid, 'coinbase', coinbaseCandidates(tx.vin[0].scriptsig || ''));
          for (const o of tx.vout || []) if (o.scriptpubkey_type === 'op_return') added += lore.addCandidates(height, hash, tx.txid, 'op_return', opReturnCandidates(o.scriptpubkey_asm));
        }
        if (txs.length < 25) break;
      }
      return added;
    },
    async landmarks() {
      const done = new Set(db.kvGet('landmarks_done', []));
      for (const lm of LANDMARKS) {
        const key = `${lm.height}:${lm.tx || 'cb'}`;
        if (done.has(key)) continue;
        try {
          const hash = String(await lore.mempool(`/block-height/${lm.height}`)).trim();
          if (lm.tx) {
            const ids = await lore.mempool(`/block/${hash}/txids`);
            const id = (ids || []).find((t) => t.startsWith(lm.tx));
            if (id) { const tx = await lore.mempool(`/tx/${id}`); for (const o of tx.vout || []) if (o.scriptpubkey_type === 'op_return') lore.addCandidates(lm.height, hash, id, 'op_return', opReturnCandidates(o.scriptpubkey_asm), 'approved'); }
          } else {
            const txs = await lore.mempool(`/block/${hash}/txs/0`);
            const cb = txs?.[0];
            if (cb?.vin?.[0]?.is_coinbase) lore.addCandidates(lm.height, hash, cb.txid, 'coinbase', coinbaseCandidates(cb.vin[0].scriptsig || ''), 'approved');
          }
          done.add(key); db.kvSet('landmarks_done', [...done]);
        } catch (e) { log('landmark', key, e.message); }
      }
    },
    okAt: null, error: null, errorAt: null,
    async tick() {
      let h;
      try { h = Number(await lore.mempool('/blocks/tip/height')); lore.okAt = Date.now(); lore.error = null; }
      catch (e) { lore.error = String(e.message || e).slice(0, 160); lore.errorAt = Date.now(); throw e; }
      if (Number.isFinite(h) && h !== lore.tip) {
        const isNew = lore.tip !== null && h > lore.tip;
        lore.tip = h; db.kvSet('btc_tip', h);
        emit('block', { height: h, isNew });
        if (isNew) { try { await lore.scanBlock(h, { pages: 4 }); } catch (e) { log('lore scan', e.message); } }
      }
    },
    async backfill() {
      // Bias toward the early years, where people left the most human messages.
      const max = lore.tip || 900000;
      const r = Math.random();
      // 30% of the time: the Eligius era (2011-12), when one pool wrote prayers into its coinbases — coinbase only, one request.
      if (r < 0.3) {
        const height = 139700 + Math.floor(Math.random() * 30000);
        const hash = String(await lore.mempool(`/block-height/${height}`)).trim();
        const txs = await lore.mempool(`/block/${hash}/txs/0`);
        const cb = txs?.[0]; if (cb?.vin?.[0]?.is_coinbase) lore.addCandidates(height, hash, cb.txid, 'coinbase', coinbaseCandidates(cb.vin[0].scriptsig || ''));
        return;
      }
      const height = r < 0.6 ? Math.floor(Math.random() * 250000) : r < 0.85 ? 250000 + Math.floor(Math.random() * 250000) : Math.floor(Math.random() * max);
      await lore.scanBlock(height, { pages: 1 });
    },
    // Pace: the tip check every 60 s; a backfill scan every 30 s until 500 lines are approved, then every
    // 10 min (the table is full enough; mempool.space is a free service). Failures back off 1 → 2 → 4 … → 30 min.
    tickGap: 60_000, fails: 0,
    fillGap() { return lore.count() >= 500 ? 600_000 : (config.backfillGapMs ?? 30_000); },
    backoffMs,
    start() {
      if (lore.running) return; lore.running = true;
      lore.seed();
      const loop = async () => {
        try { await lore.landmarks(); } catch (e) { log('landmarks', e.message); }
        let lastTick = 0; let lastFill = 0;
        while (lore.running) {
          const t = Date.now(); let pause;
          try {
            if (t - lastTick >= lore.tickGap) { lastTick = t; await lore.tick(); }
            else if (t - lastFill >= lore.fillGap()) { lastFill = t; await lore.backfill(); }
            lore.fails = 0;
            pause = Math.min(lore.tickGap - (Date.now() - lastTick), lore.fillGap() - (Date.now() - lastFill));
          } catch (e) { lore.fails++; lore.error = String(e.message || e).slice(0, 160); lore.errorAt = Date.now(); log('lore', e.message, `(backing off ${backoffMs(lore.fails) / 1000}s)`); pause = backoffMs(lore.fails); }
          await sleep(Math.max(1000, pause));
        }
      };
      loop();
    },
    stop() { lore.running = false; },
    pick() {
      // Favour older and rarer entries; genesis stays in the mix.
      const rows = lore.sample(8);
      if (!rows.length) return { ...GENESIS, kind: 'coinbase' };
      rows.sort((a, b) => a.height - b.height);
      const r = rows[Math.floor(Math.random() * Math.min(rows.length, Math.random() < 0.6 ? 3 : rows.length))];
      return { height: r.height, hash: r.block_hash, txid: r.txid, kind: r.kind, text: r.text };
    },
  };

  // Season 1: the creator's Biggest Buyer Board. Only season-wide totals are kept: no addresses, no names, no trades.
  const season = () => cached('season', 60_000, async () => {
    if (!config.seasonBoard) return null;
    const d = await getJson(fetchImpl, new URL('api/board', config.seasonBoard).href);
    if (d?.mint !== TBB_MINT || !d.season || !d.totals) return null;
    const n = (x) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : null);
    const start = n(d.season.start); const end = n(d.season.end);
    if (!start || !end || end <= start) return null;
    return {
      start, end, overtimeHours: n(d.season.overtimeHours) ?? 0,
      buyers: n(d.totals.buyers), buys: n(d.totals.buys), volumeUsd: n(d.totals.volumeUsd),
      prizeTbb: n(d.season.prizeTbb), stakeApr: n(d.season.stakeApr), url: config.seasonBoard,
      // Top 3 as the board shows them: rank, a shortened label of the board's entry, score. Full addresses and names are not kept.
      top: (Array.isArray(d.leaderboard) ? d.leaderboard : []).slice(0, 3)
        // strings only: an array or object here could slip a full address past the shortening below
        .filter((r) => typeof r?.wallet === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.wallet) && n(r.score) !== null)
        .map((r, i) => ({ rank: i + 1, label: `${r.wallet.slice(0, 4)}…${r.wallet.slice(-4)}`, score: n(r.score) })),
    };
  });

  // ---- the schedule ----
  // Every feed is refreshed by this timer at its own interval (and backoff), whether or not anyone is visiting. A request
  // reads the cache through fresh() and never asks a feed, so no refresh time says when somebody else loaded the page.
  const all = { market, chart, btc, sol: solUsd, holders, staked, season };
  const fresh = (key) => cache.get(key)?.value ?? null;
  async function tick() {
    for (const f of Object.values(all)) f().catch(() => {});
    await Promise.allSettled([...inflight.values()]);
  }
  let timer = null;
  const start = (everyMs = 10_000) => { if (timer) return; tick(); timer = setInterval(tick, everyMs); timer.unref?.(); };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };

  return { market, chart, btc, solUsd, holders, staked, season, lore, status, fresh, tick, start, stop, _cache: cache };
}
