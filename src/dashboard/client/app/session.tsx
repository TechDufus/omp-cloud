/** The signed-in session as the pages see it: who, what access, the one shared event stream, and how to end it. */
import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { DeviceAccess, Whoami } from "../api";
import type { Live } from "../live";

export interface SessionValue {
	user: string;
	/** What the service said of this connection at sign-in: the cloud's name and the device's access. Read once per sign-in. */
	identity: Whoami;
	live: Live;
	/** Ends the session on the service and shows the sign-in screen. Rejects when the service refuses. */
	signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ value, children }: { value: SessionValue; children: ReactNode }) {
	return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): SessionValue {
	const value = useContext(SessionContext);
	if (value === null) throw new Error("useSession outside SessionProvider");
	return value;
}

/** The tooltip of every control and nav item a device with threads-only access cannot use. */
export const NEEDS_FULL_ACCESS = "Needs full access";

/** The access level of this dashboard: `full` for the owner and a device with full access, else `threads`. */
export function useAccess(): DeviceAccess {
	const { identity } = useSession();
	return identity.device === null ? "full" : identity.device.access;
}

/** Whether the shared event stream is open. */
export function useLiveConnected(): boolean {
	const { live } = useSession();
	return useSyncExternalStore(live.onConnection, live.connected);
}
