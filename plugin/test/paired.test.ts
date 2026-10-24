import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudClient } from "../src/api";
import { CARD_VERSION, loadTui, type CardDetails } from "../src/cards";
import { readConfig, resolveConnection } from "../src/config";
import { readConnectionFile, writeConnectionFile, type PairedConnection } from "../src/connection";
import { isRecord } from "../src/guards";
import { runTool, TOOL_OPS } from "../src/tool";
import { UserError } from "../src/types";
import { Cloud } from "../src/verbs";
import { detail, summary, whoami } from "./builders";
import { cloudEnv, fakeHost, fakePi, until, type FakeHost, type FakeHostOptions, type FakePi } from "./fakes";
import { cleanup, FAST_RETRY, tmp } from "./helpers";
import { deviceToken, fakeTls, makeCert, pairingCode, pairingService, PAIRING_DEVICE, stopFakeServers, type FakeTls, type SeenRequest, type TestCert } from "./tls";

let cert: TestCert;
let other: TestCert;
const plain: Bun.Server<undefined>[] = [];
/** What the browser opener was asked to open; no test launches a real browser. */
const opened: string[] = [];

beforeAll(async () => {
	[cert, other] = await Promise.all([makeCert("service"), makeCert("other")]);
});
afterEach(async () => {
	stopFakeServers();
	for (const s of plain.splice(0)) s.stop(true);
	opened.length = 0;
	await cleanup();
});
afterAll(cleanup);

const THREAD = "k3x9fa2m7q1z";
const ENV_TOKEN = "env-token-must-never-be-sent";

interface Rig {
	cloud: Cloud;
	host: FakeHost;
	pi: FakePi;
	env: Record<string, string | undefined>;
	/** `<config home>/omp-cloud/connection.json` */
	file: string;
	home: string;
}

async function rig(personal?: string, extra: Record<string, string> = {}, hostOpts: FakeHostOptions = {}): Promise<Rig> {
	const env = await cloudEnv(personal, extra);
	const home = await tmp("omp-cloud-home-");
	const host = fakeHost({ cwd: tmpdir(), ...hostOpts });
	const pi = fakePi();
	return { cloud: new Cloud(pi.pi, "/own", env, home, url => void opened.push(url), undefined, FAST_RETRY), host, pi, env, file: join(env.XDG_CONFIG_HOME ?? "", "omp-cloud", "connection.json"), home };
}

function record(c: TestCert, addresses: string[], over: Partial<PairedConnection> = {}): PairedConnection {
	return {
		server: { fingerprint: c.fingerprint, certificate: c.der.toString("base64"), addresses },
		device: PAIRING_DEVICE,
		token: deviceToken(),
		pairedAt: "2026-10-20T00:00:00.000Z",
		...over,
	};
}

/** A rig whose config home holds a paired connection to `addresses` presenting `c`. */
async function pairedRig(addresses: string[], c: TestCert = cert, personal?: string, extra: Record<string, string> = {}, hostOpts: FakeHostOptions = {}): Promise<Rig & { connection: PairedConnection }> {
	const r = await rig(personal, extra, hostOpts);
	const connection = record(c, addresses);
	await writeConnectionFile(r.file, connection);
	return { ...r, connection };
}

const run = (r: Rig, args: string): Promise<void> => r.cloud.handle(args, { ...r.host.host, switchSession: async () => ({ cancelled: false }) });
const notes = (r: Rig): string => r.host.notes.map(n => n[0]).join("\n");

/** A plain-http service on loopback; every request is recorded. */
function plainService(handler: (req: Request, url: URL) => Response): { origin: string; seen: SeenRequest[] } {
	const seen: SeenRequest[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async req => {
			const url = new URL(req.url);
			seen.push({ method: req.method, path: url.pathname, authorization: req.headers.get("authorization"), body: await req.clone().text() });
			return handler(req, url);
		},
	});
	plain.push(server);
	return { origin: `http://127.0.0.1:${server.port}`, seen };
}

const answerWhoami = (req: Request, url: URL): Response =>
	url.pathname === "/api/v1/whoami" ? Response.json(whoami({ user: "dev" })) : Response.json({ error: "not found" }, { status: 404 });

