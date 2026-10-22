import { join } from "node:path";
import { resolveConfigValue } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { readMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { isLocalHost, isRecord } from "./guards";
import type { McpShip, Whoami } from "./types";

/** What the launch card shows of a shipped MCP server: an http one is reached through the service, a stdio one runs in the VM. */
export interface McpSummary {
	name: string;
	via: "service" | "vm";
}

export interface McpPlan {
	servers: McpShip[];
	summary: McpSummary[];
	warnings: string[];
}

/** The agent dir's MCP files, in precedence order: the first one that defines a name wins. */
const MCP_FILES = ["mcp.json", ".mcp.json"] as const;

/** A stdio `env` value the cloud accepts: a reference to a variable the VM has (a Secret of the service), never a literal. */
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/;
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** `${VAR}` and `${VAR:-default}` expanded from `env`; undefined when a variable is unset (or empty) and has no default. */
function expand(value: string, env: Record<string, string | undefined>): string | undefined {
	let missing = false;
	const out = value.replace(VARIABLE, (_all, name: string, fallback: string | undefined) => {
		const v = env[name];
		if (v !== undefined && v !== "") return v;
		if (fallback !== undefined) return fallback;
		missing = true;
		return "";
	});
	return missing ? undefined : out;
}

/** A header value as omp resolves it: variables expanded, then `!command`, environment variable name or literal. Undefined when it resolves to nothing. */
async function resolveHeader(value: string, env: Record<string, string | undefined>): Promise<string | undefined> {
	const expanded = expand(value, env);
	if (expanded === undefined) return undefined;
	try {
		const resolved = await resolveConfigValue(expanded);
		return resolved === undefined || resolved === "" ? undefined : resolved;
	} catch {
		return undefined;
	}
}

function strings(v: unknown): string[] | undefined {
	return Array.isArray(v) && v.every(x => typeof x === "string") ? (v as string[]) : undefined;
}

/** The URL's host is this machine: the VM cannot reach it, and the service refuses it. */
function pointsHome(url: string): boolean {
	try {
		return isLocalHost(new URL(url).hostname);
	} catch {
		return false;
	}
}

interface Entry {
	name: string;
	config: Record<string, unknown>;
}

/** The servers of the agent dir's MCP files that are enabled, the first file winning per name; a file that cannot be read is a warning. */
async function readEntries(agentDir: string, warnings: string[]): Promise<Entry[]> {
	const entries: Entry[] = [];
	const seen = new Set<string>();
	const disabled = new Set<string>();
	for (const file of MCP_FILES) {
		const path = join(agentDir, file);
		let doc: unknown;
		try {
			doc = await readMCPConfigFile(path);
		} catch (e) {
			warnings.push(`${file}: MCP servers are not shipped: ${e instanceof Error ? e.message : String(e)}`);
			continue;
		}
		if (!isRecord(doc)) continue;
		for (const name of strings(doc.disabledServers) ?? []) disabled.add(name);
		if (!isRecord(doc.mcpServers)) continue;
		for (const [name, config] of Object.entries(doc.mcpServers)) {
			if (seen.has(name)) continue;
			seen.add(name);
			if (isRecord(config)) entries.push({ name, config });
		}
	}
	return entries.filter(e => !disabled.has(e.name) && e.config.enabled !== false);
}

/**
 * The MCP servers of `<agentDir>/mcp.json` and `<agentDir>/.mcp.json` the cloud agent gets. An http server goes through the
 * service's proxy, which holds its credentials: its headers are resolved here (the way omp resolves them) and the service
 * keeps them from the VM. A stdio server runs in the VM and may only reference variables (`${NAME}`) the cloud's Secrets
 * provide. What cannot ship (a loopback url, an unresolved header, SSE, literal env values) is a warning and stays home. A
 * service without `mcp.proxy` takes none of it.
 */
export async function planMcp(agentDir: string, env: Record<string, string | undefined>, who: Pick<Whoami, "capabilities" | "mcpProxy" | "mcpLogins">): Promise<McpPlan> {
	const plan: McpPlan = { servers: [], summary: [], warnings: [] };
	const entries = await readEntries(agentDir, plan.warnings);
	if (entries.length === 0) return plan;
	if (!who.capabilities.includes("mcp.proxy")) {
		plan.warnings.push("the cloud service cannot take MCP servers; none are shipped");
		return plan;
	}
	let noProxy = false;
	for (const { name, config } of entries) {
		const type = typeof config.type === "string" ? config.type : typeof config.url === "string" ? "http" : "stdio";
		if (type === "sse") {
			plan.warnings.push(`${name} is not shipped: SSE MCP servers are not proxied; use type http`);
		} else if (type === "http") {
			const url = typeof config.url === "string" ? config.url : "";
			if (url === "") {
				plan.warnings.push(`${name} is not shipped: it has no url`);
				continue;
			}
			if (pointsHome(url)) {
				plan.warnings.push(`${name} points at this machine and is not shipped`);
				continue;
			}
			if (!who.mcpProxy) {
				noProxy = true;
				continue;
			}
			const headers: Record<string, string> = {};
			let unresolved: string | undefined;
			for (const [header, raw] of Object.entries(isRecord(config.headers) ? config.headers : {})) {
				const value = typeof raw === "string" ? await resolveHeader(raw, env) : undefined;
				if (value === undefined) {
					unresolved = header;
					break;
				}
				headers[header] = value;
			}
			if (unresolved !== undefined) {
				plan.warnings.push(`${name} is not shipped: header ${unresolved} did not resolve`);
				continue;
			}
			if (!Object.keys(headers).some(h => h.toLowerCase() === "authorization") && !who.mcpLogins.includes(url)) {
				plan.warnings.push(`${name} may need a cloud login: /cloud login mcp:${url}`);
			}
			plan.servers.push({ name, type: "http", url, headers });
			plan.summary.push({ name, via: "service" });
		} else if (type === "stdio") {
			const command = typeof config.command === "string" ? config.command : "";
			if (command === "") {
				plan.warnings.push(`${name} is not shipped: it has no command`);
				continue;
			}
			const stdioEnv = isRecord(config.env) ? config.env : {};
			if (Object.values(stdioEnv).some(v => typeof v !== "string" || !ENV_REFERENCE.test(v))) {
				plan.warnings.push(`${name} is not shipped: its env has literal values; put them in the cloud's Secrets and reference them as \${NAME}`);
				continue;
			}
			const cwd = typeof config.cwd === "string" && config.cwd !== "" && !config.cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(config.cwd) ? config.cwd : undefined;
			plan.servers.push({ name, type: "stdio", command, args: strings(config.args) ?? [], env: stdioEnv as Record<string, string>, ...(cwd === undefined ? {} : { cwd }) });
			plan.summary.push({ name, via: "vm" });
		} else {
			plan.warnings.push(`${name} is not shipped: MCP server type ${type} is not supported`);
		}
	}
	if (noProxy) plan.warnings.push("the cloud has no MCP proxy; http MCP servers are not shipped");
	return plan;
}
