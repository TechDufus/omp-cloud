/**
 * The sweeps the runner runs on its timer: the archive sweep releases the VM of a thread nobody touched for
 * `lifecycle.archiveAfterDays` (the thread itself lives on), the orphan sweep removes whatever of this service's sandboxes
 * and gateway clients no VM record holds.
 */
import { clientName, serviceClientName, type ThreadEnv, type ThreadRunner } from "./thread";

/** At most this many threads are archived by one sweep. */
export const ARCHIVE_PER_SWEEP = 5;
const MS_PER_DAY = 86_400_000;
/** A sandbox is created before its VM record is stored, so a young one without a record is no orphan. At least this long. */
const MIN_ORPHAN_GRACE_MS = 10 * 60_000;

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Archives the threads idle since `lifecycle.archiveAfterDays` (read now; 0 never archives), oldest first, one at a time:
 * at most {@link ARCHIVE_PER_SWEEP} attempts, not counting a thread that turned out ineligible or is backed off after a
 * failure. Stops early once `cancelled` says so.
 */
export async function archiveSweep(
	env: ThreadEnv,
	runnerOf: (threadId: string) => Pick<ThreadRunner, "archive">,
	now: number,
	cancelled: () => boolean,
): Promise<void> {
	const days = env.settings.get("lifecycle.archiveAfterDays");
	if (days <= 0) return;
	const cutoff = new Date(now - days * MS_PER_DAY).toISOString();
	let attempts = 0;
	for (const threadId of env.store.archiveCandidates(cutoff)) {
		if (attempts >= ARCHIVE_PER_SWEEP || cancelled()) return;
		if ((await runnerOf(threadId).archive(cutoff, days)) !== "skipped") attempts++;
	}
}

/**
 * Kills this service's sandboxes that no VM record holds and that started more than `max(10 minutes, 2 x sweepSeconds)`
 * ago, and revokes its gateway clients named after a thread that no VM record backs (never the service's own client).
 * The vmon is shared: only sandboxes carrying exactly `{app: "omp-cloud", service}` are looked at. A failure on one
 * item is logged and leaves it for the next sweep.
 */
export async function sweepOrphans(env: ThreadEnv, sweepSeconds: number, now: number): Promise<void> {
	const { store, vmon, gateway, serviceId } = env;
	const graceMs = Math.max(MIN_ORPHAN_GRACE_MS, 2 * sweepSeconds * 1000);

	// Listed before the records are read: a sandbox created in between is young, and its record follows within seconds.
	const sandboxes = await vmon.list({ app: "omp-cloud", service: serviceId });
	const held = new Set(store.vms().map(record => record.sandboxId));
	for (const sandbox of sandboxes) {
		if (held.has(sandbox.sandboxId)) continue;
		const started = Date.parse(sandbox.startedAt);
		// An unreadable start time is never proof of age.
		if (!Number.isFinite(started) || now - started < graceMs) continue;
		try {
			await vmon.kill(sandbox.sandboxId);
			console.log(`omp-cloud: killed the orphaned sandbox ${sandbox.sandboxId}`);
		} catch (error) {
			console.error(`omp-cloud: killing the orphaned sandbox ${sandbox.sandboxId} failed: ${describe(error)}`);
		}
	}

	// The names are read before the records: a thread's record is stored before its client is issued, so a client that is
	// listed already has its record.
	const names = await gateway.names();
	const backed = new Set(store.vms().map(record => record.threadId));
	const prefix = clientName(serviceId, "");
	const own = serviceClientName(serviceId);
	for (const name of names) {
		if (!name.startsWith(prefix) || name === own || backed.has(name.slice(prefix.length))) continue;
		try {
			await gateway.revoke(name);
			console.log(`omp-cloud: revoked the orphaned gateway client ${name}`);
		} catch (error) {
			console.error(`omp-cloud: revoking the orphaned gateway client ${name} failed: ${describe(error)}`);
		}
	}
}
