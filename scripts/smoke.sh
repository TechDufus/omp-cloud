#!/usr/bin/env bash
# curl smoke test of the omp-cloud HTTP API against a freshly started service (no VM).
# Needs: bun, curl, jq, git, openssl, sha256sum, tar. Never prints the API token.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

for tool in bun curl jq git openssl sha256sum tar; do
	command -v "$tool" >/dev/null || { echo "smoke: missing tool: $tool" >&2; exit 2; }
done

tmp=$(mktemp -d)
server_pid=""
events_pid=""
log="$tmp/server.log"

cleanup() {
	local status=$?
	set +e
	if [[ -n "$events_pid" ]]; then kill "$events_pid" 2>/dev/null; wait "$events_pid" 2>/dev/null; fi
	if [[ -n "$server_pid" ]]; then kill -TERM "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null; fi
	if [[ $status -ne 0 && -f "$log" ]]; then
		echo "--- server log (tail) ---" >&2
		tail -n 40 "$log" >&2
	fi
	rm -rf "$tmp"
	exit "$status"
}
trap cleanup EXIT

token=$(openssl rand -hex 32)
token_hash=$(printf %s "$token" | sha256sum | cut -d' ' -f1)

# Three free ports held at once so they differ: the API, the remote TLS listener and the misconfigured-start check.
read -r port remote_port bad_port < <(bun -e '
const servers = [0, 1, 2].map(() => Bun.serve({ port: 0, fetch: () => new Response("") }));
console.log(servers.map(s => s.port).join(" "));
for (const s of servers) s.stop(true);
')
base="http://127.0.0.1:$port"
remote_base="https://127.0.0.1:$remote_port"
data_dir="$tmp/data"

# Two self-signed identities: the service's, and a stranger's that must never be trusted. The SAN is only for curl's
# own hostname check; omp's pinned transport compares the certificate fingerprint instead.
tls_dir="$tmp/tls"
stranger_dir="$tmp/stranger-tls"
for dir in "$tls_dir" "$stranger_dir"; do
	(umask 077; install -d -m 0700 "$dir"; openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
		-subj "/CN=omp-cloud smoke" -addext "subjectAltName=IP:127.0.0.1" -keyout "$dir/key.pem" -out "$dir/cert.pem" 2>/dev/null)
done
fingerprint="SHA256:$(openssl x509 -in "$tls_dir/cert.pem" -outform der | openssl dgst -sha256 -binary | base64 | tr -d =)"

cat >"$tmp/config.json" <<EOF
{
  "listen": "127.0.0.1:$port",
  "apiTokenSha256": "$token_hash",
  "dataDir": "$data_dir",
  "vmon": { "url": "http://127.0.0.1:1", "keyFile": "$tmp/vmon.key", "template": "omp-agent" },
  "gateway": { "url": "http://127.0.0.2:2", "clientsFile": "$tmp/gateway-clients.json" },
  "broker": { "url": "http://127.0.0.1:3", "tokenFile": "$tmp/broker.token" },
  "remote": {
    "listen": "127.0.0.1:$remote_port",
    "certFile": "$tls_dir/cert.pem",
    "keyFile": "$tls_dir/key.pem",
    "advertise": ["127.0.0.1:$remote_port"],
    "allow": ["127.0.0.0/8"]
  },
  "models": {
    "default": "fake/fake-model",
    "direct": { "fake": { "baseUrl": "http://127.0.0.1:1/v1", "auth": "none", "api": "openai-completions", "models": [{ "id": "fake-model" }] } }
  },
  "runner": { "enabled": false }
}
EOF

bun run src/main.ts --config "$tmp/config.json" >"$log" 2>&1 &
server_pid=$!

ready=""
for _ in $(seq 1 100); do
	if ! kill -0 "$server_pid" 2>/dev/null; then echo "smoke: service exited during startup" >&2; exit 1; fi
	# The API answers 503 while the service starts; the app answers an unauthenticated whoami with 401.
	if [[ $(curl -s -o /dev/null -w '%{http_code}' "$base/api/v1/whoami") == 401 ]]; then ready=1; break; fi
	sleep 0.1
done
[[ -n "$ready" ]] || { echo "smoke: service did not answer within 10 s" >&2; exit 1; }

# --- fixtures ---------------------------------------------------------------
fx="$tmp/fixtures"
mkdir -p "$fx/repo" "$fx/conv" "$fx/setup"
git -C "$fx/repo" init -q
echo hello >"$fx/repo/hello.txt"
git -C "$fx/repo" add hello.txt
git -C "$fx/repo" -c user.name=Smoke -c user.email=smoke@example.com commit -q -m "smoke fixture"
head_commit=$(git -C "$fx/repo" rev-parse HEAD)
git -C "$fx/repo" update-ref refs/omp-cloud/handoff HEAD
git -C "$fx/repo" bundle create "$fx/source.bundle" refs/omp-cloud/handoff 2>/dev/null
echo '{"type":"session"}' >"$fx/conv/session.jsonl"
tar -cf "$fx/conversation.tar" -C "$fx/conv" session.jsonl
echo 'theme: dark' >"$fx/setup/config.yml"
tar -czf "$fx/setup.tar.gz" -C "$fx/setup" config.yml

jq -n --arg commit "$head_commit" '{
	prompt: "Say hello from the smoke test.\nSecond line.",
	model: "",
	thinking: "low",
	repo: {name: "smoke", remoteURL: "", baseRef: "main", baseCommit: "", handoffCommit: $commit, localBranch: "main"},
	paths: {home: "/home/ada", workspace: "/home/ada/src/smoke"},
	author: {name: "Smoke", email: "smoke@example.com"},
	configOverlays: ["overlays/claude.yml"],
	ompVersion: "18.1.0"
}' >"$fx/request.json"
jq '.prompt = ""' "$fx/request.json" >"$fx/request-empty.json"

