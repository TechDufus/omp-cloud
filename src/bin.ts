/**
 * The one entry of the omp-cloud binary (`bun build --compile src/bin.ts`): `omp-cloud <command> …`.
 *
 * Each command's module is imported when its command runs, not statically: importing the service pulls in omp's SDK,
 * whose modules install process-wide signal and exit handlers and take a while to load, and `version`, `--help`,
 * `ssh-pair` (run over ssh) and `backup` must neither pay for that nor inherit those handlers.
 */
import { BUILD, SERVICE_VERSION } from "./version";

const HELP = `omp-cloud ${SERVICE_VERSION} (${BUILD.id})

usage: omp-cloud [command] [options]

  setup [--yes] [--no-login] [--no-plugin] [--no-linger] [--no-wait] [--team <slug>] [--max-sandboxes <n>]
        [--migrate-team] [--checkout] [--json]
                                         set up this host: vibemon, the services, the plugin and the model login (asks for sudo once)
  doctor [--json]                        check the host and the stack, with a fix beside each failure
  login [<provider>]                     log the service in to a model provider
  uninstall [--purge] [--yes] [--checkout]
                                         remove what setup installed (--purge also deletes data and vibemon); backups are kept
  serve [--config <path>]                run the service (the default with no command)
  ssh-pair --name <n> --platform <p> [--config <path>]
                                         pair a device over ssh (prints one JSON line; used by /cloud connect user@host)
  update                                 check for a new release and download it
  update apply                           install the downloaded release and restart the service
  install [--from <binary>] [--config <path>]
                                         turn this install into a managed one (updates itself in place)
  backup [--keep N] [--config <path>]    one archive of the database, blobs, git cache and keys
  version                                print the version and build id
  --help                                 this text

Config: --config <path>, else $OMP_CLOUD_CONFIG, else ~/.config/omp-cloud/service.json.
`;

/** Runs `omp-cloud <argv…>` and returns the exit code; a command that serves keeps the process alive after it returns. */
async function run(argv: readonly string[]): Promise<number | undefined> {
	const [command, ...rest] = argv;
	switch (command) {
		case undefined:
			return serveFrom([]);
		case "serve":
			return serveFrom(rest);
		case "--config":
			return serveFrom(argv);
		case "ssh-pair": {
			const { cliMain } = await import("./cli");
			await cliMain(argv);
			return undefined;
		}
		case "update": {
			const { updateMain } = await import("./update/cli");
			return updateMain(rest);
		}
		case "install": {
			const { installMain } = await import("./update/cli");
			return installMain(rest);
		}
		case "backup": {
			const { backupMain } = await import("./backup");
			return backupMain(rest);
		}
		case "setup": {
			const [subcommand, ...subRest] = rest;
			if (subcommand === "system") {
				const { systemMain } = await import("./setup/system");
				return systemMain(subRest);
			}
			if (subcommand === "plugin") {
				const { pluginMain } = await import("./setup/plugin");
				return pluginMain(subRest);
			}
			const { setupMain } = await import("./setup/index");
			return setupMain(rest);
		}
		case "doctor": {
			const { doctorMain } = await import("./setup/doctor");
			return doctorMain(rest);
		}
		case "uninstall": {
			const { uninstallMain } = await import("./setup/uninstall");
			return uninstallMain(rest);
		}
		case "login": {
			const { loginMain } = await import("./setup/login");
			return loginMain(rest);
		}
		case "version":
			console.log(`omp-cloud ${SERVICE_VERSION} (${BUILD.id})`);
			return 0;
		case "--help":
		case "-h":
		case "help":
			process.stdout.write(HELP);
			return 0;
		default:
			console.error(`omp-cloud: unknown command ${JSON.stringify(command)}\n\n${HELP}`);
			return 2;
	}
}

/** The service: resolves when it is up (its listeners keep the process alive), never with an exit code. */
async function serveFrom(args: readonly string[]): Promise<undefined> {
	const { serve } = await import("./main");
	await serve(args);
	return undefined;
}

try {
	const code = await run(process.argv.slice(2));
	// `ssh-pair` sets process.exitCode itself; a command with a code exits with it, the service stays up.
	if (code !== undefined) process.exit(code);
} catch (error) {
	console.error(`omp-cloud: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
