# Security model

[README](../README.md) · [Documentation index](../README.md#documentation)

What the service, the VMs and your devices can reach, what runs as root, and what crosses between your omp and a cloud agent.

## Trust boundaries

- The service has three listeners, defined in [API](api.md#listeners): the API listener (`listen`, plain HTTP, loopback only) for the owner token and this machine's devices, the dashboard listener (`dashboard.listen`, plain HTTP, loopback only) for the dashboard's session cookie, and the remote listener (`remote`, TLS, set up on `0.0.0.0:8443`) for paired devices only. The owner token is refused on the remote listener; the dashboard listener's `POST /session` accepts it to open a session.
- The remote listener is the only omp-cloud listener reachable from other machines. vibemon and the auth broker listen on loopback and the gateway on `10.254.254.1`. The service is the only vibemon client.
- A VM holds one per-thread gateway client token. Provider credentials and git credentials never enter it.
- The cloud broker has its own OAuth login (`/cloud login <provider>`); yours is never copied.
- VM egress: the internet, plus the gateway IP. vibemon runs with `--egress-internal-allow 10.254.254.1/32`, so every other private range is denied. That exemption covers every port of the address, and a VM's traffic reaches the service host from it, so a host listener bound to all addresses is reachable from VMs; the remote listener refuses that source. `policy.egress` narrows the internet to a list for new VMs.
- `bash.patterns` (and the fixed git guard in the VM) is a guard, not a boundary: its globs see the command text with quotes removed and over-match, and `g=git; $g pus"h"` evades them. The boundaries are the missing credentials, the push policy and egress.

## What runs as root

- **Setup.** `omp-cloud setup` runs as your user and calls `sudo` once, for one command (`omp-cloud setup system …`): packages, the vibemon install, two system units and the helper below. It refuses to run as root, and the sudo password prompt is yours: setup never supplies or caches it. `omp-cloud uninstall` does the same in reverse. Setup never changes firewall rules.
- **The helper and its sudoers rule.** `/usr/local/libexec/omp-cloud/vmon-install` is root-owned (0755) and is the only thing `/etc/sudoers.d/omp-cloud` (0440, checked with `visudo -cf`) lets your user run without a password. The rule never covers the `omp-cloud` binary, which your user owns and can replace. The helper takes one argument, a vibemon tag, and downloads, verifies and installs only that release ([Updating](updating.md#vibemon-is-pinned)); the updater uses it so a one-click update that moves vibemon needs no password.
- **System units.** `omp-cloud-net` (the dummy `ompsvc0` link at `10.254.254.1`, the only address sandboxes reach on the host) and `vmon` (vibemon) are system services; the omp-cloud service, the auth broker, the gateway and the backup timer are your user's units and never run as root.
- **Linger.** Setup runs `loginctl enable-linger` for your user so those user units start at boot without a login, records that in `/etc/omp-cloud/setup.json`, and `uninstall` undoes only what setup enabled (`--no-linger` skips it).

## Messages between your omp and a cloud agent

A cloud agent can be messaged from your omp and can message it back, the way omp's own agents message each other ([Messaging a cloud agent](jobs.md#messaging-a-cloud-agent); the endpoint is [IRC messages](api.md#irc-messages)). This adds a channel across the trust boundary above. What matters for trust:

- **The VM extension.** `irc-peer.ts` runs in each VM's omp with the VM agent's own privileges, inside the VM's limits (the gateway-only egress above, no git or provider credentials). Its only host import is omp's `registry/agent-registry`; apart from `node:` built-ins it imports nothing and opens no sockets. An outgoing message leaves as a status frame on omp's stdout, which the runner already reads.
- **Inbound (you to the agent).** A message reaches a VM only through `POST /api/v1/threads/{id}/irc`, with the same bearer authentication and owner scoping as `POST …/messages` (a revoked device fails like any other request). The agent sees an ordinary incoming agent message, labelled with the `from` the caller named, whichever token was used.
- **Outbound (the agent to you).** What a cloud agent writes to `agent://Parent` is delivered into your omp session as an incoming IRC message from that agent. As with a native subagent's message, it can wake an idle main agent. It is the agent's text, not yours. Content the agent read (an untrusted repository, a web page through its tools) can therefore reach your local model this way. omp frames it as an agent message; omp-cloud does not filter or sanitize it. When a message you sent woke an idle cloud agent, the turn's final reply returns to you as such a message too. Treat it as you would a subagent's output.
- **Limits.** Size and turn limits (32768 bytes, 200 turns) are in [IRC messages](api.md#irc-messages); an oversize message is cut with a marker, never silently.
- **Child jobs are display-only.** There is no remote cancel for them; to stop the work, stop the thread ([Cancelling](jobs.md#cancelling)).
- **Not verified.** These are descriptions of what the code does, checked by unit tests and the plugin scenario, not an audit; no test tries to break out through the extension or to inject hostile message text into a local session.

## Where the details are

- [Pairing](pairing.md): what crosses the network, who may connect, the firewall, backups and identity.
- [API](api.md): agent policy (bash rules, tool approvals, spend caps, egress, allowed models), push policy, devices and pairing offers, the dashboard guard, [IRC messages](api.md#irc-messages) and [their VM side](api.md#the-vm-side-of-irc).
- [Configuration](configuration.md): `service.json` (`listen` must be loopback), `remote`, git credentials.

