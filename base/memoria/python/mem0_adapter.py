"""One authorized CBS operation per process, using the local Mem0 SDK."""

import hashlib
import ipaddress
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import ssl
import sys
from urllib.parse import urlsplit

import httpx

MODEL_SHA256 = ('ca456c06b3a9505ddfd9131408916d'
                'd79290368331e7d76bb621f1cba6bc8665')
TOKENIZER_SHA256 = ('0b44a9d7b51c3c62626640cda0e2c'
                    '2f70fdacdc25bbbd68038369d14ebdf4c39')
FINGERPRINT = f'{MODEL_SHA256}:{TOKENIZER_SHA256}'


class PinnedTransport(httpx.BaseTransport):
    def __init__(self, connection: dict):
        target = urlsplit(connection['url'])
        port = target.port or (443 if target.scheme == 'https' else 80)
        if target.scheme not in ('https', 'http') or target.hostname != connection['hostname'] or port != connection['port'] or \
                target.path != '/' or target.query or target.fragment or connection.get('protocol') != target.scheme + ':':
            raise ValueError('destination mismatch')
        if connection['servername'] != target.hostname or target.username or target.password:
            raise ValueError('destination mismatch')
        address = ipaddress.ip_address(connection['address'])
        if address.version != 4 or not (address.is_loopback or address in ipaddress.ip_network('10.0.0.0/8') or
            address in ipaddress.ip_network('172.16.0.0/12') or address in ipaddress.ip_network('192.168.0.0/16')):
            raise ValueError('destination is not private IPv4')
        if target.scheme == 'http' and connection['address'] != '127.0.0.1':
            raise ValueError('plaintext destination denied')
        self.connection = connection
        ca = os.environ.get('CBS_MEMORIA_CA_FILE')
        context = ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()
        self.inner = httpx.HTTPTransport(verify=context, trust_env=False, retries=0)

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        target = urlsplit(self.connection['url'])
        port = target.port or (443 if target.scheme == 'https' else 80)
        request_port = request.url.port or (443 if request.url.scheme == 'https' else 80)
        if (request.url.scheme, request.url.host, request_port) != (target.scheme, target.hostname, port):
            raise ValueError('unexpected destination')
        expected_host = f'{target.hostname}:{target.port}' if target.port else target.hostname
        if request.headers.get('host') != expected_host:
            raise ValueError('unexpected Host')
        pinned = httpx.Request(request.method, request.url.copy_with(host=self.connection['address']),
                               headers=request.headers, stream=request.stream,
                               extensions={**request.extensions, 'sni_hostname': target.hostname})
        response = self.inner.handle_request(pinned)
        if 300 <= response.status_code < 400:
            response.close()
            raise ValueError('redirect denied')
        return response

    def close(self) -> None:
        self.inner.close()


