import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateSettings } from "./db";
import { FeedError } from "./feed";
import { AppLayout } from "./layout";
import { AUTO_QUIET_MS, CHECKOUT_MESSAGE } from "./policy";
import { APPLY_UNIT, CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, UpdateConflict, UpdateService, type UpdateServiceDeps } from "./service";
import { StateStore } from "./state";
import { fakeFeed, fakeRelease, fakeVmon, lines, makeManifest, recordingRunner, releaseBytes, type FakeVmon } from "./test-support";

const T0 = Date.parse("2026-10-21T12:00:00Z");

let dir: string;
let layout: AppLayout;
let state: StateStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-service-"));
	layout = new AppLayout(join(dir, "app"));
	state = new StateStore(layout.stateFile, layout.lockFile, { sleep: async () => undefined });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

interface Harness {
	service: UpdateService;
	clock: { now: number };
	settings: UpdateSettings;
	calls: ReturnType<typeof recordingRunner>["calls"];
	feedCalls: { count: number };
	busy: { threads: number };
	vmon: FakeVmon;
	/** What the next `feed.latest()` answers. */
	answer: { current: { release: ReturnType<typeof fakeRelease> } | { failure: Error } };
	downloads: { count: number };
	tokens: string[];
}

function harness(over: Partial<UpdateServiceDeps> & { managed?: boolean; version?: string; latest?: string; failRun?: boolean; schema?: number; vmonInstalled?: string | null; unitEnvironment?: string } = {}): Harness {
	const clock = { now: T0 };
	const settings: UpdateSettings = { mode: "notify", feed: "github:TechDufus/omp-cloud", token: "", unit: "omp-cloud", ompUnits: ["omp-auth-broker", "omp-auth-gateway"] };
	const downloads = { count: 0 };
	const latest = over.latest ?? "0.5.1";
	const answer: Harness["answer"] = { current: { release: fakeRelease(makeManifest(latest), { downloads }) } };
	const { run, calls } = recordingRunner((argv) => {
		if (argv[1] === "version") return { stdout: `omp-cloud ${/\/versions\/([^/]+)\//.exec(argv[0] ?? "")?.[1] ?? latest} (test)\n` };
		if (argv[0] === "systemctl" && argv[4] === "Environment") return { stdout: `${over.unitEnvironment ?? ""}\n` };
		if (argv[0] === "systemd-run" && over.failRun === true) return { code: 1, stderr: "Unit omp-cloud-update.service already exists.\n" };
		if (argv[0] === "systemctl" && argv[2] === "show" && argv[4] === "MainPID") return { stdout: argv[argv.length - 1] === "omp-auth-broker" ? "4242\n" : "4343\n" };
		if (argv[0] === "/proc/4242/exe") return { stdout: "omp/18.12.3\n" };
		if (argv[0] === "/proc/4343/exe") return { stdout: "omp/18.12.2\n" };
		return undefined;
	});
	const feedCalls = { count: 0 };
	const busy = { threads: 0 };
	const vmon = fakeVmon({ installed: over.vmonInstalled });
	const tokens: string[] = [];
	const service = new UpdateService({
		layout,
		managed: over.managed ?? true,
		current: { version: over.version ?? "0.5.0", build: { id: "20261001000000-aaa", commit: "a", createdAt: "2026-10-01T00:00:00Z" } },
		state,
		settings: () => settings,
		token: async (reference) => {
			tokens.push(reference);
			return `resolved-${reference}`;
		},
		feed: () => ({
			latest: async () => {
				feedCalls.count++;
				return fakeFeed(answer.current).latest();
			},
		}),
		run,
		vmon,
		arch: "x86_64",
		ompHost: "18.12.3",
		schema: over.schema ?? 10,
		busyThreads: () => busy.threads,
		configPath: "/cfg/service.json",
		now: () => clock.now,
		log: () => undefined,
		...over,
	});
	return { service, clock, settings, calls, feedCalls, busy, vmon, answer, downloads, tokens };
}

