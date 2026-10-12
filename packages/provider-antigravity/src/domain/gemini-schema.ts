// Gemini wire rules shared by the near-native Gemini cell (native-gemini.ts) and the OpenAI-shaped chat codec
// (generate.ts). Port of opencode-antigravity-auth @ 5c6f7c2 RequestTransformService.ts: wire law 5 (tool schemas
// keep only the whitelisted keys, types upper-cased) and the Gemini-family test that gates wire law 6.

export const SCHEMA_KEYS: ReadonlySet<string> = new Set(["type", "format", "description", "nullable", "enum", "items", "properties", "required", "propertyOrdering"]);

export function sanitizeSchema(node: unknown): Record<string, unknown> {
  if (Array.isArray(node)) return node.map(sanitizeSchema) as unknown as Record<string, unknown>;
  if (node === null || typeof node !== "object") return node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === "properties" && v !== null && typeof v === "object" && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) props[name] = sanitizeSchema(sub);
      out[k] = props;
    } else {
      out[k] = k === "type" && typeof v === "string" ? v.toUpperCase() : sanitizeSchema(v);
    }
  }
  return out;
}

/** Gemini models (wire ids starting with "gemini") need a thoughtSignature on every replayed functionCall (law 6). */
export const isGeminiFamily = (wireId: string): boolean => wireId.toLowerCase().startsWith("gemini");
