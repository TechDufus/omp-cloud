# Changelog

Release notes of omp-cloud, newest first. `mise run release -- <version>` moves `## Unreleased` into a dated section, and the release workflow publishes that section as the GitHub release's notes.

Each section opens with a one- or two-sentence summary, then groups its entries under `### Upgrade notes` (only what an existing install must do or will notice), `### Added`, `### Changed`, `### Fixed` and `### Security`, in that order, leaving out empty groups. An entry is one flat bullet, `- **What changed.** One or two sentences on the effect and the command or setting to use`, written for someone who runs the service: no nested lists, tables or links, because older dashboards render only headings, flat lists, bold and code in release notes.

## Unreleased

omp-cloud moves to vibemon v0.4.1: vibemon's VMMs no longer run as root, setup creates its team idempotently, and `--migrate-team` deletes the team it leaves. Rerun `omp-cloud setup` once after updating. This release moves vibemon, so `update.mode: auto` waits for a click.

### Upgrade notes

- **vibemon v0.4.1.** omp-cloud now pins vibemon v0.4.1; an update moves the server's vibemon through the root helper (nodes follow within minutes) and the VM template rebuilds once for the new tag.
- **Rerun `omp-cloud setup` once, and `omp-cloud setup node --join <user@server>` on each node.** It creates the system user `omp-cloud-vmm` and restarts vmon with `--vmm-user`, so a turn running then is re-run. Until then `omp-cloud doctor` fails `system.check.vmm-user` (`doctor.node.vmm-user` on a node), because the updater moves only the vibemon tag.
- **Threads paused before that rerun come back as cold restores.** A sandbox paused while the VMMs ran as root cannot resume under `omp-cloud-vmm` (vmon logs `Permission denied` on its snapshot), so the thread's next message retries for about 4 minutes and then restores the thread on a new VM from its last result and conversation.

### Changed

- **`--migrate-team` deletes the old team.** Setup now deletes the team it leaves in vibemon (`delete-team --force`: its sandboxes, templates, environment snapshots and keys) and no longer keeps `vmon.key.<old slug>`; the plan says so before you confirm. A failed delete is reported as skipped (`system.team.old`) with the command that finishes it, and the switch to the new team still completes.
- **The team is created with `create-team --if-missing`.** Setup ensures its vibemon team in one idempotent call, retried while vmon starts, instead of listing teams first; the limits are still set on every run.
- **Setup installs udev when `udevadm` is missing.** udev creates the group `kvm` and gives it `/dev/kvm`, which the VMMs need now that they no longer run as root; setup never changes `/dev/kvm` itself and fails `system.vmm-user` with a fix when the group cannot read and write it.

### Fixed

- **vibemon fixes from v0.4.1.** A paused sandbox reads as paused on a machine that did not build its template, a snapshot template keeps its start command, and envd no longer leaks pidfds.

### Security

- **vibemon's VMMs no longer run as root.** vmon starts every VMM with `--vmm-user`, so it drops to the system user `omp-cloud-vmm` (group `kvm`) before opening `/dev/kvm` and runs under vibemon's seccomp and Landlock filters. `omp-cloud uninstall --purge` removes the user.
- **vibemon dependency upgrades.** vibemon v0.4.1 carries the upstream fixes for its RustSec advisories.

## 0.8.0 (2026-10-24)

You are the owner on every machine: a paired device has full or threads-only access, the cloud has a name you see everywhere, and updates, logins and the capacity of the whole vibemon cluster are visible from omp and the dashboard. More vibemon machines can join the server's cluster with `omp-cloud setup node --join`. This is Service API 6, with database migration 17, so `update.mode: auto` waits for a click on this release.

### Upgrade notes

- **Devices have access levels (schema migration 17, Service API 6).** A paired device is now the owner on its machine, with `full` access (everything the owner token can do) or `threads` access (threads and reads). On upgrade, devices paired over ssh become `full` and devices paired with a code stay `threads`; an approval that names no access, which is what a plugin older than this release sends, grants `threads`. Change one with `PATCH /api/v1/devices/{id}`. The service must restart to migrate the database before `omp-cloud ssh-pair` works again.
- **Rerun `omp-cloud setup` once.** It hands the service vibemon's admin token (`~/.config/omp-cloud/vmon-admin.token`, 0600, and `vmon.adminTokenFile` in `service.json`) so it can read the cluster's capacity; until then capacity shows as unavailable (`this server has no vibemon admin token yet`). Anything that runs as you can read that file and act as vibemon's admin.
- **A server that takes other vibemon machines keeps the cluster secret in a file.** Only with `--cluster-address`, setup copies `VMON_CLUSTER_SECRET` from `/etc/vmon/env` to `~/.config/omp-cloud/vmon-cluster.secret` (0600) and names it in `vmon.clusterSecretFile`, so `omp-cloud node-join-info` can hand it to a machine that joins over ssh. Anything that runs as you can read it. A server that takes no machines never copies it.

### Added

