// The near-native Gemini cell (P4 plan §2.3): a public Gemini `generateContent` body checked and mapped into the
// Antigravity inner request, and the upstream responses mapped back. Pure.
//
// Request rules (each from evidence; anything never captured or probed is unsupported_feature, never guessed):
//   - carried fields: contents, systemInstruction, tools[].functionDeclarations, toolConfig, generationConfig (the
//     captured IDE request, SPEC.md §3); generationConfig keys maxOutputTokens, thinkingConfig (captured) and
//     temperature, topP, topK, stopSequences (accepted on every Antigravity target, P0-LIVE E3 f6/f7).
//   - thinkingBudget is catalog-exact (AGENTS.md §3) and injected when absent (wire law 13).
//   - maxOutputTokens defaults to the catalog value and may not exceed it.
//   - tool schemas: keywords outside the law-5 whitelist are unsupported (user decision Q2); with lossy they are
//     sanitized. `type` values are upper-cased (law 5) — the same Gemini Type, not a removal.
//   - `parametersJsonSchema` (a full JSON Schema; the Gen AI SDK sends every `$schema` tool and every MCP tool this
//     way) is carried unchanged: Antigravity accepts it on Gemini and Claude models (live L1 j1/j2, 2026-10-13), while
//     the same schema as `parameters` is a 400 upstream (j3/j4).
//   - functionCallingConfig.mode only AUTO / VALIDATED; ANY, NONE and allowedFunctionNames are ignored or rejected
//     upstream (P0-LIVE L6, plan amendment B1). With tools and no mode, VALIDATED (the IDE's captured value).
//   - law 7: functionResponse parts ride in MODEL-role contents (a user-role run of them is moved).
//   - law 6 (Gemini models): a functionCall without thoughtSignature is signed from the proxy's cache, else it is
//     dropped with its functionResponse; law 8: content-free contents dropped; law 12: trailing model turns (other
//     than function responses) stripped after the law-6 drop. These always apply and are reported (decision Q3).
import { InvalidRequestError, UnsupportedFeatureError } from "@accounts-proxy/core/domain/errors.ts";
import type { ModelDescriptor } from "@accounts-proxy/provider-antigravity/domain/catalog.ts";
import { thinkingDefaultFor } from "@accounts-proxy/provider-antigravity/domain/catalog.ts";
import type { ChatMessage, ToolCall } from "@accounts-proxy/provider-antigravity/domain/generate.ts";
import { isGeminiFamily, SCHEMA_KEYS, sanitizeSchema } from "@accounts-proxy/provider-antigravity/domain/gemini-schema.ts";
import type { TrajectorySnapshot } from "@accounts-proxy/provider-antigravity/domain/trajectory.ts";

export type GeminiPart = Record<string, unknown>;
export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
/** One public `GenerateContentResponse` (the `response` inside each Antigravity stream envelope). */
export type GeminiResponse = Record<string, unknown>;

export type GeminiMethod = "generateContent" | "streamGenerateContent" | "countTokens";

export type PreparedGemini = {
  readonly contents: readonly GeminiContent[];
  readonly systemInstruction?: { readonly role: "user"; readonly parts: readonly GeminiPart[] };
  readonly tools?: readonly { readonly functionDeclarations: readonly Record<string, unknown>[] }[];
  readonly toolConfig?: { readonly functionCallingConfig: Record<string, unknown> };
  readonly generationConfig: Record<string, unknown>;
  /** The conversation as the trajectory sees it (TrajectoryState.begin). */
  readonly turns: readonly ChatMessage[];
  /** Everything removed: lossy drops and the always-applied wire-law drops (x-proxy-dropped). */
  readonly dropped: readonly string[];
};

export type PrepareOptions = { readonly lossy: boolean; readonly signatures: Readonly<Record<string, string>> };

const TARGET = "antigravity (Gemini cell)";
const TOP_LEVEL = new Set(["contents", "systemInstruction", "tools", "toolConfig", "generationConfig"]);
const GENERATION = new Set(["maxOutputTokens", "thinkingConfig", "temperature", "topP", "topK", "stopSequences"]);
const THINKING = new Set(["includeThoughts", "thinkingBudget"]);
const PART = new Set(["text", "thought", "thoughtSignature", "inlineData", "functionCall", "functionResponse"]);
const DECLARATION = new Set(["name", "description", "parameters", "parametersJsonSchema"]);
const MODES = new Set(["AUTO", "VALIDATED"]);

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** `/v1beta/models/<model>:<method>` → the method, when it is one of the three Gemini model methods. */
export function geminiMethod(path: string): GeminiMethod | undefined {
  const method = /:([A-Za-z]+)$/.exec(path)?.[1];
  return method === "generateContent" || method === "streamGenerateContent" || method === "countTokens" ? method : undefined;
}

