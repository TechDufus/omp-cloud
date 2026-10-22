# `/cloud` commands

[README](../README.md) · [Documentation index](../README.md#documentation)

Every `/cloud` command the plugin adds to omp, where finished turns and questions go, and the cards they land as.

| Command | Does |
|---|---|
| `/cloud` | Open the hub (the threads, their detail and actions on the keys listed below); outside omp's interactive UI, the same list as a card |
| `/cloud [new] <task>` | Hand off a task. It forks this session's conversation into the cloud agent (the model's own `cloud` delegations ship none unless it asks). A task whose first word is a command name needs `new`: `/cloud new list the open TODOs` |
| `/cloud list` | Threads as job tiles, grouped by the repository each was started from: this session's repository first and expanded, the others collapsed (up to 30 threads, then `+N more`); a tile shows the name, what the agent is doing, a context headline with its trend, a chart of context per turn, and cost, tokens, requests and tools. In Tern each tile has a hover card with the full widget and the details (title, id, repository, branch, changes, pushed, model, created, last active, VM state) |
| `/cloud show <id>` | Show the thread's latest reply and result; marks the thread read |
| `/cloud watch <id>` · `/cloud unwatch` | Follow a thread live; stop following threads live |
| `/cloud send <id> <message>` | Follow-up message; also follows the thread |
| `/cloud answer <id> [text]` | Answer the agent's question; without text, omp's ask dialog |
| `/cloud stop <id>` | Stop the running turn, cancel queued ones. Cancelling the thread's job in omp's jobs panel, `/jobs` or `proc://<id>/kill` stops the turn too; omp's own cleanup on `/clear`, a switch or a branch does not ([jobs](jobs.md#cancelling)) |
| `/cloud pull <id> [--into <dir>]` | Fetch the result branch `omp-cloud/<id>` and save the cloud conversation as a local omp session. With `--into <dir>` a repository thread's result is checked out in a new worktree there, and a [scratch thread's](cloud-tool.md#scratch-threads) result is cloned into the new directory |
| `/cloud resume <id>` | Check out `omp-cloud/<id>` and continue its conversation locally; needs a clean working tree |
| `/cloud preview <id> <port>` · `/cloud preview stop` | Open a web server the cloud agent runs on `<port>` of its VM in your browser, through a forwarder on `http://localhost:<lp>/`; `stop` ends every preview. See [Previews](#previews) |
| `/cloud delete <id>` | After a confirmation, delete the thread, its VM and gateway client |
| `/cloud login <provider>` | Log the cloud broker in to a provider (the server machine's owner connection only). The provider's sign-in link (and a device code, when it uses one) is posted in the transcript as a card to click or copy, then omp asks for the redirect URL or code the browser ended on. In omp's interactive UI the agent must be idle, so the card can appear at once. A paired device is refused before any request and told to run `omp-cloud login <provider>` on the server (over ssh: `ssh -t <user>@<host> '~/.local/bin/omp-cloud login <provider>'`); the same pointer replaces `/cloud login` in a handoff refused for a provider the cloud cannot run, in `/cloud status` and in the hub. `/cloud login mcp:<https url>` logs the service in to an MCP server's OAuth instead of a provider ([Secrets and MCP servers](secrets-and-mcp.md#logging-the-service-in-to-an-mcp-server)) |
| `/cloud update` | Check the service for a newer omp-cloud; for the owner, when one is ready, confirm and restart the service to install it. A paired device is told what the service says |
| `/cloud dashboard` | Print a one-time sign-in link (valid 60 s) to the dashboard, and open it in a browser from the interactive UI |
| `/cloud pair` | On the service host, in omp's interactive UI: show a pairing code (sent to your clipboard), approve the device that uses it ([pairing](pairing.md)) |
| `/cloud connect [<code> \| <ssh target>]` | On another machine: pair this omp with the service, from a pairing code or over ssh (`--name <name>`, `--replace`, `--allow-public`). Without an argument it asks for the code or target. A session that has no cloud threads then uses the new pairing (`this session uses it now`); a `url` in your config or `OMP_CLOUD_URL` stays the default of new sessions (`new sessions use … first`), and `/cloud use paired` picks the pairing |
| `/cloud devices` · `/cloud devices revoke <name\|id-prefix>` | List paired devices; revoke one (after a confirmation) |
| `/cloud disconnect [--force]` | Revoke this device and forget the connection |
| `/cloud use [env \| personal \| paired]` | Pick the cloud this session uses: `env` (`OMP_CLOUD_URL`), `personal` (the `url` and `token` of `~/.config/omp-cloud/config.yml`) or `paired` (the pairing of `/cloud connect`). Without an argument it lists the clouds this machine knows. The choice is stored in the session and refused once the session has cloud threads: start a new omp session to use another cloud |
| `/cloud status` | Connection and where it comes from, the delivery mode, and what the cloud can run. When this machine knows more than one cloud, or the session picked one, it also shows `cloud: <source> · <url> · <why>` (the default, or `this session's choice`), `other clouds: …` and `switch: /cloud use <name>` |
| `/cloud help` | Usage |

Wherever a command takes `<id>` (the `cloud` tool takes the same references), type the full 12-character thread id (any thread, any age) or one of these, matched case-insensitively among the newest 1000 threads, each in turn until one matches uniquely:

1. The id of the job omp shows for the thread's running turn (`PaneZoomShortcut`, with omp's `-2` suffix when an earlier turn's job still holds the id), or the job id without a suffix.
2. A suffix of the thread id (at least 4 characters).
3. A prefix of the thread id.
4. A word the thread's name starts with (`/cloud show zoom`, when no other name has a word starting with it).

A reference that matches several threads at one step is refused with up to 10 candidates; use the full id. Completion offers threads by name.

`/cloud <task>` and a provider the cloud cannot run: when the model is one of a provider the cloud has no login for, and you are on the server machine's owner connection in omp's interactive UI with the agent idle, omp asks `Log the cloud in?` (`The cloud cannot run <provider> models yet. Log the cloud broker in to <provider> now?`). Yes runs the same sign-in as `/cloud login <provider>` and then hands the task off; any other answer, a paired device, a non-interactive mode or a busy agent keeps the refusal that names `/cloud login <provider>` (the `cloud` tool never asks).

The `cloud` tool does not ask for a login. When the session's model is not one the cloud serves and the model named none, a delegation runs the cloud's default model and says so in its `warnings`; a model it named that the cloud does not serve, or a cloud with no model login, fails with a hint that tells the model to ask you to log in ([the tool](cloud-tool.md#models-and-logins)).

`/cloud <task>` also ships the MCP servers of your `~/.omp/agent/mcp.json` when the service has an MCP proxy. The launch card has an `mcp` row, `<name> (via the service)` for an http server and `<name> (in the VM)` for a stdio one, and a warning for each server or setting that stayed on your machine (`<name> points at this machine and is not shipped`, `<file>: <key> stays on this machine`, `<name> may need a cloud login: /cloud login mcp:<url>`): [Secrets and MCP servers](secrets-and-mcp.md).

Plan mode restricts only the model: while omp is in plan mode every delegation the `cloud` tool makes is read-only, and its `pull` and its messages to agents that are not read-only are refused ([the tool in plan mode](cloud-tool.md#plan-mode)). Your own `/cloud <task>`, `/cloud send` and `/cloud pull` act as you type them.

When the repository's `.omp-cloud.yml` has a `setup` script, the launch card also has an `env setup` row (`cached by bun.lock`, `cached by the default lockfiles` or `cached by the setup script alone`): the cloud installs your dependencies once and starts later threads on the repository from that result ([Environments](environments.md#per-repository-environments)). A service too old to run it gets the warning `the cloud service cannot run the setup of .omp-cloud.yml; it is not shipped`, and a `setup` in your personal config is ignored with `setup belongs in a repository's .omp-cloud.yml, ignored`.

## Memory

Cloud agents run without memory, and nothing about it needs setting up. A handoff ships no `~/.omp/agent/memories` (not the default store, not a project bank), omp in the VM runs with `memory.backend: off`, and nothing the cloud agent did comes back into your store: `/cloud pull`, `/cloud resume` and a followed thread save the conversation and the branch, never memories. Your local omp keeps its own memory untouched, so what it learns from a cloud result is what it retains itself, from the reply, the diff or the saved session. The reasons are in [Security model](security.md#memory).

## Previews

`/cloud preview <id> <port>` shows a dev server the cloud agent started in its VM. It starts a forwarder on a free port of this machine, prints `☁ preview of port <port> on <name>: http://localhost:<lp>/` and, in omp's interactive UI, opens that address in your browser. The VM is resumed if it is paused and kept awake while you use it. `/cloud preview stop` ends every preview; so do `/cloud disconnect` and ending omp.

- **Open the address exactly as printed.** The forwarder serves `localhost` only and answers `400` `open http://localhost:<lp>/` to any other host name, `127.0.0.1` included: the dashboard's session cookie lives on `127.0.0.1`, and browsers scope cookies by host, not port, so a previewed page there would run beside it.
- **No websockets.** A `501` `WebSocket upgrades are not forwarded` answers an upgrade; plain HTTP, streaming and server-sent events work, hot-reload sockets do not.
- **The agent starts the server.** A thread with no VM yet answers `409` `the thread has no VM; send it a message first`; port 49983 is refused. Ask the agent to run the server detached so it survives its command (`setsid nohup <command> >/dev/null 2>&1 &`).
- A service without the capability `threads.preview` is refused with `version_skew`.

Both forms work from a paired device. The `cloud` tool's `preview` op starts and stops the same forwarders for the model, so it can open the page with its own browser tool ([The `cloud` tool](cloud-tool.md)). More in [Environments and previews](environments.md#previews) and [API](api.md#environments-and-previews).

## Where results go

For a thread you started yourself, a finished turn (done or failed) and a question do not land in the conversation. They go to a cloud inbox you read when you are ready, and cost the model nothing:

- The footer status counts them: `☁ 3 unread`, or `☁ 2 working · 1 waiting · 3 unread`; the owner's footer also says `update ready` when an update waits for a click.
- `/cloud` opens the hub, which is the inbox: its header reads `☁ omp-cloud · <user> · N unread`, and a thread with unread entries starts with `[N new]`. Selecting a thread loads its detail and marks it read. The key `o` opens that thread's latest finished turn as a card with its buttons (it never wakes the model), marks it read and closes the hub; a thread with no finished turn yet says so. The hub footer lists the keys: `↑↓ select · s send · a answer · o open · x stop · p pull · r resume · d delete · q close`, plus `u update` while the owner has an update ready. `/cloud show` and a card's Show button mark a thread read too.
- In a terminal that supports it, the same entries reach the terminal's own attention tray through the Program Status Protocol (OSC 7501): a pending question shows as blocked, a result as done, a failure as an error, one record per thread, cleared when you read or answer it. In Tern an entry that arrives while the omp pane is unfocused fills "Needs attention" and badges the bell; one that arrives while you are looking at that pane counts as seen and gets no tray entry. Either way the pane's tab shows the state (red for a question) until you read it. It is written only on a real terminal, never headless, and only while omp's `terminal.programStatus` is on.
- A desktop notification also goes out for each entry, under omp's own switches: `completion.notify` for a finished turn, `error.notify` for a failure (off by default in omp) and `ask.notify` for a question.
- Text that comes from the cloud (thread names, the first line of a reply or error, a question) has control characters replaced with spaces before it reaches the inbox, the tray record or the notification, since some terminals write those raw. A deleted thread's entries and tray record are dropped, and a question already in the inbox is not added or notified a second time when you re-watch a waiting thread. If omp's `terminal.programStatus` is switched off and on again, or the terminal is suspended and resumed, the records are written again.
- A thread the model delegated through the `cloud` tool is the exception: its results reach the model, not the inbox ([how results arrive](jobs.md#how-results-arrive)).
- Set `deliver: transcript` in your personal `~/.config/omp-cloud/config.yml` to get cards for every thread; `deliver: tray` is the default. A repository's `.omp-cloud.yml` cannot set it (ignored, with a warning). `/cloud status` shows `deliver: tray (default)` or `deliver: transcript (~/.config/omp-cloud/config.yml)`. The inbox lives in memory for the session and holds at most 200 entries.

## Cards and buttons

Hand-offs, and the finished turns and questions of model-delegated threads (or of every thread with `deliver: transcript`, or opened with `o`), land in the transcript as cards. In Tern each ends in a row of buttons that run the command for you; a terminal UI and the model see the command hints instead.

- A launch card has Respond, Show and Stop.
- A finished turn has Respond (the main action), Pull, Resume and Show; a failed one has Respond and Show.
- A finished turn's card shows `PR #<n> <url>` when the service has opened a pull request for the thread ([GitHub](github.md#pull-requests)), in Tern, in a terminal UI and in the plain text the model sees.
- A single-choice question lists its options (the recommended one badged) and gets one Other… button; a multiple-choice or free-text question gets one Answer… button. In Tern the card lists the options the way omp's `ask` does; once answered, expired or cancelled it settles and shows the answer. In a terminal without Tern's protocol the card is framed with omp's own output block and status line, with ask markers on a question. A launch card's chip follows the newest turn the session knows of the thread (running, done, failed or cancelled), so a thread that recovered after a failed first turn reads `done`; from turn 2 on the header names the turn (`turn 3 done`). It has no chip while no turn is known. Only `/cloud <task>` posts a launch card: the `cloud` tool's delegations are recorded by the `delegate` result.
- A card announcing a service update (owner only) has a Restart to update button; a terminal UI shows `/cloud update`.
- Respond opens omp's input sheet (`Reply to <name> · <short id>`) and sends your text as `/cloud send` would. A question of a thread you started yourself opens omp's own ask dialog by itself (all of the turn's pending questions in one; tool approvals and the push question use omp's approve prompt instead, where once, session or a grant approve and deny denies; closing the dialog counts as no answer); Other… and Answer… and `/cloud answer <id>` without text take the same path, and an omp without those APIs asks with its select and input prompts. A question of a thread the model follows wakes the model through its card instead (the model answers an `ask` question through the `cloud` tool or asks you). Agents the model starts have no `ask`, so that is only a thread you started that the model adopted, or one on a service without the capability `threads.subagent`; approvals and pushes are always yours, and each question card is posted once. The other buttons run their verbs; Resume switches the session, so where a button has no command context it asks you to type `/cloud resume <id>`.
- In Tern the `/cloud` hub is native as well: the threads are a list you select with the keys the footer shows, the selected thread's job tile is shown with its detail, and the actions are buttons with their key caps.

A text box inside a card is not offered: in omp it would fight the composer for focus, so Respond uses the sheet.

## Slash commands in the cloud agent

A message to a cloud agent that starts with `/` (`/cloud send <id> /usage`, or the Respond button) runs in the agent's own omp, like a command typed there, when omp can run it over its RPC mode:

- Built-ins with a non-interactive handler work (`/usage`, `/compact`, `/handoff`, …), and so do extension and custom commands, skills and file commands.
- Terminal-only commands and names omp does not know reach the agent as plain text, as they do in omp.
- A built-in command ends its turn about a second after omp answers, not after the usual wait, and its reply is the command's output (plus any messages an extension command prints), cut at 100,000 characters. A built-in that keeps running after it answers (`/compact`, `/handoff`, a bare `/rename`) keeps the turn open until the agent is idle and not compacting, and what it prints meanwhile is the reply. Such a turn costs no model requests, commits only if the command changed files, and pushes nothing; the next model turn pushes what a command changed. The conversation is saved as after any turn.
- `/usage` reports the agent's own provider usage, which is usually empty in a cloud VM, so omp falls back to the session's token tally and cost. It is not your local quota.
- An extension command whose handler goes on to ask the model is an ordinary model turn: the reply is the agent's text, usage is recorded and the result is committed and pushed as usual. Output that arrives while no turn is running is dropped.

The model's side of all this, the `cloud` tool, is in [The cloud tool](cloud-tool.md).
