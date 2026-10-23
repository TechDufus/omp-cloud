import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { CARD_VERSION } from "../src/cards";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Cloud, targetFromEntries } from "../src/verbs";
import { whoami } from "./builders";
import { cloudEnv, fakeHost, fakePi, type FakeHost, type FakePi } from "./fakes";
import { cleanup, FAST_RETRY, tmp } from "./helpers";

afterEach(cleanup);

/** Two services that tell who answered: the environment's cloud (token `etok`) and the personal file's (token `ptok`). */
const services: { name: string; token: string; user: string; server?: Bun.Server<undefined>; url: string }[] = [
	{ name: "env", token: "etok", user: "env-user", url: "" },
	{ name: "personal", token: "ptok", user: "personal-user", url: "" },
];

beforeAll(() => {
	for (const s of services) {
		s.server = Bun.serve({
			port: 0,
			fetch: req => {
				if (new URL(req.url).pathname !== "/api/v1/whoami") return Response.json({ error: "not found" }, { status: 404 });
				if (req.headers.get("authorization") !== `Bearer ${s.token}`) return Response.json({ error: "unauthorized" }, { status: 401 });
				return Response.json(whoami({ user: s.user, service: { version: "0.4.0", api: 6, name: `${s.name}-cloud` } }));
			},
		});
		s.url = `http://127.0.0.1:${s.server.port}`;
	}
});
afterAll(() => {
	for (const s of services) s.server?.stop(true);
});

const [ENV, PERSONAL] = services as [(typeof services)[number], (typeof services)[number]];
const THREAD = "k3x9fa2m7q1z";
const launched = (thread = THREAD): unknown => ({ type: "custom_message", customType: "omp-cloud", details: { v: CARD_VERSION, kind: "launch", origin: "tool", thread } });
const target = (cloud: unknown): unknown => ({ type: "custom", customType: "omp-cloud-target", data: { cloud } });

interface Rig {
	cloud: Cloud;
	host: FakeHost;
	pi: FakePi;
	run: (args: string) => Promise<void>;
	/** The personal file. */
	file: string;
	notes: () => string;
}

/** A machine that knows both services: `OMP_CLOUD_URL` is the env one (the default), the personal file the other. `entries` is the session file. */
async function rig(entries: unknown[] = [], personal = `url: ${PERSONAL.url}\ntoken: ${PERSONAL.token}\n`): Promise<Rig> {
	const env = await cloudEnv(personal, { OMP_CLOUD_URL: ENV.url, OMP_CLOUD_TOKEN: ENV.token });
	const pi = fakePi({ entries });
	const host = fakeHost({ cwd: await tmp("omp-cloud-repo-"), entries });
	const cloud = new Cloud(pi.pi, "/own", env, await tmp("omp-cloud-home-"), undefined, undefined, FAST_RETRY);
	const file = join(env.XDG_CONFIG_HOME ?? "", "omp-cloud", "config.yml");
	return {
		file,
		cloud,
		host,
		pi,
		run: args => cloud.handle(args, { ...host.host, switchSession: async () => ({ cancelled: false }) }),
		notes: () => host.notes.map(n => n[0]).join("\n"),
	};
}

describe("targetFromEntries", () => {
	test("is the newest omp-cloud-target entry's cloud, whatever else the session holds", () => {
		expect(targetFromEntries([])).toBeUndefined();
		expect(targetFromEntries([target("personal"), { type: "message" }, { type: "custom", customType: "other", data: { cloud: "env" } }])).toBe("personal");
		expect(targetFromEntries([target("personal"), target("paired")])).toBe("paired");
	});

	test("an entry that names no cloud this plugin knows names none, even over an older one", () => {
		expect(targetFromEntries([target("personal"), target("elsewhere")])).toBeUndefined();
		expect(targetFromEntries([target("personal"), { type: "custom", customType: "omp-cloud-target", data: "personal" }])).toBeUndefined();
	});
});