class Findings {
  readonly unsupported: string[] = [];
  readonly dropped: string[] = [];
  constructor(readonly lossy: boolean) {}

  /** true when the feature may be dropped (lossy); otherwise it is recorded as unsupported. */
  refuse(feature: string): boolean {
    if (this.lossy) this.dropped.push(feature);
    else this.unsupported.push(feature);
    return this.lossy;
  }
}

function unknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(value).filter((k) => !allowed.has(k));
}

/** Schema keywords outside the law-5 whitelist; `properties` keys are user-defined names and are not keywords. */
export function foreignSchemaKeywords(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) foreignSchemaKeywords(item, out);
    return out;
  }
  if (!isObject(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    if (!SCHEMA_KEYS.has(key)) out.add(key);
    else if (key === "properties" && isObject(value)) for (const sub of Object.values(value)) foreignSchemaKeywords(sub, out);
    else foreignSchemaKeywords(value, out);
  }
  return out;
}

function checkPart(part: unknown, where: string, findings: Findings): GeminiPart {
  if (!isObject(part)) throw new InvalidRequestError(`${where} must be an object`);
  const out: GeminiPart = { ...part };
  for (const key of unknownKeys(part, PART)) if (findings.refuse(`contents.parts.${key}`)) delete out[key];
  if (out["text"] !== undefined && typeof out["text"] !== "string") throw new InvalidRequestError(`${where}.text must be a string`);
  const inline = out["inlineData"];
  if (inline !== undefined && (!isObject(inline) || typeof inline["mimeType"] !== "string" || typeof inline["data"] !== "string")) {
    throw new InvalidRequestError(`${where}.inlineData needs string mimeType and data`);
  }
  for (const kind of ["functionCall", "functionResponse"] as const) {
    const value = out[kind];
    if (value !== undefined && (!isObject(value) || typeof value["name"] !== "string")) throw new InvalidRequestError(`${where}.${kind} needs a string name`);
  }
  return out;
}

const hasResponse = (c: GeminiContent) => c.parts.some((p) => p["functionResponse"] !== undefined);

/** A part that carries content (law 8): a call, a response, inline data, or non-blank text. */
function contentful(part: GeminiPart): boolean {
  if (part["functionCall"] !== undefined || part["functionResponse"] !== undefined || part["inlineData"] !== undefined) return true;
  return typeof part["text"] === "string" && part["text"].trim().length > 0;
}

function checkContents(raw: unknown, findings: Findings): GeminiContent[] {
  if (!Array.isArray(raw)) throw new InvalidRequestError("contents must be an array");
  const contents: GeminiContent[] = [];
  raw.forEach((content, index) => {
    const where = `contents[${index}]`;
    if (!isObject(content)) throw new InvalidRequestError(`${where} must be an object`);
    const role = content["role"] ?? "user";
    if (role !== "user" && role !== "model") throw new InvalidRequestError(`${where}.role must be "user" or "model"`);
    if (!Array.isArray(content["parts"])) throw new InvalidRequestError(`${where}.parts must be an array`);
    const parts = content["parts"].map((p, i) => checkPart(p, `${where}.parts[${i}]`, findings));
    // Law 7: consecutive runs of functionResponse parts move to a model-role content; the rest keep the role.
    let run: GeminiContent | undefined;
    for (const part of parts) {
      const runRole = role === "user" && part["functionResponse"] !== undefined ? "model" : role;
      if (run === undefined || run.role !== runRole) {
        run = { role: runRole, parts: [] };
        contents.push(run);
      }
      run.parts.push(part);
    }
    if (parts.length === 0) contents.push({ role, parts: [] });
  });
  return contents;
}

