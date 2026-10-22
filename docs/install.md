# Install

[README](../README.md) · [Documentation index](../README.md#documentation)

One command sets up the whole service host, the machine that runs the service: vibemon (the microVM runtime), its network and units, the auth broker and gateway, the omp-cloud service, the omp plugin and the model login. It sets up only the machine it runs on; every other machine you work from needs the plugin and one pairing ([Server and devices](#server-and-devices)).

```sh
curl -fsSL https://omp-cloud.techdufus.com/install.sh | sh
```

Prefer to have an agent do it? Give omp (or any coding agent) the prompt in [Agent setup](agent-setup.md).

The script needs `curl` and `sha256sum` (or `shasum`). It downloads the release binary for Linux x86_64, checks its sha256, runs `omp-cloud version` as a smoke test and then `omp-cloud setup`. It never uses sudo and never edits a shell rc file: the binary asks for sudo once, installs itself under `~/.local/share/omp-cloud/app` (it updates itself there, see [Updating](updating.md)) and links `~/.local/bin/omp-cloud`. Make sure `~/.local/bin` is on your `PATH` to use the command by name.

## Server and devices

omp-cloud has two roles, and each is set up once:

- **The server** is the machine that runs vibemon, the auth broker and gateway, the omp-cloud service and the VMs. The other docs call it the service host. `install.sh` runs there, once, and sets up only that machine, including the plugin in that machine's omp. It is often a remote box (a homelab server, or a VM with nested KVM): from the machine you work on, run the installer over ssh, `ssh -t user@host 'curl -fsSL https://omp-cloud.techdufus.com/install.sh | sh'`.
- **A device** is a machine you run omp on and type `/cloud` in. The server is one: setup installed the plugin there and wrote its `config.yml`, so `/cloud` reaches the service on loopback. Every other device (a laptop, a second workstation) needs the plugin installed on it and one pairing: [Other machines](#other-machines).

`install.sh` runs only on the server. Any other device needs only omp 18.12.3 or newer, the plugin and one pairing; the requirements below are the server's.

## Other machines

A device other than the server needs the plugin, not the service. Install the plugin there:

```sh
omp plugin marketplace add TechDufus/omp-cloud
omp plugin install omp-cloud@omp-cloud
```

Then restart omp (`/restart`) so it loads. A private repository or fork needs git access on the device for the marketplace add. Pair once, in omp on the device, with one of:

- `/cloud connect user@host`, over ssh to the server's account: key-based login and a known host key, and nothing to approve.
- `/cloud pair` on the server, then `/cloud connect <code>` on the device.

The device reaches the server on TCP 8443, which setup never opens: see [Firewall](#firewall). By default only private, link-local and carrier-grade NAT (`100.64.0.0/10`, the range Tailscale assigns) source addresses may connect; a public address needs `remote.allow` on the server and `--allow-public` on `/cloud connect` ([Who may connect](pairing.md#who-may-connect)). A device holds its own revocable device token and never the owner token. More: [Pairing](pairing.md). The device's plugin updates apart from the server: [Updating](updating.md#the-plugin).

## Requirements

- **Linux x86_64 with `/dev/kvm`.** vibemon runs each cloud agent in a microVM. macOS, Windows and ARM machines cannot host the service (`install.sh` says so and stops); they can still use it as [another machine](#other-machines).
- **A regular user with sudo.** Run setup as that user, never as root (it refuses). It asks for sudo once; a password is fine. Without a terminal and without cached sudo it stops before changing anything and prints the exact command to run in a terminal.
- **systemd** as PID 1, with a reachable user manager (`systemctl --user show-environment` works). A container usually has neither.
- **Internet access** to GitHub (the release, vibemon), omp's build service (`build.stencil.so`, where the VM template installs omp from) and Docker's registry (`registry-1.docker.io`, the template's base image). The preflight checks that these three answer and only warns when one does not, because a proxy or mirror may still serve them; an unreachable host shows up later as a failed download. Installing a missing omp also needs `omp.sh`.
- **Disk and RAM.** At least 30 GiB free under `/var/lib` (VM templates, snapshots and every thread's VM) and 8 GiB of RAM or more, shared by the sandboxes. Both are warnings, not blockers.
- **omp** on the host: Tern's managed install first, else the first `omp` on `PATH` (or in `~/.local/bin`). A missing omp is installed with omp's own installer (`curl -fsSL https://omp.sh/install | sh`, as your user, after you agree to the plan). An omp older than the one this release is built against (18.12.3) fails the check with `omp update` as the fix.
- **Tools** setup installs from your distribution's packages (apt, dnf or pacman) when missing: `ip`, `iptables`, `iptables-restore`, `ip6tables-restore`, `mkfs.ext4`, `e2fsck`, `resize2fs`, `curl`, `tar`, `sha256sum`, `flock`, `timeout`, `git`.
- **Free ports** 3000, 7946, 7947 (vibemon), 4000 (gateway), 8765 (broker), 8080, 8081 and 8443 (the service). A port already held by omp-cloud's own units passes; anything else listening there is reported. `10.254.254.1` must be free too: setup puts it on a dummy device, `ompsvc0`, which is how sandboxes reach the host.

**Inside a VM**, nested virtualization has to work. Check on the host you will run setup on:

```sh
ls -l /dev/kvm                          # must exist
grep -E -c 'vmx|svm' /proc/cpuinfo      # must be above 0
```

`/dev/kvm` existing is necessary but not always enough: a nested guest can die at its first entry although `/dev/kvm` is present. If setup fails at `health.template` or `omp-cloud doctor` keeps reporting the VM template as not built (`journalctl --user -u omp-cloud -f` shows why), suspect nested KVM and use a bare-metal host or a hypervisor that supports it.

An omp of 18.12.3 or newer is needed wherever you run the plugin. An older omp cannot load it: the plugin then registers only a `/cloud` command (its description starts `omp-cloud could not load:`) and a startup notice (`☁ omp-cloud needs omp 18.12.3 or newer; this omp is <version> (<path>) and cannot load it (<error>) …`) that say so. A newer omp that fails to load it gets the same two, naming the error and saying to update omp-cloud (`omp plugin upgrade`) or report it. Check which `omp` your shell runs (`which omp`, `omp --version`). `omp-cloud doctor` finds either case (`plugin.loads`, below).

## What setup does

Setup configures only the machine it runs on. It checks first (read-only), prints a plan, asks `Continue? [Y/n]` and only then changes anything. The plan:

1. **Preflight** (changes nothing): platform, `/dev/kvm`, systemd and its user manager, sudo, omp and its version, the tools above, free disk and RAM, the ports and `10.254.254.1`, and whether GitHub, omp's build service and Docker's registry answer (a warning, not a block). Setup prints every result with the plan, so running the installer once without `--yes` is the requirements check: it changes nothing until you agree. A failed required check stops setup with a fix beside it.
2. **As root** (one `sudo`):
   - install missing packages;
   - install the vibemon install helper `/usr/local/libexec/omp-cloud/vmon-install` and a sudoers rule, `/etc/sudoers.d/omp-cloud`, that lets you run only that helper without a password (the updater uses it; it never covers the `omp-cloud` binary);
   - install vibemon at the pinned version in `/opt/vmon` and create `/etc/vmon/env` (vibemon's secrets) once;
   - add the service network (`ompsvc0` at `10.254.254.1`) and the system units `omp-cloud-net` and `vmon`, which start at boot (vibemon's VM network pool is `172.20.0.0/16`, or the first free of `172.29`, `172.30`, `172.31`);
   - make sure the vibemon team `omp-cloud` exists with its limits;
   - enable linger for your user (`loginctl enable-linger`), so your services start at boot without a login. Setup records that it did, so uninstall undoes only what setup enabled.
3. **As your user** (a missing omp is installed first, before the root part):
   - write `~/.config/omp-cloud/` (`service.json`, the owner token `service.token`, the team key `vmon.key`, a TLS identity for [paired devices](pairing.md)): an existing token and TLS identity are kept, the team key is replaced only when vibemon no longer knows it, and an existing `service.json` is brought up to date in place;
   - install the binary into `~/.local/share/omp-cloud/app` and link `~/.local/bin/omp-cloud`;
   - install the user units `omp-auth-broker`, `omp-auth-gateway`, `omp-cloud` and a daily `omp-cloud-backup` timer (always persistent; see [Backups and persistence](operations.md));
   - install the omp plugin from the copy bundled in the binary (a plugin already linked is left alone) and write `~/.config/omp-cloud/config.yml` when absent, so `/cloud` finds the service. omp loads a plugin at start, so setup ends this step with `restart running omp sessions (/restart) to load it`: restart (`/restart`) every omp session that was running, including the one you ran setup from if that is omp, before the first `/cloud` command;
   - wait until the gateway and the service are healthy, then for the VM template (the service builds it in the background; at most 15 minutes).
4. **Login**, unless `--no-login` or `--yes`: it helps you log in to a model provider (see below).
5. **The doctor table**, printed last (without the preflight rows, which were printed first).

Every step prints `✓` (done), `·` (already fine), `-` (skipped, for example `- plugin.providers  no model provider yet`; not a failure) or `✗` (failed, with the fix on the next line). Setup is idempotent: rerun it after a failure, to repair a drifted host, or to upgrade (a newer binary installs itself and rewrites changed units; running services restart). A rerun keeps the secrets, the team, the network pool and your config.

Exit codes: 0 done, 1 a step failed or you answered no to `Continue?`, 2 a usage error or nothing could be asked (no terminal and no `--yes`).

## Flags

Pass flags after `--` through the installer, for example `curl … | sh -s -- --yes --no-login`; or run `omp-cloud setup <flags>` once installed.

| Flag | Effect |
| --- | --- |
| `--yes` | Skip the `Continue?` question and the login (it prints `log in later: omp-cloud login <provider>`). For scripts; it needs cached sudo or a terminal for sudo's password |
| `--no-login` | Skip the login |
| `--no-plugin` | Do not install the omp plugin; install it later as under [Other machines](#other-machines) |
| `--no-linger` | Do not enable linger. The services then start at your login, not at boot |
| `--no-wait` | Do not wait for the VM template; it builds in the background |
| `--team <slug>` | The vibemon team (default `omp-cloud`): lowercase letters, digits and hyphens, at most 63 characters, not `system`. A host keeps the team it has: another `--team` is refused (exit 2) unless `--migrate-team` is given |
| `--max-sandboxes <n>` | The team's concurrent-sandbox limit, 1 to 1000 |
| `--migrate-team` | Switch the host from its recorded team (`vmon.team` in `service.json`) to `--team` (default `omp-cloud`). Paused threads then come back as cold restores and the VM template rebuilds; the old key is kept as `vmon.key.<old slug>` |
| `--checkout` | Developer mode, for a git checkout (below) |
| `--json` | One JSON report on stdout (`{ok, steps}`); the human lines go to stderr |

The installer reads two environment variables: `OMP_CLOUD_VERSION` (a release such as `0.5.1`; default the latest) and `OMP_CLOUD_DOWNLOAD_URL` (the releases base URL, default `https://github.com/TechDufus/omp-cloud/releases`). It stages the download under `$TMPDIR` when set, else `$XDG_CACHE_HOME` or `~/.cache`, not `/tmp`, which is often `noexec`; if the smoke test says permission denied, set `TMPDIR` to a directory that allows executables.

The team's limits are set on every setup run: `--max-sandboxes` concurrent sandboxes (default 32), 4 concurrent builds, and for the whole team 8 vCPUs, 8192 MB of memory and 20480 MB of disk. Each run of a sandbox lasts at most 24 hours (the cap restarts when a paused sandbox resumes). vibemon cannot delete or rename teams, so a team left behind stays.

## Login

The cloud logs in to model providers itself, apart from your omp. Setup's last prompt does it; or later:

```sh
omp-cloud login              # pick a provider from the list
omp-cloud login anthropic    # or name one
```

It prints the login URL in full first, then the device code. Open the URL in a browser on any machine, approve, and (for a provider that redirects to a page that does not load) paste the redirect URL or code back into the terminal. The command waits up to 6 minutes; the service itself ends a login after 5 ([Logins](api.md#logins)). Setup's login step skips itself when the cloud already runs a provider; `omp-cloud login` always logs in to the provider you pick, again if need be. With no provider and no terminal (an agent, a script) it prints the providers the service offers and exits 2: pick one and run `omp-cloud login <provider>`. The credentials live in the broker's vault (`~/.local/share/omp-cloud/auth-home`); sandboxes never see them. See [Security](security.md).

## Doctor

```sh
omp-cloud doctor          # the whole stack as one table, a fix beside each failure
omp-cloud doctor --json   # {ok, steps} on stdout
```

It runs the preflight, the system units and the vibemon health route, the helper and its sudoers rule, linger, the user units, the service (healthy and at this binary's version), the broker, the gateway, the VM template, the plugin and the providers the cloud serves. The plugin checks are omp and its version, installed or linked, that omp loads it (`plugin.loads`), `config.yml`. `plugin.loads` runs once the plugin is installed: it starts the omp of this host in RPC mode, from an empty directory, with no prompt and no model call, and passes when omp lists the real `/cloud` command. When the plugin fell back (the `/cloud` that says `omp-cloud could not load:`) or omp lists no `/cloud` at all it fails with the error and a fix: update omp when it is older than 18.12.3, otherwise update omp-cloud (`omp-cloud update`) and rerun `omp-cloud setup`, and report the error if it persists. It is skipped, not failed, when omp cannot be asked in time or is not installed. Exit code 1 when anything fails. A template still building and linger off show as skipped, not failed.

## Uninstall

```sh
omp-cloud uninstall            # remove what setup installed; keep the data
omp-cloud uninstall --purge    # also delete the data and vibemon
```

It prints what it will do and keep, asks `Continue? [y/N]` (`--yes` skips it) and asks for sudo once. Uninstall stops and removes the user units, pauses the team's sandboxes, removes the plugin and the `~/.local/bin/omp-cloud` link, then (as root) removes the system units `omp-cloud-net` and `vmon`, the vibemon helper, the sudoers rule and linger when setup enabled it. It keeps `~/.config/omp-cloud`, the auth home, the service data (threads, database), the app directory and vibemon with its VMs, so a later `omp-cloud setup` picks up where you left off.

`--purge` additionally kills the sandboxes and deletes vibemon (`/opt/vmon`, `/opt/vmon.prev`, `/var/lib/vmon` with every VM and template, `/etc/vmon`), `/etc/omp-cloud`, `~/.config/omp-cloud` (service config, owner token, team key, the TLS identity: paired devices must pair again), the auth home (the broker's vault: every model login is lost), `~/.local/share/omp-cloud/service` and the app directory. **Backups are always kept**, in `~/.local/share/omp-cloud/backups`; it prints how many remain.

Run it as your user from the installed binary (root is refused). In a checkout, `mise run infra:down` is `omp-cloud uninstall --checkout`.

## Firewall

Setup never opens or closes a firewall port. Run a firewall that denies incoming connections by default (ufw, firewalld or nftables). The remote listener (TCP 8443) is the only omp-cloud listener reachable from other machines; allow it from your LAN only if you pair other machines (`sudo ufw allow from 192.168.0.0/16 to any port 8443 proto tcp`, see [Pairing](pairing.md)). vibemon also binds its VMs' egress proxy to all interfaces, so the default-deny matters.

## Install from a checkout

For development. You need [mise](https://mise.jdx.dev) (it installs Bun), a clone of this repository, and the requirements above.

```sh
mise install
mise run infra:up     # omp-cloud setup --checkout
```

`--checkout` runs everything setup does, with these differences: the units run `bun run src/main.ts` in the clone instead of an installed binary, there is no managed install (nothing in `~/.local/share/omp-cloud/app`; `~/.local/bin/omp-cloud` is a small wrapper script that runs the clone with Bun, so `/cloud connect user@host` works), the plugin is linked from `<repo>/plugin` (`omp plugin link`) instead of installed from the bundle, and a dev gateway client `omp-cloud-dev` exists for the scripts. `infra:up` and `infra:down` pass their arguments through (`mise run infra:up -- --no-login`). A run under Bun without `--checkout` refuses and says so, and a release binary refuses `--checkout`. See [Development](development.md).
