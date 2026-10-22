// The interpreter that runs mitmdump. The addon and its self-check need the same Python environment as the proxy
// itself (mitmproxy.test ships with the distribution), so it is discovered from mitmdump's shebang rather than assumed.

import { readFileSync } from "node:fs";

export function mitmPython(): string {
  const binary = Bun.which("mitmdump");
  if (binary === null) throw new Error("mitmdump is not installed");
  const first = readFileSync(binary, "utf8").split("\n", 1)[0] ?? "";
  return /^#!\s*(\S+)/.exec(first)?.[1] ?? "python3";
}