/** Law 6 for Gemini models: sign from the cache, else drop the call and its response. */
function signCalls(contents: GeminiContent[], modelWireId: string, signatures: Readonly<Record<string, string>>, dropped: string[]): GeminiContent[] {
  if (!isGeminiFamily(modelWireId)) return contents;
  const unsignedIds = new Set<string>();
  const unsignedNames = new Set<string>();
  const signed = contents.map((c) => ({
    role: c.role,
    parts: c.parts.flatMap((part) => {
      const call = part["functionCall"] as Record<string, unknown> | undefined;
      if (call === undefined || typeof part["thoughtSignature"] === "string") return [part];
      const id = typeof call["id"] === "string" ? call["id"] : undefined;
      const cached = id !== undefined && Object.hasOwn(signatures, id) ? signatures[id] : undefined;
      if (cached !== undefined) return [{ ...part, thoughtSignature: cached }];
      if (id !== undefined) unsignedIds.add(id);
      else unsignedNames.add(call["name"] as string);
      dropped.push(`unsigned_function_call:${id ?? (call["name"] as string)}`);
      return [];
    }),
  }));
  if (unsignedIds.size === 0 && unsignedNames.size === 0) return signed;
  return signed.map((c) => ({
    role: c.role,
    parts: c.parts.filter((part) => {
      const response = part["functionResponse"] as Record<string, unknown> | undefined;
      if (response === undefined) return true;
      const id = typeof response["id"] === "string" ? response["id"] : undefined;
      return id !== undefined ? !unsignedIds.has(id) : !unsignedNames.has(response["name"] as string);
    }),
  }));
}

function checkSystem(raw: unknown, findings: Findings): PreparedGemini["systemInstruction"] {
  if (raw === undefined) return undefined;
  if (!isObject(raw) || !Array.isArray(raw["parts"])) throw new InvalidRequestError("systemInstruction must be a content with a parts array");
  const parts: GeminiPart[] = [];
  raw["parts"].forEach((part, i) => {
    if (!isObject(part)) throw new InvalidRequestError(`systemInstruction.parts[${i}] must be an object`);
    const foreign = unknownKeys(part, new Set(["text"]));
    if (foreign.length > 0) {
      for (const key of foreign) findings.refuse(`systemInstruction.parts.${key}`);
      if (!findings.lossy || typeof part["text"] !== "string") return;
    }
    if (typeof part["text"] !== "string") throw new InvalidRequestError(`systemInstruction.parts[${i}].text must be a string`);
    parts.push({ text: part["text"] });
  });
  return parts.length > 0 ? { role: "user", parts } : undefined;
}

function checkTools(raw: unknown, findings: Findings): PreparedGemini["tools"] {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new InvalidRequestError("tools must be an array");
  const declarations: Record<string, unknown>[] = [];
  raw.forEach((tool, i) => {
    if (!isObject(tool)) throw new InvalidRequestError(`tools[${i}] must be an object`);
    for (const key of unknownKeys(tool, new Set(["functionDeclarations"]))) findings.refuse(`tools.${key}`);
    const list = tool["functionDeclarations"];
    if (list === undefined) return;
    if (!Array.isArray(list)) throw new InvalidRequestError(`tools[${i}].functionDeclarations must be an array`);
    list.forEach((declaration, j) => {
      if (!isObject(declaration) || typeof declaration["name"] !== "string") throw new InvalidRequestError(`tools[${i}].functionDeclarations[${j}] needs a string name`);
      const out: Record<string, unknown> = { name: declaration["name"] };
      for (const key of unknownKeys(declaration, DECLARATION)) findings.refuse(`tools.functionDeclarations.${key}`);
      if (declaration["description"] !== undefined) out["description"] = declaration["description"];
      if (declaration["parameters"] !== undefined) {
        const foreign = [...foreignSchemaKeywords(declaration["parameters"])];
        for (const keyword of foreign) findings.refuse(`tools.parameters.${keyword}`);
        out["parameters"] = sanitizeSchema(declaration["parameters"]);
      }
      if (declaration["parametersJsonSchema"] !== undefined) out["parametersJsonSchema"] = declaration["parametersJsonSchema"];
      declarations.push(out);
    });
  });
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;
}

function checkToolConfig(raw: unknown, hasTools: boolean, findings: Findings): PreparedGemini["toolConfig"] {
  if (raw !== undefined && !isObject(raw)) throw new InvalidRequestError("toolConfig must be an object");
  for (const key of raw === undefined ? [] : unknownKeys(raw, new Set(["functionCallingConfig"]))) findings.refuse(`toolConfig.${key}`);
  const calling = raw?.["functionCallingConfig"];
  if (calling !== undefined && !isObject(calling)) throw new InvalidRequestError("toolConfig.functionCallingConfig must be an object");
  let mode: string | undefined;
  for (const key of calling === undefined ? [] : Object.keys(calling)) {
    const value = calling![key];
    if (key === "mode" && typeof value === "string" && MODES.has(value)) mode = value;
    else findings.refuse(key === "mode" ? `toolConfig.functionCallingConfig.mode:${String(value)}` : `toolConfig.functionCallingConfig.${key}`);
  }
  if (!hasTools && raw === undefined) return undefined;
  return { functionCallingConfig: { mode: mode ?? "VALIDATED" } };
}