- **Access levels for devices.** `whoami.device` carries `access`, `GET /api/v1/devices` lists it, `POST /api/v1/pairing/offers/{id}/approve` takes `{"access": "full" | "threads"}`, and `PATCH /api/v1/devices/{id}` changes it. The capability is `devices.access`. A device with full access can do everything the owner token can, and sees every device.
- **Every caller can read the update state.** `GET /api/v1/update` is open to every device; `POST /api/v1/update/check` and `/apply` need full access.
- **The cloud has a name.** The new setting `service.name` (empty by default, 1 to 64 letters, digits, spaces, `.`, `_` or `-`) is what the cloud calls itself; `whoami.service.name` returns it, or the server's host name when it is empty.
- **The update mode is visible to every caller.** `whoami.update` now carries `mode`, the `update.mode` setting, next to `state` and `available`.
- **A list of the cloud's logins.** `GET /api/v1/logins` returns every provider login the cloud broker holds, its disabled ones with the reason, and the MCP servers the service is logged in to, each with the account, when it was made and, for Anthropic, the date to renew by. Every caller may read it; accounts show only with full access. The capability is `logins.list`.
- **Health carries the server's vibemon version.** `GET /api/v1/health` answers `vmon`, the vibemon tag installed on the server (`null` when unknown). The service reads it in the background, so a health check never waits for it.
- **The cluster's capacity.** `GET /api/v1/capacity` answers every caller with the vCPU and memory of the vibemon cluster, what is allocated, the machines, the VMs of the omp-cloud team against its limit, and the last hour per minute; when vibemon cannot be read it says why and what to run (`available: false`). The capability is `capacity`.
- **A default cloud for the machine.** The new personal key `use: personal | paired` in `config.yml` picks the cloud new sessions take, after `OMP_CLOUD_URL` and before the personal `url` and the pairing; `/cloud use <cloud> --default` writes it (`env` cannot be the default) and switches the session as `/cloud use` does, and a session that already works with threads keeps its cloud. `/cloud status` shows the `use:` row and the `cloud:` line says `the default (use: <source> in <file>)`. A repository's `.omp-cloud.yml` cannot set it.
- **`/cloud devices access <name|id-prefix> full|threads`.** Changes a device's access from a connection with full access (`☁ <name> now has full access` or `… threads-only access`). Lowering the device you are on asks first (`This device loses full access now`); on a service without `devices.access` it says to update the service.
- **`/cloud login` alone lists the cloud's logins.** It prints `the cloud is logged in to:` with one line per provider (account, when it logged in, when to renew by, or why it is disabled) and a broker error if the broker could not be read; a service without `logins.list` gets the usage line. `/cloud login <provider>` is unchanged.
- **`/cloud status` says which cloud, as whom.** It leads with `☁ omp-cloud · <name> · omp-cloud <version>`, then `you:` (the owner with the owner token, the owner on a device with full access, or a device with threads-only access and the command that changes it), `updates: <mode> · <state>` and `capacity:` (vCPU, memory, machines and VMs of the cluster, or why it is unavailable), and ends the cloud rows with `switch: /cloud use <cloud> (this session) · /cloud use <cloud> --default (new sessions)`. The `user:` row is gone. The `cloud` tool's `info` carries the same `you:`, `capacity:` and `update: <mode> · …` lines, and its `caller` detail has `access`.
- **The footer names the cloud.** The footer status ends with the cloud's name, and an idle footer is `☁ <name>` once the service has reported one (a service older than `service.name` shows none).
- **The dashboard knows who you are and which cloud this is.** The header carries a chip with the cloud's name (`service.name`; hover for the omp-cloud version) and the account: `Owner` on the service host, or the paired device's name with a `full access` or `threads only` badge. With threads-only access the Logins start form, GitHub and Secrets show `Needs full access` (a lock marks their nav items), Settings is read-only under a banner, the update pill and the Updates card have no actions, and Devices has no pairing card. A device with full access has all of it.
- **Devices page: access levels.** Each device has a Full / Threads only switch (giving the device you are using threads-only access asks first and reloads the page), and a pending pairing request offers Approve with full access, Approve, threads only and Decline.
- **Logins page: what the cloud is logged in to.** A Logged in table lists every provider login and MCP server with its account, when it was made and when to renew it (amber inside a week, red once past, for Anthropic's 30-day grants), and its status with the reason for a disabled one; with full access each row has Log in again.
- **VMs page: the cluster as one pool.** A Capacity card shows vCPU and memory allocated of total, free disk, machines ready, the omp-cloud team's VMs against its limit, a chart of the last hour and a Machines table (closed by default) with each machine's vibemon version; its footer gives the command that adds a machine. Overview adds vCPU and memory allocated tiles. The vmon dashboard link shows only on the service host.
- **`mise run dashboard:dev -- --as=full|threads`.** The dev dashboard signs in as a paired device with that access through the plugin's forwarder, as `/cloud dashboard` does on a paired machine (`--as=owner`, the default, is the owner's own session). The fake vmon now answers the admin API (a three-machine cluster) and a fake broker lists provider logins, so the Capacity card and the Logged in table have data.
- **The update confirmation names a vibemon move.** When the release needs another vibemon than the one installed, the dashboard's **Restart to update** dialog and the `/cloud update` confirm add `This release moves vibemon from <installed> to <required>: vmon restarts, so a turn running now is re-run.` and, when the cluster has other machines, `The other <n> vibemon machines follow by themselves within a few minutes.` The machine count comes from the capacity; if that cannot be read the second sentence is left out.
- **More vibemon machines.** `omp-cloud setup --cluster-address <ip>` makes a server take other vibemon machines on its private LAN address (vmon then listens for them on that address only, never `0.0.0.0`, and restarts once); `--no-cluster` stops it, and a rerun keeps the recorded mode. On the new machine, `curl -fsSL https://omp-cloud.techdufus.com/install.sh | sh -s -- node --join you@server` (`omp-cloud setup node --join <user@server>`) installs vibemon at the server's version, joins the cluster and checks that the server sees it and that the gateway answers. VMs placed there work, capacity counts them, and they need TCP 4000, 4100 and 8443 to the server and TCP 7947 plus TCP and UDP 7946 between vibemon machines ([More vibemon machines](docs/install.md#more-vibemon-machines)).
- **Nodes follow the server's vibemon.** A node's `omp-cloud-vmon-sync` timer reads the vibemon tag from the server's health route (pinned to its certificate) every minute and installs it through the root helper; a failed install is retried after an hour, a pin mismatch is reported as a failure of the unit, and a node never downgrades.
- **`omp-cloud node-join-info`.** Run by `setup node --join` over ssh on the server: it prints one JSON line (`{"ompCloudNode": 1, …}`) with the server's address, remote port, certificate pin, vibemon tag and the cluster secret, or waits with `--member <ip>` until a machine has joined. The contract is in `docs/api.md`.
- **Doctor knows nodes and clusters.** On a node `omp-cloud doctor` checks its units, the route to the service address, the gateway, that its VMs cannot reach the server's remote listener and its vibemon version against the server's; on a server that takes machines it reports `doctor.cluster` (a machine that is not alive or runs another vibemon version). `omp-cloud uninstall` on a node removes its units and scripts and says its VMs are lost; the server restores their threads on its other machines.
- **`preflight.cluster-address`.** Setup checks that `--cluster-address` is an address of this machine and a private LAN address before it changes anything.

### Changed

