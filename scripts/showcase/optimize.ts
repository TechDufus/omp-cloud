/**
 * Optimizes the captures: every `docs/assets/src/{dashboard,tui,tern}-*.png` to `docs/assets/<same name>`, lossless,
 * with oxipng (`bun scripts/showcase/optimize.ts`). Runs the `OXIPNG` executable when set, else fetches one through mise
 * for the run (`mise x aqua:shssoichiro/oxipng@latest`), which changes no configuration.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./harness";

const SRC = join(REPO_ROOT, "docs/assets/src");
const OUT = join(REPO_ROOT, "docs/assets");
const PATTERN = /^(dashboard|tui|tern)-.+\.png$/;

const runner = process.env.OXIPNG === undefined ? ["mise", "x", "aqua:shssoichiro/oxipng@latest", "--", "oxipng"] : [process.env.OXIPNG];
if (!existsSync(SRC)) throw new Error(`${SRC} does not exist: it holds the raw captures and is not tracked; run capture-dashboard.ts and capture-tui.ts first`);
const names = readdirSync(SRC).filter(name => PATTERN.test(name));
for (const name of names) {
	const proc = Bun.spawn([...runner, "-o", "4", "--strip", "safe", "--quiet", "--out", join(OUT, name), join(SRC, name)], { stdout: "inherit", stderr: "inherit" });
	if ((await proc.exited) !== 0) throw new Error(`oxipng failed on ${name}`);
	console.log(`${name}: ${statSync(join(SRC, name)).size} -> ${statSync(join(OUT, name)).size} bytes`);
}
