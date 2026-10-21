/** The signed-in session as the pages see it: who, the one shared event stream, and how to end it. */
import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { Live } from "../live";

export interface SessionValue {
	user: string;
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

/** Whether the shared event stream is open. */
export function useLiveConnected(): boolean {
	const { live } = useSession();
	return useSyncExternalStore(live.onConnection, live.connected);
}
