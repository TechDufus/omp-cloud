import { describe, expect, test } from "bun:test";
import { Inbox, type InboxEntry } from "../src/inbox";
import { clearReport, encodeText, ProgramStatus, reportFor } from "../src/program-status";

const T = "k3x9fa2m7q1z";
const b64 = (text: string): string => Buffer.from(text).toString("base64");
const decode = (value: string): string => Buffer.from(value, "base64").toString("utf8");

/** The value of `key` in a report. */
function pair(report: string, key: string): string | undefined {
	const body = report.slice("\x1b]7501;".length, -"\x1b\\".length);
	const found = body
		.split(":")
		.map(p => p.split("=") as [string, string])
		.find(([k]) => k === key);
	return found?.[1];
}

const entry = (over: Partial<InboxEntry> = {}): InboxEntry => ({ thread: T, turn: 1, kind: "result", label: "Fix greeting bug", line: "All done.", at: 0, read: false, ...over });

describe("encodeText", () => {
	test("base64 of one control-free line", () => {
		expect(encodeText("a\tb\nc\u0007d\u0085e   f", 100)).toBe(b64("a b c d e f"));
		expect(encodeText("  \n\t ", 100)).toBeUndefined();
	});

	test("cut at a character within the byte limit, never in the middle of one", () => {
		const text = "é".repeat(100);
		const encoded = encodeText(text, 11) ?? "";
		expect(decode(encoded)).toBe("é".repeat(5));
		expect(Buffer.byteLength(decode(encodeText("x".repeat(5000), 2048) ?? ""))).toBe(2048);
		expect(decode(encodeText("😀".repeat(10), 9) ?? "")).toBe("😀😀");
	});
});

describe("reportFor", () => {
	test("a question: blocked, kind question or permission, app, title and msg", () => {
		const q = reportFor(T, [entry({ kind: "question", line: "Which database?" })]) ?? "";
		expect(q).toBe(`\x1b]7501;state=blocked:kind=question:id=omp-cloud/${T}:app=omp-cloud:title=${b64("Fix greeting bug")}:msg=${b64("Fix greeting bug asks: Which database?")}\x1b\\`);
		const p = reportFor(T, [entry({ kind: "question", line: "Allow tool: bash", permission: true })]) ?? "";
		expect(pair(p, "kind")).toBe("permission");
	});

	test("a done turn and a failed turn", () => {
		expect(reportFor(T, [entry()])).toBe(`\x1b]7501;state=done:id=omp-cloud/${T}:app=omp-cloud:title=${b64("Fix greeting bug")}:msg=${b64("Fix greeting bug · turn 1 done: All done.")}\x1b\\`);
		expect(reportFor(T, [entry({ kind: "failure", turn: 3, line: "vm lost" })])).toBe(
			`\x1b]7501;state=error:id=omp-cloud/${T}:app=omp-cloud:title=${b64("Fix greeting bug")}:msg=${b64("Fix greeting bug · turn 3 failed: vm lost")}\x1b\\`,
		);
	});

	test("the newest unread entry decides; an open question beats any result", () => {
		const done = entry({ turn: 1 });
		const failed = entry({ kind: "failure", turn: 2, line: "boom" });
		expect(pair(reportFor(T, [done, failed]) ?? "", "state")).toBe("error");
		expect(pair(reportFor(T, [failed, done]) ?? "", "state")).toBe("done");
		expect(pair(reportFor(T, [entry({ kind: "question", line: "?" }), failed]) ?? "", "state")).toBe("blocked");
	});

	test("stays within the protocol: limits, no control characters, a legal id", () => {
		const long = reportFor(T, [entry({ label: "L".repeat(500), line: `${"w ".repeat(2000)}\n\u0007end` })]) ?? "";
		expect(Buffer.byteLength(decode(pair(long, "title") ?? ""))).toBeLessThanOrEqual(192);
		const msg = decode(pair(long, "msg") ?? "");
		expect(Buffer.byteLength(msg)).toBeLessThanOrEqual(2048);
		expect(msg).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
		expect(Buffer.byteLength(long)).toBeLessThan(4096);
		expect(reportFor("bad id", [entry()])).toBeUndefined();
		expect(reportFor("x".repeat(33), [entry()])).toBeUndefined();
		expect(reportFor(T, [])).toBeUndefined();
	});

	test("clear removes one thread's record, or every record of the plugin", () => {
		expect(clearReport(T)).toBe(`\x1b]7501;state=clear:id=omp-cloud/${T}\x1b\\`);
		expect(clearReport()).toBe("\x1b]7501;state=clear:id=omp-cloud\x1b\\");
	});
});

