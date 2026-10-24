// The text of a recorded upstream request body: a string as it is, bytes as the zstd frame the OpenAI cell sends
// (recon gap P1; the only encoded body the proxy sends).
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { ContentEncoderPort } from "@accounts-proxy/core/ports/outbound/transport.ts";

export function bodyText(body: string | Uint8Array | undefined): string {
  if (body === undefined) return "";
  return typeof body === "string" ? body : zstdDecompressSync(body).toString("utf8");
}

/** zstd at the library's default level, the encoding opencode's ChatGPT requests use (the production adapter's rule). */
export class ZstdTestEncoder extends ContentEncoderPort {
  readonly encoding = "zstd";
  encode(body: string): Uint8Array {
    return new Uint8Array(zstdCompressSync(Buffer.from(body, "utf8")));
  }
}
