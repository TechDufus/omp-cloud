import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock } from "./run-lock";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "omp-cloud-run-lock-"));
	file = join(dir, "state", "scenario.lock");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A pid no process has: a child that has ended. */
function deadPid(): number {
	const child = Bun.spawnSync(["true"]);
	return child.pid;
}

describe("the run lock", () => {
	test("a free lock is taken by this process and names it", () => {
		acquireRunLock("test-run", file);
		const held: unknown = JSON.parse(readFileSync(file, "utf8"));
		expect(held).toMatchObject({ pid: process.pid, name: "test-run" });
	});

	test("a live holder refuses the run and is named", () => {
		const holder = Bun.spawn(["sleep", "30"]);
		try {
			writeFileSync(join(dir, "other"), "");
			Bun.spawnSync(["mkdir", "-p", join(dir, "state")]);
			writeFileSync(file, JSON.stringify({ pid: holder.pid, name: "plugin:scenario", since: "2026-01-01T00:00:00.000Z" }));
			expect(() => acquireRunLock("scenario", file)).toThrow(`plugin:scenario (pid ${holder.pid}, since 2026-01-01T00:00:00.000Z) is running`);
			expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: holder.pid });
		} finally {
			holder.kill();
		}
	});

	test("a dead holder's lock is stale and taken over", () => {
		Bun.spawnSync(["mkdir", "-p", join(dir, "state")]);
		writeFileSync(file, JSON.stringify({ pid: deadPid(), name: "scenario", since: "2026-01-01T00:00:00.000Z" }));
		acquireRunLock("parity:capture", file);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid, name: "parity:capture" });
	});

	test("an unreadable lock file is stale", () => {
		Bun.spawnSync(["mkdir", "-p", join(dir, "state")]);
		writeFileSync(file, "not json");
		acquireRunLock("scenario", file);
		expect(existsSync(file)).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid });
	});
});