- **A refusal names the fix.** A device with threads-only access that calls a route needing full access gets `403` `this device has threads-only access; a connection with full access can change that (Devices in the dashboard, or /cloud devices access <device> full)` instead of `only the owner token can do this`.
- **Devices paired over ssh have full access.** `omp-cloud ssh-pair` creates a `full` device, because a login on the service's account is already ownership.
- **A 401 names the credential that was refused.** For a paired connection it says the device's token was revoked or the server was set up again and that `/cloud connect --replace` pairs the machine again; for `OMP_CLOUD_TOKEN` it says to correct or unset it; for the token of `config.yml` it says it must be the server's owner token and how setup writes it.
- **`/cloud connect` says how to make the pairing the default.** The card's note is now `new sessions on this machine still use <where>: /cloud use paired --default makes this pairing the default`.
- **`/cloud pair` offers two approvals.** In the overlay on the server machine `y` approves with full access, `t` approves with threads-only access and `n` declines (`y approve with full access · t approve with threads-only access · n decline · esc cancel`); the plugin sends the access with the approval.
- **`/cloud pair` needs full access.** A paired device with threads-only access is refused with `/cloud pair needs full access; this device (<name>) has threads-only access`; the owner token and a device with full access can pair others.
- **`/cloud devices` shows each device's access.** A row reads `<name> · full access · <platform> …` or `<name> · threads only · …`, with the `(this device)` mark kept.
- **`/cloud connect` says what access the device got.** The card ends with `access: full access` or `access: threads only — a connection with full access can change that`.
- **A connection with full access is the owner in the plugin.** A device with full access installs updates (`/cloud update`, the footer's `update ready`, the hub's `u` and the update card), logs the cloud in (`/cloud login <provider>` and the offer when your session's model is not served) and gets `/cloud login` hints instead of the server-machine instructions; a device with threads-only access keeps being told what to ask of a connection with full access (`<v> is downloaded and ready: a connection with full access installs it (/cloud update there)`).

### Fixed

- **A VM that stayed unreachable failed its thread for good.** After the five retries (about four minutes), a thread whose paused VM answered `503` for ever, for example on a machine that was asleep or gone, failed with `the VM stopped responding`. When vibemon itself answers `GET /health`, the thread is now restored on a new VM from its last result and conversation, with the `vm` event `the VM did not answer for about 4 minutes (…); restoring the thread on a new VM`. If vibemon does not answer either, the thread fails as before.
- **The limits text said the whole team had 8 vCPUs, 8192 MB and 20480 MB.** Those are vibemon's per-VM ceilings, not team totals. Setup's step text and `docs/install.md` now say so.

### Security

- **A node's VMs reach only the gateway and the MCP proxy.** The node's `omp-cloud-node-net` unit rejects what its host sends or forwards to `10.254.254.1` except TCP 4000 and 4100, because a VM's traffic reaches the server from the node's LAN address, which the remote listener would otherwise accept; vmon on a node requires that unit, so it never runs without the restriction, and `omp-cloud doctor` probes that the restriction holds. The server's cluster listeners bind one private LAN address, never `0.0.0.0`.

## 0.7.0 (2026-10-22)

Cloud agents the model starts now behave like `task` subagents, each omp session picks its cloud, and plan mode delegates read-only agents. This is Service API 5, with no database migration.

### Upgrade notes

- **Update the service and the plugin together.** The subagent behaviour needs a service that reports `threads.subagent`, and plan mode needs one that reports `threads.readonly`; both arrive with API 5. Against an older service the plugin warns that its agents may ask questions, and plan-mode delegations fail with `version_skew`.
- **A model's delegation no longer ships the conversation.** The `cloud` tool forks this conversation into an agent only when the call passes `conversation: "full"`. Your own `/cloud <task>` still forks it.
- **Agents the model starts run without `ask`.** On a service that reports `threads.subagent` they get the subagent prompt and no `ask` tool, and an agent that needs a decision ends its turn with the question as its result. Threads you start with `/cloud <task>` are unchanged.
- **A model's delegation no longer posts a launch card.** Read the `delegate` result instead. `/cloud <task>` keeps its card.

### Added

- **Read-only threads.** The setting and thread policy key `policy.readOnly` (default `false`) makes a cloud agent that only reports: nothing it changes is pushed, asked about or opened as a pull request, its VM gets no MCP servers, and its prompt tells it to change nothing. A thread may turn it on, never off; the service setting makes every thread read-only. See `docs/api.md` and `docs/security.md`.
- **Read-only events.** A read-only thread's `push` event says `not pushed: the thread is read-only`. When MCP servers were requested, a `vm` event says `MCP servers not delivered: the thread is read-only (<names>)`. Its VM gets no `mcp.json` and no MCP proxy token.
- **Plan mode delegates read-only agents.** While omp is in plan mode, every delegation the model makes sets `policy.readOnly`, whatever it passes. The model's `pull` and its messages to agents that are not read-only, through `send` or `write agent://<id>`, are refused. `preview`, `diff`, `files`, `use`, `connect`, `stop` and `delete` still work, and your own `/cloud` commands are not restricted.
- **A session picks its cloud.** `/cloud use [env | personal | paired]` and the tool's `use` choose among the clouds this machine knows (`OMP_CLOUD_URL`, the `url` and `token` of `config.yml`, the pairing). The choice is stored in the session as an `omp-cloud-target` entry and is refused once the session has launched or adopted a thread.
- **`/cloud status` and `info` list the clouds.** When this machine knows more than one cloud, or the session chose one, they show `cloud:` and `other clouds:` lines. A failing `info` still lists the clouds the model can `use`.
- **The model can pair a cloud you name.** The tool's `connect` pairs a server after you confirm a `Connect to omp-cloud?` dialog. It never replaces a pairing and never passes `--allow-public`. The `cloud` tool has 17 ops.
- **`info` says what a cloud agent gets.** It lists the default model, whether the session's model is served, what agents may do (`agents may: fetch · web search · browser · egress`), the toolchain (`vm.packages`), what happens to their work (`git.push`, pull requests, signing, push credentials) and `plan mode: on` when it applies.
- **A device token can read `GET /api/v1/settings`.** `info` needs it; only writing settings is the owner's. The tool's description and `docs/cloud-tool.md` now say what a cloud agent has and what happens to its work.
- **`/cloud connect` shows what it is doing.** While it pairs, a line above the editor names the step (asking the server for a device over ssh, checking the server's certificate, checking the service with the new device token) until the result card replaces it.
- **A Formatted / Raw switch on a thread's Turns card.** Raw shows every turn's prompt and reply exactly as written, for the whole page; the browser remembers the choice.

### Changed

- **Agents the model starts run as subagents.** A thread with `origin: "tool"` runs with omp's `ask` tool off and a subagent system prompt: its assignment is the message that started it, it works autonomously, and its final message is its result. Tool and push approvals still reach you.
- **The subagent prompt names its parent and its environment.** It gives the parent to message with `write agent://<id>`, lists the names of the secret environment variables, and tells the agent to start a dev server detached and name its port.
- **A model's delegation starts blank.** The agent gets the context and task, not the conversation, unless the call passes `conversation: "full"`.
- **`delegate` names the agent it started.** It answers ``task N: agent `<Name>` (thread <id>) started`` with the conversation and MCP servers that shipped (`mcp servers:`), a `next:` line, and the files left on this machine. The session writes an `omp-cloud-thread` entry at once, which a resumed session reads like the launch cards of older sessions.
- **Results arrive as `<task-result>`.** A finished turn comes as `<task-result id="<Name>" agent="cloud" status="…">` like a `task` subagent's, with the reply inline up to 5000 characters and a preview beyond that. The reply is escaped so it cannot close the envelope or forge a notice.
- **Model fallback.** When the session's model is not one the cloud serves and the model named none, the tool's `delegate` runs the cloud's default model and says so in `warnings`. `/cloud <task>` keeps its login offer.
- **Clearer model and login errors.** A named model the cloud does not serve is `invalid` (`this cloud does not serve <model>`, with the served ids in the hint). A cloud with no model login is `not_configured` (`this cloud has no model login yet`), and the hint tells the model to ask you to run `/cloud login <provider>`, or from a paired device `omp-cloud login <provider>` on the server machine.
- **`/cloud connect` switches a session without threads to the new pairing.** It says `new sessions use … first` when a `url` is configured.
- **An `Idempotency-Key` is bound to `policy.readOnly` as well as the prompt.** A replay never returns a writable thread for a read-only request. A key stored before this release replays as a request without it. A `delegate` repeated with the same `ref` after plan mode is a `conflict`.
- **Prompts and replies are formatted on a thread's dashboard page.** The Turns card renders headings, bold, italics, strikethrough, inline code and code blocks, ordered, nested and task lists, tables (wide ones scroll sideways), block quotes and rules, where it showed raw Markdown. The page still shows the first 2000 bytes of a prompt, so a long one can end mid-list or mid-table. The release notes window looks as before.
- **Thread titles drop Markdown heading markers.** A prompt that starts with `# Goal` was titled `# Goal`. A heading loses its `#` markers, an empty one is skipped, and a heading of three words or fewer joins the line under it: `Goal: Fix the bug`. Threads created before keep their titles.
- **`whoami` reports `api: 5`.** It adds the capabilities `threads.readonly` (the `policy.readOnly` key) and `threads.subagent` (the `ask`-less subagent threads).

### Fixed

- **A recovered thread's launch card read `failed`.** A thread that recovered after a failed first turn showed turn 1's state. The card now follows the newest turn, and from turn 2 on its header names the turn (`turn 3 done`).
- **A model's launch card landed at the end of the run.** The `[cloud] Started cloud thread …` card looked like a new handoff and told the model that results arrive as `[cloud]` messages. A model's delegation no longer posts it.
- **A woken turn's report reached the model three times.** A turn a message woke (`cloud send`, `write agent://<id>`) arrived as the wake relay, a `[cloud]` turn card and the `<task-result>` a blocked `wait` returned. It now arrives once, as the wake relay, and `wait` returns a pointer to it.
- **Focusing a cloud agent in the Agent Hub failed.** Opening a running agent's detail (Tern's included) failed with `this.ctx.viewSession.agent.getPendingToolResults is not a function`. A focused agent now answers as a session with no local tools, retries, compaction, queue or todos, and shows its conversation, run state, and its model, context and cost in the status line.
- **A running agent's hub row showed `$0.0000`.** The row and the status line's cost total ignored the running first turn while the job tile showed its real cost. The session now adds the running turn's requests, tokens and cost, so the row, the total and the tile agree.

### Security

- **ssh pairing judges a host name by where it points.** `/cloud connect user@host` and the tool's `connect` no longer need `--allow-public` for a name outside `.local`, `.lan`, `.home.arpa` and `.internal` when every address it resolves to while pairing is local. A name that resolves to a public address and a public IP address are still refused without the flag, and a pairing code's names are still judged by their text.
- **A dashboard reply cannot make the page fetch anything.** Turn text is never inserted as HTML, only `http` and `https` links are clickable, and an image is shown as a link and never loaded.

## 0.6.1 (2026-10-22)

Cloud agents no longer receive or return omp memory, and a secret an agent printed no longer reaches a pull request.

### Upgrade notes

- **A database migration drops the `memory_bank` column.** An update takes a backup before it swaps the binary; on a checkout, run `mise run backup` before `git pull`.
- **The first thread after the update waits once.** The VM template is rebuilt; a VM that already exists keeps working from the old one.
- **Cloud agents share no memory with your local omp.** Nothing is shipped into the VM and nothing is merged back; what your local omp learns from a cloud result is what it retains itself.

### Changed

- **omp in the VM runs with memory off.** The service sets `memory.backend: off` in its config, which wins over the `config.yml` and overlays you ship.
- **The plugin ships no memory settings.** It ships no `~/.omp/agent/memories` and keeps the `memory`, `mnemopi` and `hindsight` settings out of the shipped `config.yml` and overlays.
- **`/cloud pull`, `/cloud resume` and a followed thread merge no memory.** Your local omp keeps its own memory untouched.
- **The memory API is gone.** The service drops `GET /api/v1/threads/{id}/memory`, the create request's `memory` field (an older client's is ignored like any unknown field), the threads' `memoryBank`, `whoami.vmWorkspace` and the capability `threads.memory`.
- **The VM template no longer installs `sqlite3`.** Only the memory export needed it, so the template's tag changes.

