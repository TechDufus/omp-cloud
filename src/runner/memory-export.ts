import { type Exec, ExecError, shellQuote } from "./exec";
import { VM_AGENT_DIR } from "./vm-layout";

/** Where omp's mnemopi backend keeps the VM's memories: the default store and one `banks/<name>/` per project bank. */
export const VM_MEMORY_DIR = `${VM_AGENT_DIR}/memories/mnemopi`;

/** The script's exit code for a VM without any memory directory. */
const NO_MEMORY = 3;
/** The script's exit code for a VM built from a template without `sqlite3`. */
const NO_SQLITE = 4;

/**
 * The shell script that snapshots every mnemopi database under `src` with `VACUUM INTO` (a consistent copy while omp may
 * hold the database open) into `out` and tars the result to `tarPath`. Exits 3 when there is no memory directory and 4
 * when `sqlite3` is missing.
 *
 * The body is a subshell on purpose. The sandbox runs commands through `bash -l -c`, and a login shell that leaves through
 * `exit` while `set -e` is on runs `~/.bash_logout` under it: the VM image's ends in `[ -x /usr/bin/clear_console ] && ...`,
 * which fails and turns every exit code (3, 4, even 0) into 1. `set -e` inside a subshell never reaches the login shell,
 * which ends normally with the subshell's status.
 */
export function memoryExportScript(src: string, out: string, tarPath: string): string {
	const q = shellQuote;
	return [
		"(",
		"set -e",
		`src=${q(src)}`,
		`[ -d "$src" ] || exit ${NO_MEMORY}`,
		`command -v sqlite3 >/dev/null || exit ${NO_SQLITE}`,
		`out=${q(out)}`,
		`rm -rf "$out"`,
		`mkdir -p "$out/banks"`,
		`if [ -f "$src/mnemopi.db" ]; then sqlite3 "$src/mnemopi.db" "VACUUM INTO '$out/mnemopi.db'"; fi`,
		`for d in "$src"/banks/*/; do [ -f "$d/mnemopi.db" ] || continue; b=$(basename "$d"); mkdir -p "$out/banks/$b"; sqlite3 "$d/mnemopi.db" "VACUUM INTO '$out/banks/$b/mnemopi.db'"; done`,
		`tar -cf ${q(tarPath)} -C "$out" . && rm -rf "$out"`,
		")",
	].join("\n");
}

/**
 * Packs the VM's mnemopi memories into the tar `tarPath` (members `./`, `./mnemopi.db`, `./banks/<name>/mnemopi.db`).
 * False, with nothing written, when the VM has no memories or no `sqlite3`; throws `ExecError` on any other failure.
 */
export async function exportMemory(exec: Exec, paths: { src?: string; work: string; tarPath: string }): Promise<boolean> {
	try {
		await exec(memoryExportScript(paths.src ?? VM_MEMORY_DIR, paths.work, paths.tarPath));
		return true;
	} catch (error) {
		if (error instanceof ExecError && (error.exitCode === NO_MEMORY || error.exitCode === NO_SQLITE)) return false;
		throw error;
	}
}
