/**
 * The two terminals a parity pass drives omp in:
 *
 * - {@link FakeTern}: a pty with the half of the Tern Surface Protocol a program needs from its terminal (the `hello` reply,
 *   an ack per frame). omp sees a TSP terminal and describes its UI; nothing is drawn, the frames are replayed into
 *   documents ({@link Replay}) and omp records them (`PI_TUI_TSP_RECORD`). tmux cannot do this: it swallows APC.
 * - {@link TmuxTerminal}: a real tmux pane with `PI_TUI_NATIVE=0`, omp's classic renderer; `capture-pane -e` is the ANSI
 *   capture a person reviews.
 */
import { TSP_KINDS } from "@oh-my-pi/pi-wire";
import { splitTspMessage } from "@oh-my-pi/pi-tui/native/encode";
import { isRecord } from "../../src/guards";
import { Replay, type TspRecord } from "./tsp";

export type KeyName = "enter" | "escape" | "tab" | "up" | "down" | "ctrl-c" | "alt-a";

const KEYS: Record<KeyName, { pty: string; tmux: string }> = {
	enter: { pty: "\r", tmux: "Enter" },
	escape: { pty: "\x1b", tmux: "Escape" },
	tab: { pty: "\t", tmux: "Tab" },
	up: { pty: "\x1b[A", tmux: "Up" },
	down: { pty: "\x1b[B", tmux: "Down" },
	"ctrl-c": { pty: "\x03", tmux: "C-c" },
	"alt-a": { pty: "\x1ba", tmux: "M-a" },
};

export interface Terminal {
	readonly kind: "native" | "ansi";
	/** Types text as keystrokes (no Enter). */
	type(text: string): Promise<void>;
	key(name: KeyName): Promise<void>;
	/** Whether omp is still running (a crash ends it). */
	alive(): Promise<boolean>;
	/** The screen's text: the TSP documents' strings (native) or the pane (ANSI). */
	text(): Promise<string>;
	/** Saves the screen under `file`: the ANSI pane (`-e`) or the surface documents as JSON. */
	capture(file: string): Promise<void>;
	/** Stops omp and everything this terminal started. */
	stop(): Promise<void>;
}

export interface LaunchOptions {
	/** The omp binary and the arguments after it. */
	argv: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	cols: number;
	rows: number;
}

const DA1_REPLY = "\x1b[?62;c";

/** A pty that speaks the terminal half of TSP. */
export class FakeTern implements Terminal {
	readonly kind = "native";
	readonly replay = new Replay();
	readonly #proc: Bun.Subprocess;
	readonly #decoder = new TextDecoder();
	#pending = "";
	#chunks = new Map<string, string>();
	/** Bytes omp wrote that were not TSP (diagnostics only). */
	other = "";
	exited = false;