### Security

- **A secret the cloud agent printed no longer reaches a pull request.** omp prints the real value to you, and the pull request's description quotes the reply. The service now replaces every secret value delivered to the thread (its `secretEnv`, secret files and the Secrets that match its repository) with `[secret <NAME>]`, or `[secret file <path>]`, in the title and the description's omp-cloud section.
- **Short and displayed values.** Env values under 4 characters are left alone, as in masking. The reply on the service, the dashboard and your omp is unchanged.
- **A pull request waits when the secrets cannot be read.** If the thread's secrets cannot be read, the pull request is not opened or updated and a `pr` event says `pull request not updated: could not read the thread's secrets: <reason>`. The push is unaffected.
- **Your local memory store no longer ships into the VM.** Every handoff shipped the whole store, all projects included, where the agent and anything it read or ran could read it.
- **Cloud memory no longer merges into your local store.** What a cloud agent retained used to be merged into the store your local omp recalls from.

## 0.6.0 (2026-10-22)

GitHub becomes a first-class host (a GitHub App, Verified commits, draft pull requests), and cloud agents get Secrets, MCP servers, per-repository environments, previews and a configurable VM toolchain.

### Upgrade notes

- **Rerun `omp-cloud setup` and restart the service.** Setup adds the `mcp` section to `service.json`; without it the service runs without the MCP proxy and http MCP servers are not delivered.
- **The first thread after the update waits once for a VM template rebuild.** The template gains `sqlite3` and a bigger default `vm.packages`. VMs that already exist keep their template.
- **The database is migrated forward, one way.** An update takes a backup before it swaps the binary; on a checkout, run `mise run backup` before `git pull`. The previous version cannot open the database afterwards.
- **A handoff no longer ships some of your omp settings.** Credentials, host paths and `!command` values stay on your machine; the launch card says which.

### Added

- **GitHub, set up once from the dashboard.** The GitHub page connects a private GitHub App on your account, or an organization you name, through GitHub's manifest flow. "Install on repositories" chooses which repositories it reaches. See `docs/github.md`.
- **GitHub fetches and pushes use the App.** `github.com` counts as a host the service holds a credential for and needs no `git.hosts` entry. Each fetch or push uses a one-hour installation token for that one repository, and handoffs from github.com repositories ship only what GitHub lacks.
- **Fallback where the App is not installed.** A `github.com` entry in `git.hosts` is still used there. Without one, the fetch or push says `the GitHub App <slug> is not installed on <owner>/<repo>` and links the install page.
- **Verified commits.** Make a signing key on the GitHub page, add its public key to GitHub as a Signing Key and set `git.sign` to `ssh` (default `off`). After each turn the service re-signs that turn's commits with its own Ed25519 SSH key, and the VM adopts the signed tip, so the next turn, the stored result, `/cloud pull` and the push carry the same commits.
- **Signing is safe to switch on later.** Only the turn's new commits are rewritten, and commits an earlier turn already exposed keep their ids. A failure leaves the unsigned result with a `notice` event, and after a push the thread's events say whether GitHub shows the head as Verified.
- **Committer for signed commits.** The committer is the App owner's noreply address. An App owned by an organization has none: set `git.committer` (`Name <email>`) to an address verified on the account that holds the key.
- **Draft pull requests.** After a push to a github.com repository the App is installed on, the service opens a draft pull request into the branch you handed off from. `git.pr` is `draft` (default), `ready` or `off`, and it needs `git.push` `ask` or `auto`.
- **Pull requests stay current.** Every later push updates the omp-cloud section of the body (the latest reply and `/cloud pull <id>`) and leaves what you wrote outside it. A pull request you close without merging is not reopened, and a failure never changes whether the push happened.
- **Where the pull request shows.** The thread's `pr` field, the turn card (`PR #<n> <url>`), the dashboard's thread page and the `cloud` tool's `status` show it.
- **Signed handoff commit.** When your repository signs commits (`commit.gpgsign`), the commit that carries your uncommitted work is signed with your key too. A hardware key or pinentry prompt that takes more than 30 seconds falls back to an unsigned commit with the launch warning `the handoff commit is unsigned: <reason>`.
- **`/cloud <task>` offers the missing login.** When the cloud has no login for the model's provider and you are on the server machine in omp's interactive UI, omp asks whether to log the cloud in now instead of refusing. Yes runs the same sign-in as `/cloud login <provider>` and hands the task off.
- **Secrets, set once on the service.** The dashboard's Secrets page (and `PUT /api/v1/secrets/{name}` with the owner token) defines an environment variable with a literal value or a `!command` that prints it, plus the repositories whose threads receive it, as globs such as `github.com/acme/*`. The repositories are required and never implied; `*` means every thread.
- **How threads receive Secrets.** A thread's VM gets the matching secrets, merged under its own `secretEnv`, in an env file omp is started under, with omp's secret obfuscation on so values are masked in what reaches the model. A change reaches a thread when its VM is next provisioned.
- **Secrets report, never serve.** Values are never served. The thread gets a `notice` when a `!command` fails, and a `vm` event lists the names.
- **MCP servers go with the handoff.** The servers of `~/.omp/agent/mcp.json` ship with `/cloud <task>`. The launch card has an `mcp` row, and a server that cannot ship (SSE, a loopback URL, a header that does not resolve, literal values in a stdio `env`) stays home with a warning that says why.
- **How each MCP server type ships.** An http server goes through a new MCP proxy on the service, which adds the server's headers and OAuth token. A stdio server runs in the VM with its `env` written as `${NAME}` references to your Secrets.
- **MCP logins.** `/cloud login mcp:<https url>` or `omp-cloud login mcp:<https url>` logs the service in to an MCP server's OAuth (discovery and dynamic client registration included). The token is kept in the service's database and refreshed on use, and only the owner token, on the server machine, can do it.
- **The cloud agent shares your Mnemopi memory.** When your omp uses Mnemopi's per-project banks (`memory.backend` `mnemopi`, `mnemopi.scoping` `per-project` or `per-project-tagged`, no `mnemopi.dbPath`), the plugin renames your project's bank to the name omp derives for the VM's working directory (`/home/user/work`). The agent's recall then sees what you retained, and your own store is not touched.
- **What the cloud agent remembers comes back.** After every turn the service snapshots the VM's Mnemopi databases into `memory.tar`, replacing the last one. When you follow, `/cloud pull` or `/cloud resume` a thread, your plugin merges the new working memories (created after the thread began, not already in your store by id or content) and their annotations into your default store and the project bank.
- **Limits of the memory return.** Only new rows merge: edits and deletions in the VM, other banks and embeddings do not come back, and a custom `mnemopi.dbPath` or another memory backend is left alone. Read "Cloud memories" in `docs/security.md`; how it works is in `docs/commands.md` (Memory).
- **Memory merge messages.** When you have no database yet, the merge waits with `☁ the cloud memories of <id> are not merged yet: <reason>` until your omp makes one. A failed merge is the warning `☁ could not merge the cloud memories of <id>: <reason>` and never fails the pull.
- **The VM toolchain is a setting.** `vm.packages` (the Debian packages of the VM template) and `vm.setup` (shell lines run as root when the template is built) are edited on the dashboard's Settings page. A package that does not exist, or a failing line, fails the build and the threads that need it until you fix the setting. See `docs/environments.md`.
- **Repository environments.** A repository's `.omp-cloud.yml` takes a `setup: {run, cacheFiles}` script, read only from the repository's file (your personal file ignores it with a warning). The service runs it once in a throwaway VM and keeps the disk as a vibemon snapshot, so the next thread on that repository starts with its dependencies installed. The launch card has an `env setup` row.
- **When an environment is built or reused.** The cache key is the template, the repository, the script and the contents of `cacheFiles`, so a changed lockfile builds a new one. Only a thread's first VM builds; a restore starts from a cached environment or the plain template.
- **Default `cacheFiles`.** `bun.lock`, `bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`, `uv.lock`, `requirements.txt`, `Gemfile.lock` and `composer.lock`.
- **A failed setup never blocks the thread.** It records `environment setup failed: exit <code>: …` and the thread starts from the template.
- **How the environment build runs.** It runs in a sandbox of its own (`app` `omp-cloud-env`), with the repository's Secrets in its environment, the thread's egress and a 30 minute limit. The lifecycle sweep kills one a dead service left past 2 hours. At most 20 environments are kept: those of an old template first, then the least recently used.
- **Previews.** `/cloud preview <id> <port>` opens a web server the cloud agent runs in its VM in your browser, and `/cloud preview stop` ends it. The service relays requests to the VM's port through vibemon, resumes a paused VM and postpones its idle pause while you look. The plugin serves it at `http://localhost:<a free local port>/`. Websockets are not forwarded.
- **The model can preview too.** The `cloud` tool has a 15th op, `preview`: `{op: "preview", thread, port}` opens a port of a cloud agent's VM at `http://localhost:<lp>/` and returns the address, so the model can open it with omp's browser tool. `{op: "preview", stop: true}` (optionally with `thread` and `port`) ends previews. It asks for approval like `send` and needs the capability `threads.preview`.
- **Previews are shared.** A call reuses a preview you started, and `/cloud preview stop`, `/cloud disconnect` and ending omp end the model's too.
- **Docker in a VM.** Add `docker.io` to `vm.packages` and `usermod -aG docker user` to `vm.setup`. Debian starts the daemon itself, and `docker run hello-world` works as the VM's user without `sudo`. See `docs/configuration.md` (Docker).
- **Service API 4.** `whoami` reports `api: 4`, the capabilities `github.app`, `commits.signed` and `threads.pr`, and `github: {app, signing}`; threads carry `pr`. New settings are `git.sign`, `git.committer` and `git.pr`.
- **Service API 4 routes.** New owner-only routes: `GET`/`DELETE /api/v1/github`, `POST /api/v1/github/manifest` and `/conversions`, `GET /api/v1/signing`, and `POST`/`DELETE /api/v1/signing/key`.
- **Service API: secrets and MCP.** `whoami` also reports the capabilities `secrets.store` and `mcp.proxy`, `mcpProxy` and `mcpLogins`, and thread creation takes an `mcp` array. New owner-only routes: `GET /api/v1/secrets` and `PUT`/`DELETE /api/v1/secrets/{name}`.
- **Service API: memory.** `whoami` reports the capability `threads.memory` and `vmWorkspace`; a create request takes `memory: {bank}` and threads carry `memoryBank`. `GET /api/v1/threads/{id}/memory` serves the export (`application/x-tar`, `404` `no memory yet`).
- **Service API: environments and previews.** `whoami` reports the capabilities `threads.setup` and `threads.preview`; a create request takes `setup: {run, cacheFiles?}` and the thread detail carries `setup`. New settings are `vm.packages` and `vm.setup`, with `vm` events for the environment steps.
- **Preview route.** Any method on `/api/v1/threads/{id}/ports/{port}[/<path>]` is relayed to the VM. It answers `400` for a bad port or 49983, `409` without a VM, `501` for a websocket upgrade and `502` when vibemon does not answer.
- **Backups include GitHub and signing keys.** `omp-cloud backup` carries `github/` and `signing/` when they exist, so a restore brings the App and the signing key back. The secrets, MCP login and memory tables are in the database, which it already carries.

