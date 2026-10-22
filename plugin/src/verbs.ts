import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { cfgAskNotify, cfgCompletionNotify, cfgErrorNotify, cfgTerminalProgramStatus } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { isTerminalHeadless } from "@oh-my-pi/pi-utils";
import { answerSummary, answerThread, AutoAsker, askUser, parseAnswerText, pendingQuestions, usesNativeDialog } from "./answer";
import { CloudClient, quickTuning, type ClientTuning } from "./api";
import { CloudError, cloudErrorText } from "./errors";
import { resolveParsed, resolveRef } from "./resolve";
import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { DETAILS_REPLY_MAX, inventoryCard, loginCard, noticeCard, patternProviders, QUESTIONS, threadBranch, updateCard, type CardAct, type CardActions, type NoticeCard, type TuiModule } from "./cards";
import { completions, parseCommand, shortName, USAGE_CONNECT, type Command, type Completion } from "./commands";
import { readConfig, resolveConnection, statusLines, type CloudConfig, type Connection, type DeliverMode, type Env } from "./config";
import { runConnect } from "./connect";
import { readConnectionFile, type PairedConnection } from "./connection";
import { runDashboard, showForwardedDashboard } from "./dashboard";
import { CloudAgents } from "./cloud-agents";
import { CloudJobs } from "./cloud-jobs";
import { Deliverer, launchCard, threadsFromEntries } from "./deliver";
import { devicesCard, runDisconnect, runRevoke } from "./devices";
import { clip, metricsLine, plural, threadHeading, threadTag, truncateText } from "./format";
import { DashboardForwarder } from "./forwarder";
import { HubComponent, type HubResult } from "./hub";
import { Inbox } from "./inbox";
import { ProgramStatus, type TerminalSink } from "./program-status";
import { launchBatch, type LaunchedThread } from "./launch";
import { loginHint, loginLines, runLogin, serverHostOf } from "./login";
import { PairComponent, type PairOutcome } from "./pair";
import { refusePairingCode } from "./pairing";
import { applyPull, isClean, notInRepository, pullBundle, type Applied } from "./pull";
import { repoKey } from "./repo-key";
import { syncConversation, type SyncOutcome } from "./session-sync";
import { git, gitRaw, resolveRemote } from "./snapshot";
import { pinnedFetch } from "./transport";
import { UserError, type AnswerBody, type CommandHost, type Host, type IrcReceiptKind, type Login, type PairingOffer, type PiHost, type Question, type ResultHeaders, type ThreadDetail, type ThreadOrigin, type ThreadSummary, type UpdateStatus, type Whoami } from "./types";
import type { DelegateRequest, DelegateResult, DelegateRun, PullRequest, ToolCloud, ToolSession } from "./tool";
import { helpLines, resultLine, WIDGET_KEY, Watcher, type WatchSink } from "./watch";
import type { WaitOptions, WaitResult } from "./wait";
import { Updates, updateLine, updateVersionsFromEntries } from "./update";
import { PLUGIN_VERSION } from "./version";

/** Idle threads of a session that become cloud agents when the session starts: the newest of the ones its cards name. */
const FOLLOWED_IDLE_MAX = 16;

const PAIR_NEEDS_UI = "☁ /cloud pair needs omp's interactive UI";

interface Session {
	cfg: CloudConfig;
	conn: Connection;
	client: CloudClient;
	root: string | undefined;
	/** Identifies the connection: the URL, the token (hashed) and the pinned certificate. Anything that holds a client must be rebuilt when it changes. */
	key: string;
}

/** A client of `conn`: pinned to its certificate when it is a paired connection. */
function clientFor(conn: Connection, tuning: ClientTuning): CloudClient {
	return new CloudClient(conn.url, conn.token, conn.paired ? pinnedFetch(conn.paired.server) : undefined, tuning);
}

function connectionKey(conn: Connection): string {
	return [conn.url, createHash("sha256").update(conn.token).digest("hex"), conn.paired?.server.fingerprint ?? ""].join("\n");
}

function errorText(e: unknown): string {
	if (e instanceof CloudError) return cloudErrorText(e);
	return e instanceof Error ? e.message : String(e);
}

/** `/cloud show`: the name (else the title) and the id in the heading, then the title when a name replaced it, what the thread has used, its error, question and result as rows, the latest finished turn's reply as markdown. */
function showCard(t: ThreadDetail): NoticeCard {
	const latest = [...t.turns].reverse().find(x => x.state === "done" || x.state === "failed");
	const lines = t.name ? [t.title] : [];
	const used = metricsLine(t.metrics);
	if (used !== "") lines.push(used);
	if (t.error) lines.push(`error: ${clip(t.error, 200)}`);
	if (t.question) lines.push(`? ${clip(t.question.text, 160)}${t.question.remaining > 1 ? ` (+${t.question.remaining - 1} more)` : ""}`);
	lines.push(resultLine(t.result));
	const body = latest ? truncateText(latest.state === "failed" ? latest.error : latest.reply, DETAILS_REPLY_MAX) : "";
	const state = t.archivedAt ? "archived" : t.phase;
	return noticeCard(t.id, `${threadHeading(t)} · ${t.id} · ${state} · ${plural(t.turns.length, "turn")} · ${t.model || "fallback model"}`, lines, body);
}

/** What a message to an archived thread does first. */
function restoringText(tag: string): string {
	return `☁ ${tag} is archived: its VM restores from the archive first (about a minute)`;
}

/** `/cloud pull`: did it work, what came with it, how to take it. */
function pullCard(thread: string, p: PullResult): NoticeCard {
	const where = p.checkedOutMoved ? "checked-out branch moved" : p.movedIn !== undefined ? `fast-forwarded in ${p.movedIn}` : p.mode === "worktree" ? `worktree ${p.path}` : p.mode === "clone" ? `cloned to ${p.path}` : "working tree untouched";
	const stats = [p.commits === undefined ? "" : plural(p.commits, "commit"), `+${p.insertions} −${p.deletions}`, plural(p.filesChanged, "file"), where];
	const lines = [stats.filter(Boolean).join(" · "), ...p.subjects.map(s => `  ${s}`)];
	const more = (p.commits ?? 0) - p.subjects.length;
	if (more > 0) lines.push(`  and ${more} more`);
	if (p.session.kind === "saved") lines.push(`session saved · /cloud resume ${shortName(thread)} continues it`);
	else if (p.session.kind === "failed") lines.push(`session not saved: ${clip(p.session.reason, 200)}`);
	lines.push(`next: ${p.next}`);
	return noticeCard(thread, `Pulled ${p.branch} @ ${p.head.slice(0, 8)}`, lines);
}

/** What a handoff started. */
export interface Delegated {
	id: string;
	/** The generated name; `""` when none. */
	name: string;
	title: string;
	/** The host job the first turn is, when it is one. */
	job: string | undefined;
	warnings: string[];
}

/** How this session follows a thread. */
export interface FollowState {
	followed: boolean;
	/** Whose results the session shows or wakes the model with; `""` when the thread is not followed. */
	origin: ThreadOrigin | "";
	/** The host job the thread's running turn is, when it is one. */
	jobId?: string;
	/** Contact with the cloud about the thread is lost. */
	stale: boolean;
}

/** What a pull did about the thread's conversation. */
export type SessionOutcome = { kind: "none" } | ({ kind: "saved" } & SyncOutcome) | { kind: "failed"; reason: string };

export interface PullResult extends Applied {
	filesChanged: number;
	insertions: number;
	deletions: number;
	session: SessionOutcome;
}

/** The thread's own workspace when it exists here, else `fallback`: where a saved conversation's session bucket follows. */
async function syncCwd(workspace: string, fallback: string): Promise<string> {
	const isDir = workspace !== "" && (await stat(workspace).then(st => st.isDirectory(), () => false));
	return isDir ? workspace : fallback;
}

