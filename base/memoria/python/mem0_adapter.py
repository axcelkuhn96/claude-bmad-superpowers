"""One authorized CBS operation per process, using the local Mem0 SDK."""

import hashlib
import ipaddress
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import ssl
import sys
import unicodedata
import uuid
from urllib.parse import urlsplit

import httpx

MODEL_SHA256 = ('ca456c06b3a9505ddfd9131408916d'
                'd79290368331e7d76bb621f1cba6bc8665')
TOKENIZER_SHA256 = ('0b44a9d7b51c3c62626640cda0e2c'
                    '2f70fdacdc25bbbd68038369d14ebdf4c39')
FINGERPRINT = f'{MODEL_SHA256}:{TOKENIZER_SHA256}'
_WARM_EMBEDDER = None
# Conservative interim floor; Task7 calibrates it on frozen negative queries.
MIN_RECALL_SCORE = 0.85


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
        public = connection.get('allowPublic', False)
        if type(public) is not bool:
            raise ValueError('destination mode invalid')
        if public:
            labels = (target.hostname or '').split('.')
            special = (ipaddress.ip_network('192.0.0.0/24'),
                       ipaddress.ip_network('192.31.196.0/24'),
                       ipaddress.ip_network('192.52.193.0/24'),
                       ipaddress.ip_network('192.175.48.0/24'),
                       ipaddress.ip_network('192.88.99.0/24'))
            if (target.scheme != 'https' or address.version != 4 or not address.is_global or
                    address.is_multicast or address.is_reserved or address.is_unspecified or
                    any(address in network for network in special) or
                    len(labels) < 2 or len(target.hostname) > 253 or
                    re.fullmatch(r'(?:\d+\.){3}\d+', target.hostname) or
                    labels[-1] in ('localhost', 'local') or
                    any(len(label) > 63 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?', label)
                        for label in labels)):
                raise ValueError('public destination invalid')
        else:
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
        self.ort = ort
        self.model = Path(os.environ['CBS_MEMORIA_MODEL'])
        tokenizer = Path(os.environ['CBS_MEMORIA_TOKENIZER'])
        if _digest(self.model) != MODEL_SHA256 or _digest(tokenizer) != TOKENIZER_SHA256:
            raise ValueError('embedding_fingerprint_mismatch')
        self.tokenizer = Tokenizer.from_file(str(tokenizer))
        self.tokenizer.enable_truncation(max_length=512)
        device = os.environ.get('CBS_MEMORIA_EMBEDDING_DEVICE', 'auto').lower()
        if device not in ('auto', 'cpu', 'cuda', 'directml'):
            raise ValueError('embedding_device_invalid')
        available = set(ort.get_available_providers())
        candidates = []
        if device in ('auto', 'cuda') and 'CUDAExecutionProvider' in available:
            candidates.append('CUDAExecutionProvider')
        if (device == 'directml' or (device == 'auto' and sys.platform == 'win32')) and \
                'DmlExecutionProvider' in available:
            candidates.append('DmlExecutionProvider')
        self.fallback_reason = 'provider_unavailable' if device != 'cpu' and not candidates else None
        self.candidates = candidates + ['CPUExecutionProvider']
        self._open_session(0)

    def _open_session(self, start: int) -> None:
        for index in range(start, len(self.candidates)):
            provider = self.candidates[index]
            options = self.ort.SessionOptions()
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            options.execution_mode = self.ort.ExecutionMode.ORT_SEQUENTIAL
            options.add_session_config_entry('session.intra_op.allow_spinning', '0')
            options.add_session_config_entry('session.inter_op.allow_spinning', '0')
            if provider == 'DmlExecutionProvider':
                options.enable_mem_pattern = False
            providers = ['CPUExecutionProvider']
            if provider == 'CUDAExecutionProvider':
                providers.insert(0, ('CUDAExecutionProvider', {'use_tf32': '0'}))
            elif provider == 'DmlExecutionProvider':
                providers.insert(0, provider)
            try:
                if provider == 'CUDAExecutionProvider' and hasattr(self.ort, 'preload_dlls'):
                    self.ort.preload_dlls(cuda=True, cudnn=True, msvc=True, directory='')
                session = self.ort.InferenceSession(str(self.model), sess_options=options,
                                                    providers=providers)
                if provider != 'CPUExecutionProvider':
                    session.disable_fallback()
                    if session.get_providers()[0] != provider:
                        self.fallback_reason = 'provider_inactive'
                        continue
                input_names = {item.name for item in session.get_inputs()}
            except Exception:
                if provider == 'CPUExecutionProvider':
                    raise
                self.fallback_reason = 'provider_init_failed'
                continue
            self.session = session
            self.provider = provider
            self._candidate_index = index
            self.input_names = input_names
            return
        raise RuntimeError('embedding_provider_unavailable')

    def embed(self, text: str, memory_action: str = 'add') -> list[float]:
        if memory_action not in ('add', 'update', 'search'):
            raise ValueError('embedding_action_invalid')
        prefix = 'query: ' if memory_action == 'search' else 'passage: '
        encoded = self.tokenizer.encode(prefix + text)
        ids = self.np.asarray([encoded.ids], dtype=self.np.int64)
        mask = self.np.asarray([encoded.attention_mask], dtype=self.np.int64)
        values = {'input_ids': ids, 'attention_mask': mask, 'token_type_ids': self.np.zeros_like(ids)}
        while True:
            try:
                output = self.session.run(None, {key: values[key] for key in self.input_names})[0]
                break
            except Exception:
                if self.provider == 'CPUExecutionProvider':
                    raise
                self.fallback_reason = 'provider_run_failed'
                self._open_session(self._candidate_index + 1)
        pooled = (output * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1)[:, None]
        norm = self.np.linalg.norm(pooled, axis=1, keepdims=True)
        if not self.np.isfinite(norm).all() or norm[0, 0] == 0 or pooled.shape[-1] != 384:
            raise ValueError('embedding_invalid')
        return (pooled / norm)[0].astype('float32').tolist()


