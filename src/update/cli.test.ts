import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMain } from "./install";
import { updateMain } from "./cli";
import { CHECKOUT_MESSAGE } from "./policy";

let dir: string;
let config: string;
let out: string[];
let err: string[];
let restoreEnv: string | undefined;
let logSpy: Mock<typeof console.log>;
let errorSpy: Mock<typeof console.error>;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-ucli-"));
	config = join(dir, "service.json");
	await Bun.write(
		config,
		JSON.stringify({
			listen: "127.0.0.1:18080",
			apiTokenSha256: "0".repeat(64),
			dataDir: join(dir, "data"),
			vmon: { url: "http://127.0.0.1:1", keyFile: join(dir, "vmon.key"), template: "omp-agent" },
			gateway: { url: "http://127.0.0.2:2", clientsFile: join(dir, "clients.json") },
			broker: { url: "http://127.0.0.1:3", tokenFile: join(dir, "broker.token") },
			models: { default: "fake/fake-model" },
		}),
	);
	out = [];
	err = [];
	logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
	errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void err.push(args.join(" ")));
	restoreEnv = process.env.OMP_CLOUD_APP_DIR;
	process.env.OMP_CLOUD_APP_DIR = join(dir, "app");
});
afterEach(async () => {
	// A spy left installed hands its calls to the next file's spyOn of the same method.
	logSpy.mockRestore();
	errorSpy.mockRestore();
	if (restoreEnv === undefined) delete process.env.OMP_CLOUD_APP_DIR;
	else process.env.OMP_CLOUD_APP_DIR = restoreEnv;
	await rm(dir, { recursive: true, force: true });
});

describe("omp-cloud update", () => {
	test("--help and -h print the usage on stdout and exit 0; an unknown flag is still exit 2 with the usage on stderr", async () => {
		for (const flag of ["--help", "-h"]) {
			out.length = 0;
			expect(await updateMain([flag])).toBe(0);
			expect(out.join("\n")).toStartWith("usage: omp-cloud update");
		}
		expect(await updateMain(["--nope"])).toBe(2);
		expect(err.join("\n")).toContain('unknown or incomplete argument "--nope"');
		expect(err.join("\n")).toContain("usage: omp-cloud update");
	});

	test("from a checkout it says so, names the way to update and exits 1; apply does the same, and neither touches the network or the app dir", async () => {
		expect(await updateMain(["--config", config])).toBe(1);
		expect(out.join("\n")).toContain("state: unsupported");
		expect(out.join("\n")).toContain(CHECKOUT_MESSAGE);
		out.length = 0;
		expect(await updateMain(["apply", "--config", config])).toBe(1);
		expect(out.join("\n")).toContain(CHECKOUT_MESSAGE);
		expect(await Bun.file(join(dir, "app", "state.json")).exists()).toBe(false);
	});

	test("bad arguments are exit 2 with the usage", async () => {
		for (const args of [["--bogus"], ["--config"], ["apply", "--version", "0.5.1"], ["apply-staged", "--config", config], ["apply-staged", "--version", "v0.5.1", "--config", config], ["apply-staged", "--version", "0.5.1"]]) {
			err.length = 0;
			expect([args, await updateMain(args)]).toEqual([args, 2]);
			expect(err.join("\n")).toContain("usage: omp-cloud update");
		}
	});

	test("a service.json that cannot be read is exit 1 with the reason", async () => {
		expect(await updateMain(["--config", join(dir, "missing.json")])).toBe(1);
		expect(err.join("\n")).toMatch(/^omp-cloud: /);
	});

	test("apply-staged with nothing staged fails without touching anything and says why", async () => {
		expect(await updateMain(["apply-staged", "--version", "0.5.1", "--config", config])).toBe(1);
	});
});

describe("omp-cloud install", () => {
	test("run from bun it needs a release binary; unknown arguments and a missing value are errors", async () => {
		expect(await installMain(["--config", config])).toBe(1);
		expect(err.join("\n")).toContain("run omp-cloud install from a release binary, or pass --from <binary>");
		err.length = 0;
		expect(await installMain(["--wat", "x"])).toBe(1);
		expect(err.join("\n")).toContain('unknown argument "--wat"');
		err.length = 0;
		expect(await installMain(["--from"])).toBe(1);
		expect(err.join("\n")).toContain("--from needs a value");
	});

	test("a --from that is not an omp-cloud is refused before anything is written", async () => {
		const fake = join(dir, "not-omp-cloud");
		await Bun.write(fake, "#!/bin/sh\necho hello\n");
		await Bun.spawn(["chmod", "755", fake]).exited;
		expect(await installMain(["--from", fake, "--config", config])).toBe(1);
		expect(err.join("\n")).toContain('does not print "omp-cloud <version>"');
		expect(await Bun.file(join(dir, "app", "manager.json")).exists()).toBe(false);
	});
});
