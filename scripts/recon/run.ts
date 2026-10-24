/**
 * Execute one client inside a fully isolated profile and capture what it sends.
 *
 * Order of operations is part of the contract: fingerprint the real client directories, start the MITM (and a private
 * X server for GUI clients), prove isolation from inside the sandbox, run the client, stop everything, fingerprint
 * again. A changed fingerprint, or a failed in-sandbox probe, fails the run.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allClients,
  clientById,
  detectVersion,
  guardedPaths,
  resolveLoginCommand,
  type ReconClient,
} from "@accounts-proxy/scripts/recon/clients.ts";
import { loginMarkers, loginSignalsSignedIn, refreshLoginRecord, writeLoginRecord } from "@accounts-proxy/scripts/recon/login.ts";
import { assertLoopbackPortFree, freeLoopbackPort, mergeServicePort } from "@accounts-proxy/scripts/recon/sandbox/ports.ts";
import { mergeJsonSetting } from "@accounts-proxy/scripts/recon/sandbox/settings.ts";
import { attributeChanges } from "@accounts-proxy/scripts/recon/sandbox/live.ts";
import { redactionManifestPath } from "@accounts-proxy/scripts/recon/shared/manifest.ts";
import { writeTimeline } from "@accounts-proxy/scripts/recon/timeline.ts";
import type { WorkflowStep } from "@accounts-proxy/scripts/recon/workflows/types.ts";
import { buildBwrapArgv, isolatedEnv } from "@accounts-proxy/scripts/recon/sandbox/bwrap.ts";
import { startDisplay, stopDisplay, type PrivateDisplay } from "@accounts-proxy/scripts/recon/sandbox/display.ts";
import { changedPaths, snapshotPaths } from "@accounts-proxy/scripts/recon/sandbox/guard.ts";
import { probeIsolation } from "@accounts-proxy/scripts/recon/sandbox/probe.ts";
import { ProcProcessControl, stopSandboxed, type StopOutcome } from "@accounts-proxy/scripts/recon/sandbox/stop.ts";
import {
  acquireProfileLock,
  assertIsolatedProfile,
  ensureProfile,
  hostnameOf,
  identityFiles,
  keyringPassphrase,
  machineIdOf,
  profileFor,
  reconRoot,
  releaseProfileLock,
  type Profile,
} from "@accounts-proxy/scripts/recon/sandbox/profiles.ts";
import {
  CA_IN_SANDBOX,
  OPEN_BIN_DIR_IN_SANDBOX,
  SESSION_BIN,
  WORK_IN_SANDBOX,
  X11_SOCKET_DIR,
  type Bind,
  type SandboxSpec,
} from "@accounts-proxy/scripts/recon/sandbox/types.ts";

const RECON_DIR = dirname(fileURLToPath(import.meta.url));
const ADDON = join(RECON_DIR, "mitm", "recon_addon.py");
const OPEN_STUB = join(RECON_DIR, "sandbox", "bin", "xdg-open");
/** Private session bus + keyring launcher, bound into the sandbox for clients that keep credentials in the keyring. */
const SESSION_STUB = join(RECON_DIR, "sandbox", "bin", "session");
/** How long a stopped client gets to run its own shutdown before the sandbox is stopped (Antigravity measured 2 s). */
const CLIENT_STOP_GRACE_MS = 30_000;

/** System trees every sandbox needs, filtered to the ones that exist on this host. */
function systemBinds(): string[] {
  return ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/opt", "/sys"].filter((path) => existsSync(path));
}

/** Wait until something accepts connections on the port. */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolveProbe) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolveProbe(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolveProbe(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`nothing listening on ${port} after ${timeoutMs} ms`);
}

/** Wait for the per-run CA bundle to be written by mitmdump. */
async function waitForCa(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`mitmproxy did not write ${path}`);
}

/** The parts of a client the capture proxy needs. `ReconClient` satisfies it; tests use a literal. */
export interface MitmTarget {
  readonly id: string;
  readonly cell: string;
  readonly interceptHosts?: string;
}

/**
 * Upstream resolvers mitmproxy may use, from `RECON_DNS_SERVERS` (comma separated). Unset means "use the system
 * resolver", which is mitmproxy's own default; the variable exists because a capture run resolves every upstream host
 * itself, so a host whose `/etc/resolv.conf` points at an unreachable server records `502` for every flow instead of
 * failing at the first one.
 */
export function upstreamDnsServers(env: NodeJS.ProcessEnv): string[] {
  const raw = env.RECON_DNS_SERVERS?.trim();
  if (raw === undefined || raw === "") return [];
  return raw
    .split(",")
    .map((server) => server.trim())
    .filter((server) => server !== "");
}

/** Start mitmdump for one run and wait for its listener. */
export async function startMitm(
  runDir: string,
  client: MitmTarget,
  runLabel: string,
  clientVersion: string,
  dnsServers: readonly string[] = [],
): Promise<{ child: ChildProcess; port: number }> {
  const port = await freeLoopbackPort();
  const confdir = join(runDir, "mitm");
  mkdirSync(confdir, { recursive: true, mode: 0o700 });
  // The log is the only record of what never became a flow: TLS handshake failures, upstream resets, redaction
  // warnings. Inheriting a pipe that nobody drains would block mitmdump once the buffer fills.
  const logFd = openSync(join(runDir, "mitm.log"), "a", 0o600);
  const child = spawn(
    "mitmdump",
    [
      "--set", `confdir=${confdir}`,
      "--listen-host", "127.0.0.1",
      "--listen-port", String(port),
      "-s", ADDON,
      "--set", `recon_out=${join(runDir, "captures")}`,
      "--set", `recon_client=${client.id}`,
      "--set", `recon_client_version=${clientVersion}`,
      "--set", `recon_cell=${client.cell}`,
      "--set", `recon_run=${runLabel}`,
      "--set", `recon_redaction=${redactionManifestPath}`,
      ...(dnsServers.length === 0 ? [] : ["--set", `dns_name_servers=${dnsServers.join(",")}`]),
      ...(client.interceptHosts === undefined ? [] : ["--set", `recon_intercept_hosts=${client.interceptHosts}`]),
    ],
    { stdio: ["ignore", logFd, logFd] },
  );
  closeSync(logFd);
  await waitForPort(port, 15_000);
  await waitForCa(join(confdir, "mitmproxy-ca-cert.pem"), 15_000);
  return { child, port };
}

