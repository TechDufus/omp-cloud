import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoginController, type LoginFlow, LoginManager } from "../auth/login";
import { handleLogins } from "../server/logins";
import { LOGINS_PATH } from "../server/paths";
import { chooseProvider, type LoginIo, loginMain, loginStep, type LoginStepOptions, type ProviderChoice } from "./login";

const TOKEN = "service-token-do-not-print";
const URL_OF = (provider: string): string => `https://auth.example.com/${provider}/authorize?state=s1`;
const PROVIDERS: ProviderChoice[] = [
	{ id: "paste-provider", name: "Paste Provider" },
	{ id: "device-provider", name: "Device Provider" },
	{ id: "callback-provider", name: "Callback Provider" },
];

let dir: string;
let tokenFile: string;
let manager: LoginManager;
let broker: Bun.Server<undefined>;
let service: Bun.Server<undefined>;
/** Providers the fake service's `whoami` says the cloud can run. */
let patterns: string[];
/** What the scripted provider flows did: `<provider> started`, `<provider> aborted`, `<provider> pasted <text>`. */
let events: string[];
/** Resolves a provider flow that waits for the browser (device code, loopback callback). */
let browser: PromiseWithResolvers<void>;

/** Provider flows scripted the way omp's are: a page to open, then a pasted redirect, a code typed elsewhere or a browser callback. */
const flow: LoginFlow = {
	has: (provider) => [...PROVIDERS.map((p) => p.id), "fail-provider"].includes(provider),
	async run(provider, controller: LoginController) {
		events.push(`${provider} started`);
		controller.signal.addEventListener("abort", () => events.push(`${provider} aborted`), { once: true });
		const done = { provider, credential: { type: "api_key" as const, key: "k", source: "login" as const }, account: "ada@example.com" };
		if (provider === "paste-provider") {
			controller.auth(URL_OF(provider), "");
			const pasted = await controller.prompt("");
			events.push(`${provider} pasted ${pasted}`);
			if (!pasted.includes("code=good")) throw new Error("the code was refused");
			return done;
		}
		if (provider === "device-provider") {
			controller.auth(URL_OF(provider), "Enter code: ABCD-1234");
			await browser.promise;
			return done;
		}
		if (provider === "callback-provider") {
			controller.auth(URL_OF(provider), "");
			// The browser is on the service host: its callback finishes the login with nobody pasting anything.
			await Promise.race([controller.prompt(""), browser.promise]);
			return done;
		}
		controller.auth(URL_OF(provider), "");
		throw new Error("denied by the provider");
	},
};

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-login-"));
	tokenFile = join(dir, "service.token");
	await writeFile(tokenFile, `${TOKEN}\n`);
	await writeFile(join(dir, "broker.token"), "broker-token\n");
	patterns = [];
	events = [];
	browser = Promise.withResolvers<void>();
	broker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("{}", { status: 200 }) });
	manager = new LoginManager({ brokerUrl: `http://127.0.0.1:${broker.port}`, brokerTokenFile: join(dir, "broker.token"), flow });
	service = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: "unauthorized" }, { status: 401 });
			if (url.pathname === "/api/v1/whoami") return Response.json({ modelPatterns: patterns });
			if (url.pathname === LOGINS_PATH || url.pathname.startsWith(`${LOGINS_PATH}/`)) {
				return handleLogins(req, url.pathname.slice(LOGINS_PATH.length).split("/").slice(1), manager);
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
});
afterEach(async () => {
	browser.resolve();
	manager.stop();
	await service.stop(true);
	await broker.stop(true);
	await rm(dir, { recursive: true, force: true });
});

/** A terminal that prints into `lines` and answers `asked` questions from `answers`; once they run out it waits like a person who types nothing. */
interface Terminal {
	io: LoginIo;
	lines: string[];
	asked: string[];
	aborted: boolean[];
}

function terminal(answers: (string | null)[] = [], interactive = true): Terminal {
	const lines: string[] = [];
	const asked: string[] = [];
	const aborted: boolean[] = [];
	const queue = [...answers];
	const io: LoginIo = {
		print: (line) => void lines.push(line),
		interactive,
		ask: async (question, signal) => {
			asked.push(question);
			if (queue.length > 0) return queue.shift() ?? null;
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			aborted.push(true);
			return null;
		},
	};
	return { io, lines, asked, aborted };
}

