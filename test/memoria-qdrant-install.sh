#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "$0")/.." && pwd)/base/memoria/deploy/install-qdrant.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -m 700 "$scratch/bin" "$scratch/data"
printf 'synthetic-test-key\n' > "$scratch/key"
chmod 600 "$scratch/key"

cat > "$scratch/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "${1-} ${2-}" in
  'info --format') exit 0 ;;
  'container inspect')
    test -f "$FAKE_DOCKER_STATE" || exit 1
    cat "$FAKE_DOCKER_STATE" ;;
  'run -d')
    if test -f "$FAKE_DOCKER_FAIL_RUN"; then rm "$FAKE_DOCKER_FAIL_RUN"; exit 97; fi
    cp "$FAKE_DOCKER_OWNED" "$FAKE_DOCKER_STATE"
    printf 'fake-container-id\n' ;;
  'start cbs-mem0-qdrant')
    if test -f "$FAKE_DOCKER_FAIL_START"; then
      remaining="$(cat "$FAKE_DOCKER_FAIL_START")"
      if test "$remaining" -gt 0; then printf '%s\n' "$((remaining - 1))" > "$FAKE_DOCKER_FAIL_START"; exit 96; fi
    fi
    exit 0 ;;
  'stop cbs-mem0-qdrant'|'restart cbs-mem0-qdrant') exit 0 ;;
  *) exit 98 ;;
esac
DOCKER
chmod 700 "$scratch/bin/docker"
export PATH="$scratch/bin:$PATH"
export FAKE_DOCKER_LOG="$scratch/docker.log" FAKE_DOCKER_STATE="$scratch/state.json" FAKE_DOCKER_OWNED="$scratch/owned.json"
export FAKE_DOCKER_FAIL_RUN="$scratch/fail-run" FAKE_DOCKER_FAIL_START="$scratch/fail-start"
export QDRANT_API_KEY_FILE="$scratch/key" QDRANT_DATA_DIR="$scratch/data" QDRANT_BIND_IP=127.0.0.1
: > "$FAKE_DOCKER_LOG"

python3 - "$scratch" "$(id -u):$(id -g)" <<'PY'
import json, pathlib, sys
root, user = pathlib.Path(sys.argv[1]), sys.argv[2]
data = root / 'data'
image = 'qdrant/qdrant@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10'
owned = {'Config': {'Labels': {'cbs.mem0.installer': '1', 'cbs.mem0.data': str(data),
                               'cbs.mem0.bind': '127.0.0.1', 'cbs.mem0.tls': '0'}, 'Image': image, 'User': user,
                    'Entrypoint': ['/qdrant/qdrant'], 'Cmd': ['--config-path', '/qdrant/config/cbs.yaml']},
         'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'},
                        'PortBindings': {'6333/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '6333'}]}},
         'Mounts': [{'Source': str(data / 'storage'), 'Destination': '/qdrant/storage', 'RW': True},
                    {'Source': str(data / 'snapshots'), 'Destination': '/qdrant/snapshots', 'RW': True},
                    {'Source': str(data / '.cbs-qdrant.yaml'), 'Destination': '/qdrant/config/cbs.yaml', 'RW': False}],
         'State': {'Running': True}}
(root / 'owned.json').write_text(json.dumps(owned))
PY

expect_reject() {
  local label="$1" expected="$2" output status before after
  before="$(wc -l < "$FAKE_DOCKER_LOG" 2>/dev/null || printf 0)"
  set +e
  output="$(bash "$script" 2>&1)"
  status=$?
  set -e
  after="$(wc -l < "$FAKE_DOCKER_LOG" 2>/dev/null || printf 0)"
  if test "$status" -eq 0 || [[ "$output" != *"$expected"* ]] || test "$before" -ne "$after"; then
    printf 'FAIL %s: status=%s output=%s docker calls=%s->%s\n' "$label" "$status" "$output" "$before" "$after" >&2
    exit 1
  fi
}

