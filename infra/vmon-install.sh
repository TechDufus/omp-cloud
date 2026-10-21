#!/usr/bin/env bash
# The root helper that installs a vibemon release: `vmon-install <tag>`.
#
# `omp-cloud setup` installs this file as the root-owned /usr/local/libexec/omp-cloud/vmon-install (0755) and lets the owner run
# it through sudo without a password (/etc/sudoers.d/omp-cloud), so that the omp-cloud updater can move vmon to the version
# an omp-cloud release pins without a root shell. Because of that rule the helper trusts nothing from its caller:
#   - the only argument is a release tag matching ^v[0-9]+\.[0-9]+\.[0-9]+$; no file, URL or checksum is ever taken from the caller,
#   - the release is downloaded here, from https://github.com/stencil-hq/vibemon/releases/download/<tag>/, over https only,
#     and each tarball must match the sha256 of its sidecar,
#   - the environment is ignored (sudo resets it, and as root the overrides below are refused outright).
#
# What it does: downloads the two tarballs and their .sha256 sidecars, verifies them, builds the new directory next to
# /opt/vmon, checks that the new vmon reports the tag, renames /opt/vmon to /opt/vmon.prev and the new directory to
# /opt/vmon, restarts the `vmon` unit and waits up to 60 s for GET http://127.0.0.1:3000/health = 204. When the unit does not
# become healthy the previous directory is moved back and the unit restarted once more. A unit that is not running is not
# started (`omp-cloud setup` does that on a first install). Sandbox VMMs keep running over a restart (KillMode=process); vmon
# adopts them again within its 60 s grace period.
#
# Output: progress on stderr; the last stdout line is JSON, {"ok": true, "version": "<tag>"} or {"ok": false, "error": "..."}.
# Exit status: 0 on success, 1 on failure, 2 for a bad invocation.
#
# Tests (src/vmon/vmon-install.test.ts) run it unprivileged against temp directories. These overrides are honoured only
# when the effective user is NOT root, and are refused as root:
#   VMON_INSTALL_ROOT        install directory (default /opt/vmon)
#   VMON_INSTALL_UNIT        systemd unit (default vmon)
#   VMON_INSTALL_BASE        download base, `<base>/<tag>/<file>`; http allowed (default the GitHub release URL)
#   VMON_INSTALL_HEALTH_URL  health URL (default http://127.0.0.1:3000/health)
#   VMON_INSTALL_HEALTH_WAIT seconds to wait for health (default 60)
#   VMON_INSTALL_SYSTEMCTL   systemctl executable (default systemctl)
set -euo pipefail

TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'
RELEASE_BASE='https://github.com/stencil-hq/vibemon/releases/download'
OVERRIDES=(VMON_INSTALL_ROOT VMON_INSTALL_UNIT VMON_INSTALL_BASE VMON_INSTALL_HEALTH_URL VMON_INSTALL_HEALTH_WAIT VMON_INSTALL_SYSTEMCTL)

# Prints the final JSON line for `error` (one line, JSON-escaped) and stops.
json_string() {
	local s="$1"
	s="${s//\\/\\\\}"
	s="${s//\"/\\\"}"
	s="${s//$'\n'/ }"
	s="${s//$'\r'/ }"
	s="${s//$'\t'/ }"
	# Any other control character would make the line invalid JSON.
	s="$(printf '%s' "$s" | tr -d '\000-\037')"
	printf '"%s"' "$s"
}
fail() {
	printf '{"ok": false, "error": %s}\n' "$(json_string "$1")"
	echo "vmon-install: $1" >&2
	exit "${2:-1}"
}
log() { echo "vmon-install: $*" >&2; }

[ "$#" -eq 1 ] || fail "usage: vmon-install <tag> (for example v0.4.0)" 2
tag="$1"
[ "${#tag}" -le 32 ] && [[ "$tag" =~ $TAG_PATTERN ]] || fail "the tag must look like v0.4.0, got: $tag" 2
version="${tag#v}"

if [ "$(id -u)" -eq 0 ]; then
	for name in "${OVERRIDES[@]}"; do
		[ -z "${!name+x}" ] || fail "$name is a test override and is refused as root" 2
	done
	PATH=/usr/sbin:/usr/bin:/sbin:/bin
	export PATH
	root=/opt/vmon
	unit=vmon
	base="$RELEASE_BASE"
	health_url=http://127.0.0.1:3000/health
	health_wait=60
	systemctl_bin=systemctl
	protocols='=https'
