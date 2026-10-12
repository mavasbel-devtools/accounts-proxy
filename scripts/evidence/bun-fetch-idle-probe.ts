// Probe: when does Bun's per-request fetch idle timeout (`timeout`, bun-types globals.d.ts) fire? One local server
// answers after <delay> ms (silent before the headers); another sends a first chunk and then nothing (silent mid-body).
// Usage: bun scripts/evidence/bun-fetch-idle-probe.ts <delay-ms> <idle-ms>
// Measured 2026-10-11 on Bun 1.4.2: `12000 500` and `12000 3000` both time out after ~8 s, in both cases.
export {};

const delay = Number(process.argv[2]);
const idle = Number(process.argv[3]);

const late = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch() {
    await Bun.sleep(delay);
    return new Response("late");
  },
});
let started = performance.now();
try {
  const res = await fetch(`http://127.0.0.1:${late.port}/`, { timeout: idle });
  console.log(`before headers: HTTP ${res.status} after ${Math.round(performance.now() - started)} ms`);
} catch (error) {
  console.log(`before headers: ${(error as Error).name} after ${Math.round(performance.now() - started)} ms`);
}
late.stop(true);

const quiet = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch: () => new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("first")) })),
});
started = performance.now();
try {
  const res = await fetch(`http://127.0.0.1:${quiet.port}/`, { timeout: idle });
  for await (const _ of res.body!) void _;
  console.log(`mid-body: ended after ${Math.round(performance.now() - started)} ms`);
} catch (error) {
  console.log(`mid-body: ${(error as Error).name} after ${Math.round(performance.now() - started)} ms`);
}
quiet.stop(true);