### Changed

- **A bigger default VM toolchain.** The default `vm.packages` is `build-essential`, `python3`, `python3-venv`, `python3-pip`, `nodejs`, `npm`, `unzip` and `ripgrep`, so a cloud agent starts with a toolchain and a stdio MCP server that needs node or python has its runtime.
- **Any toolchain change rebuilds the template.** Any change to `vm.packages` or `vm.setup`, the default included, gives the template a new tag. The first thread after it waits once for the rebuild, and `omp-cloud doctor` checks the template of the recipe you have stored.
- **The VM template gains `sqlite3`.** The recipe change gives the template a new tag. A VM already running from the old template keeps working and exports no memory until it is replaced.
- **Restoring a repository runs `git clean -fdq`.** It removes untracked files a snapshot left and keeps ignored ones, so dependencies should live in ignored directories.
- **A memory export failure is a notice, not a failed turn.** The `notice` event says `the memory could not be saved: <reason>` (the last line `sqlite3` or `tar` printed). A VM with no memory or no `sqlite3` exports nothing and says nothing, whatever exit code that `sqlite3` version uses.

### Fixed

- **A resumed thread hung after another thread's VM was deleted.** vibemon gives a paused VM's address up, so another thread's VM could take it and, when deleted, leave a connection on the host that answered the resumed VM's old connection to the model or gateway with nothing, and its next turn waited until the turn timeout.
- **A resume now drops the paused VM's connections.** A `vm` event says `dropped the connections the paused VM held from <addresses>`, and the agent opens fresh ones.
- **Release notes showed raw Markdown in the dashboard.** The "What's new" window (header) and the Settings card's "Release notes" window ran `**`, backticks and `-` together. They now show bullets, bold titles, `code`, emphasis, headings and links; only `http` and `https` links are clickable, and the notes are never inserted as HTML.

