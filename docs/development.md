# Development

[README](../README.md) · [Documentation index](../README.md#documentation)

## Layout

| Path | |
|---|---|
| `src/` | Service: `server/` HTTP, `store/` SQLite + blobs, `runner/` VMs and omp (`runner/vm-extension/`: the VM extension uploaded into every VM and loaded with `-e`), `settings/` run-time settings, `git/` base fetches and pushes, `dashboard/` dashboard listener and web client, `pairing/` remote-listener identity and pairing codes, `update/` the updater, `vmon/`, `gateway/`, `auth/` |
| `src/setup/` | `omp-cloud setup`, `doctor`, `login` and `uninstall`: preflight, the root part (`system.ts`, run as `sudo -- omp-cloud setup system`), the user part (config, TLS, units, plugin, health, login). Every probe is injected, so its tests (`*.test.ts` beside it) run in a temp directory |
| `install.sh` | The `curl \| sh` installer: POSIX sh, downloads and verifies the release binary, then runs `omp-cloud setup` |
| `plugin/` | The `/cloud` plugin (standalone package). Its runtime imports of omp, and those of the VM extension in `src/runner/vm-extension/`, must be ones a compiled omp serves; `plugin/test/host-imports.test.ts` fails otherwise |
| `infra/` | `vmon-install.sh` (the root helper `setup` installs) and `vmon.json` (the vibemon pin) |
| `scripts/` | `backup.ts` (`mise run backup`), `dashboard-dev.ts` (`mise run dashboard:dev`), `cleanhost.ts` (`mise run cleanhost`), `template.ts` (`mise run template`), `release.ts` (`mise run release:build`, `mise run release`) with `embed-natives.ts` and `notices.ts`, `smoke.sh` (`mise run smoke`), `vmon-restart-check.ts`, `showcase/` (the README screenshot captures) |
| `scripts/parity/` | `mise run parity:capture`: the native-parity harness (`capture.ts` the session, `terminal.ts` the pty and tmux drivers, `tsp.ts` the replay of omp's Tern-protocol record, `provider.ts` the scripted fake model, `summary.ts` the table) |
| `test/` | End-to-end scenarios (`scenario.ts`, `plugin-scenario.ts`, `update-scenario.ts`, `install-scenario.ts`) with their shared `run-lock.ts`, `cleanhost/` and the deterministic fake model (`fake-provider.ts`) |
| `dev/` | Developer tools (`mise run dev:local`, `dev:play`, `dev:provider`); not part of the service |
| [`docs/api.md`](api.md) | HTTP API contract |
| [`docs/install.md`](install.md) | The install: requirements, `omp-cloud setup`, login, doctor, uninstall |
| [`docs/architecture.md`](architecture.md) | How it works, the design reasons and the known limitations |

## Commands

```sh
mise run test              # unit tests (bun test); `bun test src/setup` runs the setup, doctor and uninstall tests alone
mise run typecheck         # tsc --noEmit, service and dashboard client
mise run smoke             # curl the API of a fresh service, no VM
mise run scenario          # API end to end on local vmon, fake model
mise run plugin:scenario   # real local omp + plugin installed from the release bundle through a marketplace → fresh service on local vmon
mise run parity:capture    # native-parity harness on a real omp, fake model, throwaway service on local vmon (~5 min); `-- --assert`, `--only native|ansi`, `--no-cloud`
mise run update:scenario   # the updater against real compiled releases and a throwaway user unit (no VM, no model; minutes)
mise run install:scenario  # the installer on a clean Debian 13 VM (nested KVM; tens of minutes); `-- --no-nested` for a host whose nested KVM kills the VM
mise run cleanhost -- list # clean Debian 13 VMs on the local vmon (team omp-cloud-test): create, exec, put, get, destroy, list, template, nested
mise run release:build     # dist/: the two executables, sha256 sidecars, release.json, notes.md, THIRD-PARTY-NOTICES.txt and its sidecar
mise run infra:up          # omp-cloud setup --checkout: this checkout as the service host (one sudo prompt); infra:down is uninstall --checkout
mise run serve             # service in the foreground (stop the omp-cloud unit first)
mise run dashboard:dev     # the dashboard on seeded data (temp service, runner off); prints a sign-in link
```

`update:scenario` sets `update.ompUnits` to `[]` in its throwaway database, so its apply never queries or restarts a broker or gateway unit. It refuses to start when an apply could reach live units in another way (a vibemon that is not the pin, an apply already running).

`plugin:scenario` loads the plugin the way users get it: the release's bundle files (`.omp-plugin/marketplace.json` and `plugin/`, no `node_modules`) are added as a local marketplace and installed into an isolated omp, and step 0 asserts that the real `/cloud` registers. A plugin linked from a checkout would hide an import a compiled omp does not serve; `plugin/test/host-imports.test.ts` (part of `mise run test`) catches those directly.

`parity:capture` runs one scripted session on a real omp with the plugin, the fake model and a throwaway service, once through a pty that speaks Tern's protocol and once in tmux with the classic renderer, and writes `/tmp/parity/` (`--out <dir>`). It counts the `rows` fallback nodes omp-cloud causes (`--assert` exits 1 on any, or on an incomplete cloud job view) and compares a cloud job's tiles and `/jobs` widget with a native job's. It runs the service from a `git archive HEAD` snapshot (`--live-service` uses the working tree, `--plugin head` the committed plugin as a baseline). `scenario`, `plugin:scenario`, `update:scenario`, `install:scenario` and `parity:capture` share the local vmon and the gateway clients file, so each takes one run lock (`test/run-lock.ts`, the pid file `~/.local/share/omp-cloud/scenario.lock`): a second run refuses to start with a message naming the holder (exit 2), and a lock whose process is gone is taken over. `parity:capture --no-cloud` takes none.

`install:scenario` and `cleanhost` use the dedicated vibemon team `omp-cloud-test` (key `~/.config/omp-cloud/vmon-test.key`) and never touch the live team or units. On a host whose nested KVM kills the clean VM (`mise run cleanhost -- nested` says so), `install:scenario -- --no-nested` proves everything but the template build and a real turn. `infra:up -- --no-login` and the other `omp-cloud setup` flags pass through ([Install](install.md)).

`mise tasks` lists the rest. Contributor and agent notes: [`AGENTS.md`](../AGENTS.md).

