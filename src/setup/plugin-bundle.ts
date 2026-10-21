/**
 * The plugin as this binary carries it: a gzip tar of `plugin/` and `.omp-plugin/marketplace.json`, which is what
 * `omp plugin marketplace add` reads. `null` in a checkout and under test. `scripts/release.ts` replaces this whole
 * module for a release build (`embedPluginPlugin`, the way `scripts/embed-natives.ts` replaces the SDK's addon module),
 * so it must stay free of anything but `bundledPlugin`; the file on disk is never modified. Keep the export in step
 * with `pluginBundleSource` there.
 */
export interface BundledPlugin {
	/** A path `Bun.file` can read: inside a compiled binary, the embedded tar. */
	tar: string;
}

export const bundledPlugin: BundledPlugin | null = null;