describe("check", () => {
	test("a newer release is downloaded, verified, staged and the state is ready", async () => {
		const h = harness();
		expect((await h.service.summary()).state).toBe("idle");

		await h.service.check();

		const status = await h.service.status();
		expect(status).toMatchObject({
			mode: "notify",
			managed: true,
			state: "ready",
			current: { version: "0.5.0", build: { id: "20261001000000-aaa" } },
			latest: { version: "0.5.1", notes: "notes of 0.5.1", publishedAt: "2026-10-21T01:00:00Z" },
			staged: "0.5.1",
			applying: null,
			error: null,
			message: null,
			checkedAt: new Date(T0).toISOString(),
			last: null,
		});
		expect((await stat(layout.versionBinary("0.5.1"))).mode & 0o777).toBe(0o755);
		expect(await h.service.summary()).toEqual({ state: "ready", available: "0.5.1" });
		expect(h.downloads.count).toBe(1);
	});

	test("the feed credential is resolved from update.token and only when it is set", async () => {
		const h = harness();
		await h.service.check();
		expect(h.tokens).toEqual([]);
		h.settings.token = "!/usr/bin/gh auth token";
		await h.service.check();
		expect(h.tokens).toEqual(["!/usr/bin/gh auth token"]);
	});

	test("the same or an older release is idle: latest is kept, nothing is staged or downloaded", async () => {
		const h = harness({ latest: "0.5.0" });
		await h.service.check();
		expect(await h.service.status()).toMatchObject({ state: "idle", latest: { version: "0.5.0" }, staged: null, error: null });
		expect(await h.service.summary()).toEqual({ state: "idle", available: null });
		expect(h.downloads.count).toBe(0);
		const older = harness({ latest: "0.4.0", version: "0.5.0" });
		await older.service.check();
		expect((await older.service.status()).state).toBe("idle");
	});

	test("a release that is already staged and intact is not downloaded again", async () => {
		const h = harness();
		await h.service.check();
		await h.service.check();
		expect(h.downloads.count).toBe(1);
		expect(h.feedCalls.count).toBe(2);
		expect((await h.service.status()).state).toBe("ready");
	});

	test("a newer release replaces a staged older one", async () => {
		const h = harness();
		await h.service.check();
		h.answer.current = { release: fakeRelease(makeManifest("0.5.2"), { downloads: h.downloads }) };
		h.calls.length = 0;
		await h.service.check();
		expect((await h.service.status()).staged).toBe("0.5.2");
		expect(h.downloads.count).toBe(2);
	});

	test("a feed with no release (private without token) is idle, not a failure; latest is forgotten", async () => {
		const h = harness();
		await h.service.check();
		h.answer.current = { failure: new FeedError("none", "no release of TechDufus/omp-cloud is visible") };
		await h.service.check();
		expect(await h.service.status()).toMatchObject({ state: "idle", latest: null, error: null, checkedAt: new Date(T0).toISOString() });
	});

	test("a failed look at the feed is failed with its reason; once a release is staged a later failure does not hide it", async () => {
		const h = harness();
		h.answer.current = { failure: new FeedError("failed", "GitHub answered 500") };
		await h.service.check();
		expect(await h.service.status()).toMatchObject({ state: "failed", error: "GitHub answered 500", staged: null });
		expect((await h.service.summary()).available).toBeNull();

		h.answer.current = { release: fakeRelease(makeManifest("0.5.1"), { downloads: h.downloads }) };
		await h.service.check();
		expect((await h.service.status()).state).toBe("ready");
		h.answer.current = { failure: new FeedError("failed", "GitHub answered 502") };
		await h.service.check();
		expect(await h.service.status()).toMatchObject({ state: "ready", error: null, staged: "0.5.1" });
	});

	test("a download that fails verification is failed and nothing is staged", async () => {
		const h = harness();
		const manifest = makeManifest("0.5.1");
		h.answer.current = { release: fakeRelease(manifest, { bytes: releaseBytes("0.5.1", "omp-cloud 0.5.1 (tesz)"), downloads: h.downloads }) };
		await h.service.check();
		const status = await h.service.status();
		expect(status.state).toBe("failed");
		expect(status.error).toBe("the download does not match the SHA-256 in release.json");
		expect(status.staged).toBeNull();
		await expect(stat(layout.versionBinary("0.5.1"))).rejects.toThrow();
	});

	test("concurrent checks share one run, and the state says checking then downloading meanwhile", async () => {
		const h = harness();
		const seen: string[] = [];
		const first = h.service.check();
		seen.push((await h.service.summary()).state);
		const second = h.service.check();
		expect(second).toBe(first);
		await first;
		expect(h.feedCalls.count).toBe(1);
		expect(seen[0]).toBe("checking");
	});

	test("a checkout does not check at all: unsupported, with the explanation", async () => {
		const h = harness({ managed: false });
		await h.service.check();
		expect(h.feedCalls.count).toBe(0);
		expect(await h.service.status()).toMatchObject({ managed: false, state: "unsupported", message: CHECKOUT_MESSAGE, error: null, latest: null });
		expect(await h.service.summary()).toEqual({ state: "unsupported", available: null });
	});
});

