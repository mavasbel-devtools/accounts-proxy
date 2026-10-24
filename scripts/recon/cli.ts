/**
 * Recon CLI (plan 2026-10-19-20-04): `bun scripts/recon/cli.ts help` lists the commands, `help <command>` describes
 * one. The commands and their help are in scripts/recon/cli/commands.ts; the operations in cli/live-actions.ts.
 *
 * `isolation` is the acceptance check: every client is launched for real inside its sandbox with a fast command, the
 * in-sandbox probe must report no leak, and the guard must report no change to the real client directories.
 */
import { CommandLineDriver } from "@accounts-proxy/proxy/adapters/inbound/cli/command-line-driver.ts";
import { RECON_PROGRAM, reconCommands } from "@accounts-proxy/scripts/recon/cli/commands.ts";
import { LiveReconActions } from "@accounts-proxy/scripts/recon/cli/live-actions.ts";

const driver = new CommandLineDriver(
  reconCommands(new LiveReconActions()),
  RECON_PROGRAM,
  (text) => void process.stdout.write(text),
  (text) => void process.stderr.write(text),
);
process.exit(await driver.run(process.argv.slice(2)));
