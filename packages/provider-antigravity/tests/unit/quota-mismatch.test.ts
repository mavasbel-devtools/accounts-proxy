import { describe, expect, test } from "bun:test";
import { QuotaExhaustedError, UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import { mismatchWarning, type QuotaAdvert } from "@accounts-proxy/provider-antigravity/domain/quota-mismatch.ts";

// uc-generate-mismatch-diagnosed: pure detector — 429 + advertised quota → warning; else undefined.
const model = "gemini-3.8-flash-medium";
const project = "aicode-consumers";
const resetTime = "2026-11-30T01:18:56Z";
const exhausted = new QuotaExhaustedError("antigravity", "RESOURCE_EXHAUSTED");

describe("uc-generate-mismatch-diagnosed mismatchWarning", () => {
  test("429 + advert 1.0 warns with model, project, percent and reset", () => {
    const warning = mismatchWarning(model, project, exhausted, { remainingFraction: 1, resetTime });
    expect(warning).toBeDefined();
    expect(warning!).toContain(model);
    expect(warning!).toContain(project);
    expect(warning!).toContain("100%");
    expect(warning!).toContain(resetTime);
    expect(warning!).toContain("No account was rotated (D4)");
  });

  test("429 + advert 0.9907188 warns with 99%", () => {
    const warning = mismatchWarning(model, project, exhausted, { remainingFraction: 0.9907188, resetTime });
    expect(warning).toBeDefined();
    expect(warning!).toContain("99%");
    expect(warning!).toContain("No account was rotated (D4)");
  });

  test.each([
    ["zero advert is real exhaustion", { remainingFraction: 0, resetTime } satisfies QuotaAdvert],
    ["missing advert is not a mismatch", undefined],
  ])("429 + %s → undefined", (_label, advert) => {
    expect(mismatchWarning(model, project, exhausted, advert)).toBeUndefined();
  });

  test("non-429 (UpstreamError 400) + advert 1.0 → undefined", () => {
    const upstream400 = new UpstreamError("antigravity", 400, "bad request");
    expect(mismatchWarning(model, project, upstream400, { remainingFraction: 1, resetTime })).toBeUndefined();
  });
});
