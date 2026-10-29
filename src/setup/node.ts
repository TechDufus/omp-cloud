/**
 * `omp-cloud setup node --join <user@server>`: makes this machine a vibemon node of an omp-cloud server's cluster. The user
 * part asks the server for what a node needs over ssh (`omp-cloud node-join-info`), plans, asks once, runs one
 * `sudo -- <self> setup system --node …` for all root work, then checks from both sides that the machine really joined.
 * The cluster secret travels only through that ssh answer, a 0600 file in a private temp directory and the root part:
 * it is in no step, no note, no `--json` output and no command line.
 */
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { isIP } from "node:net";
import { isRecord } from "../guards";
import type { CommandResult } from "../update/system";
import { realContext, type SetupContext } from "./context";
import { isUnicastHost } from "./ipv4";
import { installManagedBinary } from "./managed";
import { packagesFor } from "./packages";
import { preflight } from "./preflight";
import { runRootPart, sudoReady } from "./root";
import { Reporter, type StepResult } from "./steps";
import { NODE_SECRET_PATTERN } from "./system";
import { VMM_USER_PLAN } from "./system-units";

export const NODE_USAGE = "usage: omp-cloud setup node --join <user@server> [--yes] [--json]";

const SERVICE_IP = "10.254.254.1";
const GATEWAY_URL = `http://${SERVICE_IP}:4000/healthz`;
const JOIN_TIMEOUT_MS = 60_000;
const MEMBER_TIMEOUT_MS = 75_000;
const GATEWAY_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 10_000;

export interface NodeArgs {
	/** The text after `--join`, as the user typed it. */
	join: string;
	yes: boolean;
	json: boolean;
}

export type ParsedNodeArgs = { ok: true; args: NodeArgs } | { ok: false; error: string };

/** Validates `setup node`'s flags; an error is a usage error (exit 2). `argv` follows the words `setup node`. */
export function parseNodeArgs(argv: readonly string[]): ParsedNodeArgs {
	let join: string | undefined;
	let yes = false;
	let json = false;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index] ?? "";
		if (flag === "--yes" || flag === "-y") yes = true;
		else if (flag === "--json") json = true;
		else if (flag === "--join") {
			join = argv[++index];
			if (join === undefined) return { ok: false, error: "--join needs a target: user@host, a host name or ssh://[user@]host[:port]" };
		} else return { ok: false, error: `unknown argument ${JSON.stringify(flag)}` };
	}
	if (join === undefined) return { ok: false, error: "--join <user@server> is required: the omp-cloud server this machine joins" };
	return { ok: true, args: { join, yes, json } };
}

/** What ssh connects to: `destination` is `[user@]host`, `port` only when the target named one. */
export interface SshTarget {
	destination: string;
	port: number | undefined;
}

const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** A host name or an ssh_config alias (underscores included). IPv6 literals are not accepted: use a host name. */
const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const SSH_URI = /^ssh:\/\/(?:([^@/\s]+)@)?([^:/\s@[\]]+)(?::(\d{1,5}))?\/?$/i;
const NOT_A_TARGET = "that is not an ssh target (expected user@host, a host name, or ssh://[user@]host[:port]; an IPv6 literal is not accepted, use a host name)";

/**
 * The ssh target in `input`: `user@host`, a bare host or `ssh://[user@]host[:port]` (the ssh branch of the plugin's
 * `parseConnectTarget`, `plugin/src/pairing.ts`). A string that starts with `-` is refused (ssh would read it as an
 * option). Returns the reason when it is not one.
 */
export function parseJoinTarget(input: string): SshTarget | string {
	const text = input.trim();
	if (text.startsWith("-")) return "an ssh target cannot start with '-' (ssh would read it as an option)";
	const uri = SSH_URI.exec(text);
	if (uri !== null) {
		const [, user, host, portText] = uri;
		const port = portText === undefined ? undefined : Number(portText);
		if (host === undefined || !SSH_HOST.test(host) || (user !== undefined && !SSH_USER.test(user)) || (port !== undefined && (port < 1 || port > 65535))) return NOT_A_TARGET;
		return { destination: user === undefined ? host : `${user}@${host}`, port };
	}
	const at = text.lastIndexOf("@");
	const user = at < 0 ? undefined : text.slice(0, at);
	const host = at < 0 ? text : text.slice(at + 1);
	if (!SSH_HOST.test(host) || (user !== undefined && !SSH_USER.test(user))) return NOT_A_TARGET;
	return { destination: user === undefined ? host : `${user}@${host}`, port: undefined };
}

