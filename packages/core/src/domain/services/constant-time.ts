/**
 * Equality of two byte strings whose running time depends only on their lengths. Callers compare fixed-length
 * digests (SHA-256 of both values), so the time is constant. Same contract as node's crypto.timingSafeEqual, kept in
 * the domain so the application layer needs no runtime import.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
