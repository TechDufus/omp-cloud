/**
 * Pushing a turn's result to the thread's remote: the policy (`git.push`, `git.branch`, `git.protected`), the
 * question that asks the owner under `ask`, and the push itself, which the service makes from its git cache. The VM never
 * pushes. The step runs after the turn's git work and before the turn completes, so the outcome lands on the turn.
 */
import type { GitService } from "../git";
import type { Settings } from "../settings";
import { THREAD_PLACEHOLDER } from "../settings/registry";
import type { Store } from "../store";
import {
	ANSWERED_BY_STOP,
	ANSWERED_BY_TIMEOUT,
	MAX_OPTION_DESCRIPTION_BYTES,
	MAX_QUESTION_TEXT_BYTES,
	RESULT_BRANCH_PREFIX,
	StoreError,
	type Question,
	type QuestionInput,
	type Thread,
	type Turn,
} from "../store/types";
import { cutBytes } from "./ask";
import { formatDuration } from "./omp-config";

/** The key of the service's own question: the runner tells it from an agent's `ask` by this key and by its missing omp request id. */
export const PUSH_QUESTION_KEY = "omp-cloud:push";
export const PUSH_LABEL = "Push";
export const DECLINE_LABEL = "Do not push";

/** What the turn records: `pushRef` is the remote branch when `pushed`, else `""`. */
export interface PushRecord {
	pushed: boolean;
	pushError: string;
	pushRef: string;
}

/** No push was attempted (or it was declined): nothing to report. */
export const NOT_PUSHED: PushRecord = { pushed: false, pushError: "", pushRef: "" };

/** What decides whether a finished turn's result is pushed at all. */
export interface PushFacts {
	mode: "never" | "ask" | "auto";
	outcome: "completed" | "failed";
	/** The turn was stopped. */
	stopped: boolean;
	/** The turn's head after git finalize; `""` when it produced none. */
	head: string;
	handoffCommit: string;
	/** The head of the newest turn that was pushed; `""` when none was. */
	pushedHead: string;
	remoteURL: string;
}

/** Whether the result is worth a push: a finished, unstopped turn with a new head on a thread that has a remote, and a policy that allows it. */
export function pushEligible(facts: PushFacts): boolean {
	return (
		facts.mode !== "never" &&
		facts.outcome === "completed" &&
		!facts.stopped &&
		facts.head !== "" &&
		facts.head !== facts.handoffCommit &&
		facts.head !== facts.pushedHead &&
		facts.remoteURL !== ""
	);
}

/** The remote branch for a thread: the `git.branch` template with `{thread}` replaced by the thread id. */
export function pushTarget(template: string, threadId: string): string {
	return template.replaceAll(THREAD_PLACEHOLDER, threadId);
}

/** The question `ask` mode puts to the owner. */
export function pushQuestion(input: { target: string; remote: string; head: string }): QuestionInput {
	const description = `push ${input.head.slice(0, 8)} to ${input.remote} as ${input.target}`;
	return {
		key: PUSH_QUESTION_KEY,
		text: cutBytes(`Push ${input.target} to ${input.remote}?`, MAX_QUESTION_TEXT_BYTES),
		header: "Push",
		options: [
			{ label: PUSH_LABEL, description: cutBytes(description, MAX_OPTION_DESCRIPTION_BYTES) },
			{ label: DECLINE_LABEL, description: "keep the result on the service" },
		],
		multi: false,
		recommended: 0,
		ompKey: PUSH_QUESTION_KEY,
		ompLabels: [PUSH_LABEL, DECLINE_LABEL],
	};
}

/** How the push question ended. */
export type PushAnswer =
	| { kind: "push" }
	| { kind: "declined"; by: string }
	| { kind: "expired" }
	/** A stop closed it. */
	| { kind: "stopped" };

/** What the stored question says; null while nobody answered it. Only exactly `["Push"]` pushes. */
export function pushAnswer(question: Question): PushAnswer | null {
	if (question.answeredAt === null) return null;
	if (question.answeredBy === ANSWERED_BY_STOP) return { kind: "stopped" };
	if (question.expired) return { kind: "expired" };
	if (question.selected.length === 1 && question.selected[0] === PUSH_LABEL) return { kind: "push" };
	return { kind: "declined", by: question.answeredBy };
}

/** The note an expired push question carries. */
export function pushExpiredAnswer(timeoutSeconds: number): string {
	return `No answer within ${formatDuration(timeoutSeconds)}; the result was not pushed.`;
}

/** What a push step needs from the service and its turn. */
export interface PushDeps {
	store: Store;
	git: Pick<GitService, "normalize" | "pushRefusal" | "push">;
	settings: Pick<Settings, "get">;
	/** `runner.questionTimeoutSeconds` */
	questionTimeoutSeconds: number;
	/** The turn's clock: it stands still while the question is open. */
	clock: { pause(): void; resume(): void };
	/** Appends an event of kind `push` to the turn. */
	event(text: string): void;
}

/** The facts of the turn's end that the step cannot read from the store. */
export interface PushRun {
	outcome: "completed" | "failed";
	/** The turn was stopped. */
	stopped: boolean;
	/** The turn's head after git finalize. */
	head: string;
}

function isMissingThread(error: unknown): boolean {
	return error instanceof StoreError && error.code === "thread_not_found";
}

/**
 * The push of one turn's result. `run` decides, asks when the policy says so and pushes; the thread runner forwards
 * `recheck` (an answer or an expiry landed) and `cancel` (the runner is going away) to it. The question is the
 * service's own: it is never an omp ask, so nothing is ever sent to omp.
 */
