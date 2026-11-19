// e2e harness for the pi extension (plan 2026-11-15-23-52 step 5.7): runs the real entry point in a
// child process under the e2e coverage preload, then calls each recorded refreshModels and prints a JSON
// summary to stdout. Runs with ACCOUNTS_PROXY_URL set and ACCOUNTS_PROXY_TOKEN unset; stdin stays open
// until the parent closes it, so a test can stop the daemon between run and refresh. Warnings are
// collected from stderr and forwarded. The child exits through its normal path so the preload writes
// coverage.
import extension from "@accounts-proxy/pi-extension/main/extension.ts";
import { buildExtension } from "@accounts-proxy/pi-extension/composition/extension-container.ts";
import type { PiExtensionApi } from "@accounts-proxy/pi-extension/composition/extension-container.ts";
import type { PiProviderConfig } from "@accounts-proxy/pi-extension/ports/outbound/pi-host.ts";

const registered: { readonly id: string; readonly config: PiProviderConfig }[] = [];
const warnings: string[] = [];
const api: PiExtensionApi = {
  registerProvider: (id, config) => void registered.push({ id, config }),
};

const originalWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
  warnings.push(String(chunk));
  return (originalWrite as (...parts: unknown[]) => boolean)(chunk, ...args);
}) as typeof process.stderr.write;

await extension(api);
console.error("PI_EXTENSION_HARNESS_READY");
await Bun.stdin.text();
const refresh: ({ readonly id: string; readonly models: string[] } | { readonly id: string; readonly error: string })[] = [];
for (const { id, config } of registered) {
  try {
    const models = await config.refreshModels!();
    refresh.push({ id, models: models.map((model) => model.id) });
  } catch (error) {
    refresh.push({ id, error: error instanceof Error ? error.message : String(error) });
  }
}
// The default-URL branch (unset ACCOUNTS_PROXY_URL): construction only — running it would dial the default port.
void buildExtension(api, {});
console.log(
  JSON.stringify({
    registered: registered.map((entry) => entry.id),
    models: Object.fromEntries(registered.map((entry) => [entry.id, entry.config.models.length])),
    warnings,
    refresh,
  }),
);
