import { describe, expect, test } from "bun:test";
import {
  BETA_OPUS_5_5,
  CLAUDE_MESSAGE_HEADER_NAMES,
  CLAUDE_PROFILE,
} from "@accounts-proxy/provider-claude/domain/client-profile.ts";

describe("Claude 2.1.304 client profile (recon parity)", () => {
  test("profile constants match official 2.1.304 release", () => {
    expect(CLAUDE_PROFILE.version).toBe("2.1.304");
    expect(CLAUDE_PROFILE.entrypoint).toBe("sdk-cli");
    expect(CLAUDE_PROFILE.sdkPackageVersion).toBe("0.128.0");
    expect(CLAUDE_PROFILE.anthropicVersion).toBe("2023-06-01");
    expect(CLAUDE_PROFILE.dispatchId).toBe("v2d");
    expect(CLAUDE_PROFILE.atis).toBe("711efd76d10f17e5");
    expect(CLAUDE_PROFILE.requestClass).toBe("main");
    expect(CLAUDE_PROFILE.cch).toBe("a3181");
    expect(CLAUDE_PROFILE.userAgent).toBe("claude-cli/2.1.304 (external, sdk-cli)");
  });

  test("message headers preserve exact casing and canonical order", () => {
    expect(CLAUDE_MESSAGE_HEADER_NAMES).toEqual([
      "Accept",
      "Authorization",
      "Content-Type",
      "User-Agent",
      "X-Claude-Code-Session-Id",
      "X-Stainless-Arch",
      "X-Stainless-Lang",
      "X-Stainless-OS",
      "X-Stainless-Package-Version",
      "X-Stainless-Retry-Count",
      "X-Stainless-Runtime",
      "X-Stainless-Runtime-Version",
      "X-Stainless-Timeout",
      "anthropic-beta",
      "anthropic-dangerous-direct-browser-access",
      "anthropic-dispatch-id",
      "anthropic-version",
      "x-app",
      "x-cc-atis",
      "x-claude-code-prompt-id",
      "x-claude-code-request-class",
      "x-client-request-id",
    ]);
  });

  test("beta list contains exactly 17 verified betas", () => {
    const list = BETA_OPUS_5_5.split(",");
    expect(list.length).toBe(17);
    expect(list).toContain("per-turn-control-2026-07-01");
    expect(list).toContain("mid-conversation-tool-changes-2026-07-01");
    expect(list).toContain("inline-tools-2026-09-15");
    expect(list).toContain("mid-conversation-system-clear-at-2026-08-21");
    expect(list).toContain("effort-2025-11-24");
    expect(list).toContain("thinking-binding-controls-2026-08-01");
    expect(list).toContain("message-threads-2026-08-12");
  });

  test("client profile specifies Linux x64 platform values", () => {
    expect(CLAUDE_PROFILE.os).toBe("Linux");
    expect(CLAUDE_PROFILE.arch).toBe("x64");
  });
});
