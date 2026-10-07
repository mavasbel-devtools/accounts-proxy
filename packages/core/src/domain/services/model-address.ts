import { UnknownModelError } from "@inference-router/core/domain/errors.ts";
import { isProviderId, type ModelAddress } from "@inference-router/core/domain/models.ts";

export type AliasTable = Readonly<Record<string, string>>;

/**
 * Resolve a client-supplied model string. `<provider>/<model>` splits on the FIRST slash (model ids may
 * contain further slashes). A bare name is looked up in the alias table, whose values must themselves be
 * `<provider>/<model>`. Anything else is an UnknownModelError — never a guess.
 */
export function resolveModelAddress(input: string, aliases: AliasTable): ModelAddress {
  const direct = splitAddress(input);
  if (direct) return direct;
  const target = Object.hasOwn(aliases, input) ? aliases[input] : undefined;
  const aliased = target === undefined ? undefined : splitAddress(target);
  if (aliased) return aliased;
  throw new UnknownModelError(input);
}

function splitAddress(value: string): ModelAddress | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (!isProviderId(provider) || model.trim() === "") return undefined;
  return { provider, model };
}
