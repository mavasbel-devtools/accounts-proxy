// Babel + istanbul instrumentation of workspace source files (packages/*/src, apps/*/src), shared by the unit
// preload and the e2e daemon preload. Bun's native coverage is not used: per the Bun 1.4.2 docs its threshold
// enforces only lines and functions, while this repository's gate is 100% lines/statements/functions/branches.
import { transformAsync } from "@babel/core";
import transformTypeScript from "@babel/plugin-transform-typescript";
import instrument from "babel-plugin-istanbul";
import { resolve } from "node:path";

declare global {
  var __coverage__: Record<string, unknown> | undefined;
}

export const repositoryRoot = resolve(import.meta.dir, "..", "..");
export const SOURCE_FILTER = /[\\/](?:packages|apps)[\\/][^\\/]+[\\/]src[\\/].+\.ts$/;

export function registerInstrumentation(name: string): void {
  Bun.plugin({
    name,
    setup(build) {
      build.onLoad({ filter: SOURCE_FILTER }, async (args) => {
        const transformed = await transformAsync(await Bun.file(args.path).text(), {
          filename: args.path,
          sourceMaps: "inline",
          sourceType: "module",
          plugins: [[transformTypeScript, { allowDeclareFields: true }], [instrument, { cwd: repositoryRoot }]],
        });
        if (!transformed?.code) throw new Error(`failed to instrument ${args.path}`);
        return { contents: transformed.code, loader: "js" };
      });
    },
  });
}