### Security

- **The GitHub App cannot change workflows.** It has Contents, Pull requests and Metadata permissions and no Workflows permission, so GitHub refuses, on purpose, a push that changes `.github/workflows/*`.
- **GitHub credentials stay out of VMs.** The installation token never enters a VM, and the App's private key is `<dataDir>/github/app.pem` (0600). The signing key is `<dataDir>/signing/ed25519.pem` (0600).
- **Backups now hold private keys.** Keep archives that contain `github/` and `signing/` as protected as the data directory.
- **Secrets kept in the database.** Literal Secret values are stored as text, like `update.token`: keep your backups protected.
- **No MCP credential enters a VM.** The MCP proxy adds an http server's headers and OAuth token on the service side, and stdio servers get `${NAME}` references to your Secrets instead of literal values.
- **The MCP proxy blocks the service host.** It refuses an upstream that is or resolves to the service host (loopback, link-local, the gateway) and allows LAN addresses for servers in your homelab.
- **Settings that stay on your machine.** A handoff no longer ships the `auth.broker` subtree, API tokens, `shellPath`, `mnemopi.dbPath`, any value starting with `!`, endpoints that point at localhost, and the rest of the list in `docs/secrets-and-mcp.md`. The launch card warns `<file>: <key> stays on this machine` for each; `cloud` and `extensions` leave silently.
- **Cloud memories are untrusted input.** The merge reads a fixed list of archive members, attaches the database with `trusted_schema` off and takes only the columns your database has. The VM's file is never copied into place, and a database you lack is created with the schema of one you have.
- **Previews cannot reach your dashboard session.** The plugin serves a preview only on `localhost` and refuses any other host name (including `127.0.0.1`), so the previewed page never shares the dashboard's session cookie, which the forwarder also strips. The route takes bearer tokens only, and the dashboard listener answers `404` for it.
- **An environment snapshot keeps whatever the script wrote to disk.** That includes a secret: see `docs/security.md`.

