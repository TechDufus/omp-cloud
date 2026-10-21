/** One thread: facts, open questions, the composer, the turns timeline and the live event feed. */
import { ArrowLeft, Download, Send, Square, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	ApiError,
	answerQuestion,
	deleteThread,
	getThread,
	type QuestionView,
	sendMessage,
	stopThread,
	type ThreadDetailView,
	type ThreadEvent,
	type ThreadPhase,
	threadDownloadPath,
	threadEventsPath,
	type TurnState,
	type TurnView,
} from "../api";
import { messageOf, useQuery } from "../app/query";
import { navigate } from "../app/route";
import { ago, count, dateTime, diffstat, money, short } from "../format";
import { Badge, Card, Dot, EmptyState, ErrorState, KeyValues, Modal, PageHeader, TableSkeleton, type Tone } from "../kit/ui";
import { LIFECYCLE_KINDS } from "../live";
import { contextLabel, MetricsCard, threadLabel } from "./thread-metrics";
import "./threads.css";

/** The feed keeps this many newest events. */
const MAX_FEED_EVENTS = 300;
/** Events of one burst (the backlog on connect) render together. */
const FEED_FLUSH_MS = 60;
/** Relative times go stale between events. */
const REDRAW_MS = 30_000;
const ACTIVE_PHASES: readonly ThreadPhase[] = ["starting", "working", "waiting"];

const PHASE_TONES: Record<ThreadPhase, Tone> = {
	starting: "neutral",
	working: "accent",
	waiting: "warn",
	idle: "ok",
	failed: "bad",
	deleted: "neutral",
};

const TURN_TONES: Record<TurnState, Tone> = {
	queued: "neutral",
	running: "accent",
	done: "ok",
	failed: "bad",
	cancelled: "neutral",
};

export function PhaseBadge({ phase }: { phase: ThreadPhase }) {
	return <Badge tone={PHASE_TONES[phase]}>{phase}</Badge>;
}

/** Re-renders the caller every 30 s while `enabled`, so `ago(…)` stays honest. */
export function useTicker(enabled: boolean): void {
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!enabled) return;
		const timer = window.setInterval(() => setTick(tick => tick + 1), REDRAW_MS);
		return () => window.clearInterval(timer);
	}, [enabled]);
}

function isOpen(turn: TurnView, question: QuestionView): boolean {
	return turn.state === "running" && question.answeredAt === null && !question.expired;
}

