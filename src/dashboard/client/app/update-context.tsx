/** The service's own update as every page sees it: one status query, the pill derived from it, and the actions. */
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { applyUpdate, checkUpdate, getUpdate, type UpdateStatus } from "../api";
import { messageOf, useQuery } from "./query";
import { isMoving, type Pill, pendingStillApplies, pillOf } from "./update";

/** The version this browser asked to apply, kept across the restart that signs it out. */
const PENDING_KEY = "omp-cloud-update-pending";
/** The release whose "Updated to" pill this browser dismissed. */
const SEEN_KEY = "omp-cloud-update-seen";

const IDLE_POLL_MS = 60_000;
/** While a check, download or apply runs, or this browser waits for the swap. */
const MOVING_POLL_MS = 2_000;

export interface UpdateValue {
	/** The latest status; undefined until the first call succeeds. */
	status: UpdateStatus | undefined;
	/** Why the status call failed, while no status has arrived. */
	failure: string | null;
	pill: Pill | null;
	/** An apply or check request is in flight. */
	busy: boolean;
	apply: () => Promise<void>;
	check: () => Promise<void>;
	/** Hides the "Updated to" pill of this release. */
	dismiss: () => void;
	refetch: () => void;
}

const UpdateContext = createContext<UpdateValue | null>(null);

export function useUpdate(): UpdateValue {
	const value = useContext(UpdateContext);
	if (value === null) throw new Error("useUpdate outside UpdateProvider");
	return value;
}

/** The version a signed-out browser was waiting for; the sign-in screen explains the restart with it. */
export function pendingUpdateVersion(): string | null {
	return localStorage.getItem(PENDING_KEY);
}

function remember(key: string, value: string | null): void {
	if (value === null) localStorage.removeItem(key);
	else localStorage.setItem(key, value);
}

export function UpdateProvider({ children }: { children: ReactNode }) {
	const [pending, setPending] = useState<string | null>(pendingUpdateVersion);
	const [seen, setSeen] = useState<string | null>(() => localStorage.getItem(SEEN_KEY));
	const [refusal, setRefusal] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [pollMs, setPollMs] = useState(IDLE_POLL_MS);
	const query = useQuery(["update"], () => getUpdate(), { refetchMs: pollMs });
	const status = query.data;

	const moving = isMoving(status, pending);
	useEffect(() => {
		setPollMs(moving ? MOVING_POLL_MS : IDLE_POLL_MS);
	}, [moving]);

	// A refused click is shown until the next status arrives.
	useEffect(() => {
		setRefusal(null);
	}, [status]);

	// The marker ends once the new version runs or the apply stopped.
	useEffect(() => {
		if (status === undefined || pending === null || pendingStillApplies(status, pending)) return;
		remember(PENDING_KEY, null);
		setPending(null);
	}, [status, pending]);

	const pill = pillOf({ status, pending, seen, unreachable: query.error !== undefined, refusal, now: Date.now() });

	async function run(action: () => Promise<void>): Promise<void> {
		setBusy(true);
		setRefusal(null);
		try {
			await action();
		} catch (failure) {
			setRefusal(messageOf(failure));
		} finally {
			setBusy(false);
		}
	}

	const value: UpdateValue = {
		status,
		failure: status === undefined && query.error !== undefined ? messageOf(query.error) : null,
		pill,
		busy,
		apply: () =>
			run(async () => {
				const { applying } = await applyUpdate();
				remember(PENDING_KEY, applying.version);
				setPending(applying.version);
				query.refetch();
			}),
		check: () =>
			run(async () => {
				await checkUpdate();
				query.refetch();
			}),
		dismiss: () => {
			if (pill?.kind !== "updated") return;
			remember(SEEN_KEY, pill.version);
			setSeen(pill.version);
		},
		refetch: query.refetch,
	};
	return <UpdateContext value={value}>{children}</UpdateContext>;
}
