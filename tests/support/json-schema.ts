// A JSON Schema (2020-12) checker for the keywords opencode's published configuration schema uses
// (docs/reference/specs/opencode-config-schema.json: type, properties, required, additionalProperties, items, enum,
// anyOf, allOf, $ref to #/$defs), the proxy's OpenAPI document uses ($ref to #/components/schemas), and pi 1.5.2's
// models.json schema uses (docs/reference/specs/pi-models-schema.json: $comment, const, minimum, maximum,
// exclusiveMinimum, minLength, maxItems, patternProperties). Any other keyword, or a `type` that is not one string,
// in a visited schema is an error, so the checker never passes a document by ignoring a rule it does not know.
type Schema = boolean | { readonly [key: string]: unknown };

const KNOWN = new Set(["$schema", "$id", "$defs", "$comment", "type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "allOf", "$ref", "minimum", "maximum", "exclusiveMinimum", "minLength", "maxItems", "patternProperties", "allowComments", "allowTrailingCommas", "description", "title", "default", "examples", "deprecated"]);

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);
const matchesType = (v: unknown, t: string): boolean => typeOf(v) === t || (t === "number" && typeOf(v) === "integer");
const isNumber = (v: unknown): v is number => typeof v === "number";

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object" && a !== null && b !== null) {
    const ao = a as Readonly<Record<string, unknown>>;
    const bo = b as Readonly<Record<string, unknown>>;
    const ka = Object.keys(ao);
    if (ka.length !== Object.keys(bo).length) return false;
    return ka.every((k) => k in bo && deepEqual(ao[k], bo[k]));
  }
  return false;
};

export function validate(root: Schema, value: unknown, start: Schema = root): string[] {
  let errors: string[] = [];
  const definitions = (kind: string): Readonly<Record<string, Schema>> | undefined => {
    if (typeof root !== "object") return undefined;
    if (kind === "$defs") return root["$defs"] as Readonly<Record<string, Schema>> | undefined;
    return (root["components"] as { schemas?: Readonly<Record<string, Schema>> } | undefined)?.schemas;
  };
  const check = (schema: Schema, v: unknown, at: string): void => {
    if (schema === true) return;
    if (schema === false) {
      errors.push(`${at}: not allowed`);
      return;
    }
    for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`${at}: unsupported schema keyword ${key}`);
    if (typeof schema["$ref"] === "string") {
      const match = /^#\/(\$defs|components\/schemas)\/(.+)$/.exec(schema["$ref"]);
      const target = match === null ? undefined : definitions(match[1]!)?.[match[2]!];
      if (target === undefined) throw new Error(`${at}: unresolved $ref ${schema["$ref"]}`);
      check(target, v, at);
    }
    if (schema["type"] !== undefined && typeof schema["type"] !== "string") throw new Error(`${at}: unsupported type ${JSON.stringify(schema["type"])}`);
    if (typeof schema["type"] === "string" && !matchesType(v, schema["type"])) errors.push(`${at}: expected ${schema["type"]}, got ${typeOf(v)}`);
    if (Array.isArray(schema["enum"]) && !schema["enum"].some((e) => e === v)) errors.push(`${at}: ${JSON.stringify(v)} not in ${JSON.stringify(schema["enum"])}`);
    if ("const" in schema && !deepEqual(schema["const"], v)) errors.push(`${at}: ${JSON.stringify(v)} does not equal ${JSON.stringify(schema["const"])}`);
    if (isNumber(schema["minimum"]) && isNumber(v) && v < schema["minimum"]) errors.push(`${at}: ${JSON.stringify(v)} is less than minimum ${schema["minimum"]}`);
    if (isNumber(schema["maximum"]) && isNumber(v) && v > schema["maximum"]) errors.push(`${at}: ${JSON.stringify(v)} is greater than maximum ${schema["maximum"]}`);
    if (isNumber(schema["exclusiveMinimum"]) && isNumber(v) && v <= schema["exclusiveMinimum"]) errors.push(`${at}: ${JSON.stringify(v)} is less than or equal to exclusiveMinimum ${schema["exclusiveMinimum"]}`);
    if (isNumber(schema["minLength"]) && typeof v === "string" && Array.from(v).length < schema["minLength"]) errors.push(`${at}: string length ${Array.from(v).length} is less than minLength ${schema["minLength"]}`);
    if (isNumber(schema["maxItems"]) && Array.isArray(v) && v.length > schema["maxItems"]) errors.push(`${at}: array length ${v.length} is greater than maxItems ${schema["maxItems"]}`);
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
      const patterns = (schema["patternProperties"] ?? {}) as Readonly<Record<string, Schema>>;
      if (Array.isArray(schema["required"])) for (const r of schema["required"] as string[]) if (!(r in obj)) errors.push(`${at}: missing ${r}`);
      for (const [k, child] of Object.entries(obj)) {
        if (k in props) {
          check(props[k]!, child, `${at}.${k}`);
          continue;
        }
        let matched = false;
        for (const [pattern, sub] of Object.entries(patterns)) {
          if (new RegExp(pattern).test(k)) {
            check(sub, child, `${at}.${k}`);
            matched = true;
          }
        }
        if (!matched && schema["additionalProperties"] !== undefined) check(schema["additionalProperties"] as Schema, child, `${at}.${k}`);
      }
    }
    if (typeOf(v) === "array" && schema["items"] !== undefined) (v as unknown[]).forEach((item, i) => check(schema["items"] as Schema, item, `${at}[${i}]`));
  };
  check(start, value, "$");
  return errors;
}
