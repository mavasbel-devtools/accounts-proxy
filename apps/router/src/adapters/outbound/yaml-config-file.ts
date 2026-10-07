// router.yaml reader. Parser: Bun.YAML (built into Bun 1.4.2 — measured 2026-10-07, docs/temp probe), so no YAML
// dependency is added. A missing file yields undefined (= every provider disabled); a syntax error is a ConfigError.
import { readFile } from "node:fs/promises";
import { ConfigError } from "@inference-router/core/domain/config.ts";
import { ConfigSourcePort } from "@inference-router/core/ports/outbound/config.ts";

export type YamlParser = (text: string) => unknown;
const bunYaml: YamlParser = (text) => Bun.YAML.parse(text);

export class YamlConfigFile extends ConfigSourcePort {
  constructor(
    private readonly path: string,
    private readonly parse: YamlParser = bunYaml,
  ) {
    super();
  }

  async read(): Promise<unknown> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      return this.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (error) {
      throw new ConfigError(`YAML syntax error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
