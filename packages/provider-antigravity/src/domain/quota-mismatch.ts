// Warns when upstream enforces 429 while its own advertise says quota remains
// (incident 2026-11-23: gemini-3.8-flash-medium 429 ×11 on aicode-consumers while
// retrieveUserQuotaSummary and fetchAvailableModels both reported 100%).
// Pure: no I/O, no new port. D4 intact — this names the mismatch, never rotates.
import { QuotaExhaustedError } from "@accounts-proxy/core/domain/errors.ts";

export type QuotaAdvert = { readonly remainingFraction: number; readonly resetTime: string };

/**
 * Returns the operator-facing warning when `error` is a quota exhaustion for
 * `model` on `project` while `advert` still shows remaining quota; otherwise undefined.
 * A missing or zero advert is not a mismatch: real exhaustion also 429s.
 */
export function mismatchWarning(
  model: string,
  project: string,
  error: unknown,
  advert: QuotaAdvert | undefined,
): string | undefined {
  if (!(error instanceof QuotaExhaustedError)) return undefined;
  if (advert === undefined || !(advert.remainingFraction > 0)) return undefined;
  const percent = Math.round(advert.remainingFraction * 100);
  return (
    `antigravity: upstream reports 429 quota exhausted for ${model} on project ${project} ` +
    `while the advertised quota is ${percent}% (resets ${advert.resetTime}); ` +
    `the 429 is enforced upstream — retry after ${advert.resetTime}, use a model whose group holds quota, ` +
    `or re-resolve the project (manual re-login). No account was rotated (D4).`
  );
}