/** Runs `/cloud` commands and the `cloud` tool's operations. One instance per loaded extension. */
export class Cloud implements CardActions, ToolCloud {
	readonly #pi: PiHost;
	readonly #ownRoot: string;
	readonly #env: Env;
	readonly #home: string;
	readonly #deliver: Deliverer;
	/** The registry refs of the followed threads: omp's `agent://`, `history://` and IRC reach the cloud through them. */
	readonly #agents: CloudAgents;
	#tui: TuiModule | undefined;
	#threads: ThreadSummary[] = [];
	#watcher: Watcher | undefined;
	#watcherKey = "";
	/** Threads `follow` is starting to follow: followed already, though the watcher does not know them yet. */
	readonly #starting = new Set<string>();
	/** What the user's own threads reported while they worked elsewhere. */
	readonly #inbox = new Inbox();
	/** `deliver` of the newest configuration read. */
	#deliverMode: DeliverMode = "tray";
	/** The watcher's jobs: where a running turn is registered in omp, and which job ids name which thread. */
	#jobs: CloudJobs | undefined;
	/** The newest context of a command or an event: what a card's button acts through. */
	#ctx: Host | undefined;
	/** The newest command context: only a command may switch the session (`resume`). */
	#commandCtx: CommandHost | undefined;
	#forwarder: DashboardForwarder | undefined;
	#forwarderKey = "";
	readonly #chains = new Map<string, Promise<unknown>>();
	/** Threads with a watched-turn save queued but not started, and the newest host that asked. */
	readonly #waiting = new Map<string, Host>();
	/** The inbox as OSC 7501 records. */
	readonly #programStatus: ProgramStatus;
	/** What the service says of its updates: the footer's `update ready`, the card and the plugin-older notice. */
	readonly #updates: Updates;
	/** Opens omp's own dialogs by itself when a followed thread asks. */
	readonly #autoAsk: AutoAsker;

	readonly #open: (urlOrPath: string) => void;
	/** The retry schedule of every client this instance builds. */
	readonly #tuning: ClientTuning;