describe("/cloud use", () => {
	test("lists the clouds and says which one the session uses and why", async () => {
		const r = await rig();
		await r.run("use");
		expect(r.notes()).toContain(`cloud: env · ${ENV.url} · the default (OMP_CLOUD_URL is set)`);
		expect(r.notes()).toContain(`other clouds: personal ${PERSONAL.url} (url in `);
	});

	test("switches a session without threads: later commands reach the other cloud, and the choice is recorded in the session", async () => {
		const r = await rig();
		await r.run("status");
		expect(r.notes()).toContain("☁ omp-cloud · env-cloud · omp-cloud 0.4.0");

		r.host.notes.length = 0;
		await r.run("use personal");
		expect(r.host.notes).toEqual([[`☁ this session uses personal (${PERSONAL.url})`, "info"]]);
		expect(r.pi.entries).toEqual([target("personal")]);

		r.host.notes.length = 0;
		await r.run("status");
		expect(r.notes()).toContain("☁ omp-cloud · personal-cloud · omp-cloud 0.4.0");
		expect(r.notes()).toContain(`cloud: personal · ${PERSONAL.url} · this session's choice`);
		expect(r.notes()).toContain("other clouds: env ");
	});

	test("a session resumed from its entries keeps the choice, and a Cloud that has not seen the entry takes the default", async () => {
		const resumed = await rig([target("personal")]);
		await resumed.run("status");
		expect(resumed.notes()).toContain("☁ omp-cloud · personal-cloud · omp-cloud 0.4.0");

		const fresh = await rig([]);
		await fresh.run("status");
		expect(fresh.notes()).toContain("☁ omp-cloud · env-cloud · omp-cloud 0.4.0");
	});

	test("a session that works with a thread is refused, and nothing changes", async () => {
		const r = await rig([launched()]);
		await r.run("use personal");
		expect(r.host.notes).toEqual([[`☁ this session already works with 1 cloud thread (${THREAD}) on env; start a new omp session to use personal`, "error"]]);
		expect(r.pi.entries).toEqual([launched()]);

		r.host.notes.length = 0;
		await r.run("status");
		expect(r.notes()).toContain("☁ omp-cloud · env-cloud · omp-cloud 0.4.0");
	});

	test("the same connection under another name only records the choice, threads or not", async () => {
		const r = await rig([launched()], `url: ${ENV.url}\ntoken: ${ENV.token}\n`);
		await r.run("use personal");
		expect(r.host.notes).toEqual([[`☁ this session uses personal (${ENV.url})`, "info"]]);
		expect(r.pi.entries).toEqual([launched(), target("personal")]);
	});

	test("a cloud this machine does not have is refused with the way to list them", async () => {
		const r = await rig();
		await r.run("use paired");
		expect(r.host.notes).toEqual([["☁ no usable paired cloud on this machine; cloud info or /cloud use lists the clouds", "error"]]);
		expect(r.pi.entries).toEqual([]);
	});

	test("a personal url without a token cannot be picked, and says where to set it", async () => {
		const r = await rig([], `url: ${PERSONAL.url}\n`);
		await r.run("use personal");
		expect(r.host.notes[0]?.[1]).toBe("error");
		expect(r.host.notes[0]?.[0]).toContain("has no token: set token there");
		expect(r.pi.entries).toEqual([]);
	});

	test("a choice the machine no longer supports fails commands with the way out, which use itself is not blocked by", async () => {
		const r = await rig([target("paired")]);
		await r.run("status");
		expect(r.notes()).toContain("it uses paired, which this machine no longer has");

		r.host.notes.length = 0;
		await r.run("use personal");
		expect(r.host.notes).toEqual([[`☁ this session uses personal (${PERSONAL.url})`, "info"]]);
		expect(r.pi.entries).toEqual([target("paired"), target("personal")]);
	});
});

describe("/cloud use <cloud> --default", () => {
	const own = (): string => `url: ${PERSONAL.url}\ntoken: ${PERSONAL.token}\n`;

	test("writes use: into the personal file and switches this session", async () => {
		const r = await rig();
		await r.run("use personal --default");
		expect(r.host.notes).toEqual([["☁ new sessions on this machine use personal (" + PERSONAL.url + "); this session uses it now", "info"]]);
		expect(await readFile(r.file, "utf8")).toBe(`${own()}use: personal\n`);
		expect(r.pi.entries).toEqual([target("personal")]);
		r.host.notes.length = 0;
		await r.run("status");
		expect(r.notes()).toContain("☁ omp-cloud · personal-cloud · omp-cloud 0.4.0");
	});

	test("env cannot be the default: OMP_CLOUD_URL decides, nothing is written, nothing switches", async () => {
		const r = await rig();
		await r.run("use env --default");
		expect(r.host.notes).toEqual([["☁ env cannot be the default: OMP_CLOUD_URL already decides for every process that has it", "warning"]]);
		expect(await readFile(r.file, "utf8")).toBe(own());
		expect(r.pi.entries).toEqual([]);
	});

	test("a session with threads keeps its cloud, the default is written anyway, and the session is pinned so the new default does not move it", async () => {
		const r = await rig([launched()]);
		await r.run("use personal --default");
		expect(r.host.notes).toEqual([["☁ new sessions on this machine use personal (" + PERSONAL.url + "); this session keeps env: it already works with threads there", "info"]]);
		expect(await readFile(r.file, "utf8")).toBe(`${own()}use: personal\n`);
		expect(r.pi.entries).toEqual([launched(), target("env")]);
	});

	test("a cloud this machine does not have writes nothing", async () => {
		const r = await rig();
		await r.run("use paired --default");
		expect(r.host.notes[0]?.[1]).toBe("error");
		expect(await readFile(r.file, "utf8")).toBe(own());
	});
});

describe("Cloud.clouds, useCloud", () => {
	test("clouds reports what the machine knows, the one in use and whether the session chose it", async () => {
		const r = await rig();
		const before = await r.cloud.clouds(r.host.host);
		expect(before.known.map(c => c.source)).toEqual(["env", "personal"]);
		expect(before).toMatchObject({ active: "env", chosen: false });

		const after = await r.cloud.useCloud(r.host.host, "personal");
		expect(after).toMatchObject({ active: "personal", chosen: true });
		expect(after.lines[0]).toContain("this session's choice");
	});

	test("a machine with nothing configured says so, with no active cloud", async () => {
		const env = await cloudEnv();
		const host = fakeHost({ cwd: await tmp("omp-cloud-repo-") });
		const cloud = new Cloud(fakePi().pi, "/own", env, await tmp("omp-cloud-home-"), undefined, undefined, FAST_RETRY);
		expect(await cloud.clouds(host.host)).toEqual({ known: [], active: undefined, chosen: false, lines: ["cloud: none configured on this machine"] });
	});
});
