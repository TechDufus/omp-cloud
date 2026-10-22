import { effectiveCommitter } from "../git/committer";
import { SigningKeyError, type SigningKey } from "../git/signing-key";
import type { GitHubApi } from "../github/api";
import type { GitHubApp } from "../github/app";
import { isRecord } from "../guards";
import type { Settings } from "../settings";
import { ApiError } from "./errors";

const NOT_FOUND = "not found";

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Whether the GitHub account `login` holds `publicKey` (`ssh-ed25519 <base64> …`) as a signing key. Throws on any GitHub failure. */
async function registeredOn(api: GitHubApi, login: string, publicKey: string): Promise<boolean> {
	const { json: keys } = await api.request<unknown>("GET", `/users/${encodeURIComponent(login)}/ssh_signing_keys?per_page=100`, { kind: "none" });
	if (!Array.isArray(keys)) throw new Error("GitHub's list of signing keys is not an array");
	const [type, blob] = publicKey.split(" ");
	return keys.some((entry) => {
		if (!isRecord(entry) || typeof entry.key !== "string") return false;
		const [entryType, entryBlob] = entry.key.split(" ");
		return entryType === type && entryBlob === blob;
	});
}

/**
 * The routes under `/api/v1/signing`; `segments` is the path after it: the service's SSH signing key (its public half,
 * the effective committer and whether the App owner's GitHub account holds the key), making it and deleting it. Answers
 * `404` for any other path or method. Authentication and the owner-only scope are the caller's.
 */
export async function handleSigning(
	req: Request,
	segments: string[],
	deps: { key: SigningKey; app: GitHubApp; api: GitHubApi; settings: Pick<Settings, "get"> },
): Promise<Response> {
	const { key, app, api, settings } = deps;
	const [action, ...rest] = segments;
	if (rest.length > 0) throw new ApiError(404, NOT_FOUND);
	if (action === undefined) {
		if (req.method !== "GET") throw new ApiError(404, NOT_FOUND);
		const publicKey = key.publicKey();
		const committer = effectiveCommitter(settings.get("git.committer"), app);
		const owner = app.info()?.owner;
		let github: { login: string; registered: boolean | null; error: string } | null = null;
		if (owner !== undefined && owner.type === "User") {
			github = { login: owner.login, registered: null, error: "" };
			if (publicKey !== null) {
				try {
					github.registered = await registeredOn(api, owner.login, publicKey);
				} catch (error) {
					github.error = error instanceof Error ? error.message : String(error);
				}
			}
		}
		return json(200, {
			publicKey,
			fingerprint: key.fingerprint(),
			createdAt: key.createdAt(),
			committer: committer === null ? null : `${committer.name} <${committer.email}>`,
			github,
		});
	}
	if (action !== "key") throw new ApiError(404, NOT_FOUND);
	if (req.method === "POST") {
		try {
			return json(201, key.create());
		} catch (error) {
			if (error instanceof SigningKeyError && error.kind === "exists") throw new ApiError(409, error.message);
			throw error;
		}
	}
	if (req.method === "DELETE") {
		key.remove();
		return json(202, { status: "deleted" });
	}
	throw new ApiError(404, NOT_FOUND);
}
