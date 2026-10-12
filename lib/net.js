// Read an upstream response body, stopping as soon as it passes the cap (never buffer an unbounded body).
export async function readCapped(res, cap = 2_000_000) {
  const len = Number(res.headers?.get?.('content-length') || 0);
  if (len > cap) { res.body?.cancel?.().catch?.(() => {}); throw tooLarge(); }
  if (!res.body?.getReader) { const t = await res.text(); if (t.length > cap) throw tooLarge(); return t; }
  const r = res.body.getReader(); const parts = []; let n = 0;
  for (;;) { const { done, value } = await r.read(); if (done) break; n += value.length; if (n > cap) { r.cancel().catch(() => {}); throw tooLarge(); } parts.push(value); }
  return Buffer.concat(parts.map((p) => Buffer.from(p))).toString('utf8');
}
const tooLarge = () => Object.assign(new Error('response too large'), { tooLarge: true });
