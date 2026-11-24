// The Antigravity namespace alias: the upstream tool namespace `tools.opencode.`
// travels as `tools.agy.` on the wire. Pure, no I/O.
//
// Hook points in this package (native-gemini.ts): the outbound inner request
// object is finalized in `innerRequest()` before send (forward aliases apply
// there); the inbound answer re-enters through `aggregateResponses()` for
// streamed responses (and `signedCalls()` for the signature cache), where the
// reverse aliases restore the client-facing names. The streamed reverse path
// below is chunk-safe: a token split across chunks is still renamed.

export type NamespaceAlias = { readonly from: string; readonly to: string };

export const NAMESPACE_ALIASES: readonly NamespaceAlias[] = [{ from: "tools.opencode.", to: "tools.agy." }];

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function replaceTokens(text: string, table: readonly NamespaceAlias[], direction: "forward" | "reverse"): string {
  let out = text;
  for (const row of table) {
    const search = direction === "forward" ? row.from : row.to;
    const replacement = direction === "forward" ? row.to : row.from;
    out = out.split(search).join(replacement);
  }
  return out;
}

/** Deep-maps every string leaf; keys and non-string leaves pass through untouched. */
function mapStrings(value: unknown, replace: (text: string) => string): unknown {
  if (typeof value === "string") return replace(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, replace));
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = mapStrings(entry, replace);
    return out;
  }
  return value;
}

function containsToken(value: unknown, token: string): boolean {
  if (typeof value === "string") return value.includes(token);
  if (Array.isArray(value)) return value.some((item) => containsToken(item, token));
  if (isObject(value)) return Object.values(value).some((entry) => containsToken(entry, token));
  return false;
}

/**
 * Deep-replaces every from-token with its to-token in all string leaves.
 * When the input already contains any to-token it is returned unchanged with
 * skipped=true (never double-alias an already-renamed payload).
 */
export function applyForwardAliases(
  value: unknown,
  table: readonly NamespaceAlias[] = NAMESPACE_ALIASES,
): { readonly value: unknown; readonly skipped: boolean } {
  if (table.some((row) => containsToken(value, row.to))) return { value, skipped: true };
  return { value: mapStrings(value, (text) => replaceTokens(text, table, "forward")), skipped: false };
}

/** Deep-replaces every to-token with its from-token in all string leaves. */
export function applyReverseAliases(value: unknown, table: readonly NamespaceAlias[] = NAMESPACE_ALIASES): unknown {
  return mapStrings(value, (text) => replaceTokens(text, table, "reverse"));
}

/** Longest `from` token: the reverse path holds back this many chars minus one. */
const maxFromLength = (table: readonly NamespaceAlias[]): number =>
  table.reduce((max, row) => Math.max(max, row.from.length), 1);

/** Length of the longest trailing slice of `text` that starts a token (a token cut by the emit boundary). */
function trailingPartial(text: string, tokens: readonly string[]): number {
  let longest = 0;
  for (const token of tokens) {
    const limit = Math.min(text.length, token.length - 1);
    for (let length = limit; length > longest; length -= 1) {
      if (token.startsWith(text.slice(text.length - length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

/**
 * Renames one streamed text chunk back to the client-facing namespace.
 * Holds back the last (maxFromLen-1) chars, plus any trailing partial-token
 * prefix, so a token split across chunks is still renamed on flush.
 */
export function reverseStreamChunk(
  buffer: string,
  chunk: string,
  table: readonly NamespaceAlias[] = NAMESPACE_ALIASES,
): { readonly emit: string; readonly buffer: string } {
  const hold = maxFromLength(table) - 1;
  const combined = buffer + chunk;
  if (combined.length <= hold) return { emit: "", buffer: combined };
  const cut = combined.length - hold;
  const safe = combined.slice(0, cut);
  const rest = combined.slice(cut);
  const backtrack = trailingPartial(
    safe,
    table.map((row) => row.to),
  );
  return {
    emit: replaceTokens(safe.slice(0, safe.length - backtrack), table, "reverse"),
    buffer: safe.slice(safe.length - backtrack) + rest,
  };
}

/** Renames and returns whatever `reverseStreamChunk` held back. */
export function flushReverseBuffer(buffer: string, table: readonly NamespaceAlias[] = NAMESPACE_ALIASES): string {
  return replaceTokens(buffer, table, "reverse");
}
