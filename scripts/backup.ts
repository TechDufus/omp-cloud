/** `mise run backup [-- --keep N] [--config path]` and the checkout's backup unit: the logic is `omp-cloud backup` (src/backup.ts). */
import { backupMain } from "../src/backup";

process.exitCode = await backupMain(process.argv.slice(2));
