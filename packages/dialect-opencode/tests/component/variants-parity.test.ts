// Parity of the ported variant rules (opencode-variants.ts) with opencode v2.0.26's own `Variant.resolve`
// (tests/reference/plugin-9b4ec5714d/core/src/variant.ts, byte-identical), over every model of the reference catalog
// and every connection package the proxy writes. The reference's two imports are replaced by the members variant.ts
// reads: `Model.VariantID.make` (a branded identity) and `Provider.aisdk` (provider.ts:24-26).
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseReference, type ReasoningOption } from "@accounts-proxy/core/domain/model-details.ts";
import { ANTHROPIC_PACKAGE, GOOGLE_PACKAGE, OPENAI_COMPATIBLE_PACKAGE, OPENAI_PACKAGE, OPENROUTER_PACKAGE, resolveVariants } from "@accounts-proxy/dialect-opencode/adapters/inbound/opencode-variants.ts";

const reference = join(import.meta.dir, "..", "reference", "plugin-9b4ec5714d", "core", "src");
mock.module(join(reference, "model.ts"), () => ({ Model: { VariantID: { make: (id: string) => id } } }));
mock.module(join(reference, "provider.ts"), () => ({ Provider: { aisdk: (value: string) => (value.startsWith("aisdk:") ? value : `aisdk:${value}`) } }));
// Reference module loaded untyped on purpose: its source is excluded from this repository's typecheck.
const { resolve } = (await import(join(reference, "variant.ts"))) as { resolve: (model: unknown, supports?: readonly unknown[]) => unknown };

const catalog = parseReference(JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "reference", "specs", "models-opencode-reference.json"), "utf8")));
const PACKAGES = [ANTHROPIC_PACKAGE, OPENAI_PACKAGE, OPENAI_COMPATIBLE_PACKAGE, GOOGLE_PACKAGE, OPENROUTER_PACKAGE] as const;
const EXTRA: readonly (readonly ReasoningOption[])[] = [[], [{ type: "toggle" }], [{ type: "budget_tokens", min: 1024 }], [{ type: "budget_tokens" }], [{ type: "toggle" }, { type: "budget_tokens", min: 0, max: 262_144 }], [{ type: "effort", values: ["none", "low"] }, { type: "toggle" }]];

describe("variant rules parity (opencode v2.0.26 core/src/variant.ts)", () => {
  test("every reference model × every package × its own reasoning options and the edge option sets", () => {
    let cases = 0;
    for (const [, models] of catalog) {
      for (const [id, m] of models) {
        for (const pkg of PACKAGES) {
          for (const outputLimit of [m.maxOutputTokens ?? 32_000, 1_000]) {
            for (const supports of [m.reasoningOptions ?? [], ...EXTRA]) {
              const ours = resolveVariants({ modelID: id, package: pkg, outputLimit }, supports);
              const theirs = resolve({ id, modelID: id, providerID: "test", package: pkg, limit: { context: 1, output: outputLimit } }, supports);
              expect(ours).toEqual(theirs as typeof ours);
              cases += 1;
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(30_000);
  });

  test("Opus 4.5 below the 1024-token minimum has none", () => {
    for (const outputLimit of [1_000, 32_000]) {
      const supports: ReasoningOption[] = [{ type: "effort", values: ["low"] }, { type: "toggle" }];
      expect(resolveVariants({ modelID: "claude-opus-4-5", package: ANTHROPIC_PACKAGE, outputLimit }, supports)).toEqual(resolve({ id: "x", modelID: "claude-opus-4-5", package: ANTHROPIC_PACKAGE, limit: { output: outputLimit } }, supports) as never);
    }
  });
});
