# Agent setup

[README](../README.md) · [Documentation index](../README.md#documentation)

Let a coding agent set omp-cloud up for you. Paste the prompt below into omp (or any coding agent that can run shell commands). The agent reads [Install](install.md), checks your machine, shows you what setup will change and waits for your OK before it does anything. You stay in charge of three things: approving the plan, typing sudo's password and opening the model-login URL.

Most agents run commands without a terminal they can type into. Setup handles that: with no terminal and no `--yes` it prints its checks and its plan, changes nothing and exits with `no terminal to ask on; run omp-cloud setup in a terminal, or pass --yes`. The prompts below use that stop as the approval step.

Pick the prompt by where you sit. The first sets up the server on the machine the agent runs on. The second sets up a server over ssh and also makes the machine the agent runs on a device (the plugin and one pairing). A machine that only needs to become a device of a server that already runs needs neither: follow [Other machines](install.md#other-machines).

## Prompt: set up omp-cloud on this machine

```text
Set up omp-cloud on this machine so I can run `/cloud` tasks. omp-cloud runs omp agents in microVMs on a Linux host. Follow these steps in order and do not skip ahead.

1. Read docs/install.md in the omp-cloud repository (https://github.com/TechDufus/omp-cloud/blob/main/docs/install.md). It is the source of truth for the requirements, the flags and what setup changes.
2. Check the requirements by running the installer once WITHOUT --yes. Setup then checks everything read-only (platform, /dev/kvm, systemd, sudo, omp, tools, disk, RAM, ports, the 10.254.254.1 address, network reachability) and prints the results with its plan, and it changes nothing until I agree. Run the install line exactly as written, with nothing added to it (no redirects such as </dev/null, no changes to the pipe): the installer reads itself from the pipe and takes the terminal on its own.
   curl -fsSL https://raw.githubusercontent.com/TechDufus/omp-cloud/main/install.sh | sh
   Report what it printed. In its output `✓` is done, `·` is already fine, `-` is skipped (not a failure), `✗` is failed, and a failed step has a fix beside it. Stop for my answer if any check failed. If this machine is itself a VM, also check that nested virtualization works (docs/install.md says how). Warnings (low disk or RAM, an unreachable host) are for me to judge: tell me.
3. Show me the plan in plain words and continue only after I say OK:
   - If you ran step 2 in a terminal I can type into, that run is the real install: setup asks "Continue? [Y/n]" itself and sudo asks for my password in that terminal. Do not answer for me.
   - Otherwise (no terminal) step 2 stopped after printing the plan, changed nothing and exited with "no terminal to ask on". After my OK, run it again with --yes:
     curl -fsSL https://raw.githubusercontent.com/TechDufus/omp-cloud/main/install.sh | sh -s -- --yes
   - With --yes and no terminal, setup needs sudo to work without a password. If it says sudo needs a password, it has changed nothing and prints the exact command to run: give me that command, tell me to run it in my own terminal, and wait. Never try to supply, cache or bypass my sudo password.
4. Log in to a model provider with me. Setup with --yes skips the login and prints "log in later". `omp-cloud login` with no provider and no terminal prints the providers the service offers and exits 2: show me that list and ask which one I want, then run `omp-cloud login <provider>`. It prints a URL and a code: I open the URL and approve in my browser, and you wait for it to finish. If it asks for a pasted redirect URL or code and you cannot type into it, ask me to run `omp-cloud login <provider>` in my own terminal instead.
5. Verify: run `omp-cloud doctor` and show me the table. A VM template that is still building is normal for the first minutes. omp loads a plugin only at start, and setup ends the plugin step with "restart running omp sessions (/restart) to load it": restart omp (/restart) before the first /cloud command. If you are running inside the omp that needs it, ask me to restart it or to open a new session. Then start a first task such as `/cloud say hello and list the files in the repository` and tell me whether it finished.
6. Rules: do not change firewall rules, kernel or other system settings, or install anything beyond what setup itself does, without asking me first and explaining why. If a step fails, show me the failure and the fix setup printed next to it; do not improvise around it. Never print tokens, keys or the contents of ~/.config/omp-cloud.
```

## Prompt: set up omp-cloud on a remote server

For a server you reach over ssh (a homelab box, a rented machine), with this machine as the place you work from.

```text
Set up omp-cloud on my server USER@HOST and pair this machine with it, so I can run `/cloud` tasks from here that execute on the server. Follow these steps in order.

1. Read docs/install.md in the omp-cloud repository (https://github.com/TechDufus/omp-cloud/blob/main/docs/install.md) and docs/pairing.md.
2. Check the server by running the installer on it once WITHOUT --yes. Setup then checks everything read-only (platform, /dev/kvm, systemd, sudo, omp, tools, disk, RAM, ports, the 10.254.254.1 address, network reachability) and prints the results with its plan, and it changes nothing until I agree. Run the install line exactly as written, inside the quotes, with nothing added to it (no redirects such as </dev/null, no changes to the pipe): the installer reads itself from the pipe and takes the terminal on its own.
   ssh -t USER@HOST 'curl -fsSL https://raw.githubusercontent.com/TechDufus/omp-cloud/main/install.sh | sh'
   Report what it printed. In its output `✓` is done, `·` is already fine, `-` is skipped (not a failure), `✗` is failed, and a failed step has a fix beside it. Stop for my answer if any check failed. If the server is itself a VM, also check that nested virtualization works (docs/install.md says how). Warnings (low disk or RAM, an unreachable host) are for me to judge: tell me.
3. Show me the plan in plain words and continue only after I say OK:
   - ssh -t gives the server a terminal only if your own command tool has one. If it did and I can type into it, that run is the real install: setup asks "Continue? [Y/n]" itself and sudo asks for my password there. Do not answer for me.
   - Otherwise (no terminal) step 2 stopped after printing the plan, changed nothing and exited with "no terminal to ask on". After my OK, run it again with --yes:
     ssh USER@HOST 'curl -fsSL https://raw.githubusercontent.com/TechDufus/omp-cloud/main/install.sh | sh -s -- --yes'
   - With --yes and no terminal, setup needs sudo on the server to work without a password. If it says sudo needs a password, it has changed nothing and prints the exact command to run: give me that command, tell me to run it in my own ssh session on the server (ssh USER@HOST), and wait. Never try to supply, cache or bypass the sudo password. Do not run anything as root.
4. On the server, log in to a model provider with me. Setup with --yes skips the login. `omp-cloud login` with no provider and no terminal prints the providers the service offers and exits 2: show me that list and ask which one I want, then run `omp-cloud login <provider>` over ssh (`~/.local/bin/omp-cloud` when `omp-cloud` is not on the non-interactive PATH). I open the URL in my browser. If it asks for a pasted redirect URL or code and you cannot type into it, ask me to run `omp-cloud login <provider>` in my own ssh session on the server.
5. On the server, run `omp-cloud doctor` and show me the table. A VM template that is still building shows as skipped, not failed.
6. On this machine, make sure omp 18.12.3 or newer has the omp-cloud plugin (omp plugin marketplace add TechDufus/omp-cloud, then omp plugin install omp-cloud@omp-cloud). omp loads a plugin only at start, so restart omp (/restart) afterwards; if you are running inside the omp that needs it, ask me to restart it or to open a new session. Then pair: `/cloud connect USER@HOST`. Pairing over ssh needs key-based login and a known host key: if ssh asks for a password or a host-key confirmation, tell me what to run (ssh USER@HOST once, ssh-copy-id) instead of working around it.
7. Verify with `/cloud status`, then a first task such as `/cloud say hello and list the files in the repository`.
8. Rules: pairing, by code or over ssh, and every later request go to TCP 8443 on the server, so its firewall must allow that port from this machine; tell me what to allow instead of changing firewall rules, and do not change any other system settings beyond what setup does without asking me first. Never print tokens, keys or the contents of ~/.config/omp-cloud on either machine.
```

Replace `USER@HOST` with your own login before pasting.
