// Port of opencode-claude-auth @ 6292741 src/domain/services/RequestTransformService.ts (git blob f0f2b9e6).
// Pure: every random or time-dependent value arrives in TransformContext. Deliberate differences from the source
// (each pinned by tests/component/parity.test.ts):
//   F3  sanitizeThinking passes an explicit numeric budget_tokens through unchanged — no Math.max(1024, …) clamp
//       and no Math.floor — as the source's own AGENTS.md §8 requires ("do not silently clamp user configuration").
//   F8  model lookups use own-property checks, so ids such as "toString" fall back instead of hitting Object.prototype.
//   F9  the client's thinking choice is honoured (user decision Q6, 2026-10-11): an absent `thinking` stays absent
//       (no captured default), and when the result is not thinking (absent or `disabled`) the captured
//       `context_management` clear-thinking edit is left out — with it the upstream answers 400 "clear_thinking_20251015
//       strategy requires thinking to be enabled or adaptive" (P0-LIVE L2; Q6 probe: without it → 200).
//   F4  the client's `anthropic-beta` is honoured within this model's captured beta set (mergeBetaHeader).
import { UnsupportedFeatureError } from "@accounts-proxy/core/domain/errors.ts";
import { type HeaderPairs, orderedHeaders } from "@accounts-proxy/core/domain/wire.ts";
import { CLAUDE_PROFILE } from "@accounts-proxy/provider-claude/domain/client-profile.ts";
import {
  ANTHROPIC_IDENTITY,
  ANTHROPIC_VERSION_HEADER,
  CLAUDE_CCH,
  CLAUDE_ENTRYPOINT,
  CLAUDE_VERSION,
  SDK_PACKAGE_VERSION,
} from "@accounts-proxy/provider-claude/domain/constants.ts";
import { envelopeFor, type CatalogModelEntry, type ThinkingSpec } from "@accounts-proxy/provider-claude/domain/model-envelope.ts";

export type WireBlock = { readonly type: string; readonly [key: string]: unknown };
export type WireMessage = {
  readonly role: string;
  readonly content?: string | readonly WireBlock[];
  readonly [key: string]: unknown;
};
export type WireSystemBlock = { readonly type: string; readonly text: string; readonly cache_control?: unknown };
export type WireRequestBody = {
  /** Always set: the provider writes the routed model id before transforming. */
  readonly model: string;
  readonly messages: readonly WireMessage[];
  readonly system?: readonly WireSystemBlock[] | string;
  readonly max_tokens?: number;
  readonly thinking?: unknown;
  readonly output_config?: unknown;
  readonly [key: string]: unknown;
};

export type WireThinking = { readonly type: string; readonly display?: string; readonly budget_tokens?: unknown };

export type TransformContext = {
  readonly accessToken: string;
  readonly accountUuid: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly previousMessageId: string | null;
  /** Fresh uuid for the billing block (the source draws it first). */
  readonly ccPromptId: string;
  /** Fresh uuid for x-client-request-id (the source draws it second). */
  readonly clientRequestId: string;
  readonly prevToolDurations?: string;
  readonly turnIndex?: number;
};

export type CatalogLookup = (modelId: string) => CatalogModelEntry | undefined;

export type UpstreamRequest = { readonly url: string; readonly headers: HeaderPairs; readonly body: string };

/** Never-prefill laws L1–L4 (source AGENTS.md §5). */
export function guardAndNormalize(messages: readonly WireMessage[]): WireMessage[] {
  const toolUseIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content as readonly WireBlock[]) if (b.type === "tool_use" && typeof b.id === "string") toolUseIds.add(b.id);
    }
  }
  const out: WireMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const normalized = normalizeTool(m, toolUseIds);
      if (normalized) out.push(normalized);
    } else {
      out.push(m);
    }
  }
  dropDanglingToolResults(out, toolUseIds);
  while (out.length > 0 && (out[out.length - 1]!.role === "assistant" || out[out.length - 1]!.role === "tool")) out.pop();
  if (out.length === 0) out.push({ role: "user", content: "" });
  return out;
}

type ToolResultLike = { tool_use_id?: string; toolCallId?: string; content?: unknown; result?: unknown; is_error?: unknown; isError?: unknown };