describe("which credential is used", () => {
	test("with no url configured the paired connection is used whole: the device token is sent, an OMP_CLOUD_TOKEN is never sent and /cloud status says it is ignored", async () => {
		const svc = fakeTls(cert, answerWhoami);
		const r = await pairedRig([svc.address], cert, undefined, { OMP_CLOUD_TOKEN: ENV_TOKEN });
		await run(r, "status");

		expect(r.host.notes).toHaveLength(1);
		const [text, type] = r.host.notes[0] ?? ["", undefined];
		expect(type).toBe("info");
		expect(text).toContain(`source: paired device (${r.file})`);
		expect(text).toContain("device: laptop-2 (dev12345)");
		expect(text).toContain(`server: ${cert.fingerprint} at ${svc.address}`);
		expect(text).toContain("OMP_CLOUD_TOKEN is set and ignored");
		expect(text).toContain("you: the owner, with the server's owner token (full access)");
		expect(text).not.toContain(ENV_TOKEN);
		expect(text).not.toContain(r.connection.token);
		expect(svc.seen).toHaveLength(1);
		expect(svc.seen[0]?.authorization).toBe(`Bearer ${r.connection.token}`);
		expect(JSON.stringify(svc.seen)).not.toContain(ENV_TOKEN);
	});

	test("every command, not only status, uses the pinned device connection", async () => {
		const svc = fakeTls(cert, (_req, url) => (url.pathname === "/api/v1/threads" ? Response.json({ threads: [summary({ id: THREAD })] }) : answerWhoami(_req, url)));
		const r = await pairedRig([svc.address], cert, undefined, { OMP_CLOUD_TOKEN: ENV_TOKEN });
		await run(r, "list");
		expect(svc.seen.length).toBeGreaterThan(0);
		expect(svc.seen.every(s => s.authorization === `Bearer ${r.connection.token}`)).toBe(true);
		expect(r.pi.sent).toHaveLength(1);
	});

	test("a token set in config.yml is ignored too, with no url", async () => {
		const svc = fakeTls(cert, answerWhoami);
		const r = await pairedRig([svc.address], cert, "token: from-config-file\n");
		await run(r, "status");
		expect(notes(r)).toContain("is set and ignored");
		expect(notes(r)).not.toContain("from-config-file");
		expect(svc.seen[0]?.authorization).toBe(`Bearer ${r.connection.token}`);
	});

	test("a url in config.yml wins over the connection file: its own token, plain http on loopback, and the paired server is not contacted", async () => {
		const paired = fakeTls(cert, answerWhoami);
		const configured = plainService(answerWhoami);
		const r = await pairedRig([paired.address], cert, `url: ${configured.origin}\ntoken: cfg-token\n`, { OMP_CLOUD_TOKEN: "env-token" });
		await run(r, "status");

		// The env token beats the file's token for a configured url; the paired token is never mixed in.
		expect(configured.seen).toEqual([{ method: "GET", path: "/api/v1/whoami", authorization: "Bearer env-token", body: "" }]);
		expect(paired.seen).toEqual([]);
		expect(notes(r)).toContain(`url: ${configured.origin}`);
		expect(notes(r)).not.toContain("source: paired device");
		expect(notes(r)).toContain("cloud: personal ·");
		expect(notes(r)).toContain(`other clouds: paired https://${paired.address} (paired device laptop-2,`);
	});

	test("OMP_CLOUD_URL wins over the connection file as well", async () => {
		const paired = fakeTls(cert, answerWhoami);
		const configured = plainService(answerWhoami);
		const r = await pairedRig([paired.address], cert, undefined, { OMP_CLOUD_URL: configured.origin, OMP_CLOUD_TOKEN: "env-token" });
		await run(r, "status");
		expect(configured.seen[0]?.authorization).toBe("Bearer env-token");
		expect(paired.seen).toEqual([]);
	});

	test("a url with no token is not configured: it does not fall through to the connection file", async () => {
		const paired = fakeTls(cert, answerWhoami);
		const r = await pairedRig([paired.address], cert, "url: https://cloud.example\n");
		await run(r, "status");
		expect(notes(r)).toContain("is not configured");
		expect(paired.seen).toEqual([]);
	});

	test("plain http to a machine that is not loopback is refused before any request", async () => {
		for (const url of ["http://10.0.0.5", "http://example.com:8080", "http://[fd00::1]:80"]) {
			const r = await rig(`url: ${url}\ntoken: tok\n`);
			await run(r, "list");
			expect(r.host.notes).toHaveLength(1);
			expect(r.host.notes[0]?.[1]).toBe("error");
			expect(notes(r)).toContain("plain http");
			expect(notes(r)).not.toContain("tok\n");
			await run(r, "status");
			expect(notes(r)).toContain("plain http");
		}
	});

	test("http on loopback is allowed; https anywhere is", async () => {
		for (const url of ["http://127.0.0.1:1", "http://localhost:1", "http://[::1]:1", "http://app.localhost", "https://cloud.example", "https://10.0.0.5:8443"]) {
			const env = await cloudEnv(`url: ${url}\ntoken: tok\n`);
			const cfg = await readConfig({ env, home: "/h", repoRoot: undefined, platform: "linux" });
			expect((await resolveConnection(cfg)).url).toBe(url);
		}
		const env = await cloudEnv("url: ftp://x\ntoken: tok\n");
		const cfg = await readConfig({ env, home: "/h", repoRoot: undefined, platform: "linux" });
		await expect(resolveConnection(cfg)).rejects.toBeInstanceOf(UserError);
	});

	test("a corrupt connection file is an error that names it: never system roots, never the env token", async () => {
		const svc = fakeTls(cert, answerWhoami);
		const r = await rig(undefined, { OMP_CLOUD_TOKEN: ENV_TOKEN });
		await writeConnectionFile(r.file, record(cert, [svc.address]));
		await writeFile(r.file, JSON.stringify({ version: 1, token: deviceToken() }), { mode: 0o600 });
		for (const args of ["status", "list", "dashboard"]) {
			r.host.notes.length = 0;
			await run(r, args);
			expect(r.host.notes[0]?.[1]).toBe("error");
			expect(notes(r)).toContain(r.file);
			expect(notes(r)).toContain("not a valid connection record");
		}
		expect(svc.seen).toEqual([]);
	});

	test("a connection file readable by others is an error", async () => {
		const svc = fakeTls(cert, answerWhoami);
		const r = await pairedRig([svc.address]);
		await chmod(r.file, 0o644);
		await run(r, "status");
		expect(notes(r)).toContain("readable by other users");
		expect(svc.seen).toEqual([]);
	});
});

