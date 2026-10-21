import { describe, expect, test } from "bun:test";
import { tokenResolver } from "./token";

describe("update.token", () => {
	test("empty is anonymous; a literal is itself", async () => {
		const resolve = tokenResolver({}, () => undefined);
		expect(await resolve("")).toBeUndefined();
		expect(await resolve("   ")).toBeUndefined();
		expect(await resolve("ghp_literal-1234")).toBe("ghp_literal-1234");
	});

	test("an environment variable name gives its value when it is set; unset it is taken literally", async () => {
		const resolve = tokenResolver({ GH_TOKEN: " from-env \n" }, () => undefined);
		expect(await resolve("GH_TOKEN")).toBe("from-env");
		expect(await resolve("OTHER_NAME")).toBe("OTHER_NAME");
	});

	test("a !command is run and its output is the token; the log names the program, never the value, once", async () => {
		const logged: string[] = [];
		const resolve = tokenResolver({}, (message) => logged.push(message));
		expect(await resolve("!printf 's3cr3t-value\\n'")).toBe("s3cr3t-value");
		expect(await resolve("!printf 's3cr3t-value\\n'")).toBe("s3cr3t-value");
		expect(logged).toEqual(["update.token runs printf"]);
		expect(logged.join()).not.toContain("s3cr3t");
	});

	test("a failing or silent command is an error that carries no output", async () => {
		const resolve = tokenResolver({}, () => undefined);
		await expect(resolve("!echo leak-this; exit 3")).rejects.toThrow("the credential command of update.token failed (exit 3)");
		await expect(resolve("!true")).rejects.toThrow("printed nothing");
	});
});
