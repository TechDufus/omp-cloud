import { createSign, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../guards";
import { GitHubApi, GitHubError } from "./api";

const REPO_URL = "https://github.com/TechDufus/omp-cloud";
const STATE_TTL_MS = 60 * 60_000;
/** A cached installation token is reused until this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;

export interface AppInfo {
	id: number;
	slug: string;
	name: string;
	clientId: string;
	htmlUrl: string;
	owner: { login: string; id: number; type: string };
	createdAt: string;
}

export interface AppInstallation {
	id: number;
	account: string;
	accountType: string;
	selection: "all" | "selected";
	htmlUrl: string;
}

/** The App is connected but has no installation covering the repository. */
export class GitHubAppNotInstalled extends Error {
	override name = "GitHubAppNotInstalled";
}

function base64url(data: string | Buffer): string {
	return Buffer.from(data).toString("base64url");
}

/** Writes `data` to `path` through a temp file and a rename, so a reader never sees half of it. */
async function writeAtomic(path: string, data: string, mode: number): Promise<void> {
	const temp = `${path}.${process.pid}.tmp`;
	try {
		await writeFile(temp, data, { mode });
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

function field(record: Record<string, unknown>, key: string, what: string): string {
	const value = record[key];
	if (typeof value !== "string" || value === "") throw new GitHubError(502, `GitHub's ${what} has no ${key}`);
	return value;
}

function numberField(record: Record<string, unknown>, key: string, what: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new GitHubError(502, `GitHub's ${what} has no ${key}`);
	return value;
}

function parseAppInfo(json: unknown, createdAt: string): { info: AppInfo; pem: string } {
	const what = "answer to the manifest conversion";
	if (!isRecord(json) || !isRecord(json.owner)) throw new GitHubError(502, `GitHub's ${what} is not an App`);
	return {
		info: {
			id: numberField(json, "id", what),
			slug: field(json, "slug", what),
			name: field(json, "name", what),
			clientId: field(json, "client_id", what),
			htmlUrl: field(json, "html_url", what),
			owner: { login: field(json.owner, "login", what), id: numberField(json.owner, "id", what), type: field(json.owner, "type", what) },
			createdAt,
		},
		pem: field(json, "pem", what),
	};
}

function isAppInfo(value: unknown): value is AppInfo {
	return (
		isRecord(value) &&
		typeof value.id === "number" &&
		typeof value.slug === "string" &&
		typeof value.name === "string" &&
		typeof value.clientId === "string" &&
		typeof value.htmlUrl === "string" &&
		typeof value.createdAt === "string" &&
		isRecord(value.owner) &&
		typeof value.owner.login === "string" &&
		typeof value.owner.id === "number" &&
		typeof value.owner.type === "string"
	);
}

/**
 * The GitHub App the owner created through GitHub's manifest flow: its identity and private key on disk, the
 * manifest handshake, and short-lived installation tokens for single repositories.
 */
export class GitHubApp {
	readonly #dir: string;
	readonly #api: GitHubApi;
	readonly #now: () => number;
	#info: AppInfo | null;
	#pem: string | null;
	/** state → the time it expires; made by `manifest`, spent by `convert`. */
	readonly #states = new Map<string, number>();
	/** `owner/repo` (lower-case) → the token and when it expires. */
	readonly #tokens = new Map<string, { token: string; expiresAt: number }>();
	readonly #minting = new Map<string, Promise<string>>();

	private constructor(dir: string, api: GitHubApi, now: () => number, info: AppInfo | null, pem: string | null) {
		this.#dir = dir;
		this.#api = api;
		this.#now = now;
		this.#info = info;
		this.#pem = pem;
	}

	/** Loads the stored App, if any. `now` is a test seam. Throws when the key file is readable by group or other. */
	static async open(dataDir: string, api: GitHubApi, now: () => number = Date.now): Promise<GitHubApp> {
		const dir = join(dataDir, "github");
		const infoPath = join(dir, "app.json");
		const pemPath = join(dir, "app.pem");
		const [hasInfo, hasPem] = await Promise.all([Bun.file(infoPath).exists(), Bun.file(pemPath).exists()]);
		if (!hasInfo && !hasPem) return new GitHubApp(dir, api, now, null, null);
		if (!hasInfo || !hasPem) throw new Error(`the GitHub App in ${dir} is incomplete: app.json and app.pem must both exist`);
		if (((await stat(pemPath)).mode & 0o077) !== 0) throw new Error(`the GitHub App key ${pemPath} must be mode 0600`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(infoPath, "utf8"));
		} catch (error) {
			throw new Error(`the GitHub App file ${infoPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!isAppInfo(parsed)) throw new Error(`the GitHub App file ${infoPath} is malformed`);
		return new GitHubApp(dir, api, now, parsed, await readFile(pemPath, "utf8"));
	}

	connected(): boolean {
		return this.#info !== null && this.#pem !== null;
	}

	info(): AppInfo | null {
		return this.#info;
	}

	/** Where the owner installs the App on repositories. */
	installUrl(): string | null {
		return this.#info === null ? null : `https://github.com/apps/${this.#info.slug}/installations/new`;
	}

	/** Forgets the App: deletes its files and every cached token. */
	async disconnect(): Promise<void> {
		this.#info = null;
		this.#pem = null;
		this.#tokens.clear();
		this.#minting.clear();
		await Promise.all([rm(join(this.#dir, "app.json"), { force: true }), rm(join(this.#dir, "app.pem"), { force: true })]);
	}

	/** What the dashboard posts to GitHub to create the App, and the state that ties GitHub's redirect back to it. */
	manifest({ origin, org }: { origin: string; org: string | null }): { postUrl: string; manifest: string; state: string } {
		const now = this.#now();
		for (const [state, expires] of this.#states) if (expires <= now) this.#states.delete(state);
		const state = randomBytes(16).toString("hex");
		this.#states.set(state, now + STATE_TTL_MS);
		const manifest = JSON.stringify({
			name: `omp-cloud-${randomBytes(3).toString("hex")}`,
			url: REPO_URL,
			hook_attributes: { url: REPO_URL, active: false },
			redirect_url: `${origin}/`,
			setup_url: `${origin}/?github=installed`,
			setup_on_update: true,
			public: false,
			default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
			default_events: [],
		});
		const base = org === null ? "https://github.com/settings/apps/new" : `https://github.com/organizations/${org}/settings/apps/new`;
		return { postUrl: `${base}?state=${state}`, manifest, state };
	}

	/** Completes the manifest flow: trades GitHub's one-time `code` for the App's credentials and stores them. */
	async convert(code: string, state: string): Promise<AppInfo> {
		const expires = this.#states.get(state);
		if (expires === undefined || expires <= this.#now()) {
			this.#states.delete(state);
			throw new GitHubError(400, "this GitHub connection did not start here or expired; start again");
		}
		if (this.connected()) throw new GitHubError(409, "a GitHub App is already connected; disconnect it first");
		this.#states.delete(state);
		const { json } = await this.#api.request<unknown>("POST", `/app-manifests/${encodeURIComponent(code)}/conversions`, { kind: "none" });
		const { info, pem } = parseAppInfo(json, new Date(this.#now()).toISOString());
		if (this.connected()) throw new GitHubError(409, "a GitHub App is already connected; disconnect it first");
		await mkdir(this.#dir, { recursive: true, mode: 0o700 });
		await writeAtomic(join(this.#dir, "app.pem"), pem, 0o600);
		await writeAtomic(join(this.#dir, "app.json"), `${JSON.stringify(info, null, 2)}\n`, 0o600);
		this.#info = info;
		this.#pem = pem;
		return info;
	}

	/** The App's own JWT (RS256, valid 10 minutes from a minute in the past, for clock skew). */
	jwt(): string {
		if (this.#info === null || this.#pem === null) throw new Error("no GitHub App is connected");
		const now = Math.floor(this.#now() / 1000);
		const input = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(this.#info.id) }))}`;
		return `${input}.${base64url(createSign("RSA-SHA256").update(input).sign(this.#pem))}`;
	}

	/** The places the App is installed (the first 100). */
	async installations(): Promise<AppInstallation[]> {
		const { json } = await this.#api.request<unknown>("GET", "/app/installations?per_page=100", { kind: "bearer", value: this.jwt() });
		if (!Array.isArray(json)) throw new GitHubError(502, "GitHub's list of installations is not an array");
		const found: AppInstallation[] = [];
		for (const item of json) {
			if (!isRecord(item) || typeof item.id !== "number" || !isRecord(item.account)) continue;
			const { login, type } = item.account;
			if (typeof login !== "string" || typeof type !== "string") continue;
			found.push({
				id: item.id,
				account: login,
				accountType: type,
				selection: item.repository_selection === "all" ? "all" : "selected",
				htmlUrl: typeof item.html_url === "string" ? item.html_url : "",
			});
		}
		return found;
	}

	/**
	 * A token that lets the App act on `owner/repo` alone. Throws GitHubAppNotInstalled when the App is not installed
	 * there, GitHubError for any other refusal.
	 */
	tokenFor(owner: string, repo: string): Promise<string> {
		const key = `${owner}/${repo}`.toLowerCase();
		const cached = this.#tokens.get(key);
		if (cached !== undefined && cached.expiresAt - TOKEN_MARGIN_MS > this.#now()) return Promise.resolve(cached.token);
		const running = this.#minting.get(key);
		if (running !== undefined) return running;
		const minted = this.#mint(owner, repo, key).finally(() => this.#minting.delete(key));
		this.#minting.set(key, minted);
		return minted;
	}

	async #mint(owner: string, repo: string, key: string): Promise<string> {
		const slug = this.#info?.slug ?? "";
		const auth = { kind: "bearer", value: this.jwt() } as const;
		const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`;
		let installation: unknown;
		try {
			installation = (await this.#api.request<unknown>("GET", path, auth)).json;
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) {
				throw new GitHubAppNotInstalled(`the GitHub App ${slug} is not installed on ${owner}/${repo}: ${this.installUrl()}`);
			}
			throw error;
		}
		if (!isRecord(installation) || typeof installation.id !== "number") throw new GitHubError(502, `GET ${path}: the answer has no installation id`);
		const { json } = await this.#api.request<unknown>("POST", `/app/installations/${installation.id}/access_tokens`, auth, { repositories: [repo] });
		if (!isRecord(json) || typeof json.token !== "string" || typeof json.expires_at !== "string") {
			throw new GitHubError(502, `POST /app/installations/${installation.id}/access_tokens: the answer has no token`);
		}
		const expiresAt = Date.parse(json.expires_at);
		if (Number.isNaN(expiresAt)) throw new GitHubError(502, `POST /app/installations/${installation.id}/access_tokens: expires_at is not a date`);
		this.#tokens.set(key, { token: json.token, expiresAt });
		return json.token;
	}

	/** The committer GitHub attributes to the owner's commits: their noreply address. Null for an App owned by an organization. */
	committer(): { name: string; email: string } | null {
		const owner = this.#info?.owner;
		if (owner === undefined || owner.type !== "User") return null;
		return { name: owner.login, email: `${owner.id}+${owner.login}@users.noreply.github.com` };
	}
}
