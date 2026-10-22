import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubApp, GitHubAppNotInstalled } from "./app";
import { GitHubApi, GitHubError } from "./api";

interface Call {
	method: string;
	url: string;
	authorization: string | null;
	body: unknown;
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const CONVERSION = {
	id: 4242,
	slug: "omp-cloud-abc123",
	name: "omp-cloud-abc123",
	client_id: "Iv1.client",
	client_secret: "client-secret-never-stored",
	webhook_secret: "webhook-secret-never-stored",
	html_url: "https://github.com/apps/omp-cloud-abc123",
	owner: { login: "octocat", id: 583231, type: "User" },
	pem: APP_PEM,
};

let dataDir: string;
let clock: number;
let calls: Call[];
/** path → answer; a missing path answers 404 `{"message": "Not Found"}`. */
let answers: Map<string, () => { status: number; json: unknown }>;

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
	const path = url.replace("https://api.github.com", "");
	const headers = new Headers(init.headers);
	calls.push({ method: init.method ?? "GET", url: path, authorization: headers.get("authorization"), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
	const answer = answers.get(`${init.method} ${path}`);
	if (answer === undefined) return json(404, { message: "Not Found" });
	const { status, json: body } = answer();
	return json(status, body);
};

async function openApp(): Promise<GitHubApp> {
	return GitHubApp.open(dataDir, new GitHubApi(fetcher), () => clock);
}

async function connect(app: GitHubApp): Promise<void> {
	answers.set("POST /app-manifests/code-1/conversions", () => ({ status: 201, json: CONVERSION }));
	await app.convert("code-1", app.manifest({ origin: "http://localhost:8081", org: null }).state);
}

function installationAnswers(expiresAt: () => string, counter: { tokens: number }): void {
	answers.set("GET /repos/acme/widgets/installation", () => ({ status: 200, json: { id: 77 } }));
	answers.set("POST /app/installations/77/access_tokens", () => {
		counter.tokens++;
		return { status: 201, json: { token: `ghs_token_${counter.tokens}`, expires_at: expiresAt() } };
	});
}

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "github-app-"));
	clock = Date.parse("2026-10-21T12:00:00Z");
	calls = [];
	answers = new Map();
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

