import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { writeConnectionFile, type PairedConnection } from "../src/connection";
import { runTool, type ToolParams, type ToolResult } from "../src/tool";
import { Cloud } from "../src/verbs";
import { detail, summary, whoami } from "./builders";
import { cloudEnv, fakeHost, fakePi, type FakeHost, type FakeHostOptions } from "./fakes";
import { cleanup, FAST_RETRY, tmp } from "./helpers";
import { deviceToken, fakeTls, makeCert, PAIRING_DEVICE, stopFakeServers, type SeenRequest, type TestCert } from "./tls";
import { join } from "node:path";

const THREAD = "k3x9fa2m7q1z";

let cert: TestCert;
const plain: Bun.Server<undefined>[] = [];
const opened: string[] = [];
const clouds: Cloud[] = [];

beforeAll(async () => {
	cert = await makeCert("service");
});
afterEach(async () => {
	for (const c of clouds.splice(0)) c.stopForwarder();
	stopFakeServers();
	for (const s of plain.splice(0)) s.stop(true);
	opened.length = 0;
	await cleanup();
});

/** What a fake service answers: whoami with `capabilities`, the thread, its list, and the preview route through `app`. */
function service(capabilities: string[], app: (req: Request, url: URL) => Response): (req: Request, url: URL) => Response {
	return (req, url) => {
		if (url.pathname === "/api/v1/whoami") return Response.json(whoami({ capabilities }));
		if (url.pathname === "/api/v1/threads") return Response.json({ threads: [summary({ id: THREAD, name: "dev server" })], total: 1 });
		if (url.pathname === `/api/v1/threads/${THREAD}`) return Response.json(detail({ id: THREAD, name: "dev server" }));
		if (url.pathname.startsWith(`/api/v1/threads/${THREAD}/ports/`)) return app(req, url);
		return Response.json({ error: "not found" }, { status: 404 });
	};
}

function plainService(handler: (req: Request, url: URL) => Response): { origin: string; seen: SeenRequest[] } {
	const seen: SeenRequest[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: req => {
			const url = new URL(req.url);
			seen.push({ method: req.method, path: url.pathname, authorization: req.headers.get("authorization"), body: "" });
			return handler(req, url);
		},
	});
	plain.push(server);
	return { origin: `http://127.0.0.1:${server.port}`, seen };
}

interface Rig {
	cloud: Cloud;
	host: FakeHost;
	run: (args: string) => Promise<void>;
	notes: () => string;
}

async function rig(personal: string, hostOpts: FakeHostOptions = {}, paired?: PairedConnection): Promise<Rig> {
	const env = await cloudEnv(personal);
	const home = await tmp("omp-cloud-home-");
	const host = fakeHost({ cwd: tmpdir(), ...hostOpts });
	const cloud = new Cloud(fakePi().pi, "/own", env, home, url => void opened.push(url), undefined, FAST_RETRY);
	clouds.push(cloud);
	if (paired) await writeConnectionFile(join(env.XDG_CONFIG_HOME ?? "", "omp-cloud", "connection.json"), paired);
	return { cloud, host, run: args => cloud.handle(args, { ...host.host, switchSession: async () => ({ cancelled: false }) }), notes: () => host.notes.map(n => n[0]).join("\n") };
}

const urlOf = (text: string): string => /http:\/\/localhost:\d+\//.exec(text)?.[0] ?? "";

