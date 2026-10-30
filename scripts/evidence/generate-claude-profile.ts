// Generates or checks packages/provider-claude/src/domain/client-profile.ts from a captured real-CLI wire request.
// Usage: bun scripts/evidence/generate-claude-profile.ts [--check] [capture-request.json]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const defaultCapture = join(root, ".cache", "recon", "runs", "claude", "2026-10-22-02-04-42-workflow", "captures", "018-request.json");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const capturePath = args.find((a) => !a.startsWith("--")) ?? defaultCapture;

if (!existsSync(capturePath)) {
  if (checkOnly) {
    console.log(`generate-claude-profile: capture file ${capturePath} not found on this machine; skipping capture diff`);
    process.exit(0);
  } else {
    console.error(`generate-claude-profile: capture file ${capturePath} not found`);
    process.exit(1);
  }
}

type WireRequestJson = {
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
};

const capture = JSON.parse(readFileSync(capturePath, "utf8")) as WireRequestJson;
const headers = new Map<string, string>();
const headerNames: string[] = [];
for (const [k, v] of capture.headers) {
  headers.set(k.toLowerCase(), v);
  if (!["connection", "host", "accept-encoding", "content-length"].includes(k.toLowerCase())) {
    headerNames.push(k);
  }
}

const userAgent = headers.get("user-agent") ?? "";
const versionMatch = /claude-cli\/([0-9.]+)/.exec(userAgent);
const version = versionMatch?.[1] ?? "";
const sdkPackageVersion = headers.get("x-stainless-package-version") ?? "";
const anthropicVersion = headers.get("anthropic-version") ?? "";
const betas = headers.get("anthropic-beta") ?? "";
const dispatchId = headers.get("anthropic-dispatch-id") ?? "";
const atis = headers.get("x-cc-atis") ?? "";
const requestClass = headers.get("x-claude-code-request-class") ?? "";

const body = JSON.parse(capture.body) as {
  readonly system?: readonly { readonly type: string; readonly text: string }[];
};
const billingText = body.system?.[0]?.text ?? "";
const cchMatch = /cch=([0-9a-f]+)/.exec(billingText);
const cch = cchMatch?.[1] ?? "";

const generated = `// Profile of the official Claude Code CLI (${version}, sha256 ad2816b085...):
// Derived from recon MITM capture claude/2026-10-22-02-04-42-workflow (seq 18) and decompiled official bundle.

export const CLAUDE_PROFILE = {
  version: ${JSON.stringify(version)},
  entrypoint: "sdk-cli",
  cch: ${JSON.stringify(cch)},
  sdkPackageVersion: ${JSON.stringify(sdkPackageVersion)},
  anthropicVersion: ${JSON.stringify(anthropicVersion)},
  identityText: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  dispatchId: ${JSON.stringify(dispatchId)},
  atis: ${JSON.stringify(atis)},
  requestClass: ${JSON.stringify(requestClass)},
  app: "cli",
  userAgent: ${JSON.stringify(userAgent)},
  fingerprintSalt: "59cf53e54c78",
  fingerprintIndices: [4, 7, 20] as const,
} as const;

export const BETA_OPUS_5_5 =
  ${JSON.stringify(betas)};

/** Canonical HTTP header casing and order as sent by Claude Code ${version}. */
export const CLAUDE_MESSAGE_HEADER_NAMES: readonly string[] = ${JSON.stringify(headerNames, null, 2)};

export function extractPromptSample(text: string): string {
  return CLAUDE_PROFILE.fingerprintIndices.map((i) => text[i] || "0").join("");
}
`;

const targetFile = join(root, "packages", "provider-claude", "src", "domain", "client-profile.ts");

if (checkOnly) {
  const current = readFileSync(targetFile, "utf8");
  if (current !== generated) {
    console.error("client-profile.ts is out of step with captured wire. Run bun scripts/evidence/generate-claude-profile.ts to regenerate.");
    process.exit(1);
  }
  console.log("client-profile.ts matches captured wire");
} else {
  writeFileSync(targetFile, generated);
  console.log(`Updated ${targetFile} from ${capturePath}`);
}
