// The built single-file bundle (`bun build … --target bun`, what `verify` produces as dist/inference-router.js) runs
// on its own: help, then serve → GET /health → SIGTERM → exit 0. A bundle cannot carry per-source instrumentation, so
// this check adds no coverage; the source entry under the coverage preload is what the other e2e tests measure.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeTemporary, removeTemporary } from "@inference-router/test-support/temporary.ts";
import { ENTRY, makeHome, type Home } from "@inference-router/test-support/e2e/router-process.ts";

let out: string;
let home: Home;
let bundle: string;
beforeAll(async () => {
  out = makeTemporary("router-bundle");
  bundle = join(out, "inference-router.js");
  const build = Bun.spawn([process.execPath, "build", ENTRY, "--target", "bun", "--outfile", bundle], { stdout: "pipe", stderr: "pipe" });
  if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
  home = await makeHome("providers: {}\n");
});
afterAll(() => {
  removeTemporary(out);
  removeTemporary(home.dir);
});

const env = () => ({ ...process.env, INFERENCE_ROUTER_HOME: home.dir });

describe("built bundle", () => {
  test("help", async () => {
    const child = Bun.spawn([process.execPath, bundle, "help"], { env: env(), stdout: "pipe" });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toStartWith("usage: inference-router <command>");
  });

  test("serve answers /health and stops on SIGTERM", async () => {
    const child = Bun.spawn([process.execPath, bundle, "serve"], { env: env(), stdout: "pipe", stderr: "pipe" });
    let stdout = "";
    const reading = (async () => {
      for await (const chunk of child.stdout) stdout += new TextDecoder().decode(chunk);
    })();
    for (let i = 0; i < 500 && !stdout.includes("listening on"); i++) await Bun.sleep(10);
    expect(await (await fetch(`http://127.0.0.1:${home.port}/health`)).json()).toEqual({ status: "ok", providers: [] });
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    await reading;
    expect(stdout).toContain("stopped\n");
  });
});
