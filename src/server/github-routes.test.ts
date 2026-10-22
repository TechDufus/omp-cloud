import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginManager } from "../auth/login";
import { GitService } from "../git";
import { SigningKey } from "../git/signing-key";
import { GitHubApi } from "../github/api";
import { GitHubApp } from "../github/app";
import { isRecord } from "../guards";
import { Settings } from "../settings";
import { Store } from "../store";
import { type App, createApp } from "./app";
import { OWNER_CALLER, tokenSha256, type Caller } from "./auth";
import { OWNER_ONLY_MESSAGE } from "./scopes";

const TOKEN = "s3cret-token";
const ORIGIN = "http://omp.test";
const MODELS = { default: "fake/fake-model", direct: ["fake"], gateway: { providers: () => ["anthropic"], refresh: async (): Promise<void> => undefined } };
const DEVICE: Caller = { kind: "device", principal: "owner", device: { id: "dev1", name: "laptop" } };

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CONVERSION = {
	id: 4242,
	slug: "omp-cloud-abc123",
	name: "omp-cloud-abc123",
	client_id: "Iv1.client",
	client_secret: "client-secret-never-stored",
	webhook_secret: "webhook-secret-never-stored",
	html_url: "https://github.com/apps/omp-cloud-abc123",
	owner: { login: "octocat", id: 583231, type: "User" },
	pem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
};

let dir: string;
let store: Store;
let settings: Settings;
let app: App;
let key: SigningKey;
let githubApp: GitHubApp;
/** `<METHOD> <path>` to the answer; a missing one answers 404. */
let answers: Map<string, () => Response | Promise<Response>>;
let requested: string[];

const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
	const path = url.replace("https://api.github.com", "");
	requested.push(`${init.method} ${path}`);
	return (await answers.get(`${init.method} ${path}`)?.()) ?? Response.json({ message: "Not Found" }, { status: 404 });
};

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-github-routes-"));
	store = Store.open({ dataDir: dir });
	settings = Settings.load(store);
	answers = new Map();
	requested = [];
	const api = new GitHubApi(fetcher);
	githubApp = await GitHubApp.open(dir, api);
	key = SigningKey.open(dir);
	app = createApp({
		store,
		apiTokenSha256: tokenSha256(TOKEN),
		dataDir: dir,
		models: MODELS,
		ompVersion: "18.12.3",
		logins: new LoginManager({ brokerUrl: "http://127.0.0.1:1", brokerTokenFile: "/nonexistent/auth-broker.token" }),
		settings,
		git: await GitService.open({ dataDir: dir, hosts: {}, fetchTimeoutSeconds: 5, pushTimeoutSeconds: 5 }),
		github: { app: githubApp, api, signingKey: key },
	});
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

function send(method: string, path: string, body?: unknown, caller: Caller = OWNER_CALLER): Promise<Response> {
	return app.fetchAs(caller, new Request(ORIGIN + path, { method, body: body === undefined ? undefined : JSON.stringify(body) }));
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
	const body: unknown = await res.json();
	if (!isRecord(body)) throw new Error("expected an object");
	return body;
}

/** Connects the App through the routes, the way the dashboard does. */
async function connect(): Promise<void> {
	answers.set("POST /app-manifests/code-1/conversions", () => Response.json(CONVERSION, { status: 201 }));
	const manifest = await bodyOf(await send("POST", "/api/v1/github/manifest", { origin: ORIGIN }));
	const res = await send("POST", "/api/v1/github/conversions", { code: "code-1", state: manifest.state });
	expect(res.status).toBe(200);
}

describe("owner only", () => {
	test.each<[string, string]>([
		["GET", "/api/v1/github"],
		["POST", "/api/v1/github/manifest"],
		["POST", "/api/v1/github/conversions"],
		["DELETE", "/api/v1/github"],
		["GET", "/api/v1/signing"],
		["POST", "/api/v1/signing/key"],
		["DELETE", "/api/v1/signing/key"],
	])("a paired device gets 403 on %s %s", async (method, path) => {
		const res = await send(method, path, {}, DEVICE);
		expect(res.status).toBe(403);
		expect(await bodyOf(res)).toEqual({ error: OWNER_ONLY_MESSAGE });
	});

	test("no token is 401", async () => {
		const res = await app.fetch(new Request(`${ORIGIN}/api/v1/github`));
		expect(res.status).toBe(401);
	});
});

