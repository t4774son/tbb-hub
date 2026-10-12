// sha256 and the ed25519 curve check, for program-derived addresses (lib/solana.js). Nothing here verifies or makes a signature.
import crypto from 'node:crypto';

export const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

// Is a 32-byte compressed point on the ed25519 curve? (A program-derived address must be off-curve.)
const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;
function mod(a) { const r = a % P; return r >= 0n ? r : r + P; }
function modPow(b, e) { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
function modInv(a) { return modPow(mod(a), P - 2n); }

export function isOnCurve(bytes) {
  const b = Uint8Array.from(bytes);
  if (b.length !== 32) return false;
  const yb = Uint8Array.from(b); yb[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(yb[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x^2 = u / v ; check u*v^-1 is a quadratic residue (or zero)
  const x2 = mod(u * modInv(v));
  if (x2 === 0n) return (b[31] & 0x80) === 0;
  return modPow(x2, (P - 1n) / 2n) === 1n;
}
