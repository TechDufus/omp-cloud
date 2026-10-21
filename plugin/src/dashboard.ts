/**
 * `/cloud dashboard`: asks the service for a one-time sign-in link to its dashboard and shows it. The link
 * carries a code, not the API token; the token is never printed. On a paired connection the dashboard is reached
 * through the loopback forwarder, and the link carries a code minted locally.
 */

import type { CloudClient } from "./api";
import { CloudError } from "./errors";
import type { DashboardForwarder } from "./forwarder";
import { UserError, type DashboardLink, type HostUi } from "./types";

export type DashboardApi = Pick<CloudClient, "createDashboardLink">;

/** What to show the owner for a minted link. */
export function dashboardLines(link: DashboardLink): string[] {
	return [`☁ dashboard: ${link.url}`, "  one use, valid 60 s"];
}

/** Mints a local one-time code on the forwarder and reports the link through `ui`. */
export function showForwardedDashboard(forwarder: Pick<DashboardForwarder, "origin" | "mintCode">, ui: Pick<HostUi, "notify">): DashboardLink {
	const { code, expiresAt } = forwarder.mintCode();
	const link = { url: `${forwarder.origin}/#${code}`, expiresAt };
	ui.notify(dashboardLines(link).join("\n"), "info");
	return link;
}

/** Mints a link and reports it through `ui`. Throws a {@link UserError} when the service has no dashboard. */
export async function runDashboard(api: DashboardApi, ui: Pick<HostUi, "notify">): Promise<DashboardLink> {
	let link: DashboardLink;
	try {
		link = await api.createDashboardLink();
	} catch (e) {
		if (e instanceof CloudError && e.status === 404) {
			throw new UserError("☁ the service has no dashboard: add a dashboard section (listen) to its service.json");
		}
		throw e;
	}
	ui.notify(dashboardLines(link).join("\n"), "info");
	return link;
}
