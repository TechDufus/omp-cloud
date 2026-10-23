#!/usr/bin/env bash
# Keeps the vibemon of an omp-cloud node equal to the server's: `vmon-sync`, run as root by the node's systemd timer
# (`omp-cloud-vmon-sync.timer`, oneshot `omp-cloud-vmon-sync.service`).
#
# `omp-cloud setup node --join` installs this file as the root-owned /usr/local/libexec/omp-cloud/vmon-sync (0755). Vibemon
# machines of one cluster must run the same version, and the server's omp-cloud release pins it, so the node asks the server
# which vmon it runs and installs that tag through the root helper vmon-install (which downloads it from the official release,
# verifies it and rolls back when the unit does not stay active). Nothing from the network reaches a shell: the server's
# answer is reduced to a tag matching ^v[0-9]+\.[0-9]+\.[0-9]+$ before anything uses it.
#
# What it does, in order:
#   1. reads SERVER_URL (^https://[0-9.]+:[0-9]+$) and SERVER_PIN (^sha256//[A-Za-z0-9+/]{43}=$) from /etc/omp-cloud/node.env,
#      line by line; the file is never sourced, and any other line is ignored,
#   2. asks GET <SERVER_URL>/api/v1/health over https, pinned to SERVER_PIN (curl -q, body at most 64 KiB), for the server's
#      "vmon" tag; no answer, or no tag (the server's vmon is not known), ends the run with status 0. A certificate that is not
#      the pinned one (curl exit 90) is a failure: status 1, nothing installed, no state file,
#   3. compares it with the installed /opt/vmon/vmon; equal ends the run (and forgets an earlier failure),
#   4. when another install holds the helper's lock (/opt/.vmon-install.lock) it ends the run with status 0 and no state file;
#      else runs `vmon-install <tag>`. A failure is written to /var/lib/omp-cloud/vmon-sync.failed as `<tag> <epoch>`, and the
#      same tag is not tried again for an hour (a different tag is); a success deletes that file.
#
# Output: one line on stdout per decision (the journal keeps it). Exit status: 0 when there is nothing to do or the install
# worked, 1 when the configuration is unusable or the install failed, 2 for a bad invocation.
#
# Tests (src/vmon/vmon-sync.test.ts) run it unprivileged against temp directories. These overrides are honoured only when
# the effective user is NOT root, and are refused as root. Unprivileged, VMON_SYNC_CONF, VMON_SYNC_HELPER, VMON_SYNC_STATE
# and VMON_SYNC_LOCK are required:
#   VMON_SYNC_CONF    the node.env file (default /etc/omp-cloud/node.env)
#   VMON_SYNC_HELPER  the install helper, called with the tag (default /usr/local/libexec/omp-cloud/vmon-install)
#   VMON_SYNC_BINARY  the installed vmon (default /opt/vmon/vmon)
#   VMON_SYNC_CURL    curl executable (default curl)
#   VMON_SYNC_STATE   the failure state file (default /var/lib/omp-cloud/vmon-sync.failed)
#   VMON_SYNC_LOCK    the helper's install lock file (default /opt/.vmon-install.lock), which tests must set
set -euo pipefail

URL_PATTERN='^https://[0-9.]+:[0-9]+$'
PIN_PATTERN='^sha256//[A-Za-z0-9+/]{43}=$'
TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'
RETRY_AFTER=3600
OVERRIDES=(VMON_SYNC_CONF VMON_SYNC_HELPER VMON_SYNC_BINARY VMON_SYNC_CURL VMON_SYNC_STATE VMON_SYNC_LOCK)

fail() {
	echo "vmon-sync: $1" >&2
	exit "${2:-1}"
}
log() { echo "vmon-sync: $*"; }

[ "$#" -eq 0 ] || fail "usage: vmon-sync (it takes no argument)" 2

if [ "$(id -u)" -eq 0 ]; then
	for name in "${OVERRIDES[@]}"; do
		[ -z "${!name+x}" ] || fail "$name is a test override and is refused as root" 2
	done
	PATH=/usr/sbin:/usr/bin:/sbin:/bin
	export PATH
	conf=/etc/omp-cloud/node.env
	helper=/usr/local/libexec/omp-cloud/vmon-install
	binary=/opt/vmon/vmon
	curl_bin=curl
	state=/var/lib/omp-cloud/vmon-sync.failed
	lock=/opt/.vmon-install.lock
