import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../guards";

/** One entry of the omp gateway's clients file. */
interface ClientEntry {
	tokenSha256: string;
	models?: unknown;
	accounts?: unknown;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ENTRY_FIELDS: Record<string, true> = { tokenSha256: true, models: true, accounts: true };
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const POLL_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 5000;

/** Writers of one file queue behind each other, also across instances. */
const queues = new Map<string, Promise<unknown>>();

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** The gateway re-reads its clients file every 10 s, and revokes every client when any entry has an unknown field or is malformed, so never write over (or onto) one. */
function parseClients(file: string, text: string): Map<string, ClientEntry> {
	const invalid = (where: string, problem: string) => new Error(`${file} is not a valid clients file: ${where}${problem}`);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw invalid("", "not valid JSON");
	}
	if (!isRecord(value)) throw invalid("", "expected an object mapping each client name to its entry");
	const clients = new Map<string, ClientEntry>();
	const digests = new Set<string>();
	for (const [name, entry] of Object.entries(value)) {
		if (!isRecord(entry)) throw invalid(`${name}: `, "expected an object");
		for (const field of Object.keys(entry)) {
			if (!Object.hasOwn(ENTRY_FIELDS, field)) throw invalid(`${name}: `, `unknown field "${field}"`);
		}
		const { tokenSha256, models, accounts } = entry;
		if (typeof tokenSha256 !== "string" || !SHA256_HEX.test(tokenSha256)) {
			throw invalid(`${name}.tokenSha256: `, "expected 64 lowercase hex digits");
		}
		if (digests.has(tokenSha256)) throw invalid(`${name}: `, "another client has the same tokenSha256");
		digests.add(tokenSha256);
		if (models !== undefined && !isStringList(models)) {
			throw invalid(`${name}.models: `, "expected a list of strings");
		}
		if (accounts !== undefined && !(isRecord(accounts) && Object.values(accounts).every(isStringList))) {
			throw invalid(`${name}.accounts: `, "expected an object mapping provider to a list of strings");
		}
		const kept: ClientEntry = { tokenSha256 };
		if (models !== undefined) kept.models = models;
		if (accounts !== undefined) kept.accounts = accounts;
		clients.set(name, kept);
	}
	return clients;
}

/** The per-thread tokens this service registers with the omp auth gateway, kept in the gateway's clients file. A new entry is accepted only after the gateway's next re-read (up to 10 s). */
export class GatewayClients {
	private readonly file: string;
	private readonly url: string;

	constructor(options: { file: string; url: string }) {
		this.file = options.file;
		this.url = options.url.replace(/\/+$/, "");
	}

	/** A fresh random 32-byte hex token for `name`, replacing any entry of that name; returns the token. */
	async issue(name: string): Promise<string> {
		if (name.length === 0 || CONTROL_CHARACTER.test(name)) throw new Error("a gateway client name must be non-empty text");
		const token = randomBytes(32).toString("hex");
		await this.modify(clients => {
			const taken = new Set<string>();
			for (const [other, entry] of clients) if (other !== name) taken.add(entry.tokenSha256);
			const digest = new Bun.CryptoHasher("sha256").update(token).digest("hex");
			if (taken.has(digest)) throw new Error("the new gateway token collides with another client's digest");
			clients.set(name, { tokenSha256: digest });
			return true;
		});
		return token;
	}

	/** True when it removed an entry. */
	async revoke(name: string): Promise<boolean> {
		return this.modify(clients => clients.delete(name));
	}

	async names(): Promise<string[]> {
		return [...(await this.read()).keys()];
	}

	/** Resolves once `GET <url>/v1/models` with the token answers 200; throws after timeoutMs. */
	async waitAccepted(token: string, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		let last = "no response";
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			try {
				const response = await fetch(`${this.url}/v1/models`, {
					headers: { Authorization: `Bearer ${token}` },
					signal: AbortSignal.timeout(Math.min(remaining, REQUEST_TIMEOUT_MS)),
				});
				await response.body?.cancel();
				if (response.status === 200) return;
				last = `status ${response.status}`;
			} catch (error) {
				last = `request failed: ${error instanceof Error ? error.message : String(error)}`;
			}
			const wait = Math.min(POLL_INTERVAL_MS, deadline - Date.now());
			if (wait > 0) await Bun.sleep(wait);
		}
		throw new Error(`the gateway at ${this.url} did not accept the client token within ${timeoutMs} ms (last: ${last})`);
	}

	private async read(): Promise<Map<string, ClientEntry>> {
		let text: string;
		try {
			text = await readFile(this.file, "utf8");
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return new Map();
			throw error;
		}
		return parseClients(this.file, text);
	}

	/** Serialized read-modify-write: `change` returns whether it changed anything; the file is rewritten only then. */
	private modify(change: (clients: Map<string, ClientEntry>) => boolean): Promise<boolean> {
		const previous = queues.get(this.file) ?? Promise.resolve();
		const run = previous.then(async () => {
			const clients = await this.read();
			if (!change(clients)) return false;
			await this.write(clients);
			return true;
		});
		const settled = run.catch(() => {});
		queues.set(this.file, settled);
		void settled.then(() => {
			if (queues.get(this.file) === settled) queues.delete(this.file);
		});
		return run;
	}

	/** Atomic replace: a 0600 temp file next to the target, fsynced, then renamed over it. */
	private async write(clients: Map<string, ClientEntry>): Promise<void> {
		const text = `${JSON.stringify(Object.fromEntries(clients), null, 2)}\n`;
		await mkdir(dirname(this.file), { recursive: true });
		const temp = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			const handle = await open(temp, "wx", 0o600);
			try {
				await handle.writeFile(text);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temp, this.file);
		} catch (error) {
			await unlink(temp).catch(() => {});
			throw error;
		}
	}
}