/** `arg` as one word of a POSIX shell, and of fish: single-quoted, each `'` written `'\''`. Twin of `quoteArg` in `plugin/src/ssh.ts` (`src/` does not import `plugin/`). */
export function quoteArg(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * What the remote login shell is asked to run, whatever its syntax: `sh -c` with a fixed script that execs `omp-cloud`
 * from PATH, else `$HOME/.local/bin/omp-cloud`, given `args`. Twin of `remoteCommand` in `plugin/src/ssh.ts`: keep both in step.
 */
export function remoteCommand(args: readonly string[]): string {
	const script = 'if command -v omp-cloud >/dev/null 2>&1; then exec omp-cloud "$@"; fi; exec "$HOME/.local/bin/omp-cloud" "$@"';
	return ["sh", "-c", script, "sh", ...args].map(quoteArg).join(" ");
}

function portArgs(target: SshTarget): string[] {
	return target.port === undefined ? [] : ["-p", String(target.port)];
}

/** The ssh command line of a question to the server. `-T` and `BatchMode=yes` keep ssh from ever prompting; `ConnectTimeout=10` bounds the connection. */
export function sshArgv(executable: string, target: SshTarget, args: readonly string[]): string[] {
	return [executable, "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...portArgs(target), "--", target.destination, remoteCommand(args)];
}

/** One line of text with every control and format character removed and cut short. */
function excerpt(text: string, max = 200): string {
	const plain = text
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
		.replace(/[\p{Cc}\p{Cf}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

function describe(target: SshTarget): string {
	return target.port === undefined ? target.destination : `${target.destination} (port ${target.port})`;
}

/** The last stdout line that is a JSON object with `ompCloudNode: 1`; banners and other output before it are skipped. */
export function lastNodeRecord(stdout: string): Record<string, unknown> | undefined {
	const lines = stdout.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = (lines[index] ?? "").trim();
		if (!line.startsWith("{")) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (isRecord(value) && value.ompCloudNode === 1) return value;
	}
	return undefined;
}

/** Why an ask failed, in words and with the repair. */
interface AskFailure {
	detail: string;
	fix?: string;
}

type Asked = { ok: true; record: Record<string, unknown> } | ({ ok: false } & AskFailure);

/** The error of an ssh run that delivered no record, as `failure()` in `plugin/src/ssh.ts` words it. */
function sshFailure(result: CommandResult, target: SshTarget, seconds: number): AskFailure {
	const where = describe(target);
	const manual = ["ssh", ...portArgs(target), target.destination].join(" ");
	if (result.code === 124) return { detail: `ssh to ${where} timed out after ${seconds} s`, fix: `check that the host is reachable and runs sshd (${manual} shows what ssh says)` };
	if (result.code === 127) return { detail: `omp-cloud is not installed on ${where}`, fix: "install it there and run omp-cloud setup" };
	if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(result.stderr)) {
		return { detail: `the host key of ${where} changed since you last connected, so ssh refused it`, fix: "find out why before you retry, and only then remove the old key with ssh-keygen -R" };
	}
	if (/Host key verification failed/i.test(result.stderr)) return { detail: `ssh does not know the host key of ${where}`, fix: `run ${manual} once to accept its host key, then retry` };
	if (/Permission denied \(/i.test(result.stderr)) {
		const copy = ["ssh-copy-id", ...portArgs(target), target.destination].join(" ");
		return { detail: `ssh to ${where} was refused`, fix: `set up key-based ssh (${copy}); omp-cloud setup node never asks for a password` };
	}
	if (result.code !== 0 && result.code !== 1) {
		const said = excerpt(result.stderr);
		return { detail: `ssh to ${where} failed (exit ${result.code})${said === "" ? "" : `: ${said}`}`, fix: `run ${manual} to see what ssh says` };
	}
	return { detail: "the server's omp-cloud is older and cannot add machines: update it", fix: "update omp-cloud on the server (omp-cloud update apply), then run this again" };
}

/** Runs `omp-cloud <args>` on the server over ssh and returns its `ompCloudNode` record, or why there is none. */
async function askServer(ctx: SetupContext, target: SshTarget, args: readonly string[], timeoutMs: number): Promise<Asked> {
	const executable = ctx.env.OMP_CLOUD_SSH?.trim() || "ssh";
	let result: CommandResult;
	try {
		result = await ctx.run(sshArgv(executable, target, args), { timeoutMs });
	} catch (error) {
		return { ok: false, detail: `cannot run ${executable} (${excerpt(error instanceof Error ? error.message : String(error))})`, fix: "install an ssh client, or set OMP_CLOUD_SSH to its path" };
	}
	const record = lastNodeRecord(result.stdout);
	if (record === undefined) return { ok: false, ...sshFailure(result, target, timeoutMs / 1000) };
	if (record.error !== undefined) {
		const error = typeof record.error === "string" ? excerpt(record.error, 300) : "no reason given";
		return { ok: false, detail: `the server on ${target.destination} refused: ${error}` };
	}
	return { ok: true, record };
}

/** What the server's join record carries for this machine. The cluster secret is in memory only. */
export interface JoinInfo {
	address: string;
	remotePort: number;
	pin: string;
	serverVersion: string;
	vmonVersion: string;
	clusterSecret: string;
}

const PIN = /^sha256\/\/[A-Za-z0-9+/]{43}=$/;
const VMON_TAG = /^v\d+\.\d+\.\d+$/;
const SERVER_VERSION = /^[A-Za-z0-9.+_-]{1,64}$/;

/** The join info in a server's success record; the name of the first field that is wrong when it is not one. */
export function readJoinInfo(record: Record<string, unknown>): JoinInfo | string {
	const { server, vmon } = record;
	if (!isRecord(server)) return "server";
	if (typeof server.address !== "string" || !isUnicastHost(server.address)) return "server.address";
	if (typeof server.remotePort !== "number" || !Number.isInteger(server.remotePort) || server.remotePort < 1 || server.remotePort > 65535) return "server.remotePort";
	if (typeof server.pin !== "string" || !PIN.test(server.pin)) return "server.pin";
	if (typeof server.version !== "string" || !SERVER_VERSION.test(server.version)) return "server.version";
	if (!isRecord(vmon)) return "vmon";
	if (typeof vmon.version !== "string" || !VMON_TAG.test(vmon.version)) return "vmon.version";
	if (vmon.join !== `${server.address}:7946`) return "vmon.join";
	if (typeof vmon.clusterSecret !== "string" || !NODE_SECRET_PATTERN.test(vmon.clusterSecret)) return "vmon.clusterSecret";
	return {
		address: server.address,
		remotePort: server.remotePort,
		pin: server.pin,
		serverVersion: server.version,
		vmonVersion: vmon.version,
		clusterSecret: vmon.clusterSecret,
	};
}

/** How this machine reaches the server: its own address toward it, and the router in between when there is one. */
export interface RouteInfo {
	nodeAddress: string;
	via: string | null;
}

/** Reads `ip route get <address>`: `<address> [via <gw>] dev <dev> src <ip> …`; the reason when it cannot be read. */
export function readRoute(output: string, address: string): RouteInfo | string {
	const line = output.split("\n")[0] ?? "";
	if (/^local\s/.test(line)) return `${address} is an address of this machine: a node must be a different machine than the server`;
	const src = /\ssrc\s+(\d+\.\d+\.\d+\.\d+)(?:\s|$)/.exec(line)?.[1];
	if (src === undefined || isIP(src) !== 4) return `\`ip route get ${address}\` names no source address`;
	const via = /\svia\s+(\d+\.\d+\.\d+\.\d+)(?:\s|$)/.exec(line)?.[1] ?? null;
	return { nodeAddress: src, via };
}

export interface NodePlanInput {
	version: string;
	user: string;
	appDir: string;
	address: string;
	vmonVersion: string;
	packageManager: string | null;
	packages: readonly string[];
	route: boolean;
}

/** What the root part and this process will do, printed before anything changes. */
export function buildNodePlan(input: NodePlanInput): string[] {
	const lines = [`omp-cloud setup node ${input.version} will join this machine to the vibemon cluster of ${input.address}:`, "", "as root (asks for sudo once):"];
	if (input.packages.length > 0 && input.packageManager !== null) lines.push(`  - install packages with ${input.packageManager}: ${input.packages.join(" ")}`);
	lines.push(
		`  - install vibemon ${input.vmonVersion} and the vibemon helpers (the sync helper keeps it at the server's version)`,
		"  - write /etc/vmon/env (the cluster secret, root only) and /etc/omp-cloud/node.env (the server's address and certificate pin)",
		`  - add the system unit vmon (role node, joins ${input.address}:7946), which starts at boot`,
		`  - ${VMM_USER_PLAN}`,
		`  - add the system unit omp-cloud-node-net: VMs here reach only TCP 4000 and 4100 of ${SERVICE_IP}${input.route ? `, plus the route ${SERVICE_IP} via ${input.address}` : ""}`,
		"  - add the timer omp-cloud-vmon-sync.timer",
		"",
		`as ${input.user}:`,
		`  - install this binary into ${input.appDir} and link ~/.local/bin/omp-cloud (omp-cloud doctor and uninstall)`,
		"",
		"the network must allow:",
		"  - this machine must reach the server's TCP 4000, 4100 and 8443",
		"  - every vibemon machine must reach the others on TCP 7947 and on 7946 over TCP and UDP",
	);
	return lines;
}

/** The exit code and, under `--json`, the report. */
function finish(ctx: SetupContext, args: NodeArgs): number {
	const ok = !ctx.reporter.failed;
	if (args.json) ctx.stdout(`${JSON.stringify({ ok, steps: ctx.reporter.steps })}\n`);
	return ok ? 0 : 1;
}

function reportFailure(ctx: SetupContext, id: string, failure: AskFailure): void {
	ctx.reporter.report({ id, status: "failed", detail: failure.detail, ...(failure.fix === undefined ? {} : { fix: failure.fix }) });
}

/** The server's answer to `node-join-info --member`, as a step. */
async function checkMember(ctx: SetupContext, target: SshTarget, join: JoinInfo, nodeAddress: string): Promise<StepResult> {
	const fix = `allow TCP and UDP 7946 and TCP 7947 between this machine and ${join.address}, both ways`;
	const asked = await askServer(ctx, target, ["node-join-info", "--member", nodeAddress], MEMBER_TIMEOUT_MS);
	if (!asked.ok) return { id: "node.member", status: "failed", detail: asked.detail, fix };
	const { member } = asked.record;
	if (!isRecord(member) || typeof member.hostname !== "string" || typeof member.status !== "string" || typeof member.version !== "string") {
		return { id: "node.member", status: "failed", detail: `the server on ${target.destination} answered with a member record this machine cannot read`, fix };
	}
	return { id: "node.member", status: "ok", detail: `the server sees ${excerpt(member.hostname, 100)} (vibemon ${excerpt(member.version, 40)}, ${excerpt(member.status, 40)})` };
}

/** Whether a VM here reaches the server's gateway through the service IP, which is what every model call takes. */
async function checkGateway(ctx: SetupContext, join: JoinInfo, route: RouteInfo): Promise<StepResult> {
	let result: CommandResult | null = null;
	try {
		result = await ctx.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", GATEWAY_URL], { timeoutMs: GATEWAY_TIMEOUT_MS });
	} catch {
		// curl cannot start: the answer is "nothing", below.
	}
	const code = result?.stdout.trim() ?? "";
	if (code === "200") return { id: "node.gateway", status: "ok", detail: `this machine reaches the server's gateway at ${SERVICE_IP}:4000` };
	const allow = `on the server, allow TCP 4000 and 4100 to ${SERVICE_IP} from ${route.nodeAddress}`;
	return {
		id: "node.gateway",
		status: "failed",
		detail: `${GATEWAY_URL} ${code === "" || code === "000" ? "did not answer" : `answered ${excerpt(code, 20)}`}: VMs here cannot call models`,
		fix: route.via === null ? allow : `on the router ${route.via}, route ${SERVICE_IP}/32 to ${join.address}; ${allow}`,
	};
}

/** The root part's failure steps, with a fix that does not point at the secret file this run has already removed. */
function withoutSecretPath(steps: readonly StepResult[], secretFile: string, join: string): StepResult[] {
	return steps.map((step) => (step.fix?.includes(secretFile) ? { ...step, fix: `run omp-cloud setup node --join ${join} again in a terminal to see why` } : step));
}

function reportRootFailure(ctx: SetupContext, outcome: { report: { steps: StepResult[] } | null; steps: StepResult[] }, secretFile: string, join: string): void {
	if (outcome.report !== null) {
		ctx.reporter.collect(outcome.report.steps);
		if (outcome.report.steps.some((step) => step.status === "failed")) return;
	}
	ctx.reporter.reportAll(withoutSecretPath(outcome.steps, secretFile, join));
}

/** Runs `setup node`. Returns the exit code: 0 ok, 1 failed, 2 usage. */
export async function runNode(args: NodeArgs, ctx: SetupContext): Promise<number> {
	const { reporter, paths } = ctx;
	const target = parseJoinTarget(args.join);
	if (typeof target === "string") {
		reporter.warn(`omp-cloud: ${target}\n${NODE_USAGE}`);
		return 2;
	}
	if (ctx.uid === 0) {
		reporter.report({ id: "node.user", status: "failed", detail: "run omp-cloud setup node as your user; it asks for sudo once" });
		return finish(ctx, args);
	}
	if (!ctx.self.compiled) {
		reporter.report({ id: "node.binary", status: "failed", detail: "run the release binary (install.sh) on a node" });
		return finish(ctx, args);
	}

	const serverPresent = await stat(paths.serviceJson).then(
		() => true,
		() => false,
	);
	if (serverPresent) {
		reporter.report({
			id: "node.server",
			status: "failed",
			detail: "this machine runs an omp-cloud server; a machine is either a server or a node",
			fix: `omp-cloud uninstall --purge, then omp-cloud setup node --join ${args.join}`,
		});
		return finish(ctx, args);
	}

	const pre = await preflight(ctx.preflight, "node");
	reporter.reportAll(pre.steps);
	if (pre.blocked) return finish(ctx, args);

	const asked = await askServer(ctx, target, ["node-join-info"], JOIN_TIMEOUT_MS);
	if (!asked.ok) {
		reportFailure(ctx, "node.join-info", asked);
		return finish(ctx, args);
	}
	const join = readJoinInfo(asked.record);
	if (typeof join === "string") {
		reportFailure(ctx, "node.join-info", { detail: `the server on ${target.destination} sent a join record this machine cannot use (${join} is wrong)`, fix: "update omp-cloud on the server, then run this again" });
		return finish(ctx, args);
	}
	reporter.report({
		id: "node.join-info",
		status: "ok",
		detail: `the server on ${target.destination} is ${join.address} (omp-cloud ${join.serverVersion}, vibemon ${join.vmonVersion}, remote port ${join.remotePort})`,
	});

	let routeText: CommandResult | null = null;
	try {
		routeText = await ctx.run([ctx.preflight.which("ip") ?? "ip", "route", "get", join.address], { timeoutMs: PROBE_TIMEOUT_MS });
	} catch {
		// ip cannot start: reported below.
	}
	const route = routeText === null || routeText.code !== 0 ? `cannot ask this machine how it reaches ${join.address} (\`ip route get ${join.address}\` failed)` : readRoute(routeText.stdout, join.address);
	if (typeof route === "string") {
		reporter.report({ id: "node.route", status: "failed", detail: route, fix: `check that ip route get ${join.address} works on this machine, and that ${join.address} is another machine` });
		return finish(ctx, args);
	}
	const sameLan = route.via === null;
	reporter.report({
		id: "node.route",
		status: "ok",
		detail: sameLan
			? `this machine reaches ${join.address} directly: ${SERVICE_IP} is routed to it`
			: `this machine reaches ${join.address} through the router ${route.via}: that router must route ${SERVICE_IP}/32 to ${join.address} (add that static route there; omp-cloud never changes your router)`,
	});

	const packages = pre.packageManager !== null && pre.missingTools.length > 0 ? packagesFor(pre.packageManager, pre.missingTools) : [];
	reporter.note(
		buildNodePlan({ version: ctx.version, user: paths.user, appDir: paths.appDir, address: join.address, vmonVersion: join.vmonVersion, packageManager: pre.packageManager, packages, route: sameLan }).join("\n"),
	);
	if (!args.yes) {
		if (!ctx.stdinIsTty) {
			reporter.warn("omp-cloud: no terminal to ask on; run omp-cloud setup node in a terminal, or pass --yes");
			return 2;
		}
		if (!(await ctx.confirm("Continue? [Y/n]"))) {
			reporter.warn("nothing was changed");
			return 1;
		}
	}
	if (!(await sudoReady(ctx.run)) && !ctx.stdinIsTty) {
		reporter.report({
			id: "node.sudo",
			status: "failed",
			detail: "setup needs sudo once and cannot ask for a password without a terminal; nothing was changed",
			fix: `run omp-cloud setup node --join ${args.join} in a terminal`,
		});
		return finish(ctx, args);
	}

	let secretDir: string | null = null;
	try {
		let secretFile: string;
		try {
			secretDir = await mkdtemp(joinPath(tmpdir(), "omp-cloud-node-"));
			secretFile = joinPath(secretDir, "secret");
			await writeFile(secretFile, join.clusterSecret, { mode: 0o600 });
		} catch (error) {
			reporter.report({
				id: "node.secret",
				status: "failed",
				detail: `cannot write the cluster secret for the root part: ${excerpt(error instanceof Error ? error.message : String(error))}`,
				fix: "make the temp directory writable, then run this again",
			});
			return finish(ctx, args);
		}
		const root = await runRootPart(ctx.run, ctx.self, [
			"--node",
			"--user",
			paths.user,
			"--vmon",
			join.vmonVersion,
			"--server",
			join.address,
			"--remote-port",
			String(join.remotePort),
			"--pin",
			join.pin,
			"--secret-file",
			secretFile,
			...(sameLan ? ["--route"] : []),
			...(packages.length === 0 ? [] : ["--packages", packages.join(",")]),
		]);
		if (!root.ok) {
			reportRootFailure(ctx, root, secretFile, args.join);
			return finish(ctx, args);
		}
		reporter.collect(root.report.steps);
	} finally {
		if (secretDir !== null) await rm(secretDir, { recursive: true, force: true });
	}

	const installed = await installManagedBinary(paths, ctx.self.argv[0] ?? "", ctx.run);
	reporter.reportAll(installed.steps);
	if (reporter.failed) return finish(ctx, args);

	reporter.report(await checkMember(ctx, target, join, route.nodeAddress));
	reporter.report(await checkGateway(ctx, join, route));
	if (!reporter.failed) reporter.note(`this machine is a vibemon node of ${join.address}: omp-cloud doctor checks it, omp-cloud uninstall removes it`);
	return finish(ctx, args);
}

/** `omp-cloud setup node …`; `argv` follows the words `setup node`. */
export async function nodeMain(argv: readonly string[], context?: SetupContext): Promise<number> {
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
		process.stdout.write(`${NODE_USAGE}\n`);
		return 0;
	}
	const parsed = parseNodeArgs(argv);
	if (!parsed.ok) {
		process.stderr.write(`omp-cloud: ${parsed.error}\n${NODE_USAGE}\n`);
		return 2;
	}
	return runNode(parsed.args, context ?? realContext(Reporter.forProcess(parsed.args.json)));
}