/** Stop mitmdump and wait for it to exit. */
export async function stopMitm(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

/** Spawn one sandboxed command and wait for it, bounded by `timeoutMs` (zero means no bound). */
function spawnAndWait(
  argv: readonly string[],
  timeoutMs: number,
  cwd: string,
): Promise<{ code: number; timedOut: boolean; stop?: StopOutcome }> {
  return new Promise((resolveExit, rejectExit) => {
    let timedOut = false;
    let stopping: Promise<StopOutcome> | undefined;
    const proc = spawn(argv[0]!, argv.slice(1), {
      stdio: "inherit",
      // The sandbox environment is set entirely by the spec (`--clearenv`); the bwrap process itself needs almost
      // nothing from the host, and nothing that could be inherited by the client. The cwd is the run directory so a
      // client that dumps core (Electron does) writes it into the run, never into whatever directory the operator
      // happened to run the recon CLI from.
      cwd,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    const exited = new Promise<void>((resolveExited) => proc.once("exit", () => resolveExited()));
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            // The client inside the sandbox gets the signal, so it can save what it keeps (see `stopSandboxed`).
            if (proc.pid !== undefined) {
              stopping = stopSandboxed(new ProcProcessControl(), { pid: proc.pid, exited }, CLIENT_STOP_GRACE_MS, 5_000);
            }
          }, timeoutMs)
        : undefined;
    proc.once("error", rejectExit);
    proc.once("exit", (code) => {
      if (timeout) clearTimeout(timeout);
      if (stopping === undefined) resolveExit({ code: code ?? -1, timedOut });
      else void stopping.then((stop) => resolveExit({ code: code ?? -1, timedOut, stop }));
    });
  });
}

/** Wait for a visible window whose name contains `needle`, then return its id. */
async function waitForWindow(display: string, needle: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const found = await xdotool(display, ["search", "--onlyvisible", "--name", needle]);
      const window = found.split("\n")[0]?.trim() ?? "";
      if (window !== "") return window;
    } catch {
      // No window yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no window matching ${needle} appeared on the private display`);
}

/** Click a window-relative coordinate. */
async function clickWindow(display: string, window: string, x: number, y: number): Promise<void> {
  await xdotool(display, ["mousemove", "--window", window, String(x), String(y)]);
  await xdotool(display, ["click", "1"]);
}

/** True when a captured response shows a successful OAuth token exchange. */
function loginTokenSeen(runDir: string): boolean {
  const dir = join(runDir, "captures");
  if (!existsSync(dir)) return false;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith("-response.json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as { status?: unknown; url?: unknown };
      if (record.status === 200 && typeof record.url === "string" && /(^|\/)oauth|(^|\/)token/i.test(record.url)) {
        return true;
      }
    } catch {
      // A capture being written is not a token exchange.
    }
  }
  return false;
}

/**
 * Drive a GUI client from launch to a login URL, then wait for the browser flow to finish.
 *
 * The client runs on a private X server the operator cannot see, so the sign-in button is clicked by coordinate. Once
 * the client asks the browser to open a URL, the operator completes the flow on the host: the sandbox shares the
 * network namespace, so the loopback callback reaches the client.
 *
 * Completion is the client's own signed-in state, never the token exchange: Antigravity reports `signedIn` only after
 * it has persisted the credential and finished onboarding, and stopping at the exchange leaves a signed-out profile
 * (measured: run 2026-10-20-20-55-20, token 200 at seq 060, `signedOut` on the next launch). The settle window covers
 * the writes that follow the state change, and the state is re-read before the client is stopped.
 */
/**
 * A signed-in turn, driven in the same process that logged in.
 *
 * Antigravity's language server reads its token from a state-sync store that is never written in the sandbox (measured:
 * `state syncing error: key not found` in `ls-main.log`, no `antigravityUnifiedStateSync.*` topic in `state.vscdb`), so
 * a resumed profile offers no models and refuses to send. The login run is the only place a turn exists, which is why
 * the prompt is taken here: dismiss what covers the panel, pick a model, type, send.
 */
async function guiTurn(
  display: string,
  cdpPort: number | undefined,
  prompt: string,
  waitMs: number,
  windowName?: string,
): Promise<{ dismissed?: unknown; model?: unknown; typed: unknown }> {
  if (cdpPort === undefined) return { typed: await guiPrompt(display, prompt, waitMs, undefined, windowName) };
  // Right after sign-in the window still shows "Success, Continuing…" over the onboarding carousel; the chat panel
  // does not exist until the carousel is skipped, and "Skip onboarding" only appears once that screen settles
  // (measured: a turn started 10 s after `signedIn` found no input at all). So dismissal is retried until the chat
  // input is on screen, for up to two minutes.
  const dismissed: string[] = [];
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
    dismissed.push(...(await cdpDismiss(cdpPort).catch(() => ({ clicked: [] as string[] }))).clicked);
    ready = await cdpHasChatInput(cdpPort).catch(() => false);
    if (!ready) await new Promise((r) => setTimeout(r, 2_000));
  }
  const model = await cdpSelectModel(cdpPort);
  const typed = await guiPrompt(display, prompt, waitMs, cdpPort, windowName);
  return { dismissed: { clicked: dismissed, ready }, model, typed };
}

/** True when some page of the client shows the agent's message input. */
async function cdpHasChatInput(port: number): Promise<boolean> {
  for (const target of await cdpTargets(port)) {
    if (target.webSocketDebuggerUrl === undefined || target.type !== "page") continue;
    const found = await cdpEvaluate(
      target.webSocketDebuggerUrl,
      `(() => { ${CDP_VISIBLE} return [...document.querySelectorAll('[aria-label="Message input"]')].some(visible); })()`,
    );
    if (found === true) return true;
  }
  return false;
}

async function driveGuiLogin(options: {
  display: string;
  windowName: string;
  clicks?: readonly { readonly x: number; readonly y: number; readonly afterMs?: number }[];
  /** Button labels to press in order through the client's DOM; preferred over coordinates. */
  buttons?: readonly string[];
  cdpPort?: number;
  workdir: string;
  runDir: string;
  onOpenUrl?: (url: string) => void;
  timeoutMs: number;
  /** The client's own signed-in answer, read from its profile. */
  signedIn: () => boolean;
  /** Time to keep the client running after it reports signed in, so the credential is persisted. */
  settleMs?: number;
  /** True once the run was asked to stop; every wait below ends early. */
  stopped?: () => boolean;
}): Promise<{ buttonClicks: { ok: boolean; label: string; attempts: number }[]; error?: string }> {
  const buttonClicks: { ok: boolean; label: string; attempts: number }[] = [];
  try {
    await driveGuiLoginSteps(options, buttonClicks);
    return { buttonClicks };
  } catch (error) {
    return { buttonClicks, error: error instanceof Error ? error.message : String(error) };
  }
}

