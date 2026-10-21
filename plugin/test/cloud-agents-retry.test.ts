/**
 * A message to a cloud agent whose first attempt is lost: the real client repeats the POST with the same message id, the
 * service (a fake that dedupes by id, as the real one does) answers the original receipt, and the message takes effect once.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { executeSend } from "@oh-my-pi/pi-coding-agent/irc/messaging";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CloudClient, type FetchFn } from "../src/api";
import { CloudAgents, IRC_CAPABILITY } from "../src/cloud-agents";
import type { IrcReceiptKind } from "../src/types";
import { detail, turn, whoami } from "./builders";

const ID = "aaaaaak3x9fa";
const AGENT = "FixGreetingBug";

interface Service {
	/** Messages that took effect, by id: what the cloud agent receives. */
	effects: string[];
	/** Every POST to /irc: the id it carried. */
	posts: string[];
}

/** How the fake service misbehaves for the next POSTs: `lose` the answer after taking the message, or answer `status`. */
interface Script {
	steps: ("lose" | "timeout" | number | "ok")[];
}

function rig(script: Script) {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	const dir = mkdtempSync(join(tmpdir(), "omp-cloud-retry-"));
	const service: Service = { effects: [], posts: [] };
	const receipts = new Map<string, IrcReceiptKind>();
	const fetchFn: FetchFn = async (url, init) => {
		if (url.endsWith("/api/v1/whoami")) return Response.json(whoami({ capabilities: [IRC_CAPABILITY] }));
		const body: { id: string } = JSON.parse(String(init?.body));
		service.posts.push(body.id);
		const step = script.steps.shift() ?? "ok";
		if (typeof step === "number") return Response.json({ error: "no" }, { status: step });
		// The message takes effect once per id, whatever happens to the answer.
		if (!receipts.has(body.id)) {
			receipts.set(body.id, "woken");
			service.effects.push(body.id);
		}
		if (step === "lose") throw Object.assign(new TypeError("ECONNRESET: closed"), { code: "ECONNRESET" });
		if (step === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
		return Response.json({ receipt: receipts.get(body.id), id: body.id, turn: null }, { status: 201 });
	};
	const client = new CloudClient("http://cloud.test", "tok", fetchFn, { backoffMs: [1, 1, 1], random: () => 0.5 });
	const registry = AgentRegistry.global();
	registry.register({ id: "Main", displayName: "Main", kind: "main", session: { async deliverIrcMessage() { return "injected"; } } as unknown as AgentSession, status: "running" });
	const agents = new CloudAgents({ client: async () => client, follow: () => {}, warn: () => {}, cwd: () => "/", entries: () => [], relayFailed: () => {}, registry: () => registry, dir, hydrate: false });
	agents.observe(detail({ id: ID, name: "Fix greeting bug", phase: "idle", turns: [turn(1)] }));
	return { agents, registry, service, done: () => { agents.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

const write = (registry: AgentRegistry, message: string): Promise<AgentToolResult<CoordinationDetails>> => executeSend({ registry, senderId: "Main" }, { to: AGENT, message });
const textOf = (r: AgentToolResult<CoordinationDetails>): string => r.content.map(c => (c.type === "text" ? c.text : "")).join("");

let done: (() => void) | undefined;
beforeEach(() => {
	done = undefined;
});
afterEach(() => {
	done?.();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

describe("a lost answer to write agent://<id>", () => {
	test("a first attempt that times out is repeated with the same id and answered with the original receipt: one effect", async () => {
		const r = rig({ steps: ["timeout", "ok"] });
		done = r.done;
		const result = await write(r.registry, "use the existing helper");
		expect(textOf(result)).toBe(`Delivered to ${AGENT}.`);
		expect(result.isError).toBe(false);
		expect(r.service.posts).toHaveLength(2);
		expect(new Set(r.service.posts).size).toBe(1);
		expect(r.service.effects).toEqual([r.service.posts[0]!]);
	});

	test("a connection reset and a 5xx on the way are repeated too; the message still takes effect once", async () => {
		const r = rig({ steps: ["lose", 503, "ok"] });
		done = r.done;
		expect(textOf(await write(r.registry, "hello"))).toBe(`Delivered to ${AGENT}.`);
		expect(r.service.posts).toHaveLength(3);
		expect(r.service.effects).toHaveLength(1);
	});

	test("an answer that never comes is the bus's failed receipt after the retry schedule, saying the message may have been delivered", async () => {
		const r = rig({ steps: ["lose", "lose", "lose", "lose", "lose"] });
		done = r.done;
		const result = await write(r.registry, "hello");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(`Failed: ${AGENT} could not receive the message.`);
		expect(textOf(result)).toContain("may have been delivered");
		expect(r.service.posts).toHaveLength(4);
		expect(r.service.effects).toHaveLength(1);
	});

	test("a 4xx is final: one POST, the cloud's own words", async () => {
		const r = rig({ steps: [409, "ok"] });
		done = r.done;
		const result = await write(r.registry, "hello");
		expect(textOf(result)).toContain(`Failed: ${AGENT} could not receive the message.`);
		expect(r.service.posts).toHaveLength(1);
		expect(r.service.effects).toEqual([]);
	});
});
