// zstd request bodies over the runtime's node:zlib (Bun 1.4.2), at the library's default level: opencode v2.1.1, which
// runs on the same Bun, compresses its ChatGPT requests with `zstdCompressSync(body)` and no options (recon gap P1).
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { ContentDecoderPort, ContentEncoderPort } from "@accounts-proxy/core/ports/outbound/transport.ts";

export class ZstdContentEncoder extends ContentEncoderPort {
  readonly encoding = "zstd";

  encode(body: string): Uint8Array {
    return new Uint8Array(zstdCompressSync(Buffer.from(body, "utf8")));
  }
}

/** Decodes the zstd request bodies the encoder above produced, for the exchange log (plan 2026-10-26 X2). */
export class ZstdContentDecoder extends ContentDecoderPort {
  readonly encoding = "zstd";

  decode(body: Uint8Array): string {
    return new TextDecoder().decode(zstdDecompressSync(body));
  }
}
