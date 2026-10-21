import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installManaged, managedDropIn, type InstallInput } from "./install";
import { AppLayout, linkedVersion } from "./layout";
import { lines, recordingRunner } from "./test-support";
import type { CommandResult } from "./system";

let dir: string;
let input: InstallInput;
let binary: string;

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "omp-cloud-install-")));
	binary = join(dir, "downloaded", "omp-cloud");
	await Bun.write(binary, "#!/bin/sh\necho 'omp-cloud 0.5.1 (test)'\n");
	await chmod(binary, 0o755);
	input = {
		from: binary,
		configPath: join(dir, "cfg", "service.json"),
		unit: "omp-cloud",
		layout: new AppLayout(join(dir, "app")),
		binDir: join(dir, "bin"),
		unitDir: join(dir, "units"),
	};
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

interface UnitSetup {
	fragment: string;
	active: boolean;
	environment?: string;
}

function runnerFor(unit: UnitSetup, version = "omp-cloud 0.5.1 (test)\n") {
	return recordingRunner((argv): Partial<CommandResult> | undefined => {
		if (argv[1] === "version") return { stdout: version };
		if (argv[0] === "systemctl" && argv[2] === "show") {
			const property = argv[4];
			if (property === "FragmentPath") return { stdout: `${unit.fragment}\n` };
			if (property === "Environment") return { stdout: `${unit.environment ?? ""}\n` };
		}
		if (argv[0] === "systemctl" && argv[2] === "is-active") return { code: unit.active ? 0 : 3 };
		return undefined;
	});
}

describe("managedDropIn", () => {
	test("clears ExecStart, then starts the managed binary with the config", () => {
		const layout = new AppLayout("/app");
		expect(managedDropIn(layout, "/cfg/service.json")).toBe('[Service]\nWorkingDirectory=/app\nExecStart=\nExecStart="/app/bin/omp-cloud" serve --config /cfg/service.json\n');
	});
});

