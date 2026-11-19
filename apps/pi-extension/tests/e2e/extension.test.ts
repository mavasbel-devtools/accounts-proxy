// e2e for feature pi-extension (uc-pi-4, uc-pi-6): the real entry in a child process against a real
// daemon, plus manifest-stub negatives through a local Bun.serve. Replay/fake only: no live accounts.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { E2E_TEST_TIMEOUT_MS } from "@accounts-proxy/scripts/gate/run-tests.ts";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { makeHome, runProxy, startDaemon, type Daemon, type Home } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { ReplayUpstreams } from "@accounts-proxy/test-support/e2e/upstreams.ts";

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);
const upstreams = new ReplayUpstreams();
beforeAll(() => void upstreams.start());
afterAll(() => upstreams.stop());

let home: Home | undefined;
let daemon: Daemon | undefined;
afterEach(async () => {
  upstreams.reset();
  if (daemon !== undefined) await daemon.stop();
  daemon = undefined;
  if (home !== undefined) removeTemporary(home.dir);
  home = undefined;
});

const ALL = [
  "providers:",
  "  claude: {enabled: true, acknowledgeTermsRisk: true}",
  "  antigravity: {enabled: true, acknowledgeTermsRisk: true}",
  "  openai: {enabled: true, acknowledgeTermsRisk: true}",
  "  openrouter: {enabled: true}",
  "  opencode: {enabled: true}",
  "  opencode-go: {enabled: true}",
  "  cheaper-inference: {enabled: true}",
  "",
].join("\n");

const HARNESS = join(import.meta.dir, "harness.ts");
const E2E_PRELOAD = join(import.meta.dir, "..", "..", "..", "..", "scripts", "gate", "e2e-coverage-preload.ts");
const READY = "PI_EXTENSION_HARNESS_READY";

type Summary = {
  readonly registered: string[];
  readonly models: Record<string, number>;
  readonly warnings: string[];
  readonly refresh: ({ readonly id: string; readonly models: string[] } | { readonly id: string; readonly error: string })[];
};

/** Run the harness child; `hold` runs between the child's run and refresh phases (stdin stays open). */
async function runHarness(envExtra: Record<string, string>, hold?: () => Promise<void>): Promise<Summary> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ACCOUNTS_PROXY_TOKEN") env[key] = value;
  }
  Object.assign(env, envExtra);
  const child = Bun.spawn([process.execPath, "--preload", E2E_PRELOAD, HARNESS], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  const reading = (async () => {
    for await (const chunk of child.stdout) stdout += decoder.decode(chunk);
  })();
  const erroring = (async () => {
    for await (const chunk of child.stderr) stderr += decoder.decode(chunk);
  })();
  if (hold !== undefined) {
    const deadline = Date.now() + 30_000;
    while (!stderr.includes(READY)) {
      if (Date.now() > deadline) throw new Error(`harness never became ready: ${stderr}`);
      if (child.exitCode !== null) throw new Error(`harness exited ${child.exitCode}: ${stdout} ${stderr}`);
      await Bun.sleep(10);
    }
    await hold();
  }
  child.stdin.end();
  const [code] = await Promise.all([child.exited, reading, erroring]);
  if (code !== 0) throw new Error(`harness exited ${code}: ${stdout} ${stderr}`);
  return JSON.parse(stdout) as Summary;
}

type PiDocument = { providers: Record<string, { name: string; apiKey: string; models: { id: string }[] }> };

async function documentOf(token: string): Promise<PiDocument> {
  const answer = await fetch(`${daemon!.url}/pi/models.json`, { headers: { authorization: `Bearer ${token}` } });
  expect(answer.status).toBe(200);
  return (await answer.json()) as PiDocument;
}

/** A manifest stub on a random port; `manifest` answers /.well-known/pi, `config` answers config paths. */
function serveStub(manifest: unknown | (() => unknown), config?: (path: string) => unknown): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/.well-known/pi") return Response.json(typeof manifest === "function" ? manifest() : manifest);
      if (config !== undefined && path.startsWith("/pi/")) {
        const answer = config(path);
        return answer instanceof Response ? answer : Response.json(answer);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop() };
}