export function ThreadDetail({ id, active }: { id: string; active: boolean }) {
	useTicker(active);
	const thread = useQuery(["thread", id], () => getThread(id), { enabled: active, live: true });
	const t = thread.data;
	const missing = thread.error instanceof ApiError && thread.error.status === 404;
	const wasLoaded = useRef(false);
	const [busy, setBusy] = useState<"stop" | "delete" | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);

	useEffect(() => {
		if (t) wasLoaded.current = true;
	}, [t]);
	// A thread deleted elsewhere, or by the Delete button, leaves its detail behind.
	useEffect(() => {
		if (missing && wasLoaded.current) navigate("#/threads");
	}, [missing]);

	const back = (
		<a className="btn" data-variant="ghost" href="#/threads">
			<ArrowLeft size={14} /> Threads
		</a>
	);

	if (!t) {
		let body = (
			<Card flush>
				<TableSkeleton rows={6} />
			</Card>
		);
		if (missing) body = <EmptyState title="This thread no longer exists." />;
		else if (thread.error) body = <ErrorState error={messageOf(thread.error)} onRetry={thread.refetch} />;
		return (
			<div className="page">
				<PageHeader title="Thread" actions={back} />
				{body}
			</div>
		);
	}

	async function stop(): Promise<void> {
		setBusy("stop");
		try {
			await stopThread(id);
			setActionError(null);
			thread.refetch();
		} catch (error) {
			setActionError(messageOf(error));
		} finally {
			setBusy(null);
		}
	}

	async function remove(): Promise<void> {
		setBusy("delete");
		try {
			await deleteThread(id);
			navigate("#/threads");
		} catch (error) {
			setActionError(messageOf(error));
			setConfirming(false);
		} finally {
			setBusy(null);
		}
	}

	const label = threadLabel(t, "Untitled thread");
	const open = t.turns.flatMap(turn => turn.questions.filter(q => isOpen(turn, q)).map(question => ({ turn, question })));
	const ordered = [...t.turns].reverse();
	const hasConversation = t.turns.some(turn => turn.state === "done");

	return (
		<div className="page">
			<PageHeader
				title={label}
				description={
					<span className="row threads-subtitle">
						<PhaseBadge phase={t.phase} />
						{t.archivedAt !== null && <Badge>archived</Badge>}
						<span className="mono">{t.id}</span>
						{t.name && t.title && (
							<span className="threads-subtitle-title truncate" title={t.title}>
								{t.title}
							</span>
						)}
						{t.activity && (
							<span className="threads-subtitle-title truncate" title={dateTime(t.activity.at)}>
								{t.activity.kind}: {t.activity.text}
							</span>
						)}
						<span>
							created {dateTime(t.createdAt)} · active <span title={dateTime(t.lastActivityAt)}>{ago(t.lastActivityAt)}</span>
						</span>
					</span>
				}
				actions={
					<>
						{back}
						{t.result && (
							<a className="btn" data-size="sm" href={threadDownloadPath(id, "result")} download>
								<Download size={13} /> Result bundle
							</a>
						)}
						{hasConversation && (
							<a className="btn" data-size="sm" href={threadDownloadPath(id, "conversation")} download>
								<Download size={13} /> Conversation
							</a>
						)}
						<button
							type="button"
							className="btn"
							data-size="sm"
							disabled={busy !== null || !ACTIVE_PHASES.includes(t.phase)}
							onClick={() => void stop()}
						>
							<Square size={13} /> Stop
						</button>
						<button
							type="button"
							className="btn"
							data-variant="danger"
							data-size="sm"
							disabled={busy !== null}
							onClick={() => setConfirming(true)}
						>
							<Trash2 size={13} /> Delete
						</button>
					</>
				}
			/>
			{thread.error !== undefined && !missing && <ErrorState error={messageOf(thread.error)} onRetry={thread.refetch} />}
			{t.error && <ErrorState error={t.error} />}
			{actionError && <ErrorState error={actionError} />}

			{open.map(({ turn, question }) => (
				<QuestionCard key={`${turn.id}/${question.id}`} threadId={id} turn={turn} question={question} onAnswered={thread.refetch} />
			))}

			<div className="grid grid-main-side">
				<div className="threads-col">
					<Composer threadId={id} phase={t.phase} onSent={thread.refetch} />
					<MetricsCard thread={t} />
					<Card title="Turns" description={`${t.turns.length} ${t.turns.length === 1 ? "turn" : "turns"}, newest first`}>
						{ordered.length === 0 ? (
							<EmptyState title="No turns yet" />
						) : (
							<div className="threads-turns">
								{ordered.map((turn, index) => (
									<TurnBlock key={turn.id} turn={turn} open={index === 0 || turn.state === "running"} />
								))}
							</div>
						)}
					</Card>
				</div>
				<Card title="Details" className="threads-facts">
					<KeyValues items={factItems(t)} />
				</Card>
			</div>

			<EventFeed id={id} active={active} />

			<Modal
				open={confirming}
				title="Delete thread"
				onClose={() => setConfirming(false)}
				primaryAction={{ label: busy === "delete" ? "Deleting…" : "Delete", onClick: () => void remove(), disabled: busy !== null }}
			>
				<p>
					Delete “{label}” with its turns, events and files? This cannot be undone.
				</p>
			</Modal>
		</div>
	);
}

interface Fact {
	key: string;
	label: string;
	value: ReactNode;
}