## 0.5.3 (2026-10-22)

Fixes a model login that did not take effect after `omp-cloud login`, and tells a paired device the login command that works for it.

### Changed

- **A second `omp-cloud serve` stops at once.** It claims the API address first and fails with `… is already in use: the omp-cloud service is probably already running`, changing nothing.
- **The API answers `503 the service is starting` while it starts.**
- **`/cloud login` on a paired device stops before contacting the service.**
- **A paired device is told the login that works.** The handoff refusal, `/cloud login`, the hub, `/cloud status` and the `cloud` tool name the server and the command: `omp-cloud login <provider>` on the server, for example over `ssh -t`.

### Fixed

- **A login never took effect.** A second `omp-cloud serve` on the service host (for example bare `omp-cloud`, which serves by default) replaced the running service's gateway client before it failed on the taken port. After `omp-cloud login` the cloud still could not run the provider until a restart.
- **A rejected gateway client lasted until a restart.** The service now issues a new one when the gateway stops accepting its client, and reads the model list again within seconds, keeping the last list meanwhile.
- **A paired device was told to run `/cloud login`.** That failed with `only the owner token can do this`, because only the owner token, which stays on the server, can log the cloud in to a provider.

## 0.5.2 (2026-10-22)

Publishes the documentation as a website, shortens the install line and keeps the login link on screen.

### Added

- **Documentation website.** The docs are published at `https://omp-cloud.techdufus.com` with a landing page, the dashboard's look in a light and a dark theme, and search over every page. It is rebuilt on every push to `main` from `docs/*.md`, `CHANGELOG.md` and sections of `README.md`.
- **Site build tasks.** `mise run site:build` builds the site into `site/dist/` and fails on a link to a page or heading that does not exist. `mise run site:dev` previews it locally.
- **Shorter install line.** `curl -fsSL https://omp-cloud.techdufus.com/install.sh | sh` installs the server. The same `install.sh` from `main` stays available at `raw.githubusercontent.com`.

### Changed

- **`/cloud login` asks you to wait while the agent is working.** This applies to omp's interactive UI.

### Fixed

- **The login link vanished in Tern.** `/cloud login` now posts the provider's sign-in link (and a device code) as a card in the transcript, with a link to click and the full URL to copy. In Tern it was a notification that vanished after two seconds.

## 0.5.1 (2026-10-21)

omp-cloud runs omp coding agents in isolated KVM microVMs on your own hardware, driven from omp with the `/cloud` plugin and the `cloud` tool. This is the first public release; its known limitations are in `docs/architecture.md`.

### Added

