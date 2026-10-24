import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/** The root scripts in `infra/` pass shellcheck (pinned by mise); skipped where shellcheck is missing, like `test/install-sh.test.ts`. */
describe.each(["vmon-install.sh", "vmon-sync.sh"])("infra/%s", name => {
	test.skipIf(Bun.which("shellcheck") === null)("passes shellcheck -s bash", async () => {
		const proc = Bun.spawn(["shellcheck", "-s", "bash", join(import.meta.dir, "..", "..", "infra", name)], { stdout: "pipe", stderr: "pipe" });
		const out = await new Response(proc.stdout).text();
		expect({ code: await proc.exited, out }).toEqual({ code: 0, out: "" });
	});
});
