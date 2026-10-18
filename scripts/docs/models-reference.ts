// The model reference document (plan 2026-10-16 C7, decision D4): every model of every provider, generated from the
// proxy itself. A real proxy process (the source entry, as in the e2e tier) runs `models --json` and `opencode-config`
// against the replay server of the e2e tier (tests/support/e2e/upstreams.ts), so every list comes from a committed
// source: the built-in lists in the code, the committed captures and the committed vendor lists. `antigravity` has no
// built-in list, so the data directory is signed in to it through the replay (the fake browser of the e2e tier).
//
//   bun scripts/docs/models-reference.ts           writes MODELS_REFERENCE
//   bun scripts/docs/models-reference.ts --check   exit 1 when MODELS_REFERENCE differs from a fresh generation
// The e2e test apps/proxy/tests/e2e/docs.test.ts runs the same comparison inside `verify`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "@accounts-proxy/scripts/gate/instrument.ts";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { makeHome, runProxy } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { ReplayUpstreams } from "@accounts-proxy/test-support/e2e/upstreams.ts";

export const MODELS_REFERENCE = "docs/reference/2026-10-17-19-26-models.md";

const ALL_PROVIDERS = [
  "providers:",
  "  claude: {enabled: true, acknowledgeTermsRisk: true}",
  "  antigravity: {enabled: true, acknowledgeTermsRisk: true}",
  "  openai: {enabled: true, acknowledgeTermsRisk: true}",
  "  openrouter: {enabled: true}",
  "  opencode: {enabled: true}",
  "  opencode-go: {enabled: true}",
  "  cheaper-inference: {enabled: true}",
  "",
].join("\n");

type Cost = { input: number; output: number; cacheRead?: number; cacheWrite?: number; tier?: { size: number } };
type ReasoningOption = { type: "effort"; values: string[] } | { type: "toggle" } | { type: "budget_tokens"; min?: number; max?: number };
type Model = {
  id: string;
  model: string;
  name: string;
  formats: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  input?: string[];
  output?: string[];
  toolCall?: boolean;
  reasoning?: boolean;
  reasoningOptions?: ReasoningOption[];
  cost?: Cost[];
  sources: Record<string, string>;
};
type Catalog = { provider: string; source: string; referenceSource?: string; models: Model[]; error?: { code: string; message: string } };
type OpencodeConfig = { providers: Record<string, { models: Record<string, { variants?: { id: string }[] }> }> };

/**
 * Where each provider's list comes from in the generation (the files the replay server answers, or the built-in list
 * the provider falls back to without an account), and what the user's signed-in daemon listed on 2026-10-17 with the
 * source it reported (`GET /proxy/v1/models`, plan 2026-10-16 amendment R, step R7).
 */
const LIST_SOURCE: Readonly<Record<string, { readonly from: string; readonly daemon: string }>> = {
  claude: { from: "the built-in list `STATIC_CATALOG` (`packages/provider-claude/src/domain/model-envelope.ts`; no account in the generation)", daemon: "14, live" },
  antigravity: { from: "the committed capture `tests/fixtures/captures/p0-live/e5/fetch-available-models.json` (live answer of 2026-10-12; Antigravity has no built-in list)", daemon: "24, live" },
  openai: { from: "the built-in list `STATIC_CATALOG` (`packages/provider-openai/src/domain/catalog.ts`; no account in the generation)", daemon: "7, stored copy" },
  openrouter: { from: "the committed vendor list `docs/reference/specs/openrouter-models.json`", daemon: "467, stored copy" },
  opencode: { from: "the committed vendor list `docs/reference/specs/opencode-zen-models.json`", daemon: "88, stored copy" },
  "opencode-go": { from: "the committed vendor list `docs/reference/specs/opencode-go-models.json`", daemon: "37, stored copy" },
  "cheaper-inference": { from: "the committed vendor list `docs/reference/specs/cheaper-inference-public-models.json`", daemon: "91, stored copy" },
};

