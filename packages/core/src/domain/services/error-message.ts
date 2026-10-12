/**
 * The message of a caught error. Every throw in this code base is an Error subclass, and so is every rejection of the
 * runtime APIs it calls (fetch, node:fs, node:http, JSON.parse, Bun.YAML): a caught value is read as an Error.
 */
export function errorMessage(error: unknown): string {
  return (error as Error).message;
}
