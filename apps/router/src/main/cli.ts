#!/usr/bin/env bun
// `inference-router` entry point: maps the process (argv, environment, terminal) onto the composition root.
import { main } from "../composition/container.ts";

process.exitCode = await main(process.argv.slice(2));
