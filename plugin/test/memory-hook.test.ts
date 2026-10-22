import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import { projectBankName } from "../src/mnemopi";
import { run } from "../src/exec";
import { Cloud } from "../src/verbs";
import { detail, event, summary, turn, whoami } from "./builders";
import { cloudEnv, fakeHost, fakePi, fakeSettings, until, type FakeHost } from "./fakes";
import { cleanup, tmp } from "./helpers";

afterEach(cleanup);

const ID = "k3x9fa2m7q1z";
const SHORT = "2m7q1z";
const ENC = new TextEncoder();
const VM = "/home/user/work";

const state = {
	capabilities: ["threads.memory"] as string[],
	/** The bytes `GET /memory` answers; undefined is a 404. */
	memory: undefined as Uint8Array | undefined,
	requests: [] as string[],
	stream: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
	/** Turns the thread reports as finished. */
	turns: 0,
	/** The next turn runs. */
	running: true,
};

function reset(): void {
	state.capabilities = ["threads.memory"];
	state.memory = undefined;
	state.requests = [];
	state.stream = undefined;
	state.turns = 0;
	state.running = true;
}

const current = () =>
	detail({
		id: ID,
		name: "Fix greeting bug",
		phase: state.running ? "working" : "idle",
		memoryBank: "app-laptop",
		turns: [...Array.from({ length: state.turns }, (_, i) => turn(i + 1, { title: "Done", reply: "All done." })), ...(state.running ? [turn(state.turns + 1, { state: "running" })] : [])],
	});

let server: Bun.Server<undefined>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const p = new URL(req.url).pathname;
			const T = `/api/v1/threads/${ID}`;
			state.requests.push(`${req.method} ${p}`);
			if (p === "/api/v1/whoami") return Response.json(whoami({ capabilities: state.capabilities, vmWorkspace: VM }));
			if (req.method === "GET" && p === "/api/v1/threads") return Response.json({ threads: [summary({ id: ID, name: "Fix greeting bug", memoryBank: "app-laptop" })] });
			if (req.method === "GET" && p === T) return Response.json(current());
			if (req.method === "GET" && p === `${T}/events`) {
				const body = new ReadableStream<Uint8Array>({
					start: c => void (state.stream = c),
					cancel: () => void (state.stream = undefined),
				});
				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			}
			if (req.method === "GET" && p === `${T}/memory`) return state.memory ? new Response(state.memory, { headers: { "Content-Type": "application/x-tar" } }) : Response.json({ error: "no memory yet" }, { status: 404 });
			if (req.method === "POST" && p === `${T}/messages`) return Response.json({ turn: { id: 2 } }, { status: 201 });
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
});

afterAll(() => server.stop(true));

beforeEach(reset);

const live: { cloud: Cloud; host: FakeHost }[] = [];

afterEach(async () => {
	for (const { cloud, host } of live.splice(0)) {
		await cloud.handle("unwatch", host.host as never);
		cloud.shutdown();
	}
});

interface Rig {
	cloud: Cloud;
	host: FakeHost;
	agentDir: string;
}

async function setup(global: string): Promise<Rig> {
	const env = await cloudEnv(`url: http://127.0.0.1:${server.port}\ntoken: tok\n`);
	const agentDir = await tmp("omp-cloud-agent-");
	const host = fakeHost({ cwd: await tmp("omp-cloud-cwd-") });
	const pi = fakePi({ settings: await fakeSettings({ agentDir, global }) });
	const cloud = new Cloud(pi.pi, "/own", env, await tmp("omp-cloud-home-"), () => {}, { notify: () => {}, write: () => {} });
	live.push({ cloud, host });
	return { cloud, host, agentDir };
}

/** A memory export holding one cloud memory in the VM's project bank, as a tar. */
async function exportTar(extra?: (dir: string) => Promise<void>): Promise<Uint8Array> {
	const root = await tmp("omp-cloud-export-");
	const dir = join(root, "out");
	const bank = join(dir, "banks", projectBankName(VM, undefined));
	await mkdir(bank, { recursive: true });
	const store = new Mnemopi({ dbPath: join(bank, "mnemopi.db"), noEmbeddings: true, proactiveLinking: false });
	store.remember("the second marker is RED-FOX");
	store.close();
	await extra?.(dir);
	const archive = join(root, "memory.tar");
	expect((await run("tar", ["-cf", archive, "-C", dir, "."])).code).toBe(0);
	return new Uint8Array(await Bun.file(archive).arrayBuffer());
}

