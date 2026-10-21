import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CommandExitError, type Sandbox } from "e2b";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../guards";
import { Store } from "../store";
import type { NewThread, Thread } from "../store/types";
import { type ProvisionInput, ompLaunchArgs, provisionVm } from "./provision";
import { VM_AGENT_DIR, VM_CLOUD_DIR } from "./vm-layout";

const ID = "aaaaaaaaaaaa";
const HANDOFF = "a".repeat(40);
const OVERLAY_FILE = `${VM_CLOUD_DIR}/config.yml`;
const MODELS = { default: "fake/fake-model", direct: { fake: { baseUrl: "http://10.254.254.1:9000/v1", api: "openai-completions" } } };

let dir: string;
let store: Store;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	store = Store.open({ dataDir: dir });
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

function newThread(overrides: Partial<NewThread> = {}): NewThread {
	return {
		owner: "owner",
		title: "t",
		prompt: "do it",
		model: "anthropic/claude-sonnet-5-5:high",
		thinking: "",
		repo: { name: "repo", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: HANDOFF, localBranch: "main" },
		paths: { home: "", workspace: "" },
		author: { name: "", email: "" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
		...overrides,
	};
}

async function createThread(overrides: Partial<NewThread> = {}): Promise<Thread> {
	store.createThread(ID, newThread(overrides));
	await store.putBlob(ID, "source.bundle", new TextEncoder().encode("bundle"), 1024);
	const thread = store.getThread(ID);
	if (thread === null) throw new Error("the thread was not created");
	return thread;
}

/**
 * A sandbox whose files are `present` (path to content) plus what the provisioning writes; commands succeed with the output
 * the flow needs, or what `answer` returns for them, and are recorded in `commands`.
 */
function fakeSandbox(
	present: Record<string, string>,
	answer: (command: string) => string | undefined = () => undefined,
): { sandbox: Sandbox; written: Map<string, string>; commands: string[] } {
	const written = new Map<string, string>();
	const commands: string[] = [];
	const sandbox = {
		commands: {
			run: async (command: string) => {
				commands.push(command);
				const answered = answer(command);
				if (answered !== undefined) return { stdout: answered };
				return { stdout: command.startsWith("mktemp") ? "/tmp/transfer\n" : command.includes("rev-parse") ? `${HANDOFF}\n` : "" };
			},
		},
		files: {
			exists: async (path: string) => path in present || written.has(path),
			read: async (path: string) => present[path] ?? written.get(path) ?? "",
			write: async (path: string, data: unknown) => {
				written.set(path, typeof data === "string" ? data : data instanceof ReadableStream ? await new Response(data).text() : "");
			},
		},
	} as unknown as Sandbox;
	return { sandbox, written, commands };
}

function parse(text: string | undefined): Record<string, unknown> {
	const value: unknown = Bun.YAML.parse(text ?? "");
	if (!isRecord(value)) throw new Error("not a mapping");
	return value;
}

describe("ompLaunchArgs", () => {
	test("each shipped overlay in order, then the service's own, which wins", async () => {
		const thread = await createThread({ configOverlays: ["overlays/claude.yml", "later.yml"], thinking: "high" });
		expect(ompLaunchArgs(thread, MODELS, "/home/user/.omp/agent/sessions/s.jsonl")).toEqual([
			"--config",
			`${VM_AGENT_DIR}/overlays/claude.yml`,
			"--config",
			`${VM_AGENT_DIR}/later.yml`,
			"--config",
			OVERLAY_FILE,
			"--append-system-prompt",
			`${VM_CLOUD_DIR}/system-prompt.md`,
			"-e",
			`${VM_CLOUD_DIR}/irc-peer.ts`,
			"--model",
			"anthropic/claude-sonnet-5-5:high",
			"--thinking",
			"high",
			"--resume",
			"/home/user/.omp/agent/sessions/s.jsonl",
		]);
	});

	test("without overlays only the service's overlay loads, and the default model fills in", async () => {
		const thread = await createThread({ model: "" });
		expect(ompLaunchArgs(thread, MODELS, null)).toEqual([
			"--config",
			OVERLAY_FILE,
			"--append-system-prompt",
			`${VM_CLOUD_DIR}/system-prompt.md`,
			"-e",
			`${VM_CLOUD_DIR}/irc-peer.ts`,
			"--model",
			"fake/fake-model",
		]);
	});
});

describe("provisionVm", () => {
	const input = (thread: Thread, served: string[]): ProvisionInput => ({
		thread,
		store,
		git: {
			composeSource: async () => {
				throw new Error("a full-history thread never composes a source");
			},
		},
		gatewayUrl: "http://10.254.254.1:4000",
		token: "tok",
		models: MODELS,
		served,
		questionTimeoutSeconds: 60,
		policy: { bashPatterns: [], toolApproval: {}, fetch: true, webSearch: true, browser: true },
	});

	test("an overlay the setup did not ship fails with its path", async () => {
		const thread = await createThread({ configOverlays: ["overlays/claude.yml"] });
		const { sandbox, written } = fakeSandbox({ [`${VM_AGENT_DIR}/config.yml`]: "theme: dark\n" });
		await expect(provisionVm(sandbox, input(thread, ["anthropic"]))).rejects.toThrow("the overlay overlays/claude.yml is not in the shipped setup");
		expect(written.has(OVERLAY_FILE)).toBe(false);
	});

	test("lists every served provider in models.yml and merges the overlays over config.yml for the role rule", async () => {
		const thread = await createThread({ configOverlays: ["overlays/claude.yml"], thinking: "low" });
		const { sandbox, written } = fakeSandbox({
			[`${VM_AGENT_DIR}/config.yml`]: "modelRoles:\n  default: openai-codex/gpt-6\n  smol: openai-codex/gpt-6-mini\n  slow: fake/slow\n",
			[`${VM_AGENT_DIR}/overlays/claude.yml`]: "modelRoles:\n  default: anthropic/claude-opus-5-5:high\n  smol: anthropic/claude-sonnet-5-5:low\n",
		});
		const provisioned = await provisionVm(sandbox, input(thread, ["anthropic", "openai-codex"]));

		const providers = parse(written.get(`${VM_AGENT_DIR}/models.yml`)).providers;
		expect(Object.keys(isRecord(providers) ? providers : {})).toEqual(["anthropic", "openai-codex", "fake"]);
		// smol comes from the overlay (later file wins); slow's provider is direct; default is the thread's model.
		expect(parse(written.get(OVERLAY_FILE)).modelRoles).toEqual({
			default: "anthropic/claude-sonnet-5-5:high",
			smol: "anthropic/claude-sonnet-5-5:low",
			slow: "fake/slow",
		});
		expect(provisioned.extraArgs.slice(0, 4)).toEqual(["--config", `${VM_AGENT_DIR}/overlays/claude.yml`, "--config", OVERLAY_FILE]);
	});

	test("ships the IRC extension as the source embedded in the service, and the parent's identity", async () => {
		const thread = await createThread();
		const { sandbox, written } = fakeSandbox({ [`${VM_AGENT_DIR}/config.yml`]: "theme: dark\n" });
		const provisioned = await provisionVm(sandbox, input(thread, ["anthropic"]));

		expect(written.get(`${VM_CLOUD_DIR}/irc-peer.ts`)).toBe(await Bun.file(join(import.meta.dir, "vm-extension", "irc-peer.ts")).text());
		const config: unknown = JSON.parse(written.get(`${VM_CLOUD_DIR}/irc.json`) ?? "null");
		expect(config).toMatchObject({ thread: ID, parent: { id: "Parent", displayName: "Parent" } });
		// the extension loads with the same path it was written to
		const at = provisioned.extraArgs.indexOf("-e");
		expect(at).toBeGreaterThan(-1);
		expect(provisioned.extraArgs[at + 1]).toBe(`${VM_CLOUD_DIR}/irc-peer.ts`);
		expect(written.get(`${VM_CLOUD_DIR}/system-prompt.md`)).toContain("agent://Parent");
	});

	test("a role whose provider is not served runs on the thread's model", async () => {
		const thread = await createThread();
		const { sandbox, written } = fakeSandbox({
			[`${VM_AGENT_DIR}/config.yml`]: "modelRoles:\n  default: openai-codex/gpt-6\n  smol: openai-codex/gpt-6-mini\n",
		});
		await provisionVm(sandbox, input(thread, ["anthropic"]));
		expect(parse(written.get(OVERLAY_FILE)).modelRoles).toEqual({
			default: "anthropic/claude-sonnet-5-5:high",
			smol: "anthropic/claude-sonnet-5-5:high",
		});
	});

	test("the overlay carries the owner's policy over the shipped rules, the git guard first", async () => {
		const thread = await createThread();
		const { sandbox, written } = fakeSandbox({
			[`${VM_AGENT_DIR}/config.yml`]: "bash:\n  patterns:\n    - { match: 'make *', approval: allow }\n",
		});
		const policy: ProvisionInput["policy"] = {
			bashPatterns: [{ match: "npm publish*", approval: "prompt" }],
			toolApproval: { eval: "deny" },
			fetch: false,
			webSearch: true,
			browser: true,
		};
		await provisionVm(sandbox, { ...input(thread, ["anthropic"]), policy });
		const overlay = parse(written.get(OVERLAY_FILE));
		const patterns = isRecord(overlay.bash) && Array.isArray(overlay.bash.patterns) ? overlay.bash.patterns : [];
		expect(patterns[0]).toEqual({ match: "*git*push*", approval: "deny" });
		expect(patterns.slice(-2)).toEqual([
			{ match: "npm publish*", approval: "prompt" },
			{ match: "make *", approval: "allow" },
		]);
		expect(overlay.tools).toEqual({ approvalMode: "yolo", approval: { eval: "deny" } });
		expect(overlay.fetch).toEqual({ enabled: false });
	});

	describe("a delta thread", () => {
		const BASE = "b".repeat(40);
		const BUNDLE = "/tmp/transfer/source.bundle";

		/** A git whose `composeSource` hands out a full-history bundle file and counts what it was asked and released. */
		async function composing(): Promise<{ git: ProvisionInput["git"]; asked: string[][]; released: () => number }> {
			const path = join(dir, "composed.bundle");
			await writeFile(path, "full history bundle");
			const asked: string[][] = [];
			let released = 0;
			return {
				asked,
				released: () => released,
				git: {
					composeSource: async (id, remote) => {
						asked.push([id, remote]);
						return { path, release: async () => void released++ };
					},
				},
			};
		}

		test("restores from the composed full-history bundle, not the uploaded delta, and releases it", async () => {
			const thread = await createThread({ repo: { ...newThread().repo, baseCommit: BASE, remoteURL: "https://git.example.com/a/b.git" } });
			const { sandbox, written } = fakeSandbox({});
			const { git, asked, released } = await composing();
			await provisionVm(sandbox, { ...input(thread, []), git });
			expect(asked).toEqual([[ID, "https://git.example.com/a/b.git"]]);
			expect(written.get(BUNDLE)).toBe("full history bundle");
			expect(released()).toBe(1);
		});

		test("needs no uploaded source blob", async () => {
			store.createThread(ID, newThread({ repo: { ...newThread().repo, baseCommit: BASE, remoteURL: "https://git.example.com/a/b.git" } }));
			const thread = store.getThread(ID);
			if (thread === null) throw new Error("the thread was not created");
			const { sandbox, written } = fakeSandbox({});
			const { git } = await composing();
			await provisionVm(sandbox, { ...input(thread, []), git });
			expect(written.get(BUNDLE)).toBe("full history bundle");
		});

		test("a git cache that lost the thread fails the provisioning with its reason", async () => {
			const thread = await createThread({ repo: { ...newThread().repo, baseCommit: BASE } });
			const { sandbox } = fakeSandbox({});
			const git: ProvisionInput["git"] = {
				composeSource: async () => {
					throw new Error(`the git cache holds no handoff of thread ${ID}`);
				},
			};
			await expect(provisionVm(sandbox, { ...input(thread, []), git })).rejects.toThrow("holds no handoff");
		});
	});

	test("a full-history thread uploads its stored bundle and never composes one", async () => {
		const thread = await createThread();
		const { sandbox, written } = fakeSandbox({});
		await provisionVm(sandbox, input(thread, []));
		expect(written.get("/tmp/transfer/source.bundle")).toBe("bundle");
	});

	test("a full-history thread without a stored bundle is refused", async () => {
		store.createThread(ID, newThread());
		const thread = store.getThread(ID);
		if (thread === null) throw new Error("the thread was not created");
		const { sandbox } = fakeSandbox({});
		await expect(provisionVm(sandbox, input(thread, []))).rejects.toThrow("the thread has no source bundle");
	});

	test("a scratch thread restores its stored one-commit base like any full-history thread: never composed, no origin remote", async () => {
		const SCRATCH = "5".repeat(40);
		const thread = await createThread({
			scratch: true,
			repo: { name: "scratch", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: SCRATCH, localBranch: "" },
		});
		const { sandbox, written, commands } = fakeSandbox({}, command => (command.includes("rev-parse") ? `${SCRATCH}\n` : undefined));
		await provisionVm(sandbox, input(thread, []));
		expect(written.get("/tmp/transfer/source.bundle")).toBe("bundle");
		expect(commands.some(command => command.includes("checkout") && command.includes(`omp-cloud/${ID}`))).toBe(true);
		expect(commands.some(command => command.includes("remote.origin.url"))).toBe(false);
	});

	test("a scratch thread whose stored bundle is at another commit is refused like any handoff mismatch", async () => {
		const thread = await createThread({
			scratch: true,
			repo: { name: "scratch", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "5".repeat(40), localBranch: "" },
		});
		const { sandbox } = fakeSandbox({}, command => (command.includes("rev-parse") ? `${"6".repeat(40)}\n` : undefined));
		await expect(provisionVm(sandbox, input(thread, []))).rejects.toThrow("not the handoff commit");
	});

	describe("restoring a thread that already ran", () => {
		const RESULT_HEAD = HANDOFF;
		const OLD_SESSION = "0198a1c0-0000-7000-8000-000000000001";
		const RESUMED = "/home/user/.omp/agent/sessions/restored.jsonl";

		/** The VM's answers to the re-identification and unpack commands; the journal header follows the `sed` that rewrites it. */
		function conversation(): (command: string) => string | undefined {
			let journalId = OLD_SESSION;
			return command => {
				if (command.startsWith("cat ") && command.includes("manifest.json")) {
					return JSON.stringify({ version: 1, id: journalId, cwd: "/work", omp: "18.12.3" });
				}
				if (command.startsWith("head -n 4")) return `${JSON.stringify({ type: "session", version: 3, id: journalId, cwd: "/work" })}\n`;
				const sed = /^sed -i '1s\/"id":"[^"]+"\/"id":"([^"]+)"\/'/.exec(command);
				if (sed !== null) {
					journalId = sed[1] ?? journalId;
					return "";
				}
				if (command.startsWith("omp session unpack")) return `${RESUMED}\n`;
				return undefined;
			};
		}

		function completeTurn(head: string): void {
			store.startNextTurn(ID);
			store.completeTurn(ID, 1, {
				outcome: "completed",
				error: "",
				reply: "done",
				usage: null,
				head,
				filesChanged: 0,
				insertions: 0,
				deletions: 0,
				pushed: false,
				pushError: "",
				pushRef: "",
			});
		}

		async function blobs(names: { result?: string; exported?: string; session?: string }): Promise<void> {
			const encode = (body: string) => new TextEncoder().encode(body);
			if (names.result !== undefined) await store.putBlob(ID, "result.bundle", encode(names.result), 1024);
			if (names.exported !== undefined) await store.putBlob(ID, "session-export.tar", encode(names.exported), 1024);
			if (names.session !== undefined) await store.putBlob(ID, "session.tar", encode(names.session), 1024);
		}

		test("applies the result bundle after the source and unpacks the re-identified export under a fresh session id", async () => {
			const thread = await createThread();
			completeTurn(RESULT_HEAD);
			await blobs({ result: "result bundle", exported: "export tar", session: "created tar" });
			const { sandbox, written, commands } = fakeSandbox({}, conversation());

			const provisioned = await provisionVm(sandbox, input(thread, []));

			expect(written.get("/tmp/transfer/source.bundle")).toBe("bundle");
			expect(written.get("/tmp/transfer/result.bundle")).toBe("result bundle");
			// The export, not the conversation the thread was created with.
			expect(written.get("/tmp/transfer/session.tar")).toBe("export tar");
			const at = (part: string) => commands.findIndex(command => command.includes(part));
			expect(at("git init")).toBeGreaterThanOrEqual(0);
			expect(at("git init")).toBeLessThan(at("refs/omp-cloud/result"));
			expect(at("refs/omp-cloud/result")).toBeLessThan(at("session-restored.tar"));
			expect(commands.some(command => command.startsWith("git") && command.includes(`checkout -q -f -B 'omp-cloud/aaaaaaaaaaaa' '${RESULT_HEAD}'`))).toBe(true);
			const sed = commands.find(command => command.startsWith("sed -i")) ?? "";
			expect(sed).toMatch(/"id":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"/);
			expect(commands.some(command => command.startsWith("omp session unpack '/tmp/transfer/session-restored.tar'"))).toBe(true);
			expect(provisioned.extraArgs).toContain("--resume");
			expect(provisioned.extraArgs[provisioned.extraArgs.indexOf("--resume") + 1]).toBe(RESUMED);
		});

		test("without a result bundle the repository stays at the handoff commit", async () => {
			const thread = await createThread();
			await blobs({ exported: "export tar" });
			const { sandbox, commands } = fakeSandbox({}, conversation());

			await provisionVm(sandbox, input(thread, []));

			expect(commands.some(command => command.includes("refs/omp-cloud/result"))).toBe(false);
		});

		test("without an export the conversation the thread was created with unpacks as it is", async () => {
			const thread = await createThread();
			completeTurn(RESULT_HEAD);
			await blobs({ result: "result bundle", session: "created tar" });
			const { sandbox, written, commands } = fakeSandbox({}, conversation());

			await provisionVm(sandbox, input(thread, []));

			expect(written.get("/tmp/transfer/session.tar")).toBe("created tar");
			expect(commands.some(command => command.includes("manifest.json"))).toBe(false);
			expect(commands.some(command => command.startsWith("omp session unpack '/tmp/transfer/session.tar'"))).toBe(true);
		});

		test("a result bundle newer than the last completed turn restores to that turn's head", async () => {
			const thread = await createThread();
			completeTurn("c".repeat(40));
			await blobs({ result: "result bundle" });
			const { sandbox, commands } = fakeSandbox({}, conversation());

			await provisionVm(sandbox, input(thread, []));

			const checkout = commands.find(command => command.includes("checkout -q -f -B 'omp-cloud/aaaaaaaaaaaa'") && command.includes("cccccccc"));
			expect(checkout).toBeDefined();
			expect(checkout).not.toContain("refs/omp-cloud/result");
		});

		test("a result bundle of a thread whose turns recorded no head is ignored", async () => {
			const thread = await createThread();
			await blobs({ result: "result bundle" });
			const { sandbox, written, commands } = fakeSandbox({}, conversation());

			await provisionVm(sandbox, input(thread, []));

			expect(written.has("/tmp/transfer/result.bundle")).toBe(false);
			expect(commands.some(command => command.includes("refs/omp-cloud/result"))).toBe(false);
		});

		describe("after an archive", () => {
			const SNAPSHOT_HEAD = "d".repeat(40);

			/** The VM's git answers `merge-base --is-ancestor` with exit 1 (not an ancestor) for the commits in `missing`. */
			function without(...missing: string[]): (command: string) => string | undefined {
				const talk = conversation();
				return command => {
					if (command.includes("merge-base --is-ancestor") && missing.some(head => command.includes(head))) {
						throw new CommandExitError({ exitCode: 1, error: "exit", stdout: "", stderr: "" });
					}
					return talk(command);
				};
			}

			/** The repository restore checks the handoff commit out first; the last checkout is where the thread ends up. */
			const finalCheckout = (commands: string[]): string =>
				commands.filter(command => command.includes("checkout -q -f -B 'omp-cloud/aaaaaaaaaaaa'")).at(-1) ?? "";

			test("the snapshot's head is checked out when the stored bundle holds it", async () => {
				const thread = { ...(await createThread()), restoreHead: SNAPSHOT_HEAD };
				completeTurn(RESULT_HEAD);
				await blobs({ result: "result bundle" });
				const { sandbox, written, commands } = fakeSandbox({}, conversation());

				await provisionVm(sandbox, input(thread, []));

				expect(written.get("/tmp/transfer/result.bundle")).toBe("result bundle");
				expect(finalCheckout(commands)).toContain(SNAPSHOT_HEAD);
			});

			test("falls back to the last completed turn's head when the bundle does not hold the snapshot's", async () => {
				const thread = { ...(await createThread()), restoreHead: SNAPSHOT_HEAD };
				completeTurn(RESULT_HEAD);
				await blobs({ result: "result bundle" });
				const { sandbox, commands } = fakeSandbox({}, without(SNAPSHOT_HEAD));

				await provisionVm(sandbox, input(thread, []));

				expect(finalCheckout(commands)).toContain(RESULT_HEAD);
				expect(finalCheckout(commands)).not.toContain(SNAPSHOT_HEAD);
			});

			test("a thread without a completed turn restores the snapshot's head too", async () => {
				const thread = { ...(await createThread()), restoreHead: SNAPSHOT_HEAD };
				await blobs({ result: "result bundle" });
				const { sandbox, written, commands } = fakeSandbox({}, conversation());

				await provisionVm(sandbox, input(thread, []));

				expect(written.get("/tmp/transfer/result.bundle")).toBe("result bundle");
				expect(finalCheckout(commands)).toContain(SNAPSHOT_HEAD);
			});

			test("a thread without a completed turn whose bundle lacks the snapshot's head stays at the handoff commit", async () => {
				const thread = { ...(await createThread()), restoreHead: SNAPSHOT_HEAD };
				await blobs({ result: "result bundle" });
				const { sandbox, commands } = fakeSandbox({}, without(SNAPSHOT_HEAD));

				await provisionVm(sandbox, input(thread, []));

				expect(finalCheckout(commands)).toContain("refs/omp-cloud/handoff");
			});
		});

		test("a delta thread restores the composed full history, then applies its thin result bundle", async () => {
			const thread = await createThread({ repo: { ...newThread().repo, baseCommit: "b".repeat(40), remoteURL: "https://git.example.com/a/b.git" } });
			completeTurn(RESULT_HEAD);
			await blobs({ result: "thin result bundle" });
			const path = join(dir, "composed.bundle");
			await writeFile(path, "full history bundle");
			const { sandbox, written, commands } = fakeSandbox({}, conversation());
			const git: ProvisionInput["git"] = { composeSource: async () => ({ path, release: async () => {} }) };

			await provisionVm(sandbox, { ...input(thread, []), git });

			expect(written.get("/tmp/transfer/source.bundle")).toBe("full history bundle");
			expect(written.get("/tmp/transfer/result.bundle")).toBe("thin result bundle");
			expect(commands.findIndex(command => command.includes("git init"))).toBeLessThan(commands.findIndex(command => command.includes("refs/omp-cloud/result")));
		});
	});
});
