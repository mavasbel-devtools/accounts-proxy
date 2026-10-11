// The `xdg-open` the e2e daemon finds first on PATH: it records the authorization URL it was given and behaves like
// a user who approves — it calls the loopback redirect with a code and the URL's own state.
import { appendFileSync } from "node:fs";

const authorize = new URL(process.argv[2]!);
appendFileSync(process.env["INFERENCE_ROUTER_E2E_BROWSER_LOG"]!, `${authorize.toString()}\n`);
const params = authorize.searchParams;
await fetch(`${params.get("redirect_uri")}?code=e2e-code&state=${encodeURIComponent(params.get("state")!)}`, { redirect: "manual" });
