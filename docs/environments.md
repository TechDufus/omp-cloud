# Environments and previews

[README](../README.md) · [Documentation index](../README.md#documentation)

Shape the VM a cloud agent works in, and look at what it runs. The toolchain of every VM is a setting you edit once on the service; a repository can add its own setup (install the dependencies once, not on every thread); and a dev server the agent starts in its VM can be opened in your browser. The routes are in [API](api.md#environments-and-previews); the trust questions are in [Security model](security.md#environments-and-previews).

What it needs: nothing beyond the service. The setup of a repository needs the plugin and a service that reports the capability `threads.setup`, and a preview needs `threads.preview`.

## The VM toolchain

Every VM is created from a template that the service builds once per omp version and recipe, in this order:

1. The tools the runner itself needs: `ca-certificates`, `curl`, `git`, `jq`, `procps` and `sqlite3`. They are always installed.
2. The Debian packages of [`vm.packages`](api.md#settings), default `build-essential`, `python3`, `python3-venv`, `python3-pip`, `nodejs`, `npm`, `unzip` and `ripgrep`.
3. omp, from omp's build service, at the version your omp runs.
4. The lines of [`vm.setup`](api.md#settings), default none, run as **root** under `set -eux` in one script. Use it for what a package alone does not do, such as `npm install -g pnpm` or adding the VM user to a group.

Edit both on the dashboard's Settings page or with `PUT /api/v1/settings`; they are typed settings like any other, audited and part of the settings export.

| Setting | Type | Default | Rules |
|---|---|---|---|
| `vm.packages` | list of strings | the eight packages above | Each entry is a Debian package name: lower-case letters, digits and `+ . -`, starting with a letter or digit, at most 100 characters. At most 200 entries |
| `vm.setup` | list of strings | `[]` | Shell lines, at most 16384 characters in all (a line counts its characters plus one) |

A change gives the template a new name, `omp-agent:<omp version>-<hash>`, because the hash covers the recipe. Nothing else happens until a thread needs a VM:

- The first thread after the change waits once while the template builds (`vm` events say so), and a prebuild at service start builds it in the background. Packages are sorted and deduplicated before they are hashed, so listing them in another order changes nothing.
- A VM that is already running or paused keeps the template it was made from. Only new VMs, including a restore of a lost or archived thread, get the new recipe.
- A [repository environment](#per-repository-environments) built on the old template is stale; the service stops using it and evicts it first.
- `omp-cloud setup` and `omp-cloud doctor` check the template of the recipe stored in the database, so they report the one your threads will use.

A failing `vm.packages` or `vm.setup` fails the template build, and with it every thread that needs it: the thread ends `failed` with the build's error, and the next thread tries the build again. Fix the setting and start a new task. The build runs in a throwaway VM, so a bad line cannot touch the host, but it runs as root there with the internet: treat `vm.setup` like a script you would run as root.

A stdio MCP server that needs `node` or `python3` ([Secrets and MCP servers](secrets-and-mcp.md#mcp-servers)) runs in the default template.

## Per-repository environments

Installing a repository's dependencies takes minutes, and every new thread on it would pay that. A repository can commit a `setup` script to `.omp-cloud.yml`; the service runs it once in a throwaway VM, keeps that VM's disk as a vibemon snapshot, and starts later threads on the same repository from it.

```yaml
# .omp-cloud.yml at the repository root
setup:
  run: |
    bun install --frozen-lockfile
  cacheFiles: [bun.lock]
```

| Key | Meaning |
|---|---|
| `run` | The script: 1 to 16384 characters of shell. It runs under `bash` with `set -e`, as the VM's user, in `/home/user/work` with the handoff commit checked out |
| `cacheFiles` | Optional list of at most 32 repository paths (relative, outside `.git`) whose contents key the cache: when one changes, the environment is built again. Omitted, the service uses `bun.lock`, `bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`, `uv.lock`, `requirements.txt`, `Gemfile.lock` and `composer.lock`. `[]` keys the cache on the script alone |

`setup` is accepted in a repository's `.omp-cloud.yml` only. In your personal file it is ignored with the warning `setup belongs in a repository's .omp-cloud.yml, ignored` ([Configuration](configuration.md#client-config)). A repository can carry anything in it, so a setup script is code from whoever wrote the repository: it runs in the build VM and is kept in the environment ([Security model](security.md#environments-and-previews)). A scratch thread has no repository and no setup.

The launch card has an `env setup` row (`cached by bun.lock`, `cached by the default lockfiles`, or `cached by the setup script alone`). Against a service without `threads.setup` the plugin ships nothing and warns `the cloud service cannot run the setup of .omp-cloud.yml; it is not shipped`.

### How an environment is found or built

When the service creates a thread's VM it computes the environment's **key**: the SHA-256 of the template name, the repository (`<host>/<path>`, or `local/<name>` without a remote), the script and the SHA-256 of each cache file at the handoff commit (a missing file counts as missing), in path order. The key names the snapshot, `omp-env-<first 16 hex characters>`. Then:

1. **Cached.** The VM is created from the snapshot, and a `vm` event says `using the cached environment <name>`. The thread's normal provisioning runs on top: the repository is restored at its handoff commit, and `git clean -fdq` removes untracked files the snapshot left while keeping the **ignored** ones. Dependencies stay if the repository ignores them (`node_modules/`, `.venv/`, `target/`, a `deps/` that `.gitignore` lists); a dependency directory the repository does not ignore is cleaned away.
2. **Not cached, and this is the thread's first VM.** The service builds it, then creates the VM from the new snapshot. First means the thread has no recorded result yet and is not archived.
3. **Not cached, and the VM is a restore or replacement** (the thread already has a result, or was archived). The VM starts from the plain template, so a restore never waits for a build.

The build runs in a sandbox of the template whose `app` is `omp-cloud-env` (the thread VMs' is `omp-cloud`), so it is not a thread's VM and the orphan sweep leaves a running build alone. It follows these steps, announced as `vm` events:

1. `preparing the repository environment (setup in .omp-cloud.yml)`.
2. The handoff is uploaded and checked out in `/home/user/work`, as for a thread.
3. The [Secrets](secrets-and-mcp.md#secrets) whose repositories match the thread are written to a 0600 env file, sourced for the script and deleted before it runs. The thread's own `secretEnv` and `secretFiles` are not part of it.
4. The script runs, with a 30 minute limit.
5. The disk is snapshotted and recorded. `environment ready (<name>)`.
6. The build sandbox is killed, however it ended.

The sandbox gets the thread's egress policy (`policy.egress`), so a setup that needs the internet needs it allowed. Two threads that want the same key at once share one build: the second says `waiting for the repository environment another thread is preparing`.

When the script fails or times out, the thread is not blocked: a `vm` event says `environment setup failed: exit <code>: <the last 500 characters of stderr>` and the VM starts from the template. A cache file that cannot be read gives a `notice` (`the repository environment is not available: <reason>`) and the same fallback. A snapshot that vibemon no longer has (deleted outside the service) is forgotten, with a `notice`, and the VM starts from the template; the next first VM builds it again.

### How many are kept

After every build the service keeps at most 20 environments. Past that it evicts first those built on another template (which no thread can use any more), then the least recently used, deleting each snapshot from vibemon and its row from the database. A failed deletion is logged and retried by the next eviction. Using a cached environment counts as a use.

A build sandbox older than 2 hours is a leftover of a service that died mid-build: the lifecycle sweep (every `runner.lifecycleSweepSeconds`, default 3600; [Archive](archive.md)) kills it.

## Previews

An agent that starts a dev server in its VM (`python3 -m http.server 8000`, `bun run dev`) leaves you nothing to open: the VM is behind the gateway. A preview relays one of its ports to your own machine.

```text
/cloud preview <id> <port>      open port <port> of the thread's VM
/cloud preview stop             end every preview
```

The plugin starts a small forwarder on a free port of this machine and prints `☁ preview of port <port> on <name>: http://localhost:<lp>/`; in omp's interactive UI it opens that address in your browser. Open it as `localhost`, exactly as printed:

- The forwarder answers only requests whose `Host` is `localhost:<lp>` and answers anything else, `http://127.0.0.1:<lp>/` included, with `400` `open http://localhost:<lp>/`. This is deliberate: the dashboard's session cookie (`omp_cloud_session`) belongs to `127.0.0.1`, and a browser scopes cookies by host, not by port. A previewed page served on `127.0.0.1` would run next to that cookie; on `localhost` it cannot see it. The forwarder also removes any `omp_cloud_session` cookie from what it passes on and from what the app sets, as a second guard.
- The browser's other cookies pass through, so an app that logs you in works.
- Websockets are not forwarded (`501` `WebSocket upgrades are not forwarded`): a dev server's hot reload socket does not connect, though the page loads. Plain HTTP, streaming responses and server-sent events work.

One forwarder serves one thread and port, so `/cloud preview <id> 3000` and `/cloud preview <id> 8000` are two. They also end with `/cloud preview stop`, on `/cloud disconnect` and when omp ends. From a paired device the requests go over the pinned TLS connection and the service's remote listener, like every other call.

The local model can do the same through the `cloud` tool's `preview` op (`{op: "preview", thread, port}`; `{op: "preview", stop: true}` ends them): it gets the `http://localhost:<lp>/` address and opens it with omp's browser tool to take screenshots, click and read the page. The tool and the slash command share one list of forwarders, so each reuses the other's, and `/cloud preview stop` ends the model's too. See [The `cloud` tool](cloud-tool.md).

What the service does: it resolves the thread's VM, resumes it if it is paused, and relays the request to the port through vibemon's ingress. Every request postpones the idle pause (`runner.idleTimeoutSeconds`), so a VM you are looking at stays awake. The server has to keep running after the agent's command ends, so ask the agent to start it detached (`setsid nohup <command> >/dev/null 2>&1 &`). A thread with no VM yet answers `409` `the thread has no VM; send it a message first`. Port 49983 is the VM's own control port and is never forwarded. The full contract is in [API](api.md#environments-and-previews).

Limits are under [Known limitations](architecture.md#known-limitations).
