// RouterError tree. Every failure the router reports to a client is one of these; each dialect codec renders
// the (httpStatus, code, message) triple in its own error envelope.
//
//   RouterError
//   ├── ClientRequestError        — the caller's request cannot be served as sent
//   │   ├── InvalidRequestError       400 invalid_request
//   │   ├── UnsupportedFeatureError   400 unsupported_feature
//   │   ├── UnauthorizedError         401 unauthorized
//   │   ├── UnknownModelError         404 unknown_model
//   │   └── UnknownAccountError       404 unknown_account
//   └── ProviderError             — the provider side cannot serve it
//       ├── ProviderAuthRequiredError 401 provider_auth_required
//       ├── ProviderDisabledError     503 provider_disabled
//       ├── QuotaExhaustedError       429 quota_exhausted
//       └── UpstreamError             <upstream status> upstream_error
import type { ProviderId } from "./models.ts";

export type RouterErrorCode =
  | "invalid_request"
  | "unsupported_feature"
  | "unauthorized"
  | "unknown_model"
  | "unknown_account"
  | "provider_auth_required"
  | "provider_disabled"
  | "quota_exhausted"
  | "upstream_error";

export abstract class RouterError extends Error {
  abstract readonly code: RouterErrorCode;
  abstract readonly httpStatus: number;
  /** Seconds the client should wait before retrying, when known. */
  readonly retryAfterSeconds: number | undefined = undefined;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export abstract class ClientRequestError extends RouterError {}
export abstract class ProviderError extends RouterError {}

export class InvalidRequestError extends ClientRequestError {
  readonly code = "invalid_request";
  readonly httpStatus = 400;
  constructor(message: string) {
    super(message);
  }
}

export class UnsupportedFeatureError extends ClientRequestError {
  readonly code = "unsupported_feature";
  readonly httpStatus = 400;
  constructor(
    readonly features: readonly string[],
    readonly target: string,
  ) {
    super(`${target} cannot carry: ${features.join(", ")}`);
  }
}

export class UnauthorizedError extends ClientRequestError {
  readonly code = "unauthorized";
  readonly httpStatus = 401;
  constructor() {
    super("missing or invalid inference-router token");
  }
}

export class UnknownModelError extends ClientRequestError {
  readonly code = "unknown_model";
  readonly httpStatus = 404;
  constructor(readonly model: string) {
    super(`unknown model ${JSON.stringify(model)}: use <provider>/<model> or a configured alias`);
  }
}

export class UnknownAccountError extends ClientRequestError {
  readonly code = "unknown_account";
  readonly httpStatus = 404;
  constructor(
    readonly provider: ProviderId,
    readonly accountId: string,
  ) {
    super(`no ${provider} account ${JSON.stringify(accountId)}`);
  }
}

export class ProviderAuthRequiredError extends ProviderError {
  readonly code = "provider_auth_required";
  readonly httpStatus = 401;
  constructor(
    readonly provider: ProviderId,
    detail: string,
  ) {
    super(`${provider}: ${detail}; run \`inference-router login ${provider}\``);
  }
}

export class ProviderDisabledError extends ProviderError {
  readonly code = "provider_disabled";
  readonly httpStatus = 503;
  constructor(readonly provider: ProviderId) {
    super(`${provider} is disabled; enable it with acknowledgeTermsRisk: true in router.yaml`);
  }
}

export class QuotaExhaustedError extends ProviderError {
  readonly code = "quota_exhausted";
  readonly httpStatus = 429;
  override readonly retryAfterSeconds: number | undefined;
  constructor(
    readonly provider: ProviderId,
    detail: string,
    retryAfterSeconds?: number,
  ) {
    super(`${provider} quota exhausted: ${detail}`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class UpstreamError extends ProviderError {
  readonly code = "upstream_error";
  override readonly retryAfterSeconds: number | undefined;
  constructor(
    readonly provider: ProviderId,
    readonly httpStatus: number,
    readonly body: string,
    retryAfterSeconds?: number,
  ) {
    super(`${provider} upstream HTTP ${httpStatus}: ${body.slice(0, 500)}`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
