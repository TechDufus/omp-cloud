import { afterEach, expect, test } from "bun:test";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HandoffParts } from "../plugin/src/api";
import { readConfig } from "../plugin/src/config";
import { git, gitRaw } from "../plugin/src/snapshot";
import { summary, whoami } from "../plugin/test/builders";
import { cleanup, isolateOmp, remoteFixture, tmp } from "../plugin/test/helpers";
import { type AcpClient, type CloudConnection, productionEnvironment } from "./environment";

// `isolateOmp` moves omp's directories for the whole process.
afterEach(cleanup);

interface Created {
	parts: HandoffParts;
	key: string | undefined;
	/** A copy of the `source` bundle: the handoff deletes its own. */
	bundle: string;
}

/** A connection whose service only takes creates: it keeps each one and what `log` it happened at. */
async function connection(root: string, log: string[]): Promise<{ cloud: CloudConnection; created: Created[] }> {
	const created: Created[] = [];
	const aside = await tmp();
	const unused = async (): Promise<never> => {
		throw new Error("a handoff does not call this");
	};
	const client: AcpClient = {
		whoami: async () => whoami({ capabilities: ["threads.meta", "threads.idempotency", "threads.paging", "events.live", "events.json"] }),
		requireCapability: async () => {},
		createThread: async (parts, options) => {
			const ref = parts.request.ref ?? "";
			const bundle = join(aside, `${ref}.bundle`);
			if (parts.source !== undefined) await copyFile(parts.source, bundle);
			created.push({ parts, key: options?.idempotencyKey, bundle });
			log.push(`created ${ref}`);
			return { summary: summary({ ref }), replayed: false };
		},
		downloadResult: unused,
		thread: unused,
		listThreadsPage: unused,
		eventsPage: unused,
		sendMessage: unused,
		answer: unused,
		stop: unused,
		events: () => {
			throw new Error("a handoff does not follow");
		},
	};
	const cfg = await readConfig({ env: {}, home: await tmp(), repoRoot: root, platform: "linux" });
	return { cloud: { client, cfg, root, serverHost: undefined }, created };
}

test("the handoff of a first prompt ships the repository with its uncommitted work under the session's id, without a conversation", async () => {
	await isolateOmp();
	const f = await remoteFixture();
	await writeFile(join(f.work, "wip.txt"), "wip-acp\n");
	const log: string[] = [];
	const { cloud, created } = await connection(f.work, log);
	const ref = `acp-${"0af1".repeat(8)}`;

	const outcome = await productionEnvironment().launch(cloud, {
		cwd: f.work,
		prompt: "hello",
		ref,
		model: "",
		thinking: "",
		signal: new AbortController().signal,
		onProgress: progress => void log.push(progress.phase),
	});

	expect(outcome.response.ref).toBe(ref);
	expect(outcome.summary).toMatchObject({ scratch: false, conversation: "none", untrackedTotal: 1, model: "" });
	expect(log).toEqual(["packing", "uploading", `created ${ref}`]);
	expect(created).toHaveLength(1);
	const sent = created[0];
	if (sent === undefined) throw new Error("nothing was created");
	// The session id is the thread's ref and the create's idempotency key; the service's omp version runs, and nobody named the thread.
	expect(sent.key).toBe(ref);
	expect(sent.parts.request).toMatchObject({ prompt: "hello", ref, origin: "user", ompVersion: "", model: "", thinking: "" });
	expect(sent.parts.request.name).toBeUndefined();
	expect(sent.parts.request.session).toBeUndefined();
	expect(sent.parts.conversation).toBeUndefined();
	expect(sent.parts.setup).toBeDefined();

	// The bundle is the repository as it stood, the uncommitted file included.
	const fresh = await tmp();
	await git(fresh, ["init", "-q"]);
	await git(fresh, ["fetch", "-q", sent.bundle, "refs/omp-cloud/handoff"]);
	expect(await git(fresh, ["show", "FETCH_HEAD:wip.txt"])).toBe("wip-acp");
	expect(await git(fresh, ["show", "FETCH_HEAD:a.txt"])).toBe("one");
	// Nothing of the handoff stays in the repository.
	expect((await gitRaw(f.work, ["rev-parse", "--verify", "-q", "refs/omp-cloud/handoff"])).code).not.toBe(0);
	expect(await git(f.work, ["status", "--porcelain"])).toBe("?? wip.txt");
});

test("two first prompts in one repository hand off one after the other: their snapshots share a ref", async () => {
	await isolateOmp();
	const f = await remoteFixture();
	const log: string[] = [];
	const { cloud, created } = await connection(f.work, log);
	const env = productionEnvironment();
	const launch = (ref: string) =>
		env.launch(cloud, { cwd: f.work, prompt: "hello", ref, model: "", thinking: "", signal: new AbortController().signal, onProgress: () => void log.push(`progress ${ref}`) });

	const both = await Promise.all([launch("first"), launch("second")]);

	expect(both.map(outcome => outcome.response.ref)).toEqual(["first", "second"]);
	// The second handoff did not begin before the first one's thread existed.
	expect(log.indexOf("created first")).toBeLessThan(log.indexOf("progress second"));
	expect(created.map(entry => entry.key)).toEqual(["first", "second"]);
});