function normalizeTool(m: WireMessage, toolUseIds: ReadonlySet<string>): WireMessage | null {
  const blocks: readonly WireBlock[] = Array.isArray(m.content) ? (m.content as readonly WireBlock[]) : [];
  const toolResult = blocks.find((b) => b.type === "tool_result" || b.type === "tool-result") as ToolResultLike | undefined;
  let id = toolResult?.tool_use_id ?? toolResult?.toolCallId ?? "";
  let result: unknown = toolResult?.content ?? toolResult?.result;
  if (!toolResult && typeof m.content === "string") {
    const bare = m as { tool_use_id?: string; toolCallId?: string };
    id = bare.tool_use_id ?? bare.toolCallId ?? "";
    result = m.content;
  }
  if (id === "" || !toolUseIds.has(id) || result === undefined) return null;
  const isError = toolResult?.is_error ?? toolResult?.isError;
  return {
    ...m,
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: typeof result === "string" ? result : JSON.stringify(result),
        ...(isError !== undefined ? { is_error: isError } : {}),
      },
    ],
  };
}

function dropDanglingToolResults(messages: WireMessage[], toolUseIds: ReadonlySet<string>): void {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return;
  const blocks = last.content as readonly WireBlock[];
  const dangling = (b: WireBlock) => b.type === "tool_result" && typeof b.tool_use_id === "string" && !toolUseIds.has(b.tool_use_id);
  if (!blocks.some(dangling)) return;
  messages[messages.length - 1] = { ...last, content: blocks.filter((b) => !dangling(b)) };
}

/** `path` is one of the provider's native paths (absolute, no query), so `?beta=true` starts the query. */
export function apiUrl(path: string, apiBase: string): string {
  return `${apiBase}${path}?beta=true`;
}

/** `fallback` is the model envelope's thinking (every envelope has one). */
export function sanitizeThinking(thinking: unknown, fallback: ThinkingSpec): WireThinking {
  if (!thinking || typeof thinking !== "object") return { ...fallback };
  const t = thinking as Record<string, unknown>;
  const type = typeof t.type === "string" ? t.type : fallback.type;
  if (type === "adaptive") return { type: "adaptive", display: typeof t.display === "string" ? t.display : fallback.display };
  if (type === "enabled") {
    const raw = t.budget_tokens ?? t.budgetTokens ?? fallback.budget_tokens;
    return { type: "enabled", budget_tokens: typeof raw === "number" && Number.isFinite(raw) ? raw : 31999 };
  }
  if (type === "disabled") return { type: "disabled" };
  return { ...fallback };
}

export function sanitizeOutputConfig(outputConfig: unknown, fallback?: { readonly effort?: string }): { effort: string } | undefined {
  if (outputConfig && typeof outputConfig === "object") {
    const effort = (outputConfig as Record<string, unknown>).effort;
    if (typeof effort === "string" && effort.length > 0) return { effort };
  }
  return fallback?.effort ? { effort: fallback.effort } : undefined;
}

export function hasBillingBlock(system: WireRequestBody["system"]): boolean {
  if (!Array.isArray(system)) return false;
  return system.some(
    (b) =>
      typeof b === "object" &&
      b !== null &&
      typeof (b as { text?: unknown }).text === "string" &&
      (b as { text: string }).text.startsWith("x-anthropic-billing-header:"),
  );
}

function systemBlocks(system: WireRequestBody["system"], ccPromptId: string, turnIndex = 1): readonly WireSystemBlock[] {
  if (hasBillingBlock(system)) return system as readonly WireSystemBlock[];
  const billing = {
    type: "text",
    text: `x-anthropic-billing-header: cc_version=${CLAUDE_VERSION}; cc_entrypoint=${CLAUDE_ENTRYPOINT}; cch=${CLAUDE_CCH}; cc_prompt_id=${ccPromptId}; cc_turn_origin=sdk; cc_prompt_index=0; cc_turn_index=${turnIndex};`,
  };
  const identity = { type: "text", text: ANTHROPIC_IDENTITY };
  if (system === undefined) return [billing, identity];
  return [billing, identity, ...(typeof system === "string" ? [{ type: "text", text: system }] : system)];
}

/** The upstream path that counts tokens instead of answering (anthropic-count-tokens.md). */
export const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";

/**
 * Captured-claude body envelope around the guarded messages (host values win; captured defaults fill absence).
 * `counting` (difference F10, P6): count_tokens takes only the spec's body parameters, so the Messages-only fields the envelope
 * adds (`max_tokens`, `context_management`, `diagnostics`, `metadata`) are left out; the upstream answered 400
 * "Extra inputs are not permitted" to `max_tokens` and `diagnostics`, and 200 without them
 * (docs/reference/2026-10-18-18-39-p6-count-tokens-probe.md). The client's own fields still pass as sent.
 */
