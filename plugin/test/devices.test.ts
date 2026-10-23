import { describe, expect, test } from "bun:test";
import { CloudClient, type FetchFn } from "../src/api";
import { devicesCard, runAccess } from "../src/devices";
import { cloudErrorFromStatus } from "../src/errors";
import { UserError, type Device, type DeviceAccess } from "../src/types";
import { whoami } from "./builders";
import { fakeHost } from "./fakes";

const device = (over: Partial<Device>): Device => ({
	id: "dev12345abcdef",
	name: "laptop",
	platform: "linux",
	access: "full",
	createdAt: "2026-10-19T00:00:00.000Z",
	pairedFrom: "10.0.0.7",
	lastSeenAt: "",
	lastSeenAddress: "",
	current: false,
	...over,
});

const LAPTOP = device({ current: true });
const PHONE = device({ id: "devzzzzz999999", name: "phone", platform: "ios", access: "threads" });

/** An api whose `devices` lists `list` and whose `setDeviceAccess` records its calls and answers with the device changed. */
function api(list: Device[]) {
	const sets: [string, DeviceAccess][] = [];
	return {
		sets,
		devices: async () => list,
		setDeviceAccess: async (id: string, access: DeviceAccess) => {
			sets.push([id, access]);
			return { ...(list.find(d => d.id === id) ?? LAPTOP), access };
		},
	};
}

/** A host that records each confirm. */
function host(answer: boolean) {
	const h = fakeHost({ confirm: answer });
	const asked: [string, string][] = [];
	h.host.ui.confirm = async (title, message) => {
		asked.push([title, message]);
		return answer;
	};
	return { ...h, asked };
}

describe("runAccess", () => {
	test("changing another device never asks and says what it now has", async () => {
		const a = api([LAPTOP, PHONE]);
		const h = host(true);
		await runAccess(a, h.host.ui, "phone", "full");
		await runAccess(a, h.host.ui, "devzzz", "threads");
		expect(a.sets).toEqual([
			["devzzzzz999999", "full"],
			["devzzzzz999999", "threads"],
		]);
		expect(h.asked).toEqual([]);
		expect(h.notes).toEqual([
			["☁ phone now has full access", "info"],
			["☁ phone now has threads-only access", "info"],
		]);
	});

	test("raising this device never asks either", async () => {
		const a = api([device({ current: true, access: "threads" })]);
		const h = host(true);
		await runAccess(a, h.host.ui, "laptop", "full");
		expect(h.asked).toEqual([]);
		expect(h.notes).toEqual([["☁ laptop now has full access", "info"]]);
	});

	test("demoting this device asks first, by the current mark or by the paired device id", async () => {
		for (const [list, thisDeviceId] of [
			[[LAPTOP, PHONE], undefined],
			[[device({}), PHONE], "dev12345abcdef"],
		] as const) {
			const a = api([...list]);
			const h = host(true);
			await runAccess(a, h.host.ui, "laptop", "threads", thisDeviceId);
			expect(h.asked).toEqual([["Change access", "This device loses full access now"]]);
			expect(a.sets).toEqual([["dev12345abcdef", "threads"]]);
			expect(h.notes).toEqual([["☁ laptop now has threads-only access", "info"]]);
		}
	});

	test("a declined confirm changes nothing and says nothing", async () => {
		const a = api([LAPTOP]);
		const h = host(false);
		await runAccess(a, h.host.ui, "laptop", "threads");
		expect(a.sets).toEqual([]);
		expect(h.notes).toEqual([]);
	});

	test("an unknown or ambiguous target is a UserError", async () => {
		const a = api([device({ id: "devaaaa1", name: "a" }), device({ id: "devaaaa2", name: "b" })]);
		const h = host(true);
		await expect(runAccess(a, h.host.ui, "nobody", "full")).rejects.toBeInstanceOf(UserError);
		await expect(runAccess(a, h.host.ui, "devaaaa", "full")).rejects.toThrow("matches several devices");
		expect(a.sets).toEqual([]);
	});

	test("a service that refuses a threads-only caller surfaces its own text", async () => {
		const a = api([PHONE]);
		a.setDeviceAccess = async () => {
			throw cloudErrorFromStatus(403, "this needs full access");
		};
		await expect(runAccess(a, host(true).host.ui, "phone", "full")).rejects.toThrow("this needs full access");
	});

	test("a service without device access levels says to update it, and nothing is changed", async () => {
		const seen: string[] = [];
		const fetchFn: FetchFn = async (url, init) => {
			seen.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
			return Response.json(whoami({ capabilities: [] }));
		};
		const client = new CloudClient("http://cloud.test", "tok", fetchFn, { backoffMs: [1], random: () => 0.5 });
		const real = { devices: async () => [PHONE], setDeviceAccess: client.setDeviceAccess.bind(client) };
		await expect(runAccess(real, host(true).host.ui, "phone", "full")).rejects.toThrow("this omp-cloud service has no device access levels; update it");
		expect(seen.filter(s => s.startsWith("PATCH"))).toEqual([]);
	});
});

describe("devicesCard", () => {
	test("each row names the access level right after the name, and keeps the this-device mark", () => {
		const card = devicesCard([LAPTOP, PHONE], Date.parse("2026-10-20T00:00:00.000Z"));
		expect(card.lines[0]).toStartWith("laptop (this device) · full access · linux · dev12345 · ");
		expect(card.lines[1]).toStartWith("phone · threads only · ios · devzzzzz · ");
	});
});
