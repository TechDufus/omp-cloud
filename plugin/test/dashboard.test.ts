import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { CloudClient } from "../src/api";
import { runDashboard } from "../src/dashboard";
import { UserError } from "../src/types";
import { helpLines } from "../src/watch";
import { Cloud } from "../src/verbs";
import { cloudEnv, fakeHost, fakePi } from "./fakes";
import { cleanup } from "./helpers";

afterEach(cleanup);

const LINK = "http://127.0.0.1:8081/#c0de";

let server: Bun.Server<undefined>;
let origin = "";
/** Each request the fake service saw: `METHOD path` and the bearer it carried. */
let seen: { request: string; authorization: string | null }[] = [];
/** The service's answer to `POST /api/v1/dashboard/links`. */
let reply: () => Response;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch: req => {
			const url = new URL(req.url);
			seen.push({ request: `${req.method} ${url.pathname}`, authorization: req.headers.get("authorization") });
			if (req.method === "POST" && url.pathname === "/api/v1/dashboard/links") return reply();
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => {
	seen = [];
	reply = () => Response.json({ url: LINK, expiresAt: "2026-10-20T00:01:00.000Z" }, { status: 201 });
});

describe("runDashboard", () => {
	test("posts for a link and shows it with its limits, never the token", async () => {
		const host = fakeHost();
		const link = await runDashboard(new CloudClient(origin, "tok-secret"), host.host.ui);

		expect(link).toEqual({ url: LINK, expiresAt: "2026-10-20T00:01:00.000Z" });
		expect(seen).toEqual([{ request: "POST /api/v1/dashboard/links", authorization: "Bearer tok-secret" }]);
		expect(host.notes).toEqual([[`☁ dashboard: ${LINK}\n  one use, valid 60 s`, "info"]]);
		expect(JSON.stringify(host.notes)).not.toContain("tok-secret");
	});

	test("a service without a dashboard says how to add one", async () => {
		reply = () => Response.json({ error: "the dashboard is not configured" }, { status: 404 });
		const host = fakeHost();
		const err = await runDashboard(new CloudClient(origin, "tok"), host.host.ui).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(UserError);
		expect((err as UserError).message).toContain("service.json");
		expect(host.notes).toEqual([]);
	});

	test("other failures keep the service's message", async () => {
		reply = () => Response.json({ error: "unauthorized" }, { status: 401 });
		const err = await runDashboard(new CloudClient(origin, "bad"), fakeHost().host.ui).catch((e: unknown) => e);

		expect(err).not.toBeInstanceOf(UserError);
		expect((err as Error).message).toBe("unauthorized");
	});
});

describe("/cloud dashboard", () => {
	test("the verb prints the link", async () => {
		const host = fakeHost({ cwd: tmpdir() });
		const env = await cloudEnv(`url: ${origin}\ntoken: tok\n`);
		await new Cloud(fakePi().pi, "/own", env).handle("dashboard", { ...host.host, switchSession: async () => ({ cancelled: false }) });

		expect(host.notes).toEqual([[`☁ dashboard: ${LINK}\n  one use, valid 60 s`, "info"]]);
		expect(seen.map(s => s.request)).toEqual(["POST /api/v1/dashboard/links"]);
	});

	test("help lists it", () => {
		expect(helpLines().some(line => line.startsWith("/cloud dashboard") && line.includes("sign-in link"))).toBe(true);
	});
});
