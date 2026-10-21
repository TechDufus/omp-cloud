/**
 * Starts the dashboard harness on the showcase data (`scripts/dashboard-dev.ts --showcase`) and reads what it prints:
 * the sign-in link, the API address, the owner token file and the control port `scripts/showcase/service.ts` opens.
 * Shared by the capture scripts. Nothing here touches the real service: the harness seeds a temp directory.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "../..");

export interface Harness {
	/** The service's API, e.g. `http://127.0.0.1:41234`. */
	api: string;
	/** The address people open (the dashboard, through the harness's front listener when the update is scripted). */
	signInUrl: string;
	dashboardOrigin: string;
	token: string;
	tokenFile: string;
	/** The harness's temp directory (removed when it stops). */
	root: string;
	controlPort: number;
	stop(): Promise<void>;
}

/** `--update=<state>` is passed through; without it the dashboard shows what the service answers. */
export async function startHarness(options: { update?: string } = {}): Promise<Harness> {
	const args = ["run", "scripts/dashboard-dev.ts", "--showcase", ...(options.update === undefined ? [] : [`--update=${options.update}`])];
	const proc = Bun.spawn([process.execPath, ...args], { cwd: REPO_ROOT, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	let signInUrl = "";
	let api = "";
	let tokenFile = "";
	let controlPort = 0;
	let ready: (() => void) | undefined;
	const started = new Promise<void>(resolveStarted => {
		ready = resolveStarted;
	});
	const onLine = (line: string): void => {
		const sign = /sign-in:\s+(http\S+)/.exec(line);
		if (sign?.[1] !== undefined) signInUrl = sign[1];
		const apiMatch = /^\s+API:\s+(http\S+)/.exec(line);
		if (apiMatch?.[1] !== undefined) api = apiMatch[1];
		const token = /owner token:\s+(\S+)/.exec(line);
		if (token?.[1] !== undefined) tokenFile = token[1];
		const control = /showcase control on http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
		if (control?.[1] !== undefined) controlPort = Number(control[1]);
		if (line.includes("Ctrl+C stops")) ready?.();
	};
	const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		const decoder = new TextDecoder();
		let pending = "";
		for await (const chunk of stream) {
			pending += decoder.decode(chunk, { stream: true });
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		}
	};
	void pump(proc.stdout);
	void pump(proc.stderr);
	const timeout = Bun.sleep(120_000).then(() => {
		throw new Error("the harness did not start within 120 s");
	});
	await Promise.race([started, timeout]);
	if (signInUrl === "" || api === "" || tokenFile === "" || controlPort === 0) throw new Error("the harness did not print its addresses");
	const token = readFileSync(tokenFile, "utf8").trim();
	return {
		api,
		signInUrl,
		dashboardOrigin: new URL(signInUrl).origin,
		token,
		tokenFile,
		root: join(tokenFile, ".."),
		controlPort,
		async stop() {
			proc.kill("SIGINT");
			await Promise.race([proc.exited, Bun.sleep(8000)]);
			if (proc.exitCode === null) proc.kill("SIGKILL");
		},
	};
}

/** A new one-time sign-in link, by pressing Enter in the harness: the first expires after 60 s. */
export async function mintLink(api: string, token: string, dashboardOrigin: string): Promise<string> {
	const res = await fetch(`${api}/api/v1/dashboard/links`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
	if (res.status !== 201) throw new Error(`minting a sign-in link failed: ${res.status}`);
	const body: unknown = await res.json();
	const url = typeof body === "object" && body !== null && "url" in body ? String(body.url) : "";
	const link = new URL(url);
	link.port = new URL(dashboardOrigin).port;
	return link.href;
}

export interface ThreadRow {
	id: string;
	name: string;
	phase: string;
}

export async function threads(h: Harness): Promise<ThreadRow[]> {
	const res = await fetch(`${h.api}/api/v1/threads`, { headers: { Authorization: `Bearer ${h.token}` } });
	const body: unknown = await res.json();
	if (typeof body !== "object" || body === null || !("threads" in body) || !Array.isArray(body.threads)) throw new Error("unexpected thread list");
	return body.threads.map((t: { id: string; name: string; phase: string }) => ({ id: t.id, name: t.name, phase: t.phase }));
}
