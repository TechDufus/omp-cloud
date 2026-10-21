/**
 * The dashboard session handoff of an update restart (Tern's daemon handoff, for sign-ins). The dashboard's sessions are
 * in memory, so the restart an update needs would sign every browser out. When the applier restarts the service for an
 * update, the old process writes its live sessions (the SHA-256 of each session id with its times, never a cookie) to
 * `<dataDir>/dashboard-sessions.handoff` on its way down, and the new one takes them over at start if the file is
 * younger than 2 minutes, deleting it either way. Any other restart writes nothing, so it signs everyone out.
 */
import { open, readFile, rename, rm } from "node:fs/promises";
import { isRecord } from "../guards";
import { type DashboardSessions, type HandedSession } from "./session";

export const HANDOFF_FILE = "dashboard-sessions.handoff";
/** A handoff older than this belongs to an update that ended long ago. */
export const HANDOFF_MAX_AGE_MS = 2 * 60_000;
const MAX_HANDOFF_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

/** Writes the handoff atomically with mode 0600 (a temporary file beside it, renamed over). */
export async function writeSessionHandoff(path: string, sessions: DashboardSessions, now: number = Date.now()): Promise<number> {
	const handed = sessions.exportSessions();
	const temp = `${path}.tmp-${process.pid}`;
	const handle = await open(temp, "w", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify({ version: 1, writtenAt: now, sessions: handed })}\n`);
	} finally {
		await handle.close();
	}
	try {
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
	return handed.length;
}

function parseHandoff(text: string, now: number): HandedSession[] | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(raw) || raw.version !== 1 || typeof raw.writtenAt !== "number" || !Array.isArray(raw.sessions)) return null;
	const age = now - raw.writtenAt;
	if (!Number.isFinite(age) || age < 0 || age >= HANDOFF_MAX_AGE_MS) return null;
	const sessions: HandedSession[] = [];
	for (const entry of raw.sessions) {
		if (!isRecord(entry)) continue;
		const { hash, createdAt, lastSeen } = entry;
		if (typeof hash === "string" && SHA256.test(hash) && typeof createdAt === "number" && typeof lastSeen === "number" && Number.isFinite(createdAt) && Number.isFinite(lastSeen)) {
			sessions.push({ hash, createdAt, lastSeen });
		}
	}
	return sessions;
}

/**
 * Takes over the sessions of the handoff at `path` when it is fresh, and deletes the file whatever it held (a stale,
 * damaged or oversized one is ignored). Returns how many sessions were taken. Never throws.
 */
export async function importSessionHandoff(path: string, sessions: DashboardSessions, now: number = Date.now()): Promise<number> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return 0;
	}
	await rm(path, { force: true }).catch(() => undefined);
	if (text.length > MAX_HANDOFF_BYTES) return 0;
	const handed = parseHandoff(text, now);
	return handed === null ? 0 : sessions.importSessions(handed);
}

/** On the way down: writes the handoff when `updating` says this restart is an update's, else nothing. Never throws; returns how many sessions were written. */
export async function handOffSessions(path: string, sessions: DashboardSessions, updating: () => Promise<boolean>, now: () => number = Date.now): Promise<number> {
	try {
		return (await updating()) ? await writeSessionHandoff(path, sessions, now()) : 0;
	} catch (error) {
		console.error(`omp-cloud: the dashboard session handoff failed (everyone signs in again): ${error instanceof Error ? error.message : String(error)}`);
		return 0;
	}
}
