// babel-plugin-istanbul 8.0.0 ships no type declarations; it is a Babel plugin object.
declare module "babel-plugin-istanbul" {
  import type { PluginTarget } from "@babel/core";
  const plugin: PluginTarget;
  export default plugin;
}