describe("/cloud preview", () => {
	test("relays a port of the thread to localhost with the owner token, says where, and stops on `preview stop`", async () => {
		const svc = plainService(service(["threads.preview"], () => new Response("<h1>Directory listing</h1>", { headers: { "content-type": "text/html" } })));
		const r = await rig(`url: ${svc.origin}\ntoken: tok-secret\n`);
		await r.run(`preview ${THREAD.slice(-6)} 8000`);

		const url = urlOf(r.notes());
		expect(r.host.notes[0]?.[0]).toStartWith(`☁ preview of port 8000 on `);
		expect(r.notes()).toContain(`: ${url}`);
		expect(url).not.toBe("");
		expect(opened).toEqual([]);

		const page = await fetch(`${url}index.html?x=1`);
		expect(await page.text()).toBe("<h1>Directory listing</h1>");
		const relayed = svc.seen.find(s => s.path.includes("/ports/"));
		expect(relayed).toMatchObject({ method: "GET", path: `/api/v1/threads/${THREAD}/ports/8000/index.html`, authorization: "Bearer tok-secret" });
		expect(JSON.stringify(r.host.notes)).not.toContain("tok-secret");

		await r.run("preview stop");
		expect(r.host.notes.at(-1)).toEqual(["☁ stopped 1 preview", "info"]);
		await expect(fetch(url)).rejects.toThrow();
		await r.run("preview stop");
		expect(r.host.notes.at(-1)).toEqual(["☁ no previews are running", "info"]);
	});

	test("asking again for the same thread and port reuses the forwarder; another port gets its own; stop ends both", async () => {
		const svc = plainService(service(["threads.preview"], () => new Response("ok")));
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`);
		await r.run(`preview ${THREAD} 8000`);
		await r.run(`preview ${THREAD} 8000`);
		await r.run(`preview ${THREAD} 3000`);
		const [a, again, b] = r.host.notes.map(n => urlOf(n[0]));
		expect(again).toBe(a);
		expect(b).not.toBe(a);
		await r.run("preview stop");
		expect(r.host.notes.at(-1)?.[0]).toBe("☁ stopped 2 previews");
		await expect(fetch(a ?? "")).rejects.toThrow();
		await expect(fetch(b ?? "")).rejects.toThrow();
	});

	test("the TUI opens the browser; other modes only print the address", async () => {
		const svc = plainService(service(["threads.preview"], () => new Response("ok")));
		const tui = await rig(`url: ${svc.origin}\ntoken: tok\n`, { mode: "tui" });
		await tui.run(`preview ${THREAD} 8000`);
		expect(opened).toEqual([urlOf(tui.notes())]);
		const quiet = await rig(`url: ${svc.origin}\ntoken: tok\n`, { mode: "rpc" });
		await quiet.run(`preview ${THREAD} 3000`);
		expect(urlOf(quiet.notes())).not.toBe("");
		expect(opened).toEqual([urlOf(tui.notes())]);
	});

	test("a service without threads.preview is refused as version_skew and nothing listens", async () => {
		const svc = plainService(service([], () => new Response("never")));
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`, { mode: "tui" });
		await r.run(`preview ${THREAD} 8000`);
		expect(r.host.notes).toHaveLength(1);
		expect(r.host.notes[0]?.[1]).toBe("error");
		expect(r.notes()).toContain("does not support threads.preview");
		expect(opened).toEqual([]);
		expect(svc.seen.some(s => s.path.includes("/ports/"))).toBe(false);
	});

	test("session shutdown stops every preview", async () => {
		const svc = plainService(service(["threads.preview"], () => new Response("ok")));
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`);
		await r.run(`preview ${THREAD} 8000`);
		const url = urlOf(r.notes());
		expect((await fetch(url)).status).toBe(200);
		r.cloud.shutdown();
		await expect(fetch(url)).rejects.toThrow();
	});

	test("disconnecting a paired device stops the previews that carried its token", async () => {
		const svc = fakeTls(cert, service(["threads.preview"], () => new Response("ok")));
		const connection: PairedConnection = {
			server: { fingerprint: cert.fingerprint, certificate: cert.der.toString("base64"), addresses: [svc.address] },
			device: PAIRING_DEVICE,
			token: deviceToken(),
			pairedAt: "2026-10-20T00:00:00.000Z",
		};
		const r = await rig("", {}, connection);
		await r.run(`preview ${THREAD} 8000`);
		const url = urlOf(r.notes());
		expect((await fetch(url)).status).toBe(200);
		expect(svc.seen.find(s => s.path.includes("/ports/"))?.authorization).toBe(`Bearer ${connection.token}`);
		r.cloud.stopForwarder();
		await expect(fetch(url)).rejects.toThrow();
	});

	test("over a paired connection an app's redirect reaches the browser instead of failing the relay", async () => {
		const svc = fakeTls(cert, service(["threads.preview"], () => new Response(null, { status: 302, headers: { location: "/dir/" } })));
		const connection: PairedConnection = {
			server: { fingerprint: cert.fingerprint, certificate: cert.der.toString("base64"), addresses: [svc.address] },
			device: PAIRING_DEVICE,
			token: deviceToken(),
			pairedAt: "2026-10-20T00:00:00.000Z",
		};
		const r = await rig("", {}, connection);
		await r.run(`preview ${THREAD} 8000`);
		const res = await fetch(`${urlOf(r.notes())}dir`, { redirect: "manual" });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/dir/");
	});
});

describe("the cloud tool's preview op", () => {
	const run = (r: Rig, params: ToolParams): Promise<ToolResult> => runTool({ cloud: r.cloud, ctx: r.host.host, toolCallId: "call_1" }, params);
	const text = (res: ToolResult): string => res.content.map(c => c.text).join("\n");
	const alive = async (url: string): Promise<boolean> => (await fetch(url).catch(() => undefined))?.status === 200;

	test("starts a forwarder that relays to the service's ports route with the owner token, and says how to use and stop it", async () => {
		const svc = plainService(service(["threads.preview"], () => new Response("<h1>Directory listing</h1>", { headers: { "content-type": "text/html" } })));
		const r = await rig(`url: ${svc.origin}\ntoken: tok-secret\n`);
		const res = await run(r, { op: "preview", thread: THREAD.slice(-6), port: 8000 });
		expect(res.isError).toBeUndefined();
		const url = urlOf(text(res));
		expect(text(res).split("\n")[0]).toBe(`cloud preview: ok ${url} → port 8000 of ${THREAD} (dev server)`);
		expect(text(res)).toContain("browser tool");
		expect(text(res)).not.toContain("tok-secret");

		expect(await (await fetch(`${url}index.html`)).text()).toBe("<h1>Directory listing</h1>");
		expect(svc.seen.find(s => s.path.includes("/ports/"))).toMatchObject({ path: `/api/v1/threads/${THREAD}/ports/8000/index.html`, authorization: "Bearer tok-secret" });
		expect(opened).toEqual([]);
	});

	test("a second call, and the slash verb, reuse the running forwarder", async () => {
		const svc = plainService(service(["threads.preview"], () => new Response("ok")));
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`);
		const a = urlOf(text(await run(r, { op: "preview", thread: THREAD, port: 8000 })));
		expect(urlOf(text(await run(r, { op: "preview", thread: THREAD, port: 8000 })))).toBe(a);
		await r.run(`preview ${THREAD} 8000`);
		expect(urlOf(r.notes())).toBe(a);
		const b = urlOf(text(await run(r, { op: "preview", thread: THREAD, port: 3000 })));
		expect(b).not.toBe(a);

		// A preview the user started is the model's too.
		await r.run(`preview ${THREAD} 5000`);
		const user = urlOf(r.host.notes.at(-1)?.[0] ?? "");
		expect(urlOf(text(await run(r, { op: "preview", thread: THREAD, port: 5000 })))).toBe(user);
	});

	test("stop with a thread and port ends that one, with a thread ends its previews, without either ends all", async () => {
		const svc = plainService(service(["threads.preview"], () => new Response("ok")));
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`);
		const start = async (port: number): Promise<string> => urlOf(text(await run(r, { op: "preview", thread: THREAD, port })));
		const [a, b, c] = [await start(8000), await start(3000), await start(5000)] as [string, string, string];

		const one = await run(r, { op: "preview", stop: true, thread: THREAD.slice(-6), port: 3000 });
		expect(text(one)).toBe("cloud preview: ok stopped 1 preview");
		expect(await alive(a)).toBe(true);
		expect(await alive(b)).toBe(false);
		expect(await alive(c)).toBe(true);

		expect(text(await run(r, { op: "preview", stop: true, port: 5000 }))).toBe("cloud preview: ok stopped 1 preview");
		expect(await alive(c)).toBe(false);
		expect(await alive(a)).toBe(true);

		expect(text(await run(r, { op: "preview", stop: true, thread: THREAD }))).toBe("cloud preview: ok stopped 1 preview");
		expect(await alive(a)).toBe(false);
		expect(text(await run(r, { op: "preview", stop: true }))).toBe("cloud preview: ok stopped 0 previews");

		const d = await start(8000);
		const e = await start(3000);
		expect(text(await run(r, { op: "preview", stop: true }))).toBe("cloud preview: ok stopped 2 previews");
		expect(await alive(d)).toBe(false);
		expect(await alive(e)).toBe(false);
	});

	test("`/cloud preview stop`, session shutdown and disconnect end the previews the tool started", async () => {
		const svc = plainService(service(["threads.preview"], () => new Response("ok")));
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`);
		const a = urlOf(text(await run(r, { op: "preview", thread: THREAD, port: 8000 })));
		const b = urlOf(text(await run(r, { op: "preview", thread: THREAD, port: 3000 })));
		expect(await alive(a)).toBe(true);
		await r.run("preview stop");
		expect(r.host.notes.at(-1)).toEqual(["☁ stopped 2 previews", "info"]);
		expect(await alive(a)).toBe(false);
		expect(await alive(b)).toBe(false);

		const c = urlOf(text(await run(r, { op: "preview", thread: THREAD, port: 8000 })));
		r.cloud.stopForwarder();
		expect(await alive(c)).toBe(false);

		const d = urlOf(text(await run(r, { op: "preview", thread: THREAD, port: 8000 })));
		r.cloud.shutdown();
		expect(await alive(d)).toBe(false);
	});

	test("a service without threads.preview is a version_skew error and nothing listens", async () => {
		const svc = plainService(service([], () => new Response("never")));
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`);
		const res = await run(r, { op: "preview", thread: THREAD, port: 8000 });
		expect(res.isError).toBe(true);
		expect(text(res).split("\n")[0]).toContain("cloud preview: error version_skew");
		expect(text(res)).toContain("does not support threads.preview");
		await r.run("preview stop");
		expect(r.host.notes.at(-1)).toEqual(["☁ no previews are running", "info"]);
	});

	test("a bad port is refused before anything starts", async () => {
		const svc = plainService(service(["threads.preview"], () => new Response("never")));
		const r = await rig(`url: ${svc.origin}\ntoken: tok\n`);
		for (const port of [0, 65536, 49983]) {
			const res = await run(r, { op: "preview", thread: THREAD, port });
			expect(res.isError).toBe(true);
			expect(text(res)).toContain("port must be 1 to 65535 and not 49983");
		}
		await r.run("preview stop");
		expect(r.host.notes.at(-1)).toEqual(["☁ no previews are running", "info"]);
	});
});