describe("launch text that holds a pairing code", () => {
	const CODE = `ompc1:AbCdEfGhIjKl:s3cr3tS3cr3tS3cr3tS3cr3t:${"A".repeat(43)}@10.0.0.1:8443`;
	const MESSAGE = "that looks like a pairing code; use /cloud connect";

	test("/cloud <text>, /cloud new and /cloud send refuse it with the contract message and start nothing", async () => {
		const svc = plainService((_req, url) => (url.pathname === "/api/v1/threads" ? Response.json({ threads: [summary({ id: THREAD })] }) : Response.json({}, { status: 404 })));
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`);
		await run(r, CODE);
		await run(r, `new please connect with ${CODE}`);
		await run(r, `send ${THREAD} ${CODE}`);

		expect(r.host.notes.map(n => n[0])).toEqual([MESSAGE, MESSAGE, MESSAGE]);
		expect(r.host.notes.every(n => n[1] === "error")).toBe(true);
		expect(r.host.timeouts).toEqual([]);
		expect(svc.seen.filter(s => s.method === "POST")).toEqual([]);
	});

	test("the cloud tool's operations refuse it before touching the service", async () => {
		const svc = plainService(() => Response.json({}, { status: 404 }));
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`);
		const delegated = await runTool({ cloud: r.cloud, ctx: r.host.host, toolCallId: "call-1" }, { op: "delegate", task: `do ${CODE}` });
		expect(delegated.isError).toBe(true);
		expect(delegated.content[0]?.text).toContain(MESSAGE.replace(/^☁ /, ""));
		expect(svc.seen).toEqual([]);

		const client = new CloudClient(svc.origin, "tok");
		await expect(client.sendMessage(THREAD, CODE)).rejects.toThrow(MESSAGE);
		await expect(client.answer(THREAD, 1, 1, { answer: CODE })).rejects.toThrow(MESSAGE);
		await expect(client.answer(THREAD, 1, 1, { selected: [CODE] })).rejects.toThrow(MESSAGE);
		await expect(client.createThread({ request: { prompt: CODE } as never })).rejects.toThrow(MESSAGE);
		expect(svc.seen).toEqual([]);
	});

	test("the cloud tool pairs only through connect: no pair, devices, disconnect or revoke operation", () => {
		for (const verb of ["pair", "devices", "disconnect", "revoke"]) expect(TOOL_OPS as readonly string[]).not.toContain(verb);
	});
});

