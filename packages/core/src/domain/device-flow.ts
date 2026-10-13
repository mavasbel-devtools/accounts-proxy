// Device-authorization login rules (RFC 8628; plan P4.6 amendment A).

/** RFC 8628 §3.5: a `slow_down` answer adds 5 seconds to the polling interval for this and every later request. */
export const SLOW_DOWN_STEP_MS = 5_000;

export type DeviceAuthorization = {
  readonly deviceCode: string;
  /** The code the user confirms on the provider's page. */
  readonly userCode: string;
  /** The page that approves this code (absolute URL). */
  readonly verificationUrl: string;
  readonly intervalMs: number;
  readonly expiresInMs: number;
};