const FORMAT: Readonly<Record<string, string>> = { "anthropic-messages": "Messages", "openai-chat": "Chat", "openai-responses": "Responses", gemini: "Gemini" };
const FIELD_NAMES: readonly [string, string][] = [
  ["name", "name"],
  ["contextWindow", "context"],
  ["maxOutputTokens", "output"],
  ["input", "input"],
  ["toolCall", "tools"],
  ["reasoning", "reasoning"],
  ["reasoningOptions", "reasoning"],
  ["cost", "price"],
];

const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const count = (n: number | undefined): string => (n === undefined ? "—" : String(n));
const flag = (b: boolean | undefined): string => (b === undefined ? "—" : b ? "yes" : "no");
const price = (n: number): string => String(Number(n.toFixed(6)));

function reasoning(m: Model): string {
  const options = (m.reasoningOptions ?? []).map((o) => (o.type === "effort" ? `effort ${o.values.join("/")}` : o.type === "toggle" ? "on/off" : `budget${o.min !== undefined || o.max !== undefined ? ` ${o.min ?? ""}–${o.max ?? ""}` : ""}`));
  if (options.length > 0) return options.join("; ");
  return flag(m.reasoning);
}

function cost(m: Model): string {
  const base = m.cost?.[0];
  if (base === undefined) return "—";
  const tiers = (m.cost?.length ?? 0) - 1;
  return `${price(base.input)} / ${price(base.output)}${tiers > 0 ? ` (+${tiers} tier${tiers > 1 ? "s" : ""})` : ""}`;
}

/** The fields of a model the reference catalog filled (rule M1: the provider's own list first). */
function fromReference(m: Model): string {
  const names = new Set<string>();
  for (const [field, label] of FIELD_NAMES) if (m.sources[field]?.startsWith("models.opencode.ai:")) names.add(label);
  return names.size === 0 ? "" : [...names].join(", ");
}

