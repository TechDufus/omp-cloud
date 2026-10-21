/**
 * The service for the showcase harness (`mise run dashboard:dev -- --showcase`): `src/main.ts` itself, run in this
 * process so a small loopback control port can make the store do what the runner would while the VM works. A second
 * process writing the same database would not do: the event streams the plugin follows are fed in-process.
 *
 *   POST /ask     the waiting thread's agent asks its second question
 *   POST /finish  the working thread's running turn ends with its result
 *
 * The harness starts this instead of `src/main.ts`; the port is written to `showcase-control.json` beside the
 * service's config. Nothing here is part of the product.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "../../src/main";
import { Store } from "../../src/store";
import type { Thread, Turn } from "../../src/store/types";
import { SHOWCASE_FINISH, SHOWCASE_FINISHING_NAME, SHOWCASE_SECOND_QUESTION, SHOWCASE_WAITING_NAME } from "./profile";

const OWNER = "owner";

let store: Store | undefined;
const open = Store.open.bind(Store);
Store.open = options => {
	store = open(options);
	return store;
};

function runningTurn(live: Store, name: string): { thread: Thread; turn: Turn } {
	const thread = live.listThreads(OWNER, 200).find(candidate => candidate.name === name);
	if (thread === undefined) throw new Error(`no thread named ${name}`);
	const turn = live.turns(thread.id).find(candidate => candidate.state === "running");
	if (turn === undefined) throw new Error(`${name} has no running turn`);
	return { thread, turn };
}

function ask(live: Store): void {
	const { thread, turn } = runningTurn(live, SHOWCASE_WAITING_NAME);
	const q = SHOWCASE_SECOND_QUESTION;
	live.askQuestions(
		thread.id,
		turn.id,
		[
			{
				key: q.key,
				text: q.text,
				header: q.header,
				options: q.options.map(([label, description]) => ({ label, description })),
				multi: q.multi,
				recommended: q.recommended,
				ompKey: q.key,
				ompLabels: q.options.map(([label]) => label),
			},
		],
		`req-${thread.id}-${turn.id}-2`,
	);
}

function finish(live: Store): void {
	const { thread, turn } = runningTurn(live, SHOWCASE_FINISHING_NAME);
	live.completeTurn(thread.id, turn.id, {
		outcome: "completed",
		error: "",
		reply: SHOWCASE_FINISH.reply,
		usage: { inputTokens: 61_400, outputTokens: 9_800, cacheReadTokens: 310_000, cacheWriteTokens: 28_000, cost: 0.52 },
		requests: 14,
		tools: 21,
		context: { tokens: 74_000, window: 200_000 },
		head: "9d41c0e7b2a35f68d0c1e4a7b9f3d2865c1a0e47",
		filesChanged: SHOWCASE_FINISH.files,
		insertions: SHOWCASE_FINISH.insertions,
		deletions: SHOWCASE_FINISH.deletions,
		pushed: true,
		pushError: "",
		pushRef: `omp-cloud/${thread.id}`,
	});
}

const args = process.argv.slice(2);
const configFlag = args.indexOf("--config");
const configFile = configFlag === -1 ? undefined : args[configFlag + 1];
if (configFile === undefined) throw new Error("showcase service: --config <path> is required");

await serve(args);

const control = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(req) {
		const { pathname } = new URL(req.url);
		if (store === undefined) return new Response("no store", { status: 503 });
		try {
			if (req.method === "POST" && pathname === "/ask") ask(store);
			else if (req.method === "POST" && pathname === "/finish") finish(store);
			else return new Response("not found", { status: 404 });
			return Response.json({ ok: true });
		} catch (error) {
			return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 409 });
		}
	},
});
writeFileSync(join(dirname(configFile), "showcase-control.json"), JSON.stringify({ port: control.port }));
console.log(`showcase control on http://127.0.0.1:${control.port}`);