describe("provider login on a paired device", () => {
	const noProviders = (req: Request, url: URL): Response => (url.pathname === "/api/v1/whoami" ? Response.json(whoami({ user: "dev", modelPatterns: [], models: [], device: { ...PAIRING_DEVICE, access: "threads" } })) : answerWhoami(req, url));

	test("/cloud login asks only who the caller is, then says the server machine does it, naming the host the client reaches", async () => {
		const svc = fakeTls(cert, noProviders);
		// The first address refuses connections: the client settles on the second, which is the one the guidance must name.
		const r = await pairedRig(["127.0.0.2:1", svc.address]);
		await run(r, "status");
		expect(notes(r)).toContain("no providers yet (log the server in: run omp-cloud login <provider> on 127.0.0.1 (over ssh: ssh -t <user>@127.0.0.1 '~/.local/bin/omp-cloud login <provider>'))");
		r.host.notes.length = 0;
		const before = svc.seen.length;

		await run(r, "login anthropic");

		expect(r.host.notes).toEqual([
			["☁ this device has threads-only access and cannot log the cloud in: log the server in: run omp-cloud login anthropic on 127.0.0.1 (over ssh: ssh -t <user>@127.0.0.1 '~/.local/bin/omp-cloud login anthropic')", "error"],
		]);
		expect(svc.seen.slice(before).every(s => s.method === "GET" && s.path === "/api/v1/whoami")).toBe(true);
		expect(notes(r)).not.toContain(r.connection.token);
	});

	test("a handoff of a model the cloud does not serve names the device's way to log the server in, and uploads nothing", async () => {
		const svc = fakeTls(cert, (_req, url) => (url.pathname === "/api/v1/whoami" ? Response.json(whoami({ user: "dev", device: { ...PAIRING_DEVICE, access: "threads" }, defaultModel: "", capabilities: ["threads.paging", "threads.meta", "threads.idempotency", "threads.scratch"] })) : Response.json({ error: "not found" }, { status: 404 })));
		const r = await pairedRig([svc.address], cert, undefined, {}, { model: { provider: "google", id: "gemini-3" } });

		const out = await runTool({ cloud: r.cloud, ctx: r.host.host, toolCallId: "call-1" }, { op: "delegate", task: "x" });

		expect(out.isError).toBe(true);
		const text = out.content[0]?.text ?? "";
		expect(text).toContain("this cloud does not serve google/gemini-3");
		expect(text).toContain("run omp-cloud login google on 127.0.0.1 (over ssh: ssh -t <user>@127.0.0.1 '~/.local/bin/omp-cloud login google')");
		expect(text).not.toContain("/cloud login");
		expect(svc.seen.some(s => s.method === "POST")).toBe(false);
	});

	test("bare /cloud login lists what the cloud is logged in to when the service can say, else prints the usage", async () => {
		const listed = plainService((req, url) => {
			if (url.pathname === "/api/v1/whoami") return Response.json(whoami({ capabilities: ["logins.list"] }));
			if (url.pathname === "/api/v1/logins") return Response.json({ logins: [{ provider: "anthropic", kind: "provider", account: "me@example.com", loggedInAt: "2026-10-01T08:30:00.000Z", renewBy: "", disabled: false, note: "" }], brokerError: "" });
			return answerWhoami(req, url);
		});
		const r = await rig(`url: ${listed.origin}\ntoken: tok\n`);
		await run(r, "login");
		expect(r.host.notes).toEqual([["☁ the cloud is logged in to:\n  anthropic · me@example.com · logged in 2026-10-01\n  /cloud login <provider> logs the cloud in (again)", "info"]]);

		const old = plainService(answerWhoami);
		const o = await rig(`url: ${old.origin}\ntoken: tok\n`);
		await run(o, "login");
		expect(o.host.notes).toEqual([["☁ usage: /cloud login <provider>", "info"]]);
		expect(old.seen.map(s => s.path)).toEqual(["/api/v1/whoami"]);
	});

	test("an owner connection keeps /cloud login", async () => {
		const svc = plainService((req, url) => (url.pathname === "/api/v1/whoami" ? Response.json(whoami({ user: "dev", modelPatterns: [] })) : answerWhoami(req, url)));
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`);
		await run(r, "status");
		expect(notes(r)).toContain("no providers yet (/cloud login <provider>)");
	});
});

describe("the watcher follows the connection", () => {
	test("a token or pin that changes rebuilds it: the next watch uses the new credential", async () => {
		const svc = fakeTls(cert, (_req, url) => {
			if (url.pathname === "/api/v1/threads") return Response.json({ threads: [summary({ id: THREAD })] });
			if (url.pathname === `/api/v1/threads/${THREAD}`) return Response.json(detail({ id: THREAD, phase: "idle" }));
			return Response.json({}, { status: 404 });
		});
		const r = await pairedRig([svc.address]);
		const lastThreadAuth = (): string | null | undefined => svc.seen.filter(s => s.path === `/api/v1/threads/${THREAD}`).at(-1)?.authorization;

		await run(r, `watch ${THREAD}`);
		expect(lastThreadAuth()).toBe(`Bearer ${r.connection.token}`);

		const second = record(cert, [svc.address]);
		await writeConnectionFile(r.file, second);
		await run(r, `watch ${THREAD}`);
		expect(lastThreadAuth()).toBe(`Bearer ${second.token}`);

		// A different pin with the same token is a different connection as well: the old pinned transport must not be reused.
		const repinned = record(other, [svc.address], { token: second.token });
		await writeConnectionFile(r.file, repinned);
		r.host.notes.length = 0;
		await run(r, `watch ${THREAD}`);
		expect(notes(r)).toContain("cannot reach");
		// An unreachable service is retried (3 times after the first): that is the intended behaviour.
		expect(svc.seen.filter(s => s.path === `/api/v1/threads/${THREAD}`)).toHaveLength(4);
	});
});

describe("/cloud dashboard on a paired connection", () => {
	test("starts the loopback forwarder once, prints a link with a locally minted code, and relays with the device token", async () => {
		const svc = fakeTls(cert, (req, url) => {
			if (url.pathname === "/api/v1/dashboard/links") return Response.json({ error: "never asked" }, { status: 500 });
			if (url.pathname.startsWith("/api/v1/dashboard/static")) return new Response("<html>dashboard</html>", { headers: { "content-type": "text/html" } });
			return answerWhoami(req, url);
		});
		const r = await pairedRig([svc.address]);
		await run(r, "dashboard");
		await run(r, "dashboard");
		try {
			const links = r.host.notes.map(n => /^☁ dashboard: (http:\/\/127\.0\.0\.1:\d+)\/#(\S+)\n {2}one use, valid 60 s$/.exec(n[0]));
			expect(links.every(m => m !== null)).toBe(true);
			const [first, second] = links;
			if (!first || !second) throw new Error("no links");
			const origin = first[1] ?? "";
			expect(second[1]).toBe(origin);
			expect(first[2]).not.toBe(second[2]);
			expect(JSON.stringify(r.host.notes)).not.toContain(r.connection.token);

			const page = await fetch(`${origin}/`);
			expect(await page.text()).toBe("<html>dashboard</html>");
			const signIn = await fetch(`${origin}/session`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-omp-dashboard": "1" },
				body: JSON.stringify({ code: first[2] }),
			});
			expect(signIn.status).toBe(204);
			const cookie = signIn.headers.get("set-cookie")?.split(";")[0] ?? "";
			expect(cookie).toStartWith("omp_cloud_session=");
			const api = await fetch(`${origin}/api/v1/whoami`, { headers: { cookie } });
			expect((await api.json()) as { user: string }).toMatchObject({ user: "dev" });

			const relayed = svc.seen.filter(s => s.path === "/api/v1/whoami");
			expect(relayed).toHaveLength(1);
			expect(relayed[0]?.authorization).toBe(`Bearer ${r.connection.token}`);
			expect(svc.seen.some(s => s.path === "/api/v1/dashboard/links")).toBe(false);
			// The forwarder never sent the owner a one-time link request: the code is local.
			const reused = await fetch(`${origin}/session`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-omp-dashboard": "1" },
				body: JSON.stringify({ code: first[2] }),
			});
			expect(reused.status).toBe(401);
		} finally {
			r.cloud.stopForwarder();
		}
	});

	test("the browser opens on both paths in the interactive TUI only, and the link is printed either way", async () => {
		const svc = fakeTls(cert, (req, url) => (url.pathname.startsWith("/api/v1/dashboard/static") ? new Response("<html></html>") : answerWhoami(req, url)));
		const owner = plainService((_req, url) => (url.pathname === "/api/v1/dashboard/links" ? Response.json({ url: "http://127.0.0.1:8081/#c0de", expiresAt: "2026-10-20T00:01:00.000Z" }, { status: 201 }) : Response.json({}, { status: 404 })));
		for (const mode of ["rpc", "print", undefined]) {
			const o = await rig(`url: ${owner.origin}\ntoken: tok\n`, {}, { mode });
			const p = await pairedRig([svc.address], cert, undefined, {}, { mode });
			await run(o, "dashboard");
			await run(p, "dashboard");
			p.cloud.stopForwarder();
			expect(notes(o)).toContain("☁ dashboard: http://127.0.0.1:8081/#c0de");
			expect(notes(p)).toContain("☁ dashboard: http://127.0.0.1:");
		}
		expect(opened).toEqual([]);

		const o = await rig(`url: ${owner.origin}\ntoken: tok\n`, {}, { mode: "tui" });
		const p = await pairedRig([svc.address], cert, undefined, {}, { mode: "tui" });
		await run(o, "dashboard");
		await run(p, "dashboard");
		p.cloud.stopForwarder();
		const printed = /http:\/\/127\.0\.0\.1:\d+\/#\S+/.exec(notes(p))?.[0];
		expect(opened).toEqual(["http://127.0.0.1:8081/#c0de", printed ?? "missing"]);
		expect(notes(o)).toContain("☁ dashboard: http://127.0.0.1:8081/#c0de");
	});

	test("on an owner connection it still asks the service for a link", async () => {
		const svc = plainService((_req, url) => (url.pathname === "/api/v1/dashboard/links" ? Response.json({ url: "http://127.0.0.1:8081/#c0de", expiresAt: "2026-10-20T00:01:00.000Z" }, { status: 201 }) : Response.json({}, { status: 404 })));
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`);
		await run(r, "dashboard");
		expect(notes(r)).toBe("☁ dashboard: http://127.0.0.1:8081/#c0de\n  one use, valid 60 s");
		expect(svc.seen.map(s => s.path)).toEqual(["/api/v1/dashboard/links"]);
	});
});

