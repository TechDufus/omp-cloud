/** `/cloud` argument parsing, thread-id resolution and completion. Pure: no I/O. */

import { cloudJobId } from "./cloud-job";

export const VERBS = [
	"new",
	"list",
	"show",
	"watch",
	"unwatch",
	"send",
	"answer",
	"stop",
	"pull",
	"preview",
	"resume",
	"delete",
	"login",
	"status",
	"update",
	"dashboard",
	"connect",
	"pair",
	"devices",
	"disconnect",
	"help",
] as const;
export type Verb = (typeof VERBS)[number];

/** Verbs whose first argument names a thread. */
export const ID_VERBS: readonly Verb[] = ["show", "watch", "send", "answer", "stop", "pull", "resume", "delete"];
export type IdVerb = "show" | "watch" | "send" | "answer" | "stop" | "pull" | "resume" | "delete";

export const USAGE_LAUNCH = "☁ usage: /cloud <task for the cloud agent>";
export const USAGE_SEND = "☁ usage: /cloud send <id> <message>";
export const USAGE_LOGIN = "☁ usage: /cloud login <provider>";
export const USAGE_CONNECT = "☁ usage: /cloud connect [<code> | <user@host> | <host> | ssh://[user@]host[:port]] [--name <name>] [--replace] [--allow-public]";
export const USAGE_PULL = "☁ usage: /cloud pull <id> [--into <dir>]";
export const USAGE_DEVICES = "☁ usage: /cloud devices [revoke <name|id-prefix>]";
export const USAGE_DISCONNECT = "☁ usage: /cloud disconnect [--force]";
export const USAGE_PREVIEW = "☁ usage: /cloud preview <id> <port> | /cloud preview stop";

/** What the user typed, before thread ids are resolved. */
export type Parsed =
	| { kind: "launch"; task: string }
	| { kind: "login"; provider: string }
	| { kind: "preview"; token: string; port: number }
	| { kind: "hub" | "list" | "unwatch" | "status" | "update" | "dashboard" | "pair" | "previewStop" | "help" }
	| { kind: "connect"; target: string | undefined; name: string | undefined; replace: boolean; allowPublic: boolean }
	| { kind: "devices"; revoke: string | undefined }
	| { kind: "disconnect"; force: boolean }
	| { kind: IdVerb; token: string; text: string; /** `pull --into`. */ into?: string }
	| { kind: "error"; message: string };

/** A fully resolved command. */
export type Command =
	| { kind: "launch"; task: string }
	| { kind: "login"; provider: string }
	| { kind: "preview"; thread: string; port: number }
	| { kind: "hub" | "list" | "unwatch" | "status" | "update" | "dashboard" | "pair" | "previewStop" | "help" }
	| { kind: "connect"; target: string | undefined; name: string | undefined; replace: boolean; allowPublic: boolean }
	| { kind: "devices"; revoke: string | undefined }
	| { kind: "disconnect"; force: boolean }
	| { kind: Exclude<IdVerb, "send" | "answer" | "pull">; thread: string }
	| { kind: "pull"; thread: string; into: string | undefined }
	| { kind: "answer"; thread: string; text: string }
	| { kind: "send"; thread: string; text: string }
	| { kind: "error"; message: string };

function isVerb(s: string): s is Verb {
	return (VERBS as readonly string[]).includes(s);
}

function isIdVerb(s: Verb): s is IdVerb {
	return (ID_VERBS as readonly string[]).includes(s);
}

function splitFirst(s: string): [string, string] {
	const m = /^(\S+)\s*([\s\S]*)$/.exec(s);
	return m ? [m[1] ?? "", m[2] ?? ""] : ["", ""];
}

