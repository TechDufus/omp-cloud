import { describe, expect, test } from "bun:test";
import { completions, parseCommand, USAGE_CONNECT, USAGE_DEVICES, USAGE_DISCONNECT, VERBS, type Parsed } from "../src/commands";
import { resolveParsed } from "../src/resolve";
import { helpLines } from "../src/watch";

const CODE = `ompc1:AbCdEfGhIjKl:s3cr3t:${"A".repeat(43)}@10.0.0.1:8443`;
const connect = (over: Partial<Extract<Parsed, { kind: "connect" }>> = {}): Parsed => ({ kind: "connect", target: undefined, name: undefined, replace: false, allowPublic: false, ...over });

describe("parseCommand: connect", () => {
	test("no arguments prompts for the code", () => {
		expect(parseCommand("connect")).toEqual(connect());
	});

	test("a code, flags in any order, a name with spaces in quotes", () => {
		expect(parseCommand(`connect ${CODE}`)).toEqual(connect({ target: CODE }));
		expect(parseCommand(`connect --replace --allow-public ${CODE} --name "My Laptop"`)).toEqual(connect({ target: CODE, name: "My Laptop", replace: true, allowPublic: true }));
		expect(parseCommand(`connect "${CODE}"`)).toEqual(connect({ target: CODE }));
		expect(parseCommand("CONNECT --name box")).toEqual(connect({ name: "box" }));
	});

	test("an ssh target is the same positional as a code, whichever of the three forms", () => {
		for (const target of ["me@nas.local", "nas", "ssh://me@nas.local:2222"]) {
			expect(parseCommand(`connect ${target} --name box`)).toEqual(connect({ target, name: "box" }));
		}
		expect(parseCommand("connect --replace me@nas")).toEqual(connect({ target: "me@nas", replace: true }));
	});

	test("a target that starts with a single '-' is refused with its own message, never kept as a target", () => {
		for (const args of ["connect -oProxyCommand=evil", "connect -p", 'connect "-oProxyCommand=evil x"']) {
			const parsed = parseCommand(args);
			expect(parsed.kind).toBe("error");
			expect(parsed.kind === "error" ? parsed.message : "").toContain("cannot start with '-'");
		}
	});

	test("the usage names every target form", () => {
		for (const form of ["<code>", "<user@host>", "<host>", "ssh://[user@]host[:port]"]) expect(USAGE_CONNECT).toContain(form);
	});

	test.each(["connect a b", "connect --bogus", "connect --name", "connect --name --replace", `connect "${CODE}`])("%s is a usage error", args => {
		expect(parseCommand(args)).toEqual({ kind: "error", message: USAGE_CONNECT });
	});
});

describe("parseCommand: pair, devices, disconnect", () => {
	test("pair takes no arguments", () => {
		expect(parseCommand("pair")).toEqual({ kind: "pair" });
	});

	test("devices lists, and revoke takes a name that may hold spaces", () => {
		expect(parseCommand("devices")).toEqual({ kind: "devices", revoke: undefined });
		expect(parseCommand("devices revoke phone")).toEqual({ kind: "devices", revoke: "phone" });
		expect(parseCommand('devices revoke "My Phone"')).toEqual({ kind: "devices", revoke: "My Phone" });
		expect(parseCommand("devices revoke My Phone")).toEqual({ kind: "devices", revoke: "My Phone" });
		for (const bad of ["devices revoke", "devices remove x", "devices x"]) expect(parseCommand(bad)).toEqual({ kind: "error", message: USAGE_DEVICES });
	});

	test("devices access takes a name (quoted when it holds spaces) or an id prefix, then full or threads", () => {
		const access = (target: string, value: "full" | "threads"): Parsed => ({ kind: "devices", revoke: undefined, access: { target, value } });
		expect(parseCommand("devices access phone threads")).toEqual(access("phone", "threads"));
		expect(parseCommand('devices access "My Phone" full')).toEqual(access("My Phone", "full"));
		expect(parseCommand("devices access My Phone full")).toEqual(access("My Phone", "full"));
		expect(parseCommand("devices access devzzz threads")).toEqual(access("devzzz", "threads"));
		expect(parseCommand("DEVICES ACCESS phone full")).toEqual(access("phone", "full"));
		for (const bad of ["devices access", "devices access phone", "devices access phone admin", "devices access full"]) expect(parseCommand(bad)).toEqual({ kind: "error", message: USAGE_DEVICES });
	});

	test("disconnect takes only --force", () => {
		expect(parseCommand("disconnect")).toEqual({ kind: "disconnect", force: false });
		expect(parseCommand("disconnect --force")).toEqual({ kind: "disconnect", force: true });
		for (const bad of ["disconnect now", "disconnect --force --force", "disconnect --forc"]) expect(parseCommand(bad)).toEqual({ kind: "error", message: USAGE_DISCONNECT });
	});

	test("resolution passes them through without looking at threads", async () => {
		const noService = {
			thread: async () => {
				throw new Error("must not be asked");
			},
			listThreadsPage: async () => {
				throw new Error("must not be asked");
			},
		};
		for (const args of [`connect ${CODE}`, "devices", "disconnect --force"]) {
			const parsed = parseCommand(args);
			expect(await resolveParsed(parsed, noService)).toEqual(parsed as never);
		}
		expect(await resolveParsed({ kind: "pair" }, noService)).toEqual({ kind: "pair" });
	});
});

describe("completion and help", () => {
	test("the new verbs complete with a description", () => {
		for (const verb of ["connect", "pair", "devices", "disconnect"]) {
			expect(VERBS as readonly string[]).toContain(verb);
			const hit = completions(verb.slice(0, 3), [])?.find(c => c.value === verb);
			expect(hit?.description?.length).toBeGreaterThan(10);
		}
	});

	test("flags complete after connect and disconnect, revoke after devices", () => {
		expect(completions("connect --re", [])?.map(c => c.value)).toEqual(["connect --replace"]);
		expect(completions("connect --replace --a", [])?.map(c => c.value)).toEqual(["connect --replace --allow-public"]);
		expect(completions("connect --replace --r", [])).toBeNull();
		expect(completions("disconnect ", [])?.map(c => c.value)).toEqual(["disconnect --force"]);
		expect(completions("devices r", [])?.map(c => c.value)).toEqual(["devices revoke"]);
		expect(completions("devices ", [])?.map(c => c.value)).toEqual(["devices revoke", "devices access"]);
		expect(completions("devices a", [])?.map(c => c.value)).toEqual(["devices access"]);
		expect(completions("devices revoke ph", [])).toBeNull();
	});

	test("help lists each with its usage", () => {
		const help = helpLines().join("\n");
		for (const usage of ["/cloud connect [<code|host>] [--name n]", "/cloud pair", "/cloud devices [revoke|access]", "/cloud disconnect [--force]"]) expect(help).toContain(usage);
	});
});
