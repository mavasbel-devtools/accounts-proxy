// The pi configuration (plan 2026-11-15-23-52 stage 4), black-box through the real proxy process: the command
// `pi-config`, the routes `/pi/models.json` and `/.well-known/pi`, and pi 1.5.2's published schema.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { E2E_TEST_TIMEOUT_MS } from "@accounts-proxy/scripts/gate/run-tests.ts";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { validate } from "@accounts-proxy/test-support/json-schema.ts";
import { ENTRY, makeHome, runProxy, startDaemon, type Daemon, type Home } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { ReplayUpstreams, spec } from "@accounts-proxy/test-support/e2e/upstreams.ts";

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
const run = (argv: string[]) => runProxy(home!, argv, upstreams.seamEnv());
const piSchema = JSON.parse(spec("pi-models-schema.json")) as Record<string, unknown>;

type PiDocument = { $schema: string; providers: Record<string, unknown> };

describe("pi configuration", () => {
  test("pi-config prints a schema-valid document of the available providers; a provider without an account is absent; an argument is a usage error [feature=pi-config use-case=uc-pi-1 tier=e2e polarity=positive]", async () => {
    home = await makeHome(ALL);
    const generated = await run(["pi-config"]);
    expect([generated.code, generated.stderr]).toEqual([0, ""]);
    const doc = JSON.parse(generated.stdout) as PiDocument;
    expect(validate(piSchema, doc)).toEqual([]);
    const catalogs = (JSON.parse((await run(["models", "--json"])).stdout) as { catalogs: { provider: string; source: string }[] }).catalogs;
    const available = catalogs.filter((c) => c.source !== "unavailable").map((c) => `ap-${c.provider}`);
    expect(Object.keys(doc.providers).sort()).toEqual([...available].sort());
    expect(doc.providers["ap-antigravity"]).toBeUndefined();
  });

  test("pi-config with an argument exits 2 [feature=pi-config use-case=uc-pi-1 tier=e2e polarity=negative]", async () => {
    home = await makeHome(ALL);
    expect((await run(["pi-config", "x"])).code).toBe(2);
  });

  test("the daemon: GET /pi/models.json needs the token and serves the command's document [feature=pi-config use-case=uc-pi-2 tier=e2e polarity=positive]", async () => {
    home = await makeHome(ALL);
    const expected = JSON.parse((await run(["pi-config"])).stdout) as PiDocument;
    const token = (await run(["token"])).stdout.trim();
    daemon = await startDaemon(home, upstreams.seamEnv());
    const answer = await fetch(`${daemon.url}/pi/models.json`, { headers: { authorization: `Bearer ${token}` } });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual(expected);
  });

  test("the daemon: GET /pi/models.json without the token is a 401 [feature=pi-config use-case=uc-pi-2 tier=e2e polarity=negative]", async () => {
    home = await makeHome(ALL);
    daemon = await startDaemon(home, upstreams.seamEnv());
    const unauthorized = await fetch(`${daemon.url}/pi/models.json`);
    expect([unauthorized.status, await unauthorized.json()]).toEqual([401, { error: { code: "unauthorized", message: "missing or invalid accounts-proxy token" } }]);
  });

  test("the daemon: the pi manifest is open [feature=pi-config use-case=uc-pi-3 tier=e2e polarity=positive]", async () => {
    home = await makeHome(ALL);
    daemon = await startDaemon(home, upstreams.seamEnv());
    const manifest = (await (await fetch(`${daemon.url}/.well-known/pi`)).json()) as unknown;
    expect(manifest).toEqual({
      auth: { command: ["env", `ACCOUNTS_PROXY_HOME=${home.dir}`, process.execPath, ENTRY, "token"], env: "ACCOUNTS_PROXY_TOKEN" },
      config: { url: `${daemon.url}/pi/models.json` },
    });
  });

  test("the daemon: POST /.well-known/pi is a 404 [feature=pi-config use-case=uc-pi-3 tier=e2e polarity=negative]", async () => {
    home = await makeHome(ALL);
    daemon = await startDaemon(home, upstreams.seamEnv());
    expect((await fetch(`${daemon.url}/.well-known/pi`, { method: "POST" })).status).toBe(404);
  });
});