async function driveGuiLoginSteps(
  options: Parameters<typeof driveGuiLogin>[0],
  buttonClicks: { ok: boolean; label: string; attempts: number }[],
): Promise<void> {
  const stopped = options.stopped ?? (() => false);
  const window = await waitForWindow(options.display, options.windowName, 40_000);
  if (options.buttons !== undefined && options.cdpPort !== undefined) {
    // Poll instead of sleeping through a fixed order: on a first launch the welcome view is painted tens of seconds
    // after the window exists, and a modal can appear after it. A label prefixed with "?" is optional; the last one is
    // the sign-in entry and must be clicked.
    const labels = options.buttons.map((label) => ({ label, optional: label.startsWith("?"), done: false }));
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !stopped()) {
      for (const entry of labels) {
        if (entry.done) continue;
        const label = entry.optional ? entry.label.slice(1) : entry.label;
        // A slow renderer (measured: one evaluate timed out at load average 100) is a missed poll, not a failed login.
        const clicked = await cdpClickButton(options.cdpPort, label, 0).catch(() => ({ ok: false, label, attempts: 1 }));
        if (clicked.ok) {
          buttonClicks.push({ ...clicked, label });
          entry.done = true;
          await new Promise((r) => setTimeout(r, 1_500));
        }
      }
      const required = labels[labels.length - 1];
      if (required !== undefined && required.done) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    for (const entry of labels) {
      if (!entry.done) buttonClicks.push({ ok: false, label: entry.label, attempts: 0 });
    }
  }
  for (const click of options.clicks ?? []) {
    await clickWindow(options.display, window, click.x, click.y);
    await new Promise((r) => setTimeout(r, click.afterMs ?? 1_500));
  }
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  let announced = 0;
  let urlSeenAt: number | undefined;
  let tokenSeen = false;
  while (Date.now() < deadline) {
    const urls = readOpenUrls(options.workdir);
    for (const url of urls.slice(announced)) options.onOpenUrl?.(url);
    announced = urls.length;
    if (urls.length > 0 && urlSeenAt === undefined) urlSeenAt = Date.now();
    if (options.signedIn()) {
      await new Promise((r) => setTimeout(r, options.settleMs ?? 10_000));
      if (!options.signedIn()) {
        throw new Error("the client reported signed in, then lost the state before its credential was persisted");
      }
      return;
    }
    if (stopped()) throw new Error("stopped by signal before the client reported signed in");
    tokenSeen = tokenSeen || loginTokenSeen(options.runDir);
    if (urlSeenAt === undefined && Date.now() - startedAt > 45_000) {
      throw new Error(`the client never asked the browser to open a login URL; the click sequence did not reach sign-in (clicked: ${JSON.stringify(buttonClicks)})`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (urlSeenAt === undefined) {
    throw new Error(`the client never asked the browser to open a login URL; the click sequence did not reach sign-in (clicked: ${JSON.stringify(buttonClicks)})`);
  }
  throw new Error(
    tokenSeen
      ? "an OAuth token was issued but the client never reported signedIn; its credential was not persisted"
      : "the login URL was opened but no OAuth token exchange was captured before the timeout",
  );
}

/** Run a host `xdotool` command against one private display and return its stdout. */function xdotool(display: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveTool, rejectTool) => {
    const proc = spawn("xdotool", [...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DISPLAY: display } });
    let stdout = "";
    proc.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    proc.once("error", rejectTool);
    proc.once("exit", (code) => (code === 0 ? resolveTool(stdout.trim()) : rejectTool(new Error(`xdotool ${args.join(" ")} exited ${code}`))));
  });
}

/**
 * Type a prompt into a running GUI client and submit it.
 *
 * The window is activated, the editor area clicked near the bottom (where the agent input sits), the prompt typed and
 * Return pressed. This is a best-effort driver for a client with no non-interactive entry point: whether the input
 * actually receives the text is decided by the capture that follows, never assumed here.
 */
async function guiPromptKeys(
  display: string,
  prompt: string,
  waitMs: number,
  windowName = "[Aa]ntigravity",
): Promise<{ window: string; width: number; height: number }> {
  const deadline = Date.now() + 30_000;
  let window = "";
  while (Date.now() < deadline && window === "") {
    try {
      const found = await xdotool(display, ["search", "--onlyvisible", "--name", windowName]);
      window = found.split("\n")[0]?.trim() ?? "";
    } catch {
      window = "";
    }
    if (window === "") await new Promise((r) => setTimeout(r, 500));
  }
  if (window === "") throw new Error(`no window matching ${windowName} appeared on the private display`);
  // Xvfb runs without a window manager, so EWMH activation (`windowactivate`) has nothing to talk to. Focus is set
  // directly with XSetInputFocus instead, which is what `windowfocus` does.
  await xdotool(display, ["windowraise", window]).catch(() => "");
  await xdotool(display, ["windowfocus", "--sync", window]);
  const geometry = await xdotool(display, ["getwindowgeometry", "--shell", window]);
  const width = Number(/WIDTH=(\d+)/.exec(geometry)?.[1] ?? 0);
  const height = Number(/HEIGHT=(\d+)/.exec(geometry)?.[1] ?? 0);
  if (width > 0 && height > 0) {
    await xdotool(display, ["mousemove", "--window", window, String(Math.floor(width / 2)), String(Math.max(0, height - 140))]);
    await xdotool(display, ["click", "1"]);
    await new Promise((r) => setTimeout(r, 400));
  }
  await xdotool(display, ["type", "--clearmodifiers", "--delay", "12", prompt]);
  await xdotool(display, ["key", "--clearmodifiers", "Return"]);
  await new Promise((r) => setTimeout(r, waitMs));
  return { window, width, height };
}

/**
 * Submit a prompt to a running GUI client: CDP first, coordinate typing as the fallback.
 *
 * The fallback is not equivalent. It clicks a fixed point that assumes the chat panel is where it was on the day the
 * coordinates were measured; when it misses, the run records the attempt and an empty capture. The CDP driver names the
 * page, the input it found and how it submitted, so the failure is diagnosable instead of silent.
 */
async function guiPrompt(
  display: string,
  prompt: string,
  waitMs: number,
  cdpPort?: number,
  windowName?: string,
): Promise<{ window: string; width: number; height: number; driver: string; cdp?: unknown }> {
  if (cdpPort !== undefined) {
    const viaCdp = await cdpPrompt(cdpPort, prompt);
    if (viaCdp.ok) {
      await new Promise((r) => setTimeout(r, waitMs));
      return { window: "", width: 0, height: 0, driver: "cdp", cdp: viaCdp };
    }
    // No keyboard fallback when CDP is available: typing blind into a window whose chat panel is not on screen pressed
    // Return on the onboarding carousel (measured: it advanced two slides and hid "Skip onboarding"). The CDP result
    // already names what was missing.
    return { window: "", width: 0, height: 0, driver: "cdp", cdp: viaCdp };
  }
  const viaKeys = await guiPromptKeys(display, prompt, waitMs, windowName);
  return { ...viaKeys, driver: "xdotool" };
}

/**
 * Drive a GUI client's prompt input through the Chrome DevTools Protocol.
 *
 * The private X server has no window manager and no layout guarantees, so coordinate clicking in the chat panel is a
 * guess that has already missed (measured: the typed prompt reached no inference call). CDP addresses the page the
 * window actually renders. The probe is recorded whether or not submission works, so a version change shows up as a
 * concrete DOM report instead of a silent empty capture.
 */
