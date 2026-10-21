import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installOmp, Templates, templateName } from "./template";

const VMON = "v0.4.0";

/** Ops over an in-memory set of templates; `build` finishes when `finish(name)` is called. */
function fakeOps(existing: string[] = []) {
	const present = new Set(existing);
	const builds: string[] = [];
	const finishers = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
	return {
		present,
		builds,
		finish(name: string): void {
			finishers.get(name)?.resolve();
		},
		fail(name: string, error: Error): void {
			finishers.get(name)?.reject(error);
		},
		ops: {
			exists: async (name: string) => present.has(name),
			build: (name: string, version: string) => {
				builds.push(`${name}@${version}`);
				const { promise, resolve, reject } = Promise.withResolvers<void>();
				finishers.set(name, {
					resolve: () => {
						present.add(name);
						resolve();
					},
					reject,
				});
				return promise;
			},
		},
	};
}

describe("templateName", () => {
	test("holds the version and a 12-hex recipe hash, and is a valid vmon tag", async () => {
		const name = await templateName("omp-agent", "18.12.3", VMON);
		expect(name).toMatch(/^omp-agent:18\.12\.3-[0-9a-f]{12}$/);
		expect(name.slice(name.indexOf(":") + 1)).toMatch(/^[a-z0-9-_.]+$/);
	});

	test("the same recipe gives the same tag", async () => {
		expect(await templateName("omp-agent", "18.12.3", VMON)).toBe(await templateName("omp-agent", "18.12.3", VMON));
	});

	test("a changed recipe gives a different tag", async () => {
		const before = await templateName("omp-agent", "18.12.3", VMON);
		const saved = process.env.PI_BUILD_URL;
		process.env.PI_BUILD_URL = "https://build.example.test";
		try {
			expect(await templateName("omp-agent", "18.12.3", VMON)).not.toBe(before);
		} finally {
			if (saved === undefined) delete process.env.PI_BUILD_URL;
			else process.env.PI_BUILD_URL = saved;
		}
	});

	test("different versions give different tags", async () => {
		expect(await templateName("omp-agent", "18.12.3", VMON)).not.toBe(await templateName("omp-agent", "18.12.2", VMON));
	});

	test("another vmon version, or none installed, gives a different tag with the same shape", async () => {
		const names = [VMON, "v0.4.1", null].map(vmon => templateName("omp-agent", "18.12.3", vmon));
		const resolved = await Promise.all(names);
		expect(new Set(resolved).size).toBe(3);
		for (const name of resolved) expect(name).toMatch(/^omp-agent:18\.12\.3-[0-9a-f]{12}$/);
	});
});

const NAME_3 = await templateName("omp-agent", "18.12.3", VMON);
const NAME_2 = await templateName("omp-agent", "18.12.2", VMON);
const installed = async (): Promise<string | null> => VMON;

describe("Templates.ensure", () => {
	test("an existing template is returned without a build or a notice", async () => {
		const fake = fakeOps([NAME_3]);
		let notices = 0;
		const name = await new Templates("omp-agent", fake.ops, installed).ensure("18.12.3", () => notices++);
		expect(name).toBe(NAME_3);
		expect(fake.builds).toEqual([]);
		expect(notices).toBe(0);
	});

	test("a missing template is built once, with a notice, and then exists", async () => {
		const fake = fakeOps();
		const templates = new Templates("omp-agent", fake.ops, installed);
		let notices = 0;
		const pending = templates.ensure("18.12.3", () => notices++);
		await Bun.sleep(0);
		expect(fake.builds).toEqual([`${NAME_3}@18.12.3`]);
		expect(notices).toBe(1);
		fake.finish(NAME_3);
		expect(await pending).toBe(NAME_3);
		expect(await templates.ensure("18.12.3", () => notices++)).toBe(NAME_3);
		expect(fake.builds).toHaveLength(1);
		expect(notices).toBe(1);
	});

	test("concurrent callers of one version share a single build and each gets the notice", async () => {
		const fake = fakeOps();
		const templates = new Templates("omp-agent", fake.ops, installed);
		let notices = 0;
		const callers = [1, 2, 3].map(() => templates.ensure("18.12.3", () => notices++));
		await Bun.sleep(0);
		expect(fake.builds).toHaveLength(1);
		let settled = 0;
		for (const caller of callers) void caller.then(() => settled++);
		await Bun.sleep(0);
		expect(settled).toBe(0);
		fake.finish(NAME_3);
		expect(await Promise.all(callers)).toEqual(Array(3).fill(NAME_3));
		expect(fake.builds).toHaveLength(1);
		expect(notices).toBe(3);
	});

	test("different versions build side by side", async () => {
		const fake = fakeOps();
		const templates = new Templates("omp-agent", fake.ops, installed);
		const a = templates.ensure("18.12.3");
		const b = templates.ensure("18.12.2");
		await Bun.sleep(0);
		expect(fake.builds.sort()).toEqual([`${NAME_2}@18.12.2`, `${NAME_3}@18.12.3`].sort());
		fake.finish(NAME_2);
		fake.finish(NAME_3);
		expect(await Promise.all([a, b])).toEqual([NAME_3, NAME_2]);
	});

	test("a failed build rejects every waiter and the next call builds again", async () => {
		const fake = fakeOps();
		const templates = new Templates("omp-agent", fake.ops, installed);
		const first = templates.ensure("18.12.3");
		const second = templates.ensure("18.12.3");
		const outcomes = Promise.allSettled([first, second]);
		await Bun.sleep(0);
		fake.fail(NAME_3, new Error("download failed"));
		const settled = await outcomes;
		expect(settled.map(outcome => outcome.status)).toEqual(["rejected", "rejected"]);
		expect(String((settled[0] as PromiseRejectedResult).reason)).toContain("download failed");

		const retry = templates.ensure("18.12.3");
		await Bun.sleep(0);
		expect(fake.builds).toHaveLength(2);
		fake.finish(NAME_3);
		expect(await retry).toBe(NAME_3);
	});

	test("a vmon upgrade between two calls reuses nothing a vmon of another version built", async () => {
		const fake = fakeOps([NAME_3]);
		let vmon: string | null = VMON;
		const templates = new Templates("omp-agent", fake.ops, async () => vmon);
		expect(await templates.ensure("18.12.3")).toBe(NAME_3);
		expect(fake.builds).toEqual([]);

		vmon = "v0.5.0";
		const upgraded = templates.ensure("18.12.3");
		await Bun.sleep(0);
		expect(fake.builds).toHaveLength(1);
		const [started] = fake.builds;
		const name = started?.split("@")[0] ?? "";
		expect(name).not.toBe(NAME_3);
		fake.finish(name);
		expect(await upgraded).toBe(name);
	});
});

