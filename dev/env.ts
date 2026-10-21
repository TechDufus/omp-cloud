/**
 * Side-effect import: points the e2b SDK at the local vmon with the team key `omp-cloud setup` wrote to
 * `~/.config/omp-cloud/vmon.key`, without overriding E2B_* variables that are already set. Import it before `e2b`. The key is never printed.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VMON_KEY_PATH = join(homedir(), ".config", "omp-cloud", "vmon.key");
const VMON_URL = "http://127.0.0.1:3000";
const VMON_DOMAIN = "localhost";

function readKey(): string {
	try {
		return readFileSync(VMON_KEY_PATH, "utf8").trim();
	} catch {
		return "";
	}
}

process.env.E2B_API_URL ??= VMON_URL;
process.env.E2B_SANDBOX_URL ??= VMON_URL;
process.env.E2B_DOMAIN ??= VMON_DOMAIN;
if (!process.env.E2B_API_KEY) {
	const key = readKey();
	if (key === "") {
		console.error(`E2B_API_KEY is not set and ${VMON_KEY_PATH} is missing or empty: run omp-cloud setup (mise run infra:up in a checkout) to create the team key`);
		process.exit(1);
	}
	process.env.E2B_API_KEY = key;
}
