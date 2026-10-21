import { describe, expect, test } from "bun:test";
import { directModelIds } from "./model-ids";

describe("directModelIds", () => {
	test("lists provider/id for every declared model, sorted and once", () => {
		expect(
			directModelIds({
				fake: { baseUrl: "http://x", models: [{ id: "m2" }, { id: "m1" }, { id: "m1" }] },
				alpha: { baseUrl: "http://y", models: [{ id: "z", name: "Z" }] },
			}),
		).toEqual(["alpha/z", "fake/m1", "fake/m2"]);
	});

	test("a provider that declares no usable models contributes none", () => {
		expect(directModelIds({ none: { baseUrl: "http://x" }, odd: { models: "m" }, bad: { models: [{ id: "" }, { id: 4 }, "m", null] } })).toEqual([]);
		expect(directModelIds({})).toEqual([]);
	});
});
