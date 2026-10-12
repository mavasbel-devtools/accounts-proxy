// RFC 4648 §5 base64url without padding (as required by RFC 7636 PKCE), implemented without any runtime API.
// The input is zero-filled to whole 3-byte groups and the output cut to ceil(4n/3) characters, which is exactly the
// unpadded encoding of n bytes (one code path for every length).
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64UrlEncode(bytes: Uint8Array): string {
  const groups = new Uint8Array(Math.ceil(bytes.length / 3) * 3);
  groups.set(bytes);
  let out = "";
  for (let i = 0; i < groups.length; i += 3) {
    const n = (groups[i]! << 16) | (groups[i + 1]! << 8) | groups[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  return out.slice(0, Math.ceil((bytes.length * 4) / 3));
}
