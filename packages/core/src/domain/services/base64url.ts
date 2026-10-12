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

/** RFC 4648 §5 base64url decoding, with or without padding; undefined for any character outside the alphabet. */
export function base64UrlDecode(text: string): Uint8Array | undefined {
  const body = text.replace(/=+$/, "");
  if (body.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of body) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return undefined;
    value = ((value << 6) | digit) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  return out;
}
