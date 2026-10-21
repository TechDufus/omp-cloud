import { describe, expect, test } from "bun:test";
import { byteRange } from "./download";

describe("byteRange", () => {
	test("reads a closed, an open and a suffix range, clamping the end", () => {
		expect(byteRange("bytes=0-5", 12)).toEqual({ start: 0, end: 5 });
		expect(byteRange("bytes=4-", 12)).toEqual({ start: 4, end: 11 });
		expect(byteRange("bytes=4-99", 12)).toEqual({ start: 4, end: 11 });
		expect(byteRange("bytes=-3", 12)).toEqual({ start: 9, end: 11 });
		expect(byteRange("bytes=-99", 12)).toEqual({ start: 0, end: 11 });
	});

	test("a range that selects nothing is unsatisfiable", () => {
		expect(byteRange("bytes=12-", 12)).toBe("unsatisfiable");
		expect(byteRange("bytes=100-200", 12)).toBe("unsatisfiable");
		expect(byteRange("bytes=-0", 12)).toBe("unsatisfiable");
		expect(byteRange("bytes=-5", 0)).toBe("unsatisfiable");
	});

	test("no header, several ranges or anything else is served whole", () => {
		for (const header of [null, "", "bytes=", "bytes=-", "bytes=0-1,3-4", "items=0-1", "bytes=5-2", "bytes=a-b"]) {
			expect(byteRange(header, 12)).toBeNull();
		}
	});
});