# --- helpers ----------------------------------------------------------------
status=""
body="$tmp/body"
headers="$tmp/headers"

# request METHOD PATH [curl args...]: authenticated; sets $status, $body, $headers.
request() {
	local method=$1 path=$2
	shift 2
	status=$(curl -sS -o "$body" -D "$headers" -w '%{http_code}' -X "$method" \
		-H "Authorization: Bearer $token" "$@" "$base$path")
}

fail() {
	echo "FAIL - $1" >&2
	echo "  status: ${status:-?}" >&2
	if [[ -f "$body" ]]; then echo "  body: $(head -c 2000 "$body")" >&2; fi
	exit 1
}

ok() { echo "ok - $1"; }

expect_status() {
	[[ "$status" == "$1" ]] || fail "$2: expected status $1"
}

# expect_jq FILTER WHAT: the filter must be true on the last response body.
expect_jq() {
	jq -e "$1" "$body" >/dev/null 2>&1 || fail "$2: expected jq '$1'"
}

# expect_header NAME VALUE WHAT: case-insensitive name, exact value.
expect_header() {
	local actual
	actual=$(grep -i "^$1:" "$headers" | head -n1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//') || true
	[[ "$actual" == "$2" ]] || fail "$3: expected header $1: $2, got '${actual:-<none>}'"
}

# --- authentication and routing --------------------------------------------
status=$(curl -sS -o "$body" -D "$headers" -w '%{http_code}' "$base/api/v1/whoami")
expect_status 401 "whoami without a token"
expect_header WWW-Authenticate 'Bearer realm="omp-cloud"' "whoami without a token"
expect_jq '.error == "unauthorized"' "whoami without a token"
ok "no token -> 401 with WWW-Authenticate"

status=$(curl -sS -o "$body" -D "$headers" -w '%{http_code}' -H "Authorization: Bearer wrong-token" "$base/api/v1/whoami")
expect_status 401 "whoami with a wrong token"
expect_header WWW-Authenticate 'Bearer realm="omp-cloud"' "whoami with a wrong token"
ok "wrong token -> 401"

request GET /api/v1/nope
expect_status 404 "unknown route"
expect_jq '.error == "not found"' "unknown route"
ok "unknown route -> 404"

request GET /api/v1/whoami
expect_status 200 "whoami"
expect_jq '.user == "owner"' "whoami"
expect_jq '.threads == {starting: 0, working: 0, waiting: 0, idle: 0, failed: 0}' "whoami"
expect_jq '.modelPatterns == ["fake/*"]' "whoami"
expect_jq '.ompVersion | test("^[0-9]+[.][0-9]+[.][0-9]+$")' "whoami"
expect_header Cache-Control no-store "whoami"
ok "whoami -> owner, zero threads, model patterns, omp version, no-store"

# --- create -----------------------------------------------------------------
create_args=(
	-F "request=@$fx/request.json;type=application/json"
	-F "source=@$fx/source.bundle;type=application/octet-stream"
	-F "conversation=@$fx/conversation.tar;type=application/x-tar"
	-F "setup=@$fx/setup.tar.gz;type=application/gzip"
)
request POST /api/v1/threads "${create_args[@]}"
expect_status 201 "create thread"
expect_jq '.phase == "starting" and .turns == 1 and .queued == 1 and .warnings == [] and .ompVersion == "18.1.0"' "create thread"
id=$(jq -r .id "$body")
[[ "$id" =~ ^[a-z0-9]{12}$ ]] || fail "create thread: id '$id' is not 12 chars of [a-z0-9]"
ok "create -> 201 starting, 1 turn, 1 queued ($id)"

request POST /api/v1/threads \
	-F "request=@$fx/request-empty.json;type=application/json" \
	-F "source=@$fx/source.bundle;type=application/octet-stream"
expect_status 400 "create with an empty prompt"
expect_jq '(.error | type) == "string" and (.error | length) > 0' "create with an empty prompt"
ok "create with an empty prompt -> 400"

jq '.model = "nosuch/model:high"' "$fx/request.json" >"$fx/request-unrunnable.json"
request POST /api/v1/threads \
	-F "request=@$fx/request-unrunnable.json;type=application/json" \
	-F "source=@$fx/source.bundle;type=application/octet-stream"
expect_status 409 "create with a model the cloud cannot run"
expect_jq '.error == "the cloud cannot run nosuch models; log the cloud broker in with /cloud login nosuch"' "create with a model the cloud cannot run"
ok "create with an unrunnable model -> 409 with the login hint"

for bad in 'no-slash' '/id' 'provider/' 'a b/c'; do
	jq --arg m "$bad" '.model = $m' "$fx/request.json" >"$fx/request-bad.json"
	request POST /api/v1/threads \
		-F "request=@$fx/request-bad.json;type=application/json" \
		-F "source=@$fx/source.bundle;type=application/octet-stream"
	expect_status 400 "create with the malformed model '$bad'"
done
ok "create with a malformed model -> 400"

for bad in '{"configOverlays": ["../x.yml"]}' '{"configOverlays": ["/etc/passwd"]}' '{"ompVersion": "latest"}' '{"ompVersion": "v18.1.0"}'; do
	jq --argjson over "$bad" '. + $over' "$fx/request.json" >"$fx/request-bad.json"
	request POST /api/v1/threads \
		-F "request=@$fx/request-bad.json;type=application/json" \
		-F "source=@$fx/source.bundle;type=application/octet-stream"
	expect_status 400 "create with $bad"
done
ok "create with bad overlays or omp version -> 400"

request POST /api/v1/threads \
	-F "source=@$fx/source.bundle;type=application/octet-stream" \
	-F "request=@$fx/request.json;type=application/json"
expect_status 400 "create whose first part is not request"
expect_jq '(.error | type) == "string" and (.error | length) > 0' "create whose first part is not request"
ok "create whose first part is not request -> 400"

# --- read -------------------------------------------------------------------
request GET /api/v1/threads
expect_status 200 "list threads"
jq -e --arg id "$id" '.threads | map(.id) | index($id) != null' "$body" >/dev/null || fail "list threads: expected id $id in .threads"
ok "list contains the thread"

request GET "/api/v1/threads/$id"
expect_status 200 "thread detail"
expect_jq '.turns[0].state == "queued"' "thread detail"
jq -e --arg c "$head_commit" '.repo.handoffCommit == $c' "$body" >/dev/null || fail "thread detail: expected repo.handoffCommit $head_commit"
ok "detail: first turn queued, handoff commit recorded"
expect_jq '.configOverlays == ["overlays/claude.yml"] and .ompVersion == "18.1.0"' "thread detail"
ok "detail: configOverlays and ompVersion as sent"

request GET /api/v1/whoami
expect_status 200 "whoami after create"
expect_jq '.threads.starting == 1' "whoami after create"
ok "whoami counts starting == 1"

# --- messages and events ----------------------------------------------------
request POST "/api/v1/threads/$id/messages" -H 'Content-Type: application/json' -d '{"text":"a follow-up"}'
expect_status 201 "send message"
expect_jq '.turn.id == 2' "send message"
ok "message -> 201, turn 2"

events_catchup() {
	curl -sN --max-time 2 -H "Authorization: Bearer $token" "$@" || true
}

out=$(events_catchup "$base/api/v1/threads/$id/events?after=0")
grep -qx 'id: 1' <<<"$out" && grep -qx 'id: 2' <<<"$out" || { echo "FAIL - events after=0: expected id: 1 and id: 2" >&2; echo "$out" >&2; exit 1; }
[[ $(grep -c '"kind":"turn_queued"' <<<"$out") == 2 ]] || { echo "FAIL - events after=0: expected two turn_queued events" >&2; echo "$out" >&2; exit 1; }
ok "events after=0 -> seq 1 and 2, turn_queued"

out=$(events_catchup -H "Last-Event-ID: 1" "$base/api/v1/threads/$id/events")
if grep -qx 'id: 1' <<<"$out" || ! grep -qx 'id: 2' <<<"$out"; then
	echo "FAIL - events with Last-Event-ID: 1: expected only seq 2" >&2; echo "$out" >&2; exit 1
fi
ok "events with Last-Event-ID: 1 -> only seq 2"

live="$tmp/live.sse"
: >"$live"
curl -sN -H "Authorization: Bearer $token" "$base/api/v1/threads/$id/events?after=2" >"$live" 2>&1 &
events_pid=$!
# The stream announces itself with a ": connected" comment once it has no backlog.
for _ in $(seq 1 50); do
	grep -q '^: connected' "$live" && break
	sleep 0.1
done
grep -q '^: connected' "$live" || { echo "FAIL - live events: no ': connected' comment" >&2; cat "$live" >&2; exit 1; }

request POST "/api/v1/threads/$id/stop"
expect_status 200 "stop"
expect_jq '. == {"stoppedRunning": false, "cancelled": 2}' "stop"
ok "stop -> 200 {stoppedRunning: false, cancelled: 2}"

for _ in $(seq 1 50); do
	grep -qx 'id: 4' "$live" && break
	sleep 0.1
done
kill "$events_pid" 2>/dev/null || true
wait "$events_pid" 2>/dev/null || true
events_pid=""
if ! grep -qx 'id: 3' "$live" || ! grep -qx 'id: 4' "$live" || [[ $(grep -c '"kind":"turn_cancelled"' "$live") != 2 ]]; then
	echo "FAIL - live events: expected two turn_cancelled events (seq 3 and 4)" >&2; cat "$live" >&2; exit 1
fi
ok "live stream received turn_cancelled seq 3 and 4"

request GET "/api/v1/threads/$id"
expect_status 200 "detail after stop"
expect_jq '.phase == "idle"' "detail after stop"
ok "detail phase is idle after stop"

# --- answer, result, conversation ------------------------------------------
request POST "/api/v1/threads/$id/turns/1/questions/1/answer" -H 'Content-Type: application/json' -d '{"answer":"yes"}'
expect_status 404 "answer to an unknown question"
ok "answer to an unknown question -> 404"

request GET "/api/v1/threads/$id/result"
expect_status 404 "result before any"
expect_jq '.error == "no result yet"' "result before any"
ok "result -> 404 no result yet"

request GET "/api/v1/threads/$id/conversation"
expect_status 200 "conversation"
expect_header Content-Type application/x-tar "conversation"
cmp -s "$body" "$fx/conversation.tar" || fail "conversation: bytes differ from the uploaded tar"
ok "conversation -> 200 application/x-tar, identical bytes"

request GET "/api/v1/threads/$id/conversation" -H 'Range: bytes=0-9'
expect_status 206 "conversation range"
[[ $(wc -c <"$body") == 10 ]] || fail "conversation range: expected 10 bytes, got $(wc -c <"$body")"
ok "conversation Range bytes=0-9 -> 206, 10 bytes"

# --- delete -----------------------------------------------------------------
[[ -d "$data_dir/threads/$id" ]] || fail "expected $data_dir/threads/$id to exist before delete"
request DELETE "/api/v1/threads/$id"
expect_status 202 "delete"
expect_jq '.status == "deleting"' "delete"
ok "delete -> 202"

request GET "/api/v1/threads/$id"
expect_status 404 "detail after delete"
request GET "/api/v1/threads/$id/events"
expect_status 404 "events after delete"
ok "detail and events -> 404 after delete"

# 202 "deleting": the files may go a moment after the response.
for _ in $(seq 1 50); do
	[[ -e "$data_dir/threads/$id" ]] || break
	sleep 0.1
done
[[ ! -e "$data_dir/threads/$id" ]] || fail "thread directory $data_dir/threads/$id still exists 5 s after delete"
ok "thread files removed"

# --- the remote TLS listener and device pairing -------------------------------
# remote METHOD PATH [curl args...]: over the TLS port, trusting only the service's certificate; no credentials unless
# given. Sets $status, $body, $headers.
remote() {
	local method=$1 path=$2
	shift 2
	status=$(curl -sS -o "$body" -D "$headers" -w '%{http_code}' --cacert "$tls_dir/cert.pem" -X "$method" "$@" "$remote_base$path")
}

# device METHOD PATH [curl args...]: `remote` with the paired device's token (set below).
device_token=""
device() {
	local method=$1 path=$2
	shift 2
	remote "$method" "$path" -H "Authorization: Bearer $device_token" "$@"
}

json=(-H 'Content-Type: application/json')

grep -qF "omp-cloud remote on https://127.0.0.1:$remote_port ($fingerprint)" "$log" || fail "start log: expected 'omp-cloud remote on https://127.0.0.1:$remote_port ($fingerprint)'"
ok "start log names the remote listener and its certificate fingerprint"

remote GET /api/v1/whoami -H "Authorization: Bearer $token"
expect_status 401 "owner token on the remote port"
expect_header WWW-Authenticate 'Bearer realm="omp-cloud"' "owner token on the remote port"
ok "remote: the owner token -> 401 (and the pinned certificate was accepted)"

plain=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$remote_port/api/v1/whoami" 2>/dev/null || true)
[[ "$plain" == 000 ]] || fail "plain HTTP to the remote port: expected the connection to fail, got status $plain"
ok "remote: plain HTTP to the TLS port fails"

if curl -sS --max-time 5 -o /dev/null --cacert "$stranger_dir/cert.pem" "$remote_base/api/v1/whoami" 2>/dev/null; then
	fail "remote: a client that pins another certificate must not connect"
fi
ok "remote: a client pinning another self-signed certificate fails"

# VM traffic reaches host listeners with the gateway's address as its source (vmon's egress proxy dials from the host). Here the gateway is
# 127.0.0.2, inside the configured allow list, and the remote port must still refuse it before routing.
remote GET /api/v1/whoami --interface 127.0.0.2
expect_status 403 "a client whose source is the gateway address"
remote POST /api/v1/pairing/redeem --interface 127.0.0.2 "${json[@]}" -d '{}'
expect_status 403 "a redeem whose source is the gateway address"
ok "remote: a source equal to the gateway address -> 403, even inside remote.allow and on the pairing routes"

request POST /api/v1/pairing/offers "${json[@]}" -d '{}'
expect_status 201 "create offer"
expect_jq '(.code | startswith("ompc1:")) and (.id | type) == "string" and (.expiresAt | type) == "string"' "create offer"
expect_jq ".fingerprint == \"$fingerprint\" and .addresses == [\"127.0.0.1:$remote_port\"]" "create offer"
offer_id=$(jq -r .id "$body")
code=$(jq -r .code "$body")
IFS=: read -r _ code_offer offer_secret code_fp <<<"${code%@*}"
[[ "$code_offer" == "$offer_id" ]] || fail "create offer: the code does not carry the offer id"
[[ "$code_fp" == "$(printf %s "${fingerprint#SHA256:}" | tr '+/' '-_')" ]] || fail "create offer: the code does not carry the certificate fingerprint"
[[ "${code#*@}" == "127.0.0.1:$remote_port" ]] || fail "create offer: the code does not carry the advertised address"
ok "owner creates an offer: code with the offer id, the certificate fingerprint and the advertised address"

redeem_body=$(jq -n --arg offer "$offer_id" --arg secret "$offer_secret" '{offer: $offer, secret: $secret, name: "smoke phone", platform: "linux"}')
remote POST /api/v1/pairing/redeem "${json[@]}" -d "$redeem_body"
expect_status 202 "redeem"
expect_jq '(.request | type) == "string" and (.requestSecret | type) == "string" and (.expiresAt | type) == "string"' "redeem"
claim_body=$(jq '{request: .request, requestSecret: .requestSecret}' "$body")
ok "redeem over the pinned TLS port -> 202"

remote POST /api/v1/pairing/redeem "${json[@]}" -d "$redeem_body"
expect_status 401 "redeem of an offer that is no longer open"
expect_jq '.error == "invalid or expired pairing code"' "redeem of an offer that is no longer open"
ok "a second redeem of the same code -> 401"

remote POST /api/v1/pairing/claim "${json[@]}" -d "$claim_body"
expect_status 202 "claim before approval"
expect_jq '.status == "pending"' "claim before approval"
ok "claim before approval -> 202 pending"

request GET "/api/v1/pairing/offers/$offer_id"
expect_status 200 "offer while pending"
expect_jq '.status == "pending" and .request.name == "smoke phone" and .request.platform == "linux" and (.request.address | type) == "string"' "offer while pending"
ok "owner sees the request: name, platform, address"

request POST "/api/v1/pairing/offers/$offer_id/approve"
expect_status 204 "approve"
ok "owner approves -> 204"

remote POST /api/v1/pairing/claim "${json[@]}" -d "$claim_body"
expect_status 201 "claim after approval"
expect_jq '(.token | startswith("ompd_")) and .device.name == "smoke phone" and (.device.id | type) == "string"' "claim after approval"
device_token=$(jq -r .token "$body")
device_id=$(jq -r .device.id "$body")
ok "claim after approval -> 201 with an ompd_ token"

remote POST /api/v1/pairing/claim "${json[@]}" -d "$claim_body"
expect_status 401 "second claim"
expect_jq '.error == "invalid or expired pairing request"' "second claim"
ok "the token is delivered once: a second claim -> 401"

device GET /api/v1/whoami
expect_status 200 "device whoami on the remote port"
expect_jq ".device.name == \"smoke phone\" and .device.id == \"$device_id\" and .device.access == \"threads\" and .remote.fingerprint == \"$fingerprint\" and .user == \"owner\"" "device whoami on the remote port"
ok "remote: device token whoami -> the device and the server fingerprint"

status=$(curl -sS -o "$body" -w '%{http_code}' -H "Authorization: Bearer $device_token" "$base/api/v1/whoami")
expect_status 200 "device token on the loopback listener"
expect_jq ".device.id == \"$device_id\"" "device token on the loopback listener"
ok "the device token also works on the loopback listener"

device GET /api/v1/devices
expect_status 200 "devices as the device"
expect_jq '(.devices | length) == 1 and .devices[0].current == true and .devices[0].name == "smoke phone"' "devices as the device"
request GET /api/v1/devices
expect_status 200 "devices as the owner"
expect_jq '(.devices | length) == 1 and .devices[0].current == false and .devices[0].platform == "linux"' "devices as the owner"
ok "devices: the device sees itself (current), the owner sees all"

device POST /api/v1/pairing/offers "${json[@]}" -d '{}'
expect_status 403 "device token on POST /pairing/offers"
expect_jq '.error | startswith("this device has threads-only access")' "device token on POST /pairing/offers"
device PUT /api/v1/settings "${json[@]}" -d '{"settings":{}}'
expect_status 403 "device token on PUT /settings"
ok "routes that need full access refuse a threads-only device token -> 403"

request DELETE "/api/v1/devices/$device_id"
expect_status 200 "revoke"
expect_jq ".device.id == \"$device_id\" and .runningThreads == []" "revoke"
device GET /api/v1/whoami
expect_status 401 "device token after revoke"
request DELETE "/api/v1/devices/$device_id"
expect_status 404 "revoke twice"
ok "revoke -> 200; the next request with that token -> 401; revoking twice -> 404"

head -c 3000 /dev/zero | tr '\0' a >"$tmp/big"
remote POST /api/v1/pairing/redeem "${json[@]}" --data-binary "@$tmp/big"
expect_status 413 "3000-byte redeem body"
ok "a 3000-byte redeem body -> 413"

# Three open offers (the most there can be), four wrong secrets each (the fifth would burn one): twelve failures from
# one source. The limiter answers 429 from the eleventh on; no earlier answer may be anything but 401.
for _ in 1 2 3; do
	request POST /api/v1/pairing/offers "${json[@]}" -d '{}'
	expect_status 201 "offer for the garbage redeems"
	flood_offer=$(jq -r .id "$body")
	flood_body=$(jq -n --arg offer "$flood_offer" '{offer: $offer, secret: "AAAAAAAAAAAAAAAAAAAAAA", name: "garbage", platform: "linux"}')
	for _ in 1 2 3 4; do
		remote POST /api/v1/pairing/redeem "${json[@]}" -d "$flood_body"
		[[ "$status" == 401 || "$status" == 429 ]] || fail "garbage redeem: expected 401 or 429"
	done
done
expect_status 429 "twelfth garbage redeem"
expect_jq '.error == "too many attempts; try again later"' "twelfth garbage redeem"
ok "12 garbage redeems from one source -> 429"

# plain HTTP is loopback-only: a service configured to listen on a wildcard address must refuse to start.
jq --arg listen "0.0.0.0:$bad_port" '.listen = $listen' "$tmp/config.json" >"$tmp/bad-config.json"
bad_status=0
timeout 20 bun run src/main.ts --config "$tmp/bad-config.json" >"$tmp/bad.log" 2>&1 || bad_status=$?
if [[ $bad_status == 0 || $bad_status == 124 ]] || ! grep -q 'loopback' "$tmp/bad.log"; then
	cat "$tmp/bad.log" >&2
	fail "a config with listen 0.0.0.0:$bad_port: expected a non-zero exit with a loopback message (exit status $bad_status)"
fi
ok "a non-loopback listen makes the service exit non-zero (exit status $bad_status)"

echo "smoke: all checks passed"
