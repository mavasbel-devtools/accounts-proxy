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
    expect(() => validate({ type: "string", prefixItems: [] }, "")).toThrow("$: unsupported schema keyword prefixItems");
    expect(() => validate({ type: ["string", "null"] }, null)).toThrow('$: unsupported type ["string","null"]');
  });

  test("$comment is an ignored annotation", () => {
    expect(validate({ $comment: "anything goes here", type: "integer" }, 1)).toEqual([]);
  });

  test("$comment does not excuse an invalid value", () => {
    expect(validate({ $comment: "anything goes here", type: "integer" }, "x")).toEqual(["$: expected integer, got string"]);
  });

  test("const passes a deep-equal value", () => {
    expect(validate({ const: "radius" }, "radius")).toEqual([]);
    expect(validate({ const: { a: [1, 2] } }, { a: [1, 2] })).toEqual([]);
  });

  test("const fails a different value", () => {
    expect(validate({ const: "radius" }, "other")).toEqual(['$: "other" does not equal "radius"']);
    expect(validate({ const: { a: [1, 2] } }, { a: [1, 3] })).toEqual(['$: {"a":[1,3]} does not equal {"a":[1,2]}']);
  });

  test("minimum passes a value at or above the bound", () => {
    expect(validate({ type: "integer", minimum: 1 }, 1)).toEqual([]);
    expect(validate({ type: "integer", minimum: 1 }, 2)).toEqual([]);
  });

  test("minimum fails a value below the bound", () => {
    expect(validate({ type: "integer", minimum: 1 }, 0)).toEqual(["$: 0 is less than minimum 1"]);
  });

  test("maximum passes a value at or below the bound", () => {
    expect(validate({ type: "integer", maximum: 100 }, 100)).toEqual([]);
    expect(validate({ type: "integer", maximum: 100 }, 99)).toEqual([]);
  });

  test("maximum fails a value above the bound", () => {
    expect(validate({ type: "integer", maximum: 100 }, 101)).toEqual(["$: 101 is greater than maximum 100"]);
  });

  test("exclusiveMinimum passes a value strictly above the bound", () => {
    expect(validate({ type: "number", exclusiveMinimum: 0 }, 0.5)).toEqual([]);
  });

  test("exclusiveMinimum fails a value at or below the bound", () => {
    expect(validate({ type: "number", exclusiveMinimum: 0 }, 0)).toEqual(["$: 0 is less than or equal to exclusiveMinimum 0"]);
    expect(validate({ type: "number", exclusiveMinimum: 0 }, -1)).toEqual(["$: -1 is less than or equal to exclusiveMinimum 0"]);
  });

  test("minLength passes a string with enough code points", () => {
    expect(validate({ type: "string", minLength: 1 }, "a")).toEqual([]);
    expect(validate({ type: "string", minLength: 1 }, "\u{1F600}")).toEqual([]);
  });

  test("minLength fails a shorter string", () => {
    expect(validate({ type: "string", minLength: 1 }, "")).toEqual(["$: string length 0 is less than minLength 1"]);
  });

  test("maxItems passes an array within the bound", () => {
    expect(validate({ type: "array", maxItems: 2 }, [1, 2])).toEqual([]);
  });

  test("maxItems fails a longer array", () => {
    expect(validate({ type: "array", maxItems: 2 }, [1, 2, 3])).toEqual(["$: array length 3 is greater than maxItems 2"]);
  });

  test("patternProperties checks each matching property and additionalProperties skips matched ones", () => {
    const schema = { type: "object", properties: { a: { type: "integer" } }, patternProperties: { "^x-": { type: "string" } }, additionalProperties: false };
    expect(validate(schema, { a: 1, "x-foo": "s" })).toEqual([]);
  });

  test("patternProperties fails a mismatched property and additionalProperties still guards the rest", () => {
    const schema = { type: "object", properties: { a: { type: "integer" } }, patternProperties: { "^x-": { type: "string" } }, additionalProperties: false };
    expect(validate(schema, { a: 1, "x-foo": 2 })).toEqual(["$.x-foo: expected string, got integer"]);
    expect(validate(schema, { a: 1, other: true })).toEqual(["$.other: not allowed"]);
  });
});
