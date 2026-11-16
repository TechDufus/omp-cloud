/** What the ACP agent's tests share. */

import type { HandoffSummary, LaunchedThread } from "../plugin/src/launch";
import type { ThreadSummary } from "../plugin/src/types";
import { summary } from "../plugin/test/builders";

/** A handoff's summary: a repository with a little uncommitted work, the cloud's default model; override what a test needs. */
export function handoff(over: Partial<HandoffSummary> = {}): HandoffSummary {
	return {
		repo: { name: "app", baseRef: "main", localBranch: "feature" },
		scratch: false,
		base: "",
		commits: 3,
		wip: { files: 2, insertions: 5, deletions: 1 },
		untracked: ["a.txt"],
		untrackedTotal: 1,
		withheld: [],
		secrets: { files: 0, env: 0 },
		conversation: "none",
		setupBytes: 10,
		model: "",
		thinking: "",
		ompVersion: "",
		overlays: [],
		mcp: [],
		setup: null,
		policy: [],
		readOnly: false,
		...over,
	};
}

/** The outcome of a handoff that created `response`. */
export function launched(over: Partial<HandoffSummary> = {}, warnings: string[] = [], response: ThreadSummary = summary()): LaunchedThread {
	return { ok: true, index: 0, response, replayed: false, workspace: "repo", key: response.ref, warnings, summary: handoff(over) };
}
