// Port of opencode-antigravity-auth @ 5c6f7c2 domain/services/QuotaService.ts (blob 148866d6) and
// domain/entities/QuotaSnapshot.ts. Feeds `inference-router quota` (manual account choice, plan D4).

export type QuotaBucket = { readonly bucketId: string; readonly displayName: string; readonly window: string; readonly resetTime: string; readonly remainingFraction: number };
export type QuotaGroup = { readonly displayName: string; readonly description?: string; readonly buckets: readonly QuotaBucket[] };
export type QuotaSnapshot = { readonly groups: readonly QuotaGroup[]; readonly capturedAt: number };

export function toQuotaSnapshot(raw: Readonly<Record<string, unknown>>, capturedAt: number): QuotaSnapshot {
  const groups = (raw["groups"] ?? []) as Array<Record<string, unknown>>;
  return {
    capturedAt,
    groups: groups.map((g) => ({
      displayName: String(g["displayName"] ?? ""),
      buckets: ((g["buckets"] ?? []) as Array<Record<string, unknown>>).map((b) => ({
        bucketId: String(b["bucketId"] ?? ""),
        displayName: String(b["displayName"] ?? ""),
        window: String(b["window"] ?? ""),
        resetTime: String(b["resetTime"] ?? ""),
        remainingFraction: Number(b["remainingFraction"] ?? 0),
      })),
      ...(typeof g["description"] === "string" && g["description"].length > 0 ? { description: g["description"] } : {}),
    })),
  };
}

export function parseGroupModels(description: string | undefined): string[] {
  if (!description) return [];
  const idx = description.indexOf(":");
  if (idx < 0) return [];
  return description
    .slice(idx + 1)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const WINDOW_LABELS: Readonly<Record<string, string>> = { "5h": "5-hour limit", weekly: "Weekly limit" };

export type UsageView = {
  readonly capturedAt: number;
  readonly groups: readonly { readonly name: string; readonly models: readonly string[]; readonly buckets: readonly { readonly id: string; readonly window: string; readonly remainingPercent: number; readonly resetAt: string }[] }[];
  readonly text: string;
};

export function formatUsage(snapshot: QuotaSnapshot): UsageView {
  const groups = snapshot.groups.map((g) => ({
    name: g.displayName,
    models: parseGroupModels(g.description),
    buckets: g.buckets.map((b) => ({
      id: b.bucketId,
      window: Object.hasOwn(WINDOW_LABELS, b.window) ? WINDOW_LABELS[b.window]! : b.window,
      remainingPercent: Math.round(b.remainingFraction * 100),
      resetAt: b.resetTime,
    })),
  }));
  const lines: string[] = ["Antigravity usage:"];
  for (const g of groups) {
    lines.push(`- ${g.name}${g.models.length > 0 ? ` (${g.models.join(", ")})` : ""}`);
    for (const b of g.buckets) lines.push(`    ${b.window}: ${b.remainingPercent}% remaining, resets ${b.resetAt}`);
  }
  return { capturedAt: snapshot.capturedAt, groups, text: lines.join("\n") };
}
