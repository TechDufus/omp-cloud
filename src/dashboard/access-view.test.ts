import { describe, expect, test } from "bun:test";
import { gib } from "./client/format";
import { renewTone } from "./client/pages/logins-view";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("renewTone", () => {
	test("is bad once the date is past, warn inside a week of it, neutral before that", () => {
		expect(renewTone(new Date(NOW - DAY_MS).toISOString(), NOW)).toBe("bad");
		expect(renewTone(new Date(NOW + 3 * DAY_MS).toISOString(), NOW)).toBe("warn");
		expect(renewTone(new Date(NOW + 20 * DAY_MS).toISOString(), NOW)).toBe("neutral");
	});

	test("is null when the login has no date, or one that does not parse", () => {
		expect(renewTone("", NOW)).toBeNull();
		expect(renewTone("not a date", NOW)).toBeNull();
	});
});

describe("gib", () => {
	test("keeps whole gibibytes whole and rounds the rest to one decimal", () => {
		expect(gib(98304)).toBe("96");
		expect(gib(65536)).toBe("64");
		expect(gib(7680)).toBe("7.5");
		expect(gib(0)).toBe("0");
	});
});
