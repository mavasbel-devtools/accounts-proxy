// Capture path of the recon facility (plan 2026-10-19-20-04, phase R1): the addon's own contract, driven by
// mitmproxy's test harness, and the same addon inside a real mitmdump proxying a real SSE response.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promptsRecorded, startMitm, stopMitm, upstreamDnsServers, workflowRecordedEvidence } from "@accounts-proxy/scripts/recon/run.ts";
import { mitmPython } from "@accounts-proxy/scripts/recon/mitm/python.ts";
import { loadRedactionManifest, redactionManifestPath } from "@accounts-proxy/scripts/recon/shared/manifest.ts";
import { makeTemporary, removeTemporary } from "@accounts-proxy/test-support/temporary.ts";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) removeTemporary(root);
  root = undefined;
});

function temporary(): string {
  root = makeTemporary("recon-capture");
  return root;
}

function header(pairs: readonly [string, string][], name: string): string | undefined {
  return pairs.find(([key]) => key.toLowerCase() === name)?.[1];
}

function run(command: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", rejectRun);
    child.once("exit", (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
  });
}

describe("run preconditions", () => {
  test("upstream resolvers come only from RECON_DNS_SERVERS, and an empty value means the system resolver", () => {
    expect(upstreamDnsServers({})).toEqual([]);
    expect(upstreamDnsServers({ RECON_DNS_SERVERS: "" })).toEqual([]);
    expect(upstreamDnsServers({ RECON_DNS_SERVERS: "   " })).toEqual([]);
    expect(upstreamDnsServers({ RECON_DNS_SERVERS: "1.1.1.1" })).toEqual(["1.1.1.1"]);
    expect(upstreamDnsServers({ RECON_DNS_SERVERS: " 9.9.9.9 , 8.8.8.8 ," })).toEqual(["9.9.9.9", "8.8.8.8"]);
  });

  test("a supported workflow without a single captured flow is not evidence", () => {
    const workflow = { steps: [{ name: "gui-launch" }] };
    expect(workflowRecordedEvidence("workflow", workflow, 0)).toBe(false);
    expect(workflowRecordedEvidence("workflow", workflow, 1)).toBe(true);
    // Modes that are not a workflow, and workflows with no steps (declared unsupported), are exempt.
    expect(workflowRecordedEvidence("capture", undefined, 0)).toBe(true);
    expect(workflowRecordedEvidence("login", workflow, 0)).toBe(true);
    expect(workflowRecordedEvidence("verify", undefined, 0)).toBe(true);
    expect(workflowRecordedEvidence("workflow", undefined, 0)).toBe(true);
    expect(workflowRecordedEvidence("workflow", { steps: [] }, 0)).toBe(true);
  });

  test("a login that was given prompts needs a recorded turn request", () => {
    // Measured: a login run whose prompts never reached the chat panel recorded 899 flows and exited 0.
    const turn = String.raw`:streamGenerateContent\b`;
    expect(promptsRecorded(turn, ["https://oauth2.googleapis.com/token", "https://play.googleapis.com/log"])).toBe(false);
    expect(promptsRecorded(turn, ["https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"])).toBe(true);
    expect(promptsRecorded(undefined, [])).toBe(true);
  });

  test("a workflow that names its request fails when only other traffic was recorded", () => {
    // Measured on Antigravity: Send stayed disabled, yet the run recorded 350 start-up and telemetry flows.
    const turn = { steps: [{ name: "gui-prompt" }], expects: String.raw`:streamGenerateContent\b` };
    const noise = ["https://play.googleapis.com/log", "https://antigravity-unleash.goog/api/client/features"];
    expect(workflowRecordedEvidence("workflow", turn, 350, noise)).toBe(false);
    expect(workflowRecordedEvidence("workflow", turn, 0, [])).toBe(false);
    expect(
      workflowRecordedEvidence("workflow", turn, 351, [
        ...noise,
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      ]),
    ).toBe(true);
  });
});

describe("redaction manifest", () => {
  test("is validated and carries every credential class", () => {
    const manifest = loadRedactionManifest();
    expect(manifest.schema).toBe("recon-redaction/3");
    expect(manifest.credentialHeaders).toContain("authorization");
    expect(manifest.identityHeaders).toContain("chatgpt-account-id");
    expect(manifest.queryCredentialFields).toContain("sig");
    expect(manifest.identityFields).toContain("installation_id");
    expect(manifest.credentialHeaders).toContain("proxy-authorization");
    expect(manifest.credentialFields).toContain("refresh_token");
    expect(manifest.identityFields).toContain("account_uuid");
    expect(manifest.identityPatterns.map((pattern) => pattern.name)).toContain("email");
    expect(manifest.identityScoped.some((scope) => scope.fields.includes("name"))).toBe(true);
    expect(manifest.tokenPrefixes).toContain("sk-ant-");
    expect(manifest.tokenBodyMinTail).toBeGreaterThan(0);
    expect(redactionManifestPath.endsWith("scripts/recon/shared/redaction.json")).toBe(true);
  });
});

