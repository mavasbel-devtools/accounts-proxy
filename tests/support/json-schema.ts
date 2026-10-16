// A JSON Schema (2020-12) checker for the keywords opencode's published configuration schema uses
// (docs/reference/specs/opencode-config-schema.json: type, properties, required, additionalProperties, items, enum,
// anyOf, allOf, $ref to #/$defs). Any other keyword in a visited schema is an error, so the checker never passes a
// document by ignoring a rule it does not know.
type Schema = boolean | { readonly [key: string]: unknown };

const KNOWN = new Set(["$schema", "$id", "$defs", "type", "properties", "required", "additionalProperties", "items", "enum", "anyOf", "allOf", "$ref", "allowComments", "allowTrailingCommas", "description", "title", "default", "examples", "deprecated"]);

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);
const matchesType = (v: unknown, t: string): boolean => typeOf(v) === t || (t === "number" && typeOf(v) === "integer");

export function validate(root: Schema, value: unknown): string[] {
  let errors: string[] = [];
  const defs = (typeof root === "object" ? root["$defs"] : undefined) as Readonly<Record<string, Schema>> | undefined;
  const check = (schema: Schema, v: unknown, at: string): void => {
    if (schema === true) return;
    if (schema === false) {
      errors.push(`${at}: not allowed`);
      return;
    }
    for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`${at}: unsupported schema keyword ${key}`);
    if (typeof schema["$ref"] === "string") {
      const name = /^#\/\$defs\/(.+)$/.exec(schema["$ref"])?.[1];
      const target = name === undefined ? undefined : defs?.[name];
      if (target === undefined) throw new Error(`${at}: unresolved $ref ${schema["$ref"]}`);
      check(target, v, at);
    }
    if (typeof schema["type"] === "string" && !matchesType(v, schema["type"])) errors.push(`${at}: expected ${schema["type"]}, got ${typeOf(v)}`);
    if (Array.isArray(schema["enum"]) && !schema["enum"].some((e) => e === v)) errors.push(`${at}: ${JSON.stringify(v)} not in ${JSON.stringify(schema["enum"])}`);
    if (Array.isArray(schema["allOf"])) for (const s of schema["allOf"] as Schema[]) check(s, v, at);
    if (Array.isArray(schema["anyOf"])) {
      const outer = errors;
      const ok = (schema["anyOf"] as Schema[]).some((alternative) => {
        errors = [];
        check(alternative, v, at);
        return errors.length === 0;
      });
      errors = outer;
      if (!ok) errors.push(`${at}: matches no anyOf alternative`);
    }
    if (typeOf(v) === "object") {
      const obj = v as Readonly<Record<string, unknown>>;
      const props = (schema["properties"] ?? {}) as Readonly<Record<string, Schema>>;
      if (Array.isArray(schema["required"])) for (const r of schema["required"] as string[]) if (!(r in obj)) errors.push(`${at}: missing ${r}`);
      for (const [k, child] of Object.entries(obj)) {
        if (k in props) check(props[k]!, child, `${at}.${k}`);
        else if (schema["additionalProperties"] !== undefined) check(schema["additionalProperties"] as Schema, child, `${at}.${k}`);
      }
    }
    if (typeOf(v) === "array" && schema["items"] !== undefined) (v as unknown[]).forEach((item, i) => check(schema["items"] as Schema, item, `${at}[${i}]`));
  };
  check(root, value, "$");
  return errors;
}
