/** The hash router: `#/`, `#/threads`, `#/threads/<id>`, `#/spend`, `#/vms`, `#/devices`, `#/logins`, `#/github`, `#/settings`. */
import { useMemo, useSyncExternalStore } from "react";

export type PageId = "overview" | "threads" | "spend" | "vms" | "devices" | "logins" | "github" | "settings";

export interface Route {
	page: PageId;
	threadId?: string;
}

const PAGES: Readonly<Record<string, PageId>> = {
	threads: "threads",
	spend: "spend",
	vms: "vms",
	devices: "devices",
	logins: "logins",
	github: "github",
	settings: "settings",
};

/** The route a location hash names; anything unknown is the overview. */
function parseHash(hash: string): Route {
	const [, first, second] = hash.split("/");
	const page = first !== undefined && Object.hasOwn(PAGES, first) ? PAGES[first] : undefined;
	if (page === undefined) return { page: "overview" };
	if (page === "threads" && second) return { page, threadId: decodeURIComponent(second) };
	return { page };
}

function subscribe(callback: () => void): () => void {
	window.addEventListener("hashchange", callback);
	return () => window.removeEventListener("hashchange", callback);
}

export function useRoute(): Route {
	const hash = useSyncExternalStore(subscribe, () => window.location.hash);
	return useMemo(() => parseHash(hash), [hash]);
}

/** Goes to `hash` (e.g. `#/threads/abc123`). */
export function navigate(hash: string): void {
	window.location.hash = hash;
}
