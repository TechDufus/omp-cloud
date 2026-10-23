/** The dashboard's entry: the frame guard, the sign-in flow, then the app. */
import { createRoot } from "react-dom/client";
import { getSession, getWhoami, onUnauthorized, signIn, signOut, type Whoami } from "./api";
import { App } from "./app/App";
import { messageOf } from "./app/query";
import { SessionProvider } from "./app/session";
import { pendingUpdateVersion } from "./app/update-context";
import { type Live, startLive } from "./live";
import { SignIn } from "./pages/SignIn";

/** The running signed-in session's event stream; `null` while signed out. */
let live: Live | null = null;

function stopSession(): void {
	live?.close();
	live = null;
}

/** Why the session ended: the restart of an update this browser asked for, else `otherwise`. */
function endedNotice(otherwise: string): string {
	const version = pendingUpdateVersion();
	return version === null ? otherwise : `omp-cloud restarted to update to ${version}, which ends dashboard sessions. Sign in again.`;
}

/** Inside a frame render nothing: the page must not be clickjacked. */
if (window.top === window.self) {
	const container = document.getElementById("app");
	if (!container) throw new Error("index.html has no #app element");
	const root = createRoot(container);

	const showSignIn = (notice: string): void => {
		stopSession();
		root.render(<SignIn notice={notice} onSignedIn={() => void start()} />);
	};

	const startSession = (user: string, identity: Whoami): void => {
		stopSession();
		const stream = startLive(() => showSignIn(endedNotice("The connection to the service was lost and your session ended.")));
		live = stream;
		const value = {
			user,
			identity,
			live: stream,
			async signOut() {
				await signOut();
				showSignIn("");
			},
		};
		root.render(
			<SessionProvider value={value}>
				<App />
			</SessionProvider>,
		);
	};

	/** Signs in from the one-time code in the URL fragment, if any, then shows the dashboard or the sign-in form. */
	const start = async (): Promise<void> => {
		let notice = "";
		// Fragment routes start with "/"; anything else is a sign-in code.
		const code = window.location.hash.slice(1);
		if (code !== "" && !code.startsWith("/")) {
			// The code is single use, but keep it out of history and the address bar before anything else happens.
			window.history.replaceState(null, "", window.location.pathname + window.location.search);
			try {
				await signIn({ code });
			} catch (error) {
				notice = `The sign-in link was not accepted (${messageOf(error)}). Ask for a new one.`;
			}
		}
		try {
			const current = await getSession();
			if (current === null) showSignIn(notice);
			else startSession(current.user, await getWhoami());
		} catch (error) {
			showSignIn(`Cannot reach the service: ${messageOf(error)}`);
		}
	};

	onUnauthorized(() => showSignIn(endedNotice("Your session ended. Sign in again.")));
	void start();
}
