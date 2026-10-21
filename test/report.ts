/** Step runner shared by the scenario scripts: per-step timing, PASS/FAIL lines, and a final table. */

interface Row {
	name: string;
	ms: number;
	ok: boolean;
	detail: string;
}

/** Thrown by {@link Report.step} after recording a failure, so callers can stop the scenario. */
export class StepFailed extends Error {}

export class Report {
	readonly rows: Row[] = [];

	/** Run one step: record its duration and outcome, print one line, rethrow failures as {@link StepFailed}. */
	async step<T>(name: string, fn: () => Promise<T>, detail?: (value: T) => string): Promise<T> {
		const started = performance.now();
		try {
			const value = await fn();
			const ms = performance.now() - started;
			const text = detail ? detail(value) : "";
			this.rows.push({ name, ms, ok: true, detail: text });
			console.log(`PASS  ${name}  ${ms.toFixed(0)} ms${text ? `  ${text}` : ""}`);
			return value;
		} catch (error) {
			const ms = performance.now() - started;
			const text = error instanceof Error ? error.message : String(error);
			this.rows.push({ name, ms, ok: false, detail: text });
			console.log(`FAIL  ${name}  ${ms.toFixed(0)} ms\n      ${text.split("\n").join("\n      ")}`);
			throw new StepFailed(`${name}: ${text}`, { cause: error });
		}
	}

	/** Print the timing table. Returns true when every recorded step passed. */
	print(): boolean {
		const width = Math.max(4, ...this.rows.map(row => row.name.length));
		console.log(`\n${"step".padEnd(width)}  result  time(ms)`);
		for (const row of this.rows) {
			console.log(`${row.name.padEnd(width)}  ${row.ok ? "PASS  " : "FAIL  "}  ${row.ms.toFixed(0).padStart(8)}`);
		}
		const ok = this.rows.every(row => row.ok);
		console.log(`\n${ok ? "ALL PASS" : "FAILED"} (${this.rows.length} steps)`);
		return ok;
	}
}

/** Throws unless `actual` contains `expected`. */
export function expectContains(label: string, actual: string | null | undefined, expected: string): void {
	if (!actual?.includes(expected)) {
		throw new Error(`${label}: expected to contain ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

/** Throws unless `actual === expected`. */
export function expectEqual<T>(label: string, actual: T, expected: T): void {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}
