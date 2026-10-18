// The JSON Schema checker of the tests (tests/support/json-schema.ts): what it enforces, the references it resolves,
// and that it refuses a schema rule it does not know instead of passing the document.
import { describe, expect, test } from "bun:test";
import { validate } from "@accounts-proxy/test-support/json-schema.ts";

const OBJECT = { type: "object", required: ["a"], additionalProperties: false, properties: { a: { type: "integer" }, b: { type: "string", enum: ["x", "y"] } } };

describe("json-schema checker", () => {
  test("types, required, enum, additionalProperties, items", () => {
    expect(validate(OBJECT, { a: 1, b: "x" })).toEqual([]);
    expect(validate(OBJECT, { a: 1.5 })).toEqual(["$.a: expected integer, got number"]);
    expect(validate(OBJECT, { b: "z" })).toEqual(["$: missing a", '$.b: "z" not in ["x","y"]']);
    expect(validate(OBJECT, { a: 1, c: true })).toEqual(["$.c: not allowed"]);
    expect(validate({ type: "array", items: { type: "number" } }, [1, 2.5, "3"])).toEqual(["$[2]: expected number, got string"]);
    expect(validate({ type: "null" }, null)).toEqual([]);
  });

  test("anyOf and allOf", () => {
    const nullable = { anyOf: [{ type: "integer" }, { type: "null" }] };
    expect(validate(nullable, null)).toEqual([]);
    expect(validate(nullable, "x")).toEqual(["$: matches no anyOf alternative"]);
    expect(validate({ allOf: [{ type: "object" }, { required: ["k"] }] }, {})).toEqual(["$: missing k"]);
  });

  test("$ref to #/$defs and to #/components/schemas; a start schema inside a document", () => {
    expect(validate({ $defs: { n: { type: "integer" } }, $ref: "#/$defs/n" }, "x")).toEqual(["$: expected integer, got string"]);
    const document = { openapi: "3.1.0", components: { schemas: { Id: { type: "string" }, Pair: { type: "object", properties: { id: { $ref: "#/components/schemas/Id" } } } } } };
    expect(validate(document, { id: "a" }, { $ref: "#/components/schemas/Pair" })).toEqual([]);
    expect(validate(document, { id: 1 }, { $ref: "#/components/schemas/Pair" })).toEqual(["$.id: expected string, got integer"]);
    expect(() => validate(document, {}, { $ref: "#/components/schemas/Missing" })).toThrow("$: unresolved $ref #/components/schemas/Missing");
    expect(() => validate(true, {}, { $ref: "#/$defs/x" })).toThrow("$: unresolved $ref #/$defs/x");
    expect(() => validate({}, {}, { $ref: "#/other/x" })).toThrow("$: unresolved $ref #/other/x");
  });

  test("boolean schemas", () => {
    expect(validate(true, 1)).toEqual([]);
    expect(validate(false, 1)).toEqual(["$: not allowed"]);
  });

  test("an unknown keyword or a non-string type is refused, never ignored", () => {
    expect(() => validate({ type: "string", minLength: 1 }, "")).toThrow("$: unsupported schema keyword minLength");
    expect(() => validate({ type: ["string", "null"] }, null)).toThrow('$: unsupported type ["string","null"]');
  });
});