describe("Templates.prebuild", () => {
	test("builds a missing template and says so, and does nothing when it exists", async () => {
		const log = console.log;
		const lines: string[] = [];
		console.log = (line: string) => void lines.push(line);
		try {
			const fake = fakeOps();
			const templates = new Templates("omp-agent", fake.ops, installed);
			const pending = templates.prebuild("18.12.3");
			await Bun.sleep(0);
			expect(fake.builds).toEqual([`${NAME_3}@18.12.3`]);
			fake.finish(NAME_3);
			await pending;
			expect(lines.some(line => line.includes("building the VM template for omp 18.12.3 in the background"))).toBe(true);
			expect(lines.some(line => line.includes(`${NAME_3} is ready`))).toBe(true);

			lines.length = 0;
			await templates.prebuild("18.12.3");
			expect(fake.builds).toHaveLength(1);
			expect(lines.some(line => line.includes("building"))).toBe(false);
		} finally {
			console.log = log;
		}
	});

	test("a failed prebuild is logged, never thrown, and the next ensure builds again", async () => {
		const error = console.error;
		const lines: string[] = [];
		console.error = (line: string) => void lines.push(line);
		try {
			const fake = fakeOps();
			const templates = new Templates("omp-agent", fake.ops, installed);
			const pending = templates.prebuild("18.12.3");
			await Bun.sleep(0);
			fake.fail(NAME_3, new Error("download failed"));
			await pending;
			expect(lines.some(line => line.includes("download failed"))).toBe(true);

			const retry = templates.ensure("18.12.3");
			await Bun.sleep(0);
			expect(fake.builds).toHaveLength(2);
			fake.finish(NAME_3);
			expect(await retry).toBe(NAME_3);
		} finally {
			console.error = error;
		}
	});
});

describe("installOmp", () => {
	const BINARY = "#!/bin/sh\necho omp 18.12.3\n";
	const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
	let dir: string;
	let service: Bun.Server<undefined>;
	/** What the fake build service answers for `18.12.3`, and the bytes its download serves. */
	let answer: Record<string, unknown>;
	let download: string;
	let requested: string[];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "omp-cloud-install-"));
		requested = [];
		download = BINARY;
		answer = {
			build: { version: "18.12.3" },
			file: { name: "omp-linux-x64", sha256: sha256(BINARY) },
			download: "",
		};
		service = Bun.serve({
			port: 0,
			fetch(req) {
				const { pathname } = new URL(req.url);
				requested.push(pathname);
				if (pathname === "/api/products/omp/versions/18.12.3/linux-x86_64") {
					return Response.json({ ...answer, download: `${service.url.origin}/d/omp-linux-x64` });
				}
				if (pathname === "/d/omp-linux-x64") return new Response(download);
				return Response.json({ error: "no_build" }, { status: 404 });
			},
		});
	});

	afterEach(async () => {
		await service.stop(true);
		await rm(dir, { recursive: true, force: true });
	});

	function run(version = "18.12.3") {
		return Bun.spawn(["bash", "-c", installOmp(version, service.url.origin, join(dir, "omp"))], {
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	async function exists(path: string): Promise<boolean> {
		return stat(path).then(
			() => true,
			() => false,
		);
	}

	test("installs the build the service answers when the download hashes to the answered SHA-256", async () => {
		const proc = run();
		expect(await proc.exited).toBe(0);
		expect((await new Response(proc.stdout).text()).trim().split("\n").at(-1)).toBe("omp 18.12.3");
		expect(requested).toEqual(["/api/products/omp/versions/18.12.3/linux-x86_64", "/d/omp-linux-x64"]);
		expect(await exists(join(dir, "omp"))).toBe(true);
	});

	test("a download that does not hash to the answered SHA-256 installs nothing", async () => {
		download = `${BINARY}# tampered\n`;
		expect(await run().exited).not.toBe(0);
		expect(await exists(join(dir, "omp"))).toBe(false);
	});

	test.each([
		["another version", { build: { version: "18.12.2" } }],
		["another file", { file: { name: "omp-linux-arm64", sha256: sha256(BINARY) } }],
		["a malformed SHA-256", { file: { name: "omp-linux-x64", sha256: "ABC" } }],
	])("an answer for %s installs nothing", async (_name, override) => {
		answer = { ...answer, ...override };
		expect(await run().exited).not.toBe(0);
		expect(requested).toEqual(["/api/products/omp/versions/18.12.3/linux-x86_64"]);
		expect(await exists(join(dir, "omp"))).toBe(false);
	});

	test("a version the service has no build of fails", async () => {
		expect(await run("99.0.0").exited).not.toBe(0);
		expect(await exists(join(dir, "omp"))).toBe(false);
	});
});
