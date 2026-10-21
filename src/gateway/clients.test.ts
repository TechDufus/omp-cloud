import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayClients } from "./clients";

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const FOREIGN_DIGEST = sha256("someone else's token");

let dir: string;
let file: string;
let clients: GatewayClients;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-clients-"));
	file = join(dir, "clients.json");
	clients = new GatewayClients({ file, url: "http://127.0.0.1:1" });
});

afterEach(() => rm(dir, { recursive: true, force: true }));

async function stored(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(file, "utf8"));
}

describe("issue", () => {
	test("creates the file with the token's digest", async () => {
		const token = await clients.issue("alpha");
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(await stored()).toEqual({ alpha: { tokenSha256: sha256(token) } });
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(await clients.names()).toEqual(["alpha"]);
	});

	test("preserves entries it did not write, with their models and accounts", async () => {
		const foreign = {
			ops: { tokenSha256: FOREIGN_DIGEST, models: ["anthropic/*"], accounts: { anthropic: ["work"] } },
			bare: { tokenSha256: sha256("bare") },
		};
		await writeFile(file, JSON.stringify(foreign));
		const token = await clients.issue("alpha");
		expect(await stored()).toEqual({ ...foreign, alpha: { tokenSha256: sha256(token) } });
	});

	test("replaces an entry of the same name with a new token", async () => {
		const first = await clients.issue("alpha");
		const second = await clients.issue("alpha");
		expect(second).not.toBe(first);
		expect(await stored()).toEqual({ alpha: { tokenSha256: sha256(second) } });
	});

	test("concurrent issues all land", async () => {
		const names = Array.from({ length: 25 }, (_, index) => `client-${index}`);
		const tokens = await Promise.all(names.map(name => clients.issue(name)));
		const other = new GatewayClients({ file, url: "http://127.0.0.1:1" });
		const extra = await Promise.all([other.issue("from-other"), clients.revoke("client-0")]);
		expect(extra[1]).toBe(true);
		const expected: Record<string, unknown> = { "from-other": { tokenSha256: sha256(extra[0]) } };
		names.forEach((name, index) => {
			if (name !== "client-0") expected[name] = { tokenSha256: sha256(tokens[index] as string) };
		});
		expect(await stored()).toEqual(expected);
	});

	test("rejects an empty name", async () => {
		await expect(clients.issue("")).rejects.toThrow("name");
	});
});

describe("revoke", () => {
	test("removes an entry and keeps the others", async () => {
		await clients.issue("alpha");
		await clients.issue("beta");
		expect(await clients.revoke("alpha")).toBe(true);
		expect(await clients.names()).toEqual(["beta"]);
	});

	test("is false for an unknown name, also without a file", async () => {
		expect(await clients.revoke("alpha")).toBe(false);
		await expect(stat(file)).rejects.toThrow();
		await clients.issue("beta");
		expect(await clients.revoke("alpha")).toBe(false);
		expect(await clients.names()).toEqual(["beta"]);
	});
});

describe("an invalid existing file", () => {
	const cases: [string, string][] = [
		["invalid JSON", "{not json"],
		["a non-object", "[]"],
		["an entry that is not an object", JSON.stringify({ a: "x" })],
		["an unknown field", JSON.stringify({ a: { tokenSha256: FOREIGN_DIGEST, label: "x" } })],
		["a malformed digest", JSON.stringify({ a: { tokenSha256: "abc" } })],
		["a duplicate digest", JSON.stringify({ a: { tokenSha256: FOREIGN_DIGEST }, b: { tokenSha256: FOREIGN_DIGEST } })],
		["models that are not a list", JSON.stringify({ a: { tokenSha256: FOREIGN_DIGEST, models: "x" } })],
	];
	for (const [label, content] of cases) {
		test(`is never overwritten: ${label}`, async () => {
			await writeFile(file, content);
			await expect(clients.issue("alpha")).rejects.toThrow(file);
			await expect(clients.revoke("alpha")).rejects.toThrow(file);
			await expect(clients.names()).rejects.toThrow(file);
			expect(await readFile(file, "utf8")).toBe(content);
		});
	}
});

describe("waitAccepted", () => {
	test("polls until the gateway answers 200, sending the bearer token", async () => {
		const seen: (string | null)[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				expect(new URL(request.url).pathname).toBe("/v1/models");
				seen.push(request.headers.get("authorization"));
				return seen.length === 1 ? new Response("no", { status: 401 }) : Response.json({ data: [] });
			},
		});
		try {
			const gateway = new GatewayClients({ file, url: `http://127.0.0.1:${server.port}/` });
			const started = Date.now();
			await gateway.waitAccepted("secret-token", 10_000);
			expect(seen).toEqual(["Bearer secret-token", "Bearer secret-token"]);
			expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		} finally {
			await server.stop(true);
		}
	});

	test("throws with the last status once the time is up, without the token", async () => {
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("no", { status: 401 }) });
		try {
			const gateway = new GatewayClients({ file, url: `http://127.0.0.1:${server.port}` });
			const error = await gateway.waitAccepted("secret-token", 1500).catch(caught => caught);
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("401");
			expect(error.message).not.toContain("secret-token");
		} finally {
			await server.stop(true);
		}
	});

	test("reports a gateway that cannot be reached", async () => {
		const down = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
		const url = `http://127.0.0.1:${down.port}`;
		await down.stop(true);
		const gateway = new GatewayClients({ file, url });
		await expect(gateway.waitAccepted("t", 500)).rejects.toThrow("request failed");
	});
});
