# GitHub

[README](../README.md) · [Documentation index](../README.md#documentation)

Connect a GitHub App to the service once and cloud agents push to your private repositories with short-lived tokens, their commits show as **Verified**, and a draft pull request opens and stays current by itself. Nothing here gives a VM a credential: the service pushes, signs and opens the pull request, and a VM only receives and produces bundles ([Security model](security.md#github-app-and-signing-key)). The routes are in [API](api.md#github-signing-and-pull-requests).

What it needs: the dashboard ([Configuration](configuration.md#service-config)), a GitHub account that owns the repositories (or an organization you may create Apps in), and `git.push` set to `ask` or `auto`, because a pull request opens after a push.

## Set it up (once)

1. **Connect the App.** Open the dashboard's GitHub page, optionally name an organization to own the App, and press Connect. The page sends your browser to GitHub with a manifest; confirm the App there. GitHub redirects back to the dashboard, which hands the one-time code to the service, and the service stores the App's id and private key. Do it from the dashboard on the service host: a paired device is refused (`only the owner token can do this`).
2. **Install it.** Press "Install on repositories" and pick the repositories (or all). A repository the App is not installed on is not reachable through it.
3. **Make the signing key** (optional, for Verified commits). On the GitHub page press Generate. Add the public key it shows to GitHub as a **Signing Key** (`https://github.com/settings/ssh/new`, "Key type: Signing Key"; an authentication key does not make a commit Verified). The page shows `registered` when GitHub lists the key for the App's owner.
4. **Turn it on.** Set `git.sign` to `ssh` to sign, `git.push` to `auto` (or `ask`) and `git.pr` to `draft` (the default), on the GitHub page or in Settings.

Then `/cloud add a line to the README` from a clone of a repository the App is installed on. The turn card shows `PR #<n> <url>` after the push, and `gh api repos/<owner>/<repo>/commits/<sha> --jq .commit.verification.verified` prints `true` for the head.

The App is created with these permissions and no others: Contents (write), Pull requests (write) and Metadata (read). It has no webhook, no events and is private to your account.

## How pushes authenticate

While an App is connected, `github.com` counts as a host the service holds a credential for: it appears in `whoami.gitHosts`, so a handoff from a github.com repository ships only what GitHub lacks ([delta handoffs](architecture.md#design)). For each fetch and push the service mints an installation token for that one repository (`POST /app/installations/{id}/access_tokens` with `repositories: [<repo>]`), good for one hour. It caches the token until 5 minutes before it expires, hands it to git for that command only and removes it from every error text. It never enters a VM.

If the App is not installed on a repository:

- with a `github.com` entry in `service.json` `git.hosts`, that entry's token is used, as before the App existed;
- without one, the base fetch of a handoff fails with `the base commit <sha> is not on <remote> (fatal: the GitHub App <slug> is not installed on <owner>/<repo>: <install URL>)`, and the plugin falls back to a full snapshot; a push records `pushError` `git push failed: fatal: the GitHub App <slug> is not installed on <owner>/<repo>: <install URL>`.

The push rules do not change: never forced, never a protected branch (`git.protected`), never the remote's default branch ([Push policy](api.md#push-policy)).

The App asks for no Workflows permission, so GitHub refuses a push that adds or changes `.github/workflows/*` (`pushError` `the remote refused <target>: …`). This is deliberate: an agent cannot rewrite CI to reach your repository's secrets. Push such a branch yourself after `/cloud pull`.

## Signed commits

With `git.sign` `ssh` and a signing key, the service signs every commit a thread makes:

1. After a turn the runner downloads the VM's result bundle and stores it.
2. The service loads the thread's base into a temporary repository and re-creates the commits **of this turn** (those after the previous turn's head, or after the handoff commit for the first turn) with a `gpgsig` header, an SSH signature (`ssh-ed25519`, namespace `git`) made with its own Ed25519 key. The tree, author, author date and message are unchanged; only the committer is replaced (below). A commit that already carries a signature and whose parents did not change keeps its id. Commits an earlier turn exposed (stored, pulled or pushed) are never rewritten, even when that turn ran unsigned, so turning `git.sign` on later is safe: the next push is a fast-forward of the unsigned head and only the new commits carry signatures.
3. The service uploads the signed bundle to the VM, and the VM **adopts** the signed tip: it fetches it, checks that its tree equals the workspace's, moves the branch and resets softly to it. The next turn therefore builds on the signed commits. A mismatch refuses the adoption.
4. Only then does the service store the signed `result.bundle` and record the signed head, so the stored bundle, the head, `/cloud pull` and the push always agree.

Signing never fails a turn. When any step fails the unsigned result stands and the thread gets a `notice` event `the commits were not signed: <reason>`; with `git.sign` `ssh` and no key the notice is `git.sign is ssh but the service has no signing key: create it on the dashboard's GitHub page`. A successful signing is a `sign` event `signed <n> commit(s) with <fingerprint>`. Ed25519 signatures are deterministic, so a retry gives the same commit ids.

**What makes GitHub show Verified.** Two things, both on your side:

- the public key is added to your account as a **Signing Key**;
- the committer email of the commit is verified on that account. The service sets the committer on every commit it signs: `git.committer` (`Name <email>`) when set, else, for an App owned by a user account, `<login>` with the noreply address `<id>+<login>@users.noreply.github.com`, which GitHub treats as verified for that user. An App owned by an **organization** has no such address: set `git.committer` to an address verified on the account that holds the key. With neither, the commits keep their own committer, which is rarely verified.

After a push to a github.com repository the App is installed on, the service asks GitHub for the head's verification and records a `sign` event: `GitHub shows <head8> as Verified` or `GitHub does not verify <head8>: <reason>` (for example `unknown_key` or `unverified_email`). A failure of that check says nothing.

The signing key is one Ed25519 key for the whole service. Delete it on the GitHub page (and remove it from GitHub) to retire it; commits already signed keep their signature.

**Your own handoff commit.** When your repository has `commit.gpgsign=true`, the plugin makes the WIP commit that carries your uncommitted work with `git commit-tree -S`, so the handoff commit is signed with your key. A hardware key or pinentry prompt cannot hang the handoff: signing is given 30 seconds, and on a failure or timeout the commit is made unsigned and the launch card warns `the handoff commit is unsigned: <reason>`.

## Pull requests

After a successful push to a github.com repository the App is installed on, with `git.pr` not `off`, the service opens a pull request from the pushed branch into the thread's base branch (the branch you handed off from, else the remote's default branch). The title is the thread's name, else its title. A `pr` event says what happened:

| `git.pr` | After the push |
|---|---|
| `draft` (default) | opens a draft pull request, `opened draft pull request #<n> <url>`; a repository that cannot hold drafts gets a ready one, `opened pull request #<n> <url>` |
| `ready` | opens a ready pull request, `opened pull request #<n> <url>` |
| `off` | opens none |

The body is the **omp-cloud section**, between two markers:

```
<!-- omp-cloud:begin -->
**omp-cloud** thread `<id>` · <name or title> · model `<model>`

<latest reply>

Check it out locally: `/cloud pull <id>`
<!-- omp-cloud:end -->
```

The reply is cut to 6000 characters. Every later push updates only that section (`updated pull request #<n> <url>`), so what you wrote above or below the markers stays, and an unchanged body sends no request (no event). A pull request that was merged is followed by a new one on the next push; one **closed without merging** is taken as your answer: nothing opens again and the event says `pull request #<n> was closed; not opening another`. The thread's `pr` field holds `{number, url}`, the turn card shows `PR #<n> <url>`, the dashboard's thread page links it, and the `cloud` tool's `status` prints `pr: <url>`.

A pull request that fails (the App was uninstalled, GitHub is down) is a `pr` event `pull request failed: <message>`. It never changes `pushed`: the branch is on the remote either way.

## Where it lives

- `<dataDir>/github/app.json` and `app.pem`: the App's description and private key, in a 0700 directory, files 0600. A key with group or other permission bits stops the service from using it (`the GitHub App key <path> must be mode 0600`).
- `<dataDir>/signing/ed25519.pem`: the signing key, same modes (`the signing key <path> must be mode 0600`).
- Both directories are in every [backup](operations.md) and in a restore, so treat the archive like the data directory.
- Disconnect on the GitHub page deletes the App's two files from the service; delete the App itself on GitHub (Settings, Developer settings) to revoke it there.

Settings: [`git.sign`, `git.committer` and `git.pr`](api.md#settings). Limits: [Known limitations](architecture.md#known-limitations).