const DEVICES = [
	{ id: "dev12345abcdef", name: "laptop-2", platform: "linux", access: "full", createdAt: "2026-10-19T00:00:00.000Z", pairedFrom: "10.0.0.7", lastSeenAt: "2026-10-20T00:00:00.000Z", lastSeenAddress: "10.0.0.7", current: true },
	{ id: "devzzzzz999999", name: "phone", platform: "ios", access: "threads", createdAt: "2026-10-18T00:00:00.000Z", pairedFrom: "10.0.0.9", lastSeenAt: "", lastSeenAddress: "", current: false },
];

function deviceService(): FakeTls {
	return fakeTls(cert, async (req, url) => {
		if (req.method === "GET" && url.pathname === "/api/v1/whoami") return Response.json(whoami({ user: "dev", capabilities: ["devices.access"], device: { ...PAIRING_DEVICE, access: "full" } }));
		if (req.method === "GET" && url.pathname === "/api/v1/devices") return Response.json({ devices: DEVICES });
		const patch = /^\/api\/v1\/devices\/(\w+)$/.exec(url.pathname);
		if (req.method === "PATCH" && patch) {
			const body: unknown = await req.json();
			return Response.json({ device: { ...DEVICES.find(d => d.id === patch[1]), access: isRecord(body) ? body.access : "" } });
		}
		if (req.method === "DELETE" && url.pathname === "/api/v1/devices/devzzzzz999999") return Response.json({ device: { id: "devzzzzz999999", name: "phone" }, runningThreads: [THREAD] });
		if (req.method === "DELETE" && url.pathname === "/api/v1/devices/dev12345abcdef") return Response.json({ device: { id: "dev12345abcdef", name: "laptop-2" }, runningThreads: [] });
		return Response.json({ error: "not found" }, { status: 404 });
	});
}