function factItems(t: ThreadDetailView): Fact[] {
	const result = t.result;
	let vm = "none";
	if (t.vm) vm = `${t.vm.state} · ${t.vm.sandboxId}${t.vm.pid === null ? "" : ` · pid ${t.vm.pid}`}`;
	else if (t.archivedAt !== null) vm = `archived ${dateTime(t.archivedAt)} — the next message restores it`;
	const items: Fact[] = [
		{ key: "model", label: "Model", value: `${t.model || "service default"}${t.thinking ? ` · thinking ${t.thinking}` : ""}` },
		{ key: "omp", label: "omp", value: t.ompVersion || "—" },
		{ key: "repo", label: "Repository", value: t.repo.remoteURL ? `${t.repo.name} (${t.repo.remoteURL})` : t.repo.name },
		{ key: "branches", label: "Branches", value: `${t.repo.localBranch || "—"} · base ${t.repo.baseRef || "—"}` },
		{
			key: "commits",
			label: "Commits",
			value: `handoff ${short(t.repo.handoffCommit)}${t.repo.baseCommit ? ` on ${short(t.repo.baseCommit)}` : " (full history)"}`,
		},
		{ key: "home", label: "Home", value: t.paths.home || "VM default" },
		{ key: "workspace", label: "Workspace", value: t.paths.workspace || "VM default" },
		{
			key: "vm",
			label: "VM",
			value: vm,
		},
		{
			key: "overlays",
			label: "Config overlays",
			value:
				t.configOverlays.length === 0 ? (
					"none"
				) : (
					<span className="threads-chips">
						{t.configOverlays.map(overlay => (
							<Badge key={overlay} mono>
								{overlay}
							</Badge>
						))}
					</span>
				),
		},
	];
	if (result) {
		items.push({
			key: "result",
			label: "Result",
			value: [
				`${result.branch} @ ${short(result.head)} · ${diffstat(result.filesChanged, result.insertions, result.deletions)}`,
				result.pushed ? ` · pushed${result.pushRef ? ` to ${result.pushRef}` : ""}` : "",
				result.pushError ? ` · push failed: ${result.pushError}` : "",
			].join(""),
		});
	}
	return items;
}

interface QuestionCardProps {
	threadId: string;
	turn: TurnView;
	question: QuestionView;
	onAnswered: () => void;
}