function positiveInteger(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new InvalidRequestError(`${where} must be a positive integer`);
  return value;
}

function checkGeneration(raw: unknown, model: ModelDescriptor, findings: Findings): Record<string, unknown> {
  if (raw !== undefined && !isObject(raw)) throw new InvalidRequestError("generationConfig must be an object");
  const given: Record<string, unknown> = raw === undefined ? {} : { ...raw };
  for (const key of unknownKeys(given, GENERATION)) if (findings.refuse(`generationConfig.${key}`)) delete given[key];
  for (const key of ["temperature", "topP", "topK"]) {
    if (given[key] !== undefined && (typeof given[key] !== "number" || !Number.isFinite(given[key]))) throw new InvalidRequestError(`generationConfig.${key} must be a number`);
  }
  const stops = given["stopSequences"];
  if (stops !== undefined && (!Array.isArray(stops) || !stops.every((s) => typeof s === "string"))) throw new InvalidRequestError("generationConfig.stopSequences must be an array of strings");

  const out: Record<string, unknown> = {};
  const max = model.maxOutputTokens;
  if (given["maxOutputTokens"] !== undefined) {
    const value = positiveInteger(given["maxOutputTokens"], "generationConfig.maxOutputTokens");
    out["maxOutputTokens"] = max > 0 && value > max ? (findings.refuse(`generationConfig.maxOutputTokens>${max}`) ? max : value) : value;
  } else if (max > 0) out["maxOutputTokens"] = max;

  const catalogBudget = thinkingDefaultFor(model);
  const thinking = given["thinkingConfig"];
  if (thinking !== undefined && !isObject(thinking)) throw new InvalidRequestError("generationConfig.thinkingConfig must be an object");
  const config: Record<string, unknown> = {};
  for (const key of thinking === undefined ? [] : unknownKeys(thinking, THINKING)) findings.refuse(`generationConfig.thinkingConfig.${key}`);
  const include = thinking?.["includeThoughts"];
  if (include !== undefined && typeof include !== "boolean") throw new InvalidRequestError("generationConfig.thinkingConfig.includeThoughts must be a boolean");
  const budget = thinking?.["thinkingBudget"];
  if (budget !== undefined && (typeof budget !== "number" || !Number.isInteger(budget))) throw new InvalidRequestError("generationConfig.thinkingConfig.thinkingBudget must be an integer");
  if (budget !== undefined && budget !== catalogBudget) findings.refuse(`generationConfig.thinkingConfig.thinkingBudget:${budget}`);
  if (catalogBudget !== undefined || include !== undefined) {
    config["includeThoughts"] = include ?? true;
    if (catalogBudget !== undefined) config["thinkingBudget"] = catalogBudget;
    out["thinkingConfig"] = config;
  }
  for (const key of ["temperature", "topP", "topK", "stopSequences"]) if (given[key] !== undefined) out[key] = given[key];
  return out;
}

/** The conversation in the turn shape TrajectoryState expects (roles and first user text drive the trajectory). */
export function turnView(contents: readonly GeminiContent[]): ChatMessage[] {
  return contents.map((c): ChatMessage => {
    const text = c.parts.map((p) => (typeof p["text"] === "string" && p["thought"] !== true ? p["text"] : "")).join("");
    if (c.role === "user") return { role: "user", text };
    if (hasResponse(c)) return { role: "tool", text };
    const toolCalls: ToolCall[] = c.parts
      .map((p) => p["functionCall"] as Record<string, unknown> | undefined)
      .filter((call): call is Record<string, unknown> => call !== undefined)
      .map((call) => ({ id: typeof call["id"] === "string" ? call["id"] : (call["name"] as string), name: call["name"] as string, arguments: JSON.stringify(call["args"] ?? {}) }));
    return { role: "assistant", text, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
  });
}

export function prepareGeminiRequest(body: unknown, model: ModelDescriptor, options: PrepareOptions): PreparedGemini {
  if (!isObject(body)) throw new InvalidRequestError("request body must be a JSON object");
  const findings = new Findings(options.lossy);
  for (const key of unknownKeys(body, TOP_LEVEL)) findings.refuse(key);

  let contents = checkContents(body["contents"], findings);
  const systemInstruction = checkSystem(body["systemInstruction"], findings);
  const tools = checkTools(body["tools"], findings);
  const toolConfig = checkToolConfig(body["toolConfig"], tools !== undefined, findings);
  const generationConfig = checkGeneration(body["generationConfig"], model, findings);
  if (findings.unsupported.length > 0) throw new UnsupportedFeatureError([...new Set(findings.unsupported)], TARGET);

  const dropped = [...findings.dropped];
  contents = signCalls(contents, model.wireId, options.signatures, dropped);
  const kept: GeminiContent[] = [];
  for (const c of contents) {
    if (c.parts.some(contentful)) kept.push(c);
    else dropped.push("empty_content");
  }
  while (kept.length > 0 && kept[kept.length - 1]!.role === "model" && !hasResponse(kept[kept.length - 1]!)) {
    kept.pop();
    dropped.push("trailing_model_turn");
  }
  if (kept.length === 0) throw new InvalidRequestError("contents has no turn left to send (empty, or only model turns)");

  return {
    contents: kept,
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolConfig !== undefined ? { toolConfig } : {}),
    generationConfig,
    turns: turnView(kept),
    dropped: [...new Set(dropped)],
  };
}

