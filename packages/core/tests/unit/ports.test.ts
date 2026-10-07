// The ports are abstract classes (DI tokens and the roots of every implementation tree). These tests pin that
// each one is abstract-extensible and that a conforming implementation type-checks against it.
import { describe, expect, test } from "bun:test";
import { AccountAdminPort, LoginPort } from "../../src/ports/inbound/accounts.ts";
import { ChatPort, CountTokensPort, ListModelsPort, PassthroughPort } from "../../src/ports/inbound/routing.ts";
import { CredentialStorePort } from "../../src/ports/outbound/credentials.ts";
import { CallbackServerPort, ManualCodePort, OAuthClientPort } from "../../src/ports/outbound/oauth.ts";
import { ProviderPort } from "../../src/ports/outbound/provider.ts";
import { BrowserLauncherPort, ClockPort, HashPort, LockPort, LoggerPort, RandomPort, TimerPort } from "../../src/ports/outbound/system.ts";
import { KeyValueStorePort } from "../../src/ports/outbound/state.ts";
import { UsageReporterPort } from "../../src/ports/outbound/usage.ts";
import { CallbackServerFactoryPort } from "../../src/ports/outbound/oauth.ts";
import { UsagePort } from "../../src/ports/inbound/accounts.ts";
import { HttpTransportPort } from "../../src/ports/outbound/transport.ts";

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
    ];
    for (const Port of ports) {
      const Impl = class extends (Port as unknown as new () => object) {};
      expect(new Impl()).toBeInstanceOf(Port as unknown as new () => object);
    }
    expect(new FixedClock().now()).toBe(42);
  });
});