/** An open question. Its draft lives in this component, so refetches of the thread leave it alone. */
function QuestionCard({ threadId, turn, question: q, onAnswered }: QuestionCardProps) {
	const [selected, setSelected] = useState<string[]>([]);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const toggle = (label: string): void =>
		setSelected(previous => {
			if (previous.includes(label)) return previous.filter(l => l !== label);
			return q.multi ? [...previous, label] : [label];
		});

	async function submit(): Promise<void> {
		const answer = text.trim();
		if (selected.length === 0 && answer === "") {
			setError("Select an option or write an answer.");
			return;
		}
		setBusy(true);
		try {
			await answerQuestion(threadId, turn.id, q.id, { selected, answer });
			setError(null);
			onAnswered();
		} catch (failure) {
			setError(messageOf(failure));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Card
			title={q.header || "The agent asks"}
			className="threads-question"
			actions={<Badge tone="warn">{q.multi ? "choose any" : "waiting"}</Badge>}
		>
			<div className="stack threads-question-body">
				<p className="threads-text">{q.text}</p>
				{q.options.length > 0 && (
					<div className="threads-options">
						{q.options.map((option, index) => (
							<button
								key={option.label}
								type="button"
								className="threads-option"
								aria-pressed={selected.includes(option.label)}
								onClick={() => toggle(option.label)}
							>
								<span className="threads-option-label">
									{option.label}
									{q.recommended === index ? " (recommended)" : ""}
								</span>
								{option.description && <span className="threads-option-description">{option.description}</span>}
							</button>
						))}
					</div>
				)}
				<div className="row">
					<input
						type="text"
						className="input threads-answer"
						value={text}
						placeholder={q.options.length > 0 ? "Or answer in your own words" : "Your answer"}
						onChange={event => setText(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Enter") void submit();
						}}
					/>
					<button type="button" className="btn" data-variant="primary" disabled={busy} onClick={() => void submit()}>
						<Send size={13} /> Send answer
					</button>
				</div>
				{error && <ErrorState error={error} />}
			</div>
		</Card>
	);
}

interface ComposerProps {
	threadId: string;
	phase: ThreadPhase;
	onSent: () => void;
}

function Composer({ threadId, phase, onSent }: ComposerProps) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const closed = phase === "failed" || phase === "deleted";

	async function send(): Promise<void> {
		const message = text.trim();
		if (message === "" || busy || closed) return;
		setBusy(true);
		try {
			await sendMessage(threadId, message);
			setText("");
			setError(null);
			onSent();
		} catch (failure) {
			setError(messageOf(failure));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Card title="Message" description="Send a follow-up; it runs as the next turn.">
			<div className="stack threads-composer">
				<textarea
					className="input threads-textarea"
					rows={3}
					value={text}
					placeholder="Send a follow-up message (Ctrl+Enter sends)"
					onChange={event => setText(event.target.value)}
					onKeyDown={event => {
						if (event.ctrlKey && event.key === "Enter") void send();
					}}
				/>
				<div className="row">
					<button type="button" className="btn" data-variant="primary" disabled={busy || closed || text.trim() === ""} onClick={() => void send()}>
						<Send size={13} /> Send
					</button>
					{closed && <span className="micro">This thread is {phase}; it takes no more messages.</span>}
				</div>
				{error && <ErrorState error={error} />}
			</div>
		</Card>
	);
}

function TurnBlock({ turn, open }: { turn: TurnView; open: boolean }) {
	const usage = turn.usage;
	const settled = turn.questions.filter(q => !isOpen(turn, q));
	const work = [
		turn.requests > 0 && `${turn.requests} req`,
		turn.tools > 0 && `${turn.tools} tools`,
		turn.context !== null && `ctx ${contextLabel(turn.context)}`,
	]
		.filter(part => part !== false)
		.join(" · ");
	return (
		<details className="threads-turn" open={open}>
			<summary>
				<strong>Turn {turn.id}</strong>
				<Badge tone={TURN_TONES[turn.state]}>{turn.state}</Badge>
				<span className="threads-turn-title truncate">{turn.title}</span>
				{work !== "" && (
					<span className="micro threads-turn-metrics" title="Model requests · tool calls · context at the end of the turn">
						{work}
					</span>
				)}
				<span className="micro" title={dateTime(turn.completedAt ?? turn.startedAt ?? turn.queuedAt)}>
					{ago(turn.completedAt ?? turn.startedAt ?? turn.queuedAt)}
				</span>
			</summary>
			<div className="threads-turn-body">
				<div className="threads-label">
					Prompt · {turn.by} · queued {dateTime(turn.queuedAt)}
				</div>
				<p className="threads-text">{turn.text}</p>
				{turn.reply && (
					<>
						<div className="threads-label">Reply</div>
						<p className="threads-text threads-reply">{turn.reply}</p>
					</>
				)}
				{turn.error && <ErrorState error={turn.error} />}
				{usage && (
					<p className="micro">
						in {count(usage.inputTokens)} · out {count(usage.outputTokens)} · cache read {count(usage.cacheReadTokens)} / write{" "}
						{count(usage.cacheWriteTokens)} · {money(usage.cost)}
					</p>
				)}
				{turn.head && (
					<p className="micro">
						head {short(turn.head)} · {diffstat(turn.filesChanged, turn.insertions, turn.deletions)}
						{turn.pushed ? ` · pushed${turn.pushRef ? ` to ${turn.pushRef}` : ""}` : ""}
					</p>
				)}
				{turn.pushError && <ErrorState error={`Push failed: ${turn.pushError}`} />}
				{settled.map(q => (
					<SettledQuestion key={q.id} question={q} />
				))}
			</div>
		</details>
	);
}

function SettledQuestion({ question: q }: { question: QuestionView }) {
	const given = [...q.selected, q.answer].filter(part => part !== "").join(" · ");
	let outcome = "unanswered";
	if (q.answeredAt !== null) outcome = `${given || "answered"} (${q.answeredBy})`;
	else if (q.expired) outcome = "expired";
	return (
		<div className="threads-qa">
			<div className="threads-label">{q.header ? `${q.header}: ${q.text}` : q.text}</div>
			<p className="threads-text">→ {outcome}</p>
		</div>
	);
}

function isThreadEvent(value: unknown): value is ThreadEvent {
	return (
		typeof value === "object" &&
		value !== null &&
		"seq" in value &&
		typeof value.seq === "number" &&
		"at" in value &&
		typeof value.at === "string" &&
		"kind" in value &&
		typeof value.kind === "string" &&
		"turn" in value &&
		(value.turn === null || typeof value.turn === "number") &&
		"text" in value &&
		typeof value.text === "string"
	);
}

function parseEvent(data: string): ThreadEvent | null {
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return null;
	}
	return isThreadEvent(value) ? value : null;
}