describe("pi extension", () => {
  test("every available ap- provider registers; the token comes from the manifest's real command [feature=pi-extension use-case=uc-pi-4 tier=e2e polarity=positive]", async () => {
    home = await makeHome(ALL);
    const token = (await runProxy(home, ["token"], upstreams.seamEnv())).stdout.trim();
    daemon = await startDaemon(home, upstreams.seamEnv());
    const doc = await documentOf(token);
    const expected = Object.keys(doc.providers).sort();
    expect(expected.length).toBeGreaterThan(0);
    const summary = await runHarness({ ACCOUNTS_PROXY_URL: daemon.url });
    expect(summary.warnings).toEqual([]);
    expect(summary.registered.sort()).toEqual(expected);
    for (const id of expected) expect(summary.models[id]).toBe(doc.providers[id]!.models.length);
  });

  test("a closed proxy port warns once and registers nothing [feature=pi-extension use-case=uc-pi-4 tier=e2e polarity=negative]", async () => {
    const summary = await runHarness({ ACCOUNTS_PROXY_URL: "http://127.0.0.1:9" });
    expect(summary.registered).toEqual([]);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toMatch(/^accounts-proxy: .*; no ap- providers registered\n$/);
  });

  test("a wrong preset token is a 401 with one warning and no registrations [feature=pi-extension use-case=uc-pi-4 tier=e2e polarity=negative]", async () => {
    home = await makeHome(ALL);
    daemon = await startDaemon(home, upstreams.seamEnv());
    const summary = await runHarness({ ACCOUNTS_PROXY_URL: daemon.url, ACCOUNTS_PROXY_TOKEN: "wrong" });
    expect(summary.registered).toEqual([]);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain("401");
  });

  test("a token command that exits 1 warns once and registers nothing [feature=pi-extension use-case=uc-pi-4 tier=e2e polarity=negative]", async () => {
    const stub = serveStub({ auth: { command: ["false"], env: "ACCOUNTS_PROXY_TOKEN" }, config: { url: "http://127.0.0.1:9/unused" } });
    try {
      const summary = await runHarness({ ACCOUNTS_PROXY_URL: stub.url });
      expect(summary.registered).toEqual([]);
      expect(summary.warnings).toHaveLength(1);
      expect(summary.warnings[0]).toMatch(/^accounts-proxy: .*; no ap- providers registered\n$/);
    } finally {
      stub.stop();
    }
  });

  test("a token command past 10 s warns once and registers nothing [feature=pi-extension use-case=uc-pi-4 tier=e2e polarity=negative]", async () => {
    const stub = serveStub({ auth: { command: ["sleep", "11"], env: "ACCOUNTS_PROXY_TOKEN" }, config: { url: "http://127.0.0.1:9/unused" } });
    try {
      const summary = await runHarness({ ACCOUNTS_PROXY_URL: stub.url });
      expect(summary.registered).toEqual([]);
      expect(summary.warnings).toHaveLength(1);
      expect(summary.warnings[0]).toMatch(/^accounts-proxy: .*; no ap- providers registered\n$/);
    } finally {
      stub.stop();
    }
  });

  test("a configuration that is not a pi document warns once and registers nothing [feature=pi-extension use-case=uc-pi-4 tier=e2e polarity=negative]", async () => {
    home = await makeHome(ALL);
    daemon = await startDaemon(home, upstreams.seamEnv());
    const manifest = (await (await fetch(`${daemon.url}/.well-known/pi`)).json()) as { auth: { command: string[]; env: string } };
    const box: { url: string } = { url: "" };
    const stub = serveStub(() => ({ auth: manifest.auth, config: { url: `${box.url}/pi/models.json` } }), () => ({ providers: 1 }));
    box.url = stub.url;
    try {
      const summary = await runHarness({ ACCOUNTS_PROXY_URL: stub.url });
      expect(summary.registered).toEqual([]);
      expect(summary.warnings).toEqual(["accounts-proxy: not a pi configuration: providers is not an object; no ap- providers registered\n"]);
    } finally {
      stub.stop();
    }
  });

  test("refresh returns the registered models [feature=pi-extension use-case=uc-pi-6 tier=e2e polarity=positive]", async () => {
    home = await makeHome(ALL);
    const token = (await runProxy(home, ["token"], upstreams.seamEnv())).stdout.trim();
    daemon = await startDaemon(home, upstreams.seamEnv());
    const doc = await documentOf(token);
    const summary = await runHarness({ ACCOUNTS_PROXY_URL: daemon.url });
    expect(summary.warnings).toEqual([]);
    expect(summary.refresh).toHaveLength(summary.registered.length);
    for (const entry of summary.refresh) {
      expect("error" in entry).toBe(false);
      if ("models" in entry) expect(entry.models).toEqual(doc.providers[entry.id]!.models.map((model) => model.id));
    }
  });

  test("models that state only an id register with pi's documented defaults [feature=pi-extension use-case=uc-pi-4 tier=e2e polarity=positive]", async () => {
    const box: { url: string } = { url: "" };
    const stub = serveStub(
      () => ({
        auth: { command: ["false"], env: "ACCOUNTS_PROXY_TOKEN" },
        config: { url: `${box.url}/pi/models.json` },
      }),
      () => ({ providers: { "ap-mini": { models: [{ id: "m1" }, { id: "m2", cost: { input: 1 } }] } } }),
    );
    box.url = stub.url;
    try {
      // The preset token means the manifest's failing command never runs; the sparse document must still register.
      const summary = await runHarness({ ACCOUNTS_PROXY_URL: stub.url, ACCOUNTS_PROXY_TOKEN: "stub-token" });
      expect(summary.warnings).toEqual([]);
      expect(summary.registered).toEqual(["ap-mini"]);
      expect(summary.models).toEqual({ "ap-mini": 2 });
      expect(summary.refresh).toEqual([{ id: "ap-mini", models: ["m1", "m2"] }]);
    } finally {
      stub.stop();
    }
  });

  test("a provider entry without a model list warns once and registers nothing [feature=pi-extension use-case=uc-pi-4 tier=e2e polarity=negative]", async () => {
    const box: { url: string } = { url: "" };
    const stub = serveStub(
      () => ({
        auth: { command: ["false"], env: "ACCOUNTS_PROXY_TOKEN" },
        config: { url: `${box.url}/pi/models.json` },
      }),
      () => ({ providers: { "ap-x": null } }),
    );
    box.url = stub.url;
    try {
      const summary = await runHarness({ ACCOUNTS_PROXY_URL: stub.url, ACCOUNTS_PROXY_TOKEN: "stub-token" });
      expect(summary.registered).toEqual([]);
      expect(summary.warnings).toEqual(["accounts-proxy: not a pi configuration: provider ap-x has no model list; no ap- providers registered\n"]);
    } finally {
      stub.stop();
    }
  });

  test("a model without a string id warns once and registers nothing [feature=pi-extension use-case=uc-pi-4 tier=e2e polarity=negative]", async () => {
    const box: { url: string } = { url: "" };
    const stub = serveStub(
      () => ({
        auth: { command: ["false"], env: "ACCOUNTS_PROXY_TOKEN" },
        config: { url: `${box.url}/pi/models.json` },
      }),
      () => ({ providers: { "ap-x": { models: [{}] } } }),
    );
    box.url = stub.url;
    try {
      const summary = await runHarness({ ACCOUNTS_PROXY_URL: stub.url, ACCOUNTS_PROXY_TOKEN: "stub-token" });
      expect(summary.registered).toEqual([]);
      expect(summary.warnings).toEqual(["accounts-proxy: not a pi configuration: model without a string id; no ap- providers registered\n"]);
    } finally {
      stub.stop();
    }
  });

  test("a token command that prints nothing warns once and registers nothing [feature=pi-extension use-case=uc-pi-4 tier=e2e polarity=negative]", async () => {
    const stub = serveStub({ auth: { command: ["true"], env: "ACCOUNTS_PROXY_TOKEN" }, config: { url: "http://127.0.0.1:9/unused" } });
    try {
      const summary = await runHarness({ ACCOUNTS_PROXY_URL: stub.url });
      expect(summary.registered).toEqual([]);
      expect(summary.warnings).toEqual(["accounts-proxy: token command printed nothing; no ap- providers registered\n"]);
    } finally {
      stub.stop();
    }
  });

  test("a proxy error without a message names the status [feature=pi-extension use-case=uc-pi-4 tier=e2e polarity=negative]", async () => {
    const box: { url: string } = { url: "" };
    const stub = serveStub(
      () => ({
        auth: { command: ["false"], env: "ACCOUNTS_PROXY_TOKEN" },
        config: { url: `${box.url}/pi/models.json` },
      }),
      () => new Response("{}", { status: 503, statusText: "Service Unavailable", headers: { "content-type": "application/json" } }),
    );
    box.url = stub.url;
    try {
      const summary = await runHarness({ ACCOUNTS_PROXY_URL: stub.url, ACCOUNTS_PROXY_TOKEN: "stub-token" });
      expect(summary.registered).toEqual([]);
      expect(summary.warnings).toHaveLength(1);
      expect(summary.warnings[0]).toContain("answered 503: Service Unavailable");
    } finally {
      stub.stop();
    }
  });

  test("a providers list instead of a providers object warns once and registers nothing [feature=pi-extension use-case=uc-pi-4 tier=e2e polarity=negative]", async () => {
    const box: { url: string } = { url: "" };
    const stub = serveStub(
      () => ({
        auth: { command: ["false"], env: "ACCOUNTS_PROXY_TOKEN" },
        config: { url: `${box.url}/pi/models.json` },
      }),
      () => ({ providers: [] }),
    );
    box.url = stub.url;
    try {
      const summary = await runHarness({ ACCOUNTS_PROXY_URL: stub.url, ACCOUNTS_PROXY_TOKEN: "stub-token" });
      expect(summary.registered).toEqual([]);
      expect(summary.warnings).toEqual(["accounts-proxy: not a pi configuration: providers is not an object; no ap- providers registered\n"]);
    } finally {
      stub.stop();
    }
  });

  test("refresh returns an empty list when the provider disappeared [feature=pi-extension use-case=uc-pi-6 tier=e2e polarity=negative]", async () => {
    const box: { url: string } = { url: "" };
    let configCalls = 0;
    const stub = serveStub(
      () => ({
        auth: { command: ["false"], env: "ACCOUNTS_PROXY_TOKEN" },
        config: { url: `${box.url}/pi/models.json` },
      }),
      () => {
        configCalls += 1;
        return configCalls === 1 ? { providers: { "ap-fleeting": { models: [{ id: "f1" }] } } } : { providers: {} };
      },
    );
    box.url = stub.url;
    try {
      const summary = await runHarness({ ACCOUNTS_PROXY_URL: stub.url, ACCOUNTS_PROXY_TOKEN: "stub-token" });
      expect(summary.warnings).toEqual([]);
      expect(summary.registered).toEqual(["ap-fleeting"]);
      expect(summary.refresh).toEqual([{ id: "ap-fleeting", models: [] }]);
    } finally {
      stub.stop();
    }
  });

  test("stopping the daemon before refresh records a rejection per provider [feature=pi-extension use-case=uc-pi-6 tier=e2e polarity=negative]", async () => {
    home = await makeHome(ALL);
    const token = (await runProxy(home, ["token"], upstreams.seamEnv())).stdout.trim();
    daemon = await startDaemon(home, upstreams.seamEnv());
    const doc = await documentOf(token);
    const expected = Object.keys(doc.providers).sort();
    const summary = await runHarness({ ACCOUNTS_PROXY_URL: daemon.url }, async () => {
      await daemon!.stop();
      daemon = undefined;
    });
    expect(summary.registered.sort()).toEqual(expected);
    expect(summary.refresh).toHaveLength(expected.length);
    for (const entry of summary.refresh) {
      expect("error" in entry).toBe(true);
    }
  });
});
