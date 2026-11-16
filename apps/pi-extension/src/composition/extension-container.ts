// Wires the pi extension's runtime graph (architecture design §5): HTTP discovery against
// ACCOUNTS_PROXY_URL (default http://127.0.0.1:4141), the token from the manifest's command via
// node:child_process execFile (no shell), and pi itself as the host. Runs inside pi's Node.js
// process: node:* modules and Node.js globals only, no Bun API.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PiExtensionApi } from "@accounts-proxy/pi-extension/adapters/outbound/extension-pi-host.ts";
import { ExtensionPiHost } from "@accounts-proxy/pi-extension/adapters/outbound/extension-pi-host.ts";
import { ExecTokenSource } from "@accounts-proxy/pi-extension/adapters/outbound/exec-token-source.ts";
import { HttpProxyDiscovery } from "@accounts-proxy/pi-extension/adapters/outbound/http-proxy-discovery.ts";
import { RegisterProvidersService } from "@accounts-proxy/pi-extension/application/register-providers.ts";

export type { PiExtensionApi };

const DEFAULT_URL = "http://127.0.0.1:4141";

export function buildExtension(api: PiExtensionApi, env: NodeJS.ProcessEnv): RegisterProvidersService {
  const discovery = new HttpProxyDiscovery(globalThis.fetch, env.ACCOUNTS_PROXY_URL ?? DEFAULT_URL);
  const tokens = new ExecTokenSource(promisify(execFile));
  const host = new ExtensionPiHost(api, env, process.stderr);
  return new RegisterProvidersService(discovery, tokens, host);
}
