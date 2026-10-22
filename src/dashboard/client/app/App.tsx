import { useEffect, useRef } from "react";
import { DevicesPage } from "../pages/DevicesPage";
import { GitHubPage } from "../pages/GitHubPage";
import { LoginsPage } from "../pages/LoginsPage";
import { OverviewPage } from "../pages/OverviewPage";
import { SettingsPage } from "../pages/SettingsPage";
import { SpendPage } from "../pages/SpendPage";
import { ThreadsPage } from "../pages/ThreadsPage";
import { VmsPage } from "../pages/VmsPage";
import { Shell } from "./Shell";
import { runGithubReturn } from "./github-return";
import { type PageId, useRoute } from "./route";
import { UpdateProvider } from "./update-context";

/** The signed-in dashboard: the shell around the page the route names. */
export function App() {
	const route = useRoute();

	// Returning from GitHub (`/?code=…&state=…`): finish the App's creation and land on the GitHub page.
	useEffect(() => runGithubReturn(), []);

	// Visited pages stay mounted (hidden) so revisits are instant and keep their UI state; only the active page fetches (`active`).
	const mounted = useRef(new Set<PageId>());
	mounted.current.add(route.page);

	const render = (target: PageId) => {
		const active = target === route.page;
		switch (target) {
			case "overview":
				return <OverviewPage active={active} />;
			case "threads":
				return <ThreadsPage active={active} threadId={route.threadId} />;
			case "spend":
				return <SpendPage active={active} />;
			case "vms":
				return <VmsPage active={active} />;
			case "devices":
				return <DevicesPage active={active} />;
			case "logins":
				return <LoginsPage active={active} />;
			case "github":
				return <GitHubPage active={active} />;
			case "settings":
				return <SettingsPage active={active} />;
		}
	};

	return (
		<UpdateProvider>
			<Shell page={route.page}>
				{[...mounted.current].map(target => (
					<div key={target} hidden={target !== route.page}>
						{render(target)}
					</div>
				))}
			</Shell>
		</UpdateProvider>
	);
}
