#!/usr/bin/env bun
// `accounts-proxy` entry point: maps the process (argv, environment, terminal) onto the composition root.
import { main } from "@accounts-proxy/proxy/composition/container.ts";

process.exitCode = await main(process.argv.slice(2));
