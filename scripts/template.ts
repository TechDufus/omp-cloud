/**
 * `mise run template [version]`: build the vmon template `omp-agent:<version>-<recipe hash>` by hand (the service builds a missing
 * one on first use). Without an argument it builds the owner's omp version (`hostOmp()`: Tern's managed install, else
 * PATH). vmon's connection comes from ~/.config/omp-cloud/vmon.key (written by `omp-cloud setup`; see dev/env.ts).
 */
import "../dev/env";
import { hostOmp } from "../src/omp-version";
import { installedVmonVersion } from "../src/vmon/pin";
import { DEFAULT_RECIPE } from "../src/vmon/recipe";
import { buildTemplate, templateName } from "../src/vmon/template";

const BASE = "omp-agent";

const version = process.argv[2] ?? (await hostOmp()).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
	console.error(`the omp version must be <major>.<minor>.<patch>, got ${JSON.stringify(version)}`);
	process.exit(1);
}
const name = await templateName(BASE, version, await installedVmonVersion(), DEFAULT_RECIPE);
const seconds = await buildTemplate(name, version, DEFAULT_RECIPE, {}, true);
console.log(`template ${name} built in ${seconds.toFixed(1)} s`);
