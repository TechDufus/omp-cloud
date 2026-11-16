# Cloud agents in an editor (ACP)

[README](../README.md) · [Documentation index](../README.md#documentation)

`omp-cloud acp` is an agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) on stdio. An editor that hosts ACP agents starts it, and each of its sessions is a cloud thread: the first prompt hands your workspace off, the reply shows as it is written, and the result comes back as a branch.

## Setting it up

- **The connection is this machine's.** The agent uses what `/cloud` uses: `OMP_CLOUD_URL` and `OMP_CLOUD_TOKEN`, else the personal `config.yml`, else this machine's pairing ([Client config](configuration.md#client-config)). It has no login of its own; without a connection every session fails with the same `omp-cloud is not configured` text, as an authentication error.
- **The command is `omp-cloud acp`.** That is the release binary (Linux x86_64 and arm64), or in a checkout the wrapper `~/.local/bin/omp-cloud` that `mise run infra:up` writes. It takes no arguments, and stdout carries only protocol frames.
- **In Zed**, add it to `agent_servers` in the settings and start a thread with that agent in a git repository:

  ```json
  {
    "agent_servers": {
      "omp-cloud": { "type": "custom", "command": "omp-cloud", "args": ["acp"] }
    }
  }
  ```

- **The service** must serve `threads.meta`, `threads.idempotency`, `threads.paging`, `events.live` and `events.json`; a session is refused otherwise. With [`events.text`](api.md#reply-text) (Service API 7) a reply streams; without it each assistant message arrives whole when it ends.

## A session is a thread

- **Nothing exists until the first prompt.** A new session offers two options, the model (`Cloud default`, or one the cloud can run) and the thinking level. They are fixed once the thread has started.
- **The first prompt hands off.** It ships what `/cloud` ships, without a conversation: the repository of the session's directory with its uncommitted work (credential-named files stay here), your `~/.omp/agent` setup, the enabled extensions and the MCP servers of omp's `mcp.json`. The cloud agent runs the service's omp version. Outside a git repository the thread is a [scratch thread](cloud-tool.md#scratch-threads). A tool call `omp-cloud thread <id> started` lists what shipped and every warning. MCP servers the editor passes to the session are not shipped, and the list says so.
- **Every later prompt is a message** to the thread. A prompt is text and file links (`@<path>`, relative to the session's directory); any other content is refused.
- **What you see.** The reply as omp writes it, each tool call with its intent and whether it failed, the context meter, and the service's own progress (the VM, a push, a pull request) as thoughts. Thinking text and the cloud agent's own subagents are not shown. A turn that changed files ends with a line naming the result branch.
- **Cancel** stops the thread's running turn, as `/cloud stop` does.
- **The thread is an ordinary thread**: `/cloud list` in omp shows it, and a thread started in omp opens in the editor by its id.

## Questions

- **A question of the cloud agent** (its `ask` tool) is shown as text with numbered options, and the prompt ends. Your next prompt is the answer: a number, an option's label, or your own words; for a question that takes several, numbers or labels separated by commas. A question with several parts is asked one part per prompt.
- **An approval or a push question** opens the editor's permission dialog; its choice is the answer. Dismissing the dialog answers nothing, and the question times out as it does anywhere else.

## Commands

The agent has two commands of its own; every other slash command is a message for the cloud agent ([Slash commands in the cloud agent](commands.md#slash-commands-in-the-cloud-agent)).

- `/pull` fetches the thread's result as `omp-cloud/<id>` into the session's repository and says what to do next; `/pull merge` also fast-forwards the current branch (a clean working tree only). Nothing is fetched by itself after a turn.
- `/follow` shows the turn the thread is running now: one another device started, or one that was running when the session was loaded.

## Loading and listing

- **The session list** is the cloud's threads, those of the workspace when the editor names one. A thread a session of this agent made is listed under its session id (`acp-…`, the thread's `ref`), any other under its thread id.
- **Loading a session** replays the thread: each turn's prompt, its tool calls and its reply. Every finished turn's reply is whole; an assistant message in the middle of a turn is as the event log holds it, at most 500 characters, because reply text streams and is not stored. A turn still running is shown up to its last stored event, and `/follow` or the next prompt continues from there.

What has not been run, and the other limits, are under [Known limitations](architecture.md#known-limitations).
