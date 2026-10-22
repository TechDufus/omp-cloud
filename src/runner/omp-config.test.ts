import { describe, expect, test } from "bun:test";
import { isRecord } from "../guards";
import { cloudSystemPrompt, GIT_GUARD_PATTERNS, modelsYaml, type OverlayPolicy, overlayConfigYaml } from "./omp-config";

function parse(text: string): Record<string, unknown> {
	const value: unknown = Bun.YAML.parse(text);
	if (!isRecord(value)) throw new Error("not a mapping");
	return value;
}

function roles(overlay: string): unknown {
	return parse(overlay).modelRoles;
}

describe("modelsYaml", () => {
	test("round-trips gateway providers with the token and direct providers as given", () => {
		const direct = { fake: { baseUrl: "http://10.254.254.1:9000/v1", api: "openai-completions", models: [{ id: "m1" }] } };
		const text = modelsYaml({
			gatewayUrl: "http://10.254.254.1:4000",
			token: "12345678e5",
			gateway: ["anthropic", "openai-codex"],
			direct,
		});

		expect(parse(text)).toEqual({
			providers: {
				anthropic: { baseUrl: "http://10.254.254.1:4000", auth: "oauth", transport: "pi-native", apiKey: "12345678e5" },
				"openai-codex": { baseUrl: "http://10.254.254.1:4000", auth: "oauth", transport: "pi-native", apiKey: "12345678e5" },
				...direct,
			},
		});
	});

	test("lists no providers when none are configured", () => {
		expect(parse(modelsYaml({ gatewayUrl: "http://g", token: "t", gateway: [], direct: {} }))).toEqual({ providers: {} });
	});
});