/** Turn `n` finishes; with `more`, the next one starts, so the thread stays followed. */
async function finishTurn(r: Rig, n = 1, more = false): Promise<void> {
	if (n === 1) {
		await r.cloud.handle(`send ${SHORT} keep going`, r.host.host as never);
		await until(() => state.stream !== undefined);
	}
	state.turns = n;
	state.running = more;
	state.stream?.enqueue(ENC.encode(`id: ${n}\ndata: ${JSON.stringify(event(n, { kind: "turn_done", turn: n }))}\n\n`));
}

const conversations = (): number => state.requests.filter(q => q === `GET /api/v1/threads/${ID}/conversation`).length;

/**
 * Finishes turn 1, then turn 2, and waits for the second save. A thread's saves run one after the other, so once the second
 * has asked for the conversation the first one (its memory step included) is over: what it did not request, it never will.
 */
async function finishTwice(r: Rig): Promise<void> {
	await finishTurn(r, 1, true);
	await until(() => conversations() >= 1);
	await finishTurn(r, 2);
	await until(() => conversations() >= 2);
}

function localFox(agentDir: string): string[] {
	const file = join(agentDir, "memories", "mnemopi", "banks", "app-laptop", "mnemopi.db");
	const db = new Database(file, { readonly: true });
	try {
		return db
			.query<{ content: string }, [string]>("SELECT content FROM fts_working WHERE fts_working MATCH ?")
			.all("RED")
			.map(r => r.content);
	} finally {
		db.close();
	}
}

const MNEMOPI = "memory:\n  backend: mnemopi\n";

describe("a finished turn merges the cloud's memories", () => {
	test("with the mnemopi backend, they reach the local project bank the handoff renamed", async () => {
		state.memory = await exportTar();
		const r = await setup(MNEMOPI);
		await finishTurn(r);
		await until(() => state.requests.includes(`GET /api/v1/threads/${ID}/memory`));
		await until(() => {
			try {
				return localFox(r.agentDir).length === 1;
			} catch {
				return false;
			}
		});
		expect(localFox(r.agentDir)).toEqual(["the second marker is RED-FOX"]);
		expect(r.host.notes.filter(n => n[1] === "warning")).toEqual([]);
	});

	test("an archive with an unexpected entry is a warning that names the thread and the entry", async () => {
		state.memory = await exportTar(async dir => void (await writeFile(join(dir, "payload.sh"), "echo no")));
		const r = await setup(MNEMOPI);
		await finishTurn(r);
		await until(() => r.host.notes.some(n => n[0].includes("could not merge the cloud memories")));
		const warning = r.host.notes.find(n => n[0].includes("could not merge the cloud memories"));
		expect(warning).toEqual([`☁ could not merge the cloud memories of ${ID}: unexpected entry ./payload.sh`, "warning"]);
		expect(await Bun.file(join(r.agentDir, "memories", "mnemopi", "banks", "app-laptop", "mnemopi.db")).exists()).toBe(false);
	});

	test("a thread without memory yet is not a warning", async () => {
		const r = await setup(MNEMOPI);
		await finishTwice(r);
		expect(state.requests).toContain(`GET /api/v1/threads/${ID}/memory`);
		expect(r.host.notes.filter(n => n[1] === "warning")).toEqual([]);
	});

	test("without the mnemopi backend nothing is asked of the service", async () => {
		state.memory = await exportTar();
		const r = await setup("memory:\n  backend: hindsight\n");
		await finishTwice(r);
		expect(state.requests.filter(q => q.endsWith("/memory"))).toEqual([]);
	});

	test("a custom mnemopi.dbPath keeps the cloud's memories out", async () => {
		state.memory = await exportTar();
		const r = await setup(`${MNEMOPI}mnemopi:\n  dbPath: /somewhere/else.db\n`);
		await finishTwice(r);
		expect(state.requests.filter(q => q.endsWith("/memory"))).toEqual([]);
	});

	test("a service without threads.memory is not asked for memory", async () => {
		state.capabilities = ["threads.paging"];
		state.memory = await exportTar();
		const r = await setup(MNEMOPI);
		await finishTwice(r);
		expect(state.requests.filter(q => q.endsWith("/memory"))).toEqual([]);
	});
});