- **Cloud agents.** `/cloud <task>` hands your repository (uncommitted changes included) and the conversation to an omp agent in its own KVM microVM on your hardware, running the same omp you run. It works on its own branch and asks you questions when it needs to.
- **Pause, resume and replace.** After 10 minutes idle (`runner.idleTimeoutSeconds`) the VM pauses with its processes intact, and the next message resumes it. A lost VM is replaced from the last result and conversation.
- **Pull and resume locally.** `/cloud pull <id>` fetches `omp-cloud/<id>` and saves the cloud conversation as a local omp session. `/cloud resume <id>` continues it locally.
- **The `/cloud` plugin.** Commands are `/cloud` (the hub), `[new] <task>`, `list`, `show`, `watch`, `unwatch`, `send`, `answer`, `stop`, `pull`, `resume`, `delete`, `login`, `update`, `dashboard`, `pair`, `connect`, `devices`, `disconnect`, `status` and `help`; see `docs/commands.md`.
- **Naming a thread.** A thread is named by its id, a unique suffix or prefix, a word of its name, or the job id omp shows for it.
- **Slash commands in the agent.** A message that starts with `/` runs in the cloud agent's own omp (`/usage`, `/compact`, extension commands, and so on).
- **The `cloud` tool.** omp's model drives cloud agents through one tool with 14 ops: `delegate`, `list`, `status`, `read`, `events`, `diff`, `files`, `send`, `answer`, `stop`, `wait`, `pull`, `delete` and `info`; see `docs/cloud-tool.md`.
- **Delegating from the model.** `delegate` starts one thread or up to 8 from one snapshot, and a repeated `ref` replays the first thread instead of creating another. Work that needs no repository runs as a scratch thread in an empty repository.
- **Tool errors say what is known.** Errors carry a code and say whether the outcome is known.
- **Cloud agents are omp jobs and agents.** A running cloud turn shows in omp's Subagents strip, the jobs pill, `/jobs`, Tern's Background jobs panel and `wait`, and as `proc://<id>`, with step dots, per-turn bars, a context meter, cost, tokens and a live output tail; see `docs/jobs.md`.
- **Reading and finishing cloud agents.** `agent://<id>` reads the latest reply and `history://<id>` the conversation. For a thread the model started, the finished turn arrives as omp's own async-result, and cancelling the job in omp stops the cloud turn.
- **Cloud spend in `omp stats`.** `omp stats` counts the cloud's spend with yours.
- **Messaging an agent.** `write agent://<id>` messages a cloud agent with omp's own semantics and answers with a receipt: `injected` into the running turn at its next step, `woken` for an idle agent, `revived` for an archived one. A message carries an id, so a retry is safe.
- **Agent to parent messages.** A cloud agent writes back to `agent://Parent`, and the message reaches your omp as an ordinary incoming message.
- **Live events.** A running turn writes `usage`, `tool_start` and `tool_end` events before it ends.
- **Child jobs.** Background jobs and subagents a cloud agent starts in its VM write `child_start`, `child_progress` and `child_end` events, shown under the agent's job in omp's jobs panel and `/jobs`. A child still open when the VM is paused, lost or released ends `cancelled` with the reason.
- **Questions as cards.** An agent's `ask` questions come back as cards that list their options (a click on one answers it in Tern) and open omp's own ask dialog for a thread you started.
- **A cloud inbox.** Finished turns and questions go to a cloud inbox (the footer count and the `/cloud` hub) and to the terminal's attention tray, so they cost the model nothing. `deliver: transcript` in `~/.config/omp-cloud/config.yml` posts cards instead.
- **Native in Tern.** Cards, the `/cloud` hub and the `cloud` tool's results draw as Tern's own nodes. In a terminal without Tern's protocol they are framed with omp's own output block and status line.
- **Push policy.** `git.push` is `never` (default), `ask` or `auto`. It never forces and never writes a protected branch (`git.protected`, default `main`, `master`, `develop`, `release/*`) or the remote's default branch.
- **Smaller handoffs.** For a remote whose host the service holds a credential for, the handoff ships only what the remote lacks.
- **Agent policy.** Bash rules (`policy.bash.patterns`), per-tool approvals, `policy.fetch`, `policy.webSearch`, `policy.browser` and an egress allow-list (`policy.egress`).
- **Model and spend limits.** Allowed models and spend caps per turn, thread and day (`policy.spend.*`, in USD).
- **Archive.** A thread nobody touches for `lifecycle.archiveAfterDays` (default 7, 0 never) has its VM released. Its conversation and work are kept, and the next message restores it.
- **Sweeping.** Orphaned sandboxes and gateway clients are swept.
- **The dashboard.** `/cloud dashboard` prints a one-time sign-in link to a loopback web page styled after omp's `/stats`, in a light and a dark theme.
- **Dashboard pages.** Overview, Threads by repository (with an Archived filter), a thread page with context use, cost and tokens per turn, Spend, VMs, Devices, Logins and Settings.
- **Run-time settings.** Settings are typed, apply without a restart, are audited and can be exported as YAML.
- **Pairing.** Other machines pair once, from a code (`/cloud pair`, then `/cloud connect`) or over ssh (`/cloud connect user@host`), and get their own revocable device token over a TLS connection pinned to the service host's certificate.
- **Revoking a device.** `/cloud devices revoke` ends a device immediately.
- **One-command install.** `curl -fsSL https://raw.githubusercontent.com/TechDufus/omp-cloud/main/install.sh | sh` downloads the release binary, checks its sha256 and runs `omp-cloud setup`.
- **What setup does.** It prints a plan and asks first, uses sudo once for the root work, then sets up vibemon (pinned per release), the persistent system and user units (they survive a reboot), the `omp-cloud` vibemon team (32 concurrent sandboxes by default), the service config and TLS identity, the plugin and the model login.
- **Setup is safe to rerun.** It is idempotent and never changes firewall rules.
- **Requirements.** A Linux x86_64 host with `/dev/kvm`, systemd and omp 18.12.3 or newer.
- **`omp-cloud` commands.** One binary with `setup`, `doctor`, `login`, `uninstall`, `serve` (the default), `ssh-pair`, `update`, `install`, `backup` and `version`.
- **`doctor`.** It checks the machine and the whole stack, including that your omp loads the plugin, prints the fix beside each failure and exits 1 on a failure.
- **`login` and `uninstall`.** `login [<provider>]` logs the service in to a model provider and prints the URL in full. `uninstall [--purge]` removes what setup installed and keeps your backups.
- **Daily backup.** A daily timer runs `backup`: one archive of the database, blobs and git cache.
- **Update checks.** The service checks the release feed hourly (`update.mode`: `off`, `notify` by default, `auto`) and downloads and verifies a newer release. omp shows `update ready` in the cloud footer and the hub.
- **Installing an update.** One click in the dashboard, `/cloud update` or `omp-cloud update apply` installs it, and the plugin is refreshed with it; see `docs/updating.md`.
- **Rollback.** The update waits up to 60 s for the new version to answer `/api/v1/health`, rolls back if it does not, and restores the pre-update backup when the release changed the database schema.
- **Automatic updates.** `auto` installs by itself only when no thread has been starting, working or waiting for 10 minutes and the release needs the same vibemon and database schema.
- **Service API 3.** `GET /api/v1/whoami` reports the service version, `api: 3`, the capabilities (including `threads.irc`, `events.live` and `events.children`), limits, spend and models, so a client checks for a feature before it uses it. A plugin that needs one the service lacks says so (`version_skew`); see `docs/api.md`.
- **Releases.** Each tagged version is published on GitHub Releases as one `omp-cloud` executable per architecture (linux x86_64 and arm64; `install.sh` and setup accept only x86_64) with a `release.json` manifest and sha256 sidecars. `omp-cloud version` prints the version and build id.
- **License.** omp-cloud is MIT-licensed (`LICENSE`; the plugin carries its own copy in `plugin/LICENSE`). Each release has a `THIRD-PARTY-NOTICES.txt` that lists every bundled package with its license.

### Security

- **Git credentials and the push stay out of VMs.** The service fetches bases, composes bundles and pushes results from its own git cache. A VM holds only its gateway client token.
- **Approvals always reach you.** Tool approvals, `prompt` rules and the push question always go to you, and the `cloud` tool refuses to answer them.
- **A thread can only tighten policy.** It can tighten the service's policy and never loosen it.
- **The owner token is refused remotely.** The remote listener refuses it, and accepts private source addresses by default.