else
	for name in VMON_SYNC_CONF VMON_SYNC_HELPER VMON_SYNC_STATE VMON_SYNC_LOCK; do
		[ -n "${!name:-}" ] || fail "this script must run as root (or with $name set, in tests)" 2
	done
	conf="$VMON_SYNC_CONF"
	helper="$VMON_SYNC_HELPER"
	binary="${VMON_SYNC_BINARY:-/opt/vmon/vmon}"
	curl_bin="${VMON_SYNC_CURL:-curl}"
	state="$VMON_SYNC_STATE"
	lock="$VMON_SYNC_LOCK"
fi

# node.env is read as data: a line is used only when its whole value matches the pattern of its key.
server_url=""
server_pin=""
[ -f "$conf" ] || fail "$conf does not exist: this machine is not set up as a node"
while IFS= read -r line || [ -n "$line" ]; do
	case "$line" in
		SERVER_URL=*)
			value="${line#SERVER_URL=}"
			if [[ "$value" =~ $URL_PATTERN ]]; then server_url="$value"; fi
			;;
		SERVER_PIN=*)
			value="${line#SERVER_PIN=}"
			if [[ "$value" =~ $PIN_PATTERN ]]; then server_pin="$value"; fi
			;;
	esac
done < "$conf"
[ -n "$server_url" ] || fail "$conf holds no valid SERVER_URL (https://<ipv4>:<port>)"
[ -n "$server_pin" ] || fail "$conf holds no valid SERVER_PIN (sha256//<base64>)"

# The server's certificate is self-signed: -k skips the chain check and --pinnedpubkey is the trust. -q comes first so that
# no curlrc of root applies; the body is a few hundred bytes, so a larger one is refused.
curl_status=0
health="$("$curl_bin" -q -sk --proto =https --pinnedpubkey "$server_pin" --max-filesize 65536 --max-time 10 "$server_url/api/v1/health" 2>/dev/null)" || curl_status=$?
# 90: curl's "the public key does not match the pinned key". Unlike a server that is down, this is an unexpected certificate
# (a re-keyed server, or something else answering at its address), so it is a failure and never an install.
[ "$curl_status" -ne 90 ] || fail "the server's certificate is not the pinned one"
if [ "$curl_status" -ne 0 ] || [ -z "$health" ]; then
	log "the server did not answer"
	exit 0
fi

# The health body is compact JSON, {"status":..,"version":..,"build":..,"schema":..,"vmon":"v0.4.0"}; "vmon" is null when the
# server does not know its vibemon. Only a well-formed tag is taken from it.
tag="$(printf '%s' "$health" | sed -n 's/.*"vmon":[[:space:]]*"\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' | head -n 1)"
[ -n "$tag" ] && [[ "$tag" =~ $TAG_PATTERN ]] || exit 0

# A missing or broken binary reads as "not installed": the mismatch below installs the server's tag.
installed=""
if [ -x "$binary" ]; then
	installed="$("$binary" --version 2>/dev/null | head -n 1 || true)"
fi
if [ "$installed" = "vmon ${tag#v}" ]; then
	rm -f "$state"
	exit 0
fi

now="$(date +%s)"
if [ -f "$state" ]; then
	failed_tag=""
	failed_at=""
	read -r failed_tag failed_at < "$state" || true
	if [ "$failed_tag" = "$tag" ] && [[ "$failed_at" =~ ^[0-9]+$ ]] && [ "$failed_at" -le "$now" ] && [ $((now - failed_at)) -lt "$RETRY_AFTER" ]; then
		log "$tag failed less than an hour ago; not retrying yet"
		exit 0
	fi
fi

# The helper takes this lock itself and refuses when another install holds it. Contention is not a failed tag, so it never
# reaches the state file: the lock is probed here before anything is announced, and the helper's own answer catches a run
# that took the lock in between.
{ exec 8> "$lock"; } 2>/dev/null || fail "cannot open the install lock $lock"
if ! flock -n 8; then
	log "another vmon install is running; trying again next time"
	exit 0
fi
# Released again at once: a lock held here would make the helper refuse.
flock -u 8
exec 8>&-

installed_tag="${installed#vmon }"
if [ -n "$installed_tag" ]; then installed_tag="v$installed_tag"; else installed_tag="none"; fi
log "the server runs vibemon $tag, this machine $installed_tag: installing $tag"
helper_ok=true
helper_out="$("$helper" "$tag")" || helper_ok=false
[ -z "$helper_out" ] || printf '%s\n' "$helper_out"
if $helper_ok; then
	rm -f "$state"
	exit 0
fi
if [[ "$helper_out" == *"another vmon install is running"* ]]; then
	log "another vmon install is running; trying again next time"
	exit 0
fi
mkdir -p "$(dirname "$state")"
printf '%s %s\n' "$tag" "$now" > "$state"
fail "installing $tag failed: see the output above; the next attempt is in an hour"
