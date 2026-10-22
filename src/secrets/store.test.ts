import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store";
import type { NewThread, Thread } from "../store/types";
import { repoKeyOf, SecretInputError, ServiceSecrets } from "./store";

let dir: string;
let store: Store;
let secrets: ServiceSecrets;
let next = 0;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-secrets-"));
	store = Store.open({ dataDir: dir });
	secrets = new ServiceSecrets(store);
	next = 0;
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

function thread(remoteURL: string, name = "repo"): Thread {
	const input: NewThread = {
		owner: "owner",
		title: "t",
		prompt: "do it",
		model: "fake/fake-model",
		thinking: "",
		repo: { name, remoteURL, baseRef: "", baseCommit: "", handoffCommit: "c".repeat(40), localBranch: "main" },
		paths: { home: "", workspace: "" },
		author: { name: "", email: "" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
	};
	return store.createThread(`t${String(next++).padStart(11, "0")}`, input).thread;
}

const put = (name: string, value: string, repos: string[]): void => {
	secrets.put(name, { value, repos }, "owner");
};

describe("repoKeyOf", () => {
	test.each<[string, string, string]>([
		["https://github.com/TechDufus/omp-cloud.git", "repo", "github.com/techdufus/omp-cloud"],
		["https://github.com/techdufus/omp-cloud/", "repo", "github.com/techdufus/omp-cloud"],
		["https://git.example.test:8443/team/app", "repo", "git.example.test:8443/team/app"],
		["git@github.com:Acme/App.git", "repo", "github.com/acme/app"],
		["ssh://git@gitlab.com/group/sub/proj.git", "repo", "gitlab.com/group/sub/proj"],
		["", "My-Repo", "local/my-repo"],
	])("%s is %s", (remoteURL, name, key) => {
		expect(repoKeyOf({ name, remoteURL, baseRef: "", baseCommit: "", handoffCommit: "", localBranch: "" })).toBe(key);
	});
});

describe("resolveForThread", () => {
	test("a secret goes only to the repositories its globs match, `*` matching across `/`", async () => {
		put("ALL", "everywhere", ["*"]);
		put("ACME_ONLY", "acme-value", ["github.com/acme/*"]);
		put("EXACT", "exact-value", ["github.com/acme/app"]);
		put("OTHER", "other-value", ["github.com/other/*", "gitlab.com/*"]);
		put("LOCAL", "local-value", ["local/*"]);

		const acme = await secrets.resolveForThread(thread("https://github.com/acme/app.git"));
		expect(acme).toEqual({ env: { ALL: "everywhere", ACME_ONLY: "acme-value", EXACT: "exact-value" }, failures: [] });

		const deep = await secrets.resolveForThread(thread("https://github.com/acme/group/app"));
		expect(deep.env).toEqual({ ALL: "everywhere", ACME_ONLY: "acme-value" });

		const gitlab = await secrets.resolveForThread(thread("https://gitlab.com/g/p"));
		expect(gitlab.env).toEqual({ ALL: "everywhere", OTHER: "other-value" });
	});

	test("a thread without a remote matches `local/<name>`, and a glob matches case-insensitively", async () => {
		put("LOCAL", "local-value", ["local/scratch-*"]);
		put("MIXED", "mixed-value", ["GitHub.com/ACME/*"]);
		put("NAMED", "named-value", ["local/Notes"]);

		expect((await secrets.resolveForThread(thread("", "scratch-1"))).env).toEqual({ LOCAL: "local-value" });
		expect((await secrets.resolveForThread(thread("", "notes"))).env).toEqual({ NAMED: "named-value" });
		expect((await secrets.resolveForThread(thread("https://github.com/acme/app"))).env).toEqual({ MIXED: "mixed-value" });
		expect((await secrets.resolveForThread(thread("", "other"))).env).toEqual({});
	});

	test("a `!command` value resolves to its output; one that fails is reported without its output and left out", async () => {
		put("FROM_CMD", "!printf command-output", ["*"]);
		put("BROKEN", "!echo leaked-output; exit 3", ["*"]);
		put("PLAIN", "plain-value", ["*"]);

		const { env, failures } = await secrets.resolveForThread(thread("https://github.com/acme/app"));
		expect(env).toEqual({ FROM_CMD: "command-output", PLAIN: "plain-value" });
		expect(failures).toEqual(["secret BROKEN was not delivered: the credential command of secret BROKEN failed (exit 3)"]);
		expect(failures.join("")).not.toContain("leaked-output");
	});

	test("an empty store resolves to nothing", async () => {
		expect(await secrets.resolveForThread(thread("https://github.com/acme/app"))).toEqual({ env: {}, failures: [] });
	});
});

describe("put", () => {
	test("duplicate globs are kept once", () => {
		const stored = secrets.put("DEMO_TOKEN", { value: "v", repos: ["a/*", "a/*", "b"] }, "owner");
		expect(stored.repos).toEqual(["a/*", "b"]);
	});

	test('a value of just "!" is refused', () => {
		expect(() => secrets.put("DEMO_TOKEN", { value: "!", repos: ["*"] }, "owner")).toThrow(SecretInputError);
	});

	test("a value with a NUL is refused", () => {
		expect(() => secrets.put("DEMO_TOKEN", { value: "a\0b", repos: ["*"] }, "owner")).toThrow("value must be 1 to 65536 characters of text");
	});

	test("the largest value and 50 repos are accepted", () => {
		const repos = Array.from({ length: 50 }, (_, i) => `github.com/o/r${i}`);
		expect(secrets.put("BIG", { value: "x".repeat(65536), repos }, "owner").repos).toHaveLength(50);
	});
});