describe("/cloud devices", () => {
	test("lists the devices as a card and marks this one", async () => {
		const svc = deviceService();
		const r = await pairedRig([svc.address]);
		await run(r, "devices");
		const card = r.pi.sent[0]?.message;
		expect((card?.details as CardDetails).kind).toBe("notice");
		expect(card?.content).toContain("Paired devices (2)");
		expect(card?.content).toContain("laptop-2 (this device) · full access · linux");
		expect(card?.content).toContain("phone · threads only · ios · devzzzzz");
		expect(card?.content).not.toContain(r.connection.token);
	});

	test("revoke asks, deletes by name or id prefix, and names the threads still running", async () => {
		const svc = deviceService();
		const r = await pairedRig([svc.address]);
		await run(r, "devices revoke phone");
		expect(svc.seen.filter(s => s.method === "DELETE").map(s => s.path)).toEqual(["/api/v1/devices/devzzzzz999999"]);
		expect(notes(r)).toContain("☁ revoked phone");
		expect(notes(r)).toContain(`1 thread it started still run: ${THREAD}`);

		await run(r, "devices revoke devzzz");
		expect(svc.seen.filter(s => s.method === "DELETE")).toHaveLength(2);
	});

	test("revoke does nothing when declined, for an unknown device, or for this machine's own", async () => {
		const svc = deviceService();
		const declined = await pairedRig([svc.address], cert, undefined, {}, { confirm: false });
		await run(declined, "devices revoke phone");
		expect(svc.seen.filter(s => s.method === "DELETE")).toEqual([]);

		const r = await pairedRig([svc.address]);
		await run(r, "devices revoke nobody");
		await run(r, "devices revoke laptop-2");
		expect(r.host.notes.map(n => n[1])).toEqual(["error", "error"]);
		expect(r.host.notes[0]?.[0]).toContain('no device matches "nobody"');
		expect(r.host.notes[1]?.[0]).toContain("/cloud disconnect");
		expect(svc.seen.filter(s => s.method === "DELETE")).toEqual([]);
	});

	test("access sets a device's level by name or id prefix, and asks only before demoting this machine's own device", async () => {
		const svc = deviceService();
		const patches = (): string[] => svc.seen.filter(s => s.method === "PATCH").map(s => `${s.path} ${s.body}`);
		const r = await pairedRig([svc.address]);
		await run(r, "devices access phone full");
		await run(r, "devices access devzzz threads");
		expect(patches()).toEqual(['/api/v1/devices/devzzzzz999999 {"access":"full"}', '/api/v1/devices/devzzzzz999999 {"access":"threads"}']);
		expect(r.host.notes).toEqual([
			["☁ phone now has full access", "info"],
			["☁ phone now has threads-only access", "info"],
		]);

		const declined = await pairedRig([svc.address], cert, undefined, {}, { confirm: false });
		await run(declined, "devices access laptop-2 threads");
		expect(patches()).toHaveLength(2);
		await run(declined, "devices access phone full");
		expect(patches()).toHaveLength(3);
	});
});

describe("/cloud disconnect", () => {
	test("revokes this device with its own token, deletes the file, stops the forwarder and drops the connection", async () => {
		const svc = fakeTls(cert, (req, url) => (req.method === "DELETE" ? Response.json({ device: PAIRING_DEVICE, runningThreads: [] }) : answerWhoami(req, url)));
		const r = await pairedRig([svc.address]);
		await run(r, "dashboard");
		const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(notes(r))?.[0] ?? "";
		expect((await fetch(`${origin}/`)).status).toBeGreaterThan(0);

		await run(r, "disconnect");
		expect(svc.seen.filter(s => s.method === "DELETE")).toEqual([
			{ method: "DELETE", path: `/api/v1/devices/${PAIRING_DEVICE.id}`, authorization: `Bearer ${r.connection.token}`, body: "" },
		]);
		expect(await readConnectionFile(r.file)).toBeUndefined();
		await expect(fetch(`${origin}/`)).rejects.toBeInstanceOf(Error);
		expect(r.host.notes.at(-1)?.[0]).toContain("☁ disconnected");
		expect(JSON.stringify(r.host.notes)).not.toContain(r.connection.token);
	});

	test("when the service cannot be reached the file stays; --force removes it and warns that the token stays valid", async () => {
		const svc = fakeTls(cert, answerWhoami);
		const r = await pairedRig([svc.address]);
		svc.server.stop(true);
		await run(r, "disconnect");
		expect(r.host.notes.at(-1)?.[1]).toBe("error");
		expect(notes(r)).toContain("the connection is kept");
		expect(await readConnectionFile(r.file)).toEqual(r.connection);

		await run(r, "disconnect --force");
		expect(await readConnectionFile(r.file)).toBeUndefined();
		const last = r.host.notes.at(-1);
		expect(last?.[1]).toBe("warning");
		expect(last?.[0]).toContain("stays valid until it is revoked from the server machine");
	});

	test("a device the server already revoked is simply forgotten; a refused confirmation changes nothing; an unpaired machine is told so", async () => {
		const svc = fakeTls(cert, () => Response.json({ error: "unauthorized" }, { status: 401 }));
		const r = await pairedRig([svc.address]);
		await run(r, "disconnect");
		expect(notes(r)).toContain("already revoked");
		expect(await readConnectionFile(r.file)).toBeUndefined();
		await run(r, "disconnect");
		expect(r.host.notes.at(-1)?.[0]).toContain("not paired");

		const kept = await pairedRig([svc.address], cert, undefined, {}, { confirm: false });
		await run(kept, "disconnect");
		expect(await readConnectionFile(kept.file)).toEqual(kept.connection);
		expect(svc.seen).toHaveLength(1);
	});

	test("a paired file is removed even when config.yml has a url that wins for everything else", async () => {
		const svc = fakeTls(cert, () => Response.json({ device: PAIRING_DEVICE, runningThreads: [] }));
		const r = await pairedRig([svc.address], cert, "url: https://cloud.example\ntoken: t\n");
		await run(r, "disconnect");
		expect(await readConnectionFile(r.file)).toBeUndefined();
	});
});

