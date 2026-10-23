// Structural difference between the real client's request (plane A) and the proxy's (plane B), both canonical.
// Every entry is one observable difference an upstream could use to tell the two apart.
import { REDACTED, type CanonicalHeader, type CanonicalRequest } from "@accounts-proxy/scripts/recon/parity/canon.ts";

export type GapKind =
  | "method"
  | "path"
  | "query-missing"
  | "query-extra"
  | "query-value"
  | "header-missing"
  | "header-extra"
  | "header-value"
  | "header-case"
  | "header-order"
  | "body-missing"
  | "body-extra"
  | "body-value"
  | "body-type"
  | "body-length";

export type Gap = {
  readonly kind: GapKind;
  /** Header name, query key, or JSON pointer into the body. */
  readonly where: string;
  /** The client's side, absent when the client does not have it. */
  readonly client?: unknown;
  /** The proxy's side, absent when the proxy does not have it. */
  readonly proxy?: unknown;
};

function same(a: unknown, b: unknown): boolean {
  if (a === REDACTED || b === REDACTED) return typeof a === typeof b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** RFC 6901 pointer segment. */
function segment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function diffBody(a: unknown, b: unknown, where: string, out: Gap[]): void {
  if (same(a, b)) return;
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) {
    out.push({ kind: "body-type", where: where || "/", client: a, proxy: b });
    return;
  }
  if (ta === "array") {
    diffArray(a as unknown[], b as unknown[], where, out);
    return;
  }
  if (ta === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    for (const key of Object.keys(left)) {
      const path = `${where}/${segment(key)}`;
      if (!(key in right)) out.push({ kind: "body-missing", where: path, client: left[key] });
      else diffBody(left[key], right[key], path, out);
    }
    for (const key of Object.keys(right)) if (!(key in left)) out.push({ kind: "body-extra", where: `${where}/${segment(key)}`, proxy: right[key] });
    return;
  }
  out.push({ kind: "body-value", where: where || "/", client: a, proxy: b });
}

/**
 * Arrays are aligned on equal elements first (longest common subsequence), so a block the proxy inserts is one
 * `body-extra` instead of every later element reported as changed. Between two aligned elements the remaining ones are
 * paired by position and compared field by field; what is left over on one side is missing or extra. Element paths use
 * the client's index, extras the proxy's index after `+`.
 */
function diffArray(left: readonly unknown[], right: readonly unknown[], where: string, out: Gap[]): void {
  const at = where || "";
  if (left.length !== right.length) out.push({ kind: "body-length", where: at || "/", client: left.length, proxy: right.length });
  const keyA = left.map((item) => JSON.stringify(item));
  const keyB = right.map((item) => JSON.stringify(item));
  const table: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = keyA[i] === keyB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pendingA: number[] = [];
  const pendingB: number[] = [];
  const flush = () => {
    const paired = Math.min(pendingA.length, pendingB.length);
    for (let k = 0; k < paired; k += 1) diffBody(left[pendingA[k]!], right[pendingB[k]!], `${at}/${pendingA[k]}`, out);
    for (const index of pendingA.slice(paired)) out.push({ kind: "body-missing", where: `${at}/${index}`, client: left[index] });
    for (const index of pendingB.slice(paired)) out.push({ kind: "body-extra", where: `${at}/+${index}`, proxy: right[index] });
    pendingA.length = 0;
    pendingB.length = 0;
  };
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (keyA[i] === keyB[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) pendingA.push(i++);
    else pendingB.push(j++);
  }
  while (i < left.length) pendingA.push(i++);
  while (j < right.length) pendingB.push(j++);
  flush();
}

function byName(headers: readonly CanonicalHeader[]): Map<string, CanonicalHeader[]> {
  const map = new Map<string, CanonicalHeader[]>();
  for (const header of headers) map.set(header.name, [...(map.get(header.name) ?? []), header]);
  return map;
}

/**
 * Headers named in `ignore` are left out entirely: they describe the hop rather than the client (for example the
 * `transfer-encoding` a Go client chose for one body) and are reported once by the caller instead of per request.
 */
export function diffRequests(client: CanonicalRequest, proxy: CanonicalRequest, ignore: ReadonlySet<string> = new Set()): Gap[] {
  const out: Gap[] = [];
  if (client.method !== proxy.method) out.push({ kind: "method", where: "method", client: client.method, proxy: proxy.method });
  if (client.path !== proxy.path) out.push({ kind: "path", where: "path", client: client.path, proxy: proxy.path });

  const qa = new Map(client.query);
  const qb = new Map(proxy.query);
  for (const [key, value] of qa) {
    if (!qb.has(key)) out.push({ kind: "query-missing", where: key, client: value });
    else if (!same(value, qb.get(key))) out.push({ kind: "query-value", where: key, client: value, proxy: qb.get(key) });
  }
  for (const [key, value] of qb) if (!qa.has(key)) out.push({ kind: "query-extra", where: key, proxy: value });

  const ha = byName(client.headers.filter((h) => !ignore.has(h.name)));
  const hb = byName(proxy.headers.filter((h) => !ignore.has(h.name)));
  for (const [name, list] of ha) {
    const other = hb.get(name);
    if (other === undefined) {
      out.push({ kind: "header-missing", where: name, client: list.map((h) => h.value).join(", ") });
      continue;
    }
    const va = list.map((h) => h.value).join(", ");
    const vb = other.map((h) => h.value).join(", ");
    if (!same(va, vb)) out.push({ kind: "header-value", where: name, client: va, proxy: vb });
    if (list[0]!.raw !== other[0]!.raw) out.push({ kind: "header-case", where: name, client: list[0]!.raw, proxy: other[0]!.raw });
  }
  for (const [name, list] of hb) if (!ha.has(name)) out.push({ kind: "header-extra", where: name, proxy: list.map((h) => h.value).join(", ") });

  // Order is compared over the names both sides send, so a missing header is not also counted as an order change.
  const common = new Set([...ha.keys()].filter((name) => hb.has(name)));
  const orderA = [...new Set(client.headers.map((h) => h.name).filter((name) => common.has(name)))];
  const orderB = [...new Set(proxy.headers.map((h) => h.name).filter((name) => common.has(name)))];
  if (!ignore.has("header-order") && orderA.join("\n") !== orderB.join("\n")) out.push({ kind: "header-order", where: "headers", client: orderA, proxy: orderB });

  diffBody(client.body, proxy.body, "", out);
  return out;
}
