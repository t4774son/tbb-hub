// The sign-up proof of work: find a nonce such that sha256(challenge + ':' + nonce) starts with `bits` zero bits.
// Done here, in this browser, with SubtleCrypto; nothing is sent anywhere but this site. About 1–2 s on a phone at 16 bits.
const enc = new TextEncoder();
function leadingZeroBits(buf) { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; }
export async function solvePow({ challenge, bits }, onProgress = () => {}) {
  if (!globalThis.crypto?.subtle) throw new Error('This browser can’t do the sign-up check. Try a newer one.');
  const prefix = `${challenge}:`; let n = 0; const batch = 64;
  for (;;) {
    const nonces = Array.from({ length: batch }, (_, i) => (n + i).toString(36));
    const digests = await Promise.all(nonces.map((x) => crypto.subtle.digest('SHA-256', enc.encode(prefix + x))));
    for (let i = 0; i < batch; i++) if (leadingZeroBits(new Uint8Array(digests[i])) >= bits) return nonces[i];
    n += batch; onProgress(n);
    if (n > 50_000_000) throw new Error('The sign-up check took too long. Try again.');
  }
}
