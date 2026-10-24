/**
 * `/cloud login <provider>`: gives the cloud broker its own login to a provider. The OAuth flow runs
 * on the service host; this side hands the sign-in link to a presenter, takes the pasted redirect
 * URL or code, and waits.
 */

import type { CloudClient } from "./api";
import type { PairedConnection } from "./connection";
import { CloudError } from "./errors";
import { parseServerAddress } from "./pairing";
import { usedAddress } from "./transport";
import { UserError, type HostUi, type Login, type LoginList } from "./types";

export type LoginApi = Pick<CloudClient, "startLogin" | "login" | "loginInput" | "cancelLogin">;

/** The host of the server a paired connection uses (the address that answered last, without its port); undefined for a connection that is not paired. */
export function serverHostOf(paired: PairedConnection | undefined): string | undefined {
	if (!paired) return undefined;
	const address = usedAddress(paired.server);
	return parseServerAddress(address)?.host ?? address;
}

/**
 * What the user does to log the broker in to `provider`: a connection with full access runs `/cloud login`; a device with
 * threads-only access cannot, so it is pointed at the server machine, where `omp-cloud login` works.
 */
export function userLoginStep(provider: string, serverHost: string | undefined, full: boolean): string {
	if (full || serverHost === undefined) return `run /cloud login ${provider}`;
	return `run omp-cloud login ${provider} on ${serverHost} (over ssh: ssh -t <user>@${serverHost} '~/.local/bin/omp-cloud login ${provider}')`;
}

/** What to tell the user who needs the broker logged in to `provider`. */
export function loginHint(provider: string, serverHost: string | undefined, full: boolean): string {
	return full || serverHost === undefined ? `/cloud login ${provider}` : `log the server in: ${userLoginStep(provider, serverHost, full)}`;
}

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

/** `/cloud login` with no provider: what the cloud is logged in to, one line each, and how to log it in to more. */
export function loginListLines(list: LoginList): string[] {
	const lines = ["☁ the cloud is logged in to:"];
	for (const e of list.logins) {
		if (e.disabled) {
			lines.push(`  ${e.provider} · disabled: ${e.note}`);
			continue;
		}
		const parts = [e.provider];
		if (e.account) parts.push(e.account);
		if (e.loggedInAt) parts.push(`logged in ${e.loggedInAt.slice(0, 10)}`);
		if (e.renewBy) parts.push(`renew by ${e.renewBy.slice(0, 10)}`);
		lines.push(`  ${parts.join(" · ")}`);
	}
	if (list.logins.length === 0) lines.push("  nothing yet");
	if (list.brokerError) lines.push(`  ! ${list.brokerError}`);
	lines.push("  /cloud login <provider> logs the cloud in (again)");
	return lines;
}

/**
 * Runs one login to the end and reports it through `ui`. `show` presents the sign-in link (and the
 * device code, when there is one) once, right after the login starts, and only while it waits: the
 * caller picks where it goes (a transcript card, or a notification). A device-code login needs no
 * input; any other asks the owner to paste the redirect URL or code the browser ended on. Returns
 * the final login; throws a {@link UserError} when the host cannot prompt or the wait runs out.
 */
export async function runLogin(api: LoginApi, ui: HostUi, provider: string, show: (login: Login) => void, opts: RunLoginOptions = {}): Promise<Login> {
	const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
	let login = await api.startLogin(provider);
	if (login.state === "waiting") show(login);

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
