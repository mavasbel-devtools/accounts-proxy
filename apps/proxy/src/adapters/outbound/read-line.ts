// One line from a readline interface. Standard input that ends before a line was entered ends the prompt with an error:
// readline's question() alone never settles then, and the login would wait forever.
import type { Interface } from "node:readline/promises";
import { InvalidRequestError } from "@accounts-proxy/core/domain/errors.ts";

export function readLine(rl: Interface, query: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    rl.once("close", () => reject(new InvalidRequestError("standard input ended before a line was entered")));
    rl.question(query).then(resolve, reject);
  });
}
