// The OpenCode Console sign-in (plan P4.6 amendment A, rules Z17–Z20) and the Cheaper Inference key (C6–C7), black-box
// through the real proxy process with the answers captured live on 2026-10-13 (live validation L4,
// tests/fixtures/captures/p0-live/l4: the Console's user, organisations and workspace config; Cheaper Inference's
// account and wallet) and the Console's captured device-flow answers (c2). Token answers are never recorded (they carry
// grants): the approved and refreshed answers below have the fields of the device-token answer the proxy stores
// (access_token, refresh_token, expires_in, org_id), and the RFC 8628 error answers the captured pending answer's shape.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { makeHome, runProxy, startDaemon, type Daemon, type Home, readPool, writePool } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { captured, jsonResponse, ReplayUpstreams, type Responder } from "@accounts-proxy/test-support/e2e/upstreams.ts";

setDefaultTimeout(120_000);
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

const run = (argv: string[], input?: string) => runProxy(home!, argv, upstreams.seamEnv(), input === undefined ? undefined : async () => input);
const TOKEN = "/console/auth/device/token";
const ORG = "<REDACTED:orgid>";
/** A captured answer (status, body, content type) as a scripted response. */
const replay =
  (relative: string, index = 0): Responder =>
  () => {
    const answer = captured(relative, index);
    return new Response(answer.body, { status: answer.status, headers: { "content-type": answer.contentType } });
  };
/** The captured device-code answer with a 1 s interval (the captured value is 5 s). */
const quickCode: Responder = () => jsonResponse({ ...(JSON.parse(captured("console/c2-device-flow.json", 0).body) as Record<string, unknown>), interval: 1 });
const pollError = (error: string): Responder => () => jsonResponse({ _tag: "DeviceTokenError", error, error_description: `e2e ${error}` }, 400);
const tokens = (extra: Record<string, unknown> = { org_id: ORG }): Responder => () => jsonResponse({ access_token: "console-access", refresh_token: "console-refresh", expires_in: 2_592_000, token_type: "Bearer", ...extra });
const identity = () => upstreams.script("/console/api/user", replay("l4/console-identity.json", 0)).script("/console/api/orgs", replay("l4/console-identity.json", 1));
const pool = () => readPool(home!, "opencode")! as { activeId: string; accounts: { id: string; label: string; needsLogin?: string; data: Record<string, unknown> }[] };

