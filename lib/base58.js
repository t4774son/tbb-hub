// Base58 (Bitcoin alphabet) — small, dependency-free.
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Map([...ALPHA].map((c, i) => [c, BigInt(i)]));

export function encode(bytes) {
  bytes = Uint8Array.from(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHA[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

export function decode(str) {
  if (typeof str !== 'string' || str.length === 0 || str.length > 128) throw new Error('bad base58');
  let n = 0n;
  for (const c of str) {
    const v = MAP.get(c);
    if (v === undefined) throw new Error('bad base58 char');
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of str) { if (c === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

export function isPubkey(str) {
  try { return decode(str).length === 32; } catch { return false; }
}

