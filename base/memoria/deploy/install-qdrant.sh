#!/usr/bin/env bash
set -euo pipefail
set +x

name=cbs-mem0-qdrant
image=qdrant/qdrant@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10
config=/qdrant/config/cbs.yaml
candidate=
trap 'if [[ -n "$candidate" ]]; then rm -f -- "$candidate"; fi' EXIT

for variable in QDRANT_API_KEY_FILE QDRANT_DATA_DIR QDRANT_BIND_IP; do
  if [[ -z "${!variable:-}" ]]; then printf '%s is required\n' "$variable" >&2; exit 2; fi
done
if [[ "${QDRANT_ROTATE_KEY:-0}" != 0 && "${QDRANT_ROTATE_KEY:-0}" != 1 ]]; then
  printf 'QDRANT_ROTATE_KEY must be 0 or 1\n' >&2; exit 2
fi

candidate="$(python3 - "$QDRANT_API_KEY_FILE" "$QDRANT_DATA_DIR" "$QDRANT_BIND_IP" \
  "${QDRANT_TLS_CERT_FILE:-}" "${QDRANT_TLS_KEY_FILE:-}" <<'PY'
import ipaddress, json, os, pathlib, stat, sys, tempfile
key_path, data_path = map(pathlib.Path, sys.argv[1:3])
bind_ip, cert_name, tls_key_name = sys.argv[3:6]

def fail(name):
    raise ValueError(name + ' is unsafe or invalid')

try:
    if not key_path.is_absolute() or not key_path.exists() or key_path.is_symlink():
        fail('QDRANT_API_KEY_FILE')
    for component in key_path.parents:
        if component.is_symlink() or (component / '.git').exists():
            fail('QDRANT_API_KEY_FILE')
    key_stat = key_path.lstat()
    if not stat.S_ISREG(key_stat.st_mode) or stat.S_IMODE(key_stat.st_mode) != 0o600 or key_stat.st_uid != os.geteuid() or key_stat.st_nlink != 1:
        fail('QDRANT_API_KEY_FILE')
    key_bytes = key_path.read_bytes()
    if key_bytes.endswith(b'\n'):
        key_bytes = key_bytes[:-1]
    if not key_bytes or any(byte < 33 or byte > 126 for byte in key_bytes):
        fail('QDRANT_API_KEY_FILE')
    key = key_bytes.decode('ascii')

    if not data_path.is_absolute() or str(data_path) != sys.argv[2] or \
            os.path.realpath(data_path) != str(data_path) or \
            any(char in str(data_path) for char in '\n\r,:'):
        fail('QDRANT_DATA_DIR')
    for component in (data_path, *data_path.parents):
        if component.is_symlink() or (component / '.git').exists():
            fail('QDRANT_DATA_DIR')
    data_stat = data_path.lstat()
    if not stat.S_ISDIR(data_stat.st_mode) or stat.S_IMODE(data_stat.st_mode) != 0o700 or data_stat.st_uid != os.geteuid():
        fail('QDRANT_DATA_DIR')

    try:
        ip = ipaddress.ip_address(bind_ip)
    except ValueError:
        fail('QDRANT_BIND_IP')
    allowed = [ipaddress.ip_network(net) for net in ('127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7')]
    if not any(ip in network for network in allowed):
        fail('QDRANT_BIND_IP')
    if bool(cert_name) != bool(tls_key_name) or (not ip.is_loopback and not cert_name):
        fail('QDRANT_TLS_CERT_FILE/QDRANT_TLS_KEY_FILE')
    if cert_name:
        for name, value in (('QDRANT_TLS_CERT_FILE', cert_name), ('QDRANT_TLS_KEY_FILE', tls_key_name)):
            source = pathlib.Path(value)
            if not source.is_absolute() or source.is_symlink() or any(char in value for char in '\n\r,'):
                fail(name)
            for component in source.parents:
                if component.is_symlink() or (component / '.git').exists():
                    fail(name)
            source_stat = source.lstat()
            if not stat.S_ISREG(source_stat.st_mode) or stat.S_IMODE(source_stat.st_mode) != 0o600 or \
                    source_stat.st_uid != os.geteuid() or source_stat.st_nlink != 1:
                fail(name)

    content = ('service:\n  host: "0.0.0.0"\n  http_port: 6333\n  grpc_port: null\n  api_key: ' +
               json.dumps(key) + '\n')
    if cert_name:
        content += ('  enable_tls: true\ntls:\n  cert: "/qdrant/config/cbs-cert.pem"\n' +
                    '  key: "/qdrant/config/cbs-key.pem"\n')
    content += ('storage:\n  storage_path: "/qdrant/storage"\n' +
                '  snapshots_path: "/qdrant/snapshots"\n')
    fd, temp = tempfile.mkstemp(prefix='.cbs-qdrant.', dir=data_path)
    try:
        with os.fdopen(fd, 'w', encoding='ascii') as stream:
            stream.write(content)
    except BaseException:
        os.unlink(temp)
        raise
    print(temp)
except (OSError, ValueError, UnicodeError):
    name = sys.exc_info()[1]
    if isinstance(name, ValueError):
        print(str(name), file=sys.stderr)
    else:
        print('QDRANT_API_KEY_FILE or QDRANT_DATA_DIR is unsafe or invalid', file=sys.stderr)
    sys.exit(2)
PY
)" || exit 2
tls_enabled=0
if [[ -n "${QDRANT_TLS_CERT_FILE:-}" ]]; then tls_enabled=1; fi

if ! command -v docker >/dev/null 2>&1; then printf 'Docker is required\n' >&2; exit 1; fi
if ! docker info --format '{{.ServerVersion}}' >/dev/null; then printf 'Docker daemon unavailable\n' >&2; exit 1; fi

