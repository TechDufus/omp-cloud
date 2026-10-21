#!/usr/bin/env bash
# Installs the omp this repository pins (@oh-my-pi/pi-coding-agent in package.json) as `omp` into $1 (default
# $RUNNER_TEMP/omp/bin) and, in GitHub Actions, puts that directory on PATH for the next steps.
#
# The same source and checks as the VM template recipe (src/vmon/template.ts `installOmp`): omp's build service answers
# the build's exact SHA-256 and a presigned download URL, and the download is installed only when it hashes to it.
# PI_BUILD_URL overrides the service, as it does for `omp update`.
set -euo pipefail

dest="${1:-${RUNNER_TEMP:-/tmp}/omp/bin}"
version="$(jq -er '.dependencies["@oh-my-pi/pi-coding-agent"]' package.json)"
origin="${PI_BUILD_URL:-https://build.stencil.so}"
origin="${origin%/}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsS -H 'Accept: application/json' -o "$tmp/answer.json" "$origin/api/products/omp/versions/$version/linux-x86_64"
jq -e --arg version "$version" '.build.version == $version and .file.name == "omp-linux-x64"' "$tmp/answer.json" >/dev/null
sha256="$(jq -er '.file.sha256 | select(test("^[0-9a-f]{64}$"))' "$tmp/answer.json")"
curl -fsSL -o "$tmp/omp-linux-x64" "$(jq -er .download "$tmp/answer.json")"
echo "$sha256  $tmp/omp-linux-x64" | sha256sum -c -
install -D -m 0755 "$tmp/omp-linux-x64" "$dest/omp"
if [ -n "${GITHUB_PATH:-}" ]; then echo "$dest" >> "$GITHUB_PATH"; fi
"$dest/omp" --version
