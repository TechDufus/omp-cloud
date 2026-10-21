# Configuration

[README](../README.md) · [Documentation index](../README.md#documentation)

## Client config

omp-cloud keeps its own files; omp's config is never read or written. `<config home>/omp-cloud/config.yml` is yours (`<config home>` is `$XDG_CONFIG_HOME`, else `%APPDATA%` on Windows, else `~/.config`), and a repository may commit `.omp-cloud.yml` at its root. Both are YAML mappings; unknown keys and values of the wrong type are ignored and reported by `/cloud status`.

| Key | Type | Meaning |
|---|---|---|
| `url` | string | The service address; `OMP_CLOUD_URL` wins. Must be `https`, or `http` on loopback: a token never crosses a network in the clear |
| `token` | string | The owner token: a literal, an environment variable name or a `!command` (run with `/bin/sh -c`); `OMP_CLOUD_TOKEN` wins |
| `excludeExtensions` | list of strings | Extension names that stay on this machine |
| `secretFiles` | list of strings | Repository files (relative paths) whose contents go to the cloud agent |
| `secretEnv` | list of strings | Names of environment variables whose values go to the cloud agent |
| `policy` | mapping | Flat policy keys a handoff sends to tighten the service's policy for that thread: `bash.patterns`, `tools.approval`, `fetch`, `webSearch`, `browser`, `egress`, `spend.turnUSD`, `spend.threadUSD`, `spend.dayUSD`, `models.allowed`. The service never lets it loosen the policy ([API](api.md#agent-policy)). The launch card lists the keys sent |
| `deliver` | `tray` or `transcript` | Where a followed thread's finished turns and questions of your own threads go: the inbox and a terminal notification (`tray`, the default), or transcript cards. Yours only |

A repository's file never supplies `url`, `token` or `deliver`: they are ignored and `/cloud status` says so. Its three lists add to yours, and its `policy` keys replace yours key by key. `/cloud status` shows where `url`, `token` and `deliver` came from, the repository file when one was read and the warnings.

With no `url` from the environment or your file, the machine uses its paired connection (`connection.json` beside `config.yml`) and ignores a `token`; see [Pairing](pairing.md).

## Service config

`service.json` is read at start from `--config`, else `$OMP_CLOUD_CONFIG`, else `~/.config/omp-cloud/service.json`. It is JSON. `omp-cloud setup` writes it (0600) when it is missing; on a rerun it adds a missing `broker`, `dashboard` or `remote` section and sets `vmon.team`, and changes nothing else. A missing required key, an unknown key or an invalid value stops the service with a message naming the field. Everything not listed here is a setting (`GET`/`PUT /api/v1/settings`, see [API](api.md#settings)). Paths are absolute. The three listeners are defined in [API](api.md#listeners).

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
| `git` | no | `{hosts, fetchTimeoutSeconds, pushTimeoutSeconds}`: the git hosts the service holds a credential for (without any, it fetches nothing and pushes nothing) and the timeouts of a network git call of a base fetch and of a push (default 120 each, at most 2147483) |
| `dashboard` | no | `{listen, url?}`: the dashboard listener, loopback only; without it there is no dashboard. `url` is the origin browsers use, without a path (default `http://<listen>`). Setup writes `127.0.0.1:8081` |
| `remote` | no | The remote listener (TLS) for paired devices; without it the service has none. See below |

`git.hosts` is keyed by the remote URL's lower-case host, with `:port` when the URL names one (`github.com`, `git.example:8443`). Each entry is `{credential, username?}`: `credential` is a `!command` whose output is the token (never the token itself), and `username` is the Basic-auth user name git sends (default `x-access-token`).

`remote` is `{listen, certFile, keyFile, advertise?, allow?}`. `listen` may be any host and port. `certFile` holds one PEM certificate and `keyFile` its key, mode 0600 in a 0700 directory, checked at start. `advertise` lists the `host:port` entries pairing codes carry (default: the host's own addresses). `allow` lists CIDR ranges that replace the default sources, which are `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16`, `fc00::/7` and `fe80::/10` (loopback is not among them). Setup writes `0.0.0.0:8443` and a certificate and key in `~/.config/omp-cloud/tls/`. See [API](api.md#listeners) and [Pairing](pairing.md).

```json
"git": {"hosts": {"github.com": {"credential": "!/usr/bin/gh auth token"}}},
"dashboard": {"listen": "127.0.0.1:8081"},
"remote": {"listen": "0.0.0.0:8443", "certFile": "/home/you/.config/omp-cloud/tls/cert.pem", "keyFile": "/home/you/.config/omp-cloud/tls/key.pem"}
```

The credential command runs in the service's environment (a systemd user unit), not your shell. Every unit runs with one fixed `PATH`, `<omp's directory>:/usr/local/bin:/usr/bin:/bin` (in a checkout, bun's directory comes first), never your interactive one, so a tool installed elsewhere needs its absolute path. The service logs at start which program each credential command runs (`journalctl --user -u omp-cloud`).