describe("GET /github", () => {
	test("without an App: nothing, and GitHub is never asked", async () => {
		const res = await send("GET", "/api/v1/github");
		expect(res.status).toBe(200);
		expect(await bodyOf(res)).toEqual({ app: null, installUrl: null, installations: [], installationsError: "" });
		expect(requested).toEqual([]);
	});

	test("with an App: its record, the install link and where it is installed", async () => {
		await connect();
		answers.set("GET /app/installations?per_page=100", () =>
			Response.json([{ id: 9, account: { login: "acme", type: "Organization" }, repository_selection: "selected", html_url: "https://github.com/organizations/acme/settings/installations/9" }]),
		);
		const body = await bodyOf(await send("GET", "/api/v1/github"));
		expect(body.installUrl).toBe("https://github.com/apps/omp-cloud-abc123/installations/new");
		expect(body.app).toMatchObject({ id: 4242, slug: "omp-cloud-abc123", owner: { login: "octocat", id: 583231, type: "User" } });
		expect(JSON.stringify(body)).not.toContain("never-stored");
		expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
		expect(body.installationsError).toBe("");
		expect(body.installations).toEqual([
			{ id: 9, account: "acme", accountType: "Organization", selection: "selected", htmlUrl: "https://github.com/organizations/acme/settings/installations/9" },
		]);
	});

	test("a failing installations listing is reported in the body, not as an error", async () => {
		await connect();
		answers.set("GET /app/installations?per_page=100", () => Response.json({ message: "Bad credentials" }, { status: 401 }));
		const res = await send("GET", "/api/v1/github");
		expect(res.status).toBe(200);
		const body = await bodyOf(res);
		expect(body.installations).toEqual([]);
		expect(String(body.installationsError)).toContain("Bad credentials");
	});
});

describe("POST /github/manifest", () => {
	test("returns the post URL, the manifest and the state; an organization changes the URL", async () => {
		const res = await send("POST", "/api/v1/github/manifest", { origin: "http://127.0.0.1:8081" });
		expect(res.status).toBe(200);
		const body = await bodyOf(res);
		expect(body.state).toMatch(/^[0-9a-f]{32}$/);
		expect(body.postUrl).toBe(`https://github.com/settings/apps/new?state=${String(body.state)}`);
		expect(JSON.parse(String(body.manifest))).toMatchObject({ redirect_url: "http://127.0.0.1:8081/" });

		const org = await bodyOf(await send("POST", "/api/v1/github/manifest", { origin: "https://omp.example.com/", org: "acme-inc" }));
		expect(org.postUrl).toStartWith("https://github.com/organizations/acme-inc/settings/apps/new?state=");
	});

	test.each<[string, unknown]>([
		["no origin", {}],
		["a non-string origin", { origin: 5 }],
		["a path", { origin: "http://127.0.0.1:8081/app" }],
		["a query", { origin: "http://127.0.0.1:8081/?a=1" }],
		["a hash", { origin: "http://127.0.0.1:8081/#x" }],
		["credentials", { origin: "http://user:pw@127.0.0.1:8081" }],
		["another scheme", { origin: "ftp://127.0.0.1" }],
		["not a URL", { origin: "localhost" }],
	])("refuses %s", async (_label, body) => {
		expect((await send("POST", "/api/v1/github/manifest", body)).status).toBe(400);
	});

	test.each<[string, unknown]>([
		["a path in the organization", "a/b"],
		["a space", "a b"],
		["too long", "a".repeat(40)],
		["not a string", 7],
	])("refuses an organization with %s", async (_label, org) => {
		expect((await send("POST", "/api/v1/github/manifest", { origin: ORIGIN, org })).status).toBe(400);
	});

	test("refuses a body that is not JSON", async () => {
		const res = await app.fetchAs(OWNER_CALLER, new Request(`${ORIGIN}/api/v1/github/manifest`, { method: "POST", body: "nope" }));
		expect(res.status).toBe(400);
	});
});