else
	[ -n "${VMON_INSTALL_ROOT:-}" ] || fail "this helper must run as root (through sudo)" 2
	root="$VMON_INSTALL_ROOT"
	unit="${VMON_INSTALL_UNIT:-vmon}"
	base="${VMON_INSTALL_BASE:-$RELEASE_BASE}"
	health_url="${VMON_INSTALL_HEALTH_URL:-http://127.0.0.1:3000/health}"
	health_wait="${VMON_INSTALL_HEALTH_WAIT:-60}"
	systemctl_bin="${VMON_INSTALL_SYSTEMCTL:-systemctl}"
	protocols='=http,https'
fi
case "$health_wait" in '' | *[!0-9]*) fail "VMON_INSTALL_HEALTH_WAIT must be a number of seconds" 2 ;; esac

case "$(uname -m)" in
	x86_64) arch=x86_64 ;;
	*) fail "unsupported architecture $(uname -m): only x86_64 is installed by this helper" ;;
esac
# A vibemon release (tag vX.Y.Z) holds two tarballs, each with a `<file>.sha256` sidecar in `sha256sum` form: the binary
# (vmon-x86_64-unknown-linux-musl/vmon) and the assets (vmon-assets-x86_64/vmon-agent-x86_64 and vmon-kernel-x86_64).
bin_tar="vmon-x86_64-unknown-linux-musl.tar.gz"
assets_tar="vmon-assets-x86_64.tar.gz"

parent="$(dirname "$root")"
name="$(basename "$root")"
[ -d "$parent" ] || fail "$parent does not exist"
prev="$root.prev"

# One install at a time.
exec 9>"$parent/.$name-install.lock"
flock -n 9 || fail "another vmon install is running"

work=""
cleanup() { [ -z "$work" ] || rm -rf "$work"; }
trap cleanup EXIT
work="$(mktemp -d "$parent/.$name-install.XXXXXX")"

installed_version() {
	[ -x "$root/vmon" ] || return 0
	"$root/vmon" --version 2>/dev/null | head -n 1 || true
}

healthy() {
	[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$health_url" 2>/dev/null || true)" = 204 ]
}

wait_healthy() {
	local waited=0
	while [ "$waited" -lt "$health_wait" ]; do
		healthy && return 0
		sleep 1
		waited=$((waited + 1))
	done
	healthy
}

unit_active() { "$systemctl_bin" is-active --quiet "$unit" 2>/dev/null; }

# Restarts the unit; the stop alone may take TimeoutStopSec (60 s) while vmon leaves its cluster.
restart_unit() { timeout 150 "$systemctl_bin" restart "$unit"; }

if [ "$(installed_version)" = "vmon $version" ]; then
	log "vmon $tag is already installed in $root"
	printf '{"ok": true, "version": "%s"}\n' "$tag"
	exit 0
fi