QDRANT_API_KEY_FILE="$scratch/missing" expect_reject 'missing key before Docker' QDRANT_API_KEY_FILE
QDRANT_BIND_IP=0.0.0.0 expect_reject 'wide bind before Docker' QDRANT_BIND_IP
QDRANT_BIND_IP=8.8.8.8 expect_reject 'public bind before Docker' QDRANT_BIND_IP
QDRANT_BIND_IP=10.0.0.1 expect_reject 'private bind needs TLS before Docker' QDRANT_TLS_CERT_FILE
ln -s "$scratch/key" "$scratch/key-link"
QDRANT_API_KEY_FILE="$scratch/key-link" expect_reject 'symlink key before Docker' QDRANT_API_KEY_FILE
ln "$scratch/key" "$scratch/key-hardlink"
expect_reject 'hardlinked key before Docker' QDRANT_API_KEY_FILE
rm "$scratch/key-hardlink"
chmod 644 "$scratch/key"
expect_reject 'key mode before Docker' QDRANT_API_KEY_FILE
chmod 600 "$scratch/key"
chmod 755 "$scratch/data"
expect_reject 'data mode before Docker' QDRANT_DATA_DIR
chmod 700 "$scratch/data"
ln -s "$scratch/data" "$scratch/data-link"
QDRANT_DATA_DIR="$scratch/data-link" expect_reject 'symlink data before Docker' QDRANT_DATA_DIR

printf 'foreign data\n' > "$scratch/data/marker-before-install"
set +e
output="$(bash "$script" 2>&1)"
status=$?
set -e
test "$status" -ne 0
[[ "$output" == *'unknown data'* ]]
! rg -q '^run ' "$FAKE_DOCKER_LOG"
rm "$scratch/data/marker-before-install"

cp "$scratch/owned.json" "$scratch/state.json"
python3 - "$scratch/state.json" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1]); state = json.loads(p.read_text())
state['Config']['Labels']['cbs.mem0.installer'] = 'foreign'
p.write_text(json.dumps(state))
PY
set +e
output="$(bash "$script" 2>&1)"
status=$?
set -e
test "$status" -ne 0
[[ "$output" == *'foreign'* ]]
! rg -q '^run ' "$FAKE_DOCKER_LOG"
rm "$scratch/state.json"

: > "$FAKE_DOCKER_FAIL_RUN"
set +e
output="$(bash "$script" 2>&1)"
status=$?
set -e
test "$status" -ne 0
test ! -f "$scratch/state.json"
printf 'marker\n' > "$scratch/data/storage/marker"
printf 'foreign\n' > "$scratch/data/unknown"
set +e
output="$(bash "$script" 2>&1)"
status=$?
set -e
test "$status" -ne 0
[[ "$output" == *'unknown data'* ]]
rm "$scratch/data/unknown"
printf 'wrong-synthetic-key\n' > "$scratch/key"
set +e
output="$(bash "$script" 2>&1)"
status=$?
set -e
test "$status" -ne 0
[[ "$output" == *'bootstrap identity drift'* ]]
printf 'synthetic-test-key\n' > "$scratch/key"
bash "$script" > "$scratch/output"
test -f "$scratch/state.json"
bash "$script" >> "$scratch/output"
test "$(cat "$scratch/data/storage/marker")" = marker
test "$(rg -c '^run ' "$FAKE_DOCKER_LOG")" = 2
! rg -q '^start |^stop |^restart ' "$FAKE_DOCKER_LOG"
! rg -q 'synthetic-test-key' "$scratch/docker.log" "$scratch/output"
test "$(stat -c %a "$scratch/data/.cbs-qdrant.yaml")" = 600
test "$(stat -c %u "$scratch/data/.cbs-qdrant.yaml")" = "$(id -u)"

printf 'rotated-synthetic-key\n' > "$scratch/key"
set +e
output="$(bash "$script" 2>&1)"
status=$?
set -e
test "$status" -ne 0
[[ "$output" == *'rotation'* ]]
! rg -q 'rotated-synthetic-key' "$scratch/docker.log" "$scratch/output"
QDRANT_ROTATE_KEY=1 bash "$script" >> "$scratch/output"
test "$(cat "$scratch/data/storage/marker")" = marker
test "$(rg -c '^stop ' "$FAKE_DOCKER_LOG")" = 1
test "$(rg -c '^start ' "$FAKE_DOCKER_LOG")" = 1
! rg -q 'synthetic-test-key|rotated-synthetic-key' "$scratch/docker.log" "$scratch/output"