class WarmE5Embedder:
    def __init__(self, config=None):
        if _WARM_EMBEDDER is None:
            raise RuntimeError('encoder_unready')

    def embed(self, text: str, memory_action: str = 'add') -> list[float]:
        return _WARM_EMBEDDER.embed(text, memory_action)


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


def _memory(client, collection: str, state: Path, connection: dict, history_db_path: str | None = None):
    from mem0.configs.base import MemoryConfig
    from mem0.configs.llms.base import BaseLlmConfig
    from mem0.memory.main import Memory
    from mem0.utils.factory import EmbedderFactory, LlmFactory, VectorStoreFactory
    from mem0.vector_stores.qdrant import Qdrant

    class ExistingQdrant(Qdrant):
        def create_col(self, vector_size, on_disk, distance=None):
            verify_collection(self.client, self.collection_name, FINGERPRINT)
            self._has_bm25_slot = False

    EmbedderFactory.provider_to_class['ollama'] = ('mem0_adapter.WarmE5Embedder'
        if _WARM_EMBEDDER is not None else 'mem0_adapter.E5Embedder')
    sys.modules['mem0_adapter'] = sys.modules[__name__]
    LlmFactory.provider_to_class['ollama'] = ('mem0_adapter.NoGenerateLLM', BaseLlmConfig)
    VectorStoreFactory.provider_to_class['qdrant'] = 'mem0_adapter.ExistingQdrant'
    globals()['ExistingQdrant'] = ExistingQdrant
    config = MemoryConfig(
        vector_store={'provider': 'qdrant', 'config': {'client': client, 'host': connection['hostname'],
            'port': connection['port'], 'path': None, 'collection_name': collection, 'embedding_model_dims': 384}},
        embedder={'provider': 'ollama', 'config': {'model': 'multilingual-e5-small', 'embedding_dims': 384}},
        llm={'provider': 'ollama', 'config': {}},
        history_db_path=history_db_path if history_db_path is not None else str(state / 'mem0' / 'history.db'),
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
    if payload.get('context_generated') != metadata.get('context_generated'):
        raise ValueError('remote_context_unverified')
    if 'context_generated' in metadata and not _valid_generated_context(
            metadata['context_generated'], metadata.get('source_refs')):
        metadata = {key: value for key, value in metadata.items() if key != 'context_generated'}
    return {'sdkId': identifier, 'qdrantId': str(points[0].id), 'externalId': metadata.get('source_record_id'),
            'projectId': raw.get('user_id'), 'status': metadata.get('status'), 'text': raw.get('memory'),
            'metadata': metadata, 'sessionId': raw.get('run_id'),
            **({'score': raw['score']} if isinstance(raw.get('score'), (int, float)) and
               math.isfinite(raw['score']) and 0 <= raw['score'] <= 1 else {})}


def _find(memory, client, collection: str, project: str, external: str) -> list[dict]:
    limit = 64
    while limit <= 2048:
        rows = memory.get_all(filters={'user_id': project, 'source_record_id': external},
                              top_k=limit, show_expired=True)['results']
        if len(rows) < limit:
            return [_row(row, client, collection, memory.embedding_model) for row in rows]
        limit *= 2
    raise ValueError('remote_inventory_saturated')


def _dedup_key(project: str, metadata: dict, text: str) -> str:
    fields = [project, metadata.get('scope'), metadata.get('owner_id') or '',
              metadata.get('type'), text, metadata.get('condition') or '',
              metadata.get('valid_from') or '', metadata.get('valid_to') or '']
    if not all(isinstance(value, str) for value in fields) or \
            not all(fields[index] for index in (0, 1, 3, 4)):
        raise ValueError('invalid_dedup_claim')
    fields[4] = re.sub(r'[ \t\r\n]+', ' ', unicodedata.normalize('NFC', fields[4])).strip(' ')
    fields[5] = re.sub(r'[ \t\r\n]+', ' ', unicodedata.normalize('NFC', fields[5])).strip(' ')
    fields[4] = re.sub(r'[A-Z]', lambda match: match.group().lower(), fields[4])
    fields[5] = re.sub(r'[A-Z]', lambda match: match.group().lower(), fields[5])
    digest = hashlib.sha256(b'cbs-dedup-v1\x00')
    for field in fields:
        data = field.encode('utf-8')
        digest.update(str(len(data)).encode('ascii') + b':' + data)
    return digest.hexdigest()


def _find_duplicate(client, collection: str, request: dict) -> dict:
    """Exact metadata lookup; no semantic search or extra embedding."""
    from qdrant_client.models import FieldCondition, Filter, MatchValue
    metadata = request['metadata']
    project = request['projectId']
    key = metadata.get('dedup_key')
    if metadata.get('format_version') not in (4, 5) or \
            key != _dedup_key(project, metadata, request['text']):
        raise ValueError('dedup_key_mismatch')
    points, next_page = client.scroll(collection_name=collection,
        scroll_filter=Filter(must=[
            FieldCondition(key='project_id', match=MatchValue(value=project)),
            FieldCondition(key='dedup_key', match=MatchValue(value=key))]),
        limit=3, with_payload=True, with_vectors=False)
    if next_page is not None or len(points) > 2:
        raise ValueError('dedup_inventory_ambiguous')
    active = []
    pending = False
    for point in points:
        payload = point.payload or {}
        if payload.get('project_id') != project or payload.get('user_id') != project or \
                payload.get('dedup_key') != key or not isinstance(payload.get('data'), str) or \
                not isinstance(payload.get('source_record_id'), str) or \
                _dedup_key(project, payload, payload['data']) != key:
            raise ValueError('dedup_remote_mismatch')
        if payload['source_record_id'] == request.get('externalId'):
            continue  # Same source is reconciled by its existing external ID.
        if payload.get('status') == 'pending':
            pending = True
        elif payload.get('status') == 'active':
            try:
                identifier = str(uuid.UUID(str(point.id)))
            except (ValueError, TypeError, AttributeError):
                raise ValueError('dedup_remote_mismatch') from None
            active.append((identifier, payload))
    if len(active) != 1:
        if len(active) > 1:
            raise ValueError('dedup_inventory_ambiguous')
        return {'kind': 'pending', 'reason': 'duplicate_pending'} if pending else {'kind': 'clear'}
    identifier, payload = active[0]
    evidence = [project, payload.get('scope'), payload.get('owner_id') or '',
                payload.get('type'), payload['data'], payload.get('condition') or '',
                payload.get('valid_from') or '', payload.get('valid_to') or '',
                payload['source_record_id'], identifier, 'active']
    evidence_digest = hashlib.sha256(json.dumps(evidence, ensure_ascii=False,
        separators=(',', ':')).encode('utf-8')).hexdigest()
    return {'kind': 'duplicate', 'dedupKey': key, 'evidenceDigest': evidence_digest,
            'duplicateOf': {'externalId': payload['source_record_id'],
                            'sdkId': identifier, 'qdrantId': identifier, 'status': 'active',
                            'hasContext': _valid_generated_context(
                                payload.get('context_generated'), payload.get('source_refs'))}}


def _page(value: str, offset: int) -> dict:
    if type(offset) is not int or offset < 0 or offset > 16 * 1024 * 1024:
        raise ValueError('invalid_offset')
    data = value.encode('utf-8')
    if offset > len(data):
        raise ValueError('invalid_offset')
    end = min(len(data), offset + 8192)
    while end > offset:
        try:
            content = data[offset:end].decode('utf-8')
            break
        except UnicodeDecodeError:
            end -= 1
    else:
        raise ValueError('invalid_offset')
    return {'text': content, 'offset': offset,
            'nextOffset': end if end < len(data) else None, 'totalBytes': len(data)}


def _raw_collection(client, native: str) -> str | None:
    name = native + '_claude_mem_raw'
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', name):
        raise ValueError('invalid_raw_collection')
    if not client.collection_exists(name):
        return None
    verify_collection(client, name, FINGERPRINT)
    if (client.get_collection(name).config.metadata or {}).get('cbs_source') != 'claude-mem-raw-v1':
        raise ValueError('raw_collection_marker_mismatch')
    return name


def _raw_payload(payload: dict, collection: str, identifier) -> bool:
    try:
        anchor = str(uuid.UUID(str(payload.get('anchor_id'))))
        uuid.UUID(str(identifier))
    except (ValueError, TypeError, AttributeError):
        return False
    return payload.get('source') == 'claude-mem' and \
        payload.get('source_type') == 'imported_legacy' and \
        payload.get('origin') == 'assistant_report' and \
        payload.get('speaker_role') == 'assistant' and \
        payload.get('collection') == collection and \
        payload.get('embedding_fingerprint') == FINGERPRINT and \
        isinstance(payload.get('text'), str) and \
        payload.get('source_table') in ('observations', 'session_summaries') and \
        isinstance(payload.get('source_project'), str) and \
        isinstance(payload.get('source_id'), int) and \
        isinstance(payload.get('evidence_at'), str)


def _valid_generated_context(value, refs) -> bool:
    if not isinstance(value, dict) or set(value) != {'version', 'items', 'trust',
            'source_refs_sha256'} or type(value['version']) is not int or value['version'] != 1 or \
            value['trust'] != 'generated_unverified' or not isinstance(refs, list):
        return False
    digest = hashlib.sha256(json.dumps(refs, ensure_ascii=False, sort_keys=True,
        separators=(',', ':')).encode('utf-8')).hexdigest()
    ids = [ref.get('message_id') if isinstance(ref, dict) else None for ref in refs]
    if value['source_refs_sha256'] != digest or \
            any(not isinstance(identifier, str) or not identifier for identifier in ids) or \
            len(set(ids)) != len(ids):
        return False
    items = value['items']
    if not isinstance(items, list) or not 1 <= len(items) <= 4:
        return False
    secret = re.compile(r'["\']?\b(?:[A-Za-z][A-Za-z0-9_-]*[_-])?'
        r'(?:api[_ -]?key|private[_ -]?key|token|password|secret|bearer)'
        r'["\']?\s*[:= ]\s*\S+|\bsk-[a-z0-9-]{16,}|\bgh[opusr]_[A-Za-z0-9_]{16,}|'
        r'\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|'
        r'-----BEGIN [A-Z ]*PRIVATE KEY-----', re.I)
    for item in items:
        if not isinstance(item, dict) or set(item) != {'kind', 'summary', 'source_message_ids'} or \
                item['kind'] not in ('problem', 'reason', 'attempt', 'pending') or \
                not isinstance(item['summary'], str) or not item['summary'].strip() or \
                len(item['summary'].encode('utf-8')) > 256 or \
                any(ord(char) < 32 or ord(char) == 127 for char in item['summary']) or \
                secret.search(item['summary']):
            return False
        cited = item['source_message_ids']
        if not isinstance(cited, list) or not 1 <= len(cited) <= len(ids) or \
                any(not isinstance(identifier, str) or identifier not in ids for identifier in cited) or \
                len(set(cited)) != len(cited):
            return False
    return True


def _conversation_summary(metadata: dict, text: str, project: str) -> bool:
    refs = metadata.get('source_refs')
    def valid_ref(ref):
        if not isinstance(ref, dict):
            return False
        offsets = ref.get('offsets')
        excerpt = ref.get('excerpt')
        return isinstance(ref.get('message_id'), str) and bool(ref['message_id']) and \
            (ref.get('origin'), ref.get('role')) in (('human', 'user'),
                ('assistant', 'assistant')) and \
            isinstance(ref.get('actor'), str) and bool(ref['actor']) and \
            isinstance(offsets, dict) and type(offsets.get('start')) is int and \
            type(offsets.get('end')) is int and 0 <= offsets['start'] < offsets['end'] and \
            isinstance(ref.get('source_text_sha256'), str) and \
            re.fullmatch(r'[a-f0-9]{64}', ref['source_text_sha256']) is not None and \
            isinstance(excerpt, str) and bool(excerpt.strip()) and \
            len(excerpt.encode('utf-8')) <= 512
    try:
        expected_key = _dedup_key(project, metadata, text)
    except ValueError:
        return False
    first = refs[0] if isinstance(refs, list) and refs else None
    return metadata.get('format_version') == 4 and \
        metadata.get('origin') == 'conversation_summary' and \
        metadata.get('speaker_role') == 'mixed' and \
        metadata.get('actor') == 'conversation' and \
        isinstance(refs, list) and 2 <= len(refs) <= 10 and isinstance(first, dict) and \
        metadata.get('source') == first.get('message_id') and \
        metadata.get('source_offsets') == first.get('offsets') and \
        metadata.get('source_text_sha256') == first.get('source_text_sha256') and \
        metadata.get('dedup_key') == expected_key and \
        all(valid_ref(ref) for ref in refs) and \
        any(isinstance(ref, dict) and ref.get('origin') == 'human' and
            ref.get('role') == 'user' for ref in refs) and \
        any(isinstance(ref, dict) and ref.get('origin') == 'assistant' and
            ref.get('role') == 'assistant' for ref in refs)


def _explicit_mcp_record(metadata: dict, text: str, project: str) -> bool:
    try:
        expected_key = _dedup_key(project, metadata, text)
    except ValueError:
        return False
    return metadata.get('format_version') == 5 and \
        metadata.get('origin') == 'assistant_report' and \
        metadata.get('speaker_role') == 'assistant' and \
        metadata.get('actor') == 'mcp_agent' and \
        metadata.get('review_mode') == 'explicit_mcp' and \
        isinstance(metadata.get('source'), str) and \
        re.fullmatch(r'mcp_request:[a-f0-9]{64}', metadata['source']) is not None and \
        isinstance(metadata.get('source_text_sha256'), str) and \
        re.fullmatch(r'[a-f0-9]{64}', metadata['source_text_sha256']) is not None and \
        isinstance(metadata.get('auto_consent_hash'), str) and \
        re.fullmatch(r'[a-f0-9]{64}', metadata['auto_consent_hash']) is not None and \
        metadata.get('dedup_key') == expected_key


_IDENTIFIER = re.compile(r'(?<![A-Za-z0-9])(?:[A-Za-z0-9]+(?:[_.:/-][A-Za-z0-9]+)+|[A-Z]{2,}[0-9]+)(?![A-Za-z0-9])')


def distinctive_tokens(query: str) -> list[str]:
    """Only bounded technical identifiers can grant literal lexical evidence."""
    if not isinstance(query, str):
        return []
    tokens = []
    for match in _IDENTIFIER.finditer(unicodedata.normalize('NFKC', query)):
        value = match.group()
        if 4 <= len(value) <= 80 and any(char.isalpha() for char in value) and \
                value.casefold() not in [item.casefold() for item in tokens]:
            tokens.append(value)
    return tokens[:9]


def literal_spans(text: str, token: str) -> list[str]:
    if not isinstance(text, str) or not isinstance(token, str):
        return []
    normalized = unicodedata.normalize('NFKC', text).casefold()
    needle = unicodedata.normalize('NFKC', token).casefold()
    found = []
    start = 0
    while needle:
        index = normalized.find(needle, start)
        if index < 0:
            break
        end = index + len(needle)
        if (index == 0 or not normalized[index - 1].isalnum()) and \
                (end == len(normalized) or not normalized[end].isalnum()):
            found.append(normalized[index:end])
        start = index + 1
    return found


def validate_curated_payload(point, project: str, owner: str | None,
                             purpose: str = 'recall', now: datetime | None = None) -> dict | None:
    """Validate a Qdrant point without claiming an SDK row or checking a vector."""
    if purpose not in ('recall', 'history') or not isinstance(project, str) or not project:
        raise ValueError('invalid_curated_validation')
    payload = getattr(point, 'payload', None)
    if not isinstance(payload, dict) or payload.get('project_id') != project or \
            payload.get('user_id') != project or 'expiration_date' in payload or \
            payload.get('source_type') == 'imported_legacy':
        return None
    text = payload.get('data')
    external = payload.get('source_record_id')
    if not isinstance(text, str) or not text.strip() or not isinstance(external, str) or not external:
        return None
    try:
        identifier = str(uuid.UUID(str(point.id)))
    except (ValueError, TypeError, AttributeError):
        return None
    status = payload.get('status')
    if status != 'active' and not (purpose == 'history' and status == 'superseded'):
        return None
    scope = payload.get('scope')
    if scope not in ('project', 'personal', 'episode') or \
            (scope == 'personal' and (not owner or payload.get('owner_id') != owner)):
        return None
    if not all(isinstance(payload.get(key), str) and payload[key] for key in
               ('source', 'actor', 'origin', 'speaker_role', 'evidence_at')):
        return None
    origin, role = payload['origin'], payload['speaker_role']
    if not ((origin, role) in (('user_direct', 'user'), ('assistant_report', 'assistant'),
                                  ('tool_observation', 'tool'), ('external_reference', 'external')) or
            origin == 'conversation_summary' and role == 'mixed'):
        return None
    version = payload.get('format_version')
    if version == 4 and not _conversation_summary(payload, text, project) or \
            version == 5 and not _explicit_mcp_record(payload, text, project) or \
            version not in (None, 4, 5) or \
            origin == 'conversation_summary' and version != 4:
        return None
    try:
        instant = now or datetime.now(timezone.utc)
        if instant.tzinfo is None or _time(payload['evidence_at']) > instant:
            return None
        start = _time(payload['valid_from']) if payload.get('valid_from') else None
        end = _time(payload['valid_to']) if payload.get('valid_to') else None
        if scope == 'episode' and end is None:
            return None
        expired = end is not None and instant >= end
        if purpose == 'recall' and (expired or start is not None and instant < start):
            return None
    except (ValueError, TypeError):
        return None
    metadata = {key: value for key, value in payload.items() if key not in
                ('data', 'user_id', 'run_id')}
    if 'context_generated' in metadata and not _valid_generated_context(
            metadata['context_generated'], metadata.get('source_refs')):
        metadata.pop('context_generated')
    return {'sdkId': identifier, 'qdrantId': identifier, 'externalId': external,
            'projectId': project, 'status': status, 'text': text, 'metadata': metadata,
            **({'historyState': 'superseded' if status == 'superseded' else 'expired' if expired else 'active'}
               if purpose == 'history' else {})}


def history_page(client, collection: str, project: str, owner: str | None,
                 offset: str | None, limit: int = 64) -> dict:
    """One bounded Qdrant page; invalid records still consume the scan budget."""
    from qdrant_client.models import FieldCondition, Filter, MatchAny, MatchValue
    if type(limit) is not int or not 1 <= limit <= 64:
        raise ValueError('page_limit_invalid')
    if offset is not None:
        offset = str(uuid.UUID(offset))
    points, next_offset = client.scroll(collection_name=collection,
        scroll_filter=Filter(must=[
            FieldCondition(key='project_id', match=MatchValue(value=project)),
            FieldCondition(key='user_id', match=MatchValue(value=project)),
            FieldCondition(key='status', match=MatchAny(any=['active', 'superseded']))]),
        limit=limit, offset=offset, with_payload=True, with_vectors=False)
    if len(points) > limit:
        raise ValueError('page_limit_exceeded')
    items = [row for point in points
             if (row := validate_curated_payload(point, project, owner, 'history')) is not None]
    result = {'kind': 'page', 'items': items, 'scanned': len(points),
              'nextOffset': str(next_offset) if next_offset is not None else None}
    if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > 4 * 1024 * 1024:
        raise ValueError('page_oversized')
    return result


def history_get(client, collection: str, project: str, owner: str | None,
                identifier: str) -> dict:
    identifier = str(uuid.UUID(identifier))
    points = client.retrieve(collection_name=collection, ids=[identifier],
                             with_payload=True, with_vectors=False)
    row = validate_curated_payload(points[0], project, owner, 'history') if len(points) == 1 else None
    return {'kind': 'item', 'item': row} if row and row['qdrantId'] == identifier else \
        {'kind': 'blocked', 'reason': 'source_unavailable'}


def _text_index_present(client, collection: str) -> bool:
    schema = (client.get_collection(collection).payload_schema or {}).get('data')
    if schema is None:
        return False
    kind = getattr(schema, 'data_type', None)
    return str(kind).lower() in ('text', 'payloadschematype.text')


def ensure_text_index(client, collection: str) -> dict:
    """Administrative operation; collection trust is verified by execute first."""
    from qdrant_client.models import TextIndexParams, TextIndexType, TokenizerType
    if _text_index_present(client, collection):
        return {'kind': 'indexed', 'created': False}
    schema = (client.get_collection(collection).payload_schema or {}).get('data')
    if schema is not None:
        raise ValueError('text_index_schema_mismatch')
    client.create_payload_index(collection_name=collection, field_name='data',
        field_schema=TextIndexParams(type=TextIndexType.TEXT, tokenizer=TokenizerType.WORD,
                                     min_token_len=2, max_token_len=80, lowercase=True), wait=True)
    if not _text_index_present(client, collection):
        raise ValueError('text_index_unverified')
    return {'kind': 'indexed', 'created': True}


def lexical_candidates(client, collection: str, project: str, query: str,
                       limit: int = 32, owner: str | None = None,
                       now: datetime | None = None) -> dict:
    from qdrant_client.models import FieldCondition, Filter, MatchText, MatchTextAny, MatchValue
    tokens = distinctive_tokens(query)
    if not tokens:
        return {'kind': 'vector_only', 'reason': 'no_distinctive_token', 'items': []}
    if len(tokens) > 8:
        return {'kind': 'vector_only', 'reason': 'token_budget', 'items': []}
    if type(limit) is not int or limit < 1 or limit > 32:
        raise ValueError('lexical_limit_invalid')
    try:
        if not _text_index_present(client, collection):
            return {'kind': 'vector_only', 'reason': 'index_missing', 'items': []}
        terms = [FieldCondition(key='project_id', match=MatchValue(value=project)),
                 FieldCondition(key='user_id', match=MatchValue(value=project)),
                 FieldCondition(key='status', match=MatchValue(value='active'))]
        matches = [MatchText(text=tokens[0])]
        if len(tokens) > 1:
            matches.append(MatchTextAny(text_any=' '.join(tokens)))
        found = {}
        for match in matches:
            points, offset = client.scroll(collection_name=collection,
                scroll_filter=Filter(must=terms + [FieldCondition(key='data', match=match)]),
                limit=limit - len(found), with_payload=True, with_vectors=False)
            if offset is not None or len(points) + len(found) > limit:
                return {'kind': 'vector_only', 'reason': 'saturated', 'items': []}
            for point in points:
                found[str(point.id)] = point
            if len(found) == limit and match is not matches[-1]:
                return {'kind': 'vector_only', 'reason': 'saturated', 'items': []}
        ranked = []
        terms_in_query = set(re.findall(r'[a-z0-9]+', unicodedata.normalize('NFKC', query).casefold()))
        for point in found.values():
            row = validate_curated_payload(point, project, owner, 'recall', now)
            if row is None:
                continue
            spans = [matches[0] for token in tokens if (matches := literal_spans(row['text'], token))]
            if not spans:
                continue
            exact = len(set(spans))
            coverage = len(terms_in_query.intersection(re.findall(r'[a-z0-9]+',
                unicodedata.normalize('NFKC', row['text']).casefold())))
            ranked.append((-exact, -coverage, row['qdrantId'], row, spans))
        ranked.sort(key=lambda item: item[:3])
        items = [{**row, 'scoreSource': 'lexical_verified',
                  'retrievalEvidence': {'lexicalRank': index, 'literalSpans': spans}}
                 for index, (_, _, _, row, spans) in enumerate(ranked, 1)]
        return {'kind': 'items', 'items': items}
    except Exception:
        return {'kind': 'vector_only', 'reason': 'lexical_unavailable', 'items': []}


class _OneQueryEmbedder:
    """Reuse the SDK query embedding only within one search operation."""
    def __init__(self, delegate):
        self.delegate = delegate
        self.query = None
        self.vector = None

    def embed(self, text: str, memory_action: str = 'add') -> list[float]:
        if memory_action != 'search':
            return self.delegate.embed(text, memory_action)
        if self.vector is None:
            self.query = text
            self.vector = self.delegate.embed(text, memory_action)
        elif text != self.query:
            raise ValueError('query_embedding_changed')
        return self.vector


def execute_readonly(request: dict, client, state: Path) -> dict:
    """Read-only MCP operations; collection is always derived from the bound native one."""
    native = request['collection']
    project = request['projectId']
    if not isinstance(native, str) or not native or not isinstance(project, str) or not project:
        raise ValueError('invalid_identity')
    op = request['op']
    if op == 'raw_search':
        collection = _raw_collection(client, native)
        if collection is None:
            return {'kind': 'items', 'items': []}
        query = request['query']
        if not isinstance(query, str) or not query.strip() or len(query.encode('utf-8')) > 4096:
            raise ValueError('invalid_query')
        if _WARM_EMBEDDER is None:
            raise ValueError('encoder_unready')
        hits = client.query_points(collection, query=_WARM_EMBEDDER.embed(query, 'search'),
                                   limit=8, with_payload=True).points
        items = []
        for point in hits:
            payload = point.payload or {}
            score = point.score
            if not _raw_payload(payload, collection, point.id) or \
                    not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
                continue
            items.append({'id': str(point.id), 'readId': payload['anchor_id'],
                          'preview': payload['text'][:240],
                          'sourceProject': payload['source_project'],
                          'sourceTable': payload['source_table'],
                          'sourceId': payload['source_id'],
                          'evidenceAt': payload['evidence_at'], 'score': score})
            if len(items) == 5:
                break
        return {'kind': 'items', 'items': items}
    if op != 'readonly_get':
        raise ValueError('unknown_operation')
    try:
        identifier = str(uuid.UUID(request['memoryId']))
    except (ValueError, TypeError, AttributeError):
        raise ValueError('invalid_memory_id') from None
    source = request['source']
    if source == 'legacy':
        collection = _raw_collection(client, native)
        if collection is None:
            return {'kind': 'blocked', 'reason': 'source_unavailable'}
        points = client.retrieve(collection, ids=[identifier], with_payload=True)
        if len(points) != 1:
            return {'kind': 'blocked', 'reason': 'source_unavailable'}
        payload = points[0].payload or {}
        if not _raw_payload(payload, collection, points[0].id) or \
                payload.get('anchor_id') != identifier or not isinstance(payload.get('raw_row'), dict):
            return {'kind': 'blocked', 'reason': 'source_unavailable'}
        page = _page(json.dumps(payload['raw_row'], ensure_ascii=False, separators=(',', ':')),
                     request.get('offset', 0))
        return {'kind': 'item', 'item': {'projectId': project, 'source': 'legacy',
            'label': 'Claude-mem legado, gerado, não verificado',
            'sourceProject': payload['source_project'], 'sourceTable': payload['source_table'],
            'sourceId': payload['source_id'], 'evidenceAt': payload['evidence_at'], **page}}
    if source != 'curated':
        raise ValueError('invalid_source')
    verify_collection(client, native, FINGERPRINT)
    memory = _memory(client, native, state, request['connection'], history_db_path=':memory:')
    row = _row(memory.get(identifier), client, native, memory.embedding_model)
    if row is None or row['projectId'] != project or row['status'] != 'active':
        return {'kind': 'blocked', 'reason': 'source_unavailable'}
    metadata = row['metadata']
    now = datetime.now(timezone.utc)
    if metadata.get('scope') not in ('project', 'personal', 'episode') or \
            metadata.get('scope') == 'personal' and (not request.get('ownerId') or
                metadata.get('owner_id') != request['ownerId']) or \
            metadata.get('scope') == 'episode' and not metadata.get('valid_to') or \
            metadata.get('valid_from') and _time(metadata['valid_from']) > now or \
            metadata.get('valid_to') and _time(metadata['valid_to']) <= now or \
            not (_conversation_summary(metadata, row['text'], project) or
                _explicit_mcp_record(metadata, row['text'], project) or
                metadata.get('format_version') != 5 and
                metadata.get('speaker_role') == {'user_direct': 'user', 'assistant_report': 'assistant',
                    'tool_observation': 'tool', 'external_reference': 'external'}.get(metadata.get('origin'))) or \
            not metadata.get('source') or not metadata.get('actor') or \
            not metadata.get('evidence_at'):
        return {'kind': 'blocked', 'reason': 'source_unavailable'}
    page = _page(row['text'], request.get('offset', 0))
    provenance = {key: metadata.get(key) for key in
        ('source', 'actor', 'origin', 'speaker_role', 'evidence_at', 'scope')}
    if _conversation_summary(metadata, row['text'], project):
        provenance.update({'generated': True, 'source_ref_count': len(metadata['source_refs']),
                           'source_refs': metadata['source_refs']})
        if _valid_generated_context(metadata.get('context_generated'), metadata['source_refs']):
            provenance['context_generated'] = metadata['context_generated']
    elif _explicit_mcp_record(metadata, row['text'], project):
        provenance.update({'review_mode': 'explicit_mcp',
                           'source_text_sha256': metadata['source_text_sha256'],
                           'condition': metadata.get('condition')})
    return {'kind': 'item', 'item': {'projectId': project, 'source': 'curated',
        'memoryId': identifier, 'provenance': provenance, **page}}


def execute(request: dict, client, state: Path) -> dict:
    collection = request['collection']
    project = request['projectId']
    external = request.get('externalId')
    if not isinstance(project, str) or not project or not isinstance(collection, str) or not collection:
        raise ValueError('invalid_identity')
    verify_collection(client, collection, FINGERPRINT)
    op = request['op']
    if op == 'index_text':
        return ensure_text_index(client, collection)
    if op == 'history_page':
        return history_page(client, collection, project, request.get('ownerId'),
                            request.get('offset'), request.get('limit', 64))
    if op == 'history_get':
        return history_get(client, collection, project, request.get('ownerId'),
                           request['memoryId'])
    memory = _memory(client, collection, state, request['connection'], history_db_path=':memory:') \
        if op == 'search' else _memory(client, collection, state, request['connection'])
    if op == 'find':
        return {'kind': 'items', 'items': _find(memory, client, collection, project, external)}
    if op == 'read':
        row = _row(memory.get(request['sdkId']), client, collection, memory.embedding_model)
        if row is not None and row['projectId'] != project:
            raise ValueError('project_mismatch')
        return {'kind': 'item', 'item': row}
    if op == 'dedup_find':
        return _find_duplicate(client, collection, request)
    if op == 'add':
        metadata = request['metadata']
        if 'context_generated' in metadata and not _valid_generated_context(
                metadata['context_generated'], metadata.get('source_refs')):
            raise ValueError('context_generated_invalid')
        if any(key in metadata for key in ('status', 'source_record_id', 'project_id', 'expiration_date')):
            raise ValueError('reserved_metadata')
        if metadata.get('scope') not in ('project', 'personal', 'episode') or \
                (metadata.get('scope') == 'personal' and not metadata.get('owner_id')) or \
                (metadata.get('scope') == 'episode' and not metadata.get('valid_to')):
            raise ValueError('scope_invalid')
        if not all(metadata.get(field) for field in ('source', 'actor', 'origin', 'evidence_at')):
            raise ValueError('provenance_incomplete')
        _time(metadata['evidence_at'])
        if metadata.get('valid_from'):
            _time(metadata['valid_from'])
        if metadata.get('valid_to'):
            _time(metadata['valid_to'])
        if metadata.get('format_version') == 5 and \
                not _explicit_mcp_record(metadata, request['text'], project):
            raise ValueError('explicit_mcp_invalid')
        if metadata.get('format_version') in (4, 5):
            duplicate = _find_duplicate(client, collection, request)
            if duplicate['kind'] != 'clear':
                return duplicate
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
                if old is None or old['projectId'] != project or \
                        old['externalId'] != row['metadata'].get('correction_target_external_id') or \
                        old['metadata'].get('scope') != row['metadata'].get('scope') or \
                        (row['metadata'].get('scope') == 'personal' and
                         old['metadata'].get('owner_id') != row['metadata'].get('owner_id')):
                    raise ValueError('superseded_target_invalid')
                if old['status'] == 'active':
                    memory.update(supersedes, metadata={'status': 'superseded',
                        'superseded_by': identifier, 'superseded_by_external_id': external})
                    old = _row(memory.get(supersedes), client, collection, memory.embedding_model)
                    if old['status'] != 'superseded' or old['metadata'].get('superseded_by') != identifier:
                        raise ValueError('supersede_unverified')
                elif old['status'] != 'superseded' or old['metadata'].get('superseded_by') != identifier or \
                        old['metadata'].get('superseded_by_external_id') != external:
                    raise ValueError('superseded_target_invalid')
            memory.update(identifier, metadata={'status': 'active'})
        return {'kind': 'item', 'item': _row(memory.get(identifier), client, collection, memory.embedding_model)}
    if op == 'search':
        now = datetime.now(timezone.utc)
        lexical = lexical_candidates(client, collection, project, request['query'],
            owner=request.get('ownerId'), now=now)
        original_embedder = memory.embedding_model
        memory.embedding_model = (_OneQueryEmbedder(original_embedder)
                                  if hasattr(original_embedder, 'embed') else original_embedder)
        try:
            limit = 20
            while limit <= 2048:
                try:
                    result = memory.search(request['query'], filters={'user_id': project, 'status': 'active'},
                                           top_k=limit, threshold=MIN_RECALL_SCORE)
                    items = [{**_row(row, client, collection, memory.embedding_model),
                              'scoreSource': 'mem0_sdk_search'} for row in result['results']]
                except Exception:
                    if lexical['items']:
                        return {'kind': 'items', 'items': [], 'lexical_items': lexical['items'],
                                'vector_degradation': 'vector_unavailable'}
                    return {'kind': 'unavailable', 'reason': 'vector_unavailable',
                            'lexical_degradation': lexical.get('reason')}
                eligible = [row for row in items if row['projectId'] == project and
                    isinstance(row.get('score'), (int, float)) and math.isfinite(row['score']) and
                    MIN_RECALL_SCORE <= row['score'] <= 1 and
                    row['status'] == 'active' and row['metadata'].get('source') and row['metadata'].get('actor') and
                    (row['metadata'].get('format_version') != 5 or
                        _explicit_mcp_record(row['metadata'], row['text'], project)) and
                    row['metadata'].get('scope') in ('project', 'personal', 'episode') and
                    (row['metadata'].get('scope') != 'episode' or row['metadata'].get('valid_to')) and
                    (row['metadata']['scope'] in ('project', 'episode') or (request.get('ownerId') and
                        row['metadata'].get('owner_id') == request['ownerId'])) and
                    (not row['metadata'].get('valid_from') or _time(row['metadata']['valid_from']) <= now) and
                    (not row['metadata'].get('valid_to') or now < _time(row['metadata']['valid_to']))]
                if len(eligible) >= 20 or len(result['results']) < limit:
                    ranked_vector = [{**row, 'retrievalEvidence': {'vectorScore': row['score'],
                                       'vectorRank': index}}
                                     for index, row in enumerate(eligible[:20], 1)]
                    return {'kind': 'items', 'items': ranked_vector,
                            'lexical_items': lexical['items'],
                            'lexical_degradation': lexical.get('reason')}
                if limit == 2048:
                    break
                limit = min(limit * 2, 2048)
            if lexical['items']:
                return {'kind': 'items', 'items': [], 'lexical_items': lexical['items'],
                        'vector_degradation': 'vector_saturated'}
            return {'kind': 'unavailable', 'reason': 'vector_saturated',
                    'lexical_degradation': lexical.get('reason')}
        finally:
            memory.embedding_model = original_embedder
    raise ValueError('unknown_operation')


def main() -> int:
    os.environ['OMP_NUM_THREADS'] = '2'
    os.environ['OPENBLAS_NUM_THREADS'] = '1'
    os.environ['MKL_NUM_THREADS'] = '1'
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
