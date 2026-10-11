// The ports are abstract classes (DI tokens and the roots of every implementation tree). These tests pin that
// each one is abstract-extensible and that a conforming implementation type-checks against it.
import { describe, expect, test } from "bun:test";
import { AccountAdminPort, LoginPort } from "@inference-router/core/ports/inbound/accounts.ts";
import { ChatPort, CountTokensPort, ListModelsPort, PassthroughPort } from "@inference-router/core/ports/inbound/routing.ts";
import { CredentialStorePort } from "@inference-router/core/ports/outbound/credentials.ts";
import { CallbackServerPort, ManualCodePort, OAuthClientPort } from "@inference-router/core/ports/outbound/oauth.ts";
import { ProviderPort } from "@inference-router/core/ports/outbound/provider.ts";
import { BrowserLauncherPort, ClockPort, HashPort, LockPort, LoggerPort, RandomPort, TimerPort } from "@inference-router/core/ports/outbound/system.ts";
import { KeyValueStorePort } from "@inference-router/core/ports/outbound/state.ts";
import { UsageReporterPort } from "@inference-router/core/ports/outbound/usage.ts";
import { CallbackServerFactoryPort } from "@inference-router/core/ports/outbound/oauth.ts";
import { UsagePort } from "@inference-router/core/ports/inbound/accounts.ts";
import { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import { AccessPort } from "@inference-router/core/ports/inbound/access.ts";
import { DaemonStatusPort } from "@inference-router/core/ports/inbound/daemon.ts";
import { ErrorReporterPort } from "@inference-router/core/ports/inbound/diagnostics.ts";
import { DialectCodecPort } from "@inference-router/core/ports/inbound/dialect.ts";
import { HealthPort } from "@inference-router/core/ports/inbound/routing.ts";
import { ConfigSourcePort } from "@inference-router/core/ports/outbound/config.ts";
import { RouterTokenStorePort } from "@inference-router/core/ports/outbound/router-token.ts";

class FixedClock extends ClockPort {
  now(): number {
    return 42;
  }
}

describe("ports", () => {
  test("every port is a constructible abstract base for implementations", () => {
    const ports = [
      AccountAdminPort,
      LoginPort,
      ChatPort,
      CountTokensPort,
      ListModelsPort,
      PassthroughPort,
      CredentialStorePort,
      CallbackServerPort,
      ManualCodePort,
      OAuthClientPort,
      ProviderPort,
      BrowserLauncherPort,
      ClockPort,
      HashPort,
      LockPort,
      LoggerPort,
      RandomPort,
      HttpTransportPort,
      KeyValueStorePort,
      TimerPort,
      UsageReporterPort,
      CallbackServerFactoryPort,
      UsagePort,
      AccessPort,
      DialectCodecPort,
      DaemonStatusPort,
      ErrorReporterPort,
      HealthPort,
      ConfigSourcePort,
      RouterTokenStorePort,
    ];
    for (const Port of ports) {
      const Impl = class extends (Port as unknown as new () => object) {};
      expect(new Impl()).toBeInstanceOf(Port as unknown as new () => object);
    }
    expect(new FixedClock().now()).toBe(42);
  });
});
