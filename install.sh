#!/bin/sh
# omp-cloud installer: downloads the release binary, verifies it and runs `omp-cloud setup`.
#
#   curl -fsSL https://omp-cloud.techdufus.com/install.sh | sh
#   curl -fsSL https://omp-cloud.techdufus.com/install.sh | sh -s -- --yes --no-login
#
# The website serves this file from main, the same as
# https://raw.githubusercontent.com/TechDufus/omp-cloud/main/install.sh.
#
# Everything after `--` goes to `omp-cloud setup`. The script never uses sudo and never edits a shell rc file:
# the binary installs itself (to ~/.local/share/omp-cloud/app, linked from ~/.local/bin/omp-cloud) and asks for sudo once.
# Environment: OMP_CLOUD_VERSION (a release, e.g. 0.5.1; default: the latest) and OMP_CLOUD_DOWNLOAD_URL
# (the releases base URL; default https://github.com/TechDufus/omp-cloud/releases). The binary is staged (and run for the
# smoke test) under $TMPDIR when set, else ${XDG_CACHE_HOME:-~/.cache}/omp-cloud-install.XXXXXX, and removed on exit;
# /tmp is avoided because it is often noexec or RAM-backed. An https base never follows a redirect to http.
# It sends no credentials, so it can only fetch release assets that are readable anonymously; an update with a token is the binary's own job.
set -eu

ASSET="omp-cloud-linux-x86_64"
DEFAULT_URL="https://github.com/TechDufus/omp-cloud/releases"

usage() {
  cat <<'EOF'
omp-cloud installer

Usage:
  curl -fsSL https://omp-cloud.techdufus.com/install.sh | sh
  curl -fsSL https://omp-cloud.techdufus.com/install.sh | sh -s -- [setup flags]
  sh install.sh [--help | setup flags]

Downloads the omp-cloud release binary for Linux x86_64, checks its sha256, and runs
`omp-cloud setup <setup flags>` (see `omp-cloud setup --help` after installing; for example
--yes, --no-login, --team <slug>). The exit code is setup's.

Environment:
  OMP_CLOUD_VERSION       release to install, e.g. 0.5.1 (default: the latest release)
  OMP_CLOUD_DOWNLOAD_URL  releases base URL (default: https://github.com/TechDufus/omp-cloud/releases)
  TMPDIR                  where the binary is staged while it runs (default: ${XDG_CACHE_HOME:-~/.cache}; must allow executables)

The service host needs Linux x86_64 with KVM. Another machine only needs the plugin:
  omp plugin marketplace add TechDufus/omp-cloud
EOF
}

fail() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}

tmp=""
# shellcheck disable=SC2317,SC2329 # cleanup runs from the EXIT trap below, which shellcheck does not follow (SC2329 from 0.11)
cleanup() {
  if [ -n "$tmp" ]; then
    rm -rf "$tmp"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

os=$(uname -s)
arch=$(uname -m)
if [ "$os" != "Linux" ] || [ "$arch" != "x86_64" ]; then
  printf '✗ %s %s is not supported: the omp-cloud service host needs Linux x86_64 with KVM.\n' "$os" "$arch" >&2
  printf '  Another machine only needs the plugin: omp plugin marketplace add TechDufus/omp-cloud\n' >&2
  exit 1
fi

command -v curl >/dev/null 2>&1 || fail "curl is required to download omp-cloud"
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is required to verify the download"
fi

base="${OMP_CLOUD_DOWNLOAD_URL:-$DEFAULT_URL}"
base="${base%/}"
version="${OMP_CLOUD_VERSION:-}"
version="${version#v}"
if [ -z "$version" ]; then
  url="$base/latest/download"
  label="latest"
else
  case "$version" in
    *[!0-9A-Za-z.+-]*) fail "OMP_CLOUD_VERSION must look like 0.5.1, not '$version'" ;;
  esac
  url="$base/download/v$version"
  label="v$version"
fi

# Stage under the user's cache (like omp's installer, which downloads next to its target) rather than /tmp: /tmp is
# often noexec on hardened servers and RAM-backed on small VMs. $TMPDIR is used only when the user set it.
if [ -n "${TMPDIR:-}" ]; then
  stage_root="$TMPDIR"
elif [ -n "${XDG_CACHE_HOME:-}" ]; then
  stage_root="$XDG_CACHE_HOME"
elif [ -n "${HOME:-}" ]; then
  stage_root="$HOME/.cache"
else
  fail "cannot find a place to stage the download: set HOME, XDG_CACHE_HOME or TMPDIR"
fi
mkdir -p "$stage_root" || fail "cannot create $stage_root"
tmp=$(mktemp -d "$stage_root/omp-cloud-install.XXXXXX") || fail "cannot create a staging directory under $stage_root"
bin="$tmp/omp-cloud"
sidecar="$tmp/omp-cloud.sha256"

# An https base never follows a redirect to another scheme (GitHub redirects downloads to another host); a plain http
# base, which only a test or mirror sets on purpose, may redirect within http and https.
case "$base" in
  https://*) redir_protos="=https" ;;
  *) redir_protos="=http,https" ;;
esac

fetch() {
  progress="-sS"
  if [ -t 2 ]; then
    progress="--progress-bar"
  fi
  curl -fL "$progress" --proto-redir "$redir_protos" --connect-timeout 10 --speed-limit 1024 --speed-time 30 -o "$2" "$1" || fail "download failed: $1"
}

printf 'Downloading %s (%s)...\n' "$ASSET" "$label"
fetch "$url/$ASSET.sha256" "$sidecar"
fetch "$url/$ASSET" "$bin"

# The sidecar is `sha256sum -c` format: "<64 hex>  <file name>".
expected=""
read -r expected _ <"$sidecar" || true
expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
case "$expected" in
  *[!0-9a-f]*) fail "$ASSET.sha256 does not hold a sha256 digest" ;;
esac
[ "${#expected}" -eq 64 ] || fail "$ASSET.sha256 does not hold a sha256 digest"
actual=$(sha256_of "$bin")
if [ "$actual" != "$expected" ]; then
  printf '✗ sha256 mismatch for %s: expected %s, got %s. Nothing was run.\n' "$ASSET" "$expected" "$actual" >&2
  exit 1
fi
printf '✓ sha256 verified\n'

chmod +x "$bin"
if ! out=$("$bin" version 2>&1); then
  printf '✗ omp-cloud was downloaded but cannot start:\n' >&2
  printf '%s\n' "$out" | sed 's/^/    /' >&2
  case "$out" in
    *ermission\ denied*) printf '  If %s is mounted noexec, run again with TMPDIR set to a directory that allows executables.\n' "$stage_root" >&2 ;;
  esac
  exit 1
fi
printf '✓ %s\n' "$out"

# Under `curl | sh` stdin is this script, so setup must not read it: it gets the terminal when there is one (the
# prompts and sudo need it), else /dev/null.
printf 'Running omp-cloud setup...\n'
code=0
if (exec </dev/tty) 2>/dev/null; then
  "$bin" setup "$@" </dev/tty || code=$?
else
  "$bin" setup "$@" </dev/null || code=$?
fi
if [ "$code" -ne 0 ]; then
  printf '✗ omp-cloud setup exited with code %s\n' "$code" >&2
fi
exit "$code"
