/** The cloud inbox: what the user's own threads reported while they were working elsewhere, until they look at it. */

/** What happened: a turn finished, a turn failed, or the agent asked a question. */
export type InboxKind = "result" | "failure" | "question";

export interface InboxEntry {
	thread: string;
	/** The turn that finished, failed or asked. */
	turn: number;
	kind: InboxKind;
	/** The thread's name, else its title. */
	label: string;
	/** The first line of the reply, error or question. */
	line: string;
	/** Epoch ms. */
	at: number;
	/** A question that asks for an approval (`approval:*`) or for the push: a terminal marks it as a permission. Absent otherwise. */
	permission?: boolean;
	/** The question's id within its turn; set on question entries. */
	questionId?: number;
	read: boolean;
}

/** Entries kept; the oldest read ones go first. */
const KEEP = 200;

/** In-memory, per `Cloud`: the entries and their read state. Listeners hear every change. */
export class Inbox {
	readonly #entries: InboxEntry[] = [];
	readonly #listeners: (() => void)[] = [];

	add(entry: Omit<InboxEntry, "read">): void {
		this.#entries.push({ ...entry, read: false });
		while (this.#entries.length > KEEP) {
			const at = this.#entries.findIndex(e => e.read);
			this.#entries.splice(at === -1 ? 0 : at, 1);
		}
		this.#changed();
	}

	get entries(): readonly InboxEntry[] {
		return this.#entries;
	}

	get unread(): number {
		return this.#entries.filter(e => !e.read).length;
	}

	unreadFor(thread: string): number {
		return this.#entries.filter(e => e.thread === thread && !e.read).length;
	}

	/** Marks every entry of `thread` read; the listeners hear it only when something changed. */
	read(thread: string): void {
		let changed = false;
		for (const e of this.#entries) {
			if (e.thread === thread && !e.read) {
				e.read = true;
				changed = true;
			}
		}
		if (changed) this.#changed();
	}

	/** Marks the thread's entries of `kind` read, for a question that was answered; the listeners hear it only when something changed. */
	resolve(thread: string, kind: InboxKind): void {
		let changed = false;
		for (const e of this.#entries) {
			if (e.thread === thread && e.kind === kind && !e.read) {
				e.read = true;
				changed = true;
			}
		}
		if (changed) this.#changed();
	}

	/** Whether the question `id` of `turn` was already entered (read or not): a thread watched again must not enter it twice. */
	hasQuestion(thread: string, turn: number, id: number): boolean {
		return this.#entries.some(e => e.thread === thread && e.kind === "question" && e.turn === turn && e.questionId === id);
	}

	/** Drops every entry of `thread` (it was deleted); the listeners hear it only when something changed. */
	forget(thread: string): void {
		this.#drop(e => e.thread === thread);
	}

	/** Drops the entries of every thread that is not in `threads`: the service no longer has them. */
	keepOnly(threads: Iterable<string>): void {
		const known = new Set(threads);
		this.#drop(e => !known.has(e.thread));
	}

	#drop(gone: (e: InboxEntry) => boolean): void {
		const before = this.#entries.length;
		const kept = this.#entries.filter(e => !gone(e));
		if (kept.length === before) return;
		this.#entries.splice(0, before, ...kept);
		this.#changed();
	}

	onChange(listener: () => void): void {
		this.#listeners.push(listener);
	}

	#changed(): void {
		for (const l of this.#listeners) l();
	}
}
