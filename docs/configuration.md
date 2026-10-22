# Configuration

[README](../README.md) · [Documentation index](../README.md#documentation)

omp-cloud has two kinds of configuration: omp-cloud's own files on each machine you run omp on, and `service.json` on the server. Everything else is a run-time setting.

## Client config

omp-cloud keeps its own files; omp's config is never read or written. `<config home>/omp-cloud/config.yml` is yours (`<config home>` is `$XDG_CONFIG_HOME`, else `%APPDATA%` on Windows, else `~/.config`), and a repository may commit `.omp-cloud.yml` at its root. Both are YAML mappings; unknown keys and values of the wrong type are ignored and reported by `/cloud status`.

| Key | Type | Meaning |
|---|---|---|
| `url` | string | The service address; `OMP_CLOUD_URL` wins. Must be `https`, or `http` on loopback: a token never crosses a network in the clear |
| `token` | string | The owner token: a literal, an environment variable name or a `!command` (run with `/bin/sh -c`); `OMP_CLOUD_TOKEN` wins |
| `excludeExtensions` | list of strings | Extension names that stay on this machine |
| `secretFiles` | list of strings | Repository files (relative paths) whose contents go to the cloud agent |
| `secretEnv` | list of strings | Names of environment variables whose values go to the cloud agent. A value every agent on a repository needs belongs in the service's [Secrets](secrets-and-mcp.md#secrets) instead |
| `policy` | mapping | Flat policy keys a handoff sends to tighten the service's policy for that thread: `bash.patterns`, `tools.approval`, `fetch`, `webSearch`, `browser`, `egress`, `spend.turnUSD`, `spend.threadUSD`, `spend.dayUSD`, `models.allowed`. The service never lets it loosen the policy ([API](api.md#agent-policy)). The launch card lists the keys sent |
| `deliver` | `tray` or `transcript` | Where a followed thread's finished turns and questions of your own threads go: the inbox and a terminal notification (`tray`, the default), or transcript cards. Yours only |
| `setup` | mapping | `{run, cacheFiles?}`: a script the cloud runs once per repository environment and caches by the contents of `cacheFiles` (default: the common lockfiles). **A repository's `.omp-cloud.yml` only**: in your personal file it is ignored with a warning. See [Environments](environments.md#per-repository-environments) |

A repository's file never supplies `url`, `token` or `deliver`, and your personal file never supplies `setup`: they are ignored and `/cloud status` says so. The repository's three lists add to yours, and its `policy` keys replace yours key by key. `/cloud status` shows where `url`, `token` and `deliver` came from, the repository file when one was read and the warnings.

With no `url` from the environment or your file, the machine uses its paired connection (`connection.json` beside `config.yml`) and ignores a `token`; see [Pairing](pairing.md).

A handoff also ships your omp's agent directory (`~/.omp/agent`) and the session's `--config` overlays. Settings that must stay on this machine (credentials, `!command` values, host paths, loopback endpoints) are removed from that copy with a launch warning, and MCP servers are planned separately; see [Secrets and MCP servers](secrets-and-mcp.md#settings-that-stay-on-your-machine).

## Service config

`service.json` is read at start from `--config`, else `$OMP_CLOUD_CONFIG`, else `~/.config/omp-cloud/service.json`. It is JSON. `omp-cloud setup` writes it (0600) when it is missing; on a rerun it adds a missing `broker`, `dashboard`, `remote` or `mcp` section and sets `vmon.team`, and changes nothing else. A missing required key, an unknown key or an invalid value stops the service with a message naming the field. Everything not listed here is a setting (`GET`/`PUT /api/v1/settings`, see [API](api.md#settings)). Paths are absolute. The three listeners are defined in [API](api.md#listeners).

| Key | Required | Meaning |
|---|---|---|
| `listen` | yes | `host:port` or `[ipv6]:port` of the API listener (plain HTTP); must be a loopback address, or the service refuses to start. Setup writes `127.0.0.1:8080` |
| `apiTokenSha256` | yes | Lowercase or uppercase hex SHA-256 (64 characters) of the owner token |
| `dataDir` | yes | The service's data directory; setup writes `~/.local/share/omp-cloud/service` |
| `vmon` | yes | `{url, keyFile, template, team?}`: vibemon's URL, the file holding the team's API key, the template base name (no whitespace; setup writes `omp-agent`) and the vibemon team slug (lowercase letters, digits and hyphens, at most 63 characters) |
| `gateway` | yes | `{url, clientsFile}`: the omp auth gateway's URL and its clients file |
| `broker` | yes | `{url, tokenFile}`: the omp auth broker that `/cloud login` signs in to, and the file holding its token |
| `models` | yes | `{default, direct?}`. `default` is `provider/id`, used when a thread names no model; its provider must be in `direct` or served by the gateway. `direct` maps provider names to omp provider objects with a `baseUrl` that go into every VM's `models.yml`; `apiKey`, `headers` and `authHeader` are refused anywhere in them. Setup writes `anthropic/claude-sonnet-4-6` |
| `runner` | no | `{enabled, idleTimeoutSeconds, turnTimeoutSeconds, questionTimeoutSeconds, sandboxTimeoutSeconds, lifecycleSweepSeconds}`; every key is optional. `enabled: false` runs the API without VMs, so threads stay queued. The timeouts are positive integers of seconds, at most 2147483 (`sandboxTimeoutSeconds` at most 86400). Defaults: pause an idle VM after 600; abort a turn after 1800 (time a question is open does not count); answer an unanswered question with a note to proceed after 1800; sandbox expiry 3600, refreshed while the VM works; archive and orphan sweep every 3600 ([Archive](archive.md)) |
| `git` | no | `{hosts, fetchTimeoutSeconds, pushTimeoutSeconds}`: the git hosts the service holds a credential for (without any, and without a connected [GitHub App](github.md) for github.com, it fetches nothing and pushes nothing) and the timeouts of a network git call of a base fetch and of a push (default 120 each, at most 2147483) |
| `dashboard` | no | `{listen, url?}`: the dashboard listener, loopback only; without it there is no dashboard. `url` is the origin browsers use, without a path (default `http://<listen>`). Setup writes `127.0.0.1:8081` |
| `remote` | no | The remote listener (TLS) for paired devices; without it the service has none. See below |
| `mcp` | no | `{listen}`: the MCP proxy listener that VMs reach their http MCP servers through; without it the service ships no http MCP server. Setup writes `10.254.254.1:4100`. See [MCP proxy](#mcp-proxy) |

`git.hosts` is keyed by the remote URL's lower-case host, with `:port` when the URL names one (`github.com`, `git.example:8443`). Each entry is `{credential, username?}`: `credential` is a `!command` whose output is the token (never the token itself), and `username` is the Basic-auth user name git sends (default `x-access-token`). `github.com` needs no entry once a GitHub App is connected ([below](#github-app-and-signing-key)); an entry is then used only for a repository the App is not installed on.

`remote` is `{listen, certFile, keyFile, advertise?, allow?}`. `listen` may be any host and port. `certFile` holds one PEM certificate and `keyFile` its key, mode 0600 in a 0700 directory, checked at start. `advertise` lists the `host:port` entries pairing codes carry (default: the host's own addresses). `allow` lists CIDR ranges that replace the default sources, which are `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16`, `fc00::/7` and `fe80::/10` (loopback is not among them). Setup writes `0.0.0.0:8443` and a certificate and key in `~/.config/omp-cloud/tls/`. See [API](api.md#listeners) and [Pairing](pairing.md).

```json
"git": {"hosts": {"github.com": {"credential": "!/usr/bin/gh auth token"}}},
"dashboard": {"listen": "127.0.0.1:8081"},
"remote": {"listen": "0.0.0.0:8443", "certFile": "/home/you/.config/omp-cloud/tls/cert.pem", "keyFile": "/home/you/.config/omp-cloud/tls/key.pem"}
```

The credential command runs in the service's environment (a systemd user unit), not your shell. Every unit runs with one fixed `PATH`, `<omp's directory>:/usr/local/bin:/usr/bin:/bin` (in a checkout, bun's directory comes first), never your interactive one, so a tool installed elsewhere needs its absolute path. The service logs at start which program each credential command runs (`journalctl --user -u omp-cloud`).

## GitHub App and signing key

`service.json` has no GitHub keys. The App and the signing key are connected and made on the dashboard's GitHub page, and live as files in the data directory, each directory mode 0700 and each file 0600:

| Path under `dataDir` | Holds |
|---|---|
| `github/app.json`, `github/app.pem` | The connected GitHub App's description (id, slug, name, owner) and its private key |
| `signing/ed25519.pem` | The SSH key the service signs commits with |

A key file with group or other permission bits is refused (`the GitHub App key <path> must be mode 0600`, `the signing key <path> must be mode 0600`). Both directories are in every [backup](operations.md). The run-time settings are [`git.sign`, `git.committer` and `git.pr`](api.md#settings), with `git.push` deciding whether anything is pushed at all. Connecting, installing, signing and pull requests are explained in [GitHub](github.md); the dashboard's address is `dashboard.url` ([above](#service-config)), and the manifest flow needs a dashboard listener.

## MCP proxy

`mcp` is `{"listen": "<ip>:<port>"}`. The address must be an IP literal (a host name is refused: `mcp.listen must be an IP address, not a host name`) and a specific one (`0.0.0.0` and `::` are refused: `mcp.listen must be a specific address, not a wildcard`). It is plain HTTP and is not the API, so it needs no loopback address; it must be one a VM can reach, and the only host address a VM reaches is the gateway's. `omp-cloud setup` writes `10.254.254.1:4100` when it creates `service.json` and adds the section to an existing file on a rerun (`mcp section added`), the same way as `broker`, `dashboard` and `remote`; the service reads it at start, so restart it afterwards (`systemctl --user restart omp-cloud`).

```json
"mcp": {"listen": "10.254.254.1:4100"}
```

The listener starts before the runner. When the port cannot be bound the service still starts, logs `omp-cloud: the MCP proxy could not listen on <listen>: <reason>` (`journalctl --user -u omp-cloud`) and reports `mcpProxy: false` in `whoami`: stdio MCP servers still ship, http ones are not delivered. What the proxy does with a request is in [API](api.md#secrets-and-mcp-servers), and the trust boundary in [Security model](security.md#secrets-and-mcp). The VMs' egress already allows the gateway address on every port ([Security model](security.md#trust-boundaries)), so nothing needs opening; the listener sits on the gateway's address, which only this host and its VMs use.

## VM toolchain

What every VM contains is two run-time settings, not `service.json` keys: `vm.packages` (the Debian packages installed into the VM template; default `build-essential`, `python3`, `python3-venv`, `python3-pip`, `nodejs`, `npm`, `unzip`, `ripgrep`) and `vm.setup` (shell lines run as root, under `set -eux`, after the packages and omp are installed; default none). Edit them on the dashboard's Settings page or through `PUT /api/v1/settings`.

| Setting | Rules |
|---|---|
| `vm.packages` | A list of Debian package names: lower-case letters, digits and `+ . -`, starting with a letter or digit, at most 100 characters each, at most 200 entries. The runner's own tools (`ca-certificates`, `curl`, `git`, `jq`, `procps`) are always installed and need not be listed |
| `vm.setup` | A list of shell lines, at most 16384 characters in all |

Changing either builds a new template, named `omp-agent:<omp version>-<hash>`, the next time a thread (or the service's own prebuild at start) needs a VM; the first thread after the change waits for the build. The order of packages does not matter. VMs that already exist keep the template they were made from, and the [repository environments](environments.md#per-repository-environments) built on the old template are retired. A package Debian does not have, or a line that fails, fails the build, and with it every thread that needs the template, until the setting is fixed. The rules, the build order and what they do to threads are explained in [Environments](environments.md#the-vm-toolchain), and the contract in [API](api.md#settings).

### Docker

A VM can run Docker. Set `vm.packages` to the defaults plus `docker.io`, and `vm.setup` to one line that puts the VM's `user` in the `docker` group:

```json
{
  "vm.packages": ["build-essential", "python3", "python3-venv", "python3-pip", "nodejs", "npm", "unzip", "ripgrep", "docker.io"],
  "vm.setup": ["usermod -aG docker user"]
}
```

Debian's package starts `dockerd` as a systemd service when the VM boots, so the agent needs no `dockerd` line: in a VM built from this recipe `docker run --rm hello-world`, run as `user` without `sudo`, pulled the image and printed `Hello from Docker!` (Docker 26.1.5). Starting a second daemon by hand fails with `failed to start daemon, ensure docker is not running or delete /var/run/docker.pid`. The pull needs registry egress: a thread under a `policy.egress` list must allow the registry's hosts, which this check did not exercise. Changing the settings builds a new template, so the first thread after it waits for the build.