describe("overlayConfigYaml", () => {
	const user = `
modelRoles:
  default: openai/gpt-5
  smol: openai/gpt-5-mini
  slow: fake/slow-model:high
  plan: local-only/model
  bare: nomodel
  weird: 7
defaultThinkingLevel: high
theme: dark
`;
	const OPEN: OverlayPolicy = { bashPatterns: [], toolApproval: {}, fetch: true, webSearch: true, browser: true, readOnly: false };
	const base = { model: "anthropic/claude-x", thinking: "", configYamls: [user], routable: ["anthropic", "openai", "fake"], policy: OPEN, maskSecrets: false, ask: true };

	test("keeps roles whose provider is routable and replaces every other role with the thread's model", () => {
		expect(roles(overlayConfigYaml(base))).toEqual({
			default: "anthropic/claude-x",
			smol: "openai/gpt-5-mini",
			slow: "fake/slow-model:high",
			plan: "anthropic/claude-x",
			bare: "anthropic/claude-x",
			weird: "anthropic/claude-x",
		});
	});

	test("forces the default role to the thread's model even when its provider is routable", () => {
		expect(parse(overlayConfigYaml(base)).modelRoles).toMatchObject({ default: "anthropic/claude-x" });
	});

	test("ask off writes ask.enabled false; ask on leaves the tool's switch alone", () => {
		expect(parse(overlayConfigYaml({ ...base, ask: false })).ask).toEqual({ enabled: false, timeout: 0 });
		expect(parse(overlayConfigYaml(base)).ask).toEqual({ timeout: 0 });
	});

	test("without a user config the only role is default", () => {
		expect(roles(overlayConfigYaml({ ...base, configYamls: [null] }))).toEqual({ default: "anthropic/claude-x" });
		expect(roles(overlayConfigYaml({ ...base, configYamls: [] }))).toEqual({ default: "anthropic/claude-x" });
	});

	test("ignores a config that does not parse or has no roles", () => {
		for (const configYaml of ["modelRoles: [unclosed", "just a string", "theme: dark\n", "modelRoles: nope\n"]) {
			expect(roles(overlayConfigYaml({ ...base, configYamls: [configYaml] }))).toEqual({ default: "anthropic/claude-x" });
		}
	});

	test("overlays are merged over config.yml in order: a role of a later file wins, the rest carry through", () => {
		const claude = `
modelRoles:
  default: anthropic/claude-opus-5-5:high
  smol: anthropic/claude-sonnet-5-5:low
  plan: anthropic/claude-opus-5-5:xhigh
`;
		const later = "modelRoles:\n  smol: openai/gpt-5-nano\n  extra: fake/m\n";
		expect(roles(overlayConfigYaml({ ...base, configYamls: [user, claude] }))).toEqual({
			default: "anthropic/claude-x",
			smol: "anthropic/claude-sonnet-5-5:low",
			slow: "fake/slow-model:high",
			plan: "anthropic/claude-opus-5-5:xhigh",
			bare: "anthropic/claude-x",
			weird: "anthropic/claude-x",
		});
		expect(roles(overlayConfigYaml({ ...base, configYamls: [user, claude, later] }))).toMatchObject({
			smol: "openai/gpt-5-nano",
			extra: "fake/m",
			plan: "anthropic/claude-opus-5-5:xhigh",
		});
		// The reverse order lets config.yml win.
		expect(roles(overlayConfigYaml({ ...base, configYamls: [claude, user] }))).toMatchObject({ smol: "openai/gpt-5-mini", plan: "anthropic/claude-x" });
	});

	test("a missing file in the list is skipped", () => {
		expect(roles(overlayConfigYaml({ ...base, configYamls: [null, user, null] }))).toMatchObject({ smol: "openai/gpt-5-mini" });
	});

	test("sets the thinking level only when the thread has one", () => {
		expect(parse(overlayConfigYaml({ ...base, thinking: "xhigh" })).defaultThinkingLevel).toBe("xhigh");
		expect(parse(overlayConfigYaml(base))).not.toHaveProperty("defaultThinkingLevel");
	});

	test("forces the settings that cannot work in a VM and carries no other user setting", () => {
		const overlay = parse(overlayConfigYaml(base));
		expect(overlay).toMatchObject({
			ask: { timeout: 0 },
			tools: { approvalMode: "yolo" },
			computer: { enabled: false },
			collab: { autoStart: "off" },
			marketplace: { autoUpdate: "off" },
			retry: { enabled: true },
		});
		expect(overlay).not.toHaveProperty("theme");
		expect(overlay).not.toHaveProperty("secrets");
	});

	test("turns omp's memory off, whatever the user's shipped settings say", () => {
		expect(parse(overlayConfigYaml(base)).memory).toEqual({ backend: "off" });
		expect(parse(overlayConfigYaml({ ...base, configYamls: ["memory:\n  backend: mnemopi\n"] })).memory).toEqual({ backend: "off" });
	});

	test("turns omp's secret masking on only when the VM holds secrets", () => {
		expect(parse(overlayConfigYaml({ ...base, maskSecrets: true })).secrets).toEqual({ enabled: true });
		expect(parse(overlayConfigYaml(base))).not.toHaveProperty("secrets");
	});

	describe("policy", () => {
		const patterns = (overlay: string): unknown[] => {
			const bash = parse(overlay).bash;
			if (!isRecord(bash) || !Array.isArray(bash.patterns)) throw new Error("no bash.patterns");
			return bash.patterns;
		};
		const shipped = `
bash:
  patterns:
    - { match: "npm *", approval: allow }
    - { match: "rm *", approval: Prompt }
    - { match: "", approval: deny }
    - { match: "ls", approval: nope }
    - { approval: deny }
    - bare
tools:
  approval:
    bash: allow
    eval: " DENY "
    read: maybe
`;

		test("the git guard is always on, in the order of the probe, and first", () => {
			const written = patterns(overlayConfigYaml(base));
			expect(written).toEqual([...GIT_GUARD_PATTERNS]);
			expect(GIT_GUARD_PATTERNS.every((rule) => rule.approval === "deny")).toBe(true);
			expect(GIT_GUARD_PATTERNS.map((rule) => rule.match).slice(0, 3)).toEqual(["*git*push*", "*git*send-pack*", "*git*remote add*"]);
			expect(GIT_GUARD_PATTERNS.map((rule) => rule.match)).toContain("*gh pr create*");
		});

		test("writes the guard, then the policy's rules in order, then the shipped files' rules in load order", () => {
			const policy: OverlayPolicy = {
				...OPEN,
				bashPatterns: [
					{ match: "npm publish*", approval: "prompt" },
					{ match: "curl *", approval: "deny" },
				],
			};
			const second = "bash:\n  patterns:\n    - { match: 'make *', approval: allow }\n";
			const written = patterns(overlayConfigYaml({ ...base, policy, configYamls: [shipped, null, second] }));
			expect(written).toEqual([
				...GIT_GUARD_PATTERNS,
				{ match: "npm publish*", approval: "prompt" },
				{ match: "curl *", approval: "deny" },
				{ match: "npm *", approval: "allow" },
				{ match: "rm *", approval: "prompt" },
				{ match: "make *", approval: "allow" },
			]);
		});

		test("a shipped allow rule cannot shadow the guard: it comes after every deny of the guard", () => {
			const written = patterns(overlayConfigYaml({ ...base, configYamls: ["bash:\n  patterns:\n    - { match: 'git *', approval: allow }\n"] }));
			expect(written.slice(0, GIT_GUARD_PATTERNS.length)).toEqual([...GIT_GUARD_PATTERNS]);
			expect(written.at(-1)).toEqual({ match: "git *", approval: "allow" });
		});

		test("a policy that sets tools.approval.bash to prompt or deny drops the shipped allow rules and keeps the others", () => {
			for (const bash of ["prompt", "deny"] as const) {
				const policy: OverlayPolicy = { ...OPEN, toolApproval: { bash } };
				const written = patterns(overlayConfigYaml({ ...base, policy, configYamls: [shipped] }));
				expect(written).toEqual([...GIT_GUARD_PATTERNS, { match: "rm *", approval: "prompt" }]);
			}
			const allowed: OverlayPolicy = { ...OPEN, toolApproval: { bash: "allow" } };
			expect(patterns(overlayConfigYaml({ ...base, policy: allowed, configYamls: [shipped] }))).toContainEqual({ match: "npm *", approval: "allow" });
		});

		test("tools.approval is the shipped entries overridden by the policy's, invalid ones dropped", () => {
			const policy: OverlayPolicy = { ...OPEN, toolApproval: { bash: "prompt", write: "deny" } };
			const overlay = parse(overlayConfigYaml({ ...base, policy, configYamls: [shipped] }));
			expect(overlay.tools).toEqual({ approvalMode: "yolo", approval: { bash: "prompt", eval: "deny", write: "deny" } });
			expect(parse(overlayConfigYaml({ ...base, configYamls: [shipped] })).tools).toEqual({
				approvalMode: "yolo",
				approval: { bash: "allow", eval: "deny" },
			});
		});

		test("writes no tools.approval when nothing sets one", () => {
			expect(parse(overlayConfigYaml(base)).tools).toEqual({ approvalMode: "yolo" });
		});

		test("switches off fetch, web search and the browser only when the policy disables them", () => {
			const open = parse(overlayConfigYaml(base));
			for (const key of ["fetch", "web_search", "browser"]) expect(open).not.toHaveProperty(key);
			const closed = parse(overlayConfigYaml({ ...base, policy: { ...OPEN, fetch: false, webSearch: false, browser: false } }));
			expect(closed).toMatchObject({ fetch: { enabled: false }, web_search: { enabled: false }, browser: { enabled: false } });
			const some = parse(overlayConfigYaml({ ...base, policy: { ...OPEN, webSearch: false } }));
			expect(some).toMatchObject({ web_search: { enabled: false } });
			expect(some).not.toHaveProperty("fetch");
			expect(some).not.toHaveProperty("browser");
		});

		test("ignores shipped files that do not parse or have no rules", () => {
			for (const configYaml of ["bash: [unclosed", "bash: nope\n", "bash:\n  patterns: nope\n", "tools: 3\n", null]) {
				const overlay = parse(overlayConfigYaml({ ...base, configYamls: [configYaml] }));
				expect(overlay.bash).toEqual({ patterns: [...GIT_GUARD_PATTERNS] });
				expect(overlay.tools).toEqual({ approvalMode: "yolo" });
			}
		});
	});
});

