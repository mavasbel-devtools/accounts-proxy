/**
 * Authoritative isolation proof: run a shell inside the sandbox before the client and assert the isolation contract
 * from the inside.
 *
 * The fingerprint comparison in run.ts is advisory (a live opencode session on the host writes to those directories
 * constantly); this probe is the part that cannot be fooled by host activity. It checks, in the sandbox:
 *  - no guarded real path exists, and its parent is not writable;
 *  - the operator's home is not mounted;
 *  - the account name, hostname and machine id are the profile's, not the operator's.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { buildBwrapArgv } from "@accounts-proxy/scripts/recon/sandbox/bwrap.ts";
import type { SandboxSpec } from "@accounts-proxy/scripts/recon/sandbox/types.ts";

/** Shell program run inside the sandbox; `$1` home, `$2` hostname, `$3` machine id, the rest are guarded paths. */
const PROBE_SCRIPT = `
host_home=$1
expected_hostname=$2
expected_machine_id=$3
shift 3
leak=0
for path do
  case "$path" in
    FORBIDDEN:*)
      # Paths that must simply not be visible (another display's socket). The directory they would live in is the
      # sandbox's own tmpfs, so its writability says nothing.
      path=\${path#FORBIDDEN:}
      if [ -e "$path" ]; then
        echo "LEAK exists $path"
        leak=1
      fi
      continue
      ;;
  esac
  if [ -e "$path" ]; then
    echo "LEAK exists $path"
    leak=1
  fi
  parent=$(dirname "$path")
  if [ -w "$parent" ]; then
    echo "LEAK writable-parent $parent"
    leak=1
  fi
done
if [ -e "$host_home" ]; then
  echo "LEAK host-home $host_home"
  leak=1
fi

account=$(id -un 2>/dev/null)
if [ "$account" != "recon" ]; then
  echo "LEAK account $account"
  leak=1
fi

host=$(hostname 2>/dev/null)
if [ "$host" != "$expected_hostname" ]; then
  echo "LEAK hostname $host"
  leak=1
fi

machine=$(cat /etc/machine-id 2>/dev/null)
if [ "$machine" != "$expected_machine_id" ]; then
  echo "LEAK machine-id $machine"
  leak=1
fi

# The run CA must be trusted by stacks that read the platform store rather than an environment variable (the Go
# language server is one). The merged bundle is bound over the host path, so containment is the assertion.
ca=/recon-ca.pem
bundle=/etc/ssl/certs/ca-certificates.crt
if [ ! -f "$ca" ]; then
  echo "LEAK ca-missing $ca"
  leak=1
elif [ -f "$bundle" ]; then
  ca_body=$(sed -n '2p' "$ca")
  if ! grep -qF "$ca_body" "$bundle"; then
    echo "LEAK ca-not-in-system-bundle"
    leak=1
  fi
fi

if [ ! -w "$HOME" ]; then
  echo "LEAK home-not-writable $HOME"
  leak=1
fi
exit $leak
`.trim();

/** Result of the in-sandbox probe. */
export interface IsolationProbe {
  readonly ok: boolean;
  readonly leaks: readonly string[];
}

/** Run the probe with the same binds and environment as the client, but a shell instead of the client. */
export function probeIsolation(
  spec: SandboxSpec,
  guards: readonly string[],
  machineId: string,
  forbidden: readonly string[] = [],
): IsolationProbe {
  const probeSpec: SandboxSpec = {
    ...spec,
    command: ["/bin/sh", "-c", PROBE_SCRIPT, "probe", homedir(), spec.hostname, machineId, ...guards, ...forbidden],
  };
  const argv = buildBwrapArgv(probeSpec);
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 30_000 });
  const leaks = `${result.stdout}${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("LEAK"));
  return { ok: result.status === 0 && leaks.length === 0, leaks };
}
