import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { CloudAgents, IRC_CUT_PLACEHOLDER, type AgentsClient } from "../src/cloud-agents";
import { detail, event, turn } from "./builders";
import { until } from "./fakes";

/** Read as data: `plugin/` never imports `src/`. */
const RUNNER_IRC = join(import.meta.dir, "..", "..", "src", "runner", "irc.ts");

const CUT = `\n\n[omp-cloud: this message was cut: it is 40000 bytes and the limit is 32768. The whole text is in the sending agent's transcript (its write call): read ${IRC_CUT_PLACEHOLDER}]`;

describe("the cut marker of an over-long outbound message", () => {
	test("the runner's marker still says the placeholder the plugin substitutes", async () => {
		const source = await Bun.file(RUNNER_IRC).text();
		expect(source).toContain(`read ${IRC_CUT_PLACEHOLDER}]`);
		expect(source).toContain("[omp-cloud: this message was cut: it is ${total} bytes and the limit is ${MAX_TEXT_BYTES}.");
	});

	test("an inbound irc event reaches the recipient with the real history://<agent id>, nothing else changed", async () => {
		AgentRegistry.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const got: IrcMessage[] = [];
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: { async deliverIrcMessage(m: IrcMessage) { got.push(m); return "injected"; } } as unknown as AgentSession, status: "idle" });
		const client = {} as AgentsClient;
		const agents = new CloudAgents({ client: async () => client, follow: () => {}, warn: () => {}, cwd: () => "/", entries: () => [], relayFailed: () => {}, registry: () => registry, hydrate: false });
		const d = detail({ id: "aaaaaak3x9fa", name: "Fix greeting bug", phase: "working", turns: [turn(1, { state: "running" })] });
		agents.observe(d);
		const id = agents.agentId(d.id) as string;
		const body = `${"x".repeat(100)}${CUT}`;
		agents.event(d, event(1, { kind: "irc", turn: 1, text: JSON.stringify({ id: "m-1", from: "greeter", to: "Main", body, replyTo: "", at: "2026-01-01T00:00:00Z" }) }));
		await until(() => got.length === 1);
		expect(got[0]?.body).toBe(`${"x".repeat(100)}${CUT.replace(IRC_CUT_PLACEHOLDER, `history://${id}`)}`);
		expect(got[0]?.body).not.toContain("<the sending agent's id>");
		// A message without the marker is delivered as it came.
		agents.event(d, event(2, { kind: "irc", turn: 1, text: JSON.stringify({ id: "m-2", from: "greeter", to: "Main", body: "plain", replyTo: "", at: "2026-01-01T00:00:00Z" }) }));
		await until(() => got.length === 2);
		expect(got[1]?.body).toBe("plain");
		agents.dispose();
		AgentRegistry.resetGlobalForTests();
	});
});