describe("ProgramStatus", () => {
	function rig(enabled = { on: true }) {
		const inbox = new Inbox();
		const written: string[] = [];
		const changes = {
			listeners: 0,
			current: undefined as ((enabled: boolean) => void) | undefined,
			emit(enabled: boolean) {
				this.current?.(enabled);
			},
		};
		const status = new ProgramStatus({
			inbox,
			write: s => void written.push(s),
			enabled: () => enabled.on,
			onEnabledChange: listener => {
				changes.listeners++;
				changes.current = listener;
				return () => {
					changes.listeners--;
					changes.current = undefined;
				};
			},
		});
		return { inbox, written, status, enabled, changes };
	}

	test("writes a record per thread with unread entries, once per change", () => {
		const { inbox, written, status } = rig();
		inbox.add(entry());
		status.sync();
		status.sync();
		expect(written).toHaveLength(1);
		inbox.add(entry({ thread: "bbbbbbq9w8e7", label: "Other" }));
		status.sync();
		expect(written).toHaveLength(2);
		expect(pair(written[1] ?? "", "id")).toBe("omp-cloud/bbbbbbq9w8e7");
	});

	test("a newer entry replaces the record; reading clears it", () => {
		const { inbox, written, status } = rig();
		inbox.add(entry());
		status.sync();
		inbox.add(entry({ kind: "failure", turn: 2, line: "boom" }));
		status.sync();
		// The first report needs no clear; a changed one is cleared right before, in the same write, so the terminal sees an arrival.
		expect(written[0]).toBe(reportFor(T, [entry()]));
		expect(written[1]).toBe(`${clearReport(T)}${reportFor(T, [entry(), entry({ kind: "failure", turn: 2, line: "boom" })])}`);
		expect(written[1]?.split("\x1b\\")).toHaveLength(3);
		inbox.read(T);
		status.sync();
		expect(written.at(-1)).toBe(clearReport(T));
		status.sync();
		expect(written).toHaveLength(3);
	});

	test("with the setting off nothing is written and what was written is removed", () => {
		const { inbox, written, status, enabled } = rig();
		inbox.add(entry());
		status.sync();
		enabled.on = false;
		status.sync();
		expect(written.at(-1)).toBe(clearReport());
		inbox.add(entry({ turn: 2 }));
		status.sync();
		expect(written).toHaveLength(2);
		enabled.on = true;
		status.sync();
		expect(written).toHaveLength(3);
		expect(pair(written[2] ?? "", "msg")).toBe(b64("Fix greeting bug · turn 2 done: All done."));
	});

	test("clearAll with nothing written writes nothing", () => {
		const { written, status } = rig();
		status.clearAll();
		expect(written).toEqual([]);
	});

	test("omp clearing every record when the setting goes off makes the records be written again when it comes back", () => {
		const { inbox, written, status, enabled, changes } = rig();
		inbox.add(entry());
		status.sync();
		expect(written).toHaveLength(1);
		// Off: omp itself clears the terminal's records, so the plugin writes nothing and forgets what it sent.
		enabled.on = false;
		changes.emit(false);
		expect(written).toHaveLength(1);
		enabled.on = true;
		changes.emit(true);
		expect(written).toHaveLength(2);
		expect(written[1]).toBe(reportFor(T, [entry()]));
		status.dispose();
	});

	test("after a suspend the blocked records are written again, and the others are not", () => {
		const { inbox, written, status } = rig();
		inbox.add(entry({ kind: "question", line: "Which?" }));
		inbox.add(entry({ thread: "bbbbbbq9w8e7", label: "Other" }));
		status.sync();
		expect(written).toHaveLength(2);
		process.emit("SIGCONT");
		expect(written).toHaveLength(3);
		expect(pair(written[2] ?? "", "state")).toBe("blocked");
		expect(pair(written[2] ?? "", "id")).toBe(`omp-cloud/${T}`);
		status.dispose();
	});

	test("dispose clears the records and stops listening to the setting and to SIGCONT", () => {
		const { inbox, written, status, changes } = rig();
		inbox.add(entry({ kind: "question", line: "Which?" }));
		status.sync();
		const resumed = process.listenerCount("SIGCONT");
		status.dispose();
		expect(written.at(-1)).toBe(clearReport());
		expect(process.listenerCount("SIGCONT")).toBe(resumed - 1);
		expect(changes.listeners).toBe(0);
		inbox.add(entry({ turn: 2 }));
		status.sync();
		process.emit("SIGCONT");
		expect(written).toHaveLength(2);
	});
});