describe("/cloud connect", () => {
	test("pairs from a code on the command line, posts a card without secrets and leaves a 0600 file", async () => {
		const svc = pairingService(cert);
		svc.claims.splice(0, 2);
		const r = await rig();
		const code = pairingCode(cert, [svc.address]);
		await run(r, `connect ${code} --name laptop`);

		const card = r.pi.sent[0]?.message;
		expect(card?.content).toContain("Connected to omp-cloud");
		expect(card?.content).toContain(`server ${cert.fingerprint} at ${svc.address}`);
		expect(card?.content).toContain("this device: laptop-2 (dev12345)");
		expect(JSON.stringify([card, r.host.notes])).not.toContain(svc.token);
		expect(JSON.stringify([card, r.host.notes])).not.toContain("secret1234567890123456");
		expect((await stat(r.file)).mode & 0o777).toBe(0o600);
		expect((await readConnectionFile(r.file))?.token).toBe(svc.token);

		// And the next command already uses it.
		r.host.notes.length = 0;
		await run(r, "status");
		expect(notes(r)).toContain("source: paired device");
		expect(notes(r)).toContain("you: the owner, on device laptop-2 (full access)");
	});

	test("a session without threads uses the new pairing from then on, and the choice is recorded", async () => {
		const svc = pairingService(cert);
		svc.claims.splice(0, 2);
		const r = await rig();
		await run(r, `connect ${pairingCode(cert, [svc.address])} --name laptop`);

		expect(r.pi.sent[0]?.message.content).toContain("this session uses it now");
		expect(r.pi.entries).toEqual([{ type: "custom", customType: "omp-cloud-target", data: { cloud: "paired" } }]);
		r.host.notes.length = 0;
		await run(r, "status");
		expect(notes(r)).toContain("cloud: paired ·");
		expect(notes(r)).toContain("this session's choice");
	});

	test("with a url configured the card says new sessions still start there, and this session switches to the pairing", async () => {
		const svc = pairingService(cert);
		svc.claims.splice(0, 2);
		const configured = plainService(answerWhoami);
		const r = await rig(`url: ${configured.origin}\ntoken: cfg-token\n`);
		await run(r, `connect ${pairingCode(cert, [svc.address])} --name laptop`);

		const card = r.pi.sent[0]?.message.content ?? "";
		expect(card).toContain("this session uses it now");
		expect(card).toContain("new sessions on this machine still use url in ");
		expect(card).toContain("/cloud use paired --default makes this pairing the default");
		r.host.notes.length = 0;
		await run(r, "status");
		expect(notes(r)).toContain("you: the owner, on device laptop-2 (full access)");
		expect(configured.seen).toEqual([]);
	});

	test("a session that already works with threads keeps its cloud and says so", async () => {
		const svc = pairingService(cert);
		svc.claims.splice(0, 2);
		const configured = plainService(answerWhoami);
		const launched = { type: "custom_message", customType: "omp-cloud", details: { v: CARD_VERSION, kind: "launch", origin: "tool", thread: THREAD } };
		const r = await rig(`url: ${configured.origin}\ntoken: cfg-token\n`, {}, { entries: [launched] });
		await run(r, `connect ${pairingCode(cert, [svc.address])} --name laptop`);

		expect(r.pi.sent[0]?.message.content).toContain("this session keeps personal: it already works with threads there");
		expect(r.pi.entries).toEqual([]);
		r.host.notes.length = 0;
		await run(r, "status");
		expect(configured.seen).toHaveLength(1);
		expect(notes(r)).not.toContain("user: owner");
	});

	test("without a code it prompts, and the answer never appears in the command text", async () => {
		const svc = pairingService(cert);
		svc.claims.splice(0, 2);
		const titles: string[] = [];
		const r = await rig(undefined, {}, {
			input: async title => {
				titles.push(title);
				return `  ${pairingCode(cert, [svc.address])}\n`;
			},
		});
		await run(r, "connect --name laptop");
		expect(titles).toEqual(["Pairing code or ssh target"]);
		expect((await readConnectionFile(r.file))?.device.name).toBe("laptop-2");
	});

	test("an empty prompt cancels; a host that cannot prompt gets the usage", async () => {
		const cancelled = await rig(undefined, {}, { input: async () => "   " });
		await run(cancelled, "connect");
		expect(cancelled.host.notes).toEqual([["☁ connect cancelled", "info"]]);

		const mute = await rig();
		await run(mute, "connect");
		expect(mute.host.notes[0]?.[0]).toContain("usage: /cloud connect");
	});

	test("an existing connection needs --replace; the error is shown, not thrown", async () => {
		const svc = pairingService(cert);
		const r = await pairedRig([svc.address]);
		await run(r, `connect ${pairingCode(cert, [svc.address])}`);
		expect(r.host.notes[0]?.[1]).toBe("error");
		expect(r.host.notes[0]?.[0]).toContain("--replace");
		expect(svc.seen).toEqual([]);
	});

	test("a malformed code is an error that does not echo it", async () => {
		const r = await rig();
		await run(r, "connect ompc1:secretish:nope");
		expect(r.host.notes[0]?.[1]).toBe("error");
		expect(notes(r)).toContain("not a pairing code");
		expect(notes(r)).not.toContain("secretish");
	});
});