describe("the hourly loop", () => {
	test("the first check runs after 60 s, then every hour; update.mode off never checks by itself", async () => {
		const h = harness();
		await h.service.tick();
		expect(h.feedCalls.count).toBe(0);
		h.clock.now = T0 + FIRST_CHECK_DELAY_MS;
		await h.service.tick();
		expect(h.feedCalls.count).toBe(1);
		h.clock.now += CHECK_INTERVAL_MS - 1;
		await h.service.tick();
		expect(h.feedCalls.count).toBe(1);
		h.clock.now += 1;
		await h.service.tick();
		expect(h.feedCalls.count).toBe(2);

		const off = harness();
		off.settings.mode = "off";
		off.clock.now = T0 + 5 * CHECK_INTERVAL_MS;
		await off.service.tick();
		expect(off.feedCalls.count).toBe(0);
		// An explicit check still works with the mode off.
		await off.service.check();
		expect(off.feedCalls.count).toBe(1);
	});

	test("notify mode never applies by itself", async () => {
		const h = harness();
		h.clock.now = T0 + FIRST_CHECK_DELAY_MS;
		await h.service.tick();
		h.clock.now += 2 * AUTO_QUIET_MS;
		await h.service.tick();
		expect(lines(h.calls).some((line) => line.startsWith("systemd-run"))).toBe(false);
	});
});

describe("auto", () => {
	async function ready(h: Harness): Promise<void> {
		h.settings.mode = "auto";
		h.clock.now = T0 + FIRST_CHECK_DELAY_MS;
		await h.service.tick();
		expect((await h.service.status()).state).toBe("ready");
	}
	const applied = (h: Harness): boolean => lines(h.calls).some((line) => line.includes("systemd-run"));

	test("installs by itself once nothing was busy for 10 minutes and vibemon and the schema match", async () => {
		const h = harness();
		await ready(h);
		expect(applied(h)).toBe(false);
		expect(h.service.autoReason).toBe("a thread was busy less than 10 minutes ago");
		h.clock.now = T0 + AUTO_QUIET_MS + 1;
		await h.service.tick();
		expect(applied(h)).toBe(true);
		expect((await h.service.status()).applying).toMatchObject({ version: "0.5.1", step: "starting" });
	});

	test("a busy thread restarts the quiet period; waiting threads count", async () => {
		const h = harness();
		await ready(h);
		h.busy.threads = 1;
		h.clock.now = T0 + AUTO_QUIET_MS;
		await h.service.tick();
		h.busy.threads = 0;
		h.clock.now += AUTO_QUIET_MS - 1000;
		await h.service.tick();
		expect(applied(h)).toBe(false);
		h.clock.now += 1001;
		await h.service.tick();
		expect(applied(h)).toBe(true);
	});

	test("a release that needs another vibemon or a newer schema stays ready for a click", async () => {
		const other = harness({ vmonInstalled: "v0.3.0" });
		await ready(other);
		other.clock.now = T0 + 2 * AUTO_QUIET_MS;
		await other.service.tick();
		expect(applied(other)).toBe(false);
		expect(other.service.autoReason).toBe("the release needs vibemon v0.4.0, v0.3.0 is installed");
		expect((await other.service.status()).state).toBe("ready");

		const schema = harness({ schema: 9 });
		await ready(schema);
		schema.clock.now = T0 + 2 * AUTO_QUIET_MS;
		await schema.service.tick();
		expect(applied(schema)).toBe(false);
		expect(schema.service.autoReason).toBe("the release needs database schema 10, the database is at 9");
	});

	test("it does not retry over a failed apply", async () => {
		const h = harness();
		await ready(h);
		await state.update((file) => {
			file.error = "rolled back to 0.5.0";
		});
		h.clock.now = T0 + 2 * AUTO_QUIET_MS;
		await h.service.tick();
		expect(applied(h)).toBe(false);
	});
});