describe("cloudSystemPrompt", () => {
	const base: Parameters<typeof cloudSystemPrompt>[0] = {
		repoName: "app",
		branch: "omp-cloud/aaaaaaaaaaaa",
		localBranch: "",
		questionTimeoutSeconds: 1800,
		secretFiles: [],
		mcpServers: [],
		parentId: "Parent",
		origin: "",
		secretEnv: [],
		readOnly: false,
	};

	test("names the repository, workspace, branch and question timeout", () => {
		const prompt = cloudSystemPrompt(base);
		expect(prompt).toContain("repository app is checked out at /home/user/work on branch omp-cloud/aaaaaaaaaaaa.");
		expect(prompt).toContain("within 30m");
	});

	test("forbids pushing and remote changes and says the service pushes the branch under the owner's policy", () => {
		const prompt = cloudSystemPrompt(base);
		expect(prompt).toContain("Never push and never add or change git remotes");
		expect(prompt).toContain("The service pushes omp-cloud/aaaaaaaaaaaa when the owner's policy allows it");
		expect(prompt).not.toContain("Do not push");
	});

	test("mentions the local branch only when there is one", () => {
		expect(cloudSystemPrompt({ ...base, localBranch: "feature/x" })).toContain("omp-cloud/aaaaaaaaaaaa, based on feature/x.");
		expect(cloudSystemPrompt(base)).not.toContain("based on");
	});

	test("lists the secret files, or none", () => {
		expect(cloudSystemPrompt({ ...base, secretFiles: [".env", "config/key.pem"] })).toContain(
			"committed: .env, config/key.pem.",
		);
		expect(cloudSystemPrompt(base)).toContain("committed: none.");
	});

	test("names the MCP servers only when the thread ships some", () => {
		expect(cloudSystemPrompt({ ...base, mcpServers: ["fake", "docs"] })).toContain("- MCP servers: fake, docs; the http ones are reached through the service, never print their tokens.");
		expect(cloudSystemPrompt(base)).not.toContain("MCP servers");
	});

	test("names the parent as the IRC peer the agent writes to, and how", () => {
		const prompt = cloudSystemPrompt(base);
		expect(prompt).toContain("`Parent`");
		expect(prompt).toContain('path: "agent://Parent"');
		expect(prompt).toContain("Questions a person must answer still go through `ask`");
	});

	test("uses the parent id it is given", () => {
		const prompt = cloudSystemPrompt({ ...base, parentId: "Boss" });
		expect(prompt).toContain('path: "agent://Boss"');
		expect(prompt).not.toContain("agent://Parent");
	});

	test("formats durations as hours, minutes and seconds", () => {
		expect(cloudSystemPrompt({ ...base, questionTimeoutSeconds: 3600 })).toContain("within 1h ");
		expect(cloudSystemPrompt({ ...base, questionTimeoutSeconds: 5400 })).toContain("within 1h30m ");
		expect(cloudSystemPrompt({ ...base, questionTimeoutSeconds: 45 })).toContain("within 45s ");
		expect(cloudSystemPrompt({ ...base, questionTimeoutSeconds: 0 })).toContain("If nobody answers in time");
	});

	describe("a thread the model started", () => {
		const tool = { ...base, origin: "tool" as const, secretEnv: ["NPM_TOKEN"], mcpServers: ["wiki"] };

		test("is a subagent without the ask tool, with preview, parent and secret-env guidance", () => {
			const prompt = cloudSystemPrompt(tool);
			expect(prompt).toContain("You are a cloud subagent: the omp agent `Parent` delegated this work to you.");
			expect(prompt).not.toContain("use the `ask` tool");
			expect(prompt).not.toContain("go through `ask`");
			expect(prompt).toContain("setsid nohup");
			expect(prompt).toContain('path: "agent://Parent"');
			expect(prompt).toContain("environment variables hold secrets; use them and never print or commit their values: NPM_TOKEN.");
			expect(prompt).toContain("- MCP servers: wiki; the http ones are reached through the service, never print their tokens.");
		});

		test("names the environment variables and the MCP servers only when there are some", () => {
			const prompt = cloudSystemPrompt({ ...tool, secretEnv: [], mcpServers: [] });
			expect(prompt).not.toContain("environment variables");
			expect(prompt).not.toContain("MCP servers");
		});

		test("keeps the commit and push guidance", () => {
			expect(cloudSystemPrompt(tool)).toContain("Never push and never add or change git remotes");
		});
	});

	test("a person's thread keeps the ask guidance and names no environment variables", () => {
		const prompt = cloudSystemPrompt({ ...base, origin: "user", secretEnv: ["NPM_TOKEN"] });
		expect(prompt).toContain("use the `ask` tool");
		expect(prompt).not.toContain("NPM_TOKEN");
	});

	test("a read-only thread of either origin gets the read-only line instead of the commit line", () => {
		for (const origin of ["", "user", "tool"] as const) {
			const prompt = cloudSystemPrompt({ ...base, origin, readOnly: true });
			expect(prompt).toContain("- Read-only: your parent is planning.");
			expect(prompt).not.toContain("Commit as you go");
		}
	});
});
