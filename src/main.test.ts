import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "./main";

let dir: string;
let occupant: Bun.Server<undefined> | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
});

afterEach(async () => {
	await occupant?.stop(true);
	occupant = undefined;
	await rm(dir, { recursive: true, force: true });
});

describe("serve", () => {
	test("a second serve on a taken API address fails before it creates a store or issues a gateway client", async () => {
		occupant = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("the running service") });
		const config = {
			listen: `127.0.0.1:${occupant.port}`,
			apiTokenSha256: "0".repeat(64),
			dataDir: join(dir, "data"),
			vmon: { url: "http://127.0.0.1:1", keyFile: join(dir, "vmon.key"), template: "omp-agent" },
			gateway: { url: "http://127.0.0.2:2", clientsFile: join(dir, "gateway-clients.json") },
			broker: { url: "http://127.0.0.1:3", tokenFile: join(dir, "broker.token") },
			models: { default: "fake/fake-model", direct: {} },
			runner: { enabled: false },
		};
		const path = join(dir, "config.json");
		await Bun.write(path, JSON.stringify(config));

		const failure = await serve(["--config", path]).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(Error);
		const message = failure instanceof Error ? failure.message : "";
		expect(message).toContain(`http://127.0.0.1:${occupant.port} is already in use`);
		expect(message).toContain("systemctl --user status omp-cloud");
		expect(message).toContain("Nothing was changed");
		// Nothing of the service was created: no database and thread directory, no gateway client.
		// Nothing of the service was created: no data directory, no gateway clients file.
		// The listener that was there still answers.
		expect(await (await fetch(`http://127.0.0.1:${occupant.port}/`)).text()).toBe("the running service");
	});
});