/** The words of `s`, a quoted run (`"…"`, `'…'`, backticks) being one word without its quotes; undefined when a quote is left open. */
function words(s: string): string[] | undefined {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g;
	let last = 0;
	for (const m of s.matchAll(re)) {
		if (s.slice(last, m.index).trim() !== "") return undefined;
		last = m.index + m[0].length;
		if (m[4] !== undefined && /^["'`]/.test(m[4])) return undefined;
		out.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "");
	}
	return s.slice(last).trim() === "" ? out : undefined;
}

/**
 * `/cloud connect [<code> | <ssh target>] [--name <name>] [--replace] [--allow-public]`. Telling a code from a target,
 * and a good target from a bad one, is `parseConnectTarget`'s job; a word starting with a single `-` is refused here
 * already, since ssh would read it as an option.
 */
function parseConnect(rest: string): Parsed {
	const ws = words(rest);
	if (ws === undefined) return { kind: "error", message: USAGE_CONNECT };
	let target: string | undefined;
	let name: string | undefined;
	let replace = false;
	let allowPublic = false;
	for (let i = 0; i < ws.length; i++) {
		const w = ws[i] ?? "";
		if (w === "--replace") replace = true;
		else if (w === "--allow-public") allowPublic = true;
		else if (w === "--name") {
			name = ws[++i];
			if (name === undefined || name.startsWith("--")) return { kind: "error", message: USAGE_CONNECT };
		} else if (w.startsWith("--") || target !== undefined) return { kind: "error", message: USAGE_CONNECT };
		else if (w.startsWith("-")) return { kind: "error", message: "☁ an ssh target cannot start with '-' (ssh would read it as an option)" };
		else target = w;
	}
	return { kind: "connect", target, name, replace, allowPublic };
}

/** The VM's own agent port: the service refuses it, so it is refused here as well. */
export const AGENT_PORT = 49983;

/** `/cloud preview <id> <port>` or `/cloud preview stop`. */
function parsePreview(rest: string): Parsed {
	const ws = words(rest);
	if (ws === undefined) return { kind: "error", message: USAGE_PREVIEW };
	if (ws.length === 1 && ws[0]?.toLowerCase() === "stop") return { kind: "previewStop" };
	const [token = "", raw = ""] = ws;
	if (ws.length !== 2 || token === "" || !/^\d{1,5}$/.test(raw)) return { kind: "error", message: USAGE_PREVIEW };
	const port = Number(raw);
	if (port < 1 || port > 65535 || port === AGENT_PORT) return { kind: "error", message: `☁ port must be 1 to 65535 and not ${AGENT_PORT}` };
	return { kind: "preview", token, port };
}

/** `/cloud devices` or `/cloud devices revoke <name|id-prefix>`; the name may hold spaces. */
function parseDevices(rest: string): Parsed {
	if (rest === "") return { kind: "devices", revoke: undefined };
	const [sub, target] = splitFirst(rest);
	const unquoted = /^(["'`])(.*)\1$/.exec(target.trim())?.[2] ?? target.trim();
	return sub.toLowerCase() === "revoke" && unquoted !== "" ? { kind: "devices", revoke: unquoted } : { kind: "error", message: USAGE_DEVICES };
}

/**
 * The first token, lowercased, is a verb or the task starts here. Empty args open the hub;
 * `new` launches the rest even when it begins with a verb word.
 */
export function parseCommand(args: string): Parsed {
	const trimmed = args.trim();
	if (trimmed === "") return { kind: "hub" };
	const [first, rest] = splitFirst(trimmed);
	const verb = first.toLowerCase();
	if (!isVerb(verb)) return { kind: "launch", task: trimmed };
	if (verb === "new") return rest === "" ? { kind: "error", message: USAGE_LAUNCH } : { kind: "launch", task: rest };
	if (verb === "login") {
		const [provider, extra] = splitFirst(rest);
		return provider === "" || extra !== "" ? { kind: "error", message: USAGE_LOGIN } : { kind: "login", provider };
	}
	if (verb === "preview") return parsePreview(rest);
	if (verb === "connect") return parseConnect(rest);
	if (verb === "devices") return parseDevices(rest);
	if (verb === "disconnect") {
		const flags = words(rest);
		return flags !== undefined && flags.every(w => w === "--force") && flags.length <= 1 ? { kind: "disconnect", force: flags.length === 1 } : { kind: "error", message: USAGE_DISCONNECT };
	}
	if (!isIdVerb(verb)) return { kind: verb };
	const [token, text] = splitFirst(rest);
	if (verb === "send") {
		if (token === "" || text === "") return { kind: "error", message: USAGE_SEND };
	} else if (token === "") {
		return { kind: "error", message: `☁ usage: /cloud ${verb} <id>` };
	}
	if (verb === "pull") return parsePull(token, text);
	return { kind: verb, token, text };
}

/** `/cloud pull <id> [--into <dir>]`: a scratch thread is cloned into the directory, a repository thread gets a worktree there. */
function parsePull(token: string, rest: string): Parsed {
	const ws = words(rest);
	if (ws === undefined || (ws.length !== 0 && (ws.length !== 2 || ws[0] !== "--into" || (ws[1] ?? "").startsWith("--")))) return { kind: "error", message: USAGE_PULL };
	return { kind: "pull", token, text: "", into: ws[1] };
}

/** What command resolution and completion know of a thread. */
export interface ThreadRef {
	id: string;
	/** `""` when the thread has none. */
	name: string;
	/** The task title; the job id of an unnamed thread is made of it. */
	title?: string;
	/** The id omp lists the thread's running turn under, when this session follows it as a job. */
	job?: string;
}

export type ThreadMatch = { id: string } | { error: "none" | "ambiguous"; candidates: ThreadRef[] };

/** Whether a word of `name` starts with `typed` (lowercase). */
function nameWordStartsWith(name: string, typed: string): boolean {
	return name.toLowerCase().split(/\s+/).some(w => w.startsWith(typed));
}

/** A thread by full id, the id of its running job (as omp lists it, `-<n>` suffix included), its job id without a suffix (`cloudJobId`), unique suffix of at least 4 characters (`shortName` is 6), unique id prefix, or a word prefix of its name that no other thread's name shares. */
export function resolveThread(token: string, threads: readonly ThreadRef[]): ThreadMatch {
	const t = token.toLowerCase();
	const exact = threads.find(n => n.id.toLowerCase() === t);
	if (exact) return { id: exact.id };
	// A running job's id names exactly the thread it runs; a settled job's `-<n>` id names nothing (omp's suffix says nothing about which thread).
	const running = threads.find(n => n.job?.toLowerCase() === t);
	if (running) return { id: running.id };
	const job = threads.filter(n => cloudJobId(n).toLowerCase() === t);
	if (job.length === 1 && job[0]) return { id: job[0].id };
	if (job.length > 1) return { error: "ambiguous", candidates: job };
	const tiers = [
		threads.filter(n => t.length >= 4 && n.id.toLowerCase().endsWith(t)),
		threads.filter(n => n.id.toLowerCase().startsWith(t)),
		threads.filter(n => nameWordStartsWith(n.name, t)),
	];
	for (const hits of tiers) {
		if (hits.length === 1 && hits[0]) return { id: hits[0].id };
		if (hits.length > 1) return { error: "ambiguous", candidates: hits };
	}
	return { error: "none", candidates: [] };
}

/** The ambiguous candidates as the user reads them: `id (name)`, or the bare id for a thread without a name. */
export function candidateList(candidates: readonly ThreadRef[]): string {
	return candidates.map(c => (c.name === "" ? c.id : `${c.id} (${c.name})`)).join(", ");
}

/** The last 6 characters of a thread id, which `/cloud <verb> <short>` accepts. */
export function shortName(id: string): string {
	return id.slice(-6);
}

export function hintForUnmatched(token: string, verb: string): string {
	return `☁ no thread matches "${token}"; to start a cloud task beginning with "${verb}", use /cloud new <task>`;
}


export interface Completion {
	value: string;
	label: string;
	description?: string;
}

const VERB_HELP: Record<Verb, string> = {
	new: "hand off a task (even one that begins with a verb word)",
	list: "list cloud threads",
	show: "show a thread's latest reply",
	watch: "watch a thread live",
	unwatch: "stop following threads live",
	send: "send a follow-up message to a thread",
	answer: "answer the question a thread is waiting on",
	stop: "stop the running turn and cancel queued ones",
	pull: "fetch the thread's result branch; --into <dir> clones a scratch thread there, or checks a repository thread out as a worktree",
	resume: "continue the thread's conversation locally",
	preview: "open a dev server a thread runs in its VM (by port) through a local forwarder; `preview stop` ends every preview",
	delete: "delete a thread",
	login: "log the cloud broker in to a provider (second login, never a copy of yours)",
	status: "show the connection and what the cloud can run",
	update: "check the cloud service for a newer omp-cloud; when one is ready, restart the service to update (the owner confirms)",
	dashboard: "open the dashboard (prints a one-time sign-in link)",
	connect: "pair this machine with a cloud service: a pairing code (from /cloud pair on the server machine), or an ssh target (user@host) where omp-cloud is installed",
	pair: "let another machine connect: shows a code (sent to your clipboard), you approve the device (server machine only)",
	devices: "list paired devices; `devices revoke <name>` removes one",
	disconnect: "forget this machine's pairing and revoke its device",
	help: "show usage",
};

/** The words that complete after a verb's name. */
const ARGUMENT_COMPLETIONS: Partial<Record<Verb, readonly string[]>> = {
	connect: ["--name", "--replace", "--allow-public"],
	devices: ["revoke"],
	disconnect: ["--force"],
};

export function verbHelp(verb: Verb): string {
	return VERB_HELP[verb];
}

/**
 * Synchronous completion: verbs while the first word is being typed, then
 * threads from the cache after an id verb (matched by id or by a word of the name; the name is the
 * description). `value` replaces the whole argument text, so it carries the verb.
 */
export function completions(prefix: string, cachedThreads: readonly ThreadRef[]): Completion[] | null {
	const p = prefix.replace(/^\s+/, "");
	if (!/\s/.test(p)) {
		const lower = p.toLowerCase();
		const items = VERBS.filter(v => v.startsWith(lower)).map(v => ({ value: v, label: v, description: VERB_HELP[v] }));
		return items.length > 0 ? items : null;
	}
	const [first, rest] = splitFirst(p);
	const verb = first.toLowerCase();
	const flags = isVerb(verb) ? ARGUMENT_COMPLETIONS[verb] : undefined;
	if (flags) {
		const start = p.search(/\S*$/);
		const typedFlag = p.slice(start).toLowerCase();
		const given = p.slice(0, start).trim().split(/\s+/);
		const items = flags
			.filter(f => f.startsWith(typedFlag) && !given.includes(f) && (verb !== "devices" || given.length === 1))
			.map(f => ({ value: `${p.slice(0, start)}${f}`, label: f }));
		return items.length > 0 ? items : null;
	}
	if (!isVerb(verb) || (verb !== "preview" && !isIdVerb(verb))) return null;
	if (verb === "pull" && /\s/.test(rest)) {
		const start = p.search(/\S*$/);
		const afterId = /^\S+\s+\S*$/.test(rest) && "--into".startsWith(p.slice(start).toLowerCase());
		return afterId ? [{ value: `${p.slice(0, start)}--into`, label: "--into", description: "directory for a scratch clone or a worktree" }] : null;
	}
	// Past the id the rest is free text.
	if (/\s/.test(rest)) return null;
	const typed = rest.toLowerCase();
	const items = cachedThreads
		.filter(n => n.id.toLowerCase().startsWith(typed) || n.id.toLowerCase().endsWith(typed) || nameWordStartsWith(n.name, typed))
		.map(n => ({ value: `${verb} ${n.id}`, label: n.id, ...(n.name === "" ? {} : { description: n.name }) }));
	return items.length > 0 ? items : null;
}
