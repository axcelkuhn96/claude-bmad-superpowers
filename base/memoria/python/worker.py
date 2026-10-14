"""Serialized local encoder. Only the E5 instance survives between framed operations."""

import json
import os
from pathlib import Path
import struct
import sys

os.environ['OMP_NUM_THREADS'] = '2'
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
os.environ['MEM0_TELEMETRY'] = '0'
for key in ('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT'):
    os.environ.pop(key, None)

import mem0_adapter as adapter
from qdrant_client import QdrantClient

MAX_JSON = 4 * 1024 * 1024
MAX_SECRET = 8 * 1024
MAX_RESPONSE = 2 * 1024 * 1024


def exact(length):
    chunks = bytearray()
    while len(chunks) < length:
        part = sys.stdin.buffer.read(length - len(chunks))
        if not part:
            raise EOFError('partial')
        chunks.extend(part)
    return chunks


def send(value):
    body = json.dumps(value, ensure_ascii=False).encode('utf-8')
    if len(body) > MAX_RESPONSE:
        body = b'{"kind":"blocked","reason":"response_oversized"}'
    sys.stdout.buffer.write(b'M0BR\x01' + struct.pack('>I', len(body)) + body)
    sys.stdout.buffer.flush()


def execute_one(request, secret):
    if not secret or request.get('op') not in ('search', 'find', 'read', 'add', 'activate',
                                               'raw_search', 'readonly_get'):
        return {'kind': 'blocked', 'reason': 'invalid_operation'}
    state = Path(request['state']).resolve()
    os.environ['MEM0_DIR'] = str(state / 'mem0')
    connection = request['connection']
    transport = adapter.PinnedTransport(connection)
    client = None
    try:
        client = QdrantClient(url=connection['url'], api_key=secret.decode('utf-8'),
                              transport=transport, trust_env=False, follow_redirects=False,
                              prefer_grpc=False, check_compatibility=False)
        if request['op'] in ('raw_search', 'readonly_get'):
            return adapter.execute_readonly(request, client, state)
        return adapter.execute(request, client, state)
    finally:
        if client is not None:
            client.close()
        else:
            transport.close()


def main():
    adapter._WARM_EMBEDDER = adapter.E5Embedder()
    send({'kind': 'ready', 'fingerprint': adapter.FINGERPRINT})
    while True:
        header = sys.stdin.buffer.read(13)
        if not header:
            return 0
        if len(header) != 13 or header[:5] != b'M0BW\x01':
            return 2
        json_length, secret_length = struct.unpack('>II', header[5:])
        if json_length > MAX_JSON or secret_length > MAX_SECRET:
            return 2
        try:
            request = json.loads(exact(json_length).decode('utf-8'))
            secret = exact(secret_length)
            result = execute_one(request, secret)
        except (ValueError, KeyError, RuntimeError, OSError, EOFError):
            result = {'kind': 'blocked', 'reason': 'worker_operation_failed'}
        finally:
            if 'secret' in locals():
                secret[:] = b'\x00' * len(secret)
                del secret
        send(result)


if __name__ == '__main__':
    raise SystemExit(main())