/** The Markdown document for the given `models --json` and `opencode-config` answers (pure). */
export function renderModelsReference(catalogs: readonly Catalog[], config: OpencodeConfig): string {
  const total = catalogs.reduce((n, c) => n + c.models.length, 0);
  const lines: string[] = [
    "# Model reference (generated)",
    "",
    "Every model of the seven providers with its native formats, limits, media, tools, reasoning controls, price and",
    "opencode variants. **Generated, do not edit:** `bun scripts/docs/models-reference.ts` writes this file from the",
    "proxy's own `models --json` and `opencode-config` (plan 2026-10-16 decision D4); the e2e test",
    "`apps/proxy/tests/e2e/docs.test.ts` regenerates it inside `bun run verify` and fails when it differs.",
    "",
    "The generation runs the real proxy against the committed sources only (no account, no network), so it shows the",
    "lists the repository carries. What a signed-in daemon lists today is `bun run proxy models [<provider>] [--json]`",
    "or `GET /proxy/v1/models` ([API](2026-10-17-19-26-proxy-api.md)); what the user's signed-in daemon listed on",
    "2026-10-17, with the source it reported, is in the table below.",
    "",
    "| Provider | Models here | Signed-in daemon, 2026-10-17 | List used for this document | Details filled from |",
    "|---|---|---|---|---|",
  ];
  for (const c of catalogs) {
    const source = LIST_SOURCE[c.provider]!;
    const reference = c.referenceSource === undefined ? "— (no reference provider, rule M2)" : "`docs/reference/specs/models-opencode-reference.json` (models.opencode.ai)";
    lines.push(`| [\`${c.provider}\`](#${c.provider}) | ${c.models.length} | ${source.daemon} | ${source.from} | ${reference} |`);
  }
  lines.push(
    "",
    `${total} models in total.`,
    "",
    "Columns:",
    "",
    "- **Model id**: the routable `<provider>/<model>` a request names.",
    "- **Formats**: the request formats the model accepts natively (Messages = Anthropic Messages, Chat = OpenAI Chat",
    "  Completions, Responses = OpenAI Responses, Gemini = Gemini generateContent). A request in another format answers",
    "  400 `unsupported_feature`. `—`: neither the vendor's list nor the reference catalog names a format; the request is",
    "  forwarded in the client's format and the gateway answers it (rule Z6).",
    "- **Context / Output**: the context window and the maximum output, in tokens.",
    "- **Input**: the media the model reads. **Tools**: whether it calls tools.",
    "- **Reasoning**: the reasoning controls it accepts (effort levels, on/off, a token budget), else whether it reasons.",
    "- **Price**: USD per million input / output tokens; `+n tiers`: higher prices above a context size. Subscription",
    "  providers carry no price (decision E4).",
    "- **opencode variants**: the variants `GET /opencode/config.json` gives the model (opencode's own rules for the",
    "  model's connection package, rules O1–O6; none for Antigravity).",
    "- **From reference**: the fields the reference catalog filled because the provider's own list does not state them",
    "  (rules M1–M3, [model catalog rules](2026-10-16-01-38-model-catalog-rules.md)); empty: every stated field is the",
    "  provider's own.",
    "- `—`: no source states the field (never guessed).",
  );
  for (const c of catalogs) {
    const variants = config.providers[`ap-${c.provider}`]?.models ?? {};
    lines.push("", `## ${c.provider}`, "", `${c.models.length} models; list: ${LIST_SOURCE[c.provider]!.from}.`, "");
    lines.push("| Model id | Name | Formats | Context | Output | Input | Tools | Reasoning | Price | opencode variants | From reference |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const m of c.models) {
      const formats = m.formats.length === 0 ? "—" : m.formats.map((f) => FORMAT[f] ?? f).join(", ");
      const own = (variants[m.model]?.variants ?? []).map((v) => v.id).join(", ");
      lines.push(
        `| \`${cell(m.id)}\` | ${cell(m.name)} | ${formats} | ${count(m.contextWindow)} | ${count(m.maxOutputTokens)} | ${m.input?.join(", ") ?? "—"} | ${flag(m.toolCall)} | ${cell(reasoning(m))} | ${cost(m)} | ${own === "" ? "—" : own} | ${fromReference(m)} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Runs the proxy against the replay server and renders the document. */
export async function generateModelsReference(): Promise<string> {
  const upstreams = new ReplayUpstreams();
  upstreams.start();
  const home = await makeHome(ALL_PROVIDERS);
  try {
    const env = upstreams.seamEnv();
    const login = await runProxy(home, ["login", "antigravity", "--timeout-seconds", "30"], env);
    if (login.code !== 0) throw new Error(`login antigravity failed: ${login.stderr}`);
    const listed = await runProxy(home, ["models", "--json"], env);
    if (listed.code !== 0) throw new Error(`models --json failed: ${listed.stderr}`);
    const configured = await runProxy(home, ["opencode-config"], env);
    if (configured.code !== 0) throw new Error(`opencode-config failed: ${configured.stderr}`);
    return renderModelsReference((JSON.parse(listed.stdout) as { catalogs: Catalog[] }).catalogs, JSON.parse(configured.stdout) as OpencodeConfig);
  } finally {
    upstreams.stop();
    removeTemporary(home.dir);
  }
}

if (import.meta.main) {
  const path = join(repositoryRoot, MODELS_REFERENCE);
  const fresh = await generateModelsReference();
  if (process.argv.includes("--check")) {
    const same = readFileSync(path, "utf8") === fresh;
    console.log(same ? `${MODELS_REFERENCE} is current` : `${MODELS_REFERENCE} differs from a fresh generation; run bun scripts/docs/models-reference.ts`);
    process.exit(same ? 0 : 1);
  }
  writeFileSync(path, fresh);
  console.log(`wrote ${MODELS_REFERENCE}`);
}