printf 'third-synthetic-key\n' > "$scratch/key"
config_inode="$(stat -c %i "$scratch/data/.cbs-qdrant.yaml")"
printf '2\n' > "$FAKE_DOCKER_FAIL_START"
set +e
output="$(QDRANT_ROTATE_KEY=1 bash "$script" 2>&1)"
status=$?
set -e
test "$status" -ne 0
rg -q 'rotated-synthetic-key' "$scratch/data/.cbs-qdrant.yaml"
test -f "$scratch/data/.cbs-qdrant.rotation.json"
test "$(cat "$scratch/data/storage/marker")" = marker
test "$(rg -c '^start ' "$FAKE_DOCKER_LOG")" = 3
! rg -q 'third-synthetic-key' "$scratch/docker.log" "$scratch/output" "$scratch/data/.cbs-qdrant.yaml"
printf 'rotated-synthetic-key\n' > "$scratch/key"
set +e
output="$(bash "$script" 2>&1)"
status=$?
set -e
test "$status" -ne 0
[[ "$output" == *'prior config restored'* ]]
test ! -e "$scratch/data/.cbs-qdrant.rotation.json"
test "$(stat -c %i "$scratch/data/.cbs-qdrant.yaml")" = "$config_inode"
bash "$script" >> "$scratch/output"

python3 - "$scratch/state.json" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1]); state = json.loads(p.read_text())
state['Config']['Image'] = 'qdrant/qdrant:unapproved'
p.write_text(json.dumps(state))
PY
set +e
output="$(bash "$script" 2>&1)"
status=$?
set -e
test "$status" -ne 0
[[ "$output" == *'drift'* ]]
test "$(rg -c '^run ' "$FAKE_DOCKER_LOG")" = 2

mkdir -m 700 "$scratch/tlsdata"
printf 'fixture cert\n' > "$scratch/cert.pem"
printf 'fixture key\n' > "$scratch/tlskey.pem"
chmod 600 "$scratch/cert.pem" "$scratch/tlskey.pem"
python3 - "$scratch/owned.json" "$scratch/tlsowned.json" "$scratch/tlsdata" "$scratch/cert.pem" "$scratch/tlskey.pem" <<'PY'
import json, pathlib, sys
source, target, data, cert, key = sys.argv[1:]
state = json.loads(pathlib.Path(source).read_text())
state['Config']['Labels'].update({'cbs.mem0.data': data, 'cbs.mem0.bind': '10.0.0.1', 'cbs.mem0.tls': '1'})
state['HostConfig']['PortBindings']['6333/tcp'][0]['HostIp'] = '10.0.0.1'
for mount in state['Mounts']:
    mount['Source'] = mount['Source'].replace(str(pathlib.Path(source).parent / 'data'), data)
state['Mounts'] += [{'Source': cert, 'Destination': '/qdrant/config/cbs-cert.pem', 'RW': False},
                    {'Source': key, 'Destination': '/qdrant/config/cbs-key.pem', 'RW': False}]
pathlib.Path(target).write_text(json.dumps(state))
PY
export FAKE_DOCKER_STATE="$scratch/tlsstate.json" FAKE_DOCKER_OWNED="$scratch/tlsowned.json"
QDRANT_DATA_DIR="$scratch/tlsdata" QDRANT_BIND_IP=10.0.0.1 \
QDRANT_TLS_CERT_FILE="$scratch/cert.pem" QDRANT_TLS_KEY_FILE="$scratch/tlskey.pem" \
bash "$script" >> "$scratch/output"
test -f "$scratch/tlsstate.json"
rg -q 'enable_tls: true' "$scratch/tlsdata/.cbs-qdrant.yaml"
! rg -q 'synthetic-test-key|rotated-synthetic-key' "$scratch/docker.log" "$scratch/output"
printf 'PASS invalid inputs before Docker, foreign/drift refusal, idempotence, rotation, TLS, secret isolation\n'
