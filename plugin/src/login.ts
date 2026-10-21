/**
 * `/cloud login <provider>`: gives the cloud broker its own login to a provider. The OAuth flow runs
 * on the service host; this side shows the URL, takes the pasted redirect URL or code, and waits.
 */

import type { CloudClient } from "./api";
import { CloudError } from "./errors";
import { UserError, type HostUi, type Login } from "./types";

export type LoginApi = Pick<CloudClient, "startLogin" | "login" | "loginInput" | "cancelLogin">;

export interface RunLoginOptions {
	pollMs?: number;
	/** Gives up waiting after this long; the service fails a login after 5 minutes by itself. */
	maxMs?: number;
	sleep?(ms: number): Promise<void>;
}

/** What to show the owner for a login that is waiting. */
export function loginLines(l: Login): string[] {
	const lines = [`☁ logging the cloud broker in to ${l.provider}`];
	if (l.url) lines.push(`  open: ${l.url}`);
	if (l.userCode) lines.push(`  enter the code: ${l.userCode}`);
	if (l.instructions) lines.push(`  ${l.instructions}`);
	return lines;
}

/**
 * Runs one login to the end and reports it through `ui`. A device-code login needs no input; any
 * other asks the owner to paste the redirect URL or code the browser ended on. Returns the final
 * login; throws a {@link UserError} when the host cannot prompt or the wait runs out.
 */
export async function runLogin(api: LoginApi, ui: HostUi, provider: string, opts: RunLoginOptions = {}): Promise<Login> {
	const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
	let login = await api.startLogin(provider);
	ui.notify(loginLines(login).join("\n"), "info");

	if (login.state === "waiting" && login.userCode === "") {
		if (!ui.input) {
			await api.cancelLogin(login.id).catch(() => {});
			throw new UserError("☁ this host cannot prompt; log in from a TUI or RPC client that can");
		}
		const pasted = (await ui.input(`${provider}: paste the redirect URL or code`, "http://localhost:…/?code=… or the code"))?.trim();
		if (!pasted) {
			await api.cancelLogin(login.id).catch(() => {});
			ui.notify(`☁ login to ${provider} cancelled`, "info");
			return login;
		}
		try {
			login = await api.loginInput(login.id, pasted);
		} catch (e) {
			// 409: it finished (or failed) while the owner was typing
			if (!(e instanceof CloudError && e.status === 409)) throw e;
			login = await api.login(login.id);
		}
	}

	const deadline = Date.now() + (opts.maxMs ?? 6 * 60 * 1000);
	while (login.state === "waiting") {
		if (Date.now() > deadline) throw new UserError(`☁ login to ${provider} did not finish in time`);
		await sleep(opts.pollMs ?? 2000);
		login = await api.login(login.id);
	}
	if (login.state === "done") {
		ui.notify(`☁ the cloud broker is logged in to ${provider}${login.account ? ` as ${login.account}` : ""}`, "info");
	} else {
		ui.notify(`☁ login to ${provider} failed${login.error ? `: ${login.error}` : ""}`, "error");
	}
	return login;
}