describe("POST /github/conversions", () => {
	test("stores the App and answers its record", async () => {
		answers.set("POST /app-manifests/code-1/conversions", () => Response.json(CONVERSION, { status: 201 }));
		const manifest = await bodyOf(await send("POST", "/api/v1/github/manifest", { origin: ORIGIN }));
		const res = await send("POST", "/api/v1/github/conversions", { code: "code-1", state: manifest.state });
		expect(res.status).toBe(200);
		expect(await bodyOf(res)).toMatchObject({ app: { slug: "omp-cloud-abc123" } });
		expect(githubApp.connected()).toBe(true);
	});

	test("an unknown state is a 400, an App already connected a 409", async () => {
		const unknown = await send("POST", "/api/v1/github/conversions", { code: "c", state: "f".repeat(32) });
		expect(unknown.status).toBe(400);
		expect(String((await bodyOf(unknown)).error)).toContain("did not start here or expired");

		await connect();
		const manifest = await bodyOf(await send("POST", "/api/v1/github/manifest", { origin: ORIGIN }));
		const again = await send("POST", "/api/v1/github/conversions", { code: "code-1", state: manifest.state });
		expect(again.status).toBe(409);
		expect(String((await bodyOf(again)).error)).toContain("already connected");
	});

	test("GitHub refusing the code or failing is a 502 that names what GitHub said", async () => {
		const manifest = await bodyOf(await send("POST", "/api/v1/github/manifest", { origin: ORIGIN }));
		const refused = await send("POST", "/api/v1/github/conversions", { code: "bad", state: manifest.state });
		expect(refused.status).toBe(502);
		expect(String((await bodyOf(refused)).error)).toStartWith("GitHub answered 404: ");

		const second = await bodyOf(await send("POST", "/api/v1/github/manifest", { origin: ORIGIN }));
		answers.set("POST /app-manifests/boom/conversions", () => Response.json({ message: "Server Error" }, { status: 503 }));
		const down = await send("POST", "/api/v1/github/conversions", { code: "boom", state: second.state });
		expect(down.status).toBe(502);
		expect(String((await bodyOf(down)).error)).toStartWith("GitHub answered 503: ");
	});

	test.each<[string, unknown]>([
		["no code", { state: "x" }],
		["no state", { code: "x" }],
		["an empty code", { code: "", state: "x" }],
	])("refuses %s", async (_label, body) => {
		expect((await send("POST", "/api/v1/github/conversions", body)).status).toBe(400);
	});
});

describe("DELETE /github", () => {
	test("forgets the App, and is the same with none", async () => {
		await connect();
		const res = await send("DELETE", "/api/v1/github");
		expect(res.status).toBe(202);
		expect(await bodyOf(res)).toEqual({ status: "disconnected" });
		expect(githubApp.connected()).toBe(false);
		expect((await send("DELETE", "/api/v1/github")).status).toBe(202);
	});
});

describe("whoami", () => {
	test("names the App and says whether commits are signed", async () => {
		expect((await bodyOf(await send("GET", "/api/v1/whoami"))).github).toEqual({ app: null, signing: false });
		await connect();
		await send("POST", "/api/v1/signing/key");
		expect((await bodyOf(await send("GET", "/api/v1/whoami"))).github).toEqual({ app: "omp-cloud-abc123", signing: false });
		settings.apply({ "git.sign": "ssh" }, "owner");
		expect((await bodyOf(await send("GET", "/api/v1/whoami"))).github).toEqual({ app: "omp-cloud-abc123", signing: true });
		await send("DELETE", "/api/v1/signing/key");
		expect((await bodyOf(await send("GET", "/api/v1/whoami"))).github).toEqual({ app: "omp-cloud-abc123", signing: false });
	});
});

