import { describe, expect, test } from "bun:test";
import { recordingRunner } from "./test-support";
import { parseSystemdEnvironment, Units } from "./system";

describe("parseSystemdEnvironment", () => {
	test("plain words, quoted words with spaces, escapes and an empty value", () => {
		expect(parseSystemdEnvironment('HOME=/tmp/h PATH=/a:/b "TWO=two words" "Q=say \\"hi\\"" EMPTY= BACK="x\\\\y"')).toEqual({
			HOME: "/tmp/h",
			PATH: "/a:/b",
			TWO: "two words",
			Q: 'say "hi"',
			EMPTY: "",
			BACK: "x\\y",
		});
	});

	test("an empty value, junk words and bad names give nothing", () => {
		expect(parseSystemdEnvironment("")).toEqual({});
		expect(parseSystemdEnvironment("junk 1X=no =x A-B=no")).toEqual({});
	});
});

describe("Units.environment", () => {
	test("asks systemctl for the unit's Environment and parses it; an unloaded unit gives {}", async () => {
		const { run, calls } = recordingRunner((argv) => (argv[4] === "Environment" ? { stdout: "HOME=/h LANG=C\n" } : undefined));
		expect(await new Units(run).environment("omp-cloud")).toEqual({ HOME: "/h", LANG: "C" });
		expect(calls[0]?.argv).toEqual(["systemctl", "--user", "show", "-p", "Environment", "--value", "omp-cloud"]);
		const failing = recordingRunner(() => ({ code: 1, stderr: "not found" }));
		expect(await new Units(failing.run).environment("omp-cloud")).toEqual({});
	});
});