function options(io: LoginIo, extra: Partial<LoginStepOptions> = {}): LoginStepOptions {
	return { serviceUrl: `http://127.0.0.1:${service.port}`, tokenFile, io, pollMs: 5, sleep: browserFinishes, providers: async () => PROVIDERS, ...extra };
}

/** What a poll waits for: the browser finishes meanwhile, and the poll loop gets one turn of the event loop to see it. */
const browserFinishes = async (): Promise<void> => {
	browser.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("a login with an explicit provider", () => {
	test("device code: the URL comes first and in full, then the code, with nothing to paste; the login ends changed", async () => {
		const term = terminal();
		const steps = await loginStep(options(term.io, { provider: "device-provider" }));

		expect(steps).toEqual([{ id: "login", status: "changed", detail: "logged in to device-provider as ada@example.com" }]);
		expect(term.lines).toEqual([
			[
				"logging the cloud broker in to device-provider",
				`  open: ${URL_OF("device-provider")}`,
				"  enter the code: ABCD-1234",
				"  Enter code: ABCD-1234",
			].join("\n"),
		]);
		expect(term.asked).toEqual([]);
	});

	test("a pasted redirect: a blank Enter waits, the pasted URL finishes the login, and the page says the browser may be elsewhere", async () => {
		const term = terminal(["", "http://localhost:1455/auth/callback?code=good&state=s1"]);
		const steps = await loginStep(options(term.io, { provider: "paste-provider" }));

		expect(steps).toEqual([{ id: "login", status: "changed", detail: "logged in to paste-provider as ada@example.com" }]);
		expect(term.lines[0]?.split("\n")[1]).toBe(`  open: ${URL_OF("paste-provider")}`);
		expect(term.lines[0]).toContain("the browser may be on another machine");
		expect(term.asked).toHaveLength(2);
		expect(term.asked[0]).toContain("paste the redirect URL or code");
		expect(events).toContain("paste-provider pasted http://localhost:1455/auth/callback?code=good&state=s1");
	});

	test("a refused code is a failed step that names the provider's own reason and the command to retry", async () => {
		const steps = await loginStep(options(terminal(["wrong"]).io, { provider: "paste-provider" }));
		expect(steps).toEqual([{ id: "login", status: "failed", detail: "login to paste-provider failed: the code was refused", fix: "omp-cloud login paste-provider" }]);
	});

	test("a browser on the service host finishes the login by itself; the question for a paste is withdrawn", async () => {
		const term = terminal();
		const steps = await loginStep(options(term.io, { provider: "callback-provider" }));
		expect(steps[0]).toMatchObject({ status: "changed", detail: "logged in to callback-provider as ada@example.com" });
		expect(term.asked).toHaveLength(1);
		expect(term.aborted).toEqual([true]);
	});

	test("input that ends (no more typing possible) keeps waiting for the browser instead of giving up", async () => {
		const term = terminal([null]);
		const steps = await loginStep(options(term.io, { provider: "callback-provider" }));
		expect(steps[0]?.status).toBe("changed");
	});

	test("a provider that needs a paste with nobody to type is cancelled at once and tells where to run it", async () => {
		const steps = await loginStep(options(terminal([], false).io, { provider: "paste-provider" }));
		expect(steps).toEqual([
			{ id: "login", status: "failed", detail: "paste-provider needs a pasted redirect URL or code, and there is no terminal to read it from", fix: "omp-cloud login paste-provider" },
		]);
		expect(events).toContain("paste-provider aborted");
	});

	test("a device-code login needs no terminal", async () => {
		const steps = await loginStep(options(terminal([], false).io, { provider: "device-provider" }));
		expect(steps[0]?.status).toBe("changed");
	});

	test("a provider that refuses is a failed step with the reason", async () => {
		const steps = await loginStep(options(terminal().io, { provider: "fail-provider" }));
		expect(steps).toEqual([{ id: "login", status: "failed", detail: "login to fail-provider failed: denied by the provider", fix: "omp-cloud login fail-provider" }]);
	});

	test("it logs in again even when the cloud already runs that provider", async () => {
		patterns = ["device-provider/*"];
		const steps = await loginStep(options(terminal().io, { provider: "device-provider" }));
		expect(steps[0]?.status).toBe("changed");
	});

	test("an unknown provider is the service's 400, as a failed step", async () => {
		const steps = await loginStep(options(terminal().io, { provider: "nope" }));
		expect(steps).toEqual([{ id: "login", status: "failed", detail: 'unknown provider "nope"', fix: "omp-cloud login nope" }]);
	});

	test("waiting longer than maxMs cancels the login on the service and fails", async () => {
		// A deadline already behind it: the first poll finds it passed, and the browser never finished.
		const steps = await loginStep(options(terminal().io, { provider: "device-provider", maxMs: -1, sleep: async () => undefined }));
		expect(steps[0]).toMatchObject({ status: "failed", detail: "login to device-provider did not finish in time", fix: "omp-cloud login device-provider" });
		expect(events).toContain("device-provider aborted");
	});

	test("Ctrl+C (the signal) cancels the login on the service", async () => {
		const abort = new AbortController();
		const steps = await loginStep(options(terminal().io, { provider: "device-provider", signal: abort.signal, sleep: async () => abort.abort() }));
		expect(steps[0]).toMatchObject({ status: "failed", detail: "login to device-provider cancelled" });
		expect(events).toContain("device-provider aborted");
	});
});

describe("a login without a provider", () => {
	test("the cloud already running a provider is reported and nothing starts", async () => {
		patterns = ["anthropic/*", "openai-codex/*"];
		const term = terminal();
		const steps = await loginStep(options(term.io));
		expect(steps).toEqual([{ id: "login", status: "ok", detail: "the cloud can already run anthropic, openai-codex" }]);
		expect(events).toEqual([]);
		expect(term.lines).toEqual([]);
	});

	test("a provider with no `/*` pattern is not a provider", async () => {
		patterns = ["anthropic/claude-opus-5-5"];
		const steps = await loginStep(options(terminal([], false).io));
		expect(steps[0]?.status).toBe("skipped");
	});

	test("nobody to ask: skipped, with the command for later", async () => {
		const steps = await loginStep(options(terminal([], false).io));
		expect(steps).toEqual([{ id: "login", status: "skipped", detail: "no model provider yet; log in later: omp-cloud login <provider>" }]);
	});

	test("the picker lists what the service can log in to; a wrong answer asks again; a number picks and the login runs", async () => {
		const term = terminal(["9", "nope", "2"]);
		const steps = await loginStep(options(term.io));
		expect(term.lines.slice(0, 4)).toEqual(["providers the cloud can log in to:", "  1) Paste Provider (paste-provider)", "  2) Device Provider (device-provider)", "  3) Callback Provider (callback-provider)"]);
		expect(term.lines.filter((line) => line.startsWith("no provider"))).toEqual(['no provider "9" in the list', 'no provider "nope" in the list']);
		expect(steps).toEqual([{ id: "login", status: "changed", detail: "logged in to device-provider as ada@example.com" }]);
	});

	test("a provider typed by id picks it too", async () => {
		const steps = await loginStep(options(terminal(["callback-provider"]).io));
		expect(steps[0]).toMatchObject({ status: "changed", detail: "logged in to callback-provider as ada@example.com" });
	});

	test("Enter at the picker skips and says how to log in later", async () => {
		const steps = await loginStep(options(terminal([""]).io));
		expect(steps).toEqual([{ id: "login", status: "skipped", detail: "no provider chosen; log in later: omp-cloud login <provider>" }]);
		expect(events).toEqual([]);
	});

	test("the picker marks providers the cloud already runs", async () => {
		const term = terminal(["1"]);
		expect(await chooseProvider({ io: term.io, providers: async () => PROVIDERS }, ["device-provider"])).toBe("paste-provider");
		expect(term.lines).toContain("  2) Device Provider (device-provider)  logged in");
		expect(term.lines).toContain("  1) Paste Provider (paste-provider)");
	});
});

describe("when the service cannot be used", () => {
	test("unreachable: a failed step that says where it looked and how to see why", async () => {
		const steps = await loginStep(options(terminal().io, { serviceUrl: "http://127.0.0.1:1", provider: "device-provider" }));
		expect(steps[0]).toMatchObject({ id: "login", status: "failed", fix: "systemctl --user status omp-cloud" });
		expect(steps[0]?.detail).toContain("the service at http://127.0.0.1:1 is not reachable");
	});

	test("a rejected token is named without showing it", async () => {
		await writeFile(tokenFile, "some-other-token\n");
		const steps = await loginStep(options(terminal().io, { provider: "device-provider" }));
		expect(steps[0]).toMatchObject({ status: "failed", detail: "the service rejected service.token" });
		expect(JSON.stringify(steps)).not.toContain("some-other-token");
	});

	test("a missing token file is a failed step naming the file", async () => {
		await rm(tokenFile);
		const steps = await loginStep(options(terminal().io, { provider: "device-provider" }));
		expect(steps[0]?.detail).toBe(`cannot read the service token at ${tokenFile}`);
	});

	test("the token is never printed or returned", async () => {
		const term = terminal();
		const steps = await loginStep(options(term.io, { provider: "device-provider" }));
		expect(JSON.stringify([steps, term.lines, term.asked])).not.toContain(TOKEN);
	});
});

describe("loginMain", () => {
	/** Runs `loginMain` against the fake service through a service.json beside `tokenFile`. */
	async function mainWith(argv: string[], term: Terminal, servicePort: number = service.port ?? 0): Promise<number> {
		const configFile = join(dir, "service.json");
		await writeFile(
			configFile,
			JSON.stringify({
				listen: `127.0.0.1:${servicePort}`,
				apiTokenSha256: "ab".repeat(32),
				dataDir: join(dir, "data"),
				vmon: { url: "http://127.0.0.1:3000", keyFile: join(dir, "vmon.key"), template: "omp-agent" },
				gateway: { url: "http://10.254.254.1:4000", clientsFile: join(dir, "clients.json") },
				broker: { url: "http://127.0.0.1:8765", tokenFile: join(dir, "broker.token") },
				models: { default: "anthropic/claude-sonnet-5" },
			}),
		);
		const saved = process.env.OMP_CLOUD_CONFIG;
		process.env.OMP_CLOUD_CONFIG = configFile;
		try {
			return await loginMain(argv, { io: term.io, providers: async () => PROVIDERS });
		} finally {
			if (saved === undefined) delete process.env.OMP_CLOUD_CONFIG;
			else process.env.OMP_CLOUD_CONFIG = saved;
		}
	}

	test("more than a provider, or an unknown flag, is a usage error", async () => {
		expect(await loginMain(["a", "b"])).toBe(2);
		expect(await loginMain(["--provider"])).toBe(2);
	});

	test("an unreadable service.json fails with exit 1 before it asks anything", async () => {
		const saved = process.env.OMP_CLOUD_CONFIG;
		process.env.OMP_CLOUD_CONFIG = join(dir, "missing.json");
		try {
			expect(await loginMain(["device-provider"])).toBe(1);
		} finally {
			if (saved === undefined) delete process.env.OMP_CLOUD_CONFIG;
			else process.env.OMP_CLOUD_CONFIG = saved;
		}
	});

	test("no provider and no terminal: the providers one per line with id and name, then how to name one, exit 2", async () => {
		patterns = ["device-provider/*"];
		const term = terminal([], false);
		expect(await mainWith([], term)).toBe(2);
		expect(term.lines).toEqual([
			"usage: omp-cloud login [<provider>]",
			"paste-provider  Paste Provider",
			"device-provider  Device Provider  (logged in)",
			"callback-provider  Callback Provider",
			"name one: omp-cloud login <provider>",
		]);
		expect(term.asked).toEqual([]);
		expect(events).toEqual([]);
	});

	test("no provider and no terminal still lists them when the service does not answer", async () => {
		const term = terminal([], false);
		expect(await mainWith([], term, 1)).toBe(2);
		expect(term.lines.slice(1, 4)).toEqual(["paste-provider  Paste Provider", "device-provider  Device Provider", "callback-provider  Callback Provider"]);
		expect(term.lines.at(-1)).toBe("name one: omp-cloud login <provider>");
	});

	test("--help prints the usage and the same list when the service answers, exit 0", async () => {
		const term = terminal([], false);
		expect(await mainWith(["--help"], term)).toBe(0);
		expect(term.lines).toEqual(["usage: omp-cloud login [<provider>]", "paste-provider  Paste Provider", "device-provider  Device Provider", "callback-provider  Callback Provider"]);
		expect(events).toEqual([]);
	});

	test("--help without an answering service prints just the usage", async () => {
		const term = terminal([], false);
		expect(await mainWith(["-h"], term, 1)).toBe(0);
		expect(term.lines).toEqual(["usage: omp-cloud login [<provider>]"]);
	});
});
