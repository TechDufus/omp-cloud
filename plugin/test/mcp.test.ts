import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planMcp } from "../src/mcp";
import { whoami } from "./builders";
import { cleanup, tmp } from "./helpers";

afterEach(cleanup);

const WITH_PROXY = whoami({ capabilities: ["mcp.proxy"], mcpProxy: true });

async function agentDir(files: Record<string, unknown>): Promise<string> {
	const dir = await tmp("omp-cloud-mcp-");
	await mkdir(dir, { recursive: true });
	for (const [name, doc] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(doc));
	return dir;
}

describe("planMcp", () => {
	test("an http server ships with its headers expanded and resolved, and shows as via the service", async () => {
		const dir = await agentDir({
			"mcp.json": {
				mcpServers: {
					wiki: { type: "http", url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer ${WIKI_TOKEN}", "X-Region": "${REGION:-eu}", "X-Cmd": "!echo from-command" } },
					bare: { url: "https://bare.example.test/mcp" },
				},
			},
		});
		const plan = await planMcp(dir, { WIKI_TOKEN: "t0k" }, whoami({ capabilities: ["mcp.proxy"], mcpProxy: true, mcpLogins: ["https://bare.example.test/mcp"] }));
		expect(plan.servers).toEqual([
			{ name: "wiki", type: "http", url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer t0k", "X-Region": "eu", "X-Cmd": "from-command" } },
			{ name: "bare", type: "http", url: "https://bare.example.test/mcp", headers: {} },
		]);
		expect(plan.summary).toEqual([
			{ name: "wiki", via: "service" },
			{ name: "bare", via: "service" },
		]);
		expect(plan.warnings).toEqual([]);
	});

	test("a server without an Authorization header and without a cloud login gets the login note, and still ships", async () => {
		const dir = await agentDir({ "mcp.json": { mcpServers: { wiki: { type: "http", url: "https://mcp.example.test/mcp" } } } });
		const plan = await planMcp(dir, {}, WITH_PROXY);
		expect(plan.warnings).toEqual(["wiki may need a cloud login: /cloud login mcp:https://mcp.example.test/mcp"]);
		expect(plan.servers).toHaveLength(1);
	});

	test("an authorization header in any case needs no login note", async () => {
		const dir = await agentDir({ "mcp.json": { mcpServers: { wiki: { url: "https://mcp.example.test/mcp", headers: { authorization: "Bearer x" } } } } });
		expect((await planMcp(dir, {}, WITH_PROXY)).warnings).toEqual([]);
	});

	test.each(["http://localhost:8080/mcp", "http://127.0.0.1:9/mcp", "http://[::1]:9/mcp"])("%s points at this machine and is not shipped", async url => {
		const dir = await agentDir({ "mcp.json": { mcpServers: { local: { type: "http", url } } } });
		const plan = await planMcp(dir, {}, WITH_PROXY);
		expect(plan.servers).toEqual([]);
		expect(plan.summary).toEqual([]);
		expect(plan.warnings).toEqual(["local points at this machine and is not shipped"]);
	});

	test("a header that does not resolve keeps the server home, whether its variable is unset or its command prints nothing", async () => {
		const dir = await agentDir({
			"mcp.json": {
				mcpServers: {
					a: { type: "http", url: "https://a.example.test/mcp", headers: { Authorization: "Bearer ${MISSING}" } },
					b: { type: "http", url: "https://b.example.test/mcp", headers: { "X-Key": "!true" } },
				},
			},
		});
		const plan = await planMcp(dir, {}, WITH_PROXY);
		expect(plan.servers).toEqual([]);
		expect(plan.warnings).toEqual(["a is not shipped: header Authorization did not resolve", "b is not shipped: header X-Key did not resolve"]);
	});

	test("without the proxy http servers stay home with one warning, stdio ones still ship", async () => {
		const dir = await agentDir({
			"mcp.json": {
				mcpServers: {
					a: { type: "http", url: "https://a.example.test/mcp" },
					b: { type: "http", url: "https://b.example.test/mcp" },
					fs: { command: "npx", args: ["-y", "server-fs"] },
				},
			},
		});
		const plan = await planMcp(dir, {}, whoami({ capabilities: ["mcp.proxy"], mcpProxy: false }));
		expect(plan.servers.map(s => s.name)).toEqual(["fs"]);
		expect(plan.warnings).toEqual(["the cloud has no MCP proxy; http MCP servers are not shipped"]);
	});

	test("a service without the mcp.proxy capability gets nothing, with a warning", async () => {
		const dir = await agentDir({ "mcp.json": { mcpServers: { fs: { command: "npx" } } } });
		const plan = await planMcp(dir, {}, whoami({ capabilities: [] }));
		expect(plan.servers).toEqual([]);
		expect(plan.warnings).toEqual(["the cloud service cannot take MCP servers; none are shipped"]);
	});

	test("an agent dir with no MCP servers plans nothing and says nothing, whatever the service", async () => {
		const dir = await agentDir({});
		expect(await planMcp(dir, {}, whoami())).toEqual({ servers: [], summary: [], warnings: [] });
	});

	test("an SSE server is not shipped", async () => {
		const dir = await agentDir({ "mcp.json": { mcpServers: { old: { type: "sse", url: "https://old.example.test/sse" } } } });
		const plan = await planMcp(dir, {}, WITH_PROXY);
		expect(plan.servers).toEqual([]);
		expect(plan.warnings).toEqual(["old is not shipped: SSE MCP servers are not proxied; use type http"]);
	});

	test("a stdio server ships when its env only references variables; a literal value keeps it home", async () => {
		const dir = await agentDir({
			"mcp.json": {
				mcpServers: {
					gh: { command: "gh-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", REGION: "${REGION:-eu}" }, cwd: "tools" },
					abs: { type: "stdio", command: "x", cwd: "/home/me/tools" },
					leaky: { command: "leaky", env: { API_KEY: "sk-literal" } },
				},
			},
		});
		const plan = await planMcp(dir, {}, WITH_PROXY);
		expect(plan.servers).toEqual([
			{ name: "gh", type: "stdio", command: "gh-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", REGION: "${REGION:-eu}" }, cwd: "tools" },
			{ name: "abs", type: "stdio", command: "x", args: [], env: {} },
		]);
		expect(plan.summary).toEqual([
			{ name: "gh", via: "vm" },
			{ name: "abs", via: "vm" },
		]);
		expect(plan.warnings).toEqual(["leaky is not shipped: its env has literal values; put them in the cloud's Secrets and reference them as ${NAME}"]);
	});

	test("disabledServers (of either file) and enabled: false skip a server", async () => {
		const dir = await agentDir({
			"mcp.json": { mcpServers: { a: { command: "a" }, b: { command: "b" }, c: { command: "c", enabled: false } }, disabledServers: ["a"] },
			".mcp.json": { mcpServers: { d: { command: "d" }, e: { command: "e" } }, disabledServers: ["d"] },
		});
		expect((await planMcp(dir, {}, WITH_PROXY)).servers.map(s => s.name)).toEqual(["b", "e"]);
	});

	test("mcp.json is read before .mcp.json: the first file that defines a name wins", async () => {
		const dir = await agentDir({
			"mcp.json": { mcpServers: { same: { command: "from-mcp-json" } } },
			".mcp.json": { mcpServers: { same: { command: "from-dot-mcp-json" }, extra: { command: "extra" } } },
		});
		const plan = await planMcp(dir, {}, WITH_PROXY);
		expect(plan.servers).toEqual([
			{ name: "same", type: "stdio", command: "from-mcp-json", args: [], env: {} },
			{ name: "extra", type: "stdio", command: "extra", args: [], env: {} },
		]);
	});

	test("a file that is not JSON is a warning and the other file still ships", async () => {
		const dir = await agentDir({ ".mcp.json": { mcpServers: { ok: { command: "ok" } } } });
		await writeFile(join(dir, "mcp.json"), "{ not json");
		const plan = await planMcp(dir, {}, WITH_PROXY);
		expect(plan.servers.map(s => s.name)).toEqual(["ok"]);
		expect(plan.warnings).toHaveLength(1);
		expect(plan.warnings[0]).toStartWith("mcp.json: MCP servers are not shipped: ");
	});
});
