// The `xdg-open` the e2e daemon finds first on PATH. It records the authorization URL it was given, then acts like the
// user chosen by ACCOUNTS_PROXY_E2E_BROWSER_MODE:
//   approve (default)  calls the loopback redirect with a code and the URL's own state
//   deny               the user refuses: error=access_denied with a description
//   deny-bare          the user refuses: error=access_denied without a description
//   wrong-state        a callback whose state does not match (a forged redirect)
//   no-code            a callback with the right state and no code
//   wrong-path-twice   first a request to another path (404), then approves twice (the second gets 409)
//   ignore             never calls back (the login times out)
//   approve-registration  approves a new ChatGPT registration: the callback also carries the issued client id
//                      (ACCOUNTS_PROXY_E2E_ISSUED_CLIENT, default oaiapp_e2e; Sign in with ChatGPT S2, S9)
import { appendFileSync } from "node:fs";

const authorize = new URL(process.argv[2]!);
appendFileSync(process.env["ACCOUNTS_PROXY_E2E_BROWSER_LOG"]!, `${authorize.toString()}\n`);
const params = authorize.searchParams;
// OAuth providers name the loopback `redirect_uri`; OpenRouter's PKCE page names it `callback_url` (rule R5).
const redirect = (params.get("redirect_uri") ?? params.get("callback_url"))!;
const state = encodeURIComponent(params.get("state")!);
const visit = (url: string) => fetch(url, { redirect: "manual" }).then((res) => appendFileSync(process.env["ACCOUNTS_PROXY_E2E_BROWSER_LOG"]!, `callback ${res.status}\n`));

switch (process.env["ACCOUNTS_PROXY_E2E_BROWSER_MODE"] ?? "approve") {
  case "deny":
    await visit(`${redirect}?error=access_denied&error_description=${encodeURIComponent("The user denied access")}&state=${state}`);
    break;
  case "deny-bare":
    await visit(`${redirect}?error=access_denied&state=${state}`);
    break;
  case "wrong-state":
    await visit(`${redirect}?code=e2e-code&state=forged`);
    break;
  case "no-code":
    await visit(`${redirect}?state=${state}`);
    break;
  case "wrong-path-twice": {
    await visit(`${new URL(redirect).origin}/elsewhere`);
    await Promise.all([visit(`${redirect}?code=e2e-code&state=${state}`), visit(`${redirect}?code=e2e-code&state=${state}`)]);
    break;
  }
  case "ignore":
    break;
  case "approve-registration":
    await visit(`${redirect}?code=e2e-code&state=${state}&client_id=${encodeURIComponent(process.env["ACCOUNTS_PROXY_E2E_ISSUED_CLIENT"] ?? "oaiapp_e2e")}`);
    break;
  default:
    await visit(`${redirect}?code=e2e-code&state=${state}`);
}