inspect="$(docker container inspect "$name" --format '{{json .}}' 2>/dev/null)" || inspect=
if [[ -n "$inspect" ]]; then
  if ! python3 -c '
import json, os, sys
item = json.load(sys.stdin)
data, bind, image, user, tls, cert, tls_key = sys.argv[1:]
labels = item.get("Config", {}).get("Labels") or {}
if labels.get("cbs.mem0.installer") != "1":
    print("foreign container: refuse", file=sys.stderr); sys.exit(3)
expected = {"cbs.mem0.data": data, "cbs.mem0.bind": bind, "cbs.mem0.tls": tls}
mounts = {(m.get("Destination"), m.get("Source"), m.get("RW")) for m in item.get("Mounts", [])}
required = {(dest, source, rw) for dest, source, rw in (
    ("/qdrant/storage", data + "/storage", True),
    ("/qdrant/snapshots", data + "/snapshots", True),
    ("/qdrant/config/cbs.yaml", data + "/.cbs-qdrant.yaml", False))}
if tls == "1":
    required |= {("/qdrant/config/cbs-cert.pem", cert, False), ("/qdrant/config/cbs-key.pem", tls_key, False)}
cfg = item.get("Config", {})
host = item.get("HostConfig", {})
if (any(labels.get(k) != v for k, v in expected.items()) or cfg.get("Image") != image or
    cfg.get("User") != user or cfg.get("Entrypoint") != ["/qdrant/qdrant"] or
    cfg.get("Cmd") != ["--config-path", "/qdrant/config/cbs.yaml"] or
    host.get("RestartPolicy", {}).get("Name") != "unless-stopped" or
    host.get("PortBindings", {}).get("6333/tcp") != [{"HostIp": bind, "HostPort": "6333"}] or
    mounts != required):
    print("owned container drift: refuse", file=sys.stderr); sys.exit(4)
' "$QDRANT_DATA_DIR" "$QDRANT_BIND_IP" "$image" "$(id -u):$(id -g)" \
    "$tls_enabled" "${QDRANT_TLS_CERT_FILE:-}" "${QDRANT_TLS_KEY_FILE:-}" <<<"$inspect"; then
    exit 1
  fi
  existing_config="$QDRANT_DATA_DIR/.cbs-qdrant.yaml"
  if ! python3 - "$existing_config" <<'PY'
import os, pathlib, stat, sys
p = pathlib.Path(sys.argv[1])
try:
    s = p.lstat()
    assert stat.S_ISREG(s.st_mode) and stat.S_IMODE(s.st_mode) == 0o600
    assert s.st_uid == os.geteuid() and s.st_nlink == 1
except (AssertionError, OSError):
    print('owned config unsafe: refuse', file=sys.stderr)
    sys.exit(1)
PY
  then exit 1; fi
  if [[ "${QDRANT_ROTATE_KEY:-0}" == 1 ]]; then
    docker stop "$name" >/dev/null
    cat "$candidate" > "$existing_config"
    docker start "$name" >/dev/null
    printf 'Qdrant credential rotation requested; owned container restarted\n'
    exit 0
  fi
  if ! cmp -s -- "$candidate" "$existing_config"; then
    printf 'Qdrant config or key changed; request an owned rotation explicitly\n' >&2; exit 1
  fi
  if python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["State"]["Running"] else 1)' <<<"$inspect"; then
    printf 'Qdrant owned container already running; data retained\n'
  else
    docker start "$name" >/dev/null
    printf 'Qdrant owned container started; data retained\n'
  fi
  exit 0
fi

if [[ -n "$(find "$QDRANT_DATA_DIR" -mindepth 1 -maxdepth 1 ! -name "$(basename "$candidate")" -print -quit)" ]]; then
  printf 'QDRANT_DATA_DIR contains unknown data; refuse\n' >&2; exit 1
fi
mkdir -m 700 "$QDRANT_DATA_DIR/storage" "$QDRANT_DATA_DIR/snapshots"
mv -- "$candidate" "$QDRANT_DATA_DIR/.cbs-qdrant.yaml"
candidate=
publish="$QDRANT_BIND_IP:6333:6333"
if [[ "$QDRANT_BIND_IP" == *:* ]]; then publish="[$QDRANT_BIND_IP]:6333:6333"; fi
tls_mounts=()
if [[ "$tls_enabled" == 1 ]]; then
  tls_mounts+=(--mount "type=bind,src=$QDRANT_TLS_CERT_FILE,dst=/qdrant/config/cbs-cert.pem,readonly")
  tls_mounts+=(--mount "type=bind,src=$QDRANT_TLS_KEY_FILE,dst=/qdrant/config/cbs-key.pem,readonly")
fi
docker run -d --name "$name" \
  --label cbs.mem0.installer=1 \
  --label "cbs.mem0.data=$QDRANT_DATA_DIR" \
  --label "cbs.mem0.bind=$QDRANT_BIND_IP" \
  --label "cbs.mem0.tls=$tls_enabled" \
  --restart unless-stopped --user "$(id -u):$(id -g)" \
  --workdir /qdrant/storage --entrypoint /qdrant/qdrant \
  --publish "$publish" \
  --mount "type=bind,src=$QDRANT_DATA_DIR/storage,dst=/qdrant/storage" \
  --mount "type=bind,src=$QDRANT_DATA_DIR/snapshots,dst=/qdrant/snapshots" \
  --mount "type=bind,src=$QDRANT_DATA_DIR/.cbs-qdrant.yaml,dst=$config,readonly" \
  "${tls_mounts[@]}" \
  "$image" --config-path "$config" >/dev/null
printf 'Qdrant owned container created with persistent data\n'
