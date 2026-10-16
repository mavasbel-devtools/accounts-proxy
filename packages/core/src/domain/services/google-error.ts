// The Google API error envelope `{"error":{"code","message","status"}}`, as cloudcode-pa returns it (P0-LIVE
// finding L10: tests/fixtures/captures/p0-live/e3/t3-f3b-tool-choice-any.json, t4-f2-document.json). `status` is the
// google.rpc.Code name whose documented "HTTP Mapping" is the HTTP status (docs/reference/specs/google-rpc-code.proto);
// a status with no mapping there is UNKNOWN ("errors raised by APIs that do not return enough error information").
import { ProxyError, UpstreamError } from "@accounts-proxy/core/domain/errors.ts";

const RPC_STATUS: Readonly<Record<number, string>> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ABORTED",
  429: "RESOURCE_EXHAUSTED",
  499: "CANCELLED",
  500: "INTERNAL",
  501: "UNIMPLEMENTED",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

export function rpcStatusFor(httpStatus: number): string {
  return RPC_STATUS[httpStatus] ?? "UNKNOWN";
}

export type GoogleErrorEnvelope = { readonly error: { readonly code: number; readonly message: string; readonly status: string } & Record<string, unknown> };

function isGoogleError(value: unknown): value is GoogleErrorEnvelope {
  if (value === null || typeof value !== "object") return false;
  const error = (value as { error?: unknown }).error;
  return error !== null && typeof error === "object" && typeof (error as { code?: unknown }).code === "number" && typeof (error as { message?: unknown }).message === "string";
}

/** The envelope for a proxy error. An upstream error whose body already is a Google envelope is kept verbatim. */
export function googleErrorEnvelope(error: ProxyError): GoogleErrorEnvelope {
  if (error instanceof UpstreamError) {
    try {
      const parsed: unknown = JSON.parse(error.body);
      if (isGoogleError(parsed)) return parsed;
    } catch {
      // not JSON: wrapped below
    }
  }
  return { error: { code: error.httpStatus, message: error.message, status: rpcStatusFor(error.httpStatus) } };
}
