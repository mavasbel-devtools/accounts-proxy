/** Raw configuration document (parsed YAML), or undefined when no configuration file exists. */
export abstract class ConfigSourcePort {
  abstract read(): Promise<unknown>;
}
