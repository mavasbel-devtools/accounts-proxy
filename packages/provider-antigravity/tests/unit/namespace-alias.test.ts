// Namespace alias unit tests: forward/reverse over inner-request-shaped
// fixtures, the forward skip flag, chunk-split streaming, table-drivenness.
import { describe, expect, test } from "bun:test";
import {
  applyForwardAliases,
  applyReverseAliases,
  flushReverseBuffer,
  NAMESPACE_ALIASES,
  reverseStreamChunk,
} from "@accounts-proxy/provider-antigravity/domain/namespace-alias.ts";

const fixture = {
  contents: [
    { role: "user", parts: [{ text: "Call tools.opencode.read to open it" }] },
    { role: "model", parts: [{ functionCall: { name: "tools.opencode.read", args: { path: "tools.opencode.config" } } }] },
    { role: "model", parts: [{ functionResponse: { name: "tools.opencode.read", output: "done tools.opencode.read" } }] },
  ],
  systemInstruction: { role: "user", parts: [{ text: "System tools.opencode.prompt" }] },
  tools: [{ functionDeclarations: [{ name: "tools.opencode.read", description: "Reads via tools.opencode.backend" }] }],
  generationConfig: { maxOutputTokens: 1024, thinking: true, missing: null },
  "tools.opencode.key": "key names stay",
};

const forwardedFixture = {
  contents: [
    { role: "user", parts: [{ text: "Call tools.agy.read to open it" }] },
    { role: "model", parts: [{ functionCall: { name: "tools.agy.read", args: { path: "tools.agy.config" } } }] },
    { role: "model", parts: [{ functionResponse: { name: "tools.agy.read", output: "done tools.agy.read" } }] },
  ],
  systemInstruction: { role: "user", parts: [{ text: "System tools.agy.prompt" }] },
  tools: [{ functionDeclarations: [{ name: "tools.agy.read", description: "Reads via tools.agy.backend" }] }],
  generationConfig: { maxOutputTokens: 1024, thinking: true, missing: null },
  "tools.opencode.key": "key names stay",
};

describe("namespace-alias", () => {
  test("forward renames every string leaf and round-trips through reverse", () => {
    const forward = applyForwardAliases(fixture);
    expect(forward.skipped).toBe(false);
    expect(forward.value).toEqual(forwardedFixture);
    expect(applyReverseAliases(forward.value)).toEqual(fixture);
  });

  test("forward leaves keys and non-string leaves alone", () => {
    const forward = applyForwardAliases({ "tools.opencode.key": 42, flag: true, missing: null });
    expect(forward).toEqual({ value: { "tools.opencode.key": 42, flag: true, missing: null }, skipped: false });
  });

  test("forward skips and flags when a to-token is already present", () => {
    const input = { contents: [{ role: "user", parts: [{ text: "already tools.agy.read here" }] }] };
    const forward = applyForwardAliases(input);
    expect(forward.skipped).toBe(true);
    expect(forward.value).toBe(input);
  });

  test("reverse passes non-string leaves through", () => {
    expect(applyReverseAliases(42)).toBe(42);
    expect(applyReverseAliases(null)).toBe(null);
  });

  test("reverse renames a token split across 3 chunks", () => {
    let buffer = "";
    let out = "";
    for (const chunk of ["call tools.a", "gy.r", "ead now"]) {
      const step = reverseStreamChunk(buffer, chunk);
      out += step.emit;
      buffer = step.buffer;
    }
    out += flushReverseBuffer(buffer);
    expect(out).toBe("call tools.opencode.read now");
  });

  test("reverse emits complete tokens while holding a partial tail", () => {
    const first = reverseStreamChunk("", "hi tools.agy.read end!");
    const out = first.emit + flushReverseBuffer(first.buffer);
    expect(out).toBe("hi tools.opencode.read end!");
    expect(first.emit).toBe("hi ");
  });

  test("flush renames the held remainder", () => {
    expect(flushReverseBuffer("tools.agy.x")).toBe("tools.opencode.x");
    expect(flushReverseBuffer("")).toBe("");
  });

  test("a second table row proves the table drives the rename", () => {
    const twoRows = [...NAMESPACE_ALIASES, { from: "tools.extra.", to: "tools.x." }];
    const input = "a tools.extra.z and tools.opencode.read";
    const forward = applyForwardAliases(input, twoRows);
    expect(forward).toEqual({ value: "a tools.x.z and tools.agy.read", skipped: false });
    expect(applyReverseAliases(forward.value, twoRows)).toBe(input);
    expect(applyForwardAliases("has tools.x.z", twoRows).skipped).toBe(true);
  });
});
