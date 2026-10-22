# Updating

[README](../README.md) · [Documentation index](../README.md#documentation)

The service updates the way Tern does: it checks the release feed in the background, downloads and verifies a newer release, and installs it when you click once. This page is about the server; the plugin on each other device updates on its own ([The plugin](#the-plugin)). A git checkout updates with git instead (the last section). The contract (routes, state shape, feed and manifest formats) is in [`api.md`](api.md#updates).

## A managed install

A release is one `omp-cloud` executable per architecture (linux x86_64 and arm64) with a `release.json` manifest, a `.sha256` sidecar for each executable, the release notes and a `THIRD-PARTY-NOTICES.txt` of the bundled packages' licenses. The executable carries every command; `omp-cloud --help` lists them. Releases also carry a linux-arm64 build, but `install.sh` and `omp-cloud setup` accept only x86_64 hosts.

Install layout (`OMP_CLOUD_APP_DIR`, default `~/.local/share/omp-cloud/app`), the same shape as Tern's omp manager:

- `versions/<version>/omp-cloud`: one directory per version. The current one and the two before it are kept.
- `bin/omp-cloud`: a relative symlink to the current version, swapped atomically.
- `manager.json` and `state.json`: the marker and the updater's state.

`omp-cloud setup` makes the install managed (it copies the binary into `<app>/versions/<version>`). `omp-cloud install [--from <binary>]` does that step alone for a binary you run now: it copies the binary into `versions/<version>`, writes `manager.json` and the `bin` link, points `~/.local/bin/omp-cloud` at `bin/omp-cloud`, and points the service unit at `bin/omp-cloud serve --config <path>` (a persistent unit through a `managed.conf` drop-in, a transient one by restarting it). It prints what it changed. A process is managed when its executable's real path is inside `<app>/versions/`; a git checkout is not, and its update state is `unsupported`.

## One click

With `update.mode` at its default, `notify`, the service checks the feed 60 seconds after it starts and hourly, and when a newer release exists it downloads the file for the machine's architecture, verifies size and sha256 (and the sidecar), stages it as `versions/<new>/omp-cloud` and runs `<staged> version`. The state is then `ready` and the owner sees it in these places:

- **Dashboard.** A header pill reads `Update ready · <version>` with a **Restart to update** button (after a confirm); while it works the pill shows the step, then `Updated to <version>` with the release notes, or `Update failed: <error>` with Retry. **Settings** has an Updates card: the state, Check for updates, the mode selector (`off`, `notify`, `auto`), and the components (this service, vibemon installed against required, and the omp the host, broker and gateway run).
- **omp.** The footer adds `update ready` (`☁ 2 working · 1 waiting · update ready`), the `/cloud` hub header shows `update <version> ready (u: restart to update)` and its key `u` applies after a confirm, `/cloud update` checks and applies, and in Tern a card `omp-cloud <version> is ready` with a **Restart to update** button appears once per version. A device sees none of this; only the owner applies.
- **The command line.** `omp-cloud update` checks, downloads and prints the state; `omp-cloud update apply` installs a downloaded release (it asks the running service to, or applies itself when the service cannot be asked).

Clicking runs the update outside the service, as a transient unit (`systemd-run --user --unit=omp-cloud-update`) of the new binary, so it survives the service's restart. The unit carries the service unit's whole environment, `HOME` and `PATH` included. The steps (backup, vibemon, omp, swap, health), the checks that refuse an update before anything changes, and the rollback after a failed swap are in [Applying an update](api.md#applying-an-update). Dashboard sessions survive the restart ([details](api.md#dashboard-sessions-and-an-update-restart)); without the handoff the sign-in screen says the restart ended the session and you sign in again.

## `auto`

`update.mode: auto` installs by itself only when that costs no one anything: no thread is starting, working or waiting and none has been for 10 minutes, the release runs on the vibemon that is installed (a vibemon upgrade needs root and restarts vibemon, which re-runs any turn that is working, see [below](#vibemon-is-pinned)), and it needs no new database schema (a migration is one way). Otherwise the update stays `ready` and waits for a click. `off` never checks by itself.

## vibemon is pinned

Each omp-cloud release pins the vibemon version it was tested with (`infra/vmon.json`, and `requires.vmon.version` in `release.json`). Tern follows omp's latest; omp-cloud does not, because a vibemon upgrade can change the snapshot format and needs root. `omp-cloud setup` installs exactly the pin, and installs a root helper, `/usr/local/libexec/omp-cloud/vmon-install`, with a sudoers rule that lets your user run only it (`/etc/sudoers.d/omp-cloud`, checked with `visudo -cf`; it never covers the `omp-cloud` binary). The helper takes one argument, a tag, downloads that release and its checksums from stencil-hq/vibemon itself, verifies them, lists both tarballs and refuses anything but regular files and directories (a symlink, hardlink, device or FIFO) or an absolute or `..` path before it unpacks, swaps `/opt/vmon` (keeping `/opt/vmon.prev`), restarts the `vmon` unit and rolls back if `/health` does not answer. It never downgrades: a tag older than the installed vibemon is refused before any download (`refusing to downgrade: vmon v<installed> is installed and <tag> is older`; the comparison is numeric, so `v0.10.0` is newer than `v0.9.0`), the same tag is a no-op, and any newer release installs. Without the helper or its sudo rule, an update that needs another vibemon stops before anything changed: run `omp-cloud setup` once. The helper's contract (argument, JSON last line, exit codes) is in [API](api.md#vibemon).

**What a vibemon change costs a running turn.** The helper restarts the `vmon` unit, and a restart does not keep the VM of a turn that is running: omp-cloud reports the VM lost, restores the thread from its last result on a new sandbox and re-runs the turn, so the work the turn had done so far is redone. Paused sandboxes are unaffected. That is why `auto` waits for a quiet service and for the same vibemon, and why a click that moves vibemon is best given while no turn is running. The VM template tag includes the vibemon version, so a new vibemon gets a new template; the service builds it in the background at start.

## The feed

`update.feed` is `github:<owner>/<repo>` (the default is `github:TechDufus/omp-cloud`, its latest GitHub release) or an `http(s)://` base URL that serves `release.json` and the files, for self-hosting and tests. A private repository or fork needs `update.token`: set it to a `!command` whose output is a GitHub token (for example `!/usr/bin/gh auth token`), the name of an environment variable of the service, or the token itself. In that last case it is stored in the clear in the database but reads back as `(set)` and is never audited or exported, and the service never logs the value; prefer a `!command`. A public repository is read without a token. `update.unit` names the service's user unit that an update restarts, and `update.ompUnits` the units whose omp the `omp` step checks (default the broker and gateway; `[]` skips the step).

## The plugin

The server and each device have their own copy of the plugin, and each moves its own way. The server's plugin is refreshed by the service update. A device's plugin does not follow the server: `omp plugin upgrade` and then `/restart` update it. Plugin and service are versioned together, and `mise run release -- <version>` bumps both manifests. omp loads a plugin at start, so `/restart` omp to load a new one.

**On the server.** The release binary carries the plugin, and an applied update refreshes it in the server's omp as a last, non-fatal step (`omp plugin marketplace update` and `upgrade` from the copy bundled in the new binary): a failure never fails or rolls back the update, and the result reads `updated to <version> (the omp plugin was not refreshed: <reason>; run omp-cloud setup to retry)`.

**On a device.** A device installs the plugin from the GitHub marketplace ([Other machines](install.md#other-machines); the marketplace is this repository, so a private repository or fork needs access to it). That plugin moves when the version in `.omp-plugin/marketplace.json` rises: `omp plugin upgrade`, then `/restart`. When the plugin is older than the service it says so once per omp process (a restart says it again): `☁ the omp-cloud plugin <a> is older than the service <b>: update it (omp plugin upgrade omp-cloud, or git pull in a linked checkout) and restart omp`.

**A linked plugin** (`mise run infra:up` links `<repo>/plugin`) follows the checkout: `git pull`, then `/restart`.

**Skew.** A newer service keeps working with an older plugin, because responses only gain fields. A newer plugin against an older service works as far as the service goes: `GET /api/v1/whoami` lists the service's `capabilities`, and an operation that needs one the service lacks fails with `version_skew`, naming the capability and the service's version and saying to update the service. Messages to a cloud agent (`write agent://<id>`, the `cloud` tool's `send`) use `threads.irc` (API 3); against a service without it they go through the thread's message queue as a queued turn. Two capabilities arrived with API 5. `threads.subagent`: the service runs the agents the model starts without `ask`; a plugin against a service without it warns in the delegate result that those agents may ask questions, which arrive as `[cloud]` messages. `threads.readonly`: the `policy.readOnly` key; in plan mode the plugin delegates read-only agents, and against a service without it a delegation fails with `version_skew` (update the service, or delegate after the plan is approved).

## Updating a git checkout

A checkout's update state is `unsupported`: `this omp-cloud runs from a git checkout; update it with git pull and restart it`.

The service is the repository checkout it runs from. To update it: `mise run backup` (an online backup, see [Backups and persistence](operations.md)), `git pull`, then `systemctl --user restart omp-cloud`. The service migrates its database forward when it starts and refuses a database newer than itself, so a checkout older than the data cannot start on it, and a restore of a backup made before the update needs the matching checkout. `mise run infra:up` (`omp-cloud setup --checkout`) is idempotent and also rewrites the `omp-cloud` command (`~/.local/bin/omp-cloud`, used by `/cloud connect user@host`) when the install is not a managed one, so run it after moving the repository. `GET /api/v1/whoami` reports the running `service.version` and API level, and the tool's `info` shows them. The plugin follows [the section above](#the-plugin).
