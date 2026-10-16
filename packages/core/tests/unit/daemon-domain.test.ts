// Core additions for the daemon (P4): errors, the Google error envelope, constant-time comparison.
import { describe, expect, test } from "bun:test";
import {
  InternalError,
  InvalidRequestError,
  PayloadTooLargeError,
  QuotaExhaustedError,
  RouteNotFoundError,
  UpstreamError,
  UpstreamTimeoutError,
} from "@accounts-proxy/core/domain/errors.ts";
import { constantTimeEqual } from "@accounts-proxy/core/domain/services/constant-time.ts";
import { googleErrorEnvelope, rpcStatusFor } from "@accounts-proxy/core/domain/services/google-error.ts";

describe("daemon errors", () => {
  test("codes, statuses and messages", () => {
    const cases = [
      [new RouteNotFoundError("GET", "/x"), "not_found", 404, "no route GET /x"],
      [new PayloadTooLargeError(32_000_000), "payload_too_large", 413, "request body exceeds 32000000 bytes"],
      [new UpstreamTimeoutError("api.anthropic.com", 600_000), "upstream_timeout", 504, "upstream api.anthropic.com sent nothing for 600000 ms"],
      [new InternalError(), "internal_error", 500, "internal proxy error (details are in the proxy log)"],
    ] as const;
    for (const [error, code, status, message] of cases) {
      expect([error.code, error.httpStatus, error.message, error.name]).toEqual([code, status, message, error.constructor.name]);
    }
  });
});

describe("Google error envelope", () => {
  test.each([
    [400, "INVALID_ARGUMENT"],
    [401, "UNAUTHENTICATED"],
    [403, "PERMISSION_DENIED"],
    [404, "NOT_FOUND"],
    [409, "ABORTED"],
    [429, "RESOURCE_EXHAUSTED"],
    [499, "CANCELLED"],
    [500, "INTERNAL"],
    [501, "UNIMPLEMENTED"],
    [503, "UNAVAILABLE"],
    [504, "DEADLINE_EXCEEDED"],
    [413, "UNKNOWN"],
    [502, "UNKNOWN"],
  ])("HTTP %p → %p (google.rpc.Code HTTP Mapping)", (status, name) => {
    expect(rpcStatusFor(status)).toBe(name);
  });

  test("proxy errors are wrapped; an upstream Google body is kept verbatim; other upstream bodies are wrapped", () => {
    expect(googleErrorEnvelope(new InvalidRequestError("bad"))).toEqual({ error: { code: 400, message: "bad", status: "INVALID_ARGUMENT" } });
    const captured = { error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT", details: [] } };
    expect(googleErrorEnvelope(new UpstreamError("antigravity", 400, JSON.stringify(captured)))).toEqual(captured);
    for (const body of ["not json", "[1]", "null", '{"error":"x"}', '{"error":{"code":"400","message":"m"}}', '{"error":{"code":400}}']) {
      expect(googleErrorEnvelope(new UpstreamError("antigravity", 502, body)).error.status).toBe("UNKNOWN");
    }
    expect(googleErrorEnvelope(new QuotaExhaustedError("antigravity", "x")).error.code).toBe(429);
  });
});

describe("constantTimeEqual", () => {
  test("equal, different, different length", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  });
});