describe("restartingForUpdate", () => {
	const applying = (step: string, startedAt = T0) =>
		state.update((file) => {
			file.applying = { version: "0.5.1", step: step as "swap", startedAt: new Date(startedAt).toISOString(), from: "0.5.0", backup: "" };
		});

	test("is true while an apply is at swap or rollback: the two steps that restart the service", async () => {
		const h = harness();
		expect(await h.service.restartingForUpdate()).toBe(false);
		for (const step of ["starting", "backup", "vmon", "omp", "health"]) {
			await applying(step);
			expect([step, await h.service.restartingForUpdate()]).toEqual([step, false]);
		}
		for (const step of ["swap", "rollback"]) {
			await applying(step);
			expect([step, await h.service.restartingForUpdate()]).toEqual([step, true]);
		}
	});

	test("is false once the apply ended, and for an apply record whose applier is long gone", async () => {
		const h = harness();
		await applying("swap");
		await state.update((file) => {
			file.applying = null;
		});
		expect(await h.service.restartingForUpdate()).toBe(false);
		await applying("swap", T0 - 20 * 60_000);
		expect(await h.service.restartingForUpdate()).toBe(false);
	});
});

describe("apply", () => {
	test("starts the new binary's applier as the transient unit omp-cloud-update and records the start", async () => {
		const h = harness();
		await h.service.check();
		h.calls.length = 0;

		expect(await h.service.apply()).toEqual({ version: "0.5.1" });

		expect(lines(h.calls)).toEqual([
			"systemctl --user show -p Environment --value omp-cloud",
			`systemctl --user reset-failed ${APPLY_UNIT}`,
			`systemd-run --user --unit=${APPLY_UNIT} --collect --setenv=OMP_CLOUD_APP_DIR=${layout.dir} ${layout.versionBinary("0.5.1")} update apply-staged --version 0.5.1 --config /cfg/service.json`,
		]);
		const status = await h.service.status();
		expect(status.state).toBe("applying");
		expect(status.applying).toEqual({ version: "0.5.1", step: "starting", startedAt: new Date(T0).toISOString() });
		expect((await state.read()).applying).toMatchObject({ from: "0.5.0", backup: "" });
	});

	test("the applier gets the service unit's whole Environment as systemd reports it (HOME, PATH, anything else) plus the app dir; nothing from this process", async () => {
		const h = harness({ unitEnvironment: 'HOME=/tmp/h PATH=/opt/bun:/usr/bin OMP_CLOUD_CONFIG=/tmp/h/service.json "EXTRA=two words"' });
		await h.service.check();
		h.calls.length = 0;
		process.env.OMP_CLOUD_TEST_LEAK = "from-this-process";
		try {
			await h.service.apply();
		} finally {
			delete process.env.OMP_CLOUD_TEST_LEAK;
		}
		const launch = lines(h.calls).find((line) => line.startsWith("systemd-run")) ?? "";
		expect(launch).toBe(
			`systemd-run --user --unit=${APPLY_UNIT} --collect --setenv=HOME=/tmp/h --setenv=PATH=/opt/bun:/usr/bin --setenv=OMP_CLOUD_CONFIG=/tmp/h/service.json --setenv=EXTRA=two words --setenv=OMP_CLOUD_APP_DIR=${layout.dir} ${layout.versionBinary("0.5.1")} update apply-staged --version 0.5.1 --config /cfg/service.json`,
		);
		expect(launch).not.toContain("from-this-process");
	});

	test("is refused when nothing is ready, while another apply runs, and in a checkout", async () => {
		const idle = harness();
		await expect(idle.service.apply()).rejects.toThrow(new UpdateConflict("no update is ready"));
		expect(lines(idle.calls)).toEqual([]);

		const h = harness();
		await h.service.check();
		await h.service.apply();
		await expect(h.service.apply()).rejects.toThrow("omp-cloud 0.5.1 is already being installed");

		const checkout = harness({ managed: false });
		await expect(checkout.service.apply()).rejects.toThrow(CHECKOUT_MESSAGE);
	});

	test("is refused when the staged file is gone or damaged", async () => {
		const h = harness();
		await h.service.check();
		await Bun.write(layout.versionBinary("0.5.1"), "damaged");
		await expect(h.service.apply()).rejects.toThrow("the staged omp-cloud 0.5.1 is missing or damaged; check for updates again");
		await rm(layout.versionDir("0.5.1"), { recursive: true });
		await expect(h.service.apply()).rejects.toThrow("is missing or damaged");
		expect((await state.read()).applying).toBeNull();
	});

	test("a unit that cannot be started is a conflict, and the applying record is withdrawn", async () => {
		const h = harness({ failRun: true });
		await h.service.check();
		await expect(h.service.apply()).rejects.toThrow("could not start the update: systemd-run omp-cloud-update failed: Unit omp-cloud-update.service already exists.");
		expect((await state.read()).applying).toBeNull();
		expect((await h.service.status()).state).toBe("ready");
	});

	test("a failed apply keeps its release staged: failed, and Retry can apply again", async () => {
		const h = harness();
		await h.service.check();
		await state.update((file) => {
			file.error = "the service did not report 0.5.1 within 60 s (no answer); rolled back to 0.5.0";
			file.last = { version: "0.5.1", notes: "n", at: "t", result: "failed", message: file.error };
		});
		expect(await h.service.status()).toMatchObject({ state: "failed", staged: "0.5.1", last: { result: "failed" } });
		expect(await h.service.apply()).toEqual({ version: "0.5.1" });
		const status = await h.service.status();
		expect(status).toMatchObject({ state: "applying", error: null, last: null });
	});

	test("an applying record older than 15 minutes is a failure the user can retry", async () => {
		const h = harness();
		await h.service.check();
		await h.service.apply();
		h.clock.now = T0 + 16 * 60_000;
		const status = await h.service.status();
		expect(status.state).toBe("failed");
		expect(status.applying).toBeNull();
		expect(status.error).toBe("the update to 0.5.1 did not finish (its step was starting)");
		expect(status.last).toMatchObject({ result: "failed", version: "0.5.1", notes: "notes of 0.5.1" });
		expect(await h.service.apply()).toEqual({ version: "0.5.1" });
	});
});

describe("components", () => {
	test("vibemon installed, required (from the latest release, else the pin) and the helper; the omp of the host, broker and gateway", async () => {
		const h = harness();
		expect((await h.service.status()).components).toEqual({
			vmon: { installed: "v0.4.0", required: "v0.4.0", helper: true },
			omp: { host: "18.12.3", broker: "18.12.3", gateway: "18.12.2" },
		});
		await h.service.check();
		expect((await h.service.status()).components.vmon.required).toBe("v0.4.0");
	});

	test("the look-up is cached for a minute", async () => {
		const h = harness();
		await h.service.status();
		const before = h.calls.length;
		await h.service.status();
		expect(h.calls.length).toBe(before);
		h.clock.now += 61_000;
		await h.service.status();
		expect(h.calls.length).toBeGreaterThan(before);
	});
});