describe("/cloud pair", () => {
	const OFFER = { id: "AbCdEfGhIjKl", code: `ompc1:AbCdEfGhIjKl:s3cr3tS3cr3tS3cr3tS3cr3t:${"A".repeat(43)}@10.0.0.42:8443`, expiresAt: new Date(Date.now() + 300_000).toISOString(), fingerprint: "SHA256:x", addresses: ["10.0.0.42:8443"] };

	function ownerService(offer: () => Response = () => Response.json(OFFER, { status: 201 })): { origin: string; seen: SeenRequest[] } {
		return plainService((req, url) => {
			if (req.method === "POST" && url.pathname === "/api/v1/pairing/offers") return offer();
			if (req.method === "GET" && url.pathname === `/api/v1/pairing/offers/${OFFER.id}`) return Response.json({ id: OFFER.id, status: "open", expiresAt: OFFER.expiresAt, request: null, device: null });
			if (req.method === "DELETE" && url.pathname === `/api/v1/pairing/offers/${OFFER.id}`) return new Response(null, { status: 204 });
			return Response.json({ error: "not found" }, { status: 404 });
		});
	}

	/** A host `custom` that builds the overlay, lets it poll once, sends `keys` and resolves with what `done` got. */
	function overlayHost(keys: string[], seen: unknown[] = []): FakeHostOptions["custom"] {
		return (async (
			factory: (...a: unknown[]) => unknown,
			options: unknown,
		) => {
			seen.push(options);
			const { promise, resolve } = Promise.withResolvers<unknown>();
			const pair = (await factory({ requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, resolve)) as { handleInput(d: string): void; dispose(): void };
			for (const k of keys) pair.handleInput(k);
			const result = await promise;
			pair.dispose();
			return result;
		}) as never;
	}

	test("without an interactive UI it refuses before creating an offer", async () => {
		const svc = ownerService();
		for (const mode of [undefined, "rpc"]) {
			const r = await rig(`url: ${svc.origin}\ntoken: tok\n`, {}, { mode });
			await run(r, "pair");
			expect(r.host.notes).toEqual([["☁ /cloud pair needs omp's interactive UI", "error"]]);
		}
		const tui = await rig(`url: ${svc.origin}\ntoken: tok\n`, {}, { mode: "tui" });
		await run(tui, "pair");
		expect(tui.host.notes[0]?.[0]).toContain("needs omp's interactive UI");
		expect(svc.seen.filter(s => s.method === "POST")).toEqual([]);
	});

	test("a paired device with threads-only access cannot pair others and names itself", async () => {
		const svc = fakeTls(cert, (req, url) => (url.pathname === "/api/v1/whoami" ? Response.json(whoami({ user: "dev", device: { ...PAIRING_DEVICE, access: "threads" } })) : answerWhoami(req, url)));
		const r = await pairedRig([svc.address], cert, undefined, {}, { mode: "tui" });
		await run(r, "pair");
		expect(r.host.notes).toEqual([["☁ /cloud pair needs full access; this device (laptop-2) has threads-only access", "error"]]);
		expect(svc.seen.every(s => s.path === "/api/v1/whoami")).toBe(true);
	});

	test("a paired device with full access goes on to the overlay check", async () => {
		const svc = fakeTls(cert, (req, url) => (url.pathname === "/api/v1/whoami" ? Response.json(whoami({ user: "dev", device: { ...PAIRING_DEVICE, access: "full" } })) : answerWhoami(req, url)));
		const r = await pairedRig([svc.address], cert, undefined, {}, { mode: "tui" });
		await run(r, "pair");
		expect(notes(r)).toContain("needs omp's interactive UI");
		expect(notes(r)).not.toContain("needs full access");
	});

	test("a service without a remote section says how to add one", async () => {
		const svc = ownerService(() => Response.json({ error: "remote access is not configured" }, { status: 404 }));
		const tui = await loadTui();
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`, {}, { mode: "tui", custom: overlayHost([]) });
		r.cloud.setTui(tui);
		await run(r, "pair");
		expect(notes(r)).toContain("remote section");
	});

	test("the overlay opens, Esc cancels the offer, and the code appears in no note, card or model-visible text", async () => {
		const svc = ownerService();
		const tui = await loadTui();
		const opened: unknown[] = [];
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`, {}, { mode: "tui", custom: overlayHost(["\x1b"], opened) });
		r.cloud.setTui(tui);
		await run(r, "pair");

		expect(opened).toEqual([{ overlay: true, overlayOptions: { anchor: "center", width: "92%", maxHeight: "92%", minWidth: 60 } }]);
		await until(() => svc.seen.some(s => s.method === "DELETE"));
		expect(svc.seen.filter(s => s.method === "DELETE").map(s => s.path)).toContain(`/api/v1/pairing/offers/${OFFER.id}`);
		expect(r.host.notes).toEqual([["☁ pairing cancelled", "info"]]);
		expect(r.pi.sent).toEqual([]);
		expect(JSON.stringify([r.host.notes, r.pi.sent, r.host.widgets])).not.toContain("s3cr3t");
		expect(svc.seen.find(s => s.method === "POST")?.body).toBe("{}");
	});

	test("a host that never builds the overlay gets the offer cancelled and the refusal", async () => {
		const svc = ownerService();
		const tui = await loadTui();
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`, {}, { mode: "tui", custom: (async () => undefined) as never });
		r.cloud.setTui(tui);
		await run(r, "pair");
		expect(notes(r)).toContain("needs omp's interactive UI");
		expect(svc.seen.filter(s => s.method === "DELETE")).toHaveLength(1);
	});
});