interface CdpTarget {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

const CDP_VISIBLE =
  'const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); ' +
  'return r.width > 4 && r.height > 4 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0; };';

function probeExpression(): string {
  return `(() => {
    ${CDP_VISIBLE}
    const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]')].filter(visible).map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName, role: el.getAttribute('role'), aria: el.getAttribute('aria-label'), placeholder: el.getAttribute('placeholder'), cls: String(el.className).slice(0, 100), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible).map((b) => ({
      aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), text: (b.textContent || '').trim().slice(0, 40), disabled: Boolean(b.disabled),
    })).filter((b) => /send|submit|run|ask/i.test((b.aria || '') + ' ' + (b.title || '') + ' ' + b.text));
    return { title: document.title, url: location.href, inputs, buttons };
  })()`;
}


/** Focus the chat input and put the caret at its end, so the real input path can type into it. */
function focusExpression(): string {
  return `(() => {
    ${CDP_VISIBLE}
    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]')]
      .filter(visible)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .sort((a, b) => (b.r.y + b.r.height) - (a.r.y + a.r.height));
    if (candidates.length === 0) return { ok: false, reason: 'no visible text input' };
    const el = candidates[0].el;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { ok: true, tag: el.tagName, role: el.getAttribute('role'), aria: el.getAttribute('aria-label') };
  })()`;
}

/** Read back what the input now holds and whether the send control became usable. */
function typedExpression(): string {
  return `(() => {
    ${CDP_VISIBLE}
    const el = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]')].filter(visible)[0];
    const value = el === undefined ? '' : (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.textContent) || '';
    const send = [...document.querySelectorAll('button, [role="button"]')].filter(visible)
      .find((b) => /send message/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')));
    return { length: value.length, value: value.slice(0, 120), sendDisabled: send === undefined ? null : Boolean(send.disabled) };
  })()`;
}

function sendExpression(): string {
  return `(() => {
    ${CDP_VISIBLE}
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
    const send = buttons.find((b) => /send|submit|run|ask/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.textContent || '')));
    if (send) {
      send.click();
      return { ok: true, how: 'button', label: (send.getAttribute('aria-label') || send.getAttribute('title') || send.textContent || '').trim().slice(0, 60) };
    }
    const el = document.activeElement;
    if (el) {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
      return { ok: true, how: 'enter' };
    }
    return { ok: false, reason: 'no send button and no focused element' };
  })()`;
}

/**
 * Clear the dialogs that sit between the client's start-up and its chat panel. Antigravity 1.107.0 shows a
 * workspace-trust modal over a five-slide onboarding carousel even with `--skip-welcome`, and neither is dismissed by
 * a flag; measured on the real client, skippng the carousel is what reveals the "Message input" box.
 */
export function dismissExpression(): string {
  return `(() => {
    ${CDP_VISIBLE}
    const clicked = [];
    const clickBy = (pattern, scope) => {
      const el = [...(scope ?? document).querySelectorAll('button, a, [role="button"]')]
        .filter(visible)
        .find((candidate) => pattern.test((candidate.textContent || '').trim()));
      if (el === undefined) return;
      el.click();
      clicked.push((el.textContent || '').trim().slice(0, 40));
    };
    clickBy(/I trust the authors/i);
    // The pre-2.0 settings-migration dialog reappears on every launch until it is answered; its Cancel is scoped to the
    // dialog so a generic "Cancel" elsewhere is never pressed.
    const migration = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      /Migrate Settings, Keybindings, and Extensions/i.test(d.textContent || ''),
    );
    if (migration !== undefined) clickBy(/^Cancel$/i, migration);
    clickBy(/Skip onboarding/i);
    // "Skip onboarding" exists only on the carousel's first slide. Measured 2026-10-21: the run's fallback typing
    // pressed Return, which advanced to slide 3, and from there only "Next" leads on. While the chat input is absent,
    // one "Next" per pass walks the carousel to its end.
    const chatReady = [...document.querySelectorAll('[aria-label="Message input"]')].some(visible);
    if (!chatReady && clicked.length === 0) clickBy(/^Next\\b/i);
    return { clicked };
  })()`;
}

/** Run the dismissal on every page target of a GUI client; dialogs are per window, not per process. */
async function cdpDismiss(port: number): Promise<{ ok: boolean; clicked: string[] }> {
  const targets = await cdpTargets(port);
  const clicked: string[] = [];
  for (const target of targets) {
    if (target.webSocketDebuggerUrl === undefined || !["page", "webview", "iframe"].includes(target.type)) continue;
    const result = (await cdpEvaluate(target.webSocketDebuggerUrl, dismissExpression())) as { clicked?: string[] } | undefined;
    clicked.push(...(result?.clicked ?? []));
  }
  return { ok: true, clicked };
}

/** Click one button by its visible label on every page target of a GUI client; returns whether one matched. */
export function buttonExpression(label: string): string {
  return `(() => {
    ${CDP_VISIBLE}
    // Alternatives are separated by "|" and tried in order: one entry point is labelled differently on a profile that
    // has already been through onboarding ("Log in") than on a fresh one ("Continue with Google"), and the fresh label
    // must win when both are on screen — the title-bar "Log in" does not open the browser.
    const targets = ${JSON.stringify(label)}.split('|').map((part) => part.trim().toLowerCase());
    const visibleControls = [...document.querySelectorAll('button, a, [role="button"]')].filter(visible);
    for (const target of targets) {
      const el = visibleControls.find((candidate) => (candidate.textContent || '').trim().toLowerCase().includes(target));
      if (el === undefined) continue;
      el.click();
      return { ok: true, target, clicked: (el.textContent || '').trim().slice(0, 40) };
    }
    return { ok: false, target: targets.join('|') };
  })()`;
}

/** Click a labelled button on the client's own page, waiting for it to appear (a dialog may still be rendering). */
async function cdpClickButton(
  port: number,
  label: string,
  waitFor = 20_000,
): Promise<{ ok: boolean; label: string; attempts: number }> {
  const deadline = Date.now() + waitFor;
  let attempts = 0;
  do {
    attempts += 1;
    for (const target of await cdpTargets(port)) {
      if (target.webSocketDebuggerUrl === undefined || !["page", "webview", "iframe"].includes(target.type)) continue;
      const result = (await cdpEvaluate(target.webSocketDebuggerUrl, buttonExpression(label))) as { ok?: boolean } | undefined;
      if (result?.ok === true) return { ok: true, label, attempts };
    }
    if (waitFor <= 0) break;
    await new Promise((r) => setTimeout(r, 500));
  } while (Date.now() < deadline);
  return { ok: false, label, attempts };
}

/** Open the agent's model picker and choose the first offered model; a turn cannot be sent while none is selected. */
async function cdpSelectModel(port: number): Promise<{ opened: boolean; chosen: string | null; attempts: number }> {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    for (const target of await cdpTargets(port)) {
      if (target.webSocketDebuggerUrl === undefined || !["page", "webview", "iframe"].includes(target.type)) continue;
      const socket = target.webSocketDebuggerUrl;
      const opened = (await cdpEvaluate(socket, modelPickerExpression())) as { ok?: boolean } | undefined;
      if (opened?.ok !== true) continue;
      await new Promise((r) => setTimeout(r, 1_000));
      const choice = (await cdpEvaluate(socket, modelChoiceExpression())) as { chosen?: string | null } | undefined;
      if (choice?.chosen != null) return { opened: true, chosen: choice.chosen, attempts: attempt };
      await cdpEvaluate(socket, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await new Promise((r) => setTimeout(r, 1_000));
      return { opened: true, chosen: null, attempts: attempt };
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return { opened: false, chosen: null, attempts: 12 };
}

/** Press the "Select model" control; a no-op when a model is already chosen. */
function modelPickerExpression(): string {
  return `(() => {
    ${CDP_VISIBLE}
    const el = [...document.querySelectorAll('[aria-label]')].filter(visible)
      .find((candidate) => /^Select model/i.test(candidate.getAttribute('aria-label') || ''));
    if (el === undefined) return { ok: false, reason: 'no model control' };
    const current = el.getAttribute('aria-label') || '';
    if (!/no model selected/i.test(current)) return { ok: false, reason: 'already selected', current };
    el.click();
    return { ok: true, current };
  })()`;
}

/** Choose a model from the open picker: the first offered entry, preferring a Gemini entry when the list names one. */
export function modelChoiceExpression(): string {
  return `(() => {
    ${CDP_VISIBLE}
    const items = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], [role="listbox"] > *')]
      .filter(visible)
      // The menubar's File/Edit/... are role="menuitem" too; measured, the first such item was "File".
      .filter((el) => el.closest('[role="menubar"]') === null)
      .map((el) => ({ el, text: (el.getAttribute('aria-label') || el.textContent || '').trim() }))
      .filter((item) => item.text.length > 0 && !/no models available/i.test(item.text));
    if (items.length === 0) return { chosen: null, reason: 'no models offered' };
    const pick = items.find((item) => /gemini/i.test(item.text)) ?? items[0];
    pick.el.click();
    return { chosen: pick.text.slice(0, 60) };
  })()`;
}

async function cdpTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP /json/list answered ${response.status}`);
  return (await response.json()) as CdpTarget[];
}

/** One CDP call over its own socket: commands are short, and a fresh socket cannot leak state between steps. */
async function cdpCommand(
  socketUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } } | undefined> {
  const socket = new WebSocket(socketUrl);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("CDP socket failed")), { once: true });
  });
  try {
    return await new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => rejectResult(new Error(`CDP ${method} timed out`)), 15_000);
      socket.addEventListener("message", (event) => {
        const data = JSON.parse(String(event.data)) as {
          id?: number;
          result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
          error?: { message?: string };
        };
        if (data.id !== 1) return;
        clearTimeout(timer);
        if (data.error !== undefined) {
          rejectResult(new Error(data.error.message ?? `CDP ${method} failed`));
          return;
        }
        resolveResult(data.result);
      });
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    socket.close();
  }
}

async function cdpEvaluate(socketUrl: string, expression: string): Promise<unknown> {
  const reply = await cdpCommand(socketUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (reply?.exceptionDetails !== undefined) {
    throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "CDP exception");
  }
  return reply?.result?.value;
}

/**
 * Probe every page target and submit the prompt in the one that actually carries the chat input.
 *
 * The prompt is typed through CDP's input path (`Input.insertText`) rather than by assigning `textContent`: the chat
 * input is a controlled React component, and measured on Antigravity 1.107.0 an `execCommand('insertText')` left the
 * box empty and the Send button disabled, so the run looked successful and sent nothing.
 */
async function cdpPrompt(
  port: number,
  prompt: string,
): Promise<{
  ok: boolean;
  driver: string;
  target?: string;
  probe?: unknown;
  focus?: unknown;
  typed?: unknown;
  submit?: unknown;
  send?: unknown;
  error?: string;
}> {
  try {
    const targets = await cdpTargets(port);
    const pages = targets.filter(
      (target) => target.webSocketDebuggerUrl !== undefined && ["page", "webview", "iframe"].includes(target.type),
    );
    const seen: { target: string; probe: unknown }[] = [];
    for (const target of pages) {
      const socket = target.webSocketDebuggerUrl!;
      const probe = (await cdpEvaluate(socket, probeExpression())) as { inputs?: unknown[] } | undefined;
      seen.push({ target: `${target.type}:${target.url}`, probe });
      if ((probe?.inputs?.length ?? 0) === 0) continue;
      const focus = (await cdpEvaluate(socket, focusExpression())) as { ok?: boolean } | undefined;
      if (focus?.ok !== true) continue;
      await cdpCommand(socket, "Input.insertText", { text: prompt });
      await new Promise((r) => setTimeout(r, 400));
      const typed = (await cdpEvaluate(socket, typedExpression())) as { length?: number; sendDisabled?: boolean | null } | undefined;
      if ((typed?.length ?? 0) === 0) {
        return { ok: false, driver: "cdp", target: target.url, probe, focus, typed, error: "the chat input stayed empty" };
      }
      const send = await cdpEvaluate(socket, sendExpression());
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, driver: "cdp", target: target.url, probe, focus, typed, send };
    }
    return { ok: false, driver: "cdp", probe: seen, error: "no page target had a visible text input" };
  } catch (error) {
    return { ok: false, driver: "cdp", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Base64 SHA-256 of the certificate's SubjectPublicKeyInfo, the value Chromium accepts in
 * `--ignore-certificate-errors-spki-list`. Chromium derives it from the DER SPKI, not from the PEM text.
 */
export function spkiPin(caBundle: string): string {
  const certificate = new X509Certificate(readFileSync(caBundle));
  const spki = certificate.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return createHash("sha256").update(spki).digest("base64");
}

/** Resolve the command, substituting the live proxy URL, the run CA's SPKI pin and the CDP port for their placeholders. */
function resolveCommand(
  client: ReconClient,
  command: readonly string[],
  proxyUrl: string,
  caBundle: string,
  cdpPort?: number,
): string[] {
  const pin = spkiPin(caBundle);
  const resolved = command.map((arg) => {
    if (arg === "http://127.0.0.1:0") return proxyUrl;
    if (arg === "--ignore-certificate-errors-spki-list=@CA_SPKI@") return `--ignore-certificate-errors-spki-list=${pin}`;
    if (arg === "--remote-debugging-port=@CDP_PORT@") return `--remote-debugging-port=${cdpPort ?? 0}`;
    return arg;
  });
  if (client.gui) {
    resolved.push(WORK_IN_SANDBOX);
  }
  // A client that keeps credentials in the OS keyring gets a private bus and keyring, started inside the sandbox. It
  // is a wrapper so every path (default command, workflow step, login) gets it, and `run.json` records it.
  return client.session === true ? [SESSION_BIN, ...resolved] : resolved;
}

/** The system trust bundle every Linux TLS stack falls back to when no environment variable points elsewhere. */
const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/**
 * Merge the run CA into a copy of the host system trust bundle.
 *
 * Not every TLS stack reads `SSL_CERT_FILE`: a Go binary does, a Rust binary usually does, but a library that calls
 * the platform verifier reads only this file. Binding the merged copy over the host path inside the sandbox means the
 * run CA is trusted by every one of them, without patching any client bundle.
 */
export function mergeSystemCaBundle(hostBundle: string, runCa: string, target: string): string | undefined {
  if (!existsSync(hostBundle) || !existsSync(runCa)) return undefined;
  const system = readFileSync(hostBundle, "utf8").trimEnd();
  const ca = readFileSync(runCa, "utf8").trimEnd();
  writeFileSync(target, `${system}\n${ca}\n`, { mode: 0o600 });
  return target;
}

/**
 * Extra bind-mounts every sandbox gets: the run CA, the browser-opener stub, the merged system trust bundle, and the
 * profile's own identity (machine id, hostname, passwd, group) over the host's. Without the last four a client can read
 * the operator's account name and machine id even though its home is empty.
 */
function isolationBinds(profile: Profile, caBundle: string, systemCa?: string): Bind[] {
  const identity = identityFiles(profile);
  return [
    { source: caBundle, target: CA_IN_SANDBOX },
    ...(systemCa === undefined ? [] : [{ source: systemCa, target: SYSTEM_CA_BUNDLE }]),
    { source: OPEN_STUB, target: `${OPEN_BIN_DIR_IN_SANDBOX}/xdg-open` },
    { source: SESSION_STUB, target: SESSION_BIN },
    { source: identity.machineId, target: "/etc/machine-id" },
    { source: identity.hostname, target: "/etc/hostname" },
    { source: identity.passwd, target: "/etc/passwd" },
    { source: identity.group, target: "/etc/group" },
  ];
}

/** Sandbox spec for one client run. */
export function buildSpec(
  client: ReconClient,
  profile: Profile,
  workdir: string,
  proxyUrl: string,
  caBundle: string,
  command: readonly string[],
  options: { readonly display?: string; readonly systemCa?: string; readonly cdpPort?: number },
): SandboxSpec {
  const env: Record<string, string> = { ...isolatedEnv(proxyUrl), ...client.env };
  if (client.session === true) env.RECON_KEYRING_PASSPHRASE = keyringPassphrase(profile);
  if (options.display !== undefined) env.DISPLAY = options.display;
  const readonlyBinds: Bind[] = [...client.readonlyBinds, ...isolationBinds(profile, caBundle, options.systemCa)];
  // Only this run's own display socket is mounted; the operator's X0/X1 sockets stay invisible, and `-ac` keeps the
  // private server from demanding an xauth cookie the sandbox does not have.
  const writableBinds: Bind[] =
    client.gui && options.display !== undefined
      ? [{ source: `${X11_SOCKET_DIR}/X${options.display.slice(1)}`, target: `${X11_SOCKET_DIR}/X${options.display.slice(1)}` }]
      : [];
  // /tmp is emptied first; the X11 socket directory is mounted afterwards, so it survives into the sandbox.
  const tmpfs = ["/tmp"];
  return {
    profileHome: profile.home,
    hostname: hostnameOf(profile),
    workdir,
    systemBinds: systemBinds(),
    readonlyBinds,
    writableBinds,
    tmpfs,
    env,
    command: resolveCommand(client, command, proxyUrl, caBundle, options.cdpPort),
  };
}

/** Outcome of a run, written to `run.json` next to the captures. */
export interface RunOutcome {
  readonly runDir: string;
  readonly client: string;
  readonly version: string;
  readonly exitCode: number;
  readonly changedGuards: readonly string[];
  readonly volatileGuards: readonly string[];
  readonly liveGuards: readonly string[];
  readonly probeOk: boolean;
  readonly timedOut: boolean;
  readonly captures: number;
  /** A supported workflow that recorded no flow: an outage or a UI that never loaded, not evidence. */
  readonly emptyWorkflow: boolean;
  readonly profileHome: string;
  readonly openUrls: readonly string[];
  readonly timelineSteps: number;
  readonly unmarkedFlows: number;
  /** Path of the profile's login record, written only for a login run. */
  readonly loginRecord?: string;
  /** A login run was given prompts and recorded no request matching the client's turn request. */
  readonly missingTurn: boolean;
  /** Why a login run did not complete; the run record and captures are still written. */
  readonly loginError?: string;
  /** The run was stopped by SIGINT or SIGTERM; cleanup ran and the record was written. */
  readonly stoppedBySignal?: string;
}

/** URLs a sandboxed client asked the browser to open (login links), read from the opener stub's log. */
function readOpenUrls(workdir: string): string[] {
  const file = join(workdir, "open-url.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * State a profile needs before any client process starts.
 *
 * opencode's managed service takes a port derived from its release channel (49374 on `latest`). The sandbox shares the
 * host network namespace, so the operator's own session normally holds exactly that port and a login dies with
 * EADDRINUSE before it can print a URL. A per-profile port in the profile's own `service.json` keeps the two apart
 * without touching the operator's file.
 *
 * Codex's login server binds a fixed 1455 and has no port option; detect the collision before spawning rather than
 * after a half-finished login.
 */
export async function prepareClientState(client: ReconClient, profile: Profile, mode: string): Promise<void> {
  if (client.id === "opencode") {
    const port = await freeLoopbackPort();
    mergeServicePort(join(profile.home, ".config", "opencode", "service.json"), port);
  }
  if (client.id === "codex" && mode === "login") {
    await assertLoopbackPortFree(1455);
  }
  if (client.id === "antigravity") {
    // The workspace-trust dialog covers the welcome screen on a fresh profile. Turning trust off in the profile's own
    // settings removes a modal that would otherwise have to be clicked blind before the sign-in button is reachable.
    mergeJsonSetting(
      join(profile.home, ".config", "Antigravity IDE", "User", "settings.json"),
      "security.workspace.trust.enabled",
      false,
    );
  }
}

/**
 * Whether a run satisfies its own evidence rule. Every mode except a supported workflow is exempt; a supported workflow
 * is evidence only if it recorded at least one flow.
 */
export function workflowRecordedEvidence(
  mode: "capture" | "login" | "workflow" | "verify",
  workflow: { readonly steps: readonly unknown[]; readonly expects?: string } | undefined,
  captures: number,
  urls: readonly string[] = [],
): boolean {
  if (mode !== "workflow") return true;
  if (workflow === undefined || workflow.steps.length === 0) return true;
  if (captures === 0) return false;
  if (workflow.expects === undefined) return true;
  const expected = new RegExp(workflow.expects);
  return urls.some((url) => expected.test(url));
}

/** Whether a run that sent prompts recorded at least one turn; a client that names no turn request is not checked. */
export function promptsRecorded(turnRequest: string | undefined, urls: readonly string[]): boolean {
  if (turnRequest === undefined) return true;
  const pattern = new RegExp(turnRequest);
  return urls.some((url) => pattern.test(url));
}

/** Request URLs of a run's captures, in sequence order. */
function capturedUrls(runDir: string): string[] {
  const dir = join(runDir, "captures");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith("-request.json"))
    .sort()
    .map((name) => {
      try {
        return String((JSON.parse(readFileSync(join(dir, name), "utf8")) as { url?: unknown }).url ?? "");
      } catch {
        return "";
      }
    });
}

/** Run a client under isolation, with capture, and verify the guard. */
export async function runClient(options: {
  clientId: string;
  mode: "capture" | "login" | "workflow" | "verify";
  args: readonly string[];
  /** Integration id for a client whose login flow accepts one; substituted into `loginCommand`. */
  loginTarget?: string;
  /** Called as soon as a GUI login asks the browser to open a URL, so the operator can act while the run waits. */
  onOpenUrl?: (url: string) => void;
  /**
   * One prompt typed into a GUI client after it reports signed in, in the same process, then captured.
   *
   * Antigravity has no cross-run credential store in the sandbox: its unified-state-sync topics never appear in
   * `state.vscdb` there (measured across sessions from 30 s to 5 min), so a signed-in session cannot be resumed. The
   * signed-in state is real while the client runs, so the first real turn is taken in the same run.
   */
  promptAfterLogin?: readonly string[];
  /**
   * Move the client's existing profile aside before the run, so the client starts as a first launch.
   *
   * Measured need on Antigravity 1.107.0: the sign-in entry point that calls the system browser is the onboarding
   * carousel's "Continue with Google". Once onboarding is completed the entry moves into Settings → Account, whose
   * "Sign In" does not reach the browser opener in this sandbox, so a resumed profile cannot be signed in again. The old
   * profile is renamed, never deleted, so nothing is lost.
   */
  freshProfile?: boolean;
  timeoutMs?: number;
  /** When present, the run executes these steps instead of one command and records a timeline. */
  workflow?: { readonly id: string; readonly steps: readonly WorkflowStep[]; readonly expects?: string };
}): Promise<RunOutcome> {
  const client = clientById(options.clientId);
  const profile = profileFor(client.id);
  if (options.freshProfile === true && existsSync(profile.home)) {
    // Renamed, not deleted: the previous profile is evidence of what was measured there and costs nothing to keep.
    const aside = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
    renameSync(profile.home, `${profile.home}.${aside}.bak`);
  }
  ensureProfile(profile, client.profileDirs);
  assertIsolatedProfile(profile);
  await prepareClientState(client, profile, options.mode);

  const version = detectVersion(client);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  // Two runs in the same second must never share a directory: the second would append its captures to the first run's
  // sequence and its timeline would mix two workflows.
  let runDir = join(reconRoot(), "runs", client.id, `${stamp}-${options.mode}`);
  for (let attempt = 2; existsSync(runDir); attempt += 1) {
    runDir = join(reconRoot(), "runs", client.id, `${stamp}-${options.mode}-${attempt}`);
  }
  const workdir = join(runDir, "work");
  mkdirSync(workdir, { recursive: true, mode: 0o700 });

  const guarded = guardedPaths(client);
  const first = snapshotPaths(guarded);
  await new Promise((r) => setTimeout(r, 300));
  const before = snapshotPaths(guarded);
  const volatile = changedPaths(first, before);

  const { child: mitm, port } = await startMitm(
    runDir,
    client,
    `${client.id}/${stamp}/${options.mode}`,
    version,
    upstreamDnsServers(process.env),
  );
  const proxyUrl = `http://127.0.0.1:${port}`;
  const caBundle = join(runDir, "mitm", "mitmproxy-ca-cert.pem");
  const systemCa = mergeSystemCaBundle(SYSTEM_CA_BUNDLE, caBundle, join(runDir, "mitm", "system-ca.pem"));

  let display: PrivateDisplay | undefined;
  if (client.gui) {
    display = await startDisplay();
  }
  // A GUI client's chat input is driven through CDP. The port is per run, so two runs never share one and the port
  // never collides with anything the operator holds.
  const cdpPort = client.gui ? await freeLoopbackPort() : undefined;

  const command =
    options.args.length > 0
      ? options.args
      : options.mode === "login"
        ? resolveLoginCommand(client, options.loginTarget)
        : options.mode === "verify"
          ? (client.authStatusCommand ?? client.defaultCommand)
          : client.defaultCommand;
  const spec = buildSpec(client, profile, workdir, proxyUrl, caBundle, command, {
    ...(display ? { display: display.name } : {}),
    ...(systemCa === undefined ? {} : { systemCa }),
    ...(cdpPort === undefined ? {} : { cdpPort }),
  });
  const argv = buildBwrapArgv(spec);
  // The operator's other displays must not be reachable from the sandbox; only this run's socket is mounted.
  const forbidden =
    display === undefined
      ? []
      : readdirSync(X11_SOCKET_DIR)
          .filter((name) => name !== `X${display.name.slice(1)}`)
          .map((name) => `FORBIDDEN:${X11_SOCKET_DIR}/${name}`);
  const probe = probeIsolation(spec, guarded, machineIdOf(profile), forbidden);
  if (!probe.ok) {
    if (display) await stopDisplay(display);
    await stopMitm(mitm);
    throw new Error(`isolation probe failed: ${probe.leaks.join("; ")}`);
  }

  // A login is interactive and has no default timeout; a capture run is always bounded.
  const timeoutMs = options.timeoutMs ?? (options.mode === "login" ? 0 : client.timeoutMs);
  const marker = (name: string, phase: "start" | "end" | "point", detail?: Record<string, unknown>): void => {
    appendFileSync(
      join(runDir, "steps.jsonl"),
      `${JSON.stringify({ atMs: Date.now(), name, phase, ...(detail === undefined ? {} : { detail }) })}\n`,
      { mode: 0o600 },
    );
  };
  marker("run-start", "point", { mode: options.mode, workflow: options.workflow?.id });

  let timedOut = false;
  let exitCode = 0;
  let gui: ChildProcess | undefined;
  let loginError: string | undefined;
  // A signal must reach the cleanup below: without this, stopping a run left its mitmdump and private X server running
  // (measured: four orphaned pairs on displays :90-:93). The first signal asks the waits to stop; the window is then
  // closed and the proxy stopped by the `finally`. A second signal exits at once.
  let stoppedBySignal: string | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stoppedBySignal !== undefined) process.exit(130);
    stoppedBySignal = signal;
    marker("stopped-by-signal", "point", { signal });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const stopped = (): boolean => stoppedBySignal !== undefined;
  // A step's argv goes through the same resolution as the default command, so the proxy URL and CA pin placeholders
  // mean the same thing in a workflow.
  const sandboxArgv = (args: readonly string[]): string[] =>
    buildBwrapArgv({ ...spec, command: resolveCommand(client, args, proxyUrl, caBundle, cdpPort) });
  // A second run on the same profile is not isolation, it is corruption: the second process finds the first one's
  // single-instance state and exits at once (measured: a 5-minute run recorded nothing because an earlier run's IDE
  // was still up), and both would write one home. The lock turns that into an error instead of an empty capture.
  const profileLock = acquireProfileLock(profile);
  try {
    if (options.workflow !== undefined) {      for (const step of options.workflow.steps) {
        const action = step.action;
        marker(step.name, "start", { kind: action.kind });
        let detail: Record<string, unknown> = {};
        if (action.kind === "exec") {
          const result = await spawnAndWait(sandboxArgv(action.argv), action.timeoutMs ?? timeoutMs, workdir);
          timedOut = timedOut || result.timedOut;
          exitCode = result.code;
          detail = { exitCode: result.code, timedOut: result.timedOut, ...(result.stop === undefined ? {} : { stop: result.stop }) };
        } else if (action.kind === "gui-launch") {
          if (display === undefined) throw new Error("gui-launch needs a private display");
          const guiArgv = sandboxArgv(action.argv);
          gui = spawn(guiArgv[0]!, guiArgv.slice(1), {
            stdio: "inherit",
            cwd: workdir,
            env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
          });
          detail = { pid: gui.pid ?? null };
        } else if (action.kind === "gui-dismiss") {
          if (cdpPort === undefined) throw new Error("gui-dismiss needs a client with a debugging port");
          detail = await cdpDismiss(cdpPort);
        } else if (action.kind === "gui-prompt") {
          if (display === undefined || gui === undefined) throw new Error("gui-prompt needs gui-launch first");
          const model = cdpPort === undefined ? undefined : await cdpSelectModel(cdpPort);
          const typed = await guiPrompt(display.name, action.prompt, action.waitMs ?? 20_000, cdpPort, client.windowName);
          exitCode = gui.exitCode ?? 0;
          detail = { ...typed, ...(model === undefined ? {} : { model }) };
        } else {
          await new Promise((r) => setTimeout(r, action.ms));
          detail = { waitedMs: action.ms };
        }
        // Give the proxy a moment to flush what the step caused before closing it. Without this, a stream the client
        // aborted on the way out is written after the step's end marker and lands in `unmarked` instead of the step.
        await new Promise((r) => setTimeout(r, 300));
        marker(step.name, "end", detail);
      }
    } else {
      if (
        options.mode === "login" &&
        client.gui &&
        (client.loginClicks !== undefined || client.loginButtons !== undefined)
      ) {
        if (display === undefined) throw new Error("a GUI login needs a private display");
        gui = spawn(argv[0]!, argv.slice(1), {
          stdio: "inherit",
          cwd: workdir,
          env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        });
        const login = await driveGuiLogin({
          stopped,
          display: display.name,
          windowName: client.windowName ?? "Antigravity",
          ...(client.loginClicks === undefined ? {} : { clicks: client.loginClicks }),
          ...(client.loginButtons === undefined ? {} : { buttons: client.loginButtons }),
          ...(cdpPort === undefined ? {} : { cdpPort }),
          workdir,
          runDir,
          ...(options.onOpenUrl === undefined ? {} : { onOpenUrl: options.onOpenUrl }),
          timeoutMs: options.timeoutMs ?? 600_000,
          signedIn: () =>
            client.loginSignals !== undefined && loginSignalsSignedIn(profile.home, client.loginSignals),
        });
        marker("login-clicks", "point", { buttons: login.buttonClicks });
        if (login.error !== undefined) {
          loginError = login.error;
          marker("login-failed", "point", { error: login.error });
        } else if (options.promptAfterLogin !== undefined) {
          // The signed-in client is already up: the same window that finished the login receives every prompt, in one
          // conversation, so one consent yields a first turn, a multi-turn history and a tool loop.
          for (const [index, prompt] of options.promptAfterLogin.entries()) {
            if (stopped()) break;
            const name = `signed-in-prompt-${index + 1}`;
            marker(name, "start", { prompt });
            const turn = await guiTurn(display.name, cdpPort, prompt, 45_000, client.windowName);
            marker(name, "end", turn);
          }
        }
        exitCode = loginError !== undefined ? 1 : (gui.exitCode ?? 0);
      } else {
        const result = await spawnAndWait(argv, timeoutMs, workdir);
        timedOut = result.timedOut;
        exitCode = result.code;
        if (result.stop !== undefined) marker("client-stop", "point", { signals: result.stop.signals, graceful: result.stop.graceful });
      }
    }
  } finally {
    if (gui !== undefined && gui.exitCode === null && gui.pid !== undefined) {
      // The client itself gets the SIGTERM, inside the sandbox: that runs its own shutdown, which is where Antigravity
      // writes its state-sync topics (the sign-in among them). A signal to the sandbox kills it without that.
      const child = gui;
      const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      const stop = await stopSandboxed(new ProcProcessControl(), { pid: gui.pid, exited }, CLIENT_STOP_GRACE_MS, 5_000);
      marker("client-stop", "point", { signals: stop.signals, graceful: stop.graceful });
    }
    if (display) await stopDisplay(display);
    await stopMitm(mitm);
    releaseProfileLock(profileLock);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  const after = snapshotPaths(guarded);
  // A path that is still changing after the client exited belongs to the operator's live session, not to this run.
  // Together with the pre-run window this separates "the sandbox leaked" from "the host was busy"; the in-sandbox
  // probe remains the authoritative proof.
  await new Promise((r) => setTimeout(r, 500));
  const later = snapshotPaths(guarded);
  const afterBusy = changedPaths(after, later);
  const differing = changedPaths(before, after);
  const volatileChanged = [...new Set([...volatile, ...afterBusy])].filter((path) => differing.includes(path));
  const attributed = attributeChanges(
    differing.filter((path) => !volatileChanged.includes(path)),
    Object.values(allClients()),
  );
  const changed = attributed.unexplained;
  const liveGuards = attributed.live;
  const captures = existsSync(join(runDir, "captures"))
    ? readdirSync(join(runDir, "captures")).filter((name) => name.endsWith("-request.json")).length
    : 0;
  // A workflow is evidence or it is nothing: a supported workflow that recorded no flow failed, whatever the client's
  // exit code said. That is how a dead host resolver (every flow `502`) or a UI that never loaded gets caught here
  // instead of being filed as a successful run.
  const urls = capturedUrls(runDir);
  const emptyWorkflow = !workflowRecordedEvidence(options.mode, options.workflow, captures, urls);
  // A login that was asked to send prompts is held to the same rule as a workflow: no turn request, no evidence.
  const missingTurn =
    options.mode === "login" &&
    (options.promptAfterLogin?.length ?? 0) > 0 &&
    loginError === undefined &&
    !promptsRecorded(client.turnRequest, urls);
  if (missingTurn && exitCode === 0) exitCode = 1;
  if (emptyWorkflow && exitCode === 0) exitCode = 1;
  const openUrls = readOpenUrls(workdir);
  // A login is recorded by the hash of the credential files it produced, never by their content: refresh tokens rotate
  // and a copied token would invalidate the profile it came from.
  const markers = loginMarkers(profile.home, client.authMarkers);
  const signedIn =
    client.signedIn !== undefined
      ? client.signedIn(profile.home)
      : client.loginSignals !== undefined
        ? loginSignalsSignedIn(profile.home, client.loginSignals)
        : client.authMarkers.length === 0
          ? null
          : markers.length > 0;
  const loginRecord =
    options.mode === "login"
      ? writeLoginRecord(profile.dir, {
          client: client.id,
          version,
          at: new Date().toISOString(),
          signedIn,
          markers,
          openUrls,
          exitCode,
        })
      : options.mode === "verify"
        ? refreshLoginRecord(profile.dir, { signedIn, markers })
        : undefined;

  writeFileSync(
    join(runDir, "run.json"),
    `${JSON.stringify(
      {
        schema: "recon-run/2",
        client: client.id,
        label: client.label,
        cell: client.cell,
        version,
        mode: options.mode,
        workflow: options.workflow?.id ?? null,
        steps:
          options.workflow?.steps.map((step) => ({ name: step.name, kind: step.action.kind })) ?? [],
        startedAt: stamp,
        timedOut,
        proxyUrl,
        display: display?.name,
        hostname: hostnameOf(profile),
        machineId: machineIdOf(profile),
        profileHome: profile.home,
        workdir,
        command: spec.command,
        bwrap: argv,
        guard: {
          paths: guarded,
          before: Object.fromEntries(Object.entries(before).map(([path, value]) => [path, value.hash])),
          after: Object.fromEntries(Object.entries(after).map(([path, value]) => [path, value.hash])),
          probe: { ok: probe.ok, leaks: probe.leaks },
          volatile,
          changed,
          volatileChanged,
          live: liveGuards,
        },
        openUrls,
        captures,
        emptyWorkflow,
        loginRecord: loginRecord ?? null,
        loginError: loginError ?? null,
        missingTurn,
        stoppedBySignal: stoppedBySignal ?? null,
      },
      null,
      2,
    )}\n`,
  );

  // The timeline joins the flat captures to the step markers on one wall clock. It is written for every run, so a
  // plain capture is still readable as a single unmarked workflow rather than a special case.
  const timeline = writeTimeline(runDir);

  return {
    runDir,
    client: client.id,
    version,
    exitCode,
    changedGuards: changed,
    volatileGuards: volatileChanged,
    liveGuards,
    probeOk: probe.ok,
    timedOut,
    captures,
    emptyWorkflow,
    profileHome: profile.home,
    openUrls,
    timelineSteps: timeline.steps.length,
    unmarkedFlows: timeline.unmarked.length,
    ...(loginRecord === undefined ? {} : { loginRecord }),
    ...(loginError === undefined ? {} : { loginError }),
    missingTurn,
    ...(stoppedBySignal === undefined ? {} : { stoppedBySignal }),
  };
}
