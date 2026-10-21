import { expect, test } from "bun:test";
import { join } from "node:path";
import { isRecord } from "../src/guards";

const REPO = join(import.meta.dir, "..", "..");

/** A marketplace install reads `.omp-plugin/marketplace.json`; a link reads `plugin/package.json`. Both must describe the same plugin. */
test("the marketplace entry names the plugin package and its version, and points at it", async () => {
	const marketplace: unknown = await Bun.file(join(REPO, ".omp-plugin", "marketplace.json")).json();
	const pkg: unknown = await Bun.file(join(REPO, "plugin", "package.json")).json();
	if (!isRecord(marketplace) || !Array.isArray(marketplace.plugins) || !isRecord(pkg)) throw new Error("unexpected manifest shape");
	const entries = marketplace.plugins.filter(isRecord);
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({ name: pkg.name, version: pkg.version, source: "./plugin" });
});
