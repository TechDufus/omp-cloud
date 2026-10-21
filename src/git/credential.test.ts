import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrub, writeCredentialHelper } from "./credential";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-cred-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** Runs the helper the way git does: `<helper> get`, the request on stdin. */
async function ask(helper: string, request: Record<string, string>, verb = "get"): Promise<string> {
	const stdin = `${Object.entries(request).map(([k, v]) => `${k}=${v}`).join("\n")}\n\n`;
	const proc = Bun.spawn([helper, verb], { cwd: dir, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
	const [out, code] = await Promise.all([proc.stdout.text(), proc.exited]);
	expect(code).toBe(0);
	return out;
}

const INPUT = { protocol: "https", host: "github.com", username: "x-access-token", token: "tok-SECRET-123" };

describe("writeCredentialHelper", () => {
	test("answers the configured host with the username and the token", async () => {
		const helper = await writeCredentialHelper(dir, INPUT);
		expect(await ask(helper, { protocol: "https", host: "github.com", path: "acme/app.git" })).toBe("username=x-access-token\npassword=tok-SECRET-123\n");
	});

	test.each([
		["another host", { protocol: "https", host: "evil.example" }],
		["a subdomain", { protocol: "https", host: "api.github.com" }],
		["a host that only starts with it", { protocol: "https", host: "github.com.evil.example" }],
		["the host with a port", { protocol: "https", host: "github.com:8443" }],
		["another protocol", { protocol: "http", host: "github.com" }],
		["no host", { protocol: "https" }],
		["nothing", {}],
	])("answers nothing for %s", async (_label, request) => {
		const helper = await writeCredentialHelper(dir, INPUT);
		expect(await ask(helper, request)).toBe("");
	});

	test("answers nothing to store or erase", async () => {
		const helper = await writeCredentialHelper(dir, INPUT);
		expect(await ask(helper, { protocol: "https", host: "github.com" }, "store")).toBe("");
		expect(await ask(helper, { protocol: "https", host: "github.com" }, "erase")).toBe("");
	});

	test("matches the host exactly, port included", async () => {
		const helper = await writeCredentialHelper(dir, { ...INPUT, protocol: "http", host: "127.0.0.1:8080" });
		expect(await ask(helper, { protocol: "http", host: "127.0.0.1:8080" })).toContain("password=tok-SECRET-123");
		expect(await ask(helper, { protocol: "http", host: "127.0.0.1:8081" })).toBe("");
	});

	test("the token is in a 0600 file and nowhere in the script, which is 0700", async () => {
		const helper = await writeCredentialHelper(dir, INPUT);
		expect(await readFile(join(dir, "token"), "utf8")).toBe(INPUT.token);
		expect((await stat(join(dir, "token"))).mode & 0o777).toBe(0o600);
		expect((await stat(helper)).mode & 0o777).toBe(0o700);
		expect(await readFile(helper, "utf8")).not.toContain(INPUT.token);
	});

	test("shell metacharacters in the host or username are inert", async () => {
		const helper = await writeCredentialHelper(dir, { ...INPUT, host: "h'; touch pwned; '", username: "u$(touch pwned)" });
		expect(await ask(helper, { protocol: "https", host: "h'; touch pwned; '" })).toBe("username=u$(touch pwned)\npassword=tok-SECRET-123\n");
		expect(await Bun.file(join(dir, "pwned")).exists()).toBe(false);
	});
});

describe("scrub", () => {
	test("removes URL userinfo and the secrets", () => {
		const text = "fatal: unable to access 'https://user:hunter2@github.com/a/b.git/': The requested URL returned error: 403 hunter2";
		const out = scrub(text, ["hunter2"]);
		expect(out).not.toContain("hunter2");
		expect(out).toContain("https://github.com/a/b.git/");
	});

	test("an empty secret replaces nothing", () => {
		expect(scrub("plain text", [""])).toBe("plain text");
	});
});
