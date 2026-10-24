import { describe, expect, test } from "bun:test";
import { fullAccess, youLine } from "../src/access";
import { capacityLine, readCapacity } from "../src/capacity";
import { loginHint, userLoginStep } from "../src/login";
import type { Capacity } from "../src/types";
import { parseCapacity, parseLoginList } from "../src/wire";
import { whoami } from "./builders";

const OWNER = whoami();
const FULL = whoami({ device: { id: "d1", name: "laptop", access: "full" } });
const THREADS = whoami({ device: { id: "d1", name: "laptop", access: "threads" } });

const CAPACITY: Capacity = {
	available: true,
	problem: "",
	fix: "",
	machines: { total: 3, ready: 2 },
	vcpus: { total: 24, allocated: 4 },
	memoryMB: { total: 98304, allocated: 1536 },
	diskFreeMB: 1,
	vms: { cluster: 2, cloud: { running: 2, paused: 1, limit: 32 }, size: { vcpus: 2, memoryMB: 4096 } },
	cluster: { accepting: false, address: "", joinCommand: "", versionSkew: false },
};

describe("who may change the cloud", () => {
	test("the owner token and a device with full access may; a device with threads-only access may not", () => {
		expect(fullAccess(OWNER)).toBe(true);
		expect(fullAccess(FULL)).toBe(true);
		expect(fullAccess(THREADS)).toBe(false);
	});

	test("the you line says which of the three the caller is", () => {
		expect(youLine(OWNER)).toBe("the owner, with the server's owner token (full access)");
		expect(youLine(FULL)).toBe("the owner, on device laptop (full access)");
		expect(youLine(THREADS)).toBe("device laptop, threads only (a connection with full access runs /cloud devices access laptop full)");
	});

	test("a login hint names /cloud login for a connection with full access, whatever machine it is on, and the server machine otherwise", () => {
		expect(loginHint("openai", undefined, true)).toBe("/cloud login openai");
		expect(loginHint("openai", "10.0.20.24", true)).toBe("/cloud login openai");
		expect(loginHint("openai", "10.0.20.24", false)).toStartWith("log the server in: run omp-cloud login openai on 10.0.20.24");
		expect(userLoginStep("openai", "10.0.20.24", true)).toBe("run /cloud login openai");
		expect(userLoginStep("openai", "10.0.20.24", false)).toContain("ssh -t <user>@10.0.20.24");
	});
});

describe("capacity", () => {
	test("the line gives vCPU, memory, machines and the cloud's VMs, and says when vibemon versions differ", () => {
		expect(capacityLine(CAPACITY)).toBe("24 vCPU (4 allocated) · 96 GiB (1.5 allocated) · 3 machines · 2 of 32 VMs running");
		expect(capacityLine({ ...CAPACITY, machines: { total: 1, ready: 1 }, cluster: { ...CAPACITY.cluster, versionSkew: true }, vms: { ...CAPACITY.vms, cloud: { running: 0, paused: 0, limit: 0 } } })).toBe(
			"24 vCPU (4 allocated) · 96 GiB (1.5 allocated) · 1 machine · 0 VMs running · vibemon versions differ",
		);
	});

	test("unavailable gives the reason", () => {
		expect(capacityLine({ ...CAPACITY, available: false, problem: "this server has no vibemon admin token yet", fix: "omp-cloud setup" })).toBe("unavailable (this server has no vibemon admin token yet)");
	});

	test("it is read only from a service that has the capability, and a failed read is no line", async () => {
		let calls = 0;
		const client = {
			capacity: async () => {
				calls++;
				return CAPACITY;
			},
		};
		expect(await readCapacity(client, { capabilities: [] })).toBeUndefined();
		expect(calls).toBe(0);
		expect(await readCapacity(client, { capabilities: ["capacity"] })).toEqual(CAPACITY);
		expect(
			await readCapacity(
				{
					capacity: async () => {
						throw new Error("down");
					},
				},
				{ capabilities: ["capacity"] },
			),
		).toBeUndefined();
	});

	test("the answer is read field by field; what the service leaves out is zero", () => {
		expect(parseCapacity({ available: true, machines: { total: 2, ready: 1 }, vcpus: { total: 8, allocated: 2 }, history: [{}], members: [{}] })).toMatchObject({
			available: true,
			machines: { total: 2, ready: 1 },
			vcpus: { total: 8, allocated: 2 },
			memoryMB: { total: 0, allocated: 0 },
			vms: { cloud: { running: 0, paused: 0, limit: 0 } },
			cluster: { accepting: false, joinCommand: "" },
		});
	});
});

describe("the login list", () => {
	test("entries are read as sent, an unknown kind is a provider, and a missing broker error is empty", () => {
		const list = parseLoginList({
			logins: [
				{ provider: "anthropic", kind: "provider", account: "me@example.com", loggedInAt: "2026-10-01T00:00:00.000Z", renewBy: "2026-10-31T00:00:00.000Z", disabled: false, note: "" },
				{ provider: "mcp:https://x.example/mcp", kind: "mcp", account: "x.example", loggedInAt: "", renewBy: "", disabled: false, note: "" },
				{ provider: "openai", kind: "other", disabled: true, note: "refresh failed" },
			],
		});
		expect(list.brokerError).toBe("");
		expect(list.logins.map(l => [l.provider, l.kind, l.disabled])).toEqual([
			["anthropic", "provider", false],
			["mcp:https://x.example/mcp", "mcp", false],
			["openai", "provider", true],
		]);
		expect(list.logins[2]?.note).toBe("refresh failed");
		expect(parseLoginList({ logins: [], brokerError: "the cloud broker did not answer: down" }).brokerError).toBe("the cloud broker did not answer: down");
	});
});