function kindTone(kind: string): Tone {
	if (kind === "tool_error" || kind === "turn_failed" || kind === "thread_failed") return "bad";
	if (kind === "turn_done") return "ok";
	if (kind === "question_asked") return "warn";
	return LIFECYCLE_KINDS[kind] === true ? "accent" : "neutral";
}

/** The thread's own event stream: backlog first, then live. The one stream a page opens besides the shared one. */
function EventFeed({ id, active }: { id: string; active: boolean }) {
	const [events, setEvents] = useState<ThreadEvent[]>([]);
	const [status, setStatus] = useState("connecting…");
	const listRef = useRef<HTMLUListElement>(null);
	/** The newest seq that reached the list; a reopened stream resumes after it. */
	const flushed = useRef(0);
	const stick = useRef(true);

	useEffect(() => {
		if (!active) return;
		setStatus("connecting…");
		let received = flushed.current;
		let pending: ThreadEvent[] = [];
		let timer: number | undefined;
		const flush = (): void => {
			timer = undefined;
			const batch = pending;
			pending = [];
			const newest = batch[batch.length - 1];
			if (newest === undefined) return;
			flushed.current = newest.seq;
			const list = listRef.current;
			stick.current = list === null || list.scrollHeight - list.scrollTop - list.clientHeight < 40;
			setEvents(previous => {
				const next = previous.concat(batch);
				return next.length > MAX_FEED_EVENTS ? next.slice(next.length - MAX_FEED_EVENTS) : next;
			});
		};
		const source = new EventSource(threadEventsPath(id, received));
		source.onopen = () => setStatus("live");
		source.onerror = () => setStatus(source.readyState === EventSource.CLOSED ? "disconnected" : "reconnecting…");
		// A reconnect resumes by Last-Event-ID, but `after` takes precedence there, so skip seen events.
		source.onmessage = frame => {
			const event = parseEvent(frame.data);
			if (event === null || event.seq <= received) return;
			received = event.seq;
			pending.push(event);
			timer ??= window.setTimeout(flush, FEED_FLUSH_MS);
		};
		return () => {
			source.close();
			window.clearTimeout(timer);
		};
	}, [id, active]);

	useLayoutEffect(() => {
		const list = listRef.current;
		if (list && stick.current) list.scrollTop = list.scrollHeight;
	}, [events]);

	const live = status === "live";
	return (
		<Card
			title="Live events"
			description="Every event of this thread; progress lines are dimmed."
			actions={
				<span className="row">
					<Dot tone={live ? "live" : "neutral"} pulse={live} />
					<span className="micro">{status}</span>
				</span>
			}
			flush
		>
			{events.length === 0 ? (
				<EmptyState title="No events yet" />
			) : (
				<ul className="threads-feed" ref={listRef}>
					{events.map(event => (
						<li key={event.seq} className="threads-event" data-lifecycle={LIFECYCLE_KINDS[event.kind] === true}>
							<time className="micro" dateTime={event.at}>
								{new Date(event.at).toLocaleTimeString()}
							</time>
							<Badge tone={kindTone(event.kind)} mono>
								{event.kind}
							</Badge>
							{event.turn !== null && <span className="micro">#{event.turn}</span>}
							<span className="threads-event-text">{event.text}</span>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}
