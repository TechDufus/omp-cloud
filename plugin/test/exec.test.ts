import { describe, expect, test } from "bun:test";
import { ompCommand } from "../src/exec";

describe("ompCommand", () => {
	test("under a source checkout or `bun test` it is the omp on PATH", () => {
		expect(ompCommand()).toEqual(["omp"]);
	});

	for (const main of ["/$bunfs/root/omp-linux-x64", "B:/~BUN/root/omp.exe", "B:/%7EBUN/root/omp.exe"]) {
		test(`a compiled omp (${main}) re-enters its own executable`, () => {
			expect(ompCommand(main)).toEqual([process.execPath]);
		});
	}

	test("a plain script path is not a compiled omp", () => {
		expect(ompCommand("/home/me/omp/src/cli.ts")).toEqual(["omp"]);
	});
});
