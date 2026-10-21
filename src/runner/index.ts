/**
 * The runner: follows the store's event feed and gives every live thread a {@link ThreadRunner}, which owns the
 * thread's VM and omp. `Runner.start` first reconciles the store's VM records, vmon's sandboxes and the gateway's
 * clients, so that a service restart neither leaks sandboxes nor loses a running turn.
 */
import type { Config } from "../config";
import type { GatewayClients } from "../gateway/clients";
import type { GatewayModels } from "../gateway/models";
import type { GitService } from "../git";
import type { Settings } from "../settings";
import type { Store } from "../store";
import type { Vmon } from "../vmon";
import { archiveSweep, sweepOrphans } from "./lifecycle";
import { clientName, loseVm, releaseVm, serviceClientName, ThreadRunner, type ThreadEnv } from "./thread";

/** The first sweep runs this long after the start (sooner when the sweep interval is shorter). */
const FIRST_SWEEP_SECONDS = 60;
/** `stop` waits this long for a sweep in progress. */
const SWEEP_STOP_WAIT_MS = 5000;

export interface RunnerOptions {
	store: Store;
	vmon: Vmon;
	gateway: GatewayClients;
	/** Which providers the gateway serves; its client (`serviceClientName`) is never revoked by reconcile. */
	models: GatewayModels;
	config: Config;
	/** The run-time settings, handed to every thread runner. */
	settings: Settings;
	/** Completes delta handoffs to the full history each VM restores from. */
	git: GitService;
	/** The service host's omp version. */
	ompVersion: string;
}

export class Runner {
	readonly #env: ThreadEnv;
	readonly #threads = new Map<string, ThreadRunner>();
	#unsubscribe: (() => void) | undefined;
	#sweepTimer: Timer | undefined;
	/** The sweep in progress, resolved when none runs. */
	#sweeping: Promise<void> = Promise.resolve();
	#stopped = false;

	private constructor(env: ThreadEnv) {
		this.#env = env;
	}

	/** Reconciles with vmon and the gateway clients file, subscribes to the store, resumes pending work. */
	static async start(options: RunnerOptions): Promise<Runner> {
		const runner = new Runner({ ...options, serviceId: options.store.serviceId() });
		await runner.#reconcile();
		runner.#unsubscribe = options.store.subscribeAll({
			// Listeners must not touch the store themselves: every reaction waits for the next microtask.
			event: (threadId, event) => {
				switch (event.kind) {
					case "turn_queued":
						queueMicrotask(() => runner.#wake(threadId));
						break;
					case "stop_requested":
						queueMicrotask(() => {
							if (event.turn !== null) runner.#threads.get(threadId)?.onStopRequested(event.turn);
						});
						break;
					case "question_answered":
					case "question_expired":
						queueMicrotask(() => runner.#threads.get(threadId)?.recheckAsks());
						break;
					case "irc_in":
						queueMicrotask(() => runner.#threads.get(threadId)?.onIrcQueued());
						break;
					default:
						break;
				}
			},
			deleted: threadId => {
				queueMicrotask(() => void runner.#remove(threadId));
			},
		});
		for (const id of options.store.workThreadIds()) runner.#wake(id);
		for (const record of options.store.vms()) {
			if (record.state === "running" && runner.#isLive(record.threadId) && !options.store.workThreadIds().includes(record.threadId)) {
				runner.#thread(record.threadId).scheduleIdle();
			}
		}
		runner.#scheduleSweep(Math.min(FIRST_SWEEP_SECONDS, options.config.runner.lifecycleSweepSeconds));
		// The template of the host's omp for the installed vmon, built in the background when missing (never throws).
		void options.vmon.prebuildTemplate(options.ompVersion);
		return runner;
	}

	/** Stops the sweeps, unsubscribes and detaches from every omp (VMs keep their state). */
	async stop(): Promise<void> {
		this.#stopped = true;
		clearTimeout(this.#sweepTimer);
		this.#sweepTimer = undefined;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		await Promise.all([...this.#threads.values()].map(thread => thread.detach()));
		await Promise.race([this.#sweeping, Bun.sleep(SWEEP_STOP_WAIT_MS)]);
		this.#threads.clear();
	}

	/** Runs one sweep after `delaySeconds`, then the next one `lifecycleSweepSeconds` after it ended. */
	#scheduleSweep(delaySeconds: number): void {
		this.#sweepTimer = setTimeout(() => {
			this.#sweeping = this.#sweep().finally(() => {
				if (!this.#stopped) this.#scheduleSweep(this.#env.config.runner.lifecycleSweepSeconds);
			});
		}, delaySeconds * 1000);
	}

	/** The archive sweep, then the orphan sweep; each failure is logged and leaves the work to the next sweep. */
	async #sweep(): Promise<void> {
		try {
			await archiveSweep(this.#env, threadId => this.#thread(threadId), Date.now(), () => this.#stopped);
		} catch (error) {
			console.error(`omp-cloud: the archive sweep failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			await sweepOrphans(this.#env, this.#env.config.runner.lifecycleSweepSeconds, Date.now());
		} catch (error) {
			console.error(`omp-cloud: the orphan sweep failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#thread(threadId: string): ThreadRunner {
		let thread = this.#threads.get(threadId);
		if (thread === undefined) {
			thread = new ThreadRunner(this.#env, threadId);
			this.#threads.set(threadId, thread);
		}
		return thread;
	}

	/** A thread that can still run: neither deleted nor failed. */
	#isLive(threadId: string): boolean {
		const thread = this.#env.store.getThread(threadId);
		return thread !== null && thread.phase !== "failed";
	}

	#wake(threadId: string): void {
		if (this.#isLive(threadId)) this.#thread(threadId).wake();
	}

	/** The thread was deleted: tear its VM down. */
	async #remove(threadId: string): Promise<void> {
		const thread = this.#thread(threadId);
		try {
			await thread.teardown();
		} catch (error) {
			console.error(`omp-cloud: tearing down the VM of thread ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.#threads.delete(threadId);
	}

	/** Brings the VM records, the sandboxes and the gateway clients of this service into agreement. */
	async #reconcile(): Promise<void> {
		const { store, vmon, gateway, serviceId } = this.#env;
		const sandboxes = await vmon.list({ app: "omp-cloud", service: serviceId });
		const listed = new Map(sandboxes.map(sandbox => [sandbox.sandboxId, sandbox]));
		const kept = new Set<string>();

		for (const record of store.vms()) {
			if (!this.#isLive(record.threadId)) {
				await releaseVm(this.#env, record.threadId, listed.has(record.sandboxId));
				continue;
			}
			const sandbox = listed.get(record.sandboxId);
			if (sandbox === undefined) {
				await loseVm(this.#env, record.threadId);
				continue;
			}
			kept.add(record.sandboxId);
			if (sandbox.state !== record.state) store.putVm({ ...record, state: sandbox.state });
		}

		for (const sandbox of sandboxes) {
			if (kept.has(sandbox.sandboxId)) continue;
			try {
				await vmon.kill(sandbox.sandboxId);
			} catch (error) {
				console.error(`omp-cloud: killing the stray sandbox ${sandbox.sandboxId} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const prefix = clientName(serviceId, "");
		const keep = serviceClientName(serviceId);
		for (const name of await gateway.names()) {
			if (!name.startsWith(prefix) || name === keep) continue;
			const threadId = name.slice(prefix.length);
			if (store.vm(threadId) !== null && this.#isLive(threadId)) continue;
			await gateway.revoke(name);
		}
	}
}