describe("the Console device login (K1, Z17–Z20)", () => {
  test("approved after a slow_down: the tokens, the user and workspace (captured), the workspace headers; one account for both providers", async () => {
    home = await makeHome("providers:\n  opencode: {enabled: true}\n  opencode-go: {enabled: true}\n");
    upstreams.script("/console/auth/device/code", quickCode);
    upstreams.script(TOKEN, pollError("authorization_pending"), pollError("slow_down"), tokens());
    identity();
    upstreams.script("/console/api/v2/config", replay("l4/console-config.json"));
    const login = await run(["login", "opencode-go", "--timeout-seconds", "60"]);
    expect([login.code, login.stderr]).toEqual([0, ""]);
    expect(login.stdout).toEndWith("signed in to opencode-go as <REDACTED:account_id> (<REDACTED:answer_name>) (active account)\n");
    const polls = upstreams.find(TOKEN).slice(-3);
    expect(polls.map((p) => new URLSearchParams(p.body).get("grant_type"))).toEqual(Array(3).fill("urn:ietf:params:oauth:grant-type:device_code"));
    const [user, orgs, config] = [upstreams.find("/console/api/user").at(-1)!, upstreams.find("/console/api/orgs").at(-1)!, upstreams.find("/console/api/v2/config").at(-1)!];
    expect([user.headers["authorization"], user.headers["x-org-id"], orgs.headers["x-org-id"]]).toEqual(["Bearer console-access", undefined, undefined]);
    expect([config.headers["authorization"], config.headers["x-org-id"]]).toEqual(["Bearer console-access", ORG]);
    const stored = pool().accounts[0]!;
    expect([stored.id, stored.label]).toEqual(["<REDACTED:account_id>/<REDACTED:orgid>", "<REDACTED:account_id> (<REDACTED:answer_name>)"]);
    expect(stored.data).toEqual({ accessToken: "console-access", refreshToken: "console-refresh", expiresAt: expect.any(Number), orgId: ORG, workspaceHeaders: { opencode: { "x-opencode-org-id": ORG }, "opencode-go": { "x-opencode-org-id": ORG } } });
    expect((await run(["account", "list", "opencode"])).stdout).toBe("* <REDACTED:account_id>/<REDACTED:orgid>  (<REDACTED:account_id> (<REDACTED:answer_name>))\n");
  });

  test("a token without a workspace, an unknown workspace, a user without e-mail; ended or malformed answers", async () => {
    home = await makeHome("providers:\n  opencode: {enabled: true}\n");
    const approved = async (token: Responder, user?: Responder) => {
      upstreams.script("/console/auth/device/code", quickCode);
      upstreams.script(TOKEN, token);
      if (user !== undefined) upstreams.script("/console/api/user", user).script("/console/api/orgs", replay("l4/console-identity.json", 1));
      else identity();
      upstreams.script("/console/api/v2/config", replay("l4/console-config.json"));
      return run(["login", "opencode", "--timeout-seconds", "60"]);
    };
    const personal = await approved(tokens({}));
    expect([personal.code, personal.stdout]).toEqual([0, expect.stringContaining("signed in to opencode as <REDACTED:account_id> (active account)\n")]);
    expect(pool().accounts.at(-1)!.data["orgId"]).toBeUndefined();
    expect(upstreams.find("/console/api/v2/config").at(-1)!.headers["x-org-id"]).toBeUndefined();
    const unknown = await approved(tokens({ org_id: "org_elsewhere" }));
    expect(unknown.stdout).toContain("signed in to opencode as <REDACTED:account_id> (org_elsewhere) (active account)\n");
    expect(pool().accounts.at(-1)!.id).toBe("<REDACTED:account_id>/org_elsewhere");
    const byId = await approved(tokens(), () => jsonResponse({ id: "usr_e2e", email: null }));
    expect(byId.stdout).toContain("signed in to opencode as usr_e2e (<REDACTED:answer_name>) (active account)\n");
    for (const [token, user, message] of [
      [tokens(), () => jsonResponse({ role: "user" }), "error: opencode upstream HTTP 502: the Console user answer has no email or id\n"],
      [() => jsonResponse({ access_token: "a", expires_in: 1 }), undefined, 'error: opencode upstream HTTP 502: token answer lacks a field: ["access_token","expires_in"]\n'],
      [pollError("access_denied"), undefined, "error: opencode: device authorization ended: access_denied; run `accounts-proxy login opencode`\n"],
      [pollError("expired_token"), undefined, "error: opencode: device authorization ended: expired_token; run `accounts-proxy login opencode`\n"],
      [() => jsonResponse({ _tag: "DeviceTokenError" }, 400), undefined, "error: opencode: device authorization ended: no error code; run `accounts-proxy login opencode`\n"],
      [() => new Response("busy", { status: 503 }), undefined, "error: opencode upstream HTTP 503: busy\n"],
    ] as const) {
      const result = await approved(token, user);
      expect([result.code, result.stderr]).toEqual([1, message]);
    }
  });
});