export function envelope(body: WireRequestBody, messages: readonly WireMessage[], ctx: TransformContext, lookup: CatalogLookup, counting: boolean): Record<string, unknown> {
  const env = envelopeFor(body.model, lookup(body.model));
  const outputConfig = sanitizeOutputConfig(body.output_config, env.outputConfig);
  const thinking = body.thinking === undefined ? undefined : sanitizeThinking(body.thinking, env.thinking);
  const thinkingOn = thinking !== undefined && thinking.type !== "disabled";
  const messagesOnly = !counting;
  return {
    ...body,
    messages,
    system: systemBlocks(body.system, ctx.ccPromptId, ctx.turnIndex),
    ...(messagesOnly && body.max_tokens === undefined ? { max_tokens: env.maxTokens } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(messagesOnly && thinkingOn ? { context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } } : {}),
    ...(outputConfig ? { output_config: outputConfig } : {}),
    ...(messagesOnly
      ? {
          diagnostics: { previous_message_id: ctx.previousMessageId },
          metadata: (body["metadata"] as Record<string, unknown> | undefined) ?? { user_id: JSON.stringify({ device_id: ctx.deviceId, account_uuid: ctx.accountUuid, session_id: ctx.sessionId }) },
        }
      : {}),
  };
}

export type BetaMerge = { readonly header: string; readonly dropped: readonly string[] };

const betaNames = (header: string): string[] =>
  header
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

/**
 * F4: the client's `anthropic-beta` (a comma list, anthropic-messages.md) merged with this model's captured beta set.
 * Only names in that captured set are proven against subscription traffic, so any other name is unsupported_feature
 * (with `lossy`: dropped and reported). Order: the client's known names first, then the remaining captured names.
 */
export function mergeBetaHeader(client: string | undefined, captured: string, lossy: boolean): BetaMerge {
  if (client === undefined) return { header: captured, dropped: [] };
  const known = betaNames(captured);
  const requested = [...new Set(betaNames(client))];
  const unknown = requested.filter((name) => !known.includes(name)).map((name) => `anthropic-beta:${name}`);
  if (unknown.length > 0 && !lossy) throw new UnsupportedFeatureError(unknown, "claude (only this model's captured anthropic-beta set is proven)");
  const kept = requested.filter((name) => known.includes(name));
  return { header: [...kept, ...known.filter((name) => !kept.includes(name))].join(","), dropped: unknown };
}

/** The captured beta set of a model (the request envelope's `anthropic-beta`). */
export function capturedBetaHeader(model: string, lookup: CatalogLookup): string {
  return envelopeFor(model, lookup(model)).betaHeader;
}

/** Captured-claude request header set; authorization carries the proxy's fresh OAuth token, `betaHeader` the merged
 * beta set (mergeBetaHeader over capturedBetaHeader). Header order and casing match Claude Code 2.1.304. */
export function upstreamHeaders(ctx: TransformContext, betaHeader: string): HeaderPairs {
  const pairs: (readonly [string, string])[] = [
    ["Accept", "application/json"],
    ["Authorization", `Bearer ${ctx.accessToken}`],
    ["Content-Type", "application/json"],
    ["User-Agent", `claude-cli/${CLAUDE_VERSION} (external, ${CLAUDE_ENTRYPOINT})`],
    ["X-Claude-Code-Session-Id", ctx.sessionId],
    ["X-Stainless-Arch", CLAUDE_PROFILE.arch],
    ["X-Stainless-Lang", "js"],
    ["X-Stainless-OS", CLAUDE_PROFILE.os],
    ["X-Stainless-Package-Version", SDK_PACKAGE_VERSION],
    ["X-Stainless-Retry-Count", "0"],
    ["X-Stainless-Runtime", "node"],
    ["X-Stainless-Runtime-Version", "v26.3.0"],
    ["X-Stainless-Timeout", "600"],
    ["anthropic-beta", betaHeader],
    ["anthropic-dangerous-direct-browser-access", "true"],
    ["anthropic-dispatch-id", "v2d"],
    ["anthropic-version", ANTHROPIC_VERSION_HEADER],
    ["x-app", "cli"],
    ["x-cc-atis", "711efd76d10f17e5"],
  ];
  if (ctx.prevToolDurations) {
    pairs.push(["x-claude-code-prev-tool-durations", ctx.prevToolDurations]);
  }
  pairs.push(
    ["x-claude-code-prompt-id", ctx.ccPromptId],
    ["x-claude-code-request-class", "main"],
    ["x-client-request-id", ctx.clientRequestId],
  );
  return orderedHeaders(pairs);
}

export function transformRequest(
  input: { readonly body: WireRequestBody; readonly path: string; readonly betaHeader: string },
  ctx: TransformContext,
  lookup: CatalogLookup,
  apiBase: string,
): UpstreamRequest {
  const messages = guardAndNormalize(input.body.messages);
  return {
    headers: upstreamHeaders(ctx, input.betaHeader),
    url: apiUrl(input.path, apiBase),
    body: JSON.stringify(envelope(input.body, messages, ctx, lookup, input.path === COUNT_TOKENS_PATH)),
  };
}
