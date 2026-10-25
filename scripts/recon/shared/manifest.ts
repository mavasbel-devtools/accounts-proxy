// Typed access to the recon redaction manifest. The manifest is read once and validated, so a malformed or partially
// edited file fails at load instead of silently weakening redaction. The capture addon reads the same JSON file.
//
// Two classes of rule live here:
// * credentials (headers, fields, query fields, token prefixes), and
// * identity (headers, fields, value patterns, and per-endpoint scoped fields) so promoted goldens never carry the
//   operator's account: email, names, device and install identifiers, account identifiers.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface IdentityPattern {
  readonly name: string;
  readonly regex: string;
}

export interface IdentityScope {
  readonly host: string;
  readonly pathPrefix: string;
  readonly fields: readonly string[];
}

export interface RedactionManifest {
  readonly schema: string;
  readonly credentialHeaders: readonly string[];
  /** Headers whose value names the operator's account; the value is also redacted wherever it recurs in the run. */
  readonly identityHeaders: readonly string[];
  readonly credentialFields: readonly string[];
  readonly queryCredentialFields: readonly string[];
  readonly tokenPrefixes: readonly string[];
  readonly forbiddenMarkers: readonly string[];
  readonly tokenBodyMinTail: number;
  readonly identityFields: readonly string[];
  readonly identityPatterns: readonly IdentityPattern[];
  readonly identityScoped: readonly IdentityScope[];
}

/** Absolute path of the manifest, also handed to the Python addon as `recon_redaction`. */
export const redactionManifestPath = join(dirname(fileURLToPath(import.meta.url)), "redaction.json");

function stringArray(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`recon redaction manifest: ${key} must be a non-empty array of strings`);
  }
  return value as string[];
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`recon redaction manifest: ${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function identityPatterns(value: unknown): readonly IdentityPattern[] {
  if (!Array.isArray(value)) throw new Error("recon redaction manifest: identityPatterns must be an array");
  return value.map((item, index) => {
    const entry = record(item, `identityPatterns[${index}]`);
    const name = entry.name;
    const regex = entry.regex;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`recon redaction manifest: identityPatterns[${index}].name must be a non-empty string`);
    }
    if (typeof regex !== "string" || regex.length === 0) {
      throw new Error(`recon redaction manifest: identityPatterns[${index}].regex must be a non-empty string`);
    }
    // A pattern that does not compile is a redaction hole; fail at load rather than at capture time.
    try {
      new RegExp(regex);
    } catch (error) {
      throw new Error(`recon redaction manifest: identityPatterns[${index}].regex does not compile: ${String(error)}`);
    }
    return { name, regex };
  });
}

function identityScoped(value: unknown): readonly IdentityScope[] {
  if (!Array.isArray(value)) throw new Error("recon redaction manifest: identityScoped must be an array");
  return value.map((item, index) => {
    const entry = record(item, `identityScoped[${index}]`);
    const host = entry.host;
    const pathPrefix = entry.pathPrefix;
    if (typeof host !== "string" || host.length === 0) {
      throw new Error(`recon redaction manifest: identityScoped[${index}].host must be a non-empty string`);
    }
    if (typeof pathPrefix !== "string" || !pathPrefix.startsWith("/")) {
      throw new Error(`recon redaction manifest: identityScoped[${index}].pathPrefix must start with "/"`);
    }
    return { host: host.toLowerCase(), pathPrefix, fields: stringArray(entry.fields, `identityScoped[${index}].fields`) };
  });
}

function parse(raw: string): RedactionManifest {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new Error(`recon redaction manifest is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (document === null || typeof document !== "object") throw new Error("recon redaction manifest must be an object");
  const entry = document as Record<string, unknown>;
  if (typeof entry.schema !== "string" || entry.schema !== "recon-redaction/3") {
    throw new Error(`recon redaction manifest: unexpected schema ${String(entry.schema)}`);
  }
  const tail = entry.tokenBodyMinTail;
  if (typeof tail !== "number" || !Number.isInteger(tail) || tail < 1) {
    throw new Error("recon redaction manifest: tokenBodyMinTail must be a positive integer");
  }
  return {
    schema: entry.schema,
    credentialHeaders: stringArray(entry.credentialHeaders, "credentialHeaders"),
    identityHeaders: stringArray(entry.identityHeaders, "identityHeaders"),
    credentialFields: stringArray(entry.credentialFields, "credentialFields"),
    queryCredentialFields: stringArray(entry.queryCredentialFields, "queryCredentialFields"),
    tokenPrefixes: stringArray(entry.tokenPrefixes, "tokenPrefixes"),
    forbiddenMarkers: stringArray(entry.forbiddenMarkers, "forbiddenMarkers"),
    tokenBodyMinTail: tail,
    identityFields: stringArray(entry.identityFields, "identityFields"),
    identityPatterns: identityPatterns(entry.identityPatterns),
    identityScoped: identityScoped(entry.identityScoped),
  };
}

let cached: RedactionManifest | undefined;

export function loadRedactionManifest(): RedactionManifest {
  cached ??= parse(readFileSync(redactionManifestPath, "utf8"));
  return cached;
}
