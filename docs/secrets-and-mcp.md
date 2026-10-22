# Secrets and MCP servers

[README](../README.md) · [Documentation index](../README.md#documentation)

Configure a credential once on the service and every cloud agent that works on a repository you name gets it, without it ever being in a handoff from your laptop. MCP servers your omp already uses go with a handoff too: the ones that need a login are reached through the service, which holds the credential and keeps it out of the VM. What the trust boundary looks like is in [Security model](security.md#secrets-and-mcp); the routes are in [API](api.md#secrets-and-mcp-servers).

What it needs: nothing but the service. The Secrets page is in the dashboard ([Configuration](configuration.md#service-config)) and the same routes answer the owner token. MCP servers need the service's MCP proxy ([below](#the-proxy)), which `omp-cloud setup` configures.

## Secrets

A secret is an environment variable the service puts in the VM of each thread whose repository matches the secret's `repos`. There are two ways to give an agent an environment value, and they do not replace each other:

| | Set where | Scoped by | Use it for |
|---|---|---|---|
| **Secrets** (this page) | Once, on the service | The repositories you list | Tokens and keys every agent on those repositories needs; the `${NAME}` an MCP server's `env` refers to |
| `secretEnv` ([client config](configuration.md#client-config)) | On your machine, in each handoff | That handoff | A value only this task needs, taken from your shell's environment |

### Add one

On the dashboard's **Secrets** page (Access group, hotkey `k`): a table of the secrets (name, repositories, kind, when updated), a form to add or replace one, and Delete behind a confirmation. Choosing a row to replace fills the name and repositories; the value is never shown, here or anywhere, so you type it again. Or with the owner token, through [`PUT /api/v1/secrets/{name}`](api.md#secrets-and-mcp-servers):

```json
{"value": "!op read op://Private/npm/token", "repos": ["github.com/acme/*"]}
```

- **Name.** A valid variable name, at most 128 characters, not `HOME` or `PATH` and not starting with `OMP_` or `MISE_`.
- **Value.** 1 to 65536 characters of text with no NUL. A value that starts with `!` is a **command**: the service runs the rest with `/bin/sh -c` each time it provisions a VM (in the service's own environment, with the units' fixed `PATH`: [Configuration](configuration.md#service-config)), and uses its one line of printable output. The command has 10 seconds, its output is cached in memory for 5 minutes, and nothing of its output or errors is logged. Anything else is a **literal**, stored as you typed it. A value that is only `!` is refused; a literal that must start with `!` cannot be stored.
- **`repos`** is required, with no default: 1 to 50 globs of at most 200 characters without whitespace. A missing or empty list is refused, so a secret never reaches repositories you did not name ([below](#which-threads-get-a-secret)).

Saving a name that exists replaces its value and its repositories. Deleting removes it for threads provisioned afterwards.

### Which threads get a secret

Each glob is matched against the thread's **repository key**, case-insensitively: `<host>/<path>` of the remote URL without `.git` (`github.com/acme/app`), or `local/<repo name>` for a thread that has no remote (a [scratch thread](cloud-tool.md#scratch-threads) is `local/scratch`). `*` matches any run of characters, `/` included.

| Glob | Matches |
|---|---|
| `github.com/acme/app` | that repository |
| `github.com/acme/*` | every repository of `acme` |
| `github.com/*` | every github.com repository |
| `local/*` | threads without a remote |
| `*` | every thread, remote or not |

`*` is the only way to mean "all": an empty list never does. A secret scoped to `*` also reaches scratch threads and threads on repositories you do not control, so scope credentials as narrowly as the work allows.

### How it reaches the VM

When the service creates or restores a VM it resolves the matching secrets (a `!command` that fails is left out, and the thread gets a `notice` event `secret <NAME> was not delivered: <reason>` without any output of the command; the VM still starts) and writes them with the thread's own `secretEnv` into one file, `~/.omp-cloud/env` (0600), as `KEY='value'` lines. Anything omp starts under is started with that file sourced, so a value is in the environment of omp and every tool it runs but never on a command line the sandbox API lists. The thread's own `secretEnv` wins when both name a variable. A `vm` event, `secret env: <names>`, lists the names and never a value.

Two things follow from provisioning being the moment of delivery: a changed or deleted secret reaches a thread only when its VM is next provisioned (a [restore or an archive revival](archive.md); a paused VM resumes with the environment it had), and the agent in the VM can read its own environment, which is the point.

**Masking.** Whenever the VM got env values or secret files, provisioning also writes `~/.omp/agent/secrets.yml` (0600) and turns on omp's secret obfuscation (`secrets.enabled`) in the VM's config. It holds one `obfuscate` entry per env value of at least 4 characters and per shipped secret file whose content is valid UTF-8 and at most 64 KiB. omp then replaces those strings in what it sends to the model. This keeps a value out of the conversation when an agent echoes it. It is string replacement, not a boundary: see [Known limitations](architecture.md#known-limitations).

## MCP servers

omp reads MCP servers from `mcp.json` in its agent directory. At handoff the plugin reads `~/.omp/agent/mcp.json` and then `~/.omp/agent/.mcp.json` (the first file defining a name wins), skips names in `disabledServers` and servers with `enabled: false`, and sends the rest in the thread request's `mcp` field ([API](api.md#creating-a-thread)). The launch card gets an `mcp` row: `<name> (via the service)` or `<name> (in the VM)`. Your `mcp.json` itself is never part of the shipped setup: the VM gets its own, written when it is provisioned (0600), and the system prompt names the servers (`MCP servers: <names>; the http ones are reached through the service, never print their tokens.`).

| Server | Becomes | Needs |
|---|---|---|
| `type: "http"`, or a `url` with no `type` | An http server in the VM that points at the service's proxy | The service's MCP proxy |
| `stdio` (a `command`) | The same server, run inside the VM | Its `env` values written as `${NAME}`; the command present in the VM |
| `type: "sse"` | Not shipped: `<name> is not shipped: SSE MCP servers are not proxied; use type http` | |
| Any server whose URL host is `localhost`, `127.*` or `[::1]` | Not shipped: `<name> points at this machine and is not shipped` | |

A service that lacks the proxy capability takes none: `the cloud service cannot take MCP servers; none are shipped`. One that has the capability but is not listening ([the proxy](#the-proxy)) takes only stdio servers: `the cloud has no MCP proxy; http MCP servers are not shipped`.

A read-only thread (`policy.readOnly`, which the plugin sets on every delegation the model makes in plan mode) takes none: the plugin does not even resolve the servers' `!command` headers, and a service that is handed some anyway writes no `mcp.json` and no proxy token for it (`MCP servers not delivered: the thread is read-only (<names>)`). The `cloud` tool's delegate result names the servers that did ship (`mcp servers: <name> (through the service | in the VM)`).

### http servers go through the service

The plugin resolves each header the way omp does (`${VAR}` and `${VAR:-default}` from your environment first, then a `!command`, an environment variable name or a literal) and sends the result with the request. A header that does not resolve keeps the server home: `<name> is not shipped: header <H> did not resolve`. The service keeps the headers in the thread's `secrets.json`, which is never served.

In the VM the server's entry is `http://<mcp.listen>/mcp/<name>` with `Authorization: Bearer <token>`. The token is 32 random bytes made each time the VM is provisioned; the service stores only its SHA-256, and it works for that one thread's servers. The upstream's own headers, and any OAuth token the service holds, are added by the proxy and never leave the service.

A server whose URL has no `Authorization` header and no login the service knows gets a launch warning: `<name> may need a cloud login: /cloud login mcp:<url>`.

### stdio servers run in the VM

A stdio server is the VM's own process, with the VM's network and egress. Its `command` must exist there: the VM is the template's Debian image with git, curl, jq, omp and the packages of the `vm.packages` setting (node, npm and python3 by default, [Environments](environments.md#the-vm-toolchain)), so a server that needs another runtime has none unless you add its package to `vm.packages` or the agent installs it. Its `args` and a **relative** `cwd` ship as written. Its `env` may hold only references, `${NAME}` or `${NAME:-default}`, which omp fills from the VM's environment: create the value as a [Secret](#secrets) scoped to the repositories that use the server. A literal value keeps the server home: `<name> is not shipped: its env has literal values; put them in the cloud's Secrets and reference them as ${NAME}`. Only `env` is checked: do not put credentials in `args`.

### The proxy

The proxy is a second listener of the service, on the gateway address so a VM can reach it, set by `service.json` `mcp.listen` ([Configuration](configuration.md#mcp-proxy)); `omp-cloud setup` writes `10.254.254.1:4100`. A request to `/mcp/<name>`:

1. needs `Authorization: Bearer <token>` of a thread that has not failed (otherwise `401 {"error": "unknown token"}`) and a path that is exactly `/mcp/<name>` (otherwise `404`); a name the thread did not ship is `404 no MCP server <name>`;
2. is refused with `403 the MCP server resolves to the service host` when the upstream host is or resolves to a loopback, unspecified or link-local address or the service's own (gateway, proxy) address; LAN addresses are allowed, for servers on your homelab;
3. is forwarded to the server's URL with the VM's request headers except `Authorization`, `Cookie`, `Host` and the connection's framing, plus the server's headers, or `Authorization: Bearer <OAuth token>` when the server has none and the service has a login for its URL;
4. streams back, so server-sent events arrive as they are sent and `Mcp-Session-Id` makes the round trip. A redirect is not followed: the VM sees the `3xx`. A server that does not answer is `502 {"error": "the MCP server did not answer: <reason>"}`.

### Logging the service in to an MCP server

An MCP server that wants OAuth (most hosted ones) needs one login, made on the service host, not copied from your omp:

```text
/cloud login mcp:https://mcp.example.com/mcp      # in omp on the server machine
omp-cloud login mcp:https://mcp.example.com/mcp   # or in a shell on the server
```

The URL is the server's `url` in `mcp.json`, exactly: the login is stored under it, and a server is matched by that string. Only `https` URLs. The flow is omp's own (endpoint discovery, dynamic client registration and the browser sign-in) and runs like a [provider login](api.md#logins): the sign-in link appears as a card, and when the provider redirects to a `localhost` page that does not load, you paste that page's URL back. Paired devices cannot log in; run it on the server.

The service keeps the token and its refresh token in its database and refreshes the token when it expires within 5 minutes, one refresh at a time per URL. If a refresh fails the proxy sends the request without a token, the server answers `401`, and the service logs `refreshing the MCP login for <url> failed` once: log in again. `whoami.mcpLogins` lists the URLs the service has a login for; a login serves every thread that ships that URL without its own `Authorization` header, like the model login.

If the server's OAuth cannot complete (it advertises no endpoints: `the MCP server <url> advertises no OAuth endpoints`; or it pins a client and a fixed redirect port), the login fails with its message; such a server works through the proxy only with a static header.

## Settings that stay on your machine

Your omp settings (`~/.omp/agent/config.yml` and the `--config` overlays the session loaded) ship to the VM, but not all of them can work there or should be there. The plugin removes these keys from the copy it ships, at any depth and also as dotted top-level keys (`"auth.broker.url"`), and the launch card warns `<file name>: <key> stays on this machine`:

- **Silently:** `cloud`, `extensions`, and the memory settings `memory`, `mnemopi` and `hindsight` (top level, whole subtrees: cloud agents run without memory, whatever your omp's backend is).
- **The broker login:** the `auth.broker` subtree.
- **Credentials:** `images.urls.credentials`, `dev.autoqaPush.token`, `searxng.token`, `searxng.basicPassword`.
- **Host paths and settings of this machine:** `shellPath`, `shellMinimizer.settingsPath`, `plan.autosaveDir`, `browser.screenshotDir`, `browser.cdpUrl`, `browser.relayUrl`, `skills.customDirectories`, `workspace.additionalDirectories`, `ida.installDir`, `images.urls.command`, `images.urls.sshTarget`, `images.urls.bindHost`, `images.urls.publicBaseUrl`.
- **Commands:** any string value, at any depth, that starts with `!` (omp runs it as a shell command on the machine it is configured on).
- **Local endpoints:** `searxng.endpoint` and `compaction.remoteEndpoint` when the URL's host is `localhost`, `127.*`, `[::1]` or `0.0.0.0`.

A mapping that the removal empties is dropped too. The file is rewritten only when something was removed, and your own files are never changed. If a setting that stayed home is one the agent needs, provide it the cloud's way: a [Secret](#secrets) for a token, a public endpoint instead of a local one.

## Where it lives

- The service database holds the `secrets` table (name, value, repositories, who and when) and the `mcp_credentials` table (the OAuth tokens per URL). **Literal values and OAuth tokens are stored in clear**, the way `update.token` is; a `!command` value stores the command, not its output.
- A thread's `secrets.json` holds the headers and stdio entries of its MCP servers, beside its `secretFiles` and `secretEnv`; it is never served.
- All of it is in every [backup](operations.md). Treat the archive like the data directory.

Limits: [Known limitations](architecture.md#known-limitations).