/** The inner Antigravity request in the captured key order (contents, systemInstruction, tools, toolConfig, labels, generationConfig, sessionId). */
export function innerRequest(prepared: PreparedGemini, snapshot: TrajectorySnapshot): Record<string, unknown> {
  return {
    contents: prepared.contents,
    ...(prepared.systemInstruction !== undefined ? { systemInstruction: prepared.systemInstruction } : {}),
    ...(prepared.tools !== undefined ? { tools: prepared.tools } : {}),
    ...(prepared.toolConfig !== undefined ? { toolConfig: prepared.toolConfig } : {}),
    labels: snapshot.labels,
    generationConfig: prepared.generationConfig,
    sessionId: snapshot.sessionId,
  };
}

const candidateOf = (response: GeminiResponse): Record<string, unknown> | undefined => {
  const candidates = response["candidates"];
  return Array.isArray(candidates) && isObject(candidates[0]) ? candidates[0] : undefined;
};

/** Every functionCall part of a response that carries a thoughtSignature and an id (law 6 cache input). */
export function signedCalls(response: GeminiResponse): { readonly id: string; readonly signature: string }[] {
  const parts = (candidateOf(response)?.["content"] as { parts?: unknown } | undefined)?.parts;
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part: unknown) => {
    if (!isObject(part) || !isObject(part["functionCall"]) || typeof part["thoughtSignature"] !== "string") return [];
    const id = part["functionCall"]["id"];
    return typeof id === "string" ? [{ id, signature: part["thoughtSignature"] }] : [];
  });
}

const isTextPart = (part: GeminiPart) => typeof part["text"] === "string" && Object.keys(part).every((k) => k === "text" || k === "thought" || k === "thoughtSignature");

/**
 * Decision Q4: one non-streamed response from the streamed ones. Consecutive text parts with the same `thought` flag
 * are concatenated (a thoughtSignature on any of them is kept, the last one winning); every other part (function
 * calls with their signatures, inline data) is kept in order. The last finishReason, usageMetadata, modelVersion
 * and responseId win; the other candidate fields come from the last candidate.
 */
export function aggregateResponses(responses: readonly GeminiResponse[]): GeminiResponse {
  const parts: GeminiPart[] = [];
  let candidate: Record<string, unknown> = {};
  const top: Record<string, unknown> = {};
  for (const response of responses) {
    for (const [key, value] of Object.entries(response)) if (key !== "candidates") top[key] = value;
    const current = candidateOf(response);
    if (current === undefined) continue;
    const { content, ...rest } = current;
    candidate = { ...candidate, ...rest };
    const incoming = isObject(content) && Array.isArray(content["parts"]) ? (content["parts"] as unknown[]) : [];
    for (const raw of incoming) {
      if (!isObject(raw)) continue;
      const previous = parts[parts.length - 1];
      if (previous !== undefined && isTextPart(previous) && isTextPart(raw) && (previous["thought"] === true) === (raw["thought"] === true)) {
        previous["text"] = `${previous["text"] as string}${raw["text"] as string}`;
        if (raw["thoughtSignature"] !== undefined) previous["thoughtSignature"] = raw["thoughtSignature"];
      } else parts.push({ ...raw });
    }
  }
  return { candidates: [{ ...candidate, content: { role: "model", parts } }], ...top };
}
