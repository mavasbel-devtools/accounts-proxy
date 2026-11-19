// The pi extension's entry point (architecture design §5): pi awaits this factory at startup and
// applies the provider registrations once it resolves. Imports composition only (main → composition).
import { buildExtension, type PiExtensionApi } from "@accounts-proxy/pi-extension/composition/extension-container.ts";

export default async function (pi: PiExtensionApi): Promise<void> {
  await buildExtension(pi, process.env).run();
}