# No downgrades: the sudoers rule lets anything running as the owner call this helper, so it never installs a tag older than the
# installed vmon (an older, possibly vulnerable release). Any newer official release is allowed. A version that does not parse
# as x.y.z is not compared. The rollback below is not a tag install and is unaffected.
current="$(installed_version)"
if [[ "$current" =~ ^vmon\ ([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
	current_version="${BASH_REMATCH[1]}"
	if [ "$(printf '%s\n%s\n' "$current_version" "$version" | sort -V | head -n 1)" != "$current_version" ]; then
		fail "refusing to downgrade: vmon v$current_version is installed and $tag is older"
	fi
fi

# Downloads one file of the release into $work/dl and checks it against its sidecar. The sidecar is `<sha256>  <file>`.
fetch_verified() {
	local file="$1" hash sidecar_name actual
	for asset in "$file" "$file.sha256"; do
		curl --fail --silent --show-error --location --proto "$protocols" --tlsv1.2 --max-time 600 --retry 2 \
			--output "$work/dl/$asset" "$base/$tag/$asset" || fail "downloading $asset of vibemon $tag failed"
	done
	read -r hash sidecar_name < "$work/dl/$file.sha256" || true
	sidecar_name="${sidecar_name#\*}"
	[[ "$hash" =~ ^[0-9a-f]{64}$ ]] || fail "$file.sha256 does not hold a sha256 digest"
	[ "$sidecar_name" = "$file" ] || fail "$file.sha256 names $sidecar_name, not $file"
	actual="$(sha256sum "$work/dl/$file" | cut -d' ' -f1)"
	[ "$actual" = "$hash" ] || fail "$file does not match its sha256 sidecar"
}

mkdir -p "$work/dl" "$work/x"
log "downloading vibemon $tag"
fetch_verified "$bin_tar"
fetch_verified "$assets_tar"
# The tarballs come over the network, so nothing is extracted before every member is known to stay inside the extraction
# directory: only regular files and directories, no absolute path, no `..` segment, no link of any kind.
check_members() {
	local file="$1" listing line names
	listing="$(tar -tvzf "$work/dl/$file" 2>/dev/null)" || fail "$file is not a readable tarball"
	names="$(tar -tzf "$work/dl/$file" 2>/dev/null)" || fail "$file is not a readable tarball"
	[ -n "$names" ] || fail "$file is empty"
	while IFS= read -r line; do
		case "${line:0:1}" in
			- | d) ;;
			*) fail "$file holds a member that is not a plain file or directory (${line:0:1}): refusing to unpack it" ;;
		esac
	done <<< "$listing"
	while IFS= read -r line; do
		case "$line" in
			/* | .. | ../* | */.. | */../*) fail "$file holds the member path \"$line\", which leaves the extraction directory" ;;
		esac
	done <<< "$names"
}
check_members "$bin_tar"
check_members "$assets_tar"
tar -xzf "$work/dl/$bin_tar" -C "$work/x" --no-same-owner --no-same-permissions || fail "$bin_tar does not unpack"
tar -xzf "$work/dl/$assets_tar" -C "$work/x" --no-same-owner --no-same-permissions || fail "$assets_tar does not unpack"

src_vmon="$work/x/vmon-x86_64-unknown-linux-musl/vmon"
src_agent="$work/x/vmon-assets-x86_64/vmon-agent-$arch"
src_kernel="$work/x/vmon-assets-x86_64/vmon-kernel-$arch"
for file in "$src_vmon" "$src_agent" "$src_kernel"; do
	[ -f "$file" ] && [ ! -L "$file" ] || fail "the release lacks ${file#"$work/x/"}"
done

new="$work/new"
install -d -m 0755 "$new"
install -m 0755 "$src_vmon" "$src_agent" "$new/"
install -m 0644 "$src_kernel" "$new/"
reported="$("$new/vmon" --version 2>/dev/null | head -n 1 || true)"
[ "$reported" = "vmon $version" ] || fail "the downloaded vmon reports \"$reported\", not \"vmon $version\""

was_active=false
if unit_active; then was_active=true; fi
old_version="$(installed_version)"

# The swap: /opt/vmon moves aside and the new directory takes its name. Two renames in a row (a directory cannot be
# exchanged atomically with portable tools); the running vmon keeps its already loaded binary meanwhile.
rm -rf "$prev"
had_old=false
if [ -e "$root" ]; then
	mv -T "$root" "$prev"
	had_old=true
fi
if ! mv -T "$new" "$root"; then
	if $had_old; then mv -T "$prev" "$root" || true; fi
	fail "could not move the new vmon into $root"
fi
log "installed vibemon $tag in $root${old_version:+ (previous: $old_version, kept in $prev)}"

if ! $was_active; then
	log "the $unit unit is not running: nothing to restart"
	printf '{"ok": true, "version": "%s"}\n' "$tag"
	exit 0
fi

log "restarting $unit"
failure=""
if ! restart_unit; then
	failure="restarting $unit failed"
elif ! wait_healthy; then
	failure="vmon $tag did not answer $health_url with 204 within ${health_wait} s"
fi
if [ -z "$failure" ]; then
	printf '{"ok": true, "version": "%s"}\n' "$tag"
	exit 0
fi

# Roll back: the previous directory takes its name again and the unit restarts on it.
log "$failure: rolling back"
if ! $had_old; then
	fail "$failure (there was no previous vmon to roll back to)"
fi
rm -rf "$work/failed"
mv -T "$root" "$work/failed"
mv -T "$prev" "$root"
if restart_unit && wait_healthy; then
	fail "$failure; rolled back to ${old_version:-the previous vmon}"
fi
fail "$failure; the rollback to ${old_version:-the previous vmon} did not become healthy either: check systemctl status $unit"