describe("GitHubApp manifest flow", () => {
	test("a fresh data directory has no App", async () => {
		const app = await openApp();
		expect(app.connected()).toBe(false);
		expect(app.info()).toBeNull();
		expect(app.installUrl()).toBeNull();
		expect(app.committer()).toBeNull();
	});

	test("manifest returns the post URL, a 32 hex state and the manifest JSON", async () => {
		const app = await openApp();
		const user = app.manifest({ origin: "http://localhost:8081", org: null });
		expect(user.state).toMatch(/^[0-9a-f]{32}$/);
		expect(user.postUrl).toBe(`https://github.com/settings/apps/new?state=${user.state}`);
		const manifest = JSON.parse(user.manifest);
		expect(manifest).toEqual({
			name: expect.stringMatching(/^omp-cloud-[0-9a-f]{6}$/),
			url: "https://github.com/TechDufus/omp-cloud",
			hook_attributes: { url: "https://github.com/TechDufus/omp-cloud", active: false },
			redirect_url: "http://localhost:8081/",
			setup_url: "http://localhost:8081/?github=installed",
			setup_on_update: true,
			public: false,
			default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
			default_events: [],
		});
		expect(app.manifest({ origin: "http://localhost:8081", org: "acme-inc" }).postUrl).toStartWith("https://github.com/organizations/acme-inc/settings/apps/new?state=");
	});

	test("convert stores the App without the secrets, with 0600 files in a 0700 directory, and a reopen finds it", async () => {
		const app = await openApp();
		await connect(app);
		expect(app.connected()).toBe(true);
		expect(app.info()).toEqual({
			id: 4242,
			slug: "omp-cloud-abc123",
			name: "omp-cloud-abc123",
			clientId: "Iv1.client",
			htmlUrl: "https://github.com/apps/omp-cloud-abc123",
			owner: { login: "octocat", id: 583231, type: "User" },
			createdAt: "2026-10-21T12:00:00.000Z",
		});
		expect(app.installUrl()).toBe("https://github.com/apps/omp-cloud-abc123/installations/new");
		expect(calls[0]).toMatchObject({ method: "POST", url: "/app-manifests/code-1/conversions", authorization: null });
		expect((await stat(join(dataDir, "github"))).mode & 0o777).toBe(0o700);
		expect((await stat(join(dataDir, "github", "app.pem"))).mode & 0o777).toBe(0o600);
		expect((await stat(join(dataDir, "github", "app.json"))).mode & 0o777).toBe(0o600);
		const stored = await Bun.file(join(dataDir, "github", "app.json")).text();
		expect(stored).not.toContain("secret");
		const reopened = await openApp();
		expect(reopened.info()).toEqual(app.info());
		expect(() => reopened.jwt()).not.toThrow();
	});

	test("an unknown or expired state is a 400, and a connected App refuses a second conversion with 409", async () => {
		const app = await openApp();
		const unknown = await app.convert("code-1", "f".repeat(32)).catch((e: unknown) => e);
		expect(unknown).toBeInstanceOf(GitHubError);
		expect(unknown).toMatchObject({ status: 400, message: "this GitHub connection did not start here or expired; start again" });

		const { state } = app.manifest({ origin: "http://localhost:8081", org: null });
		clock += 61 * 60_000;
		expect(await app.convert("code-1", state).catch((e: unknown) => e)).toMatchObject({ status: 400 });
		expect(calls).toHaveLength(0);

		await connect(app);
		const again = app.manifest({ origin: "http://localhost:8081", org: null });
		expect(await app.convert("code-2", again.state).catch((e: unknown) => e)).toMatchObject({
			status: 409,
			message: "a GitHub App is already connected; disconnect it first",
		});
	});

	test("a state is single use", async () => {
		const app = await openApp();
		const { state } = app.manifest({ origin: "http://localhost:8081", org: null });
		answers.set("POST /app-manifests/code-1/conversions", () => ({ status: 404, json: { message: "Not Found" } }));
		await expect(app.convert("code-1", state)).rejects.toThrow("POST /app-manifests/code-1/conversions: Not Found");
		expect(await app.convert("code-1", state).catch((e: unknown) => e)).toMatchObject({ status: 400 });
	});

	test("a key file readable by group or other is refused at open", async () => {
		const app = await openApp();
		await connect(app);
		const pem = join(dataDir, "github", "app.pem");
		await chmod(pem, 0o644);
		await expect(openApp()).rejects.toThrow(`the GitHub App key ${pem} must be mode 0600`);
	});

	test("disconnect deletes the files and the App is gone after a reopen", async () => {
		const app = await openApp();
		await connect(app);
		await app.disconnect();
		expect(app.connected()).toBe(false);
		expect(await Bun.file(join(dataDir, "github", "app.json")).exists()).toBe(false);
		expect(await Bun.file(join(dataDir, "github", "app.pem")).exists()).toBe(false);
		expect((await openApp()).connected()).toBe(false);
	});
});

