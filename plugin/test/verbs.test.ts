import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../src/exec";
import { Cloud } from "../src/verbs";
import { login, whoami } from "./builders";
import { cloudEnv, fakeHost, fakePi } from "./fakes";
import { cleanup, FAST_RETRY, tmp } from "./helpers";

afterEach(cleanup);

let server: Bun.Server<undefined>;
let origin = "";

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch: req => {
			const url = new URL(req.url);
			if (url.pathname !== "/api/v1/whoami") return Response.json({ error: "not found" }, { status: 404 });
			if (req.headers.get("authorization") !== "Bearer tok") return Response.json({ error: "unauthorized" }, { status: 401 });
			return Response.json(whoami({ user: "dev", modelPatterns: ["anthropic/*"], defaultModel: "anthropic/claude-sonnet-5-5" }));
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

interface StatusOptions {
	/** The personal file's YAML; no file when undefined. */
	personal?: string;
	/** The repository file's YAML; the session then runs in a fresh git repository that holds it. */
	repo?: string;
	env?: Record<string, string>;
}

/** Runs `/cloud status` against omp-cloud's files; returns what the user was shown and where the personal file is. */
async function status(o: StatusOptions = {}): Promise<{ text: string; type: string | undefined; personal: string; repoFile: string }> {
	const env = await cloudEnv(o.personal, o.env);
	const repo = await tmp("omp-cloud-repo-");
	await run("git", ["init", "-q"], { cwd: repo });
	const repoFile = join(repo, ".omp-cloud.yml");
	if (o.repo !== undefined) await writeFile(repoFile, o.repo);
	const host = fakeHost({ cwd: repo });
	await new Cloud(fakePi().pi, "/own", env, await tmp("omp-cloud-home-"), undefined, undefined, FAST_RETRY).handle("status", { ...host.host, switchSession: async () => ({ cancelled: false }) });
	expect(host.notes).toHaveLength(1);
	const [text, type] = host.notes[0] ?? ["", undefined];
	return { text, type, personal: join(env.XDG_CONFIG_HOME ?? "", "omp-cloud", "config.yml"), repoFile };
}

describe("/cloud status", () => {
	test("reports the url and where it came from, the token only by origin, then what the service says", async () => {
		const { text, type, personal } = await status({ personal: `url: ${origin}/\ntoken: tok\n` });
		expect(type).toBe("info");
		expect(text).toBe(
			[
				"☁ omp-cloud",
				`  url: ${origin} (${personal})`,
				`  token: set (${personal})`,
				"  deliver: tray (default)",
				"  user: dev",
				"  runs: anthropic",
				"  a handoff from here runs: anthropic/claude-sonnet-5-5 (thinking high), this session's model",
				"  fallback for requests that name no model: anthropic/claude-sonnet-5-5 · omp 18.12.3",
			].join("\n"),
		);
		expect(text).not.toMatch(/\btok\b/);
	});

	test("the model a handoff runs is the session's, not the service's fallback", async () => {
		const env = await cloudEnv(`url: ${origin}\ntoken: tok\n`);
		const host = fakeHost({ cwd: await tmp("omp-cloud-repo-"), model: { provider: "anthropic", id: "claude-opus-5-5" } });
		await new Cloud(fakePi({ thinking: "low" }).pi, "/own", env, await tmp("omp-cloud-home-")).handle("status", { ...host.host, switchSession: async () => ({ cancelled: false }) });
		const [text = ""] = host.notes[0] ?? [];
		expect(text).toContain("a handoff from here runs: anthropic/claude-opus-5-5 (thinking low), this session's model");
		expect(text).not.toContain("default model");
	});

	test("a !command token works and its output never shows", async () => {
		const { text, personal } = await status({ personal: `url: ${origin}\ntoken: "!printf tok"\n` });
		expect(text).toContain(`token: set (${personal})`);
		expect(text).not.toContain("printf");
		expect(text).toContain("user: dev");
	});

	test("the environment is the origin when it wins", async () => {
		const { text } = await status({ personal: "url: http://nowhere.invalid\n", env: { OMP_CLOUD_URL: origin, OMP_CLOUD_TOKEN: "tok" } });
		expect(text).toContain(`url: ${origin} (env)`);
		expect(text).toContain("token: set (env)");
	});

	test("the repository file is shown, its url is ignored for the personal one and the status says so", async () => {
		const { text, type, repoFile } = await status({ personal: `url: ${origin}\ntoken: tok\n`, repo: "url: http://evil.invalid\nsecretEnv: [A]\n" });
		expect(type).toBe("info");
		expect(text).toMatch(new RegExp(`url: ${origin} \\(.*\\) · the repository's value is ignored`));
		expect(text).toContain(`repository file: ${repoFile}`);
		expect(text).not.toContain("evil.invalid");
		expect(text).toContain("user: dev");
	});

	test("a repository url with no personal one leaves it unconfigured, and the error names the ignored key", async () => {
		const { text, type, personal, repoFile } = await status({ personal: "token: tok\n", repo: "url: http://evil.invalid\n" });
		expect(type).toBe("error");
		expect(text).toContain("url: not set");
		expect(text).toContain(`token: set (${personal})`);
		expect(text).toContain(`omp-cloud is not configured: set url and token in ${personal}`);
		expect(text).toContain(`url in ${repoFile} is ignored`);
		expect(text).not.toContain("evil.invalid");
	});

	test("warnings about unknown keys and wrong types show, without values", async () => {
		const { text, personal } = await status({ personal: `url: ${origin}\ntoken: tok\ncolour: secret-marker\nsecretEnv: secret-marker\n` });
		expect(text).toContain(`warning: ${personal}: colour is not a known key, ignored`);
		expect(text).toContain(`warning: ${personal}: secretEnv is not a list, ignored`);
		expect(text).not.toContain("secret-marker");
		expect(text).toContain("user: dev");
	});

	test("an unreachable service still reports the connection, as an error", async () => {
		const { text, type, personal } = await status({ personal: "url: http://127.0.0.1:9\ntoken: tok\n" });
		expect(type).toBe("error");
		expect(text).toContain(`url: http://127.0.0.1:9 (${personal})`);
		expect(text).toContain(`token: set (${personal})`);
		expect(text).not.toContain("user:");
	});

	test("nothing configured says how to configure it, naming the personal file", async () => {
		const { text, type, personal } = await status();
		expect(type).toBe("error");
		expect(text).toContain("url: not set");
		expect(text).toContain("token: not set");
		expect(text).toContain(`set url and token in ${personal} (for example token: "!cat ~/.config/omp-cloud/service.token")`);
		expect(text).toContain("OMP_CLOUD_URL and OMP_CLOUD_TOKEN");
	});

	test("a personal file that is not valid YAML is an error naming it", async () => {
		const { text, type, personal } = await status({ personal: "url: [unclosed\n" });
		expect(type).toBe("error");
		expect(text).toContain(`${personal} is not valid YAML`);
	});
});

describe("/cloud login", () => {
	const URL_SHOWN = "https://auth.example/x?state=s3cr3t";
	let broker: Bun.Server<undefined>;
	let brokerOrigin = "";
	/** Every request the fake service saw: `METHOD path`. */
	let seen: string[] = [];

	beforeAll(() => {
		broker = Bun.serve({
			port: 0,
			fetch: req => {
				const path = new URL(req.url).pathname;
				seen.push(`${req.method} ${path}`);
				if (req.method === "POST" && path === "/api/v1/logins") return Response.json(login({ url: URL_SHOWN, instructions: "Sign in, then paste the address." }), { status: 201 });
				if (req.method === "POST" && path === "/api/v1/logins/l1/input") return Response.json(login({ state: "done", account: "ada" }));
				return Response.json({ error: "not found" }, { status: 404 });
			},
		});
		brokerOrigin = `http://127.0.0.1:${broker.port}`;
	});
	afterAll(() => broker.stop(true));
	beforeEach(() => {
		seen = [];
	});

	async function loginIn(mode: string, idle = true) {
		const env = await cloudEnv(`url: ${brokerOrigin}\ntoken: tok\n`);
		const host = fakeHost({ cwd: await tmp("omp-cloud-repo-"), mode, input: async () => "the-code" });
		host.idle = idle;
		const pi = fakePi();
		await new Cloud(pi.pi, "/own", env, await tmp("omp-cloud-home-"), undefined, undefined, FAST_RETRY).handle("login openai-codex", { ...host.host, switchSession: async () => ({ cancelled: false }) });
		return { host, pi };
	}

	test("in the interactive UI the sign-in link is a transcript card with the full URL, and the model never sees it", async () => {
		const { host, pi } = await loginIn("tui");
		expect(pi.sent).toHaveLength(1);
		const [card] = pi.sent;
		expect(card?.message.customType).toBe("omp-cloud");
		expect(card?.message.display).toBe(true);
		expect(card?.message.details).toMatchObject({ kind: "login", provider: "openai-codex", url: URL_SHOWN, userCode: "", instructions: "Sign in, then paste the address." });
		expect(card?.message.content).not.toContain(URL_SHOWN);
		expect(host.notes.some(([text]) => text.includes(URL_SHOWN))).toBe(false);
		expect(host.notes.at(-1)).toEqual(["☁ the cloud broker is logged in to openai-codex as ada", "info"]);
		expect(seen).toEqual(["POST /api/v1/logins", "POST /api/v1/logins/l1/input"]);
	});

	test("in the interactive UI while the agent is working it refuses before any login starts", async () => {
		const { host, pi } = await loginIn("tui", false);
		expect(host.notes).toEqual([["☁ the agent is working: run /cloud login again when it is idle, so the sign-in link can go in the transcript", "error"]]);
		expect(pi.sent).toEqual([]);
		expect(seen).toEqual([]);
	});

	test("without the interactive UI the link is an info notification and no card is posted", async () => {
		for (const mode of ["rpc", "print"]) {
			seen = [];
			const { host, pi } = await loginIn(mode, false);
			const shown = host.notes.find(([text]) => text.includes(URL_SHOWN));
			expect(shown?.[1]).toBe("info");
			expect(shown?.[0]).toContain(`open: ${URL_SHOWN}`);
			expect(pi.sent).toEqual([]);
			expect(seen).toContain("POST /api/v1/logins");
		}
	});
});

describe("the login offer on /cloud <task>", () => {
	let service: Bun.Server<undefined>;
	let serviceOrigin = "";
	let loggedIn = false;
	/** Every request the fake service saw: `METHOD path`. */
	let seen: string[] = [];

	beforeAll(() => {
		service = Bun.serve({
			port: 0,
			fetch: req => {
				const path = new URL(req.url).pathname;
				seen.push(`${req.method} ${path}`);
				if (path === "/api/v1/whoami") return Response.json(whoami({ modelPatterns: loggedIn ? ["anthropic/*"] : ["openai/*"] }));
				if (req.method === "POST" && path === "/api/v1/logins") return Response.json(login({ url: "https://auth.example/x" }), { status: 201 });
				if (req.method === "POST" && path === "/api/v1/logins/l1/input") {
					loggedIn = true;
					return Response.json(login({ state: "done", account: "ada" }));
				}
				return Response.json({ error: "not found" }, { status: 404 });
			},
		});
		serviceOrigin = `http://127.0.0.1:${service.port}`;
	});
	afterAll(() => service.stop(true));
	beforeEach(() => {
		seen = [];
		loggedIn = false;
	});

	/** Runs `/cloud do it` and waits for the detached launch to report; `confirm` answers the offer. */
	async function launch(o: { mode?: string; idle?: boolean; confirm: boolean }) {
		const env = await cloudEnv(`url: ${serviceOrigin}\ntoken: tok\n`);
		const host = fakeHost({ cwd: await tmp("omp-cloud-repo-"), mode: o.mode ?? "tui", input: async () => "the-code" });
		host.idle = o.idle ?? true;
		const asked: [string, string][] = [];
		host.host.ui.confirm = async (title, message) => {
			asked.push([title, message]);
			return o.confirm;
		};
		// The launch is detached; its failure is the notification this resolves on.
		const { promise: reported, resolve } = Promise.withResolvers<void>();
		const record = host.host.ui.notify;
		host.host.ui.notify = (message, type) => {
			record(message, type);
			if (type === "error") resolve();
		};
		const pi = fakePi();
		await new Cloud(pi.pi, "/own", env, await tmp("omp-cloud-home-"), undefined, undefined, FAST_RETRY).handle("do it", { ...host.host, switchSession: async () => ({ cancelled: false }) });
		for (const run of host.timeouts) run();
		await reported;
		return { host, asked, pi };
	}

	test("yes logs the cloud in, then the launch goes on with the refreshed whoami", async () => {
		const { host, asked, pi } = await launch({ confirm: true });
		expect(asked).toEqual([["Log the cloud in?", "The cloud cannot run anthropic models yet. Log the cloud broker in to anthropic now?"]]);
		expect(seen).toEqual(["GET /api/v1/whoami", "POST /api/v1/logins", "POST /api/v1/logins/l1/input", "GET /api/v1/whoami"]);
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.message.details).toMatchObject({ kind: "login", url: "https://auth.example/x" });
		// The model is served now: the launch got past the model check (the directory is no repository, which is its next complaint).
		const [error = ""] = host.notes.find(([, type]) => type === "error") ?? [];
		expect(error).not.toContain("cannot run");
	});

	test("no keeps today's error and starts no login", async () => {
		const { host, asked } = await launch({ confirm: false });
		expect(asked).toHaveLength(1);
		expect(host.notes.find(([, type]) => type === "error")).toEqual(["☁ handoff failed: the cloud cannot run anthropic models yet: /cloud login anthropic", "error"]);
		expect(seen).not.toContain("POST /api/v1/logins");
	});

	test("outside the interactive UI, or while the agent works, there is no offer: today's error", async () => {
		for (const o of [{ mode: "rpc" }, { idle: false }]) {
			const { host, asked } = await launch({ confirm: true, ...o });
			expect(asked).toEqual([]);
			expect(host.notes.find(([, type]) => type === "error")?.[0]).toBe("☁ handoff failed: the cloud cannot run anthropic models yet: /cloud login anthropic");
		}
		expect(seen).not.toContain("POST /api/v1/logins");
	});
});
