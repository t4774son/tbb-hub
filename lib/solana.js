// The little Solana needed to read public chain data: three fixed addresses and JSON-RPC with backoff. Read-only:
// nothing here builds, signs or sends anything, and no curve maths is needed (the pool address is a constant; the test
// suite derives it once from the program to prove it).
import { readCapped } from './net.js';

export const TBB_MINT = '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump';
// The staking program behind stakethebull.xyz and its public 'pool' account (the program-derived address for seed "pool").
export const STAKING_PROGRAM = '4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT';
export const STAKING_POOL = '67bWpBwiiEdgP78ASpAPg6Next2Gtdycu1GFumRLs1Xw';

// ---- RPC
// The public RPC is a shared free service: a 429 is not retried, and after a failed call the next calls fail
// at once for 1 min, then 2, 4 … 30 min, until one succeeds. RPC-level errors are answers, not failures.
const backoffMs = (fails) => Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, fails - 1));
export function makeRpc(url, { fetchImpl = fetch, minGapMs = 250 } = {}) {
  let last = 0; let fails = 0; let until = 0;
  return async function rpc(method, params = []) {
    if (Date.now() < until) throw Object.assign(new Error('rpc backing off'), { status: 503 });
    const failed = (e) => { fails++; until = Date.now() + backoffMs(fails); return e; };
    for (let attempt = 0; attempt < 5; attempt++) {
      const wait = Math.max(0, last + minGapMs - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000), redirect: 'error' });
        if (res.status === 429) throw failed(Object.assign(new Error('rpc 429'), { status: 429, final: true }));
        if (res.status >= 500) { await new Promise((r) => setTimeout(r, 800 * 2 ** attempt)); continue; }
        const t = await readCapped(res, 4_000_000); // stops reading at 4 MB
        const j = JSON.parse(t);
        if (j.error) throw Object.assign(new Error(j.error.message || 'rpc error'), { rpc: j.error });
        fails = 0; until = 0;
        return j.result;
      } catch (e) {
        if (e.rpc || e.final) throw e;
        if (e.tooLarge || attempt === 4) throw failed(e); // an oversized answer won't shrink on retry
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      }
    }
    throw failed(new Error('rpc unavailable'));
  };
}