describe("GitHubApp tokens", () => {
	test("the JWT verifies against the key's public half and is valid for 10 minutes from a minute ago", async () => {
		const app = await openApp();
		await connect(app);
		const [header, payload, signature] = app.jwt().split(".");
		expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
		const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
		expect(claims).toEqual({ iat: clock / 1000 - 60, exp: clock / 1000 + 540, iss: "4242" });
		expect(claims.exp - claims.iat).toBe(600);
		const verified = createVerify("RSA-SHA256")
			.update(`${header}.${payload}`)
			.verify(createPublicKey(APP_PEM), Buffer.from(signature ?? "", "base64url"));
		expect(verified).toBe(true);
	});

	test("installations lists the App's installations through the JWT", async () => {
		const app = await openApp();
		await connect(app);
		calls.length = 0;
		answers.set("GET /app/installations?per_page=100", () => ({
			status: 200,
			json: [
				{ id: 1, account: { login: "octocat", type: "User" }, repository_selection: "selected", html_url: "https://github.com/settings/installations/1" },
				{ id: 2, account: { login: "acme", type: "Organization" }, repository_selection: "all", html_url: "https://github.com/organizations/acme/settings/installations/2" },
				{ nonsense: true },
			],
		}));
		expect(await app.installations()).toEqual([
			{ id: 1, account: "octocat", accountType: "User", selection: "selected", htmlUrl: "https://github.com/settings/installations/1" },
			{ id: 2, account: "acme", accountType: "Organization", selection: "all", htmlUrl: "https://github.com/organizations/acme/settings/installations/2" },
		]);
		expect(calls[0]?.authorization).toBe(`Bearer ${app.jwt()}`);
	});

	test("tokenFor mints one repository-scoped token and caches it until 5 minutes before expiry", async () => {
		const app = await openApp();
		await connect(app);
		const counter = { tokens: 0 };
		installationAnswers(() => new Date(clock + 60 * 60_000).toISOString(), counter);
		calls.length = 0;

		expect(await app.tokenFor("acme", "widgets")).toBe("ghs_token_1");
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /repos/acme/widgets/installation", "POST /app/installations/77/access_tokens"]);
		expect(calls[0]?.authorization).toStartWith("Bearer ey");
		expect(calls[1]?.body).toEqual({ repositories: ["widgets"] });

		clock += 54 * 60_000;
		expect(await app.tokenFor("acme", "widgets")).toBe("ghs_token_1");
		expect(await app.tokenFor("ACME", "Widgets")).toBe("ghs_token_1");
		expect(counter.tokens).toBe(1);

		clock += 2 * 60_000;
		expect(await app.tokenFor("acme", "widgets")).toBe("ghs_token_2");
		expect(counter.tokens).toBe(2);
	});

	test("concurrent requests for one repository mint one token", async () => {
		const app = await openApp();
		await connect(app);
		const counter = { tokens: 0 };
		installationAnswers(() => new Date(clock + 60 * 60_000).toISOString(), counter);
		const tokens = await Promise.all([app.tokenFor("acme", "widgets"), app.tokenFor("acme", "widgets"), app.tokenFor("acme", "widgets")]);
		expect(tokens).toEqual(["ghs_token_1", "ghs_token_1", "ghs_token_1"]);
		expect(counter.tokens).toBe(1);
	});

	test("a 404 installation is GitHubAppNotInstalled with the install URL; other failures stay GitHubErrors", async () => {
		const app = await openApp();
		await connect(app);
		const error = await app.tokenFor("acme", "private").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GitHubAppNotInstalled);
		expect((error as Error).message).toBe("the GitHub App omp-cloud-abc123 is not installed on acme/private: https://github.com/apps/omp-cloud-abc123/installations/new");

		answers.set("GET /repos/acme/broken/installation", () => ({ status: 500, json: { message: "Server Error" } }));
		const failure = await app.tokenFor("acme", "broken").catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(GitHubError);
		expect(failure).toMatchObject({ status: 500, message: "GET /repos/acme/broken/installation: Server Error" });
	});

	test("disconnect drops cached tokens", async () => {
		const app = await openApp();
		await connect(app);
		installationAnswers(() => new Date(clock + 60 * 60_000).toISOString(), { tokens: 0 });
		await app.tokenFor("acme", "widgets");
		await app.disconnect();
		expect(() => app.jwt()).toThrow("no GitHub App is connected");
	});

	test("committer is the owner's noreply address for a user, null for an organization", async () => {
		const app = await openApp();
		await connect(app);
		expect(app.committer()).toEqual({ name: "octocat", email: "583231+octocat@users.noreply.github.com" });
		await app.disconnect();
		answers.set("POST /app-manifests/code-1/conversions", () => ({ status: 201, json: { ...CONVERSION, owner: { login: "acme", id: 9, type: "Organization" } } }));
		await app.convert("code-1", app.manifest({ origin: "http://localhost:8081", org: "acme" }).state);
		expect(app.committer()).toBeNull();
	});
});
