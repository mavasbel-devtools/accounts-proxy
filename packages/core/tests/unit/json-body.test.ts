import { describe, expect, test } from "bun:test";
import { InvalidRequestError } from "@inference-router/core/domain/errors.ts";
import { parseJsonBody } from "@inference-router/core/domain/services/json-body.ts";

describe("parseJsonBody", () => {
  test("JSON is parsed; anything else is a 400", () => {
    expect(parseJsonBody('{"a":[1]}')).toEqual({ a: [1] });
    expect(() => parseJsonBody("{oops")).toThrow(new InvalidRequestError("request body is not valid JSON"));
  });
});