describe("the signing key", () => {
	test("without a key every field is null, and GitHub is not asked", async () => {
		const res = await send("GET", "/api/v1/signing");
		expect(res.status).toBe(200);
		expect(await bodyOf(res)).toEqual({ publicKey: null, fingerprint: null, createdAt: null, committer: null, github: null });
		expect(requested).toEqual([]);
	});

	test("POST /key makes it once, 409 the second time, and the private half never leaves the host", async () => {
		const res = await send("POST", "/api/v1/signing/key");
		expect(res.status).toBe(201);
		const made = await bodyOf(res);
		expect(String(made.publicKey)).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+ omp-cloud$/);
		expect(String(made.fingerprint)).toStartWith("SHA256:");
		expect(JSON.stringify(made)).not.toContain("PRIVATE");

		const again = await send("POST", "/api/v1/signing/key");
		expect(again.status).toBe(409);
		expect(await bodyOf(again)).toEqual({ error: "a signing key exists; delete it to replace it" });

		const shown = await bodyOf(await send("GET", "/api/v1/signing"));
		expect(shown).toMatchObject({ publicKey: made.publicKey, fingerprint: made.fingerprint });
		expect(typeof shown.createdAt).toBe("string");
		expect(JSON.stringify(shown)).not.toContain("PRIVATE");
	});

	test("DELETE /key removes it, so a new one can be made", async () => {
		await send("POST", "/api/v1/signing/key");
		const res = await send("DELETE", "/api/v1/signing/key");
		expect(res.status).toBe(202);
		expect(key.exists()).toBe(false);
		expect((await send("POST", "/api/v1/signing/key")).status).toBe(201);
	});

	test("the effective committer is git.committer, else the App owner's noreply address", async () => {
		await connect();
		expect((await bodyOf(await send("GET", "/api/v1/signing"))).committer).toBe("octocat <583231+octocat@users.noreply.github.com>");
		settings.apply({ "git.committer": "Ada Lovelace <ada@example.com>" }, "owner");
		expect((await bodyOf(await send("GET", "/api/v1/signing"))).committer).toBe("Ada Lovelace <ada@example.com>");
	});

	test("registration is read from the App owner's public signing keys by type and key", async () => {
		await connect();
		const made = await bodyOf(await send("POST", "/api/v1/signing/key"));
		const [type, blob] = String(made.publicKey).split(" ");
		answers.set("GET /users/octocat/ssh_signing_keys?per_page=100", () => Response.json([{ id: 1, key: "ssh-rsa AAAA other" }]));
		expect((await bodyOf(await send("GET", "/api/v1/signing"))).github).toEqual({ login: "octocat", registered: false, error: "" });

		answers.set("GET /users/octocat/ssh_signing_keys?per_page=100", () => Response.json([{ id: 2, key: `${type} ${blob}` }]));
		expect((await bodyOf(await send("GET", "/api/v1/signing"))).github).toEqual({ login: "octocat", registered: true, error: "" });
	});

	test("a failed registration check leaves registered null with the reason", async () => {
		await connect();
		await send("POST", "/api/v1/signing/key");
		answers.set("GET /users/octocat/ssh_signing_keys?per_page=100", () => Response.json({ message: "rate limited" }, { status: 403 }));
		const github = (await bodyOf(await send("GET", "/api/v1/signing"))).github;
		expect(github).toMatchObject({ login: "octocat", registered: null });
		expect(String((github as Record<string, unknown>).error)).toContain("rate limited");
	});

	test("an App owned by an organization has no account to check", async () => {
		answers.set("POST /app-manifests/code-1/conversions", () => Response.json({ ...CONVERSION, owner: { login: "acme", id: 5, type: "Organization" } }, { status: 201 }));
		const manifest = await bodyOf(await send("POST", "/api/v1/github/manifest", { origin: ORIGIN }));
		await send("POST", "/api/v1/github/conversions", { code: "code-1", state: manifest.state });
		await send("POST", "/api/v1/signing/key");
		const shown = await bodyOf(await send("GET", "/api/v1/signing"));
		expect(shown.github).toBeNull();
		expect(shown.committer).toBeNull();
	});

	test("unknown paths and methods are 404", async () => {
		expect((await send("GET", "/api/v1/signing/key")).status).toBe(404);
		expect((await send("PUT", "/api/v1/signing")).status).toBe(404);
		expect((await send("GET", "/api/v1/signing/key/extra")).status).toBe(404);
		expect((await send("GET", "/api/v1/github/nothing")).status).toBe(404);
		expect((await send("PUT", "/api/v1/github")).status).toBe(404);
	});
});
