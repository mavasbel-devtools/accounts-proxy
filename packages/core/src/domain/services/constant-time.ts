/**
 * Equality of two byte strings whose running time depends only on their lengths. Callers compare fixed-length
 * digests (SHA-256 of both values), so the time is constant. Same contract as node's crypto.timingSafeEqual, kept in
 * the domain so the application layer needs no runtime import. A length difference is folded into the result
 * instead of returning early.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