describe("installManaged", () => {
	test("copies the binary into versions/<v>, writes the marker, bin link and the shell link, and prints what it changed", async () => {
		const { run } = runnerFor({ fragment: "", active: false });
		const changes = await installManaged(input, run);

		const { layout } = input;
		expect((await stat(layout.versionBinary("0.5.1"))).mode & 0o777).toBe(0o755);
		expect(await readFile(layout.versionBinary("0.5.1"), "utf8")).toBe("#!/bin/sh\necho 'omp-cloud 0.5.1 (test)'\n");
		expect(JSON.parse(await readFile(layout.managerFile, "utf8"))).toEqual({ manager: "omp-cloud", name: "omp-cloud" });
		expect(await linkedVersion(layout)).toBe("0.5.1");
		expect(await readlink(join(input.binDir, "omp-cloud"))).toBe(layout.binLink);
		expect(JSON.parse(await readFile(layout.stateFile, "utf8"))).toMatchObject({ installed: "0.5.1" });
		expect(changes).toEqual([
			`wrote ${layout.managerFile}`,
			`installed ${layout.versionBinary("0.5.1")}`,
			`pointed ${layout.binLink} at 0.5.1`,
			`linked ${join(input.binDir, "omp-cloud")} to ${layout.binLink}`,
			`the unit omp-cloud is not loaded: start the service with ${layout.binLink} serve --config ${input.configPath}`,
		]);
	});

	test("running it again changes nothing", async () => {
		const unit = { fragment: join(input.unitDir, "omp-cloud.service"), active: true };
		await installManaged(input, runnerFor(unit).run);
		const again = runnerFor(unit);
		const changes = await installManaged(input, again.run);
		expect(changes).toEqual([`the unit omp-cloud already starts ${input.layout.binLink}`]);
		expect(lines(again.calls).some((line) => line.includes("restart") || line.includes("daemon-reload"))).toBe(false);
	});

	test("a binary that does not print omp-cloud <version> is refused and nothing is installed", async () => {
		const { run } = runnerFor({ fragment: "", active: false }, "bun 1.4.3\n");
		await expect(installManaged(input, run)).rejects.toThrow("does not print \"omp-cloud <version>\" for its version command");
		await expect(lstat(input.layout.dir)).rejects.toThrow();
		await expect(lstat(join(input.binDir, "omp-cloud"))).rejects.toThrow();
	});

	test("installing the binary that already is versions/<v>/omp-cloud copies nothing", async () => {
		const { layout } = input;
		await installManaged(input, runnerFor({ fragment: "", active: false }).run);
		const again = await installManaged({ ...input, from: layout.versionBinary("0.5.1") }, runnerFor({ fragment: "", active: false }).run);
		expect(again.some((change) => change.startsWith("installed"))).toBe(false);
	});

	test("a persistent unit gets a drop-in, a daemon-reload and a restart when it runs", async () => {
		const unit = { fragment: join(input.unitDir, "omp-cloud.service"), active: true };
		const { run, calls } = runnerFor(unit);
		const changes = await installManaged(input, run);

		const dropIn = join(input.unitDir, "omp-cloud.service.d", "managed.conf");
		expect(await readFile(dropIn, "utf8")).toBe(managedDropIn(input.layout, input.configPath));
		expect(changes.slice(-2)).toEqual([`wrote ${dropIn} (the unit omp-cloud now starts ${input.layout.binLink})`, "restarted omp-cloud"]);
		const sequence = lines(calls).filter((line) => /daemon-reload|restart/.test(line));
		expect(sequence).toEqual(["systemctl --user daemon-reload", "systemctl --user restart omp-cloud"]);
	});

	test("a persistent unit that is not running is configured but not started", async () => {
		const { run, calls } = runnerFor({ fragment: join(input.unitDir, "omp-cloud.service"), active: false });
		const changes = await installManaged(input, run);
		expect(changes.some((change) => change.startsWith("restarted"))).toBe(false);
		expect(lines(calls).some((line) => line.includes("restart"))).toBe(false);
	});

	test("a transient unit is stopped and started again on the managed binary, keeping its whole Environment", async () => {
		const environment = 'HOME=/tmp/h PATH=/opt/bun:/usr/bin OMP_CLOUD_CONFIG=/tmp/h/service.json "EXTRA=two words" LANG=C';
		const { run, calls } = runnerFor({ fragment: "/run/user/1000/systemd/transient/omp-cloud.service", active: true, environment });
		const changes = await installManaged(input, run);

		expect(changes.at(-1)).toBe(`restarted the transient unit omp-cloud on ${input.layout.binLink} serve --config ${input.configPath}`);
		const sequence = lines(calls).filter((line) => /stop|systemd-run/.test(line));
		expect(sequence).toEqual([
			"systemctl --user stop omp-cloud",
			`systemd-run --user --unit=omp-cloud --property Description=omp-cloud service --setenv=HOME=/tmp/h --setenv=PATH=/opt/bun:/usr/bin --setenv=OMP_CLOUD_CONFIG=/tmp/h/service.json --setenv=EXTRA=two words --setenv=LANG=C --setenv=OMP_CLOUD_APP_DIR=${input.layout.dir} ${input.layout.binLink} serve --config ${input.configPath}`,
		]);
	});

	test("a transient unit that is not running is left alone, with the command to start it", async () => {
		const { run, calls } = runnerFor({ fragment: "/run/user/1000/systemd/transient/omp-cloud.service", active: false });
		const changes = await installManaged(input, run);
		expect(changes.at(-1)).toBe(`the transient unit omp-cloud is not running: start the service with ${input.layout.binLink} serve --config ${input.configPath}`);
		expect(lines(calls).some((line) => line.includes("systemd-run") || line.includes("stop"))).toBe(false);
	});

	test("replaces an old ~/.local/bin/omp-cloud wrapper with the link, and leaves a link that is right", async () => {
		await Bun.write(join(input.binDir, "omp-cloud"), "#!/bin/sh\nexec bun src/cli.ts\n");
		await writeFile(join(dir, "marker"), "x");
		const first = await installManaged(input, runnerFor({ fragment: "", active: false }).run);
		expect(first).toContain(`linked ${join(input.binDir, "omp-cloud")} to ${input.layout.binLink}`);
		expect(await readlink(join(input.binDir, "omp-cloud"))).toBe(input.layout.binLink);
		const second = await installManaged(input, runnerFor({ fragment: "", active: false }).run);
		expect(second.some((change) => change.startsWith("linked"))).toBe(false);
	});
});