def _digest(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


class NoGenerateLLM:
    calls = 0

    def __init__(self, config=None):
        self.config = {'enable_vision': False}

    def generate_response(self, *args, **kwargs):
        type(self).calls += 1
        raise RuntimeError('secondary_llm_denied')


class E5Embedder:
    def __init__(self, config=None):
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.np = np
        model = Path(os.environ['CBS_MEMORIA_MODEL'])
        tokenizer = Path(os.environ['CBS_MEMORIA_TOKENIZER'])
        if _digest(model) != MODEL_SHA256 or _digest(tokenizer) != TOKENIZER_SHA256:
            raise ValueError('embedding_fingerprint_mismatch')
        self.tokenizer = Tokenizer.from_file(str(tokenizer))
        self.tokenizer.enable_truncation(max_length=512)
        self.session = ort.InferenceSession(str(model), providers=['CPUExecutionProvider'])
        self.input_names = {item.name for item in self.session.get_inputs()}

    def embed(self, text: str, memory_action: str = 'add') -> list[float]:
        if memory_action not in ('add', 'update', 'search'):
            raise ValueError('embedding_action_invalid')
        prefix = 'query: ' if memory_action == 'search' else 'passage: '
        encoded = self.tokenizer.encode(prefix + text)
        ids = self.np.asarray([encoded.ids], dtype=self.np.int64)
        mask = self.np.asarray([encoded.attention_mask], dtype=self.np.int64)
        values = {'input_ids': ids, 'attention_mask': mask, 'token_type_ids': self.np.zeros_like(ids)}
        output = self.session.run(None, {key: values[key] for key in self.input_names})[0]
        pooled = (output * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1)[:, None]
        norm = self.np.linalg.norm(pooled, axis=1, keepdims=True)
        if not self.np.isfinite(norm).all() or norm[0, 0] == 0 or pooled.shape[-1] != 384:
            raise ValueError('embedding_invalid')
        return (pooled / norm)[0].astype('float32').tolist()


def verify_collection(client, collection: str, fingerprint: str) -> None:
    info = client.get_collection(collection)
    vectors = info.config.params.vectors
    dimension = vectors.size if hasattr(vectors, 'size') else None
    metadata = info.config.metadata or {}
    if dimension != 384 or str(vectors.distance) not in ('Cosine', 'Distance.COSINE') or \
            metadata.get('cbs_embedding_fingerprint') != fingerprint:
        raise ValueError('collection_fingerprint_mismatch')


def _time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamp_without_timezone')
    return parsed


def _memory(client, collection: str, state: Path, connection: dict):
    from mem0.configs.base import MemoryConfig
    from mem0.configs.llms.base import BaseLlmConfig
    from mem0.memory.main import Memory
    from mem0.utils.factory import EmbedderFactory, LlmFactory, VectorStoreFactory
    from mem0.vector_stores.qdrant import Qdrant

    class ExistingQdrant(Qdrant):
        def create_col(self, vector_size, on_disk, distance=None):
            verify_collection(self.client, self.collection_name, FINGERPRINT)
            self._has_bm25_slot = False

    EmbedderFactory.provider_to_class['ollama'] = 'mem0_adapter.E5Embedder'
    sys.modules['mem0_adapter'] = sys.modules[__name__]
    LlmFactory.provider_to_class['ollama'] = ('mem0_adapter.NoGenerateLLM', BaseLlmConfig)
    VectorStoreFactory.provider_to_class['qdrant'] = 'mem0_adapter.ExistingQdrant'
    globals()['ExistingQdrant'] = ExistingQdrant
    config = MemoryConfig(
        vector_store={'provider': 'qdrant', 'config': {'client': client, 'host': connection['hostname'],
            'port': connection['port'], 'path': None, 'collection_name': collection, 'embedding_model_dims': 384}},
        embedder={'provider': 'ollama', 'config': {'model': 'multilingual-e5-small', 'embedding_dims': 384}},
        llm={'provider': 'ollama', 'config': {}},
        history_db_path=str(state / 'mem0' / 'history.db'),
    )
    return Memory(config)


def _row(raw: dict | None, client, collection: str, embedder) -> dict | None:
    if raw is None:
        return None
    metadata = raw.get('metadata') or {}
    identifier = raw['id']
    points = client.retrieve(collection, ids=[identifier], with_payload=True, with_vectors=True)
    if 'expiration_date' in raw or 'expiration_date' in metadata or \
            (points and 'expiration_date' in (points[0].payload or {})):
        raise ValueError('remote_expiration_unsupported')
    if len(points) != 1 or points[0].id != identifier or not isinstance(points[0].vector, list) or len(points[0].vector) != 384:
        raise ValueError('remote_vector_unverified')
    if not all(math.isfinite(value) for value in points[0].vector):
        raise ValueError('remote_vector_invalid')
    expected = embedder.embed(raw.get('memory', ''), 'add')
    if len(expected) != 384 or not all(math.isclose(actual, wanted, rel_tol=1e-4, abs_tol=1e-4)
                                      for actual, wanted in zip(points[0].vector, expected)):
        raise ValueError('remote_vector_unverified')
    payload = points[0].payload or {}
    if payload.get('data') != raw.get('memory') or payload.get('user_id') != raw.get('user_id') or \
            payload.get('project_id') != raw.get('user_id') or payload.get('status') != metadata.get('status') or \
            payload.get('source_record_id') != metadata.get('source_record_id'):
        raise ValueError('remote_payload_unverified')
    return {'sdkId': identifier, 'qdrantId': str(points[0].id), 'externalId': metadata.get('source_record_id'),
            'projectId': raw.get('user_id'), 'status': metadata.get('status'), 'text': raw.get('memory'),
            'metadata': metadata, 'sessionId': raw.get('run_id')}


def _find(memory, client, collection: str, project: str, external: str) -> list[dict]:
    limit = 64
    while limit <= 2048:
        rows = memory.get_all(filters={'user_id': project, 'source_record_id': external},
                              top_k=limit, show_expired=True)['results']
        if len(rows) < limit:
            return [_row(row, client, collection, memory.embedding_model) for row in rows]
        limit *= 2
    raise ValueError('remote_inventory_saturated')


def execute(request: dict, client, state: Path) -> dict:
    collection = request['collection']
    project = request['projectId']
    external = request.get('externalId')
    if not isinstance(project, str) or not project or not isinstance(collection, str) or not collection:
        raise ValueError('invalid_identity')
    verify_collection(client, collection, FINGERPRINT)
    memory = _memory(client, collection, state, request['connection'])
    op = request['op']
    if op == 'find':
        return {'kind': 'items', 'items': _find(memory, client, collection, project, external)}
    if op == 'read':
        row = _row(memory.get(request['sdkId']), client, collection, memory.embedding_model)
        if row is not None and row['projectId'] != project:
            raise ValueError('project_mismatch')
        return {'kind': 'item', 'item': row}
    if op == 'add':
        metadata = request['metadata']
        if any(key in metadata for key in ('status', 'source_record_id', 'project_id', 'expiration_date')):
            raise ValueError('reserved_metadata')
        if metadata.get('scope') not in ('project', 'personal') or \
                (metadata.get('scope') == 'personal' and not metadata.get('owner_id')):
            raise ValueError('scope_invalid')
        if not all(metadata.get(field) for field in ('source', 'actor', 'origin', 'evidence_at')):
            raise ValueError('provenance_incomplete')
        _time(metadata['evidence_at'])
        if metadata.get('valid_from'):
            _time(metadata['valid_from'])
        if metadata.get('valid_to'):
            _time(metadata['valid_to'])
        metadata = {**metadata, 'status': 'pending', 'source_record_id': external, 'project_id': project}
        result = memory.add(request['text'], user_id=project, run_id=request['sessionId'],
                            metadata=metadata, infer=False)
        return {'kind': 'pending', 'sdkId': result['results'][0]['id']}
    if op == 'activate':
        identifier = request['sdkId']
        row = _row(memory.get(identifier), client, collection, memory.embedding_model)
        if row is None or row['projectId'] != project or row['externalId'] != external:
            raise ValueError('canonical_mismatch')
        if row['status'] == 'pending':
            supersedes = row['metadata'].get('supersedes_id')
            if supersedes:
                old = _row(memory.get(supersedes), client, collection, memory.embedding_model)
                if old is None or old['projectId'] != project or old['status'] not in ('active', 'superseded'):
                    raise ValueError('superseded_target_invalid')
                if old['status'] == 'active':
                    memory.update(supersedes, metadata={'status': 'superseded'})
                    old = _row(memory.get(supersedes), client, collection, memory.embedding_model)
                    if old['status'] != 'superseded':
                        raise ValueError('supersede_unverified')
            memory.update(identifier, metadata={'status': 'active'})
        return {'kind': 'item', 'item': _row(memory.get(identifier), client, collection, memory.embedding_model)}
    if op == 'search':
        now = datetime.now(timezone.utc)
        limit = 20
        while limit <= 2048:
            result = memory.search(request['query'], filters={'user_id': project, 'status': 'active'}, top_k=limit)
            items = [_row(row, client, collection, memory.embedding_model) for row in result['results']]
            eligible = [row for row in items if row['projectId'] == project and
                row['status'] == 'active' and row['metadata'].get('source') and row['metadata'].get('actor') and
                row['metadata'].get('scope') in ('project', 'personal') and
                (row['metadata']['scope'] == 'project' or (request.get('ownerId') and
                    row['metadata'].get('owner_id') == request['ownerId'])) and
                (not row['metadata'].get('valid_from') or _time(row['metadata']['valid_from']) <= now) and
                (not row['metadata'].get('valid_to') or now < _time(row['metadata']['valid_to']))]
            if len(eligible) >= 20 or len(result['results']) < limit:
                return {'kind': 'items', 'items': eligible[:20]}
            limit *= 2
        raise ValueError('remote_search_saturated')
    raise ValueError('unknown_operation')


def main() -> int:
    request = json.loads(sys.stdin.readline())
    state = Path(os.environ['CBS_MEMORIA_STATE']).resolve()
    os.environ['MEM0_DIR'] = str(state / 'mem0')
    os.environ['MEM0_TELEMETRY'] = '0'
    for name in ('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT'):
        os.environ.pop(name, None)
    from qdrant_client import QdrantClient
    connection = request['connection']
    transport = PinnedTransport(connection)
    client = None
    try:
        client = QdrantClient(url=connection['url'], api_key=os.environ['CBS_MEMORIA_API_KEY'],
                              transport=transport, trust_env=False, follow_redirects=False,
                              prefer_grpc=False, check_compatibility=False)
        result = execute(request, client, state)
    except (ValueError, KeyError, RuntimeError, OSError) as error:
        result = {'kind': 'blocked', 'reason': str(error).split(':')[0][:80]}
    finally:
        if client is not None:
            client.close()
        else:
            transport.close()
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