	/**
	 * `open` launches the user's browser; `terminal` is where notifications and OSC 7501 records go (the host's terminal, once pi-tui
	 * is loaded, by default); `tuning` is the clients' retry schedule (production keeps the default; a test shortens it).
	 */
	constructor(
		pi: PiHost,
		ownRoot: string,
		env: Env = process.env,
		home: string = homedir(),
		open: (urlOrPath: string) => void = openPath,
		terminal?: TerminalSink,
		tuning: ClientTuning = {},
	) {
		this.#tuning = tuning;
		this.#pi = pi;
		this.#ownRoot = ownRoot;
		this.#env = env;
		this.#open = open;
		this.#home = home;
		const sink: TerminalSink = terminal ?? {
			notify: n => this.#tui?.TERMINAL.sendNotification(n),
			// OSC 7501 goes through pi-tui's writer, which never tears a frame, and only to a real terminal.
			write: sequence => {
				if (process.stdout.isTTY && !isTerminalHeadless()) this.#tui?.writeTerminalSequence(sequence);
			},
		};
		this.#programStatus = new ProgramStatus({
			inbox: this.#inbox,
			write: sink.write,
			enabled: () => cfgTerminalProgramStatus.get(this.#pi.pi.settings),
			onEnabledChange: listener => cfgTerminalProgramStatus.listen(this.#pi.pi.settings, listener),
		});
		this.#deliver = new Deliverer(pi, {
			inbox: this.#inbox,
			mode: () => this.#deliverMode,
			notify: sink.notify,
			allow: type => (type === "completion" ? cfgCompletionNotify : type === "error" ? cfgErrorNotify : cfgAskNotify).get(this.#pi.pi.settings) !== "off",
		});
		this.#agents = new CloudAgents({
			client: async () => {
				const ctx = this.#ctx;
				if (!ctx) throw new UserError("☁ there is no session to reach the cloud from");
				return (await this.#session(ctx, "full")).client;
			},
			follow: thread => {
				const ctx = this.#ctx;
				if (ctx) this.follow(thread, { origin: this.#deliver.originOf(ctx, thread) });
			},
			warn: message => this.#ctx?.ui.notify(message, "warning"),
			cwd: () => this.#ctx?.cwd ?? process.cwd(),
			entries: () => this.#ctx?.sessionManager.getEntries?.() ?? [],
			relayFailed: (detail, turn, reason) => {
				const ctx = this.#ctx;
				if (!ctx) return;
				ctx.ui.notify(`☁ ${threadTag(detail)}: could not hand turn ${turn.id}'s reply to the agent that asked for it (${reason}); it is posted as a card`, "warning");
				this.#deliver.turn(ctx, detail, turn, [], undefined, false);
			},
		});
		this.#inbox.onChange(() => {
			this.#watcher?.refreshStatus();
			this.#programStatus.sync();
		});
		this.#updates = new Updates({
			pluginVersion: PLUGIN_VERSION,
			notify: message => this.#ctx?.ui.notify(message, "warning"),
			card: version => void this.#postUpdateCard(version),
			shown: () => updateVersionsFromEntries(this.#ctx?.sessionManager.getEntries?.() ?? []),
			changed: () => this.#watcher?.refreshStatus(),
		});
		this.#autoAsk = new AutoAsker({
			answer: async (host, thread, turn, id, body) => (await this.#session(host, "quick")).client.answer(thread, turn, id, body),
			// A thread the model started has its `ask` questions answered by the model; the user's own (approvals, the push) are the user's.
			modelOwns: (host, thread) => this.#deliver.originOf(host, thread) === "tool",
			answered: async (host, thread, answered, left) => this.#reportAnswers(host, await this.#session(host, "quick"), thread, answered, left),
			tag: thread => this.#tag(thread),
		});
	}

	/** The session is ending: the terminal keeps no record this plugin wrote, and nothing listens any more. */
	shutdown(): void {
		this.#programStatus.dispose();
		this.#updates.stop();
		this.#autoAsk.close();
		this.#agents.dispose();
	}

	/** The host's pi-tui, once imported; the hub overlay and the live widget need it. */
	setTui(tui: TuiModule | undefined): void {
		this.#tui = tui;
	}

	/** Synchronous completion from the in-memory thread cache; never touches the network. */
	complete(prefix: string): Completion[] | null {
		return completions(prefix, this.#threads);
	}

	/** Re-points the live watcher at the host of a new session. */
	rebind(host: Host): void {
		this.#ctx = host;
		this.#watcher?.rebind(host);
	}

	/** Shows cards held back while the agent was busy, once it is idle. */
	flushCards(host: Host): void {
		this.#ctx = host;
		this.#deliver.flush(host);
	}

	/** Stops the dashboard forwarder of a paired connection, if one runs. */
	stopForwarder(): void {
		this.#forwarder?.stop();
	}

	async handle(args: string, ctx: CommandHost): Promise<void> {
		this.#ctx = ctx;
		this.#commandCtx = ctx;
		try {
			await this.#dispatch(args, ctx);
		} catch (e) {
			ctx.ui.notify(e instanceof UserError ? e.message : `☁ ${errorText(e)}`, "error");
		}
	}

	async #repoRoot(cwd: string): Promise<string | undefined> {
		const r = await gitRaw(cwd, ["rev-parse", "--show-toplevel"]);
		return r.code === 0 ? r.stdout.trim() : undefined;
	}

	async #config(ctx: Host): Promise<{ cfg: CloudConfig; root: string | undefined }> {
		const root = await this.#repoRoot(ctx.cwd);
		return { cfg: await readConfig({ env: this.#env, home: this.#home, repoRoot: root, platform: process.platform }), root };
	}

	/**
	 * The configuration, connection and a client of it. `quick` is for commands and UI a person waits on (one fast retry, so a
	 * dead service is reported at once); `full` is the model's tool operations and the following and waiting paths.
	 */
	async #session(ctx: Host, patience: "quick" | "full"): Promise<Session> {
		const { cfg, root } = await this.#config(ctx);
		this.#deliverMode = cfg.deliver;
		const conn = await resolveConnection(cfg);
		return { cfg, conn, client: clientFor(conn, patience === "quick" ? quickTuning(this.#tuning) : this.#tuning), root, key: connectionKey(conn) };
	}

	/** The live watcher, rebuilt when the URL, the token or the pinned certificate changed: it holds a client of the old connection. */
	#getWatcher(ctx: Host, s: Session): Watcher {
		if (!this.#watcher || this.#watcherKey !== s.key) {
			this.#watcher?.unwatch();
			const jobs = new CloudJobs({
				wakes: (thread, turn) => this.#ctx !== undefined && this.#deliver.originOf(this.#ctx, thread) === "tool" && turn.origin !== "irc",
				agentId: thread => this.#agents.agentId(thread),
				taken: id => this.#agents.holdsId(id),
				warn: message => this.#ctx?.ui.notify(message, "warning"),
				transitioning: () => this.#agents.ownerTransitioning(),
				events: () => this.#pi.events,
				stop: thread => {
					const host = this.#ctx ?? ctx;
					void this.#session(host, "full")
						.then(session => session.client.stop(thread))
						.catch((e: unknown) => host.ui.notify(`☁ cannot stop ${this.#tag(thread)}: ${errorText(e)}`, "error"));
				},
				aside: (thread, label) => {
					if (this.#ctx) this.#deliver.cancelled(this.#ctx, thread, label);
				},
			});
			this.#jobs = jobs;
			// The watcher follows threads for as long as they run: it keeps the full retry schedule whichever command built it.
			const steady = clientFor(s.conn, this.#tuning);
			this.#watcher = new Watcher(ctx, steady, this.#watchSink(steady), undefined, { tui: () => this.#tui, jobs, agents: this.#agents, unread: () => this.#inbox.unread, update: () => this.#updates.ready !== undefined });
			this.#watcherKey = s.key;
		} else {
			this.#watcher.rebind(ctx);
		}
		return this.#watcher;
	}

	/** The id of the host job `thread`'s running turn is, when this session follows it as one. */
	jobOf(thread: string): string | undefined {
		return this.#jobs?.jobId(thread);
	}

	/**
	 * Follows `thread` until it has nothing left to do, or upgrades how it is followed: `tool` wakes the model with its
	 * results and questions, `user` shows them to the person (the inbox). Upgrade only: a thread the model follows stays the
	 * model's whatever origin a later caller asks for, so a `user` request just follows it. Returns at once; the session
	 * resolves in the background and a failure is reported to the user.
	 */
	follow(thread: string, opts: { origin: ThreadOrigin }): void {
		const ctx = this.#ctx;
		const was = ctx ? this.#deliver.originOf(ctx, thread) : undefined;
		if (was !== "tool") {
			this.#deliver.setOrigin(thread, opts.origin);
			// A running job of the user's thread was set up to deliver nothing to the model: now one path must.
			if (opts.origin === "tool") this.#jobs?.adopt(thread);
		}
		if (!ctx || this.#watcher?.followed(thread) || this.#starting.has(thread)) return;
		this.#starting.add(thread);
		void this.#session(ctx, "full")
			.then(s => this.#getWatcher(ctx, s).watch(thread))
			.catch((e: unknown) => ctx.ui.notify(`☁ cannot follow ${this.#tag(thread)}: ${errorText(e)}`, "warning"))
			.finally(() => this.#starting.delete(thread));
	}

	/** How this session follows `thread`: whether it does, for whom, the job its running turn is, and whether contact with it is lost. */
	followState(thread: string): FollowState {
		const known = this.#watcher?.followed(thread);
		const followed = known !== undefined || this.#starting.has(thread);
		const jobId = this.#jobs?.jobId(thread);
		return {
			followed,
			origin: followed && this.#ctx ? this.#deliver.originOf(this.#ctx, thread) : "",
			...(jobId === undefined ? {} : { jobId }),
			stale: known?.stale === true,
		};
	}

	/** Resolves when threads settle as `opts` says (see `Waits.run`); event-driven for the threads this session follows, polled for the others. Rejects with an `aborted` CloudError when `opts.signal` fires. */
	async waitFor(threads: readonly string[], opts: WaitOptions): Promise<WaitResult[]> {
		const ctx = this.#ctx;
		if (!ctx) throw new UserError("☁ there is no session to wait in");
		return this.#getWatcher(ctx, await this.#session(ctx, "full")).waits.run(threads, opts);
	}

	/** The `cloud` tool's `send`: omp's IRC to the thread's agent (the agent is registered first when the session did not follow the thread yet). */
	sendIrc(detail: ThreadDetail, text: string): Promise<{ receipt: IrcReceiptKind; turn: number | null }> {
		this.#agents.observe(detail);
		QUESTIONS.settle(detail.id, detail.turns);
		return this.#agents.send(detail.id, text);
	}

	/** The `cloud` tool's `read`: `agent://<id>` through omp's own handler. */
	readAgent(thread: string): Promise<{ id: string; text: string; turn: number } | undefined> {
		return this.#agents.read(thread);
	}

	/** The host is about to switch sessions or branch: omp cancels the session's jobs on the way, and they register again; the terminal's records of this session go. */
	beforeSwitch(): void {
		this.#jobs?.beginTransition();
		this.#programStatus.clearAll();
	}

	/** The switch or branch is done: a cancel from here on is the user's, and what is still unread is reported to the terminal again. */
	afterSwitch(): void {
		this.#jobs?.endTransition();
		this.#programStatus.sync();
	}

	/**
	 * Follows the threads the session's cards name that still run, so a turn that was running when omp restarted or the session
	 * was resumed is a host job again. Quiet: a session without cards never touches the service, and one that cannot reach it
	 * has nothing to follow (its commands report the connection).
	 */
	async followSession(ctx: Host): Promise<void> {
		this.#ctx = ctx;
		const named = threadsFromEntries(ctx.sessionManager.getEntries?.() ?? []);
		// The cloud agents of another session's threads are not this session's peers.
		this.#agents.retainOnly(new Set([...named, ...(this.#watcher?.watching ?? [])]));
		if (named.size === 0) return;
		try {
			const s = await this.#session(ctx, "full");
			const threads = await this.#threadList(s);
			for (const t of threads) {
				if (!named.has(t.id) || (t.phase !== "starting" && t.phase !== "working" && t.phase !== "waiting" && t.queued === 0)) continue;
				if (this.#watcher?.watching.includes(t.id)) continue;
				await this.#getWatcher(ctx, s).watch(t.id);
			}
			// The threads with nothing running are agents too: the model can write to one to start its next turn.
			for (const t of threads.filter(x => named.has(x.id) && this.#agents.agentId(x.id) === undefined).slice(0, FOLLOWED_IDLE_MAX)) {
				const detail = await s.client.thread(t.id).catch(() => undefined);
				if (detail) {
					this.#agents.observe(detail);
					QUESTIONS.settle(detail.id, detail.turns);
				}
			}
		} catch {
			// Not configured, or the service is unreachable: nothing to follow.
		}
	}

	// -----------------------------------------------------------------------
	// Updates
	// -----------------------------------------------------------------------

	/** Takes in a `whoami`: the footer, the card and the plugin notice follow it. The footer is the watcher's, so the watcher exists first. */
	#observe(ctx: Host, s: Session, who: Whoami): void {
		this.#getWatcher(ctx, s);
		this.#updates.observe(who);
	}

	/** Asks the service about itself now and every quarter hour, so `update ready` appears without a command. Silent when it cannot be reached or is not configured: the commands report that. */
	probeUpdates(ctx: Host): void {
		this.#ctx = ctx;
		this.#updates.start(async () => {
			const at = this.#ctx;
			if (!at) return;
			try {
				const s = await this.#session(at, "quick");
				this.#observe(at, s, await s.client.whoami());
			} catch {
				// Not configured or unreachable: there is nothing to say about updates.
			}
		});
	}

	/** The owner's card for a ready version, with the release notes when the service gives them. */
	async #postUpdateCard(version: string): Promise<void> {
		const ctx = this.#ctx;
		if (!ctx) return;
		let notes = "";
		try {
			notes = (await (await this.#session(ctx, "quick")).client.updateStatus()).latest?.notes ?? "";
		} catch {
			// The card without notes.
		}
		this.#deliver.post(ctx, updateCard(version, notes));
	}

	/**
	 * `/cloud update`, the card's Restart to update button and the hub's `u`: a device is told what the service says; the owner
	 * gets the updater's state, a check when nothing is ready, and, when a version is ready, a confirm before the service installs
	 * it and restarts.
	 */
	async #updateCommand(ctx: Host, s: Session): Promise<void> {
		const who = await s.client.whoami();
		this.#observe(ctx, s, who);
		const line = updateLine(who.update, who.device === null);
		if (line === undefined) {
			ctx.ui.notify("☁ this omp-cloud service does not support updates: update it by hand", "info");
			return;
		}
		const service = `omp-cloud ${who.service.version || "service"}`;
		if (who.device) {
			ctx.ui.notify(`☁ ${service}: ${line}`, "info");
			return;
		}
		let status: UpdateStatus;
		try {
			status = await s.client.updateStatus();
		} catch (e) {
			if (!(e instanceof CloudError) || e.code !== "not_found") throw e;
			ctx.ui.notify("☁ this omp-cloud service does not support updates: update it by hand", "info");
			return;
		}
		switch (status.state) {
			case "ready":
				return this.#applyUpdate(ctx, s, status.staged ?? status.latest?.version ?? who.update?.available ?? "", who);
			case "unsupported":
				ctx.ui.notify(`☁ ${status.message ?? "this omp-cloud runs from a git checkout; update it with git pull and restart it"}`, "warning");
				return;
			case "applying":
				ctx.ui.notify(`☁ ${service} is installing ${status.applying?.version ?? "an update"}${status.applying ? ` (${status.applying.step})` : ""}: the service restarts`, "info");
				return;
			case "downloading":
				ctx.ui.notify(`☁ ${service}: downloading ${status.latest?.version ?? "a newer version"}; the footer says "update ready" when it can be installed`, "info");
				return;
			case "checking":
				ctx.ui.notify(`☁ ${service}: checking for a newer version; /cloud update shows what it finds`, "info");
				return;
			case "failed":
				ctx.ui.notify(`☁ ${service}: the last update failed${status.error ? `: ${status.error}` : ""}; checking again`, "warning");
				await s.client.checkUpdate();
				return;
			case "idle":
				await s.client.checkUpdate();
				ctx.ui.notify(`☁ ${service} is up to date${status.checkedAt ? ` (checked ${status.checkedAt})` : ""}; checking again now: /cloud update shows what it finds`, "info");
				return;
		}
	}

	/** Confirms, then asks the service to install the staged `version` and restart. A refusal (nothing ready any more, an apply running) is the service's own message. */
	async #applyUpdate(ctx: Host, s: Session, version: string, who: Whoami): Promise<void> {
		const busy = who.threads.starting + who.threads.working + who.threads.waiting;
		const running = busy > 0 ? ` ${plural(busy, "thread")} ${busy === 1 ? "is" : "are"} working right now.` : "";
		if (!(await ctx.ui.confirm("Update omp-cloud", `Install omp-cloud ${version || "the new version"} and restart the cloud service? It is unreachable for a moment while it restarts.${running}`))) return;
		const applying = (await s.client.applyUpdate()) || version;
		this.#updates.applying(applying);
		ctx.ui.notify(`☁ installing omp-cloud ${applying}: the service restarts in a moment`, "info");
	}

	async #dispatch(args: string, ctx: CommandHost): Promise<void> {
		const parsed = parseCommand(args);
		if (parsed.kind === "error") {
			ctx.ui.notify(parsed.message, "error");
			return;
		}
		if (parsed.kind === "help") {
			const [title = "", ...rows] = helpLines();
			this.#deliver.post(ctx, noticeCard("", title, rows));
			return;
		}
		if (parsed.kind === "unwatch") {
			if (this.#watcher) this.#watcher.unwatch();
			else {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.setStatus(WIDGET_KEY, undefined);
			}
			return;
		}
		if (parsed.kind === "launch") {
			// Handlers have a short budget and uploads exceed it; slash commands run
			// immediately even while the agent streams, so detach the launch.
			refusePairingCode(parsed.task);
			ctx.ui.notify("☁ Handing off to the cloud…", "info");
			const task = parsed.task;
			ctx.setTimeout(() => void this.#launchFromCommand(ctx, task), 0);
			return;
		}
		if (parsed.kind === "status") return this.#status(ctx);
		if (parsed.kind === "connect") return this.#connect(ctx, parsed);
		if (parsed.kind === "disconnect") return this.#disconnect(ctx, parsed.force);

		const s = await this.#session(ctx, "quick");
		if (parsed.kind === "update") return this.#updateCommand(ctx, s);
		if (parsed.kind === "login") {
			// A paired device is refused before any service call: every login route is owner-token only.
			const serverHost = serverHostOf(s.conn.paired);
			if (serverHost !== undefined) throw new UserError(`☁ a paired device cannot log the cloud in: ${loginHint(parsed.provider, serverHost)}`);
			// The TUI shows the sign-in link as a card, and a card waits for an idle agent: refuse before a login starts rather than prompt with no link on screen.
			if (ctx.mode === "tui" && !ctx.isIdle()) {
				throw new UserError("☁ the agent is working: run /cloud login again when it is idle, so the sign-in link can go in the transcript");
			}
			const show = ctx.mode === "tui" ? (l: Login) => this.#deliver.post(ctx, loginCard(l)) : (l: Login) => ctx.ui.notify(loginLines(l).join("\n"), "info");
			await runLogin(s.client, ctx.ui, parsed.provider, show);
			return;
		}
		if (parsed.kind === "dashboard") {
			const link = s.conn.paired ? showForwardedDashboard(this.#forwarderFor(s, s.conn.paired), ctx.ui) : await runDashboard(s.client, ctx.ui);
			// Only the interactive TUI opens a browser: never RPC or print mode. The link was printed either way.
			if (ctx.mode === "tui") this.#open(link.url);
			return;
		}
		if (parsed.kind === "pair") return this.#pair(ctx, s);
		if (parsed.kind === "devices") {
			if (parsed.revoke !== undefined) await runRevoke(s.client, ctx.ui, parsed.revoke);
			else this.#deliver.post(ctx, devicesCard(await s.client.devices(), Date.now()));
			return;
		}
		if (parsed.kind === "hub") return this.#hub(ctx, s);
		const [, cmd] = await Promise.all([this.#threadList(s), resolveParsed(parsed, s.client, { jobOf: id => this.#jobs?.jobId(id) })]);
		await this.#run(cmd, ctx, s);
	}

	async #threadList(s: Session): Promise<ThreadSummary[]> {
		this.#threads = await s.client.listThreads();
		return this.#threads;
	}

	/** A thread as notifications name it: its name (else title) and its id. */
	#tag(id: string): string {
		const known = this.#threads.find(t => t.id === id);
		return known ? threadTag(known) : id;
	}

	/** Queues a message; `restoring` when the thread was archived, so its VM comes back from the archive first. */
	async #queue(s: Session, thread: string, text: string): Promise<{ turn: number; restoring: boolean }> {
		refusePairingCode(text);
		const restoring = (await s.client.thread(thread)).archivedAt !== null;
		const sent = await s.client.sendMessage(thread, text);
		return { turn: sent.turn.id, restoring };
	}

	/** `/cloud send`: queues the message (saying so when the thread restores from the archive first) and follows the thread. */
	async #send(ctx: Host, s: Session, thread: string, text: string, label: string = this.#tag(thread)): Promise<void> {
		const sent = await this.#queue(s, thread, text);
		if (sent.restoring) ctx.ui.notify(restoringText(label), "info");
		ctx.ui.notify(`☁ queued turn ${sent.turn} on ${label}`, "info");
		await this.#getWatcher(ctx, s).watch(thread);
	}

	/** `/cloud stop`: aborts the running turn and cancels the queued ones. */
	async #stop(ctx: Host, s: Session, thread: string): Promise<void> {
		const r = await s.client.stop(thread);
		ctx.ui.notify(`☁ stopped ${this.#tag(thread)}: running ${r.stoppedRunning ? "yes" : "no"}, cancelled ${r.cancelled}`, "info");
	}

	async #run(cmd: Command, ctx: CommandHost, s: Session): Promise<void> {
		switch (cmd.kind) {
			case "error":
				ctx.ui.notify(cmd.message, "error");
				return;
			case "list":
				return this.#inventory(ctx, s);
			case "show":
				this.#inbox.read(cmd.thread);
				this.#deliver.post(ctx, showCard(await s.client.thread(cmd.thread)));
				return;
			case "watch": {
				const idle = await this.#getWatcher(ctx, s).watch(cmd.thread);
				if (idle) this.#deliver.post(ctx, showCard(idle));
				return;
			}
			case "send":
				await this.#send(ctx, s, cmd.thread, cmd.text);
				return;
			case "answer":
				await this.#answer(ctx, s, cmd.thread, cmd.text);
				return;
			case "stop":
				await this.#stop(ctx, s, cmd.thread);
				return;
			case "pull":
				await this.#pull(ctx, s, cmd.thread, cmd.into);
				return;
			case "resume":
				await this.#resume(ctx, s, cmd.thread);
				return;
			case "delete": {
				const tag = this.#tag(cmd.thread);
				if (!(await ctx.ui.confirm("Delete cloud thread", `Delete ${tag} and its result?`))) return;
				await s.client.deleteThread(cmd.thread);
				this.#threads = this.#threads.filter(t => t.id !== cmd.thread);
				this.#agents.release(cmd.thread);
				this.#inbox.forget(cmd.thread);
				ctx.ui.notify(`☁ deleted ${tag}`, "info");
				return;
			}
			default:
				return;
		}
	}

	/** The connection and where it came from (never a token), then what the service says. Reported even when the service is unreachable. */
	async #status(ctx: Host): Promise<void> {
		const { cfg } = await this.#config(ctx);
		let conn: Connection | undefined;
		let failure: unknown;
		try {
			conn = await resolveConnection(cfg);
		} catch (e) {
			failure = e;
		}
		const lines = ["☁ omp-cloud", ...statusLines(cfg, conn)];
		if (!conn) {
			ctx.ui.notify([...lines, `  ${errorText(failure)}`].join("\n"), "error");
			return;
		}
		try {
			const who = await clientFor(conn, quickTuning(this.#tuning)).whoami();
			const providers = patternProviders(who.modelPatterns);
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
			const thinking = this.#pi.getThinkingLevel();
			lines.push(
				`  user: ${who.user}`,
				`  runs: ${providers.length > 0 ? providers.join(", ") : `no providers yet (${loginHint("<provider>", serverHostOf(conn.paired))})`}`,
				model === ""
					? `  a handoff from here runs: the service's fallback model, ${who.defaultModel || "none"}`
					: `  a handoff from here runs: ${model}${thinking ? ` (thinking ${thinking})` : ""}, this session's model`,
				`  fallback for requests that name no model: ${who.defaultModel || "none"} · omp ${who.ompVersion || "?"}`,
			);
			const updating = updateLine(who.update, who.device === null);
			if (updating) lines.push(`  update: ${updating}`);
			ctx.ui.notify(lines.join("\n"), "info");
		} catch (e) {
			ctx.ui.notify([...lines, `  ${errorText(e)}`].join("\n"), "error");
		}
	}

	// -----------------------------------------------------------------------
	// Pairing
	// -----------------------------------------------------------------------

	/** `/cloud connect`: pairs this machine from a code or over ssh (prompted for when none was typed, which keeps a code out of the prompt history). */
	async #connect(ctx: CommandHost, o: { target: string | undefined; name: string | undefined; replace: boolean; allowPublic: boolean }): Promise<void> {
		const { cfg } = await this.#config(ctx);
		let target = o.target;
		if (target === undefined) {
			if (!ctx.ui.input) throw new UserError(USAGE_CONNECT);
			target = (await ctx.ui.input("Pairing code or ssh target", "ompc1:… or user@host"))?.trim();
			if (!target) {
				ctx.ui.notify("☁ connect cancelled", "info");
				return;
			}
		}
		const card = await runConnect({ target, name: o.name, replace: o.replace, allowPublic: o.allowPublic }, { connectionFile: cfg.connectionFile, ui: ctx.ui });
		this.#deliver.post(ctx, card);
	}

	/** `/cloud pair`: the overlay with the code (copied to the clipboard), on the server machine's owner connection. Needs the TUI. */
	async #pair(ctx: CommandHost, s: Session): Promise<void> {
		if (s.conn.paired) throw new UserError("☁ /cloud pair works with the owner token on the server machine; this machine is itself a paired device");
		const tui = this.#tui;
		const custom = ctx.ui.custom?.bind(ctx.ui);
		if (ctx.mode !== "tui" || !custom || !tui) throw new UserError(PAIR_NEEDS_UI);
		let offer: PairingOffer;
		try {
			offer = await s.client.createPairingOffer();
		} catch (e) {
			if (e instanceof CloudError && e.status === 404) {
				throw new UserError("☁ remote access is not configured on the service: add a remote section (listen, certFile, keyFile) to its service.json");
			}
			throw e;
		}
		let built = false;
		let outcome: PairOutcome | undefined;
		try {
			outcome = await custom<PairOutcome | undefined>(
				(tuiHost, theme, _keybindings, done) => {
					built = true;
					const pair = new PairComponent({ api: s.client, offer, theme, tui, copy: copyToClipboard, requestRender: () => tuiHost.requestRender(), done });
					pair.start();
					return pair;
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "92%", maxHeight: "92%", minWidth: 60 } },
			);
		} catch (e) {
			if (built) throw e;
		}
		if (!built) {
			await s.client.cancelPairing(offer.id).catch(() => {});
			throw new UserError(PAIR_NEEDS_UI);
		}
		if (outcome?.kind === "paired") ctx.ui.notify(`☁ paired ${outcome.name}`, "info");
		else ctx.ui.notify(`☁ pairing ${outcome === undefined || ["open", "pending", "approved"].includes(outcome.status) ? "cancelled" : outcome.status}`, "info");
	}

	/** `/cloud disconnect`: works on the connection file whichever source the session resolves to. */
	async #disconnect(ctx: Host, force: boolean): Promise<void> {
		const { cfg } = await this.#config(ctx);
		const paired = await readConnectionFile(cfg.connectionFile);
		if (!paired) throw new UserError("☁ this machine is not paired; /cloud connect <code> pairs it");
		const gone = await runDisconnect({ connectionFile: cfg.connectionFile, paired, ui: ctx.ui, force, stopForwarder: () => this.stopForwarder(), tuning: quickTuning(this.#tuning) });
		if (gone) {
			this.#watcher?.unwatch();
			this.#watcher = undefined;
		}
	}

	/** The dashboard forwarder of this paired connection: started once per process, restarted when the connection changes. */
	#forwarderFor(s: Session, paired: PairedConnection): DashboardForwarder {
		if (this.#forwarder && !this.#forwarder.stopped && this.#forwarderKey === s.key) return this.#forwarder;
		this.#forwarder?.stop();
		this.#forwarder = DashboardForwarder.start({ upstream: pinnedFetch(paired.server), base: s.conn.url, token: s.conn.token });
		this.#forwarderKey = s.key;
		return this.#forwarder;
	}

	// -----------------------------------------------------------------------
	// Hub
	// -----------------------------------------------------------------------

	/** The overlay hub in a TUI; elsewhere (RPC, a UI without overlays) an inventory card. */
	async #hub(ctx: CommandHost, s: Session): Promise<void> {
		const tui = this.#tui;
		const custom = ctx.ui.custom?.bind(ctx.ui);
		if (ctx.mode !== "tui" || !custom || !tui) return this.#inventory(ctx, s);
		for (;;) {
			let built = false;
			let result: HubResult | undefined;
			try {
				result = await custom<HubResult | undefined>(
					(tuiHost, theme, _keybindings, done) => {
						built = true;
						const hub = new HubComponent({
							serverHost: serverHostOf(s.conn.paired),
							// Explicit arrows: the hub hands `events` to the follower as a bare function.
							api: {
								whoami: async () => {
									const who = await s.client.whoami();
									this.#observe(ctx, s, who);
									return who;
								},
								listThreads: () => s.client.listThreads(),
								thread: id => s.client.thread(id),
								events: (id, o) => s.client.events(id, o),
							},
							theme,
							tui,
							requestRender: () => tuiHost.requestRender(),
							done,
							inbox: this.#inbox,
						});
						hub.start();
						return hub;
					},
					{ overlay: true, overlayOptions: { anchor: "center", width: "92%", maxHeight: "92%", minWidth: 60 } },
				);
			} catch (e) {
				if (built) throw e;
			}
			if (!built) return this.#inventory(ctx, s);
			if (!result) return;
			if (!(await this.#hubAction(ctx, s, result))) return;
		}
	}

	/** Runs one hub key; false when the hub should not reopen. */
	async #hubAction(ctx: CommandHost, s: Session, r: HubResult): Promise<boolean> {
		try {
			switch (r.action) {
				case "send": {
					const text = (await ctx.ui.input?.(`Message to ${r.label}`, "follow-up for the cloud agent"))?.trim();
					if (!text) return true;
					await this.#send(ctx, s, r.thread, text, r.label);
					return true;
				}
				case "answer":
					await this.#answer(ctx, s, r.thread);
					return true;
				case "open": {
					// The thread's latest finished turn as a card in the transcript, with its buttons; the hub closes so the card is seen.
					const detail = await s.client.thread(r.thread);
					const latest = [...detail.turns].reverse().find(t => t.state === "done" || t.state === "failed");
					this.#inbox.read(r.thread);
					if (!latest) {
						ctx.ui.notify(`☁ ${r.label} has no finished turn yet`, "info");
						return true;
					}
					this.#deliver.open(ctx, detail, latest);
					return false;
				}
				case "stop": {
					const tag = r.label;
					if (!(await ctx.ui.confirm("Stop cloud thread", `Abort the running turn of ${tag} and cancel queued ones?`))) return true;
					const st = await s.client.stop(r.thread);
					ctx.ui.notify(`☁ stopped ${tag}: running ${st.stoppedRunning ? "yes" : "no"}, cancelled ${st.cancelled}`, "info");
					return true;
				}
				case "pull":
					await this.#pull(ctx, s, r.thread);
					return true;
				case "resume":
					await this.#resume(ctx, s, r.thread);
					return false;
				case "delete": {
					const tag = r.label;
					if (!(await ctx.ui.confirm("Delete cloud thread", `Delete ${tag} and its result?`))) return true;
					await s.client.deleteThread(r.thread);
					this.#threads = this.#threads.filter(t => t.id !== r.thread);
					this.#agents.release(r.thread);
					this.#inbox.forget(r.thread);
					ctx.ui.notify(`☁ deleted ${tag}`, "info");
					return true;
				}
				case "update":
					await this.#updateCommand(ctx, s);
					return true;
			}
		} catch (e) {
			ctx.ui.notify(e instanceof UserError ? e.message : `☁ ${errorText(e)}`, "error");
			return true;
		}
	}

	async #inventory(ctx: Host, s: Session): Promise<void> {
		const [who, threads, current] = await Promise.all([s.client.whoami(), s.client.listThreads(), this.#currentRepoKey(s.root)]);
		this.#observe(ctx, s, who);
		this.#threads = threads;
		this.#deliver.post(ctx, inventoryCard(who, threads, Date.now(), current));
	}

	/**
	 * The group key this session's own threads get: derived from the repository exactly as a handoff records it
	 * (the upstream remote's URL when it has one, else the directory name, else the path). Undefined outside a git repository.
	 */
	async #currentRepoKey(root: string | undefined): Promise<string | undefined> {
		if (root === undefined) return undefined;
		const { remoteURL } = await resolveRemote(root);
		return repoKey({ remoteURL, name: basename(root), workspace: root });
	}

	// -----------------------------------------------------------------------
	// Questions
	// -----------------------------------------------------------------------

	async #answer(ctx: Host, s: Session, thread: string, text?: string): Promise<void> {
		const out = await answerThread(s.client, thread, ctx.ui, text);
		if (out.answered.length === 0) this.#autoAsk.unanswered(ctx, thread, out.turn, out.asked);
		await this.#reportAnswers(ctx, s, thread, out.answered, out.left);
	}

	/** What an answer did: what was answered, what still waits, and following the thread on. */
	async #reportAnswers(ctx: Host, s: Session, thread: string, answered: readonly Question[], left: number): Promise<void> {
		if (left === 0) this.#inbox.resolve(thread, "question");
		for (const q of answered) ctx.ui.notify(`☁ answered ${answerSummary(q)}`, "info");
		if (answered.length === 0) {
			ctx.ui.notify("☁ answer cancelled", "info");
			return;
		}
		if (left > 0) ctx.ui.notify(`☁ ${plural(left, "question")} still wait on ${this.#tag(thread)}: /cloud answer ${shortName(thread)}`, "warning");
		await this.#getWatcher(ctx, s).watch(thread);
	}

	// -----------------------------------------------------------------------
	// Card buttons
	// -----------------------------------------------------------------------

	/**
	 * A button on a transcript card: runs what the matching `/cloud` command runs, through the newest context, and reports the
	 * same way. Nothing throws out of here: a failure, a deleted thread or a closed question is a notification.
	 */
	run(thread: string, act: CardAct): void {
		const ctx = this.#ctx;
		if (ctx) void this.#act(ctx, thread, act);
	}

	async #act(ctx: Host, thread: string, act: CardAct): Promise<void> {
		try {
			const s = await this.#session(ctx, "quick");
			if (act.kind === "update") return await this.#updateCommand(ctx, s);
			const known = (await this.#threadList(s)).find(t => t.id === thread);
			if (!known) throw new UserError(`☁ ${shortName(thread)} no longer exists`);
			switch (act.kind) {
				case "reply":
					return await this.#reply(ctx, s, known);
				case "pull":
					return await this.#pull(ctx, s, thread);
				case "show":
					this.#inbox.read(thread);
					this.#deliver.post(ctx, showCard(await s.client.thread(thread)));
					return;
				case "stop":
					return await this.#stop(ctx, s, thread);
				case "resume": {
					const command = this.#commandCtx;
					if (!command) throw new UserError(`☁ resuming switches the session: run /cloud resume ${shortName(thread)}`);
					return await this.#resume(command, s, thread);
				}
				case "answer":
					return await this.#answerCard(ctx, s, thread, act.question, act.option);
				case "answer-other":
					return await this.#answerCard(ctx, s, thread, act.question);
			}
		} catch (e) {
			const gone = e instanceof CloudError && e.status === 404;
			ctx.ui.notify(e instanceof UserError ? e.message : gone ? `☁ ${shortName(thread)} no longer exists` : `☁ ${errorText(e)}`, "error");
		}
	}

	/** The Reply button: asks for the message and sends it as `/cloud send` does. A cancelled or empty input sends nothing. */
	async #reply(ctx: Host, s: Session, thread: ThreadSummary): Promise<void> {
		if (!ctx.ui.input) throw new UserError(`☁ this host cannot prompt; use /cloud send ${shortName(thread.id)} <message>`);
		const text = (await ctx.ui.input(`Reply to ${threadHeading(thread, 60)} · ${shortName(thread.id)}`, "message"))?.trim();
		if (text) await this.#send(ctx, s, thread.id, text);
	}

	/**
	 * An answer button: `option` answers the question with that option of its list; without it the user types an answer (or, for a
	 * several-choice question, picks through omp's prompts as `/cloud answer` does). `question` is `<turn>:<id>` as the card says.
	 */
	async #answerCard(ctx: Host, s: Session, thread: string, question: string, option?: number): Promise<void> {
		const [turnText = "", idText = ""] = question.split(":");
		const turn = Number(turnText);
		const id = Number(idText);
		const pending = pendingQuestions(await s.client.thread(thread));
		const q = pending !== undefined && pending.turn === turn ? pending.questions.find(x => x.id === id) : undefined;
		if (!pending || !q) throw new UserError(`☁ that question on ${this.#tag(thread)} is closed already`);
		let body: AnswerBody | undefined;
		if (option !== undefined) {
			const label = q.options?.[option]?.label;
			if (label === undefined) throw new UserError(`☁ that question on ${this.#tag(thread)} has no such option`);
			body = { selected: [label] };
		} else if (q.multi || usesNativeDialog(ctx.ui, q)) {
			body = await askUser(ctx.ui, thread, q);
		} else {
			if (!ctx.ui.input) throw new UserError(`☁ this host cannot prompt; use /cloud answer ${shortName(thread)} <text>`);
			const text = (await ctx.ui.input(`${this.#tag(thread)} asks: ${clip(q.text, 160)}`, "your answer"))?.trim();
			body = text ? parseAnswerText(q, text) : undefined;
		}
		if (!body) {
			ctx.ui.notify("☁ answer cancelled", "info");
			this.#autoAsk.unanswered(ctx, thread, turn, [q]);
			return;
		}
		await this.#reportAnswers(ctx, s, thread, [await s.client.answer(thread, turn, id, body)], pending.questions.length - 1);
	}

	// -----------------------------------------------------------------------
	// Pull and resume
	// -----------------------------------------------------------------------

	/** Downloads the thread's result bundle to a temp file for `work`; a missing result is `not_found` with a message that says so. */
	async #withResult<T>(client: Pick<CloudClient, "downloadResult">, id: string, signal: AbortSignal | undefined, work: (bundlePath: string, headers: ResultHeaders) => Promise<T>): Promise<T> {
		const tmp = await mkdtemp(join(tmpdir(), "omp-cloud-pull-"));
		try {
			const bundle = join(tmp, "result.bundle");
			let headers: ResultHeaders;
			try {
				headers = await client.downloadResult(id, bundle, { signal });
			} catch (e) {
				if (e instanceof CloudError && e.status === 404) throw new CloudError({ code: "not_found", status: 404, message: `${id} has no result yet`, retriable: false, outcomeKnown: true, hint: "a turn must finish and commit first; cloud status shows where it is" });
				throw e;
			}
			return await work(bundle, headers);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	}

	/** `/cloud resume`: fetches the result's branch into the repository (no identity check: the user names the thread). */
	async #fetchResult(s: Session, id: string): Promise<void> {
		const root = s.root;
		if (!root) throw new UserError("☁ not a git repository");
		const detail = await s.client.thread(id);
		await this.#withResult(s.client, id, undefined, (bundlePath, headers) =>
			pullBundle({ root, thread: id, bundlePath, baseCommit: detail.repo.baseCommit || headers.base, remote: "origin" }),
		).catch((e: unknown) => {
			throw e instanceof CloudError && e.code === "not_found" ? new UserError(`☁ ${e.message}`) : e;
		});
	}

	/**
	 * Downloads the newest conversation export of `thread` and places it in the local omp sessions; `fork`
	 * lets omp fork it beside a local copy that has to stay. Undefined when the thread has no conversation yet.
	 * Callers queue it on the thread's chain.
	 */
	async #saveConversation(client: Pick<CloudClient, "downloadConversation">, thread: string, cwd: string, current: string | undefined, fork: boolean): Promise<SyncOutcome | undefined> {
		const tmp = await mkdtemp(join(tmpdir(), "omp-cloud-session-"));
		try {
			const archive = join(tmp, "conversation.tar");
			try {
				await client.downloadConversation(thread, archive);
			} catch (e) {
				if (e instanceof CloudError && e.status === 404) return undefined;
				throw e;
			}
			// The agent's `history://` reads the same export; its failure never stops the local copy from being made.
			await this.#agents.ingest(thread, archive).catch(() => {});
			return await syncConversation({ archive, cwd, current, env: this.#env, fork });
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	}

	/** Applies the thread's result bundle, then saves the conversation; a failed save is reported in the result, never thrown. */
	async #pullThread(ctx: Host, s: Session, id: string, req: PullRequest, signal?: AbortSignal): Promise<PullResult> {
		const detail = await s.client.thread(id, { signal });
		if (!detail.scratch && s.root === undefined) throw notInRepository();
		const applied = await this.#withResult(s.client, id, signal, (bundlePath, headers) =>
			applyPull({
				root: s.root,
				cwd: ctx.cwd,
				thread: id,
				scratch: detail.scratch,
				bundlePath,
				identity: { handoffCommit: detail.repo.handoffCommit, baseCommit: detail.repo.baseCommit || headers.base, remoteURL: detail.repo.remoteURL },
				...req,
			}),
		);
		const cwd = detail.scratch ? applied.path : await syncCwd(detail.paths.workspace, s.root ?? ctx.cwd);
		const current = ctx.sessionManager.getSessionFile();
		let session: SessionOutcome;
		try {
			const synced = await this.#serialized(id, () => this.#saveConversation(s.client, id, cwd, current, true));
			session = synced ? { kind: "saved", ...synced } : { kind: "none" };
		} catch (e) {
			session = { kind: "failed", reason: errorText(e) };
		}
		const r = detail.result;
		return { ...applied, filesChanged: r?.filesChanged ?? 0, insertions: r?.insertions ?? 0, deletions: r?.deletions ?? 0, session };
	}

	/**
	 * `/cloud pull`, the hub and the card button: fetches the branch; with `into` a scratch thread is cloned there and a repository
	 * thread gets a worktree. The user names the thread, so the repository identity check the model's `pull` makes is skipped
	 * (`force`), as `/cloud resume` skips it.
	 */
	async #pull(ctx: Host, s: Session, id: string, into?: string): Promise<void> {
		const p = await this.#pullThread(ctx, s, id, { apply: into === undefined ? "fetch" : "worktree", into, force: true });
		this.#deliver.post(ctx, pullCard(id, p));
	}

	async #resume(ctx: CommandHost, s: Session, id: string): Promise<void> {
		const root = s.root;
		if (!root) throw new UserError("☁ not a git repository");
		if (!(await isClean(root))) throw new UserError("☁ commit or stash your changes first (or use /cloud pull)");
		await this.#fetchResult(s, id);
		await git(root, ["switch", threadBranch(id)]);

		const current = ctx.sessionManager.getSessionFile();
		const saved = await this.#serialized(id, () => this.#saveConversation(s.client, id, root, current, true));
		if (!saved) throw new UserError(`☁ ${id} has no conversation yet`);
		if (saved.mode === "skipped") throw new Error(`resume saved no session although forking was allowed: ${saved.file}`);
		const sw = await ctx.switchSession(saved.file);
		if (sw.cancelled) throw new UserError(`☁ session switch was cancelled; the conversation was restored to ${saved.file}`);
		ctx.ui.notify(`☁ resumed ${id} on branch ${threadBranch(id)}`, "info");
		const detail = await s.client.thread(id).catch(() => undefined);
		if (detail && (detail.phase === "starting" || detail.phase === "working" || detail.phase === "waiting")) {
			ctx.ui.notify("☁ the cloud agent is still working; this is a snapshot", "warning");
		}
	}

	/**
	 * Saves the conversation of a thread whose turn just finished, in the background. A request made
	 * while one is queued behind other work shares that run, which downloads the newest export anyway.
	 */
	#saveFinishedTurn(host: Host, client: CloudClient, thread: ThreadDetail): void {
		const id = thread.id;
		const queued = this.#waiting.has(id);
		this.#waiting.set(id, host);
		if (queued) return;
		this.#serialized(id, async () => {
			const latest = this.#waiting.get(id) ?? host;
			this.#waiting.delete(id);
			try {
				const cwd = await syncCwd(thread.paths.workspace, (await this.#repoRoot(latest.cwd)) ?? latest.cwd);
				await this.#saveConversation(client, id, cwd, latest.sessionManager.getSessionFile(), false);
			} catch (e) {
				latest.ui.notify(`☁ could not save ${id}'s conversation locally: ${errorText(e)}`, "warning");
			}
		}).catch(() => {
			// The notification itself failed (a stale host); nobody is left to tell.
		});
	}

	/** The watcher's sink: finished turns become cards (or inbox entries) and also save the conversation. */
	#watchSink(client: CloudClient): WatchSink {
		return {
			turn: (host, thread, turn, events, job) => {
				this.#deliver.turn(host, thread, turn, events, job);
				this.#saveFinishedTurn(host, client, thread);
			},
			question: (host, thread, q) => {
				this.#deliver.question(host, thread, q);
				// The card above stays as the transcript's record and the way back to a dismissed dialog.
				void this.#autoAsk.open(host, thread);
			},
			refreshed: thread => {
				this.#deliver.refreshed(thread);
				this.#autoAsk.settle(thread);
			},
			tray: (host, thread) => this.#deliver.tray(host, thread),
			answered: thread => this.#deliver.answered(thread),
			gone: (host, thread, job) => {
				this.#autoAsk.close(thread.id);
				this.#deliver.gone(host, thread, job);
			},
			lost: (host, thread) => this.#deliver.lost(host, thread),
			flush: host => this.#deliver.flush(host),
		};
	}

	// -----------------------------------------------------------------------
	// Launch
	// -----------------------------------------------------------------------

	/** Runs `work` after everything queued under `key` (a repository root or a thread id) has settled. */
	async #serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
		const prev = this.#chains.get(key) ?? Promise.resolve();
		const next = prev.then(work, work);
		this.#chains.set(key, next);
		try {
			return await next;
		} finally {
			if (this.#chains.get(key) === next) this.#chains.delete(key);
		}
	}

	async #launchFromCommand(ctx: Host, task: string): Promise<void> {
		try {
			const d = await this.#launchOne(ctx, task);
			ctx.ui.notify(`☁ ${threadTag(d)} started — /cloud watch ${shortName(d.id)}`, "info");
			for (const w of d.warnings) ctx.ui.notify(`☁ ${w}`, "warning");
		} catch (e) {
			ctx.ui.notify(e instanceof UserError ? e.message : `☁ handoff failed: ${errorText(e)}`, "error");
		}
	}

	/** The session id the host reports; `""` in a host that has none. */
	#sessionId(ctx: Host): string {
		return ctx.sessionManager.getSessionId?.() ?? "";
	}

	/** What a created thread gets in this session: it leads the cached list, its launch card is posted (not for a replayed create: the card exists already) and it is followed for `origin`. The host job of its first turn, when it is one already. */
	#announce(ctx: Host, origin: ThreadOrigin, prompt: string, o: LaunchedThread): string | undefined {
		const id = o.response.id;
		this.#threads = [o.response, ...this.#threads.filter(t => t.id !== id)];
		if (!o.replayed) this.#deliver.post(ctx, launchCard({ origin, thread: id, name: o.response.name, prompt, summary: o.summary, warnings: o.warnings }));
		this.follow(id, { origin });
		return this.#jobs?.jobId(id);
	}

	/**
	 * `/cloud <task>`: hands the current conversation and repository to the cloud, posts the launch card and follows the thread
	 * for the user. A failure is thrown.
	 */
	async #launchOne(ctx: Host, task: string): Promise<Delegated> {
		refusePairingCode(task);
		this.#ctx = ctx;
		const s = await this.#session(ctx, "quick");
		return this.#serialized(s.root ?? ctx.cwd, async () => {
			const batch = await launchBatch({
				host: ctx,
				pi: this.#pi,
				cfg: s.cfg,
				client: s.client,
				serverHost: serverHostOf(s.conn.paired),
				tasks: [{ task, workspace: "repo" }],
				origin: "user",
				sessionId: this.#sessionId(ctx),
				env: this.#env,
				home: this.#home,
				agentDir: this.#pi.pi.settings.getAgentDir(),
				ownRoot: this.#ownRoot,
			});
			const outcome = batch.outcomes[0];
			if (!outcome) throw new Error("the handoff produced no outcome");
			if (!outcome.ok) throw outcome.error;
			const job = this.#announce(ctx, "user", task, outcome);
			return { id: outcome.response.id, name: outcome.response.name, title: outcome.response.title, job, warnings: outcome.warnings };
		});
	}

	// -----------------------------------------------------------------------
	// Operations for the `cloud` tool (see `ToolCloud` in tool.ts)
	// -----------------------------------------------------------------------

	/** The client and session id of the tool's call. The call's context becomes the one cards and follows use. */
	async toolSession(ctx: Host): Promise<ToolSession> {
		this.#ctx = ctx;
		return { client: (await this.#session(ctx, "full")).client, sessionId: this.#sessionId(ctx) };
	}

	/**
	 * Delegation by the local model: one snapshot, conversation and setup for the whole batch, one create per task. Serialized
	 * with the user's launches of the same repository. Each created thread is announced and followed so its results wake the model.
	 */
	async delegate(ctx: Host, request: DelegateRequest, run: DelegateRun): Promise<DelegateResult> {
		this.#ctx = ctx;
		const s = await this.#session(ctx, "full");
		return this.#serialized(s.root ?? ctx.cwd, async () => {
			const batch = await launchBatch({
				host: ctx,
				pi: this.#pi,
				cfg: s.cfg,
				client: s.client,
				serverHost: serverHostOf(s.conn.paired),
				tasks: request.tasks,
				context: request.context,
				origin: "tool",
				sessionId: this.#sessionId(ctx),
				env: this.#env,
				home: this.#home,
				agentDir: this.#pi.pi.settings.getAgentDir(),
				ownRoot: this.#ownRoot,
				toolCallId: run.toolCallId,
				signal: run.signal,
				onProgress: run.onProgress,
			});
			const outcomes = batch.outcomes.map(o => (o.ok ? { ...o, job: this.#announce(ctx, "tool", request.tasks[o.index]?.task ?? "", o) } : o));
			return { defaultWorkspace: batch.defaultWorkspace, outcomes };
		});
	}

	/** Drops what the session holds of a thread the service deleted: its follower and job end without a word, since the model that deleted it knows. */
	forgetThread(thread: string): void {
		this.#watcher?.forget(thread);
		this.#agents.release(thread);
		this.#threads = this.#threads.filter(t => t.id !== thread);
		this.#inbox.forget(thread);
	}

	/** The full id of the thread `token` names: a 12-character id, a job id, an id suffix (4 or more characters) or a name prefix; throws `not_found` or `ambiguous_ref`. */
	#resolve(s: Session, token: string, signal?: AbortSignal): Promise<string> {
		return resolveRef(s.client, token, { jobOf: id => this.#jobs?.jobId(id) ?? this.#agents.agentId(id), signal });
	}

	/** The full id of the thread `ref` names (see `resolveRef`). */
	async resolve(ctx: Host, ref: string, signal?: AbortSignal): Promise<string> {
		return this.#resolve(await this.#session(ctx, "full"), ref, signal);
	}

	/** `/cloud pull` and the tool's pull: the thread's result applied as `req` says, then its conversation saved as a local session. */
	async pull(ctx: Host, thread: string, req: PullRequest, signal?: AbortSignal): Promise<PullResult & { thread: string }> {
		this.#ctx = ctx;
		return { thread, ...(await this.#pullThread(ctx, await this.#session(ctx, "full"), thread, req, signal)) };
	}
}
