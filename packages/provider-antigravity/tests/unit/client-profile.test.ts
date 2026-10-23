import { describe, expect, test } from "bun:test";
import { ANTIGRAVITY_PROFILE } from "@accounts-proxy/provider-antigravity/domain/client-profile.ts";

describe("Antigravity 1.107.0 client profile (recon parity)", () => {
  test("profile constants match official 1.107.0 release on Linux", () => {
    expect(ANTIGRAVITY_PROFILE.version).toBe("2.5.5");
    expect(ANTIGRAVITY_PROFILE.ideType).toBe("ANTIGRAVITY");
    expect(ANTIGRAVITY_PROFILE.ideVersion).toBe("2.5.5");
    expect(ANTIGRAVITY_PROFILE.ideName).toBe("antigravity");
    expect(ANTIGRAVITY_PROFILE.osType).toBe("linux");
    expect(ANTIGRAVITY_PROFILE.arch).toBe("amd64");
    expect(ANTIGRAVITY_PROFILE.userAgent).toBe("antigravity/ide/2.5.5 (aidev_client; os_type=linux; arch=amd64)");
  });
});