describe("capture addon", () => {
  test(
    "satisfies the record contract under mitmproxy's own test harness",
    async () => {
      const result = await run(mitmPython(), [join(import.meta.dir, "..", "..", "recon", "mitm", "selfcheck.py")]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toMatch(/^PASS \d+ checks$/);
    },
    30_000,
  );
});

describe("capture through mitmdump", () => {
  test(
    "records an SSE exchange with chunk timing, a JSON exchange, and no surviving secret",
    async () => {
      const runDir = temporary();
      const encoder = new TextEncoder();
      const sse = [
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_delta\ndata: {"delta":"hi"}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      const origin = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          if (new URL(request.url).pathname === "/v1/messages") {
            const stream = new ReadableStream({
              async start(controller) {
                for (const frame of sse) {
                  controller.enqueue(encoder.encode(frame));
                  await Bun.sleep(60);
                }
                controller.close();
              },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
          }
          const body = await request.text();
          return Response.json({ ok: true, received: body.length });
        },
      });
      const target = { id: "selfcheck", cell: "claude" };
      const { child, port } = await startMitm(runDir, target, "selfcheck/run", "9.9.9");
      const proxy = `http://127.0.0.1:${port}`;
      try {
        const streamed = await fetch(`http://127.0.0.1:${origin.port}/v1/messages`, {
          method: "POST",
          headers: {
            authorization: "Bearer sk-ant-SECRETSECRETSECRET",
            "content-type": "application/json",
            "x-duplicate": "one",
          },
          body: '{"model":"claude-sonnet-4-5","access_token":"sk-ant-SECRETSECRETSECRET"}',
          proxy,
        });
        expect(streamed.status).toBe(200);
        expect(await streamed.text()).toBe(sse.join(""));

        const plain = await fetch(`http://127.0.0.1:${origin.port}/v1/models`, {
          headers: { authorization: "Bearer sk-ant-SECRETSECRETSECRET" },
          proxy,
        });
        expect(plain.status).toBe(200);
        expect(await plain.json()).toEqual({ ok: true, received: 0 });
      } finally {
        await stopMitm(child);
        origin.stop(true);
      }

      const captures = join(runDir, "captures");
      const files = readdirSync(captures).sort();
      expect(files.filter((name) => name.endsWith("-request.json"))).toHaveLength(2);
      expect(files.filter((name) => name.endsWith("-response.json"))).toHaveLength(2);

      const streamRequest = JSON.parse(readFileSync(join(captures, "001-request.json"), "utf8")) as {
        headers: [string, string][];
        body: string;
        secretScan: string;
        clientVersion: string;
        cell: string;
        wallAtMs: number;
        clientConn: { id: string };
      };
      expect(streamRequest.clientVersion).toBe("9.9.9");
      expect(streamRequest.cell).toBe("claude");
      expect(header(streamRequest.headers, "authorization")).toBe("Bearer <REDACTED:authorization>");
      expect(streamRequest.body).not.toContain("SECRETSECRET");
      expect(streamRequest.body).toContain('"model":"claude-sonnet-4-5"');
      expect(streamRequest.secretScan).toBe("clean");
      expect(streamRequest.wallAtMs).toBeGreaterThan(1_700_000_000_000);
      expect(streamRequest.clientConn.id.length).toBeGreaterThan(0);

      const streamResponse = JSON.parse(readFileSync(join(captures, "001-response.json"), "utf8")) as {
        status: number;
        headers: [string, string][];
        chunks: { atMs: number; bytes: number; text: string; event?: string }[];
        doneAtMs: number;
        headersAtMs: number;
        secretScan: string;
        streamed: boolean;
        aborted: boolean;
        frames: { atMs: number; event?: string; bytes: number }[];
      };
      expect(streamResponse.status).toBe(200);
      expect(header(streamResponse.headers, "content-type")).toContain("text/event-stream");
      expect(streamResponse.chunks.length).toBeGreaterThanOrEqual(2);
      expect(streamResponse.chunks.map((chunk) => chunk.text).join("")).toBe(sse.join(""));
      expect(streamResponse.chunks[0]!.atMs).toBeGreaterThanOrEqual(streamResponse.headersAtMs);
      expect(streamResponse.doneAtMs).toBeGreaterThan(streamResponse.chunks[0]!.atMs);
      expect(streamResponse.secretScan).toBe("clean");
      expect(streamResponse.streamed).toBe(true);
      expect(streamResponse.aborted).toBe(false);
      expect(streamResponse.chunks.map((chunk) => chunk.event)).toEqual(["message_start", "content_block_delta", "message_stop"]);
      expect(streamResponse.frames.map((frame) => frame.event)).toEqual(["message_start", "content_block_delta", "message_stop"]);
      expect(streamResponse.frames.every((frame) => frame.bytes > 0)).toBe(true);

      const plainResponse = JSON.parse(readFileSync(join(captures, "002-response.json"), "utf8")) as { body: string };
      expect(plainResponse.body).toBe('{"ok":true,"received":0}');

      const index = JSON.parse(readFileSync(join(captures, "index.json"), "utf8")) as {
        schema: string;
        counts: Record<string, number>;
      };
      expect(index.schema).toBe("recon-index/2");
      expect(index.counts.connections).toBe(0);
      expect(index.counts.requests).toBe(2);
      expect(index.counts.responses).toBe(2);

      const connections = JSON.parse(readFileSync(join(captures, "connections.json"), "utf8")) as {
        schema: string;
        connections: unknown[];
      };
      expect(connections.schema).toBe("recon-connections/1");
      // A plain-HTTP proxy origin has no TLS, so the registry is written empty rather than absent.
      expect(connections.connections).toEqual([]);

      for (const name of files) {
        const text = readFileSync(join(captures, name), "utf8");
        expect(text).not.toContain("SECRETSECRET");
        expect(text).not.toContain("sk-ant-");
      }
    },
    60_000,
  );
});
