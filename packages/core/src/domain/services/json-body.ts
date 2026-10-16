import { InvalidRequestError } from "@accounts-proxy/core/domain/errors.ts";

/** A client request body parsed as JSON; anything unparsable is a 400 invalid_request_error. */
export function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidRequestError("request body is not valid JSON");
  }
}