export class PushStep {
	/** Ends the wait for the answer; set while the question is open. */
	#wait: ((answer: PushAnswer | null) => void) | null = null;

	constructor(
		private readonly deps: PushDeps,
		private readonly thread: Thread,
		private readonly turn: Turn,
	) {}

	/** The record for `completeTurn`; null when the runner went away while the question was open (the turn stays running). */
	async run(input: PushRun): Promise<PushRecord | null> {
		try {
			return await this.#run(input);
		} catch (error) {
			if (isMissingThread(error)) return null;
			return this.#failed(`git push failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** An answer or an expiry landed: ends the wait when the push question is settled. */
	recheck(): void {
		const finish = this.#wait;
		if (finish === null) return;
		let question: Question | undefined;
		try {
			question = this.#question();
		} catch (error) {
			if (isMissingThread(error)) finish(null);
			return;
		}
		const answer = question === undefined ? null : pushAnswer(question);
		if (answer !== null) finish(answer);
	}

	/** The runner is stopping or the thread was deleted: ends the wait without an answer. */
	cancel(): void {
		this.#wait?.(null);
	}

	async #run(input: PushRun): Promise<PushRecord | null> {
		const { store, git, settings } = this.deps;
		const { thread } = this;
		// A lost VM may have requeued the turn while it was being finalized: its result is discarded, so nothing is pushed.
		if (store.turns(thread.id).find(t => t.id === this.turn.id)?.state !== "running") return NOT_PUSHED;
		const mode = settings.get("git.push");
		const pushedHead = store.turns(thread.id).findLast(t => t.pushed)?.head ?? "";
		const eligible = pushEligible({
			mode,
			outcome: input.outcome,
			stopped: input.stopped,
			head: input.head,
			handoffCommit: thread.repo.handoffCommit,
			pushedHead,
			remoteURL: thread.repo.remoteURL,
		});
		if (!eligible) return NOT_PUSHED;

		const target = pushTarget(settings.get("git.branch"), thread.id);
		const protectedPatterns = settings.get("git.protected");
		const refusal = git.pushRefusal(thread.repo.remoteURL, target, protectedPatterns);
		if (refusal !== null) return this.#failed(refusal);
		const remote = git.normalize(thread.repo.remoteURL);
		if ((await store.blob(thread.id, "result.bundle")) === null) return this.#failed("the result bundle is not stored");

		if (mode === "ask") {
			const answer = await this.#ask({ target, remote, head: input.head });
			if (answer === null) return null;
			if (answer.kind === "declined") this.deps.event(`push declined by ${answer.by}`);
			else if (answer.kind === "expired") this.deps.event("push question expired");
			if (answer.kind !== "push") return NOT_PUSHED;
		}

		const outcome = await git.push(thread.id, {
			remoteURL: thread.repo.remoteURL,
			bundlePath: store.blobPath(thread.id, "result.bundle"),
			localBranch: RESULT_BRANCH_PREFIX + thread.id,
			head: input.head,
			target,
			protectedPatterns,
		});
		if (!outcome.pushed) return this.#failed(outcome.error);
		this.deps.event(`pushed ${target} to ${remote}`);
		return { pushed: true, pushError: "", pushRef: target };
	}

	#failed(error: string): PushRecord {
		this.deps.event(`push failed: ${error}`);
		return { pushed: false, pushError: error, pushRef: "" };
	}

	/** The turn's newest push question of the service's own (no omp request id): a model `ask` with the same key is never it. */
	#question(): Question | undefined {
		return this.deps.store
			.turns(this.thread.id)
			.find(t => t.id === this.turn.id)
			?.questions.findLast(q => q.key === PUSH_QUESTION_KEY && q.requestId === null);
	}

	/**
	 * Puts the question to the owner and waits for its answer; a question an earlier run of this turn left (a service
	 * restart redelivers the turn) is reused, answered or not, instead of asked again. Null when cancelled.
	 */
	async #ask(input: { target: string; remote: string; head: string }): Promise<PushAnswer | null> {
		const { store, clock, questionTimeoutSeconds } = this.deps;
		let question = this.#question();
		if (question === undefined) {
			try {
				question = store.askQuestions(this.thread.id, this.turn.id, [pushQuestion(input)], null).questions[0];
			} catch (error) {
				// A stop got in first: nobody is left to ask.
				if (error instanceof StoreError && error.code === "turn_not_running") return { kind: "stopped" };
				throw error;
			}
		}
		if (question === undefined) throw new Error("the push question vanished");
		const settled = pushAnswer(question);
		if (settled !== null) return settled;

		const { ask } = question;
		const asked = Date.parse(question.askedAt);
		const left = questionTimeoutSeconds * 1000 - (Date.now() - (Number.isNaN(asked) ? Date.now() : asked));
		clock.pause();
		return new Promise<PushAnswer | null>(resolve => {
			const timer = setTimeout(() => {
				try {
					store.expireAsk(this.thread.id, this.turn.id, ask, pushExpiredAnswer(questionTimeoutSeconds), ANSWERED_BY_TIMEOUT);
				} catch (error) {
					if (!isMissingThread(error)) {
						console.error(`omp-cloud: expiring the push question of thread ${this.thread.id} failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}, Math.max(left, 0));
			this.#wait = answer => {
				clearTimeout(timer);
				this.#wait = null;
				clock.resume();
				resolve(answer);
			};
		});
	}
}
