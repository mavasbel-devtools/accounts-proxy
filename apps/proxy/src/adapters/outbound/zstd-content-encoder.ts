// zstd request bodies over the runtime's node:zlib (Bun 1.4.2), at the library's default level: opencode v2.1.1, which
// runs on the same Bun, compresses its ChatGPT requests with `zstdCompressSync(body)` and no options (recon gap P1).
import { zstdCompressSync } from "node:zlib";
import { ContentEncoderPort } from "@accounts-proxy/core/ports/outbound/transport.ts";

export class ZstdContentEncoder extends ContentEncoderPort {
  readonly encoding = "zstd";

  encode(body: string): Uint8Array {
    return new Uint8Array(zstdCompressSync(Buffer.from(body, "utf8")));
  }
}
