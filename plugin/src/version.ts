import pkg from "../package.json" with { type: "json" };

/** This plugin's version: `version` in plugin/package.json. */
export const PLUGIN_VERSION: string = pkg.version;