	constructor(options: LaunchOptions, readonly recordFile: string) {
		this.#proc = Bun.spawn(options.argv, {
			cwd: options.cwd,
			env: { ...options.env, TERM: "xterm-256color", TERM_PROGRAM: "tern", COLORTERM: "truecolor", PI_TUI_NATIVE: "1", PI_TUI_NATIVE_STATS: "1", PI_TUI_TSP_RECORD: recordFile },
			terminal: { cols: options.cols, rows: options.rows, data: (_terminal, data) => this.#onData(this.#decoder.decode(data, { stream: true })) },
		});
		void this.#proc.exited.then(() => {
			this.exited = true;
		});
	}

	#write(text: string): void {
		if (!this.exited) this.#proc.terminal?.write(text);
	}

	#reply(kind: "r" | "e", body: unknown): void {
		this.#write(`\x1b_tsp;${kind};${JSON.stringify(body)}\x1b\\`);
	}

	#onData(text: string): void {
		this.#pending += text;
		for (;;) {
			const start = this.#pending.indexOf("\x1b_tsp;");
			if (start < 0) {
				this.other = (this.other + this.#pending.replaceAll(/\x1b\[[0-9;?]*c/g, "")).slice(-4096);
				if (this.#pending.includes("\x1b[c")) this.#write(DA1_REPLY);
				// Keep a possible start of an APC split across reads.
				this.#pending = this.#pending.endsWith("\x1b") || this.#pending.endsWith("\x1b_") ? this.#pending.slice(-2) : "";
				return;
			}
			const end = this.#pending.indexOf("\x1b\\", start);
			if (end < 0) {
				this.other = (this.other + this.#pending.slice(0, start)).slice(-4096);
				this.#pending = this.#pending.slice(start);
				return;
			}
			if (this.#pending.slice(0, start).includes("\x1b[c")) this.#write(DA1_REPLY);
			const sequence = this.#pending.slice(start, end + 2);
			this.#pending = this.#pending.slice(end + 2);
			this.#message(sequence);
		}
	}

	#message(sequence: string): void {
		const raw = splitTspMessage(sequence);
		if (raw === null) return;
		const chunk = raw.params.c;
		let body = raw.body;
		if (chunk !== undefined) {
			body = (this.#chunks.get(chunk) ?? "") + raw.body;
			if (raw.params.m === "1") {
				this.#chunks.set(chunk, body);
				return;
			}
			this.#chunks.delete(chunk);
		}
		let value: unknown;
		try {
			value = JSON.parse(body);
		} catch {
			return;
		}
		if (!isRecord(value)) return;
		if (raw.verb === "q" && value.q === "hello") {
			this.#reply("r", { r: "hello", v: 1, term: "parity-harness", ver: "1", kinds: TSP_KINDS, features: [], apc: 65_536, credits: 2, cols: 120, cell: { w: 9, h: 18 }, dark: true, reduceMotion: false, hour12: false });
			return;
		}
		if (raw.verb === "q" && value.q === "blobs") {
			this.#reply("r", { r: "blobs", have: [] });
			return;
		}
		const record: TspRecord = { t: Date.now(), dir: "out", verb: raw.verb, body: value };
		this.replay.apply(record);
		if (raw.verb === "f" && typeof value.sf === "string" && typeof value.s === "number") this.#reply("e", { ev: "ack", sf: value.sf, s: value.s });
	}

	async type(text: string): Promise<void> {
		this.#write(text);
		await Bun.sleep(80);
	}

	async key(name: KeyName): Promise<void> {
		this.#write(KEYS[name].pty);
		await Bun.sleep(80);
	}

	async text(): Promise<string> {
		return this.replay.text();
	}

	async capture(file: string): Promise<void> {
		await Bun.write(file, JSON.stringify(this.replay.snapshots(), null, 1));
	}

	async alive(): Promise<boolean> {
		return !this.exited;
	}

	async stop(): Promise<void> {
		if (this.exited) return;
		this.#proc.kill("SIGTERM");
		const gone = await Promise.race([this.#proc.exited.then(() => true), Bun.sleep(8000).then(() => false)]);
		if (!gone) {
			this.#proc.kill("SIGKILL");
			await this.#proc.exited;
		}
	}
}

async function tmux(...args: string[]): Promise<string> {
	const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	if (code !== 0) throw new Error(`tmux ${args.join(" ")} exited ${code}: ${err.trim()}`);
	return out;
}

/** shell-quotes one word. */
function quote(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** omp's classic renderer in a tmux pane of its own session. */
export class TmuxTerminal implements Terminal {
	readonly kind = "ansi";
	readonly session: string;
	#stopped = false;

	private constructor(session: string) {
		this.session = session;
	}

	static async launch(options: LaunchOptions, session: string): Promise<TmuxTerminal> {
		const env: Record<string, string | undefined> = { ...options.env, TERM: "tmux-256color", PI_TUI_NATIVE: "0", TERM_PROGRAM: undefined };
		const assignments = Object.entries(env)
			.filter((entry): entry is [string, string] => entry[1] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]))
			.map(([name, value]) => `${name}=${quote(value)}`);
		// `env -i`: tmux's own environment must not leak the owner's omp settings into the pane.
		const command = `exec env -i ${assignments.join(" ")} ${options.argv.map(quote).join(" ")}`;
		await tmux("new-session", "-d", "-s", session, "-x", String(options.cols), "-y", String(options.rows), "-c", options.cwd, command);
		await tmux("set-option", "-t", session, "remain-on-exit", "on");
		return new TmuxTerminal(session);
	}

	async type(text: string): Promise<void> {
		await tmux("send-keys", "-t", this.session, "-l", text);
		await Bun.sleep(80);
	}

	async key(name: KeyName): Promise<void> {
		await tmux("send-keys", "-t", this.session, KEYS[name].tmux);
		await Bun.sleep(80);
	}

	async text(): Promise<string> {
		return tmux("capture-pane", "-p", "-t", this.session);
	}

	async capture(file: string): Promise<void> {
		await Bun.write(file, await tmux("capture-pane", "-p", "-e", "-t", this.session));
	}

	async alive(): Promise<boolean> {
		return (await tmux("list-panes", "-t", this.session, "-F", "#{pane_dead}").catch(() => "1")).trim() === "0";
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		await tmux("kill-session", "-t", this.session).catch(() => undefined);
	}
}