describe("the Console session (Z18, plan v4 Phase H)", () => {
  /** An expired device sign-in in the proxy's own account file. */
  const expired = () => {
    const headers = { opencode: { "x-opencode-org-id": ORG }, "opencode-go": { "x-opencode-org-id": ORG } };
    writePool(home!, "opencode", { accounts: [{ provider: "opencode", id: "e2e/org", label: "e2e", data: { accessToken: "console-old", refreshToken: "console-refresh-old", expiresAt: Date.now() - 1000, orgId: ORG, workspaceHeaders: headers } }], activeId: "e2e/org" });
  };
  async function serve(): Promise<{ url: string; token: string }> {
    home = await makeHome("providers:\n  opencode: {enabled: true}\n  opencode-go: {enabled: true}\n");
    expired();
    const token = (await run(["token"])).stdout.trim();
    daemon = await startDaemon(home, upstreams.seamEnv());
    return { url: daemon.url, token };
  }
  const chat = (s: { url: string; token: string }) =>
    fetch(`${s.url}/openai/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json", "x-opencode-session": "ses_e2e" }, body: JSON.stringify({ model: "opencode-go/glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }) });
  const lastInference = () => upstreams.find("/inference/go/openai/v1/chat/completions").at(-1)!;

  test("an expired device token is renewed (single-use refresh token, the workspace kept) before the request", async () => {
    const s = await serve();
    upstreams.script(TOKEN, tokens({}));
    expect((await chat(s)).status).toBe(401);
    const refresh = new URLSearchParams(upstreams.find(TOKEN).at(-1)!.body);
    expect([refresh.get("grant_type"), refresh.get("refresh_token"), refresh.get("client_id")]).toEqual(["refresh_token", "console-refresh-old", "accounts-proxy"]);
    expect([lastInference().headers["authorization"], lastInference().headers["x-opencode-org-id"]]).toEqual(["Bearer console-access", ORG]);
    expect(pool().accounts[0]!.data).toMatchObject({ accessToken: "console-access", refreshToken: "console-refresh", orgId: ORG });
    // A refresh answer that names a workspace binds the session to it.
    expired();
    upstreams.script(TOKEN, tokens({ org_id: "org_renewed" }));
    expect((await chat(s)).status).toBe(401);
    expect(pool().accounts[0]!.data["orgId"]).toBe("org_renewed");
  });

  test("a refused refresh (invalid_grant) marks the account for a new login; other refusals are upstream errors", async () => {
    const s = await serve();
    upstreams.script(TOKEN, () => jsonResponse({ error: "invalid_grant", error_description: "e2e" }, 400));
    const refused = await chat(s);
    expect([refused.status, ((await refused.json()) as { error: { message: string } }).error.message]).toEqual([401, "opencode: account e2e/org needs a new login (the Console rejected the refresh token (invalid_grant)); run `accounts-proxy login opencode`"]);
    expect(pool().accounts[0]!.needsLogin).toContain("invalid_grant");
    expired();
    // The catalog (the model's formats) and the request each try the renewal.
    upstreams.script(TOKEN, () => jsonResponse({ error: "server_error" }, 400), () => jsonResponse({ error: "server_error" }, 400));
    const failed = await chat(s);
    expect([failed.status, ((await failed.json()) as { error: { message: string } }).error.message]).toEqual([400, 'opencode upstream HTTP 400: {"error":"server_error"}']);
  });
});

describe("Cheaper Inference key and wallet (C6–C7, captured answers)", () => {
  test("the key is checked against the account (its e-mail names it); the wallet is reported; refusals", async () => {
    home = await makeHome("providers:\n  cheaper-inference: {enabled: true}\n");
    upstreams.script("/v1/account", replay("l4/cheaper-account.json"));
    const login = await run(["login", "cheaper-inference"], "ci_live_e2e\n");
    expect([login.code, login.stdout]).toEqual([0, "Cheaper Inference API key (dashboard → API keys, ci_live_…): \nsigned in to cheaper-inference as <REDACTED:account_id> (active account)\n"]);
    expect(upstreams.find("/v1/account").at(-1)!.headers["authorization"]).toBe("Bearer ci_live_e2e");
    upstreams.script("/v1/account/balance", replay("l4/cheaper-balance.json"));
    const quota = await run(["quota", "cheaper-inference"]);
    expect(quota.stdout).toBe('Cheaper Inference wallet (GET /v1/account/balance):\n  currency: "USD"\n  balance_usd: 13.772105\n  available_usd: 13.772105\n  reserved_usd: 0\n');
    upstreams.script("/v1/account/balance", () => jsonResponse({ error: { message: "e2e" } }, 401));
    expect(await run(["quota", "cheaper-inference"])).toMatchObject({ code: 1, stderr: expect.stringContaining("cheaper-inference: GET /v1/account/balance HTTP 401") });
    upstreams.script("/v1/account", () => jsonResponse({ error: { message: "invalid key" } }, 401));
    expect(await run(["login", "cheaper-inference"], "ci_live_bad\n")).toMatchObject({ code: 1, stderr: expect.stringContaining("cheaper-inference: the key was refused: HTTP 401") });
  });
});
